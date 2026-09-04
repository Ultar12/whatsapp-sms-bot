#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const TelegramBot = require('node-telegram-bot-api');
const {
  createNewStore,
  loadStore,
  saveStore,
  requestSmsCode,
  verifyCode,
  WhalibmobClient,
} = require('whalibmob');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '');
const sessionDir = process.env.WA_SESSION_DIR || path.join(os.homedir(), '.whatsapp-sms-bot');
let method = normalizeMethod(process.env.WA_CODE_METHOD || 'sms');

if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN environment variable.');
if (!/^\d+$/.test(adminId)) throw new Error('Missing or invalid TELEGRAM_ADMIN_CHAT_ID.');
fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

const bot = new TelegramBot(token, { polling: true });
const pending = new Map();
const clients = new Map();
const busy = new Set();
const lastRequestAt = new Map();
const REQUEST_COOLDOWN_MS = 60 * 60 * 1000;

function normalizeMethod(value) {
  const selected = String(value || '').trim().toLowerCase();
  if (selected === 'app' || selected === 'wa_old' || selected === 'code') return 'wa_old';
  if (selected === 'voice' || selected === 'call') return 'voice';
  if (selected === 'sms' || selected === 'text') return 'sms';
  throw new Error('Verification method must be sms, voice, or app.');
}

function methodLabel(value = method) {
  return value === 'voice' ? 'voice call' : value === 'wa_old' ? 'WhatsApp app code' : 'SMS';
}

function authorized(msg) {
  return String(msg.chat.id) === adminId;
}

function phoneFromText(value) {
  const phone = String(value || '').replace(/[^0-9]/g, '');
  if (phone.length < 7 || phone.length > 15) throw new Error('Use an international number with country code, e.g. 15551234567.');
  return phone;
}

function sessionFile(phone) {
  return path.join(sessionDir, `${phone}.json`);
}

async function send(chatId, text) {
  return bot.sendMessage(chatId, text);
}

async function startWhatsApp(phone, chatId) {
  if (clients.has(phone)) return;
  const client = new WhalibmobClient({ sessionDir, autoRead: true });
  clients.set(phone, client);
  client.on('connected', () => send(chatId, `Success: WhatsApp is connected for +${phone}.`).catch(console.error));
  client.on('reconnecting', ({ delay }) => console.log(`WhatsApp ${phone}: reconnecting in ${delay}ms`));
  client.on('error', (error) => {
    console.error(`WhatsApp ${phone}:`, error.message);
    send(chatId, `WhatsApp error for +${phone}: ${error.message}`).catch(console.error);
  });
  client.on('auth_failure', ({ reason }) => send(chatId, `WhatsApp authentication failed for +${phone}: ${reason}`).catch(console.error));
  client.on('message', async (msg) => {
    const decoded = msg && msg.decoded;
    if (!decoded || !msg.from || msg.from === 'status@broadcast') return;
    console.log(`WhatsApp ${phone} message from ${msg.from}: ${decoded.text || decoded.type || 'unknown'}`);
    if (decoded.type === 'text' && String(decoded.text).trim().toLowerCase() === 'ping') {
      await client.sendText(msg.from, 'pong');
    }
  });
  try {
    await client.connect(phone);
  } catch (error) {
    clients.delete(phone);
    throw error;
  }
}

async function requestVerification(chatId, rawPhone) {
  if (busy.has(chatId)) return send(chatId, 'A verification request is already running. Wait for its result.');
  const phone = phoneFromText(rawPhone);
  const previous = lastRequestAt.get(chatId) || 0;
  if (Date.now() - previous < REQUEST_COOLDOWN_MS) {
    const seconds = Math.ceil((REQUEST_COOLDOWN_MS - (Date.now() - previous)) / 1000);
    return send(chatId, `${phone}\n----------------\nPlease submit this number again in ${seconds} seconds.`);
  }
  lastRequestAt.set(chatId, Date.now());
  busy.add(chatId);
  try {
    const file = sessionFile(phone);
    let store = loadStore(file);
    if (store && store.registered) {
      await send(chatId, `This number is already registered. Starting it now: +${phone}`);
      return await startWhatsApp(phone, chatId);
    }
    store = store || createNewStore(phone, { name: process.env.WA_DISPLAY_NAME || 'My Telegram WhatsApp Bot' });
    saveStore(store, file);
    await send(chatId, `Requesting a ${methodLabel()} verification code for +${phone}...`);
    const result = await requestSmsCode(store, method);
    saveStore(result.store || store, file);
    const requestMessage = await send(chatId, `✅ ${phone}\n----------------\nRequest succeeded. Reply to this message with the verification code.`);
    pending.set(chatId, { phone, file, method, requestMessageId: requestMessage.message_id });
  } catch (error) {
    await send(chatId, `${phone} 🟡 Try later\n----------------\n${error.message}`);
  } finally {
    busy.delete(chatId);
  }
}

