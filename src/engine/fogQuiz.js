// Fog navigation: a whiteout leaves only the ground within ~60–110 m. You
// walk a few steps on a known heading and stop; which point are you at? The
// skyline is gone, so candidates are compared only on the near ground (the
// 40 m terrain probes of the view descriptor), with distractors close enough
// to need the slope and the nearby shapes.

import { now } from './quiz.js';
import { surfaceElevation } from './terrainSurface.js';
import { formatHeading } from './heading.js';
import { terrains, scaffold, bearingText } from './mapModes.js';

const BANDS = {
  easy: { visibility: 110, band: [3, 12] }, medium: { visibility: 90, band: [2.2, 7] }, hard: { visibility: 75, band: [1.6, 4.5] },
  expert: { visibility: 68, band: [1.3, 3.6] }, master: { visibility: 60, band: [1, 3] },
};
const EYE = 1.7, FOV = 60, COLUMNS = 33, WALK = 26;

const nearDescriptor = (model, p, heading) => model.skyline.viewDescriptor(p.x, p.y, heading, FOV, { eyeHeight: EYE, columns: COLUMNS }).near[0];
const nearDistance = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

export function generateFogQuiz(opts) {
  const difficulty = BANDS[opts.difficulty] ? opts.difficulty : 'medium', band = BANDS[difficulty], t0 = now();
  for (const built of terrains({ ...opts, difficulty }, 'fog')) {
    const { model, rng } = built, L = model.size;
    for (let tries = 0; tries < 120; tries++) {
      const p = { x: rng.range(0.15, 0.85) * L, y: rng.range(0.15, 0.85) * L }, heading = Math.round(rng.range(0, 360)) % 360;
      const slope = model.getSlope(p.x, p.y);
      if (slope < 4 || slope > 28) continue;
      const near = nearDescriptor(model, p, heading);
      const mean = near.reduce((s, v) => s + v, 0) / near.length, spread = Math.sqrt(near.reduce((s, v) => s + (v - mean) ** 2, 0) / near.length);
      if (spread < 0.6 && Math.abs(mean) < 2) continue; // a featureless flat would be guesswork
      const distractors = [];
      for (let k = 0; k < 160 && distractors.length < 2; k++) {
        const q = { x: rng.range(0.1, 0.9) * L, y: rng.range(0.1, 0.9) * L };
        if ([p, ...distractors].some((r) => Math.hypot(r.x - q.x, r.y - q.y) < 250)) continue;
        const D = nearDistance(near, nearDescriptor(model, q, heading));
        if (D >= band.band[0] && D <= band.band[1]) distractors.push({ ...q, D });
      }
      if (distractors.length < 2) continue;
      const options = rng.shuffle([{ ...p, D: 0, correct: true }, ...distractors]).map((q, i) => ({ label: 'ABC'[i], x: +q.x.toFixed(1), y: +q.y.toFixed(1),
        z: +surfaceElevation(model, q.x, q.y).toFixed(2), correct: !!q.correct, D: +q.D.toFixed(2), landform: model.analyzer.classify(q.x, q.y),
        slope: +model.getSlope(q.x, q.y).toFixed(1) }));
      const correct = options.find((o) => o.correct);
      const camera = { x: p.x, y: p.y, z: surfaceElevation(model, p.x, p.y) + EYE, eyeHeight: EYE, heading, fov: FOV, pitch: -4, roll: 0 };
      const quiz = scaffold({ ...built, mode: 'fog', seed: opts.seed, difficulty, variant: opts.variant || 0, camera, t0, extra: {
        fog: { visibility: band.visibility, walk: WALK },
        heading: { degrees: heading, ...formatHeading(heading, 'exact'), mode: 'exact' },
        options, correctLabel: correct.label, hardness: Math.min(1, 0.35 + (110 - band.visibility) / 80),
        map: { centre: p, revealYou: true },
      } });
      quiz.explanation = fogExplanation(quiz);
      return quiz;
    }
  }
  throw new Error('No clear fog question found for this seed. Try another seed.');
}

export function fogExplanation(quiz) {
  const correct = quiz.options.find((o) => o.correct);
  return { version: 1, language: 'en', source: 'near-terrain-analysis', kind: 'fog',
    correct: { label: correct.label, summary: `At ${correct.label} the ground within the fog matches what you saw walking ${bearingText(quiz.camera.heading)}.`,
      evidence: [{ type: 'near-ground', text: `${correct.label} is ${correct.landform.replace(/-/g, ' ')} ground sloping about ${correct.slope.toFixed(0)}°. With ${quiz.fog.visibility} m of visibility only the nearest slopes count; the skyline is hidden.`,
        data: { slopeDegrees: correct.slope, landform: correct.landform, visibilityMetres: quiz.fog.visibility } }] },
    closestLabels: quiz.options.filter((o) => !o.correct).sort((a, b) => a.D - b.D).map((o) => o.label),
    alternatives: quiz.options.filter((o) => !o.correct).map((o) => ({ label: o.label, difference: o.D, status: 'distinguished', plausibility: '',
      reasons: [{ type: 'near-mismatch', text: `${o.label} is ${o.landform.replace(/-/g, ' ')} ground sloping ${o.slope.toFixed(0)}°; facing ${bearingText(quiz.camera.heading)} its nearby ground sits ${o.D.toFixed(1)}° off from the view on average.`,
        data: { nearDifferenceDegrees: o.D, slopeDegrees: o.slope } }] })) };
}
