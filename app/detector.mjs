// Reference-based intro/credits detection ("method 4"): the engine behind fingerprint.mjs.
// Validated in dumb-populate/tidb/experiment (detect.mjs v4, FINDINGS-v1..v4): 15/19 intros matched on episodes with
// TheIntroDB truth, median 0.87 s, no false matches; median 1 read (16 s of audio) per episode.
//
// - Intro: a season sibling's known intro is the REFERENCE (Haitsma-Kalker style fingerprint, 32 bits per ~46 ms).
//   The target is read at the season's known intro positions: one 16 s read checked as two halves that must agree
//   on the alignment, then 8 s snippets stepping outward, each confirmed by a second snippet. Intros under 24 s:
//   one continuous window instead. PAL-speed targets get a sped-up reference.
// - Credits: single frames near the end (320x180 gray): "pure black + sharp text edges" = credits. The block's
//   edges are binary-searched; the start is the first frame with TEXT. Calibration against siblings is the caller's.
// - Reads: only through InfiniDysk's WebDAV in bounded, growing byte ranges (128 KiB -> 4 MiB) behind a local
//   proxy, so ffmpeg can't trigger read-ahead. Run the container with small loopback TCP buffers
//   (--sysctl net.ipv4.tcp_rmem/tcp_wmem = "4096 32768 65536"): measured 18 MB -> 2.5-15 MB per frame probe.
// The WebDAV password stays in memory: never logged, never on a command line.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';

export const VERSION = 9;   // bump when detection changes: stored misses are retried on a new version
export const SR = 11025;
const FRAME = 4096, HOP = 512;
export const HOP_S = HOP / SR;
const BANDS = 33, F_LO = 300, F_HI = 5000;
const SNIP_S = 8, SNIP_BER = 0.33, SNIP_MARGIN = 0.08, RUN_BER = 0.38;
export const REF_MARGIN_S = 5, SHORT_INTRO_S = 24;
const BYTE_SANITY = 600e6;                  // per-episode backstop; budgets are in seconds of media read
const CHUNK_MIN = 128 << 10, CHUNK_MAX = 4 << 20;
const FW = 320, FH = 180;

// ---------- fingerprint ----------
const rev = new Uint32Array(FRAME);
for (let i = 0, bits = Math.log2(FRAME); i < FRAME; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
const cosT = new Float64Array(FRAME / 2), sinT = new Float64Array(FRAME / 2);
for (let i = 0; i < FRAME / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / FRAME); sinT[i] = -Math.sin(2 * Math.PI * i / FRAME); }
const hann = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1)));
const edges = Array.from({ length: BANDS + 1 }, (_, i) => Math.round(F_LO * (F_HI / F_LO) ** (i / BANDS) * FRAME / SR));

export function fingerprint(pcm) {
    const n = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1);
    const out = new Uint32Array(n), re = new Float64Array(FRAME), im = new Float64Array(FRAME);
    let prev = null;
    for (let f = 0; f < n; f++) {
        for (let i = 0; i < FRAME; i++) { re[rev[i]] = pcm[f * HOP + i] * hann[i]; im[rev[i]] = 0; }
        for (let size = 2; size <= FRAME; size <<= 1) {
            const half = size >> 1, step = FRAME / size;
            for (let s = 0; s < FRAME; s += size) for (let k = 0; k < half; k++) {
                const c = cosT[k * step], sn = sinT[k * step], a = s + k, b = a + half;
                const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
                re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
            }
        }
        const e = new Float64Array(BANDS);
        for (let b = 0; b < BANDS; b++) { let s = 1e-9; for (let k = edges[b]; k < edges[b + 1]; k++) s += re[k] * re[k] + im[k] * im[k]; e[b] = Math.log(s); }
        let v = 0;
        if (prev) for (let b = 0; b < 32; b++) if ((e[b] - e[b + 1]) - (prev[b] - prev[b + 1]) > 0) v |= (1 << b);
        out[f] = v >>> 0; prev = e;
    }
    return out.subarray(1);   // frame i starts at (i + 1) * HOP_S
}
const FP0 = HOP_S;
const pop = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

