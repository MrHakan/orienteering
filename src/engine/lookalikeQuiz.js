// Three distant points with mutually similar views, rather than two points
// independently similar to an observer. Coarse graph triangles are shortlisted
// in all eight headings, then re-cast at full resolution before acceptance.

import { SeedManager } from './rng.js';
import { ViewpointGenerator } from './viewpoints.js';
import { QuizValidator } from './validator.js';
import { TerrainAnalyzer } from './analyzer.js';
import { getDifficulty, applyTuning } from './difficulty.js';
import { descriptorDistance, horizonDistance } from './skyline.js';
import { distinguishingCue, depthDifference, VIEW_COLUMNS } from './quizCandidates.js';
import { buildTerrain, assemble, now } from './quiz.js';
import { DIRECTIONS } from './facingQuiz.js';
import { saturate, wrap360 } from './grid.js';

export { DIRECTIONS };

const BANDS = {
  easy: [1.5, 2.4, 3.8, 1.3], medium: [1.0, 1.8, 3.2, 1.0],
  hard: [0.8, 1.5, 2.8, 0.9], expert: [0.7, 1.3, 2.5, 0.8], master: [0.65, 1.2, 2.3, 0.8],
};
const COARSE_COLUMNS = 13;
const SHORTLIST = 48;
const EXTENDED_SHORTLIST = 192;
const MAX_DEPTH_GAP = 0.95;
const anchorCache = new WeakMap();

/** Prominent peaks/notches in screen coordinates, with small ripples removed. */
export function skylineAnchors(desc) {
  if (anchorCache.has(desc)) return anchorCache.get(desc);
  const h = desc.horizon;
  const smooth = Array.from(h, (_, i) => {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(h.length - 1, i + 1); j++) { sum += h[j]; count++; }
    return sum / count;
  });
  const anchors = [];
  for (const sign of [1, -1]) {
    for (let i = 1; i < smooth.length - 1; i++) {
      const z = sign * smooth[i];
      if (z <= sign * smooth[i - 1] || z < sign * smooth[i + 1]) continue;
      let left = z, right = z;
      for (let j = i - 1; j >= 0; j--) {
        if (sign * smooth[j] > z) break;
        left = Math.min(left, sign * smooth[j]);
      }
      for (let j = i + 1; j < smooth.length; j++) {
        if (sign * smooth[j] > z) break;
        right = Math.min(right, sign * smooth[j]);
      }
      const prominence = z - Math.max(left, right);
      if (prominence >= 0.4) anchors.push({ position: i / (h.length - 1), prominence, kind: sign === 1 ? 'peak' : 'notch' });
    }
  }
  anchorCache.set(desc, anchors);
  return anchors;
}

function anchorGap(a, b, coarse) {
  const aa = skylineAnchors(a), bb = skylineAnchors(b);
  let gap = 0;
  // A strong feature in either view must have a counterpart in the other;
  // weak extra ripples are tolerated. Never slide profiles to make them fit.
  for (const [from, to] of [[aa, bb], [bb, aa]]) {
    for (const anchor of from.filter((p) => p.prominence >= (coarse ? 1.3 : 1.0))) {
      const counterparts = to.filter((p) => p.kind === anchor.kind);
      const nearest = counterparts.reduce((min, p) => Math.min(min, Math.abs(p.position - anchor.position)), 1);
      gap = Math.max(gap, nearest);
    }
  }
  return gap;
}

/** Effective developer defaults; three options and eight headings are fixed. */
export function getLookalikePreset(difficulty = 'medium', tuning = null) {
  const base = getDifficulty(difficulty);
  const [min, target, max, cue] = BANDS[difficulty] || BANDS.medium;
  const preset = applyTuning({ ...base, heading: 'intercardinal', distractors: 2,
    fov: [60, 66], band: { min, target, max }, minQuality: 0.42,
    minConfidence: 0.35, rejectSameLandform: true,
    search: { cue, shortlist: 3 },
  }, tuning);
  // These define the mode, even when a link contains another mode's overrides.
  preset.heading = 'intercardinal';
  preset.distractors = 2;
  return preset;
}

