#!/usr/bin/env node
// tidb-sync — pull intro / recap / credits / preview segments from TheIntroDB (theintrodb.org)
// and turn them into Plex intro + credits markers, so Plex doesn't have to fingerprint every
// file on the usenet/RD mounts itself.
//
// Sources, per segment type, first match wins: TheIntroDB (TMDB-keyed, community-verified), the file's own
// named chapters (already in Plex's DB, free), introdb.app (IMDb-keyed, unverified). Provenance of every
// marker we write is kept in the ledger; `sources` reports plex / tidb / chapters / introdb per marker.
//
// Stages (see README.md):
//   inventory   read Plex DB (read-only)            -> ledger.items
//   fetch       API only (no Plex access) -> ledger.lookups; --source tidb|introdb (quota aware)
//   plan        read-only diff ledger vs Plex        -> data/plan-*.json + summary
//   selftest    read-only: prove our extra_data encoder reproduces Plex's own bytes
//   status      ledger summary;  sources   marker provenance in Plex (read-only)
//   apply       *** WRITES the Plex DB *** (needs --yes; Plex stopped, or --live)
//   undo <f>    *** WRITES the Plex DB *** reverts one apply run from its undo log
//
// Plex has no API for intro/credits markers (only bookmarks), so apply writes the same rows
// MarkerEditorForPlex writes: `taggings` (tag_type 12) + the pv:intros / pv:credits JSON inside
// media_parts.extra_data. Plex wipes these whenever it re-analyzes an item/season; the ledger's
// `applied` table lets the next run notice that and re-apply.

import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLEX_ROOT = '/mnt/cache/appdata/DUMB/data/plex/Plex Media Server';
const CFG = {
    plexDb: process.env.PLEX_DB || `${PLEX_ROOT}/Plug-in Support/Databases/com.plexapp.plugins.library.db`,
    plexPrefs: process.env.PLEX_PREFS || `${PLEX_ROOT}/Preferences.xml`,
    plexUrl: process.env.PLEX_URL || 'http://192.168.0.100:32400',
    dataDir: process.env.TIDB_DATA_DIR || path.join(HERE, 'data'),   // plans, undo logs (and the ledger by default)
    ledger: process.env.TIDB_LEDGER || path.join(process.env.TIDB_DATA_DIR || path.join(HERE, 'data'), 'tidb.db'),
    // Optional TheIntroDB API key (raises GET /media from 500/day per IP to 1000/day per account).
    // Deliberately outside the claude workspace — never put the key in this directory.
    keyFile: process.env.TIDB_API_KEY_FILE || '/mnt/cache/appdata/tidb-sync/api_key',
    backupDir: process.env.TIDB_BACKUP_DIR || '/mnt/cache/appdata/tidb-sync/backups',
    // fingerprint.mjs's store: detections from the "fingerprint" source (method 4), read-only here
    fpDb: process.env.FP_DB || path.join(process.env.TIDB_DATA_DIR || path.join(HERE, 'data'), 'fingerprints.db'),
    api: 'https://api.theintrodb.org/v3',
};

const DAY = 86400;
const TTL = {
    hit: 60 * DAY,        // re-read accepted data occasionally; averages get refined
    missWarm: 14 * DAY,   // episode of a show that has *some* TheIntroDB data
    missCold: 30 * DAY,   // show with no data on its probe episodes
    missMovie: 30 * DAY,
    error: 1 * DAY,
    bad: 180 * DAY,       // 400-class other than 404/429: our params are wrong, don't hammer
};
const MIN_SEG_MS = 3000;
const FINAL_SLACK_MS = 2000;   // credits ending this close to EOF count as "final" (drives Up Next)
const PACE_MS = 400;           // 25 req / 10 s: under /media's 30 and /submit's 40 (confirmed with TIDB on Discord)
const MATCH_TOLERANCE_MS = 500;

const EXTRA = {
    intro: '{"pv:version":"5","url":"pv%3Aversion=5"}',
    credits: '{"pv:version":"4","url":"pv%3Aversion=4"}',
    creditsFinal: '{"pv:final":"1","pv:version":"4","url":"pv%3Afinal=1&pv%3Aversion=4"}',
};

// ---------- cli ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
function die(msg) { console.error(`tidb-sync: ${msg}`); process.exit(1); }

const planOpts = () => ({
    policy: opt('policy', 'fill'),          // fill | prefer-tidb
    mapRecap: !flag('no-recap'),            // recap  -> extra intro marker ("Skip Intro" over the recap)
    mapPreview: !flag('no-preview'),        // preview -> credits marker (skipping it lands on Up Next)
    useChapters: !flag('no-chapters'),      // the file's own named chapters (Intro / Credits / Recap ...)
    useIntrodb: !flag('no-introdb'),        // introdb.app fills segment types the others lack
    useFingerprint: !flag('no-fingerprint'), // our own audio/video detection (fingerprint.mjs), last resort
    useCommercials: !flag('no-commercials'), // "Commercial N" chapters (comskip -> comchap) -> commercial markers
    commercialSections: opt('commercial-sections', 'Sports'),   // library sections (names or ids, comma-separated)
    palGuard: !flag('no-pal-guard'),        // ignore community timestamps on PAL speed-up files (see buildPlan)
});

