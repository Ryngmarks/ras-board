// node --test tools/publish-missions.test.cjs – the mission log (ras07): the public list is a 5-field whitelist (owner #10), the
// Uppdrag page has one loader and escapes everything, and the public pages only ever link to the local board.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { sanitize } = require('./publish-missions.cjs');

const repo = path.join(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'missions.json');
const read = f => fs.readFileSync(f, 'utf8');
const doc = () => JSON.parse(read(fixture));
const codeScript = html => html.match(/<script>([\s\S]*?)<\/script>/)[1];
function cspHashOk(html) {
  const hash = crypto.createHash('sha256').update(codeScript(html).replace(/\r\n?/g, '\n'), 'utf8').digest('base64');
  return html.includes(`script-src 'sha256-${hash}'`);
}
// A page script with its pure functions; boot() only runs where a `document` exists.
function page(name) {
  const ctx = vm.createContext({});
  vm.runInContext(codeScript(read(path.join(repo, name))), ctx);
  return ctx;
}
const fakeDoc = text => ({ getElementById: id => (id === 'ras-missions' && text !== undefined ? { textContent: text } : null) });
const noFetch = () => { throw new Error('fetch must not be called'); };

// ---- publish-missions.cjs ----
const one = patch => { const d = doc(); Object.assign(d.missions.find(m => m.id === 'm20-test-cards'), patch); return sanitize(d); };

test('publish: exactly generated_at + missions, and exactly project, id, name, phase, updated (+ work_orders when the mission has them)', () => {
  const out = sanitize(doc());
  assert.deepEqual(Object.keys(out), ['generated_at', 'missions']);
  for (const m of out.missions) {
    assert.deepEqual(Object.keys(m), m.id === 'm20-test-cards' ? ['project', 'id', 'name', 'phase', 'updated', 'work_orders'] : ['project', 'id', 'name', 'phase', 'updated']);
    assert.match(m.updated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'owner #10: an ISO time only');
  }
  assert.equal(out.missions.find(m => m.id === 'm20-test-cards').updated, '2026-11-01T09:00:00.000Z');
  const json = JSON.stringify(out);
  for (const leak of ['WO-02 bygger', 'docs/ras', 'cl-m20', 'Brief skriven', '"opened"', '"closed"', '"log"', '"tokens"', '"next"']) assert.equal(json.includes(leak), false, leak);
});

test('publish: updated is rebuilt from the date, so no text rides along; a non-date is refused', () => {
  assert.equal(one({ updated: '2026-11-01T10:00:00+02:00' }).missions.find(m => m.id === 'm20-test-cards').updated, '2026-11-01T08:00:00.000Z');
  for (const updated of ['yesterday', 'WO-02 C:/Users/x', '', null, undefined, 7, '2026-11-01T10:00:00Z ' + 'x'.repeat(40)])
    assert.throws(() => one({ updated }), String(updated));
});

// ---- work orders (owner decision 2026-11-14: public) ----
test('publish: work orders are rebuilt from a whitelist, in plan order, with only the fields that are set', () => {
  const wos = sanitize(doc()).missions.find(m => m.id === 'm20-test-cards').work_orders;
  assert.deepEqual(wos.map(w => w.id), ['WO-01', 'WO-02', 'WO-03', 'WO-04']);
  assert.deepEqual(wos[0], { id: 'WO-01', title: 'Kortmodell', status: 'done', role: 'implementer', started: '2026-10-30T10:00:00.000Z', done: '2026-11-01T08:30:00.000Z', result: 'Granskad och godkänd' });
  assert.deepEqual(wos[2], { id: 'WO-03', title: 'Granska koden', status: 'todo', role: 'reviewer', after: 'WO-02' });
  const extra = one({ work_orders: [{ id: 'WO-01', title: 'T', status: 'todo', branch: 'secret-branch', note: 'private note', worktree: 'cl-m20' }] });
  assert.deepEqual(extra.missions.find(m => m.id === 'm20-test-cards').work_orders, [{ id: 'WO-01', title: 'T', status: 'todo' }], 'unknown fields never ride along');
});

