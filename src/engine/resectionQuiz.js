// Resection: compass bearings to two or three visible peaks fix your
// position. Easy marks the peaks on the map and offers near misses, one of
// them exactly on one bearing line (the classic trap of trusting a single
// bearing). From Medium up the peaks are hidden and the answers are spread
// over the map, each where the bearings run to other, similar hills — the
// classic misidentification. Those are ruled out by a bearing that meets no
// hill, or on harder levels by how their hills would look from there.

import { now } from './quiz.js';
import { surfaceElevation } from './terrainSurface.js';
import { DEG, angleDiff, wrap360 } from './grid.js';
import { terrains, scaffold, bearingTo, bearingText, panCamera, CLIP_DURATION, normaliseResectionAnswer } from './mapModes.js';
import { normaliseGridSize, gridCells, cellAt } from './gridQuiz.js';

// hidden: peaks unmarked, answers spread; lookalikes: answers whose every bearing meets a hill
// (ruled out only by the view, needing `cues` differences).
const BANDS = {
  easy: { peaks: 3, minError: 10, maxError: 90, round: 1 },
  medium: { peaks: 3, minError: 6, maxError: 25, round: 1, hidden: true, lookalikes: 0 },
  hard: { peaks: 2, minError: 6, maxError: 25, round: 1, hidden: true, lookalikes: 1, cues: 2 },
  expert: { peaks: 2, minError: 5, maxError: 20, round: 1, hidden: true, lookalikes: 1, cues: 1 },
  master: { peaks: 2, minError: 6, maxError: 20, round: 5, hidden: true, lookalikes: 2, cues: 1 },
};
const EYE = 1.7, PEAK_LIFT = 2, SPREAD = 0.25; // hidden peaks: answers at least a quarter of the map apart
// Hidden peaks need more hills to confuse and room to spread the answers: a 3 km map at the usual detail.
const LARGE_MAP = { size: 3000, n: 385 };
const formGroup = (form) => ['valley', 'reentrant'].includes(form) ? 'hollow' : ['ridge', 'spur'].includes(form) ? 'crest'
  : ['summit', 'knoll'].includes(form) ? 'top' : form;

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
  const gridSize = normaliseResectionAnswer(opts.resectionAnswer) === 'grid' ? normaliseGridSize(opts.gridSize) : 0;
  for (const built of terrains({ ...opts, difficulty, ...(band.hidden && !opts.size ? LARGE_MAP : {}) }, 'resection')) {
    const { model, rng } = built, L = model.size;
    const peaks = model.analyzer.summits
      .filter((s) => model.inside(s.x, s.y, 60) && (s.kind === 'summit' || s.prominence >= (band.hidden ? 7 : 10))) // larger maps: clear knolls too
      .map((s) => ({ x: s.x, y: s.y, z: surfaceElevation(model, s.x, s.y) + PEAK_LIFT, prominence: s.prominence || 0, kind: s.kind }))
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
      if (gridSize && !fixInOneCell(o, chosen, shown, band, L, gridSize)) continue;
      const error = (q) => chosen.map((p, i) => angleDiff(bearingTo(q, p), shown[i]));
      const distractors = band.hidden ? lookalikeDistractors({ model, rng, o, eye, chosen, shown, band, error }) : nearMisses({ model, rng, o, chosen, band, error });
      if (!distractors) continue;
      const own = band.hidden ? { lines: chosen.map((p, i) => line(error(o)[i], p, i)), refute: null, cues: [] } : {};
      const labels = rng.shuffle([{ ...o, ...own, correct: true }, ...distractors]).map((q, i) => ({ ...q, label: 'ABCD'[i],
        z: surfaceElevation(model, q.x, q.y), errors: error(q).map((e) => +e.toFixed(1)) }));
      const options = labels.map(({ label, x, y, z, correct, trap, errors, lines, refute, cues }) => ({ label, x, y, z, correct: !!correct, trap: !!trap, errors,
        ...(band.hidden ? { lines, refute, cues } : {}), landform: model.analyzer.classify(x, y) }));
      const correct = options.find((q) => q.correct), wrong = options.filter((q) => !q.correct);
      const peaksOut = chosen.map((p, i) => ({ label: `P${i + 1}`, x: p.x, y: p.y, z: p.z, bearing: +p.bearing.toFixed(2), shown: shown[i],
        elevation: +(Math.atan2(p.z - eye.z, Math.hypot(p.x - o.x, p.y - o.y)) / DEG).toFixed(3) }));
      const camera = { x: o.x, y: o.y, z: eye.z, eyeHeight: EYE, heading: peaksOut[0].bearing, fov: 50, pitch: peaksOut[0].elevation, roll: 0 };
      const quiz = scaffold({ ...built, mode: 'resection', seed: opts.seed, difficulty, variant: opts.variant || 0, camera, t0, extra: {
        // Only Easy marks the peaks; harder levels make you find each labelled hill on the contour map.
        resection: { peaks: peaksOut, rounding: band.round, peaksMarked: difficulty === 'easy' },
        options, correctLabel: correct.label,
        hardness: Math.min(1, (band.peaks === 2 ? 0.5 : 0.25) + (band.round > 1 ? 0.3 : 0) + (10 - band.minError) / 20
          + (band.hidden ? 0.15 + 0.1 * wrong.filter((q) => q.refute === 'view').length : 0)),
        validation: { ok: true, issues: [], confidence: 0.85, uniqueness: Math.min(1, ...wrong.map((q) => band.hidden
          ? (q.refute === 'view' ? 0.3 : Math.max(...q.lines.map((l) => l.error)) / 20) : Math.max(...q.errors) / 20)) },
      } });
      const extend = (p, through) => { const d = Math.hypot(through.x - p.x, through.y - p.y), k = (d + 260) / d; return { x: p.x + (through.x - p.x) * k, y: p.y + (through.y - p.y) * k }; };
      quiz.map = {
        extras: difficulty === 'easy' ? peaksOut.map((p) => ({ type: 'point', shape: 'peak', x: p.x, y: p.y, label: p.label, color: '#ffd666' })) : [],
        revealExtras: [...(difficulty === 'easy' ? [] : peaksOut.map((p) => ({ type: 'point', shape: 'peak', x: p.x, y: p.y, label: p.label, color: '#ffd666' })))].concat(peaksOut.map((p) => ({ type: 'line', points: [p, extend(p, o)], color: 'rgba(255, 214, 102, .85)', width: 1.6, dash: [6, 4], label: bearingText(p.shown + 180), labelAt: 0.75 }))),
        revealYou: true, centre: { x: o.x, y: o.y },
      };
      quiz.explanation = resectionExplanation(quiz);
      return gridSize ? toGridAnswer(quiz, o, L, gridSize) : quiz;
    }
  }
  throw new Error('No clear resection found for this seed. Try another seed.');
}

