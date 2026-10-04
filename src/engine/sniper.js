// Sniper mode: lie prone, spot an enemy sniper far away, then choose the
// bullet-drop (BDC) mark of the scope that puts the round on target.
//
// The answer comes from a physical trajectory (gravity + quadratic drag), not
// from a lookup: the rifle is zeroed at 100 m and each scope mark is the hold
// that hits a target on FLAT ground at that range. Shooting up- or downhill,
// gravity only acts across the HORIZONTAL distance (rifleman's rule), so the
// straight-line range is never the right mark when the slope is steep.
//
// Only the starting heading is given. Range and height difference have to be
// read from the terrain: locate yourself and the target on the contour map,
// or range the prone enemy's 0.50 m shoulders with the scope's mil stadia.

import { SeedManager, Random } from './rng.js';
import { getDifficulty, applyTuning } from './difficulty.js';
import { formatHeading } from './heading.js';
import { ViewpointGenerator } from './viewpoints.js';
import { buildTerrain, terrainSummary, landmarkSummary, now } from './quiz.js';
import { surfaceElevation, surfaceLineOfSight } from './terrainSurface.js';
import { DEG, clamp, lerp, saturate, smoothstep, wrap360 } from './grid.js';

export const SNIPER_DURATION = 15;
/** Overview until 5 s, raise the rifle, then 10 s through the scope. */
export const SNIPER_TIMING = Object.freeze({ overview: 5, scope: 5.7, finish: 15 });
export const SNIPER_EYE = 0.45;          // prone eye height (m)
export const SNIPER_FOV = 55;            // unscoped horizontal field of view (°)
export const TARGET_HEIGHT = 1.8;        // body scale (a 1.80 m man, lying prone)
export const HEAD_HEIGHT = 0.3;          // aim point: the prone enemy's head centre above the ground
export const SHOULDER_WIDTH = 0.5;       // across the ghillie shoulders, for mil ranging
export const BODY_LENGTH = 1.7;          // head to boots along the ground
export const HEAD_RADIUS = 0.12;         // a hold counts as a hit inside this radius
/** Scope picture: its circle spans ±SCOPE_RADIUS_MIL; the circle radius is a fraction of the short side. */
export const SCOPE_RADIUS_MIL = 12;
export const SCOPE_CIRCLE = 0.46;
export const MARKS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

// ------------------------------------------------------------- ballistics

export const RIFLE = Object.freeze({ muzzle: 820, drag: 0.00055, sightHeight: 0.05, zero: 100, g: 9.81 });

/** Height of the bullet (relative to the scope) where it crosses horizontal distance x. */
function trajectoryHeight(bore, x, rifle = RIFLE) {
  let px = 0, py = -rifle.sightHeight, vx = rifle.muzzle * Math.cos(bore), vy = rifle.muzzle * Math.sin(bore);
  const dt = 0.0015;
  for (let i = 0; i < 4000; i++) {
    const v = Math.hypot(vx, vy);
    const ax = -rifle.drag * v * vx, ay = -rifle.drag * v * vy - rifle.g;
    const nx = px + vx * dt, ny = py + vy * dt;
    if (nx >= x) return py + (ny - py) * (x - px) / (nx - px);
    px = nx; py = ny; vx += ax * dt; vy += ay * dt;
  }
  return -Infinity;
}

