import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { descriptorDistance } from '../src/engine/skyline.js';
import { scrambleLabels } from '../src/engine/scramble.js';
import { captionText } from '../src/export/composer.js';
import { DIRECTIONS, getLookalikePreset, lookalikeDirection, compareLookalikeViews, rankLookalikeTriples, triangleSpread } from '../src/engine/lookalikeQuiz.js';

test('a hub with two look-alikes is insufficient: the other pair must match too', () => {
  const points = ['A', 'B', 'C'];
  const graph = rankLookalikeTriples(points, (a, b) => a === 'A' ? { cost: 0.2 } : null);
  assert.equal(graph.total, 0);
  assert.deepEqual(graph.triples, []);
  const complete = rankLookalikeTriples(points, () => ({ cost: 0.2 }));
  assert.equal(complete.total, 1);
  assert.deepEqual(complete.triples[0].points, points);
});

test('minimax prefers a balanced triple over a lower average with an outlier', () => {
  const points = ['A', 'B', 'C', 'D', 'E', 'F'];
  const costs = { AB: 0.05, AC: 0.05, BC: 0.9, DE: 0.4, DF: 0.4, EF: 0.4 };
  const graph = rankLookalikeTriples(points, (a, b) => costs[a + b] === undefined ? null : { cost: costs[a + b] });
  assert.equal(graph.total, 2);
  assert.deepEqual(graph.triples[0].points, ['D', 'E', 'F']);
  const bounded = rankLookalikeTriples(points, (a, b) => costs[a + b] === undefined ? null : { cost: costs[a + b] }, 1);
  assert.equal(bounded.triples.length, 1);
  assert.deepEqual(bounded.triples[0].points, ['D', 'E', 'F']);
});

test('eight automatic variants cover all compass directions, and explicit directions stay fixed', () => {
  const order = Array.from({ length: 8 }, (_, v) => lookalikeDirection('cycle', 'master', v).heading);
  assert.deepEqual([...order].sort((a, b) => a - b), DIRECTIONS.map((d) => d.heading));
  assert.equal(lookalikeDirection('cycle', 'master', 8).heading, order[0]);
  assert.equal(lookalikeDirection('cycle', 'master', 5, 'NW').heading, 315);
  assert.throws(() => lookalikeDirection('cycle', 'master', 0, 'NNW'), /Unknown/);
});

test('identical silhouettes, wrong depths and collinear map points cannot pass', () => {
  const desc = (offset = 0, distance = 400) => ({
    heading: 0, fov: 64,
    horizon: Array.from({ length: 33 }, (_, i) => Math.sin(i / 7) * 3 + offset),
    near: [0, 1, 2].map(() => Array(33).fill(-2)), dist: Array(33).fill(distance),
  });
  const preset = getLookalikePreset('master');
  assert.ok(!compareLookalikeViews(desc(), desc(), preset).ok, 'identical is ambiguous');
  assert.ok(compareLookalikeViews(desc(), desc(1.5), preset).ok);
  assert.ok(!compareLookalikeViews(desc(), desc(1.5, 2000), preset).ok, 'similar outline at a different depth');
  assert.equal(triangleSpread([{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 1000, y: 0 }]), 0);
  assert.ok(triangleSpread([{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 250, y: 500 }]) > 0.08);
});

test('a visible central summit cannot match a ramp or a summit at the edge', () => {
  const view = (horizon) => ({ heading: 90, fov: 64, horizon, near: [0, 1, 2].map(() => Array(33).fill(-2)), dist: Array(33).fill(400) });
  const hill = (centre) => Array.from({ length: 33 }, (_, i) => 2 + 4 * Math.exp(-(((i - centre) / 8) ** 2)));
  const preset = getLookalikePreset('medium');
  const central = view(hill(16));
  const ramp = view(Array.from({ length: 33 }, (_, i) => 2 + i / 8));
  assert.ok(!compareLookalikeViews(central, ramp, preset).ok);
  assert.ok(!compareLookalikeViews(central, view(hill(28)), preset).ok);
  assert.ok(compareLookalikeViews(central, view(hill(18).map((h) => h + 1.5)), preset).ok, 'nearby peak plus a visible cue');
});

