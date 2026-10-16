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

The Devil Gate menu has three session controls:

- **Phone Code**: enter the number, then use **WhatsApp → Linked devices → Link a device → Link with phone number** and enter the displayed code.
- **QR Code**: choose QR Code and scan the live QR from **WhatsApp → Linked devices → Link a device**.
- **Delete Existing Session**: protected by `PAIRING_SITE_KEY`; use it when the service says a session already exists or when switching to another WhatsApp account. This deletes the pairing site's local `auth_info/` only; it does not delete the bot host's copied session ID.

After either pairing method:

1. Wait for the session to complete.
2. Copy the `YAMI_SESSION_V1...` value.
3. Put it in the bot deployment as:

```env
SESSION_ID=YAMI_SESSION_V1...
```

The bot repository consumes the session and no longer performs interactive console pairing.

## Multi-user panel behavior

The panel creates an isolated session slot for each visitor and stores its temporary auth state under `SESSION_ROOT` (default `./sessions`). One user's pairing activity does not replace another user's slot.

- **Phone Code mode** displays only the WhatsApp phone-linking code. QR data is intentionally suppressed in both the backend response and the browser UI.
- **QR Code mode** displays only the live QR image for that slot.
- **New Slot** creates another isolated workspace in the same panel.
- **Resume Slot** restores the browser's current slot after a refresh using local storage.
- **Delete This Session** removes only the current visitor's slot and its auth files.

The session ID is still shown only after that slot successfully connects. Each user should copy their own ID into their own bot deployment as `SESSION_ID`.

When pairing completes, the page displays a **Session ready** panel. The `YAMI_SESSION_V1...` value is blurred by default; use **Reveal Session ID** or **Copy Session ID**. Completed slots are restored from `SESSION_ROOT` when the page or service restarts, so refreshing the page does not hide a successfully generated session.

The service also sends the session ID privately to the linked WhatsApp account in a message containing the `SESSION_ID=` environment-variable line. For phone-code pairing it sends to the number entered in the form; for QR pairing it sends to the WhatsApp account identified by the linked socket. If delivery fails, the masked web panel remains available as a fallback.

## Security

Treat the session ID and `auth_info/` as passwords. Never commit them, paste them into public issues, or expose the status endpoint without `PAIRING_SITE_KEY`. If a session is exposed, unlink it from WhatsApp and generate a new one.