test('publish: a bad work order stops the publish (no silent drop)', () => {
  const wo = patch => one({ work_orders: [{ id: 'WO-01', title: 'T', status: 'todo', ...patch }] });
  for (const patch of [{ id: 'WO 01' }, { id: '' }, { id: 'x'.repeat(25) }, { status: 'blocked' }, { title: '' }, { title: 7 }, { title: 'see C:/Users/x/notes' },
    { title: 'mail a@b.se' }, { role: 'Implementer!' }, { started: 'yesterday' }, { done: 7 }, { after: 'WO 02' }, { result: 'https://example.com/x' }])
    assert.throws(() => wo(patch), JSON.stringify(patch));
  assert.throws(() => one({ work_orders: 'WO-01' }));
  assert.throws(() => one({ work_orders: [null] }));
  assert.throws(() => one({ work_orders: Array.from({ length: 61 }, (_, i) => ({ id: 'WO-' + i, title: 'T', status: 'todo' })) }));
});

test('pages: both cleaners give the same work orders, drop unknown rows and escape-safe plain strings only', () => {
  const pub = sanitize(doc());
  for (const name of ['index.html', 'missions.html']) {
    const p = page(name);
    const fromPublic = p.cleanPublicMissions(JSON.parse(JSON.stringify(pub))).find(m => m.id === 'm20-test-cards').wos;
    const fromLocal = p.cleanMissions(doc()).find(m => m.id === 'm20-test-cards').wos;
    assert.equal(JSON.stringify(fromPublic), JSON.stringify(fromLocal), name);
    assert.equal(fromPublic.length, 4, name);
    assert.deepEqual(Object.keys(fromPublic[0]), ['id', 'title', 'role', 'status', 'started', 'done', 'after', 'result'], name);
    const rows = p.cleanWos([{ id: 'WO-01', title: 'ok', status: 'todo', role: '<img>', started: 'nope', extra: 1 }, { id: 'WO-02', title: 'x', status: 'evil' }, { title: 'no id', status: 'todo' }, null, 'x']);
    assert.equal(JSON.stringify(rows), JSON.stringify([{ id: 'WO-01', title: 'ok', role: '', status: 'todo', started: '', done: '', after: '', result: '' }]), name);
    assert.equal(p.cleanWos(undefined).length, 0, name);
    assert.equal(p.cleanWos(Array.from({ length: 500 }, (_, i) => ({ id: 'W' + i, title: 't', status: 'todo' }))).length, 60, name);
  }
});

