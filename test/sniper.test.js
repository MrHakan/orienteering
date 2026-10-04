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
