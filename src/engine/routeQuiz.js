// Route choice: three ways from a start triangle to a finish circle — straight,
// or around the left or right through a waypoint (each leg a least-time
// Dijkstra path). Walking time follows Tobler's hiking function (speed falls
// off with slope, fastest slightly downhill), off-trail. Which wins depends on
// the ground: sometimes over the hill, sometimes around it.

import { now } from './quiz.js';
import { surfaceElevation } from './terrainSurface.js';
import { terrains, scaffold } from './mapModes.js';

const BANDS = { easy: 0.2, medium: 0.12, hard: 0.08, expert: 0.06, master: 0.045 }; // margin over the 2nd-fastest
const COLORS = { A: '#ff6b5e', B: '#5fd08a', C: '#4fd3e0' };
const OFF_TRAIL = 0.6;

/** Tobler: km/h for a slope dz/dx, scaled for rough ground. */
export const toblerSpeed = (slope) => 6 * Math.exp(-3.5 * Math.abs(slope + 0.05)) * OFF_TRAIL;

export function routeStats(model, points) {
  let seconds = 0, length = 0, climb = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], d = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(d / 5));
    let z0 = surfaceElevation(model, a.x, a.y);
    for (let k = 1; k <= steps; k++) {
      const x = a.x + (b.x - a.x) * k / steps, y = a.y + (b.y - a.y) * k / steps, z1 = surfaceElevation(model, x, y), dd = d / steps;
      seconds += dd / (toblerSpeed((z1 - z0) / dd) / 3.6);
      if (z1 > z0) climb += z1 - z0;
      z0 = z1; length += dd;
    }
  }
  return { minutes: seconds / 60, length, climb };
}

/** Least-time path on a 15 m grid (8-neighbour Dijkstra) with an optional extra cost field. */
function leastTime(model, s, f, penalty = () => 0) {
  const step = 15, pad = 260;
  const x0 = Math.max(0, Math.min(s.x, f.x) - pad), y0 = Math.max(0, Math.min(s.y, f.y) - pad);
  const x1 = Math.min(model.size, Math.max(s.x, f.x) + pad), y1 = Math.min(model.size, Math.max(s.y, f.y) + pad);
  const nx = Math.ceil((x1 - x0) / step) + 1, ny = Math.ceil((y1 - y0) / step) + 1, N = nx * ny;
  const z = new Float32Array(N), extra = new Float32Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + i * step, y = y0 + j * step;
    z[j * nx + i] = model.getElevation(x, y); extra[j * nx + i] = penalty(x, y);
  }
  const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const id = (p) => Math.round((p.y - y0) / step) * nx + Math.round((p.x - x0) / step);
  const start = id(s), goal = id(f);
  // Binary heap of [cost, node].
  const heap = [[0, start]]; dist[start] = 0;
  const push = (item) => { heap.push(item); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0;
    for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top; };
  const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.length) {
    const [cost, u] = pop();
    if (done[u]) continue; done[u] = 1;
    if (u === goal) break;
    const ui = u % nx, uj = (u / nx) | 0;
    for (const [di, dj] of nb) {
      const i = ui + di, j = uj + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const v = j * nx + i, d = step * Math.hypot(di, dj);
      const c = cost + d / (toblerSpeed((z[v] - z[u]) / d) / 3.6) * (1 + extra[v]);
      if (c < dist[v]) { dist[v] = c; prev[v] = u; push([c, v]); }
    }
  }
  const path = [];
  for (let u = goal; u >= 0; u = prev[u]) path.push({ x: x0 + (u % nx) * step, y: y0 + ((u / nx) | 0) * step });
  path.reverse();
  path[0] = { x: s.x, y: s.y }; path[path.length - 1] = { x: f.x, y: f.y };
  return smooth(path);
}

/** Chaikin smoothing (keeps the end points) so grid paths read like footpaths. */
function smooth(points, rounds = 3) {
  let p = points.filter((_, i) => i % 2 === 0 || i === points.length - 1);
  for (let r = 0; r < rounds; r++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(p[p.length - 1]); p = out;
  }
  return p;
}

const distanceToPath = (pt, path) => Math.min(...path.map((q) => Math.hypot(q.x - pt.x, q.y - pt.y)));
const separation = (a, b) => Math.max(...a.filter((_, i) => i % 4 === 0).map((p) => distanceToPath(p, b)));

