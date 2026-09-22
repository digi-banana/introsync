#!/usr/bin/env node
// IntroSync container entrypoint. Once a day at RUN_AT (local time) it runs the tidb-sync.mjs stages
//   inventory -> fetch tidb -> fetch introdb -> plan -> [selftest -> apply]   (apply only if APPLY_ENABLED)
// (plan merges, per segment type: TheIntroDB, then the files' named chapters, then introdb.app, then our own
// fingerprint detections) each as a child process, and serves the web UI + /health on WEB_PORT.
// With FP_ENABLED, a separate worker runs fingerprint.mjs in hourly rounds (see "fingerprint worker").
//
// Run settings live in /data/settings.json and are edited on the Settings page (settings.mjs); the template's
// old variables only seed that file on first start. Login (AUTH_*), port and folders stay in the template.
// Security model: login is optional (see "login" below). Changes (settings, keys, run, plan, apply, undo, submit)
// are allowed from the local network, or from anywhere with login on, and ALWAYS need a per-process CSRF token and a
// same-origin request.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as S from './settings.mjs';
import * as UI from './ui.mjs';

const env = (k, d) => process.env[k] ?? d;
const PORT = +env('WEB_PORT', 8897);
const TOOL = '/app/tidb-sync.mjs';
const DATA = S.DATA_DIR;
const LEDGER = env('TIDB_LEDGER', path.join(DATA, 'tidb.db'));
const PLEX_DB = env('PLEX_DB', '/plex/Plug-in Support/Databases/com.plexapp.plugins.library.db');
const CONFIG_KEY = env('TIDB_API_KEY_FILE', '/config/api_key');
const log = (...a) => console.log(new Date().toISOString(), '[main]', ...a);

S.load();
if (S.seededFromEnv) log('settings.json created from the container environment / defaults:', JSON.stringify(S.all()));

// ---------- login (optional) ----------
// The user wants login OPTIONAL, "particularly for local network traffic" (2026-09-18):
//   login off (default): no prompts. Changes are allowed from the local network; a request from outside it
//                        (e.g. if the port is ever exposed through a proxy or tunnel) gets a read-only UI.
//   login on:            required from outside the local network; on the local network only if AUTH_LOCAL=true.
// CSRF + same-origin checks apply to every change regardless: they're what stops a hostile web page from
// POSTing here through the user's browser, and they need no login.
const AUTH = env('AUTH_ENABLED', 'false') === 'true';
const AUTH_LOCAL = env('AUTH_LOCAL', 'false') === 'true';
const digest = (s) => createHash('sha256').update(s).digest();

// Private / loopback / link-local addresses count as local. LAN clients keep their real address (Docker DNAT);
// requests from the Unraid host arrive via the Docker gateway, also private. If the request was forwarded by a
// proxy, every address it lists must be private too, so a proxied internet request is never treated as local.
// 100.64.0.0/10 (CGNAT) is Tailscale's range: the user chose to count their tailnet as local (2026-09-18). Tailscale's
// IPv6 range (fd7a:115c:a1e0::/48) is already covered by the fc00::/7 entry.
const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
                 /^::1$/, /^f[cd][0-9a-f]{2}:/i, /^fe[89ab][0-9a-f]:/i];
const isPrivate = (ip) => { const a = String(ip ?? '').trim().replace(/^::ffff:/i, '').replace(/^\[|\]$/g, ''); return !!a && PRIVATE.some(r => r.test(a)); };
function clientAddrs(req) {
    const addrs = [req.socket.remoteAddress];
    for (const h of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip']) {
        if (req.headers[h]) addrs.push(...String(req.headers[h]).split(','));
    }
    for (const m of String(req.headers.forwarded ?? '').matchAll(/for="?\[?([^\]";,]+)/gi)) addrs.push(m[1]);
    return addrs.map(a => String(a).trim()).filter(Boolean);
}
const isLocal = (req) => clientAddrs(req).every(isPrivate);

// May this request change anything? Local network: yes (login is checked separately if AUTH_LOCAL). Outside: only with login on.
const canWrite = (req) => isLocal(req) || AUTH;

