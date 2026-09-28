import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SeedManager, Random } from '../src/engine/rng.js';
import { TerrainGenerator } from '../src/engine/terrainGenerator.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { ContourGenerator } from '../src/engine/contours.js';
import { generateQuiz } from '../src/engine/quiz.js';
import { getDifficulty } from '../src/engine/difficulty.js';
import { formatHeading } from '../src/engine/heading.js';

const small = { size: 2000, n: 129 };

function hash(arr) {
  let h = 2166136261;
  const u = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
  for (const v of u) h = Math.imul(h ^ v, 16777619);
  return h >>> 0;
}

test('PRNG streams are deterministic and independent of consumption order', () => {
  const a = new SeedManager('x'), b = new SeedManager('x');
  a.stream('one').next();
  assert.equal(a.stream('two').next(), b.stream('two').next());
  assert.notEqual(new Random('x').next(), new Random('y').next());
});

test('same seed reproduces the identical heightmap', () => {
  const p = getDifficulty('medium').terrain;
  const t1 = TerrainGenerator.generate(new SeedManager('det').stream('terrain', 0), p, small);
  const t2 = TerrainGenerator.generate(new SeedManager('det').stream('terrain', 0), p, small);
  const t3 = TerrainGenerator.generate(new SeedManager('other').stream('terrain', 0), p, small);
  assert.equal(hash(t1.heights), hash(t2.heights));
  assert.notEqual(hash(t1.heights), hash(t3.heights));
});

test('terrain is structured, with a noise share within 20-35%', () => {
  for (const d of ['easy', 'medium', 'hard', 'expert']) {
    const t = TerrainGenerator.generate(new SeedManager(`share-${d}`).stream('terrain', 0), getDifficulty(d).terrain, small);
    assert.ok(t.meta.noiseShare >= 0.18 && t.meta.noiseShare <= 0.35, `${d}: ${t.meta.noiseShare}`);
    assert.ok(t.meta.archetypes.length >= 2 && t.meta.archetypes.length <= 6);
    assert.ok(t.meta.max - t.meta.min > 25);
  }
});

test('contours are closed or boundary-to-boundary and labels match elevation', () => {
  const t = TerrainGenerator.generate(new SeedManager('contours').stream('terrain', 0), getDifficulty('hard').terrain, small);
  const model = new TerrainModel({ ...t, seed: 'contours' });
  const interval = model.chooseContourInterval();
  assert.ok([2, 5, 10, 20].includes(interval));
  const contours = model.getContours(interval);
  assert.ok(ContourGenerator.validate(contours).ok);
  for (const c of contours) {
    assert.equal(c.level % interval, 0);
    for (const line of c.lines) {
      for (let k = 0; k < line.points.length; k += 2) {
        assert.ok(Math.abs(model.getElevation(line.points[k], line.points[k + 1]) - c.level) < 0.05);
      }
    }
  }
});

test('contours keep higher ground on the left (hill loops are counter-clockwise)', () => {
  const n = 41, cell = 10, h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = 100 - Math.hypot(i - 20, j - 20);
  const [c] = ContourGenerator.extract(h, n, cell, 10).filter((c) => c.level === 90);
  assert.equal(c.lines.length, 1);
  assert.ok(c.lines[0].closed);
  assert.ok(ContourGenerator.signedArea(c.lines[0].points) > 0);
});

test('model queries are consistent', () => {
  const t = TerrainGenerator.generate(new SeedManager('q').stream('terrain', 0), getDifficulty('medium').terrain, small);
  const m = new TerrainModel({ ...t, seed: 'q' });
  const x = 900, y = 1100;
  assert.ok(Number.isFinite(m.getElevation(x, y)));
  assert.ok(Number.isFinite(m.getElevation(-500, 2600)), 'outside the map is defined');
  const s = m.getSlope(x, y);
  assert.ok(s >= 0 && s < 90);
  const a = m.getAspect(x, y);
  assert.ok(a === -1 || (a >= 0 && a < 360));
  assert.equal(m.getSkyline(x, y, 0).length, 72);
  const sig = m.getTerrainSignature(x, y);
  for (const k of ['elevation', 'slope', 'aspect', 'curvature', 'relativeElevation', 'ridgeDistance', 'valleyDistance', 'summitDistance', 'saddleDistance', 'openness']) assert.ok(Number.isFinite(sig[k]), k);
  assert.ok(m.getFlowAccumulation(x, y) >= 1);
});

test('generated quizzes are deterministic, valid and randomise the answer label', () => {
  const q1 = generateQuiz({ seed: 'quiz-a', difficulty: 'medium' });
  const q2 = generateQuiz({ seed: 'quiz-a', difficulty: 'medium' });
  assert.deepEqual(q1.camera, q2.camera);
  assert.deepEqual(q1.options, q2.options);
  assert.equal(q1.options.filter((o) => o.correct).length, 1);
  assert.equal(q1.options.length, 1 + getDifficulty('medium').distractors);
  assert.ok(q1.camera.fov >= 55 && q1.camera.fov <= 75);
  assert.ok(q1.camera.eyeHeight >= 1.6 && q1.camera.eyeHeight <= 1.85);
  assert.ok(q1.camera.pitch >= -4 && q1.camera.pitch <= 6);
  const band = getDifficulty('medium').band;
  for (const o of q1.options.filter((o) => !o.correct)) assert.ok(o.D >= band.min && o.D <= band.max);

  const labels = new Set();
  for (let i = 0; i < 6; i++) labels.add(generateQuiz({ seed: `label-${i}`, difficulty: 'easy' }).correctLabel);
  assert.ok(labels.size > 1, 'correct answer is not always the same label');
});