/** Every block of eight automatic variants visits each heading exactly once. */
export function lookalikeDirection(seed, difficulty, variant = 0, direction = 'auto') {
  if (direction !== 'auto') {
    const d = DIRECTIONS.find((d) => d.label === direction);
    if (!d) throw new Error(`Unknown look-alike direction: ${direction}`);
    return d;
  }
  const order = new SeedManager(`${seed}#${difficulty}`).stream('lookalike-directions').shuffle(DIRECTIONS);
  return order[((variant % 8) + 8) % 8];
}

/** Absolute angles stay intact: never align, mirror or normalise the skyline. */
export function compareLookalikeViews(a, b, preset, { coarse = false } = {}) {
  const D = descriptorDistance(a, b);
  const horizon = horizonDistance(a.horizon, b.horizon);
  const depth = depthDifference(a, b);
  const cue = distinguishingCue(a, b);
  const anchors = anchorGap(a, b, coarse);
  // Screen-wide shape at two scales catches broad ridge/saddle mismatches
  // that one sharp peak or a low mean error could otherwise disguise.
  const n = a.horizon.length;
  let shape = 0;
  for (const fraction of [0.08, 0.24]) {
    const step = Math.max(1, Math.round((n - 1) * fraction));
    let sum = 0;
    for (let i = 0; i < n - step; i++) {
      sum += ((a.horizon[i + step] - a.horizon[i]) - (b.horizon[i + step] - b.horizon[i])) ** 2;
    }
    shape += Math.sqrt(sum / (n - step)) / 2;
  }
  const slack = coarse ? 1.2 : 1;
  const min = coarse ? preset.band.min * 0.6 : Math.max(0.6, preset.band.min);
  const max = Math.min(3.8, preset.band.max);
  const minCue = coarse ? preset.search.cue * 0.65 : Math.max(0.6, preset.search.cue);
  const ok = D >= min && D <= max * slack && horizon <= max * 1.15 * slack
    && depth <= MAX_DEPTH_GAP * slack && shape <= max * 1.5 * slack && cue.magnitude >= minCue
    && anchors <= (coarse ? 0.24 : 0.14);
  const cost = 0.5 * D / max + 0.15 * horizon / (max * 1.15)
    + 0.15 * depth / MAX_DEPTH_GAP + 0.1 * shape / (max * 1.5) + 0.1 * anchors / 0.14;
  return { ok, cost, D, horizon, depth, shape, anchors, cue };
}

/** Minimax comes first; balance penalises one easy-to-eliminate outlier. */
export function tripleCost(pairs) {
  const costs = pairs.map((p) => p.cost);
  const worst = Math.max(...costs), best = Math.min(...costs);
  return 0.7 * worst + 0.2 * costs.reduce((a, b) => a + b, 0) / 3 + 0.1 * (worst - best);
}

/** Keep three separate map locations, rather than a row along one slope. */
export function triangleSpread([a, b, c]) {
  const longest = Math.max(Math.hypot(a.x - b.x, a.y - b.y), Math.hypot(a.x - c.x, a.y - c.y), Math.hypot(b.x - c.x, b.y - c.y));
  return longest ? Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / longest ** 2 : 0;
}

/**
 * Build the compatibility graph once, intersect adjacency lists to enumerate
 * triangles, and retain a bounded shortlist. pairFor returns null for an
 * incompatible pair. No point is privileged as the eventual correct answer.
 */
export function rankLookalikeTriples(points, pairFor, limit = SHORTLIST, acceptTriple = () => true) {
  const edges = Array.from({ length: points.length }, () => new Map());
  let pairsExamined = 0, total = 0;
  for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++) {
    pairsExamined++;
    const pair = pairFor(points[a], points[b]);
    if (pair) edges[a].set(b, pair);
  }
  const triples = [];
  for (let a = 0; a < points.length; a++) for (const [b, ab] of edges[a]) {
    for (const [c, bc] of edges[b]) {
      const ac = edges[a].get(c);
      if (!ac) continue;
      if (!acceptTriple([points[a], points[b], points[c]])) continue;
      total++;
      const pairs = [ab, ac, bc];
      const cost = tripleCost(pairs);
      if (triples.length === limit && cost >= triples.at(-1).cost) continue;
      triples.push({ points: [points[a], points[b], points[c]], pairs, cost });
      triples.sort((x, y) => x.cost - y.cost);
      if (triples.length > limit) triples.pop();
    }
  }
  return { triples, total, pairsExamined };
}

