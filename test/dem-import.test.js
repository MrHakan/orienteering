import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAsc, parseHgt, parseHeightmap, gridToTerrain, packTerrain, unpackTerrain } from '../src/engine/demImport.js';
import { generate } from '../src/engine/quiz.js';

const asc = (cols, rows, cell, f, extra = '') => {
  let t = `ncols ${cols}\nnrows ${rows}\nxllcorner 0\nyllcorner 0\ncellsize ${cell}\n${extra}NODATA_value -9999\n`;
  for (let r = 0; r < rows; r++) t += Array.from({ length: cols }, (_, c) => f(c * cell, (rows - 1 - r) * cell)).join(' ') + '\n';
  return t;
};

test('ESRI ASCII grids: north-up orientation, voids filled, centre crop', () => {
  // Height rises to the north (y) only: the engine grid must rise with row index j.
  const g = parseAsc(asc(300, 300, 10, (x, y) => (x === 1000 && y === 1000 ? -9999 : (50 + y / 20).toFixed(2))));
  assert.equal(g.cols, 300); assert.equal(g.dx, 10);
  assert.ok(Number.isNaN(g.values[g.values.findIndex(Number.isNaN)]));
  const t = gridToTerrain(g, { name: 'test' });
  assert.equal(t.size, 2000); assert.equal(t.n, 257); assert.equal(t.meta.world, 'custom');
  const n = t.n, south = t.heights[10 * n + 128], north = t.heights[(n - 10) * n + 128];
  assert.ok(north > south + 80, 'north is higher, as in the file');
  assert.ok(t.heights.every(Number.isFinite));
  assert.throws(() => parseAsc('hello'), /Not an ESRI ASCII grid/);
  assert.throws(() => gridToTerrain(parseAsc(asc(30, 30, 10, () => 5))), /too small/);
  assert.throws(() => gridToTerrain(parseAsc(asc(120, 120, 10, () => 50))), /almost flat/);
});

test('SRTM tiles and heightmap images', () => {
  const side = 1201, buf = new ArrayBuffer(side * side * 2), view = new DataView(buf);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) view.setInt16((j * side + i) * 2, j === 5 && i === 5 ? -32768 : 300 + Math.round(200 * Math.sin(i / 40) * Math.cos(j / 50)), false);
  const hgt = parseHgt(buf, 'N37E032.hgt');
  assert.ok(Math.abs(hgt.dy - 92.1) < 1 && hgt.dx < hgt.dy, '3″ spacing, narrower east-west at 37° N');
  const t = gridToTerrain(hgt);
  assert.equal(t.size, 2000);
  assert.throws(() => parseHgt(new ArrayBuffer(10)), /SRTM/);
  const w = 64, data = new Uint8ClampedArray(w * w * 4);
  for (let k = 0; k < w * w; k++) { const v = (k % w) * 4; data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = v; data[k * 4 + 3] = 255; }
  const img = parseHeightmap({ width: w, height: w, data }, { metresWide: 1500, minHeight: 100, maxHeight: 300 });
  assert.equal(img.values[0], 100); assert.ok(Math.abs(img.values[w - 1] - (100 + 252 / 255 * 200)) < 1e-3);
  const ti = gridToTerrain(img);
  assert.equal(ti.size, 1500, 'a smaller area keeps its own extent');
});

test('packed terrain round-trips, and every mode can play on it', async () => {
  const t = gridToTerrain(parseAsc(asc(400, 400, 10, (x, y) => (80 + 60 * Math.exp(-((x - 2000) ** 2) / 180000) + 30 * Math.sin(y / 250) + 20 * Math.cos(x / 170)).toFixed(1))), { name: 'ridge' });
  const back = unpackTerrain(packTerrain(t));
  assert.deepEqual(back.heights, t.heights); assert.equal(back.meta.name, 'ridge');
  const q = await generate({ seed: 'dem', difficulty: 'medium', mode: 'route', world: 'custom', customTerrain: t });
  assert.equal(q.terrain.world, 'custom'); assert.equal(q.worldChoice, 'custom');
  assert.deepEqual(Array.from(q.terrain.heights.slice(0, 20)), Array.from(t.heights.slice(0, 20)));
});
