// Renders icon.png (256x256) for the Unraid template: a skip-forward glyph over a timeline with a
// highlighted (skipped) segment, on a violet-to-orange rounded tile. Same art as the page's /icon.svg.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const N = 256, SS = 4;
const px = Buffer.alloc(N * N * 4);
const mix = (a, b, t) => a + (b - a) * t;
const S = N / 64;   // design grid is 64x64, like the SVG

function inRoundRect(x, y, x0, y0, w, h, r) {
    const cx = Math.min(Math.max(x, x0 + r), x0 + w - r), cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
    return x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
    const s = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
    const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// returns [r, g, b, a] in 0..255 for one sub-sample at design coords (u, v)
function sample(u, v) {
    if (!inRoundRect(u, v, 0, 0, 64, 64, 14)) return [0, 0, 0, 0];
    const t = Math.min(1, Math.max(0, (u + v) / 128));
    let c = [mix(109, 255, t), mix(74, 106, t), mix(255, 61, t)];
    const white = (a) => { c = [mix(c[0], 255, a), mix(c[1], 255, a), mix(c[2], 255, a)]; };
    if (inTriangle(u, v, [16, 17], [30, 28], [16, 39]) || inTriangle(u, v, [30, 17], [44, 28], [30, 39])
        || inRoundRect(u, v, 45, 17, 4, 22, 1.5)) white(1);
    if (inRoundRect(u, v, 12, 46, 40, 5, 2.5)) white(inRoundRect(u, v, 21, 46, 14, 5, 2.5) ? 1 : 0.4);
    return [...c, 255];
}

for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const [r, g, b, a] = sample((x + (sx + 0.5) / SS) / S, (y + (sy + 0.5) / SS) / S);
        acc[0] += r * a; acc[1] += g * a; acc[2] += b * a; acc[3] += a;
    }
    const i = (y * N + x) * 4, a = acc[3];
    px[i] = a ? acc[0] / a : 0; px[i + 1] = a ? acc[1] / a : 0; px[i + 2] = a ? acc[2] / a : 0; px[i + 3] = a / (SS * SS);
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
writeFileSync(new URL('./icon.png', import.meta.url), Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]));
console.log('wrote icon.png');
