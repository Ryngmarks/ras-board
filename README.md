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