function verify(q, direction, difficulty) {
  assert.equal(q.mode, 'lookalike');
  assert.deepEqual(q.options.map((o) => o.label), ['A', 'B', 'C']);
  assert.equal(q.options.filter((o) => o.correct).length, 1);
  assert.equal(q.correctLabel, q.options.find((o) => o.correct).label);
  assert.equal(q.camera.heading, direction.heading);
  assert.equal(q.headingMode, 'intercardinal');
  assert.ok(q.validation.ok && !q.lowConfidence);
  assert.equal(q.matching.pairs.length, 3);
  assert.deepEqual(q.stats.directions.map((d) => d.heading), DIRECTIONS.map((d) => d.heading));
  assert.ok(triangleSpread(q.options) >= 0.08);
  const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
  const preset = getLookalikePreset(difficulty);
  // Independently cast the final viewpoints; coarse-search metadata is not
  // accepted as evidence that the actual A/B/C views meet the contract.
  const descs = q.options.map((o) => model.skyline.viewDescriptor(o.x, o.y, q.camera.heading, q.camera.fov, { eyeHeight: q.camera.eyeHeight }));
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
    const pa = q.options[a], pb = q.options[b];
    assert.ok(Math.hypot(pa.x - pb.x, pa.y - pb.y) >= q.matching.minSeparation);
    assert.ok(!model.analyzer.sameFeature(pa.x, pa.y, pb.x, pb.y));
    const pair = compareLookalikeViews(descs[a], descs[b], preset);
    assert.ok(pair.ok, `${difficulty} ${direction.label} ${pa.label}/${pb.label}: ${JSON.stringify(pair)}`);
    assert.ok(pair.D > 0 && pair.D <= preset.band.max);
  }
  const correctIndex = q.options.findIndex((o) => o.correct);
  for (let i = 0; i < 3; i++) if (i !== correctIndex) {
    assert.ok(Math.abs(q.options[i].D - descriptorDistance(descs[correctIndex], descs[i])) < 0.001);
  }
  return q;
}

test('real terrain produces three mutually similar, geographically distinct views in every direction', async () => {
  for (const direction of DIRECTIONS) {
    verify(await generate({ seed: 'coverage', difficulty: 'medium', mode: 'lookalike', direction: direction.label }), direction, 'medium');
  }
});

test('all difficulties work; deterministic replay, scrambling and exports keep the same puzzle', async () => {
  const labels = new Set();
  for (const difficulty of ['easy', 'medium', 'hard', 'expert', 'master']) {
    const opts = { seed: 'coverage', difficulty, mode: 'lookalike', direction: 'NW' };
    const q = verify(await generate(opts), DIRECTIONS[7], difficulty);
    labels.add(q.correctLabel);
    const replay = await generate(opts);
    assert.deepEqual(q.camera, replay.camera);
    assert.deepEqual(q.options, replay.options);
    assert.deepEqual(q.matching, replay.matching);
    assert.deepEqual(q.terrain.heights, replay.terrain.heights);
    const shuffled = scrambleLabels(q, 2);
    assert.deepEqual(shuffled.matching, q.matching, 'pair diagnostics refer to coordinates, never stale letters');
    assert.equal(shuffled.correctLabel, shuffled.options.find((o) => o.correct).label);
    assert.match(captionText(shuffled), /^You are at A, B or C, facing north-west\.$/);
  }
  assert.ok(labels.size > 1, 'the correct letter is not fixed');
});

test('an impossible request fails explicitly instead of returning a broken look-alike puzzle', async () => {
  await assert.rejects(generate({ seed: 'coverage', mode: 'lookalike', tuning: { minTrue: 1500, minSep: 1500 }, maxTerrainAttempts: 1 }), /No fair A\/B\/C/);
});

test('difficult seeds stay fair through bounded terrain retries', async () => {
  for (const [seed, difficulty, direction] of [['stress-25', 'hard', 'SE'], ['stress-29', 'master', 'E']]) {
    const q = verify(await generate({ seed, difficulty, mode: 'lookalike', direction }), DIRECTIONS.find((d) => d.label === direction), difficulty);
    assert.ok(q.stats.terrainAttempt > 0);
    assert.ok(q.stats.directions.find((d) => d.direction === direction).valid > 0);
  }
});
