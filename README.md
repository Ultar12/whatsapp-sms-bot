# Telegram WhatsApp SMS Bot

An admin-only Telegram controller for [`whalibmob`](https://github.com/Kunboruto20/whalibmob). You send commands in Telegram; the service requests a WhatsApp verification code, accepts the code, saves the session, and runs a small WhatsApp bot that replies `pong` to `ping`.

## Telegram commands

- `/register 15551234567` — request an SMS verification code
- `/code 123456` — submit the received code
- `/status` — show pending registrations and running WhatsApp clients
- `/stop` — stop running WhatsApp clients
- `/help` — show the command list

Only the chat ID in `TELEGRAM_ADMIN_CHAT_ID` can use these commands. Other Telegram users receive `Unauthorized.`

## Local setup

```bash
cp .env.example .env
# Edit .env and put in a newly generated BotFather token.
npm install
npm start
```

Never commit `.env`. The supplied token was exposed in chat and must be revoked with BotFather before using a replacement token.

## Heroku setup

This repository includes a `Procfile` with a persistent worker process. Create a Heroku app, connect this GitHub repository, and set these Config Vars in Heroku:

```text
TELEGRAM_BOT_TOKEN=<new token from BotFather>
TELEGRAM_ADMIN_CHAT_ID=7710721646
WA_CODE_METHOD=sms
WA_DISPLAY_NAME=My Telegram WhatsApp Bot
```

Then scale the worker to one process. Do not put the token in source code, Git, or the README.

## Important production limitation

Heroku dyno filesystems are ephemeral. The local WhatsApp session directory can disappear after a dyno restart or redeploy, requiring registration again. For a durable production bot, store the whalibmob session files in encrypted persistent storage and load them at startup.

Use only phone numbers and WhatsApp accounts you control, avoid repeated code requests, and follow WhatsApp and Telegram terms.
