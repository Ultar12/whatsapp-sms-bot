# Telegram WhatsApp SMS Bot

An admin-only Telegram controller for [`whalibmob`](https://github.com/Kunboruto20/whalibmob). Send a phone number in Telegram and the service immediately requests a WhatsApp verification code. Send the code when it arrives; successful verification starts the WhatsApp bot.

## Telegram flow

1. Send a plain international phone number, for example `15551234567`.
2. The bot requests the currently selected verification method automatically.
3. The bot reports whether the request succeeded or returns the exact error.
4. If the request succeeds, use Telegram's **Reply** action on the bot's request message and send the received code in that reply. The bot rejects codes sent as unrelated new messages.
5. The bot reports success or the verification error and starts the WhatsApp connection after successful verification.

Failed requests are reported in a compact format such as `15551234567 🟡 Try later`, followed by the error returned by WhatsApp. A one-hour local cooldown prevents accidental repeated requests from the same admin chat.

## Commands

- `/change sms` — request codes by SMS
- `/change voice` — request codes by voice call
- `/change app` — use the supported WhatsApp-app/legacy code method
- `/change` — show the current method
- `/status` — show the current method and pending/running sessions
- `/stop` — stop running WhatsApp clients
- `/help` — show help

`/change` also displays clickable buttons for `sms`, `voice`, and `wscode`, plus the aliases `/cgsms`, `/cgvoice`, and `/cgwscode`. There is no `/code` command: reply to the bot's request message with the digits.

Only the chat ID in `TELEGRAM_ADMIN_CHAT_ID` can use these commands. Other Telegram users receive `Unauthorized.`

## Environment variables

```env
TELEGRAM_BOT_TOKEN=<new token from BotFather>
TELEGRAM_ADMIN_CHAT_ID=7710721646
WA_CODE_METHOD=sms
WA_DISPLAY_NAME=My Telegram WhatsApp Bot
```

Never commit `.env`. The token previously supplied was exposed in chat and must be revoked with BotFather before using a replacement token.

## Heroku

The repository includes a `Procfile`:

```text
worker: node src/telegram-bot.js
```

Create a Heroku app, deploy this repository, add the environment variables above as Heroku Config Vars, and run one worker process. Do not put the token in source code, Git, or the README.

## Important production limitation

Heroku dyno filesystems are ephemeral. The local WhatsApp session directory can disappear after a dyno restart or redeploy, requiring verification again. For durable production use, store whalibmob session files in encrypted persistent storage and load them at startup.

Use only phone numbers and WhatsApp accounts you control, avoid repeated code requests, and follow WhatsApp and Telegram terms.
