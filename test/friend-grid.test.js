import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { cellAtExtent } from '../src/engine/gridQuiz.js';
import { MapRenderer, quizMarkers } from '../src/render/mapRenderer.js';
import { ExportComposer, captionText } from '../src/export/composer.js';
import { scrambleLabels } from '../src/engine/scramble.js';

for (const difficulty of ['easy', 'medium']) for (const gridSize of [4, 8, 16]) {
  test(`${difficulty} friend grid ${gridSize} scores the person's cell and preserves the qualified sighting`, async () => {
    const opts = { seed: 'friend-demo', mode: 'friend', difficulty };
    const point = await generate(opts);
    const q = await generate({ ...opts, friendAnswer: 'grid', gridSize });
    assert.deepEqual(q.camera, point.camera);
    assert.deepEqual(q.terrain.heights, point.terrain.heights);
    assert.deepEqual(q.friend.matches, point.options);
    for (const key of ['x', 'y', 'z', 'height', 'observerHidden']) assert.equal(q.friend[key], point.friend[key]);
    assert.equal(q.correctLabel, cellAtExtent(q.friend.x, q.friend.y, q.mapExtent, gridSize));
    assert.equal(q.options.length, gridSize ** 2);
    assert.equal(q.options.filter(o => o.correct).length, 1);
    assert.equal(q.grid.cellMetres, q.mapExtent.size / gridSize);
    assert.deepEqual(q.grid.target, { x: q.friend.x, y: q.friend.y });
    assert.deepEqual(quizMarkers(q), []);
    assert.equal(scrambleLabels(q, 3), q);
    assert.match(captionText(q), /^Find your friend's cell: A1–/);
    assert.ok(captionText(q).length < 60);
    if (difficulty === 'easy') assert.notEqual(q.correctLabel, cellAtExtent(q.camera.x, q.camera.y, q.mapExtent, gridSize));
  });
}

test('friend grid replays depth trap and new positions on the same terrain', async () => {
  const opts = { seed: 'friend-replay', mode: 'friend', difficulty: 'master', friendChallenge: 'depth-trap', friendAnswer: 'grid', gridSize: 16 };
  const a = await generate(opts), b = await generate(opts), c = await generate({ ...opts, variant: 1 });
  assert.deepEqual(a.friend, b.friend); assert.deepEqual(a.grid, b.grid);
  assert.equal(a.correctLabel, b.correctLabel);
  assert.deepEqual(a.terrain.heights, c.terrain.heights);
  assert.notDeepEqual(a.camera, c.camera);
  assert.equal(a.validation.ok, true);
  assert.equal(a.friend.observerHidden, true);
});

test('cropped grid hit testing and polygons use the displayed extent at every rotation', () => {
  const mr = Object.create(MapRenderer.prototype);
  mr.data = { model: { size: 2000 }, extent: { x: 700, y: 1200, size: 400 }, grid: { size: 4 } };
  mr.S = 360; mr.cx = 200; mr.cy = 200;
  mr.canvas = { getBoundingClientRect: () => ({ left: 10, top: 20 }) };
  const polygon = [];
  mr.ctx = { beginPath() {}, closePath() {}, moveTo: (x, y) => polygon.push(mr.toWorld(x, y)), lineTo: (x, y) => polygon.push(mr.toWorld(x, y)) };
  for (const angle of [0, 90, 180, 270]) {
    mr.cos = Math.cos(angle * Math.PI / 180); mr.sin = Math.sin(angle * Math.PI / 180);
    const [x, y] = mr.toCanvas(650, 1250);
    assert.equal(mr.hit({ clientX: x + 10, clientY: y + 20 }).label, 'B2');
    const [ox, oy] = mr.toCanvas(490, 1250);
    assert.equal(mr.hit({ clientX: ox + 10, clientY: oy + 20 }), null);
    polygon.length = 0; mr.gridPolygon('B2');
    for (const [i, expected] of [[600, 1300], [700, 1300], [700, 1200], [600, 1200]].entries()) {
      assert.ok(Math.hypot(polygon[i][0] - expected[0], polygon[i][1] - expected[1]) < 1e-8);
    }
  }
});

test('question maps hide FRIEND and hidden YOU; answer maps reveal the exact subject', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => {
    const texts = [], arcs = [], ctx = new Proxy({ measureText: () => ({ width: 20 }), fillText: text => texts.push(text), arc: (...args) => arcs.push(args) },
      { get: (target, key) => target[key] ?? (() => {}), set: (target, key, value) => { target[key] = value; return true; } });
    return { getContext: () => ctx, texts, arcs };
  } };
  try {
    for (const observerHidden of [true, false]) {
      const c = Object.create(ExportComposer.prototype);
      c.quiz = { mode: 'friend', friend: { observerHidden }, camera: { x: 550, y: 1100, heading: 0, fov: 50 },
        terrain: { contourInterval: 5 }, options: [], correctLabel: 'B2',
        grid: { size: 4, target: { x: 650, y: 1250 } }, mapExtent: { x: 700, y: 1200, size: 400 } };
      c.model = { size: 2000, getContours: () => [] }; c.layout = { map: { s: 400 } }; c.options = { northUp: true };
      c.buildMaps();
      assert.equal(c.mapCanvas.texts.includes('FRIEND'), false);
      assert.equal(c.mapCanvas.texts.includes('YOU'), !observerHidden);
      assert.equal(c.mapRevealCanvas.texts.includes('FRIEND'), true);
      assert.equal(c.mapRevealCanvas.texts.includes('YOU'), true);
      assert.ok(c.mapCanvas.texts.includes('100 m per cell · 5 m contours'));
      assert.ok(c.mapRevealCanvas.arcs.some(([x, y, radius]) => x === 82 && y === 82 && radius === 4));
    }
  } finally { globalThis.document = previous; }
});
