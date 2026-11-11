#!/usr/bin/env node
/* Kanban Board v0.02 server: zero npm dependencies, Node 18+.
   The Raspberry Pi runs this and is the single source of truth.
   - Serves ./public (the board page)
   - JSON API: GET /api/board, PUT /api/card/:id, DELETE /api/card/:id, PUT /api/board, PUT /api/meta
   - GET /api/events: Server-Sent Events (live updates + heartbeat pings)
   - GET /healthz
   - GET/POST /login: sets an HttpOnly cookie so the browser (and SSE) can authenticate
   Conflicts are settled per card: the newest updatedAt wins. Deletes are tombstones.
   Config (env): PORT=8080 HOST=127.0.0.1 DATA_DIR=./data BACKUPS=30 BACKUP_MIN_INTERVAL_S=300
                 TOMBSTONE_DAYS=60 PING_S=15
                 AUTH_TOKEN (required; KANBAN_TOKEN is accepted as another name)
   Every route except /login requires the token via Authorization: Bearer or the
   kanban_token cookie. The process refuses to listen if that token is unset.
   Do not pass the token in a query string. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '0.02';
const SCHEMA = 3;
const PORT = parseInt(process.env.PORT || '8080', 10);
const DEFAULT_HOST = '127.0.0.1';
const HOST = process.env.HOST || DEFAULT_HOST;
const MAX_TOKEN_CHARS = 256;
const LOGIN_BODY_MAX = 4096;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const BACKUPS = Math.max(0, parseInt(process.env.BACKUPS || '30', 10));
const BACKUP_MIN_INTERVAL = Math.max(0, parseInt(process.env.BACKUP_MIN_INTERVAL_S || '300', 10)) * 1000;
const TOMBSTONE_MS = Math.max(1, parseFloat(process.env.TOMBSTONE_DAYS || '60')) * 864e5;
const PING_MS = Math.max(1, parseFloat(process.env.PING_S || '15')) * 1000;
const MAX_BODY = 5 * 1024 * 1024;
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* Shared secret. Read at startup in main(); empty means fail closed. */
let expectedToken = '';

/* First non-empty AUTH_TOKEN, otherwise KANBAN_TOKEN. Whitespace-only is empty. */
function configuredToken() {
  for (const key of ['AUTH_TOKEN', 'KANBAN_TOKEN']) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0 && value.trim().length > 0) return value;
  }
  return '';
}

/* Constant-time compare of SHA-256 digests. Over-long or empty input returns
   false before hashing so a huge header cannot throw or burn CPU as a 500. */