function authorized(req) {
    if (!AUTH) return true;
    if (isLocal(req) && !AUTH_LOCAL) return true;
    const user = env('AUTH_USERNAME', ''), pass = env('AUTH_PASSWORD', '');
    if (!user || !pass) return false;
    const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) return false;
    const given = Buffer.from(m[1], 'base64').toString('utf8');
    return timingSafeEqual(digest(given), digest(`${user}:${pass}`));
}
// Browsers resend Basic credentials automatically, so a hostile page could otherwise POST here as the user.
const CSRF = randomBytes(24).toString('hex');
const sameToken = (a) => typeof a === 'string' && a.length === CSRF.length && timingSafeEqual(Buffer.from(a), Buffer.from(CSRF));

// ---------- child processes ----------
// API keys reach the tool as FILE PATHS only; values never pass through the environment or logs.
function childEnv() {
    return { ...process.env,
        PLEX_URL: S.get('PLEX_URL'),
        FP_WEBDAV_URL: S.get('FP_WEBDAV_URL'), FP_WEBDAV_USER: S.get('FP_WEBDAV_USER'), FP_DECYPHARR_URL: S.get('FP_DECYPHARR_URL'),
        TIDB_API_KEY_FILE: S.secretIsSet('tidb_api_key') ? S.secretPath('tidb_api_key') : CONFIG_KEY,
        INTRODB_API_KEY_FILE: S.secretPath('introdb_api_key'),
        INFINIDYSK_PASSWORD_FILE: S.secretPath('infinidysk_password') };
}
function tool(args, { quiet = false } = {}) {
    return new Promise((resolve) => {
        const p = spawn('node', [TOOL, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
        let out = '';
        // Keep up to 32 MB: `--json` candidate lists run to hundreds of KB, and trimming from the front would cut the
        // JSON line (it's the LAST line) and make it unparseable. Only the tail is shown on pages.
        const keep = (b) => { out = (out + b).slice(-32_000_000); if (!quiet) process.stdout.write(b); };
        p.stdout.on('data', keep);
        p.stderr.on('data', keep);
        const t = setTimeout(() => p.kill('SIGTERM'), 3 * 3600_000);
        p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
    });
}
const lastJson = (out) => { try { return JSON.parse(out.trim().split('\n').pop()); } catch { return null; } };

function planArgs() {
    const a = ['--policy', S.get('POLICY')];
    if (!S.get('MAP_RECAP')) a.push('--no-recap');
    if (!S.get('MAP_PREVIEW')) a.push('--no-preview');
    if (!S.get('CHAPTERS_ENABLED')) a.push('--no-chapters');
    if (!S.get('INTRODB_ENABLED')) a.push('--no-introdb');
    if (!S.get('PAL_GUARD')) a.push('--no-pal-guard');
    if (!S.get('FP_ENABLED')) a.push('--no-fingerprint');
    if (!S.get('COMMERCIALS_ENABLED')) a.push('--no-commercials');
    a.push('--commercial-sections', S.get('COMMERCIALS_SECTIONS'));
    return a;
}
const applySteps = () => [['selftest'], ['apply', '--yes', '--live', '--keep-backups', String(S.get('KEEP_BACKUPS')), ...planArgs()]];

// ---------- one action at a time (daily chain, Run now, and every UI action share this) ----------
let running = null;          // label of what's in progress
let nextRunAt = null, schedTimer = null;
const SESSIONS = path.join(DATA, 'sessions.jsonl');   // who/what triggered each run, for the history table
function appendSession(rec) {
    try {
        fs.appendFileSync(SESSIONS, JSON.stringify(rec) + '\n');
        const lines = fs.readFileSync(SESSIONS, 'utf8').trim().split('\n');
        if (lines.length > 2000) fs.writeFileSync(SESSIONS, lines.slice(-1000).join('\n') + '\n');
    } catch (e) { log('sessions.jsonl:', e.message); }
}
function runSteps(label, trigger, steps, after) {
    if (running) return false;
    running = label;
    const rec = { trigger, label, started: new Date().toISOString(), steps: [] };
    log(`${label} (${trigger}): ${steps.map(s => s[0] + (s[2] && !s[2].startsWith('-') ? `:${s[2]}` : '')).join(' -> ')}`);
    (async () => {
        let ok = true;
        try {
            for (const args of steps) {
                running = `${label}: ${args[0]}${args[0] === 'fetch' ? ` ${args[2]}` : ''}`;
                const r = await tool(args);
                rec.steps.push({ args: args.join(' '), code: r.code, tail: r.out.split('\n').slice(-12).join('\n') });
                // Never apply on a failed selftest (Plex format drift) or a failed plan; stop on any error.
                if (r.code !== 0) { ok = false; log(`${args[0]} exited ${r.code}; stopping`); break; }
            }
            if (ok && after) await after();
        } catch (e) { ok = false; log(`${label} failed:`, e.message); }
        rec.finished = new Date().toISOString();
        rec.ok = ok;
        appendSession(rec);
        running = null;
        invalidate();
        refreshSubs();
        log(`${label} finished (${ok ? 'ok' : 'failed'})`);
    })();
    return true;
}
function runChain(trigger) {
    const steps = [['inventory']];
    if (S.get('TIDB_ENABLED')) steps.push(['fetch', '--source', 'tidb', '--budget', String(S.get('TIDB_BUDGET'))]);
    if (S.get('INTRODB_ENABLED')) steps.push(['fetch', '--source', 'introdb', '--budget', String(S.get('INTRODB_BUDGET'))]);
    steps.push(['plan', '--show', '0', ...planArgs()]);
    if (S.get('APPLY_ENABLED')) steps.push(...applySteps());
    // Submitting comes last: it only ever offers markers Plex detected itself, and only when a key is set (the tool
    // exits non-zero without one, which would fail the whole chain).
    if (S.get('SUBMIT_TIDB_AUTO') && (S.secretIsSet('tidb_api_key') || fs.existsSync(CONFIG_KEY)))
        steps.push(['submit', '--yes', '--limit', String(S.get('SUBMIT_TIDB_LIMIT'))]);
    if (S.get('SUBMIT_INTRODB_AUTO') && S.secretIsSet('introdb_api_key'))
        steps.push(['submit-introdb', '--yes', '--limit', String(S.get('SUBMIT_INTRODB_LIMIT'))]);
    const ok = runSteps('daily chain', trigger, steps);
    if (!ok) log(`${trigger} run skipped: busy with ${running}`);
    return ok;
}

function scheduleNext() {
    clearTimeout(schedTimer);
    const [h, m] = S.get('RUN_AT').split(':').map(Number);
    const next = new Date();
    next.setHours(h, m, 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    nextRunAt = next;
    schedTimer = setTimeout(() => { runChain('schedule'); scheduleNext(); }, next - new Date());
    log(`next run ${next.toString()}`);
}

// ---------- fingerprint worker (method 4) ----------
// While FP_ENABLED is on, fingerprint.mjs runs in rounds of up to an hour, back to back, BESIDE the one-at-a-time lock:
// it only reads Plex and the ledger and writes its own store (fingerprints.db); the daily chain's `plan` picks its
// detections up. No download limit (Usenet is unlimited) and no pause for streams (only Plex DB writes wait for those,
// and this never writes Plex's DB): both the user's calls, 2026-09-18.
const FP_TOOL = '/app/fingerprint.mjs';
const FP_DB = env('FP_DB', path.join(DATA, 'fingerprints.db'));
const fp = { child: null, state: 'off', since: Date.now(), timer: null, last: null };
// How long to wait before the next round, by why the last one stopped.
const FP_NEXT = { time: 5_000, limit: 5_000, done: 6 * 3600_000 };
function fpArgs() {
    const a = ['detect', '--max-minutes', '60'];
    if (!S.get('FP_CREDITS')) a.push('--no-credits');
    if (!S.get('CHAPTERS_ENABLED')) a.push('--no-chapters');
    if (!S.get('INTRODB_ENABLED')) a.push('--no-introdb');
    if (!S.get('MAP_RECAP')) a.push('--no-recap');
    if (!S.get('MAP_PREVIEW')) a.push('--no-preview');
    return a;
}
const fpSet = (state) => { if (fp.state !== state) { fp.state = state; fp.since = Date.now(); } };
function fpStart() {
    clearTimeout(fp.timer); fp.timer = null;
    if (fp.child) return;
    if (!S.get('FP_ENABLED')) return fpSet('off');
    if (!S.secretIsSet('infinidysk_password')) return fpSet('no-password');
    fpSet('running');
    const p = spawn('node', [FP_TOOL, ...fpArgs()], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    fp.child = p;
    let out = '';
    const keep = (b) => { out = (out + b).slice(-200_000); process.stdout.write(b); };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    p.on('exit', (code) => {
        fp.child = null;
        const sum = lastJson(out);
        fp.last = { at: Math.floor(Date.now() / 1000), code, ...(sum ?? {}) };
        invalidate();
        if (!S.get('FP_ENABLED')) return fpSet('off');
        const why = sum?.stopped ?? 'error';
        if (why === 'no-password' || why === 'bad-password') return fpSet(why);   // until the password changes
        fpSet(why === 'time' || why === 'limit' ? 'running' : why === 'done' ? 'idle' : why);
        fp.timer = setTimeout(fpStart, FP_NEXT[why] ?? 30 * 60_000);
    });
}
function fpStop() {
    clearTimeout(fp.timer); fp.timer = null;
    if (fp.child) fp.child.kill('SIGTERM');
    fpSet('off');
}
function fpStatus() {
    const st = { state: fp.state, since: fp.since, last: fp.last, enabled: S.get('FP_ENABLED') };
    const db = fs.existsSync(FP_DB) ? ro(FP_DB) : null;
    if (!db) return st;
    try {
        st.detections = db.prepare('SELECT kind, status, count(*) n FROM detections GROUP BY kind, status').all().map(r => ({ ...r }));
        const rdCol = db.prepare('PRAGMA table_info(reads)').all().some(c => c.name === 'rd_bytes') ? 'rd_bytes' : '0';
        st.today = { ...(db.prepare(`SELECT bytes, ${rdCol} rd_bytes, episodes FROM reads WHERE day = ?`).get(new Date().toISOString().slice(0, 10)) ?? { bytes: 0, rd_bytes: 0, episodes: 0 }) };
        st.last7 = { ...db.prepare(`SELECT coalesce(sum(bytes), 0) bytes, coalesce(sum(${rdCol}), 0) rd_bytes, coalesce(sum(episodes), 0) episodes FROM reads WHERE day >= date('now', '-6 days')`).get() };
        st.total = { ...db.prepare(`SELECT coalesce(sum(bytes), 0) bytes, coalesce(sum(${rdCol}), 0) rd_bytes, coalesce(sum(episodes), 0) episodes, min(day) since FROM reads`).get() };
        st.refs = db.prepare('SELECT count(*) n FROM refs').get().n;
        st.lastRun = JSON.parse(db.prepare("SELECT value FROM state WHERE key = 'lastRun'").get()?.value ?? 'null');
    } catch (e) { st.error = e.message; } finally { db.close(); }
    return st;
}

// ---------- data for the pages (read-only; cached) ----------
const cache = new Map();
const cached = async (k, ms, fn) => {
    const c = cache.get(k);
    if (c && Date.now() - c.at < ms) return c.v;
    const v = await fn();
    cache.set(k, { at: Date.now(), v });
    return v;
};
function invalidate() { cache.clear(); }
const ro = (file) => { try { const d = new DatabaseSync(file, { readOnly: true }); d.exec('PRAGMA busy_timeout=10000'); return d; } catch { return null; } };

async function snapshot() {
    return cached('snap', 60_000, async () => {
        if (running) return cache.get('snap')?.v ?? { status: null, sources: null };
        const [st, so] = await Promise.all([tool(['status', '--json', '--runs', '12'], { quiet: true }), tool(['sources', '--json'], { quiet: true })]);
        return { status: lastJson(st.out), sources: lastJson(so.out) };
    });
}

// Map a ledger `applied.source` ("tidb:intro", "chapters:recap+tidb:intro", …) to one badge.
function srcCat(source) {
    if (!source) return 'tidb';                         // rows from before provenance was recorded
    const kinds = [...new Set(String(source).split('+').map(p => p.split(':')[0]))];
    return kinds.length === 1 ? kinds[0] : 'mixed';
}

function buildLibrary() {
    const plex = ro(PLEX_DB);
    if (!plex) return { shows: new Map(), movies: { total: 0, withIntro: 0, withCredits: 0, src: {} } };
    const tag = plex.prepare('SELECT id FROM tags WHERE tag_type = 12 ORDER BY id LIMIT 1').get()?.id;
    const eps = plex.prepare(`SELECT e.id mid, e."index" ep, se."index" season, sh.id show_id, sh.title show, e.title title
        FROM metadata_items e JOIN metadata_items se ON se.id = e.parent_id JOIN metadata_items sh ON sh.id = se.parent_id
        WHERE e.metadata_type = 4 AND e.deleted_at IS NULL`).all();
    const movies = plex.prepare('SELECT id mid FROM metadata_items WHERE metadata_type = 1 AND deleted_at IS NULL').all();
    const marks = tag ? plex.prepare(`SELECT metadata_item_id mid, text, time_offset s, end_time_offset e FROM taggings
        WHERE tag_id = ? AND text IN ('intro', 'credits')`).all(tag) : [];
    plex.close();
    const led = ro(LEDGER);
    const applied = led ? led.prepare('SELECT mid, text, start_ms, end_ms, source FROM applied').all() : [];
    led?.close();
    const ours = new Map(applied.map(a => [`${a.mid}|${a.text}|${a.start_ms}|${a.end_ms}`, a.source]));
    const byMid = new Map();
    for (const m of marks) {
        const k = `${m.mid}|${m.text}|${m.s}|${m.e}`;
        const src = ours.has(k) ? srcCat(ours.get(k)) : 'plex';
        if (!byMid.has(m.mid)) byMid.set(m.mid, []);
        byMid.get(m.mid).push({ text: m.text, s: m.s, e: m.e, src });
    }
    const shows = new Map();
    for (const e of eps) {
        if (!shows.has(e.show_id)) shows.set(e.show_id, { id: e.show_id, title: e.show ?? '?', eps: [], withIntro: 0, withCredits: 0, src: {} });
        const sh = shows.get(e.show_id);
        const ms = (byMid.get(e.mid) ?? []).sort((a, b) => a.s - b.s);
        const intro = ms.filter(m => m.text === 'intro'), credits = ms.filter(m => m.text === 'credits');
        sh.eps.push({ ep: e.ep, season: e.season, title: e.title ?? '', intro, credits });
        if (intro.length) sh.withIntro++;
        if (credits.length) sh.withCredits++;
        for (const m of ms) sh.src[m.src] = (sh.src[m.src] ?? 0) + 1;
    }
    const mv = { total: movies.length, withIntro: 0, withCredits: 0, src: {} };
    for (const m of movies) {
        const ms = byMid.get(m.mid) ?? [];
        if (ms.some(x => x.text === 'intro')) mv.withIntro++;
        if (ms.some(x => x.text === 'credits')) mv.withCredits++;
        for (const x of ms) mv.src[x.src] = (mv.src[x.src] ?? 0) + 1;
    }
    return { shows, movies: mv };
}

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

// One row per run ("session"): the ledger's stage rows grouped. A new session starts at `inventory`, at any
// submit, or after a 20-minute gap. The trigger comes from sessions.jsonl when one matches the start time.
function runHistory(limit = 60) {
    const db = ro(LEDGER);
    if (!db) return [];
    const rows = db.prepare('SELECT cmd, started_at s, finished_at f, summary FROM runs ORDER BY started_at, id').all();
    const appliedRows = db.prepare('SELECT applied_at t, source FROM applied').all();
    db.close();
    let trig = [];
    try { trig = fs.readFileSync(SESSIONS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { }
    const out = [];
    let cur = null;
    for (const r of rows) {
        let sm = {};
        try { sm = JSON.parse(r.summary); } catch { }
        const isSubmit = r.cmd === 'submit' || r.cmd === 'submit-introdb';
        // A run ends at its apply: anything after an apply is a new run, however soon it follows.
        if (!cur || r.cmd === 'inventory' || isSubmit || cur.submit || cur.apply || r.s - cur.end > 1200) {
            cur = { start: r.s, end: r.f, stages: [], fetch: {}, apply: null, plan: null, submit: null };
            out.push(cur);
        }
        cur.end = Math.max(cur.end, r.f);
        cur.stages.push(r.cmd);
        if (r.cmd.startsWith('fetch:')) cur.fetch[r.cmd.slice(6)] = sm;
        else if (r.cmd === 'apply') {
            // The recorded bySource describes the whole PLAN. When a run wrote only part of it (--match / --limit),
            // those totals overstate what it wrote; count the ledger rows this run actually wrote instead.
            const bySource = sm.stats?.bySource ?? {};
            const planned = Object.values(bySource).reduce((a, b) => a + b, 0);
            let src = bySource;
            if (planned !== (sm.done?.inserted ?? 0)) {
                src = { tidb: 0, chapters: 0, introdb: 0, fingerprint: 0, mixed: 0 };
                for (const a of appliedRows) if (a.t >= r.s - 5 && a.t <= r.f + 5) src[srcCat(a.source)] = (src[srcCat(a.source)] ?? 0) + 1;
            }
            cur.apply = { ...(sm.done ?? {}), bySource: src, retract: sm.stats?.retract ?? 0 };
        }
        else if (r.cmd === 'plan') cur.plan = sm.stats ?? null;
        else if (isSubmit) cur.submit = { svc: r.cmd === 'submit' ? 'TheIntroDB' : 'introdb.app', ...sm };
    }
    const TRIG = { schedule: 'daily schedule', manual: 'Run now', start: 'container start', web: 'web page' };
    for (const h of out) {
        const m = trig.find(x => Math.abs(Date.parse(x.started) / 1000 - h.start) < 120);
        // Triggers are only recorded from this version on. For older runs, one that began at the daily run time
        // was the schedule; anything else is unknown.
        const d = new Date(h.start * 1000);
        const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const atRunTime = h.stages[0] === 'inventory' && Math.abs(toMin(hhmm) - toMin(S.get('RUN_AT'))) <= 2;
        h.trigger = m ? `${TRIG[m.trigger] ?? m.trigger}${m.label && m.label !== 'daily chain' ? ` · ${m.label}` : ''}`
            : atRunTime ? 'daily schedule' : '–';
        h.result = h.submit ? `sent ${UI.n(h.submit.ok)} to ${UI.esc(h.submit.svc)}${h.submit.failed ? ` <span class="bad">· ${UI.n(h.submit.failed)} failed</span>` : ''}`
            : h.apply ? `<span class="ok">wrote ${UI.n(h.apply.inserted)}</span>${h.apply.skippedChanged ? ` · ${UI.n(h.apply.skippedChanged)} skipped` : ''}`
            : h.plan ? '<span class="muted">planned only</span>'
            : `<span class="muted">${UI.esc(h.stages.join(', '))}</span>`;
    }
    return out.reverse().slice(0, limit);
}

function latestPlan() {
    let files = [];
    try { files = fs.readdirSync(DATA).filter(f => /^plan-.*\.json$/.test(f)).map(f => ({ f, t: fs.statSync(path.join(DATA, f)).mtimeMs })); } catch { }
    files.sort((a, b) => b.t - a.t);
    if (!files.length) return null;
    const k = `plan:${files[0].f}:${files[0].t}`;
    const c = cache.get(k);
    if (c) return c.v;
    let v = null;
    try { v = { file: files[0].f, mtime: files[0].t, data: JSON.parse(fs.readFileSync(path.join(DATA, files[0].f), 'utf8')) }; } catch { }
    cache.set(k, { at: Date.now(), v });
    return v;
}

const UNDO_RX = /^undo-(.+)\.jsonl(\.undone)?$/;
function undoLogs() {
    let files = [];
    try { files = fs.readdirSync(DATA).filter(f => UNDO_RX.test(f)); } catch { }
    return files.sort().reverse().map(f => {
        const ops = { insert: 0, delete: 0, extra: 0, index: 0 };
        try { for (const l of fs.readFileSync(path.join(DATA, f), 'utf8').split('\n')) { const m = /"op":"(\w+)"/.exec(l); if (m && m[1] in ops) ops[m[1]]++; } } catch { }
        const stamp = UNDO_RX.exec(f)[1].replace(/T(\d\d)(\d\d)(\d\d)\d*Z$/, ' $1:$2:$3');
        return { file: f, label: stamp, undone: f.endsWith('.undone'), ops };
    });
}

// Submission candidates are computed in the BACKGROUND (TheIntroDB's dry run takes ~80 s on this library), on
// startup, after every run or action, and on request; the Submit page shows the latest result and its age.
// Both dry runs are read-only, so they don't take the one-at-a-time lock. The submit actions themselves
// recompute inside the tool, so a stale list can't cause a wrong submission.
let subs = { at: 0, data: null, computing: false };
function refreshSubs() {
    if (subs.computing) return;
    subs.computing = true;
    Promise.all([tool(['submit', '--json'], { quiet: true }), tool(['submit-introdb', '--json'], { quiet: true })])
        .then(([a, b]) => { subs = { at: Date.now(), data: { tidb: lastJson(a.out), introdb: lastJson(b.out) }, computing: false }; })
        .catch((e) => { subs.computing = false; log('submit candidates failed:', e.message); });
}

// ---------- http ----------
const HEADERS = {
    'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'",
};
function send(res, code, body, type = 'text/html; charset=utf-8', extra = {}) {
    res.writeHead(code, { ...HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
}
const redirect = (res, to, msg, err) => send(res, 303, '', 'text/plain', { Location: `${to}${msg ? `${to.includes('?') ? '&' : '?'}m=${encodeURIComponent(msg)}${err ? '&e=1' : ''}` : ''}` });
function readBody(req) {
    return new Promise((resolve, reject) => {
        let b = '';
        req.on('data', (d) => { b += d; if (b.length > 65536) { reject(new Error('request too large')); req.destroy(); } });
        req.on('end', () => resolve(b));
        req.on('error', reject);
    });
}
// Every state-changing request: allowed for this client (local network, or login on), same-origin, and carrying
// this process's CSRF token.
async function writeGate(req, res) {
    if (!canWrite(req)) {
        send(res, 403, UI.layout({ title: 'Read-only', authOn: false, body: '<div class="card"><p>Changes are only allowed from the local network, or from anywhere once login is turned on.</p><p><a href="/">Back</a></p></div>' }));
        return null;
    }
    const origin = req.headers.origin || req.headers.referer;
    if (origin) {
        let host = null;
        try { host = new URL(origin).host; } catch { }
        if (host !== req.headers.host) { send(res, 403, 'cross-origin request refused', 'text/plain'); return null; }
    }
    let form;
    try { form = Object.fromEntries(new URLSearchParams(await readBody(req))); }
    catch { send(res, 413, 'request too large', 'text/plain'); return null; }
    if (!sameToken(form._csrf)) { send(res, 403, 'form expired or forged (reload the page and try again)', 'text/plain'); return null; }
    return form;
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d4aff"/><stop offset="1" stop-color="#ff6a3d"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><path d="M16 17l14 11-14 11zM30 17l14 11-14 11z" fill="#fff"/><rect x="45" y="17" width="4" height="22" rx="1.5" fill="#fff"/><rect x="12" y="46" width="40" height="5" rx="2.5" fill="#fff" opacity=".4"/><rect x="21" y="46" width="14" height="5" rx="2.5" fill="#fff"/></svg>`;

async function ctx(url, req) {
    const snap = await snapshot();
    const m = url.searchParams.get('m');
    return {
        authOn: canWrite(req), csrf: CSRF, running, nextRunAt, snap, settings: S.all(), fp: fpStatus(),
        secrets: Object.fromEntries(Object.keys(S.SECRETS).map(k => [k, S.secretIsSet(k)])),
        configKey: (() => { try { return fs.statSync(CONFIG_KEY).size > 0; } catch { return false; } })(),
        flash: m ? { msg: m.slice(0, 300), err: url.searchParams.get('e') === '1' } : null,
    };
}

async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/health') return send(res, 200, JSON.stringify({ ok: true, running, nextRunAt, fingerprint: fp.state }), 'application/json');
    if (!authorized(req)) {
        return send(res, 401, env('AUTH_USERNAME', '') && env('AUTH_PASSWORD', '') ? 'login required' : 'AUTH_ENABLED=true but no username/password set',
                    'text/plain', { 'WWW-Authenticate': 'Basic realm="IntroSync", charset="UTF-8"' });
    }
    if (p === '/icon.svg') return send(res, 200, ICON, 'image/svg+xml');

    if (req.method === 'GET') {
        if (p === '/') { const c = await ctx(url, req); return send(res, 200, UI.statusPage({ ...c, history: runHistory(12) })); }
        if (p === '/settings') return send(res, 200, UI.settingsPage(await ctx(url, req)));
        if (p === '/library') {
            const c = await ctx(url, req);
            const lib = await cached('lib', 300_000, async () => buildLibrary());
            return send(res, 200, UI.libraryPage({ ...c, lib, showId: +url.searchParams.get('show') || null, q: url.searchParams.get('q') ?? '', filter: url.searchParams.get('f') ?? '' }));
        }
        if (p === '/plan') {
            const c = await ctx(url, req);
            const lp = latestPlan();
            return send(res, 200, UI.planPage({ ...c, plan: lp?.data, planFile: lp?.file, planAge: lp ? UI.ago(lp.mtime / 1000) : '', action: url.searchParams.get('a') ?? '' }));
        }
        if (p === '/runs') { const c = await ctx(url, req); return send(res, 200, UI.runsPage({ ...c, history: runHistory(80), undoLogs: undoLogs() })); }
        if (p === '/submit') {
            if (url.searchParams.get('refresh') === '1') { refreshSubs(); return redirect(res, '/submit', 'Recalculating what is ready to send…'); }
            if (!subs.data || Date.now() - subs.at > 30 * 60_000) refreshSubs();
            const c = await ctx(url, req);
            return send(res, 200, UI.submitPage({ ...c, sub: subs.data ?? {}, subsAt: subs.at, subsComputing: subs.computing,
                hasTidbKey: !!c.snap.status?.hasTidbKey,
                submitted: { tidb: c.snap.sources?.submittedToTheIntroDB_fromPlex, introdb: c.snap.sources?.submittedToIntrodbApp_fromPlex } }));
        }
        return send(res, 404, 'not found', 'text/plain');
    }

    if (req.method !== 'POST') return send(res, 405, 'method not allowed', 'text/plain');
    const form = await writeGate(req, res);
    if (!form) return;
    const busy = (to) => redirect(res, to, `Busy: ${running}. Try again when it finishes.`, true);

    if (p === '/settings') {
        try {
            const changed = S.update(form);
            if (changed.includes('RUN_AT')) scheduleNext();
            // Fingerprint on/off applies now; its other options apply from its next round (within the hour).
            if (changed.includes('FP_ENABLED')) { if (S.get('FP_ENABLED')) fpStart(); else fpStop(); }
            invalidate();
            log(`settings changed: ${changed.join(', ') || '(none)'}`);
            return redirect(res, '/settings', changed.length ? `Saved: ${changed.map(k => S.SCHEMA.find(s => s.key === k).label).join(', ')}.` : 'No changes.');
        } catch (e) { return redirect(res, '/settings', e.message, true); }
    }
    if (p === '/secrets') {
        try {
            const r = S.setSecret(form.name, form.clear ? '' : form.value);
            log(`secret ${form.name} ${r}`);             // never the value
            if (form.name === 'infinidysk_password' && S.get('FP_ENABLED') && !fp.child) fpStart();
            invalidate();
            return redirect(res, '/settings', `${S.SECRETS[form.name].label} ${r}.`);
        } catch (e) { return redirect(res, '/settings', e.message, true); }
    }
    if (p === '/run') return runChain('manual') ? redirect(res, '/', 'Run started.') : busy('/');
    if (p === '/plan') return runSteps('build plan', 'web', [['plan', '--show', '0', ...planArgs()]]) ? redirect(res, '/plan', 'Building a new plan…') : busy('/plan');
    if (p === '/apply') {
        if (form.ok !== '1') return redirect(res, '/plan', 'Tick the confirmation box to apply.', true);
        return runSteps('apply', 'web', applySteps()) ? redirect(res, '/plan', 'Applying: selftest, then write. Refresh for progress.') : busy('/plan');
    }
    if (p === '/undo') {
        const logs = undoLogs();
        const newest = logs.find(l => !l.undone);
        if (!newest || form.file !== newest.file) return redirect(res, '/runs', 'Only the most recent apply can be undone.', true);
        const full = path.join(DATA, newest.file);
        const ok = runSteps('undo', 'web', [['undo', full, '--yes', '--live']], async () => { fs.renameSync(full, `${full}.undone`); });
        return ok ? redirect(res, '/runs', `Undoing ${newest.label}…`) : busy('/runs');
    }
    if (p === '/submit/tidb' || p === '/submit/introdb') {
        const limit = Number(form.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 5000) return redirect(res, '/submit', 'Limit must be a whole number from 1 to 5000.', true);
        const svc = p.endsWith('tidb') ? 'submit' : 'submit-introdb';
        const ok = runSteps(`submit to ${svc === 'submit' ? 'TheIntroDB' : 'introdb.app'}`, 'web', [[svc, '--yes', '--limit', String(limit)]]);
        return ok ? redirect(res, '/submit', `Submitting up to ${limit}…`) : busy('/submit');
    }
    return send(res, 404, 'not found', 'text/plain');
}

createServer((req, res) => {
    handle(req, res).catch((e) => { log('request failed:', e.stack || e.message); if (!res.headersSent) send(res, 500, 'internal error', 'text/plain'); });
}).listen(PORT, () => log(`web UI on :${PORT} (login ${AUTH ? `on${AUTH_LOCAL ? ', including the local network' : ' outside the local network'}` : 'off; changes allowed from the local network'})`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log(`${sig}: exiting`); fp.child?.kill('SIGTERM'); process.exit(0); });

scheduleNext();
setTimeout(refreshSubs, 20_000);
if (S.get('RUN_ON_START')) setTimeout(() => runChain('start'), 15_000);
setTimeout(fpStart, 30_000);
