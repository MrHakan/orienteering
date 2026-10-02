import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { Random } from '../src/engine/rng.js';
import { createTrailPlan, simulateTrail } from '../src/engine/trailMotion.js';
import { describeTrailTerrain, travelledCells } from '../src/engine/trailTerrain.js';

test('terrain clues reject a flat or uniform incline and recognise a ridge-to-valley descent', () => {
  const size = 2000, n = 129;
  const plan = createTrailPlan(new Random('terrain-profile'), 0, 24);
  const metrics = {};
  for (const kind of ['flat', 'plane', 'ridge-valley']) {
    const heights = Float32Array.from({ length: n * n }, (_, i) => {
      const y = Math.floor(i / n) * size / (n - 1);
      return kind === 'flat' ? 10 : kind === 'plane' ? y * .04 : 20 + 8 * Math.cos((y - 800) / 100);
    });
    const model = new TerrainModel({ size, n, heights });
    const route = simulateTrail(model, { x: 800, y: 800 }, plan);
    assert.ok(route);
    metrics[kind] = describeTrailTerrain(model, route);
  }
  assert.equal(metrics.flat.ok, false);
  assert.equal(metrics.flat.relief, 0); // Jump arcs cannot count as ground relief.
  assert.ok(metrics.plane.relief > 15);
  assert.equal(metrics.plane.ok, false); // Height change alone is not variety.
  assert.equal(metrics['ridge-valley'].ok, true);
  assert.equal(metrics['ridge-valley'].ridgeToValley, true);
  assert.deepEqual(metrics['ridge-valley'].featureSequence, ['ridge', 'slope', 'valley']);
  assert.ok(metrics['ridge-valley'].score > metrics.plane.score);
});

test('cell coverage ignores corner grazes but counts a genuine passage and its order', () => {
  assert.deepEqual(travelledCells([{ x: 100, y: 650 }, { x: 500, y: 650 }], 800, 4), ['A1', 'A2', 'A3']);
  const corner = [{ x: 100, y: 220 }, { x: 201, y: 201 }, { x: 180, y: 100 }];
  assert.deepEqual(travelledCells(corner, 800, 4), ['C1', 'D1']);
  assert.deepEqual(travelledCells([...corner].reverse(), 800, 4), ['D1', 'C1']);
});