/** Approximate descriptors reuse a point's 360° sweep; exact rays decide acceptance. */
export function sweepDescriptor(sw, heading, fov, eyeHeight) {
  const horizon = [], dist = [], near = [[], [], []];
  const rays = sw.rays;
  for (let i = 0; i < COARSE_COLUMNS; i++) {
    const index = wrap360(heading - fov / 2 + fov * i / (COARSE_COLUMNS - 1)) / 360 * rays.length;
    const a = rays[Math.floor(index) % rays.length], b = rays[(Math.floor(index) + 1) % rays.length];
    const t = index - Math.floor(index);
    const lerp = (x, y) => x + (y - x) * t;
    horizon.push(lerp(a.angle, b.angle));
    dist.push(lerp(a.dist, b.dist));
    for (let p = 0; p < 3; p++) near[p].push(lerp(a.probes[p], b.probes[p]));
  }
  return { ...sw.p, heading, fov, eyeHeight, horizon, dist, near };
}

function usable(desc, quality, preset) {
  return quality.total >= preset.minQuality && desc.blockedFrac <= 0.45 && desc.edgeFrac <= 0.4
    && (quality.components.skylineComplexity >= 0.25 || quality.components.landmarkVisibility >= 0.25);
}

/**
 * mode='lookalike', direction='auto' | N | NE | E | SE | S | SW | W | NW.
 * A bounded failure is explicit: never fall back to an unrelated puzzle or
 * label a broken/ambiguous two-option result as a look-alike question.
 */
