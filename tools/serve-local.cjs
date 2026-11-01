#!/usr/bin/env node
// Serves the LOCAL RAS board (with mission token history). Default: 127.0.0.1 only, never the network.
// Every request, in both modes, must name this server in its Host header (127.0.0.1 / localhost / [::1] :<port>, and in
// LAN mode the computer name and its current LAN IPv4s) – anything else gets 421 (DNS rebinding, ras07 WO-03 audit H2).
// LAN mode (owner ras07 #11, opt-in: --lan or env RAS_BOARD_LAN=1): listens on 0.0.0.0 (IPv4), answers only addresses in
// this computer's own connected subnets (403 otherwise; virtual/VPN adapters excluded), and asks other devices once for the
// secret key, typed into a same-origin form (POST). A right key gives that device its own random session (HttpOnly cookie
// ras_board_<port>; only a hash is stored in %USERPROFILE%/.ras/board-sessions.json; expires after 180 days on the server).
// The key is never accepted in a URL. --lan refuses to start unless the key file is limited to this user and the firewall
// rule "RAS board <port> (block Public)" from tools/lan-setup.ps1 exists.
// The key: random 256 bits in %USERPROFILE%/.ras/board-key (env RAS_BOARD_KEY_FILE), printed only by --show-key.
// Meant to be started from the T3 project script "RAS-tavla" so the owner sees it in T3's preview, also through
// T3 remote. On a page load the data is refreshed when it is older than REFRESH_MS:
//   ras-telemetry collect + history  ->  build-local.cjs  ->  ~/.ras/board/index.html + missions.html + library.html  ->  publish-history.cjs
// Usage: node tools/serve-local.cjs [--port 5199] [--lan]
//        node tools/serve-local.cjs --show-key [--port 5199]   (prints the address and the key to type, then exits)
//        node tools/serve-local.cjs --rotate-key               (new key; every device session is revoked, then exits)
//        node tools/serve-local.cjs --revoke-sessions          (every device has to enter the key again, then exits)
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOST = '127.0.0.1';
const LAN_HOST = '0.0.0.0';
const DEFAULT_PORT = 5199;
const REFRESH_MS = 2 * 60 * 1000;
const NET_REFRESH_MS = 30 * 1000;
const SESSION_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 60 * 1000;
const FAIL_MAP_MAX = 1024;
const boardRepo = path.resolve(__dirname, '..');
const rasDir = path.join(os.homedir(), '.ras');
const defaultBoardDir = path.join(rasDir, 'board');
const defaultKeyFile = process.env.RAS_BOARD_KEY_FILE || path.join(rasDir, 'board-key');
const defaultSessionsFile = process.env.RAS_BOARD_SESSIONS_FILE || path.join(rasDir, 'board-sessions.json');
const rasHome = process.env.RAS_HOME || path.resolve(boardRepo, '..', 'ryngmark-agents');
const telemetry = path.join(rasHome, 'tools', 'ras-telemetry.mjs');

// The only routes (no directory listing; the Host header is checked, never used for routing).
const ROUTES = { '/': 'index.html', '/index.html': 'index.html', '/library.html': 'library.html', '/missions.html': 'missions.html', '/org.json': 'org.json',
  '/assets/ras-gaming.png': 'assets/ras-gaming.png', '/assets/ras-software.png': 'assets/ras-software.png' };
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

const bindHost = lan => (lan ? LAN_HOST : HOST);
const cookieName = port => `ras_board_${port}`;
const blockRuleName = port => `RAS board ${port} (block Public)`;

// ---- remote addresses (IPv4-mapped IPv6 "::ffff:a.b.c.d" counts as IPv4) ----
function ipv4(addr) {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(String(addr || ''));
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every(n => n <= 255) ? o : null;
}
const toInt = o => ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
function isLoopback(addr) {
  const v4 = ipv4(addr);
  return v4 ? v4[0] === 127 : addr === '::1';
}

