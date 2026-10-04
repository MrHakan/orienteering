// Match a whole moving terrain sequence, not an isolated start or end point.
// Coarse mutually compatible triples are refined at more times and bearings.
import { SeedManager } from './rng.js';
import { getDifficulty, applyTuning } from './difficulty.js';
import { formatHeading, candidateHeadings } from './heading.js';
import { ViewpointGenerator } from './viewpoints.js';
import { descriptorDistance } from './skyline.js';
import { depthDifference } from './quizCandidates.js';
import { rankLookalikeTriples, triangleSpread } from './lookalikeQuiz.js';
import { buildTerrain, terrainSummary, landmarkSummary, framingPitch, now } from './quiz.js';
import { createTrailPlan, simulateTrail, planAt, normaliseMovement, landingPulse } from './trailMotion.js';
import { terrainRunDuration, trailViewTimes, describeTrailTerrain } from './trailTerrain.js';
import { surfaceElevation } from './terrainSurface.js';
import { saturate, wrap360 } from './grid.js';
import { withAnswerExplanation } from './answerExplanation.js';

export const TRAIL_COLORS = { A: '#ff6358', B: '#58d68b', C: '#39d5ed' };
export const normaliseTrailAnswer = value => value === 'grid' ? 'grid' : 'trail';
const BANDS = {
  easy: { min: 1.7, max: 8, cue: 1.7, profile: 10 },
  medium: { min: 1.2, max: 6, cue: 1.4, profile: 7 },
  hard: { min: 0.95, max: 4.8, cue: 1.2, profile: 5 },
  expert: { min: 0.8, max: 4.0, cue: 1.0, profile: 4 },
  master: { min: 0.7, max: 3.5, cue: 0.9, profile: 3.4 },
};
export function getTrailPreset(difficulty = 'medium', tuning = null) {
  const base = applyTuning(getDifficulty(difficulty), tuning);
  return { ...base, trailBand: BANDS[difficulty] || BANDS.medium };
}

export function describeTrailRoute(model, route, plan, fov, times, columns) {
  return times.map((t) => {
    const p = planAt(plan, t), x = route.x + p.x, y = route.y + p.y;
    const descriptor = model.skyline.viewDescriptor(x, y, wrap360(p.heading + Math.sin(t * Math.PI / 0.32) * 1.1), fov, {
      eyeHeight: route.feet[p.index] + 1.7 - model.getElevation(x, y), columns,
    });
    return { ...descriptor, pitchOffset: -landingPulse(route, t) * 0.45 };
  });
}

/** Minimum map-relative spacing keeps otherwise fair tracks from clustering. */
export function trailSpread(points, size) {
  const distances = points.flatMap((p, i) => points.slice(i + 1).map(q => Math.hypot(p.x - q.x, p.y - q.y)));
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minSeparation = Math.min(...distances), diameter = Math.max(...distances);
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  const ok = minSeparation >= size * .25 && diameter >= size * .45
    && spanX >= size * .30 && spanY >= size * .30 && triangleSpread(points) >= .18;
  return { ok, minSeparation, diameter, spanX, spanY };
}

// Use the central 9 degrees while inspect is idle. Even the three-column
// coarse cue spans only +/-7.5 degrees, inside the viewmodel-free centre strip.
function routeCue(a, b, times) {
  let best = { magnitude: 0, delta: 0, bearing: 0, t: 0 };
  for (let k = 0; k < times.length; k++) {
    const t = times[k];
    if ((t >= 1.2 && t <= 4) || (t >= 7.4 && t <= 10.2)) continue;
    const n = a[k].horizon.length;
    for (let c = 1; c < n - 1; c++) {
      const offset = a[k].fov * c / (n - 1) - a[k].fov / 2;
      if (Math.abs(offset) > a[k].fov * .05) continue;
      let delta = 0;
      for (let j = -1; j <= 1; j++) delta += ((b[k].horizon[c + j] - (b[k].pitchOffset || 0)) - (a[k].horizon[c + j] - (a[k].pitchOffset || 0))) / 3;
      if (Math.abs(delta) > best.magnitude) best = { magnitude: Math.abs(delta), delta,
        bearing: Math.round(wrap360(a[k].heading + offset)), t };
    }
  }
  return best;
}

