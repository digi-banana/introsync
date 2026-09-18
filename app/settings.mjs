// IntroSync settings: the web UI's Settings page is the control surface (user request 2026-09-18).
// Values live in $TIDB_DATA_DIR/settings.json (mode 600). On the very first start, when that file doesn't
// exist yet, each setting is seeded from the container's environment (the Unraid template's old variables)
// or its default; after that the file wins and the environment is ignored for these keys.
// API keys are separate write-only files in $TIDB_DATA_DIR/secrets/ (dir 700, files 600): the UI can set,
// replace or clear them but never reads them back, and nothing here logs them.
// Login (AUTH_*), ports, paths and PLEX_URL deliberately stay in the template: they're the root of trust
// and the plumbing, and a settings page can't safely change its own login.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.TIDB_DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'settings.json');
const SECRETS_DIR = path.join(DATA_DIR, 'secrets');

export const SCHEMA = [
    { key: 'APPLY_ENABLED', type: 'bool', def: false, group: 'Writing', label: 'Write markers into Plex',
      help: 'Off = look up and plan only. On = each daily run writes the planned markers into Plex (after a passing format selftest, only with no one streaming, with a full database backup and an undo log).' },
    { key: 'POLICY', type: 'enum', def: 'fill', options: ['fill', 'prefer-tidb'], group: 'Writing', label: 'Policy',
      help: 'fill = never replace markers Plex detected itself. prefer-tidb = replace them with TheIntroDB data.' },
    { key: 'KEEP_BACKUPS', type: 'int', def: 3, min: 1, max: 30, group: 'Writing', label: 'Plex database backups to keep',
      help: 'One full backup (~520 MB) is taken per apply, so with a daily run this is roughly days of history. Undo logs are kept separately and never pruned.' },
    { key: 'TIDB_ENABLED', type: 'bool', def: true, group: 'Sources', label: 'Use TheIntroDB',
      help: 'Primary source: community-verified timings.' },
    { key: 'CHAPTERS_ENABLED', type: 'bool', def: false, group: 'Sources', label: "Use the files' chapter names",
      help: 'Named chapters (Intro, Opening Credits, End Credits, Recap…) already in Plex\'s database. Ranked below TheIntroDB, above introdb.app. Movies get credits only.' },
    { key: 'INTRODB_ENABLED', type: 'bool', def: true, group: 'Sources', label: 'Use introdb.app',
      help: 'Fallback: only fills a segment type the other sources lack.' },
    { key: 'PAL_GUARD', type: 'bool', def: true, group: 'Sources', label: 'PAL speed-up guard',
      help: 'A 25 fps file in a 23.976 fps season plays 4.3% fast, so community timings drift on it. On = use only its own chapters there.' },
    { key: 'MAP_RECAP', type: 'bool', def: true, group: 'Sources', label: 'Recaps become Skip Intro',
      help: 'Plex has no recap marker, so a recap is added as an extra intro marker.' },
    { key: 'MAP_PREVIEW', type: 'bool', def: true, group: 'Sources', label: '"Next time on" previews become credits',
      help: 'Skipping a preview lands on Up Next.' },
    { key: 'TIDB_BUDGET', type: 'int', def: 985, min: 0, max: 1000, group: 'Lookups', label: 'TheIntroDB lookups per run',
      help: 'Their limit is 1000/day with an API key, 500/day per IP without.' },
    { key: 'INTRODB_BUDGET', type: 'int', def: 500, min: 0, max: 2000, group: 'Lookups', label: 'introdb.app lookups per run',
      help: 'Paced at 1 request/second. Its terms forbid bulk-downloading the database, so keep this modest.' },
    { key: 'RUN_AT', type: 'time', def: '07:30', group: 'Schedule', label: 'Daily run time',
      help: 'Local time (HH:MM). After Plex\'s maintenance window, so markers Plex wiped overnight are re-applied.' },
    { key: 'RUN_ON_START', type: 'bool', def: false, group: 'Schedule', label: 'Also run when the container starts',
      help: 'Runs the whole chain, writes included if enabled, 15 s after every start or recreate. Prefer Run now.' },
];
export const SECRETS = {
    tidb_api_key: { label: 'TheIntroDB API key', help: 'Raises lookups to 1000/day and is required to submit. From your theintrodb.org account.' },
    introdb_api_key: { label: 'introdb.app API key', help: 'Stored for future introdb.app submissions (not used yet). Starts with idb_.' },
};

