// Grid references are fixed to the terrain: A is the north row, 1 the west
// column. A display rotation never changes a cell's identity.
import { SeedManager } from './rng.js';
import { getDifficulty, applyTuning } from './difficulty.js';
import { formatHeading } from './heading.js';
import { ViewpointGenerator } from './viewpoints.js';
import { descriptorDistance, horizonDistance } from './skyline.js';
import { distinguishingCue } from './quizCandidates.js';
import { buildTerrain, terrainSummary, landmarkSummary, framingPitch, now } from './quiz.js';
import { saturate, wrap360, angleDiff } from './grid.js';
import { createSunWatch } from './sunWatch.js';
import { withAnswerExplanation } from './answerExplanation.js';
import {
  normaliseGen, GEN2_GRID_THRESHOLDS, qualifiedMapSummits, sweepPanoramas,
  discoverPanoramaHeadings, fastWindowCheck, fastSweepHorizonMinRMS, analyzeSkylineFrame,
  descriptorHorizonPeaks, featureDistinction, adjacentSummitShift, mapReasoningMetrics, gridGen2Scores,
} from './gen2.js';

export const GRID_SIZES = [4, 6, 8, 16];
export const normaliseGridSize = (value) => GRID_SIZES.includes(Number(value)) ? Number(value) : 4;
export const normaliseGridChallenge = (value) => value === 'lost-compass' ? value : 'standard';
export const headingHidden = (quiz) => !!quiz.sunWatch || quiz.mode === 'facing' || (quiz.mode === 'grid' && quiz.grid.challenge === 'lost-compass');
export const usesGrid = (quiz) => !!quiz?.grid;

/** References belong to the displayed map extent, including local friend maps. */
export function cellAtExtent(x, y, extent, divisions) {
  return cellAt(x - extent.x + extent.size / 2, y - extent.y + extent.size / 2, extent.size, divisions);
}

export function gridCells(size, divisions) {
  const n = normaliseGridSize(divisions), step = size / n;
  return Array.from({ length: n * n }, (_, i) => {
    const row = Math.floor(i / n), column = i % n;
    return { label: `${String.fromCharCode(65 + row)}${column + 1}`, row, column,
      x: (column + 0.5) * step, y: size - (row + 0.5) * step };
  });
}

export function cellAt(x, y, size, divisions) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > size || y > size) return null;
  const n = normaliseGridSize(divisions);
  const column = Math.min(n - 1, Math.floor(x / size * n));
  const row = Math.min(n - 1, Math.floor((size - y) / size * n));
  return `${String.fromCharCode(65 + row)}${column + 1}`;
}

export function parseCell(value, divisions) {
  const match = /^([A-P])\s*([1-9]|1[0-6])$/.exec(String(value).trim().toUpperCase());
  const n = normaliseGridSize(divisions);
  if (!match || match[1].charCodeAt(0) - 65 >= n || Number(match[2]) > n) return null;
  return `${match[1]}${Number(match[2])}`;
}

/**
 * Grid question metrics. hardness: how close the nearest look-alike comes, how many cells look
 * alike and how many of those are far from the answer (no neighbouring-cell shortcut).
 * confidence: how visible the weakest look-alike's skyline cue is and how clear the view is —
 * fairness, not closeness, so the two numbers rank different things.
 */
export function gridScore({ closestD, minD, lookalikes, remote, weakestCue, quality, blockedFrac, edgeFrac }) {
  const closeness = Math.exp(-(closestD - minD) / 1.2);
  return {
    hardness: saturate(0.5 * closeness + 0.3 * (1 - Math.exp(-lookalikes / 5)) + 0.2 * (lookalikes ? remote / lookalikes : 0)),
    confidence: saturate(0.45 * saturate((weakestCue - 0.8) / 1.6) + 0.4 * saturate(quality / 0.8) + 0.15 * saturate(1 - 2 * blockedFrac - 2 * edgeFrac)),
  };
}

// Master grids whose look-alikes all lack a visible cue try one more terrain, then settle for the clearest.
const FAINT_CUE = 'look-alike cell without a visible cue', FAINT_AFTER = 1;

