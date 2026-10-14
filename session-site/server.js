import 'dotenv/config';

import http from 'node:http';
import path from 'node:path';
import { readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import P from 'pino';

const root = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.resolve(process.env.SESSION_AUTH_DIR || './auth_info');
const port = Number(process.env.PORT || 3000);
const siteKey = process.env.PAIRING_SITE_KEY || '';
const logger = P({ level: process.env.LOG_LEVEL || 'info' });

let pairing = { status: 'idle', code: '', phone: '', sessionId: '', message: '' };
let activeSocket = null;
let lastPairAt = 0;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function cleanPhone(input) {
  return String(input || '').replace(/\D/g, '');
}

async function registered() {
  try {
    const creds = JSON.parse(await readFile(path.join(authDir, 'creds.json'), 'utf8'));
    return Boolean(creds.registered);
  } catch {
    return false;
  }
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

async function startPairing(phone, requestedKey) {
  if (siteKey && requestedKey !== siteKey) throw new Error('Invalid site key.');
  if (activeSocket || pairing.status === 'waiting' || pairing.status === 'code') throw new Error('A pairing ritual is already active.');
  if (Date.now() - lastPairAt < 30000) throw new Error('Please wait 30 seconds before requesting another code.');
  if (await registered()) throw new Error('A session already exists. Delete auth_info on this Repl before pairing a new number.');

  lastPairAt = Date.now();
  await rm(authDir, { recursive: true, force: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  pairing = { status: 'awakening', code: '', phone, sessionId: '', message: 'Opening the Black Clover gate…' };

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  activeSocket = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      pairing = { status: 'complete', code: pairing.code, phone, sessionId: await collectSessionId(), message: 'Session forged. Copy it into the bot deployment.' };
      activeSocket = null;
      await sock.end?.(undefined);
    }
    if (connection === 'close' && pairing.status !== 'complete') {
      const code = lastDisconnect?.error?.output?.statusCode;
      pairing = { status: 'failed', code: '', phone, sessionId: '', message: `WhatsApp closed the gate (${code || 'temporary error'}). Try again.` };
      activeSocket = null;
    }
  });

  pairing.status = 'waiting';
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.PAIRING_REQUEST_DELAY_MS || 1800)));
  const code = await sock.requestPairingCode(phone);
  pairing = { ...pairing, status: 'code', code, message: 'On WhatsApp: Linked devices → Link a device → Link with phone number.' };
}

async function body(req) {
  let value = '';
  for await (const chunk of req) value += chunk;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/status') {
      if (siteKey && req.headers['x-site-key'] !== siteKey) return json(res, 403, { error: 'Invalid site key.' });
      return json(res, 200, { ...pairing, sessionId: pairing.status === 'complete' ? pairing.sessionId : '' });
    }
    if (req.method === 'POST' && req.url === '/api/pair') {
      const input = await body(req);
      const phone = cleanPhone(input.phone);
      if (phone.length < 8 || phone.length > 15) return json(res, 400, { error: 'Enter an international number with country code, digits only.' });
      startPairing(phone, input.siteKey).catch((error) => { pairing = { ...pairing, status: 'failed', message: error.message }; });
      return json(res, 202, { ok: true });
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
