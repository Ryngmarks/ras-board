# ras-board

Live team board for the Ryngmark Agent System (RAS): which role works on which project right now.

Page: https://ryngmarks.github.io/ras-board/

- `index.html` – the board (static, no build). It reads `status.json` through the GitHub API every minute.
- `status.json` – written only by `tools/ras-status.ps1` in the RAS repo. Keep it short: role, project, state,
  a few words of note. Nothing secret – this repo is public.

Format:
```json
{ "updated": "<ISO time>",
  "entries": [ { "role": "research", "project": "Coach Helper", "state": "working", "note": "Veo export", "since": "<ISO time>" } ] }
```
`state` is `working` or `waiting`. A role with no entry is free.
