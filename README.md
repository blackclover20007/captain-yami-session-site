# Captain Yami Session Site

A standalone browser-based WhatsApp pairing service for **Captain Yami Bot · Yami Black Clover**.

This repository is intentionally separate from the bot repository:

- Pairing site: https://github.com/blackclover20007/captain-yami-session-site
- Bot: https://github.com/blackclover20007/captain-yami-bot

## Run on Replit

```bash
npm install
cp .env.example .env
npm start
```

Replit exposes the web app on port `3000`. Set `PAIRING_SITE_KEY` as a Replit Secret for a public deployment, then enter the same key in the web form.

## Deploy on Render

Deploy this repository as a Render Blueprint. The included `render.yaml` starts the service with `npm start` and generates a `PAIRING_SITE_KEY`. Open the Render URL, enter the generated key, and follow the WhatsApp instructions.

## Pair and export

1. Enter the WhatsApp number in international format with country code.
2. On the phone open **WhatsApp → Linked devices → Link a device → Link with phone number**.
3. Enter the code shown by the Devil Gate page.
4. Wait for the session to complete.
5. Copy the `YAMI_SESSION_V1...` value.
6. Put it in the bot deployment as:

```env
SESSION_ID=YAMI_SESSION_V1...
```

The bot repository consumes the session and no longer performs interactive console pairing.

## Security

Treat the session ID and `auth_info/` as passwords. Never commit them, paste them into public issues, or expose the status endpoint without `PAIRING_SITE_KEY`. If a session is exposed, unlink it from WhatsApp and generate a new one.
