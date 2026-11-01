// node --test tools/serve-local.test.cjs – the local board server (ras07 WO-03 + WO-03b audit fixes, owner #11): loopback by
// default, a Host allowlist in both modes, LAN mode only for this computer's own subnets and only with a per-device session.
// The request handler is called directly: no port is opened, nothing is refreshed, no firewall is read.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');
const serve = require('./serve-local.cjs');

const repo = path.join(__dirname, '..');
const DATA = 'BOARD-DATA-MARKER';
const HOST = 'johansdator:5199';
const COOKIE = 'ras_board_5199';
const IFACES = {
  'Wi-Fi': [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
    { address: '192.168.0.167', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  'vEthernet (WSL (Hyper-V firewall))': [{ address: '172.20.16.1', netmask: '255.255.240.0', family: 'IPv4', internal: false }],
  'Local Area Connection* 10': [{ address: '192.168.137.1', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
};

function tempBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-serve-'));
  for (const name of ['index.html', 'missions.html', 'library.html']) fs.writeFileSync(path.join(dir, name), `<p>${DATA} ${name}</p>`);
  fs.writeFileSync(path.join(dir, 'org.json'), `{"x":"${DATA}"}`);
  return { dir, keyFile: path.join(dir, 'key', 'board-key'), sessionsFile: path.join(dir, 'key', 'board-sessions.json') };
}
function setup(opts = {}) {
  const { dir, keyFile, sessionsFile } = tempBoard();
  const calls = { refresh: 0 };
  const state = { clock: 1000000, ifaces: IFACES };
  const handler = serve.createHandler({ lan: true, port: 5199, hostname: 'JOHANSDATOR', boardDir: dir, keyFile, sessionsFile,
    interfaces: () => state.ifaces, refresh: () => { calls.refresh += 1; }, now: () => state.clock, ...opts });
  return { dir, keyFile, sessionsFile, calls, state, handler, key: () => serve.readKey(keyFile), tick: ms => { state.clock += ms; } };
}
// Fake request/response pair; resolves with { status, headers, body } when the handler ends the response.
function call(handler, { method = 'GET', url = '/', remote = '192.168.0.20', cookie, body, host = HOST, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  const h = { ...(cookie ? { cookie } : {}), ...(host ? { host } : {}), ...(method === 'POST' ? { origin: `http://${host}` } : {}), ...headers };
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  Object.assign(req, { method, url, headers: h, socket: { remoteAddress: remote } });
  return new Promise(resolve => {
    const res = {
      req, headersSent: false,
      writeHead(status, hdrs) { this.status = status; this.headers = hdrs; this.headersSent = true; },
      end(b) { this.body = b === undefined ? '' : b.toString(); resolve(this); },
    };
    handler(req, res);
  });
}
const cookieOf = r => String(r.headers['Set-Cookie'] || '').split(';')[0];
const grouped = key => serve.formatKey(key);
async function login(s, opts = {}) {
  const r = await call(s.handler, { method: 'POST', url: '/', body: 'key=' + encodeURIComponent(grouped(s.key())), ...opts });
  assert.equal(r.status, 303);
  return cookieOf(r);
}

test('default bind is loopback; LAN mode only when asked for', () => {
  assert.equal(serve.HOST, '127.0.0.1');
  assert.equal(serve.bindHost(false), '127.0.0.1');
  assert.equal(serve.bindHost(true), '0.0.0.0');
  const src = fs.readFileSync(path.join(__dirname, 'serve-local.cjs'), 'utf8');
  assert.match(src, /const lan = argv\.includes\('--lan'\) \|\| process\.env\.RAS_BOARD_LAN === '1'/);
  assert.match(src, /listen\(port, bindHost\(lan\)/);
  assert.match(src, /if \(require\.main === module\) main\(/, 'requiring the module must not start a server');
});

// ---- H2: Host allowlist + fetch metadata ----
test('H2: loopback with a foreign or missing Host gets 421, no data and no refresh (DNS rebinding)', async () => {
  const { dir, keyFile, sessionsFile } = tempBoard();
  let refreshed = 0;
  const h = serve.createHandler({ lan: false, port: 5199, boardDir: dir, keyFile, sessionsFile, refresh: () => { refreshed += 1; } });
  for (const host of ['attacker.example:5199', 'rebind.attacker.example', '127.0.0.1', '127.0.0.1:80', 'localhost:5198', HOST, '192.168.0.167:5199', null]) {
    const r = await call(h, { remote: '127.0.0.1', url: '/missions.html', host });
    assert.equal(r.status, 421, String(host));
    assert.doesNotMatch(r.body, new RegExp(DATA));
  }
  assert.equal(refreshed, 0);
  for (const host of ['127.0.0.1:5199', 'LOCALHOST:5199', '[::1]:5199']) {
    const r = await call(h, { remote: '127.0.0.1', url: '/missions.html', host });
    assert.equal(r.status, 200, host);
    assert.match(r.body, new RegExp(DATA));
  }
  assert.equal(refreshed, 3);
});

test('H2: LAN mode accepts the computer name and its current LAN IPv4 (any case), nothing else', async () => {
  const s = setup();
  const cookie = await login(s);
  for (const host of ['johansdator:5199', 'JohansDator:5199', '192.168.0.167:5199', '127.0.0.1:5199'])
    assert.equal((await call(s.handler, { cookie, host })).status, 200, host);
  for (const host of ['johansdator.evil.example:5199', 'johansdator:5198', '172.20.16.1:5199', '192.168.137.1:5199', 'evil.example', ''])
    assert.equal((await call(s.handler, { cookie, host })).status, 421, host);
});

test('H2: cross-site and same-site subresources are refused; only page navigations refresh', async () => {
  const { dir, keyFile, sessionsFile } = tempBoard();
  let refreshed = 0;
  const h = serve.createHandler({ lan: false, port: 5199, boardDir: dir, keyFile, sessionsFile, refresh: () => { refreshed += 1; } });
  const host = '127.0.0.1:5199';
  for (const site of ['cross-site', 'same-site']) {
    const r = await call(h, { remote: '127.0.0.1', host, headers: { 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' } });
    assert.equal(r.status, 403, site);
    assert.doesNotMatch(r.body, new RegExp(DATA));
  }
  assert.equal(refreshed, 0);
  // A click from the public site is a navigation: served (and refreshed, as today).
  assert.equal((await call(h, { remote: '127.0.0.1', host, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })).status, 200);
  assert.equal(refreshed, 1);
  // The board's own fetch of org.json/pages and HEAD never refresh.
  assert.equal((await call(h, { remote: '127.0.0.1', host, url: '/missions.html', headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } })).status, 200);
  assert.equal((await call(h, { remote: '127.0.0.1', host, method: 'HEAD', url: '/missions.html' })).status, 200);
  assert.equal(refreshed, 1);
});

test('H2/L1: a POST needs a same-origin Origin (or Sec-Fetch-Site same-origin); refused posts are not counted', async () => {
  const s = setup();
  const right = 'key=' + s.key();
  for (const headers of [{ origin: 'http://evil.example' }, { origin: 'http://johansdator:8080' }, { origin: 'null' }, { origin: undefined },
    { origin: 'null', 'sec-fetch-site': 'cross-site' }, { origin: undefined, 'sec-fetch-site': 'same-site' }]) {
    const r = await call(s.handler, { method: 'POST', body: right, headers });
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.equal(r.headers['Set-Cookie'], undefined);
  }
  // 30 cross-site wrong posts cannot lock the device out.
  for (let i = 0; i < 30; i++) await call(s.handler, { method: 'POST', body: 'key=wrong', headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
  assert.equal((await call(s.handler, { method: 'POST', body: right })).status, 303);
  assert.equal((await call(s.handler, { method: 'POST', body: right, headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } })).status, 303);
  assert.equal((await call(s.handler, { method: 'POST', body: right, host: '192.168.0.167:5199' })).status, 303);
});

// ---- H1: own subnets only ----
test('H1: LAN mode serves only this computer\'s own subnets; other private ranges, virtual adapters and public get 403', async () => {
  const s = setup();
  for (const remote of ['8.8.8.8', '::ffff:8.8.8.8', '169.254.3.4', 'fe80::1', '2001:db8::1', '10.0.0.5', '172.16.0.1', '192.168.1.20',
    '172.20.16.5', '192.168.137.20']) {
    const r = await call(s.handler, { remote, method: 'POST', body: 'key=' + s.key() });
    assert.equal(r.status, 403, remote);
    assert.doesNotMatch(r.body, new RegExp(DATA));
    assert.equal(r.headers['Set-Cookie'], undefined);
  }
  assert.equal((await call(s.handler, { remote: '::ffff:192.168.0.20' })).status, 401);
  assert.equal(s.calls.refresh, 0);
});

test('H1: subnets are recomputed from the interfaces (new Wi-Fi -> old subnet refused)', async () => {
  const s = setup();
  assert.equal((await call(s.handler, { remote: '192.168.0.20' })).status, 401);
  s.state.ifaces = { 'Wi-Fi': [{ address: '10.1.2.3', netmask: '255.255.255.0', family: 'IPv4', internal: false }] };
  s.tick(serve.NET_REFRESH_MS);
  assert.equal((await call(s.handler, { remote: '192.168.0.20' })).status, 403);
  assert.equal((await call(s.handler, { remote: '10.1.2.40', host: '10.1.2.3:5199' })).status, 401);
  assert.equal((await call(s.handler, { remote: '10.1.2.40', host: '192.168.0.167:5199' })).status, 421, 'old IP no longer a valid Host');
});

test('H1: lanNetworks keeps real /16../30 IPv4 LANs only', () => {
  const nets = serve.lanNetworks({ ...IFACES,
    'Ethernet 2': [{ address: '10.9.0.4', netmask: '255.0.0.0', family: 'IPv4' }],
    'NordLynx': [{ address: '10.5.0.2', netmask: '255.255.255.0', family: 'IPv4' }],
    'Ethernet 3': [{ address: '192.168.5.9', netmask: '255.0.255.0', family: 'IPv4' }],
    'Ethernet 4': [{ address: '169.254.9.9', netmask: '255.255.0.0', family: 'IPv4' }] });
  assert.deepEqual(nets.map(n => n.address), ['192.168.0.167']);
  assert.ok(serve.inNetworks('192.168.0.1', nets) && serve.inNetworks('::ffff:192.168.0.254', nets));
  assert.ok(!serve.inNetworks('192.168.1.1', nets) && !serve.inNetworks('fe80::1', nets) && !serve.inNetworks(undefined, nets));
});

test('default mode: only loopback is served (a LAN address gets 403), no key needed locally, no key file made', async () => {
  const { dir, keyFile, sessionsFile } = tempBoard();
  let refreshed = 0;
  const h = serve.createHandler({ lan: false, port: 5199, boardDir: dir, keyFile, sessionsFile, interfaces: () => IFACES, refresh: () => { refreshed += 1; } });
  assert.ok(!fs.existsSync(keyFile), 'default mode makes no key');
  assert.equal((await call(h, { remote: '192.168.0.20' })).status, 403);
  const r = await call(h, { remote: '127.0.0.1', url: '/missions.html', host: '127.0.0.1:5199' });
  assert.equal(r.status, 200);
  assert.match(r.body, /missions\.html/);
  assert.equal(r.headers['X-Frame-Options'], undefined, 'loopback pages keep today\'s headers (T3 preview)');
  assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(refreshed, 1);
  assert.equal((await call(h, { remote: '127.0.0.1', method: 'POST', host: '127.0.0.1:5199', body: 'key=x' })).status, 405);
});

// ---- M1/M2: per-device sessions, key only by form ----
test('M2: no key in URLs – ?key= is never checked, only stripped (also the right key)', async () => {
  const s = setup();
  const r = await call(s.handler, { url: '/missions.html?key=' + s.key() });
  assert.equal(r.status, 302);
  assert.equal(r.headers.Location, '/missions.html');
  assert.equal(r.headers['Set-Cookie'], undefined);
  const loop = await call(s.handler, { remote: '127.0.0.1', host: '127.0.0.1:5199', url: '/index.html?key=x' });
  assert.equal(loop.status, 302);
  assert.equal(loop.headers.Location, '/index.html');
  for (const url of ['//evil.example/?key=1', '/\\evil.example/?key=1', 'http://evil.example/?key=1'])
    assert.equal((await call(s.handler, { url })).headers.Location, '/', url);
});

test('M1: key form -> own random session per device, stored hashed; forged/unknown ids refused', async () => {
  const s = setup();
  const key = s.key();
  assert.match(key, /^[0-9a-f]{64}$/);
  let r = await call(s.handler, { url: '/missions.html' });
  assert.equal(r.status, 401);
  assert.doesNotMatch(r.body, new RegExp(DATA));
  assert.match(r.body, /Skriv in nyckeln/);
  assert.match(r.body, /<form method="post" action="\/missions\.html">/);
  assert.equal(r.headers['X-Frame-Options'], 'DENY');
  assert.equal(r.headers['Referrer-Policy'], 'same-origin', 'so the form POST carries a real Origin');
  assert.match(r.headers['Content-Security-Policy'], /frame-ancestors 'none'/);

  r = await call(s.handler, { method: 'POST', url: '/missions.html', body: 'key=' + 'a'.repeat(64) });
  assert.equal(r.status, 401);
  assert.match(r.body, /Fel nyckel/);
  assert.doesNotMatch(r.body, new RegExp(key));

  r = await call(s.handler, { method: 'POST', url: '/missions.html', body: 'key=' + encodeURIComponent(grouped(key).toUpperCase()) });
  assert.equal(r.status, 303);
  assert.equal(r.headers.Location, '/missions.html');
  assert.match(r.headers['Set-Cookie'], /^ras_board_5199=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=15552000$/);
  const a = cookieOf(r);
  const b = await login(s, { remote: '192.168.0.21' });
  assert.notEqual(a, b, 'every device has its own session');
  const stored = fs.readFileSync(s.sessionsFile, 'utf8');
  for (const c of [a, b]) assert.ok(!stored.includes(c.split('=')[1]), 'only a hash is stored');
  assert.ok(!stored.includes(key));
  assert.equal(JSON.parse(stored).sessions.length, 2);

  r = await call(s.handler, { url: '/missions.html', cookie: a + '; other=1' });
  assert.equal(r.status, 200);
  assert.match(r.body, new RegExp(DATA));
  assert.equal(r.headers['Content-Security-Policy'], "frame-ancestors 'none'");
  assert.equal(s.calls.refresh, 1, 'only the served page refreshes');
  assert.equal((await call(s.handler, { cookie: a, remote: '192.168.0.99' })).status, 200, 'a session is per browser, not per IP');
  for (const forged of ['ras_board_5199=' + 'b'.repeat(43), 'ras_board=' + a.split('=')[1], 'ras_board_5199=' + key, 'ras_board_5199='])
    assert.equal((await call(s.handler, { cookie: forged })).status, 401, forged);
});

test('M1: sessions expire after 180 days on the server, whatever the browser keeps', async () => {
  const s = setup();
  const cookie = await login(s);
  s.tick(serve.SESSION_MS - 1000);
  assert.equal((await call(s.handler, { cookie })).status, 200);
  s.tick(2000);
  assert.equal((await call(s.handler, { cookie })).status, 401);
  // A new login drops the expired one from the file.
  await login(s);
  assert.equal(JSON.parse(fs.readFileSync(s.sessionsFile, 'utf8')).sessions.length, 1);
});

test('M1: --revoke-sessions (another process) and key rotation log every device out', async () => {
  const s = setup();
  const one = await login(s);
  serve.createSessionStore(s.sessionsFile).revokeAll();
  assert.equal((await call(s.handler, { cookie: one })).status, 401);
  const two = await login(s);
  assert.equal((await call(s.handler, { cookie: two })).status, 200);
  serve.writeKey(s.keyFile);
  const r = await call(s.handler, { cookie: two });
  assert.equal(r.status, 401);
  assert.doesNotMatch(r.body, new RegExp(DATA));
  assert.equal((await call(s.handler, { cookie: await login(s) })).status, 200);
  fs.writeFileSync(s.sessionsFile, '{broken');
  assert.equal((await call(s.handler, { cookie: two })).status, 401, 'a broken file means no sessions (fail closed)');
});

test('no readable key file -> nobody on the LAN gets in (fail closed); loopback still works', async () => {
  const s = setup();
  const key = s.key();
  const cookie = await login(s);
  fs.rmSync(s.keyFile);
  assert.equal((await call(s.handler, { method: 'POST', body: 'key=' + key })).status, 401);
  assert.equal((await call(s.handler, { cookie })).status, 401);
  assert.equal((await call(s.handler, { remote: '127.0.0.1', host: '127.0.0.1:5199' })).status, 200);
});

test('L4: the SameSite bounce reloads at most once (?b=1), so blocked cookies cannot loop', async () => {
  const s = setup();
  let r = await call(s.handler, { url: '/missions.html', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
  assert.equal(r.status, 401);
  assert.match(r.body, /<meta http-equiv="refresh" content="0;url=\/missions\.html\?b=1">/);
  r = await call(s.handler, { url: '/missions.html?b=1' });
  assert.equal(r.status, 401);
  assert.doesNotMatch(r.body, /http-equiv="refresh"/);
  assert.match(r.body, /action="\/missions\.html"/);
  const cookie = await login(s);
  assert.equal((await call(s.handler, { url: '/missions.html?b=1', cookie })).status, 200);
});

test('constant-time compare: both sides hashed and compared with crypto.timingSafeEqual', () => {
  assert.ok(serve.safeEqual('abc', 'abc'));
  assert.ok(!serve.safeEqual('abc', 'abd'));
  assert.ok(!serve.safeEqual('abc', 'a'.repeat(1000)), 'different lengths do not throw');
  const src = fs.readFileSync(path.join(__dirname, 'serve-local.cjs'), 'utf8');
  assert.match(src, /const safeEqual = \(a, b\) => crypto\.timingSafeEqual\(digest\(a\), digest\(b\)\)/);
  assert.match(src, /safeEqual\(normalizeKey\(attempt\), key\)/);
  assert.doesNotMatch(src, /(attempt|key)\s*[!=]==?\s*(attempt|key)\b/);
  assert.equal(serve.normalizeKey(' AB12-cd34 ef\t56 '), 'ab12cd34ef56');
  assert.equal(serve.formatKey('a'.repeat(64)).split(' ').length, 16);
});

test('rate limit: 10 wrong keys per IP per minute, then 429 even for the right key; other IPs unaffected', async () => {
  const s = setup();
  const post = (body, remote = '192.168.0.20') => call(s.handler, { method: 'POST', body, remote });
  for (let i = 0; i < serve.FAIL_LIMIT; i++) assert.equal((await post('key=wrong' + i)).status, 401);
  const r = await post('key=' + s.key());
  assert.equal(r.status, 429);
  assert.equal(r.headers['Set-Cookie'], undefined);
  assert.equal((await post('key=' + s.key(), '::ffff:192.168.0.20')).status, 429, 'mapped form is the same IP');
  assert.equal((await post('key=' + s.key(), '192.168.0.21')).status, 303);
  s.tick(61 * 1000);
  assert.equal((await post('key=' + s.key())).status, 303);
  assert.equal((await call(s.handler, { method: 'POST', body: 'key=' + 'x'.repeat(5000) })).status, 413);
});

test('L1: the fail map is bounded; when it is full of live entries new IPs are refused, not evicted', async () => {
  const s = setup();
  s.state.ifaces = { 'Wi-Fi': [{ address: '10.0.0.1', netmask: '255.255.0.0', family: 'IPv4' }] };
  s.tick(serve.NET_REFRESH_MS);
  const host = '10.0.0.1:5199';
  for (let i = 0; i < serve.FAIL_MAP_MAX; i++)
    await call(s.handler, { method: 'POST', body: 'key=x', host, remote: `10.0.${(i >> 8) + 1}.${i & 255}` });
  assert.equal((await call(s.handler, { method: 'POST', body: 'key=' + s.key(), host, remote: '10.0.200.1' })).status, 429);
  s.tick(61 * 1000);
  assert.equal((await call(s.handler, { method: 'POST', body: 'key=' + s.key(), host, remote: '10.0.200.1' })).status, 303);
});

test('same fixed routes, redirects stay on this server, methods limited', async () => {
  const s = setup();
  const cookie = await login(s);
  for (const url of ['/tools/serve-local.cjs', '/.git/config', '/..%2f..%2fboard-key', '/assets/', '/board-key', '/key/board-key', '/board-sessions.json'])
    assert.equal((await call(s.handler, { url, cookie })).status, 404, url);
  const json = await call(s.handler, { url: '/org.json', cookie });
  assert.equal(json.status, 200);
  assert.equal(json.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal((await call(s.handler, { method: 'PUT', cookie })).status, 405);
  const head = await call(s.handler, { method: 'HEAD', cookie });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('refresh keeps its 2-minute throttle for every caller', () => {
  let t = 0;
  let runs = 0;
  const refresh = serve.makeRefresh(() => { runs += 1; }, () => t);
  assert.equal(refresh(), true);
  for (let i = 0; i < 50; i++) { t += 1000; refresh(); }
  assert.equal(runs, 1);
  t += serve.REFRESH_MS;
  assert.equal(refresh(), true);
  assert.equal(runs, 2);
});

test('key file: 64 hex chars, kept when it exists, garbage is not a key', () => {
  const { keyFile } = tempBoard();
  const a = serve.loadOrCreateKey(keyFile);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(serve.loadOrCreateKey(keyFile), a);
  fs.writeFileSync(keyFile, 'not-a-key');
  assert.equal(serve.readKey(keyFile), null);
  assert.notEqual(serve.writeKey(keyFile), a);
});

// ---- L2 + H1 start checks (firewall and icacls mocked) ----
test('L2: key ACL check passes only for the current user alone, no inherited entries', () => {
  const file = 'C:\\Users\\johan\\.ras\\board-key';
  const out = lines => `${file} ${lines.join('\r\n' + ' '.repeat(file.length + 1))}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
  const ok = lines => serve.keyAclOk(file, { platform: 'win32', user: 'JOHANSDATOR\\johan', run: () => out(lines) });
  assert.ok(ok(['JOHANSDATOR\\johan:(F)']));
  assert.ok(ok(['johansdator\\JOHAN:(F)']));
  assert.ok(!ok(['JOHANSDATOR\\johan:(I)(F)']));
  assert.ok(!ok(['JOHANSDATOR\\johan:(F)', 'Johansdator\\CodexSandboxUsers:(RX)']));
  assert.ok(!ok(['NT AUTHORITY\\SYSTEM:(F)']));
  assert.ok(!ok([]));
  assert.ok(!serve.keyAclOk(file, { platform: 'win32', user: 'JOHANSDATOR\\johan', run: () => { throw new Error('icacls failed'); } }));
});

test('L2/H1: --lan refuses to start without a locked key file or without the Public block rule (Swedish message)', () => {
  const base = { port: 5199, keyFile: 'X:\\k', platform: 'win32', ensureKey: () => 'k', restrict: () => {}, aclOk: () => true, firewallOk: () => true };
  assert.deepEqual(serve.lanStartProblems(base), []);
  let p = serve.lanStartProblems({ ...base, firewallOk: () => false });
  assert.equal(p.length, 1);
  assert.match(p[0], /Brandväggsregeln "RAS board 5199 \(block Public\)" saknas/);
  assert.match(p[0], /lan-setup\.ps1/);
  p = serve.lanStartProblems({ ...base, aclOk: () => false });
  assert.equal(p.length, 1);
  assert.match(p[0], /Nyckelfilen .* kunde inte låsas/);
  assert.equal(serve.lanStartProblems({ ...base, ensureKey: () => { throw new Error('acl'); } }).length, 1);
  assert.equal(serve.lanStartProblems({ ...base, restrict: () => { throw new Error('icacls'); }, aclOk: () => false }).length, 1);
  const src = fs.readFileSync(path.join(__dirname, 'serve-local.cjs'), 'utf8');
  assert.match(src, /const problems = lanStartProblems\(\{ port \}\);\s*if \(problems\.length\) \{[\s\S]*?process\.exit\(1\)/);
});

test('H1: the block-rule check reads Get-NetFirewallRule output and wants Enabled Inbound Block, Public, TCP <port>', () => {
  let script = '';
  const ok = out => serve.blockRuleOk(5199, s => { script = s; return out; });
  assert.ok(ok('True|Inbound|Block|Public|TCP|5199\r\n'));
  assert.ok(ok('True|Inbound|Block|Any|TCP|5199'));
  assert.match(script, /Get-NetFirewallRule -DisplayName 'RAS board 5199 \(block Public\)'/);
  assert.doesNotMatch(script, /\b(New|Set|Remove|Enable|Disable)-NetFirewall/, 'read-only');
  for (const out of ['', 'False|Inbound|Block|Public|TCP|5199', 'True|Inbound|Allow|Public|TCP|5199', 'True|Outbound|Block|Public|TCP|5199',
    'True|Inbound|Block|Private|TCP|5199', 'True|Inbound|Block|Public|UDP|5199', 'True|Inbound|Block|Public|TCP|80'])
    assert.ok(!ok(out), out);
  assert.ok(!serve.blockRuleOk(5199, () => { throw new Error('no powershell'); }));
});

test('no committed file holds a key-like 64-hex string or a key in a link', () => {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const files = git.stdout.split(/\r?\n/).filter(f => f && !/\.png$/i.test(f));
  assert.ok(files.length > 5);
  for (const f of files) {
    const text = fs.readFileSync(path.join(repo, f), 'utf8');
    assert.doesNotMatch(text, /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i, f);
    assert.doesNotMatch(text, /[?&]key=[0-9a-z]{8,}/i, f);
  }
});

test('lan-setup.ps1: Allow on Private, Block on Public, -Remove undoes everything, asks before profile changes, no key in a URL', () => {
  const ps = fs.readFileSync(path.join(__dirname, 'lan-setup.ps1'), 'utf8');
  assert.match(ps, /-Action Allow[^\n]*-Profile Private\b/);
  assert.match(ps, /-Action Block[^\n]*-Profile Public\b/);
  assert.doesNotMatch(ps, /-Action Allow[^\n]*-Profile (Any|Public|Domain)/);
  assert.match(ps, /\$blockName = "RAS board \$Port \(block Public\)"/);
  assert.match(ps, /RAS board \$Port/);
  assert.match(ps, /\[switch\]\$Remove/);
  assert.match(ps, /\[switch\]\$Autostart/);
  assert.match(ps, /--show-key/);
  assert.doesNotMatch(ps, /\?key=/);
  assert.match(ps, /Read-Host/, 'asks before changing the network profile');
  assert.match(ps, /lan-setup-state\.json/, 'remembers what it changed');
  const remove = ps.slice(ps.indexOf('if ($Remove)'), ps.indexOf('exit 0'));
  for (const what of [/\$ruleName/, /\$blockName/, /Unregister-ScheduledTask/, /Stop-Process/, /serve-local\\\.cjs/, /--lan/, /NetworkCategory Public/, /Read-Host/])
    assert.match(remove, what);
});
