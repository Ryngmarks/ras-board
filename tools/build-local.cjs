// Builds the LOCAL board: index.html + the mission history (and org.json) embedded, written outside every git repo.
// Usage: node tools/build-local.cjs [--out <dir>]      (default dir: %USERPROFILE%/.ras/board)
// Reads <RAS_TELEMETRY_DIR or %USERPROFILE%/.ras/telemetry>/history.json. Nothing here is ever pushed or published.
const fs = require("fs");
const os = require("os");
const path = require("path");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const home = os.homedir();
const telemetryDir = process.env.RAS_TELEMETRY_DIR || path.join(home, ".ras", "telemetry");
const outDir = path.resolve(arg("--out", path.join(home, ".ras", "board")));
const boardDir = path.join(__dirname, "..");

function insideGitWorkTree(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}
if (insideGitWorkTree(outDir)) {
  console.error(`build-local: refusing to write inside a git work tree: ${outDir}`);
  process.exit(1);
}

// Inside <script type="application/json"> only "</script" and "<!--" can break out; escaping every "<" covers both.
const embed = obj => JSON.stringify(obj).replace(/</g, "\\u003c");

let history = { generated_at: null, missions: [] };
const historyFile = path.join(telemetryDir, "history.json");
if (fs.existsSync(historyFile)) history = JSON.parse(fs.readFileSync(historyFile, "utf8"));
else console.warn(`build-local: ${historyFile} not found - embedding an empty history (run ras-telemetry history first)`);

const orgFile = path.join(boardDir, "org.json");
const org = fs.existsSync(orgFile) ? JSON.parse(fs.readFileSync(orgFile, "utf8")) : null;

let html = fs.readFileSync(path.join(boardDir, "index.html"), "utf8");
// Different script type than the code script, so tools/csp.cjs (first plain <script>) and the CSP hash stay valid.
// org is embedded too because a page opened from file:// cannot fetch org.json same-origin.
const blocks = `<script type="application/json" id="ras-history">${embed(history)}</script>\n` +
  (org ? `<script type="application/json" id="ras-org">${embed(org)}</script>\n` : "");
if (!html.includes("<script>")) throw new Error("index.html has no code script");
html = html.replace("<script>", () => blocks + "<script>");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "index.html"), html);
if (org) fs.copyFileSync(orgFile, path.join(outDir, "org.json"));
console.log(`build-local: ${history.missions?.length ?? 0} missions embedded -> ${path.join(outDir, "index.html")}`);
