// Quiz orchestration: seed -> terrain -> viewpoint -> distractors -> validation.
// Deterministic for a given (seed, difficulty).

import { SeedManager } from './rng.js';
import { TerrainGenerator, DEFAULT_SIZE, DEFAULT_RES } from './terrainGenerator.js';
import { TerrainModel } from './terrainModel.js';
import { ViewpointGenerator } from './viewpoints.js';
import { QuizCandidateGenerator } from './quizCandidates.js';
import { QuizValidator } from './validator.js';
import { getDifficulty, applyTuning } from './difficulty.js';
import { formatHeading } from './heading.js';
import { clamp } from './grid.js';

export const LABELS = ['A', 'B', 'C', 'D', 'E'];

export const HEADING_MODES = ['cardinal', 'intercardinal', 'exact'];

/**
 * Terrain for (seed, difficulty, attempt). Shared by every quiz mode, so one
 * seed gives the same landscape in "Where are you?" and "Which way?".
 */
export function buildTerrain({ seed, difficulty, attempt, preset, seeds, size = DEFAULT_SIZE, n = DEFAULT_RES }) {
  const terrain = TerrainGenerator.generate(seeds.stream('terrain', attempt), preset.terrain, { size, n });
  const model = new TerrainModel({ ...terrain, seed: `${seed}#${difficulty}#${attempt}` });
  const interval = model.chooseContourInterval();
  const terrainCheck = QuizValidator.validateTerrain(model, model.getContours(interval));
  return { model, interval, terrainCheck };
}

/** Dispatch on quiz mode; existing location quizzes retain their defaults. */
export async function generate(opts) {
  if (opts.mode === 'friend') {
    const { generateFriendQuiz } = await import('./friendQuiz.js');
    return generateFriendQuiz(opts);
  }
  if (opts.mode === 'grid') {
    const { generateGridQuiz } = await import('./gridQuiz.js');
    return generateGridQuiz(opts);
  }
  if (opts.mode === 'lookalike') {
    const { generateLookalikeQuiz } = await import('./lookalikeQuiz.js');
    return generateLookalikeQuiz(opts);
  }
  if (opts.mode === 'facing') {
    const { generateFacingQuiz } = await import('./facingQuiz.js');
    return generateFacingQuiz(opts);
  }
  return generateQuiz(opts);
}

/**
 * @param {{seed:string, difficulty?:string, variant?:number, headingMode?:string, size?:number, n?:number, maxTerrainAttempts?:number, onProgress?:(msg:string)=>void}} opts
 * `variant` keeps the terrain of (seed, difficulty) but draws a new observer
 * position, heading and distractors. Variant 0 is the original question.
 * `headingMode` overrides the difficulty's heading style
 * ('cardinal' | 'intercardinal' | 'exact'). `tuning` holds developer-mode
 * overrides (see TUNABLES in difficulty.js).
 */