test('heading formatting per difficulty', () => {
  assert.equal(formatHeading(0, 'cardinal').text, 'FACING NORTH');
  assert.equal(formatHeading(45, 'intercardinal').text, 'FACING NORTH-EAST');
  assert.equal(formatHeading(37, 'exact').text, 'FACING 037°');
});

test('MP4 muxer writes a well-formed fast-start file', async () => {
  const { muxMp4 } = await import('../src/export/mp4.js');
  const samples = Array.from({ length: 45 }, (_, i) => ({ data: new Uint8Array(100 + i).fill(i), key: i % 30 === 0 }));
  const blob = muxMp4({ codec: 'avc1.640028', width: 1080, height: 1920, fps: 30, description: Uint8Array.from([1, 100, 0, 40, 255, 225, 0, 0, 1, 0, 0]), samples });
  const b = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(b.buffer);
  const top = [];
  for (let off = 0; off < b.length;) {
    const size = dv.getUint32(off);
    top.push([String.fromCharCode(...b.subarray(off + 4, off + 8)), off, size]);
    off += size;
  }
  assert.deepEqual(top.map((t) => t[0]), ['ftyp', 'moov', 'mdat']);
  const text = new TextDecoder('latin1').decode(b);
  const stco = text.indexOf('stco');
  const chunkOffset = dv.getUint32(stco + 12);
  assert.equal(chunkOffset, top[2][1] + 8, 'stco points at the first sample');
  assert.equal(b[chunkOffset], 0);
  const mvhd = text.indexOf('mvhd');
  assert.equal(dv.getUint32(mvhd + 16), 1000);
  assert.equal(dv.getUint32(mvhd + 20), 1500, '45 frames at 30 fps = 1.5 s');
  const stss = text.indexOf('stss');
  assert.equal(dv.getUint32(stss + 8), 2);
  assert.ok(text.includes('avcC'));
});

test('variants keep the terrain but move the positions', () => {
  const a = generateQuiz({ seed: 'variant', difficulty: 'easy' });
  const b = generateQuiz({ seed: 'variant', difficulty: 'easy', variant: 1 });
  const a2 = generateQuiz({ seed: 'variant', difficulty: 'easy', variant: 0 });
  assert.deepEqual(a.camera, a2.camera, 'variant 0 is the original question');
  if (a.stats.terrainAttempt === b.stats.terrainAttempt) assert.equal(hash(a.terrain.heights), hash(b.terrain.heights));
  assert.ok(a.camera.x !== b.camera.x || a.camera.y !== b.camera.y || a.camera.heading !== b.camera.heading);
});

test('master questions are hard but every distractor has a visible cue', () => {
  const q = generateQuiz({ seed: 'master-t', difficulty: 'master' });
  const p = getDifficulty('master');
  assert.equal(q.options.length, 3);
  assert.ok(!q.lowConfidence);
  for (const o of q.options.filter((o) => !o.correct)) {
    assert.ok(o.D >= p.band.min && o.D <= p.band.max);
    assert.ok(Math.abs(o.cue.delta) >= p.search.cue, 'distinguishing skyline feature');
  }
  assert.ok(q.hardness > 0 && q.hardness <= 1);
});

test('scrambling moves every letter but keeps the points', async () => {
  const { scrambleLabels } = await import('../src/engine/scramble.js');
  const q = generateQuiz({ seed: 'scr', difficulty: 'hard' });
  const at = (quiz) => new Map(quiz.options.map((o) => [`${o.x},${o.y}`, o.label]));
  let prev = q;
  for (let n = 1; n <= 5; n++) {
    const s = scrambleLabels(q, n);
    assert.deepEqual([...at(s).keys()].sort(), [...at(q).keys()].sort(), 'same points');
    assert.deepEqual(s.options.map((o) => o.label), q.options.map((o) => o.label), 'letters stay A, B, C...');
    for (const [pt, label] of at(s)) assert.notEqual(label, at(prev).get(pt), 'every letter moved');
    assert.equal(s.correctLabel, s.options.find((o) => o.correct).label);
    assert.deepEqual(scrambleLabels(q, n).options, s.options, 'deterministic');
    prev = s;
  }
});

test('heading style can be overridden (master with 8 directions or exact bearings)', async () => {
  const { generate } = await import('../src/engine/quiz.js');
  const eight = await generate({ seed: 'hm', difficulty: 'master', headingMode: 'intercardinal' });
  assert.equal(eight.camera.heading % 45, 0);
  assert.match(eight.heading.text, /^FACING (NORTH|SOUTH|EAST|WEST)(-(EAST|WEST))?$/);
  const exact = await generate({ seed: 'hm', difficulty: 'master' });
  assert.match(exact.heading.text, /^FACING \d{3}°$/);
  assert.equal(hash(exact.terrain.heights), hash(eight.terrain.heights), 'same terrain');
});

test('"Which way?" mode: 8 directions, one correct, distinct from the rest', async () => {
  const { generate } = await import('../src/engine/quiz.js');
  for (const difficulty of ['easy', 'master']) {
    const q = await generate({ seed: 'facing-t', difficulty, mode: 'facing' });
    assert.equal(q.mode, 'facing');
    assert.deepEqual(q.options.map((o) => o.label), ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
    assert.equal(q.options.filter((o) => o.correct).length, 1);
    const correct = q.options.find((o) => o.correct);
    assert.equal(correct.label, q.correctLabel);
    assert.equal(correct.heading, q.camera.heading);
    assert.equal(q.point.x, q.camera.x);
    assert.ok(!q.lowConfidence);
    const minD = getDifficulty(difficulty).facing.minD;
    for (const o of q.options.filter((o) => !o.correct)) assert.ok(o.D >= minD, `${o.label} ${o.D}`);
  }
});
