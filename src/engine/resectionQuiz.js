// Resection: compass bearings to two or three visible peaks fix your
// position. The peaks are marked on the map; you choose where you stand.
// One distractor usually lies exactly on one bearing line (the classic trap
// of trusting a single bearing) but contradicts the other.

import { now } from './quiz.js';
import { surfaceElevation } from './terrainSurface.js';
import { DEG, angleDiff, wrap360 } from './grid.js';
import { terrains, scaffold, bearingTo, bearingText, panCamera, CLIP_DURATION } from './mapModes.js';

const BANDS = {
  easy: { peaks: 3, minError: 10, maxError: 90, round: 1 },
  medium: { peaks: 3, minError: 6, maxError: 40, round: 1 },
  hard: { peaks: 2, minError: 6, maxError: 25, round: 1 },
  expert: { peaks: 2, minError: 5, maxError: 20, round: 1 },
  master: { peaks: 2, minError: 6, maxError: 20, round: 5 },
};
const EYE = 1.7, PEAK_LIFT = 2;

/** Coarse line of sight (half-cell steps) — fast enough to scan many observer/peak pairs. */
function sees(model, a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.ceil(d / (model.cell / 2));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (model.getElevation(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) > a.z + (b.z - a.z) * t - 0.5) return false;
  }
  return true;
}

export function generateResectionQuiz(opts) {
  const difficulty = BANDS[opts.difficulty] ? opts.difficulty : 'medium', band = BANDS[difficulty], t0 = now();
  for (const built of terrains({ ...opts, difficulty }, 'resection')) {
    const { model, rng } = built, L = model.size;
    const peaks = model.analyzer.summits
      .filter((s) => model.inside(s.x, s.y, 60) && (s.kind === 'summit' || s.prominence >= 10))
      .map((s) => ({ x: s.x, y: s.y, z: surfaceElevation(model, s.x, s.y) + PEAK_LIFT, prominence: s.prominence || 0 }))
      .sort((a, b) => b.prominence - a.prominence).slice(0, 14);
    if (peaks.length < band.peaks) continue;
    for (let tries = 0; tries < 220; tries++) {
      const o = { x: rng.range(0.12, 0.88) * L, y: rng.range(0.12, 0.88) * L };
      if (model.getSlope(o.x, o.y) > 22) continue;
      const eye = { ...o, z: surfaceElevation(model, o.x, o.y) + EYE };
      const visible = peaks.filter((p) => { const d = Math.hypot(p.x - o.x, p.y - o.y); return d > 250 && d < 1600 && sees(model, eye, p); });
      if (visible.length < band.peaks) continue;
      // Well-conditioned geometry: bearings neither nearly parallel nor opposite.
      const chosen = [];
      for (const p of rng.shuffle(visible)) {
        const b = bearingTo(o, p);
        if (chosen.every((q) => { const sep = angleDiff(b, q.bearing); return sep >= 35 && sep <= 150; })) chosen.push({ ...p, bearing: b });
        if (chosen.length === band.peaks) break;
      }
      if (chosen.length < band.peaks) continue;
      const shown = chosen.map((p) => Math.round(p.bearing / band.round) * band.round % 360);
      const error = (q) => chosen.map((p, i) => angleDiff(bearingTo(q, p), shown[i]));
      // Distractors: one on a bearing line (trap), the others nearby plausible ground.
      const distractors = [];
      const ok = (q) => model.inside(q.x, q.y, 80) && model.getSlope(q.x, q.y) < 30
        && Math.max(...error(q)) >= band.minError + band.round / 2
        && [o, ...distractors].every((r) => Math.hypot(r.x - q.x, r.y - q.y) >= 140);
      for (let k = 0; k < 60 && distractors.length < 1; k++) {
        const p = rng.pick(chosen), back = (p.bearing + 180) * DEG, d = Math.hypot(p.x - o.x, p.y - o.y) + rng.range(-420, 420) * (rng.chance(0.5) ? 1 : -1);
        const q = { x: p.x + Math.sin(back) * d, y: p.y + Math.cos(back) * d, trap: true };
        if (d > 150 && ok(q)) distractors.push(q);
      }
      for (let k = 0; k < 200 && distractors.length < 3; k++) {
        const a = rng.range(0, 360) * DEG, r = rng.range(180, 650), q = { x: o.x + Math.sin(a) * r, y: o.y + Math.cos(a) * r };
        if (ok(q) && Math.max(...error(q)) <= band.maxError) distractors.push(q); // near misses, not giveaways
      }
      if (distractors.length < 3) continue;
      const labels = rng.shuffle([{ ...o, correct: true }, ...distractors]).map((q, i) => ({ ...q, label: 'ABCD'[i],
        z: surfaceElevation(model, q.x, q.y), errors: error(q).map((e) => +e.toFixed(1)) }));
      const options = labels.map(({ label, x, y, z, correct, trap, errors }) => ({ label, x, y, z, correct: !!correct, trap: !!trap, errors, landform: model.analyzer.classify(x, y) }));
      const correct = options.find((q) => q.correct);
      const peaksOut = chosen.map((p, i) => ({ label: `P${i + 1}`, x: p.x, y: p.y, z: p.z, bearing: +p.bearing.toFixed(2), shown: shown[i],
        elevation: +(Math.atan2(p.z - eye.z, Math.hypot(p.x - o.x, p.y - o.y)) / DEG).toFixed(3) }));
      const camera = { x: o.x, y: o.y, z: eye.z, eyeHeight: EYE, heading: peaksOut[0].bearing, fov: 50, pitch: peaksOut[0].elevation, roll: 0 };
      const quiz = scaffold({ ...built, mode: 'resection', seed: opts.seed, difficulty, variant: opts.variant || 0, camera, t0, extra: {
        // Only Easy marks the peaks; harder levels make you find each labelled hill on the contour map.
        resection: { peaks: peaksOut, rounding: band.round, peaksMarked: difficulty === 'easy' },
        options, correctLabel: correct.label,
        hardness: Math.min(1, (band.peaks === 2 ? 0.5 : 0.25) + (band.round > 1 ? 0.3 : 0) + (10 - band.minError) / 20),
        validation: { ok: true, issues: [], confidence: 0.85, uniqueness: Math.min(1, Math.min(...options.filter((q) => !q.correct).map((q) => Math.max(...q.errors))) / 20) },
      } });
      const extend = (p, through) => { const d = Math.hypot(through.x - p.x, through.y - p.y), k = (d + 260) / d; return { x: p.x + (through.x - p.x) * k, y: p.y + (through.y - p.y) * k }; };
      quiz.map = {
        extras: difficulty === 'easy' ? peaksOut.map((p) => ({ type: 'point', shape: 'peak', x: p.x, y: p.y, label: p.label, color: '#ffd666' })) : [],
        revealExtras: [...(difficulty === 'easy' ? [] : peaksOut.map((p) => ({ type: 'point', shape: 'peak', x: p.x, y: p.y, label: p.label, color: '#ffd666' })))].concat(peaksOut.map((p) => ({ type: 'line', points: [p, extend(p, o)], color: 'rgba(255, 214, 102, .85)', width: 1.6, dash: [6, 4], label: bearingText(p.shown + 180), labelAt: 0.75 }))),
        revealYou: true, centre: { x: o.x, y: o.y },
      };
      quiz.explanation = resectionExplanation(quiz);
      return quiz;
    }
  }
  throw new Error('No clear resection found for this seed. Try another seed.');
}

