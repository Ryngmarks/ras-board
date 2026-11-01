#!/usr/bin/env node
// Publishes the mission token history to the public board (owner decision 2026-10-31):
// mission name, project, organisation, director, input/output/total/cache tokens, status and close date – nothing else.
//
// Reads  %USERPROFILE%/.ras/telemetry/history.json (env RAS_TELEMETRY_DIR overrides) and the RAS mission log
//        <RAS_MISSIONS_FILE or <RAS_HOME or ../ryngmark-agents>/docs/missions.json>: every mission whose key
//        <project>/<id> is `public: false` there (security audits) is dropped (ras07 review finding 1). Fail closed: when the
//        history has missions and the log cannot be read, nothing is published (one warning line, exit 0 – serve-local
//        runs this as best effort).
// Writes history.json on branch `status` of Ryngmarks/ras-board through the GitHub API with the board-only token in
//        %USERPROFILE%/.ras/board-token (fine-grained: ras-board, Contents read/write).
// Every value is rebuilt from a whitelist and checked: anything that looks like a path, a key or a URL stops the publish.
// Usage: node tools/publish-history.cjs [--dry-run]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'Ryngmarks/ras-board';
const BRANCH = 'status';
const FILE = 'history.json';
const dryRun = process.argv.includes('--dry-run');
const telemetryDir = process.env.RAS_TELEMETRY_DIR || path.join(os.homedir(), '.ras', 'telemetry');
const tokenFile = path.join(os.homedir(), '.ras', 'board-token');
const rasHome = process.env.RAS_HOME || path.resolve(__dirname, '..', '..', 'ryngmark-agents');
const missionsFile = process.env.RAS_MISSIONS_FILE || path.join(rasHome, 'docs', 'missions.json');

const ORGS = ['gaming', 'software', 'core'];
const STATUSES = ['measured', 'partial', 'missing'];
// Things that must never reach a public file: Windows/Unix paths, URLs, e-mail addresses, typical secret prefixes.
const FORBIDDEN = /[A-Za-z]:[\\/]|\\\\|(^|\s)\/(Users|home|tmp|etc)\b|https?:\/\/|[\w.+-]+@[\w-]+\.\w|github_pat_|ghp_|gho_|sk-[A-Za-z0-9]|AKIA[0-9A-Z]{8}|-----BEGIN/;

function text(value, max, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${field} is not text`);
  const clean = value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  if (FORBIDDEN.test(clean)) throw new Error(`${field} looks like a path, URL, address or key – refusing to publish: "${clean.slice(0, 40)}"`);
  return clean;
}
function count(value, field) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is not a token count`);
  return value;
}

// Normalised so case, padding, whitespace, control or invisible format characters can never make a private key miss
// (ras07 fix checks F1): every such character is removed, not just trimmed. Over-matching only hides more – safe.
const norm = v => String(v ?? '').normalize('NFKC').replace(/[\p{C}\p{Z}\s]+/gu, '').toLowerCase();
const missionKey = (project, id) => `${norm(project)}/${norm(id)}`;

// The keys (lower case) of every mission marked `public: false` in RAS docs/missions.json. Throws when the file is
// missing, unreadable or not a version 1 list – the caller then publishes nothing.
function privateKeys(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || doc.version !== 1 || !Array.isArray(doc.missions)) throw new Error('not a version 1 mission list');
  const keys = new Set();
  for (const m of doc.missions) {
    if (!m || typeof m !== 'object' || m.public !== false) continue;
    if (typeof m.key === 'string' && m.key.includes('/')) { const [proj, ...rest] = m.key.split('/'); keys.add(missionKey(proj, rest.join('/'))); }
    if (typeof m.project === 'string' && typeof m.id === 'string') keys.add(missionKey(m.project, m.id));
  }
  return keys;
}

// `hidden` = privateKeys(); private missions are dropped before the list is cut to 10.
function sanitize(history, hidden = new Set()) {
  if (!history || !Array.isArray(history.missions)) throw new Error('history.json has no missions list');
  const visible = history.missions.filter(m => !(m && typeof m === 'object' && hidden.has(missionKey(m.project, m.id))));
  return {
    generated_at: new Date().toISOString(),
    missions: visible.slice(0, 10).map((m, i) => {
      const at = `missions[${i}]`;
      if (m.closed_at && Number.isNaN(Date.parse(m.closed_at))) throw new Error(`${at}.closed_at is not a date`);
      return {
        id: text(m.id, 80, `${at}.id`), project: text(m.project, 80, `${at}.project`), name: text(m.name, 120, `${at}.name`),
        org: ORGS.includes(m.org) ? m.org : null, director: text(m.director, 60, `${at}.director`),
        input: count(m.input, `${at}.input`), output: count(m.output, `${at}.output`), total: count(m.total, `${at}.total`),
        cache_read: count(m.cache_read, `${at}.cache_read`), status: STATUSES.includes(m.status) ? m.status : null,
        closed_at: m.closed_at ? new Date(m.closed_at).toISOString() : null,
        runs: count(m.runs, `${at}.runs`), runs_missing: count(m.runs_missing, `${at}.runs_missing`),
      };
    }),
  };
}

async function main() {
  const source = path.join(telemetryDir, 'history.json');
  if (!fs.existsSync(source)) throw new Error('no history.json – run ras-telemetry collect + history first');
  const history = JSON.parse(fs.readFileSync(source, 'utf8'));
  let hidden = new Set();
  if (Array.isArray(history?.missions) && history.missions.length) {
    try { hidden = privateKeys(missionsFile); } catch (error) {
      console.warn(`publish-history: mission log unreadable (${String(error.message).split(/\r?\n/)[0].slice(0, 80)}) – publishing nothing`);
      return;
    }
  }
  const published = sanitize(history, hidden);
  const body = JSON.stringify(published, null, 2) + '\n';
  if (dryRun) { process.stdout.write(body); return; }
  if (!fs.existsSync(tokenFile)) throw new Error('no board token in ~/.ras/board-token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const api = `https://api.github.com/repos/${REPO}/contents/${FILE}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ras-board-publish' };
  const current = await fetch(`${api}?ref=${BRANCH}`, { headers });
  let sha;
  if (current.ok) {
    const file = await current.json();
    sha = file.sha;
    const old = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    if (JSON.stringify(old.missions) === JSON.stringify(published.missions)) { console.log('publish-history: unchanged'); return; }
  } else if (current.status !== 404) throw new Error(`GitHub GET ${current.status}`);
  const put = await fetch(api, { method: 'PUT', headers, body: JSON.stringify({
    message: `history: ${published.missions.length} missions`, branch: BRANCH, sha,
    content: Buffer.from(body, 'utf8').toString('base64') }) });
  if (!put.ok) throw new Error(`GitHub PUT ${put.status}`);
  console.log(`publish-history: ${published.missions.length} missions published`);
}

if (require.main === module) main().catch(error => { console.error('publish-history: ' + error.message); process.exit(1); });
// FORBIDDEN and text() are the guard every public board file shares (publish-missions.cjs reuses them).
module.exports = { sanitize, privateKeys, FORBIDDEN, text };
