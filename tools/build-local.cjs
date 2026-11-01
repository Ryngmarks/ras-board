// Builds the LOCAL board: index.html + the mission history (and org.json) embedded, and library.html + the game library
// export embedded, written outside every git repo.
// Usage: node tools/build-local.cjs [--out <dir>]      (default dir: %USERPROFILE%/.ras/board)
// Reads <RAS_TELEMETRY_DIR or %USERPROFILE%/.ras/telemetry>/history.json and
//       <RAS_LIBRARY_DIR or %USERPROFILE%/.ras/library>/mossvale.json. Nothing here is ever pushed or published.
const fs = require("fs");
const os = require("os");
const path = require("path");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const home = os.homedir();
const telemetryDir = process.env.RAS_TELEMETRY_DIR || path.join(home, ".ras", "telemetry");
const libraryDir = process.env.RAS_LIBRARY_DIR || path.join(home, ".ras", "library");
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

// Different script type than the code script, so tools/csp.cjs (first plain <script>) and the CSP hash stay valid.
function writePage(name, blocks) {
  let html = fs.readFileSync(path.join(boardDir, name), "utf8");
  if (!html.includes("<script>")) throw new Error(`${name} has no code script`);
  html = html.replace("<script>", () => blocks + "<script>");
  fs.writeFileSync(path.join(outDir, name), html);
}

let history = { generated_at: null, missions: [] };
const historyFile = path.join(telemetryDir, "history.json");
if (fs.existsSync(historyFile)) history = JSON.parse(fs.readFileSync(historyFile, "utf8"));
else console.warn(`build-local: ${historyFile} not found - embedding an empty history (run ras-telemetry history first)`);

const orgFile = path.join(boardDir, "org.json");
const org = fs.existsSync(orgFile) ? JSON.parse(fs.readFileSync(orgFile, "utf8")) : null;

// Game library (m09): null = no export yet (the page says how to make one). A broken file is embedded as an unknown
// shape so the page says "could not be read" instead of the board build failing.
let library = null;
const libraryFile = path.join(libraryDir, "mossvale.json");
if (fs.existsSync(libraryFile)) {
  try { library = JSON.parse(fs.readFileSync(libraryFile, "utf8")); }
  catch (e) { console.warn(`build-local: ${libraryFile} is not valid JSON (${e.message})`); library = { version: null }; }
} else console.warn(`build-local: ${libraryFile} not found - the library page will say "Ingen export ännu"`);

fs.mkdirSync(outDir, { recursive: true });
// org is embedded too because a page opened from file:// cannot fetch org.json same-origin.
writePage("index.html", `<script type="application/json" id="ras-history">${embed(history)}</script>\n` +
  (org ? `<script type="application/json" id="ras-org">${embed(org)}</script>\n` : ""));
writePage("library.html", `<script type="application/json" id="ras-library">${embed(library)}</script>\n`);
if (org) fs.copyFileSync(orgFile, path.join(outDir, "org.json"));
// Branch logos (owner, 2026-10-31).
fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });
for (const logo of ["ras-gaming.png", "ras-software.png"]) {
  const from = path.join(boardDir, "assets", logo);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outDir, "assets", logo));
}
console.log(`build-local: ${history.missions?.length ?? 0} missions embedded -> ${path.join(outDir, "index.html")}`);
console.log(`build-local: library ${library ? (library.families?.length ?? 0) + " families" : "missing"} embedded -> ${path.join(outDir, "library.html")}`);
