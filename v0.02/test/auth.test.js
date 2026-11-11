/* Auth, login cookie, fail-closed startup, and bind-address checks.
   Uses an obvious fake token only. Do not print it. Run: node test/auth.test.js */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn, spawnSync} = require('child_process');
const {safeEqual, loginCookie, DEFAULT_HOST, MAX_TOKEN_CHARS} = require('../server.js');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const TOKEN = 'fake-test-token';
const OTHER = 'other-fake-token';
const WRONG = 'wrong-test-token';
const UNAUTHORIZED = '{"error":"unauthorized"}';
const results = [];

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function childEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const key of ['AUTH_TOKEN', 'KANBAN_TOKEN', 'HOST', 'PORT', 'DATA_DIR']) delete env[key];
  return Object.assign(env, extra);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function listenAddrs(pid, port) {
  let text = '';
  try { text = fs.readFileSync(`/proc/${pid}/net/tcp`, 'utf8'); } catch (_) { return []; }
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  const found = [];
  for (const line of text.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[1].split(':');
    if (local.length !== 2 || local[1].toUpperCase() !== hexPort) continue;
    if (parts[3].toUpperCase() !== '0A') continue;
    found.push(local[0].toUpperCase());
  }
  return found;
}

function startServer(extra, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-auth-'));
  const env = childEnv(Object.assign({PORT: String(port), DATA_DIR: dir}, extra));
  const child = spawn(process.execPath, [SERVER], {env, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not listen')), 4000);
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error('server exited ' + code));
    });
    child.stdout.on('data', () => {
      if (/on http/.test(out)) { clearTimeout(timer); resolve(); }
    });
  });
  return {child, dir, ready, output: () => ({out, err})};
}

function stopServer(srv) {
  return new Promise(resolve => {
    if (!srv || !srv.child || srv.child.exitCode != null) return resolve();
    srv.child.once('exit', () => resolve());
    srv.child.kill('SIGTERM');
    setTimeout(() => { if (srv.child.exitCode == null) srv.child.kill('SIGKILL'); }, 1500).unref();
  });
}

function failStart(extra) {
  return freePort().then(port => new Promise(resolve => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-fail-'));
    const env = childEnv(Object.assign({PORT: String(port), DATA_DIR: dir}, extra));
    const child = spawn(process.execPath, [SERVER], {env, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({code: null, out, err, port, dir, listened: true});
    }, 3000);
    child.on('close', code => {
      clearTimeout(timer);
      const socket = net.connect({host: '127.0.0.1', port}, () => {
        socket.end();
        resolve({code, out, err, port, dir, listened: true});
      });
      socket.on('error', () => resolve({code, out, err, port, dir, listened: false}));
    });
  }));
}

function request(port, method, reqPath, opts) {
  const options = opts || {};
  const data = options.body == null ? null : Buffer.from(options.body);
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, options.headers || {});
    if (data) headers['Content-Length'] = data.length;
    const req = http.request({host: '127.0.0.1', port, method, path: reqPath, headers}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', err => reject(new Error(method + ' ' + reqPath.split('?')[0] + ' ' + err.message)));
    if (data) req.write(data);
    req.end();
  });
}

function openSSE(port, headers) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    const req = http.request({host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers: headers || {}}, res => {
      let buf = '';
      const timer = setTimeout(() => {
        req.destroy();
        finish({status: res.statusCode, headers: res.headers, body: buf, ended: false});
      }, 1200);
      res.on('data', c => {
        buf += c.toString('utf8');
        if (buf.includes('event: hello') || (res.statusCode !== 200 && buf.length > 0)) {
          clearTimeout(timer);
          req.destroy();
          finish({status: res.statusCode, headers: res.headers, body: buf, ended: false});
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        finish({status: res.statusCode, headers: res.headers, body: buf, ended: true});
      });
    });
    req.on('error', err => {
      if (err.code === 'ECONNRESET') return;
      finish(null, err);
    });
    req.end();
  });
}

function cookieFlags(header) {
  const parts = String(header || '').split(';').map(s => s.trim());
  return {parts, value: parts[0].startsWith('kanban_token=') ? decodeURIComponent(parts[0].slice('kanban_token='.length)) : ''};
}

async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({name, ok: true, ms: Date.now() - t});
    console.log('PASS', name);
  } catch (e) {
    results.push({name, ok: false, ms: Date.now() - t});
    console.log('FAIL', name, '-', e.message);
  }
}

