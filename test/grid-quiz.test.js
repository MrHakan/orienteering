import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { gridCells, cellAt, parseCell, normaliseGridSize, headingHidden, gridScore } from '../src/engine/gridQuiz.js';
import { MapRenderer, quizMarkers } from '../src/render/mapRenderer.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { descriptorDistance } from '../src/engine/skyline.js';
import { scrambleLabels } from '../src/engine/scramble.js';
import { captionText } from '../src/export/composer.js';
import { supportsSunWatch, usesSunWatch, sunWatchFrame, solarPosition } from '../src/engine/sunWatch.js';

test('grid references run A1 west to east, then B1 north to south', () => {
  for (const n of [4, 6, 8, 16]) {
    const cells = gridCells(2000, n);
    assert.equal(cells.length, n * n);
    assert.equal(new Set(cells.map((p) => p.label)).size, n * n);
    assert.deepEqual(cells.slice(0, 4).map((p) => p.label), ['A1', 'A2', 'A3', 'A4']);
    assert.equal(cells[n].label, 'B1');
    assert.equal(cells.at(-1).label, `${String.fromCharCode(64 + n)}${n}`);
    for (const p of cells) assert.equal(cellAt(p.x, p.y, 2000, n), p.label);
    assert.equal(cellAt(0, 2000, 2000, n), 'A1');
    assert.equal(cellAt(2000, 0, 2000, n), cells.at(-1).label);
  }
  for (const [x, y] of [[-1, 0], [2001, 0], [0, -1], [0, 2001], [NaN, 500]]) assert.equal(cellAt(x, y, 2000, 4), null);
});

test('cell input accepts compact or spaced codes and rejects out-of-grid codes', () => {
  assert.equal(parseCell(' b 3 ', 4), 'B3');
  assert.equal(parseCell('p16', 16), 'P16');
  assert.equal(parseCell('f6', 6), 'F6');
  assert.equal(parseCell('G1', 6), null);
  assert.equal(parseCell('A7', 6), null);
  for (const value of ['A0', 'A01', 'A5', 'E1', 'A1junk', '<b>A1</b>', '', '11']) assert.equal(parseCell(value, 4), null);
  assert.equal(parseCell('P17', 16), null);
  assert.equal(normaliseGridSize('8'), 8);
  assert.equal(normaliseGridSize('6'), 6);
  assert.equal(normaliseGridSize('invalid'), 4);
});

test('rotating the display preserves grid references and pointer hit testing', () => {
  const mr = Object.create(MapRenderer.prototype);
  mr.data = { model: { size: 2000 }, grid: { size: 16 } };
  mr.S = 480; mr.cx = 300; mr.cy = 300;
  mr.canvas = { getBoundingClientRect: () => ({ left: 17, top: 29 }) };
  for (const angle of [0, 90, 180, 270]) {
    mr.cos = Math.cos(angle * Math.PI / 180); mr.sin = Math.sin(angle * Math.PI / 180);
    for (const p of gridCells(2000, 16)) {
      const [x, y] = mr.toCanvas(p.x, p.y);
      assert.equal(mr.hit({ clientX: x + 17, clientY: y + 29 }).label, p.label);
      const [wx, wy] = mr.toWorld(x, y);
      assert.ok(Math.abs(wx - p.x) < 1e-8 && Math.abs(wy - p.y) < 1e-8);
    }
    assert.equal(mr.hit({ clientX: -1000, clientY: -1000 }), null);
  }
});