async function verifyPending(chatId, rawCode) {
  const request = pending.get(chatId);
  if (!request) return send(chatId, 'No code is expected. Send a phone number to start a verification request.');
  const code = String(rawCode || '').replace(/\s/g, '');
  if (!/^\d{4,8}$/.test(code)) return send(chatId, 'The verification code must contain digits only.');
  if (busy.has(chatId)) return send(chatId, 'Verification is already running. Wait for its result.');
  busy.add(chatId);
  try {
    const store = loadStore(request.file);
    if (!store) throw new Error('The saved registration session was not found.');
    const verified = await verifyCode(store, code, { method: request.method });
    if (!verified || !verified.store || !verified.store.registered) throw new Error(`Verification was not successful (status: ${verified && verified.status}).`);
    saveStore(verified.store, request.file);
    pending.delete(chatId);
    await send(chatId, `Success: +${request.phone} was verified. Starting the WhatsApp bot...`);
    try {
      await startWhatsApp(request.phone, chatId);
    } catch (error) {
      await send(chatId, `The number was verified, but the WhatsApp connection failed: ${error.message}`);
    }
  } catch (error) {
    await send(chatId, `Verification failed for +${request.phone}.\nError: ${error.message}`);
  } finally {
    busy.delete(chatId);
  }
}

function isReplyToCodeRequest(msg, request) {
  return Boolean(
    msg.reply_to_message &&
    Number(msg.reply_to_message.message_id) === Number(request.requestMessageId)
  );
}

bot.onText(/^\/start$/, (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  return send(msg.chat.id, `Send a phone number to start. Current method: ${methodLabel()}.\nUse /change sms, /change voice, or /change app.`);
});

bot.onText(/^\/(?:help|commands)$/, (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  return send(msg.chat.id, 'Send a phone number: the bot requests the code automatically.\nThen send the received code.\n/change sms\n/change voice\n/change app\n/status\n/stop');
});

bot.onText(/^\/change(?:\s+(sms|voice|app|call|text|code|wa_old))?$/i, async (msg, match) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  if (!match[1]) return send(msg.chat.id, `Modify the type of verification code\n----------------\nCurrent verification code type: ${method === 'wa_old' ? 'wscode' : method}\n\nClick the link behind the type you need to change, and then you can complete the modification of the verification code type.\n\nsms → /cgsms\nvoice → /cgvoice\nwscode → /cgwscode\n\nNotice:\n1. After you change the verification code type, all the numbers you submit will be registered with this type.\n2. The wscode type requires an account already registered and successfully logged in on your device.`, { reply_markup: { inline_keyboard: [[{ text: 'sms', callback_data: 'change:sms' }, { text: 'voice', callback_data: 'change:voice' }, { text: 'wscode', callback_data: 'change:app' }]] } });
  try {
    method = normalizeMethod(match[1]);
    await send(msg.chat.id, `Verification method changed to ${methodLabel()}. Send a phone number when ready.`);
  } catch (error) {
    await send(msg.chat.id, error.message);
  }
});

for (const [command, selected] of [['cgsms', 'sms'], ['cgvoice', 'voice'], ['cgwscode', 'app']]) {
  bot.onText(new RegExp(`^\\/${command}$`, 'i'), async (msg) => {
    if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
    method = normalizeMethod(selected);
    await send(msg.chat.id, `Current verification code type: ${selected === 'app' ? 'wscode' : selected}`);
  });
}

bot.on('callback_query', async (query) => {
  if (!query.message || !authorized(query.message)) return bot.answerCallbackQuery(query.id, { text: 'Unauthorized.' });
  if (query.data && query.data.startsWith('change:')) {
    method = normalizeMethod(query.data.slice(7));
    await bot.answerCallbackQuery(query.id, { text: `Changed to ${methodLabel()}` });
    await send(query.message.chat.id, `Current verification code type: ${method === 'wa_old' ? 'wscode' : method}`);
  }
});

bot.onText(/^\/code(?:\s+([0-9]{4,8}))?$/, (msg, match) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  const request = pending.get(msg.chat.id);
  if (!request || !isReplyToCodeRequest(msg, request)) {
    return send(msg.chat.id, 'Please reply to the bot message requesting the code. Do not send the code as a new message.');
  }
  return verifyPending(msg.chat.id, match[1]);
});

bot.onText(/^\/status$/, async (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  const pendingText = pending.size ? [...pending.values()].map((x) => `+${x.phone} (${methodLabel(x.method)})`).join(', ') : 'none';
  const runningText = clients.size ? [...clients.keys()].map((x) => `+${x}`).join(', ') : 'none';
  await send(msg.chat.id, `Selected method: ${methodLabel()}\nPending: ${pendingText}\nRunning: ${runningText}`);
});

bot.onText(/^\/stop$/, async (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  for (const [phone, client] of clients) {
    try { await client.close?.(); } catch (error) { console.error(error.message); }
    clients.delete(phone);
  }
  await send(msg.chat.id, 'Stopped running WhatsApp clients.');
});

// Any plain phone number starts the process; no /register command is needed.
bot.on('message', async (msg) => {
  if (!authorized(msg) || typeof msg.text !== 'string' || msg.text.startsWith('/')) return;
  const text = msg.text.trim();
  if (/^\d{4,8}$/.test(text) && pending.has(msg.chat.id)) {
    const request = pending.get(msg.chat.id);
    if (!isReplyToCodeRequest(msg, request)) {
      return send(msg.chat.id, 'Please reply to the bot message requesting the code. Do not send the code as a new message.');
    }
    return verifyPending(msg.chat.id, text);
  }
  if (/^[+()\-\s\d]{7,25}$/.test(text)) return requestVerification(msg.chat.id, text);
});

bot.on('polling_error', (error) => console.error('Telegram polling error:', error.message));
console.log('Telegram bot is running. Send a phone number to begin.');
