// IntroSync web UI: server-rendered HTML, no framework, no external assets.
// Every value that came from Plex, the ledger or a service is escaped with esc(). API keys are never rendered.
import { SCHEMA, SECRETS } from './settings.mjs';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const n = (x) => (x ?? 0).toLocaleString('en-US');
const when = (sec) => sec ? new Date(sec * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–';
export function ago(sec) {
    if (!sec) return 'never';
    const d = Math.max(0, Date.now() / 1000 - sec);
    return d < 90 ? 'just now' : d < 5400 ? `${Math.round(d / 60)} min ago` : d < 172800 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} days ago`;
}
const t = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const BADGE = { plex: 'Plex', tidb: 'TheIntroDB', chapters: 'chapters', introdb: 'introdb.app', fingerprint: 'fingerprint', mixed: 'mixed' };
// Source columns, in plan priority order (tidb-sync.mjs mergeSources)
const SRC_COLS = ['plex', 'tidb', 'chapters', 'introdb', 'fingerprint', 'mixed'];
const badge = (src) => `<span class="b b-${esc(src)}">${esc(BADGE[src] ?? src)}</span>`;

const CSS = `
:root{--bg:#f7f7f9;--card:#fff;--fg:#1d1d24;--mute:#6b6b78;--line:#e4e4ea;--accent:#6d4aff;--ok:#1a8f5a;--bad:#c93a3a;--warn:#b86e00;--warnbg:#fff4e0}
@media (prefers-color-scheme:dark){:root{--bg:#131318;--card:#1c1c23;--fg:#ececf1;--mute:#9a9aa8;--line:#2d2d37;--accent:#a08bff;--ok:#4cc38a;--bad:#ff6b6b;--warn:#f0a53a;--warnbg:#2e2412}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1060px;margin:0 auto;padding:20px 16px 48px}h1{font-size:22px;margin:0}h2{font-size:15px;margin:0 0 10px;color:var(--mute);font-weight:600}
header{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-bottom:14px}nav{display:flex;gap:4px;flex-wrap:wrap}
nav a{color:var(--fg);text-decoration:none;padding:6px 12px;border-radius:8px}nav a.on{background:var(--accent);color:#fff}nav a:not(.on):hover{background:var(--line)}
.sub{color:var(--mute);margin:0 0 16px}.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;overflow-x:auto;margin-bottom:16px}.grid .card{margin-bottom:0}
table{border-collapse:collapse;width:100%}th,td{text-align:right;padding:5px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;vertical-align:top}
th:first-child,td:first-child,.l{text-align:left}thead th{color:var(--mute);font-weight:600;white-space:nowrap}.mono,pre{font:12px/1.4 ui-monospace,Menlo,monospace}
pre{white-space:pre-wrap;margin:6px 0 0;color:var(--mute)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
button,.btn{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}button.danger{background:var(--bad)}button:disabled{opacity:.45;cursor:not-allowed}
.big{font-size:28px;font-weight:700;line-height:1.2}.row{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-end}
.b{display:inline-block;border-radius:6px;padding:0 6px;font-size:12px;margin:1px 2px;white-space:nowrap;border:1px solid var(--line)}
.b-plex{background:#e7f1ff;color:#1d4f91;border-color:#b8d3f5}.b-tidb{background:#efe9ff;color:#4b2fb8;border-color:#cfc2fb}
.b-chapters{background:#e6f6ee;color:#146b45;border-color:#b7e2cb}.b-introdb{background:#fff0e3;color:#9a4b00;border-color:#f6cfa8}.b-mixed{background:#f1f1f4;color:#555;border-color:#d8d8e0}
.b-fingerprint{background:#e3f5f7;color:#0b6470;border-color:#aee0e6}
@media (prefers-color-scheme:dark){.b-plex{background:#162a45;color:#9cc4ff;border-color:#244870}.b-tidb{background:#241c45;color:#c3b3ff;border-color:#3d2f75}
.b-chapters{background:#12301f;color:#8fe0b3;border-color:#1f5537}.b-introdb{background:#35220d;color:#ffc58f;border-color:#5a3a16}.b-mixed{background:#26262e;color:#bbb;border-color:#3a3a44}
.b-fingerprint{background:#0f2d31;color:#8fdde6;border-color:#1c4f56}}
.banner{border:1px solid var(--warn);background:var(--warnbg);border-radius:10px;padding:10px 14px;margin-bottom:16px}
.flash{border:1px solid var(--accent);border-radius:10px;padding:10px 14px;margin-bottom:16px}.flash.err{border-color:var(--bad);color:var(--bad)}
label{display:block;font-weight:600}.help{color:var(--mute);font-size:13px;margin:2px 0 0;font-weight:400}.field{padding:10px 0;border-bottom:1px solid var(--line)}
.field:last-child{border-bottom:0}input[type=text],input[type=password],input[type=number],input[type=time],input[type=search],select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
input[type=checkbox]{width:18px;height:18px;vertical-align:-3px;margin-right:8px}.inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
details summary{cursor:pointer}.muted{color:var(--mute)}.pill{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:13px;margin-right:6px;white-space:nowrap}
.pill.warn{border-color:var(--warn);color:var(--warn)}a{color:var(--accent)}td.m{white-space:nowrap}
`;

const NAV = [['/', 'Status'], ['/library', 'Library'], ['/plan', 'Plan & apply'], ['/runs', 'Runs & undo'], ['/submit', 'Submit'], ['/settings', 'Settings']];

export function layout({ title, active, body, flash, authOn, running, refresh }) {
    // authOn = "this client may make changes": true on the local network, or anywhere with login on.
    const banner = authOn ? '' : `<div class="banner"><b>Read-only: you're connecting from outside your local network.</b> Changes work from the
local network, or from anywhere once login is on (Unraid: Docker → IntroSync → Edit → <b>Require login</b> = true, with a username and password).</div>`;
    const fl = flash ? `<div class="flash${flash.err ? ' err' : ''}">${esc(flash.msg)}</div>` : '';
    const run = running ? `<div class="flash">Working: <b>${esc(running)}</b>. Refresh to see progress.</div>` : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · IntroSync</title><link rel="icon" href="/icon.svg">${refresh ? `<meta http-equiv="refresh" content="${+refresh}">` : ''}<style>${CSS}</style></head><body><main>
<header><h1>IntroSync</h1><nav>${NAV.map(([h, l]) => `<a href="${h}"${h === active ? ' class="on"' : ''}>${l}</a>`).join('')}</nav></header>
${banner}${fl}${run}${body}</main></body></html>`;
}

// A POST form carrying the CSRF token. `confirm` adds a browser confirm() before submitting.
export function form(action, csrf, inner, { confirm } = {}) {
    return `<form method="post" action="${esc(action)}"${confirm ? ` onsubmit="return confirm(${esc(JSON.stringify(confirm))})"` : ''}>
<input type="hidden" name="_csrf" value="${esc(csrf)}">${inner}</form>`;
}
const dis = (c) => c.authOn && !c.running ? '' : ' disabled';

// ---------------- status ----------------
export function statusPage(c) {
    const { status, sources } = c.snap;
    const items = Object.fromEntries((status?.items ?? []).map(r => [r.kind, r.n]));
    const srcRows = Object.entries(sources?.markers ?? {}).map(([type, x]) =>
        `<tr><th>${esc(type)}</th>${SRC_COLS.map(k => `<td>${n(x[k])}</td>`).join('')}</tr>`).join('');
    return layout({ title: 'Status', active: '/', authOn: c.authOn, running: c.running, flash: c.flash, body: `
<p class="sub">Intro &amp; credits markers for Plex from TheIntroDB, then the files' own chapter names, then introdb.app, then IntroSync's own fingerprint detection.
${c.running ? '' : `Next scheduled run: <b>${esc(c.nextRunAt?.toLocaleString('en-US') ?? '–')}</b>.`}</p>
<div class="card inline">${chips(c.settings)}
${form('/run', c.csrf, `<button${dis(c)}>Run now</button>`, { confirm: c.settings.APPLY_ENABLED ? 'Run the full chain now? Writing is ON, so markers will be written into Plex.' : 'Run lookups and plan now? (Writing is off.)' })}
<span class="muted">${c.settings.APPLY_ENABLED ? 'Each run writes markers into Plex.' : 'Runs look up and plan only (writing is off).'}</span></div>
${usageCard(c)}
${fingerprintCard(c)}
<div class="grid">
<div class="card"><h2>Library</h2><div class="row"><div><div class="big">${n(items.ep)}</div>episodes</div><div><div class="big">${n(items.movie)}</div>movies</div><div><div class="big">${n(status?.showsWithData)}</div>shows with TheIntroDB data</div></div></div>
<div class="card"><h2>Markers in Plex by source</h2><table><thead><tr><th></th>${SRC_COLS.map(k => `<th>${esc(BADGE[k])}</th>`).join('')}</tr></thead><tbody>${srcRows}</tbody></table>
<p class="muted" style="margin:8px 0 0">${n(sources?.writtenByUs)} written by IntroSync · ${n(sources?.noLongerInPlex_reappliedNextRun)} wiped by Plex (re-applied next run)</p></div>
</div>
<div class="card" style="margin-top:16px"><h2>Run history</h2>${historyTable(c.history.slice(0, 12))}
<p class="muted" style="margin:8px 0 0"><a href="/runs">Full history and undo →</a></p></div>` });
}

function chips(s) {
    const pills = [['Writing', s.APPLY_ENABLED ? 'on' : 'off', s.APPLY_ENABLED], ['TheIntroDB', s.TIDB_ENABLED ? 'on' : 'off'],
                   ['chapters', s.CHAPTERS_ENABLED ? 'on' : 'off'], ['introdb.app', s.INTRODB_ENABLED ? 'on' : 'off'],
                   ['fingerprint', s.FP_ENABLED ? 'on' : 'off'], ['PAL guard', s.PAL_GUARD ? 'on' : 'off'], ['policy', s.POLICY], ['daily', s.RUN_AT]];
    return pills.map(([k, v, w]) => `<span class="pill${w ? ' warn' : ''}">${esc(k)}: ${esc(v)}</span>`).join('');
}

// Fingerprint detection (fingerprint.mjs via main.mjs's worker): state, results, and what it read.
const FP_STATE = { off: 'off', running: 'working through the library', idle: 'idle: nothing left to detect (looks again every 6 hours)',
    'no-password': 'waiting for the InfiniDysk WebDAV password (Settings)', 'bad-password': 'InfiniDysk rejected the WebDAV password (Settings)',
    'webdav-unreachable': 'waiting: InfiniDysk WebDAV is not answering (retries in 30 minutes)',
    'read-errors': 'paused: files could not be read (retries in 30 minutes)', error: 'waiting after an error (see the container log; retries in 30 minutes)' };
function fingerprintCard(c) {
    const f = c.fp ?? {};
    if (!f.enabled && !f.total?.episodes) {
        return `<div class="card"><h2>Fingerprint detection</h2><p class="muted" style="margin:0">Off. When on, IntroSync detects intros and credits itself on episodes
no other source covers, from a few seconds of each file matched against a season sibling whose intro is known. <a href="/settings">Settings</a></p></div>`;
    }
    const cnt = (kind, sts) => (f.detections ?? []).filter(d => d.kind === kind && sts.includes(d.status)).reduce((a, d) => a + d.n, 0);
    const gb = (b) => `${((b ?? 0) / 1e9).toFixed(1)} GB`;
    const q = f.lastRun?.queue;
    return `<div class="card"><h2>Fingerprint detection</h2>
<p style="margin:0 0 10px">${badge('fingerprint')} <b>${esc(FP_STATE[f.state] ?? f.state)}</b> <span class="muted">(since ${esc(ago(f.since / 1000))})</span></p>
<div class="row"><div><div class="big">${n(cnt('intro', ['match']))}</div>intros found</div><div><div class="big">${n(cnt('credits', ['found']))}</div>credits found</div>
<div><div class="big">${n(cnt('intro', ['miss', 'read-error', 'ref-error']) + cnt('credits', ['miss', 'read-error']))}</div>not found <span class="muted">(retried in 30 days)</span></div>
<div><div class="big">${q ? n(q.episodes) : '–'}</div>episodes waiting <span class="muted">(at the last round's start)</span></div></div>
<table style="margin-top:10px"><thead><tr><th></th><th>read: Usenet (InfiniDysk)</th><th>Real-Debrid (decypharr)</th><th>episodes</th></tr></thead><tbody>
${[['today (UTC)', f.today], ['last 7 days', f.last7], [`total${f.total?.since ? ` since ${f.total.since}` : ''}`, f.total]].map(([k, r]) =>
    `<tr><th>${esc(k)}</th><td>${gb((r?.bytes ?? 0) - (r?.rd_bytes ?? 0))}</td><td>${gb(r?.rd_bytes)}</td><td>${n(r?.episodes)}</td></tr>`).join('')}</tbody></table>
<p class="muted" style="margin:8px 0 0">Bytes read through each backend's WebDAV. InfiniDysk downloads about 3× that from Usenet (it fetches whole articles); decypharr about 1×.
${n(f.refs)} season references saved, so each one is read only once. New detections reach Plex at the next daily run (or Run now).</p></div>`;
}

// Request usage per service: last request, rolling 24 h, and TheIntroDB's daily limit (500 without a key, 1000 with).
function usageCard(c) {
    const st = c.snap.status ?? {};
    const req = Object.fromEntries((st.requests ?? []).map(r => [r.source, r]));
    const api = Object.fromEntries((st.apiState ?? []).map(r => [r.source, r]));
    const limit = st.hasTidbKey ? 1000 : 500;
    const tidb24 = req.tidb?.last24h ?? 0;
    const warn = tidb24 >= limit || api.tidb?.remaining === 0
        ? `<div class="banner" style="margin:10px 0 0"><b>TheIntroDB limit reached.</b> ${n(tidb24)} requests in the last 24 hours;
TheIntroDB allows ${n(limit)} per day ${st.hasTidbKey ? 'with an API key' : 'without an API key (1,000 with one)'}.
The next run may not be able to pull any more from TheIntroDB until the window clears.</div>` : '';
    const row = (src, name, lim) => `<tr><th>${name}</th><td>${req[src]?.last ? `${esc(when(req[src].last))} <span class="muted">(${esc(ago(req[src].last))})</span>` : '<span class="muted">none recorded yet</span>'}</td>
<td>${n(req[src]?.last24h)}${lim ? ` <span class="muted">/ ${n(lim)}</span>` : ''}</td><td>${api[src]?.remaining != null ? `${n(api[src].remaining)} <span class="muted">(${esc(ago(api[src].at))})</span>` : '<span class="muted">–</span>'}</td></tr>`;
    return `<div class="card"><h2>Lookups</h2><table><thead><tr><th></th><th class="l">last request</th><th>last 24 h</th><th>remaining (service says)</th></tr></thead><tbody>
${row('tidb', 'TheIntroDB', limit)}${row('introdb', 'introdb.app', null)}</tbody></table>
<p class="muted" style="margin:8px 0 0">TheIntroDB: ${n(limit)}/day ${st.hasTidbKey ? '(API key set)' : '(no API key: 500/day; add a key in Settings for 1,000)'}. Counts start from this version; earlier requests aren't timestamped.</p>${warn}</div>`;
}

export function historyTable(rows) {
    if (!rows.length) return '<p class="muted">No runs recorded yet.</p>';
    const look = (x) => x ? `${n(x.requests)} <span class="muted">· ${n(x.hit)} hit${x.stopped === 'reserve' || x.stopped === 'usage-limit' ? ` · <span class="warn">${esc(x.stopped === 'reserve' ? 'quota' : 'limit')}</span>` : ''}</span>` : '<span class="muted">–</span>';
    const src = (h, k) => h.apply ? n(h.apply.bySource?.[k]) : '<span class="muted">–</span>';
    return `<table><thead><tr><th>started</th><th class="l">trigger</th><th>TheIntroDB<br>lookups</th><th>introdb.app<br>lookups</th>
<th>written:<br>TheIntroDB</th><th>chapters</th><th>introdb.app</th><th>finger-<br>print</th><th>mixed</th><th>removed</th><th class="l">result</th></tr></thead><tbody>
${rows.map(h => `<tr><td class="m">${esc(when(h.start))}</td><td class="l">${esc(h.trigger)}</td><td>${look(h.fetch.tidb)}</td><td>${look(h.fetch.introdb)}</td>
<td>${src(h, 'tidb')}</td><td>${src(h, 'chapters')}</td><td>${src(h, 'introdb')}</td><td>${src(h, 'fingerprint')}</td><td>${src(h, 'mixed')}</td>
<td>${h.apply ? n(h.apply.deleted) : '<span class="muted">–</span>'}</td><td class="l">${h.result}</td></tr>`).join('')}</tbody></table>`;
}

// ---------------- settings ----------------
export function settingsPage(c) {
    const groups = [...new Set(SCHEMA.map(s => s.group))];
    const field = (s) => {
        const v = c.settings[s.key];
        const input = s.type === 'bool' ? `<input type="checkbox" name="${s.key}" value="true"${v ? ' checked' : ''}>`
            : s.type === 'enum' ? `<select name="${s.key}">${s.options.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
            : s.type === 'time' ? `<input type="time" name="${s.key}" value="${esc(v)}" required>`
            : s.type === 'text' ? `<input type="text" name="${s.key}" value="${esc(v)}" maxlength="200" required style="min-width:320px">`
            : `<input type="number" name="${s.key}" value="${esc(v)}" min="${s.min}" max="${s.max}" required style="width:110px">`;
        return s.type === 'bool'
            ? `<div class="field"><label>${input}${esc(s.label)}</label><p class="help">${esc(s.help)}</p></div>`
            : `<div class="field"><label>${esc(s.label)}</label><div class="inline" style="margin-top:4px">${input}</div><p class="help">${esc(s.help)}</p></div>`;
    };
    const secretCard = Object.entries(SECRETS).map(([name, m]) => {
        const set = c.secrets[name];
        const extra = name === 'tidb_api_key' && !set && c.configKey ? ' <span class="muted">(using the key file in the Config folder)</span>' : '';
        return `<div class="field"><label>${esc(m.label)} — ${set ? '<span class="ok">set</span>' : '<span class="muted">not set</span>'}${extra}</label><p class="help">${esc(m.help)} Never shown again after saving.</p>
${form('/secrets', c.csrf, `<input type="hidden" name="name" value="${esc(name)}"><div class="inline" style="margin-top:6px">
<input type="password" name="value" autocomplete="off" placeholder="${set ? 'enter a new one to replace it' : 'paste it here'}" style="min-width:320px">
<button${dis(c)}>Save</button>${set ? `<button class="ghost" name="clear" value="1"${dis(c)} formnovalidate>Clear</button>` : ''}</div>`)}</div>`;
    }).join('');
    return layout({ title: 'Settings', active: '/settings', authOn: c.authOn, running: c.running, flash: c.flash, body: `
<p class="sub">Stored in <span class="mono">settings.json</span> in the Data folder. This page is the control: the Unraid template's old variables only seeded it on first start.
Login, ports and folders stay in the template.</p>
${form('/settings', c.csrf, groups.map(g => `<div class="card"><h2>${esc(g)}</h2>${SCHEMA.filter(s => s.group === g).map(field).join('')}</div>`).join('')
    + `<div class="card inline"><button${dis(c)}>Save settings</button><span class="muted">Takes effect from the next run. Changing the daily time reschedules immediately.</span></div>`)}
<div class="card"><h2>Keys and passwords</h2>${secretCard}</div>` });
}

// ---------------- library ----------------
export function libraryPage(c) {
    const L = c.lib;
    const q = c.q ?? '';
    if (c.showId) {
        const sh = L.shows.get(c.showId);
        if (!sh) return layout({ title: 'Library', active: '/library', authOn: c.authOn, body: '<p>Show not found.</p>' });
        const seasons = [...new Set(sh.eps.map(e => e.season))].sort((a, b) => a - b);
        const cell = (ms) => ms.length ? ms.map(m => `${t(m.s)}–${t(m.e)} ${badge(m.src)}`).join('<br>') : '<span class="bad">none</span>';
        return layout({ title: sh.title, active: '/library', authOn: c.authOn, running: c.running, body: `
<p class="sub"><a href="/library">← all shows</a></p><div class="card"><h2>${esc(sh.title)}</h2>
<p class="muted" style="margin:0">${n(sh.eps.length)} episodes · ${n(sh.withIntro)} with an intro marker · ${n(sh.withCredits)} with credits</p></div>
${seasons.map(sn => `<div class="card"><h2>Season ${esc(sn)}</h2><table><thead><tr><th>ep</th><th class="l">title</th><th class="l">intro</th><th class="l">credits</th></tr></thead><tbody>
${sh.eps.filter(e => e.season === sn).sort((a, b) => a.ep - b.ep).map(e => `<tr><td>${esc(e.ep)}</td><td class="l">${esc(e.title)}</td><td class="l m">${cell(e.intro)}</td><td class="l m">${cell(e.credits)}</td></tr>`).join('')}
</tbody></table></div>`).join('')}` });
    }
    const flt = c.filter ?? '';
    let shows = [...L.shows.values()];
    if (q) shows = shows.filter(s => s.title.toLowerCase().includes(q.toLowerCase()));
    if (flt === 'missing') shows = shows.filter(s => s.withIntro < s.eps.length || s.withCredits < s.eps.length);
    if (flt === 'none') shows = shows.filter(s => s.withIntro === 0 && s.withCredits === 0);
    shows.sort((a, b) => a.title.localeCompare(b.title));
    const srcCells = (s) => SRC_COLS.map(k => `<td>${s.src[k] ? n(s.src[k]) : '<span class="muted">·</span>'}</td>`).join('');
    const mv = L.movies;
    return layout({ title: 'Library', active: '/library', authOn: c.authOn, running: c.running, body: `
<form method="get" action="/library" class="card inline"><input type="search" name="q" value="${esc(q)}" placeholder="Search shows" style="min-width:240px">
<select name="f"><option value="">All shows</option><option value="missing"${flt === 'missing' ? ' selected' : ''}>Missing some markers</option><option value="none"${flt === 'none' ? ' selected' : ''}>No markers at all</option></select>
<button>Filter</button><span class="muted">${n(shows.length)} shows</span></form>
<div class="card"><table><thead><tr><th>show</th><th>episodes</th><th>with intro</th><th>with credits</th>${SRC_COLS.map(k => `<th>${badge(k)}</th>`).join('')}</tr></thead><tbody>
${shows.slice(0, 400).map(s => `<tr><td><a href="/library?show=${s.id}">${esc(s.title)}</a></td><td>${n(s.eps.length)}</td>
<td>${pctCell(s.withIntro, s.eps.length)}</td><td>${pctCell(s.withCredits, s.eps.length)}</td>${srcCells(s)}</tr>`).join('')}
</tbody></table>${shows.length > 400 ? `<p class="muted">Showing 400 of ${n(shows.length)}; search to narrow.</p>` : ''}</div>
<div class="card"><h2>Movies</h2><p class="muted" style="margin:0 0 8px">${n(mv.total)} movies · ${n(mv.withCredits)} with a credits marker · ${n(mv.withIntro)} with an intro marker</p>
<table><thead><tr>${SRC_COLS.map(k => `<th>${badge(k)}</th>`).join('')}</tr></thead>
<tbody><tr>${SRC_COLS.map(k => `<td style="text-align:left">${n(mv.src[k])}</td>`).join('')}</tr></tbody></table></div>` });
}
const pctCell = (a, b) => b ? `${n(a)} <span class="muted">(${Math.round(100 * a / b)}%)</span>` : '–';

// ---------------- plan & apply ----------------
export function planPage(c) {
    const p = c.plan;
    const st = p?.stats ?? {};
    const act = c.action ?? '';
    const actions = ['add', 'update', 'reapply', 'retract', 'replace'];
    let rows = (p?.plan ?? []).filter(it => Object.values(it.changes ?? {}).some(ch => ch.action && ch.action !== 'keep'));
    if (act) rows = rows.filter(it => Object.values(it.changes ?? {}).some(ch => ch.action === act));
    const ch = (it) => Object.entries(it.changes ?? {}).filter(([, v]) => v.action && v.action !== 'keep').map(([k, v]) =>
        `<div><b>${esc(k)}</b> ${esc(v.action)}: ${(v.add ?? []).map(m => `${t(m.start)}–${t(m.end)} ${badge(String(m.src ?? '').split(':')[0] || 'mixed')}`).join(' ')}${(v.remove ?? []).length ? ` <span class="muted">(−${v.remove.length})</span>` : ''}</div>`).join('');
    const changes = (st.add ?? 0) + (st.update ?? 0) + (st.reapply ?? 0) + (st.retract ?? 0) + (st.replacePlex ?? 0);
    return layout({ title: 'Plan & apply', active: '/plan', authOn: c.authOn, running: c.running, flash: c.flash, body: `
<div class="card"><h2>Latest plan</h2>${p ? `<p class="muted" style="margin:0 0 8px">${esc(c.planFile)} · built ${esc(c.planAge)}</p>
<div class="row"><div><div class="big">${n(st.add)}</div>to add</div><div><div class="big">${n(st.update)}</div>to update</div><div><div class="big">${n(st.reapply)}</div>to re-apply</div>
<div><div class="big">${n(st.retract)}</div>to retract</div><div><div class="big">${n(st.alreadyCurrent)}</div>already current</div><div><div class="big">${n(st.keptPlex)}</div>Plex's own kept</div></div>
<p class="muted" style="margin:10px 0 0">New markers by source: ${Object.entries(st.bySource ?? {}).map(([k, v]) => `${badge(k)} ${n(v)}`).join(' ')}</p>` : '<p class="muted">No plan yet.</p>'}</div>
<div class="card inline">${form('/plan', c.csrf, `<button${dis(c)}>Build a new plan</button>`)}
${form('/apply', c.csrf, `<label class="inline" style="font-weight:400"><input type="checkbox" name="ok" value="1" required>I understand this writes into Plex's database</label>
<button class="danger"${dis(c)}>Apply now</button>`, { confirm: 'Write the planned markers into Plex now? A full database backup and an undo log are made first, and it refuses if anyone is streaming.' })}
<span class="muted">Apply builds a fresh plan with the current settings (same as the preview if nothing changed), runs the format selftest, and only writes with no one streaming.</span></div>
<div class="card"><h2>Changes ${changes ? `(${n(changes)} planned)` : ''}</h2>
<form method="get" action="/plan" class="inline" style="margin-bottom:8px"><select name="a"><option value="">All actions</option>${actions.map(a => `<option${a === act ? ' selected' : ''}>${a}</option>`).join('')}</select><button class="ghost">Filter</button></form>
${rows.length ? `<table><thead><tr><th>item</th><th class="l">changes</th></tr></thead><tbody>${rows.slice(0, 300).map(it => `<tr><td class="l">${esc(it.label)}</td><td class="l">${ch(it)}</td></tr>`).join('')}</tbody></table>
${rows.length > 300 ? `<p class="muted">Showing 300 of ${n(rows.length)}.</p>` : ''}` : '<p class="muted">Nothing to change.</p>'}</div>` });
}

// ---------------- runs & undo ----------------
export function runsPage(c) {
    const logs = c.undoLogs;
    const newest = logs.find(l => !l.undone);
    return layout({ title: 'Runs & undo', active: '/runs', authOn: c.authOn, running: c.running, flash: c.flash, body: `
<div class="card"><h2>Run history</h2>${historyTable(c.history)}</div>
<div class="card"><h2>Undo</h2><p class="muted" style="margin:0 0 10px">Each apply keeps an undo log that restores Plex's exact previous data. Only the <b>most recent</b> apply can be undone:
undoing an older one after newer ones would overwrite their changes, so undo steps back one run at a time. After an undo the next daily run will re-add those
markers unless you also change the settings that produced them.</p>
<table><thead><tr><th>applied (UTC)</th><th>added</th><th>removed</th><th>parts</th><th class="l"></th></tr></thead><tbody>
${logs.slice(0, 25).map(l => `<tr><td class="m">${esc(l.label)}</td><td>${n(l.ops.insert)}</td><td>${n(l.ops.delete)}</td><td>${n(l.ops.extra)}</td><td class="l">${l.undone ? '<span class="muted">undone</span>'
    : l === newest ? form('/undo', c.csrf, `<input type="hidden" name="file" value="${esc(l.file)}"><button class="danger"${dis(c)}>Undo this run</button>`, { confirm: `Undo the apply from ${l.label}? This removes ${l.ops.insert} markers and restores ${l.ops.delete}.` })
    : '<span class="muted">undo newer runs first</span>'}</td></tr>`).join('')}</tbody></table></div>` });
}

// ---------------- submit ----------------
export function submitPage(c) {
    const card = (svc) => {
        const d = c.sub[svc];
        const isT = svc === 'tidb';
        const name = isT ? 'TheIntroDB' : 'introdb.app';
        const keyOk = isT ? c.hasTidbKey : c.secrets.introdb_api_key;
        const cands = d?.candidates ?? [];
        const rules = isT
            ? 'Sends intros Plex detected itself, on episodes Plex matched to a TMDB episode, 5–200 s long, with the real file length so TheIntroDB can match the cut. Paced at 25 requests per 10 s (TheIntroDB OK\'d bulk submission under 40/10 s).'
            : 'Sends intros and end credits (as "outro") Plex detected itself, with the series IMDb id and season/episode (movies: credits only). PAL-speed (25 fps) files are skipped because introdb.app entries carry no file length. Paced at 1 per second; introdb.app allows 1 submission per segment per episode every 5 minutes.';
        const skipped = isT ? (d ? `${n(d.skippedIntroSyncWritten)} markers IntroSync wrote were excluded.` : '')
            : (d?.skipped ? `Excluded: ${n(d.skipped.introsyncWritten)} written by IntroSync · ${n(d.skipped.pal)} PAL-speed · ${n(d.skipped.multiple)} with more than one marker · ${n(d.skipped.noImdb)} without an IMDb id · ${n(d.skipped.bounds)} out of bounds · ${n(d.skipped.alreadySent)} already sent.` : '');
        return `<div class="card"><h2>${name}</h2>
<div class="row"><div><div class="big">${n(isT ? c.submitted.tidb : c.submitted.introdb)}</div>sent so far</div><div><div class="big">${d ? n(cands.length) : '…'}</div>ready to send</div>
<div>API key: ${keyOk ? '<span class="ok">set</span>' : '<span class="bad">not set</span> <a href="/settings">add in Settings</a>'}</div></div>
<p class="help" style="margin-top:10px">${esc(rules)}</p><p class="help">${esc(skipped)}</p>
${form(`/submit/${svc}`, c.csrf, `<div class="inline" style="margin:10px 0"><label style="font-weight:400">Send up to</label>
<input type="number" name="limit" value="${Math.min(50, cands.length) || 50}" min="1" max="${Math.max(1, cands.length)}" style="width:90px">
<button${keyOk && cands.length && c.authOn && !c.running ? '' : ' disabled'}>Submit to ${name}</button></div>`, { confirm: `Send these to ${name}? Submissions are public contributions and can't be recalled from here.` })}
${cands.length ? `<details><summary>Preview the first ${Math.min(100, cands.length)}</summary><table style="margin-top:8px"><thead><tr><th>item</th><th class="l">segment</th><th>start</th><th>end</th></tr></thead><tbody>
${cands.slice(0, 100).map(x => `<tr><td class="l">${esc(x.label)}</td><td class="l">${esc(x.segment)}</td><td>${t(x.start_ms)}</td><td>${t(x.end_ms)}</td></tr>`).join('')}</tbody></table></details>` : ''}</div>`;
    };
    const waiting = !c.subsAt;
    const asOf = waiting ? '<b>Working out what is ready to send…</b> This takes about a minute and a half; the page refreshes itself.'
        : `Lists as of ${esc(ago(c.subsAt / 1000))}${c.subsComputing ? ' (recalculating now)' : ''} · <a href="/submit?refresh=1">Recalculate</a>`;
    return layout({ title: 'Submit', active: '/submit', authOn: c.authOn, running: c.running, flash: c.flash, refresh: waiting ? 20 : 0, body: `
<p class="sub">${asOf}</p>
<div class="card"><h2>What gets submitted</h2><p style="margin:0">Only timings from <b>your own library</b>: markers Plex detected itself. Markers IntroSync wrote are never submitted,
so TheIntroDB's data is never copied into introdb.app or back into TheIntroDB, and introdb.app's data never goes into TheIntroDB (its terms forbid building on it).
Chapter-based timings aren't submitted: they need your review first, and that review queue isn't built yet.</p></div>
<div class="grid">${card('tidb')}${card('introdb')}</div>` });
}
