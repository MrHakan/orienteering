// "Which way are you facing?" mode: the observer position is marked on the
// map, the heading is hidden, and the player picks one of the 8 compass
// directions. A position qualifies only if the true view can be told apart
// from the view in each of the other 7 directions.

import { SeedManager } from './rng.js';
import { ViewpointGenerator } from './viewpoints.js';
import { QuizValidator } from './validator.js';
import { getDifficulty, applyTuning } from './difficulty.js';
import { descriptorDistance } from './skyline.js';
import { distinguishingCue, VIEW_COLUMNS } from './quizCandidates.js';
import { buildTerrain, now, landmarkSummary, terrainSummary, framingPitch } from './quiz.js';
import { saturate } from './grid.js';

export const DIRECTIONS = [
  { label: 'N', heading: 0 }, { label: 'NE', heading: 45 }, { label: 'E', heading: 90 }, { label: 'SE', heading: 135 },
  { label: 'S', heading: 180 }, { label: 'SW', heading: 225 }, { label: 'W', heading: 270 }, { label: 'NW', heading: 315 },
];

/**
 * @param {{seed:string, difficulty?:string, variant?:number, maxTerrainAttempts?:number, onProgress?:(msg:string)=>void}} opts
 */
export function generateFacingQuiz({ seed, difficulty = 'medium', variant = 0, tuning = null, size, n, maxTerrainAttempts = 4, onProgress = () => {} }) {
  const t0 = now();
  const base = applyTuning(getDifficulty(difficulty), tuning);
  const preset = { ...base, heading: 'intercardinal' };
  const rule = base.facing;
  const seeds = new SeedManager(`${seed}#${difficulty}`);
  const vt = ['facing', ...(variant ? [`v${variant}`] : [])];
  const log = [];
  let best = null;

  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n });
    if (!terrainCheck.ok) { log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues }); continue; }

    onProgress('Scoring viewpoints in all 8 directions');
    const vrng = seeds.stream('view', attempt, ...vt);
    const fov = Math.round(vrng.range(preset.fov[0], preset.fov[1]));
    const eyeHeight = Math.round(vrng.range(1.6, 1.85) * 100) / 100;
    const vg = new ViewpointGenerator(model, preset, vrng.fork('viewpoints'), { fov, eyeHeight, maxPicks: base.search ? 40 : 24 });
    const { picked, evaluated } = vg.generate();

    const rose = new Map(); // point -> 8 view descriptors
    const describeAll = (x, y) => {
      const key = `${x},${y}`;
      if (!rose.has(key)) rose.set(key, DIRECTIONS.map((d) => model.skyline.viewDescriptor(x, y, d.heading, fov, { eyeHeight, columns: VIEW_COLUMNS })));
      return rose.get(key);
    };

    const valid = [];
    for (const [t, vp] of picked.entries()) {
      const descs = describeAll(vp.x, vp.y);
      const ci = DIRECTIONS.findIndex((d) => d.heading === vp.heading);
      const correct = descs[ci];
      const others = DIRECTIONS.map((d, i) => (i === ci ? null : { ...d, D: descriptorDistance(correct, descs[i]), cue: distinguishingCue(correct, descs[i]) })).filter(Boolean);
      const closest = others.reduce((a, b) => (b.D < a.D ? b : a));
      const issues = [];
      if (vp.quality.total < preset.minQuality) issues.push(`view quality ${vp.quality.total.toFixed(2)} below ${preset.minQuality}`);
      if (correct.blockedFrac > 0.45) issues.push('terrain blocks most of the view');
      if (correct.edgeFrac > 0.4) issues.push('view relies on terrain outside the map');
      if (closest.D < rule.minD) issues.push(`${closest.label} looks too similar (${closest.D.toFixed(2)}° < ${rule.minD}°)`);
      if (base.search && closest.cue.magnitude < base.search.cue) issues.push('no visible feature separates the closest direction');
      const uniqueness = saturate((closest.D - 0.6 * rule.minD) / (0.8 * rule.minD));
      const confidence = saturate(0.5 * uniqueness + 0.4 * vp.quality.total / 0.8 + 0.1 * (1 - correct.blockedFrac));
      // Hardness: how close the most similar wrong direction comes, and how many look alike.
      const alike = others.filter((o) => o.D < rule.minD * 2).length / others.length;
      const hardness = issues.length ? 0 : saturate(0.7 * Math.exp(-(closest.D - rule.minD) / 0.8) + 0.3 * alike);
      const entry = { attempt, try: t, model, interval, terrainCheck, vp, fov, eyeHeight, correct, others, closest, evaluated, hardness, validation: { ok: issues.length === 0, issues, uniqueness, confidence, minDistance: closest.D } };
      log.push({ attempt, stage: 'question', try: t, ok: entry.validation.ok, confidence: +confidence.toFixed(3), hardness: +hardness.toFixed(3), issues });
      if (!best || (entry.validation.ok ? 10 : 0) + confidence > (best.validation.ok ? 10 : 0) + best.validation.confidence) best = entry;
      if (entry.validation.ok) {
        valid.push(entry);
        // First valid view in weighted-random order that is hard enough.
        if (!base.search && !(closest.D > (rule.maxD ?? Infinity))) break;
      }
    }
    if (valid.length) {
      let chosen = valid.find((v) => !(v.closest.D > (rule.maxD ?? Infinity))) || valid.reduce((a, b) => (b.closest.D < a.closest.D ? b : a));
      if (base.search) {
        valid.sort((a, b) => b.hardness - a.hardness);
        const shortlist = valid.slice(0, base.search.shortlist);
        chosen = seeds.stream('shortlist', attempt, ...vt).weighted(shortlist, (e) => e.hardness ** 2 + 1e-6) || shortlist[0];
      }
      return assembleFacing(chosen, { seed, difficulty, variant, base, seeds, vt, log, t0, compared: valid.length });
    }
  }
  if (!best) throw new Error(`Could not generate a valid terrain for seed "${seed}"`);
  return assembleFacing(best, { seed, difficulty, variant, base, seeds, vt, log, t0, lowConfidence: true });
}