export function generateQuiz({ seed, difficulty = 'medium', variant = 0, headingMode = null, tuning = null, size = DEFAULT_SIZE, n = DEFAULT_RES, maxTerrainAttempts = 4, maxViewTries = 8, onProgress = () => {} }) {
  const t0 = now();
  const base = applyTuning(getDifficulty(difficulty), tuning);
  const override = HEADING_MODES.includes(headingMode) && headingMode !== base.heading ? headingMode : null;
  const preset = override ? { ...base, heading: override } : base;
  const seeds = new SeedManager(`${seed}#${difficulty}`);
  // Streams that decide positions get the variant (and heading style) tag;
  // terrain streams do not.
  const vt = [...(variant ? [`v${variant}`] : []), ...(override ? [`h-${override}`] : [])];
  const log = [];
  let best = null;

  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n });
    if (!terrainCheck.ok) {
      log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues });
      continue;
    }

    onProgress('Analysing landforms and viewpoints');
    const vrng = seeds.stream('view', attempt, ...vt);
    const fov = Math.round(vrng.range(preset.fov[0], preset.fov[1]));
    const eyeHeight = Math.round(vrng.range(1.6, 1.85) * 100) / 100;
    const search = preset.search;
    const vg = new ViewpointGenerator(model, preset, vrng.fork('viewpoints'), { fov, eyeHeight, maxPicks: search ? search.viewTries : 16 });
    const { picked, evaluated } = vg.generate();

    onProgress(search ? `Searching ${picked.length} viewpoints for the most devious question` : 'Choosing distractors');
    const cg = new QuizCandidateGenerator(model, preset, seeds.stream('distractors', attempt, ...vt));
    if (search) {
      const valid = [];
      for (const [t, vp] of picked.entries()) {
        const view = { x: vp.x, y: vp.y, heading: vp.heading, fov, eyeHeight };
        const candidates = cg.generate(view);
        const validation = QuizValidator.validateQuestion({ view, quality: vp.quality, candidates }, preset);
        const entry = { attempt, try: t, model, interval, terrainCheck, view, quality: vp.quality, candidates, validation, evaluated };
        entry.hardness = validation.ok ? puzzleHardness(entry, preset) : 0;
        log.push({ attempt, stage: 'question', try: t, ok: validation.ok, confidence: +validation.confidence.toFixed(3), hardness: +entry.hardness.toFixed(3), issues: validation.issues });
        if (!best || rank(entry) > rank(best)) best = entry;
        if (validation.ok) valid.push(entry);
        if (t % 4 === 3) onProgress(`Searching viewpoints (${t + 1}/${picked.length}, ${valid.length} valid)`);
      }
      if (valid.length) {
        valid.sort((a, b) => b.hardness - a.hardness);
        const shortlist = valid.slice(0, search.shortlist);
        const chosen = seeds.stream('shortlist', attempt, ...vt).weighted(shortlist, (e) => e.hardness ** 2) || shortlist[0];
        return assemble(chosen, { seed, difficulty, variant, preset, seeds, vt, log, t0, searched: valid.length });
      }
      continue;
    }
    for (const [t, vp] of picked.slice(0, maxViewTries).entries()) {
      const view = { x: vp.x, y: vp.y, heading: vp.heading, fov, eyeHeight };
      const candidates = cg.generate(view);
      const validation = QuizValidator.validateQuestion({ view, quality: vp.quality, candidates }, preset);
      const entry = { attempt, try: t, model, interval, terrainCheck, view, quality: vp.quality, candidates, validation, evaluated };
      log.push({ attempt, stage: 'question', try: t, ok: validation.ok, confidence: +validation.confidence.toFixed(3), issues: validation.issues });
      if (!best || rank(entry) > rank(best)) best = entry;
      if (validation.ok) return assemble(entry, { seed, difficulty, variant, preset, seeds, vt, log, t0 });
    }
  }
  if (!best) throw new Error(`Could not generate a valid terrain for seed "${seed}"`);
  return assemble(best, { seed, difficulty, variant, preset, seeds, vt, log, t0, lowConfidence: true });
}

/**
 * How hard a valid question is to solve (0..1): distractor views close to the
 * ambiguity limit, similar terrain signatures and landform types, similar
 * elevations, and options spread over the map so that "the one in the middle"
 * gives nothing away.
 */
export function puzzleHardness(e, preset) {
  const { distractors, correct } = e.candidates;
  if (!distractors.length) return 0;
  const band = preset.band;
  const mean = (f) => distractors.reduce((a, d) => a + f(d), 0) / distractors.length;
  const closeness = mean((d) => Math.exp(-(d.D - band.min) / 0.6));
  const similarity = mean((d) => Math.exp(-1.6 * d.sigDist));
  const sameLandform = mean((d) => (d.signature.landform === correct.signature.landform ? 1 : 0));
  const relief = Math.max(20, e.model.max - e.model.min);
  const elevation = mean((d) => Math.exp(-Math.abs(d.signature.elevation - correct.signature.elevation) / (0.12 * relief)));
  const pts = [correct, ...distractors];
  let minPair = Infinity;
  for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) minPair = Math.min(minPair, Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y));
  const spread = Math.min(1, minPair / 650);
  return 0.4 * closeness + 0.2 * similarity + 0.1 * sameLandform + 0.15 * elevation + 0.15 * spread;
}