/** Every position that fits all bearings (within the reading accuracy) lies in the observer's cell. */
function fixInOneCell(o, chosen, shown, band, L, size) {
  const own = cellAt(o.x, o.y, L, size), slack = band.round / 2 + 0.6, reach = 500, step = 10;
  for (let dy = -reach; dy <= reach; dy += step) for (let dx = -reach; dx <= reach; dx += step) {
    const q = { x: o.x + dx, y: o.y + dy };
    if (cellAt(q.x, q.y, L, size) === own) continue;
    if (chosen.every((p, i) => angleDiff(bearingTo(q, p), shown[i]) <= slack)) return false;
  }
  return true;
}

/**
 * Grid answer: the cell you stand in. The point answers stay as
 * `resection.points`; their cells explain the look-alike traps.
 */
function toGridAnswer(quiz, o, L, size) {
  const correctLabel = cellAt(o.x, o.y, L, size), points = quiz.options;
  const options = gridCells(L, size).map((c) => ({ ...c, correct: c.label === correctLabel }));
  const out = { ...quiz, options, correctLabel, resection: { ...quiz.resection, answer: 'grid', points },
    grid: { size, origin: 'observer', cellMetres: L / size, target: { x: Math.round(o.x), y: Math.round(o.y) } } };
  out.explanation = gridExplanation(out, quiz.explanation);
  return out;
}