for (const gridSize of [4, 6, 8, 16]) for (const gridChallenge of ['standard', 'lost-compass']) {
  test(`${gridSize}×${gridSize} ${gridChallenge} creates a validated cell-centre question`, async () => {
    const q = await generate({ seed: 'grid-check', mode: 'grid', gridSize, gridChallenge, difficulty: 'medium' });
    assert.equal(q.mode, 'grid');
    assert.equal(q.grid.size, gridSize);
    assert.equal(q.options.length, gridSize * gridSize);
    assert.equal(q.options.filter((o) => o.correct).length, 1);
    const correct = q.options.find((o) => o.correct);
    assert.equal(q.camera.x, correct.x); assert.equal(q.camera.y, correct.y);
    assert.equal(cellAt(correct.x, correct.y, q.terrain.size, gridSize), q.correctLabel);
    assert.equal(q.validation.ok, true); assert.equal(q.lowConfidence, false);
    assert.ok(q.validation.minDistance >= q.validation.minRequiredDistance);
    assert.equal(q.stats.cellsChecked, gridSize * gridSize);
    assert.equal(q.stats.directionsChecked, gridChallenge === 'lost-compass' ? 8 : 1);
    assert.equal(headingHidden(q), gridChallenge === 'lost-compass');
    assert.deepEqual(quizMarkers(q), []); // no hidden observer/distractor markers
    assert.equal(scrambleLabels(q, 3), q); // references never get scrambled
    assert.equal(captionText(q), `Find your cell: A1–${String.fromCharCode(64 + gridSize)}${gridSize}.`);
    assert.ok(captionText(q).length < 40); // exports never enumerate all cells
  });
}

test('grid replay and new positions retain fixed references; heading overrides apply', async () => {
  const opts = { seed: 'grid-replay', mode: 'grid', gridSize: 8, gridChallenge: 'standard', difficulty: 'hard', headingMode: 'cardinal' };
  const a = await generate(opts), b = await generate(opts), c = await generate({ ...opts, variant: 1 });
  assert.deepEqual(a.camera, b.camera);
  assert.equal(a.correctLabel, b.correctLabel);
  assert.deepEqual(a.terrain.heights, b.terrain.heights);
  assert.equal(a.heading.mode, 'cardinal'); assert.equal(a.camera.heading % 90, 0);
  assert.deepEqual(a.options.map((o) => [o.label, o.x, o.y]), c.options.map((o) => [o.label, o.x, o.y]));
  assert.notDeepEqual(a.camera, c.camera);
});

for (const gridSize of [4, 6, 8, 16]) for (const gridChallenge of ['standard', 'lost-compass']) {
  test(`sun/watch ${gridSize}×${gridSize} ${gridChallenge} retains validated cells and a visible solar cue`, async () => {
    const q = await generate({ seed: 'grid-check', mode: 'grid', difficulty: 'sun-watch', gridSize, gridChallenge });
    assert.equal(supportsSunWatch(q.mode), true);
    assert.equal(q.difficulty, 'sun-watch'); assert.equal(usesSunWatch(q), true);
    assert.equal(q.grid.size, gridSize); assert.equal(q.grid.challenge, gridChallenge);
    assert.equal(q.options.length, gridSize ** 2);
    assert.equal(q.options.filter(o => o.correct).length, 1);
    assert.equal(cellAt(q.camera.x, q.camera.y, q.terrain.size, gridSize), q.correctLabel);
    assert.deepEqual(q.heading, { degrees: q.camera.heading, text: '', arrow: '', mode: 'hidden' });
    assert.equal(headingHidden(q), true); assert.deepEqual(quizMarkers(q), []);
    assert.equal(scrambleLabels(q, 3), q);
    assert.equal(q.validation.ok, true); assert.equal(q.lowConfidence, false);
    const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
    const view = (p, heading) => model.skyline.viewDescriptor(p.x, p.y, heading, q.camera.fov,
      { eyeHeight: q.camera.eyeHeight, columns: 49 });
    const target = view(q.camera, q.camera.heading);
    const headings = gridChallenge === 'lost-compass' ? [0, 45, 90, 135, 180, 225, 270, 315] : [q.camera.heading];
    let closest = Infinity;
    for (const p of q.options.filter(o => !o.correct)) {
      const difference = Math.min(...headings.map(h => descriptorDistance(target, view(p, h))));
      assert.ok(Math.abs(difference - p.D) < 1e-9);
      assert.ok(difference >= q.validation.minRequiredDistance);
      closest = Math.min(closest, difference);
    }
    assert.ok(Math.abs(closest - q.validation.minDistance) < 1e-9);
    assert.equal(q.stats.directionsChecked, headings.length);
    const sun = solarPosition(q.sunWatch.hour24, q.sunWatch.minute, 0, q.sunWatch.latitude);
    assert.ok(sun.altitude > model.skyline.castRay(q.camera.x, q.camera.y, q.camera.z, sun.azimuth).angle + 4);
    assert.equal(sunWatchFrame(q, 4).watch.progress, 1);
    assert.ok(Math.abs(sunWatchFrame(q, 4).camera.pitch + 64) < 1e-9);
    assert.deepEqual(sunWatchFrame(q, 15).camera, q.camera);
    assert.equal(captionText(q), `Find your cell: A1–${String.fromCharCode(64 + gridSize)}${gridSize}.`);
  });
}