// Where does the short sequence S sit inside the longer R? `core` limits acceptable positions.
export function locate(R, S, core = [0, R.length]) {
    const far = Math.round(2 / HOP_S);
    let best = { ber: 1, pos: -1 }, second = 1;
    for (let p = 0; p + S.length <= R.length; p++) {
        let e = 0; for (let i = 0; i < S.length; i++) e += pop(R[p + i] ^ S[i]);
        const ber = e / (32 * S.length);
        if (ber < best.ber) { if (Math.abs(p - best.pos) > far) second = Math.min(second, best.ber); best = { ber, pos: p }; }
        else if (Math.abs(p - best.pos) > far) second = Math.min(second, ber);
    }
    const inCore = best.pos >= core[0] - S.length * 0.4 && best.pos + S.length <= core[1] + S.length * 0.4;
    return { ...best, second, ok: best.pos >= 0 && S.length > 0 && inCore && best.ber < SNIP_BER && second - best.ber > SNIP_MARGIN };
}

// A reference: fingerprint of [intro - margin, intro + margin] and where the intro sits in it (seconds, in the
// reference's own sped-up timeline when k != 1).
export function mkRef(pcm, introStart, introLen, k) {
    const R = fingerprint(pcm);
    return { R, k, introStart, introLen, core: [Math.max(0, Math.floor((introStart - FP0) / HOP_S)), Math.floor((introStart + introLen - FP0) / HOP_S)] };
}
// Stored form (fingerprints.db): the 32-bit frames as a little-endian blob.
export const refToBlob = (R) => Buffer.from(R.buffer, R.byteOffset, R.byteLength);
export const blobToRef = (b) => { const c = Buffer.from(b); return new Uint32Array(c.buffer, c.byteOffset, c.byteLength >>> 2); };

function halvesAgree(ref, F, readStart) {
    const h = Math.floor(F.length / 2), A = F.subarray(0, h), B = F.subarray(h);
    const a = locate(ref.R, A, ref.core), b = locate(ref.R, B, ref.core);
    const shiftA = readStart + FP0 - (a.pos * HOP_S + FP0), shiftB = readStart + FP0 + h * HOP_S - (b.pos * HOP_S + FP0);
    const agree = a.pos >= 0 && b.pos >= 0 && Math.min(a.ber, b.ber) < SNIP_BER && Math.max(a.ber, b.ber) < 0.40 && Math.abs(shiftA - shiftB) < 0.3;
    return { agree, a, b, shift: a.ok ? shiftA : b.ok ? shiftB : null, start: agree ? ref.introStart + shiftA : null };
}

export function classify(px) {
    let pure = 0, bright = 0, edgesN = 0;
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
        const v = px[y * FW + x];
        if (v < 28) pure++; else if (v > 80) bright++;
        if (x > 0 && Math.abs(v - px[y * FW + x - 1]) > 50) edgesN++;
    }
    const n = FW * FH, p = pure / n, b = bright / n, e = edgesN / n;
    return p >= 0.97 && e < 0.001 ? 'black' : p >= 0.80 && e >= 0.002 && b < 0.25 ? 'credits' : 'content';
}
const creditsLike = (s) => s === 'credits' || s === 'black';