test('board: a hostile work order title is escaped in the plan', () => {
  const p = page('index.html');
  const w = p.cleanWos([{ id: '<b>', title: '<img src=x onerror=alert(1)>', status: 'done', role: 'implementer', result: '<script>' }])[0];
  const html = p.woItem(w, { key: 'P/m' }, {});
  assert.equal(/<img|<script|<b>/.test(html.replace(/<b>(?=&lt;)/g, '')), false);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

// ras07 review finding 3 + owner #6: no silent cut – every public mission (old done and active) survives publish -> cleaner.
test('archive: 10001 public missions all survive both public cleaners (no cap at all)', () => {
  const pub = { generated_at: '2026-11-01T00:00:00.000Z', missions: Array.from({ length: 10001 }, (_, i) => ({ project: 'Proj', id: `m${i}-x`, name: `M ${i}`, phase: i === 10000 ? 'build' : 'done', updated: '2026-01-01T00:00:00.000Z' })) };
  for (const name of ['index.html', 'missions.html']) {
    const rows = page(name).cleanPublicMissions(JSON.parse(JSON.stringify(pub)));
    assert.equal(rows.length, 10001, name);
    assert.ok(rows.some(m => m.id === 'm10000-x' && m.phase === 'build'), name);
  }
});

test('archive: 600 missions incl. old done and active all survive publish and both public cleaners', () => {
  const d = { version: 1, missions: Array.from({ length: 600 }, (_, i) => ({
    key: `Proj/ras${String(i).padStart(3, '0')}-m`, project: 'Proj', id: `ras${String(i).padStart(3, '0')}-m`, title: `M ${i}`,
    phase: i === 599 ? 'build' : i === 598 ? 'owner' : 'done', updated: new Date(Date.UTC(2020, 0, 1) + i * 3600e3).toISOString(), public: true })) };
  d.missions.push({ ...d.missions[0], key: 'Proj/zz-audit', id: 'zz-audit', public: false });
  const pub = sanitize(d);
  assert.equal(pub.missions.length, 600);
  assert.ok(pub.missions.some(m => m.id === 'ras000-m' && m.phase === 'done'), 'oldest done mission kept');
  assert.equal(pub.missions.find(m => m.id === 'ras599-m').phase, 'build', 'active mission kept');
  assert.equal(pub.missions.some(m => m.id === 'zz-audit'), false);
  for (const name of ['index.html', 'missions.html']) {
    const rows = page(name).cleanPublicMissions(JSON.parse(JSON.stringify(pub)));
    assert.equal(rows.length, 600, name);
    assert.ok(rows.some(m => m.id === 'ras000-m') && rows.some(m => m.id === 'ras599-m' && m.phase === 'build'), name);
    assert.equal(rows.find(m => m.id === 'ras000-m').updated, '2020-01-01T00:00:00.000Z', name);
  }
  assert.equal(page('missions.html').cleanMissions(d).length, 601, 'local cleaner: no 500 cut either');
});

test('public Senaste aktivitet (owner #10): newest phase changes as project · name → phase, no notes, no role events', () => {
  const p = page('index.html');
  const list = p.cleanPublicMissions(sanitize(doc()));
  // a live role entry exists, but the public feed shows phase changes only (who works now stays in the org tree/Projekt)
  p.__list = list;
  vm.runInContext('MISS = { state: "ok", local: false, list: __list }; data = { entries: [{ role: "implementer", project: "Mossvale", state: "working", note: "x", since: new Date().toISOString() }] };', p);
  const items = p.activityItems();
  assert.equal(items.length, 7, 'the 7 newest of the 7 public missions');
  assert.deepEqual(items.map(i => i.t), items.map(i => i.t).slice().sort((a, b) => b - a), 'newest first');
  assert.equal(items[0].html, '<b>Mossvale · Visuell stil (test)</b> → <span class="phase p-owner">Väntar på dig</span>');
  const all = items.map(i => i.html).join('\n');
  assert.doesNotMatch(all, /WO-0|Brief skriven|Välj en av|arbetar i|väntar i|test-audit|Test Audit/);
});

test('publish: private missions are dropped (public:false or no explicit true); every done mission is kept', () => {
  const ids = sanitize(doc()).missions.map(m => m.id);
  assert.equal(ids.includes('ch02-test-audit'), false);
  assert.ok(ids.includes('ras90-test-done') && ids.includes('ras91-test-old'), 'old done missions stay (owner #6)');
  assert.equal(one({ public: undefined }).missions.some(m => m.id === 'm20-test-cards'), false);
  assert.equal(one({ public: 'yes' }).missions.some(m => m.id === 'm20-test-cards'), false);
});

for (const [label, patch] of [
  ['windows path in title', { title: 'C:\\Users\\johan\\x' }], ['forward-slash path', { title: 'see C:/Users/johan' }],
  ['unix home', { title: 'in /Users/johan' }], ['URL', { title: 'see https://x.y' }], ['e-mail', { project: 'j@ryngmarks.com' }],
  ['GitHub token', { title: 'github_pat_abc' }], ['private key', { title: '-----BEGIN KEY' }], ['bad id', { id: '../x' }],
  ['id with a path', { id: 'C:/x' }], ['unknown phase', { phase: 'hacked' }], ['empty title', { title: '' }], ['title not text', { title: 7 }],
]) {
  test(`publish: refuses ${label}`, () => assert.throws(() => one(patch)));
}

test('publish: not a version 1 list is refused', () => {
  assert.throws(() => sanitize({ version: 2, missions: [] }));
  assert.throws(() => sanitize({ version: 1 }));
});

test('publish --dry-run on the fixture prints the whitelist and needs no token', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'publish-missions.cjs'), '--dry-run'],
    { env: { ...process.env, RAS_MISSIONS_FILE: fixture, USERPROFILE: os.tmpdir(), HOME: os.tmpdir() }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.missions.length, 7);
  assert.equal(out.missions.some(m => m.id === 'ch02-test-audit'), false);
});