function gridExplanation(quiz, pointExplanation) {
  const { peaks, points, rounding } = quiz.resection, { size } = quiz.grid, L = quiz.terrain.size, cell = quiz.correctLabel;
  const traps = new Map();
  for (const o of points.filter((p) => !p.correct)) {
    const label = cellAt(o.x, o.y, L, size);
    if (label === cell || traps.has(label)) continue;
    const named = { ...o, label: `the ${o.trap ? 'single-bearing trap' : o.lines ? 'look-alike point' : 'near-miss point'} in ${label}` };
    const rename = (text) => text.replace(new RegExp(`\\b${o.label}\\b`, 'g'), named.label);
    const point = pointExplanation.alternatives.find((a) => a.label === o.label);
    const base = o.lines ? lookalikeAlternative(named, peaks, rounding)
      : { ...point, plausibility: rename(point.plausibility), reasons: point.reasons.map((r) => ({ ...r, text: rename(r.text) })) };
    traps.set(label, { ...base, label, scope: 'trap-point', comparisonPoint: { x: Math.round(o.x), y: Math.round(o.y) },
      plausibility: `A trap lies in ${label}. ${(base.plausibility || '').replace(/^./, (c) => c.toUpperCase())}`.trim() });
  }
  const alternatives = quiz.options.filter((c) => !c.correct).map((c) => {
    if (traps.has(c.label)) return traps.get(c.label);
    const errors = peaks.map((p) => angleDiff(bearingTo(c, p), p.shown)), worst = errors.indexOf(Math.max(...errors)), p = peaks[worst];
    return { label: c.label, difference: +errors[worst].toFixed(1), status: 'distinguished', scope: 'cell-centre', plausibility: '',
      reasons: [{ type: 'bearing-mismatch', text: `The back-bearings do not cross in ${c.label}: from its centre, ${p.label} would lie ${errors[worst].toFixed(1)}° off the ${bearingText(p.shown)} you measured.`,
        data: { peak: p.label, errorDegrees: +errors[worst].toFixed(1) } }] };
  });
  const ranked = [...alternatives].sort((a, b) => (a.scope === 'trap-point' ? -1 : 0) - (b.scope === 'trap-point' ? -1 : 0) || a.difference - b.difference);
  return { ...pointExplanation, kind: 'resection-cell',
    correct: { label: cell, summary: `Only ${cell} holds the point where every back-bearing crosses.`,
      evidence: [...pointExplanation.correct.evidence.filter((e) => e.type !== 'bearing-check')
        .map((e) => e.type === 'back-bearings' ? { ...e, text: e.text.replace(/The lines cross at \w+\.$/, `The lines cross where you stand, in ${cell}.`) } : e),
        { type: 'observer-cell', text: `The back-bearings cross inside ${cell} (${Math.round(quiz.grid.cellMetres)} m cells). Allowing ±${(rounding / 2 + 0.6).toFixed(1)}° of reading error on every bearing, all positions that fit stay in ${cell}.`,
          data: { label: cell, target: quiz.grid.target, divisions: size } }] },
    closestLabels: ranked.slice(0, 3).map((a) => a.label), alternatives };
}

/** What a bearing line from a point runs to: its nearest hill and the angle off it. */
const line = (error, hill, peak) => ({ error: +error.toFixed(1),
  hill: hill && { x: Math.round(hill.x), y: Math.round(hill.y), height: Math.round(hill.z - PEAK_LIFT), kind: hill.kind || 'summit', peak } });

/** Easy (peaks marked): one point on a bearing line (trap), the others nearby plausible ground. */
function nearMisses({ model, rng, o, chosen, band, error }) {
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
  return distractors.length === 3 ? distractors : null;
}

/**
 * Hidden peaks: answers spread over the map, on ground like yours, where the
 * bearings run to other hills (mistake them for P1… and you land there). A
 * bearing that meets no hill rules each out; look-alikes whose every bearing
 * meets a hill are ruled out by the view (hidden, much nearer or farther, or
 * above instead of below eye level).
 */
