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

Deploy this repository as a Render Blueprint. The included `render.yaml` creates a Node web service, runs `npm install`, starts it with `npm start`, binds through Render's `PORT` on `0.0.0.0`, and checks `/health`. Render generates a `PAIRING_SITE_KEY`; open the Render URL, enter that generated key, and follow the WhatsApp instructions.

If you configure the service manually instead of using the Blueprint, use:

```text
Runtime: Node
Build command: npm install
Start command: npm start
Health check path: /health
```

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
