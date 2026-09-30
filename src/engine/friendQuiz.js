// Locate a distant person from our observer's POV. Easy marks the observer;
// terrain challenges match each target with a plausible, unmarked observer.
import { SeedManager } from './rng.js';
import { getDifficulty, applyTuning } from './difficulty.js';
import { formatHeading } from './heading.js';
import { ViewpointGenerator } from './viewpoints.js';
import { buildTerrain, terrainSummary, landmarkSummary, now } from './quiz.js';
import { surfaceElevation, surfaceLineOfSight } from './terrainSurface.js';
import { descriptorDistance } from './skyline.js';
import { distinguishingCue } from './quizCandidates.js';
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

const FRIEND_BANDS = {
  medium: { min: 1.5, max: 6, cue: 1.4, search: 6 },
  hard: { min: 1.1, max: 4.5, cue: 1.2, search: 10 },
  expert: { min: 0.9, max: 3.8, cue: 1.1, search: 14 },
  master: { min: 0.8, max: 3.2, cue: 1.0, search: 20 },
};

/** The question map must not expose a hidden observer through a marker or cone. */
export function friendObserver(quiz) {
  return quiz.mode === 'friend' && !quiz.friend.observerHidden ? quiz.camera : null;
}

/** Answer comparisons remain an observer's POV, never the friend's POV. */
export function friendOptionCamera(quiz, option) {
  return quiz.friend.observerHidden ? option.observer : quiz.camera;
}

export function generateFriendQuiz(opts) {
  if (opts.difficulty === 'easy') return generateKnownFriendQuiz(opts);
  return generateTerrainFriendQuiz(opts);
}

