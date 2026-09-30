import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { gridCells, cellAt, parseCell, normaliseGridSize, headingHidden } from '../src/engine/gridQuiz.js';
import { MapRenderer, quizMarkers } from '../src/render/mapRenderer.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { descriptorDistance } from '../src/engine/skyline.js';
import { scrambleLabels } from '../src/engine/scramble.js';
import { captionText } from '../src/export/composer.js';

test('grid references run A1 west to east, then B1 north to south', () => {
  for (const n of [4, 8, 16]) {
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
  for (const value of ['A0', 'A01', 'A5', 'E1', 'A1junk', '<b>A1</b>', '', '11']) assert.equal(parseCell(value, 4), null);
  assert.equal(parseCell('P17', 16), null);
  assert.equal(normaliseGridSize('8'), 8);
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

for (const gridSize of [4, 8, 16]) for (const gridChallenge of ['standard', 'lost-compass']) {
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