export function generateLookalikeQuiz({ seed, world = 'classic', difficulty = 'medium', variant = 0, direction = 'auto', tuning = null,
  size, n, maxTerrainAttempts = 8, onProgress = () => {} }) {
  const t0 = now();
  const preset = getLookalikePreset(difficulty, tuning);
  const chosenDirection = lookalikeDirection(seed, difficulty, variant, direction);
  const seeds = new SeedManager(`${seed}#${difficulty}`);
  const vt = ['lookalike', `v${variant}`, chosenDirection.label];
  const log = [];
  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating look-alike terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n, world });
    if (!terrainCheck.ok) { log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues }); continue; }
    const rng = seeds.stream('view', attempt, ...vt);
    const fov = Math.round(rng.range(...preset.fov));
    const eyeHeight = Math.round(rng.range(1.6, 1.85) * 100) / 100;
    const vg = new ViewpointGenerator(model, preset, rng.fork('positions'), { fov, eyeHeight, gridSize: 18 });
    const byHeading = DIRECTIONS.map(() => []);
    onProgress('Scanning terrain in all 8 directions');
    const positions = vg.candidatePositions();
    for (const [id, p] of positions.entries()) {
      const sw = vg.sweep(p);
      const z = model.getElevation(p.x, p.y), slope = model.getSlope(p.x, p.y);
      for (const [di, d] of DIRECTIONS.entries()) {
        const quality = vg.score(sw, d.heading);
        if (!usable(quality, quality, preset)) continue;
        byHeading[di].push({ ...p, id, z, slope, quality, desc: sweepDescriptor(sw, d.heading, fov, eyeHeight) });
      }
    }

    const geographicCache = new Map();
    const minSeparation = Math.max(350, preset.minSeparation, preset.minTrueDistance);
    const geographicallyDistinct = (a, b) => {
      if (Math.hypot(a.x - b.x, a.y - b.y) < minSeparation) return false;
      // Similar elevations and slopes also keep the renderer's colour and
      // shading comparable, instead of matching just the silhouette.
      if (Math.abs(a.z - b.z) > 0.18 * (model.max - model.min) || Math.abs(a.slope - b.slope) > 8) return false;
      if (!preset.rejectSameLandform) return true;
      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (!geographicCache.has(key)) geographicCache.set(key, !model.analyzer.sameFeature(a.x, a.y, b.x, b.y));
      return geographicCache.get(key);
    };

    const headingStats = [], validByHeading = [];
    let examined = 0, refined = 0;
    for (const [di, d] of DIRECTIONS.entries()) {
      onProgress(`Matching A/B/C views facing ${d.label} (${di + 1}/8)`);
      const graph = rankLookalikeTriples(byHeading[di], (a, b) => {
        const pair = compareLookalikeViews(a.desc, b.desc, preset, { coarse: true });
        return pair.ok && geographicallyDistinct(a, b) ? pair : null;
      }, d.label === chosenDirection.label ? EXTENDED_SHORTLIST : SHORTLIST, (pts) => triangleSpread(pts) >= 0.08);
      examined += graph.pairsExamined;
      const exact = new Map();
      const describe = (p) => {
        if (!exact.has(p.id)) exact.set(p.id, model.skyline.viewDescriptor(p.x, p.y, d.heading, fov, { eyeHeight, columns: VIEW_COLUMNS }));
        return exact.get(p.id);
      };
      const valid = [];
      let headingRefined = 0;
      for (const triple of graph.triples) {
        // Coarse peak locations can move under exact ray casting. If the
        // first shortlist has no passing triangle, search deeper for the
        // requested direction before discarding the terrain.
        if (headingRefined >= SHORTLIST && valid.length) break;
        headingRefined++;
        refined++;
        const pts = triple.points;
        const descs = pts.map(describe);
        if (descs.some((desc, i) => !usable(desc, pts[i].quality, preset))) continue;
        const pairs = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => ({ a, b, ...compareLookalikeViews(descs[a], descs[b], preset) }));
        if (pairs.some((p) => !p.ok)) continue;
        const cost = tripleCost(pairs);
        valid.push({ points: pts, descs, pairs, cost, heading: d.heading });
      }
      valid.sort((a, b) => a.cost - b.cost);
      validByHeading.push(valid);
      headingStats.push({ direction: d.label, heading: d.heading, viewpoints: byHeading[di].length, triangles: graph.total, refined: headingRefined, valid: valid.length });
      log.push({ attempt, stage: 'matching', direction: d.label, coarse: graph.total, refined: headingRefined, valid: valid.length });
    }
    const matches = validByHeading[DIRECTIONS.findIndex((d) => d.heading === chosenDirection.heading)];
    if (!matches.length) continue;
    const pick = seeds.stream('shortlist', attempt, ...vt);
    const triple = pick.weighted(matches.slice(0, 3), (t) => Math.exp(-4 * t.cost));
    // Choose the correct vertex only AFTER choosing the symmetric triple.
    const ci = pick.fork('observer').int(0, 2);
    const correct = triple.points[ci], correctDesc = triple.descs[ci];
    const signature = (p) => model.analyzer.getTerrainSignature(p.x, p.y, { eyeHeight });
    const correctSig = signature(correct);
    const view = { x: correct.x, y: correct.y, heading: triple.heading, fov, eyeHeight };
    const candidates = {
      correct: { ...correct, desc: correctDesc, signature: correctSig },
      distractors: triple.points.flatMap((p, i) => {
        if (i === ci) return [];
        const sig = signature(p);
        return [{ ...p, desc: triple.descs[i], signature: sig,
          D: descriptorDistance(correctDesc, triple.descs[i]), sigDist: TerrainAnalyzer.signatureDistance(correctSig, sig, model.max - model.min), cue: distinguishingCue(correctDesc, triple.descs[i]) }];
      }),
      considered: examined, inBand: matches.length,
    };
    const validation = QuizValidator.validateQuestion({ view, quality: correct.quality, candidates }, preset);
    if (!validation.ok) { log.push({ attempt, stage: 'question', try: 'final', ...validation }); continue; }
    const e = { model, interval, terrainCheck, view, quality: correct.quality, candidates, validation,
      attempt, try: ci, evaluated: positions.length * 8, hardness: saturate(1 - triple.cost) };
    const q = assemble(e, { seed, difficulty, variant, preset, seeds, vt, log, t0, searched: matches.length, mode: 'lookalike' });
    q.directionChoice = direction;
    q.matching = { direction: chosenDirection.label, cost: triple.cost, minSeparation,
      pairs: triple.pairs.map(({ a, b, D, horizon, depth, shape, anchors, cue }) => ({
        from: { x: triple.points[a].x, y: triple.points[a].y }, to: { x: triple.points[b].x, y: triple.points[b].y }, D, horizon, depth, shape, anchors, cue,
      })),
    };
    q.stats = { ...q.stats, directions: headingStats, triplesRefined: refined, pairsExamined: examined };
    return q;
  }
  throw new Error(`No fair A/B/C look-alikes facing ${chosenDirection.label} for this seed. Try another seed or a lower difficulty.`);
}