function lookalikeDistractors({ model, rng, o, eye, chosen, shown, band, error }) {
  const spread = SPREAD * model.size, reach = Math.max(2000, 0.85 * model.size), onHill = band.round / 2 + 1, offHill = band.minError + band.round / 2;
  const hills = model.analyzer.summits.filter((s) => model.inside(s.x, s.y, 40))
    .map((s) => ({ x: s.x, y: s.y, z: surfaceElevation(model, s.x, s.y) + PEAK_LIFT, prominence: s.prominence || 0, kind: s.kind }));
  const peakOf = (h) => chosen.findIndex((p) => Math.hypot(p.x - h.x, p.y - h.y) < 1);
  const nearest = (q, bearing) => {
    let best = { error: 180, hill: null };
    for (const h of hills) {
      const d = Math.hypot(h.x - q.x, h.y - q.y);
      if (d < 100 || d > reach) continue; // generous: any hill a reader might take for it
      const e = angleDiff(bearingTo(q, h), bearing);
      if (e < best.error) best = { error: e, hill: h };
    }
    return best;
  };
  const group = formGroup(model.analyzer.classify(o.x, o.y)), cands = [];
  const consider = (x, y) => {
    if (!model.inside(x, y, 80) || model.getSlope(x, y) > 26 || Math.hypot(x - o.x, y - o.y) < spread) return;
    if (cands.some((c) => Math.hypot(c.x - x, c.y - y) < 60)) return;
    const q = { x, y };
    if (Math.max(...error(q)) < offHill) return;
    const near = shown.map((b) => nearest(q, b));
    if (near.some((l) => l.error > onHill && l.error < offHill)) return; // neither on a hill nor clearly off one
    const hits = near.filter((l) => l.error <= onHill).length, worst = Math.max(...near.map((l) => l.error));
    if (hits < band.peaks - 1) return; // all bearings but one look right
    const refute = hits === band.peaks ? 'view' : 'map';
    if (refute === 'map' ? worst > band.maxError : !band.lookalikes) return;
    const lines = near.map((l) => line(l.error, l.hill, l.hill ? peakOf(l.hill) : -1));
    // Look-alikes: the hills taken for P1… resemble them (same kind, similar prominence).
    const alike = near.reduce((sum, l, i) => l.error > onHill || peakOf(l.hill) === i ? sum : sum + (l.hill.kind === chosen[i].kind ? 0.3 : 0)
      + 0.3 * Math.min(l.hill.prominence, chosen[i].prominence) / Math.max(l.hill.prominence, chosen[i].prominence, 1), 0);
    const same = formGroup(model.analyzer.classify(x, y)) === group;
    cands.push({ x, y, lines, refute, near, trap: near.some((l, i) => l.error <= onHill && peakOf(l.hill) === i),
      score: hits + (same ? 2.5 : 0) + alike + (refute === 'map' ? 1.5 * (1 - worst / band.maxError) : 0) + rng.range(0, 0.8) }); // near misses first
  };
  const back = shown.map((b) => ({ x: Math.sin((b + 180) * DEG), y: Math.cos((b + 180) * DEG) }));
  // Two bearings meeting two hills exactly, then single bearing lines through each hill.
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    const u = back[i], v = back[j], det = v.x * u.y - u.x * v.y;
    for (const a of hills) for (const b of hills) {
      if (a === b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, t = (v.x * dy - v.y * dx) / det, s = (u.x * dy - u.y * dx) / det;
      if (t >= 250 && t <= 1600 && s >= 250 && s <= 1600) consider(a.x + u.x * t, a.y + u.y * t);
    }
  }
  for (let i = 0; i < shown.length; i++) for (const h of hills) for (let t = 250; t <= 1600; t += 45) consider(h.x + back[i].x * t, h.y + back[i].y * t);

  const cuesOf = (c) => {
    const at = { x: c.x, y: c.y, z: surfaceElevation(model, c.x, c.y) + EYE }, cues = [];
    c.near.forEach(({ hill: h }, i) => {
      const p = chosen[i], d = Math.hypot(h.x - c.x, h.y - c.y), r = Math.hypot(p.x - o.x, p.y - o.y);
      const e = Math.atan2(h.z - at.z, d) / DEG, e0 = Math.atan2(p.z - eye.z, r) / DEG;
      if (!sees(model, at, h)) { cues.push({ type: 'hidden', peak: i }); return; }
      if (d / r >= 2 || d / r <= 0.5) cues.push({ type: 'distance', peak: i, metres: Math.round(d), seen: Math.round(r) });
      if ((Math.sign(e) !== Math.sign(e0) && Math.abs(e - e0) >= 1.5) || Math.abs(e - e0) >= 4) cues.push({ type: 'elevation', peak: i, degrees: +e.toFixed(1), seen: +e0.toFixed(1) });
    });
    return cues;
  };
  const picked = [];
  let views = 0;
  const take = (c, { inSight = false } = {}) => {
    if (picked.includes(c) || !picked.every((r) => Math.hypot(r.x - c.x, r.y - c.y) >= spread)) return false;
    if (c.refute === 'view') {
      if (views >= band.lookalikes) return false;
      c.cues ??= cuesOf(c);
      if (c.cues.length < band.cues || inSight && c.cues.some((x) => x.type === 'hidden')) return false;
      views++;
    }
    picked.push(c); return true;
  };
  const sorted = cands.sort((a, b) => b.score - a.score);
  for (const c of sorted) if (c.trap && take(c)) break;
  // Hardest first: look-alike hills in sight from there, told apart only by distance and height.
  if (band.lookalikes) for (const c of sorted) if (c.refute === 'view' && take(c, { inSight: true })) break;
  if (band.lookalikes && !views) for (const c of sorted) if (c.refute === 'view' && take(c)) break;
  for (const c of sorted) if (picked.length < 3) take(c);
  if (picked.length < 3 || !picked.some((c) => c.trap)) return null;
  return picked.map(({ x, y, lines, refute, trap, cues }) => ({ x, y, lines, refute, trap, cues: cues || [] }));
}

