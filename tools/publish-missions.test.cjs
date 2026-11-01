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

test('publish: exactly generated_at + missions, and exactly project, id, name, phase, updated per mission', () => {
  const out = sanitize(doc());
  assert.deepEqual(Object.keys(out), ['generated_at', 'missions']);
  for (const m of out.missions) {
    assert.deepEqual(Object.keys(m), ['project', 'id', 'name', 'phase', 'updated']);
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
const LOCAL = { 'index.html': 'http://127.0.0.1:5199/', 'missions.html': 'http://127.0.0.1:5199/missions.html', 'library.html': 'http://127.0.0.1:5199/library.html' };
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

test('public pages link to the same page on the local board, and to nothing else on 127.0.0.1', () => {
  for (const [name, url] of Object.entries(LOCAL)) {
    const html = read(path.join(repo, name));
    assert.ok(html.includes(`<a href="${url}" rel="noopener">Öppna lokalt →</a>`), name);
    assert.match(html, /Fungerar bara på Johans dator medan den lokala tavlan körs \(knappen RAS-tavla i T3\)/);
    for (const m of html.matchAll(/(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)[^"'\s<]*/g)) assert.ok(ALLOWED_LOCAL.has(m[0]), `${name}: ${m[0]}`);
  }
});

test('serve-local serves /missions.html and still binds to 127.0.0.1 only (static check – starting it publishes)', () => {
  const src = read(path.join(__dirname, 'serve-local.cjs'));
  assert.match(src, /'\/missions\.html': 'missions\.html'/);
  assert.match(src, /const HOST = '127\.0\.0\.1'/);
  assert.match(src, /listen\(port, HOST/);
});
