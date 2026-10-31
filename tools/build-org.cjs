// Builds org.json (public: names, statuses, notes, registry ids only) from the RAS repo's org.yaml.
// Usage: node tools/build-org.cjs [--ras <RAS repo dir>] [--out <org.json>]
// Exits 1 (naming the id) when a role points at an agent/profile that is not in registry.yaml or is "active" without one.
const fs = require("fs");
const path = require("path");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const RAS = arg("--ras", process.env.RAS_HOME || path.resolve(__dirname, "..", "..", "ryngmark-agents"));
const OUT = arg("--out", path.join(__dirname, "..", "org.json"));

// --- tiny YAML subset: nested maps, block lists (scalars or maps), one-line {a: b} maps, quoted strings, # comments ---
function scalar(s) {
  s = s.trim();
  if (/^"(.*)"$/.test(s)) return s.slice(1, -1).replace(/\\"/g, '"');
  if (/^'(.*)'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (s === "null" || s === "~" || s === "") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}
function splitTop(s) { // split on commas outside quotes
  const parts = []; let cur = "", q = "";
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = ""; }
    else if (c === '"' || c === "'") { q = c; cur += c; }
    else if (c === ",") { parts.push(cur); cur = ""; }
    else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
function keyValue(s) { // "key: value" -> [key, rawValue] or null
  const m = s.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
  return m ? [m[1], m[2] ?? ""] : null;
}
function flowMap(s) {
  const o = {};
  for (const part of splitTop(s.slice(1, -1))) {
    const kv = keyValue(part.trim());
    if (!kv) throw new Error(`bad inline map: ${s}`);
    o[kv[0]] = scalar(kv[1]);
  }
  return o;
}
function value(raw) { return raw.startsWith("{") && raw.endsWith("}") ? flowMap(raw) : scalar(raw); }

function stripComment(line) { // "#" starts a comment at line start or after whitespace, outside quotes
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = ""; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function parseYaml(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const noComment = stripComment(raw);
    if (!noComment.trim()) continue;
    lines.push({ indent: noComment.match(/^ */)[0].length, text: noComment.trim() });
  }
  let pos = 0;
  function block(indent) {
    if (pos >= lines.length || lines[pos].indent < indent) return null;
    return lines[pos].text.startsWith("- ") ? list(lines[pos].indent) : map(lines[pos].indent);
  }
  function map(indent, seed) {
    const o = seed || {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith("- ")) {
      const kv = keyValue(lines[pos].text);
      if (!kv) throw new Error(`org.yaml: cannot parse "${lines[pos].text}"`);
      pos++;
      o[kv[0]] = kv[1] === "" ? block(indent + 1) : value(kv[1]);
    }
    return o;
  }
  function list(indent) {
    const a = [];
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("- ")) {
      const rest = lines[pos].text.slice(2).trim();
      const kv = rest.startsWith("{") ? null : keyValue(rest);
      if (kv) { // "- key: value" starts a map whose other keys sit at indent + 2
        lines[pos] = { indent: indent + 2, text: rest };
        a.push(map(indent + 2));
      } else { pos++; a.push(value(rest)); }
    }
    return a;
  }
  return map(lines.length ? lines[0].indent : 0);
}

// --- registry ids ---
function registryIds(text) {
  const ids = { agent: new Set(), profile: new Set() };
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const sec = line.match(/^(agents|profiles):\s*$/);
    if (sec) { section = sec[1] === "agents" ? "agent" : "profile"; continue; }
    const id = line.match(/^\s+- id:\s*(\S+)/);
    if (id && section) ids[section].add(id[1]);
  }
  return ids;
}

function fail(msg) { console.error("build-org: " + msg); process.exit(1); }

const org = parseYaml(fs.readFileSync(path.join(RAS, "org.yaml"), "utf8"));
const reg = registryIds(fs.readFileSync(path.join(RAS, "registry.yaml"), "utf8"));
const where = [];

function role(r, label) {
  if (!r || typeof r.name !== "string") fail(`${label}: role without name`);
  const kind = r.agent ? "agent" : r.profile ? "profile" : null;
  const id = r.agent || r.profile || null;
  if (id && !reg[kind].has(id)) fail(`${label}: ${kind} "${id}" (role "${r.name}") is not in registry.yaml`);
  if (r.status !== "active" && r.status !== "planned") fail(`${label}: role "${r.name}" needs status active|planned`);
  if (r.status === "active" && !id) fail(`${label}: role "${r.name}" is active but has no agent/profile in registry.yaml`);
  where.push(`${label}/${r.name}`);
  return { name: r.name, kind, id, status: r.status, note: r.note || "" };
}

if (!org.owner || !org.branches || !org.core) fail("org.yaml needs owner, branches and core");
const out = {
  owner: { name: org.owner.name, title: org.owner.title },
  branches: {},
  core: { name: org.core.name, roles: (org.core.roles || []).map(r => role(r, "core")) },
};
for (const [key, b] of Object.entries(org.branches)) {
  const d = b.director || {};
  if (d.status !== "active" && d.status !== "planned") fail(`${key}: director needs status active|planned`);
  out.branches[key] = {
    name: b.name,
    director: { name: d.name, status: d.status, today: d.today || "" },
    projects: b.projects || [],
    roles: (b.roles || []).map(r => role(r, key)),
  };
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`build-org: ${where.length} roles checked against registry.yaml -> ${path.basename(OUT)}`);
