import 'dotenv/config';

import http from 'node:http';
import path from 'node:path';
import { readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import makeWASocket, { Browsers, useMultiFileAuthState } from '@whiskeysockets/baileys';
import P from 'pino';
import QRCode from 'qrcode';

const root = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.resolve(process.env.SESSION_AUTH_DIR || './auth_info');
const port = Number(process.env.PORT || 3000);
const siteKey = process.env.PAIRING_SITE_KEY || '';
const logger = P({ level: process.env.LOG_LEVEL || 'info' });

let pairing = { status: 'idle', mode: '', code: '', qr: '', phone: '', sessionId: '', message: '' };
let activeSocket = null;
let lastPairAt = 0;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function cleanPhone(input) { return String(input || '').replace(/\D/g, ''); }
function keyIsValid(requestedKey) { return !siteKey || requestedKey === siteKey; }

async function registered() {
  try {
    const creds = JSON.parse(await readFile(path.join(authDir, 'creds.json'), 'utf8'));
    return Boolean(creds.registered);
  } catch { return false; }
}

async function collectSessionId() {
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

async function startPairing({ phone = '', requestedKey, mode }) {
  if (!keyIsValid(requestedKey)) throw new Error('Invalid site key.');
  if (activeSocket || ['waiting', 'code', 'qr'].includes(pairing.status)) throw new Error('A pairing ritual is already active.');
  if (Date.now() - lastPairAt < 30000) throw new Error('Please wait 30 seconds before requesting another code.');
  if (mode === 'code' && (phone.length < 8 || phone.length > 15)) throw new Error('Enter an international number with country code, digits only.');
  if (await registered()) throw new Error('A session already exists. Use Delete Existing Session first.');

  lastPairAt = Date.now();
  await rm(authDir, { recursive: true, force: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  pairing = { status: 'awakening', mode, code: '', qr: '', phone, sessionId: '', message: 'Opening the Black Clover gate…' };

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  activeSocket = sock;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr && mode === 'qr') {
      pairing = { ...pairing, status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 2, width: 320 }), message: 'Scan this QR with WhatsApp → Linked devices → Link a device.' };
    }
    if (connection === 'open') {
      pairing = { ...pairing, status: 'complete', sessionId: await collectSessionId(), message: 'Session forged. Copy it into the bot deployment.', qr: '' };
      activeSocket = null;
      await sock.end?.(undefined);
    }
    if (connection === 'close' && pairing.status !== 'complete') {
      const code = lastDisconnect?.error?.output?.statusCode;
      pairing = { ...pairing, status: 'failed', code: '', qr: '', sessionId: '', message: `WhatsApp closed the gate (${code || 'temporary error'}). Try again.` };
      activeSocket = null;
    }
  });

  if (mode === 'code') {
    pairing.status = 'waiting';
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.PAIRING_REQUEST_DELAY_MS || 1800)));
    const code = await sock.requestPairingCode(phone);
    pairing = { ...pairing, status: 'code', code, message: 'On WhatsApp: Linked devices → Link a device → Link with phone number.' };
  } else {
    pairing.status = 'waiting';
  }
}

async function body(req) {
  let value = '';
  for await (const chunk of req) value += chunk;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, service: 'captain-yami-session-site' });
    if (req.method === 'GET' && req.url === '/api/status') {
      if (!keyIsValid(req.headers['x-site-key'])) return json(res, 403, { error: 'Invalid site key.' });
      return json(res, 200, { ...pairing, sessionId: pairing.status === 'complete' ? pairing.sessionId : '' });
    }
    if (req.method === 'POST' && ['/api/pair', '/api/pair-qr'].includes(req.url)) {
      const input = await body(req);
      const mode = req.url === '/api/pair-qr' ? 'qr' : 'code';
      const phone = cleanPhone(input.phone);
      if (mode === 'code' && (phone.length < 8 || phone.length > 15)) return json(res, 400, { error: 'Enter an international number with country code, digits only.' });
      startPairing({ phone, requestedKey: input.siteKey, mode }).catch((error) => { pairing = { ...pairing, status: 'failed', message: error.message }; });
      return json(res, 202, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/reset') {
      const input = await body(req);
      if (!keyIsValid(input.siteKey)) return json(res, 403, { error: 'Invalid site key.' });
      if (activeSocket) return json(res, 409, { error: 'Finish or cancel the active pairing ritual first.' });
      await rm(authDir, { recursive: true, force: true });
      pairing = { status: 'idle', mode: '', code: '', qr: '', phone: '', sessionId: '', message: 'Existing session deleted. Choose a new pairing method.' };
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
