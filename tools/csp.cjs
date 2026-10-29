// Recomputes the Content-Security-Policy hash for the page's single inline <script>.
// Run after every edit of the script: node tools/csp.cjs index.html
// Browsers hash the script text after normalising line endings to LF, so we do the same.
const fs = require("fs");
const crypto = require("crypto");

const file = process.argv[2];
let html = fs.readFileSync(file, "utf8");
html = html.replace(/\r?\n<meta http-equiv="Content-Security-Policy"[^\n]*/, "");

const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error("no inline <script> found");
const hash = crypto.createHash("sha256").update(match[1].replace(/\r\n?/g, "\n"), "utf8").digest("base64");

const csp = [
  "default-src 'none'",
  `script-src 'sha256-${hash}'`,
  "style-src 'unsafe-inline'",
  "connect-src 'self' https://api.github.com https://raw.githubusercontent.com",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
fs.writeFileSync(file, html);
console.log("CSP script hash:", hash);
