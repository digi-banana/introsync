#!/usr/bin/env node
// fingerprint — IntroSync's fourth source ("method 4"): detect intros/credits on episodes no other source covers, by
// matching a few seconds of each target against a season sibling whose intro is already known (Plex's own marker or
// TheIntroDB). Engine: detector.mjs. Validation history: dumb-populate/tidb/experiment/FINDINGS-v4.md.
//
// Read-only against Plex and the ledger. Writes only its own store ($TIDB_DATA_DIR/fingerprints.db):
//   refs         reference fingerprints per (file, size, speed factor): each season's reference is read ONCE, ever
//   sib_credits  raw credits detection on siblings with known credits (the calibration inputs), per file
//   sib_cards    12 s of 64x36 thumbnails around a sibling's known credits start (the stills method's reference)
//   detections   every outcome per (episode, intro|credits), keyed to the file (path + size): matches are what the
//                plan uses as source "fingerprint"; misses are retried only on a new file, a new detector VERSION,
//                or after 30 days (1 day for read errors)
//   reads        bytes read per UTC day, total and the Real-Debrid part (the usage record; there is no download limit)
//   validation   results of `detect --validate` (episodes WITH known timings, detected blind, compared)
// A replaced file (repair engine, upgrade) has a different path/size, so its stored rows simply stop matching.
//
// Rules (from the v4 validation):
// - Seeds: an intro marker Plex detected itself, else TheIntroDB (not on PAL speed-up files, whose community timings
//   are for the normal-speed cut). introdb.app, chapters and our own detections are never seeds, and neither are
//   PREMIERES (E1): special openings, and a lone pilot entry can be wrong (The Office S1: TheIntroDB's pilot "intro"
//   0:00-0:31 is the Universal logo; E2/E3 matched it perfectly and would have got a logo as their intro).
// - Reference: a same-release, non-premiere sibling with an intro length near the season median.
// - Seasons with short intros (< 24 s) scattered > 90 s apart are skipped (Reacher: never matched, 72-164 MB each).
// - Premieres (E1) search further (160 s of reads, 20 reads) and measure the end from the audio.
// - No seed in the season: the nearest season of the same show, end measured. Season 0 (specials) is skipped.
// - Credits are written ONLY when two same-release non-premiere siblings calibrate within 5 s of each other
//   (single-sibling calibration took Bad Batch from 15 s to 45 s off). A miss never becomes "no intro".
// - Runs while people stream (user, 2026-09-18: reads are fine, only writes to Plex's database must wait; those happen
//   in tidb-sync's apply, which keeps its own streaming check). This tool never writes Plex's database.
//
// usage: fingerprint.mjs detect [--max-minutes 60] [--limit N] [--show TEXT] [--dry-run] [--no-credits]
//                               [--no-chapters] [--no-introdb] [--no-recap] [--no-preview] [--dav-url U] [--dav-user U]
//        fingerprint.mjs detect --validate N [--show TEXT]      (blind test on episodes with known timings)
//        fingerprint.mjs status [--json]  |  selftest
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import * as D from './detector.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

const DATA = process.env.TIDB_DATA_DIR || '/data';
export const CFG = {
    plexDb: process.env.PLEX_DB || '/plex/Plug-in Support/Databases/com.plexapp.plugins.library.db',
    plexPrefs: process.env.PLEX_PREFS || '/plex/Preferences.xml',
    plexUrl: process.env.PLEX_URL || 'http://192.168.0.100:32400',
    ledger: process.env.TIDB_LEDGER || path.join(DATA, 'tidb.db'),
    store: process.env.FP_DB || path.join(DATA, 'fingerprints.db'),
    davUrl: String(opt('dav-url', process.env.FP_WEBDAV_URL || 'http://192.168.0.100:8080')).replace(/\/+$/, ''),
    davUser: opt('dav-user', process.env.FP_WEBDAV_USER || 'admin'),
    davPassFile: process.env.INFINIDYSK_PASSWORD_FILE || path.join(DATA, 'secrets', 'infinidysk_password'),
    decypharrUrl: String(opt('decypharr-url', process.env.FP_DECYPHARR_URL || 'http://192.168.0.100:28282')).replace(/\/+$/, ''),
    debridRoot: process.env.DEBRID_ROOT || '/mnt/debrid',
};
const FP_FORMAT = 1;               // stored reference fingerprint format
const CALIB_AGREE_S = 5, CALIB_MAX_S = 90, CALIB_SIBS = 3, USUAL_TOL_S = 10, DISPERSED_S = 90;
// Credits start is nudged this much LATER: an early marker cuts into the story (and brings up Up Next too soon), a late
// one just shows a few more seconds of credits. v7 validation errors were -2.1..+4.4 s, one -7.3 s.
const CREDITS_SAFETY_S = 2;
// Stills second chance (credits cards, see detector.mjs "stills"): 4 thumbnails a second; a match needs correlation >= 0.8,
// 0.2 clear of the runner-up, and two siblings agreeing within 1.5 s.
const STILL_FPS = 4, CARD_MIN = 0.8, CARD_MARGIN = 0.2, CARD_AGREE_S = 1.5, CARDS_VERSION = 1;
// Where the "first text frame" method gives up, the stills method gets a second chance.
const STILLS_FOR = new Set(['calibration-disagrees', 'no-calibration', 'off-pattern', 'no-credits-block', 'no-start-edge', 'implausible']);
const SIB_VERSION = 6;             // how sibling calibrations are measured (hint from the OTHER siblings since v6)
const RETRY = { miss: 30 * DAY, 'read-error': DAY };
// A round stops after this many episodes in a row that couldn't be read (backend down): don't mark the library "missed".
const MAX_FAILED_EPISODES = 5;

