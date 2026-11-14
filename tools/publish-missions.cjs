#!/usr/bin/env node
// Publishes the short mission list to the public board (ras07, owner decisions #1, #5, #6, #10): per mission only project,
// id, name, phase and updated (an ISO time, nothing else) – plus, when the mission has them, its work orders (owner decision
// 2026-11-14): id, title, status and optionally role, started, done, after and result, each rebuilt from a whitelist. Missions with `public: false` (security audits) are never
// published; every finished mission stays in the list – there is no cap (review finding 3).
//
// Reads  <RAS_MISSIONS_FILE or <RAS_HOME or ../ryngmark-agents>/docs/missions.json>  (written by tools/ras-missions.mjs)
// Writes missions.json on branch `status` of Ryngmarks/ras-board through the GitHub API with the board-only token in
//        %USERPROFILE%/.ras/board-token (fine-grained: ras-board, Contents read/write) – only when the list changed.
// Every value is rebuilt from a whitelist and checked with the publish-history guard: anything that looks like a path,
// a key, an e-mail address or a URL stops the publish.
// Usage: node tools/publish-missions.cjs [--dry-run]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { text } = require('./publish-history.cjs');

const REPO = 'Ryngmarks/ras-board';
const BRANCH = 'status';
const FILE = 'missions.json';
const dryRun = process.argv.includes('--dry-run');
const rasHome = process.env.RAS_HOME || path.resolve(__dirname, '..', '..', 'ryngmark-agents');
const source = process.env.RAS_MISSIONS_FILE || path.join(rasHome, 'docs', 'missions.json');
const tokenFile = path.join(os.homedir(), '.ras', 'board-token');

const PHASES = ['analysis', 'plan', 'owner', 'build', 'review', 'done', 'paused'];
const ID = /^[a-z0-9][a-z0-9-]{2,40}$/;

const WO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/;
const ROLE = /^[a-z0-9-]{1,40}$/;
const WO_STATUS = ['done', 'working', 'owner', 'todo'];
const isoTime = (v, field) => {
  if (typeof v !== 'string' || v.length > 40 || !Number.isFinite(Date.parse(v))) throw new Error(`${field} is not a date`);
  return new Date(v).toISOString();
};
// Work orders in plan order. Nothing is copied as it stands: ids and roles must match their pattern, times are rebuilt from
// the parsed date and every text goes through the same guard as the mission name. A mission without the field gets none.
function workOrders(list, at) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length > 60) throw new Error(`${at}.work_orders is not a list of at most 60 work orders`);
  return list.map((w, j) => {
    const f = `${at}.work_orders[${j}]`;
    if (!w || typeof w !== 'object') throw new Error(`${f} is not a work order`);
    if (typeof w.id !== 'string' || !WO_ID.test(w.id)) throw new Error(`${f}.id is not a work order id`);
    if (!WO_STATUS.includes(w.status)) throw new Error(`${f}.status is not a known status`);
    const title = text(w.title, 80, `${f}.title`);
    if (!title) throw new Error(`${f} has no title`);
    const out = { id: w.id, title, status: w.status };
    if (w.role !== undefined && w.role !== null) {
      if (typeof w.role !== 'string' || !ROLE.test(w.role)) throw new Error(`${f}.role is not a role id`);
      out.role = w.role;
    }
    for (const k of ['started', 'done']) if (w[k] !== undefined && w[k] !== null) out[k] = isoTime(w[k], `${f}.${k}`);
    if (w.after !== undefined && w.after !== null) {
      if (typeof w.after !== 'string' || !WO_ID.test(w.after)) throw new Error(`${f}.after is not a work order id`);
      out.after = w.after;
    }
    const result = text(w.result, 120, `${f}.result`);
    if (result) out.result = result;
    return out;
  });
}

function sanitize(doc) {
  if (!doc || doc.version !== 1 || !Array.isArray(doc.missions)) throw new Error('missions.json is not a version 1 mission list');
  const missions = doc.missions
    // fail closed: only an explicit public: true is published (security audits are public: false)
    .filter(m => m && typeof m === 'object' && m.public === true)
    .map((m, i) => {
      const at = `missions[${i}]`;
      if (typeof m.id !== 'string' || !ID.test(m.id)) throw new Error(`${at}.id is not a mission id`);
      if (!PHASES.includes(m.phase)) throw new Error(`${at}.phase is not a known phase`);
      const project = text(m.project, 60, `${at}.project`);
      const name = text(m.title, 80, `${at}.title`);
      if (!project || !name) throw new Error(`${at} has no project or title`);
      // owner #10: a time only – rebuilt from the parsed date, so no text can ride along
      if (typeof m.updated !== 'string' || m.updated.length > 40 || !Number.isFinite(Date.parse(m.updated))) throw new Error(`${at}.updated is not a date`);
      const wos = workOrders(m.work_orders, at);
      return { project, id: m.id, name, phase: m.phase, updated: new Date(m.updated).toISOString(), ...(wos ? { work_orders: wos } : {}) };
    })
    .sort((a, b) => a.project.localeCompare(b.project) || a.id.localeCompare(b.id));
  return { generated_at: new Date().toISOString(), missions };
}

async function main() {
  if (!fs.existsSync(source)) throw new Error('no docs/missions.json – run ras-missions.mjs in RAS first');
  const published = sanitize(JSON.parse(fs.readFileSync(source, 'utf8')));
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
    if (JSON.stringify(old.missions) === JSON.stringify(published.missions)) { console.log('publish-missions: unchanged'); return; }
  } else if (current.status !== 404) throw new Error(`GitHub GET ${current.status}`);
  const put = await fetch(api, { method: 'PUT', headers, body: JSON.stringify({
    message: `missions: ${published.missions.length} missions`, branch: BRANCH, sha,
    content: Buffer.from(body, 'utf8').toString('base64') }) });
  if (!put.ok) throw new Error(`GitHub PUT ${put.status}`);
  console.log(`publish-missions: ${published.missions.length} missions published`);
}

if (require.main === module) main().catch(error => { console.error('publish-missions: ' + error.message); process.exit(1); });
module.exports = { sanitize };