// This computer's own LAN subnets, from the interface list (audit H1: not "any private range"). Left out: loopback,
// link-local, IPv6, virtual and tunnel adapters (WSL/Hyper-V/Docker/VM/VPN, Windows' "Local Area Connection*" hotspot
// adapters and its 192.168.137.0/24 sharing range), and subnets wider than /16 or narrower than /30.
const VIRTUAL_IF = /\*|\b(vethernet|wsl|hyper-v|docker|virtualbox|vbox|vmware|vpn|tap|tun|wireguard|nordlynx|tailscale|zerotier|bluetooth)\b/i;
function lanNetworks(ifaces) {
  const nets = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (VIRTUAL_IF.test(name)) continue;
    for (const a of list || []) {
      if (!a || a.internal || !(a.family === 'IPv4' || a.family === 4)) continue;
      const ip = ipv4(a.address);
      const mask = ipv4(a.netmask);
      if (!ip || !mask || ip[0] === 127 || (ip[0] === 169 && ip[1] === 254) || (ip[0] === 192 && ip[1] === 168 && ip[2] === 137)) continue;
      const m = toInt(mask);
      const prefix = m.toString(2).replace(/0+$/, '').length;
      if (m !== (prefix ? (~0 << (32 - prefix)) >>> 0 : 0) || prefix < 16 || prefix > 30) continue;
      nets.push({ address: ip.join('.'), net: (toInt(ip) & m) >>> 0, mask: m });
    }
  }
  return nets;
}
function inNetworks(addr, nets) {
  const v4 = ipv4(addr);
  if (!v4) return false;
  const n = toInt(v4);
  return nets.some(x => ((n & x.mask) >>> 0) === x.net);
}
// Host header values that name this server (lower case, with the port).
function allowedHosts({ lan, port, hostname, nets }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (lan) {
    if (hostname) hosts.add(`${String(hostname).toLowerCase()}:${port}`);
    for (const n of nets) hosts.add(`${n.address}:${port}`);
  }
  return hosts;
}

// ---- key ----
const KEY_RE = /^[0-9a-f]{64}$/;
// What a person types: groups, spaces, dashes and upper case are all fine.
const normalizeKey = s => String(s || '').replace(/[\s-]+/g, '').toLowerCase();
const formatKey = key => key.match(/.{1,4}/g).join(' ');
function readKey(file = defaultKeyFile) {
  try { const key = fs.readFileSync(file, 'utf8').trim(); return KEY_RE.test(key) ? key : null; } catch { return null; }
}
const currentUser = () => (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username);
const runIcacls = cmdArgs => execFileSync('icacls', cmdArgs, { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, windowsHide: true });
// The file gets an ACL for the current user only (no inherited entries). Throws when that fails (audit L2: fail closed).
function restrictToUser(file, run = runIcacls) {
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o600); return; }
  run([file, '/inheritance:r', '/grant:r', `${currentUser()}:F`]);
}
// True only when every entry of the file's ACL is the current user's own, none inherited.
function keyAclOk(file, { platform = process.platform, run = runIcacls, user = currentUser() } = {}) {
  try {
    if (platform !== 'win32') return (fs.statSync(file).mode & 0o077) === 0;
    const out = String(run([file]));
    const block = out.split(/\r?\n\s*\r?\n/)[0];
    const lines = block.split(/\r?\n/).map((l, i) => (i === 0 ? l.slice(l.indexOf(file) === 0 ? file.length : 0) : l).trim()).filter(Boolean);
    const entries = lines.map(l => /^(.+?):((?:\([A-Z,]+\))+)$/i.exec(l));
    return entries.length > 0 && entries.every(e => e && e[1].toLowerCase() === user.toLowerCase() && !/\(I\)/i.test(e[2]));
  } catch { return false; }
}
function writeKey(file = defaultKeyFile) {
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key + '\n', { flag: 'wx', mode: 0o600 });
  try { restrictToUser(tmp); } catch (error) { fs.rmSync(tmp, { force: true }); throw new Error('could not limit the key file to the current user: ' + file); }
  fs.renameSync(tmp, file);
  return key;
}
const loadOrCreateKey = (file = defaultKeyFile) => readKey(file) || writeKey(file);

// Constant time whatever the input length: both sides are hashed to 32 bytes first.
const digest = s => crypto.createHash('sha256').update(String(s), 'utf8').digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
// Sessions remember which key they were made with; a rotated key makes every old session worthless.
const keyId = key => crypto.createHmac('sha256', key).update('ras-board-session-kid-v1').digest('hex').slice(0, 16);
function cookies(req) {
  const out = [];
  for (const part of String(req.headers.cookie || '').slice(0, 4096).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
  }
  return out;
}

