// Locate a distant person from a known observer. Camera and target are separate
// world positions; wrong answers move only the person when compared afterwards.
import { SeedManager } from './rng.js';
import { getDifficulty, applyTuning } from './difficulty.js';
import { formatHeading } from './heading.js';
import { ViewpointGenerator } from './viewpoints.js';
import { buildTerrain, terrainSummary, landmarkSummary, now } from './quiz.js';
import { surfaceElevation, surfaceLineOfSight } from './terrainSurface.js';
import { DEG, saturate, angleDiff, wrap360 } from './grid.js';

export const FRIEND_HEIGHT = 1.8;
export const normaliseFriendChallenge = (value) => value === 'depth-trap' ? value : 'standard';

export function personSight(model, observer, point) {
  const distance = Math.hypot(point.x - observer.x, point.y - observer.y);
  const z = surfaceElevation(model, point.x, point.y);
  const elevation = Math.atan2(z + FRIEND_HEIGHT / 2 - observer.z, distance) / DEG;
  const angularHeight = (Math.atan2(z + FRIEND_HEIGHT - observer.z, distance)
    - Math.atan2(z - observer.z, distance)) / DEG;
  const bearing = wrap360(Math.atan2(point.x - observer.x, point.y - observer.y) / DEG);
  const visible = [0.25, 1.0, 1.65].every((height) => surfaceLineOfSight(model, observer, { ...point, z: z + height }));
  return { z, distance, bearing, elevation, angularHeight, visible };
}

// A local map keeps the three nearby spots distinct on a phone. The crop is
// determined by ALL candidates, so its framing cannot reveal the answer.
export function friendMapExtent(model, camera, options) {
  const pts = [camera, ...options];
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const size = Math.min(model.size, Math.max(400, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 170));
  const clampCentre = (v) => Math.max(size / 2, Math.min(model.size - size / 2, v));
  return { x: clampCentre((Math.min(...xs) + Math.max(...xs)) / 2),
    y: clampCentre((Math.min(...ys) + Math.max(...ys)) / 2), size };
}

export function generateFriendQuiz({ seed, difficulty = 'medium', variant = 0, headingMode = null,
  friendChallenge = 'standard', tuning = null, size, n, maxTerrainAttempts = 4, onProgress = () => {} }) {
  const t0 = now(), challenge = normaliseFriendChallenge(friendChallenge);
  const base = applyTuning(getDifficulty(difficulty), tuning);
  const heading = ['exact', 'cardinal', 'intercardinal'].includes(headingMode) ? headingMode : base.heading;
  const preset = { ...base, heading }, seeds = new SeedManager(`${seed}#${difficulty}`), log = [];
  const fov = 50, eyeHeight = 1.7;
  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating friend terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n });
    if (!terrainCheck.ok) { log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues }); continue; }
    const rng = seeds.stream('friend', attempt, challenge, heading, variant);
    const vg = new ViewpointGenerator(model, preset, rng.fork('viewpoints'), {
      fov, eyeHeight, gridSize: 12, margin: Math.min(280, model.size / 4), maxPicks: 48,
    });
    onProgress('Finding clear views of your friend');
    const { picked, evaluated } = vg.generate();
    for (const [t, vp] of picked.entries()) {
      if (vp.quality.total < base.minQuality) continue;
      const camera = { x: vp.x, y: vp.y, z: surfaceElevation(model, vp.x, vp.y) + eyeHeight,
        eyeHeight, heading: vp.heading, fov, pitch: 0, roll: 0 };
      // Try different lines through the landscape without moving the observer.
      for (let line = 0; line < 16; line++) {
        const centre = vp.heading + rng.range(-0.8, 0.8);
        const distances = [rng.range(65, 90), rng.range(125, 150), rng.range(205, 230)];
        const points = distances.map((distance, i) => {
          const az = centre + (challenge === 'depth-trap' ? 0 : [-5.5, 0, 5.5][i]);
          const x = camera.x + Math.sin(az * DEG) * distance, y = camera.y + Math.cos(az * DEG) * distance;
          const sight = personSight(model, camera, { x, y });
          return { x, y, ...sight };
        });
        if (points.some((p) => !model.inside(p.x, p.y, 30) || model.getSlope(p.x, p.y) > 26 || !p.visible)) continue;
        const separation = Math.min(...points.flatMap((a, i) => points.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
        if (separation < 45) continue;
        const chosen = rng.pick(points);
        camera.pitch = chosen.elevation;
        if (Math.abs(camera.pitch) > 24 || chosen.angularHeight < 0.38) continue;
        // Even identical bearings must differ enough in apparent height / size
        // to be distinguished at the 3× zoom (at least ~3 pixels on a phone).
        const difference = (a, b) => Math.max(angleDiff(a.bearing, b.bearing), Math.abs(a.elevation - b.elevation), Math.abs(a.angularHeight - b.angularHeight));
        const minDifference = Math.min(...points.filter((p) => p !== chosen).map((p) => difference(chosen, p)));
        if (minDifference < 0.18) continue;
        const options = rng.fork(`labels-${t}-${line}`).shuffle(points).map((p, i) => ({ ...p,
          label: ['A', 'B', 'C'][i], correct: p === chosen, landform: model.analyzer.classify(p.x, p.y), D: difference(chosen, p) }));
        const correctLabel = options.find((p) => p.correct).label;
        const confidence = saturate(0.55 + 0.25 * Math.min(1, minDifference / 0.6) + 0.2 * vp.quality.total);
        if (confidence < base.minConfidence) continue;
        log.push({ attempt, stage: 'question', try: t, ok: true, confidence: +confidence.toFixed(3), issues: [] });
        return {
          version: 1, mode: 'friend', seed, difficulty, variant, lowConfidence: false,
          terrain: terrainSummary(model, interval, terrainCheck), camera,
          friend: { x: chosen.x, y: chosen.y, z: chosen.z, height: FRIEND_HEIGHT, heading: wrap360(chosen.bearing + 180), challenge },
          mapExtent: friendMapExtent(model, camera, options),
          heading: { degrees: camera.heading, ...formatHeading(camera.heading, heading), mode: heading },
          mapRotation: base.mapRotation ? rng.fork('rotation').pick([0, 90, 180, 270]) : 0,
          options, correctLabel, landmarks: landmarkSummary(model),
          quality: { total: vp.quality.total, ...vp.quality.components, blockedFrac: vp.quality.blockedFrac,
            edgeFrac: vp.quality.edgeFrac, landmarksInView: vp.quality.landmarksInView },
          validation: { ok: true, issues: [], confidence, uniqueness: saturate(minDifference / 0.6),
            minDistance: minDifference, minRequiredDistance: 0.18, minSeparation: separation },
          hardness: saturate(1 - minDifference / 6),
          stats: { viewpointsEvaluated: evaluated, terrainAttempt: attempt, ms: Math.round(now() - t0) }, log,
        };
      }
    }
    log.push({ attempt, stage: 'question', try: picked.length, ok: false, confidence: 0, issues: ['no clear and distinguishable sighting'] });
  }
  throw new Error('No clear friend sighting found. Try another seed or a lower difficulty.');
}
