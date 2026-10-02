// Measure the final rendered surface along a run, independently of its label.
// Short ripples and cells touched only at a corner are not useful terrain clues.
import { cellAt } from './gridQuiz.js';
import { saturate } from './grid.js';

export function terrainRunDuration(size = 2000, divisions = 6) {
  // Keep the CS speed ceiling. Larger cells need more time, not faster motion.
  return Math.max(24, Math.ceil(size / divisions / 14));
}

export function trailViewTimes(duration, coarse = false) {
  const step = coarse ? 3 : 1.5, times = [];
  for (let t = 0; t < duration - .25; t += step) times.push(t);
  times.push(duration - .25);
  return times;
}

/** Ordered cells with >=12 m of travel inside them; excludes corner grazes. */
export function travelledCells(points, size, divisions) {
  const runs = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], distance = Math.hypot(b.x - a.x, b.y - a.y);
    // Subdivide for fine grids and exact border crossings, even in test fixtures.
    const steps = Math.max(1, Math.ceil(distance / 2));
    for (let j = 0; j < steps; j++) {
      const f = (j + .5) / steps, cell = cellAt(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, size, divisions);
      if (!cell) continue;
      if (runs.at(-1)?.cell !== cell) runs.push({ cell, distance: 0 });
      runs.at(-1).distance += distance / steps;
    }
  }
  return runs.filter(r => r.distance >= 12).map(r => r.cell);
}

const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];

export function describeTrailTerrain(model, route, divisions = 6) {
  const samples = [], features = [];
  let distance = 0, next = 0, last = route.points[0];
  for (let i = 0; i < route.points.length; i++) {
    const p = route.points[i]; distance += Math.hypot(p.x - last.x, p.y - last.y); last = p;
    if (distance < next && i !== route.points.length - 1) continue;
    next = distance + 10;
    const k = Math.min(route.ground.length - 1, i * 16), idx = model.analyzer.idx(p.x, p.y);
    const rel = model.analyzer.relElev[idx];
    const ridge = model.analyzer.ridgeDist[idx], valley = model.analyzer.valleyDist[idx];
    const feature = ridge < 75 && rel > .5 ? 'ridge' : valley < 75 && rel < -.5 ? 'valley' : 'slope';
    const sample = { distance, z: route.ground[k], slope: model.getSlope(p.x, p.y), ridge, valley, feature };
    samples.push(sample);
    if (features.at(-1)?.kind !== feature) features.push({ kind: feature, start: distance, end: distance, z: sample.z });
    features.at(-1).end = distance;
  }
  const heights = samples.map(p => p.z), slopes = samples.map(p => p.slope), grades = [];
  // Grades span at least 30 m, so bhop arcs and one terrain triangle cannot
  // manufacture a slope transition. ground[] contains surface height only.
  for (let i = 0; i < samples.length; i++) {
    const b = samples.slice(i + 1).find(p => p.distance - samples[i].distance >= 30);
    if (b) grades.push(Math.atan2(b.z - samples[i].z, b.distance - samples[i].distance) * 180 / Math.PI);
  }
  const relief = Math.max(...heights) - Math.min(...heights);
  const slopeRange = percentile(slopes, .9) - percentile(slopes, .1);
  const gradeRange = grades.length ? percentile(grades, .9) - percentile(grades, .1) : 0;
  const stable = features.filter(f => f.end - f.start >= 20);
  const featureSequence = stable.map(f => f.kind).filter((f, i, a) => !i || f !== a[i - 1]);
  const ridgeToValley = stable.some((a, i) => a.kind === 'ridge'
    && stable.slice(i + 1).some(b => b.kind === 'valley' && a.z - b.z >= 4));
  const cells = travelledCells(route.points, model.size, divisions);
  const score = .25 * saturate(relief / 25) + .25 * saturate(gradeRange / 10)
    + .2 * saturate(slopeRange / 8) + .15 * saturate((featureSequence.length - 1) / 2)
    + .15 * Number(ridgeToValley);
  const ok = relief >= 6 && Math.max(slopeRange, gradeRange) >= 2.5;
  return { ok, score, length: distance, relief, slopeRange, gradeRange, featureSequence, ridgeToValley,
    cells, gridSize: divisions, cellCount: new Set(cells).size };
}
