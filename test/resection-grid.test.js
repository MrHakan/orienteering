import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { cellAt } from '../src/engine/gridQuiz.js';
import { cellBorderMargin } from '../src/engine/friendQuiz.js';
import { surfaceElevation } from '../src/engine/terrainSurface.js';
import { DEG } from '../src/engine/grid.js';
import { bearingTo } from '../src/engine/mapModes.js';
import { RESECTION_BANDS, fixSlack, rivalFixes, resectionGridScore } from '../src/engine/resectionQuiz.js';

const modelOf = (q) => new TerrainModel({ ...q.terrain, meta: { world: q.terrain.world }, seed: q.terrain.modelSeed });
const resection = (seed, difficulty, gridSize, extra = {}) => generate({ seed, difficulty, mode: 'resection', resectionAnswer: 'grid', gridSize, ...extra });
const wholeMap = (q) => ({ x: q.terrain.size / 2, y: q.terrain.size / 2, size: q.terrain.size });
const SEEDS = ['rg-0', 'rg-1', 'rg-2', 'rg-3', 'rg-4', 'rg-5', 'rg-6', 'rg-7'];
let masterG8;
const master = () => masterG8 ??= Promise.all(SEEDS.map((seed) => resection(seed, 'master', 8, { world: 'auto' })));

function sees(model, a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.ceil(d / (model.cell / 2));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (model.getElevation(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) > a.z + (b.z - a.z) * t - 0.5) return false;
  }
  return true;
}

test('resection grid with hidden peaks: you stand on the centre of your cell', async () => {
  const quizzes = [...await master(), ...await Promise.all(['rg-a', 'rg-b', 'rg-c'].flatMap((seed) => [resection(seed, 'hard', 4), resection(seed, 'expert', 16)]))];
  for (const q of quizzes) {
    assert.equal(q.grid.origin, 'observer-cell-centre', q.seed);
    assert.equal(cellBorderMargin(q.camera.x, q.camera.y, wholeMap(q), q.grid.size), 0.5, `${q.seed} g${q.grid.size}`);
    assert.equal(cellAt(q.camera.x, q.camera.y, q.terrain.size, q.grid.size), q.correctLabel);
  }
  const easy = await resection('res-g', 'easy', 4);
  assert.equal(easy.grid.origin, 'observer', 'Easy marks the peaks and keeps its free observer');
});

test('resection grid: the fix survives the guaranteed reading error, and the explanation states it', async () => {
  assert.equal(fixSlack(RESECTION_BANDS.master, 8), 5.1);
  assert.equal(fixSlack(RESECTION_BANDS.master, 16), 3.1);
  assert.equal(fixSlack(RESECTION_BANDS.easy, 4), 1.1);
  for (const q of await master()) {
    const slack = fixSlack(RESECTION_BANDS.master, 8);
    assert.ok(q.validation.fixTolerance >= slack, `${q.seed}: ${q.validation.fixTolerance}`);
    assert.ok(q.validation.minPeakSize > 0 && Number.isFinite(q.validation.minPeakSize));
    const cell = q.explanation.correct.evidence.find((e) => e.type === 'observer-cell');
    assert.match(cell.text, /Allowing ±5\.1° of reading error/);
  }
});

test('resection grid: no other cell holds an unrefuted rival fix (independent brute force)', async () => {
  for (const q of await master()) {
    const model = modelOf(q), L = model.size, o = q.camera, peaks = q.resection.peaks, shown = peaks.map((p) => p.shown);
    const ranges = peaks.map((p) => Math.hypot(p.x - o.x, p.y - o.y)), reach = Math.max(2000, 0.85 * L);
    const hills = model.analyzer.summits.filter((s) => model.inside(s.x, s.y, 40) && (s.kind === 'summit' || (s.prominence || 0) >= 7))
      .map((s) => ({ x: s.x, y: s.y, z: surfaceElevation(model, s.x, s.y) + 2 }));
    // Walk each back-bearing from every hill in 5 m steps; a rival is where the two walks meet.
    let unrefuted = 0, rivals = 0;
    for (const a of hills) for (const b of hills) {
      if (a === b || (Math.hypot(a.x - peaks[0].x, a.y - peaks[0].y) < 1 && Math.hypot(b.x - peaks[1].x, b.y - peaks[1].y) < 1)) continue;
      const da = (shown[0] + 180) * DEG, db = (shown[1] + 180) * DEG;
      // Solve a + t·ua = b + s·ub by Cramer's rule, written out independently of the engine.
      const ua = [Math.sin(da), Math.cos(da)], ub = [Math.sin(db), Math.cos(db)], den = ua[0] * -ub[1] - ua[1] * -ub[0];
      const rx = b.x - a.x, ry = b.y - a.y, t = (rx * -ub[1] - ry * -ub[0]) / den, s = (ua[0] * ry - ua[1] * rx) / den;
      if (t < 100 || s < 100 || t > reach || s > reach) continue;
      const p = { x: a.x + ua[0] * t, y: a.y + ua[1] * t };
      if (!model.inside(p.x, p.y, 80) || model.getSlope(p.x, p.y) > 26 || cellAt(p.x, p.y, L, 8) === q.correctLabel) continue;
      rivals++;
      const at = { ...p, z: surfaceElevation(model, p.x, p.y) + 1.7 };
      const told = [a, b].some((h, i) => {
        const d = i ? s : t, e = Math.atan2(h.z - at.z, d) / DEG, e0 = peaks[i].elevation;
        return d / ranges[i] >= 2 || d / ranges[i] <= 0.5 || Math.abs(e - e0) >= 4 || (Math.sign(e) !== Math.sign(e0) && Math.abs(e - e0) >= 1.5) || !sees(model, at, h);
      });
      if (!told) unrefuted++;
    }
    assert.equal(unrefuted, 0, q.seed);
    assert.equal(rivals, q.validation.rivalFixes.refuted, `${q.seed}: the engine saw the same rivals`);
  }
});

