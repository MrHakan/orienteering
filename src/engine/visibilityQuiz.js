// Intervisibility: from YOU, exactly one of five 2 m flags is in sight; the
// others hide behind terrain. Pure contour reading — the scene only shows a
// drone overview. For each flag we compute the lowest height above its foot
// that the eye could see (one pass along the sightline): ≤ 0 means the whole
// flag shows, > 2 m means the flag is hidden, and how far beyond 2 m sets the
// difficulty.

import { now } from './quiz.js';
import { surfaceElevation } from './terrainSurface.js';
import { terrains, scaffold, bearingTo } from './mapModes.js';

const EYE = 1.7, FLAG = 2;
const BANDS = {
  easy: { visibleAt: 0, hiddenBy: 12 }, medium: { visibleAt: 0.5, hiddenBy: 6 }, hard: { visibleAt: 0.9, hiddenBy: 3.5 },
  expert: { visibleAt: 1.1, hiddenBy: 2.5 }, master: { visibleAt: 1.3, hiddenBy: 1.5 },
};

/** Lowest visible height above the target's ground, and where the sightline is most obstructed. */
export function sightline(model, eye, target) {
  const d = Math.hypot(target.x - eye.x, target.y - eye.y), steps = Math.ceil(d / 2), zT = surfaceElevation(model, target.x, target.y);
  let worst = -Infinity, at = null;
  for (let i = 1; i < steps - 1; i++) {
    const t = i / steps, x = eye.x + (target.x - eye.x) * t, y = eye.y + (target.y - eye.y) * t;
    const need = (surfaceElevation(model, x, y) - eye.z) / t; // height gain per full distance to clear this point
    if (need > worst) { worst = need; at = { x, y, distance: d * t }; }
  }
  return { distance: d, minHeight: worst + eye.z - zT + 0.04, block: at, z: zT };
}

export function generateVisibilityQuiz(opts) {
  const difficulty = BANDS[opts.difficulty] ? opts.difficulty : 'medium', band = BANDS[difficulty], t0 = now();
  for (const built of terrains({ ...opts, difficulty }, 'visibility')) {
    const { model, rng } = built, L = model.size;
    for (let tries = 0; tries < 160; tries++) {
      const o = { x: rng.range(0.2, 0.8) * L, y: rng.range(0.2, 0.8) * L };
      if (model.getSlope(o.x, o.y) > 25) continue;
      const eye = { ...o, z: surfaceElevation(model, o.x, o.y) + EYE };
      const candidates = [];
      for (let k = 0; k < 40; k++) {
        const a = rng.range(0, Math.PI * 2), r = rng.range(220, 900), p = { x: o.x + Math.sin(a) * r, y: o.y + Math.cos(a) * r };
        if (!model.inside(p.x, p.y, 60)) continue;
        const s = sightline(model, eye, p);
        const visible = s.minHeight <= band.visibleAt, hidden = s.minHeight >= FLAG + band.hiddenBy * 0.4 && s.minHeight <= FLAG + band.hiddenBy * 2.5;
        if (visible || hidden) candidates.push({ ...p, ...s, visible });
      }
      const seen = candidates.filter((c) => c.visible), unseen = candidates.filter((c) => !c.visible);
      if (!seen.length || unseen.length < 4) continue;
      const chosen = [rng.pick(seen)];
      for (const c of rng.shuffle(unseen)) {
        if (chosen.length === 5) break;
        // Spread around YOU so they cannot be judged as one group.
        if (chosen.every((q) => Math.hypot(q.x - c.x, q.y - c.y) > 160)) chosen.push(c);
      }
      if (chosen.length < 5) continue;
      const options = rng.shuffle(chosen).map((c, i) => ({ label: 'ABCDE'[i], x: +c.x.toFixed(1), y: +c.y.toFixed(1), z: +c.z.toFixed(2),
        correct: c.visible, visible: c.visible, distance: +c.distance.toFixed(1), bearing: +bearingTo(o, c).toFixed(1),
        minHeight: +c.minHeight.toFixed(2), blockDistance: c.visible ? null : +c.block.distance.toFixed(1), block: c.visible ? null : { x: +c.block.x.toFixed(1), y: +c.block.y.toFixed(1) } }));
      const correct = options.find((q) => q.correct);
      const camera = { x: o.x, y: o.y, z: eye.z, eyeHeight: EYE, heading: correct.bearing, fov: 52, pitch: 0, roll: 0 };
      const quiz = scaffold({ ...built, mode: 'visibility', seed: opts.seed, difficulty, variant: opts.variant || 0, camera, t0, extra: {
        options, correctLabel: correct.label,
        hardness: Math.min(1, 0.35 + (12 - band.hiddenBy) / 16),
        map: {
          centre: { x: o.x, y: o.y }, drone: { radius: 1100, height: 330 }, observer: { x: o.x, y: o.y },
          revealExtras: options.map((q) => q.visible
            ? { type: 'line', points: [o, q], color: '#5fd08a', width: 2 }
            : { type: 'line', points: [o, q.block, q], color: '#ff6b5e', width: 1.4, dash: [5, 4] }).concat(
            options.filter((q) => !q.visible).map((q) => ({ type: 'point', shape: 'dot', x: q.block.x, y: q.block.y, color: '#ff6b5e' }))),
        },
      } });
      quiz.explanation = visibilityExplanation(quiz);
      return quiz;
    }
  }
  throw new Error('No clear intervisibility question found for this seed. Try another seed.');
}

export function visibilityExplanation(quiz) {
  const correct = quiz.options.find((o) => o.correct);
  return { version: 1, language: 'en', source: 'sightline-analysis', kind: 'intervisibility',
    correct: { label: correct.label, summary: `${correct.label} is the only flag in sight from YOU.`,
      evidence: [{ type: 'clear-sightline', text: correct.minHeight <= 0
        ? `The ground never rises above the line from your eye (1.7 m) to the foot of ${correct.label}, ${Math.round(correct.distance)} m away: the whole flag shows.`
        : `From YOU the ground hides only the lowest ${correct.minHeight.toFixed(1)} m of ${correct.label}, ${Math.round(correct.distance)} m away; the top of the 2 m flag shows.`,
      data: { distanceMetres: correct.distance, lowestVisibleHeightMetres: correct.minHeight } }] },
    closestLabels: quiz.options.filter((o) => !o.correct).sort((a, b) => a.minHeight - b.minHeight).slice(0, 3).map((o) => o.label),
    alternatives: quiz.options.filter((o) => !o.correct).map((o) => ({ label: o.label, difference: +(o.minHeight - 2).toFixed(2), status: 'distinguished', plausibility: '',
      reasons: [{ type: 'hidden', text: `Ground ${Math.round(o.blockDistance)} m out along the line to ${o.label} rises above the sightline; a flag there would need to be ${o.minHeight.toFixed(1)} m tall to show.`,
        data: { blockDistanceMetres: o.blockDistance, neededHeightMetres: o.minHeight } }] })) };
}
