import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { compareExplanationViews, buildAnswerExplanation, explanationComparisons, explanationReport } from '../src/engine/answerExplanation.js';
import { scrambleLabels } from '../src/engine/scramble.js';
import { cellAtExtent } from '../src/engine/gridQuiz.js';

function view(heading, horizon, near = [-10, -5, -2], visible = false) {
  return { heading, fov: 60, horizon: Float32Array.from(horizon),
    near: near.map(v => new Float32Array(horizon.length).fill(v)),
    probeVisible: [0, 1, 2].map(() => new Uint8Array(horizon.length).fill(visible ? 1 : 0)) };
}

test('view explanations preserve the sign, screen position and separate world bearings', () => {
  const camera = { heading: 0, pitch: 0, fov: 60 };
  const a = view(0, [1, 2, 3]), b = view(90, [5, 6, 7]);
  const high = compareExplanationViews(a, b, camera);
  assert.equal(high.type, 'view-mismatch');
  assert.equal(high.data.deltaDegrees, 4);
  assert.equal(high.data.screenSide, 'left');
  assert.equal(high.data.observedBearing, 330);
  assert.equal(high.data.alternativeBearing, 60);
  assert.match(high.text, /shown bearing 330°; candidate bearing 060°/);
  assert.match(high.text, /higher than shown/);
  const low = compareExplanationViews(b, a, { ...camera, heading: 90 });
  assert.equal(low.data.deltaDegrees, -4); assert.match(low.text, /lower than shown/);
  assert.equal(compareExplanationViews(a, a, camera), null);
});

test('occluded or unmeasured foreground probes cannot manufacture an explanation', () => {
  const camera = { heading: 0, pitch: 0, fov: 60 }, a = view(0, [2, 2, 2]);
  const hidden = view(0, [2, 2, 2], [5, 5, 5]);
  assert.equal(compareExplanationViews(a, hidden, camera), null);
  const measuredA = view(0, [2, 2, 2], [-10, -5, -2], true);
  const measuredB = view(0, [2, 2, 2], [-2, 0, 1], true);
  const clue = compareExplanationViews(measuredA, measuredB, camera);
  assert.equal(clue.data.feature, 'foreground'); assert.equal(clue.data.probeMetres, 40);
  assert.equal(clue.data.deltaDegrees, 8);
});

test('grid explanations explain every alternative and always include a submitted wrong cell', async () => {
  const q = await generate({ seed: 'grid-check', difficulty: 'medium', mode: 'grid', gridSize: 4 });
  const e = q.explanation;
  assert.equal(e.correct.label, q.correctLabel); assert.equal(e.alternatives.length, 15);
  assert.equal(e.closestLabels.length, 3); assert.equal(e.closestLabels[0], q.closestLabel);
  const wrong = e.alternatives.find(o => !e.closestLabels.includes(o.label)).label;
  const comparisons = explanationComparisons(q, wrong);
  assert.deepEqual(comparisons.map(o => o.label), [wrong, ...e.closestLabels]);
  for (const other of e.alternatives) {
    const option = q.options.find(o => o.label === other.label);
    assert.equal(other.comparisonHeading, option.heading);
    assert.equal(other.status, 'distinguished');
    assert.ok(other.reasons[0].data.deltaDegrees !== 0);
  }
  const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
  const before = q.terrain.heights.slice();
  assert.deepEqual(e, buildAnswerExplanation(q, model));
  assert.deepEqual(e, buildAnswerExplanation({ ...q, mapRotation: (q.mapRotation + 90) % 360 }, model));
  assert.deepEqual(q.terrain.heights, before);
  const profile = e.correct.evidence.find(o => o.type === 'contour-profile').data;
  const rad = profile.bearing * Math.PI / 180;
  const change = model.getElevation(q.camera.x + Math.sin(rad) * 120, q.camera.y + Math.cos(rad) * 120)
    - model.getElevation(q.camera.x, q.camera.y);
  assert.ok(Math.abs(profile.elevationChangeMetres - change) < .01);
  const report = explanationReport(q, wrong);
  assert.equal(report.chosenLabel, wrong); assert.equal(report.correctLabel, q.correctLabel);
  assert.deepEqual(report, JSON.parse(JSON.stringify(report)));
});

