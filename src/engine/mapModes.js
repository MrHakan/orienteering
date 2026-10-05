// Shared pieces for the map-reading modes (resection, route choice,
// intervisibility, profile matching, drainage, fog navigation): mode list,
// the 15-second clip cameras, neutral quality fields and quiz scaffolding.

import { SeedManager } from './rng.js';
import { getDifficulty, applyTuning } from './difficulty.js';
import { buildTerrain, terrainSummary, landmarkSummary, now } from './quiz.js';
import { surfaceElevation } from './terrainSurface.js';
import { DEG, clamp, lerp, smoothstep, wrap360 } from './grid.js';
import { formatHeading } from './heading.js';

export const MAP_MODES = Object.freeze({
  resection: { label: 'Resection — bearings to peaks', title: 'WHERE ARE YOU? · BEARINGS' },
  route: { label: 'Route choice — fastest way', title: 'WHICH ROUTE IS FASTEST?' },
  visibility: { label: 'Intervisibility — what can you see?', title: 'WHICH POINT CAN YOU SEE?' },
  profile: { label: 'Profile — match the cross-section', title: 'WHICH PROFILE?' },
  drainage: { label: 'Drainage — where does the water go?', title: 'WHERE DOES THE WATER GO?' },
  fog: { label: 'Fog navigation — near terrain only', title: 'LOST IN THE FOG' },
});
export const isMapMode = (q) => !!q && Object.hasOwn(MAP_MODES, q.mode);
export const CLIP_DURATION = 15;

/** Quality fields the facts panel expects; map questions are not scored on a view. */
export const neutralQuality = (total = 0.6) => ({ total, skylineComplexity: 0, landmarkVisibility: 0, terrainVariation: 0,
  ridgeValleyInformation: 0, foregroundInformation: 0, orientationIdentifiability: 0, occlusionPenalty: 0, blockedFrac: 0, edgeFrac: 0 });

/** Terrain attempts with the usual validation; yields { model, interval, terrainCheck, rng, attempt }. */
export function* terrains({ seed, world = 'classic', difficulty, variant = 0, tuning = null, size, n, maxTerrainAttempts = 5, onProgress = () => {} }, stream) {
  const base = applyTuning(getDifficulty(difficulty), tuning), seeds = new SeedManager(`${seed}#${difficulty}`);
  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating terrain (attempt ${attempt + 1})`);
    const built = buildTerrain({ seed, difficulty, attempt, preset: base, seeds, size, n, world });
    if (!built.terrainCheck.ok) continue;
    yield { ...built, base, attempt, rng: seeds.stream(stream, attempt, variant) };
  }
}

/** Common quiz fields; `extra` carries the mode's own data, options and explanation. */
export function scaffold({ mode, seed, difficulty, variant, model, interval, terrainCheck, base, camera, t0, attempt, extra }) {
  return {
    version: 1, mode, seed, difficulty, variant, lowConfidence: false,
    terrain: terrainSummary(model, interval, terrainCheck), camera,
    heading: { degrees: camera.heading, ...formatHeading(camera.heading, 'exact'), mode: 'exact' },
    mapRotation: 0, landmarks: landmarkSummary(model), quality: neutralQuality(),
    validation: { ok: true, issues: [], confidence: 0.8, uniqueness: 0.8 }, hardness: 0.5,
    stats: { viewpointsEvaluated: 0, terrainAttempt: attempt, ms: Math.round(now() - t0) }, log: [],
    ...extra,
  };
}

// ------------------------------------------------------------------ clips

/**
 * Drone overview: a slow 24° orbit around `centre`, low enough that the relief
 * reads against the sky, without revealing sightlines or water paths directly.
 */
export function droneCamera(model, centre, t = 0, { radius = 1100, height = 340, heading = 200 } = {}) {
  const h = wrap360(heading + 24 * clamp(t / CLIP_DURATION, 0, 1));
  const x = centre.x - Math.sin(h * DEG) * radius, y = centre.y - Math.cos(h * DEG) * radius;
  const ground = surfaceElevation(model, centre.x, centre.y);
  const z = Math.max(ground + height, surfaceElevation(model, x, y) + 120);
  // Look a little beyond the centre so the far relief stands against the sky.
  const pitch = -0.62 * Math.atan2(z - ground, radius) / DEG;
  return { x, y, z, eyeHeight: z - surfaceElevation(model, x, y), heading: h, fov: 52, pitch, roll: 0 };
}

/** Look from a fixed eye towards a sequence of bearings, holding each (resection). */
export function panCamera(base, targets, t) {
  const n = targets.length, slot = CLIP_DURATION / n, i = clamp(Math.floor(t / slot), 0, n - 1);
  const local = (t - i * slot) / slot, move = smoothstep(0, 0.35, local);
  const from = i === 0 ? targets[0] : targets[i - 1], to = targets[i];
  const turn = wrap360(to.heading - from.heading + 180) - 180;
  return { ...base, heading: wrap360(from.heading + turn * (i === 0 ? 1 : move)), pitch: lerp(from.pitch, to.pitch, i === 0 ? 1 : move), focus: i };
}

/** Short walk into the final position (fog navigation): parallax from the near ground. */
export function walkCamera(model, end, heading, t, { distance = 26, eyeHeight = 1.7 } = {}) {
  const k = smoothstep(0, 10, t), back = distance * (1 - k);
  const x = end.x - Math.sin(heading * DEG) * back, y = end.y - Math.cos(heading * DEG) * back;
  const bob = Math.sin(t * Math.PI * 3.6) * 0.035 * (1 - smoothstep(9, 10, t));
  return { x, y, z: surfaceElevation(model, x, y) + eyeHeight + bob, eyeHeight, heading, fov: 60, pitch: -4, roll: 0 };
}

/** Elevation profile sampled every `step` metres along a polyline. */
export function profileAlong(model, a, b, samples = 64) {
  return Array.from({ length: samples }, (_, i) => {
    const t = i / (samples - 1);
    return +surfaceElevation(model, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t).toFixed(2);
  });
}

export const bearingTo = (a, b) => wrap360(Math.atan2(b.x - a.x, b.y - a.y) / DEG);
export const bearingText = (v) => `${String(Math.round(wrap360(v)) % 360).padStart(3, '0')}°`;