/** Scene camera: look at each peak in turn for an equal share of the clip. */
export function resectionFrame(quiz, t) {
  const targets = quiz.resection.peaks.map((p) => ({ heading: p.bearing, pitch: p.elevation + 1.5 }));
  return panCamera(quiz.camera, targets, Math.min(t, CLIP_DURATION - 1e-6));
}

const hillName = (hill, peaks) => hill.peak >= 0 ? peaks[hill.peak].label : `the ${hill.height} m ${hill.kind === 'knoll' ? 'knoll' : 'hill'}`;
const distanceText = (m) => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
const eyeLevel = (deg) => `${Math.abs(deg).toFixed(1)}° ${deg < 0 ? 'below' : 'above'} eye level`;

/** Why a spread-out answer looks right (bearings meet hills) and what rules it out. */
function lookalikeAlternative(o, peaks, rounding) {
  const onHill = rounding / 2 + 1, hits = o.lines.map((l, i) => ({ l, p: peaks[i], i })).filter(({ l }) => l.error <= onHill);
  const alike = hits.filter(({ l, i }) => l.hill.peak !== i), own = hits.find(({ l, i }) => l.hill.peak === i);
  const runs = hits.map(({ l, p }, k) => `the ${p.label} bearing (${bearingText(p.shown)})${k ? '' : ' runs'} to ${hillName(l.hill, peaks)}`).join(' and ');
  const plausibility = `From ${o.label}, ${runs}`
    + (own ? ` — it sits on ${own.p.label}'s true back-bearing` : '')
    + (alike.length ? `${own ? ';' : ' —'} mistake ${alike.map(({ l }) => hillName(l.hill, peaks)).join(' and ')} for ${alike.map(({ p }) => p.label).join(' and ')} and ${o.label} fits` : '')
    + (o.refute === 'view' ? '. Every bearing meets a hill, so only the view tells it apart.' : '.');
  const reasons = o.refute === 'view' ? o.cues.map((c) => {
    const p = peaks[c.peak], name = hillName(o.lines[c.peak].hill, peaks);
    if (c.type === 'hidden') return { type: 'lookalike-hidden', text: o.lines[c.peak].hill.peak === c.peak ? `From ${o.label}, ${p.label} itself would be hidden behind higher ground, yet it stands in plain view.`
      : `From ${o.label}, ${name} on the ${p.label} bearing would be hidden behind higher ground, yet ${p.label} stands in plain view.`, data: { peak: p.label } };
    if (c.type === 'distance') return { type: 'lookalike-distance', text: `From ${o.label}, ${name} would be ${distanceText(c.metres)} away, but ${p.label} in the view is ${distanceText(c.seen)} away — it would look much ${c.metres > c.seen ? 'smaller and hazier' : 'larger'}.`,
      data: { peak: p.label, metres: c.metres, seenMetres: c.seen } };
    return { type: 'lookalike-elevation', text: `From ${o.label} you would look ${c.degrees < 0 ? 'down' : 'up'} at ${name} (${eyeLevel(c.degrees)}), but ${p.label} in the view is ${eyeLevel(c.seen)}.`,
      data: { peak: p.label, degrees: c.degrees, seenDegrees: c.seen } };
  }) : o.lines.map((l, i) => ({ l, p: peaks[i] })).filter(({ l }) => l.error > onHill).map(({ l, p }) => ({ type: 'bearing-mismatch',
    text: `But from ${o.label} the ${p.label} bearing (${bearingText(p.shown)}) meets no hill: the nearest summit is ${l.error.toFixed(1)}° off it.`, data: { peak: p.label, errorDegrees: l.error } }));
  return { label: o.label, difference: o.refute === 'view' ? 0 : Math.max(...o.lines.map((l) => l.error)), status: 'distinguished', plausibility, reasons };
}