test('sun/watch grid replay preserves cells, ignores heading overrides and applies latitude tuning', async () => {
  const opts = { seed: 'grid-check', mode: 'grid', difficulty: 'sun-watch', gridSize: 6 };
  const a = await generate(opts), b = await generate({ ...opts, headingMode: 'exact' });
  assert.deepEqual(a.camera, b.camera); assert.deepEqual(a.options, b.options); assert.deepEqual(a.sunWatch, b.sunWatch);
  const tuned = await generate({ ...opts, tuning: { sunLat: 40 } });
  assert.equal(tuned.sunWatch.latitude, 40);
  assert.deepEqual(tuned.camera, a.camera); assert.deepEqual(tuned.options, a.options);
  const next = await generate({ ...opts, variant: 1 });
  assert.deepEqual(next.terrain.heights, a.terrain.heights);
  assert.notDeepEqual(next.camera, a.camera);
  assert.deepEqual(next.options.map(o => [o.label, o.x, o.y]), a.options.map(o => [o.label, o.x, o.y]));
  const ordinary = await generate({ ...opts, difficulty: 'medium' });
  assert.equal(usesSunWatch(ordinary), false); assert.equal(headingHidden(ordinary), false);
  assert.ok(ordinary.heading.text.length > 0);
});

test('lost compass compares every wrong cell in all eight directions', async () => {
  const q = await generate({ seed: 'grid-all-directions', mode: 'grid', gridSize: 8, gridChallenge: 'lost-compass', headingMode: 'exact' });
  assert.equal(q.heading.mode, 'intercardinal');
  const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
  const view = (p, heading) => model.skyline.viewDescriptor(p.x, p.y, heading, q.camera.fov, { eyeHeight: q.camera.eyeHeight, columns: 49 });
  const target = view(q.camera, q.camera.heading);
  let closest = Infinity;
  for (const p of q.options.filter((o) => !o.correct)) {
    let best = Infinity;
    for (let h = 0; h < 360; h += 45) best = Math.min(best, descriptorDistance(target, view(p, h)));
    assert.ok(Math.abs(best - p.D) < 1e-9);
    closest = Math.min(closest, best);
  }
  assert.ok(Math.abs(closest - q.validation.minDistance) < 1e-9);
});

test('grid refuses to emit a question without validated terrain', async () => {
  await assert.rejects(generate({ seed: 'invalid-grid', mode: 'grid', maxTerrainAttempts: 0 }), /No unambiguous grid question/);
});

test('small grids handle a depleted viewpoint pool across difficulty extremes', async () => {
  for (const difficulty of ['easy', 'master']) for (const gridChallenge of ['standard', 'lost-compass']) {
    const q = await generate({ seed: 'grid-matrix', mode: 'grid', gridSize: 4, difficulty, gridChallenge });
    assert.equal(q.validation.ok, true);
  }
});

