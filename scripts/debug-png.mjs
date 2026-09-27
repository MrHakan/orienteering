// Debug helper: writes a hillshade + contour PNG for a seed (no dependencies).
// usage: node scripts/debug-png.mjs <seed> [difficulty] [out.png]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { SeedManager } from '../src/engine/rng.js';
import { TerrainGenerator } from '../src/engine/terrainGenerator.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { getDifficulty } from '../src/engine/difficulty.js';

const [seed = 'demo', diff = 'medium', out = 'debug.png'] = process.argv.slice(2);
const t0 = performance.now();
const t = TerrainGenerator.generate(new SeedManager(seed).stream('terrain', 0), getDifficulty(diff).terrain);
const t1 = performance.now();
const model = new TerrainModel({ ...t, seed });
const a = model.analyzer;
const t2 = performance.now();
console.log({ gen: Math.round(t1 - t0), analyze: Math.round(t2 - t1), ...t.meta, landforms: undefined, summits: a.summits.length, saddles: a.saddles.length, depressions: a.depressions.length, interval: model.chooseContourInterval() });

const { n, heights } = model;
const interval = model.chooseContourInterval();
const W = n, img = Buffer.alloc(W * W * 3);
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
  const k = j * n + i;
  const gx = (heights[Math.min(k + 1, k - i + n - 1)] - heights[Math.max(k - 1, k - i)]) / (2 * model.cell);
  const gy = (heights[Math.min(k + n, n * n - 1)] - heights[Math.max(k - n, 0)]) / (2 * model.cell);
  const shade = Math.max(0, Math.min(1, 0.6 + (-gx * 0.7 + gy * 0.7) * 1.5));
  const t = (heights[k] - model.min) / (model.max - model.min);
  let r = 60 + 150 * t, g = 110 + 90 * t, b = 60 + 40 * t;
  r *= shade; g *= shade; b *= shade;
  const band = Math.floor(heights[k] / interval);
  const nb = [k + 1, k + n].filter((q) => q < n * n).some((q) => Math.floor(heights[q] / interval) !== band);
  if (nb) { const idx = Math.floor(heights[k] / interval) % 5 === 0; r = g = b = idx ? 20 : 50; }
  if (a.valleyMask[k] && model.drainage.accumulation[k] > 200) { r = 40; g = 80; b = 200; }
  const row = n - 1 - j;
  img.set([r, g, b], (row * W + i) * 3);
}
for (const s of a.summits) mark(s, [255, 0, 0]);
for (const s of a.saddles) mark(s, [255, 255, 0]);
for (const s of a.depressions) mark(s, [0, 255, 255]);
function mark(p, c) { for (let d = -2; d <= 2; d++) for (const [di, dj] of [[d, 0], [0, d]]) { const i = p.i + di, j = p.j + dj; if (i >= 0 && j >= 0 && i < n && j < n) img.set(c, ((n - 1 - j) * W + i) * 3); } }

const raw = Buffer.alloc((W * 3 + 1) * W);
for (let y = 0; y < W; y++) { raw[y * (W * 3 + 1)] = 0; img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
const crc = (buf) => { let c, crcT = []; for (let n2 = 0; n2 < 256; n2++) { c = n2; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n2] = c >>> 0; } let x = 0xffffffff; for (const b of buf) x = crcT[(x ^ b) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', out);
