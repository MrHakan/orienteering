import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { MAP_MODES, isMapMode, profileAlong, droneCamera, bearingTo } from '../src/engine/mapModes.js';
import { toblerSpeed, routeStats } from '../src/engine/routeQuiz.js';
import { sightline } from '../src/engine/visibilityQuiz.js';
import { surfaceElevation } from '../src/engine/terrainSurface.js';

const modelOf = (q) => new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
const one = (q) => { assert.equal(q.options.filter((o) => o.correct).length, 1); assert.equal(q.options.find((o) => o.correct).label, q.correctLabel); };
const shape = (q) => {
  assert.equal(q.explanation.correct.label, q.correctLabel);
  assert.equal(q.explanation.alternatives.length, q.options.length - 1);
  assert.doesNotThrow(() => JSON.stringify(q.map));
  assert.ok(isMapMode(q));
};

test('six map-reading modes are registered and dispatched', async () => {
  assert.deepEqual(Object.keys(MAP_MODES), ['resection', 'route', 'visibility', 'profile', 'drainage', 'fog']);
  const a = await generate({ seed: 'mm-det', difficulty: 'medium', mode: 'route' });
  const b = await generate({ seed: 'mm-det', difficulty: 'medium', mode: 'route' });
  assert.deepEqual({ ...a, stats: null }, { ...b, stats: null }, 'deterministic');
  const sw = await generate({ seed: 'mm-det', difficulty: 'sun-watch', mode: 'fog', world: 'karst' });
  assert.equal(sw.difficulty, 'medium');
  assert.equal(sw.terrain.world, 'karst');
});

test('resection: only the true position matches every bearing', async () => {
  for (const difficulty of ['easy', 'master']) {
    const q = await generate({ seed: 'res-t', difficulty, mode: 'resection' }); one(q); shape(q);
    const { peaks, rounding } = q.resection, correct = q.options.find((o) => o.correct);
    assert.equal(peaks.length, difficulty === 'easy' ? 3 : 2);
    for (const p of peaks) {
      const err = Math.abs(((bearingTo(correct, p) - p.shown + 540) % 360) - 180);
      assert.ok(err <= rounding / 2 + 0.6, `true point within rounding (${err})`);
    }
    for (const o of q.options.filter((o) => !o.correct)) assert.ok(Math.max(...o.errors) >= 5, `${o.label} contradicts a bearing`);
    assert.ok(q.options.some((o) => o.trap), 'a single-bearing trap is offered');
  }
});

test('route choice: Tobler time picks the fastest route by a clear margin', async () => {
  assert.ok(toblerSpeed(-0.05) > toblerSpeed(0) && toblerSpeed(0) > toblerSpeed(0.2) && toblerSpeed(-0.05) > toblerSpeed(-0.3));
  const q = await generate({ seed: 'route-t', difficulty: 'hard', mode: 'route' }); one(q); shape(q);
  const model = modelOf(q), times = q.options.map((o) => routeStats(model, o.points).minutes);
  const best = Math.min(...times);
  assert.ok(Math.abs(times[q.options.findIndex((o) => o.correct)] - best) < 1e-9);
  assert.ok([...times].sort((a, b) => a - b)[1] / best - 1 >= 0.08);
  assert.equal(q.map.lineOptions.length, 3);
});

test('intervisibility: exactly one flag is in sight', async () => {
  const q = await generate({ seed: 'vis-t', difficulty: 'master', mode: 'visibility' }); one(q); shape(q);
  const model = modelOf(q), eye = { x: q.camera.x, y: q.camera.y, z: q.camera.z };
  for (const o of q.options) {
    const s = sightline(model, eye, o);
    if (o.correct) assert.ok(s.minHeight <= 1.3, 'the top of the flag shows');
    else assert.ok(s.minHeight > 2, `${o.label} hidden (needs ${s.minHeight.toFixed(1)} m)`);
  }
});

test('profile: the correct chart is the true cross-section; the reverse is a trap', async () => {
  const q = await generate({ seed: 'prof-t', difficulty: 'master', mode: 'profile' }); one(q); shape(q);
  const model = modelOf(q), truth = profileAlong(model, q.profileLine.a, q.profileLine.b);
  assert.deepEqual(q.options.find((o) => o.correct).profile, truth);
  assert.deepEqual(q.options.find((o) => o.kind === 'reversed').profile, [...truth].reverse());
  for (const o of q.options.filter((o) => !o.correct)) assert.ok(o.rms >= 3.2);
});

test('drainage: steepest descent from the drop reaches the correct outlet', async () => {
  const q = await generate({ seed: 'drain-t', difficulty: 'hard', mode: 'drainage' }); one(q); shape(q);
  const model = modelOf(q), { receiver } = model.drainage, n = model.n, cell = model.cell;
  let k = Math.round(q.drainage.drop.y / cell) * n + Math.round(q.drainage.drop.x / cell);
  while (receiver[k] >= 0) k = receiver[k];
  const end = { x: (k % n) * cell, y: ((k / n) | 0) * cell };
  const nearest = [...q.options].sort((a, b) => Math.hypot(a.x - end.x, a.y - end.y) - Math.hypot(b.x - end.x, b.y - end.y))[0];
  assert.ok(nearest.correct);
  assert.ok(q.drainage.divide <= 140, 'hard drops sit near a watershed');
});

test('fog: whiteout visibility, near-ground distractors within the band', async () => {
  const q = await generate({ seed: 'fog-t', difficulty: 'master', mode: 'fog' }); one(q); shape(q);
  assert.equal(q.fog.visibility, 60);
  for (const o of q.options.filter((o) => !o.correct)) assert.ok(o.D >= 1 && o.D <= 3);
  assert.equal(q.options.find((o) => o.correct).D, 0);
});

test('drone camera stays above the ground and orbits during the clip', async () => {
  const q = await generate({ seed: 'drone-t', difficulty: 'easy', mode: 'visibility' }), model = modelOf(q);
  const a = droneCamera(model, q.map.centre, 0, q.map.drone), b = droneCamera(model, q.map.centre, 15, q.map.drone);
  assert.ok(Math.abs(((b.heading - a.heading + 540) % 360) - 180 - 24) < 1e-6);
  for (const c of [a, b]) assert.ok(c.z > surfaceElevation(model, c.x, c.y) + 100 && c.pitch < 0);
});
