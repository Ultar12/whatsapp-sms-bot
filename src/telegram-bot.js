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
const method = (process.env.WA_CODE_METHOD || 'sms').toLowerCase();

if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN environment variable.');
if (!/^\d+$/.test(adminId)) throw new Error('Missing or invalid TELEGRAM_ADMIN_CHAT_ID.');
if (!['sms', 'voice', 'wa_old'].includes(method)) throw new Error('WA_CODE_METHOD must be sms, voice, or wa_old.');

fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
const bot = new TelegramBot(token, { polling: true });
const pending = new Map();
const clients = new Map();

function authorized(msg) {
  return String(msg.chat.id) === adminId;
}

function phoneFromArg(value) {
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
  client.on('connected', () => send(chatId, `WhatsApp bot connected for +${phone}. Send ping to receive pong.`).catch(console.error));
  client.on('reconnecting', ({ delay }) => console.log(`WhatsApp ${phone}: reconnecting in ${delay}ms`));
  client.on('error', (error) => console.error(`WhatsApp ${phone}:`, error.message));
  client.on('auth_failure', ({ reason }) => send(chatId, `WhatsApp authentication failed: ${reason}`).catch(console.error));
  client.on('message', async (msg) => {
    const decoded = msg && msg.decoded;
    if (!decoded || !msg.from || msg.from === 'status@broadcast') return;
    console.log(`WhatsApp ${phone} message from ${msg.from}: ${decoded.text || decoded.type || 'unknown'}`);
    if (decoded.type === 'text' && String(decoded.text).trim().toLowerCase() === 'ping') {
      await client.sendText(msg.from, 'pong');
    }
  });
  await client.connect(phone);
}

bot.onText(/^\/start$/, (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  return send(msg.chat.id, 'Commands:\n/register 15551234567\n/code 123456\n/status\n/help');
});

bot.onText(/^\/(?:help|commands)$/, (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  return send(msg.chat.id, '/register <international number> requests an SMS\n/code <verification code> verifies it\n/status shows pending sessions\n/stop stops a running WhatsApp client');
});

bot.onText(/^\/register(?:\s+(.+))?$/, async (msg, match) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  try {
    const phone = phoneFromArg(match[1]);
    const file = sessionFile(phone);
    let store = loadStore(file);
    if (store && store.registered) {
      await send(msg.chat.id, `This number is already registered. Starting the bot for +${phone}.`);
      return startWhatsApp(phone, msg.chat.id);
    }
    store = store || createNewStore(phone, { name: process.env.WA_DISPLAY_NAME || 'My Telegram WhatsApp Bot' });
    saveStore(store, file);
    await send(msg.chat.id, `Requesting a ${method} code for +${phone}...`);
    const result = await requestSmsCode(store, method);
    saveStore(result.store || store, file);
    pending.set(msg.chat.id, { phone, file });
    await send(msg.chat.id, 'Code requested. When it arrives, send /code 123456.');
  } catch (error) {
    await send(msg.chat.id, `Registration error: ${error.message}`);
  }
});

bot.onText(/^\/code(?:\s+([0-9]{4,8}))?$/, async (msg, match) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  try {
    const request = pending.get(msg.chat.id);
    if (!request) throw new Error('No pending registration. Start with /register <number>.');
    const store = loadStore(request.file);
    if (!store) throw new Error('Registration session not found.');
    const verified = await verifyCode(store, match[1]);
    if (!verified || !verified.store || !verified.store.registered) throw new Error(`Verification incomplete (status: ${verified && verified.status}).`);
    saveStore(verified.store, request.file);
    pending.delete(msg.chat.id);
    await send(msg.chat.id, `Registration complete for +${request.phone}. Starting the WhatsApp bot...`);
    await startWhatsApp(request.phone, msg.chat.id);
  } catch (error) {
    await send(msg.chat.id, `Verification error: ${error.message}`);
  }
});

bot.onText(/^\/status$/, async (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  const pendingText = pending.size ? [...pending.values()].map((x) => `+${x.phone}`).join(', ') : 'none';
  const runningText = clients.size ? [...clients.keys()].map((x) => `+${x}`).join(', ') : 'none';
  await send(msg.chat.id, `Pending registrations: ${pendingText}\nRunning WhatsApp clients: ${runningText}`);
});

bot.onText(/^\/stop$/, async (msg) => {
  if (!authorized(msg)) return send(msg.chat.id, 'Unauthorized.').catch(console.error);
  for (const [phone, client] of clients) {
    try { await client.close?.(); } catch (error) { console.error(error.message); }
    clients.delete(phone);
  }
  await send(msg.chat.id, 'Stopped running WhatsApp clients.');
});

bot.on('polling_error', (error) => console.error('Telegram polling error:', error.message));
console.log('Telegram bot is running.');
