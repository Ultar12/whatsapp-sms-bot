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
const parallelLimit = Math.max(1, Number.parseInt(process.env.PARALLEL_LIMIT || '3', 10) || 3);
let method = normalizeMethod(process.env.WA_CODE_METHOD || 'sms');

if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN environment variable.');
if (!/^\d+$/.test(adminId)) throw new Error('Missing or invalid TELEGRAM_ADMIN_CHAT_ID.');
fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

const bot = new TelegramBot(token, { polling: true });
// chat ID -> Map(bot request message ID -> registration request)
const pending = new Map();
const clients = new Map();
const inFlight = new Set();

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
  if (phone.length < 7 || phone.length > 15) throw new Error('Use an international phone number with country code.');
  return phone;
}

function sessionFile(phone) {
  return path.join(sessionDir, `${phone}.json`);
}

function chatRequests(chatId, create = false) {
  let requests = pending.get(chatId);
  if (!requests && create) {
    requests = new Map();
    pending.set(chatId, requests);
  }
  return requests;
}

function pendingCount() {
  let count = 0;
  for (const requests of pending.values()) count += requests.size;
  return count;
}

async function send(chatId, text, options) {
  return bot.sendMessage(chatId, text, options);
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
  const phone = phoneFromText(rawPhone);
  if (inFlight.size >= parallelLimit) {
    return send(chatId, `${phone} 🟡 Try later\n----------------\nParallel limit reached (${parallelLimit}).`);
  }
  if (inFlight.has(phone) || clients.has(phone)) return send(chatId, `${phone} is already being processed.`);
  inFlight.add(phone);
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
    chatRequests(chatId, true).set(requestMessage.message_id, { phone, file, method, requestMessageId: requestMessage.message_id });
  } catch (error) {
    await send(chatId, `${phone} 🟡 Try later\n----------------\n${error.message}`);
  } finally {
    inFlight.delete(phone);
  }
}

function findPendingReply(chatId, msg) {
  const requests = chatRequests(chatId);
  if (!requests || !msg.reply_to_message) return null;
  return requests.get(Number(msg.reply_to_message.message_id)) || null;
}

async function verifyPending(chatId, rawCode, request) {
  const code = String(rawCode || '').replace(/\s/g, '');
  if (!/^\d{4,8}$/.test(code)) return;
  if (inFlight.has(request.phone)) return;
  inFlight.add(request.phone);
  try {
    const store = loadStore(request.file);
    if (!store) throw new Error('The saved registration session was not found.');
    const verified = await verifyCode(store, code, { method: request.method });
    if (!verified || !verified.store || !verified.store.registered) throw new Error(`Verification was not successful (status: ${verified && verified.status}).`);
    saveStore(verified.store, request.file);
    const requests = chatRequests(chatId);
    requests?.delete(request.requestMessageId);
    if (requests?.size === 0) pending.delete(chatId);
    await send(chatId, `Success: +${request.phone} was verified. Starting the WhatsApp bot...`);
    try {
      await startWhatsApp(request.phone, chatId);
    } catch (error) {
      await send(chatId, `The number was verified, but the WhatsApp connection failed: ${error.message}`);
    }
  } catch (error) {
    await send(chatId, `Verification failed for +${request.phone}.\nError: ${error.message}`);
  } finally {
    inFlight.delete(request.phone);
  }
}

bot.onText(/^\/start$/, (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  return send(msg.chat.id, `Send a phone number to start. Current method: ${methodLabel()}.\nUse /change sms, /change voice, or /change app.`);
});

bot.onText(/^\/(?:help|commands)$/, (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  return send(msg.chat.id, 'Send multiple phone numbers; each starts independently up to the parallel limit.\nReply to each request message with its own code.\n/change sms\n/change voice\n/change app\n/status\n/stop');
});

bot.onText(/^\/change(?:\s+(sms|voice|app|call|text|code|wa_old))?$/i, async (msg, match) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  if (!match[1]) return send(msg.chat.id, `Modify the type of verification code\n----------------\nCurrent verification code type: ${method === 'wa_old' ? 'wscode' : method}\n\nsms → /cgsms\nvoice → /cgvoice\nwscode → /cgwscode`, { reply_markup: { inline_keyboard: [[{ text: 'sms', callback_data: 'change:sms' }, { text: 'voice', callback_data: 'change:voice' }, { text: 'wscode', callback_data: 'change:app' }]] } });
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

bot.onText(/^\/status$/, async (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  const pendingLines = [];
  for (const requests of pending.values()) for (const request of requests.values()) pendingLines.push(`+${request.phone} (${methodLabel(request.method)})`);
  await send(msg.chat.id, `Selected method: ${methodLabel()}\nPending: ${pendingLines.join(', ') || 'none'}\nRunning: ${clients.size ? [...clients.keys()].map((x) => `+${x}`).join(', ') : 'none'}\nParallel limit: ${parallelLimit}`);
});

bot.onText(/^\/stop$/, async (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  for (const [phone, client] of clients) {
    try { await client.close?.(); } catch (error) { console.error(error.message); }
    clients.delete(phone);
  }
  await send(msg.chat.id, 'Stopped running WhatsApp clients.');
});

// Any plain phone number starts independently; a code is accepted only as a reply.
bot.on('message', async (msg) => {
  if (!authorized(msg) || typeof msg.text !== 'string' || msg.text.startsWith('/')) return;
  const text = msg.text.trim();
  const request = findPendingReply(msg.chat.id, msg);
  if (request && /^\d{4,8}$/.test(text)) return verifyPending(msg.chat.id, text, request);
  if (/^[+()\-\s\d]{7,25}$/.test(text)) return requestVerification(msg.chat.id, text);
});

bot.on('polling_error', (error) => console.error('Telegram polling error:', error.message));
console.log(`Telegram bot is running. Parallel limit: ${parallelLimit}`);
