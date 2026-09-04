#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const {
  createNewStore,
  loadStore,
  saveStore,
  requestSmsCode,
  verifyCode,
  WhalibmobClient,
} = require('whalibmob');

const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(os.homedir(), '.whatsapp-sms-bot');
const phoneArg = process.argv[2];

function normalizePhone(value) {
  const phone = String(value || '').replace(/[^0-9]/g, '');
  if (phone.length < 7 || phone.length > 15) {
    throw new Error('Enter a valid international phone number, including country code.');
  }
  return phone;
}

function sessionFile(phone) {
  return path.join(SESSION_DIR, `${phone}.json`);
}

function ensureSessionDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
}

async function ask(rl, question, hidden = false) {
  if (!hidden) return (await rl.question(question)).trim();
  // The verification code is not printed by this program; terminal echo
  // suppression is intentionally avoided for portability across terminals.
  return (await rl.question(question)).trim();
}

async function registerIfNeeded(phone, rl) {
  ensureSessionDir();
  const file = sessionFile(phone);
  let store = loadStore(file);

  if (store && store.registered) {
    console.log(`Using existing session: ${file}`);
    return { store, file };
  }

  store = store || createNewStore(phone, { name: process.env.WA_DISPLAY_NAME || 'My WhatsApp Bot' });
  const method = (process.env.WA_CODE_METHOD || 'sms').toLowerCase();
  if (!['sms', 'voice', 'wa_old'].includes(method)) {
    throw new Error('WA_CODE_METHOD must be sms, voice, or wa_old.');
  }

  saveStore(store, file);
  console.log(`Requesting a ${method} verification code for +${phone}...`);
  const requested = await requestSmsCode(store, method);
  saveStore(requested.store || store, file);
  console.log(`WhatsApp response: ${requested.status || 'code requested'}`);

  const code = await ask(rl, 'Enter the verification code: ', true);
  if (!/^\d{4,8}$/.test(code)) throw new Error('The verification code must contain digits only.');

  const verified = await verifyCode(store, code);
  if (!verified || !verified.store || !verified.store.registered) {
    throw new Error(`Verification did not complete (status: ${verified && verified.status}).`);
  }
  saveStore(verified.store, file);
  console.log(`Registration complete. Session saved to ${file}`);
  return { store: verified.store, file };
}

async function startBot(phone, file) {
  const client = new WhalibmobClient({ sessionDir: SESSION_DIR, autoRead: true });

  client.on('connected', () => console.log('Bot connected and listening for messages.'));
  client.on('reconnecting', ({ delay }) => console.log(`Connection lost; retrying in ${Math.round(delay / 1000)}s...`));
  client.on('disconnected', () => console.log('Bot disconnected.'));
  client.on('restart_required', () => console.log('WhatsApp requested a stream restart; reconnecting...'));
  client.on('error', (error) => console.error('WhatsApp error:', error.message));
  client.on('auth_failure', ({ reason }) => console.error('Authentication failure:', reason));

  client.on('message', async (msg) => {
    const decoded = msg && msg.decoded;
    if (!decoded || !msg.from || msg.from === 'status@broadcast') return;
    const text = String(decoded.text || '').trim().toLowerCase();
    console.log(`Message from ${msg.from}: ${decoded.text || `[${decoded.type || 'unknown'}]`}`);
    if (decoded.type === 'text' && text === 'ping') {
      await client.sendText(msg.from, 'pong');
    }
  });

  await client.connect(phone);
  // Keep the process alive while the client maintains its WebSocket connection.
  await new Promise(() => {});
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    const entered = phoneArg || await ask(rl, 'Phone number with country code (digits only): ');
    const phone = normalizePhone(entered);
    const { file } = await registerIfNeeded(phone, rl);
    rl.close();
    await startBot(phone, file);
  } catch (error) {
    rl.close();
    console.error('\nBot stopped:', error.message);
    process.exitCode = 1;
  }
}

main();
