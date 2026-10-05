// Drainage: rain falls at the drop — at which outlet does it leave the area?
// Water follows D8 steepest descent over the depression-filled surface (the
// same drainage model the terrain uses), so every cell ends at a map-edge
// outlet. Options are the main outlets; harder levels drop the rain closer to
// a watershed, where a few metres decide the valley.

import { now } from './quiz.js';
import { terrains, scaffold } from './mapModes.js';

const BANDS = { easy: { divide: [120, 2000] }, medium: { divide: [60, 2000] }, hard: { divide: [0, 140] }, expert: { divide: [0, 90] }, master: { divide: [0, 55] } };

export function generateDrainageQuiz(opts) {
  const difficulty = BANDS[opts.difficulty] ? opts.difficulty : 'medium', band = BANDS[difficulty], t0 = now();
  for (const built of terrains({ ...opts, difficulty }, 'drainage')) {
    const { model, rng } = built, { n, cell } = model, { filled, receiver, accumulation } = model.drainage, N = n * n;
    // Exit (border cell) of every cell, resolved from low to high ground.
    const order = Array.from({ length: N }, (_, k) => k).sort((a, b) => filled[a] - filled[b]);
    const exit = new Int32Array(N);
    for (const k of order) exit[k] = receiver[k] < 0 ? k : exit[receiver[k]];
    const xy = (k) => ({ x: (k % n) * cell, y: ((k / n) | 0) * cell });
    // Main outlets: the border cells collecting the most water, well spread.
    const border = [];
    for (let k = 0; k < N; k++) { const i = k % n, j = (k / n) | 0; if (i === 0 || j === 0 || i === n - 1 || j === n - 1) border.push(k); }
    border.sort((a, b) => accumulation[b] - accumulation[a]);
    const outlets = [];
    for (const k of border) {
      if (accumulation[k] < 300) break;
      if (outlets.every((q) => Math.hypot(xy(q).x - xy(k).x, xy(q).y - xy(k).y) > 320)) outlets.push(k);
      if (outlets.length === 8) break;
    }
    if (outlets.length < 4) continue;
    // Each cell's outlet: the main outlet its exit belongs to (exits near a main outlet join it).
    const nearestOutlet = (k) => { const p = xy(exit[k]); let best = -1, bd = 90; for (const o of outlets) { const q = xy(o), d = Math.hypot(p.x - q.x, p.y - q.y); if (d < bd) { bd = d; best = o; } } return best; };
    for (let tries = 0; tries < 400; tries++) {
      const i = rng.int(Math.round(n * 0.18), Math.round(n * 0.82)), j = rng.int(Math.round(n * 0.18), Math.round(n * 0.82)), k = j * n + i;
      const target = nearestOutlet(k);
      if (target < 0) continue;
      const path = [k];
      for (let u = receiver[k]; u >= 0; u = receiver[u]) path.push(u);
      const length = path.length * cell;
      if (length < 450) continue;
      // Distance to the nearest ground draining to another main outlet (the watershed).
      let divide = Infinity;
      const r = Math.ceil(Math.min(band.divide[1], 400) / cell);
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 1 || jj < 1 || ii >= n - 1 || jj >= n - 1) continue;
        const other = nearestOutlet(jj * n + ii);
        if (other >= 0 && other !== target) divide = Math.min(divide, Math.hypot(di, dj) * cell);
      }
      if (divide < band.divide[0] || divide > band.divide[1]) continue;
      const others = rng.shuffle(outlets.filter((o) => o !== target)).slice(0, 3);
      const inward = (o) => { const p = xy(o), c = model.size / 2, d = Math.hypot(c - p.x, c - p.y); return { x: p.x + (c - p.x) / d * 30, y: p.y + (c - p.y) / d * 30 }; };
      const options = rng.shuffle([target, ...others]).map((o, idx) => ({ label: 'ABCD'[idx], ...inward(o), correct: o === target,
        catchment: +(accumulation[o] * cell * cell / 1e6).toFixed(3) }));
      const correct = options.find((o) => o.correct), drop = xy(k);
      const line = path.filter((_, idx) => idx % 2 === 0 || idx === path.length - 1).map(xy);
      const camera = { x: drop.x, y: drop.y, z: model.getElevation(drop.x, drop.y) + 1.7, eyeHeight: 1.7, heading: 0, fov: 52, pitch: 0, roll: 0 };
      const quiz = scaffold({ ...built, mode: 'drainage', seed: opts.seed, difficulty, variant: opts.variant || 0, camera, t0, extra: {
        drainage: { drop, length: +length.toFixed(1), divide: Number.isFinite(divide) ? +divide.toFixed(1) : null, path: line.map((p) => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1) })) },
        options, correctLabel: correct.label, hardness: Math.min(1, 0.3 + (Number.isFinite(divide) ? Math.max(0, 150 - divide) / 200 : 0)),
        map: {
          centre: drop, drone: { radius: 1150, height: 360 },
          extras: [{ type: 'point', shape: 'drop', x: drop.x, y: drop.y, color: '#4fa8ff' }],
          revealExtras: [{ type: 'line', points: line, color: '#4fa8ff', width: 2.6, halo: true, arrow: true }],
        },
      } });
      quiz.explanation = drainageExplanation(quiz);
      return quiz;
    }
  }
  throw new Error('No clear drainage question found for this seed. Try another seed.');
}

export function drainageExplanation(quiz) {
  const d = quiz.drainage, correct = quiz.options.find((o) => o.correct);
  return { version: 1, language: 'en', source: 'd8-drainage', kind: 'drainage',
    correct: { label: correct.label, summary: `Water from the drop runs ${Math.round(d.length)} m downhill and leaves the area at ${correct.label}.`,
      evidence: [{ type: 'flow-path', text: `Each step goes to the steepest lower neighbour (crossing the contours at right angles); hollows are filled until they spill, so the water always finds an outlet.`
        + (d.divide !== null ? ` The watershed to another outlet is ${Math.round(d.divide)} m from the drop.` : ''),
      data: { lengthMetres: d.length, divideMetres: d.divide } }] },
    closestLabels: quiz.options.filter((o) => !o.correct).map((o) => o.label),
    alternatives: quiz.options.filter((o) => !o.correct).map((o) => ({ label: o.label, difference: null, status: 'distinguished', plausibility: '',
      reasons: [{ type: 'other-catchment', text: `${o.label} drains a different catchment (${o.catchment.toFixed(2)} km² upstream); the drop is on the other side of its watershed.`, data: { catchmentKm2: o.catchment } }] })) };
}