/** Scene camera: look at each peak in turn for an equal share of the clip. */
export function resectionFrame(quiz, t) {
  const targets = quiz.resection.peaks.map((p) => ({ heading: p.bearing, pitch: p.elevation + 1.5 }));
  return panCamera(quiz.camera, targets, Math.min(t, CLIP_DURATION - 1e-6));
}

export function resectionExplanation(quiz) {
  const peaks = quiz.resection.peaks, correct = quiz.options.find((o) => o.correct);
  const evidence = [...(quiz.resection.peaksMarked ? [] : [{ type: 'peak-identification', text: `Each labelled hill in the view is a summit on the map: ${peaks.map((p) => `${p.label} at ${Math.round(p.z - 2)} m`).join(', ')}. Match its shape and height against the closed contours before taking the back-bearing.`,
    data: { peaks: peaks.map(({ label, x, y, z }) => ({ label, x: Math.round(x), y: Math.round(y), heightMetres: Math.round(z - 2) })) } }]), { type: 'back-bearings', text: `Reverse each bearing (±180°) and draw it from the peak: ${peaks.map((p) => `${p.label} ${bearingText(p.shown)} → back-bearing ${bearingText(p.shown + 180)}`).join('; ')}. `
    + `The lines cross at ${correct.label}.`, data: { peaks: peaks.map(({ label, shown }) => ({ label, bearing: shown, backBearing: wrap360(shown + 180) })) } },
  { type: 'bearing-check', text: `From ${correct.label} every peak lies within ${Math.max(...correct.errors).toFixed(1)}° of its measured bearing.`,
    data: { errors: correct.errors } }];
  if (quiz.resection.rounding > 1) evidence.push({ type: 'rounding', text: `Bearings were read to the nearest ${quiz.resection.rounding}°, so allow ±${quiz.resection.rounding / 2}° around each line.`, data: { rounding: quiz.resection.rounding } });
  const alternatives = quiz.options.filter((o) => !o.correct).map((o) => {
    const worst = o.errors.indexOf(Math.max(...o.errors)), p = peaks[worst];
    return { label: o.label, difference: o.errors[worst], status: 'distinguished',
      plausibility: o.trap ? `${o.label} sits on one bearing line, so a single bearing cannot rule it out.` : '',
      reasons: [{ type: 'bearing-mismatch', text: `From ${o.label}, ${p.label} lies ${o.errors[worst].toFixed(1)}° away from the ${bearingText(p.shown)} you measured.`,
        data: { peak: p.label, errorDegrees: o.errors[worst] } }] };
  });
  return { version: 1, language: 'en', source: 'bearing-geometry', kind: 'resection',
    correct: { label: correct.label, summary: `Only ${correct.label} reproduces every measured bearing.`, evidence },
    closestLabels: [...alternatives].sort((a, b) => a.difference - b.difference).slice(0, 3).map((a) => a.label), alternatives };
}