// ---------- databases ----------
function openLedger() {
    fs.mkdirSync(path.dirname(CFG.ledger), { recursive: true });
    const db = new DatabaseSync(CFG.ledger);
    db.exec(`
        PRAGMA busy_timeout=15000;
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS items(
            mid INTEGER PRIMARY KEY, kind TEXT NOT NULL, tmdb INTEGER NOT NULL, season INTEGER, episode INTEGER,
            duration_ms INTEGER, show_title TEXT, title TEXT, lkey TEXT NOT NULL, seen_at INTEGER);
        CREATE INDEX IF NOT EXISTS items_lkey ON items(lkey);
        CREATE TABLE IF NOT EXISTS lookups(
            lkey TEXT PRIMARY KEY, status INTEGER, body TEXT, fetched_at INTEGER, next_at INTEGER, tries INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS applied(
            mid INTEGER, text TEXT, start_ms INTEGER, end_ms INTEGER, final INTEGER, applied_at INTEGER,
            PRIMARY KEY(mid, text, start_ms));
        CREATE TABLE IF NOT EXISTS runs(
            id INTEGER PRIMARY KEY AUTOINCREMENT, cmd TEXT, started_at INTEGER, finished_at INTEGER, summary TEXT);
        CREATE TABLE IF NOT EXISTS submissions(
            mid INTEGER, segment TEXT, start_ms INTEGER, end_ms INTEGER, http INTEGER, status TEXT, response TEXT,
            submitted_at INTEGER, PRIMARY KEY(mid, segment));`);
    // introdb.app is keyed on IMDb ids: items.ikey is its lookup key (lookups rows prefixed "idb:").
    // applied.source / submissions.origin record provenance (NULL applied.source = pre-introdb run = tidb).
    for (const [table, col] of [['items', 'imdb TEXT'], ['items', 'ikey TEXT'], ['applied', 'source TEXT'],
                                ['submissions', "origin TEXT DEFAULT 'plex'"]]) {
        try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    db.exec('CREATE INDEX IF NOT EXISTS items_ikey ON items(ikey)');
    // Every API request, counted per UTC day and source as it's made (so killed runs still count).
    db.exec('CREATE TABLE IF NOT EXISTS usage(day TEXT, source TEXT, requests INTEGER, PRIMARY KEY(day, source))');
    // Per-request timestamps (pruned after 3 days) for a ROLLING 24-hour count and "last request" in the UI:
    // `usage` is per UTC day, which can't answer "how many in the last 24 h". api_state keeps the latest quota
    // the service itself reported (TheIntroDB's x-usagelimit-remaining), which also counts other clients.
    db.exec(`CREATE TABLE IF NOT EXISTS request_log(ts INTEGER NOT NULL, source TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS request_log_src_ts ON request_log(source, ts);
             CREATE TABLE IF NOT EXISTS api_state(source TEXT PRIMARY KEY, remaining INTEGER, usage_reset INTEGER, at INTEGER);`);
    return db;
}

function openPlex(readOnly = true) {
    // SQLite locking over Unraid's /mnt/user FUSE layer is not trustworthy; always use the pool path.
    if (CFG.plexDb.startsWith('/mnt/user/')) die('use the /mnt/cache/... path for the Plex DB, never /mnt/user/...');
    if (!fs.existsSync(CFG.plexDb)) die(`Plex DB not found: ${CFG.plexDb}`);
    const db = new DatabaseSync(CFG.plexDb, { readOnly });
    db.exec('PRAGMA busy_timeout=30000');
    return db;
}

function markerTagId(plex) {
    const r = plex.prepare('SELECT id FROM tags WHERE tag_type=12 ORDER BY id LIMIT 1').get();
    if (!r) die('no marker tag (tag_type=12) in the Plex DB; let Plex create one marker first');
    return r.id;
}

function recordRun(L, name, started, summary) {
    L.prepare('INSERT INTO runs(cmd, started_at, finished_at, summary) VALUES (?,?,?,?)')
        .run(name, started, now(), JSON.stringify(summary));
}

const lkeyOf = (r) => r.kind === 'movie' ? `m:${r.tmdb}` : `t:${r.tmdb}:${r.season}:${r.episode}`;
const ikeyOf = (r) => !/^tt\d{7,9}$/.test(r.imdb || '') ? null
    : r.kind === 'movie' ? `idb:m:${r.imdb}` : `idb:t:${r.imdb}:${r.season}:${r.episode}`;
const imdbOf = (idExpr) => `(SELECT substr(t.tag, 8) FROM taggings x JOIN tags t ON t.id = x.tag_id
    WHERE x.metadata_item_id = ${idExpr} AND t.tag_type = 314 AND t.tag LIKE 'imdb://%' LIMIT 1)`;

// metadata_items.duration is the agent's rounded runtime (e.g. 47:00); the file's real length
// lives in media_items. Off by >30 s for half this library, >3 min for ~3.9k items.
const fileDur = (idExpr) => `(SELECT max(duration) FROM media_items WHERE metadata_item_id = ${idExpr})`;

const isPalFps = (f) => Math.abs((f ?? 0) - 25) < 0.05 || Math.abs((f ?? 0) - 50) < 0.05;

// A show/movie Plex has tagged with more than one TMDB id is ambiguous (e.g. Hard Knocks has two):
// skip it rather than guess, both for lookups and for submissions.
const singleTmdb = (idExpr) => `(SELECT count(*) FROM taggings x JOIN tags t ON t.id = x.tag_id
    WHERE x.metadata_item_id = ${idExpr} AND t.tag_type = 314 AND t.tag LIKE 'tmdb://%') = 1`;

// ---------- inventory ----------
function inventory() {
    const t = now();
    const plex = openPlex(true);
    const guid = `JOIN taggings tg ON tg.metadata_item_id = %ID%
                  JOIN tags g ON g.id = tg.tag_id AND g.tag_type = 314 AND g.tag LIKE 'tmdb://%'`;
    const eps = plex.prepare(`
        SELECT e.id mid, 'ep' kind, CAST(substr(g.tag, 8) AS INTEGER) tmdb, se."index" season, e."index" episode,
               ${fileDur('e.id')} duration_ms, sh.title show_title, e.title title, ${imdbOf('sh.id')} imdb
        FROM metadata_items e
        JOIN metadata_items se ON se.id = e.parent_id
        JOIN metadata_items sh ON sh.id = se.parent_id
        ${guid.replace('%ID%', 'sh.id')}
        WHERE e.metadata_type = 4 AND e.deleted_at IS NULL AND e."index" >= 1 AND ${singleTmdb('sh.id')}
          AND se."index" BETWEEN 1 AND 999   -- year-numbered seasons (e.g. 1977) are rejected by TIDB`).all();
    const movies = plex.prepare(`
        SELECT m.id mid, 'movie' kind, CAST(substr(g.tag, 8) AS INTEGER) tmdb, NULL season, NULL episode,
               ${fileDur('m.id')} duration_ms, NULL show_title, m.title title, ${imdbOf('m.id')} imdb
        FROM metadata_items m
        ${guid.replace('%ID%', 'm.id')}
        WHERE m.metadata_type = 1 AND m.deleted_at IS NULL AND ${singleTmdb('m.id')}`).all();
    plex.close();

    const L = openLedger();
    const up = L.prepare(`
        INSERT INTO items(mid, kind, tmdb, season, episode, duration_ms, show_title, title, lkey, imdb, ikey, seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(mid) DO UPDATE SET kind=excluded.kind, tmdb=excluded.tmdb, season=excluded.season,
            episode=excluded.episode, duration_ms=excluded.duration_ms, show_title=excluded.show_title,
            title=excluded.title, lkey=excluded.lkey, imdb=excluded.imdb, ikey=excluded.ikey, seen_at=excluded.seen_at`);
    let n = 0;
    L.exec('BEGIN');
    for (const r of [...eps, ...movies]) {
        if (!(r.tmdb > 0)) continue;
        up.run(r.mid, r.kind, r.tmdb, r.season, r.episode, r.duration_ms, r.show_title, r.title, lkeyOf(r),
               r.imdb, ikeyOf(r), t);
        n++;
    }
    const gone = L.prepare('DELETE FROM items WHERE seen_at < ?').run(t).changes;
    L.exec('COMMIT');
    const summary = { episodes: eps.length, movies: movies.length, upserted: n, removed: Number(gone) };
    recordRun(L, 'inventory', t, summary);
    log('inventory', summary);
}

// ---------- fetch ----------
function readKey() {
    try { return fs.readFileSync(CFG.keyFile, 'utf8').trim() || null; } catch { return null; }
}

// Order work so the daily quota goes where hits are likely:
//   probes of never-seen shows (first ep + first ep of latest season), interleaved with
//   unfetched episodes of shows that already have data; then movies (low hit rate); then refreshes.
function buildQueue(L, t, keyCol) {
    const items = L.prepare(`SELECT ${keyCol} lkey, kind, tmdb, imdb, season, episode, max(duration_ms) duration_ms,
                                    min(coalesce(show_title, title)) label
                             FROM items WHERE ${keyCol} IS NOT NULL GROUP BY ${keyCol}`).all();
    const lk = new Map(L.prepare('SELECT lkey, status, next_at FROM lookups').all().map(r => [r.lkey, r]));
    const fresh = (k) => !lk.has(k);
    const due = (k) => lk.has(k) && lk.get(k).next_at <= t;
    const shows = new Map();
    const probeNew = [], warmNew = [], movieNew = [], refresh = [];
    for (const it of items) {
        if (it.kind === 'movie') {
            if (fresh(it.lkey)) movieNew.push(it); else if (due(it.lkey)) refresh.push(it);
            continue;
        }
        if (!shows.has(it.tmdb)) shows.set(it.tmdb, []);
        shows.get(it.tmdb).push(it);
    }
    for (const eps of shows.values()) {
        eps.sort((a, b) => a.season - b.season || a.episode - b.episode);
        const last = eps[eps.length - 1].season;
        const probes = new Set([eps[0], eps.find(e => e.season === last)]);
        const hits = eps.some(e => lk.get(e.lkey)?.status === 200);
        const state = hits ? 'warm' : [...probes].every(p => lk.has(p.lkey)) ? 'cold' : 'new';
        for (const e of eps) {
            e.state = state;
            const isProbe = probes.has(e);
            if (state === 'new' && isProbe && fresh(e.lkey)) probeNew.push(e);
            else if (state === 'warm' && fresh(e.lkey)) warmNew.push(e);
            else if (due(e.lkey) && (state === 'warm' || isProbe)) refresh.push(e);
        }
    }
    refresh.sort((a, b) => lk.get(a.lkey).next_at - lk.get(b.lkey).next_at);
    const mixed = [];
    for (let i = 0; i < Math.max(probeNew.length, warmNew.length); i++) {
        if (i < probeNew.length) mixed.push(probeNew[i]);
        if (i < warmNew.length) mixed.push(warmNew[i]);
    }
    return { queue: [...mixed, ...movieNew, ...refresh],
             counts: { probeNew: probeNew.length, warmNew: warmNew.length, movieNew: movieNew.length, refresh: refresh.length } };
}

async function tidbGet(q, key) {
    const p = new URLSearchParams({ tmdb_id: String(q.tmdb) });
    if (q.kind === 'ep') { p.set('season', String(q.season)); p.set('episode', String(q.episode)); }
    if (q.duration_ms > 0) p.set('duration_ms', String(q.duration_ms));
    const headers = { Accept: 'application/json', 'User-Agent': 'tidb-plex-sync/0.1' };
    if (key) headers.Authorization = `Bearer ${key}`;
    try {
        const r = await fetch(`${CFG.api}/media?${p}`, { headers, signal: AbortSignal.timeout(20000) });
        const num = (h) => { const v = r.headers.get(h); return v == null || v === '' ? null : Number(v); };
        return { status: r.status, body: await r.text(), remaining: num('x-usagelimit-remaining'),
                 usageReset: num('x-usagelimit-reset'), rateReset: num('x-ratelimit-reset') };
    } catch (e) {
        return { status: 0, body: String(e?.message || e) };
    }
}

// introdb.app (a separate project from TheIntroDB): IMDb-keyed, no key needed to read, no published
// rate limit ("fair usage"); its terms prohibit bulk-downloading the database, so keep the pace slow.
// It answers 200 with all-null segments when it has nothing: normalise that to 404.
async function introdbGet(q) {
    const p = new URLSearchParams({ imdb_id: q.imdb });
    if (q.kind === 'movie') p.set('is_movie', 'true');
    else { p.set('season', String(q.season)); p.set('episode', String(q.episode)); }
    try {
        const r = await fetch(`https://api.introdb.app/segments?${p}`, {
            headers: { Accept: 'application/json', 'User-Agent': 'tidb-plex-sync/0.1' }, signal: AbortSignal.timeout(20000) });
        const body = await r.text();
        if (r.status === 200) {
            const b = JSON.parse(body);
            if (!b.intro && !b.recap && !b.outro) return { status: 404, body: '' };
        }
        return { status: r.status, body };
    } catch (e) {
        return { status: 0, body: String(e?.message || e) };
    }
}

const SOURCES = {
    tidb: { keyCol: 'lkey', paceMs: PACE_MS, budget: 450, get: tidbGet },
    introdb: { keyCol: 'ikey', paceMs: 1000, budget: 500, get: introdbGet },
};

async function fetchCmd() {
    const t0 = now();
    const L = openLedger();
    if (!L.prepare('SELECT 1 FROM items LIMIT 1').get()) die('ledger is empty; run `inventory` first');
    const source = opt('source', 'tidb');
    const src = SOURCES[source] || die(`unknown --source ${source} (tidb | introdb)`);
    const budget = Number(opt('budget', src.budget));
    const reserve = Number(opt('reserve', 10));
    const key = source === 'tidb' ? readKey() : null;
    const { queue, counts } = buildQueue(L, t0, src.keyCol);
    log(`fetch ${source}: queue ${queue.length}`, counts, `budget ${budget}`, source === 'tidb' ? (key ? '(api key)' : '(anonymous)') : '');

    const prev = L.prepare('SELECT status FROM lookups WHERE lkey=?');
    const put = L.prepare(`
        INSERT INTO lookups(lkey, status, body, fetched_at, next_at, tries) VALUES (?,?,?,?,?,1)
        ON CONFLICT(lkey) DO UPDATE SET status=excluded.status, body=excluded.body, fetched_at=excluded.fetched_at,
            next_at=excluded.next_at, tries=lookups.tries+1`);
    const bump = L.prepare('UPDATE lookups SET next_at=?, tries=tries+1 WHERE lkey=?');
    const tally = { requests: 0, hit: 0, miss: 0, error: 0, remaining: null, stopped: 'queue-empty' };
    const countUsage = L.prepare(`INSERT INTO usage(day, source, requests) VALUES (date('now'), ?, 1)
                                  ON CONFLICT(day, source) DO UPDATE SET requests = requests + 1`);
    const logReq = L.prepare('INSERT INTO request_log(ts, source) VALUES (?, ?)');
    const putState = L.prepare(`INSERT INTO api_state(source, remaining, usage_reset, at) VALUES (?,?,?,?)
                                ON CONFLICT(source) DO UPDATE SET remaining=excluded.remaining,
                                    usage_reset=excluded.usage_reset, at=excluded.at`);
    L.prepare('DELETE FROM request_log WHERE ts < ?').run(now() - 3 * DAY);

    for (const q of queue) {
        if (tally.requests >= budget) { tally.stopped = 'budget'; break; }
        let r, attempts = 0;
        do {
            r = await src.get(q, key);
            tally.requests++;
            countUsage.run(source);
            logReq.run(now(), source);
            if (r.status !== 429 || r.remaining === 0) break;
            await sleep(((r.rateReset ?? 10) + 1) * 1000);   // short-window rate limit: wait it out
        } while (++attempts < 3);
        if (r.remaining != null) { tally.remaining = r.remaining; putState.run(source, r.remaining, r.usageReset ?? null, now()); }
        if (r.status === 429) { tally.stopped = 'usage-limit'; break; }

        const t = now();
        if (r.status === 200) {
            put.run(q.lkey, 200, r.body, t, t + TTL.hit); tally.hit++;
        } else if (r.status === 404) {
            const ttl = q.kind === 'movie' ? TTL.missMovie : q.state === 'warm' ? TTL.missWarm : TTL.missCold;
            put.run(q.lkey, 404, null, t, t + ttl); tally.miss++;
        } else {
            tally.error++;
            const ttl = r.status >= 400 && r.status < 500 ? TTL.bad : TTL.error;
            // never clobber good data with a transient failure
            if (prev.get(q.lkey)?.status === 200) bump.run(t + ttl, q.lkey);
            else put.run(q.lkey, r.status, r.body.slice(0, 300), t, t + ttl);
            if (tally.error >= 10 && tally.error > tally.hit + tally.miss) { tally.stopped = 'errors'; break; }
        }
        if (tally.remaining != null && tally.remaining <= reserve) { tally.stopped = 'reserve'; break; }
        await sleep(src.paceMs);
    }
    recordRun(L, `fetch:${source}`, t0, tally);
    log(`fetch ${source} done`, tally);
}

// ---------- mapping + plan ----------
function desiredMarkers(b, dur, { mapRecap, mapPreview }) {
    const segs = [];
    const add = (text, src, list, openStart, openEnd) => {
        for (const s of list || []) {
            const start = s.start_ms ?? (openStart ? 0 : null);
            let end = s.end_ms ?? (openEnd && dur > 0 ? dur : null);
            if (start == null || end == null) continue;
            if (dur > 0) {
                if (start >= dur) continue;      // segment is past EOF: different cut than ours
                end = Math.min(end, dur);
            }
            if (end - start < MIN_SEG_MS) continue;
            segs.push({ text, src: `${b.from?.[src] ?? 'tidb'}:${src}`, start: Math.round(start), end: Math.round(end), final: 0 });
        }
    };
    add('intro', 'intro', b.intro, true, false);
    if (mapRecap) add('intro', 'recap', b.recap, true, false);
    add('credits', 'credits', b.credits, false, true);
    if (mapPreview) add('credits', 'preview', b.preview, false, true);
    segs.sort((a, b) => a.start - b.start);

    // Plex (and MarkerEditor) reject overlapping markers: merge same-type, trim or drop cross-type.
    const out = [];
    for (const s of segs) {
        const p = out[out.length - 1];
        if (p && s.start <= p.end) {
            if (p.text === s.text) { p.end = Math.max(p.end, s.end); p.src += `+${s.src}`; continue; }
            if (s.end - (p.end + 1) < MIN_SEG_MS) continue;
            s.start = p.end + 1;
        }
        out.push(s);
    }
    const last = out[out.length - 1];
    if (last?.text === 'credits' && dur > 0 && last.end >= dur - FINAL_SLACK_MS) last.final = 1;
    return { intro: out.filter(s => s.text === 'intro'), credits: out.filter(s => s.text === 'credits') };
}

// m.src is e.g. "tidb:intro", "chapters:credits", or "tidb:credits+introdb:credits" after a merge.
const SOURCE_NAMES = ['tidb', 'chapters', 'introdb', 'fingerprint'];
const sourceOf = (src = '') => {
    const s = SOURCE_NAMES.filter(k => src.includes(`${k}:`));
    return s.length > 1 ? 'mixed' : s[0] ?? 'tidb';
};

// Named chapters Plex already extracted into media_parts.extra_data (pv:chapters): free, exact for this
// file, no reads over the mounts. Only unambiguous names count ("Studio Logo", "Scene 3", "Part 01" don't),
// and each must sit where that segment plausibly lives. Measured vs TheIntroDB: credits start within
// ~2 s median; intros looser (~6 s median), hence ranked below TheIntroDB.
const CHAPTER_RX = {
    intro: /^(intro|opening|opening credits|opening titles?|opening theme|title sequence|main titles?|theme|theme song|op)$/i,
    recap: /^(recap|previously|previously on|last time|last time on)$/i,
    credits: /^(credits|end credits|ending credits|closing credits|end titles?|ending|outro|ed)$/i,
    preview: /^(preview|next episode|next time|next time on|coming up|coming up next|next week|next week on)$/i,
};
// Movies: credits/preview only. A film's "Opening Credits" chapter often runs over the first scene.
function chapterSegments(chapters, dur, kind) {
    if (!Array.isArray(chapters) || chapters.length < 2 || !(dur > 0)) return null;
    const b = {};
    for (const c of chapters) {
        const name = String(c.name ?? '').trim().replace(/[.…:!]+$/, '');
        const type = Object.keys(CHAPTER_RX).find(k => CHAPTER_RX[k].test(name));
        if (!type || b[type] || (kind === 'movie' && (type === 'intro' || type === 'recap'))) continue;
        const start = Math.round(c.start * 1000), end = Math.round(c.end * 1000), len = end - start;
        // Length caps tightened 2026-09-18 after the pre-apply audit (user-approved): at 200 s / 20 min they
        // let through "intro" chapters that swallow the cold open (American Dad! 163 s, Grey's Anatomy 164 s)
        // and mislabeled "recaps" of 18 min (Criminal Minds) and 10 min (Dexter: Resurrection) — Skip Intro
        // would jump into the story. Caps apply per chapter, BEFORE a recap merges with the opening, so a
        // real opening + recap (Dragon Ball Super ~168 s) still merges; long genuine recaps (Bosch 272 s) stay.
        const ok = type === 'intro' ? start <= dur * 0.35 && len >= 5000 && len <= 150000
            : type === 'recap' ? start <= dur * 0.35 && len >= 5000 && len <= 300000
            : start >= dur * 0.6 && len >= 5000 && len <= 1800000;              // credits, preview
        if (ok) b[type] = [{ start_ms: start, end_ms: end }];
    }
    return Object.keys(b).length ? b : null;
}

const sameSet = (a, b, tol = 0) => a.length === b.length && a.every((m, i) =>
    Math.abs(m.start - b[i].start) <= tol && Math.abs(m.end - b[i].end) <= tol);

// Per segment type, the first source that has it wins: TheIntroDB (community-verified, cut-aware),
// then the file's own named chapters, then introdb.app (rows go live unverified, can't pick a cut).
// introdb.app's "outro" = end credits; its "post_credits" is a scene to watch, so it's never mapped.
// Last: our own detection (fingerprint.mjs), which only runs where none of the above has the segment type anyway.
function mergeSources(tb, cb, ib, fb, { useChapters, useIntrodb, useFingerprint }) {
    const b = { from: {} };
    const take = (k, v, src) => { if (!b[k] && v?.length) { b[k] = v; b.from[k] = src; } };
    for (const k of ['intro', 'recap', 'credits', 'preview']) take(k, tb?.[k], 'tidb');
    if (useChapters && cb) for (const k of ['intro', 'recap', 'credits', 'preview']) take(k, cb[k], 'chapters');
    if (useIntrodb && ib) {
        for (const [k, v] of [['intro', ib.intro], ['recap', ib.recap], ['credits', ib.outro]]) {
            if (v?.end_ms > 0) take(k, [{ start_ms: v.start_ms, end_ms: v.end_ms }], 'introdb');
        }
    }
    if (useFingerprint && fb) for (const k of ['intro', 'credits']) take(k, fb[k], 'fingerprint');
    return b;
}

// Detections from fingerprint.mjs, only where they were made on the file Plex has NOW (same path + size): a replaced
// or upgraded file gets detected again rather than inheriting another release's timings.
function fingerprintBodies(plex) {
    const out = new Map();
    if (!fs.existsSync(CFG.fpDb)) return out;
    let db;
    try { db = new DatabaseSync(CFG.fpDb, { readOnly: true }); db.exec('PRAGMA busy_timeout=15000'); }
    catch (e) { log(`fingerprint store unreadable (${e.message}); ignoring it`); return out; }
    const rows = db.prepare(`SELECT mid, kind, file, size, start_ms, end_ms FROM detections
                             WHERE status IN ('match', 'found') AND start_ms IS NOT NULL AND end_ms > start_ms`).all();
    db.close();
    const part = plex.prepare(`SELECT mp.file, mp.size FROM media_items mi JOIN media_parts mp ON mp.media_item_id = mi.id
                               WHERE mi.metadata_item_id = ? AND mi.deleted_at IS NULL AND mp.deleted_at IS NULL`);
    for (const r of rows) {
        const parts = part.all(r.mid);
        if (parts.length !== 1 || parts[0].file !== r.file || parts[0].size !== r.size) continue;
        if (!out.has(r.mid)) out.set(r.mid, {});
        out.get(r.mid)[r.kind] = [{ start_ms: r.start_ms, end_ms: r.end_ms }];
    }
    return out;
}

function buildPlan(L, plex, opts) {
    const tagId = markerTagId(plex);
    const rows = L.prepare(`
        SELECT i.mid, i.kind, i.show_title, i.title, i.season, i.episode, t.body tbody, d.body ibody
        FROM items i
        LEFT JOIN lookups t ON t.lkey = i.lkey AND t.status = 200
        LEFT JOIN lookups d ON d.lkey = i.ikey AND d.status = 200`).all();
    const live = plex.prepare(`SELECT ${fileDur('m.id')} duration FROM metadata_items m WHERE m.id=? AND m.deleted_at IS NULL`);
    const mine = L.prepare('SELECT text, start_ms start, end_ms "end", final, source FROM applied WHERE mid=? ORDER BY start_ms');
    const oursMids = new Set(L.prepare('SELECT DISTINCT mid FROM applied').all().map(r => r.mid));
    // PAL guard. A 25/50 fps file in a season that is mostly 23.976/24 fps (or a 25 fps movie ~4% shorter than
    // its listed runtime) is a PAL speed-up: it plays 4.3% fast, so TheIntroDB/introdb.app timestamps, which
    // are for the normal-speed version, drift by up to minutes. Only the file's own chapters are trusted there.
    const spedUp = new Set();
    if (opts.palGuard) {
        const all = plex.prepare(`SELECT m.id mid, m.metadata_type type, m.parent_id season, m.duration meta,
                                         max(mi.frames_per_second) fps, max(mi.duration) dur
                                  FROM metadata_items m JOIN media_items mi ON mi.metadata_item_id = m.id
                                  WHERE m.metadata_type IN (1, 4) AND m.deleted_at IS NULL GROUP BY m.id`).all();
        const pal = (f) => Math.abs(f - 25) < 0.05 || Math.abs(f - 50) < 0.05;
        const film = (f) => Math.abs(f - 23.976) < 0.05 || Math.abs(f - 24) < 0.05;
        const seasons = new Map();
        for (const x of all) if (x.type === 4) { if (!seasons.has(x.season)) seasons.set(x.season, []); seasons.get(x.season).push(x); }
        for (const x of all) {
            if (!pal(x.fps)) continue;
            if (x.type === 4) {
                const sib = seasons.get(x.season).filter(y => y.mid !== x.mid && y.fps > 0);
                if (sib.length && sib.filter(y => film(y.fps)).length / sib.length >= 0.5) spedUp.add(x.mid);
            } else if (x.meta > 0 && x.dur > 0 && x.dur / x.meta > 0.94 && x.dur / x.meta < 0.975) spedUp.add(x.mid);
        }
    }
    // One pass each over markers and chapters instead of ~39k per-item queries.
    const existingBy = new Map();
    for (const m of plex.prepare(`SELECT id, metadata_item_id mid, text, time_offset start, end_time_offset "end", "index" idx
                                  FROM taggings WHERE tag_id=? ORDER BY time_offset, id`).all(tagId)) {
        if (!existingBy.has(m.mid)) existingBy.set(m.mid, []);
        existingBy.get(m.mid).push({ id: m.id, text: m.text, start: m.start, end: m.end, idx: m.idx });
    }
    const chaptersBy = new Map();   // mid -> chapters of its longest media version
    if (opts.useChapters) {
        for (const r of plex.prepare(`SELECT mi.metadata_item_id mid, mi.duration dur, mp.extra_data x
                                      FROM media_items mi JOIN media_parts mp ON mp.media_item_id = mi.id
                                      WHERE mp.extra_data LIKE '%pv:chapters%'`).all()) {
            if ((chaptersBy.get(r.mid)?.dur ?? -1) >= r.dur) continue;
            let ch;
            try { ch = JSON.parse(JSON.parse(r.x)['pv:chapters']).Chapters?.Chapter; } catch { continue; }
            if (Array.isArray(ch) && ch.length > 1) chaptersBy.set(r.mid, { ch, dur: r.dur });
        }
    }
    // Our own detections are measured on this exact file (PAL speed included), so the PAL guard doesn't apply to them.
    const fpBy = opts.useFingerprint ? fingerprintBodies(plex) : new Map();
    const stats = { withData: 0, gone: 0, noUsable: 0, add: 0, reapply: 0, update: 0, replacePlex: 0,
                    keptPlex: 0, alreadyCurrent: 0, droppedOverlap: 0, markers: { intro: 0, credits: 0, commercial: 0 },
                    bySource: { tidb: 0, chapters: 0, introdb: 0, fingerprint: 0, mixed: 0 }, retract: 0, spedUpFiles: spedUp.size, palIgnored: 0,
                    fingerprintDetections: fpBy.size };
    const plan = [];

    for (const r of rows) {
        const ch = chaptersBy.get(r.mid);
        const fb = fpBy.get(r.mid) ?? null;
        const sped = spedUp.has(r.mid);
        if (sped && (r.tbody || r.ibody)) stats.palIgnored++;
        const tbody = sped ? null : r.tbody, ibody = sped ? null : r.ibody;
        const mayRetract = sped && oursMids.has(r.mid);
        if (!tbody && !(opts.useIntrodb && ibody) && !ch && !fb && !mayRetract) continue;
        stats.withData++;
        const lv = live.get(r.mid);
        if (!lv) { stats.gone++; continue; }
        const dur = lv.duration || 0;
        const merged = mergeSources(tbody && JSON.parse(tbody), ch && chapterSegments(ch.ch, dur, r.kind),
                                    ibody && JSON.parse(ibody), fb, opts);
        const want = desiredMarkers(merged, dur, opts);
        if (!want.intro.length && !want.credits.length && !mayRetract) { stats.noUsable++; continue; }
        const existing = existingBy.get(r.mid) ?? [];
        const ours = mine.all(r.mid);
        const changes = {};
        for (const type of ['intro', 'credits']) {
            const w = want[type];
            const ex = existing.filter(m => m.text === type);
            const mn = ours.filter(m => m.text === type);
            if (!w.length) {                               // no source for this type: leave Plex alone, except...
                // ...on a PAL speed-up file, take back IntroSync's own community-sourced markers (nothing replaces them)
                if (mayRetract && ex.length && mn.length && sameSet(ex, mn) && mn.every(m => /^(tidb|introdb):/.test(m.source ?? 'tidb:')))
                    changes[type] = { action: 'retract', remove: ex.map(m => m.id), add: [] };
                continue;
            }
            let action = null;
            if (!ex.length) action = mn.length ? 'reapply' : 'add';            // reapply = Plex wiped ours
            else if (mn.length && sameSet(ex, mn)) action = sameSet(ex, w) ? null : 'update';
            else if (opts.policy === 'prefer-tidb') action = sameSet(ex, w, MATCH_TOLERANCE_MS) ? null : 'replacePlex';
            else { stats.keptPlex++; continue; }
            if (!action) { stats.alreadyCurrent++; continue; }
            changes[type] = { action, remove: ex.map(m => m.id), add: w };
        }
        if (!Object.keys(changes).length) continue;

        // Drop any new marker that would overlap a marker we are keeping (other type, or commercials).
        const removeIds = new Set(Object.values(changes).flatMap(c => c.remove));
        const kept = existing.filter(m => !removeIds.has(m.id));
        for (const c of Object.values(changes)) {
            c.add = c.add.filter(m => {
                const clash = kept.some(k => m.start <= k.end && k.start <= m.end);
                if (clash) stats.droppedOverlap++;
                return !clash;
            });
        }
        for (const [type, c] of Object.entries(changes)) {
            if (!c.add.length && !c.remove.length) { delete changes[type]; continue; }
            stats[c.action]++;
            stats.markers[type] += c.add.length;
            for (const m of c.add) stats.bySource[sourceOf(m.src)]++;
        }
        if (!Object.keys(changes).length) continue;
        const label = r.kind === 'movie' ? r.title
            : `${r.show_title} S${String(r.season).padStart(2, '0')}E${String(r.episode).padStart(2, '0')}`;
        plan.push({ mid: r.mid, label, dur, existing, changes });
    }
    if (opts.useCommercials) planCommercials(plex, opts, { existingBy, mine, plan, stats });
    return { plan, stats, tagId };
}

// ---------- commercial markers from comskip chapters (Sports recordings) ----------
// The DVR trimmer (Unmanic comchap) leaves chapters "Commercial 1..N" alternating with "Chapter N" in each recording.
// Plex shows "Skip Commercial" for text='commercial' markers (its own DVR comskip writes them: taggings with
// extra_data NULL + pv:commercials version -1 in media_parts.extra_data), so they're written the same way.
// Only the configured sections (default: the one named "Sports"); these items have no TMDB id, so they're not in the
// ledger's items and are found straight from Plex. Plex's own commercial markers are never replaced (policy fill).
const COMMERCIAL_RX = /^commercials?(\s*\d+)?$/i;
function commercialSegments(chapters, dur) {
    const segs = [];
    for (const c of chapters) {
        if (!COMMERCIAL_RX.test(String(c.name ?? '').trim())) continue;
        const start = Math.round(c.start * 1000), end = Math.round(Math.min(c.end * 1000, dur > 0 ? dur : Infinity));
        if (end - start < 5000 || end - start > 20 * 60000) continue;   // comskip blips / a whole segment misread
        // At the very start or end it's the trimmed pre/post pad, not a break (e.g. "Commercial 1" 0:00-0:52)
        if (start < 2000 || (dur > 0 && end > dur - 2000)) continue;
        const p = segs[segs.length - 1];
        if (p && start - p.end <= 1000) { p.end = Math.max(p.end, end); continue; }   // back-to-back breaks: one marker
        segs.push({ text: 'commercial', src: 'chapters:commercial', start, end, final: 0 });
    }
    return segs;
}
function planCommercials(plex, opts, { existingBy, mine, plan, stats }) {
    const want = new Set(String(opts.commercialSections ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    const secs = plex.prepare('SELECT id, name FROM library_sections').all()
        .filter(s => want.has(String(s.id)) || want.has(String(s.name).toLowerCase())).map(s => s.id);
    stats.commercialSections = secs;
    if (!secs.length) return;
    const rows = plex.prepare(`SELECT m.id mid, m.title, gp.title show, mi.duration dur, mp.extra_data x,
            (SELECT count(*) FROM media_items mi2 JOIN media_parts mp2 ON mp2.media_item_id = mi2.id
             WHERE mi2.metadata_item_id = m.id AND mi2.deleted_at IS NULL AND mp2.deleted_at IS NULL) parts
        FROM metadata_items m JOIN media_items mi ON mi.metadata_item_id = m.id JOIN media_parts mp ON mp.media_item_id = mi.id
        LEFT JOIN metadata_items p ON p.id = m.parent_id LEFT JOIN metadata_items gp ON gp.id = p.parent_id
        WHERE m.library_section_id IN (${secs.map(() => '?').join(',')}) AND m.deleted_at IS NULL AND mi.deleted_at IS NULL
          AND mp.deleted_at IS NULL AND mp.extra_data LIKE '%Commercial%'`).all(...secs);
    stats.commercialItems = 0;
    for (const r of rows) {
        if (r.parts !== 1) continue;                    // one file only: chapters and markers describe the same timeline
        let ch; try { ch = JSON.parse(JSON.parse(r.x)['pv:chapters']).Chapters?.Chapter; } catch { continue; }
        if (!Array.isArray(ch)) continue;
        const w = commercialSegments(ch, r.dur || 0);
        if (!w.length) continue;
        stats.commercialItems++;
        const existing = existingBy.get(r.mid) ?? [];
        const ex = existing.filter(m => m.text === 'commercial');
        const mn = mine.all(r.mid).filter(m => m.text === 'commercial');
        let action = null;
        if (!ex.length) action = mn.length ? 'reapply' : 'add';
        else if (mn.length && sameSet(ex, mn)) action = sameSet(ex, w) ? null : 'update';
        else { stats.keptPlex++; continue; }              // Plex's own commercial markers: leave them
        if (!action) { stats.alreadyCurrent++; continue; }
        const removeIds = new Set(ex.map(m => m.id));
        const kept = existing.filter(m => !removeIds.has(m.id));
        const add = w.filter(m => { const clash = kept.some(k => m.start <= k.end && k.start <= m.end); if (clash) stats.droppedOverlap++; return !clash; });
        if (!add.length && !removeIds.size) continue;
        stats[action]++;
        stats.markers.commercial += add.length;
        stats.bySource.chapters += add.length;
        const change = { action, remove: [...removeIds], add };
        const prev = plan.find(p => p.mid === r.mid);
        if (prev) prev.changes.commercial = change;
        else plan.push({ mid: r.mid, label: `${r.show ? `${r.show}: ` : ''}${r.title}`, dur: r.dur || 0, existing, changes: { commercial: change } });
    }
}

function planCmd() {
    const t0 = now();
    const L = openLedger();
    const plex = openPlex(true);
    const opts = planOpts();
    const { plan, stats } = buildPlan(L, plex, opts);
    plex.close();
    fs.mkdirSync(CFG.dataDir, { recursive: true });
    const out = path.join(CFG.dataDir, `plan-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
    fs.writeFileSync(out, JSON.stringify({ opts, stats, plan }, null, 1));
    recordRun(L, 'plan', t0, { opts, stats });
    log('plan', opts, stats);
    for (const p of plan.slice(0, Number(opt('show', 15)))) {
        const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
        const desc = Object.entries(p.changes).map(([t, c]) =>
            `${c.action} ${t} ${c.add.map(m => `${fmt(m.start)}-${fmt(m.end)}${m.final ? '(final)' : ''}[${sourceOf(m.src)}]`).join(',') || '-'}`
            + (c.remove.length ? ` (removes ${c.remove.length})` : '')).join(' | ');
        console.log(`  ${p.label.padEnd(48).slice(0, 48)} ${desc}`);
    }
    log(`plan written: ${out}`);
}

// ---------- media_parts.extra_data (mirrors MarkerEditorForPlex MediaAnalysisWriter) ----------
// Plex leaves only [A-Za-z0-9_-] literal in the url field; encodeURIComponent also leaves .!~*'()
// (MarkerEditor has that deviation). Verified byte-for-byte against this library by `selftest`.
const plexEncode = (s) => encodeURIComponent(s).replace(/[.!~*'()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function encodeExtra(core) {
    const sorted = {};
    for (const k of Object.keys(core).sort()) sorted[k] = typeof core[k] === 'object' ? JSON.stringify(core[k]) : core[k];
    sorted.url = Object.entries(sorted).map(([k, v]) => `${plexEncode(k)}=${plexEncode(v)}`).join('&');
    return JSON.stringify(sorted);
}

function rewriteExtra(raw, types, intros, credits, commercials = []) {
    let obj;
    try { obj = JSON.parse(raw); } catch { return null; }
    if (!obj || typeof obj !== 'object' || !('url' in obj)) return null;   // pre-1.40 PMS format: leave alone
    const { url: _url, ...core } = obj;
    if (types.has('intro')) {
        core['pv:intros'] = intros.length ? { MediaPartMarkersArray: { attributeName: 'intros', version: 5,
            MediaPartMarker: intros.map(m => ({ startTimeOffset: m.start, endTimeOffset: m.end })) } } : '';
    }
    if (types.has('credits')) {
        core['pv:credits'] = credits.length ? { MediaPartMarkersArray: { attributeName: 'credits', version: 4,
            MediaPartMarker: credits.map(m => m.final
                ? { startTimeOffset: m.start, endTimeOffset: m.end, final: true }
                : { startTimeOffset: m.start, endTimeOffset: m.end }) } }
            : { attributeName: 'credits', version: 4 };
    }
    if (types.has('commercial')) {                     // as Plex's own DVR comskip writes it (version -1)
        if (commercials.length) core['pv:commercials'] = { MediaPartMarkersArray: { attributeName: 'commercials', version: -1,
            MediaPartMarker: commercials.map(m => ({ startTimeOffset: m.start, endTimeOffset: m.end })) } };
        else delete core['pv:commercials'];
    }
    return encodeExtra(core);
}

function selftest() {
    // Read-only: re-encode real extra_data rows unchanged and compare bytes with what Plex wrote.
    const plex = openPlex(true);
    const rows = plex.prepare(`SELECT extra_data FROM media_parts WHERE extra_data LIKE '{%'
                               ORDER BY random() LIMIT ?`).all(Number(opt('n', 5000)));
    plex.close();
    let same = 0, diff = 0, bad = 0, example = null;
    for (const { extra_data } of rows) {
        let o; try { o = JSON.parse(extra_data); } catch { bad++; continue; }
        const { url: _u, ...core } = o;
        if (encodeExtra(core) === extra_data) same++;
        else { diff++; example ??= { plex: extra_data.slice(0, 400), ours: encodeExtra(core).slice(0, 400) }; }
    }
    log('selftest', { sampled: rows.length, identical: same, different: diff, unparseable: bad });
    if (example) console.log(example);
    process.exitCode = diff || bad ? 1 : 0;
}

// ---------- apply / undo (WRITE) ----------
function plexToken() {
    try { return fs.readFileSync(CFG.plexPrefs, 'utf8').match(/PlexOnlineToken="([^"]+)"/)?.[1] ?? null; } catch { return null; }
}

function plexProcessRunning() {
    // Container processes are visible in the host's /proc; don't trust "HTTP didn't answer" alone.
    for (const pid of fs.readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
        try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('plexmediaserver/Plex Media Server')) return true; } catch { }
    }
    return false;
}

// true = running, false = confirmed stopped, null = can't tell (e.g. inside a container, where Plex's
// process isn't visible and PLEX_URL doesn't answer). Callers must fail closed on null.
async function plexUp() {
    if (plexProcessRunning()) return true;
    try { if ((await fetch(`${CFG.plexUrl}/identity`, { signal: AbortSignal.timeout(5000) })).ok) return true; } catch { }
    return flag('plex-stopped') ? false : null;
}

async function activeSessions() {
    const token = plexToken();
    if (!token) return null;
    try {
        const r = await fetch(`${CFG.plexUrl}/status/sessions`, {
            headers: { Accept: 'application/json', 'X-Plex-Token': token }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) return null;
        return (await r.json())?.MediaContainer?.size ?? null;
    } catch { return null; }
}

async function preflight(what) {
    if (!flag('yes')) die(`${what} writes to the Plex database; re-run with --yes`);
    const up = await plexUp();
    if (up === null) die(`can't confirm whether Plex is running (no process visible, ${CFG.plexUrl} not answering). `
        + 'Fix PLEX_URL, or pass --plex-stopped if Plex really is stopped.');
    if (up) {
        if (!flag('live')) die('Plex is running. Stop Plex first, or pass --live to write while it runs '
            + '(MarkerEditorForPlex strongly recommends stopping PMS).');
        const n = await activeSessions();
        if (n === null && !flag('skip-session-check')) die('could not read Plex sessions; refusing (or pass --skip-session-check)');
        if (n > 0) die(`${n} active Plex session(s); not writing now`);
    }
}

async function takeBackup(plex) {
    fs.mkdirSync(CFG.backupDir, { recursive: true });
    const dest = path.join(CFG.backupDir, `library.db.pre-tidb-${new Date().toISOString().replace(/[:.]/g, '')}`);
    // One step (rate > page count): an incremental backup restarts every time Plex writes, and may never finish.
    await backup(plex, dest, { rate: 10_000_000 });
    const old = fs.readdirSync(CFG.backupDir).filter(f => f.startsWith('library.db.pre-tidb-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - Number(opt('keep-backups', 3))))) fs.rmSync(path.join(CFG.backupDir, f));
    return dest;
}

async function applyCmd() {
    await preflight('apply');
    const t0 = now();
    const L = openLedger();
    const plex = openPlex(false);
    const opts = planOpts();
    const { plan, stats, tagId } = buildPlan(L, plex, opts);
    const match = opt('match', '').toLowerCase();         // pilot on one show: --match "last of us"
    const limit = Number(opt('limit', 0)) || plan.length;
    const work = plan.filter(p => p.label.toLowerCase().includes(match)).slice(0, limit);
    if (!work.length) { log('apply: nothing to do', stats); return; }
    if (!flag('no-backup')) log(`backup: ${await takeBackup(plex)}`);

    const undoPath = path.join(CFG.dataDir, `undo-${new Date().toISOString().replace(/[:.]/g, '')}.jsonl`);
    const undo = fs.openSync(undoPath, 'a');
    const U = (o) => fs.writeSync(undo, `${JSON.stringify(o)}\n`);

    const q = {
        marks: plex.prepare(`SELECT id, text, time_offset start, end_time_offset "end", "index" idx, extra_data
                             FROM taggings WHERE metadata_item_id=? AND tag_id=? ORDER BY time_offset, id`),
        row: plex.prepare('SELECT * FROM taggings WHERE id=?'),
        del: plex.prepare('DELETE FROM taggings WHERE id=?'),
        idx: plex.prepare('UPDATE taggings SET "index"=? WHERE id=?'),
        ins: plex.prepare(`INSERT INTO taggings(metadata_item_id, tag_id, "index", text, time_offset, end_time_offset,
                                                thumb_url, created_at, extra_data) VALUES (?,?,?,?,?,?,'',?,?)`),
        parts: plex.prepare(`SELECT mp.id, mp.extra_data FROM media_parts mp
                             JOIN media_items mi ON mi.id = mp.media_item_id WHERE mi.metadata_item_id=?`),
        extra: plex.prepare('UPDATE media_parts SET extra_data=? WHERE id=?'),
        forget: L.prepare('DELETE FROM applied WHERE mid=? AND text=?'),
        remember: L.prepare(`INSERT OR REPLACE INTO applied(mid, text, start_ms, end_ms, final, applied_at, source)
                             VALUES (?,?,?,?,?,?,?)`),
    };
    const done = { items: 0, inserted: 0, deleted: 0, parts: 0, skippedChanged: 0 };
    const CHUNK = 200;
    for (let i = 0; i < work.length; i += CHUNK) {
        plex.exec('BEGIN IMMEDIATE');
        L.exec('BEGIN');
        try {
            for (const p of work.slice(i, i + CHUNK)) {
                const t = now();
                const cur = q.marks.all(p.mid, tagId);
                // Plex touched this item between plan and write: skip, next run re-plans it.
                if (!sameSet(cur, p.existing) || cur.some((m, j) => m.id !== p.existing[j].id)) { done.skippedChanged++; continue; }
                const removeIds = new Set(Object.values(p.changes).flatMap(c => c.remove));
                for (const id of removeIds) { U({ op: 'delete', mid: p.mid, row: q.row.get(id) }); q.del.run(id); done.deleted++; }
                const all = [...cur.filter(m => !removeIds.has(m.id)).map(m => ({ ...m, kept: true })),
                             ...Object.values(p.changes).flatMap(c => c.add)].sort((a, b) => a.start - b.start);
                all.forEach((m, j) => {
                    if (m.kept) {
                        if (m.idx !== j) { U({ op: 'index', mid: p.mid, id: m.id, old: m.idx }); q.idx.run(j, m.id); }
                        return;
                    }
                    const extra = m.text === 'intro' ? EXTRA.intro : m.text === 'commercial' ? null : m.final ? EXTRA.creditsFinal : EXTRA.credits;
                    const id = Number(q.ins.run(p.mid, tagId, j, m.text, m.start, m.end, t, extra).lastInsertRowid);
                    U({ op: 'insert', mid: p.mid, id });
                    done.inserted++;
                });
                const types = new Set(Object.keys(p.changes));
                const intros = all.filter(m => m.text === 'intro');
                const credits = all.filter(m => m.text === 'credits')
                    .map(m => ({ ...m, final: m.kept ? Number((m.extra_data || '').includes('final')) : m.final }));
                const commercials = all.filter(m => m.text === 'commercial');
                for (const part of q.parts.all(p.mid)) {
                    const next = rewriteExtra(part.extra_data, types, intros, credits, commercials);
                    if (next && next !== part.extra_data) {
                        U({ op: 'extra', mid: p.mid, part_id: part.id, old: part.extra_data });
                        q.extra.run(next, part.id);
                        done.parts++;
                    }
                }
                for (const [type, c] of Object.entries(p.changes)) {
                    q.forget.run(p.mid, type);
                    for (const m of c.add) q.remember.run(p.mid, type, m.start, m.end, m.final, t, m.src);
                }
                done.items++;
            }
            plex.exec('COMMIT');
            L.exec('COMMIT');
        } catch (e) {
            plex.exec('ROLLBACK');
            L.exec('ROLLBACK');
            fs.closeSync(undo);
            die(`apply failed in chunk ${i / CHUNK}, chunk rolled back: ${e.message}. Undo log for earlier chunks: ${undoPath}`);
        }
    }
    fs.closeSync(undo);
    recordRun(L, 'apply', t0, { opts, stats, done, undoPath });
    log('apply done', done, `undo log: ${undoPath}`);
}

async function undoCmd() {
    const file = argv[1];
    if (!file || !fs.existsSync(file)) die('usage: undo <undo-*.jsonl> --yes');
    await preflight('undo');
    const ops = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).reverse();
    const plex = openPlex(false);
    const L = openLedger();
    const mids = new Set();
    plex.exec('BEGIN IMMEDIATE');
    try {
        for (const o of ops) {
            mids.add(o.mid);
            if (o.op === 'insert') plex.prepare('DELETE FROM taggings WHERE id=?').run(o.id);
            else if (o.op === 'index') plex.prepare('UPDATE taggings SET "index"=? WHERE id=?').run(o.old, o.id);
            else if (o.op === 'extra') plex.prepare('UPDATE media_parts SET extra_data=? WHERE id=?').run(o.old, o.part_id);
            else if (o.op === 'delete') {
                const cols = Object.keys(o.row);
                plex.prepare(`INSERT INTO taggings(${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
                    .run(...cols.map(c => o.row[c]));
            }
        }
        plex.exec('COMMIT');
    } catch (e) {
        plex.exec('ROLLBACK');
        die(`undo failed, nothing changed: ${e.message}`);
    }
    // Forget these items entirely so the next apply doesn't treat the restored state as "ours was wiped".
    // (They will be re-added by a later apply unless you also stop scheduling it.)
    const forget = L.prepare('DELETE FROM applied WHERE mid=?');
    for (const m of mids) forget.run(m);
    log(`undo: reverted ${ops.length} operations on ${mids.size} items from ${file}`);
}

// ---------- submit Plex-detected intros back to TheIntroDB ----------
// TIDB FAQ: bulk submitting is allowed "but we'd prefer if you contacted us before doing so".
// Without --yes this is a dry run: candidate count, agreement with TIDB's accepted data, sample bodies.
async function submitCmd() {
    const t0 = now();
    const L = openLedger();
    const plex = openPlex(true);
    const tagId = markerTagId(plex);
    // Only episodes Plex itself matched to a TMDB *episode* (so Plex numbering = TMDB numbering), with exactly one
    // marker of that type, within TIDB's bounds (intro 5-200 s, credits 5 s-30 min).
    const rows = plex.prepare(`
        SELECT e.id mid, CAST(substr(sg.tag, 8) AS INTEGER) tmdb, se."index" season, e."index" episode, ${fileDur('e.id')} duration,
               (SELECT max(duration) - min(duration) FROM media_items WHERE metadata_item_id = e.id) spread,
               (SELECT max(frames_per_second) FROM media_items WHERE metadata_item_id = e.id) fps,
               tg.text segment, sh.title show, tg.time_offset start_ms, tg.end_time_offset end_ms,
               (SELECT substr(t.tag, 8) FROM taggings x JOIN tags t ON t.id = x.tag_id
                 WHERE x.metadata_item_id = e.id AND t.tag_type = 314 AND t.tag LIKE 'imdb://%' LIMIT 1) imdb
        FROM taggings tg
        JOIN metadata_items e ON e.id = tg.metadata_item_id AND e.metadata_type = 4 AND e.deleted_at IS NULL
        JOIN metadata_items se ON se.id = e.parent_id
        JOIN metadata_items sh ON sh.id = se.parent_id
        JOIN taggings stg ON stg.metadata_item_id = sh.id
        JOIN tags sg ON sg.id = stg.tag_id AND sg.tag_type = 314 AND sg.tag LIKE 'tmdb://%'
        WHERE tg.tag_id = ? AND tg.text IN ('intro', 'credits') AND se."index" >= 1 AND e."index" >= 1 AND ${singleTmdb('sh.id')}
          AND (SELECT count(*) FROM taggings y WHERE y.metadata_item_id = e.id AND y.tag_id = ? AND y.text = tg.text) = 1
          AND EXISTS (SELECT 1 FROM taggings z JOIN tags t ON t.id = z.tag_id
                      WHERE z.metadata_item_id = e.id AND t.tag_type = 314 AND t.tag LIKE 'tmdb://%')`).all(tagId, tagId);
    plex.close();

    const tidb = L.prepare(`SELECT l.status, l.body FROM items i JOIN lookups l ON l.lkey = i.lkey WHERE i.mid = ?`);
    const done = L.prepare('SELECT 1 FROM submissions WHERE mid = ? AND segment = ? AND http = 200');
    // Only Plex's OWN detections may be submitted. Since IntroSync began writing markers (2026-09-18 04:40Z),
    // Plex's taggings also hold markers WE wrote from TheIntroDB (an echo), from introdb.app (copying it into
    // TheIntroDB is barred by introdb.app's terms), and from chapters (need user review first). Any marker
    // matching an `applied` row is ours, so it's excluded here. (All 419 earlier submissions predate 04:40Z.)
    const ours = L.prepare('SELECT 1 FROM applied WHERE mid = ? AND text = ? AND start_ms = ? AND end_ms = ?');
    const cands = [];
    const agree = { compared: 0, within2s: 0, within5s: 0, worse: [] };
    const only = opt('segment', '');                      // optional: submit just intros, or just credits
    let skippedOurs = 0, skippedPal = 0;
    for (const r of rows) {
        const seg = r.segment;
        if (only && seg !== only) continue;
        const len = r.end_ms - r.start_ms;
        if (len < 5000 || len > (seg === 'intro' ? 200000 : 1800000) || done.get(r.mid, seg)) continue;
        if (ours.get(r.mid, seg, r.start_ms, r.end_ms)) { skippedOurs++; continue; }
        // Omit the duration when versions of different length exist: we can't tell which one Plex analyzed.
        const withDuration = r.duration >= 300000 && r.duration <= 21600000 && r.spread <= 2000;
        // A PAL speed-up plays 4.3% fast, so its timings only make sense tied to that cut's duration.
        if (isPalFps(r.fps) && !withDuration) { skippedPal++; continue; }
        const l = tidb.get(r.mid);
        const body = l?.status === 200 ? JSON.parse(l.body) : null;
        const t = seg === 'intro' ? body?.intro?.[0] : body?.credits?.[0];
        if (seg === 'intro' ? t?.end_ms != null : t?.start_ms != null) {
            const d = seg === 'intro' ? Math.max(Math.abs((t.start_ms ?? 0) - r.start_ms), Math.abs(t.end_ms - r.end_ms))
                : Math.abs(t.start_ms - r.start_ms);
            agree.compared++;
            if (d <= 2000) agree.within2s++;
            if (d <= 5000) agree.within5s++;
            else agree.worse.push(`${r.show} S${r.season}E${r.episode} ${seg}: plex ${r.start_ms}-${r.end_ms} tidb ${t.start_ms ?? 0}-${t.end_ms ?? 'EOF'}`);
        }
        const sub = { tmdb_id: r.tmdb, type: 'tv', segment: seg, season: r.season, episode: r.episode, start_ms: r.start_ms };
        // Credits running to the end of the file: TIDB's own convention is end null = end of media.
        if (seg === 'intro' || !(r.duration > 0) || r.end_ms < r.duration - 2000) sub.end_ms = r.end_ms;
        if (withDuration) sub.video_duration_ms = r.duration;
        if (/^tt\d{7,8}$/.test(r.imdb || '')) sub.imdb_id = r.imdb;
        cands.push({ mid: r.mid, label: `${r.show} S${r.season}E${r.episode}`, body: sub });
    }
    const bySeg = cands.reduce((m, c) => (m[c.body.segment] = (m[c.body.segment] ?? 0) + 1, m), {});
    log('submit candidates', { plexMarkersEligible: rows.length, skippedIntroSyncWritten: skippedOurs, skippedPalSpeedUp: skippedPal,
        toSubmit: cands.length, bySegment: bySeg, agreementWithTidb: { ...agree, worse: agree.worse.length } });
    for (const w of agree.worse.slice(0, 10)) console.log(`  disagrees >5s: ${w}`);
    if (flag('json')) return console.log(JSON.stringify({ eligible: rows.length, skippedIntroSyncWritten: skippedOurs, skippedPalSpeedUp: skippedPal,
        bySegment: bySeg,
        candidates: cands.map(c => ({ mid: c.mid, label: c.label, segment: c.body.segment, start_ms: c.body.start_ms, end_ms: c.body.end_ms ?? null })) }));

    if (!flag('yes')) {
        for (const c of cands.slice(0, 3)) console.log('  dry-run', c.label, JSON.stringify(c.body));
        console.log('  (dry run: nothing sent; add --yes [--limit N] to submit)');
        return;
    }
    const key = readKey();
    if (!key) die(`submitting needs an API key in ${CFG.keyFile}`);
    const put = L.prepare(`INSERT OR REPLACE INTO submissions(mid, segment, start_ms, end_ms, http, status, response, submitted_at)
                           VALUES (?,?,?,?,?,?,?,?)`);
    const tally = { sent: 0, ok: 0, duplicate: 0, failed: 0 };
    for (const c of cands.slice(0, Number(opt('limit', 0)) || cands.length)) {
        let r;
        try {
            r = await fetch(`${CFG.api}/submit`, { method: 'POST', signal: AbortSignal.timeout(20000),
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'tidb-plex-sync/0.1' },
                body: JSON.stringify(c.body) });
        } catch (e) { tally.failed++; continue; }
        const text = await r.text();
        tally.sent++;
        if (r.status === 429) { log('submit: rate/usage limit hit, stopping'); break; }
        const dup = /already submitted/i.test(text);
        let accepted = 'ok';
        try { accepted = JSON.parse(text).submissions?.[0]?.status ?? 'ok'; } catch { }
        const status = r.ok ? accepted : dup ? 'duplicate' : 'error';
        put.run(c.mid, c.body.segment, c.body.start_ms, c.body.end_ms ?? null, dup ? 200 : r.status, status, text.slice(0, 500), now());
        if (r.ok) tally.ok++; else if (dup) tally.duplicate++; else { tally.failed++; log(`submit ${c.label}: ${r.status} ${text.slice(0, 200)}`); }
        if (tally.failed >= 5 && tally.failed > tally.ok) { log('submit: too many failures, stopping'); break; }
        await sleep(PACE_MS);
    }
    recordRun(L, 'submit', t0, tally);
    log('submit done', tally);
}

// ---------- submit Plex-detected markers to introdb.app (spec: https://api.introdb.app/openapi.json) ----------
// POST https://api.introdb.app/submit, header X-API-Key: idb_…, body { segment_type: intro|recap|outro|post-credits,
// imdb_id, season+episode | is_movie, start_sec, end_sec, tmdb_id? }. Their limit: 1 submission per segment and
// episode per 5 minutes (429). imdb_id is the SERIES id for episodes (as introdbGet reads it).
// Only markers Plex detected ITSELF go out — nothing IntroSync wrote. That rules out copying TheIntroDB's data
// (or introdb.app's own) into introdb.app, and chapter-derived timings, which need the user's review first.
// PAL-speed files (25/50 fps) are skipped: introdb.app entries carry no file length, so timings measured on a
// 4.3%-fast file would mislead everyone using the normal-speed release. Movies: credits (outro) only.
// Without --yes this is a dry run; --json lists the candidates for the web UI.
function readIdbKey() {
    try { return fs.readFileSync(process.env.INTRODB_API_KEY_FILE || '/data/secrets/introdb_api_key', 'utf8').trim() || null; }
    catch { return null; }
}
async function submitIdbCmd() {
    const t0 = now();
    const L = openLedger();
    const plex = openPlex(true);
    const tagId = markerTagId(plex);
    // Per-item file length / frame rate and per-(item, type) marker counts computed ONCE with grouped joins:
    // three correlated sub-queries per marker took ~190 s over ~13k markers.
    const rows = plex.prepare(`
        WITH mk AS (SELECT metadata_item_id mid, text, time_offset start_ms, end_time_offset end_ms
                    FROM taggings WHERE tag_id = ? AND text IN ('intro', 'credits')),
             cnt AS (SELECT mid, text, count(*) n FROM mk GROUP BY mid, text),
             mi AS (SELECT metadata_item_id mid, max(duration) duration, max(frames_per_second) fps
                    FROM media_items WHERE metadata_item_id IN (SELECT DISTINCT mid FROM mk) GROUP BY metadata_item_id)
        SELECT mk.mid, mk.text, mk.start_ms, mk.end_ms, mi.duration, mi.fps, cnt.n
        FROM mk JOIN cnt ON cnt.mid = mk.mid AND cnt.text = mk.text LEFT JOIN mi ON mi.mid = mk.mid`).all(tagId);
    plex.close();
    const item = L.prepare('SELECT kind, imdb, tmdb, season, episode, show_title, title FROM items WHERE mid = ?');
    const ours = L.prepare('SELECT 1 FROM applied WHERE mid = ? AND text = ? AND start_ms = ? AND end_ms = ?');
    const done = L.prepare('SELECT 1 FROM submissions WHERE mid = ? AND segment = ? AND http = 200');
    const skip = { introsyncWritten: 0, multiple: 0, noImdb: 0, movieIntro: 0, pal: 0, bounds: 0, alreadySent: 0 };
    const cands = [];
    for (const r of rows) {
        if (ours.get(r.mid, r.text, r.start_ms, r.end_ms)) { skip.introsyncWritten++; continue; }
        if (r.n !== 1) { skip.multiple++; continue; }
        const it = item.get(r.mid);
        const movie = it?.kind === 'movie';
        if (!it || !/^tt\d{7,9}$/.test(it.imdb || '') || (!movie && !(it.season >= 1 && it.episode >= 1))) { skip.noImdb++; continue; }
        const seg = r.text === 'intro' ? 'intro' : 'outro';
        if (movie && seg === 'intro') { skip.movieIntro++; continue; }
        const fps = Math.round(r.fps || 0);
        if (fps === 25 || fps === 50) { skip.pal++; continue; }
        const len = r.end_ms - r.start_ms;
        const okLen = seg === 'intro' ? len >= 5000 && len <= 200000 : len >= 5000 && len <= 1800000;
        if (!okLen || !(r.duration > 0) || r.end_ms > r.duration + 2000 || (seg === 'outro' && r.start_ms < r.duration * 0.5)) {
            skip.bounds++; continue;
        }
        if (done.get(r.mid, `idb:${seg}`)) { skip.alreadySent++; continue; }
        const body = { segment_type: seg, imdb_id: it.imdb, start_sec: r.start_ms / 1000, end_sec: Math.min(r.end_ms, r.duration) / 1000 };
        if (movie) body.is_movie = true; else { body.season = it.season; body.episode = it.episode; }
        if (Number.isInteger(it.tmdb) && it.tmdb > 0) body.tmdb_id = it.tmdb;
        cands.push({ mid: r.mid, segment: seg, label: movie ? it.title : `${it.show_title} S${it.season}E${it.episode}`, body });
    }
    log('submit-introdb candidates', { plexMarkers: rows.length, toSubmit: cands.length, skipped: skip });
    if (flag('json')) return console.log(JSON.stringify({ eligible: rows.length, skipped: skip,
        candidates: cands.map(c => ({ mid: c.mid, label: c.label, segment: c.segment,
                                      start_ms: Math.round(c.body.start_sec * 1000), end_ms: Math.round(c.body.end_sec * 1000) })) }));
    if (!flag('yes')) {
        for (const c of cands.slice(0, 3)) console.log('  dry-run', c.label, JSON.stringify(c.body));
        console.log('  (dry run: nothing sent; add --yes [--limit N] to submit)');
        return;
    }
    const key = readIdbKey();
    if (!key) die('submitting to introdb.app needs its API key (set it on the Settings page)');
    const put = L.prepare(`INSERT OR REPLACE INTO submissions(mid, segment, start_ms, end_ms, http, status, response, submitted_at, origin)
                           VALUES (?,?,?,?,?,?,?,?, 'plex')`);
    const tally = { sent: 0, ok: 0, rateLimited: 0, rejected: 0, failed: 0 };
    let consec429 = 0;
    for (const c of cands.slice(0, Number(opt('limit', 0)) || cands.length)) {
        let r;
        try {
            r = await fetch('https://api.introdb.app/submit', { method: 'POST', signal: AbortSignal.timeout(20000),
                headers: { 'X-API-Key': key, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'introsync/0.2' },
                body: JSON.stringify(c.body) });
        } catch { tally.failed++; await sleep(1100); continue; }
        const text = await r.text();
        tally.sent++;
        if (r.status === 401) { log('submit-introdb: API key rejected (401), stopping'); break; }
        const status = r.ok ? 'ok' : r.status === 429 ? 'rate-limited' : r.status === 400 ? 'rejected' : 'error';
        if (r.status !== 429) consec429 = 0;
        put.run(c.mid, `idb:${c.segment}`, Math.round(c.body.start_sec * 1000), Math.round(c.body.end_sec * 1000),
                r.status, status, text.slice(0, 500), now());
        if (r.ok) tally.ok++;
        else if (r.status === 429) {
            // Two different 429s: their documented per-episode limit (1 per segment/episode/5 min), and an account-wide
            // cap of 100 submissions an hour, which just returns "limit":100 for everything. Three in a row means the
            // hourly cap, so stop instead of burning the rest of the batch on refusals (2026-09-21: 201 wasted).
            tally.rateLimited++;
            if (++consec429 >= 3) {
                let reset = null; try { reset = JSON.parse(text).reset_at ?? null; } catch { }
                tally.stopped = 'rate-limited'; tally.resetAt = reset;
                log(`submit-introdb: hourly limit reached (their cap is 100/h)${reset ? `, resets ${reset}` : ''}; stopping`);
                break;
            }
        }
        else if (r.status === 400) { tally.rejected++; log(`submit-introdb ${c.label} ${c.segment}: 400 ${text.slice(0, 160)}`); }
        else { tally.failed++; log(`submit-introdb ${c.label}: ${r.status} ${text.slice(0, 160)}`); }
        if (tally.failed >= 5 && tally.failed > tally.ok) { log('submit-introdb: too many failures, stopping'); break; }
        await sleep(1100);
    }
    recordRun(L, 'submit-introdb', t0, tally);
    log('submit-introdb done', tally);
}

// ---------- sources: provenance of every intro/credits marker currently in Plex (read-only) ----------
// A marker matching a ledger `applied` row was written by us (source = tidb / introdb / mixed);
// anything else in Plex is Plex's own detection (or a manual edit) = "plex".
function sourcesCmd() {
    const L = openLedger();
    const plex = openPlex(true);
    const tagId = markerTagId(plex);
    const marks = plex.prepare(`SELECT metadata_item_id mid, text, time_offset start, end_time_offset "end"
                                FROM taggings WHERE tag_id = ? AND text IN ('intro', 'credits', 'commercial')`).all(tagId);
    plex.close();
    const ours = new Map(L.prepare('SELECT mid, text, start_ms, end_ms, source FROM applied').all()
        .map(a => [`${a.mid}|${a.text}|${a.start_ms}|${a.end_ms}`, a.source]));
    const table = {};
    for (const m of marks) {
        const key = `${m.mid}|${m.text}|${m.start}|${m.end}`;
        const src = ours.has(key) ? sourceOf(ours.get(key) ?? 'tidb:') : 'plex';
        table[m.text] ??= { plex: 0, tidb: 0, chapters: 0, introdb: 0, fingerprint: 0, mixed: 0 };
        table[m.text][src]++;
    }
    const live = new Set(marks.map(m => `${m.mid}|${m.text}|${m.start}|${m.end}`));
    const missing = [...ours.keys()].filter(k => !live.has(k)).length;
    const extra = { writtenByUs: ours.size, noLongerInPlex_reappliedNextRun: missing,
                    submittedToTheIntroDB_fromPlex: L.prepare("SELECT count(*) n FROM submissions WHERE status != 'error' AND segment NOT LIKE 'idb:%'").get().n,
                    submittedToIntrodbApp_fromPlex: L.prepare("SELECT count(*) n FROM submissions WHERE status = 'ok' AND segment LIKE 'idb:%'").get().n };
    if (flag('json')) return console.log(JSON.stringify({ markers: table, ...extra }));
    console.log('Markers in Plex by source:');
    console.table(table);
    console.log(extra);
}

// ---------- status ----------
function status() {
    const L = openLedger();
    const one = (sql) => L.prepare(sql).get();
    const out = {
        usage: {
            today: L.prepare("SELECT source, requests FROM usage WHERE day = date('now')").all().map(r => ({ ...r })),
            last7: L.prepare("SELECT source, sum(requests) requests FROM usage WHERE day >= date('now', '-6 days') GROUP BY source").all().map(r => ({ ...r })),
            total: L.prepare('SELECT source, sum(requests) requests, min(day) since FROM usage GROUP BY source').all().map(r => ({ ...r })),
        },
        items: L.prepare('SELECT kind, count(*) n, count(DISTINCT lkey) lookups_needed FROM items GROUP BY kind').all()
            .map(r => ({ ...r })),
        lookups: L.prepare(`SELECT CASE WHEN lkey LIKE 'idb:%' THEN 'introdb' ELSE 'tidb' END source, status, count(*) n
                            FROM lookups GROUP BY 1, 2`).all().map(r => ({ ...r })),
        showsWithData: one(`SELECT count(DISTINCT i.tmdb) n FROM items i JOIN lookups l ON l.lkey=i.lkey
                            WHERE i.kind='ep' AND l.status=200`).n,
        applied: { ...one('SELECT count(DISTINCT mid) items, count(*) markers FROM applied') },
        lastRuns: L.prepare('SELECT cmd, datetime(finished_at, \'unixepoch\') at, summary FROM runs ORDER BY id DESC LIMIT ?')
            .all(Number(opt('runs', 5))).map(r => ({ ...r })),
        // Rolling 24 h request counts + last request per source, and the quota the service last reported.
        requests: L.prepare(`SELECT source, max(ts) last, sum(ts > ?) last24h FROM request_log GROUP BY source`)
            .all(now() - DAY).map(r => ({ ...r })),
        apiState: L.prepare('SELECT source, remaining, usage_reset, at FROM api_state').all().map(r => ({ ...r })),
        hasTidbKey: !!readKey(),
    };
    console.log(flag('json') ? JSON.stringify(out) : out);
}

// ---------- main ----------
const COMMANDS = { inventory, fetch: fetchCmd, plan: planCmd, selftest, status, sources: sourcesCmd,
                   apply: applyCmd, undo: undoCmd, submit: submitCmd, 'submit-introdb': submitIdbCmd };
if (!COMMANDS[cmd]) {
    console.log('usage: tidb-sync.mjs inventory | fetch [--source tidb|introdb] [--budget N] | plan [--policy fill|prefer-tidb] [--no-chapters] [--no-introdb] [--no-fingerprint]\n'
        + '                     plan/apply also: [--no-commercials] [--commercial-sections "Sports,4"]\n'
        + '                     selftest | status | sources\n'
        + '                     apply --yes [--live] [--limit N] [--match TEXT] [--policy ...] [--no-recap] [--no-preview]\n'
        + '                     undo <file> --yes [--live]\n'
        + '                     submit [--yes] [--limit N] [--segment intro|credits] [--json]   (Plex-detected intros + credits -> TheIntroDB; dry run without --yes)\n'
        + '                     submit-introdb [--yes] [--limit N] [--json]   (Plex-detected intros/credits -> introdb.app; dry run without --yes)');
    process.exit(cmd ? 1 : 0);
}
await COMMANDS[cmd]();
