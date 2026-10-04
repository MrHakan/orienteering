// Grid references are fixed to the terrain: A is the north row, 1 the west
// column. A display rotation never changes a cell's identity.
import { SeedManager } from './rng.js';
import { getDifficulty, applyTuning } from './difficulty.js';
import { formatHeading } from './heading.js';
import { ViewpointGenerator } from './viewpoints.js';
import { descriptorDistance } from './skyline.js';
import { distinguishingCue } from './quizCandidates.js';
import { buildTerrain, terrainSummary, landmarkSummary, framingPitch, now } from './quiz.js';
import { saturate } from './grid.js';
import { createSunWatch } from './sunWatch.js';
import { withAnswerExplanation } from './answerExplanation.js';

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

/** Every possible origin is a cell centre, so all answers can be checked.
 * Lost compass checks other cells in all eight directions, not only the
 * true heading. No unvalidated fallback question is returned.
 */
export function generateGridQuiz({ seed, difficulty = 'medium', variant = 0, headingMode = null,
  gridSize = 4, gridChallenge = 'standard', tuning = null, size, n, maxTerrainAttempts = 4, onProgress = () => {} }) {
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
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n });
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
    const valid = [];
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
      const closest = options.filter((o) => !o.correct).reduce((a, b) => b.D < a.D ? b : a);
      const issues = [];
      if (closest.D < minD) issues.push(`cell ${closest.label} looks too similar (${closest.D.toFixed(2)}°)`);
      const uniqueness = saturate(closest.D / (minD * 2));
      const confidence = saturate(0.6 * uniqueness + 0.4 * vp.quality.total);
      if (confidence < base.minConfidence) issues.push('insufficient confidence');
      log.push({ attempt, stage: 'question', try: t, ok: !issues.length, confidence: +confidence.toFixed(3), issues });
      if (issues.length) continue;
      const hardness = saturate(Math.exp(-(closest.D - minD) / 1.2));
      valid.push({ vp, correct, options, closest, confidence, uniqueness, hardness });
      if (!base.search) break;
    }
    if (!valid.length) continue;
    valid.sort((a, b) => b.hardness - a.hardness);
    const e = rng.fork('choice').pick(valid.slice(0, base.search?.shortlist || 1));
    const options = e.options.map((o) => ({ ...o, z: model.getElevation(o.x, o.y), landform: model.analyzer.classify(o.x, o.y) }));
    const quiz = {
      version: 1, mode: 'grid', seed, difficulty, variant, lowConfidence: false,
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
      validation: { ok: true, issues: [], confidence: e.confidence, uniqueness: e.uniqueness, minDistance: e.closest.D, minRequiredDistance: minD },
      hardness: e.hardness, landmarks: landmarkSummary(model),
      stats: { viewpointsEvaluated: evaluated, cellsChecked: cells.length, directionsChecked: hidden ? 8 : 1,
        questionsCompared: valid.length, terrainAttempt: attempt, ms: Math.round(now() - t0) }, log,
    };
    if (watch) quiz.sunWatch = createSunWatch(quiz, model, { latitude: base.sunWatchLatitude });
    return withAnswerExplanation(quiz, model);
  }
  throw new Error('No unambiguous grid question found. Try a new seed or a lower difficulty.');
}
