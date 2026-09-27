// Quiz orchestration: seed -> terrain -> viewpoint -> distractors -> validation.
// Deterministic for a given (seed, difficulty).

import { SeedManager } from './rng.js';
import { TerrainGenerator, DEFAULT_SIZE, DEFAULT_RES } from './terrainGenerator.js';
import { TerrainModel } from './terrainModel.js';
import { ViewpointGenerator } from './viewpoints.js';
import { QuizCandidateGenerator } from './quizCandidates.js';
import { QuizValidator } from './validator.js';
import { getDifficulty } from './difficulty.js';
import { formatHeading } from './heading.js';
import { clamp } from './grid.js';

export const LABELS = ['A', 'B', 'C', 'D', 'E'];

/**
 * @param {{seed:string, difficulty?:string, size?:number, n?:number, maxTerrainAttempts?:number, onProgress?:(msg:string)=>void}} opts
 */
export function generateQuiz({ seed, difficulty = 'medium', size = DEFAULT_SIZE, n = DEFAULT_RES, maxTerrainAttempts = 4, maxViewTries = 8, onProgress = () => {} }) {
  const t0 = now();
  const preset = getDifficulty(difficulty);
  const seeds = new SeedManager(`${seed}#${difficulty}`);
  const log = [];
  let best = null;

  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating terrain (attempt ${attempt + 1})`);
    const terrain = TerrainGenerator.generate(seeds.stream('terrain', attempt), preset.terrain, { size, n });
    const model = new TerrainModel({ ...terrain, seed: `${seed}#${difficulty}#${attempt}` });
    const interval = model.chooseContourInterval();
    const terrainCheck = QuizValidator.validateTerrain(model, model.getContours(interval));
    if (!terrainCheck.ok) {
      log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues });
      continue;
    }

    onProgress('Analysing landforms and viewpoints');
    const vrng = seeds.stream('view', attempt);
    const fov = Math.round(vrng.range(preset.fov[0], preset.fov[1]));
    const eyeHeight = Math.round(vrng.range(1.6, 1.85) * 100) / 100;
    const vg = new ViewpointGenerator(model, preset, vrng.fork('viewpoints'), { fov, eyeHeight });
    const { picked, evaluated } = vg.generate();

    onProgress('Choosing distractors');
    const cg = new QuizCandidateGenerator(model, preset, seeds.stream('distractors', attempt));
    for (const [t, vp] of picked.slice(0, maxViewTries).entries()) {
      const view = { x: vp.x, y: vp.y, heading: vp.heading, fov, eyeHeight };
      const candidates = cg.generate(view);
      const validation = QuizValidator.validateQuestion({ view, quality: vp.quality, candidates }, preset);
      const entry = { attempt, try: t, model, interval, terrainCheck, view, quality: vp.quality, candidates, validation, evaluated };
      log.push({ attempt, stage: 'question', try: t, ok: validation.ok, confidence: +validation.confidence.toFixed(3), issues: validation.issues });
      if (!best || rank(entry) > rank(best)) best = entry;
      if (validation.ok) return assemble(entry, { seed, difficulty, preset, seeds, log, t0 });
    }
  }
  if (!best) throw new Error(`Could not generate a valid terrain for seed "${seed}"`);
  return assemble(best, { seed, difficulty, preset, seeds, log, t0, lowConfidence: true });
}

const rank = (e) => (e.validation.ok ? 10 : 0) + e.validation.confidence + 0.2 * e.candidates.distractors.length;
const now = () => (globalThis.performance ? performance.now() : Date.now());

function assemble(e, { seed, difficulty, preset, seeds, log, t0, lowConfidence = false }) {
  const { model, view, quality, candidates, validation } = e;
  const rng = seeds.stream('labels', e.attempt, e.try);
  const points = [
    { x: view.x, y: view.y, correct: true, D: 0, landform: candidates.correct.signature.landform },
    ...candidates.distractors.map((d) => ({ x: d.x, y: d.y, correct: false, D: +d.D.toFixed(3), sigDist: +d.sigDist.toFixed(3), landform: d.signature.landform })),
  ];
  const options = rng.shuffle(points).map((p, i) => ({ label: LABELS[i], ...p, z: model.getElevation(p.x, p.y) }));
  const correctLabel = options.find((o) => o.correct).label;

  const horizon = Array.from(candidates.correct.desc.horizon);
  const meanHorizon = horizon.reduce((a, b) => a + b, 0) / horizon.length;
  const pitch = +clamp(meanHorizon * 0.6 - 1.5, -4, 6).toFixed(2);
  const a = model.analyzer;
  const headingLabel = formatHeading(view.heading, preset.heading);
  const mapRotation = preset.mapRotation ? rng.fork('rotation').pick([0, 90, 180, 270]) : 0;

  return {
    version: 1,
    mode: 'where-am-i',
    seed, difficulty,
    lowConfidence,
    terrain: {
      size: model.size, n: model.n, heights: model.heights,
      modelSeed: model.seed,
      min: model.min, max: model.max,
      archetypes: model.meta.archetypes,
      noiseShare: model.meta.noiseShare,
      contourInterval: e.interval,
      check: e.terrainCheck,
    },
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
    landmarks: {
      summits: a.summits.map(({ x, y, z, prominence, kind }) => ({ x, y, z, prominence, kind })),
      saddles: a.saddles.map(({ x, y, z }) => ({ x, y, z })),
      depressions: a.depressions.map(({ x, y, z, depth }) => ({ x, y, z, depth })),
    },
    stats: {
      viewpointsEvaluated: e.evaluated,
      distractorCandidates: candidates.considered,
      inBand: candidates.inBand,
      terrainAttempt: e.attempt,
      viewTry: e.try,
      ms: Math.round(now() - t0),
    },
    log,
  };
}