export function resectionExplanation(quiz) {
  const peaks = quiz.resection.peaks, correct = quiz.options.find((o) => o.correct);
  const found = (p, i) => {
    const hill = correct.lines?.[i]?.hill, metres = Math.hypot(p.x - correct.x, p.y - correct.y);
    return `${p.label} is the ${Math.round(p.z - 2)} m ${hill?.kind === 'knoll' ? 'knoll' : 'summit'} ${distanceText(metres)} away, ${eyeLevel(p.elevation)}`;
  };
  const evidence = [...(quiz.resection.peaksMarked ? [] : [{ type: 'peak-identification', text: `Find each labelled hill on the map by its shape, height and distance: ${peaks.map(found).join('; ')}. Similar hills elsewhere fit the wrong points.`,
    data: { peaks: peaks.map(({ label, x, y, z, elevation }) => ({ label, x: Math.round(x), y: Math.round(y), heightMetres: Math.round(z - 2), metres: Math.round(Math.hypot(x - correct.x, y - correct.y)), elevationDegrees: elevation })) } }]), { type: 'back-bearings', text: `Reverse each bearing (±180°) and draw it from the peak: ${peaks.map((p) => `${p.label} ${bearingText(p.shown)} → back-bearing ${bearingText(p.shown + 180)}`).join('; ')}. `
    + `The lines cross at ${correct.label}.`, data: { peaks: peaks.map(({ label, shown }) => ({ label, bearing: shown, backBearing: wrap360(shown + 180) })) } },
  { type: 'bearing-check', text: `From ${correct.label} every peak lies within ${Math.max(...correct.errors).toFixed(1)}° of its measured bearing.`,
    data: { errors: correct.errors } }];
  if (quiz.resection.rounding > 1) evidence.push({ type: 'rounding', text: `Bearings were read to the nearest ${quiz.resection.rounding}°, so allow ±${quiz.resection.rounding / 2}° around each line.`, data: { rounding: quiz.resection.rounding } });
  const alternatives = quiz.options.filter((o) => !o.correct).map((o) => o.lines ? lookalikeAlternative(o, peaks, quiz.resection.rounding) : (() => {
    const worst = o.errors.indexOf(Math.max(...o.errors)), p = peaks[worst];
    return { label: o.label, difference: o.errors[worst], status: 'distinguished',
      plausibility: o.trap ? `${o.label} sits on one bearing line, so a single bearing cannot rule it out.` : '',
      reasons: [{ type: 'bearing-mismatch', text: `From ${o.label}, ${p.label} lies ${o.errors[worst].toFixed(1)}° away from the ${bearingText(p.shown)} you measured.`,
        data: { peak: p.label, errorDegrees: o.errors[worst] } }] };
  })());
  return { version: 1, language: 'en', source: 'bearing-geometry', kind: 'resection',
    correct: { label: correct.label, summary: `Only ${correct.label} reproduces every measured bearing.`, evidence },
    closestLabels: [...alternatives].sort((a, b) => a.difference - b.difference).slice(0, 3).map((a) => a.label), alternatives };
}