export function generateRouteQuiz(opts) {
  const difficulty = BANDS[opts.difficulty] ? opts.difficulty : 'medium', margin = BANDS[difficulty], t0 = now();
  for (const built of terrains({ ...opts, difficulty }, 'route')) {
    const { model, rng } = built, L = model.size;
    for (let tries = 0; tries < 90; tries++) {
      const s = { x: rng.range(0.15, 0.85) * L, y: rng.range(0.15, 0.85) * L };
      const a = rng.range(0, Math.PI * 2), d = rng.range(550, 950);
      const f = { x: s.x + Math.sin(a) * d, y: s.y + Math.cos(a) * d };
      if (!model.inside(f.x, f.y, 150)) continue;
      const straight = Array.from({ length: 21 }, (_, i) => ({ x: s.x + (f.x - s.x) * i / 20, y: s.y + (f.y - s.y) * i / 20 }));
      // Three human choices: straight over everything, or around the left / right via a waypoint
      // (each leg the least-time path). Which one wins depends on the ground in between.
      const nx = -(f.y - s.y) / d, ny = (f.x - s.x) / d, m = { x: (s.x + f.x) / 2, y: (s.y + f.y) / 2 };
      const around = (side) => {
        const off = rng.range(0.22, 0.42) * d * side, w = { x: m.x + nx * off + (f.x - s.x) * rng.range(-0.12, 0.12), y: m.y + ny * off + (f.y - s.y) * rng.range(-0.12, 0.12) };
        if (!model.inside(w.x, w.y, 60)) return null;
        const first = leastTime(model, s, w), second = leastTime(model, w, f);
        return [...first, ...second.slice(1)];
      };
      const left = around(1), right = around(-1);
      if (!left || !right) continue;
      const routes = [{ kind: 'straight', points: straight }, { kind: 'left', points: left }, { kind: 'right', points: right }];
      if (separation(left, straight) < 80 || separation(right, straight) < 80 || separation(left, right) < 120) continue;
      const stats = routes.map((r) => ({ ...r, ...routeStats(model, r.points) }));
      const sorted = [...stats].sort((p, q) => p.minutes - q.minutes);
      if (sorted[1].minutes / sorted[0].minutes - 1 < margin) continue;
      if (sorted[2].minutes / sorted[0].minutes - 1 > 0.9) continue; // no absurd option
      // Keep the answer unpredictable: a straight-line win is accepted only some of the time,
      // and only when the straight line really does cross relief.
      if (sorted[0].kind === 'straight' && (rng.next() > 0.3 || sorted[0].climb < 20)) continue;
      const labelled = rng.shuffle(stats).map((r, i) => ({ ...r, label: 'ABC'[i] }));
      const fastest = sorted[0].kind;
      const options = labelled.map((r) => ({ label: r.label, kind: r.kind, color: COLORS[r.label], correct: r.kind === fastest,
        minutes: +r.minutes.toFixed(2), length: +r.length.toFixed(1), climb: +r.climb.toFixed(1),
        points: r.points.map((p) => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1) })) }));
      const correct = options.find((o) => o.correct), centre = { x: (s.x + f.x) / 2, y: (s.y + f.y) / 2 };
      const camera = { x: s.x, y: s.y, z: surfaceElevation(model, s.x, s.y) + 1.7, eyeHeight: 1.7, heading: 0, fov: 52, pitch: 0, roll: 0 };
      const quiz = scaffold({ ...built, mode: 'route', seed: opts.seed, difficulty, variant: opts.variant || 0, camera, t0, extra: {
        route: { start: s, finish: f, straight: d, offTrail: OFF_TRAIL },
        options, correctLabel: correct.label,
        hardness: Math.min(1, 0.3 + (0.2 - (sorted[1].minutes / sorted[0].minutes - 1)) * 3),
        map: {
          markers: false, centre, drone: { radius: Math.max(900, d * 1.2), height: 320 },
          lineOptions: options.map((o) => ({ label: o.label, points: o.points })),
          extras: [...options.map((o) => ({ type: 'line', points: o.points, color: o.color, width: 2.6, halo: true, label: o.label, labelAt: 0.5 })),
            { type: 'point', shape: 'start', x: s.x, y: s.y, color: '#c34fd9' }, { type: 'point', shape: 'finish', x: f.x, y: f.y, color: '#c34fd9' }],
          revealExtras: [{ type: 'line', points: correct.points, color: '#ffffff', width: 1.2, dash: [3, 4] }],
        },
      } });
      quiz.explanation = routeExplanation(quiz);
      return quiz;
    }
  }
  throw new Error('No clear route choice found for this seed. Try another seed.');
}

export function routeExplanation(quiz) {
  const correct = quiz.options.find((o) => o.correct);
  const describe = (o) => `${o.label}: ${o.minutes.toFixed(1)} min for ${Math.round(o.length)} m with ${Math.round(o.climb)} m of climbing`;
  const kinds = { straight: 'goes straight', left: 'swings around the left', right: 'swings around the right' };
  return { version: 1, language: 'en', source: 'tobler-hiking-time', kind: 'route',
    correct: { label: correct.label, summary: `${correct.label} ${kinds[correct.kind]} and is the fastest on foot.`,
      evidence: [{ type: 'walking-time', text: `${describe(correct)}. Walking speed follows Tobler's hiking function: about ${(6 * Math.exp(-0.175) * OFF_TRAIL).toFixed(1)} km/h on the flat off-trail, slowing on steep climbs and steep descents.`,
        data: { minutes: correct.minutes, lengthMetres: correct.length, climbMetres: correct.climb } }] },
    closestLabels: quiz.options.filter((o) => !o.correct).sort((a, b) => a.minutes - b.minutes).map((o) => o.label),
    alternatives: quiz.options.filter((o) => !o.correct).map((o) => ({ label: o.label, difference: +(o.minutes - correct.minutes).toFixed(2), status: 'distinguished',
      plausibility: o.length < correct.length ? `${o.label} is shorter, but the slopes cost more time than they save.` : o.climb < correct.climb ? `${o.label} climbs less, but the extra distance costs more.` : '',
      reasons: [{ type: 'slower', text: `${describe(o)} — ${(o.minutes - correct.minutes).toFixed(1)} min slower (${Math.round((o.minutes / correct.minutes - 1) * 100)}%).`,
        data: { minutes: o.minutes, lengthMetres: o.length, climbMetres: o.climb } }] })) };
}