/** Bore angle (rad above horizontal) that crosses (x, y). */
function boreFor(x, y, rifle = RIFLE) {
  let lo = -0.3, hi = 0.5;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (trajectoryHeight(mid, x, rifle) > y) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

const ZERO_BORE = boreFor(RIFLE.zero, 0);
/** Scope mark positions: milliradians BELOW the crosshair, for flat-ground hits at each range. */
export const MARK_MILS = Object.freeze(Object.fromEntries(MARKS.map(m => [m, (boreFor(m, 0) - ZERO_BORE) * 1000])));

/**
 * Vertical miss (m, + high) at a target `horizontal` metres away and `rise`
 * metres above the scope, holding the target on the given scope mark.
 */
export function holdMiss(horizontal, rise, mark) {
  const los = Math.atan2(rise, horizontal);
  return trajectoryHeight(los + ZERO_BORE + MARK_MILS[mark] / 1000, horizontal) - rise;
}

export function bestMark(horizontal, rise) {
  const misses = MARKS.map(mark => ({ mark, miss: holdMiss(horizontal, rise, mark) }));
  misses.sort((a, b) => Math.abs(a.miss) - Math.abs(b.miss));
  return { mark: misses[0].mark, misses };
}

const nearestMark = metres => MARKS.reduce((best, m) => Math.abs(m - metres) < Math.abs(best - metres) ? m : best, MARKS[0]);

// --------------------------------------------------------------- timeline

const ease = t => smoothstep(0, 1, t);

/** Horizontal field of view (°) that shows SCOPE_RADIUS_MIL at the scope circle's radius. */
export function scopeFov(aspect) {
  // Circle radius = SCOPE_CIRCLE × short side; half the width therefore spans this many mils.
  const halfWidthMil = (SCOPE_RADIUS_MIL / 2) * aspect / (SCOPE_CIRCLE * Math.min(1, aspect));
  // Perspective maps tan(angle) linearly to the screen, so tan(half-FOV) = half-width in radians.
  return 2 * Math.atan(halfWidthMil / 1000) / DEG;
}

/** Screen pixels per mil for a scene of the given size (same rule as scopeFov). */
export const pixelsPerMil = (width, height) => SCOPE_CIRCLE * Math.min(width, height) / SCOPE_RADIUS_MIL;

/** The shooter's hold relative to the target, in mils (+ means the target sits below the crosshair). */
export function sniperSway(t) {
  const s = Math.max(0, t - SNIPER_TIMING.scope);
  // Walk the target down the BDC ladder and back (≈7 s cycle), with breathing and tremor.
  const ladder = 5.6 - 4.6 * Math.cos(2 * Math.PI * s / 7.2);
  const breath = 0.45 * Math.sin(2 * Math.PI * 0.27 * s + 0.6);
  const tremor = 0.07 * Math.sin(17.3 * s) + 0.05 * Math.sin(29.1 * s + 1.3);
  const settle = 1 - ease(s / 0.9);
  return {
    vertical: lerp(ladder + breath + tremor, 0, settle * 0.85),
    horizontal: 0.55 * Math.sin(2 * Math.PI * 0.19 * s) + 0.25 * Math.sin(2 * Math.PI * 0.41 * s + 2) + 0.05 * Math.sin(23.7 * s),
  };
}

/**
 * One deterministic camera/scope sampler for the game, replays and exports.
 * `aspect` is the scene's width / height (the scope circle is round on screen).
 */
export function sniperFrame(quiz, seconds = 0, aspect = 1.6) {
  const t = clamp(Number.isFinite(seconds) ? seconds : 0, 0, SNIPER_DURATION), s = quiz.sniper, base = quiz.camera;
  const scopeH = scopeFov(aspect);
  const aimSway = sniperSway(t);
  const aim = { heading: wrap360(s.bearing + aimSway.horizontal * 0.0573), pitch: s.elevation + aimSway.vertical * 0.0573 };
  // A slow breathing bob while observing; the rifle rises over 0.7 s.
  const bob = 0.12 * Math.sin(2 * Math.PI * 0.25 * t);
  const raise = ease((t - SNIPER_TIMING.overview) / (SNIPER_TIMING.scope - SNIPER_TIMING.overview));
  const turn = wrap360(aim.heading - base.heading + 180) - 180;
  const zoom = raise <= 0 ? base.fov : raise >= 1 ? scopeH : Math.exp(lerp(Math.log(base.fov), Math.log(scopeH), raise));
  const camera = { ...base, heading: wrap360(base.heading + turn * raise), pitch: lerp(base.pitch + bob, aim.pitch, raise), fov: zoom };
  return { camera, raise, scoped: raise >= 1, phase: t < SNIPER_TIMING.overview ? 'overview' : raise < 1 ? 'raise' : 'scope',
    sway: aimSway, time: t, done: t >= SNIPER_DURATION };
}

// ------------------------------------------------------------- generation

const BANDS = {
  easy: { range: [380, 620], options: 3, minAngle: 0 },
  medium: { range: [420, 780], options: 3, minAngle: 2 },
  hard: { range: [480, 900], options: 4, minAngle: 4 },
  expert: { range: [520, 980], options: 4, minAngle: 5 },
  master: { range: [540, 1000], options: 5, minAngle: 6 },
};
export const sniperBand = difficulty => BANDS[difficulty] || BANDS.medium;

/** A prone enemy: his head and rifle must be in clear view; his body lies on the slope behind them. */
function targetSight(model, camera, x, y, bearing) {
  const z = surfaceElevation(model, x, y);
  const visible = [0.2, HEAD_HEIGHT, 0.4].every(h => surfaceLineOfSight(model, camera, { x, y, z: z + h }));
  const fx = x + Math.sin(bearing * DEG) * BODY_LENGTH, fy = y + Math.cos(bearing * DEG) * BODY_LENGTH;
  // Positive pitch raises the boots (lying head-down a slope facing the observer).
  const pitch = Math.atan2(surfaceElevation(model, fx, fy) - z, BODY_LENGTH) / DEG;
  return { z, visible, pitch };
}

export function generateSniperQuiz({ seed, world = 'classic', difficulty = 'medium', variant = 0, tuning = null,
  size, n, maxTerrainAttempts = 5, onProgress = () => {} }) {
  if (!BANDS[difficulty]) difficulty = 'medium';
  const t0 = now(), base = applyTuning(getDifficulty(difficulty), tuning), band = sniperBand(difficulty);
  const preset = { ...base, heading: 'exact' }, seeds = new SeedManager(`${seed}#${difficulty}`), log = [];
  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating sniper terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n, world });
    if (!terrainCheck.ok) { log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues }); continue; }
    const rng = seeds.stream('sniper', attempt, variant);
    const vg = new ViewpointGenerator(model, preset, rng.fork('viewpoints'), {
      fov: SNIPER_FOV, eyeHeight: SNIPER_EYE, gridSize: 14, margin: Math.min(200, model.size / 6), maxPicks: 60,
    });
    onProgress('Finding a prone firing position');
    const { picked, evaluated } = vg.generate();
    let tried = 0;
    // First insist on a real height difference for the difficulty, then accept any clear shot.
    for (const minAngle of [band.minAngle, 0]) for (const vp of picked) {
      const ground = surfaceElevation(model, vp.x, vp.y);
      const camera = { x: vp.x, y: vp.y, z: ground + SNIPER_EYE, eyeHeight: SNIPER_EYE, heading: vp.heading, fov: SNIPER_FOV, pitch: 0, roll: 0 };
      for (let line = 0; line < 24; line++) {
        tried++;
        const bearing = wrap360(vp.heading + rng.range(-0.28, 0.28) * SNIPER_FOV);
        const horizontal = rng.range(...band.range);
        const x = camera.x + Math.sin(bearing * DEG) * horizontal, y = camera.y + Math.cos(bearing * DEG) * horizontal;
        if (!model.inside(x, y, 40) || model.getSlope(x, y) > 30) continue;
        if (!model.inside(x + Math.sin(bearing * DEG) * 2, y + Math.cos(bearing * DEG) * 2, 30)) continue;
        const sight = targetSight(model, camera, x, y, bearing);
        if (!sight.visible || Math.abs(sight.pitch) > 22) continue;
        const rise = sight.z + HEAD_HEIGHT - camera.z;
        const angle = Math.atan2(rise, horizontal) / DEG;
        if (Math.abs(angle) > 22 || Math.abs(angle) < minAngle) continue;
        const { mark, misses } = bestMark(horizontal, rise);
        const [best, second] = misses;
        // Exactly one mark hits the head; every other mark clearly misses it.
        if (mark < 300 || Math.abs(best.miss) > HEAD_RADIUS - 0.01 || Math.abs(second.miss) < 2.5 * HEAD_RADIUS) continue;
        const slant = Math.hypot(horizontal, rise), slantMark = nearestMark(slant);
        // Consecutive marks around the answer; Master always offers the straight-line trap.
        const pick = rng.fork(`options-${attempt}-${tried}`);
        const count = band.options, lowest = clamp(mark - 100 * pick.int(0, count - 1), 300, 1000 - 100 * (count - 1));
        let marks = Array.from({ length: count }, (_, i) => lowest + 100 * i);
        if (difficulty === 'master' && slantMark !== mark && !marks.includes(slantMark)) marks = [...marks.slice(0, -1), slantMark].sort((a, b) => a - b);
        if (!marks.includes(mark)) continue;
        const options = marks.map(m => ({ label: `${m} m`, metres: m, mil: +MARK_MILS[m].toFixed(3),
          miss: +holdMiss(horizontal, rise, m).toFixed(3), correct: m === mark }));
        camera.pitch = +clamp(angle * 0.6 - 1, -14, 8).toFixed(2);
        const confidence = saturate(0.6 + 0.25 * Math.min(1, (Math.abs(second.miss) - Math.abs(best.miss)) / 2) + 0.15 * vp.quality.total);
        if (confidence < base.minConfidence) continue;
        log.push({ attempt, stage: 'question', try: tried, ok: true, confidence: +confidence.toFixed(3), issues: [] });
        const target = { x, y, z: sight.z, height: TARGET_HEIGHT, heading: wrap360(bearing + 180), pitch: +sight.pitch.toFixed(2),
          skin: 'sniper', pose: 'prone', aimHeight: HEAD_HEIGHT };
        const quiz = {
          version: 1, mode: 'sniper', seed, difficulty, variant, lowConfidence: false,
          terrain: terrainSummary(model, interval, terrainCheck), camera,
          sniper: { target, bearing: +bearing.toFixed(3), elevation: +(Math.atan2(rise, horizontal) / DEG).toFixed(4),
            horizontal: +horizontal.toFixed(1), slant: +slant.toFixed(1), rise: +rise.toFixed(2), angle: +angle.toFixed(2),
            correctMark: mark, slantMark, rifle: RIFLE, marks: MARKS.map(m => ({ metres: m, mil: +MARK_MILS[m].toFixed(3) })) },
          heading: { degrees: camera.heading, ...formatHeading(camera.heading, 'exact'), mode: 'exact' },
          mapRotation: base.mapRotation ? rng.fork('rotation').pick([0, 90, 180, 270]) : 0,
          options, correctLabel: `${mark} m`, landmarks: landmarkSummary(model),
          quality: { total: vp.quality.total, ...vp.quality.components, blockedFrac: vp.quality.blockedFrac, edgeFrac: vp.quality.edgeFrac },
          validation: { ok: true, issues: [], confidence, margin: +(Math.abs(second.miss) - Math.abs(best.miss)).toFixed(3),
            uniqueness: saturate((Math.abs(second.miss) - Math.abs(best.miss)) / 1.5) },
          hardness: saturate((horizontal - 350) / 650 * 0.6 + Math.min(1, Math.abs(angle) / 15) * 0.4),
          stats: { viewpointsEvaluated: evaluated, terrainAttempt: attempt, ms: Math.round(now() - t0) }, log,
        };
        quiz.explanation = sniperExplanation(quiz);
        return quiz;
      }
    }
    log.push({ attempt, stage: 'question', try: tried, ok: false, confidence: 0, issues: ['no visible target with one clearly best holdover'] });
  }
  throw new Error('No clear sniper shot found. Try another seed or a lower difficulty.');
}

