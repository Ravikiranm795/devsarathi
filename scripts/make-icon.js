'use strict';
// Draws the extension icon (a dharma wheel: the chariot wheel Sarathi steers) as a 128x128 PNG with no image library.
// Run once: node scripts/make-icon.js   (the result is committed: packages/vscode/media/icon.png)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 128;
const px = Buffer.alloc(N * N * 4);
const bg = [18, 24, 38];
const ring = [45, 212, 191];
const accent = [96, 165, 250];

function blend(i, c, a) {
  for (let k = 0; k < 3; k++) px[i + k] = Math.round(px[i + k] * (1 - a) + c[k] * a);
  px[i + 3] = 255;
}

const cx = (N - 1) / 2;
const cy = (N - 1) / 2;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    // rounded-square background
    const dx = Math.abs(x - cx) - (N / 2 - 14);
    const dy = Math.abs(y - cy) - (N / 2 - 14);
    const out = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - 14;
    const inside = out <= 0 ? 1 : Math.max(0, 1 - out);
    px[i] = bg[0];
    px[i + 1] = bg[1];
    px[i + 2] = bg[2];
    px[i + 3] = Math.round(255 * inside);
    if (!inside) continue;
    const r = Math.hypot(x - cx, y - cy);
    const ang = Math.atan2(y - cy, x - cx);
    // outer ring
    const ringCov = Math.max(0, 1 - Math.abs(r - 46) / 4.5);
    if (ringCov > 0) blend(i, ring, Math.min(1, ringCov * 1.4));
    // 8 spokes
    const spokeAngle = ((ang + Math.PI * 2) % (Math.PI / 4));
    const dist = Math.min(spokeAngle, Math.PI / 4 - spokeAngle) * r;
    if (r > 14 && r < 46) {
      const cov = Math.max(0, 1 - dist / 3);
      if (cov > 0) blend(i, accent, cov);
    }
    // hub
    const hub = Math.max(0, 1 - Math.abs(r - 9) / 3.5);
    if (r < 12 && hub > 0) blend(i, ring, Math.min(1, hub * 1.5));
    if (r < 6) blend(i, ring, 1);
    // small beads between spokes on the rim
    for (let k = 0; k < 8; k++) {
      const a = (k + 0.5) * (Math.PI / 4);
      const bx = cx + Math.cos(a) * 55;
      const by = cy + Math.sin(a) * 55;
      const d = Math.hypot(x - bx, y - by);
      if (d < 4.2) blend(i, ring, Math.min(1, 4.2 - d));
    }
  }
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;
ihdr[9] = 6; // RGBA
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const out = path.resolve(__dirname, '..', 'packages', 'vscode', 'media', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${path.relative(process.cwd(), out)} (${png.length} bytes)`);