function safeEqual(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (presented.length === 0 || presented.length > MAX_TOKEN_CHARS) return false;
  if (expected.length === 0 || expected.length > MAX_TOKEN_CHARS) return false;
  const left = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const right = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function loginCookie(token, secure) {
  const parts = [
    'kanban_token=' + encodeURIComponent(token),
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=31536000'
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* Same-origin path only. Anything else (absolute URL, //host, backslash, scheme) becomes /. */
function safeNext(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return '/';
  let value;
  try { value = decodeURIComponent(raw); } catch (_) { return '/'; }
  if (value.length === 0 || value.length > 2048 || value[0] !== '/') return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (value.includes('\\') || value.includes('://')) return '/';
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return '/';
  if (/%2f|%5c/i.test(value)) return '/';
  const pathPart = value.split('?')[0];
  if (pathPart.includes(':')) return '/';
  return value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function cookieValue(header, name) {
  if (typeof header !== 'string' || header.length === 0) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    let val = part.slice(eq + 1).trim();
    if (val.length >= 2 && val.charCodeAt(0) === 34 && val.charCodeAt(val.length - 1) === 34) val = val.slice(1, -1);
    try { return decodeURIComponent(val); } catch (_) { return val; }
  }
  return '';
}

/* null when the Authorization header is absent. A present but unusable header is ''. */
function bearerValue(header) {
  if (typeof header !== 'string' || header.length === 0) return null;
  if (header.length > MAX_TOKEN_CHARS + 64) return header.slice(0, MAX_TOKEN_CHARS + 1);
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : '';
}

function requestAuthorized(req) {
  const fromHeader = bearerValue(req.headers.authorization);
  if (fromHeader != null && safeEqual(fromHeader, expectedToken)) return true;
  const fromCookie = cookieValue(req.headers.cookie, 'kanban_token');
  if (!fromCookie) return false;
  return safeEqual(fromCookie, expectedToken);
}

/* ---------- storage ---------- */
let board = null;      // {schema, rev, fresh, cards:[...incl. tombstones], tagColors, metaUpdatedAt}
let lastBackup = 0;

function emptyBoard() { return { schema: SCHEMA, rev: 0, fresh: true, cards: [], tagColors: {}, metaUpdatedAt: 0 }; }

function readBoardFile(file) {
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!b || !Array.isArray(b.cards)) throw new Error('no cards array');
  return b;
}

function loadBoard() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!fs.existsSync(BOARD_FILE)) { board = emptyBoard(); log('No board yet; starting fresh at', BOARD_FILE); return; }
  try {
    board = readBoardFile(BOARD_FILE);
  } catch (e) {
    const bad = BOARD_FILE + '.corrupt-' + Date.now();
    log('board.json unreadable (' + e.message + '); moving it to', bad);
    try { fs.renameSync(BOARD_FILE, bad); } catch (_) {}
    board = null;
    for (const f of listBackups().reverse()) {
      try { board = readBoardFile(path.join(BACKUP_DIR, f)); log('Restored from backup', f); break; } catch (_) {}
    }
    if (!board) board = emptyBoard();
  }
  board.schema = SCHEMA;
  board.rev = board.rev || 0;
  board.tagColors = board.tagColors || {};
  board.metaUpdatedAt = board.metaUpdatedAt || 0;
  board.fresh = !!board.fresh && board.cards.length === 0;
  board.cards.forEach(fixOwner);
  pruneTombstones();
}

function listBackups() {
  try { return fs.readdirSync(BACKUP_DIR).filter(f => /^board-.*\.json$/.test(f)).sort(); } catch (_) { return []; }
}

function backup(force) {
  if (!BACKUPS || !fs.existsSync(BOARD_FILE)) return;
  const t = Date.now();
  if (!force && t - lastBackup < BACKUP_MIN_INTERVAL) return;
  lastBackup = t;
  const name = 'board-' + new Date(t).toISOString().replace(/[:.]/g, '-') + '.json';
  try { fs.copyFileSync(BOARD_FILE, path.join(BACKUP_DIR, name)); } catch (e) { log('backup failed', e.message); }
  const all = listBackups();
  for (const f of all.slice(0, Math.max(0, all.length - BACKUPS))) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {} }
}

/* Atomic write: temp file + fsync + rename, so a power cut never leaves half a file. */
function persist(forceBackup) {
  backup(forceBackup);
  const tmp = BOARD_FILE + '.tmp-' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(board)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, BOARD_FILE);
  try { const dfd = fs.openSync(DATA_DIR, 'r'); fs.fsyncSync(dfd); fs.closeSync(dfd); } catch (_) {}
}

function pruneTombstones() {
  const cutoff = Date.now() - TOMBSTONE_MS;
  const before = board.cards.length;
  board.cards = board.cards.filter(c => !(c.deleted && c.updatedAt < cutoff));
  return before - board.cards.length;
}

/* ---------- merge rules ---------- */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/* v0.01 owner value 'husband' was renamed to 'personb'. */
function fixOwner(c) { if (c && typeof c.owner === 'string' && c.owner.trim().toLowerCase() === 'husband') c.owner = 'personb'; return c; }
function validCard(c) { return c && typeof c === 'object' && ID_RE.test(String(c.id)) && Number.isFinite(c.updatedAt); }
function findIdx(id) { return board.cards.findIndex(c => c.id === id); }

/* Returns {applied, card}: card is whichever version won. */
function upsert(card) {
  const i = findIdx(card.id);
  const cur = i >= 0 ? board.cards[i] : null;
  if (cur && !(card.updatedAt > cur.updatedAt)) return { applied: false, card: cur };
  if (i >= 0) board.cards[i] = card; else board.cards.push(card);
  return { applied: true, card };
}

function bump() { board.rev++; board.fresh = false; }