const MASTER_SEEDS = ['gq-0', 'gq-1', 'gq-2', 'gq-3', 'gq-4', 'gq-5'];
let masterGrids;
const masterGrid = () => masterGrids ??= Promise.all(MASTER_SEEDS.map((seed) => generate({ seed, mode: 'grid', gridSize: 8, difficulty: 'master' })));

test('master grid: every look-alike cell differs by a skyline cue you can see', async () => {
  for (const q of await masterGrid()) {
    const wrong = q.options.filter((o) => !o.correct), minD = q.validation.minRequiredDistance;
    const closest = wrong.reduce((a, b) => b.D < a.D ? b : a), near = wrong.filter((o) => o.D < 2 * minD);
    const gate = [closest, ...near];
    for (const o of gate) assert.ok(o.cue.magnitude >= 1.6, `${q.seed} ${o.label}: cue ${o.cue.magnitude.toFixed(2)}°`);
    assert.equal(q.validation.weakestCue, +Math.min(...gate.map((o) => o.cue.magnitude)).toFixed(2));
    assert.equal(q.validation.lookalikes, near.length);
    const [row, column] = [q.correctLabel.charCodeAt(0) - 65, +q.correctLabel.slice(1) - 1];
    assert.equal(q.validation.remoteLookalikes, near.filter((o) => Math.max(Math.abs(o.row - row), Math.abs(o.column - column)) > 1).length);
  }
});

test('master grid: the dev tuning cue 0 switches the visible-cue gate off', async () => {
  const issue = (q) => q.log.filter((l) => l.issues.includes('look-alike cell without a visible cue')).length;
  const gated = await generate({ seed: 'gq-0', mode: 'grid', gridSize: 8, difficulty: 'master' });
  const open = await generate({ seed: 'gq-0', mode: 'grid', gridSize: 8, difficulty: 'master', tuning: { cue: 0 } });
  assert.ok(issue(gated) > 0, 'the gate rejected a candidate');
  assert.equal(issue(open), 0);
  assert.ok(open.validation.weakestCue < 1.6, 'the open search keeps a faint-cue question');
});

test('grid score: hardness measures closeness and spread, confidence the weakest cue', () => {
  const base = { closestD: 1.1, minD: 0.9, lookalikes: 4, remote: 1, weakestCue: 2, quality: 0.7, blockedFrac: 0, edgeFrac: 0 };
  const s = gridScore(base);
  for (const v of [s.hardness, s.confidence]) assert.ok(v >= 0 && v <= 1);
  assert.ok(gridScore({ ...base, remote: 4 }).hardness > s.hardness, 'distant look-alikes are harder');
  assert.ok(gridScore({ ...base, lookalikes: 12, remote: 3 }).hardness > s.hardness);
  assert.ok(gridScore({ ...base, closestD: 0.95 }).hardness > s.hardness);
  assert.ok(gridScore({ ...base, weakestCue: 1.2 }).confidence < s.confidence, 'a fainter cue is less fair');
  assert.ok(gridScore({ ...base, blockedFrac: 0.2 }).confidence < s.confidence);
  assert.equal(gridScore({ ...base, closestD: 0.95 }).confidence, s.confidence, 'closeness alone does not move confidence');
});

test('grid: below master only the reported numbers change; master repeats exactly', async () => {
  for (const [difficulty, gridSize, gridChallenge, label, heading] of [['medium', 8, 'standard', 'C5', 225], ['hard', 8, 'standard', 'G5', 346], ['expert', 16, 'lost-compass', 'K11', 0]]) {
    const q = await generate({ seed: 'grid-check', mode: 'grid', difficulty, gridSize, gridChallenge });
    assert.deepEqual([q.correctLabel, q.camera.heading], [label, heading], difficulty);
  }
  const [a] = await masterGrid(), b = await generate({ seed: MASTER_SEEDS[0], mode: 'grid', gridSize: 8, difficulty: 'master' });
  assert.deepEqual(b.camera, a.camera);
  assert.deepEqual([b.correctLabel, b.hardness, b.validation], [a.correctLabel, a.hardness, a.validation]);
});
