#!/usr/bin/env node
// Serves the LOCAL RAS board (with mission token history) on this PC only – 127.0.0.1, never the network.
// Meant to be started from the T3 project script "RAS-tavla" so the owner sees it in T3's preview, also through
// T3 remote. On a page load the data is refreshed when it is older than REFRESH_MS:
//   ras-telemetry collect + history  ->  build-local.cjs  ->  ~/.ras/board/index.html  ->  publish-history.cjs
// Usage: node tools/serve-local.cjs [--port 5199]
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 5199);
const HOST = '127.0.0.1';
const REFRESH_MS = 2 * 60 * 1000;
const boardDir = path.join(os.homedir(), '.ras', 'board');
const boardRepo = path.resolve(__dirname, '..');
const rasHome = process.env.RAS_HOME || path.resolve(boardRepo, '..', 'ryngmark-agents');
const telemetry = path.join(rasHome, 'tools', 'ras-telemetry.mjs');

let lastRefresh = 0;
let lastError = '';

function refresh() {
  if (Date.now() - lastRefresh < REFRESH_MS) return;
  lastRefresh = Date.now();
  try {
    const run = (file, cmdArgs) => execFileSync(process.execPath, [file, ...cmdArgs], { stdio: 'pipe', timeout: 120000 });
    if (fs.existsSync(telemetry)) {
      run(telemetry, ['collect']);
      run(telemetry, ['history']);
    }
    run(path.join(boardRepo, 'tools', 'build-org.cjs'), []);
    run(path.join(boardRepo, 'tools', 'build-local.cjs'), []);
    // Owner decision 2026-10-31: the mission summaries (name, tokens, director, date) are public; publish when changed.
    try { run(path.join(boardRepo, 'tools', 'publish-history.cjs'), []); } catch (error) { console.error('publish failed: ' + String(error.stderr || error.message).split(/\r?\n/)[0]); }
    lastError = '';
  } catch (error) {
    // Keep serving the last good build; say what failed in the console only (never in the page).
    lastError = String(error.stderr || error.message).split(/\r?\n/)[0];
    console.error('refresh failed: ' + lastError);
  }
}

const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  const allowed = { '/': 'index.html', '/index.html': 'index.html', '/org.json': 'org.json',
    '/assets/ras-gaming.png': 'assets/ras-gaming.png', '/assets/ras-software.png': 'assets/ras-software.png' };
  const name = allowed[url.pathname];
  if (!name) { res.writeHead(404); return res.end('not found'); }
  if (name === 'index.html') refresh();
  const file = path.join(boardDir, name);
  if (!fs.existsSync(file)) { res.writeHead(503); return res.end('board not built yet'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(name)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
});

server.listen(port, HOST, () => {
  refresh();
  console.log('RAS board (local, with token history): http://localhost:' + port + '/');
});