function assembleFacing(e, { seed, difficulty, variant, base, seeds, vt, log, t0, lowConfidence = false, compared = 0 }) {
  const { model, vp, fov, eyeHeight, correct, others, closest } = e;
  const rng = seeds.stream('labels', e.attempt, e.try, ...vt);
  const byLabel = new Map(others.map((o) => [o.label, o]));
  const options = DIRECTIONS.map((d) => {
    const o = byLabel.get(d.label);
    return o ? { ...d, correct: false, D: +o.D.toFixed(3), cue: { bearing: o.cue.bearing, delta: +o.cue.delta.toFixed(2) } } : { ...d, correct: true, D: 0 };
  });
  const correctLabel = options.find((o) => o.correct).label;
  const z = model.getElevation(vp.x, vp.y);
  const quiz = {
    version: 1,
    mode: 'facing',
    seed, difficulty, variant,
    lowConfidence,
    terrain: terrainSummary(model, e.interval, e.terrainCheck),
    camera: { x: vp.x, y: vp.y, eyeHeight, z: z + eyeHeight, heading: vp.heading, fov, pitch: framingPitch(Array.from(correct.horizon)), roll: 0 },
    heading: { degrees: vp.heading, text: 'WHICH WAY ARE YOU FACING?', arrow: '', mode: 'hidden' },
    point: { x: vp.x, y: vp.y, z, landform: model.analyzer.classify(vp.x, vp.y) },
    mapRotation: base.mapRotation ? rng.fork('rotation').pick([0, 90, 180, 270]) : 0,
    options,
    correctLabel,
    closestLabel: closest.label,
    quality: { total: vp.quality.total, ...vp.quality.components, blockedFrac: vp.quality.blockedFrac, edgeFrac: vp.quality.edgeFrac, landmarksInView: vp.quality.landmarksInView },
    validation: e.validation,
    hardness: e.hardness,
    landmarks: landmarkSummary(model),
    stats: { viewpointsEvaluated: e.evaluated, terrainAttempt: e.attempt, viewTry: e.try, questionsCompared: compared, ms: Math.round(now() - t0) },
    log,
  };
  return quiz;
}

// Re-exported for callers that only import this module.
export { QuizValidator };