export function compareTrailViews(a, b, band, times, { coarse = false } = {}) {
  const Ds = a.views.map((d, i) => descriptorDistance(d, b.views[i]));
  const D = Math.sqrt(Ds.reduce((s, d) => s + d * d, 0) / Ds.length);
  const depths = a.views.map((d, i) => depthDifference(d, b.views[i]));
  let profile = 0;
  for (let k = 0; k < a.ground.length; k += 16) {
    profile += ((a.ground[k] - a.ground[0]) - (b.ground[k] - b.ground[0])) ** 2;
  }
  profile = Math.sqrt(profile / Math.ceil(a.ground.length / 16));
  const cue = routeCue(a.views, b.views, times);
  const slack = coarse ? 1.25 : 1, min = band.min * (coarse ? 0.55 : 1);
  const maxFrame = Math.max(...Ds), depth = depths.reduce((s, d) => s + d, 0) / depths.length;
  const ok = D >= min && D <= band.max * slack && maxFrame <= band.max * 1.5 * slack
    && profile <= band.profile * slack && depth <= 1.05 * slack
    && cue.magnitude >= band.cue * (coarse ? 0.6 : 1);
  const cost = 0.55 * D / band.max + 0.15 * maxFrame / (band.max * 1.5)
    + 0.2 * profile / band.profile + 0.1 * depth / 1.05;
  return { ok, D, cost, profile, depth, cue, maxFrame };
}

// Keep the complete contour map: a crop around the tracks can hide the
// distant ridge that supplies their distinguishing skyline cue.
export function trailMapExtent(model) {
  return { x: model.size / 2, y: model.size / 2, size: model.size };
}

