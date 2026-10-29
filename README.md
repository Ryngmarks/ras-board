# ras-board

Live team board for the Ryngmark Agent System (RAS): which role works on which project right now.

Page: https://ryngmarks.github.io/ras-board/

- `index.html` – the board (static, no build). It reads `status.json` through the GitHub API every 2 minutes (60 unauthenticated calls/h per IP are shared by all open tabs) and falls back to raw.githubusercontent.com (no limit, cached up to 5 min).
- `status.json` (`projects` = connected projects, `entries` = who works where) on branch **`status`** (so updates do not rebuild Pages) – written only by `tools/ras-status.ps1` in the RAS repo. Keep it short: role, project, state,
  a few words of note. Nothing secret – this repo is public.

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
