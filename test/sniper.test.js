import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { surfaceLineOfSight } from '../src/engine/terrainSurface.js';
import {
  MARKS, MARK_MILS, HEAD_RADIUS, HEAD_HEIGHT, SNIPER_FOV, SNIPER_TIMING, SNIPER_DURATION,
  holdMiss, bestMark, sniperFrame, sniperSway, scopeFov, pixelsPerMil, generateSniperQuiz, sniperBand,
} from '../src/engine/sniper.js';

test('scope marks come from the ballistics: zero at 100 m, drop grows with range', () => {
  assert.equal(MARK_MILS[100], 0);
  for (let i = 1; i < MARKS.length; i++) {
    assert.ok(MARK_MILS[MARKS[i]] > MARK_MILS[MARKS[i - 1]], 'monotonic');
    if (i > 1) assert.ok(MARK_MILS[MARKS[i]] - MARK_MILS[MARKS[i - 1]] > MARK_MILS[MARKS[i - 1]] - MARK_MILS[MARKS[i - 2]], 'spreads with range');
  }
  assert.ok(MARK_MILS[1000] > 8 && MARK_MILS[1000] < 12, `1000 m hold ${MARK_MILS[1000]} mil`);
  // On flat ground each mark hits exactly at its own range.
  for (const m of MARKS) assert.ok(Math.abs(holdMiss(m, 0, m)) < 0.01, `${m} m mark on flat ground`);
});

test("rifleman's rule: up- and downhill shots use the horizontal range, not the straight line", () => {
  for (const rise of [250, -250]) {
    const slant = Math.hypot(600, rise);
    assert.ok(slant > 640, 'the straight-line range rounds to the 700 m mark');
    const { mark, misses } = bestMark(600, rise);
    assert.equal(mark, 600);
    assert.ok(Math.abs(misses[0].miss) < 0.1);
    assert.ok(holdMiss(600, rise, 700) > 0.5, 'the straight-line mark shoots high');
  }
});

test('sniper quizzes have exactly one head-shot mark among consecutive options', () => {
  for (const difficulty of ['easy', 'medium', 'master']) {
    const q = generateSniperQuiz({ seed: `sniper-${difficulty}`, difficulty });
    const band = sniperBand(difficulty), s = q.sniper;
    assert.equal(q.mode, 'sniper');
    assert.equal(q.options.length, band.options);
    assert.ok(s.horizontal >= band.range[0] && s.horizontal <= band.range[1]);
    const hits = q.options.filter((o) => Math.abs(o.miss) <= HEAD_RADIUS);
    assert.equal(hits.length, 1, `${difficulty}: one hit`);
    assert.ok(hits[0].correct);
    assert.equal(q.correctLabel, `${s.correctMark} m`);
    for (const o of q.options.filter((o) => !o.correct)) assert.ok(Math.abs(o.miss) >= 2.5 * HEAD_RADIUS, `${o.label} clearly misses`);
    if (difficulty !== 'master') {
      const metres = q.options.map((o) => o.metres);
      metres.forEach((m, i) => { if (i) assert.equal(m - metres[i - 1], 100); });
    }
    // The enemy is really visible from the prone eye.
    const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
    assert.ok(surfaceLineOfSight(model, q.camera, { x: s.target.x, y: s.target.y, z: s.target.z + HEAD_HEIGHT }));
    assert.ok(Math.abs(s.rise - (s.target.z + HEAD_HEIGHT - q.camera.z)) < 0.05);
    assert.equal(q.camera.eyeHeight, 0.45);
    // Machine-readable explanation, same shape as the other modes.
    assert.equal(q.explanation.kind, 'holdover');
    assert.equal(q.explanation.alternatives.length, q.options.length - 1);
    assert.equal(q.explanation.correct.label, q.correctLabel);
  }
  const a = generateSniperQuiz({ seed: 'same', difficulty: 'medium' }), b = generateSniperQuiz({ seed: 'same', difficulty: 'medium' });
  assert.deepEqual({ ...a, stats: null, log: null }, { ...b, stats: null, log: null }, 'deterministic');
});

test('timeline: 5 s overview, rifle raise, then 10 s of scope sway independent of the answer', () => {
  const q = generateSniperQuiz({ seed: 'timeline', difficulty: 'easy' });
  const overview = sniperFrame(q, 2, 1.6), scope = sniperFrame(q, 9, 1.6);
  assert.equal(overview.phase, 'overview');
  assert.equal(overview.camera.fov, SNIPER_FOV);
  assert.equal(overview.raise, 0);
  assert.equal(sniperFrame(q, 5.3, 1.6).phase, 'raise');
  assert.equal(scope.phase, 'scope');
  assert.ok(Math.abs(scope.camera.fov - scopeFov(1.6)) < 1e-9);
  const sway = sniperSway(9);
  assert.ok(Math.abs(scope.camera.pitch - (q.sniper.elevation + sway.vertical * 0.0573)) < 1e-9);
  assert.deepEqual(sniperFrame(q, 9, 1.6), scope, 'seekable');
  assert.ok(sniperFrame(q, SNIPER_DURATION, 1.6).done);
  // The hold walks the target over the whole BDC ladder (about 1–10 mil), whatever the answer.
  const holds = Array.from({ length: 200 }, (_, i) => sniperSway(SNIPER_TIMING.scope + 1 + i * 0.04).vertical);
  assert.ok(Math.min(...holds) < 1.6 && Math.max(...holds) > 9.5);
});