test('resection grid: the rival scan finds the true fix when it is not excluded (positive control)', async () => {
  const q = (await master())[0], model = modelOf(q), o = q.camera, eye = { x: o.x, y: o.y, z: o.z };
  const other = q.correctLabel === 'A1' ? 'B2' : 'A1';
  const args = { model, observer: o, eye, peaks: q.resection.peaks, shown: q.resection.peaks.map((p) => p.shown), band: RESECTION_BANDS.master, gridSize: 8 };
  assert.equal(rivalFixes({ ...args, ownCell: q.correctLabel }).unrefuted, 0);
  assert.ok(rivalFixes({ ...args, ownCell: other, excludeTrue: false }).unrefuted >= 1);
});

test('resection grid score: weak rivals raise hardness, a tolerant fix raises confidence', async () => {
  const base = { base: 1, weak: 5, crossing: 70, tolerance: 6, minPeakSize: 1, farPeak: 1000 };
  const s = resectionGridScore(base);
  for (const v of [s.hardness, s.confidence]) assert.ok(v >= 0 && v <= 1);
  assert.ok(resectionGridScore({ ...base, weak: 20 }).hardness > s.hardness);
  assert.ok(resectionGridScore({ ...base, crossing: 40 }).hardness > s.hardness, 'an oblique crossing is harder to draw');
  assert.ok(resectionGridScore({ ...base, tolerance: 9 }).confidence > s.confidence);
  assert.ok(resectionGridScore({ ...base, minPeakSize: 0.3 }).confidence < s.confidence);
  assert.ok(resectionGridScore({ ...base, farPeak: 1700 }).confidence < s.confidence);
  assert.ok(resectionGridScore({ ...base, base: 0.6 }).hardness <= 0.6, 'the band stays the ceiling');
  const extreme = resectionGridScore({ base: 1, weak: 1e6, crossing: 0, tolerance: 1e6, minPeakSize: 1e6, farPeak: 0 });
  assert.equal(extreme.hardness, 1); assert.equal(extreme.confidence, 1);
  const quizzes = await master();
  assert.ok(new Set(quizzes.map((q) => q.hardness.toFixed(3))).size >= 4, 'hardness ranks master quizzes');
  assert.ok(new Set(quizzes.map((q) => q.validation.confidence.toFixed(3))).size >= 4, 'confidence ranks master quizzes');
});

test('resection: point answers and Easy grids are unchanged; grids are deterministic', async () => {
  const pick = (q) => ({ label: q.correctLabel, x: +q.camera.x.toFixed(2), y: +q.camera.y.toFixed(2), heading: +q.camera.heading.toFixed(1),
    hardness: +q.hardness.toFixed(4), confidence: q.validation.confidence });
  assert.deepEqual(pick(await generate({ seed: 'res-t', difficulty: 'master', mode: 'resection' })), { label: 'C', x: 1659.45, y: 2605.26, heading: 260.8, hardness: 1, confidence: 0.85 });
  const medium = pick(await generate({ seed: 'res-h', difficulty: 'medium', mode: 'resection' }));
  assert.deepEqual([medium.label, medium.x, medium.y, medium.hardness], ['C', 1185.13, 2428.44, 0.6]);
  assert.deepEqual(pick(await resection('res-g', 'easy', 4)), { label: 'B3', x: 1372.1, y: 1391.72, heading: 234.4, hardness: 0.25, confidence: 0.85 });
  const [a] = await master(), b = await resection(SEEDS[0], 'master', 8, { world: 'auto' });
  assert.deepEqual(b.camera, a.camera);
  assert.deepEqual([b.correctLabel, b.hardness, b.validation], [a.correctLabel, a.hardness, a.validation]);
});