// ---- missions.html ----
test('committed missions.html carries no data block and a valid CSP hash (GitHub raw allowed)', () => {
  const html = read(path.join(repo, 'missions.html'));
  assert.doesNotMatch(html, /<script[^>]*id=["']?ras-missions/);
  assert.ok(cspHashOk(html), 'run node tools/csp.cjs missions.html');
  assert.match(html, /connect-src 'self' https:\/\/api\.github\.com https:\/\/raw\.githubusercontent\.com;/);
});

test('loader: embedded log = local rows with tokens; null = none; broken or wrong version = invalid', async () => {
  const p = page('missions.html');
  const d = doc(); d.missions[0].tokens = 12_300_000;
  const r = await p.loadMissions(fakeDoc(JSON.stringify(d)), noFetch);
  assert.equal(r.state, 'ok');
  assert.equal(r.local, true);
  assert.equal(r.list.length, 8, 'local view shows private missions too');
  assert.equal(r.list[0].tokens, 12_300_000);
  assert.equal((await p.loadMissions(fakeDoc('null'), noFetch)).state, 'none');
  assert.equal((await p.loadMissions(fakeDoc('{oops'), noFetch)).state, 'invalid');
  assert.equal((await p.loadMissions(fakeDoc('{"version":null}'), noFetch)).state, 'invalid');
});

test('loader: without a block it fetches only the public list; 404 = none, network error = failed', async () => {
  const p = page('missions.html');
  const urls = [];
  const pub = sanitize(doc());
  const ok = async url => { urls.push(url); return { ok: true, status: 200, json: async () => pub }; };
  const r = await p.loadMissions(fakeDoc(undefined), ok);
  assert.deepEqual(urls, ['https://raw.githubusercontent.com/Ryngmarks/ras-board/status/missions.json']);
  assert.equal(r.local, false);
  assert.equal(r.list.find(m => m.id === 'm30-test-style').title, 'Visuell stil (test)');
  assert.equal(r.list.every(m => m.next === '' && m.log.length === 0 && m.tokens === null), true);
  assert.equal((await p.loadMissions(fakeDoc(undefined), async () => ({ ok: false, status: 404 }))).state, 'none');
  assert.equal((await p.loadMissions(fakeDoc(undefined), async () => { throw new TypeError('offline'); })).state, 'failed');
});

test('index.html and missions.html clean missions the same way (no drift between the copies)', () => {
  const a = page('index.html'), b = page('missions.html');
  const raw = doc(), pub = sanitize(doc());
  assert.equal(JSON.stringify(a.cleanMissions(raw)), JSON.stringify(b.cleanMissions(raw)));
  assert.equal(JSON.stringify(a.cleanPublicMissions(pub)), JSON.stringify(b.cleanPublicMissions(pub)));
  assert.equal(codeScript(read(path.join(repo, 'index.html'))).includes(b.loadMissions.toString()), true, 'loadMissions copies differ');
});

test('groups: Väntar på dig first, Klar last and collapsed; public rows show project, name and phase only', () => {
  const p = page('missions.html');
  const list = p.cleanMissions(doc());
  const view = { local: true, project: '', open: new Set(), doneOpen: false, hit: '' };
  const html = p.renderPage(list, view, { Mossvale: 'gaming' });
  const order = ['Väntar på dig', 'Analys och plan', 'Utförande och granskning', 'Pausad', 'Klar'].map(t => html.indexOf(`<h2>${t}</h2>`));
  assert.ok(order.every(i => i > -1) && order.every((v, i) => i === 0 || v > order[i - 1]), String(order));
  assert.match(html, /<details class="card group g-done" id="g-done">/);
  assert.match(html, /bdot gaming/);
  const pub = p.renderPage(p.cleanPublicMissions(sanitize(doc())), { ...view, local: false }, {});
  assert.doesNotMatch(pub, /Välj en av tre stilar|data-key|Tokens|<code>/);
  assert.match(pub, /Visuell stil \(test\)/);
});

test('hostile strings are escaped and hostile values dropped', () => {
  const p = page('missions.html');
  const evil = '<img src=x onerror=alert(1)>"\'';
  const d = doc();
  Object.assign(d.missions[0], { project: evil, title: evil, next: evil, branch: evil, worktree: evil, brief: 'C:/Users/x/brief.md',
    status: '../../etc/passwd', tokens: 'x', log: [{ at: evil, phase: 'build', note: evil }, { at: d.missions[0].updated, phase: '<b>', note: 'x' }] });
  d.missions[1].phase = '<script>';
  const list = p.cleanMissions(d);
  assert.equal(list.length, 7, 'unknown phase dropped');
  const m = list.find(x => x.project === evil);
  assert.equal(m.brief, '');
  assert.equal(m.status, '');
  assert.equal(m.tokens, null);
  assert.equal(m.log.length, 1);
  const view = { local: true, project: '', open: new Set(list.map(x => x.key)), doneOpen: true, hit: '' };
  const html = p.renderPage(list, view, {}) + p.renderFilters(list, view).html;
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;/);
  assert.doesNotMatch(html, /C:\/Users|\.\.\/\.\./);
  // the public shape goes through the same renderer
  const pub = p.cleanPublicMissions({ missions: [{ project: evil, id: 'x1', name: evil, phase: 'owner', next: evil }] });
  assert.equal(pub[0].next, '');
  assert.doesNotMatch(p.renderPage(pub, { ...view, local: false }, {}), /<img/);
});

// ---- build-local ----
function buildLocal(env, out) {
  return spawnSync(process.execPath, [path.join(__dirname, 'build-local.cjs'), '--out', out],
    { env: { ...process.env, RAS_TELEMETRY_DIR: path.join(out, 'no-telemetry'), RAS_LIBRARY_DIR: path.join(out, 'no-library'), ...env }, encoding: 'utf8' });
}

test('build-local embeds the mission log in missions.html and index.html, joins tokens by key, keeps CSP valid', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-mis-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-missrc-'));
  const d = doc();
  d.missions[0].title = '</script><script>alert(1)</script>';
  fs.writeFileSync(path.join(src, 'missions.json'), JSON.stringify(d));
  fs.mkdirSync(path.join(src, 'tel'));
  fs.writeFileSync(path.join(src, 'tel', 'missions.json'), JSON.stringify({ missions: [{ key: d.missions[0].key, total: 4200000 }] }));
  const r = buildLocal({ RAS_MISSIONS_FILE: path.join(src, 'missions.json'), RAS_TELEMETRY_DIR: path.join(src, 'tel') }, out);
  assert.equal(r.status, 0, r.stderr);
  for (const name of ['missions.html', 'index.html']) {
    const html = read(path.join(out, name));
    const block = html.match(/<script type="application\/json" id="ras-missions">([\s\S]*?)<\/script>/);
    assert.ok(block, `${name}: data block embedded`);
    assert.equal(block[1].includes('<'), false);
    const embedded = JSON.parse(block[1]);
    assert.equal(embedded.missions[0].title, '</script><script>alert(1)</script>');
    assert.equal(embedded.missions[0].tokens, 4200000);
    assert.equal(embedded.missions[1].tokens, null);
    assert.ok(cspHashOk(html), name);
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test('build-local with no mission log embeds null; a broken one embeds an unknown shape', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-mis-'));
  let r = buildLocal({ RAS_MISSIONS_FILE: path.join(out, 'nothing.json') }, out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(path.join(out, 'missions.html')), /<script type="application\/json" id="ras-missions">null<\/script>/);
  fs.writeFileSync(path.join(out, 'broken.json'), '{oops');
  r = buildLocal({ RAS_MISSIONS_FILE: path.join(out, 'broken.json') }, out);
  assert.equal(r.status, 0, r.stderr);
  const block = read(path.join(out, 'missions.html')).match(/id="ras-missions">([\s\S]*?)<\/script>/)[1];
  assert.equal((await page('missions.html').loadMissions(fakeDoc(block), noFetch)).state, 'invalid');
  fs.rmSync(out, { recursive: true, force: true });
});

// ---- the three pages: top bar + local links (owner #9) ----
// Owner #11: the local board's hostname on the home network (never the DHCP IP, never a key).
const LOCAL = { 'index.html': 'http://johansdator:5199/', 'missions.html': 'http://johansdator:5199/missions.html', 'library.html': 'http://johansdator:5199/library.html' };
const ALLOWED_LOCAL = new Set(Object.values(LOCAL));

test('every page has the same top bar: Översikt, Uppdrag, Spelbibliotek, the current one marked', () => {
  for (const name of Object.keys(LOCAL)) {
    const html = read(path.join(repo, name));
    const nav = html.match(/<nav class="tabs"[\s\S]*?<\/nav>/)[0];
    const tabs = [...nav.matchAll(/<a href="([^"]+)"([^>]*)>[\s\S]*?<span>([^<]+)<\/span><\/a>/g)].map(m => [m[1], m[3], /aria-current="page"/.test(m[2])]);
    assert.deepEqual(tabs.map(t => t.slice(0, 2)), [['index.html', 'Översikt'], ['missions.html', 'Uppdrag'], ['library.html', 'Spelbibliotek']], name);
    assert.deepEqual(tabs.filter(t => t[2]).map(t => t[0]), [name], name);
    assert.match(html, /\.topbar \{ position: sticky; top: 0;/);
  }
});

test('public pages link to the same page on the local board (johansdator), and to nothing else local or keyed', () => {
  for (const [name, url] of Object.entries(LOCAL)) {
    const html = read(path.join(repo, name));
    assert.ok(html.includes(`<a href="${url}" rel="noopener">Öppna lokalt →</a>`), name);
    assert.ok(html.includes('<small>Fungerar i Johans hemnätverk när tavlan är igång.</small>'), name);
    for (const m of html.matchAll(/(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|johansdator|192\.168\.\d+\.\d+)[^"'\s<]*/gi)) assert.ok(ALLOWED_LOCAL.has(m[0]), `${name}: ${m[0]}`);
    assert.doesNotMatch(html, /[?&]key=/, name);
    if (name !== 'library.html') assert.ok(html.includes('data-local-href="http://johansdator:5199/library.html"'), name);
  }
});

test('serve-local serves /missions.html and binds to 127.0.0.1 unless LAN mode is asked for (no server is started)', () => {
  const serve = require('./serve-local.cjs');
  assert.equal(serve.ROUTES['/missions.html'], 'missions.html');
  assert.equal(serve.bindHost(false), '127.0.0.1');
  assert.equal(serve.bindHost(undefined), '127.0.0.1');
});

// ---- decisions on work orders that wait for the owner ----
const DEC = () => ({
  summary: 'Kameran styr hur spelet känns.',
  questions: [
    { id: 'S1', text: 'Kamerans inramning', note: 'Gäller alla scener.', options: [{ label: 'A Närmare', text: 'Tätt på hjälten' }, { label: 'B Balanserad', text: 'Mitt emellan', recommended: true }, { label: 'C Vidare' }] },
    { id: 'Q2', text: 'En fråga utan val besvaras i fritext.' }] });
const owned = decision => one({ work_orders: [{ id: 'WO-05', title: 'Välj kamera', status: 'owner', started: '2026-11-01T10:00:00Z', decision }] }).missions.find(m => m.id === 'm20-test-cards').work_orders[0];
const rx = s => new RegExp(s.replace(/[[\]().]/g, '\\$&'));

test('publish: a decision on an owner work order is rebuilt from the whitelist', () => {
  assert.deepEqual(owned(DEC()).decision, DEC());
  const d = DEC();
  d.extra = 'x'; d.questions[0].secret = 'x'; d.questions[0].options[0].branch = 'x'; d.questions[0].options[0].recommended = null;
  assert.deepEqual(owned(d).decision, DEC(), 'unknown fields and a null recommended never ride along');
  assert.equal('decision' in owned(undefined), false);
  assert.equal('decision' in owned(null), false);
  assert.deepEqual(owned({ questions: [{ id: 'Q', text: 'T', options: null }] }).decision, { questions: [{ id: 'Q', text: 'T' }] });
});

test('publish: a decision is published on no other status (the fixture carries one on a todo work order)', () => {
  const wos = sanitize(doc()).missions.find(m => m.id === 'm20-test-cards').work_orders;
  assert.equal('decision' in wos[3], false);
  for (const status of ['done', 'working', 'todo']) {
    const out = one({ work_orders: [{ id: 'WO-05', title: 'T', status, decision: DEC() }] }).missions.find(m => m.id === 'm20-test-cards').work_orders[0];
    assert.equal('decision' in out, false, status);
  }
});

test('publish: a malformed decision stops the publish and the error names the field', () => {
  const bad = (fn, field) => { const d = DEC(); fn(d); assert.throws(() => owned(d), rx(field), field); };
  bad(d => { d.questions = []; }, 'decision.questions');
  bad(d => { d.questions = 'S1'; }, 'decision.questions');
  bad(d => { d.questions = Array.from({ length: 13 }, (_, i) => ({ id: 'Q' + i, text: 'T' })); }, 'decision.questions');
  bad(d => { d.questions[0].id = 'S 1'; }, 'questions[0].id');
  bad(d => { d.questions[0].id = 7; }, 'questions[0].id');
  bad(d => { d.questions[1].id = 'S1'; }, 'questions[1].id');
  bad(d => { d.questions[0].text = ''; }, 'questions[0]');
  bad(d => { delete d.questions[1].text; }, 'questions[1]');
  bad(d => { d.questions[0] = null; }, 'questions[0]');
  bad(d => { d.questions[0].options = [{ label: 'A' }]; }, 'questions[0].options');
  bad(d => { d.questions[0].options = Array.from({ length: 7 }, (_, i) => ({ label: 'L' + i })); }, 'questions[0].options');
  bad(d => { d.questions[0].options = 'A'; }, 'questions[0].options');
  bad(d => { d.questions[0].options[1].label = ''; }, 'options[1]');
  bad(d => { delete d.questions[0].options[2].label; }, 'options[2]');
  bad(d => { d.questions[0].options[2].recommended = true; }, 'more than one recommended');
  bad(d => { d.questions[0].options[0].recommended = 'true'; }, 'recommended is not true');
  bad(d => { d.questions[0].options[0].recommended = false; }, 'recommended is not true');
  bad(d => { d.summary = 7; }, 'decision.summary');
  bad(d => { d.questions[0].note = {}; }, 'questions[0].note');
  assert.throws(() => owned('S1'), /is not a decision/);
  assert.throws(() => owned([DEC()]), /is not a decision/);
});

test('publish: decision texts are cut at their limits and run through the path/URL/address/key guard', () => {
  const d = DEC();
  d.summary = 's'.repeat(400); d.questions[0].text = 't'.repeat(300); d.questions[0].note = 'n'.repeat(400);
  d.questions[0].options[0].label = 'l'.repeat(90); d.questions[0].options[0].text = 'x'.repeat(300);
  const out = owned(d).decision;
  assert.deepEqual([out.summary.length, out.questions[0].text.length, out.questions[0].note.length, out.questions[0].options[0].label.length, out.questions[0].options[0].text.length], [300, 200, 300, 60, 240]);
  for (const [fn, field] of [
    [x => { x.summary = 'se C:/Users/x/notes'; }, 'decision.summary'], [x => { x.questions[0].text = 'https://example.com'; }, 'questions[0].text'],
    [x => { x.questions[0].note = 'mail a@b.se'; }, 'questions[0].note'], [x => { x.questions[0].options[0].label = 'ghp_abcdef'; }, 'options[0].label'],
    [x => { x.questions[0].options[1].text = '/Users/johan/x'; }, 'options[1].text']]) {
    const x = DEC(); fn(x);
    assert.throws(() => owned(x), new RegExp(rx(field).source + '[^]*looks like a path'), field);
  }
});

test('publish: the whole list is refused when one decision is bad (nothing is half published)', () => {
  const d = doc();
  d.missions[0].work_orders.push({ id: 'WO-05', title: 'T', status: 'owner', decision: { questions: [{ id: 'S1', text: 'T', options: [{ label: 'A' }, { label: 'B', recommended: true }, { label: 'C', recommended: true }] }] } });
  assert.throws(() => sanitize(d), /work_orders\[4\]\.decision\.questions\[0\]/);
});

// ---- the decision panel on the board page ----
const pageDec = () => {
  const p = page('index.html');
  const m = { key: 'Clicker Land/m20-test-cards' };
  const w = p.cleanWos([{ id: 'WO-05', title: 'Välj kamera', status: 'owner', started: '2026-11-01T10:00:00Z', decision: DEC() }])[0];
  return { p, m, w };
};

test('board: cleanWos keeps a valid decision on owner only, and drops an invalid one whole', () => {
  const { p, w } = pageDec();
  assert.equal(w.decision.questions.length, 2);
  assert.equal(JSON.stringify(w.decision.questions[1]), JSON.stringify({ id: 'Q2', text: 'En fråga utan val besvaras i fritext.', note: '', options: [] }));
  assert.equal(JSON.stringify(w.decision.questions[0].options.map(o => o.recommended)), "[false,true,false]");
  const one1 = d => p.cleanWos([{ id: 'WO-05', title: 'T', status: 'owner', decision: d }])[0];
  assert.equal(p.cleanWos([{ id: 'WO-05', title: 'T', status: 'todo', decision: DEC() }])[0].decision, undefined);
  for (const fn of [d => { d.questions = []; }, d => { d.questions = Array.from({ length: 13 }, (_, i) => ({ id: 'Q' + i, text: 'T' })); }, d => { d.questions[1].id = 'S1'; },
    d => { d.questions[0].id = '<b>'; }, d => { d.questions[0].text = ''; }, d => { d.questions[0].options.length = 1; }, d => { d.questions[0].options[0].label = ''; },
    d => { d.questions[0].options[0].recommended = true; }, d => { d.questions[0].options[0].recommended = 'yes'; }, d => { d.questions = 'S1'; }]) {
    const d = DEC(); fn(d);
    assert.equal(one1(d).decision, undefined, fn.toString());
  }
  for (const d of [null, 'x', [], 7]) assert.equal(one1(d).decision, undefined);
  const long = DEC(); long.questions[0].text = 't'.repeat(500); long.summary = 's'.repeat(500);
  assert.equal(one1(long).decision.questions[0].text.length, 200);
  assert.equal(one1(long).decision.summary.length, 300);
});

test('board: an owner work order with a decision gets a closed button and a hidden panel; one without keeps the link', () => {
  const { p, m, w } = pageDec();
  const html = p.woItem(w, m, {});
  assert.match(html, /<button type="button" class="dec-btn" data-dec="[^"]+" aria-expanded="false" aria-controls="(dec-\d+)">Öppna beslutet/);
  const id = html.match(/aria-controls="([^"]+)"/)[1];
  assert.match(html, new RegExp(`<div class="dec-panel" id="${id}" role="region"[^>]* hidden>`));
  assert.doesNotMatch(html, /<input|<form|<textarea|<select|onclick|<a /);
  const plain = p.cleanWos([{ id: 'WO-06', title: 'Utan beslut', status: 'owner' }])[0];
  const link = p.woItem(plain, m, {});
  assert.match(link, /<a class="dec-btn" href="missions\.html#/);
  assert.doesNotMatch(link, /<button|dec-panel/);
});

test('board: the open panel shows summary, ids, notes, options, the recommended mark, free text and how to answer', () => {
  const { p, m, w } = pageDec();
  p.toggleDecision(p.decKey(m, w));
  const html = p.woItem(w, m, {});
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Stäng beslutet/);
  assert.doesNotMatch(html, /<div class="dec-panel"[^>]* hidden>/);
  for (const s of ['Kameran styr hur spelet känns.', '<code>S1</code>', 'Kamerans inramning', 'Gäller alla scener.', 'A Närmare', 'Tätt på hjälten', 'B Balanserad', 'C Vidare', '<code>Q2</code>', 'Besvaras med fritext.', 'till exempel <b>S1 B</b>'])
    assert.ok(html.includes(s), s);
  assert.equal(html.match(/Rekommenderas/g).length, 1);
  assert.match(html, /<li class="dec-opt rec"><b>B Balanserad<\/b><span class="dec-rec">Rekommenderas<\/span>/);
  assert.equal(html.match(/Besvaras med fritext/g).length, 1, 'only the question without options');
  p.toggleDecision(p.decKey(m, w));
  assert.match(p.woItem(w, m, {}), /aria-expanded="false"/);
});

test('board: hostile decision text is escaped', () => {
  const p = page('index.html');
  const evil = '<img src=x onerror=alert(1)>"\'';
  const w = p.cleanWos([{ id: 'WO-05', title: 'T', status: 'owner', decision: { summary: evil, questions: [{ id: 'S1', text: evil, note: evil, options: [{ label: evil, text: evil, recommended: true }, { label: evil }] }] } }])[0];
  const m = { key: 'P/m' };
  p.toggleDecision(p.decKey(m, w));
  const html = p.woItem(w, m, {});
  assert.doesNotMatch(html, /<img|<script/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;'));
});

test('board: opened panels stay open when Planen is repainted (state lives in a set, not in the DOM) and focus returns to the button', () => {
  const { p, m, w } = pageDec();
  const host = { innerHTML: '', firstChild: null, buttons: [], querySelectorAll() { return this.buttons; } };
  const els = { plan: { hidden: true }, plans: host };
  let focused = null;
  const key = p.decKey(m, w);
  p.document = { getElementById: id => els[id], activeElement: null };
  vm.runInContext(`MISS = { list: [{ key: ${JSON.stringify(m.key)}, project: 'Clicker Land', title: 'Test Cards', phase: 'owner', updated: '2026-11-01T09:00:00Z', wos: [${JSON.stringify(w)}] }] }`, p);
  p.paintPlan();
  assert.match(host.innerHTML, /aria-expanded="false"/);
  p.toggleDecision(key);
  host.buttons = [{ dataset: { dec: key }, focus() { focused = key; } }];
  p.document.activeElement = { dataset: { dec: key } };
  p.paintPlan();
  assert.match(host.innerHTML, /aria-expanded="true"/);
  assert.equal(focused, key, 'focus restored after the rebuild');
  host.firstChild = {};
  const before = host.innerHTML;
  p.paintPlan(); p.paintPlan(); // the 30 s repaint: still open
  assert.equal(host.innerHTML, before);
  assert.match(host.innerHTML, /aria-expanded="true"/);
  assert.equal(els.plan.hidden, false);
});

test('board: index.html draws decisions with no inline handler and the CSP hash is still valid; missions.html does not draw work orders', () => {
  const html = read(path.join(repo, 'index.html'));
  assert.ok(cspHashOk(html));
  assert.doesNotMatch(html, /\son(click|change|input|submit)=/i);
  assert.ok(html.includes('button[data-dec]'));
  assert.doesNotMatch(read(path.join(repo, 'missions.html')), /woItem|cleanDecision|dec-panel/);
});