/** Every possible origin is a cell centre, so all answers can be checked.
 * Lost compass checks other cells in all eight directions, not only the
 * true heading. The only fallback question is a Master one whose look-alikes
 * all lack a visible cue (validation.ok false, lowConfidence, faintCue).
 */
export function generateGridQuiz(opts) {
  if (normaliseGen(opts.gen) === 2) return generateGridQuizGen2(opts);
  const { seed, world = 'classic', difficulty = 'medium', variant = 0, headingMode = null,
    gridSize = 4, gridChallenge = 'standard', tuning = null, size, n, maxTerrainAttempts = 4, onProgress = () => {} } = opts;
  const t0 = now(), divisions = normaliseGridSize(gridSize), challenge = normaliseGridChallenge(gridChallenge);
  const hidden = challenge === 'lost-compass';
  const watch = difficulty === 'sun-watch';
  const base = applyTuning(getDifficulty(difficulty), tuning);
  const heading = hidden || watch ? 'intercardinal' : ['cardinal', 'intercardinal', 'exact'].includes(headingMode) ? headingMode : base.heading;
  const preset = { ...base, heading };
  const seeds = new SeedManager(`${seed}#${difficulty}`);
  const vt = ['grid', divisions, challenge, heading, variant];
  const minD = Math.max(0.6, base.band.min);
  const log = [];

  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating grid terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n, world });
    if (!terrainCheck.ok) { log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues }); continue; }
    const cells = gridCells(model.size, divisions);
    const rng = seeds.stream('view', attempt, ...vt);
    const fov = Math.round(rng.range(preset.fov[0], preset.fov[1])), eyeHeight = 1.7;
    const vg = new ViewpointGenerator(model, preset, rng.fork('viewpoints'), { fov, eyeHeight,
      maxPicks: base.search?.viewTries || 32, minPickDistance: 0 });
    vg.candidatePositions = () => cells.filter((p) => model.getSlope(p.x, p.y) <= 26);
    onProgress(`Scoring ${cells.length} cell centres`);
    const { picked, evaluated } = vg.generate();
    const cache = new Map();
    const describe = (p, h) => {
      const key = `${p.label}:${h}`;
      if (!cache.has(key)) cache.set(key, model.skyline.viewDescriptor(p.x, p.y, h, fov, { eyeHeight, columns: 49 }));
      return cache.get(key);
    };
    // Master: candidates that pass everything except the visible-cue gate (repetitive terrain).
    const valid = [], faint = [];
    for (const [t, vp] of picked.entries()) {
      const label = cellAt(vp.x, vp.y, model.size, divisions);
      const origin = cells.find((p) => p.label === label);
      const correct = describe(origin, vp.heading);
      if (vp.quality.total < base.minQuality || correct.blockedFrac > 0.45 || correct.edgeFrac > 0.4) continue;
      onProgress(`Checking every cell${hidden ? ' in all 8 directions' : ''} (${t + 1}/${picked.length})`);
      const headings = hidden ? [0, 45, 90, 135, 180, 225, 270, 315] : [vp.heading];
      const options = cells.map((p) => {
        if (p.label === label) return { ...p, heading: vp.heading, correct: true, D: 0 };
        let best = null;
        for (const h of headings) {
          const desc = describe(p, h), D = descriptorDistance(correct, desc);
          if (!best || D < best.D) best = { heading: h, D, cue: distinguishingCue(correct, desc) };
        }
        return { ...p, ...best, correct: false };
      });
      const wrong = options.filter((o) => !o.correct), closest = wrong.reduce((a, b) => b.D < a.D ? b : a);
      // Look-alike cells: the closest one and every cell within twice the ambiguity limit.
      const near = wrong.filter((o) => o.D < 2 * minD), weakestCue = Math.min(...[closest, ...near].map((o) => o.cue.magnitude));
      const issues = [];
      if (closest.D < minD) issues.push(`cell ${closest.label} looks too similar (${closest.D.toFixed(2)}°)`);
      // Master: each look-alike must differ by a skyline cue large enough to see in the frame.
      if (base.search && weakestCue < base.search.cue) issues.push(FAINT_CUE);
      const uniqueness = saturate(closest.D / (minD * 2));
      const accept = saturate(0.6 * uniqueness + 0.4 * vp.quality.total); // acceptance rule, unchanged
      if (accept < base.minConfidence) issues.push('insufficient confidence');
      const remote = near.filter((o) => Math.max(Math.abs(o.row - origin.row), Math.abs(o.column - origin.column)) > 1).length;
      const { hardness, confidence } = gridScore({ closestD: closest.D, minD, lookalikes: near.length, remote, weakestCue,
        quality: vp.quality.total, blockedFrac: correct.blockedFrac, edgeFrac: correct.edgeFrac });
      log.push({ attempt, stage: 'question', try: t, ok: !issues.length, confidence: +confidence.toFixed(3), hardness: +hardness.toFixed(4),
        weakestCue: +weakestCue.toFixed(2), issues });
      const entry = { vp, correct, options, closest, confidence, uniqueness, hardness, weakestCue, lookalikes: near.length, remote };
      if (issues.length) { if (issues.length === 1 && issues[0] === FAINT_CUE) faint.push(entry); continue; }
      valid.push(entry);
      if (!base.search) break;
    }
    if (!valid.length && (attempt < Math.min(FAINT_AFTER, maxTerrainAttempts - 1) || !faint.length)) continue;
    // Still no candidate with a visible cue: keep the one with the clearest cue, marked low-confidence
    // and ranked below clean questions (hardness ≤ 0.3, confidence ≤ 0.4), rather than spend more terrain.
    valid.sort((a, b) => b.hardness - a.hardness);
    const fallback = !valid.length, e = fallback ? faint.reduce((a, b) => b.weakestCue > a.weakestCue ? b : a)
      : rng.fork('choice').pick(valid.slice(0, base.search?.shortlist || 1));
    const options = e.options.map((o) => ({ ...o, z: model.getElevation(o.x, o.y), landform: model.analyzer.classify(o.x, o.y) }));
    const quiz = {
      version: 1, mode: 'grid', seed, difficulty, variant, lowConfidence: fallback,
      grid: { size: divisions, challenge, origin: 'cell-centre', cellMetres: model.size / divisions },
      terrain: terrainSummary(model, interval, terrainCheck),
      camera: { x: e.vp.x, y: e.vp.y, z: model.getElevation(e.vp.x, e.vp.y) + eyeHeight,
        heading: e.vp.heading, eyeHeight, fov, pitch: framingPitch(Array.from(e.correct.horizon)), roll: 0 },
      heading: watch ? { degrees: e.vp.heading, text: '', arrow: '', mode: 'hidden' }
        : { degrees: e.vp.heading, ...formatHeading(e.vp.heading, heading), mode: heading },
      mapRotation: base.mapRotation ? rng.fork('rotation').pick([0, 90, 180, 270]) : 0,
      options, correctLabel: cellAt(e.vp.x, e.vp.y, model.size, divisions), closestLabel: e.closest.label,
      quality: { total: e.vp.quality.total, ...e.vp.quality.components, blockedFrac: e.correct.blockedFrac,
        edgeFrac: e.correct.edgeFrac, landmarksInView: e.vp.quality.landmarksInView },
      validation: { ok: !fallback, issues: fallback ? [FAINT_CUE] : [], confidence: fallback ? Math.min(e.confidence, 0.4) : e.confidence,
        uniqueness: e.uniqueness, minDistance: e.closest.D, minRequiredDistance: minD,
        weakestCue: +e.weakestCue.toFixed(2), lookalikes: e.lookalikes, remoteLookalikes: e.remote, faintCue: fallback },
      hardness: fallback ? Math.min(e.hardness, 0.3) : e.hardness, landmarks: landmarkSummary(model),
      stats: { viewpointsEvaluated: evaluated, cellsChecked: cells.length, directionsChecked: hidden ? 8 : 1,
        questionsCompared: valid.length, terrainAttempt: attempt, ms: Math.round(now() - t0) }, log,
    };
    if (watch) quiz.sunWatch = createSunWatch(quiz, model, { latitude: base.sunWatchLatitude });
    return withAnswerExplanation(quiz, model);
  }
  throw new Error('No unambiguous grid question found. Try a new seed or a lower difficulty.');
}

