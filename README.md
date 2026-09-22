# IntroSync

Plex intro and credits skip markers from community databases, so Plex doesn't have to
audio-fingerprint every file. Fingerprinting is expensive here because the library lives on the
InfiniDysk (NNTP) and Decypharr (RD) streaming mounts.

- **Sources** (per segment type, the first one that has it wins)
  1. [TheIntroDB](https://theintrodb.org): community-verified, TMDB-keyed, and cut-aware (it
     takes the file length).
  2. **Chapter names** Plex already extracted from each file ("Intro", "Opening Credits",
     "End Credits", "Recap", "Previously On" …). Free: no lookups, no file reads. Off until
     `CHAPTERS_ENABLED=true`. Movies take credits only, because a film's opening-credits chapter
     often runs over story.
  3. [introdb.app](https://introdb.app): IMDb-keyed and unverified. Fills whatever the others lack.
  4. **Fingerprint detection** (`FP_ENABLED`, off by default): IntroSync's own detection on episodes none of the
     above covers, from a few seconds of each file matched against a season sibling whose intro is known. See
     "Fingerprint detection" below.
- **Provenance:** every marker IntroSync writes records its source in the ledger. The `sources`
  stage (and the status page) reports every marker in Plex as `plex` (Plex's own detection),
  `tidb`, `chapters`, `introdb`, `fingerprint`, or `mixed` (when merged segments came from different sources).
- **Status (2026-09-18):** running with `APPLY_ENABLED=true`.
  - Trial (The Last of Us, 22 markers) confirmed by the user in a client.
  - First full run: 770 markers. A later run added 165 (4 of IntroSync's own rewritten).
  - Chapters: off, pending the recovery session's audit.

## Layout
| path | what |
|---|---|
| `app/tidb-sync.mjs` | the tool (all stages); **canonical copy** |
| `app/main.mjs` | container entrypoint: daily scheduler + status page on :8897 + fingerprint worker |
| `app/fingerprint.mjs`, `app/detector.mjs` | fingerprint source (method 4): orchestration + store / detection engine |
| `data/fingerprints.db` | fingerprint store: saved references, sibling calibrations, detections, bytes read per day |
| `data/tidb.db` | ledger: items, lookups (TIDB rows `t:`/`m:`, introdb.app rows `idb:`), applied (+source), submissions, runs |
| `data/plan-*.json`, `data/undo-*.jsonl` | plans; one undo log per apply |
| `config/api_key` | TheIntroDB API key (99:100, 600). Never copy it into the claude workspace. |
| `backups/` | full Plex DB backup before each apply (~520 MB each; `KEEP_BACKUPS` kept, currently 7) |
| `make-icon.mjs` → `icon.png` | template icon |

- Build: `docker build -t local/introsync:latest /mnt/cache/appdata/introsync`
- Template: `/boot/config/plugins/dockerMan/templates-user/my-IntroSync.xml`
- Run a stage by hand:
  `docker exec IntroSync node /app/tidb-sync.mjs status|sources|plan|selftest|...`
- Don't run a second copy from the host against `data/tidb.db`. Files it creates would be
  root-owned, and the container (99:100) couldn't write the ledger's WAL.

## Settings added 2026-09-18
- **Login**: `AUTH_ENABLED` / `AUTH_USERNAME` / `AUTH_PASSWORD` (masked) give HTTP Basic auth on
  everything except `/health`, which Docker's healthcheck uses. If it's enabled without
  credentials, every page is refused rather than left open.
- **`RUN_ON_START` is false**: a recreate must not trigger writes. Use **Run now** instead.
- **`KEEP_BACKUPS`**: full Plex DB backups kept (the user chose 7).
- **Lookup record**: the ledger table `usage(day, source, requests)` counts every API request per
  UTC day as it's made (so killed runs still count). The status page shows today, the last
  7 days, and the total. It's a record only, not a cap.

## PAL speed-up guard (PAL_GUARD, default true), added 2026-09-18
- **The problem:** some releases are PAL speed-ups (25/50 fps) of 23.976/24 fps content. They play
  4.3% fast (and higher), so TheIntroDB/introdb.app timestamps, which were measured on the
  normal-speed version, drift on them: ~5 s at 2:00, ~2 min at 50:00. Found by the detection
  experiment (a True Blood S3E1 WEBRip in a Blu-ray season).
- **Detection:**
  - An episode at 25/50 fps counts as sped up when at least half its season is 23.976/24 fps.
  - A 25/50 fps movie counts when its file is 2.5–6% shorter than its listed runtime.
  - All-PAL seasons (native UK/EU productions, or US shows released entirely at PAL speed)
    can't be told apart, so they're left alone.
- **Effect on those files:** community sources are ignored and only the file's own chapters count.
  IntroSync's own TheIntroDB/introdb.app markers are replaced by chapters, or retracted
  (action `retract`) when there are none. Plex's own markers are never touched.
- **First dry run:** 506 files flagged; 5 retractions (True Blood S7 ×4, Dexter: Original Sin S1E1).

## Changing code
Edits to `app/` only take effect after
`docker build -t local/introsync:latest /mnt/cache/appdata/introsync` and a recreate. Afterwards,
check that `docker exec IntroSync md5sum /app/*.mjs` matches disk. **Only one session owns
these files at a time.**

## Daily run (RUN_AT, default 07:30, after Plex's Butler window ends at 07:00)
The stages run in order: `inventory`, `fetch --source tidb`, `fetch --source introdb`, `plan`.
When `APPLY_ENABLED=true`, `selftest` and `apply --yes --live` follow. The chain stops at the
first failing stage, so a failed selftest (Plex format drift) never applies. The status page's
**Run now** button runs the same chain.

## How markers are written (verified)
- **Plex has no API for intro/credits markers** (Plex staff, forums.plex.tv/t/938786), so apply
  writes what MarkerEditorForPlex writes:
  - `taggings` rows (tag_type 12), `index` ordered by start time across all marker types
  - the `pv:intros` / `pv:credits` JSON in `media_parts.extra_data`
- Plex's `url` field encodes everything except `[A-Za-z0-9_-]`. MarkerEditor's
  `encodeURIComponent` doesn't, but ours does: `selftest` shows 20,000/20,000 rows byte-identical.
- **Durations come from `media_items.duration`, the real file length.** `metadata_items.duration`
  is the agent's rounded runtime and is off by more than 30 s for half this library.
- Plex wipes custom markers when it re-analyzes a season. The next run sees the missing markers
  in `applied` and re-applies them (`reapply`).
- Policy `fill` (default) never replaces markers Plex detected itself. `prefer-tidb` does.

**apply safety:**
- It needs `--yes`.
- It must **positively** confirm Plex's state, either a visible process or `PLEX_URL/identity`
  answering. If it can't, it refuses. `--plex-stopped` is the explicit override.
- While Plex runs, it needs `--live`, and it refuses unless active sessions == 0.
- It refuses a Plex DB path under `/mnt/user`.
- It backs up the DB first and writes in 200-item transactions.
- It re-checks each item against the plan inside the transaction.
- It keeps an undo log: `undo <log> --yes --live` restores the exact prior bytes.

Tested on a synthetic DB built from Plex's real schema:
- add
- keep Plex's markers and commercial markers, with re-index
- re-plan finds nothing to do
- simulated wipe → reapply
- prefer-tidb replace
- credits + preview merge
- two-source merge with provenance
- undo → byte-identical; integrity_check ok

In the container, the ledger, selftest and `sources` all work, and so do the Plex reachability
and session checks.

## Source mapping
| Plex marker | TheIntroDB | introdb.app |
|---|---|---|
| intro | `intro` | `intro` (only if TIDB has none) |
| intro (extra, `MAP_RECAP`) | `recap` | `recap` (only if TIDB has none) |
| credits | `credits` | `outro` (only if TIDB has none) |
| credits (`MAP_PREVIEW`) | `preview` | n/a |
| not mapped | n/a | `post_credits`: a scene to *watch* |

A credits segment reaching within 2 s of the end of the file becomes the **final** marker (Up Next).

## API facts
**TheIntroDB** (`https://theintrodb.org/openapi.yaml`)
- `GET /v3/media?tmdb_id&season&episode&duration_ms`, Bearer key optional.
- Quota: **1000/day** with a key (500/day per IP without). Rate limit: 30 per 10 s.
- The maintainers OK'd bulk submission, at under 40 req / 10 s, on Discord.
- `POST /v3/submit` adds a submission, `PUT /v3/submissions/{id}` edits your own pending one,
  and `GET /v3/submissions?limit&offset` lists yours.

**introdb.app** (`https://api.introdb.app/openapi.json`)
- `GET /segments?imdb_id&season&episode` or `?imdb_id&is_movie=true`. No key needed to read.
- It answers **200 with all-null segments when it has nothing** (the tool normalizes that to 404).
- Each segment carries `confidence` and `submission_count`, usually 1.0 / 1.
- Rows go live **without verification**.
- No published rate limit ("fair usage"). **Terms forbid "scraping or bulk downloading the
  entire database"**: paced at 1 req/s, 500/day.
- There's no cut matching, so the "start after EOF" guard is the only protection there.

## Measured (2026-09-17)
| | TheIntroDB | introdb.app |
|---|---|---|
| shows with data on S1E1 | 35% (14/40) | 28% (11/40) |
| random deeper episodes | 56% for shows TIDB has | 15% (3/20) |
| movies | 5% (1/20) | 0% (0/20) |

- introdb.app covered about 1 in 4 of the shows TheIntroDB lacked.
- Agreement on intros: 8 of 13 within 3 s, 2 at 7–8 s, 3 badly off (25 s, 30 s, 11.6 min).
  That's why it's fallback-only.

## Known risks
- **Numbering:** TIDB uses TMDB season/episode numbers; introdb.app most likely IMDb's. A show
  whose Plex ordering differs could get another episode's markers. Anime and absolute-order
  shows are most at risk.
- Shows or movies with more than one TMDB id in Plex (e.g. Hard Knocks) are skipped.
- A PMS update can change the extra_data format. That's why `selftest` gates every apply
  (DUMB auto-updates Plex).

## Web UI (2026-09-18)
Pages: **Status** (lookups: last request, rolling 24 h, TheIntroDB limit warning; run history), **Library**
(show → season → episode markers with source badges; filters), **Plan & apply**, **Runs & undo**, **Submit**, **Settings**.
- **Settings live in `/data/settings.json`** (mode 600), edited on the Settings page. The template's old run variables
  seeded it once and were then removed from the template; the file wins over the environment. Login (`AUTH_*`),
  port, folders and `TZ` stay in the template (a settings page can't safely change its own login). The Plex address
  moved to the Settings page (text setting, seeded from the template's `PLEX_URL`).
- **API keys** (`tidb_api_key`, `introdb_api_key`) are write-only files in `/data/secrets/` (dir 700, files 600),
  passed to the tool as file paths only; never rendered, never logged. With no key set here, TheIntroDB falls back
  to `/config/api_key`.
- **Security (login optional, per the user):** with login off, changes are allowed from the local network (private
  source IPs, plus Tailscale's 100.64.0.0/10 by the user's choice; forwarding headers must list only such IPs) and outside connections are read-only. `AUTH_ENABLED=true`
  requires login from outside; `AUTH_LOCAL=true` extends it to the LAN. Every change ALWAYS needs a per-process CSRF
  token and a same-origin request. CSP, no framing.
- **One action at a time:** the daily chain and every UI action share one lock.
- **Undo only the newest apply.** `undo` doesn't check for later changes, so undoing an older run after newer ones
  would overwrite them. After an undo the next run re-adds those markers unless the settings change.
- **Run history** groups the ledger's stage rows into one row per run (a run ends at its apply). Markers by source come
  from the apply's plan stats, or — when the run wrote only part of the plan (`--match`/`--limit`) — from the ledger rows
  it actually wrote. Triggers are recorded in `/data/sessions.jsonl` from this version on.
- **Lookups:** `request_log` (per-request timestamps, 3 days) and `api_state` (the quota TheIntroDB itself reports).
  TheIntroDB allows 500/day without a key, 1000 with one; the Status page warns when the rolling 24 h count reaches it.

## Submitting (`submit`, `submit-introdb`)
**Only markers Plex detected itself** are submitted. Any marker matching an `applied` row was written by IntroSync
and is excluded: that prevents echoing TheIntroDB's data back, copying introdb.app's data into TheIntroDB (barred by
its terms), copying TheIntroDB's data into introdb.app, and sending unreviewed chapter timings.
(Before 2026-09-18 `submit` did NOT exclude them; all 419 earlier submissions predate IntroSync's first write.)
- `submit`: intros → TheIntroDB, with the real file length; paced 25/10 s.
- `submit-introdb`: intros and credits (as `outro`) → introdb.app per https://api.introdb.app/openapi.json
  (`X-API-Key`, series IMDb id + season/episode, `start_sec`/`end_sec`); movies credits only; PAL-speed files skipped
  (no file length in their entries); paced 1/s; 401 stops, 429 (1 per segment/episode/5 min) is recorded and skipped.
  Tracked in `submissions` as segment `idb:intro` / `idb:outro`.
- Both are dry runs without `--yes`; `--json` lists candidates (the Submit page computes these in the background).
- Not built yet: a review queue for chapter-derived timings.
- Fingerprint detections are never submitted: once applied they're IntroSync-written markers, excluded like the rest.

## Fingerprint detection (`FP_ENABLED`, off by default), added 2026-09-18
IntroSync's own detection ("method 4"), for episodes none of the other sources covers. Instead of Plex's whole-file
scan, it reads a few seconds of each episode and matches them against a **season sibling whose intro is already known**
(an intro marker Plex detected itself, or TheIntroDB). History and measurements:
`/mnt/user/claude/dumb-populate/tidb/experiment/FINDINGS-v1..v4.md`.

- **Intros:** the sibling's intro (±5 s) is the reference fingerprint. The target is read at the season's known intro
  positions (one 16 s read, checked as two halves that must agree), then 8 s snippets stepping outward, each confirmed
  by a second one. Short intros (< 24 s) use one continuous window. PAL speed-ups get a sped-up reference.
  Premieres search further and measure the end from the audio. No seed in the season: the nearest season of the show.
- **Credits:** single frames near the end ("black + text"), block edges binary-searched, then calibrated against
  siblings with known credits. Written **only** when the 3 nearest same-release, non-premiere siblings all calibrate
  within 5 s of each other AND the result sits within 10 s of the season's usual position before the end. An early
  credits marker would skip story and bring up Up Next too soon, so seasons that don't behave consistently are left alone.
- **Never:** seeds from introdb.app, chapters or our own detections; submissions of detections anywhere (once applied
  they're IntroSync-written markers, excluded like the rest); a miss turned into "no intro".
- **Reads** go through each backend's own WebDAV in small growing byte ranges (never through the mounts, which read
  ahead): InfiniDysk (Usenet; downloads ~3× the bytes read, it fetches whole articles) and decypharr (Real-Debrid;
  ~1×). The container needs `/mnt/debrid` (read-only, slave) to follow Plex's symlinks, and small loopback TCP buffers
  (`--sysctl net.ipv4.tcp_rmem="4096 32768 65536" --sysctl net.ipv4.tcp_wmem="4096 32768 65536"`) so ffmpeg can't pull
  far ahead through the local proxy.
- **Settings page:** on/off, credits on/off, InfiniDysk WebDAV address + user, decypharr address, and the InfiniDysk
  WebDAV password as a write-only secret (DUMB's `infinidysk.webdav_password`; the user enters it, it's not copied).
- **Worker:** `main.mjs` runs `fingerprint.mjs detect` in rounds of up to an hour, back to back, beside the
  one-at-a-time lock (it only reads Plex and the ledger). It runs while people stream (the user's call: only writes
  to Plex's database wait for that, and those happen in `apply`), and when there's nothing left looks again every
  6 hours. No download limit (Usenet is unlimited, per the user); what it read is recorded per day (`reads`) and
  shown on the Status page.
- **Order:** most recently watched shows first.
- **Store** `/data/fingerprints.db` (keyed to the FILE: path + size, so a replaced/upgraded file is simply redone):
  `refs` (reference fingerprints, ~6 KB each: each read once, ever), `sib_credits` (sibling calibrations),
  `detections` (every outcome; misses retried after 30 days, read errors after 1 day, or on a new detector version),
  `reads`, `validation`, `state`.
- **Plan:** detections are the lowest-ranked source (`fingerprint`), used only if made on the file Plex has now.
  Switching the source off stops using them (`--no-fingerprint`); markers already written stay until undone.
- **By hand:** `docker exec IntroSync node /app/fingerprint.mjs status` · `selftest` ·
  `detect --validate 15` (blind test on episodes WITH known timings, compared, nothing written to Plex) ·
  `detect --dry-run --limit 5` (no detections stored).

## Commercial markers from comskip chapters (`COMMERCIALS_ENABLED`, default on), added 2026-09-19
User request, relayed by the recovery session: Sports recordings get "Skip Commercial" markers from the chapters the
DVR trimmer leaves in them (Unmanic comchap: "Commercial 1..N" alternating with "Chapter N"). This keeps Unraid's
comskip step worth its CPU.
- **Scope:** the libraries in `COMMERCIALS_SECTIONS` (names or ids, default `Sports` = section 4). These items have
  no TMDB id, so they're found straight from Plex, not the ledger. One-file items only.
- **Mapping:** each "Commercial N" chapter becomes a `commercial` marker. Dropped: blips under 5 s and anything over
  20 min, and a break at the very start or end (the trimmed pre/post padding, e.g. "Commercial 1" 0:00–0:52).
  Back-to-back breaks merge.
- **Written the way Plex's own DVR comskip writes them** (verified against item 85350): `taggings` text
  `commercial`, `extra_data` NULL, indexed with the item's other markers; `pv:commercials` (marker array version
  -1) in `media_parts.extra_data`.
- **Plex's own commercial markers are never replaced.** Source `chapters` in the provenance. Same backup, undo and
  session check as every apply; never submitted anywhere.
- **Tested on a copy of the Plex DB:**
  - apply wrote 22 markers on "Buffalo Bills vs Detroit Lions";
  - the encoder selftest reproduced all 64,740 rows byte for byte;
  - a re-plan found it up to date;
  - undo restored it byte-identical.
  First live plan: 3 recordings, 53 breaks, 30 s–7.8 min (median 2.2 min).

## Submitting: credits + auto-submit (2026-09-21)
- **TheIntroDB now gets credits too.** `submit` used to send only intros, though their API has accepted
  `intro`/`recap`/`credits`/`preview` all along. Credits: start required, end omitted when the marker runs to the
  end of the file (their convention for "to the end"), 5 s–30 min, with `video_duration_ms` when the versions agree.
  PAL-speed files are only sent when that duration can be included. `--segment intro|credits` limits a run.
  First batch of 5 credits accepted 2026-09-21. Candidates then: 2,469 credits + 2 intros.
- **introdb.app caps submissions at 100 per hour per account** (429 `{"error":"Rate limit exceeded","limit":100,
  "reset_at":…}`), which is NOT the documented per-episode limit. A manual run on 2026-09-21 sent 98 and then burned
  201 requests on refusals. Now three 429s in a row stop the run and log their reset time.
- **Auto-submit in the daily chain** (after apply, last): `SUBMIT_TIDB_AUTO` + `SUBMIT_TIDB_LIMIT` (default 400;
  their limit is 1,000/day) and `SUBMIT_INTRODB_AUTO` + `SUBMIT_INTRODB_LIMIT` (default 100 = their hourly cap).
  A step is only added when that service's key is set, since the tool exits non-zero without one and would fail the
  chain. Both were switched on for this install on 2026-09-21.
- Unchanged: only markers **Plex detected itself** are ever submitted. Nothing IntroSync wrote goes out, including
  fingerprint detections.