const rank = (e) => (e.validation.ok ? 10 : 0) + e.validation.confidence + 0.2 * e.candidates.distractors.length;
export const now = () => (globalThis.performance ? performance.now() : Date.now());

/** Plain-data landform summary (for overlays), shared by all modes. */
export function landmarkSummary(model) {
  const a = model.analyzer;
  return {
    summits: a.summits.map(({ x, y, z, prominence, kind }) => ({ x, y, z, prominence, kind })),
    saddles: a.saddles.map(({ x, y, z }) => ({ x, y, z })),
    depressions: a.depressions.map(({ x, y, z, depth }) => ({ x, y, z, depth })),
  };
}

/** Terrain block of a quiz object, shared by all modes. */
export function terrainSummary(model, interval, terrainCheck) {
  return {
    size: model.size, n: model.n, heights: model.heights,
    modelSeed: model.seed,
    min: model.min, max: model.max,
    archetypes: model.meta.archetypes,
    noiseShare: model.meta.noiseShare,
    contourInterval: interval,
    check: terrainCheck,
  };
}

/** Pitch that frames the horizon slightly above centre. */
export function framingPitch(horizon) {
  const mean = horizon.reduce((a, b) => a + b, 0) / horizon.length;
  return +clamp(mean * 0.6 - 1.5, -4, 6).toFixed(2);
}

export function assemble(e, { seed, difficulty, variant = 0, preset, seeds, vt = [], log, t0, lowConfidence = false, searched = 0, mode = 'where-am-i' }) {
  const { model, view, quality, candidates, validation } = e;
  const rng = seeds.stream('labels', e.attempt, e.try, ...vt);
  const points = [
    { x: view.x, y: view.y, correct: true, D: 0, landform: candidates.correct.signature.landform },
    ...candidates.distractors.map((d) => ({ x: d.x, y: d.y, correct: false, D: +d.D.toFixed(3), sigDist: +d.sigDist.toFixed(3), landform: d.signature.landform, cue: { bearing: d.cue.bearing, delta: +d.cue.delta.toFixed(2) } })),
  ];
  const options = rng.shuffle(points).map((p, i) => ({ label: LABELS[i], ...p, z: model.getElevation(p.x, p.y) }));
  const correctLabel = options.find((o) => o.correct).label;

  const pitch = framingPitch(Array.from(candidates.correct.desc.horizon));
  const headingLabel = formatHeading(view.heading, preset.heading);
  const mapRotation = preset.mapRotation ? rng.fork('rotation').pick([0, 90, 180, 270]) : 0;

  return {
    version: 1,
    mode,
    seed, difficulty, variant,
    headingMode: preset.heading,
    lowConfidence,
    terrain: terrainSummary(model, e.interval, e.terrainCheck),
    camera: {
      x: view.x, y: view.y, eyeHeight: view.eyeHeight, z: model.getElevation(view.x, view.y) + view.eyeHeight,
      heading: view.heading, fov: view.fov, pitch, roll: 0,
    },
    heading: { degrees: view.heading, ...headingLabel, mode: preset.heading },
    mapRotation,
    options,
    correctLabel,
    quality: { total: quality.total, ...quality.components, blockedFrac: quality.blockedFrac, edgeFrac: quality.edgeFrac, landmarksInView: quality.landmarksInView },
    validation,
    hardness: e.hardness ?? puzzleHardness(e, preset),
    landmarks: landmarkSummary(model),
    stats: {
      viewpointsEvaluated: e.evaluated,
      distractorCandidates: candidates.considered,
      inBand: candidates.inBand,
      terrainAttempt: e.attempt,
      viewTry: e.try,
      questionsCompared: searched,
      ms: Math.round(now() - t0),
    },
    log,
  };
}
