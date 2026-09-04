# WhatsApp SMS Bot

A small interactive WhatsApp bot built with [`whalibmob`](https://github.com/Kunboruto20/whalibmob). It requests a verification code by SMS, asks for the code locally, saves the authenticated session, and then replies `pong` when it receives `ping`.

## Requirements

- Node.js 18 or newer
- A real phone number that can receive WhatsApp SMS
- A connection that WhatsApp accepts for registration

## Setup

```bash
npm install
npm start
```

The program asks for the phone number in international format, for example `15551234567`. You can also pass it as an argument:

```bash
npm start -- 15551234567
```

After WhatsApp sends the code, enter it in the terminal. The session is stored under `~/.whatsapp-sms-bot/` and is reused on later starts.

Send `ping` to the registered WhatsApp account to receive `pong`.

## Configuration

```bash
WA_SESSION_DIR=/secure/path WA_DISPLAY_NAME="My Bot" npm start -- 15551234567
```

The default registration method is SMS. Set `WA_CODE_METHOD=voice` to request a voice call, or `WA_CODE_METHOD=wa_old` when registering an already-active account through the supported legacy flow.

## Security and operational notes

Never commit the session directory, verification codes, or WhatsApp credentials. This bot uses a non-official WhatsApp client protocol; use it only with accounts and numbers you control and follow WhatsApp's terms. Do not repeatedly request codes: WhatsApp may rate-limit or restrict the number.

This starter bot deliberately has one small behavior (`ping` → `pong`). Add commands incrementally and validate user input before sending messages or changing account data.