// ---------- stills (credits cards) ----------
// The first seconds of end credits are usually the same cards every episode (live action: 0.9-1.0 correlation between
// episodes, ~0 against the scene before; FINDINGS-v5). A sibling's 8 s card SEQUENCE, slid along the target, pins the
// credits start where calibrating the "first text frame" can't (seasons whose episodes disagree on that).
export const TW = 64, TH = 36, CARD_S = 8;
export function thumb(px) {   // 320x180 gray -> 64x36 (5x5 block means)
    const out = new Uint8Array(TW * TH);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
        let s = 0; for (let yy = 0; yy < 5; yy++) for (let xx = 0; xx < 5; xx++) s += px[(y * 5 + yy) * FW + x * 5 + xx];
        out[y * TW + x] = Math.round(s / 25);
    }
    return out;
}
// Normalised correlation of two thumbnails; null when either is (near) flat, e.g. a black frame between cards.
export function ncc(a, b) {
    const n = a.length;
    let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let s = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; va += x * x; vb += y * y; }
    return va / n < 16 || vb / n < 16 ? null : s / Math.sqrt(va * vb);
}
// sib: { frames, t0, fps, truth } with frames covering [truth - 3, truth + CARD_S + 1]. Slide its card part
// [truth, truth + CARD_S) along tgt.frames; returns the best alignment as a predicted credits start in tgt's timeline.
export function alignCards(sib, tgt) {
    const k0 = Math.round((sib.truth - sib.t0) * sib.fps), K = Math.round(CARD_S * sib.fps);
    const card = sib.frames.slice(k0, k0 + K);
    if (card.length < K) return null;
    const scores = [];
    for (let j = 0; j + K <= tgt.frames.length; j++) {
        let s = 0, n = 0;
        for (let k = 0; k < K; k++) { const v = ncc(card[k], tgt.frames[j + k]); if (v != null) { s += v; n++; } }
        scores.push(n >= K / 2 ? s / n : -1);
    }
    let bj = -1; scores.forEach((v, j) => { if (bj < 0 || v > scores[bj]) bj = j; });
    if (bj < 0) return null;
    const far = 2 * tgt.fps;   // runner-up must be > 2 s away (a card stays up for seconds)
    const second = Math.max(-1, ...scores.filter((_, j) => Math.abs(j - bj) > far));
    return { start: tgt.t0 + bj / tgt.fps, score: scores[bj], second };
}
// Do this sibling's credits look different from its own last seconds of story? (animation often doesn't)
export function distinctive(sib) {
    const k0 = Math.round((sib.truth - sib.t0) * sib.fps), K = Math.round(CARD_S * sib.fps);
    const pre = sib.frames.slice(0, Math.max(0, k0 - 2)), card = sib.frames.slice(k0, k0 + K);
    let s = 0, n = 0;
    for (const a of pre) for (const b of card) { const v = ncc(a, b); if (v != null) { s += v; n++; } }
    return card.length >= K && (n === 0 || s / n < 0.5);
}

// ---------- frame rates ----------
export const isPal = (f) => Math.abs(f - 25) < 0.05 || Math.abs(f - 50) < 0.05;
export const isFilm = (f) => Math.abs(f - 23.976) < 0.05 || Math.abs(f - 24) < 0.05;
// Speed factor from a reference's timeline to a target's (PAL speed-up plays 25/23.976 fast).
export const speedOf = (refFps, tgtFps) => (isPal(tgtFps) && isFilm(refFps)) ? 25 / refFps : (isFilm(tgtFps) && isPal(refFps)) ? tgtFps / 25 : 1;