// ---------- store ----------
export function openStore(file = CFG.store) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA busy_timeout=15000;
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS refs(file TEXT, size INTEGER, k REAL, truth TEXT, intro_start REAL, intro_len REAL, zero_start INTEGER,
            core0 INTEGER, core1 INTEGER, fp BLOB, format INTEGER, created INTEGER, PRIMARY KEY(file, size, k));
        CREATE TABLE IF NOT EXISTS sib_credits(file TEXT, size INTEGER, truth REAL, status TEXT, raw REAL, version INTEGER, created INTEGER,
            PRIMARY KEY(file, size));
        CREATE TABLE IF NOT EXISTS detections(mid INTEGER, kind TEXT, file TEXT, size INTEGER, status TEXT, start_ms INTEGER, end_ms INTEGER,
            final INTEGER, detail TEXT, bytes INTEGER, version INTEGER, at INTEGER, PRIMARY KEY(mid, kind));
        CREATE TABLE IF NOT EXISTS reads(day TEXT PRIMARY KEY, bytes INTEGER DEFAULT 0, episodes INTEGER DEFAULT 0, refs INTEGER DEFAULT 0,
            calib INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS validation(run TEXT, mid INTEGER, kind TEXT, label TEXT, status TEXT, start REAL, "end" REAL,
            truth_start REAL, truth_end REAL, err REAL, detail TEXT, bytes INTEGER, at INTEGER);
        CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);`);
    db.exec(`CREATE TABLE IF NOT EXISTS sib_cards(file TEXT, size INTEGER, truth REAL, t0 REAL, fps REAL, n INTEGER, frames BLOB, version INTEGER,
                 created INTEGER, PRIMARY KEY(file, size))`);
    for (const [t, c] of [['sib_credits', 'hint REAL'], ['reads', 'rd_bytes INTEGER DEFAULT 0']]) {
        try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch { /* already there */ }
    }
    return db;
}
const day = () => new Date().toISOString().slice(0, 10);

// ---------- library model (read-only: Plex DB + ledger + store) ----------
// Mirrors tidb-sync.mjs chapterSegments(): which chapter names count, and where. Used only to know what the plan
// will already cover (so no reads are spent there); the plan itself stays the authority.
const CHAPTER_RX = {
    intro: /^(intro|opening|opening credits|opening titles?|opening theme|title sequence|main titles?|theme|theme song|op)$/i,
    recap: /^(recap|previously|previously on|last time|last time on)$/i,
    credits: /^(credits|end credits|ending credits|closing credits|end titles?|ending|outro|ed)$/i,
    preview: /^(preview|next episode|next time|next time on|coming up|coming up next|next week|next week on)$/i,
};
function chapterTypes(x, durMs) {
    let ch; try { ch = JSON.parse(JSON.parse(x)['pv:chapters']).Chapters?.Chapter; } catch { return new Set(); }
    const out = new Set();
    if (!Array.isArray(ch) || ch.length < 2) return out;
    for (const c of ch) {
        const type = Object.keys(CHAPTER_RX).find(k => CHAPTER_RX[k].test(String(c.name ?? '').trim().replace(/[.…:!]+$/, '')));
        if (!type) continue;
        const start = c.start * 1000, len = (c.end - c.start) * 1000;
        const ok = type === 'intro' ? start <= durMs * 0.35 && len >= 5000 && len <= 150000
            : type === 'recap' ? start <= durMs * 0.35 && len >= 5000 && len <= 300000
            : start >= durMs * 0.6 && len >= 5000 && len <= 1800000;
        if (ok) out.add(type);
    }
    return out;
}
// Source + frame rate from the Sonarr file name ("[WEBDL-1080p]", "[Bluray-2160p Remux]"): same-release siblings share
// intro edits and credits offsets.
const relOf = (file, fps) => {
    const src = (file.match(/\[(Bluray|Remux|WEBDL|WEB-DL|WEBRip|HDTV|DVD)/i)?.[1] ?? '?').toLowerCase().replace(/web-?dl|webrip/, 'web').replace('remux', 'bluray');
    return `${src}@${Math.round((fps ?? 0) * 1000) / 1000}`;
};

export function loadLibrary(o) {
    const P = new DatabaseSync(CFG.plexDb, { readOnly: true });
    P.exec('PRAGMA busy_timeout=30000');
    const tag = P.prepare('SELECT id FROM tags WHERE tag_type = 12 ORDER BY id LIMIT 1').get()?.id;
    const rows = P.prepare(`SELECT e.id mid, e."index" ep, e.guid, se.id season_id, se."index" season, sh.id show_id, sh.title show
        FROM metadata_items e JOIN metadata_items se ON se.id = e.parent_id JOIN metadata_items sh ON sh.id = se.parent_id
        WHERE e.metadata_type = 4 AND e.deleted_at IS NULL`).all();
    const media = new Map();
    for (const m of P.prepare(`SELECT mi.metadata_item_id mid, mi.duration dur, mi.frames_per_second fps, mp.file, mp.size
            FROM media_items mi JOIN media_parts mp ON mp.media_item_id = mi.id JOIN metadata_items e ON e.id = mi.metadata_item_id
            WHERE e.metadata_type = 4 AND mi.deleted_at IS NULL AND mp.deleted_at IS NULL`).all()) {
        if (!media.has(m.mid)) media.set(m.mid, []);
        media.get(m.mid).push(m);
    }
    const chapters = new Map();
    if (o.useChapters) {
        for (const r of P.prepare(`SELECT mi.metadata_item_id mid, mi.duration dur, mp.extra_data x FROM media_items mi
                JOIN media_parts mp ON mp.media_item_id = mi.id WHERE mp.extra_data LIKE '%pv:chapters%'`).all()) chapters.set(r.mid, chapterTypes(r.x, r.dur));
    }
    const marks = new Map();
    if (tag) for (const m of P.prepare(`SELECT metadata_item_id mid, text, time_offset s, end_time_offset e FROM taggings
            WHERE tag_id = ? AND text IN ('intro', 'credits') ORDER BY time_offset`).all(tag)) {
        if (!marks.has(m.mid)) marks.set(m.mid, []);
        marks.get(m.mid).push(m);
    }
    const viewed = new Map(P.prepare(`SELECT guid, max(last_viewed_at) t FROM metadata_item_settings
            WHERE last_viewed_at IS NOT NULL GROUP BY guid`).all().map(r => [r.guid, r.t]));
    P.close();

    const L = new DatabaseSync(CFG.ledger, { readOnly: true });
    L.exec('PRAGMA busy_timeout=15000');
    const ours = new Set(L.prepare('SELECT mid, text, start_ms, end_ms FROM applied').all().map(a => `${a.mid}|${a.text}|${a.start_ms}|${a.end_ms}`));
    const bodies = new Map(L.prepare(`SELECT i.mid, t.body tbody, d.body ibody FROM items i
            LEFT JOIN lookups t ON t.lkey = i.lkey AND t.status = 200 LEFT JOIN lookups d ON d.lkey = i.ikey AND d.status = 200
            WHERE i.kind = 'ep' AND (t.body IS NOT NULL OR d.body IS NOT NULL)`).all().map(r => [r.mid, r]));
    L.close();

    const seasons = new Map(), shows = new Map();
    for (const r of rows) {
        const ms = media.get(r.mid) ?? [];
        const m = ms.length === 1 && ms[0].dur > 0 ? ms[0] : null;      // one version, one part: timings are unambiguous
        const ep = { mid: r.mid, ep: r.ep, season: r.season, seasonId: r.season_id, showId: r.show_id, show: r.show ?? '?',
                     label: `${r.show ?? '?'} S${String(r.season).padStart(2, '0')}E${String(r.ep).padStart(2, '0')}`,
                     file: m?.file ?? null, size: m?.size ?? null, dur: m ? m.dur / 1000 : null, fps: m?.fps ?? 0,
                     rel: m ? relOf(m.file, m.fps) : '?', multi: ms.length > 1, marks: marks.get(r.mid) ?? [],
                     chapters: chapters.get(r.mid) ?? new Set(), body: bodies.get(r.mid) ?? null };
        if (!seasons.has(r.season_id)) seasons.set(r.season_id, { id: r.season_id, season: r.season, showId: r.show_id, eps: [] });
        seasons.get(r.season_id).eps.push(ep);
        if (!shows.has(r.show_id)) shows.set(r.show_id, { id: r.show_id, title: r.show ?? '?', seasons: [], viewed: 0 });
        const sh = shows.get(r.show_id);
        sh.viewed = Math.max(sh.viewed, viewed.get(r.guid) ?? 0);
    }
    for (const s of seasons.values()) {
        shows.get(s.showId).seasons.push(s);
        // PAL guard (same rule as tidb-sync's plan): a 25/50 fps file in a mostly 23.976/24 fps season is a speed-up.
        const withFps = s.eps.filter(e => e.fps > 0);
        for (const e of s.eps) {
            const sib = withFps.filter(x => x !== e);
            e.spedUp = D.isPal(e.fps) && sib.length > 0 && sib.filter(x => D.isFilm(x.fps)).length / sib.length >= 0.5;
            deriveTruth(e, ours, o);
        }
    }
    return { seasons, shows };
}

// Known timings (seeds / calibration) and what the plan will already cover, per episode.
function deriveTruth(e, ours, o) {
    const own = e.marks.filter(m => !ours.has(`${e.mid}|${m.text}|${m.s}|${m.e}`));
    const durMs = (e.dur ?? 0) * 1000;
    let tb = null, ib = null;
    try { tb = e.body?.tbody ? JSON.parse(e.body.tbody) : null; } catch { }
    try { ib = e.body?.ibody ? JSON.parse(e.body.ibody) : null; } catch { }
    if (e.spedUp) { tb = null; ib = null; }
    const pi = own.find(m => m.text === 'intro' && m.e - m.s >= 5000 && m.e - m.s <= 200000 && (!durMs || m.s < durMs * 0.5));
    const ti = tb?.intro?.[0]?.end_ms ? tb.intro[0] : null;
    e.truthIntro = pi ? { start: pi.s / 1000, end: pi.e / 1000, src: 'plex' }
        : ti && ti.end_ms - (ti.start_ms ?? 0) >= 5000 ? { start: (ti.start_ms ?? 0) / 1000, end: ti.end_ms / 1000, src: 'tidb' } : null;
    const pc = own.find(m => m.text === 'credits' && durMs && m.s >= durMs * 0.5);
    const tc = tb?.credits?.[0]?.start_ms;
    e.truthCredits = pc ? pc.s / 1000 : tc != null && (!durMs || tc >= durMs * 0.5) ? tc / 1000 : null;
    // where those credits end (TheIntroDB's open end = the end of the file)
    e.truthCreditsEnd = e.truthCredits == null ? null : pc ? pc.e / 1000 : (tb?.credits?.[0]?.end_ms ?? durMs) / 1000;
    const has = (b, k) => !!b?.[k]?.length && b[k].some(s => s.end_ms != null || s.start_ms != null);
    e.covered = {
        intro: e.marks.some(m => m.text === 'intro') || has(tb, 'intro') || (o.mapRecap && has(tb, 'recap'))
            || (o.useIntrodb && (ib?.intro?.end_ms > 0 || (o.mapRecap && ib?.recap?.end_ms > 0)))
            || (o.useChapters && (e.chapters.has('intro') || (o.mapRecap && e.chapters.has('recap')))),
        credits: e.marks.some(m => m.text === 'credits') || has(tb, 'credits') || (o.mapPreview && has(tb, 'preview'))
            || (o.useIntrodb && ib?.outro?.end_ms > 0)
            || (o.useChapters && (e.chapters.has('credits') || (o.mapPreview && e.chapters.has('preview')))),
    };
}

// ---------- detection run ----------
async function davCheck(password) {
    try {
        const r = await fetch(`${CFG.davUrl}/`, { method: 'PROPFIND', headers: { Depth: '0', Authorization: 'Basic ' + Buffer.from(`${CFG.davUser}:${password}`).toString('base64') },
                                                  signal: AbortSignal.timeout(15_000) });
        return r.status === 401 || r.status === 403 ? 'bad-password' : r.status >= 500 ? 'webdav-unreachable' : 'ok';
    } catch { return 'webdav-unreachable'; }
}

async function detectCmd() {
    const t0 = Date.now();
    const o = { useChapters: !flag('no-chapters'), useIntrodb: !flag('no-introdb'), mapRecap: !flag('no-recap'), mapPreview: !flag('no-preview'),
                credits: !flag('no-credits'), dryRun: flag('dry-run'), validate: Number(opt('validate', 0)), show: opt('show', null),
                limit: Number(opt('limit', 0)), maxMs: Number(opt('max-minutes', 60)) * 60_000, only: opt('only', null) };
    const summary = { intro: {}, credits: {}, skipped: {}, bytes: 0, episodes: 0, refsBuilt: 0, calibMeasured: 0, cardsMeasured: 0, stopped: null, queue: null };
    const finish = (stopped) => {
        summary.stopped = stopped; summary.minutes = +((Date.now() - t0) / 60000).toFixed(1);
        try { const S = openStore(); S.prepare('INSERT OR REPLACE INTO state(key, value) VALUES (?, ?)').run(o.validate ? 'lastValidate' : 'lastRun', JSON.stringify({ at: now(), ...summary })); S.close(); } catch { }
        log('fingerprint', o.validate ? 'validate' : 'detect', 'finished:', stopped);
        console.log(JSON.stringify(summary));
    };
    let password = null;
    try { password = fs.readFileSync(CFG.davPassFile, 'utf8').trim() || null; } catch { }
    if (!password) return finish('no-password');
    const dav = await davCheck(password);
    if (dav !== 'ok') return finish(dav);

    // Real-Debrid files (decypharr's WebDAV, no auth): optional. Unreachable = those files are skipped this round.
    let decypharrUrl = CFG.decypharrUrl || null;
    if (decypharrUrl) {
        try {
            const r = await fetch(`${decypharrUrl}/webdav/`, { method: 'PROPFIND', headers: { Depth: '0' }, signal: AbortSignal.timeout(10_000) });
            if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
        } catch (e) { log(`decypharr WebDAV not reachable at ${decypharrUrl} (${e.message}); Real-Debrid files are skipped this round`); decypharrUrl = null; }
    }
    const lib = loadLibrary(o);
    const S = openStore();
    const rd = await D.createReader({ davUrl: CFG.davUrl, davUser: CFG.davUser, davPassword: password, decypharrUrl, debridRoot: CFG.debridRoot });
    const q = {
        ref: S.prepare('SELECT * FROM refs WHERE file = ? AND size = ? AND k = ?'),
        putRef: S.prepare(`INSERT OR REPLACE INTO refs(file, size, k, truth, intro_start, intro_len, zero_start, core0, core1, fp, format, created)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
        sib: S.prepare('SELECT * FROM sib_credits WHERE file = ? AND size = ?'),
        cards: S.prepare('SELECT * FROM sib_cards WHERE file = ? AND size = ?'),
        putCards: S.prepare('INSERT OR REPLACE INTO sib_cards(file, size, truth, t0, fps, n, frames, version, created) VALUES (?,?,?,?,?,?,?,?,?)'),
        putSib: S.prepare('INSERT OR REPLACE INTO sib_credits(file, size, truth, status, raw, version, created, hint) VALUES (?,?,?,?,?,?,?,?)'),
        det: S.prepare('SELECT * FROM detections WHERE mid = ? AND kind = ?'),
        putDet: S.prepare(`INSERT OR REPLACE INTO detections(mid, kind, file, size, status, start_ms, end_ms, final, detail, bytes, version, at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
        seasonDets: S.prepare("SELECT mid, start_ms FROM detections WHERE kind = 'intro' AND status = 'match'"),
        addReads: S.prepare(`INSERT INTO reads(day, bytes, episodes, refs, calib, rd_bytes) VALUES (?,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET
                             bytes = bytes + excluded.bytes, episodes = episodes + excluded.episodes, refs = refs + excluded.refs, calib = calib + excluded.calib,
                             rd_bytes = rd_bytes + excluded.rd_bytes`),
        putVal: S.prepare(`INSERT INTO validation(run, mid, kind, label, status, start, "end", truth_start, truth_end, err, detail, bytes, at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    };
    const detected = new Map(q.seasonDets.all().map(r => [r.mid, r.start_ms / 1000]));
    const readable = (e) => !!(e.file && !e.multi && e.dur > 0 && rd.urlFor(e.file));
    const bump = (k, st) => { summary[k][st] = (summary[k][st] ?? 0) + 1; };
    const skip = (why) => { summary.skipped[why] = (summary.skipped[why] ?? 0) + 1; };

    // stored outcome still valid for this file? (matches: always; misses: until a retry is due)
    const settled = (e, kind) => {
        const d = q.det.get(e.mid, kind);
        if (!d || d.file !== e.file || d.size !== e.size) return false;
        if (d.status === 'match' || d.status === 'found') return true;
        if (d.version !== D.VERSION) return false;
        return now() - d.at < (d.status === 'read-error' || d.status === 'ref-error' ? RETRY['read-error'] : RETRY.miss);
    };

    async function reference(ep, k) {
        const truth = `${ep.truthIntro.start.toFixed(3)}-${ep.truthIntro.end.toFixed(3)}`;
        const row = q.ref.get(ep.file, ep.size, k);
        if (row && row.truth === truth && row.format === FP_FORMAT) {
            return { R: D.blobToRef(row.fp), k, introStart: row.intro_start, introLen: row.intro_len, core: [row.core0, row.core1], zeroStart: !!row.zero_start, cached: true };
        }
        const ref = await D.buildReference(rd, rd.urlFor(ep.file), ep.truthIntro, k);
        summary.refsBuilt++;
        if (ref) q.putRef.run(ep.file, ep.size, k, truth, ref.introStart, ref.introLen, ref.zeroStart ? 1 : 0, ref.core[0], ref.core[1], D.refToBlob(ref.R), FP_FORMAT, now());
        return ref;
    }
    // Calibration input: truth - raw detection on a sibling with known credits (seconds; null = no usable measurement).
    // The sibling is measured EXACTLY as a target would be, with a position hint from the OTHER siblings, never its own
    // known position: measuring with its own truth as the hint (v5 first cut) made siblings agree while the targets came
    // out 17-23 s late (TLOU, credits over artwork). Cached per file; re-measured if the hint moves by more than 10 s.
    async function sibOffset(sib, hint) {
        const row = q.sib.get(sib.file, sib.size);
        if (row && row.version === SIB_VERSION && Math.abs(row.truth - sib.truthCredits) < 0.01 && row.hint != null && Math.abs(row.hint - hint) <= 10)
            return row.status === 'found' ? row.truth - row.raw : null;
        const r = await D.findCredits(rd, rd.urlFor(sib.file), sib.dur, hint);
        summary.calibMeasured++;
        const ok = r.status === 'found' && Math.abs(sib.truthCredits - r.start) <= CALIB_MAX_S;
        q.putSib.run(sib.file, sib.size, sib.truthCredits, ok ? 'found' : r.status === 'found' ? 'far' : r.status, r.start ?? null, SIB_VERSION, now(), hint);
        return ok ? sib.truthCredits - r.start : null;
    }

    async function doIntro(season, t, exclude) {
        const seedOk = (e) => e !== t && e.ep !== 1 && !exclude.has(e.mid) && e.truthIntro && readable(e);
        let seeds = season.eps.filter(seedOk);
        let cross = false;
        if (!seeds.length) {
            const others = lib.shows.get(season.showId).seasons.filter(s => s !== season && s.season > 0)
                .sort((a, b) => Math.abs(a.season - season.season) - Math.abs(b.season - season.season));
            for (const s of others) { seeds = s.eps.filter(seedOk); if (seeds.length) { cross = true; break; } }
        }
        if (!seeds.length) return { status: 'skip', why: 'no-seed' };
        const lens = seeds.map(e => e.truthIntro.end - e.truthIntro.start).sort((a, b) => a - b), med = lens[Math.floor(lens.length / 2)];
        const starts = seeds.map(e => e.truthIntro.start / D.speedOf(e.fps, t.fps));
        if (med < D.SHORT_INTRO_S && seeds.length >= 2 && Math.max(...starts) - Math.min(...starts) > DISPERSED_S) return { status: 'skip', why: 'dispersed' };
        const score = (e) => (e.rel === t.rel ? 0 : 1000) + Math.abs(e.truthIntro.end - e.truthIntro.start - med);
        const refEp = [...seeds].sort((a, b) => score(a) - score(b))[0];
        const k = D.speedOf(refEp.fps, t.fps);
        const ref = await reference(refEp, k);
        if (!ref) return { status: 'ref-error', detail: { ref: refEp.label } };
        const hintStarts = [...starts, ...(cross ? [] : season.eps.filter(e => e !== t && !exclude.has(e.mid) && detected.has(e.mid)).map(e => detected.get(e.mid)))];
        const hints = D.hintsFor(hintStarts, ref.introStart);
        const premiere = t.ep === 1;
        const measure = premiere || cross;
        const r = await D.findIntro(rd, rd.urlFor(t.file), t.dur, ref, hints, premiere && ref.introLen >= 40 ? { budgetS: 160, maxReads: 20, measure } : { measure });
        const detail = { how: r.how, reads: r.reads?.length ?? 0, readS: r.readS, ref: refEp.label, refRel: refEp.rel, refCached: !!ref.cached, k: +k.toFixed(4),
                         cross, measuredStart: r.measuredStart, measuredEnd: r.measuredEnd, hints: hints.slice(0, 5).map(h => +h.toFixed(1)) };
        if (r.status !== 'match') return { status: r.status === 'read-error' ? 'read-error' : 'miss', why: r.status, detail };
        if (r.end - r.start < 5 || r.start > t.dur * 0.5) return { status: 'miss', why: 'implausible', detail: { ...detail, start: r.start, end: r.end } };
        return { status: 'match', start: r.start, end: r.end, final: 0, detail };
    }

    // Credits are written only where the season's credits behave the same everywhere. Blind validation (v6): The Last of
    // Us S1's sibling offsets split into ~0 s and ~-17 s groups, so any two siblings could agree while a target from the
    // other group came out 17 s off; FROM S1E1/E2 raw detections were 55 s early / 64 s late. An EARLY credits marker skips
    // story and brings up Up Next before the ending, so both checks are strict:
    //   1. calibration: the 3 nearest same-release non-premiere siblings (at least 2 usable) all within 5 s of each other
    //   2. plausibility: the target's calibrated start lies within 10 s of the siblings' usual position before the end
    const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const fromEndOf = (list) => median(list.map(e => e.dur - e.truthCredits));   // seconds before EOF

    async function doCredits(season, t, exclude) {
        const sibs = season.eps.filter(e => e !== t && !exclude.has(e.mid) && e.truthCredits != null && e.rel === t.rel && e.ep !== 1 && readable(e))
            .sort((a, b) => Math.abs(a.ep - t.ep) - Math.abs(b.ep - t.ep));
        if (sibs.length < 2) return { status: 'skip', why: 'no-calibration' };
        const r = await creditsByText(t, sibs);
        if (r.status === 'found' || !STILLS_FOR.has(r.why)) return r;
        const s = await creditsByStills(t, sibs, r);
        return s.status === 'found' ? s : { ...r, detail: { ...(r.detail ?? {}), stills: s.why } };
    }

    async function creditsByText(t, sibs) {
        const offs = [];
        for (const s of sibs.slice(0, CALIB_SIBS)) {
            const off = await sibOffset(s, fromEndOf(sibs.filter(e => e !== s)));
            if (off != null) offs.push({ ep: s.ep, off });
        }
        if (offs.length < 2) return { status: 'skip', why: 'no-calibration', detail: { offs } };
        const spread = Math.max(...offs.map(o => o.off)) - Math.min(...offs.map(o => o.off));
        if (spread > CALIB_AGREE_S) return { status: 'skip', why: 'calibration-disagrees', detail: { offs } };
        const offset = median(offs.map(o => o.off)), usual = fromEndOf(sibs);
        const r = await D.findCredits(rd, rd.urlFor(t.file), t.dur, usual);
        const detail = { raw: r.start ?? null, offset: +offset.toFixed(2), calib: offs.map(p => `E${p.ep}:${p.off.toFixed(1)}`), usualFromEnd: +usual.toFixed(1),
                         probes: r.probes, pattern: r.pattern };
        if (r.status !== 'found') return { status: r.status === 'read-error' ? 'read-error' : 'miss', why: r.status, detail };
        const start = r.start + offset + CREDITS_SAFETY_S, end = r.final ? t.dur : r.end;
        if (start < t.dur * 0.5 || end - start < 5) return { status: 'miss', why: 'implausible', detail: { ...detail, start, end } };
        if (Math.abs(t.dur - start - usual) > USUAL_TOL_S + CREDITS_SAFETY_S) return { status: 'miss', why: 'off-pattern', detail: { ...detail, start, fromEnd: +(t.dur - start).toFixed(1) } };
        return { status: 'found', start, end, final: r.final ? 1 : 0, detail };
    }

    // The sibling's thumbnails around its known credits start: decoded once, then from the store.
    async function sibCards(s) {
        const row = q.cards.get(s.file, s.size);
        if (row && row.version === CARDS_VERSION && Math.abs(row.truth - s.truthCredits) < 0.01) {
            const buf = Buffer.from(row.frames), n = D.TW * D.TH;
            return { t0: row.t0, fps: row.fps, truth: row.truth, frames: Array.from({ length: row.n }, (_, i) => new Uint8Array(buf.subarray(i * n, (i + 1) * n))) };
        }
        const sq = await rd.seq(rd.urlFor(s.file), s.truthCredits - 3, 3 + D.CARD_S + 1, STILL_FPS);
        summary.cardsMeasured++;
        q.putCards.run(s.file, s.size, s.truthCredits, sq.t0, sq.fps, sq.frames.length, Buffer.concat(sq.frames.map(f => Buffer.from(f))), CARDS_VERSION, now());
        return { ...sq, truth: s.truthCredits };
    }

    // Second chance: find the siblings' opening credits cards in the target. Only seasons whose cards are distinctive
    // (unlike the story just before them) and consistent (sibling A's cards find sibling B's known start within 1.5 s);
    // written only when two such siblings put the target's start within 1.5 s of each other.
    async function creditsByStills(t, sibs, first) {
        const refs = [];
        for (const s of sibs.slice(0, CALIB_SIBS)) {
            const c = await sibCards(s);
            if (c.frames.length && D.distinctive(c)) refs.push({ s, c });
        }
        if (refs.length < 2) return { status: 'skip', why: 'stills-not-distinctive' };
        const ok = new Set();
        for (const a of refs) for (const b of refs) {
            if (a === b) continue;
            const m = D.alignCards(a.c, b.c);
            if (m && m.score >= CARD_MIN && Math.abs(m.start - b.c.truth) <= CARD_AGREE_S) { ok.add(a); ok.add(b); }
        }
        if (ok.size < 2) return { status: 'skip', why: 'stills-inconsistent' };
        // Search around the season's usual position (and the text method's estimate, when it had one close by)
        const usual = fromEndOf(sibs), expect = [t.dur - usual];
        const est = first.detail?.raw != null ? first.detail.raw + (first.detail.offset ?? 0) : null;
        if (est != null && Math.abs(est - expect[0]) <= 45) expect.push(est);
        const w0 = Math.max(t.dur * 0.5, Math.min(...expect) - 30), w1 = Math.min(t.dur, Math.max(...expect) + 30 + D.CARD_S);
        if (w1 - w0 < D.CARD_S + 2) return { status: 'skip', why: 'stills-window' };
        const tgt = await rd.seq(rd.urlFor(t.file), w0, w1 - w0, STILL_FPS);
        const preds = [...ok].map(r => ({ ep: r.s.ep, ...(D.alignCards(r.c, tgt) ?? { score: -1, second: -1 }) }))
            .filter(p => p.score >= CARD_MIN && p.score - p.second >= CARD_MARGIN);
        const detail = { method: 'stills', preds: preds.map(p => `E${p.ep}:${p.start.toFixed(1)}@${p.score.toFixed(2)}`), window: [+w0.toFixed(0), +w1.toFixed(0)],
                         first: first.why };
        if (preds.length < 2) return { status: 'skip', why: 'stills-no-match', detail };
        const mid = median(preds.map(p => p.start));
        const agree = preds.filter(p => Math.abs(p.start - mid) <= CARD_AGREE_S);
        if (agree.length < 2) return { status: 'skip', why: 'stills-disagree', detail };
        const start = median(agree.map(p => p.start)) + CREDITS_SAFETY_S;
        // End: the text method's block end if it found one; else like the siblings (to EOF only if all of theirs are)
        const toEof = [...ok].every(r => r.s.truthCreditsEnd >= r.s.dur - 2);
        const lens = [...ok].map(r => r.s.truthCreditsEnd - r.s.truthCredits);
        const end = toEof ? t.dur : Math.min(t.dur, start + Math.min(...lens));
        if (start < t.dur * 0.5 || end - start < 5) return { status: 'skip', why: 'stills-implausible', detail };
        return { status: 'found', start, end, final: toEof ? 1 : 0, detail };
    }

    // ---------- queue ----------
    const showRx = o.show ? new RegExp(o.show.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const shows = [...lib.shows.values()].filter(s => !showRx || showRx.test(s.title))
        .sort((a, b) => (b.viewed - a.viewed) || a.title.localeCompare(b.title));
    const hasSeed = (season, t) => season.eps.some(e => e !== t && e.ep !== 1 && e.truthIntro)
        || lib.shows.get(season.showId).seasons.some(s => s !== season && s.season > 0 && s.eps.some(e => e.ep !== 1 && e.truthIntro));
    const work = [];
    for (const sh of shows) for (const season of [...sh.seasons].sort((a, b) => a.season - b.season)) {
        if (season.season <= 0) continue;
        for (const t of [...season.eps].sort((a, b) => a.ep - b.ep)) {
            if (o.validate) {
                const kinds = [t.truthIntro && o.only !== 'credits' ? 'intro' : null, o.credits && o.only !== 'intro' && t.truthCredits != null ? 'credits' : null].filter(Boolean);
                if (kinds.length && t.file && !t.multi) work.push({ season, t, kinds });
                continue;
            }
            // Only what can actually be worked on: a seed somewhere in the show (intros), two same-release non-premiere
            // siblings with known credits (credits). Whether the files are on InfiniDysk is checked when processed.
            const kinds = [];
            if (!t.covered.intro && hasSeed(season, t) && !settled(t, 'intro')) kinds.push('intro');
            if (o.credits && !t.covered.credits && season.eps.filter(e => e !== t && e.truthCredits != null && e.rel === t.rel && e.ep !== 1).length >= 2
                && !settled(t, 'credits')) kinds.push('credits');
            if (kinds.length && t.file && !t.multi) work.push({ season, t, kinds });
        }
    }
    let list = work;
    if (o.validate) {   // spread the blind test over seasons: at most 3 episodes per season, seasons with >= 3 known intros
        const per = new Map();
        list = work.filter(w => w.season.eps.filter(e => e.truthIntro).length >= 3 && (per.set(w.season.id, (per.get(w.season.id) ?? 0) + 1).get(w.season.id) <= 3))
            .slice(0, o.validate);
    }
    summary.queue = { episodes: list.length, intro: list.filter(w => w.kinds.includes('intro')).length, credits: list.filter(w => w.kinds.includes('credits')).length };
    log(`fingerprint ${o.validate ? `validate (${list.length} known episodes, blind)` : 'detect'}: ${summary.queue.intro} intro and ${summary.queue.credits} credits targets${o.dryRun ? ' (dry run: nothing stored as detections)' : ''}`);
    const runId = new Date().toISOString();

    let stopped = 'done', failedInRow = 0;
    for (const w of list) {
        if (Date.now() - t0 > o.maxMs) { stopped = 'time'; break; }
        if (o.limit && summary.episodes >= o.limit) { stopped = 'limit'; break; }
        const { season, t } = w;
        if (!readable(t)) { skip(t.multi ? 'multi-version' : `unreadable-${rd.backendOf(t.file)}`); continue; }
        const exclude = new Set(o.validate ? [t.mid] : []);
        const e0 = { bytes: rd.stat.bytes, rd: rd.stat.by.decypharr, refs: summary.refsBuilt, calib: summary.calibMeasured, auth: rd.stat.authErrors };
        const line = [];
        let readFailed = false;
        for (const kind of w.kinds) {
            const b0 = rd.stat.bytes, re0 = rd.stat.readErrors;
            let r;
            try { r = kind === 'intro' ? await doIntro(season, t, exclude) : await doCredits(season, t, exclude); }
            catch (e) { r = { status: 'read-error', why: String(e?.message ?? e).slice(0, 120) }; }
            // Login refused mid-round (password changed): store nothing for this episode and stop the round.
            if (rd.stat.authErrors > e0.auth) break;
            const bytes = rd.stat.bytes - b0;
            // An outcome caused by failed reads is a read error (retried tomorrow), not a real miss (retried in 30 days).
            if (r.status !== 'match' && r.status !== 'found' && r.status !== 'skip' && rd.stat.readErrors > re0) r = { ...r, status: 'read-error', why: r.why ?? r.status };
            if (r.status === 'read-error' || r.status === 'ref-error') readFailed = true;
            if (r.status === 'skip') { skip(r.why); line.push(`${kind} skip (${r.why}${r.detail?.stills ? `; stills: ${r.detail.stills}` : ''})`); continue; }
            bump(kind, r.status);
            const detail = JSON.stringify({ why: r.why, ...(r.detail ?? {}) });
            if (o.validate) {
                const ts = kind === 'intro' ? t.truthIntro.start : t.truthCredits, te = kind === 'intro' ? t.truthIntro.end : null;
                const err = r.start == null ? null : kind === 'intro' ? Math.max(Math.abs(r.start - ts), Math.abs(r.end - te)) : Math.abs(r.start - ts);
                q.putVal.run(runId, t.mid, kind, t.label, r.status, r.start ?? null, r.end ?? null, ts, te, err, detail, bytes, now());
                line.push(`${kind} ${r.status}${r.detail?.method === 'stills' ? ' [stills]' : ''}${err != null ? ` err ${err.toFixed(2)}s` : r.why ? ` (${r.why}${r.detail?.stills ? `; stills: ${r.detail.stills}` : ''})` : ''}`);
            } else {
                if (!o.dryRun) q.putDet.run(t.mid, kind, t.file, t.size, r.status, r.start != null ? Math.round(r.start * 1000) : null,
                                            r.end != null ? Math.round(r.end * 1000) : null, r.final ?? 0, detail, bytes, D.VERSION, now());
                if (kind === 'intro' && r.status === 'match') detected.set(t.mid, r.start);
                line.push(`${kind} ${r.status}${r.start != null ? ` ${r.start.toFixed(1)}-${r.end.toFixed(1)}` : r.why ? ` (${r.why})` : ''}`);
            }
        }
        if (rd.stat.authErrors > e0.auth) { stopped = 'bad-password'; log(`  ${t.label}: the backend refused the login; stopping (nothing stored for it)`); break; }
        failedInRow = readFailed ? failedInRow + 1 : 0;
        summary.episodes++;
        // everything read for this episode, including a new reference or sibling calibration it needed
        q.addReads.run(day(), rd.stat.bytes - e0.bytes, 1, summary.refsBuilt - e0.refs, summary.calibMeasured - e0.calib, rd.stat.by.decypharr - e0.rd);
        log(`  ${t.label} [${t.rel}]: ${line.join(' | ')}`);
        if (failedInRow >= MAX_FAILED_EPISODES) { stopped = 'read-errors'; log(`  ${failedInRow} episodes in a row couldn't be read; stopping this round`); break; }
    }
    summary.bytes = rd.stat.bytes;
    summary.bytesBy = { ...rd.stat.by };
    summary.readErrors = rd.stat.readErrors;
    rd.close();
    S.close();
    if (o.validate) summary.validation = runId;
    finish(stopped);
}

// ---------- status ----------
function statusCmd() {
    const S = openStore();
    const out = {
        detections: S.prepare('SELECT kind, status, count(*) n FROM detections GROUP BY kind, status').all().map(r => ({ ...r })),
        reads: {
            today: { ...(S.prepare('SELECT bytes, rd_bytes, episodes, refs, calib FROM reads WHERE day = ?').get(day()) ?? { bytes: 0, rd_bytes: 0, episodes: 0, refs: 0, calib: 0 }) },
            last7: { ...S.prepare("SELECT coalesce(sum(bytes),0) bytes, coalesce(sum(episodes),0) episodes FROM reads WHERE day >= date('now', '-6 days')").get() },
            total: { ...S.prepare('SELECT coalesce(sum(bytes),0) bytes, coalesce(sum(episodes),0) episodes, min(day) since FROM reads').get() },
        },
        refs: S.prepare('SELECT count(*) n, coalesce(sum(length(fp)),0) bytes FROM refs').get().n,
        calibrations: S.prepare('SELECT count(*) n FROM sib_credits').get().n,
        lastRun: JSON.parse(S.prepare("SELECT value FROM state WHERE key = 'lastRun'").get()?.value ?? 'null'),
        lastValidate: JSON.parse(S.prepare("SELECT value FROM state WHERE key = 'lastValidate'").get()?.value ?? 'null'),
    };
    S.close();
    console.log(flag('json') ? JSON.stringify(out) : out);
}

function selftestCmd() {
    const r = D.selftest();
    for (const [name, ok] of r) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    process.exitCode = r.every(x => x[1]) ? 0 : 1;
}

const COMMANDS = { detect: detectCmd, status: statusCmd, selftest: selftestCmd };
if (import.meta.url === `file://${process.argv[1]}`) {
    // main.mjs stops a round with SIGTERM (fingerprint switched off): exiting closes the read proxy, so ffmpeg children end too.
    process.on('SIGTERM', () => { log('SIGTERM: stopping'); process.exit(0); });
    if (!COMMANDS[cmd]) {
        console.log('usage: fingerprint.mjs detect [--max-minutes 60] [--limit N] [--show TEXT] [--dry-run] [--no-credits] [--validate N] | status [--json] | selftest');
        process.exit(cmd ? 1 : 0);
    }
    await COMMANDS[cmd]();
}
