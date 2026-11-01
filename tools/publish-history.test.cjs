// node --test tools/publish-history.test.cjs – the whitelist must stop anything that is not a mission summary.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitize } = require('./publish-history.cjs');

const base = { id: 'ras03', project: 'RAS', name: 'Board', org: 'core', director: 'Project Manager', input: 10, output: 2,
  total: 12, cache_read: 9, status: 'measured', closed_at: '2026-10-31T12:00:00Z', runs: 3, runs_missing: 0 };
const one = patch => sanitize({ missions: [{ ...base, ...patch }] }).missions[0];

test('a normal mission passes with exactly the whitelisted fields', () => {
  assert.deepEqual(Object.keys(one({})), ['id', 'project', 'name', 'org', 'director', 'input', 'output', 'total', 'cache_read',
    'status', 'closed_at', 'runs', 'runs_missing']);
});

test('extra fields are dropped, never published', () => {
  assert.equal(JSON.stringify(one({ secret: 'zzz', transcript_path: 'C:/x' })).includes('zzz'), false);
});

for (const [label, patch] of [
  ['windows path', { name: 'C:\\Users\\johan\\x' }], ['forward-slash path', { name: 'C:/Users/johan' }],
  ['UNC path', { name: '\\\\server\\share' }], ['unix home', { name: 'see /Users/johan' }], ['URL', { name: 'see https://x.y' }],
  ['GitHub token', { name: 'github_pat_abc' }], ['e-mail', { director: 'j@ryngmarks.com' }], ['private key', { name: '-----BEGIN KEY' }],
  ['negative count', { total: -1 }], ['non-integer count', { input: 1.5 }], ['bad date', { closed_at: 'yesterday' }],
]) {
  test(`refuses ${label}`, () => assert.throws(() => one(patch)));
}

test('unknown org and status become null; more than 10 missions are cut to 10', () => {
  const m = one({ org: 'evil', status: 'pwned' });
  assert.equal(m.org, null);
  assert.equal(m.status, null);
  assert.equal(sanitize({ missions: Array.from({ length: 12 }, () => base) }).missions.length, 10);
});

// ---- ras07 review finding 1: private missions (public: false in RAS docs/missions.json) never reach history.json ----
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { privateKeys } = require('./publish-history.cjs');

const rasHome = process.env.RAS_HOME || path.resolve(__dirname, '..', '..', 'ryngmark-agents');
const telemetryTool = path.join(rasHome, 'tools', 'ras-telemetry.mjs');
const log = (...missions) => ({ version: 1, missions: missions.map(([project, id, isPublic]) => ({ key: `${project}/${id}`, project, id, public: isPublic })) });
function publishDryRun(env) {
  const clean = { ...process.env, USERPROFILE: os.tmpdir(), HOME: os.tmpdir() };
  delete clean.RAS_MISSIONS_FILE; delete clean.RAS_HOME;
  return spawnSync(process.execPath, [path.join(__dirname, 'publish-history.cjs'), '--dry-run'], { env: { ...clean, ...env }, encoding: 'utf8' });
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ras-hist-')); }

test('sanitize drops hidden keys (any case) before the cut to 10', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ ...base, id: `ras${10 + i}` }));
  many.unshift({ ...base, project: 'RAS', id: 'ras02-self-audit' });
  const out = sanitize({ missions: many }, new Set(['ras/ras02-self-audit']));
  assert.equal(out.missions.length, 10);
  assert.equal(out.missions.some(m => m.id === 'ras02-self-audit'), false);
  assert.equal(out.missions[0].id, 'ras10');
});

test('private keys match whatever the case, padding or inner whitespace of the history entry', () => {
  const hidden = new Set(['ras/ras02-self-audit']);
  const cases = [[' RAS ', 'ras02-self-audit'], ['\tRAS', 'ras02-self-audit '], ['ras', ' RAS02-SELF-AUDIT'], ['RAS', 'ras02-self-audit\n'], ['\u00a0RAS', 'ras02-self-audit']];
  for (const [project, id] of cases) {
    const out = sanitize({ missions: [{ ...base, project, id }] }, hidden);
    assert.equal(out.missions.length, 0, JSON.stringify([project, id]));
  }
});

