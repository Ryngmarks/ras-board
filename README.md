# ras-board

Live team board for the Ryngmark Agent System (RAS): which role works on which project right now.

Page: https://ryngmarks.github.io/ras-board/

- `index.html` – the board (static, no build). It reads `status.json` through the GitHub API every 2 minutes (60 unauthenticated calls/h per IP are shared by all open tabs) and falls back to raw.githubusercontent.com (no limit, cached up to 5 min).
- `status.json` (`projects` = connected projects, `entries` = who works where) on branch **`status`** (so updates do not rebuild Pages) – written only by `tools/ras-status.ps1` in the RAS repo. Keep it short: role, project, state,
  a few words of note. Nothing secret – this repo is public.

## Organisation and latest missions
- **Organisation** – owner → RAS Gaming / RAS Software (director + roles) and the shared RAS Core row; planned roles are dashed
  and marked "planerad". Source of truth is `org.yaml` in the RAS repo; `node tools/build-org.cjs` checks every `agent:`/`profile:`
  against `registry.yaml` (exit 1 naming the id otherwise) and writes `org.json` (names, statuses, notes, registry ids – public is fine).
  The page fetches `org.json` same-origin and passes it through `cleanOrg()`.
- **Senaste uppdrag** – the 10 latest closed missions with input (and cache-read share), output, total and closing date.
  The data exists **only in the local build**; the public page shows a note instead.
- **Local build:** `node tools/build-local.cjs [--out <dir>]` reads `%USERPROFILE%/.ras/telemetry/history.json` (env `RAS_TELEMETRY_DIR`)
  and writes `%USERPROFILE%/.ras/board/index.html` with the history embedded as `<script type="application/json" id="ras-history">`
  (`<` escaped as `<`) plus `org.json` (also embedded, because a page opened from file:// cannot fetch it). It refuses to write inside a git work tree.
  The code script is unchanged, so the CSP hash stays valid.
- **Privacy:** token numbers, mission names and paths are never committed or published without the owner's decision; `ras-board`
  is public. Never copy the local `index.html` into this repo.

Format:
```json
{ "updated": "<ISO time>", "projects": ["Coach Helper"],
  "entries": [ { "role": "research", "project": "Coach Helper", "state": "working", "note": "Veo export", "since": "<ISO time>" } ] }
```
`state` is `working` or `waiting`. A role with no entry is free.

## Security
- `status.json` is untrusted: `clean()` keeps only known fields and states, everything is escaped before rendering,
  and owner alerts come only from `for: "owner"`.
- A Content-Security-Policy allows only the page's own inline script (by hash) and fetches to GitHub. **After editing
  the `<script>`, run `node tools/csp.cjs index.html`** or the page will not run.

## Local board in T3 (with token history)
`tools/serve-local.cjs` serves the local board on **127.0.0.1:5199 only** (never the network) and refreshes the data
(`ras-telemetry collect` + `history`, `build-org`, `build-local`) when a page load finds it older than 2 minutes.
Start it with the **RAS-tavla** button in the T3 project "RAS" – it opens in T3's preview, also from T3 remote.
Only `/`, `/index.html`, `/library.html`, `/org.json` and the two logos are served.

## Spelbibliotek (game library, local only – m09)
`library.html` is a sibling page shown as a tab ("Tavlan | Spelbibliotek"): weapon families → variants → abilities with
game text, rig action from the code scan, notes, known issues and media placeholders. Abilities in no weapon list are
hidden until "Visa förmågor utan vapen" is ticked.
- **Data never in git.** `build-local.cjs` embeds `<RAS_LIBRARY_DIR or %USERPROFILE%/.ras/library>/mossvale.json`
  (written by `tools/library/export.mjs` in the Mossvale repo) as `<script type="application/json" id="ras-library">`;
  no file → the page says "Ingen export ännu". The committed page has no data and on Pages says it is local only.
- **One loader** (`loadLibrary`): the embedded block, else same-origin `library.json` (a future private host).
  `cleanLibrary()` is the only code that knows the data shape (contract: `docs/ras/m09-weapon-library/wo/library-contract.md`
  in Mossvale); unknown fields are dropped and everything is escaped. Media/links become URLs only when
  `<meta name="ras-media-base">` is set; repo-relative paths only.
- After editing its script: `node tools/csp.cjs library.html` (its CSP allows `connect-src 'self'` only).
- Tests: `node --test tools/*.test.cjs` (fixture: `tools/fixtures/mossvale.json`, invented data).

## Public mission history (owner decision 2026-10-31)
`tools/publish-history.cjs` writes `history.json` to the `status` branch: per mission only id, project, name, organisation,
director, input/output/total/cache tokens, run counts, status and close date. Values are rebuilt from a whitelist and
anything that looks like a path, URL, e-mail address or key stops the publish (`node --test tools/publish-history.test.cjs`).
No keys, logs, paths or prompts are ever published. `serve-local.cjs` publishes when the history changes.