// ---------- reader ----------
// Resolves Plex's /mnt/debrid/... symlinks to the backend's own WebDAV, read in bounded ranges; never through the
// mounts, which read ahead (InfiniDysk's rclone mount: ~200 MB per 8 s snippet; decypharr's dfs mount: 128 MB).
// - InfiniDysk (Usenet): /mnt/debrid/infinidysk/<p> -> <davUrl>/<p>, Basic auth. It fetches whole Usenet articles, so
//   downloads run ~3x the bytes read (v4 measurement).
// - decypharr (Real-Debrid): /mnt/debrid/decypharr/<p> -> <decypharrUrl>/webdav/<p>, no auth. Measured ~1x
//   (1 MiB range -> 1 MB, 16 MiB -> 18 MB of decypharr downloads).
// A backend without a URL (or InfiniDysk without a password) is simply not readable: those files are skipped.
export async function createReader({ davUrl, davUser, davPassword, decypharrUrl, debridRoot = '/mnt/debrid' }) {
    const auth = davPassword ? 'Basic ' + Buffer.from(`${davUser}:${davPassword}`).toString('base64') : null;
    const backends = [
        { name: 'infinidysk', prefix: `${debridRoot}/infinidysk/`, base: davUrl, auth, on: !!(davUrl && auth) },
        { name: 'decypharr', prefix: `${debridRoot}/decypharr/`, base: decypharrUrl ? `${decypharrUrl}/webdav` : null, auth: null, on: !!decypharrUrl },
    ];
    const sources = new Map(), urls = new Map(), audioMaps = new Map();
    // authErrors: the backend refused the login (401/403) mid-run, e.g. its WebDAV password was changed; callers stop.
    const stat = { bytes: 0, readErrors: 0, authErrors: 0, by: { infinidysk: 0, decypharr: 0 } };
    const server = createServer(async (req, res) => {
        const src = sources.get(decodeURIComponent(req.url.slice(1)));
        if (!src) { res.writeHead(404); return res.end(); }
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
        let closed = false; const ac = new AbortController();
        res.on('close', () => { closed = true; ac.abort(); });
        try {
            const hdr = src.b.auth ? { Authorization: src.b.auth } : {};
            if (src.size == null) {
                const h = await fetch(src.b.base + src.path, { method: 'HEAD', headers: hdr, signal: AbortSignal.timeout(30_000) });
                if (h.status === 401 || h.status === 403) stat.authErrors++;
                if (!h.ok) throw new Error(`HTTP ${h.status}`);
                src.size = Number(h.headers.get('content-length'));
            }
            let pos = m ? +m[1] : 0; const end = m && m[2] ? +m[2] : src.size - 1;
            res.writeHead(m ? 206 : 200, { 'Accept-Ranges': 'bytes', 'Content-Length': end - pos + 1, ...(m ? { 'Content-Range': `bytes ${pos}-${end}/${src.size}` } : {}) });
            let chunk = CHUNK_MIN;
            while (pos <= end && !closed) {
                const to = Math.min(end, pos + chunk - 1);
                chunk = Math.min(CHUNK_MAX, chunk * 2);
                const up = await fetch(src.b.base + src.path, { headers: { ...hdr, Range: `bytes=${pos}-${to}` }, signal: AbortSignal.any([ac.signal, AbortSignal.timeout(60_000)]) });
                if (up.status === 401 || up.status === 403) stat.authErrors++;
                if (!up.ok) throw new Error(`HTTP ${up.status}`);
                const buf = Buffer.from(await up.arrayBuffer());
                stat.bytes += buf.length;
                stat.by[src.b.name] += buf.length;
                if (!res.write(buf)) await new Promise(r => res.once('drain', r));
                pos = to + 1;
            }
            res.end();
        } catch { if (!closed) { stat.readErrors++; res.destroy(); } }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    // A URL ffmpeg can read for this Plex file path, or null (no readable backend / not resolvable).
    function urlFor(file) {
        if (urls.has(file)) return urls.get(file);
        let u = null;
        try {
            const t = fs.readlinkSync(file);
            const b = backends.find(x => x.on && t.startsWith(x.prefix));
            if (b) {
                const id = String(sources.size);
                sources.set(id, { b, path: t.slice(b.prefix.length - 1).split('/').map(encodeURIComponent).join('/') });
                u = `http://127.0.0.1:${port}/${id}`;
            }
        } catch { }
        urls.set(file, u);
        return u;
    }
    const backendOf = (file) => { try { const t = fs.readlinkSync(file); return backends.find(x => t.startsWith(x.prefix))?.name ?? 'other'; } catch { return 'unresolvable'; } };
    function ffmpeg(args, timeoutMs = 60_000) {
        return new Promise((resolve) => {
            const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rw_timeout', '30000000', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
            const chunks = []; let err = '';
            p.stdout.on('data', c => chunks.push(c)); p.stderr.on('data', c => { err = (err + c).slice(-300); });
            const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
            p.on('exit', (code) => { clearTimeout(t); resolve({ code, buf: Buffer.concat(chunks), err }); });
        });
    }
    // The English track explicitly: multi-audio WEB releases often default to a dub (TLOU: Italian, 0.41 vs 0.06).
    async function audioMap(url) {
        if (audioMaps.has(url)) return audioMaps.get(url);
        const r = await new Promise((resolve) => {
            const p = spawn('ffprobe', ['-v', 'error', '-probesize', '2000000', '-select_streams', 'a', '-show_entries', 'stream=index:stream_tags=language', '-of', 'json', url]);
            let o = ''; p.stdout.on('data', c => { o += c; }); p.on('exit', () => resolve(o));
            setTimeout(() => p.kill('SIGKILL'), 60_000);
        });
        let map = null;
        try { const st = JSON.parse(r).streams ?? []; const en = st.find(x => /^en/i.test(x.tags?.language ?? '')); if (en && st.length > 1) map = `0:${en.index}`; } catch { }
        audioMaps.set(url, map);
        return map;
    }
    async function audio(url, start, dur, k = 1) {
        const af = k === 1 ? `aresample=${SR}` : `aresample=${SR},asetrate=${Math.round(SR * k)},aresample=${SR}`;
        const map = await audioMap(url);
        const r = await ffmpeg(['-ss', String(Math.max(0, start)), '-t', String(dur), '-i', url, ...(map ? ['-map', map] : []), '-vn', '-ac', '1', '-af', af, '-f', 's16le', 'pipe:1'],
                               60_000 + dur * 1000);
        return new Int16Array(r.buf.buffer, r.buf.byteOffset, Math.floor(r.buf.length / 2));
    }
    // One 320x180 gray frame at (about) t: the nearest decodable frame after the keyframe seek, or null.
    async function grab(url, t) {
        const r = await ffmpeg(['-probesize', '1000000', '-analyzeduration', '500000', '-noaccurate_seek', '-ss', String(Math.max(0, t)), '-i', url, '-an', '-frames:v', '1',
                                '-vf', `scale=${FW}:${FH},format=gray`, '-f', 'rawvideo', 'pipe:1']);
        return r.buf.length >= FW * FH ? r.buf.subarray(0, FW * FH) : null;
    }
    async function frameAt(url, t) {
        const px = await grab(url, t);
        return px ? classify(px) : 'error';
    }
    // A contiguous stretch decoded at `fps`, as 64x36 thumbnails (stills matching). Frame i is at t + i / fps.
    async function seq(url, t, dur, fps) {
        const r = await ffmpeg(['-ss', String(Math.max(0, t)), '-t', String(dur), '-i', url, '-an', '-vf', `fps=${fps},scale=${FW}:${FH},format=gray`, '-f', 'rawvideo', 'pipe:1'],
                               60_000 + dur * 2000);
        const frames = []; for (let o = 0; o + FW * FH <= r.buf.length; o += FW * FH) frames.push(thumb(r.buf.subarray(o, o + FW * FH)));
        return { t0: Math.max(0, t), fps, frames };
    }
    async function framesAt(url, t, dur, fps) {
        const r = await ffmpeg(['-ss', String(Math.max(0, t)), '-t', String(dur), '-i', url, '-an', '-vf', `fps=${fps},scale=${FW}:${FH},format=gray`, '-f', 'rawvideo', 'pipe:1']);
        const out = []; for (let o = 0; o + FW * FH <= r.buf.length; o += FW * FH) out.push(classify(r.buf.subarray(o, o + FW * FH)));
        return out;
    }
    return { urlFor, backendOf, audio, grab, frameAt, framesAt, seq, stat, close: () => server.close() };
}

// ---------- detection ----------
// Reference from a sibling's known intro, read in the TARGET's speed (k). null if the read came back short.
export async function buildReference(rd, url, intro, k) {
    const start = Math.max(0, intro.start - REF_MARGIN_S), len = intro.end - intro.start;
    const pcm = await rd.audio(url, start, len + 2 * REF_MARGIN_S, k);
    if (pcm.length < SR * len * 0.8 / k) return null;
    // zeroStart: TheIntroDB's "starts at the beginning" (start 0). Copying it would carry the convention to every match
    // (TLOU: exact matches scored ~7 s off), so those starts get measured from the audio instead.
    return { ...mkRef(pcm, (intro.start - start) / k, len / k, k), zeroStart: intro.start <= 1 };
}

// Where the matching audio really starts/stops around a predicted edge. Returns [edge seconds | null, seconds read].
async function measureEdge(rd, url, ref, shift, pred, which) {
    const w0 = Math.max(0, which === 'end' ? pred - 12 : pred - 4), len = which === 'end' ? 20 : 18;
    const F = fingerprint(await rd.audio(url, w0, len));
    const W = Math.round(1 / HOP_S), errs = [];
    for (let j = 0; j < F.length; j++) {
        const i = Math.round((w0 + j * HOP_S - shift) / HOP_S);
        errs.push(i >= 0 && i < ref.R.length && i <= ref.core[1] ? pop(ref.R[i] ^ F[j]) / 32 : 1);
    }
    const good = errs.map((_, j) => { let s = 0, n = 0; for (let q = Math.max(0, j - W / 2); q < Math.min(errs.length, j + W / 2); q++) { s += errs[q]; n++; } return s / n < RUN_BER; });
    let edge = null;
    if (which === 'end') { for (let j = 0, run = 0; j < good.length; j++) { run = good[j] ? run + 1 : 0; if (run >= W) edge = j + 1; } }
    else { for (let j = 0, run = 0; j < good.length; j++) { run = good[j] ? run + 1 : 0; if (run >= W) { edge = j - W + 1; break; } } }
    return [edge == null ? null : w0 + FP0 + edge * HOP_S, len];
}

// hints: known intro starts of the season in the target's timeline, most common first.
// opts.budgetS: seconds of media read (80; premieres 160); opts.maxReads (10; premieres 20); opts.measure: measure the
// end from the audio (premieres, pilots, cross-season references).
export async function findIntro(rd, url, durS, ref, hints, { budgetS = 80, maxReads = 10, measure = false } = {}) {
    const L = ref.introLen, b0 = rd.stat.bytes, reads = [];
    let readS = 0;
    const fits = (s) => readS + s <= budgetS && rd.stat.bytes - b0 < BYTE_SANITY;
    const done = async (start, how, shift) => {
        let end = start + L, measuredEnd = false, measuredStart = false;
        if (measure && shift != null) {
            const [e, s] = await measureEdge(rd, url, ref, shift, end, 'end'); readS += s;
            if (e && e > start + 5) { end = e; measuredEnd = true; }
        }
        if (ref.zeroStart && shift != null) {
            const [b, s] = await measureEdge(rd, url, ref, shift, start, 'start'); readS += s;
            if (b != null && b < end - 5) { start = b; measuredStart = true; }
        }
        return { status: 'match', start: Math.max(0, start), end: Math.min(durS, end), how, measuredEnd, measuredStart, reads, readS };
    };
    if (L < SHORT_INTRO_S) {
        const core = ref.R.subarray(ref.core[0], ref.core[1]);
        for (const h of hints.slice(0, 2)) {
            if (!fits(L + 30)) break;
            const w0 = Math.max(0, h - 15), pcm = await rd.audio(url, w0, L + 30); readS += L + 30;
            if (pcm.length < SR * 5) { reads.push([+w0.toFixed(1), 'read-error']); continue; }
            const m = locate(fingerprint(pcm), core);
            reads.push([+w0.toFixed(1), +m.ber.toFixed(3), +m.second.toFixed(3), 'window']);
            if (m.ok) { const start = w0 + FP0 + m.pos * HOP_S; return done(start, 'window', start - ref.introStart); }
        }
        return { status: fits(L + 30) ? 'none' : 'budget', reads, readS };
    }
    const t0 = Math.max(0, hints[0] + L / 2 - SNIP_S);
    const pcm0 = await rd.audio(url, t0, 2 * SNIP_S); readS += 2 * SNIP_S;
    if (pcm0.length < SR * SNIP_S) reads.push([+t0.toFixed(1), 'read-error']);
    else {
        const r = halvesAgree(ref, fingerprint(pcm0), t0);
        reads.push([+t0.toFixed(1), +r.a.ber.toFixed(3), +r.b.ber.toFixed(3), r.agree ? 'agree' : 'x2']);
        if (r.agree) return done(r.start, 'halves', r.start - ref.introStart);
    }
    const step = Math.max(10, Math.min(60, L - SNIP_S - 2)), cap = Math.min(720, durS * 0.4), mid = hints[0] + L / 2 - SNIP_S / 2;
    const sched = hints.slice(1, 3).map(h => h + L / 2 - SNIP_S / 2);
    for (let i = 1; sched.length < maxReads * 2; i++) {
        const d = Math.ceil(i / 2) * step, t = mid + (i % 2 ? d : -d);
        if (mid - d < 0 && mid + d > cap) break;
        if (t >= 0 && t <= cap - SNIP_S) sched.push(t);
    }
    for (const t of sched) {
        if (reads.length >= maxReads || !fits(SNIP_S)) break;
        const pcm = await rd.audio(url, t, SNIP_S); readS += SNIP_S;
        if (pcm.length < SR * SNIP_S * 0.8) { reads.push([+t.toFixed(1), 'read-error']); if (reads.filter(x => x[1] === 'read-error').length >= 2) return { status: 'read-error', reads, readS }; continue; }
        const m = locate(ref.R, fingerprint(pcm), ref.core);
        reads.push([+t.toFixed(1), +m.ber.toFixed(3), +m.second.toFixed(3)]);
        if (!m.ok) continue;
        const shift = t + FP0 - (m.pos * HOP_S + FP0), pred = [ref.introStart + shift, ref.introStart + L + shift];
        const cands = [pred[0] + 0.65 * L - SNIP_S / 2, t + SNIP_S, t - SNIP_S, pred[0] + 0.15 * L].map(x => Math.max(0, x));
        const tc = cands.find(x => Math.abs(x - t) >= SNIP_S * 0.75 && x >= pred[0] - 1 && x + SNIP_S <= pred[1] + 1) ?? cands[3];
        const m2 = locate(ref.R, fingerprint(await rd.audio(url, tc, SNIP_S)), ref.core); readS += SNIP_S;
        const shift2 = tc + FP0 - (m2.pos * HOP_S + FP0);
        reads.push([+tc.toFixed(1), +m2.ber.toFixed(3), +m2.second.toFixed(3), 'confirm']);
        if (m2.pos >= 0 && m2.ber < 0.40 && Math.abs(shift2 - shift) < 0.3) return done(pred[0], 'snippets', shift);
    }
    return { status: fits(SNIP_S) && reads.length < maxReads ? 'none' : 'budget', reads, readS };
}

// Raw credits block (uncalibrated). hintFromEnd: seconds before EOF where the season's credits usually start.
export async function findCredits(rd, url, durS, hintFromEnd, { maxProbes = 20 } = {}) {
    let n = 0; const b0 = rd.stat.bytes;
    const more = () => n < maxProbes && rd.stat.bytes - b0 < BYTE_SANITY;
    const at = async (t) => { t = Math.max(0, Math.min(durS - 1, t)); n++; return rd.frameAt(url, t); };
    const offsets = new Set(hintFromEnd
        ? [3, 20, hintFromEnd - 45, hintFromEnd - 15, hintFromEnd, hintFromEnd + 15, hintFromEnd + 45].map(Math.round)
        : [3, 20, 45, 75, 110, 150, 200, 260, 330, 420]);
    const grid = [];
    for (const d of [...offsets].filter(d => d >= 3 && d < durS).sort((a, b) => a - b)) grid.push({ t: durS - d, s: await at(durS - d) });
    if (grid.filter(g => g.s === 'error').length > 3) return { status: 'read-error', probes: n };
    grid.sort((a, b) => a.t - b.t);
    const pattern = grid.map(g => ({ credits: 'C', black: 'B', content: 'o', error: 'e' })[g.s]).join('');
    const runs = []; let cur = null;
    for (let i = 0; i < grid.length; i++) { if (creditsLike(grid[i].s)) { if (cur) cur[1] = i; else cur = [i, i]; } else if (cur) { runs.push(cur); cur = null; } }
    if (cur) runs.push(cur);
    const run = runs.reverse().find(r => grid.slice(r[0], r[1] + 1).some(g => g.s === 'credits')) ?? null;
    if (!run) return { status: 'no-credits-block', probes: n, pattern };
    const firstText = grid.findIndex((g, i) => i >= run[0] && g.s === 'credits');
    let lo = firstText > 0 ? grid[firstText - 1].t : null, hi = grid[firstText].t;
    for (let back = 120; lo === null && back <= 600 && more(); back += 120) {
        const t = grid[0].t - back; if ((await at(t)) === 'credits') hi = t; else lo = t;
    }
    if (lo === null) return { status: 'no-start-edge', probes: n, pattern };
    while (hi - lo > 3 && more()) { const mid = (lo + hi) / 2; if ((await at(mid)) === 'credits') hi = mid; else lo = mid; }
    let end = durS, final = true;
    if (run[1] < grid.length - 1) {
        let a = grid[run[1]].t, b = grid[run[1] + 1].t;
        while (b - a > 3 && more()) { const mid = (a + b) / 2; if (creditsLike(await at(mid))) a = mid; else b = mid; }
        end = a; final = false;
    }
    const fr = await rd.framesAt(url, hi - 5, 6, 4);
    let r0 = fr.length; for (let i = fr.length - 1; i >= 0 && creditsLike(fr[i]); i--) r0 = i;
    let first = null; for (let i = r0; i < fr.length; i++) if (fr[i] === 'credits') { first = i; break; }
    return { status: 'found', start: first != null ? hi - 5 + first / 4 : hi, end, final, probes: n + 1, pattern };
}

// Known intro starts (seconds, target timeline), clustered within 5 s, most common first.
export function hintsFor(starts, fallback) {
    const clusters = [];
    for (const s of [...starts].sort((a, b) => a - b)) { const c = clusters.find(c => Math.abs(c.at - s) < 5); if (c) { c.n++; c.at = (c.at * (c.n - 1) + s) / c.n; } else clusters.push({ at: s, n: 1 }); }
    const out = clusters.sort((a, b) => b.n - a.n).map(c => c.at);
    return out.length ? out : [fallback];
}

// ---------- selftest (synthetic audio/frames; no reads) ----------
export function selftest() {
    let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const noise = (secs, amp) => Int16Array.from({ length: Math.round(secs * SR) }, () => (rnd() - 0.5) * amp);
    const cat = (...a) => { const o = new Int16Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
    const music = (secs, s0) => { let st = s0; const r = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 2 ** 32);
        const o = new Int16Array(Math.round(secs * SR)); let y = 0;
        for (let i = 0; i < o.length; i++) { const t = i / SR, beat = Math.floor(t * 2), en = Math.exp(-((t * 2) % 1) * 3), f = 220 * 2 ** (((beat * 7) % 12) / 12);
            y = 0.97 * y + (r() - 0.5) * 2200; o[i] = y + en * (5000 * Math.sin(2 * Math.PI * f * t) + 2500 * Math.sin(2 * Math.PI * 1.5 * f * t)); }
        return o; };
    const speed = (x, k) => Int16Array.from({ length: Math.floor(x.length / k) }, (_, i) => x[Math.min(x.length - 1, Math.round(i * k))]);
    const res = [];
    const intro = music(60, 99), ref = mkRef(cat(noise(REF_MARGIN_S, 8000), intro, noise(REF_MARGIN_S, 8000)), REF_MARGIN_S, 60, 1);
    const tgt = cat(noise(40, 9000), intro, noise(60, 9000));
    const two = halvesAgree(ref, fingerprint(tgt.subarray(60 * SR, 76 * SR)), 60);
    res.push(['16 s read, halves agree', two.agree && Math.abs(two.start - 40) < 0.3]);
    res.push(['other audio rejected', !halvesAgree(ref, fingerprint(noise(16, 9000)), 0).agree]);
    const short = music(15, 5), sref = mkRef(cat(noise(REF_MARGIN_S, 8000), short, noise(REF_MARGIN_S, 8000)), REF_MARGIN_S, 15, 1);
    const sw = locate(fingerprint(cat(noise(25, 9000), short, noise(20, 9000))), sref.R.subarray(sref.core[0], sref.core[1]));
    res.push(['short intro window', sw.ok && Math.abs(sw.pos * HOP_S - 25) < 0.3]);
    const k = 25 / 23.976, fast = cat(noise(38, 9000), speed(intro, k), noise(60, 9000));
    const fref = mkRef(speed(cat(noise(REF_MARGIN_S, 8000), intro, noise(REF_MARGIN_S, 8000)), k), REF_MARGIN_S / k, 60 / k, k);
    const pal = halvesAgree(fref, fingerprint(fast.subarray(55 * SR, 71 * SR)), 55);
    res.push(['PAL speed', pal.agree && Math.abs(pal.start - 38) < 0.3]);
    const back = blobToRef(refToBlob(ref.R));
    res.push(['blob round trip', back.length === ref.R.length && back.every((v, i) => v === ref.R[i])]);
    const frame = (fill, textPx) => { const p = new Uint8Array(FW * FH).fill(fill); for (let i = 0; i < textPx; i++) p[Math.floor(rnd() * p.length)] = 230; return p; };
    const scene = Uint8Array.from({ length: FW * FH }, (_, i) => 20 + Math.round(60 * ((i % FW) / FW)));
    res.push(['frame classes', [classify(frame(10, 150)), classify(frame(5, 0)), classify(frame(110, 0)), classify(scene)].join() === 'credits,black,content,content']);
    // stills: a sibling's card sequence found in a target whose credits start 23.5 s into a 60 s window
    const noiseT = () => Uint8Array.from({ length: TW * TH }, () => Math.floor(rnd() * 200));
    const cards = Array.from({ length: 6 }, () => noiseT()), cardAt = (t) => cards[Math.min(5, Math.floor(t / 1.5))];
    const sibS = { t0: 0, fps: 4, truth: 3, frames: Array.from({ length: 48 }, (_, i) => i / 4 < 3 ? noiseT() : cardAt(i / 4 - 3)) };
    const tgtS = { t0: 100, fps: 4, frames: Array.from({ length: 240 }, (_, i) => i / 4 < 23.5 ? noiseT() : cardAt(i / 4 - 23.5)) };
    const al = alignCards(sibS, tgtS);
    res.push(['stills alignment', !!al && Math.abs(al.start - 123.5) <= 0.25 && al.score > 0.9 && al.score - al.second > 0.3 && distinctive(sibS)]);
    return res;
}