const BY_KEY = Object.fromEntries(SCHEMA.map(s => [s.key, s]));

// Parse one raw value (from env, a form, or the file) into the setting's type; throws on bad input.
export function coerce(s, raw) {
    if (s.type === 'bool') {
        if (typeof raw === 'boolean') return raw;
        const v = String(raw ?? '').trim().toLowerCase();
        if (['true', 'on', '1', 'yes'].includes(v)) return true;
        if (['false', 'off', '0', 'no', ''].includes(v)) return false;
        throw new Error(`${s.label}: expected on/off`);
    }
    if (s.type === 'int') {
        const v = Number(String(raw).trim());
        if (!Number.isInteger(v) || v < s.min || v > s.max) throw new Error(`${s.label}: whole number ${s.min}–${s.max}`);
        return v;
    }
    if (s.type === 'enum') {
        const v = String(raw).trim();
        if (!s.options.includes(v)) throw new Error(`${s.label}: one of ${s.options.join(', ')}`);
        return v;
    }
    if (s.type === 'time') {
        const v = String(raw).trim();
        const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v);
        if (!m) throw new Error(`${s.label}: HH:MM`);
        return `${m[1].padStart(2, '0')}:${m[2]}`;
    }
    throw new Error(`unknown type ${s.type}`);
}

function writeAtomic(file, text, mode) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, mode); } catch { }
}

let cur = null;
export let seededFromEnv = false;

export function load() {
    let fileVals = {};
    const exists = fs.existsSync(FILE);
    if (exists) {
        try { fileVals = JSON.parse(fs.readFileSync(FILE, 'utf8')).values ?? {}; }
        catch (e) { throw new Error(`settings.json unreadable (${e.message}); fix or delete it`); }
    }
    const vals = {};
    for (const s of SCHEMA) {
        if (s.key in fileVals) { try { vals[s.key] = coerce(s, fileVals[s.key]); continue; } catch { } }
        // Not in the file (first start, or a setting added since): seed from the environment, else default.
        const env = process.env[s.key];
        try { vals[s.key] = env !== undefined ? coerce(s, env) : s.def; } catch { vals[s.key] = s.def; }
    }
    seededFromEnv = !exists;
    cur = vals;
    save();
    return cur;
}

function save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeAtomic(FILE, JSON.stringify({ updated: new Date().toISOString(), values: cur }, null, 2) + '\n', 0o600);
}

export const get = (k) => { if (!cur) load(); return cur[k]; };
export const all = () => { if (!cur) load(); return { ...cur }; };

// Validate a whole form's worth of changes first; only if every field is valid, apply and save.
// Returns the keys whose value actually changed.
export function update(raw) {
    if (!cur) load();
    const next = { ...cur }, errors = [];
    for (const s of SCHEMA) {
        // Unchecked checkboxes are absent from a form post, so a missing bool means "off".
        const v = s.type === 'bool' ? (raw[s.key] ?? 'false') : raw[s.key];
        if (v === undefined) continue;
        try { next[s.key] = coerce(s, v); } catch (e) { errors.push(e.message); }
    }
    if (errors.length) throw new Error(errors.join('; '));
    const changed = SCHEMA.map(s => s.key).filter(k => next[k] !== cur[k]);
    cur = next;
    if (changed.length) save();
    return changed;
}

// ---------- secrets (write-only) ----------
const secretFile = (name) => {
    if (!(name in SECRETS)) throw new Error('unknown secret');
    return path.join(SECRETS_DIR, name);
};
export const secretPath = (name) => secretFile(name);
export function secretIsSet(name) {
    try { return fs.statSync(secretFile(name)).size > 0; } catch { return false; }
}
export function setSecret(name, value) {
    const f = secretFile(name);
    const v = String(value ?? '').trim();
    if (!v) { try { fs.unlinkSync(f); } catch { } return 'cleared'; }
    if (v.length > 512 || /[\r\n\0]/.test(v)) throw new Error('that key looks malformed');
    fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(SECRETS_DIR, 0o700); } catch { }
    writeAtomic(f, v + '\n', 0o600);
    return 'set';
}