// ------------------------------------------------------------ explanation

const fmt = (v, d = 1) => Number(v).toFixed(d);

/** Same machine-readable shape as the other quiz explanations. */
export function sniperExplanation(quiz) {
  const s = quiz.sniper, uphill = s.rise >= 0;
  const correct = quiz.options.find(o => o.correct);
  const evidence = [
    { type: 'range', text: `The enemy's head is ${Math.round(s.horizontal)} m away horizontally and ${fmt(Math.abs(s.rise))} m ${uphill ? 'above' : 'below'} your eye `
      + `(${fmt(Math.abs(s.angle))}° ${uphill ? 'uphill' : 'downhill'}); the straight-line range is ${Math.round(s.slant)} m.`,
    data: { horizontalMetres: s.horizontal, riseMetres: s.rise, slantMetres: s.slant, angleDegrees: s.angle } },
    { type: 'rifleman-rule', text: 'Gravity only pulls across the horizontal distance, so up- and downhill shots use the mark for the horizontal range, '
      + `not the straight-line range${s.slantMark !== s.correctMark ? ` (${s.slantMark} m here, which shoots high)` : ''}.`,
    data: { correctMark: s.correctMark, slantMark: s.slantMark } },
    { type: 'ballistic-hit', text: `Holding the head on the ${correct.label} mark, the simulated round lands ${fmt(Math.abs(correct.miss * 100), 0)} cm ${correct.miss >= 0 ? 'high' : 'low'}, inside the head (±${HEAD_RADIUS * 100} cm).`,
      data: { mark: correct.metres, missMetres: correct.miss, muzzleVelocity: s.rifle.muzzle, zeroMetres: s.rifle.zero } },
    { type: 'ranging', text: `Ranging check: his ${SHOULDER_WIDTH.toFixed(2)} m shoulders at ${Math.round(s.slant)} m span ${fmt(SHOULDER_WIDTH * 1000 / s.slant, 2)} mil in the scope (metres = 500 / mil).`,
      data: { shoulderWidthMetres: SHOULDER_WIDTH, mils: +(SHOULDER_WIDTH * 1000 / s.slant).toFixed(3) } },
  ];
  const alternatives = quiz.options.filter(o => !o.correct).map(o => ({
    label: o.label, difference: Math.abs(o.miss), plausibility: o.metres === s.slantMark ? 'This is the mark for the straight-line range.' : '',
    status: 'distinguished',
    reasons: [{ type: 'holdover-miss', text: `The ${o.label} mark puts the round ${fmt(Math.abs(o.miss), 2)} m ${o.miss >= 0 ? 'high' : 'low'} of the head${o.miss > 0.2 ? ', over the target' : o.miss < -1.6 ? ', into the ground in front' : ''}.`,
      data: { mark: o.metres, missMetres: o.miss } }],
  }));
  return { version: 1, language: 'en', source: 'ballistic-trajectory-analysis', kind: 'holdover',
    correct: { label: quiz.correctLabel, summary: `The ${quiz.correctLabel} mark is the only hold that puts the round on the enemy sniper's head.`, evidence },
    closestLabels: [...alternatives].sort((a, b) => a.difference - b.difference).slice(0, 3).map(o => o.label), alternatives };
}

/** Deterministic per-quiz noise source (kept for future gusts; never wall-clock). */
export const sniperRandom = quiz => new Random(`${quiz.seed}|${quiz.difficulty}|${quiz.variant || 0}|sniper-v1`);