export function generateTrailQuiz({ seed, world = 'classic', difficulty = 'medium', variant = 0, headingMode = null, movement = 'go',
  tuning = null, size, n, maxTerrainAttempts = 4, onProgress = () => {} }) {
  const t0 = now(), preset = getTrailPreset(difficulty, tuning), band = preset.trailBand;
  const headingStyle = ['exact', 'cardinal', 'intercardinal'].includes(headingMode) ? headingMode : preset.heading;
  const physics = normaliseMovement(movement), seeds = new SeedManager(`${seed}#${difficulty}`), log = [];
  const fov = 90, eyeHeight = 1.7;
  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating bunny-hop terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n, world });
    if (!terrainCheck.ok) { log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues }); continue; }
    const rng = seeds.stream('trail', attempt, variant, headingStyle);
    const headings = rng.fork('headings').shuffle(candidateHeadings(headingStyle, rng.fork('angles')));
    for (let h = 0; h < 8; h++) {
      const heading = headings[h % headings.length];
      onProgress('Searching for three matching moving terrain views');
      const plan = createTrailPlan(rng.fork(`steering-${h}`), heading, terrainRunDuration(model.size)), grng = rng.fork(`grid-${h}`);
      const coarseTimes = trailViewTimes(plan.duration, true), fullTimes = trailViewTimes(plan.duration);
      const routes = [], gridSize = 33, margin = 65, span = model.size - 2 * margin;
      const vg = new ViewpointGenerator(model, preset, rng.fork(`quality-${h}`), { fov, eyeHeight });
      for (let j = 0; j < gridSize; j++) for (let i = 0; i < gridSize; i++) {
        const p = { x: margin + (i + grng.range(0.1, 0.9)) * span / gridSize,
          y: margin + (j + grng.range(0.1, 0.9)) * span / gridSize };
        const route = simulateTrail(model, p, plan, physics);
        if (!route) continue;
        route.terrainRun = describeTrailTerrain(model, route);
        if (!route.terrainRun.ok || route.terrainRun.cellCount < 2) continue;
        route.views = describeTrailRoute(model, route, plan, fov, coarseTimes, 13);
        if (route.views.some((d) => d.edgeFrac > 0.35 || d.blockedFrac > 0.5)) continue;
        const skylineRange = Math.max(...route.views[0].horizon) - Math.min(...route.views[0].horizon);
        if (skylineRange < 1.5) continue;
        routes.push(route);
      }
      const pairFor = (a, b, coarse = true, times = coarseTimes) => {
        if (Math.hypot(a.x - b.x, a.y - b.y) < model.size * .25) return null;
        const pair = compareTrailViews(a, b, band, times, { coarse });
        return pair.ok ? pair : null;
      };
      const ranking = rankLookalikeTriples(routes, pairFor, 72, p => trailSpread(p, model.size).ok);
      let accepted = 0;
      const valid = [];
      const refined = new Map();
      for (const triple of ranking.triples) {
        const points = triple.points.map((p) => {
          if (!refined.has(p)) refined.set(p, { ...p, views: describeTrailRoute(model, p, plan, fov, fullTimes, 33),
            quality: vg.score(vg.sweep(p), heading) });
          return refined.get(p);
        });
        if (points.some((p) => p.quality.total < preset.minQuality)) continue;
        const pairs = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => pairFor(points[a], points[b], false, fullTimes));
        if (pairs.some((p) => !p)) continue;
        const pitch = framingPitch(Array.from(points[0].views[0].horizon));
        // Keep the distinguishing cue in the actual wide scene at all choices.
        const cueVisible = pairs.every((p, k) => {
          const a = points[[0, 0, 1][k]], index = fullTimes.indexOf(p.cue.t), d = a.views[index];
          const offset = wrap360(p.cue.bearing - d.heading + 180) - 180;
          const c = Math.max(0, Math.min(32, Math.round((offset + fov / 2) / fov * 32)));
          return [[0, 1], [0, 2], [1, 2]][k].every((i) => {
            const view = points[i].views[index];
            return Math.abs(view.horizon[c] - pitch - (view.pitchOffset || 0)) < 25;
          });
        });
        if (!cueVisible) continue;
        accepted++;
        valid.push({ points, pairs, cost: Math.max(...pairs.map((p) => p.cost)), terrainScore: Math.min(...points.map(p => p.terrainRun.score)), pitch });
      }
      log.push({ attempt, stage: 'question', try: h, ok: valid.length > 0,
        confidence: valid.length ? 0.85 : 0, issues: valid.length ? [] : ['no fair three-route match'] });
      if (!valid.length) continue;
      valid.sort((a, b) => (a.cost - .35 * a.terrainScore) - (b.cost - .35 * b.terrainScore));
      const triple = rng.fork(`question-${h}`).pick(valid.slice(0, difficulty === 'master' ? 2 : 4));
      const chosen = rng.fork(`correct-${h}`).pick(triple.points);
      const options = rng.fork(`labels-${h}`).shuffle(triple.points).map((p, i) => {
        const correct = p === chosen;
        const pair = correct ? null : compareTrailViews(chosen, p, band, fullTimes);
        const { views, quality, ...route } = p;
        return { ...route, label: ['A', 'B', 'C'][i], correct, D: pair?.D || 0, cue: pair?.cue || null,
          z: surfaceElevation(model, p.x, p.y), landform: model.analyzer.classify(p.x, p.y) };
      });
      const minD = Math.min(...triple.pairs.map((p) => p.D)), confidence = saturate(0.65 + 0.2 * Math.min(1, minD / band.min - 0.5));
      if (confidence < preset.minConfidence) continue;
      const correctLabel = options.find((p) => p.correct).label;
      const camera = { x: chosen.x, y: chosen.y, z: chosen.feet[0] + eyeHeight, heading, pitch: triple.pitch, fov, eyeHeight, roll: 0 };
      const spread = trailSpread(triple.points, model.size), { minSeparation } = spread;
      return withAnswerExplanation({
        version: 1, mode: 'trail', seed, difficulty, variant, lowConfidence: false,
        terrain: terrainSummary(model, interval, terrainCheck), camera,
        trail: { plan, movement: physics, answerMode: 'trail', duration: plan.duration, pairs: triple.pairs, times: fullTimes },
        options, correctLabel, heading: { degrees: heading, ...formatHeading(heading, headingStyle), mode: headingStyle },
        mapExtent: trailMapExtent(model), mapRotation: preset.mapRotation ? rng.fork('rotation').pick([0, 90, 180, 270]) : 0,
        landmarks: landmarkSummary(model), hardness: saturate(1 - triple.cost),
        quality: { total: chosen.quality.total, ...chosen.quality.components, blockedFrac: chosen.quality.blockedFrac,
          edgeFrac: chosen.quality.edgeFrac, landmarksInView: chosen.quality.landmarksInView },
        validation: { ok: true, issues: [], confidence, uniqueness: saturate(minD / (2 * band.min)),
          minDistance: minD, minRequiredDistance: band.min, minSeparation, minCue: band.cue, requiredSeparation: model.size * .25, spread },
        stats: { viewpointsEvaluated: routes.length * coarseTimes.length, questionsCompared: accepted, terrainAttempt: attempt,
          ms: Math.round(now() - t0) }, log,
      }, model);
    }
  }
  throw new Error('No fair three-trail question found. Try another seed or a lower difficulty.');
}