test('privateKeys reads public:false keys only and refuses a list that is not version 1', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify(log(['RAS', 'ras02-self-audit', false], ['RAS', 'ras03-board', true], ['RAS', 'ras04-x', undefined])));
  assert.deepEqual([...privateKeys(path.join(dir, 'm.json'))], ['ras/ras02-self-audit']);
  fs.writeFileSync(path.join(dir, 'v2.json'), JSON.stringify({ version: 2, missions: [] }));
  assert.throws(() => privateKeys(path.join(dir, 'v2.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('telemetry -> public: a closed public:false mission is not published (RAS_HOME default path)', t => {
  if (!fs.existsSync(telemetryTool)) return t.skip(`no ${telemetryTool}`);
  const dir = tmp(), tel = path.join(dir, 'telemetry'), home = path.join(dir, 'ras');
  fs.mkdirSync(tel); fs.mkdirSync(path.join(home, 'docs'), { recursive: true });
  const snap = (id, total) => ({ id, input: total - 1, output: 1, total, cache_read: 0, status: 'measured', runs: 1, runs_missing: 0 });
  fs.writeFileSync(path.join(tel, 'closed.json'), JSON.stringify({
    'RAS/ras02-self-audit': { closed_at: '2026-10-30T10:00:00.000Z', name: 'Self audit', project: 'RAS', snapshot: snap('ras02-self-audit', 50) },
    'RAS/ras03-board-telemetry': { closed_at: '2026-10-29T10:00:00.000Z', name: 'Board telemetry', project: 'RAS', snapshot: snap('ras03-board-telemetry', 70) },
  }));
  const made = spawnSync(process.execPath, [telemetryTool, 'history'], { env: { ...process.env, RAS_TELEMETRY_DIR: tel, RAS_NOW: '2026-11-01T00:00:00.000Z' }, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const history = JSON.parse(fs.readFileSync(path.join(tel, 'history.json'), 'utf8'));
  assert.ok(history.missions.some(m => m.id === 'ras02-self-audit'), 'telemetry itself keeps the audit (it has no privacy field)');
  fs.writeFileSync(path.join(home, 'docs', 'missions.json'), JSON.stringify(log(['RAS', 'ras02-self-audit', false], ['RAS', 'ras03-board-telemetry', true])));
  const r = publishDryRun({ RAS_TELEMETRY_DIR: tel, RAS_HOME: home });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.missions.map(m => m.id), ['ras03-board-telemetry']);
  assert.equal(r.stdout.includes('audit') || r.stdout.includes('Self'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fail closed: history with missions + a missing or broken mission log = nothing published, one warning, exit 0', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ missions: [{ ...base, project: 'RAS', id: 'ras02-self-audit' }] }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{oops');
  fs.writeFileSync(path.join(dir, 'wrong.json'), JSON.stringify({ missions: [] }));
  for (const file of ['missing.json', 'broken.json', 'wrong.json']) {
    const r = publishDryRun({ RAS_TELEMETRY_DIR: dir, RAS_MISSIONS_FILE: path.join(dir, file) });
    assert.equal(r.status, 0, file + ': ' + r.stderr);
    assert.equal(r.stdout, '', file);
    assert.equal(r.stderr.trim().split(/\r?\n/).length, 1, file);
    assert.match(r.stderr, /publishing nothing/);
  }
  // nothing to hide: an empty history still publishes (without needing the log)
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ missions: [] }));
  const r = publishDryRun({ RAS_TELEMETRY_DIR: dir, RAS_MISSIONS_FILE: path.join(dir, 'missing.json') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).missions, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
