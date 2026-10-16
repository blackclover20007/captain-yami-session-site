import 'dotenv/config';

import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import makeWASocket, { Browsers, useMultiFileAuthState } from '@whiskeysockets/baileys';
import P from 'pino';
import QRCode from 'qrcode';

const root = path.dirname(fileURLToPath(import.meta.url));
const sessionRoot = path.resolve(process.env.SESSION_ROOT || './sessions');
const port = Number(process.env.PORT || 3000);
const siteKey = process.env.PAIRING_SITE_KEY || '';
const logger = P({ level: process.env.LOG_LEVEL || 'info' });
const sessions = new Map();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function cleanPhone(input) { return String(input || '').replace(/\D/g, ''); }
function keyIsValid(requestedKey) { return !siteKey || requestedKey === siteKey; }
function newSessionId() { return `yami_${randomBytes(18).toString('base64url')}`; }
function authDirFor(id) { return path.join(sessionRoot, id, 'auth_info'); }
function publicPairing(state) { return { ...state.pairing, qr: state.pairing.mode === 'qr' ? state.pairing.qr : '' }; }

function getSession(id) { return id && sessions.get(id); }
async function resolveSession(id) {
  if (!id || !/^yami_[A-Za-z0-9_-]{24}$/.test(id)) return null;
  const existing = getSession(id);
  if (existing) return existing;
  const authDir = authDirFor(id);
  if (!(await registered(authDir))) return null;
  const state = {
    id,
    authDir,
    activeSocket: null,
    lastPairAt: 0,
    pairing: {
      status: 'complete',
      mode: 'restored',
      code: '',
      qr: '',
      phone: '',
      sessionId: await collectSessionId(authDir),
      message: 'Session restored. Copy it into the bot deployment.'
    }
  };
  sessions.set(id, state);
  return state;
}
function sessionIdFrom(req, input = {}) { return req.headers['x-session-id'] || input.sessionId; }

async function registered(authDir) {
  try {
    const creds = JSON.parse(await readFile(path.join(authDir, 'creds.json'), 'utf8'));
    return Boolean(creds.registered);
  } catch { return false; }
}

async function collectSessionId(authDir) {
  const files = {};
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, relative);
      else files[relative] = (await readFile(full)).toString('base64');
    }
  }
  await walk(authDir);
  return `YAMI_SESSION_V1.${gzipSync(Buffer.from(JSON.stringify(files))).toString('base64url')}`;
}

async function finishReconnectedSession(state, sock) {
  const sessionId = await collectSessionId(state.authDir);
  const phone = state.pairing.phone;
  const target = phone ? `${phone}@s.whatsapp.net` : sock.user?.id;
  let delivery = 'failed';
  let message = 'Session forged. Use the hidden panel below to copy it.';
  try {
    if (!target) throw new Error('The linked WhatsApp account could not be identified.');
    await sock.sendMessage(target, {
      text: `Captain Yami Bot session ready.\n\nSESSION_ID (keep private):\n${sessionId}\n\nAdd it to your bot host as:\nSESSION_ID=${sessionId}`
    });
    delivery = 'sent';
    message = 'Session forged and sent privately to your WhatsApp chat. The panel also has a hidden copy button.';
  } catch (error) {
    logger.warn({ error: error.message }, 'Could not send session ID to WhatsApp');
    message = 'Session forged, but WhatsApp delivery failed. Use Reveal Session ID or Copy Session ID below.';
  }
  state.pairing = { ...state.pairing, status: 'complete', sessionId, delivery, message, qr: '' };
  state.activeSocket = null;
  await sock.end?.(undefined);
}

async function reconnectAfterPairingRestart(state, mode) {
  const { state: authState, saveCreds } = await useMultiFileAuthState(state.authDir);
  const sock = makeWASocket({ auth: authState, browser: Browsers.ubuntu('Chrome'), logger, markOnlineOnConnect: false, syncFullHistory: false });
  state.activeSocket = sock;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') return finishReconnectedSession(state, sock);
    if (connection === 'close') {
      if (state.pairing.status === 'complete') return;
      const code = lastDisconnect?.error?.output?.statusCode;
      state.activeSocket = null;
      state.pairing = { ...state.pairing, status: 'failed', qr: '', sessionId: '', message: `WhatsApp closed the resumed session (${code || 'temporary error'}). Refresh and try again.` };
    }
  });
  state.pairing = { ...state.pairing, status: 'reconnecting', mode, qr: '', message: 'WhatsApp accepted the code. Reopening the Captain Yami session…' };
}

