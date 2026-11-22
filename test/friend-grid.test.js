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

const friendGrid = (seed, difficulty = 'master', world = 'auto') => generate({ seed, world, mode: 'friend', difficulty, friendAnswer: 'grid', gridSize: 8 });
// Seeds whose earlier (unchecked) question had another cell centre with the same sighting and view.
const CENTRE_TWIN_SEEDS = ['qq-5', 'qq-16', 'qq-17', 'qq-21', 'qq-32', 'qq-38', 'qq-40'];
let centreTwins;
const centreTwinFriends = () => centreTwins ??= Promise.all(CENTRE_TWIN_SEEDS.map((seed) => friendGrid(seed)));
const lookalikes = (q) => {
  const { model, out: centres } = sightings(q, gridCells(q.terrain.size, 8)), { out: lattice } = sightings(q, engineLattice(q, model), { far: 240 });
  const limit = q.validation.lookalikeLimit;
  return { centre: centres.some((D) => D < limit), lattice: lattice.some((D) => D < limit) };
};
const assertFlagged = (q) => {
  assert.deepEqual([q.validation.lookalikeElsewhere, q.validation.ok, q.lowConfidence, q.stats.pick], [true, false, true, 'flagged'], q.seed);
  assert.ok(q.validation.confidence <= 0.4 && q.hardness <= 0.3, `${q.seed}: flagged numbers ${q.hardness} / ${q.validation.confidence}`);
  assert.ok(q.validation.issues.includes('look-alike sighting in another cell'));
  assert.match(q.explanation.caution, /uncertain/);
};

test('friend grid: a clean question has no other cell centre with the same sighting and view', async () => {
  for (const q of [...await masterFriend(), ...await centreTwinFriends()]) {
    assert.equal(q.validation.lookalikeLimit, 0.8);
    assert.ok(q.validation.rivalCells >= 2 && Number.isFinite(q.validation.weakestCue));
    if (q.validation.lookalikeElsewhere) { assertFlagged(q); continue; }
    const { out } = sightings(q, gridCells(q.terrain.size, 8));
    for (const D of out) assert.ok(D >= q.validation.lookalikeLimit, `${q.seed}: another cell looks the same (${D.toFixed(2)})`);
    assert.equal(q.validation.ok, true);
  }
});

test('friend grid flag: flagged exactly when the picked sighting has a look-alike in another cell', async () => {
  const quizzes = [...await masterFriend(), ...await centreTwinFriends()];
  for (const q of quizzes) {
    const found = lookalikes(q);
    assert.equal(q.validation.lookalikeElsewhere, found.centre || found.lattice, `${q.seed}: flag matches the independent scans`);
    if (q.validation.lookalikeElsewhere) assertFlagged(q);
  }
  // qq-16 / qq-38: candidates without a twin at a centre or on the search lattice all have one farther away.
  assert.deepEqual(quizzes.filter((q) => q.validation.lookalikeElsewhere).map((q) => q.seed), ['qq-16', 'qq-38']);
});

test('friend grid: candidates with a twin are logged and set aside before the pick', async () => {
  for (const q of [...await masterFriend(), ...await centreTwinFriends()]) {
    const candidates = q.log.filter((l) => l.stage === 'candidate' && l.attempt === q.stats.terrainAttempt);
    assert.equal(candidates.length, q.stats.questionsCompared, q.seed);
    assert.equal(candidates.filter((l) => !l.ok).length, q.stats.lookalikeCandidates, q.seed);
    for (const l of candidates) assert.deepEqual(l.issues, l.ok ? [] : ['look-alike sighting in another cell']);
  }
  // Pinned counts: the sightings searched on the observer lattice (pool stage) and at the other cell
  // centres both mark candidates; qq-5 needs both.
  const counts = Object.fromEntries((await centreTwinFriends()).map((q) => [q.seed, [q.stats.lookalikeCandidates, q.stats.questionsCompared]]));
  assert.deepEqual(counts, { 'qq-5': [5, 14], 'qq-16': [2, 3], 'qq-17': [1, 5], 'qq-21': [3, 7], 'qq-32': [2, 12], 'qq-38': [4, 5], 'qq-40': [4, 8] });
});

test('friend grid pick: from the three hardest clean candidates, none much easier than the best', async () => {
  for (const q of [...await masterFriend(), ...await centreTwinFriends()]) {
    if (q.stats.pick !== 'shortlist') continue;
    const open = q.log.filter((l) => l.stage === 'candidate' && l.attempt === q.stats.terrainAttempt && l.ok).map((l) => l.hardness).sort((a, b) => b - a);
    const h = +q.hardness.toFixed(4);
    assert.ok(open.slice(0, 3).includes(h), `${q.seed}: ${h} among ${open.slice(0, 3)}`);
    assert.ok(h >= open[0] - 0.15, `${q.seed}: ${h} vs best ${open[0]}`);
  }
});

test('friend grid on dunes: repetitive terrain still yields a question, flagged when no sighting is unique', async () => {
  // Medium dn-0/dn-3 and Master dn-1/dn-14 threw "No clear friend sighting found" when twins were hard rejections.
  for (const [seed, difficulty] of [['dn-0', 'medium'], ['dn-3', 'medium'], ['dn-1', 'master'], ['dn-14', 'master']]) {
    const q = await friendGrid(seed, difficulty, 'dunes');
    assert.equal(q.terrain.world, 'dunes');
    assert.equal(q.validation.lookalikeLimit, 0.8, 'the same look-alike limit at every level');
    if (q.validation.lookalikeElsewhere) assertFlagged(q);
    else assert.deepEqual([q.validation.ok, q.lowConfidence], [true, false], seed);
  }
});

test('friend grid on dunes: no unflagged centre twin, and the search goes on until a clean candidate appears', async () => {
  // dn-24 / dn-33: a candidate has a twin only at another cell centre. dn-6 / dn-26: every candidate in
  // the first 2 × 6 views has a twin, so the usual Medium stop would have flagged the question.
  const quizzes = Object.fromEntries(await Promise.all(['dn-24', 'dn-33', 'dn-6', 'dn-26'].map(async (seed) => [seed, await friendGrid(seed, 'medium', 'dunes')])));
  for (const [seed, q] of Object.entries(quizzes)) {
    if (q.validation.lookalikeElsewhere) { assertFlagged(q); continue; }
    const { out } = sightings(q, gridCells(q.terrain.size, 8));
    for (const D of out) assert.ok(D >= q.validation.lookalikeLimit, `${seed}: another cell centre looks the same (${D.toFixed(2)})`);
  }
  for (const seed of ['dn-6', 'dn-26']) {
    const q = quizzes[seed], candidates = q.log.filter((l) => l.stage === 'candidate' && l.attempt === q.stats.terrainAttempt);
    assert.equal(q.stats.pick, 'shortlist', seed);
    assert.ok(q.stats.viewTry >= 12 && candidates.some((l) => l.try < 12) && candidates.filter((l) => l.try < 12).every((l) => !l.ok), seed);
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