// ---- device sessions (audit M1): random id per device, only its SHA-256 on disk, expiry checked here ----
const SID_RE = /^[A-Za-z0-9_-]{43}$/;
const sidHash = sid => crypto.createHash('sha256').update(sid, 'utf8').digest('hex');
function createSessionStore(file = defaultSessionsFile, now = Date.now) {
  let cache = { stamp: undefined, list: [] };
  const stampOf = () => { try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return null; } };
  // Re-read when the file changes (another process ran --revoke-sessions). Unreadable or malformed = no sessions.
  function load() {
    const stamp = stampOf();
    if (stamp !== cache.stamp) {
      let list = [];
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data && data.version === 1 && Array.isArray(data.sessions))
          list = data.sessions.filter(s => s && /^[0-9a-f]{64}$/.test(s.id) && Number.isFinite(s.created) && typeof s.kid === 'string');
      } catch { list = []; }
      cache = { stamp, list };
    }
    return cache.list;
  }
  function save(list) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: list }, null, 1) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
    cache = { stamp: stampOf(), list };
  }
  const live = s => now() - s.created < SESSION_MS && s.created <= now();
  return {
    create(kid) {
      const sid = crypto.randomBytes(32).toString('base64url');
      const list = load().filter(live).concat({ id: sidHash(sid), created: now(), kid });
      save(list.sort((a, b) => a.created - b.created).slice(-MAX_SESSIONS));
      return sid;
    },
    valid(sid, kid) {
      if (!SID_RE.test(String(sid || '')) || !kid) return false;
      const h = sidHash(sid);
      return load().some(s => s.id === h && s.kid === kid && live(s));
    },
    revokeAll() { save([]); },
    count() { return load().filter(live).length; },
  };
}

// ---- refresh (same 2-min throttle for every request, local or LAN) ----
function refreshSteps() {
  try {
    const run = (file, cmdArgs) => execFileSync(process.execPath, [file, ...cmdArgs], { stdio: 'pipe', timeout: 120000 });
    if (fs.existsSync(telemetry)) {
      run(telemetry, ['collect']);
      run(telemetry, ['history']);
    }
    run(path.join(boardRepo, 'tools', 'build-org.cjs'), []);
    run(path.join(boardRepo, 'tools', 'build-local.cjs'), []);
    // Owner decision 2026-10-31: the mission summaries (name, tokens, director, date) are public; publish when changed.
    // publish-history drops public:false missions and publishes nothing when the mission log is unreadable (its one warning
    // line goes to this console, stderr inherited).
    try { execFileSync(process.execPath, [path.join(boardRepo, 'tools', 'publish-history.cjs')], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 120000 }); }
    catch (error) { console.error('publish failed: ' + String(error.message).split(/\r?\n/)[0]); }
  } catch (error) {
    // Keep serving the last good build; say what failed in the console only (never in the page).
    console.error('refresh failed: ' + String(error.stderr || error.message).split(/\r?\n/)[0]);
  }
}
function makeRefresh(steps = refreshSteps, now = Date.now) {
  let last = -Infinity;
  return () => {
    if (now() - last < REFRESH_MS) return false;
    last = now();
    steps();
    return true;
  };
}