test('A/B/C explanations remain attached to physical points through scrambling', async () => {
  const q = await generate({ seed: 'variant', difficulty: 'easy' });
  const baseline = structuredClone(q.explanation);
  assert.equal(q.explanation.alternatives.length, 2);
  for (const steps of [1, 2, 5]) {
    const shuffled = scrambleLabels(q, steps);
    assert.equal(shuffled.explanation.correct.label, shuffled.correctLabel);
    for (const alternative of shuffled.explanation.alternatives) {
      const point = shuffled.options.find(o => o.label === alternative.label);
      const original = q.options.find(o => o.x === point.x && o.y === point.y);
      assert.deepEqual(alternative.reasons, baseline.alternatives.find(o => o.label === original.label).reasons);
    }
    assert.equal(explanationComparisons(shuffled, shuffled.correctLabel).length, 2);
    assert.deepEqual(shuffled.explanation, scrambleLabels(q, steps).explanation);
  }
  assert.deepEqual(q.explanation, baseline);
});

test('sun/watch explanations reject headings which disagree with the measured solar orientation', async () => {
  const q = await generate({ seed: 'sun-watch-demo', difficulty: 'sun-watch', mode: 'where-am-i' });
  assert.equal(q.explanation.correct.evidence[0].type, 'sun-orientation');
  for (const alternative of q.explanation.alternatives) {
    const reason = alternative.reasons.find(r => r.type === 'heading-mismatch');
    assert.ok(reason.data.differenceDegrees >= q.validation.minHeadingGap);
    assert.equal(reason.data.observedHeading, q.camera.heading);
  }
});

test('friend-grid reasoning uses qualified positions inside cells, including non-centre targets', async () => {
  const q = await generate({ seed: 'friend-demo', difficulty: 'easy', mode: 'friend', friendAnswer: 'grid', gridSize: 6 });
  assert.equal(q.explanation.kind, 'person-cell');
  const target = q.explanation.correct.evidence.find(e => e.type === 'person-cell').data.target;
  assert.equal(cellAtExtent(target.x, target.y, q.mapExtent, q.grid.size), q.correctLabel);
  assert.notDeepEqual(target, { x: q.options.find(o => o.correct).x, y: q.options.find(o => o.correct).y });
  const qualified = q.explanation.alternatives.filter(o => o.scope === 'qualified-point');
  assert.ok(qualified.length > 0);
  for (const other of qualified) {
    assert.equal(cellAtExtent(other.comparisonPoint.x, other.comparisonPoint.y, q.mapExtent, q.grid.size), other.label);
    assert.ok(other.reasons.some(r => r.type.startsWith('person-')));
  }
  assert.ok(q.explanation.alternatives.some(o => o.scope === 'cell-bounds' && o.reasons[0].type === 'person-outside-cell'));
});

test('trail reasoning retains the validated replay moment and signed skyline difference', async () => {
  const q = await generate({ seed: 'bhop-demo', mode: 'trail', difficulty: 'medium' });
  assert.equal(q.explanation.kind, 'route');
  assert.equal(q.explanation.correct.evidence[0].type, 'route-terrain');
  for (const other of q.explanation.alternatives) {
    const option = q.options.find(o => o.label === other.label), data = other.reasons[0].data;
    assert.equal(data.timeSeconds, +option.cue.t.toFixed(2));
    assert.equal(data.deltaDegrees, +option.cue.delta.toFixed(2));
    assert.ok(data.timeSeconds >= 0 && data.timeSeconds <= q.trail.duration);
  }
});

test('flat ambiguous comparisons and low generation confidence are reported honestly', () => {
  const n = 17, size = 1024, terrain = { n, size, heights: new Float32Array(n * n), modelSeed: 'flat-explanation' };
  const q = { mode: 'where-am-i', seed: 'flat', difficulty: 'easy', lowConfidence: true, terrain,
    camera: { x: 512, y: 512, z: 1.7, eyeHeight: 1.7, heading: 0, fov: 60, pitch: 0 },
    options: [{ label: 'A', correct: true, x: 512, y: 512, z: 0 }, { label: 'B', correct: false, x: 512, y: 512, z: 0, D: 0 }], correctLabel: 'A' };
  const e = buildAnswerExplanation(q);
  assert.match(e.caution, /uncertain/);
  assert.equal(e.alternatives[0].status, 'inconclusive');
  assert.equal(e.alternatives[0].reasons[0].type, 'inconclusive');
  assert.deepEqual(e, JSON.parse(JSON.stringify(e)));
});
