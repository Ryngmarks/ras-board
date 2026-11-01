# ras-board

Live team board for the Ryngmark Agent System (RAS): which role works on which project right now.

Page: https://ryngmarks.github.io/ras-board/

Three pages share one top bar (Översikt · Uppdrag · Spelbibliotek) and one light look (owner look 2026-11-01, ras07);
the shared CSS block is marked "keep identical" in each page.

- `index.html` – Översikt (static, no build): Väntar på Johan, Pågår nu, Tokens, the organisation tree, Projekt and Senaste aktivitet. It reads `status.json` through the GitHub API every 2 minutes (60 unauthenticated calls/h per IP are shared by all open tabs) and falls back to raw.githubusercontent.com (no limit, cached up to 5 min).
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
  (`<` escaped as `<`) plus `org.json` (also embedded, because a page opened from file:// cannot fetch it). It refuses to write inside a git work tree – checked on
  the real path (junctions and symlinks resolved with `fs.realpathSync.native`) of `--out` and of every output file and folder.
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
`tools/serve-local.cjs` serves the local board on **127.0.0.1:5199 only** by default (home network: see below) and
refreshes the data (`ras-telemetry collect` + `history`, `build-org`, `build-local`) when a page load finds it older than
2 minutes. Start it with the **RAS-tavla** button in the T3 project "RAS" – it opens in T3's preview, also from T3 remote.
Only `/`, `/index.html`, `/missions.html`, `/library.html`, `/org.json` and the two logos are served.
On the public Pages site (no embedded data) every "local only" note links to the same page on the local board
(`http://johansdator:5199/…`, the host name, never an IP or a key; plain links, nothing is fetched) and the Spelbibliotek
tab points at the local server. Locally served pages keep relative links.

## Hemnätverket (local board from another computer at home – ras07 #11, audit fixes WO-03b)
Opt-in: `node tools/serve-local.cjs --lan` (or env `RAS_BOARD_LAN=1`). Without it nothing changes: 127.0.0.1 only.
- **Every request, both modes:** the `Host` header must name this server (`127.0.0.1`, `localhost` or `[::1]` with the
  port; in LAN mode also the computer name `johansdator` and its current LAN IPv4) – anything else gets 421 and no data,
  which stops DNS rebinding. Other sites may link to the board but not embed or fetch it (`Sec-Fetch-Site` cross/same-site
  subresources → 403), and only a page load (navigation) refreshes the data.
- **What LAN mode does:** listens on all IPv4 addresses and answers only addresses in this computer's **own connected
  subnets** (read from the network adapters every 30 s; virtual, VPN and hotspot adapters are left out). Everything else
  gets 403. Every other device needs the **key** once; this computer (127.0.0.1) never does.
- **Start checks:** `--lan` refuses to start (Swedish message) unless the key file is readable by your Windows user only and
  the firewall rule "RAS board 5199 (block Public)" from `lan-setup.ps1` exists.
- **The key:** 256 random bits in `%USERPROFILE%/.ras/board-key` (env `RAS_BOARD_KEY_FILE`), never in git and **never in a
  URL**. `--show-key` prints the address and the key in groups of four to type; `--rotate-key` makes a new key and logs
  every device out.
- **First visit on the other computer:** open `http://johansdator:5199/`, type the key in the "Nyckel krävs" form (spaces
  and case do not matter). The form only works from the board's own page (same-origin `Origin` check). The server checks
  the key in constant time and gives that browser its **own random session** (cookie `ras_board_5199`, `HttpOnly;
  SameSite=Strict`). Only a hash of it is stored, in `%USERPROFILE%/.ras/board-sessions.json`; it expires after 180 days
  on the server. `--revoke-sessions` logs every device out. 10 wrong keys per minute from one address → 429.
- **Setup, once, as administrator:** `powershell -ExecutionPolicy Bypass -File toolslan-setup.ps1`. If the Wi-Fi is
  *Public* it explains what *Private* means (Windows then trusts that network: file and printer sharing, discovery and other
  apps with Private rules open up too) and asks before changing it; the change is remembered. It adds an Allow rule
  "RAS board 5199" (TCP 5199, Private profile and local subnet only, this `node.exe`) and a Block rule
  "RAS board 5199 (block Public)" (TCP 5199, Public profile, any program – Block wins over the broad
  "Node.js JavaScript Runtime" Allow rules that exist for Public). Then it prints the key. `-Autostart` also starts the LAN
  server hidden at logon (log: `%USERPROFILE%/.ras/board-lan.log`). `-Remove` removes both rules and that task, stops a
  running `serve-local.cjs --lan`, and offers to set a network it made Private back to Public. Running it again is safe.
- **Risk in plain words:** a device on the home Wi-Fi reaches the port but sees only the key page without the key; with the
  key (or a stolen session cookie) it sees everything the local board shows – token counts, mission notes, the game library.
  Use it only on your own network and run `--rotate-key` if a device is lost or the key leaks. On a Public network the
  Block rule keeps the port closed, and the server itself answers only its own subnet.
- **KNOWN ISSUE – plain HTTP:** the traffic is not encrypted. Someone who knows the Wi-Fi password and listens on the home
  network, or redirects `johansdator` to another machine (name spoofing), can read pages and lift a session cookie. Cookies
  are not tied to a port, so other servers reached as `johansdator:<port>` also receive `ras_board_5199`. Not fixed (no TLS);
  the owner decides whether this is accepted.
- On this computer `http://johansdator:5199/` resolves to the Wi-Fi address, not 127.0.0.1: in LAN mode it asks for the
  key once here too; in default mode use `http://127.0.0.1:5199/` (or the RAS-tavla button).
- Tests: `node --test tools/serve-local.test.cjs` (calls the request handler directly; no port, no refresh, no publish; the
  firewall and `icacls` checks are mocked).

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
Every mission whose `<project>/<id>` is `public: false` in RAS `docs/missions.json` (env `RAS_MISSIONS_FILE` or `RAS_HOME`,
default `../ryngmark-agents`) is dropped before the list is cut to 10 (ras07 review). Fail closed: if the history has
missions and that file cannot be read or is not a version 1 list, nothing is published (one warning line, exit 0).

## Uppdrag (mission log – ras07)
`missions.html` lists every RAS mission in every project by phase: Väntar på dig → Analys/Plan → Utförande/Granskning →
Pausad → Klar (collapsed), with project filter chips. Source: `docs/missions.json` in the RAS repo, written only by
`node tools/ras-missions.mjs`.
- **Local:** `build-local.cjs` embeds the file (env `RAS_MISSIONS_FILE` or `RAS_HOME`, default `../ryngmark-agents`) as
  `<script type="application/json" id="ras-missions">` in `missions.html` and `index.html`, with `tokens` joined by key from
  the telemetry `missions.json`. Rows open to show the log and the brief/STATUS paths (as text).
- **Public:** `tools/publish-missions.cjs` writes `missions.json` to the `status` branch: per mission only project, id, name,
  phase and `updated` (an ISO time rebuilt from the parsed date – owner decision #10), rebuilt from a whitelist with the
  `publish-history` guard; only `public: true` missions (security audits are `public: false`), every mission kept – no cap –,
  PUT only when changed, `--dry-run` prints it. The page fetches it and shows project · name · phase · time only.
  Översikt's public "Senaste aktivitet" lists the 7 newest of these (project · name → phase · relative time, no notes); who
  works now is shown in the organisation tree and the Projekt cards. Locally it shows the mission log entries (with notes)
  and role events.
- The page cleaners never cut the list: every published mission is shown (owner #6).
- One loader (`loadMissions`) and one cleaner per shape (`cleanMissions` local, `cleanPublicMissions` public); the copies in
  `index.html` and `missions.html` are tested to stay identical. Tests: `node --test tools/*.test.cjs` (fixture
  `tools/fixtures/missions.json`, invented data). After editing a page script: `node tools/csp.cjs <page>`.
