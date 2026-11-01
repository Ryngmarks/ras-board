// node --test tools/library.test.cjs – the game library page (m09 WO-05): no data in git, one loader, everything escaped.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'mossvale.json');
const read = f => fs.readFileSync(f, 'utf8');
const codeScript = html => html.match(/<script>([\s\S]*?)<\/script>/)[1];

// The page script with its pure functions; boot() only runs where a `document` exists.
function page() {
  const ctx = vm.createContext({});
  vm.runInContext(codeScript(read(path.join(repo, 'library.html'))), ctx);
  return ctx;
}
const fakeDoc = text => ({ getElementById: id => (id === 'ras-library' && text !== undefined ? { textContent: text } : null) });
const noFetch = () => { throw new Error('fetch must not be called'); };

function cspHashOk(html) {
  const hash = crypto.createHash('sha256').update(codeScript(html).replace(/\r\n?/g, '\n'), 'utf8').digest('base64');
  return html.includes(`script-src 'sha256-${hash}'`);
}

test('committed library.html carries no data block and a valid CSP hash with same-origin connect only', () => {
  const html = read(path.join(repo, 'library.html'));
  assert.doesNotMatch(html, /<script[^>]*id=["']?ras-library/);
  assert.ok(cspHashOk(html), 'run node tools/csp.cjs library.html');
  assert.match(html, /connect-src 'self';/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('index.html CSP hash is still valid and it links to the library tab', () => {
  const html = read(path.join(repo, 'index.html'));
  assert.ok(cspHashOk(html), 'run node tools/csp.cjs index.html');
  assert.match(html, /href="library\.html"/);
});

test('loader: embedded export is read, extra fields ignored, missing notes get defaults', async () => {
  const p = page();
  const r = await p.loadLibrary(fakeDoc(read(fixture)), noFetch);
  assert.equal(r.state, 'ok');
  assert.equal(r.lib.families.length, 3);
  assert.equal(r.lib.unlisted.length, 3);
  assert.equal(r.lib.orphans.length, 1);
  const whirl = r.lib.families[1].abilities.find(a => a.id === 'test_whirl');
  assert.equal('futureField' in whirl, false);
  assert.equal(whirl.note.status, 'unreviewed');
  assert.equal(whirl.rig.action, '');
  assert.match(p.renderAbilityPanel(whirl, 'x'), /Inte beskrivet ännu/);
  assert.match(p.renderAbilityPanel(whirl, 'x'), /Inget klipp ännu/);
});

test('loader: embedded null = no export yet; broken or wrong version = invalid', async () => {
  const p = page();
  assert.equal((await p.loadLibrary(fakeDoc('null'), noFetch)).state, 'noexport');
  assert.equal((await p.loadLibrary(fakeDoc('{oops'), noFetch)).state, 'invalid');
  assert.equal((await p.loadLibrary(fakeDoc('{"version":2,"families":[]}'), noFetch)).state, 'invalid');
  assert.match(read(path.join(repo, 'library.html')), /noexport: "Ingen export ännu – kör tools\/library\/export\.mjs i Mossvale/);
});

test('loader: without an embedded block it fetches same-origin library.json only', async () => {
  const p = page();
  const urls = [];
  const ok = async url => { urls.push(url); return { ok: true, json: async () => JSON.parse(read(fixture)) }; };
  assert.equal((await p.loadLibrary(fakeDoc(undefined), ok)).state, 'ok');
  assert.deepEqual(urls, ['library.json']);
  assert.equal((await p.loadLibrary(fakeDoc(undefined), async () => ({ ok: false, status: 404 }))).state, 'elsewhere');
  assert.equal((await p.loadLibrary(fakeDoc(undefined), async () => { throw new TypeError('file://'); })).state, 'elsewhere');
});

test('hostile strings are escaped and hostile values dropped', () => {
  const p = page();
  const evil = '<img src=x onerror=alert(1)>"\'';
  const raw = JSON.parse(read(fixture));
  const f = raw.families[0];
  f.name = evil; f.glyph = '<b>'; f.color = 'red;background:url(//x)';
  f.passives[0].desc = evil; f.variants[0].name = evil;
  Object.assign(f.abilities[0], { name: evil, desc: evil, slot: '<i>', rig: { action: evil, source: 'scan', file: 'javascript:alert(1)', line: 'x' } });
  Object.assign(f.abilities[0].note, { identity: evil, proposal: evil, status: '<script>',
    knownIssues: [{ text: evil, source: 'C:/Users/x/secret.md' }],
    links: [{ label: evil, href: 'javascript:alert(1)' }, { label: 'up', href: '../../etc/passwd' }],
    media: { clip: 'https://evil.example/x.webp', icon: '/abs/icon.png' } });
  raw.orphans = [{ kind: '<x>', id: evil, hint: evil }];
  raw.exported = evil;
  raw.build.commit = evil;
  const lib = p.cleanLibrary(raw);
  const view = { family: lib.families[0].key, open: new Set([`${lib.families[0].key}-0`]), q: '', status: '', unlisted: true };
  p.setMediaBase('/media/mossvale/');
  const html = [p.renderMeta(lib), p.renderOrphans(lib), p.renderCards(lib, view), p.renderFamily(lib.families[0], view), p.renderUnlisted(lib, view)].join('\n');
  assert.doesNotMatch(html, /<img|<i>|<script|<x>/);
  // a 3-char glyph is dropped; the chip falls back to the (escaped) first letter of the name
  assert.match(html, /<span class="glyph" aria-hidden="true">&lt;<\/span>/);
  assert.doesNotMatch(html, /glyph" aria-hidden="true">&lt;b&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;/);
  assert.doesNotMatch(html, /javascript:|evil\.example|C:\/Users|\.\.\/|url\(/);
  assert.equal(lib.families[0].colour, '');
  assert.equal(lib.families[0].abilities[0].note.status, 'unreviewed');
  p.setMediaBase('');
});

test('media base: only repo-relative paths become same-origin URLs; no base = placeholders and plain text', () => {
  const p = page();
  assert.equal(p.relPath('docs/ras/m05/final-clips/a.webp'), 'docs/ras/m05/final-clips/a.webp');
  for (const bad of ['https://x/a.webp', '/abs.png', 'C:/x.png', 'a/../../b.png', '\\\\server\\x.png', 'data:image/png;base64,x']) assert.equal(p.relPath(bad), '', bad);
  assert.doesNotMatch(p.mediaBox('clip', 'docs/a.webp'), /<img/);
  p.setMediaBase('https://evil.example/');
  assert.equal(p.mediaUrl('docs/a.webp'), '');
  p.setMediaBase('media/mossvale');
  assert.match(p.mediaBox('clip', 'docs/a.webp'), /<img src="media\/mossvale\/docs\/a\.webp"/);
  p.setMediaBase('');
});

test('filter: unlisted abilities stay hidden until the toggle is on; search and status filter rows', () => {
  const p = page();
  const lib = p.cleanLibrary(JSON.parse(read(fixture)));
  const view = { family: 'sword', open: new Set(), q: '', status: '', unlisted: false };
  assert.equal(p.renderUnlisted(lib, view), '');
  view.unlisted = true;
  assert.match(p.renderUnlisted(lib, view), /Old Test Slash/);
  view.q = 'cleave';
  const fam = p.renderFamily(lib.families[0], view);
  assert.match(fam, /Test Cleave/);
  assert.doesNotMatch(fam, /Test Strike/);
  view.q = ''; view.status = 'needs-work';
  assert.match(p.renderCards(lib, view), /1 träffar/);
});

// build-local writes to a temp dir outside every git tree; HOME is never touched.
function buildLocal(env, out) {
  return spawnSync(process.execPath, [path.join(__dirname, 'build-local.cjs'), '--out', out],
    { env: { ...process.env, RAS_TELEMETRY_DIR: path.join(out, 'no-telemetry'), ...env }, encoding: 'utf8' });
}

test('build-local embeds the export (with "<" escaped) and keeps the CSP hash valid', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-lib-'));
  const libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-libsrc-'));
  const raw = JSON.parse(read(fixture));
  raw.families[0].abilities[0].desc = '</script><script>alert(1)</script>';
  fs.writeFileSync(path.join(libDir, 'mossvale.json'), JSON.stringify(raw));
  const r = buildLocal({ RAS_LIBRARY_DIR: libDir }, out);
  assert.equal(r.status, 0, r.stderr);
  const html = read(path.join(out, 'library.html'));
  const block = html.match(/<script type="application\/json" id="ras-library">([\s\S]*?)<\/script>/);
  assert.ok(block, 'data block embedded');
  assert.equal(block[1].includes('<'), false);
  assert.equal(JSON.parse(block[1]).families[0].abilities[0].desc, '</script><script>alert(1)</script>');
  assert.ok(cspHashOk(html));
  assert.ok(cspHashOk(read(path.join(out, 'index.html'))));
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(libDir, { recursive: true, force: true });
});

test('build-local with no export embeds null (page says "Ingen export ännu")', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-lib-'));
  const r = buildLocal({ RAS_LIBRARY_DIR: path.join(out, 'nothing-here') }, out);
  assert.equal(r.status, 0, r.stderr);
  const html = read(path.join(out, 'library.html'));
  assert.match(html, /<script type="application\/json" id="ras-library">null<\/script>/);
  const p = page();
  assert.equal((await p.loadLibrary(fakeDoc('null'), noFetch)).state, 'noexport');
  fs.rmSync(out, { recursive: true, force: true });
});

test('build-local still refuses to write inside a git work tree', () => {
  const r = buildLocal({ RAS_LIBRARY_DIR: path.dirname(fixture) }, path.join(repo, 'tmp-should-not-exist'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to write inside a git work tree/);
  assert.equal(fs.existsSync(path.join(repo, 'tmp-should-not-exist')), false);
});

test('serve-local serves /library.html (static check – starting it would refresh telemetry and publish)', () => {
  const src = read(path.join(__dirname, 'serve-local.cjs'));
  assert.match(src, /'\/library\.html': 'library\.html'/);
  assert.match(src, /listen\(port, HOST/);
  assert.match(src, /const HOST = '127\.0\.0\.1'/);
});