test('the reticle scale matches the scope field of view', () => {
  for (const [w, h] of [[1000, 625], [1000, 500], [600, 900]]) {
    const halfMil = (w / 2) / pixelsPerMil(w, h);
    assert.ok(Math.abs(scopeFov(w / h) - 2 * Math.atan(halfMil / 1000) * 180 / Math.PI) < 1e-9);
  }
});

test('generate() dispatches sniper mode and keeps the world', async () => {
  const q = await generate({ seed: 'dispatch', mode: 'sniper', difficulty: 'sun-watch', world: 'karst' });
  assert.equal(q.mode, 'sniper');
  assert.equal(q.difficulty, 'medium');
  assert.equal(q.terrain.world, 'karst');
});

test('the enemy lies prone along the slope and the first-person rifle is real geometry', async () => {
  const { personVertices } = await import('../src/render/personMesh.js');
  const { rifleGeometry, rifleModelMatrix } = await import('../src/render/rifleViewModel.js');
  const extent = (v) => { const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < v.length; i += 9) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); }
    return { lo, hi }; };
  const flat = extent(personVertices({ x: 0, y: 0, z: 0, height: 1.8, heading: 0, pitch: 0, skin: 'sniper', pose: 'prone' }));
  assert.ok(flat.hi[1] < 0.55 && flat.lo[1] > -0.05, `prone height ${flat.hi[1].toFixed(2)} m`);
  assert.ok(flat.hi[2] - flat.lo[2] > 2.4, 'body plus rifle stretch along the ground');
  // Head-down slope: boots (behind, north for heading 180) rise with the pitch.
  const sloped = extent(personVertices({ x: 0, y: 0, z: 0, height: 1.8, heading: 180, pitch: 15, skin: 'sniper', pose: 'prone' }));
  assert.ok(sloped.hi[1] > flat.hi[1] + 0.05 && sloped.lo[1] < -0.1, 'boots up the slope, rifle and bipod down it');
  const q = generateSniperQuiz({ seed: 'prone', difficulty: 'medium' });
  assert.equal(q.sniper.target.pose, 'prone');
  assert.ok(Math.abs(q.sniper.target.pitch) <= 22);
  assert.equal(HEAD_HEIGHT, 0.3);
  const rifle = rifleGeometry();
  assert.equal(rifle.length % 10, 0);
  assert.ok(rifle.length / 10 > 5000, 'detailed mesh');
  assert.ok(rifle.every(Number.isFinite));
  const m = rifleModelMatrix(1.6, 0, 0);
  assert.ok(m[14] < -0.4 && m[12] > 0, 'lower right, in front of the eye');
  assert.ok(rifleModelMatrix(1.6, 1, 0)[13] < m[13] - 0.5, 'lowered out of view as the scope comes up');
});

test('optional crosswind: one mark + windage pair hits, the wind card matches the drift', async () => {
  const { WIND_CARD, windDrift, sniperWeather } = await import('../src/engine/sniper.js');
  // Card: more drift per m/s with range; holds scale linearly with the crosswind.
  WIND_CARD.forEach((c, i) => { if (i) assert.ok(c.milPerMps > WIND_CARD[i - 1].milPerMps); });
  assert.ok(Math.abs(windDrift(600, 0, 4, 600) - 4 * windDrift(600, 0, 1, 600)) < 1e-9);
  assert.ok(windDrift(600, 0, 1, 600) > 0, 'a wind from the right (+) pushes the round left of the aim, so it is held right');
  const plain = generateSniperQuiz({ seed: 'windy', difficulty: 'medium' });
  assert.equal(plain.sniper.wind, undefined, 'wind is opt-in; plain quizzes are unchanged');
  for (const difficulty of ['easy', 'medium', 'master']) {
    const q = generateSniperQuiz({ seed: 'windy', difficulty, sniperWind: true }), w = q.sniper.wind;
    assert.ok(w && w.speed >= 1 && w.speed <= 9);
    const relative = ((w.from - q.sniper.bearing + 540) % 360) - 180;
    assert.ok(Math.abs(w.cross - w.speed * Math.sin(relative * Math.PI / 180)) < 0.01);
    assert.equal(Math.sign(w.holdMil), Math.sign(w.cross), 'hold into the wind');
    assert.ok(Number.isInteger(w.holdMil * 2), 'on a 0.5 mil tick');
    const labels = q.options.map((o) => o.label);
    assert.equal(new Set(labels).size, labels.length);
    const off = (o) => Math.hypot(o.miss, o.lateral);
    assert.equal(q.options.filter((o) => off(o) <= HEAD_RADIUS).length, 1);
    assert.ok(q.options.find((o) => o.correct) === q.options.find((o) => off(o) <= HEAD_RADIUS));
    assert.equal(q.correctLabel, `${q.sniper.correctMark} m · ${w.holdMil > 0 ? 'R' : 'L'} ${Math.abs(w.holdMil).toFixed(1)}`);
    assert.ok(q.explanation.correct.evidence.some((e) => e.type === 'crosswind'));
    // The scene's wind blows the same way (toward from + 180°).
    const weather = sniperWeather(q, { wind: [0, 0] }), toward = (w.from + 180) * Math.PI / 180;
    assert.ok(Math.abs(weather.wind[0] - w.speed * Math.sin(toward)) < 1e-9 && Math.abs(weather.wind[1] - w.speed * Math.cos(toward)) < 1e-9);
  }
});