/* ---------- SSE ---------- */
const clients = new Set();
function sse(res, event, data) { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
function broadcast(event, data) { for (const res of clients) { try { sse(res, event, data); } catch (_) {} } }
function startHousekeeping() {
  setInterval(() => broadcast('ping', { t: Date.now(), rev: board ? board.rev : 0 }), PING_MS).unref();
  setInterval(() => { if (board && pruneTombstones()) { bump(); persist(); } }, 6 * 3600e3).unref();
}

/* ---------- HTTP helpers ---------- */
function send(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
function unauthorized(req, res) {
  if (req && req.readable) req.resume();
  if (req && req.method === 'HEAD') {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': 0 });
    res.end();
    return;
  }
  return send(res, 401, { error: 'unauthorized' });
}
function redirectTo(res, location, extra) {
  res.writeHead(302, Object.assign({ Location: location, 'Cache-Control': 'no-store', 'Content-Length': 0 }, extra || {}));
  res.end();
}
function redirectToLogin(res, url) {
  const next = safeNext(url.pathname + url.search);
  redirectTo(res, '/login?next=' + encodeURIComponent(next));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', ch => { size += ch.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { code: 413 })); req.destroy(); } else chunks.push(ch); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(Object.assign(new Error('Invalid JSON'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (_) { return send(res, 400, { error: 'bad path' }); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize('/' + rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (pathname === '/' || pathname === '/index.html' || pathname.endsWith('.html')) {
      headers['Set-Cookie'] = loginCookie(expectedToken, !!(req.socket && req.socket.encrypted));
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function loginPage(next) {
  return '<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kanban login</title></head>\n<body>\n<form method="post" action="/login">\n<input type="hidden" name="next" value="' + escapeHtml(next) + '">\n<label>Token <input name="token" type="password" autocomplete="current-password" maxlength="256" required></label>\n<button type="submit">Sign in</button>\n</form>\n</body>\n</html>\n';
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    req.on('data', ch => {
      size += ch.length;
      if (size > limit) {
        finish(null, null);
        return;
      }
      chunks.push(ch);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    req.on('error', err => finish(err));
  });
}

function loginRequestFields(raw, contentType) {
  const out = { token: '', next: '' };
  if (raw == null) return out;
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.token === 'string') out.token = parsed.token;
      else if (parsed && typeof parsed.password === 'string') out.token = parsed.password;
      if (parsed && typeof parsed.next === 'string') out.next = parsed.next;
    } catch (_) {}
    return out;
  }
  if (ct.includes('application/x-www-form-urlencoded') || raw.includes('=')) {
    const params = new URLSearchParams(raw);
    const token = params.get('token');
    const password = params.get('password');
    if (typeof token === 'string' && token.length > 0) out.token = token;
    else if (typeof password === 'string' && password.length > 0) out.token = password;
    const next = params.get('next');
    if (typeof next === 'string') out.next = next;
    return out;
  }
  const line = raw.replace(/\r?\n$/, '');
  if (line && !line.includes('\n') && !line.includes('\r')) out.token = line;
  return out;
}

function handleLogin(req, res, method, url) {
  const secure = !!(req.socket && req.socket.encrypted);
  if (method === 'GET' || method === 'HEAD') {
    const next = safeNext(url.searchParams.get('next') || '');
    if (requestAuthorized(req)) return redirectTo(res, next, { 'Set-Cookie': loginCookie(expectedToken, secure) });
    const html = loginPage(next);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(html),
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(method === 'HEAD' ? undefined : html);
    return;
  }
  return readRaw(req, LOGIN_BODY_MAX).then(raw => {
    if (res.headersSent) return;
    if (raw == null) return unauthorized(req, res);
    const fields = loginRequestFields(raw, req.headers['content-type']);
    if (!safeEqual(fields.token, expectedToken)) return unauthorized(req, res);
    const next = safeNext(fields.next || url.searchParams.get('next') || '');
    redirectTo(res, next, { 'Set-Cookie': loginCookie(expectedToken, secure) });
  }).catch(() => {
    if (!res.headersSent) unauthorized(req, res);
  });
}

