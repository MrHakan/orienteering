import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { cellAtExtent } from '../src/engine/gridQuiz.js';
import { MapRenderer, quizMarkers } from '../src/render/mapRenderer.js';
import { ExportComposer, captionText } from '../src/export/composer.js';
import { scrambleLabels } from '../src/engine/scramble.js';

import { cellBorderMargin, centredFriendExtent, personSight, hypothesisLattice, friendGridScore, friendShortlist } from '../src/engine/friendQuiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { cellAt, gridCells } from '../src/engine/gridQuiz.js';
import { descriptorDistance } from '../src/engine/skyline.js';
import { surfaceElevation } from '../src/engine/terrainSurface.js';
import { SeedManager } from '../src/engine/rng.js';

for (const difficulty of ['easy', 'medium', 'master']) for (const gridSize of [4, 6, 8, 16]) {
  test(`${difficulty} friend grid ${gridSize} puts the friend on a cell centre with a qualified sighting`, async () => {
    const opts = { seed: 'friend-demo', mode: 'friend', difficulty };
    const q = await generate({ ...opts, friendAnswer: 'grid', gridSize });
    assert.equal(q.correctLabel, cellAtExtent(q.friend.x, q.friend.y, q.mapExtent, gridSize));
    // Exactly the centre: half a cell of range/bearing error keeps the same answer.
    assert.ok(Math.abs(cellBorderMargin(q.friend.x, q.friend.y, q.mapExtent, gridSize) - 0.5) < 1e-6);
    const centre = q.options.find(o => o.correct);
    assert.ok(Math.hypot(centre.x - q.friend.x, centre.y - q.friend.y) < 1e-6);
    assert.equal(q.grid.origin, 'friend-cell-centre');
    const correct = q.friend.matches.filter(m => m.correct);
    assert.equal(correct.length, 1);
    assert.equal(correct[0].x, q.friend.x); assert.equal(correct[0].y, q.friend.y);
    // The sighting is real and every look-alike keeps the same range and apparent size.
    const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
    const sight = personSight(model, q.camera, q.friend);
    assert.ok(sight.visible);
    assert.ok(Math.abs(sight.distance - correct[0].distance) < 1e-6);
    // Medium and up: every look-alike has the same range and apparent size (Easy uses three depths).
    if (difficulty !== 'easy') for (const m of q.friend.matches) {
      assert.ok(Math.abs(m.distance - correct[0].distance) < 1e-6);
      assert.ok(Math.abs(m.angularHeight - correct[0].angularHeight) <= 0.015 + 1e-9);
    }
    assert.ok(Math.abs(((sight.bearing - q.camera.heading + 540) % 360) - 180) <= 3.5, 'friend near the middle of the view');
    for (const p of [q.camera, ...q.friend.matches]) {
      assert.ok(Math.abs(p.x - q.mapExtent.x) <= q.mapExtent.size / 2 && Math.abs(p.y - q.mapExtent.y) <= q.mapExtent.size / 2);
    }
    assert.equal(q.options.length, gridSize ** 2);
    assert.equal(q.options.filter(o => o.correct).length, 1);
    assert.equal(q.grid.cellMetres, q.mapExtent.size / gridSize);
    assert.deepEqual(q.grid.target, { x: q.friend.x, y: q.friend.y });
    assert.deepEqual(quizMarkers(q), []);
    assert.equal(scrambleLabels(q, 3), q);
    assert.match(captionText(q), /^Find your friend's cell: A1–/);
    assert.ok(captionText(q).length < 60);
    assert.match(q.explanation.correct.evidence.find(e => e.type === 'person-cell').text, new RegExp(`centre of ${q.correctLabel}`));
    if (difficulty === 'easy') assert.notEqual(q.correctLabel, cellAtExtent(q.camera.x, q.camera.y, q.mapExtent, gridSize));
  });
}

test('point answers keep the original A/B/C friend sighting', async () => {
  for (const difficulty of ['easy', 'master']) {
    const a = await generate({ seed: 'friend-demo', mode: 'friend', difficulty });
    const b = await generate({ seed: 'friend-demo', mode: 'friend', difficulty, gridSize: 8 });
    assert.deepEqual(a.friend, b.friend); assert.deepEqual(a.camera, b.camera); assert.equal(a.correctLabel, b.correctLabel);
    assert.equal(a.grid, undefined);
  }
});

test('local friend crops slide onto a cell centre only when everything stays inside', () => {
  const model = { size: 2000 };
  const extent = { x: 700, y: 1200, size: 400 };
  const out = centredFriendExtent(model, extent, { x: 713, y: 1187 }, 4, [{ x: 600, y: 1100 }]);
  assert.ok(Math.abs(cellBorderMargin(713, 1187, out, 4) - 0.5) < 1e-9);
  assert.equal(out.size, 400);
  assert.ok(Math.abs(out.x - extent.x) <= 50 && Math.abs(out.y - extent.y) <= 50);
  assert.equal(centredFriendExtent(model, extent, { x: 713, y: 1187 }, 4, [{ x: 880, y: 1100 }]), null, 'candidate pushed out of the crop');
  assert.equal(centredFriendExtent(model, { x: 200, y: 200, size: 400 }, { x: 240, y: 240 }, 4, []), null, 'crop would leave the terrain');
  assert.equal(cellBorderMargin(0, 0, { x: 200, y: 200, size: 400 }, 4), 0);
});

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

// Master friend grids: the same sighting from another cell must not give the same view.
const FRIEND_SEEDS = ['fg-0', 'fg-1', 'fg-2', 'fg-3', 'fg-4', 'fg-5'];
let masterFriends;
const masterFriend = () => masterFriends ??= Promise.all(FRIEND_SEEDS.map((seed) => generate({ seed, mode: 'friend', difficulty: 'master', friendAnswer: 'grid', gridSize: 8 })));

/** Independent re-computation: view distances of every consistent sighting whose friend stands on one of `points`. */
function sightings(q, points, { far = 0 } = {}) {
  const model = new TerrainModel({ ...q.terrain, meta: { world: q.terrain.world }, seed: q.terrain.modelSeed }), L = model.size, cam = q.camera;
  const dx = q.friend.x - cam.x, dy = q.friend.y - cam.y, range = Math.hypot(dx, dy), seen = personSight(model, cam, q.friend);
  const view = (o) => model.skyline.viewDescriptor(o.x, o.y, cam.heading, cam.fov, { eyeHeight: cam.eyeHeight, columns: 33 });
  const base = view(cam), out = [];
  for (const point of points) {
    if (cellAt(point.x, point.y, L, q.grid.size) === q.correctLabel || Math.hypot(point.x - q.friend.x, point.y - q.friend.y) < far) continue;
    const o = { x: point.x - dx, y: point.y - dy };
    if (!model.inside(o.x, o.y, 0) || !model.inside(point.x, point.y, 0) || model.getSlope(o.x, o.y) > 26 || model.getSlope(point.x, point.y) > 26) continue;
    const observer = { x: o.x, y: o.y, z: surfaceElevation(model, o.x, o.y) + cam.eyeHeight };
    const sight = personSight(model, observer, point);
    if (!sight.visible || Math.abs(sight.distance - range) > 1e-6 || Math.abs(sight.elevation - seen.elevation) > q.validation.elevationTolerance) continue;
    out.push(descriptorDistance(base, view(observer)));
  }
  return { model, out };
}
const engineLattice = (q, model) => hypothesisLattice(model, new SeedManager(`${q.seed}#${q.difficulty}`)
  .stream('friend-terrain', q.stats.terrainAttempt, q.friend.challenge, q.heading.mode, q.variant).fork('hypotheses'))
  .map((p) => ({ x: p.x + q.friend.x - q.camera.x, y: p.y + q.friend.y - q.camera.y }));

test('master friend grid: no other cell centre gives the same sighting and view', async () => {
  for (const q of await masterFriend()) {
    const { out } = sightings(q, gridCells(q.terrain.size, 8));
    for (const D of out) assert.ok(D >= q.validation.minRequiredDistance, `${q.seed}: another cell looks the same (${D.toFixed(2)})`);
    assert.equal(typeof q.validation.lookalikeElsewhere, 'boolean');
    assert.ok(q.validation.rivalCells >= 2 && Number.isFinite(q.validation.weakestCue));
  }
});

test('friend grid flag: clean quizzes have no look-alike on the lattice; flagged ones say so', async () => {
  const flagged = await generate({ seed: 'qq-16', world: 'auto', mode: 'friend', difficulty: 'master', friendAnswer: 'grid', gridSize: 8 });
  assert.equal(flagged.validation.lookalikeElsewhere, true, 'qq-16 has no clean candidate');
  for (const q of [...await masterFriend(), flagged]) {
    const { model } = sightings(q, []), { out } = sightings(q, engineLattice(q, model), { far: 240 });
    const twin = out.some((D) => D < q.validation.minRequiredDistance);
    assert.equal(q.validation.lookalikeElsewhere, twin, `${q.seed}: flag matches the lattice scan`);
    if (twin) assert.ok(q.validation.confidence <= 0.4, `${q.seed}: flagged confidence ${q.validation.confidence}`);
  }
});

test('friend grid score and shortlist floor', () => {
  const band = { min: 0.8, max: 3.2 }, base = { closestD: 1.5, rivals: 3, weakestCue: 1.5, band, quality: 0.7, blockedFrac: 0, edgeFrac: 0 };
  const s = friendGridScore(base);
  for (const v of [s.hardness, s.confidence]) assert.ok(v >= 0 && v <= 1);
  assert.ok(friendGridScore({ ...base, closestD: 1 }).hardness > s.hardness);
  assert.ok(friendGridScore({ ...base, rivals: 8 }).hardness > s.hardness);
  assert.ok(friendGridScore({ ...base, weakestCue: 1 }).confidence < s.confidence);
  assert.equal(friendGridScore({ ...base, closestD: 1 }).confidence, s.confidence, 'closeness alone does not move confidence');
  const sorted = [{ hardness: 0.9 }, { hardness: 0.8 }, { hardness: 0.5 }, { hardness: 0.4 }];
  assert.deepEqual(friendShortlist(sorted).map((q) => q.hardness), [0.9, 0.8]);
  assert.deepEqual(friendShortlist(sorted.slice(2)).map((q) => q.hardness), [0.5, 0.4]);
});

test('friend: point answers and Easy grids are unchanged; master grids repeat exactly', async () => {
  const pick = (q) => [q.correctLabel, +q.camera.x.toFixed(2), +q.camera.y.toFixed(2), q.camera.heading, +q.hardness.toFixed(4), +q.validation.confidence.toFixed(4)];
  assert.deepEqual(pick(await generate({ seed: 'friend-demo', mode: 'friend', difficulty: 'master' })), ['C', 1032.18, 601.48, 269, 0.6829, 0.9446]);
  assert.deepEqual(pick(await generate({ seed: 'friend-demo', mode: 'friend', difficulty: 'easy', friendAnswer: 'grid', gridSize: 8 })), ['E5', 1174.73, 1632.46, 180, 0.0833, 0.9506]);
  const [a] = await masterFriend(), b = await generate({ seed: FRIEND_SEEDS[0], mode: 'friend', difficulty: 'master', friendAnswer: 'grid', gridSize: 8 });
  assert.deepEqual(b.camera, a.camera); assert.deepEqual(b.friend, a.friend);
  assert.deepEqual([b.correctLabel, b.hardness, b.validation], [a.correctLabel, a.hardness, a.validation]);
});