/**
 * Gen=2 grid generator: constructs phone-legible, hard-and-fair cell-centre
 * views directly from 360 deg cell panoramas, verified on pure interior
 * skyline features and ranked by genuine map-reasoning difficulty.
 */
function generateGridQuizGen2({ seed, world = 'classic', difficulty = 'medium', variant = 0, headingMode = null,
  gridSize = 4, gridChallenge = 'standard', tuning = null, size, n, maxTerrainAttempts = 4, onProgress = () => {} }) {
  const t0 = now();
  const divisions = normaliseGridSize(gridSize);
  const challenge = normaliseGridChallenge(gridChallenge);
  const hidden = challenge === 'lost-compass';
  const watch = difficulty === 'sun-watch';
  const base = applyTuning(getDifficulty(difficulty), tuning);
  const heading = hidden || watch ? 'intercardinal' : ['cardinal', 'intercardinal', 'exact'].includes(headingMode) ? headingMode : base.heading;
  const preset = { ...base, heading };
  const seeds = new SeedManager(`${seed}#${difficulty}`);
  const vt = ['grid', 'gen2', divisions, challenge, heading, variant];
  const minD = Math.max(0.6, base.band.min);
  const T = GEN2_GRID_THRESHOLDS;
  const log = [];

  let bestStrict = null;
  let bestFallback = null;
  let totalEvaluated = 0;

  const cmpEntry = (a, b) => (b.rankScore - a.rankScore)
    || (a.origin.label.localeCompare(b.origin.label))
    || (a.heading - b.heading);

  const attemptCap = Math.max(0, maxTerrainAttempts);
  let zeroPeakTerrains = 0;
  for (let attempt = 0; attempt < attemptCap; attempt++) {
    onProgress(`Generating gen=2 grid terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n, world });
    if (!terrainCheck.ok) {
      log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues });
      continue;
    }

    const cells = gridCells(model.size, divisions);
    const walkable = cells.filter((p) => model.getSlope(p.x, p.y) <= 26);
    if (!walkable.length) continue;

    const rng = seeds.stream('view', attempt, ...vt);
    const fov = Math.round(rng.range(preset.fov[0], preset.fov[1]));
    const eyeHeight = 1.7;
    const summits = qualifiedMapSummits(model, interval, T.minMapPromFactor, T.minMapPromMetres);

    onProgress(`Scanning ${walkable.length} cell panoramas`);
    const sweeps = sweepPanoramas(model, walkable, { step: 1.5, eyeHeight });
    const sweepByLabel = new Map(sweeps.map((sw) => [sw.p.label, sw]));

    // Stage 1: discover phone-legible candidate (cell, heading) windows from 360 deg sweeps.
    const fixedHeadings = heading === 'cardinal' ? [0, 90, 180, 270]
      : heading === 'intercardinal' ? [0, 45, 90, 135, 180, 225, 270, 315] : null;
    const proposals = [];
    for (const sw of sweeps) {
      const origin = sw.p;
      const borderDist = Math.min(origin.row, divisions - 1 - origin.row, origin.column, divisions - 1 - origin.column);
      const isCorner = (origin.row === 0 || origin.row === divisions - 1) && (origin.column === 0 || origin.column === divisions - 1);
      const interiorBias = isCorner ? 0 : borderDist === 0 ? 0.08 : 0.18;
      let heads;
      if (fixedHeadings) {
        heads = fixedHeadings.map((h) => fastWindowCheck(sw, h, fov, summits, T)).filter(Boolean);
        heads.sort((a, b) => (b.quickScore - a.quickScore) || (a.heading - b.heading));
        heads = heads.slice(0, 3);
      } else {
        heads = discoverPanoramaHeadings(sw, fov, summits, T);
      }
      for (const h of heads) {
        const minSweepRMS = fastSweepHorizonMinRMS(sweeps, sw, h.heading, fov);
        const rmsOk = minSweepRMS >= 0.45 ? 1 : 0;
        const propScore = h.quickScore + interiorBias + (rmsOk ? 0.4 : -0.6);
        proposals.push({ sw, origin, heading: h.heading, quickStrict: h.quickStrict, minSweepRMS, propScore });
      }
    }
    totalEvaluated += proposals.length;
    proposals.sort((a, b) => (b.propScore - a.propScore)
      || (a.origin.label.localeCompare(b.origin.label))
      || (a.heading - b.heading));

    // Stage 2: exact 0.5-deg skyline verification on the top proposals.
    const exactStrict = [];
    const exactFallback = [];
    const exactLimit = Math.min(proposals.length, 84);
    for (let i = 0; i < exactLimit; i++) {
      const pr = proposals[i];
      const cam = { x: pr.origin.x, y: pr.origin.y, heading: pr.heading, fov, eyeHeight };
      const sky = analyzeSkylineFrame(model, cam, { step: 0.5, margin: 20, contourInterval: interval, thresholds: T, summits, divisions });
      const item = { ...pr, sky };
      if (sky.passesSkyline) {
        const reasoning = mapReasoningMetrics(model, pr.origin, sky.peaks, cells, divisions, interval);
        const borderDist = Math.min(pr.origin.row, divisions - 1 - pr.origin.row, pr.origin.column, divisions - 1 - pr.origin.column);
        const isCorner = (pr.origin.row === 0 || pr.origin.row === divisions - 1) && (pr.origin.column === 0 || pr.origin.column === divisions - 1);
        // Sweet spot for pure-horizon RMS is 0.70..1.40 deg (challenging yet clearly unique).
        const rmsSweet = pr.minSweepRMS < 0.62 ? 0.15 : saturate(1 - (pr.minSweepRMS - 0.70) / 1.35);
        const preDiff = 0.36 * (1 - Math.exp(-reasoning.decoySameOrder / 8))
          + 0.24 * rmsSweet
          + 0.22 * (isCorner ? 0 : borderDist === 0 ? 0.45 : 1)
          + 0.18 * (1 - Math.exp(-reasoning.singlePeakCells / 12));
        exactStrict.push({ ...item, reasoning, preScore: 0.62 * preDiff + 0.38 * sky.skylineScore });
        if (exactStrict.length >= 36) break;
      } else if (exactFallback.length < 10) {
        exactFallback.push(item);
      }
    }
    exactStrict.sort((a, b) => (b.preScore - a.preScore)
      || (a.origin.label.localeCompare(b.origin.label))
      || (a.heading - b.heading));
    exactFallback.sort((a, b) => (b.sky.skylineScore - a.sky.skylineScore)
      || (a.origin.label.localeCompare(b.origin.label))
      || (a.heading - b.heading));

    // Pick diverse cells first so one ambiguous cell cannot crowd out cleaner cells.
    const toEval = [];
    if (exactStrict.length) {
      const perCell = new Map();
      for (const item of exactStrict) {
        const cnt = perCell.get(item.origin.label) || 0;
        if (cnt >= 2) continue;
        perCell.set(item.origin.label, cnt + 1);
        toEval.push(item);
        if (toEval.length >= 22) break;
      }
    } else {
      toEval.push(...exactFallback.slice(0, 4));
    }
    const vg = new ViewpointGenerator(model, preset, rng.fork('vg'), { fov, eyeHeight, maxPicks: 1, minPickDistance: 0 });
    const vgSweepCache = new Map();
    const vgScoreOf = (origin, h) => {
      if (!vgSweepCache.has(origin.label)) vgSweepCache.set(origin.label, vg.sweep(origin));
      return vg.score(vgSweepCache.get(origin.label), h);
    };

    const descCache = new Map();
    const peakCache = new Map();
    const describe = (p, h) => {
      const key = `${p.label}:${h}`;
      if (!descCache.has(key)) descCache.set(key, model.skyline.viewDescriptor(p.x, p.y, h, fov, { eyeHeight, columns: 49 }));
      return descCache.get(key);
    };
    const descPeaksOf = (p, h, desc) => {
      const key = `${p.label}:${h}`;
      if (!peakCache.has(key)) peakCache.set(key, descriptorHorizonPeaks(desc.horizon, fov, 0.35));
      return peakCache.get(key);
    };

    const evalCandidate = (cand) => {
      const { origin, heading: h, sky } = cand;
      const correct = describe(origin, h);
      const vpQuality = vgScoreOf(origin, h);
      const headings = hidden ? [0, 45, 90, 135, 180, 225, 270, 315] : [h];

      let minHorizonRMS = Infinity;
      let minInteriorCue = Infinity;
      let minFeatureMargin = Infinity;
      let minAdjacentShift = Infinity;
      let adjacentFair = true;
      let ambiguousCells = 0;
      let remoteCloseHorizon = 0;
      const cam = { x: origin.x, y: origin.y, heading: h, fov, eyeHeight };

      const options = cells.map((p) => {
        if (p.label === origin.label) return { ...p, heading: h, correct: true, D: 0 };
        let best = null;
        let bestDesc = null;
        let bestH = h;
        for (const ch of headings) {
          const desc = describe(p, ch);
          const D = descriptorDistance(correct, desc);
          if (!best || D < best.D) { best = { heading: ch, D, cue: distinguishingCue(correct, desc) }; bestDesc = desc; bestH = ch; }
        }
        const fd = featureDistinction(correct, sky.peaks, sky.relief, bestDesc, descPeaksOf(p, bestH, bestDesc), T);
        if (fd.hRMS < minHorizonRMS) minHorizonRMS = fd.hRMS;
        if (fd.intCue < minInteriorCue) minInteriorCue = fd.intCue;
        if (fd.effectiveMargin < minFeatureMargin) minFeatureMargin = fd.effectiveMargin;
        if (!fd.clearOnPhone) ambiguousCells++;

        const cheb = Math.max(Math.abs(p.row - origin.row), Math.abs(p.column - origin.column));
        if (cheb === 1) {
          const adjShift = adjacentSummitShift(model, cam, sky.peaks, p);
          if (adjShift < minAdjacentShift) minAdjacentShift = adjShift;
          if (fd.intCue < T.minAdjacentCue && adjShift < T.minAdjacentShift) adjacentFair = false;
        } else if (fd.hRMS < 1.8) {
          remoteCloseHorizon++;
        }
        return { ...p, ...best, correct: false };
      });
      if (!Number.isFinite(minAdjacentShift)) minAdjacentShift = 0;

      const wrong = options.filter((o) => !o.correct);
      const closest = wrong.reduce((a, b) => (b.D < a.D || (b.D === a.D && b.label < a.label)) ? b : a);
      const near = wrong.filter((o) => o.D < 2 * minD);
      const weakestCue = Math.min(...[closest, ...near].map((o) => o.cue.magnitude));
      const uniqueness = saturate(closest.D / (minD * 2));
      const accept = saturate(0.6 * uniqueness + 0.4 * vpQuality.total);
      const remote = near.filter((o) => Math.max(Math.abs(o.row - origin.row), Math.abs(o.column - origin.column)) > 1).length;
      const { hardness: legacyHardness, confidence: legacyConfidence } = gridScore({
        closestD: closest.D, minD, lookalikes: near.length, remote, weakestCue,
        quality: vpQuality.total, blockedFrac: correct.blockedFrac, edgeFrac: correct.edgeFrac,
      });

      const reasoning = cand.reasoning || mapReasoningMetrics(model, origin, sky.peaks, cells, divisions, interval);
      const scores = gridGen2Scores({
        sky, minHorizonRMS, minInteriorCue, minFeatureMargin, minAdjacentShift,
        remoteCloseHorizon, reasoning, originRow: origin.row, originCol: origin.column, divisions, heading: h,
      });

      const issues = [];
      if (!sky.passesSkyline) issues.push('skyline below gen2 phone-legibility bar');
      if (vpQuality.total < base.minQuality) issues.push('view quality below threshold');
      if (vpQuality.components.landmarkVisibility < T.minLandmarkVisibility) issues.push('weak landmark visibility');
      if (correct.blockedFrac > 0.45 || correct.edgeFrac > 0.4) issues.push('occluded or off-map view');
      if (closest.D < minD) issues.push(`cell ${closest.label} looks too similar (${closest.D.toFixed(2)}°)`);
      if (base.search && weakestCue < base.search.cue) issues.push(FAINT_CUE);
      if (accept < base.minConfidence) issues.push('insufficient confidence');
      if (ambiguousCells > 0) issues.push(`${ambiguousCells} cell(s) fail gen2 feature uniqueness`);
      if (!adjacentFair) issues.push('adjacent cell lacks clear summit shift or skyline cue');

      const strict = issues.length === 0;
      const basicValid = closest.D >= minD && (!base.search || weakestCue >= base.search.cue) && accept >= base.minConfidence;
      const edgePenalty = 0.12 * Math.max(0, sky.edgeHighMax - 0.60);
      const rankScore = strict
        ? 0.62 * scores.difficulty + 0.23 * scores.fairness + 0.15 * scores.readability - edgePenalty
        : (basicValid ? 0.5 : 0) + (sky.passesSkyline ? 0.4 : 0) + 0.35 * scores.fairness + 0.35 * scores.readability + 0.2 * scores.difficulty - 0.08 * Math.min(5, ambiguousCells);

      return {
        attempt, model, interval, terrainCheck, fov, eyeHeight, origin, heading: h,
        correct, vpQuality, options, closest, near, remote, weakestCue, uniqueness, accept,
        legacyHardness, legacyConfidence, sky, reasoning, scores,
        minHorizonRMS, minInteriorCue, minFeatureMargin, minAdjacentShift, ambiguousCells,
        issues, strict, basicValid, rankScore,
      };
    };

    const strictValid = [];
    for (const [idx, cand] of toEval.entries()) {
      onProgress(`Evaluating gen=2 candidate (${idx + 1}/${toEval.length})`);
      const entry = evalCandidate(cand);
      log.push({
        attempt, stage: 'gen2', try: idx, cell: entry.origin.label, heading: entry.heading,
        ok: entry.strict, difficulty: entry.scores.difficulty, fairness: entry.scores.fairness,
        readability: entry.scores.readability, rankScore: +entry.rankScore.toFixed(4), issues: entry.issues,
      });
      if (entry.strict) {
        strictValid.push(entry);
        if (!bestStrict || cmpEntry(entry, bestStrict) < 0) bestStrict = entry;
        if (strictValid.length >= 8 && bestStrict.scores.difficulty >= T.targetDifficulty) break;
      } else if (!bestFallback || cmpEntry(entry, bestFallback) < 0) {
        bestFallback = entry;
      }
    }

    // If strict skyline candidates all failed uniqueness, also check top 4 fallback proposals for bestFallback.
    if (!bestStrict && exactStrict.length && !bestFallback && exactFallback.length) {
      for (const cand of exactFallback.slice(0, 4)) {
        const entry = evalCandidate(cand);
        if (!bestFallback || cmpEntry(entry, bestFallback) < 0) bestFallback = entry;
      }
    }

    if (exactStrict.length === 0 && (!exactFallback.length || exactFallback[0].sky.distinctPeaks === 0)) zeroPeakTerrains++;

    // Stop early as soon as we have a strict phone-fair candidate meeting the D8+ difficulty target;
    // otherwise try at most 1 extra terrain when upgrading difficulty, or up to attemptCap when seeking strict fairness
    // (stopping after 2 completely flat zero-peak terrains so repetitive dune fields stay fast).
    if (bestStrict && (bestStrict.scores.difficulty >= T.targetDifficulty || attempt >= 1)) break;
    if (!bestStrict && zeroPeakTerrains >= 2 && bestFallback) break;
  }

  const chosen = bestStrict || bestFallback;
  if (!chosen) throw new Error('No unambiguous grid question found. Try a new seed or a lower difficulty.');

  const isFallback = !bestStrict;
  const e = chosen;
  const { model, interval, terrainCheck, fov, eyeHeight, sky } = e;
  const options = e.options.map((o) => ({ ...o, z: model.getElevation(o.x, o.y), landform: model.analyzer.classify(o.x, o.y) }));
  const ok = !isFallback || e.basicValid;
  const lowConfidence = isFallback && (!e.basicValid || !sky.passesSkyline);
  const reportedHardness = lowConfidence ? Math.min(e.scores.difficulty, 0.3) : e.scores.difficulty;
  const reportedConfidence = lowConfidence ? Math.min(e.scores.fairness, 0.4) : e.scores.fairness;

  const quiz = {
    version: 1,
    gen: 2,
    mode: 'grid',
    seed,
    difficulty,
    variant,
    lowConfidence,
    grid: { size: divisions, challenge, origin: 'cell-centre', cellMetres: model.size / divisions },
    terrain: terrainSummary(model, interval, terrainCheck),
    camera: {
      x: e.origin.x,
      y: e.origin.y,
      z: model.getElevation(e.origin.x, e.origin.y) + eyeHeight,
      heading: e.heading,
      eyeHeight,
      fov,
      pitch: framingPitch(Array.from(e.correct.horizon)),
      roll: 0,
    },
    heading: watch ? { degrees: e.heading, text: '', arrow: '', mode: 'hidden' }
      : { degrees: e.heading, ...formatHeading(e.heading, heading), mode: heading },
    mapRotation: 0, // gen=2 is designed and calibrated for north-up maps
    options,
    correctLabel: e.origin.label,
    closestLabel: e.closest.label,
    quality: {
      total: e.vpQuality.total,
      ...e.vpQuality.components,
      blockedFrac: e.correct.blockedFrac,
      edgeFrac: e.correct.edgeFrac,
      landmarksInView: e.vpQuality.landmarksInView,
    },
    gen2: {
      version: 2,
      mode: 'grid',
      strict: !isFallback,
      fallback: isFallback,
      cutLeft: sky.cutLeft,
      cutRight: sky.cutRight,
      edgeCut: sky.edgeCut,
      edgeWall: sky.edgeWall,
      maxAngle: sky.maxAngle,
      relief: sky.relief,
      distinctPeaks: sky.distinctPeaks,
      primaryProm: sky.primaryProm,
      secondaryProm: sky.secondaryProm,
      primaryLocalProm: sky.primaryLocalProm,
      secondaryLocalProm: sky.secondaryLocalProm,
      peakSep: sky.peakSep,
      saddleDrop: sky.saddleDrop,
      minEdgeDist: sky.minEdgeDist,
      minHorizonRMS: +e.minHorizonRMS.toFixed(2),
      minInteriorCue: +e.minInteriorCue.toFixed(2),
      uniquenessMargin: +e.minFeatureMargin.toFixed(2),
      minAdjacentShift: +e.minAdjacentShift.toFixed(1),
      ambiguousCells: e.ambiguousCells,
      mapSummits: e.reasoning.mapSummits,
      decoyPairs: e.reasoning.decoyPairs,
      decoySameOrder: e.reasoning.decoySameOrder,
      singlePeakCells: e.reasoning.singlePeakCells,
      borderDist: e.scores.borderDist,
      difficulty: e.scores.difficulty,
      fairness: e.scores.fairness,
      readability: e.scores.readability,
      estimatedDifficulty: e.scores.estimatedDifficulty,
      estimatedFairness: e.scores.estimatedFairness,
      estimatedReadability: e.scores.estimatedReadability,
      rankScore: +e.rankScore.toFixed(4),
      peaks: sky.peaks.map(({ d, az, a, dist, prom, localProm, sharpness, edgeDist, summit }) => ({
        d, az, a, dist, prom, localProm, sharpness, edgeDist,
        summit: summit ? { cell: summit.cell, kind: summit.kind, prominence: summit.prominence } : null,
      })),
    },
    validation: {
      ok,
      issues: isFallback ? e.issues : [],
      confidence: reportedConfidence,
      uniqueness: e.uniqueness,
      minDistance: e.closest.D,
      minRequiredDistance: minD,
      weakestCue: +e.weakestCue.toFixed(2),
      lookalikes: e.near.length,
      remoteLookalikes: e.remote,
      faintCue: !!(base.search && e.weakestCue < base.search.cue),
    },
    hardness: reportedHardness,
    landmarks: landmarkSummary(model),
    stats: {
      viewpointsEvaluated: totalEvaluated,
      cellsChecked: divisions * divisions,
      directionsChecked: hidden ? 8 : 1,
      questionsCompared: log.filter((l) => l.stage === 'gen2').length,
      terrainAttempt: e.attempt,
      ms: Math.round(now() - t0),
    },
    log,
  };
  if (watch) quiz.sunWatch = createSunWatch(quiz, model, { latitude: base.sunWatchLatitude });
  return withAnswerExplanation(quiz, model);
}