/* ---------- routes ---------- */
async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (_) { return send(res, 400, { error: 'bad path' }); }
  const p = url.pathname;
  const m = req.method;

  if (p === '/login' && (m === 'GET' || m === 'HEAD' || m === 'POST')) return handleLogin(req, res, m, url);
  if (!requestAuthorized(req)) {
    if ((m === 'GET' || m === 'HEAD') && (p === '/' || p === '/index.html')) return redirectToLogin(res, url);
    return unauthorized(req, res);
  }

  if (p === '/healthz') return send(res, 200, { ok: true, version: VERSION, rev: board.rev, cards: board.cards.filter(c => !c.deleted).length, clients: clients.size, uptimeS: Math.round(process.uptime()), serverTime: Date.now() });

  if (p === '/api/events' && m === 'GET') {
    req.socket.setTimeout(0); req.socket.setKeepAlive(true);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    sse(res, 'hello', { rev: board.rev, serverTime: Date.now(), version: VERSION });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/board' && m === 'GET') return send(res, 200, Object.assign({ serverTime: Date.now() }, board));

  if (p === '/api/board' && m === 'PUT') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.cards)) return send(res, 400, { error: 'expected {cards:[...]}' });
    if (url.searchParams.get('ifFresh') === '1' && !board.fresh) return send(res, 409, { error: 'board already has data' });
    const t = Date.now();
    const incoming = body.cards.filter(c => c && !c.deleted && ID_RE.test(String(c.id)));
    const ids = new Set(incoming.map(c => c.id));
    // Full replace (import): imported cards are stamped "now" so they beat older offline edits;
    // every card not in the import becomes a tombstone so it can't come back.
    const tombs = board.cards.filter(c => !ids.has(c.id)).map(c => c.deleted ? c : { id: c.id, deleted: true, updatedAt: t });
    board.cards = incoming.map(c => fixOwner(Object.assign({}, c, { updatedAt: t }))).concat(tombs);
    if (body.tagColors && typeof body.tagColors === 'object') { board.tagColors = body.tagColors; board.metaUpdatedAt = t; }
    bump(); persist(true);
    broadcast('board', { rev: board.rev });
    log('Board replaced:', incoming.length, 'cards');
    return send(res, 200, Object.assign({ serverTime: Date.now() }, board));
  }

  if (p === '/api/meta' && m === 'PUT') {
    const body = await readBody(req);
    if (!body || typeof body.tagColors !== 'object' || !Number.isFinite(body.updatedAt)) return send(res, 400, { error: 'expected {tagColors, updatedAt}' });
    if (body.updatedAt > board.metaUpdatedAt) {
      board.tagColors = body.tagColors; board.metaUpdatedAt = body.updatedAt; bump(); persist();
      broadcast('meta', { rev: board.rev, tagColors: board.tagColors, updatedAt: board.metaUpdatedAt });
    }
    return send(res, 200, { tagColors: board.tagColors, updatedAt: board.metaUpdatedAt, rev: board.rev });
  }

  const cm = p.match(/^\/api\/card\/([^/]+)$/);
  if (cm) {
    const id = decodeURIComponent(cm[1]);
    if (!ID_RE.test(id)) return send(res, 400, { error: 'bad card id' });
    if (m === 'PUT') {
      const card = await readBody(req);
      if (!validCard(card) || card.id !== id) return send(res, 400, { error: 'card needs matching id and numeric updatedAt' });
      if (card.deleted) return send(res, 400, { error: 'use DELETE to delete' });
      const r = upsert(fixOwner(card));
      if (r.applied) { bump(); persist(); broadcast('card', { rev: board.rev, card: r.card }); }
      return send(res, 200, { applied: r.applied, card: r.card, rev: board.rev });
    }
    if (m === 'DELETE') {
      const body = await readBody(req).catch(() => null);
      let ts = Number((body && body.updatedAt) || url.searchParams.get('updatedAt'));
      if (!Number.isFinite(ts) || ts <= 0) ts = Date.now();
      const r = upsert({ id, deleted: true, updatedAt: ts });
      if (r.applied) { bump(); persist(); broadcast('card', { rev: board.rev, card: r.card }); }
      return send(res, 200, { applied: r.applied, card: r.card, rev: board.rev });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  if (p.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });
  if (m === 'GET' || m === 'HEAD') return serveStatic(req, res, p);
  return send(res, 405, { error: 'method not allowed' });
}

function pathOnly(url) {
  const value = String(url || '');
  const q = value.indexOf('?');
  return q < 0 ? value : value.slice(0, q);
}

function failClosed() {
  try { fs.writeSync(2, 'AUTH_TOKEN not set\n'); } catch (_) {}
  process.exit(1);
}

function main() {
  const token = configuredToken();
  if (!token || token.length > MAX_TOKEN_CHARS) failClosed();
  expectedToken = token;
  loadBoard();
  startHousekeeping();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      if (!res.headersSent) {
        const code = e.code >= 400 && e.code < 600 ? e.code : 500;
        if (code === 401) unauthorized(req, res);
        else send(res, code, { error: code === 500 ? 'server error' : e.message });
      }
      if (!(e.code >= 400 && e.code < 500)) log('Error', req.method, pathOnly(req.url), e.stack || e);
    });
  });
  server.requestTimeout = 0; // SSE streams stay open indefinitely
  server.listen(PORT, HOST, () => log(`Kanban Board v${VERSION} on http://${HOST}:${PORT}  data: ${BOARD_FILE}`));
  function shutdown(sig) {
    log('Got', sig, '- shutting down');
    for (const res of clients) { try { res.end(); } catch (_) {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { safeEqual, loginCookie, DEFAULT_HOST, MAX_TOKEN_CHARS };

if (require.main === module) main();
