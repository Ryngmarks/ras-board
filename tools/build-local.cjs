// Builds the LOCAL board: index.html + the mission history (and org.json) embedded, missions.html + the RAS mission log
// (with token totals) embedded, and library.html + the game library export embedded, written outside every git repo.
// Usage: node tools/build-local.cjs [--out <dir>]      (default dir: %USERPROFILE%/.ras/board)
// Reads <RAS_TELEMETRY_DIR or %USERPROFILE%/.ras/telemetry>/history.json (+ missions.json for tokens by key),
//       <RAS_LIBRARY_DIR or %USERPROFILE%/.ras/library>/mossvale.json and
//       <RAS_MISSIONS_FILE or <RAS_HOME or ../ryngmark-agents>/docs/missions.json>. Nothing here is ever pushed or published.
const fs = require("fs");
const os = require("os");
const path = require("path");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const home = os.homedir();
const telemetryDir = process.env.RAS_TELEMETRY_DIR || path.join(home, ".ras", "telemetry");
const libraryDir = process.env.RAS_LIBRARY_DIR || path.join(home, ".ras", "library");
const outDir = path.resolve(arg("--out", path.join(home, ".ras", "board")));
const boardDir = path.join(__dirname, "..");
const rasHome = process.env.RAS_HOME || path.resolve(boardDir, "..", "ryngmark-agents");
const missionsFile = process.env.RAS_MISSIONS_FILE || path.join(rasHome, "docs", "missions.json");

// The real location of a path that may not exist yet: the nearest existing ancestor resolved through every junction and
// symlink (fs.realpathSync.native), plus the parts below it. A dangling link counts as existing and is refused.
function realLocation(p) {
  const rest = [];
  for (let d = path.resolve(p); ; d = path.dirname(d)) {
    let linkStat = null;
    try { linkStat = fs.lstatSync(d); } catch {}
    if (linkStat) {
      if (!fs.existsSync(d)) throw new Error(`dangling link: ${d}`);
      return path.join(fs.realpathSync.native(d), ...rest.reverse());
    }
    if (path.dirname(d) === d) return path.resolve(p);
    rest.push(path.basename(d));
  }
}
function insideGitWorkTree(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}
// ras07 review finding 2: a junction or link (on --out, an ancestor, or an output file/folder) must not redirect the
// private pages into a git tree, so the check runs on the real path of the folder and of every file before it is written.
function guard(target) {
  let real;
  try { real = realLocation(target); } catch (e) { real = null; console.error(`build-local: ${e.message}`); }
  if (!real || insideGitWorkTree(real) || insideGitWorkTree(path.resolve(target))) {
    console.error(`build-local: refusing to write inside a git work tree: ${target}${real && real !== path.resolve(target) ? ` (real path ${real})` : ""}`);
    process.exit(1);
  }
  return target;
}
guard(outDir);

// Inside <script type="application/json"> only "</script" and "<!--" can break out; escaping every "<" covers both.
const embed = obj => JSON.stringify(obj).replace(/</g, "\\u003c");

// Different script type than the code script, so tools/csp.cjs (first plain <script>) and the CSP hash stay valid.
// Write via a temp file + rename: the rename replaces the directory entry, so a hardlink (or any link) at the target is
// never written through into another tree (ras07 fix check F2).
function safeWrite(target, data) {
  const dest = guard(target);
  const tmp = guard(`${dest}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data, { flag: "wx" });
  fs.renameSync(tmp, dest);
}

function writePage(name, blocks) {
  let html = fs.readFileSync(path.join(boardDir, name), "utf8");
  if (!html.includes("<script>")) throw new Error(`${name} has no code script`);
  html = html.replace("<script>", () => blocks + "<script>");
  safeWrite(path.join(outDir, name), html);
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

// Mission log (ras07): null = no file yet; broken = an unknown shape so the page says "could not be read". Tokens are not
// stored in the log: they are joined here from the telemetry by key (open missions included, local only).
let missions = null;
if (fs.existsSync(missionsFile)) {
  try {
    missions = JSON.parse(fs.readFileSync(missionsFile, "utf8"));
    const tokens = new Map();
    const tokenFile = path.join(telemetryDir, "missions.json");
    if (fs.existsSync(tokenFile)) {
      try { for (const t of JSON.parse(fs.readFileSync(tokenFile, "utf8")).missions || []) if (t && typeof t.key === "string") tokens.set(t.key, t.total); }
      catch (e) { console.warn(`build-local: ${tokenFile} is not valid JSON (${e.message}) - missions without tokens`); }
    }
    if (Array.isArray(missions?.missions)) for (const m of missions.missions) if (m && typeof m === "object") m.tokens = tokens.get(m.key) ?? null;
  } catch (e) { console.warn(`build-local: ${missionsFile} is not valid JSON (${e.message})`); missions = { version: null }; }
} else console.warn(`build-local: ${missionsFile} not found - the Uppdrag page will say "Ingen uppdragslogg ännu"`);

fs.mkdirSync(guard(outDir), { recursive: true });
// org is embedded too because a page opened from file:// cannot fetch org.json same-origin.
const orgBlock = org ? `<script type="application/json" id="ras-org">${embed(org)}</script>\n` : "";
const missionsBlock = `<script type="application/json" id="ras-missions">${embed(missions)}</script>\n`;
writePage("index.html", `<script type="application/json" id="ras-history">${embed(history)}</script>\n` + orgBlock + missionsBlock);
writePage("missions.html", missionsBlock + orgBlock);
writePage("library.html", `<script type="application/json" id="ras-library">${embed(library)}</script>\n`);
if (org) safeWrite(path.join(outDir, "org.json"), fs.readFileSync(orgFile));
// Branch logos (owner, 2026-10-31).
fs.mkdirSync(guard(path.join(outDir, "assets")), { recursive: true });
for (const logo of ["ras-gaming.png", "ras-software.png"]) {
  const from = path.join(boardDir, "assets", logo);
  if (fs.existsSync(from)) safeWrite(path.join(outDir, "assets", logo), fs.readFileSync(from));
}
console.log(`build-local: ${history.missions?.length ?? 0} missions embedded -> ${path.join(outDir, "index.html")}`);
console.log(`build-local: ${missions ? (missions.missions?.length ?? 0) + " missions in the log" : "no mission log"} embedded -> ${path.join(outDir, "missions.html")}`);
console.log(`build-local: library ${library ? (library.families?.length ?? 0) + " families" : "missing"} embedded -> ${path.join(outDir, "library.html")}`);