async function startPairing(state, { phone = '', requestedKey, mode }) {
  if (!keyIsValid(requestedKey)) throw new Error('Invalid site key.');
  if (state.activeSocket || ['waiting', 'code', 'qr'].includes(state.pairing.status)) throw new Error('This session slot already has a pairing ritual active.');
  if (Date.now() - state.lastPairAt < 15000) throw new Error('Please wait 15 seconds before requesting another code in this slot.');
  if (mode === 'code' && (phone.length < 8 || phone.length > 15)) throw new Error('Enter an international number with country code, digits only.');
  if (await registered(state.authDir)) throw new Error('This slot already has a session. Use Delete Existing Session or create a new slot.');

  state.lastPairAt = Date.now();
  await rm(path.dirname(state.authDir), { recursive: true, force: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(state.authDir);
  state.pairing = { status: 'awakening', mode, code: '', qr: '', phone, sessionId: '', message: 'Opening the Black Clover gate…' };

  const sock = makeWASocket({ auth: authState, browser: Browsers.ubuntu('Chrome'), logger, markOnlineOnConnect: false, syncFullHistory: false });
  state.activeSocket = sock;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr && mode === 'qr') {
      state.pairing = { ...state.pairing, status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 2, width: 320 }), message: 'Scan this QR with WhatsApp → Linked devices → Link a device.' };
    }
    if (connection === 'open') {
      await finishReconnectedSession(state, sock);
    }
    if (connection === 'close' && state.pairing.status !== 'complete') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === 515 && mode === 'code' && state.pairing.code) {
        await reconnectAfterPairingRestart(state, mode);
        return;
      }
      const recovery = code === 428 ? ' Check WhatsApp Linked devices, remove an unused companion, then retry.' : ' Try again.';
      state.pairing = { ...state.pairing, status: 'failed', code: '', qr: '', sessionId: '', message: `WhatsApp closed the gate (${code || 'temporary error'}).${recovery}` };
      state.activeSocket = null;
    }
  });

  if (mode === 'code') {
    state.pairing.status = 'waiting';
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.PAIRING_REQUEST_DELAY_MS || 1800)));
    const code = await sock.requestPairingCode(phone);
    state.pairing = { ...state.pairing, status: 'code', code, qr: '', message: 'Phone-code mode is active. QR is intentionally hidden. On WhatsApp: Linked devices → Link a device → Link with phone number.' };
  } else {
    state.pairing.status = 'waiting';
  }
}

async function body(req) {
  let value = '';
  for await (const chunk of req) value += chunk;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, service: 'captain-yami-session-site', activeSlots: sessions.size });
    if (req.method === 'POST' && req.url === '/api/session') {
      const input = await body(req);
      if (!keyIsValid(input.siteKey)) return json(res, 403, { error: 'Invalid site key.' });
      const id = newSessionId();
      sessions.set(id, { id, authDir: authDirFor(id), activeSocket: null, lastPairAt: 0, pairing: { status: 'idle', mode: '', code: '', qr: '', phone: '', sessionId: '', message: 'Session slot ready. Choose a pairing method.' } });
      return json(res, 201, { sessionId: id });
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      if (!keyIsValid(req.headers['x-site-key'])) return json(res, 403, { error: 'Invalid site key.' });
      const state = await resolveSession(sessionIdFrom(req));
      if (!state) return json(res, 404, { error: 'Session slot not found. Create a new slot.' });
      return json(res, 200, publicPairing(state));
    }
    if (req.method === 'POST' && ['/api/pair', '/api/pair-qr'].includes(req.url)) {
      const input = await body(req);
      if (!keyIsValid(input.siteKey)) return json(res, 403, { error: 'Invalid site key.' });
      const state = await resolveSession(sessionIdFrom(req, input));
      if (!state) return json(res, 404, { error: 'Session slot not found. Create a new slot first.' });
      const mode = req.url === '/api/pair-qr' ? 'qr' : 'code';
      const phone = cleanPhone(input.phone);
      if (mode === 'code' && (phone.length < 8 || phone.length > 15)) return json(res, 400, { error: 'Enter an international number with country code, digits only.' });
      startPairing(state, { phone, requestedKey: input.siteKey, mode }).catch((error) => { state.pairing = { ...state.pairing, status: 'failed', message: error.message }; });
      return json(res, 202, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/reset') {
      const input = await body(req);
      if (!keyIsValid(input.siteKey)) return json(res, 403, { error: 'Invalid site key.' });
      const state = await resolveSession(sessionIdFrom(req, input));
      if (!state) return json(res, 404, { error: 'Session slot not found.' });
      if (state.activeSocket) return json(res, 409, { error: 'Finish or cancel the active pairing ritual first.' });
      await rm(path.dirname(state.authDir), { recursive: true, force: true });
      state.pairing = { status: 'idle', mode: '', code: '', qr: '', phone: '', sessionId: '', message: 'Existing session deleted. Choose a new pairing method.' };
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/session/delete') {
      const input = await body(req);
      if (!keyIsValid(input.siteKey)) return json(res, 403, { error: 'Invalid site key.' });
      const state = await resolveSession(sessionIdFrom(req, input));
      if (!state) return json(res, 404, { error: 'Session slot not found.' });
      if (state.activeSocket) return json(res, 409, { error: 'Finish or cancel the active pairing ritual first.' });
      await rm(path.dirname(state.authDir), { recursive: true, force: true });
      sessions.delete(state.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = await readFile(path.join(root, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(404); res.end('Not found');
  } catch (error) {
    logger.error(error, 'Session site request failed');
    json(res, 500, { error: 'The devil gate encountered an internal error.' });
  }
});

server.listen(port, '0.0.0.0', () => logger.info({ port }, 'Captain Yami Session Site online'));