// ---- responses ----
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
// LAN responses may never be framed. Loopback page responses keep today's headers so T3's preview keeps working.
const NO_FRAME = { 'X-Frame-Options': 'DENY' };
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
}
function page(res, status, title, inner, headers = {}) {
  const html = '<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${esc(title)}</title>${headers.refreshTo ? `<meta http-equiv="refresh" content="0;url=${esc(headers.refreshTo)}">` : ''}` +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d2433}' +
    'input{font:inherit;font-family:ui-monospace,monospace;padding:.4rem;width:100%;box-sizing:border-box;margin:.3rem 0 .8rem}' +
    'button{font:inherit;padding:.4rem 1rem}.err{color:#a3261b}</style></head><body>' + `<h1>${esc(title)}</h1>${inner}</body></html>`;
  const { refreshTo, ...rest } = headers;
  send(res, status, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, ...NO_FRAME, ...rest });
}
function keyPage(res, back, { wrong = false, bounce = false } = {}) {
  page(res, 401, 'Nyckel krävs',
    '<p>Skriv in nyckeln för RAS-tavlan. Du behöver den en gång per dator och webbläsare. Nyckeln visas på Johans dator med ' +
    '<code>node tools/serve-local.cjs --show-key</code> (mellanslagen spelar ingen roll).</p>' +
    (wrong ? '<p class="err">Fel nyckel.</p>' : '') +
    `<form method="post" action="${esc(back)}"><label>Nyckel<input name="key" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>` +
    '<button type="submit">Öppna tavlan</button></form>',
    // The session cookie is SameSite=Strict, so a click from the public site (another site) arrives without it. One
    // same-origin reload (meta refresh to ?b=1) sends it; ?b=1 never reloads again, so blocked cookies cannot loop (L4).
    // Referrer-Policy same-origin: the form's POST then carries this page's real Origin for the same-origin check.
    { 'Referrer-Policy': 'same-origin', ...(bounce ? { refreshTo: `${back}?b=1` } : {}) });
}

function readForm(req, limit = 2048) {
  return new Promise(resolve => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { resolve(null); req.destroy?.(); } else chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('key') ?? ''));
    req.on('error', () => resolve(null));
  });
}
// A POST must come from a page of this very server (audit H2/M2/L1): Origin = http://<the allowed Host>, or, when the
// browser hides the Origin ("null" or none), Sec-Fetch-Site: same-origin. Neither can be set by another site's script.
function sameOrigin(req, host) {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') return String(origin).toLowerCase() === `http://${host}`;
  return req.headers['sec-fetch-site'] === 'same-origin';
}