// Each answer has a physically valid observation point at the SAME range and
// bearing. Full-body visibility and matched apparent height prevent distance
// alone from eliminating a letter. Only one observer's terrain view matches.
function generateTerrainFriendQuiz({ seed, difficulty = 'medium', variant = 0, headingMode = null,
  friendChallenge = 'standard', tuning = null, size, n, maxTerrainAttempts = 4, onProgress = () => {} }) {
  const t0 = now(), challenge = normaliseFriendChallenge(friendChallenge);
  const base = applyTuning(getDifficulty(difficulty), tuning), band = FRIEND_BANDS[difficulty] || FRIEND_BANDS.medium;
  const heading = ['exact', 'cardinal', 'intercardinal'].includes(headingMode) ? headingMode : base.heading;
  const preset = { ...base, heading }, seeds = new SeedManager(`${seed}#${difficulty}`), log = [];
  const fov = 50, eyeHeight = 1.7, elevationTolerance = challenge === 'depth-trap' ? 0.25 : 0.5;
  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating friend terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n });
    if (!terrainCheck.ok) { log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues }); continue; }
    const rng = seeds.stream('friend-terrain', attempt, challenge, heading, variant);
    const vg = new ViewpointGenerator(model, preset, rng.fork('viewpoints'), {
      fov, eyeHeight, gridSize: 12, margin: Math.min(280, model.size / 4), maxPicks: 48,
    });
    onProgress('Matching ranges and searching terrain look-alikes');
    const { picked, evaluated } = vg.generate();
    // A shared jittered lattice is independent of the correct target.
    const grid = [], grng = rng.fork('hypotheses'), spacing = 48, margin = 70;
    for (let y = margin; y < model.size - margin; y += spacing) for (let x = margin; x < model.size - margin; x += spacing) {
      const p = { x: x + grng.range(-15, 15), y: y + grng.range(-15, 15) };
      if (model.getSlope(p.x, p.y) <= 26) grid.push(p);
    }
    const valid = [];
    let considered = 0;
    for (const [t, vp] of picked.entries()) {
      if (vp.quality.total < base.minQuality) continue;
      const camera = { x: vp.x, y: vp.y, z: surfaceElevation(model, vp.x, vp.y) + eyeHeight,
        eyeHeight, heading: vp.heading, fov, pitch: 0, roll: 0 };
      for (let line = 0; line < 4; line++) {
        const distance = rng.range(130, 210), bearing = wrap360(vp.heading + rng.range(-3, 3));
        const dx = Math.sin(bearing * DEG) * distance, dy = Math.cos(bearing * DEG) * distance;
        const target = { x: camera.x + dx, y: camera.y + dy };
        if (!model.inside(target.x, target.y, margin) || model.getSlope(target.x, target.y) > 26) continue;
        const chosen = { ...target, ...personSight(model, camera, target) };
        if (!chosen.visible || Math.abs(chosen.elevation) > 16 || chosen.angularHeight < 0.45) continue;
        camera.pitch = chosen.elevation;
        const describe = (c) => model.skyline.viewDescriptor(c.x, c.y, c.heading, fov, {
          eyeHeight: c.z - model.getElevation(c.x, c.y), columns: 33,
        });
        const correctDesc = describe(camera);
        const targetLandform = model.analyzer.classify(chosen.x, chosen.y);
        const formGroup = (form) => ['valley', 'reentrant'].includes(form) ? 'hollow'
          : ['ridge', 'spur'].includes(form) ? 'crest' : form;
        // Terrain above the friend must actually be in the wide frame.
        const inFrame = Array.from(correctDesc.horizon).filter((h) => Math.abs(h - camera.pitch) < 14).length;
        if (inFrame < 20 || correctDesc.edgeFrac > 0.3 || correctDesc.blockedFrac > 0.5) continue;
        const pool = [];
        for (const p of grid) {
          if (Math.hypot(p.x - camera.x, p.y - camera.y) < 280) continue;
          const point = { x: p.x + dx, y: p.y + dy };
          if (!model.inside(point.x, point.y, margin) || model.getSlope(point.x, point.y) > 26) continue;
          if (['expert', 'master'].includes(difficulty)
            && formGroup(model.analyzer.classify(point.x, point.y)) !== formGroup(targetLandform)) continue;
          const observer = { ...camera, ...p, z: surfaceElevation(model, p.x, p.y) + eyeHeight };
          // Cheap height filtering precedes the dense triangle-surface LOS.
          const z = surfaceElevation(model, point.x, point.y);
          const elevation = Math.atan2(z + FRIEND_HEIGHT / 2 - observer.z, distance) / DEG;
          if (Math.abs(elevation - chosen.elevation) > elevationTolerance) continue;
          const sight = personSight(model, observer, point);
          if (!sight.visible || Math.abs(sight.angularHeight - chosen.angularHeight) > 0.015) continue;
          considered++;
          const desc = describe(observer), D = descriptorDistance(correctDesc, desc);
          if (desc.edgeFrac > 0.3 || desc.blockedFrac > 0.5 || D < band.min || D > band.max) continue;
          const cue = distinguishingCue(correctDesc, desc);
          const cueOffset = wrap360(cue.bearing - camera.heading + 180) - 180;
          const cueColumn = Math.max(0, Math.min(32, Math.round((cueOffset + fov / 2) / fov * 32)));
          if (cue.magnitude < band.cue || Math.abs(correctDesc.horizon[cueColumn] - camera.pitch) > 14) continue;
          pool.push({ ...point, ...sight, observer, D, cue, desc });
        }
        // Prefer similar terrain; do not stop at the first legal pair.
        pool.sort((a, b) => a.D - b.D);
        let pair = null, cost = Infinity;
        for (let i = 0; i < Math.min(pool.length, 24); i++) for (let j = i + 1; j < Math.min(pool.length, 40); j++) {
          const a = pool[i], b = pool[j];
          if (Math.hypot(a.x - b.x, a.y - b.y) < 280 || descriptorDistance(a.desc, b.desc) < band.min * 0.8) continue;
          const next = a.D + b.D;
          if (next < cost) { cost = next; pair = [a, b]; }
        }
        if (!pair) continue;
        const points = [{ ...chosen, observer: { ...camera }, D: 0 }, ...pair.map(({ desc, ...p }) => p)];
        const minDifference = Math.min(...pair.map((p) => p.D));
        const confidence = saturate(0.5 + 0.25 * Math.min(1, minDifference / band.min - 0.5) + 0.25 * vp.quality.total);
        if (confidence < base.minConfidence) continue;
        const hardness = saturate(1 - ((pair[0].D + pair[1].D) / 2 - band.min) / (band.max - band.min));
        const options = rng.fork(`labels-${t}-${line}`).shuffle(points).map((p, i) => ({
          ...p, label: ['A', 'B', 'C'][i], correct: p.D === 0, landform: model.analyzer.classify(p.x, p.y),
        }));
        const separation = Math.min(...options.flatMap((a, i) => options.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
        const q = {
          version: 2, mode: 'friend', seed, difficulty, variant, lowConfidence: false,
          terrain: terrainSummary(model, interval, terrainCheck), camera: { ...camera },
          friend: { x: chosen.x, y: chosen.y, z: chosen.z, height: FRIEND_HEIGHT,
            heading: wrap360(chosen.bearing + 180), challenge, observerHidden: true },
          // Fixed full-map framing cannot leak the correct observer or target.
          mapExtent: { x: model.size / 2, y: model.size / 2, size: model.size },
          heading: { degrees: camera.heading, ...formatHeading(camera.heading, heading), mode: heading },
          mapRotation: base.mapRotation ? rng.fork(`rotation-${t}-${line}`).pick([0, 90, 180, 270]) : 0,
          options, correctLabel: options.find((p) => p.correct).label, landmarks: landmarkSummary(model),
          quality: { total: vp.quality.total, ...vp.quality.components, blockedFrac: correctDesc.blockedFrac,
            edgeFrac: correctDesc.edgeFrac, landmarksInView: vp.quality.landmarksInView },
          validation: { ok: true, issues: [], confidence, uniqueness: saturate(minDifference / (band.min * 2)),
            minDistance: minDifference, minRequiredDistance: band.min, minSeparation: separation,
            rangeSpread: Math.max(...options.map((p) => p.distance)) - Math.min(...options.map((p) => p.distance)),
            maxApparentHeightDifference: Math.max(...options.map((p) => Math.abs(p.angularHeight - chosen.angularHeight))),
            elevationTolerance, minCue: band.cue },
          hardness,
          stats: { viewpointsEvaluated: evaluated, terrainAttempt: attempt, viewTry: t }, log,
        };
        valid.push(q);
        break;
      }
      if (valid.length && t + 1 >= band.search) break;
      if (t % 4 === 3) onProgress(`Checking terrain matches (${t + 1}/${picked.length})`);
    }
    if (valid.length) {
      valid.sort((a, b) => b.hardness - a.hardness);
      const q = rng.fork('shortlist').pick(valid.slice(0, 3));
      q.stats = { ...q.stats, questionsCompared: valid.length, distractorCandidates: considered, ms: Math.round(now() - t0) };
      log.push({ attempt, stage: 'question', try: q.stats.viewTry, ok: true, confidence: +q.validation.confidence.toFixed(3), issues: [] });
      return q;
    }
    log.push({ attempt, stage: 'question', try: picked.length, ok: false, confidence: 0, issues: ['no matched-range terrain sighting'] });
  }
  throw new Error('No clear friend sighting found. Try another seed or a lower difficulty.');
}

function generateKnownFriendQuiz({ seed, difficulty = 'medium', variant = 0, headingMode = null,
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
          friend: { x: chosen.x, y: chosen.y, z: chosen.z, height: FRIEND_HEIGHT, heading: wrap360(chosen.bearing + 180), challenge, observerHidden: false },
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