function runs(args, env) {
  return spawnSync('bash', args, {env: childEnv(env), encoding: 'utf8'});
}

function countToken(text, secret) {
  if (!secret) return 0;
  return text.split(secret).length - 1;
}

(async () => {
  await check('safeEqual accepts only the same secret under the length cap', async () => {
    assert(safeEqual(TOKEN, TOKEN) === true, 'equal secrets did not match');
    assert(safeEqual(TOKEN, OTHER) === false, 'unequal secrets matched');
    assert(safeEqual('', TOKEN) === false, 'empty presented matched');
    assert(safeEqual(TOKEN, '') === false, 'empty expected matched');
    assert(safeEqual('x'.repeat(MAX_TOKEN_CHARS), TOKEN) === false, 'max-length wrong secret threw or matched');
    assert(safeEqual('x'.repeat(MAX_TOKEN_CHARS + 1), TOKEN) === false, 'over-long secret matched');
    assert(safeEqual(123, TOKEN) === false, 'non-string matched');
    assert(DEFAULT_HOST === '127.0.0.1', 'default host changed');
    const src = safeEqual.toString();
    assert(src.includes('timingSafeEqual'), 'compare does not use timingSafeEqual');
    assert(src.includes("sha256"), 'compare does not hash');
    const serverSrc = fs.readFileSync(SERVER, 'utf8');
    assert(serverSrc.includes('safeEqual(fromHeader, expectedToken)'), 'request path does not use safeEqual');
    assert(serverSrc.includes('safeEqual(fromCookie, expectedToken)'), 'cookie path does not use safeEqual');
    assert(serverSrc.includes('req.socket && req.socket.encrypted'), 'Secure flag is not tied to HTTPS');
    const secure = loginCookie(TOKEN, true);
    const plain = loginCookie(TOKEN, false);
    assert(secure.includes('HttpOnly') && secure.includes('SameSite=Strict') && secure.includes('Path=/') && secure.includes('Secure'), 'secure cookie flags incomplete');
    assert(!plain.includes('Secure'), 'plain cookie set Secure');
  });

  await check('server refuses to listen without a token', async () => {
    for (const extra of [{}, {AUTH_TOKEN: ''}, {AUTH_TOKEN: '   '}, {KANBAN_TOKEN: ''}, {AUTH_TOKEN: '   ', KANBAN_TOKEN: '   '}]) {
      const failed = await failStart(extra);
      assert(failed.code !== 0 && failed.code != null, 'process did not exit non-zero');
      assert(failed.listened === false, 'process listened without a token');
      assert(failed.err.includes('AUTH_TOKEN not set'), 'missing fail-closed log');
      assert(!fs.existsSync(path.join(failed.dir, 'board.json')), 'board was created without a token');
      fs.rmSync(failed.dir, {recursive: true, force: true});
    }
    const huge = 'x'.repeat(MAX_TOKEN_CHARS + 1);
    const over = await failStart({AUTH_TOKEN: huge});
    assert(over.code !== 0 && over.listened === false, 'over-long configured token was accepted');
    assert(over.err.includes('AUTH_TOKEN not set'), 'over-long token log mismatch');
    assert(!over.out.includes(huge) && !over.err.includes(huge), 'configured token was logged');
    fs.rmSync(over.dir, {recursive: true, force: true});
  });

  const port = await freePort();
  const srv = startServer({AUTH_TOKEN: TOKEN, KANBAN_TOKEN: OTHER}, port);
  try {
    await srv.ready;
    const auth = {Authorization: 'Bearer ' + TOKEN};
    const board = {id: 'c1', title: 'One', column: 'todo', updatedAt: 10};

    await check('missing token is 401 on every route and does not open SSE', async () => {
      const paths = [
        ['GET', '/api/board'],
        ['PUT', '/api/board', JSON.stringify({cards: []})],
        ['PUT', '/api/card/c1', JSON.stringify(board)],
        ['DELETE', '/api/card/c1', JSON.stringify({updatedAt: 11})],
        ['PUT', '/api/meta', JSON.stringify({tagColors: {}, updatedAt: 1})],
        ['GET', '/healthz'],
        ['GET', '/'],
        ['HEAD', '/'],
        ['GET', '/sw.js']
      ];
      for (const [method, reqPath, body] of paths) {
        const res = await request(port, method, reqPath, {body, headers: body ? {'Content-Type': 'application/json'} : {}});
        assert(res.status === 401, method + ' ' + reqPath + ' status ' + res.status);
        if (method !== 'HEAD') assert(res.body === UNAUTHORIZED, method + ' ' + reqPath + ' body ' + res.body);
        assert(String(res.headers['content-type'] || '').includes('application/json'), method + ' ' + reqPath + ' content-type');
        assert(!res.body.includes('<title>Kanban Board</title>'), 'board HTML leaked');
        assert(!res.body.includes('event:'), 'SSE leaked');
      }
      const sse = await openSSE(port);
      assert(sse.status === 401 && sse.body === UNAUTHORIZED, 'SSE without a token status ' + sse.status);
      assert(!String(sse.headers['content-type'] || '').includes('text/event-stream'), 'SSE stream started');
      assert(!sse.body.includes('event:'), 'SSE event leaked');
    });

    await check('wrong header and wrong cookie share the missing-token body', async () => {
      const missing = await request(port, 'GET', '/api/board');
      const header = await request(port, 'GET', '/api/board', {headers: {Authorization: 'Bearer ' + WRONG}});
      const cookie = await request(port, 'GET', '/api/board', {headers: {Cookie: 'kanban_token=' + WRONG}});
      const basic = await request(port, 'GET', '/api/board', {headers: {Authorization: 'Basic ' + WRONG}});
      const query = await request(port, 'GET', '/api/board?token=' + encodeURIComponent(TOKEN));
      const over = await request(port, 'GET', '/healthz', {headers: {Authorization: 'Bearer ' + 'x'.repeat(MAX_TOKEN_CHARS + 1)}});
      for (const res of [missing, header, cookie, basic, query, over]) {
        assert(res.status === 401 && res.body === UNAUTHORIZED, 'body ' + res.body);
      }
      const again = await request(port, 'GET', '/healthz', {headers: auth});
      assert(again.status === 200, 'server died after an over-long token');
    });

    await check('bearer token reaches the current success codes', async () => {
      const health = await request(port, 'GET', '/healthz', {headers: auth});
      assert(health.status === 200 && JSON.parse(health.body).ok === true, 'health ' + health.status);
      const page = await request(port, 'GET', '/', {headers: auth});
      assert(page.status === 200 && page.body.includes('<title>Kanban Board</title>'), 'board page ' + page.status);
      const asset = await request(port, 'GET', '/sw.js', {headers: auth});
      assert(asset.status === 200 && asset.body.includes('/login'), 'asset ' + asset.status);
      const put = await request(port, 'PUT', '/api/card/c1', {headers: Object.assign({'Content-Type': 'application/json'}, auth), body: JSON.stringify(board)});
      assert(put.status === 200 && JSON.parse(put.body).applied === true, 'put card ' + put.status);
      const meta = await request(port, 'PUT', '/api/meta', {headers: Object.assign({'Content-Type': 'application/json'}, auth), body: JSON.stringify({tagColors: {home: '#fff'}, updatedAt: 20})});
      assert(meta.status === 200 && JSON.parse(meta.body).tagColors.home === '#fff', 'meta ' + meta.status);
      const del = await request(port, 'DELETE', '/api/card/c1', {headers: Object.assign({'Content-Type': 'application/json'}, auth), body: JSON.stringify({updatedAt: 30})});
      assert(del.status === 200 && JSON.parse(del.body).card.deleted === true, 'delete ' + del.status);
      const replaced = await request(port, 'PUT', '/api/board', {headers: Object.assign({'Content-Type': 'application/json'}, auth), body: JSON.stringify({cards: [{id: 'c2', title: 'Two'}]})});
      assert(replaced.status === 200 && JSON.parse(replaced.body).cards.some(c => c.id === 'c2'), 'replace ' + replaced.status);
      const sse = await openSSE(port, auth);
      assert(sse.status === 200 && String(sse.headers['content-type'] || '').includes('text/event-stream'), 'SSE status ' + sse.status);
      assert(sse.body.includes('event: hello'), 'SSE hello missing');
      const other = await request(port, 'GET', '/api/board', {headers: {Authorization: 'Bearer ' + OTHER}});
      assert(other.status === 401 && other.body === UNAUTHORIZED, 'KANBAN_TOKEN overrode AUTH_TOKEN');
    });

    await check('login sets the cookie and a wrong login does not', async () => {
      const formPage = await request(port, 'GET', '/login');
      assert(formPage.status === 200 && formPage.body.includes('<form') && formPage.body.includes('action="/login"'), 'login form missing');
      assert(!formPage.body.includes(TOKEN), 'login form contained the token');
      const head = await request(port, 'HEAD', '/login');
      assert(head.status === 200 && head.body === '', 'HEAD /login status ' + head.status);
      assert(String(head.headers['content-type'] || '').includes('text/html'), 'HEAD /login content-type');
      const bad = await request(port, 'POST', '/login', {headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'token=' + WRONG});
      assert(bad.status === 401 && bad.body === UNAUTHORIZED, 'wrong login body ' + bad.body);
      assert(!bad.headers['set-cookie'], 'wrong login set a cookie');
      const raw = await request(port, 'POST', '/login', {body: TOKEN + '\n'});
      assert(raw.status === 302 && raw.headers.location === '/', 'raw login status ' + raw.status);
      const flags = cookieFlags([].concat(raw.headers['set-cookie'] || [])[0]);
      assert(flags.value === TOKEN, 'cookie value mismatch');
      assert(flags.parts.some(p => p === 'HttpOnly'), 'cookie missing HttpOnly');
      assert(flags.parts.some(p => p === 'SameSite=Strict'), 'cookie missing SameSite');
      assert(flags.parts.some(p => p === 'Path=/'), 'cookie missing Path');
      assert(flags.parts.some(p => p === 'Max-Age=31536000'), 'cookie missing Max-Age');
      assert(!flags.parts.some(p => p === 'Secure'), 'Secure set on HTTP');
      const cookie = 'kanban_token=' + encodeURIComponent(flags.value);
      const boardRes = await request(port, 'GET', '/api/board', {headers: {Cookie: cookie}});
      assert(boardRes.status === 200 && JSON.parse(boardRes.body).cards.some(c => c.id === 'c2'), 'cookie board ' + boardRes.status);
      const sse = await openSSE(port, {Cookie: 'other=1; ' + cookie});
      assert(sse.status === 200 && sse.body.includes('event: hello'), 'cookie SSE failed');
      const json = await request(port, 'POST', '/login', {headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: TOKEN})});
      assert(json.status === 302 && cookieFlags([].concat(json.headers['set-cookie'] || [])[0]).value === TOKEN, 'JSON login failed');
      const huge = await request(port, 'POST', '/login', {body: 'token=' + 'x'.repeat(5000)});
      assert(huge.status === 401 && huge.body === UNAUTHORIZED && !huge.headers['set-cookie'], 'over-long login body ' + huge.status);
      const still = await request(port, 'GET', '/healthz', {headers: auth});
      assert(still.status === 200, 'server died after a large login');
    });

    await check('server logs do not include the token', async () => {
      const logs = srv.output();
      assert(!logs.out.includes(TOKEN) && !logs.err.includes(TOKEN), 'token appeared in server logs');
      assert(!logs.out.includes(OTHER) && !logs.err.includes(OTHER), 'alternate token appeared in server logs');
      assert(/http:\/\/127\.0\.0\.1:\d+/.test(logs.out), 'listen log did not show loopback');
    });
  } finally {
    await stopServer(srv);
    fs.rmSync(srv.dir, {recursive: true, force: true});
  }

  await check('KANBAN_TOKEN is accepted when AUTH_TOKEN is unset', async () => {
    const p = await freePort();
    const alt = startServer({KANBAN_TOKEN: TOKEN}, p);
    try {
      await alt.ready;
      const res = await request(p, 'GET', '/healthz', {headers: {Authorization: 'Bearer ' + TOKEN}});
      assert(res.status === 200, 'KANBAN_TOKEN status ' + res.status);
      assert(!alt.output().out.includes(TOKEN) && !alt.output().err.includes(TOKEN), 'token logged');
    } finally {
      await stopServer(alt);
      fs.rmSync(alt.dir, {recursive: true, force: true});
    }
  });

  await check('default bind is loopback and HOST is explicit', async () => {
    const p = await freePort();
    const bound = startServer({AUTH_TOKEN: TOKEN}, p);
    try {
      await bound.ready;
      await sleep(50);
      const addrs = listenAddrs(bound.child.pid, p);
      assert(addrs.includes('0100007F'), 'default listen addrs ' + addrs.join(','));
      assert(!addrs.includes('00000000'), 'default bound every interface');
      assert(bound.output().out.includes('http://127.0.0.1:' + p), 'log host was not loopback');
    } finally {
      await stopServer(bound);
      fs.rmSync(bound.dir, {recursive: true, force: true});
    }
    const p2 = await freePort();
    const specific = startServer({AUTH_TOKEN: TOKEN, HOST: '127.0.0.2'}, p2);
    try {
      await specific.ready;
      await sleep(50);
      const addrs = listenAddrs(specific.child.pid, p2);
      assert(addrs.includes('0200007F'), 'specific listen addrs ' + addrs.join(','));
      assert(specific.output().out.includes('http://127.0.0.2:' + p2), 'HOST was ignored');
    } finally {
      await stopServer(specific);
      fs.rmSync(specific.dir, {recursive: true, force: true});
    }
  });

  await check('installer writes loopback, mode 0600, and does not flip an existing HOST', async () => {
    const script = path.join(ROOT, 'pi', 'install.sh');
    const src = fs.readFileSync(script, 'utf8');
    assert(src.includes('chown kanban:kanban'), 'env file is not handed to the service user');
    assert(src.includes('openssl rand -hex 16'), 'installer does not generate a token');
    assert(!/^HOST=0\.0\.0\.0$/m.test(src), 'installer still hard-codes an all-interfaces bind');
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-openssl-'));
    const stubToken = '0123456789abcdef0123456789abcdef';
    fs.writeFileSync(path.join(stubDir, 'openssl'), '#!/bin/sh\nif [ "$1" = "rand" ] && [ "$2" = "-hex" ] && [ "$3" = "16" ]; then\n  printf "%s\\n" "' + stubToken + '"\n  exit 0\nfi\necho unexpected >&2\nexit 1\n', {mode: 0o755});
    function dry(envFile, env) {
      return runs([script], Object.assign({
        KANBAN_INSTALL_DRY_RUN: '1',
        KANBAN_ENV_FILE: envFile,
        PATH: stubDir + path.delimiter + process.env.PATH
      }, env));
    }
    const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-env-')), 'kanban.env');
    const created = dry(fresh, {AUTH_TOKEN: TOKEN});
    assert(created.status === 0, 'fresh dry-run failed');
    const freshText = fs.readFileSync(fresh, 'utf8');
    assert(freshText.split('\n').includes('HOST=127.0.0.1'), 'new env did not use loopback');
    assert(!freshText.split('\n').includes('HOST=0.0.0.0'), 'new env wrote an all-interfaces bind');
    assert(freshText.includes('AUTH_TOKEN=' + TOKEN), 'supplied token was not stored');
    assert((fs.statSync(fresh).mode & 0o777) === 0o600, 'new env mode ' + (fs.statSync(fresh).mode & 0o777).toString(8));
    assert(countToken(created.stdout, TOKEN) === 1, 'token printed ' + countToken(created.stdout, TOKEN) + ' times');
    assert(!/http:\/\/\d+\.\d+\.\d+\.\d+/.test(created.stdout), 'loopback install advertised a network URL');
    assert(!created.stdout.includes(stubToken) && !created.stderr.includes(stubToken), 'generator ran when a token was supplied');

    const generatedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-env-')), 'kanban.env');
    const generated = dry(generatedFile, {});
    assert(generated.status === 0, 'generated dry-run failed');
    const generatedText = fs.readFileSync(generatedFile, 'utf8');
    assert(generatedText.includes('AUTH_TOKEN=' + stubToken), 'generated token was not the test stub');
    assert(generatedText.split('\n').includes('HOST=127.0.0.1'), 'generated env did not use loopback');
    assert(countToken(generated.stdout, stubToken) === 1, 'generated token printed ' + countToken(generated.stdout, stubToken) + ' times');
    assert(!/http:\/\/\d+\.\d+\.\d+\.\d+/.test(generated.stdout), 'generated install advertised a network URL');

    const opted = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-env-')), 'kanban.env');
    const opt = dry(opted, {AUTH_TOKEN: TOKEN, HOST: '0.0.0.0'});
    assert(opt.status === 0, 'opt-in dry-run failed');
    assert(fs.readFileSync(opted, 'utf8').split('\n').includes('HOST=0.0.0.0'), 'supplied all-interfaces bind was not written');

    const kept = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-env-')), 'kanban.env');
    fs.writeFileSync(kept, 'PORT=9090\nHOST=0.0.0.0\nDATA_DIR=/tmp/kanban-data\n', {mode: 0o644});
    const again = dry(kept, {AUTH_TOKEN: OTHER, HOST: '127.0.0.1'});
    assert(again.status === 0, 'upgrade dry-run failed');
    const keptText = fs.readFileSync(kept, 'utf8');
    assert(keptText.includes('PORT=9090'), 'upgrade rewrote PORT');
    assert(keptText.split('\n').includes('HOST=0.0.0.0'), 'upgrade flipped HOST');
    assert(keptText.includes('AUTH_TOKEN=' + OTHER), 'upgrade did not append a token');
    assert(!keptText.includes(stubToken), 'upgrade ignored a supplied token and generated one');
    assert((fs.statSync(kept).mode & 0o777) === 0o600, 'upgrade mode ' + (fs.statSync(kept).mode & 0o777).toString(8));
    assert(again.stderr.includes('Left unchanged'), 'upgrade did not warn about HOST');
    assert(countToken(again.stdout, OTHER) === 1, 'upgrade token printed ' + countToken(again.stdout, OTHER) + ' times');
    assert(countToken(again.stdout, stubToken) === 0, 'upgrade generated a token while one was supplied');

    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-env-')), 'kanban.env');
    fs.writeFileSync(missing, 'HOST=192.0.2.10\nPORT=8080\n', {mode: 0o644});
    const appended = dry(missing, {});
    assert(appended.status === 0, 'append dry-run failed');
    const missingText = fs.readFileSync(missing, 'utf8');
    assert(missingText.split('\n').includes('HOST=192.0.2.10'), 'append rewrote HOST');
    assert(missingText.includes('AUTH_TOKEN=' + stubToken), 'append did not generate a token');
    assert(countToken(appended.stdout, stubToken) === 1, 'appended token printed ' + countToken(appended.stdout, stubToken) + ' times');
    assert((fs.statSync(missing).mode & 0o777) === 0o600, 'append mode was not 0600');

    const stable = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-env-')), 'kanban.env');
    fs.writeFileSync(stable, 'HOST=192.0.2.10\nAUTH_TOKEN=' + TOKEN + '\n', {mode: 0o644});
    const same = dry(stable, {AUTH_TOKEN: OTHER});
    assert(same.status === 0, 'existing-token dry-run failed');
    const stableText = fs.readFileSync(stable, 'utf8');
    assert(stableText.includes('HOST=192.0.2.10'), 'existing address was rewritten');
    assert(stableText.includes('AUTH_TOKEN=' + TOKEN), 'existing token was replaced');
    assert(!stableText.includes(OTHER), 'a second token was added');
    assert(countToken(same.stdout, TOKEN) === 0 && countToken(same.stdout, OTHER) === 0, 'existing token was printed again');
    assert((fs.statSync(stable).mode & 0o777) === 0o600, 'existing env mode was not tightened');

    const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-env-')), 'kanban.env');
    const refused = dry(bad, {AUTH_TOKEN: 'fake token'});
    assert(refused.status !== 0, 'unsafe token was stored');
    assert(!fs.existsSync(bad), 'unsafe token created an env file');
    assert(!refused.stdout.includes('fake token') && !refused.stderr.includes('fake token'), 'refused token was printed');

    const rootOnly = runs([script], {KANBAN_INSTALL_DRY_RUN: '1'});
    assert(rootOnly.status !== 0, 'dry-run without a temp path was allowed');
  });

  await check('docs and client keep the token out of the query and the example config', async () => {
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
    assert(example.AUTH_TOKEN === 'replace-me', 'example token is not a placeholder');
    assert(example.HOST === '127.0.0.1', 'example host is not loopback');
    assert(!JSON.stringify(example).includes(TOKEN), 'example config contained the test token');
    const ignore = fs.readFileSync(path.join(ROOT, '..', '.gitignore'), 'utf8');
    assert(ignore.includes('config.local.json'), 'config.local.json is not gitignored');
    const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert(page.includes("credentials:'same-origin'"), 'fetch does not send the cookie');
    const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
    assert(sw.includes("u.pathname==='/login'"), 'service worker can answer /login from cache');
    assert(sw.includes("u.pathname.includes('/api/')"), 'service worker can answer /api from cache');
    const wd = fs.readFileSync(path.join(ROOT, 'pi', 'watchdog.sh'), 'utf8');
    assert(wd.includes('Authorization: Bearer'), 'watchdog does not send the token');
    assert(!wd.includes('echo "$TOKEN"') && !wd.includes('echo "$AUTH_TOKEN"'), 'watchdog echoes the token');
  });

  const pass = results.filter(r => r.ok).length;
  console.log('\n' + pass + '/' + results.length + ' passed');
  process.exit(pass === results.length ? 0 : 1);
})().catch(err => {
  console.error(err && err.message ? err.message : err);
  process.exit(2);
});