// The request handler. Exported so tests can call it with any remote address without opening a port or refreshing.
function createHandler({ lan = false, port = DEFAULT_PORT, hostname = os.hostname(), boardDir = defaultBoardDir, keyFile = defaultKeyFile,
  sessionsFile = defaultSessionsFile, sessions = null, interfaces = os.networkInterfaces, refresh = () => false, now = Date.now } = {}) {
  if (lan) loadOrCreateKey(keyFile);
  const store = sessions || createSessionStore(sessionsFile, now);
  const COOKIE = cookieName(port);
  let cache = { mtime: null, key: null };
  // Re-read when the file changes, so --rotate-key takes effect without a restart. No readable key = nobody gets in.
  function currentKey() {
    let mtime = null;
    try { const st = fs.statSync(keyFile); mtime = `${st.mtimeMs}:${st.ino}:${st.size}`; } catch { return null; }
    if (mtime !== cache.mtime) cache = { mtime, key: readKey(keyFile) };
    return cache.key;
  }
  // Subnets and Host names follow the interfaces (DHCP, another Wi-Fi), recomputed at most every NET_REFRESH_MS.
  let net = { at: -Infinity, nets: [], hosts: allowedHosts({ lan: false, port }) };
  function netState() {
    if (lan && now() - net.at >= NET_REFRESH_MS) {
      let nets = [];
      try { nets = lanNetworks(interfaces()); } catch { nets = []; }
      net = { at: now(), nets, hosts: allowedHosts({ lan, port, hostname, nets }) };
    }
    return net;
  }
  // Failed keys per IP; the map is bounded: when it is full of live entries, new IPs are refused too (fail closed).
  const fails = new Map();
  const failState = ip => {
    const f = fails.get(ip);
    return f && now() - f.start < FAIL_WINDOW_MS ? f : null;
  };
  function prune() { for (const [k] of fails) if (!failState(k)) fails.delete(k); }
  function limited(ip) {
    const f = failState(ip);
    if (f) return f.count >= FAIL_LIMIT;
    if (fails.size >= FAIL_MAP_MAX) prune();
    return fails.size >= FAIL_MAP_MAX;
  }
  function fail(ip) {
    const f = failState(ip) || { start: now(), count: 0 };
    f.count += 1;
    fails.set(ip, f);
  }

  return async function handle(req, res) {
    try {
      const remote = (req.socket && req.socket.remoteAddress) || '';
      const local = isLoopback(remote);
      const { nets, hosts } = netState();
      if (!local && !(lan && inNetworks(remote, nets)))
        return page(res, 403, 'Åtkomst nekad', '<p>Tavlan kan bara öppnas från datorer i hemnätverket.</p>');
      // DNS rebinding (H2): a page on another name that re-resolves to this computer still sends its own name here.
      const host = String(req.headers.host || '').toLowerCase();
      if (!hosts.has(host))
        return page(res, 421, 'Fel adress', '<p>Öppna tavlan via <code>http://127.0.0.1:' + port + '/</code>' +
          (lan ? ' eller datorns namn i hemnätverket' : '') + '.</p>');
      const url = new URL(req.url || '/', 'http://board.invalid');
      const route = ROUTES[url.pathname];
      const back = route ? url.pathname : '/';
      const method = req.method;
      if (!(method === 'GET' || method === 'HEAD' || (method === 'POST' && !local)))
        return send(res, 405, 'method not allowed', { Allow: local ? 'GET, HEAD' : 'GET, HEAD, POST', ...(local ? {} : NO_FRAME) });
      // Other sites (and other ports of this computer – same site) may link here, but not embed, fetch or post.
      const site = req.headers['sec-fetch-site'];
      const mode = req.headers['sec-fetch-mode'];
      if ((site === 'cross-site' || site === 'same-site') && mode !== 'navigate')
        return send(res, 403, 'cross-site request refused', local ? {} : NO_FRAME);
      if (method === 'POST' && !sameOrigin(req, host))
        return page(res, 403, 'Åtkomst nekad', '<p>Nyckeln kan bara skickas från tavlans egen sida.</p>');
      // The key is never taken from a URL (M2): a stray ?key= is only removed from the address bar, never checked.
      if (url.searchParams.has('key')) return send(res, 302, '', { Location: back, ...(local ? {} : NO_FRAME) });

      if (!local) {
        const ip = ipv4(remote).join('.');
        const key = currentKey();
        if (method === 'POST') {
          const attempt = await readForm(req);
          if (attempt === null) return send(res, 413, 'too large', NO_FRAME);
          if (limited(ip))
            return page(res, 429, 'För många försök', '<p>För många felaktiga nycklar. Vänta en minut och försök igen.</p>', { 'Retry-After': '60' });
          if (key && safeEqual(normalizeKey(attempt), key)) {
            fails.delete(ip);
            const sid = store.create(keyId(key));
            return send(res, 303, '', { ...NO_FRAME, Location: back,
              'Set-Cookie': `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
          }
          fail(ip);
          return keyPage(res, back, { wrong: true });
        }
        const kid = key ? keyId(key) : null;
        if (!kid || !cookies(req).some(([name, value]) => name === COOKIE && store.valid(value, kid)))
          return keyPage(res, back, { bounce: method === 'GET' && !url.searchParams.has('b') });
      }

      if (!route) return send(res, 404, 'not found', local ? {} : NO_FRAME);
      // Only a page load refreshes (a navigation, or a client without fetch metadata); never a HEAD or a script's fetch.
      if (route.endsWith('.html') && method === 'GET' && (!mode || mode === 'navigate')) refresh();
      const file = path.join(boardDir, route);
      let body;
      try { body = await fs.promises.readFile(file); } catch { return send(res, 503, 'board not built yet', local ? {} : NO_FRAME); }
      send(res, 200, body, { 'Content-Type': types[path.extname(route)],
        ...(local ? {} : { ...NO_FRAME, 'Content-Security-Policy': "frame-ancestors 'none'" }) });
    } catch (error) {
      console.error('request failed: ' + String(error && error.message).split(/\r?\n/)[0]);
      if (!res.headersSent) send(res, 500, 'error', NO_FRAME); else res.end();
    }
  };
}

// ---- start checks for --lan (read-only) ----
const runPowerShell = script => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, windowsHide: true });
// True when an enabled inbound Block rule named "RAS board <port> (block Public)" covers TCP <port> on the Public profile.
function blockRuleOk(port, run = runPowerShell) {
  const script = "$ErrorActionPreference = 'SilentlyContinue'; " +
    `foreach ($r in @(Get-NetFirewallRule -DisplayName '${blockRuleName(port)}')) { $p = $r | Get-NetFirewallPortFilter; ` +
    "'{0}|{1}|{2}|{3}|{4}|{5}' -f $r.Enabled, $r.Direction, $r.Action, $r.Profile, $p.Protocol, ($p.LocalPort -join ',') }";
  let out;
  try { out = String(run(script)); } catch { return false; }
  return out.split(/\r?\n/).some(line => {
    const [enabled, dir, action, profile, proto, ports] = line.trim().split('|');
    return enabled === 'True' && dir === 'Inbound' && action === 'Block' && /\b(Public|Any)\b/.test(profile || '') &&
      String(proto).toUpperCase() === 'TCP' && String(ports).split(',').includes(String(port));
  });
}
// Swedish reasons why --lan must not start; empty = go. Checks are injectable for the tests.
function lanStartProblems({ port = DEFAULT_PORT, keyFile = defaultKeyFile, platform = process.platform,
  ensureKey = loadOrCreateKey, restrict = restrictToUser, aclOk = keyAclOk, firewallOk = blockRuleOk } = {}) {
  const problems = [];
  let keyReady = false;
  try { ensureKey(keyFile); keyReady = true; } catch { /* reported below */ }
  if (keyReady) { try { restrict(keyFile); } catch { /* checked next */ } }
  if (!keyReady || !aclOk(keyFile))
    problems.push(`Nyckelfilen ${keyFile} kunde inte låsas så att bara din Windows-användare kan läsa den. ` +
      'Kör "node tools/serve-local.cjs --rotate-key" och försök igen.');
  if (platform === 'win32' && !firewallOk(port))
    problems.push(`Brandväggsregeln "${blockRuleName(port)}" saknas. Den stänger porten på offentliga nätverk (kafé, hotell). ` +
      'Kör tools\\lan-setup.ps1 som administratör först.');
  return problems;
}

function main(argv) {
  const portArg = argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : String(DEFAULT_PORT);
  const port = Number(portArg);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('bad --port: ' + portArg); process.exit(1); }
  if (argv.includes('--revoke-sessions')) {
    createSessionStore().revokeAll();
    console.log('Alla enheter är utloggade. De behöver skriva in nyckeln igen.');
    return;
  }
  if (argv.includes('--rotate-key')) {
    writeKey();
    createSessionStore().revokeAll();
    console.log('Ny nyckel skriven till ' + defaultKeyFile + '. Alla enheter är utloggade. Visa nyckeln med --show-key.');
    return;
  }
  if (argv.includes('--show-key')) {
    const key = loadOrCreateKey();
    console.log(`Öppna http://${os.hostname().toLowerCase()}:${port}/ på den andra datorn och skriv in nyckeln (mellanslagen spelar ingen roll):`);
    console.log('  ' + formatKey(key));
    return;
  }
  const lan = argv.includes('--lan') || process.env.RAS_BOARD_LAN === '1';
  if (lan) {
    const problems = lanStartProblems({ port });
    if (problems.length) {
      for (const p of problems) console.error(p);
      console.error('Tavlan startar inte i hemnätverksläge. Utan --lan går den att öppna på den här datorn som vanligt.');
      process.exit(1);
    }
  }
  const refresh = makeRefresh();
  const server = http.createServer(createHandler({ lan, port, refresh }));
  server.requestTimeout = 15000;
  server.listen(port, bindHost(lan), () => {
    refresh();
    console.log('RAS board (local, with token history): http://localhost:' + port + '/');
    if (lan) console.log(`Home network (key needed on other devices): http://${os.hostname().toLowerCase()}:${port}/ – show the key with --show-key`);
  });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { HOST, LAN_HOST, ROUTES, REFRESH_MS, SESSION_MS, FAIL_LIMIT, FAIL_MAP_MAX, NET_REFRESH_MS, bindHost, cookieName, blockRuleName,
  isLoopback, lanNetworks, inNetworks, allowedHosts, readKey, writeKey, loadOrCreateKey, normalizeKey, formatKey, keyAclOk, safeEqual,
  keyId, createSessionStore, makeRefresh, createHandler, blockRuleOk, lanStartProblems, sameOrigin };
