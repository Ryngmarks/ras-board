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
