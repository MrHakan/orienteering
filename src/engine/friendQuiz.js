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
import { normaliseGridSize, gridCells, cellAt, cellAtExtent } from './gridQuiz.js';
import { normaliseFriendSkin } from './friendAppearance.js';
import { withAnswerExplanation } from './answerExplanation.js';

export const FRIEND_HEIGHT = 1.8;
export const normaliseFriendChallenge = (value) => value === 'depth-trap' ? value : 'standard';
export const normaliseFriendAnswer = (value) => value === 'grid' ? 'grid' : 'point';

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

/**
 * Grid answers put the friend exactly on a cell centre, so a small range or
 * bearing error never flips the answer to a neighbouring cell.
 */
export const friendOnCellCentre = (opts) => normaliseFriendAnswer(opts.friendAnswer) === 'grid';

/** Distance (fraction of a cell, 0.5 = centre) from a point to the nearest border of its cell. */
export function cellBorderMargin(x, y, extent, divisions) {
  const step = extent.size / normaliseGridSize(divisions);
  const lx = x - (extent.x - extent.size / 2), ly = y - (extent.y - extent.size / 2);
  const m = (v) => { const r = ((v % step) + step) % step; return Math.min(r, step - r); };
  return Math.min(m(lx), m(ly)) / step;
}

/**
 * Easy friend maps are local crops. Slide the crop (same size) so the friend
 * lands on a cell centre while every candidate and the observer stay well
 * inside it; null when that is impossible.
 */
export function centredFriendExtent(model, extent, friend, divisions, points, pad = 30) {
  const step = extent.size / normaliseGridSize(divisions), half = extent.size / 2;
  const shift = (v, origin) => { const local = v - (origin - half); return local - (Math.floor(local / step) + 0.5) * step; };
  const out = { ...extent, x: extent.x + shift(friend.x, extent.x), y: extent.y + shift(friend.y, extent.y) };
  if (out.x < half || out.y < half || out.x > model.size - half || out.y > model.size - half) return null;
  const inside = (p) => Math.abs(p.x - out.x) <= half - pad && Math.abs(p.y - out.y) <= half - pad;
  return points.every(inside) ? out : null;
}

/** Hypothetical observers: a shared jittered lattice, independent of the correct target. */
export function hypothesisLattice(model, grng, spacing = 48, margin = 70) {
  const grid = [];
  for (let y = margin; y < model.size - margin; y += spacing) for (let x = margin; x < model.size - margin; x += spacing) {
    const p = { x: x + grng.range(-15, 15), y: y + grng.range(-15, 15) };
    if (model.getSlope(p.x, p.y) <= 26) grid.push(p);
  }
  return grid;
}

/**
 * Grid answers (friend in a cell centre), from the look-alike sightings the viewer could confuse:
 * closestD (nearest view distance), rivals (sightings within band.max) and weakestCue (smallest
 * skyline cue among the near ones). hardness: how close and how many; confidence: how visible the
 * weakest cue is and how clear the view is.
 */
export function friendGridScore({ closestD, rivals, weakestCue, band, quality, blockedFrac, edgeFrac }) {
  return {
    hardness: saturate(0.65 * saturate(1 - (closestD - band.min) / (band.max - band.min)) + 0.35 * (1 - Math.exp(-(rivals - 1) / 4))),
    confidence: saturate(0.45 * saturate((weakestCue - 0.6) / 1.8) + 0.4 * saturate(quality / 0.8) + 0.15 * saturate(1 - 2 * blockedFrac - 2 * edgeFrac)),
  };
}

/** The best three candidates, minus any much easier than the best (no 'too easy' day by chance). */
export const friendShortlist = (sorted, floor = 0.15) => sorted.slice(0, 3).filter((q) => q.hardness >= sorted[0].hardness - floor);

export function generateFriendQuiz(opts) {
  const quiz = opts.difficulty === 'easy' ? generateKnownFriendQuiz(opts) : generateTerrainFriendQuiz(opts);
  return withAnswerExplanation(finishFriendQuiz(quiz, opts));
}

export function finishFriendQuiz(quiz, opts) {
  quiz.friend.answerMode = normaliseFriendAnswer(opts.friendAnswer);
  quiz.friend.skin = normaliseFriendSkin(opts.friendSkin);
  if (quiz.friend.answerMode !== 'grid') return quiz;
  const size = normaliseGridSize(opts.gridSize), extent = quiz.mapExtent;
  const correctLabel = cellAtExtent(quiz.friend.x, quiz.friend.y, extent, size);
  // Keep the qualified sighting and its terrain matches intact. The generators
  // already placed the friend on a cell centre of this extent (friendOnCellCentre).
  quiz.friend.matches = quiz.options;
  quiz.grid = { size, origin: 'friend-cell-centre', cellMetres: extent.size / size,
    target: { x: quiz.friend.x, y: quiz.friend.y } };
  quiz.options = gridCells(extent.size, size).map(p => ({ ...p,
    x: p.x + extent.x - extent.size / 2, y: p.y + extent.y - extent.size / 2,
    correct: p.label === correctLabel }));
  quiz.correctLabel = correctLabel;
  return quiz;
}

// Each answer has a physically valid observation point at the SAME range and
// bearing. Full-body visibility and matched apparent height prevent distance
// alone from eliminating a letter. Only one observer's terrain view matches.
function generateTerrainFriendQuiz({ seed, world = 'classic', difficulty = 'medium', variant = 0, headingMode = null,
  friendChallenge = 'standard', friendAnswer = 'point', gridSize = 4, tuning = null, size, n, maxTerrainAttempts = 4, onProgress = () => {} }) {
  const centred = friendOnCellCentre({ friendAnswer }), divisions = normaliseGridSize(gridSize);
  const t0 = now(), challenge = normaliseFriendChallenge(friendChallenge);
  const base = applyTuning(getDifficulty(difficulty), tuning), band = FRIEND_BANDS[difficulty] || FRIEND_BANDS.medium;
  const heading = ['exact', 'cardinal', 'intercardinal'].includes(headingMode) ? headingMode : base.heading;
  const preset = { ...base, heading }, seeds = new SeedManager(`${seed}#${difficulty}`), log = [];
  const fov = 50, eyeHeight = 1.7, elevationTolerance = challenge === 'depth-trap' ? 0.25 : 0.5;
  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating friend terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n, world });
    if (!terrainCheck.ok) { log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues }); continue; }
    const rng = seeds.stream('friend-terrain', attempt, challenge, heading, variant);
    const vg = new ViewpointGenerator(model, preset, rng.fork('viewpoints'), {
      fov, eyeHeight, gridSize: 12, margin: Math.min(280, model.size / 4), maxPicks: 48,
    });
    onProgress('Matching ranges and searching terrain look-alikes');
    const { picked, evaluated } = vg.generate();
    const margin = 70, grid = hypothesisLattice(model, rng.fork('hypotheses'), 48, margin);
    const valid = [], farScans = new Map();
    let considered = 0;
    // Grid answers: the friend stands on a cell centre of the full-map grid.
    const cells = centred ? gridCells(model.size, divisions) : null;
    const centres = centred ? cells.filter((c) => model.inside(c.x, c.y, margin) && model.getSlope(c.x, c.y) <= 26) : null;
    for (const [t, vp] of picked.entries()) {
      if (vp.quality.total < base.minQuality) continue;
      const camera = { x: vp.x, y: vp.y, z: surfaceElevation(model, vp.x, vp.y) + eyeHeight,
        eyeHeight, heading: vp.heading, fov, pitch: 0, roll: 0 };
      // Centres in range near the scored view direction; the camera turns to face the chosen one.
      // Coarse grids (few centres in range) may turn up to 70°, still checked below with the turned view.
      let lines = null;
      if (centred) {
        const near = centres.map((c) => ({ c, d: Math.hypot(c.x - camera.x, c.y - camera.y), b: wrap360(Math.atan2(c.x - camera.x, c.y - camera.y) / DEG) }))
          .filter((o) => o.d >= 125 && o.d <= 215);
        const crng = rng.fork(`centres-${t}`);
        lines = crng.shuffle(near.filter((o) => angleDiff(o.b, vp.heading) <= 35));
        if (!lines.length) lines = crng.shuffle(near.filter((o) => angleDiff(o.b, vp.heading) <= 70));
        lines = lines.slice(0, 4);
      }
      for (let line = 0; line < (centred ? lines.length : 4); line++) {
        let distance, bearing;
        if (centred) {
          ({ d: distance, b: bearing } = lines[line]);
          camera.heading = wrap360(Math.round(bearing + rng.range(-3, 3)));
        } else {
          distance = rng.range(130, 210); bearing = wrap360(vp.heading + rng.range(-3, 3));
        }
        const dx = centred ? lines[line].c.x - camera.x : Math.sin(bearing * DEG) * distance;
        const dy = centred ? lines[line].c.y - camera.y : Math.cos(bearing * DEG) * distance;
        const target = centred ? { x: lines[line].c.x, y: lines[line].c.y } : { x: camera.x + dx, y: camera.y + dy };
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
        const pool = [], targetCell = centred ? cellAt(target.x, target.y, model.size, divisions) : null;
        // Another place for the friend, seen at the same range, bearing and eye-level angle from `observer`.
        const consistent = (observer, point) => Math.abs(Math.atan2(surfaceElevation(model, point.x, point.y) + FRIEND_HEIGHT / 2 - observer.z, distance) / DEG
          - chosen.elevation) <= elevationTolerance && personSight(model, observer, point).visible;
        let ambiguous = false;
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
          // Grid answers: the same sighting from a spot whose friend lies in another cell is a second answer.
          if (centred && D < band.min && cellAt(point.x, point.y, model.size, divisions) !== targetCell) { ambiguous = true; break; }
          if (desc.edgeFrac > 0.3 || desc.blockedFrac > 0.5 || D < band.min || D > band.max) continue;
          const cue = distinguishingCue(correctDesc, desc);
          const cueOffset = wrap360(cue.bearing - camera.heading + 180) - 180;
          const cueColumn = Math.max(0, Math.min(32, Math.round((cueOffset + fov / 2) / fov * 32)));
          if (cue.magnitude < band.cue || Math.abs(correctDesc.horizon[cueColumn] - camera.pitch) > 14) continue;
          pool.push({ ...point, ...sight, observer, D, cue, desc });
        }
        if (ambiguous) continue;
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
        let hardness = saturate(1 - ((pair[0].D + pair[1].D) / 2 - band.min) / (band.max - band.min)), reported = confidence, gridChecks = {};
        if (centred) {
          // Every other cell centre that gives the same sighting: none may look the same.
          const alts = pair.map((p) => ({ D: p.D, cue: p.cue.magnitude }));
          let twin = false;
          for (const c of cells) {
            if (c.label === targetCell) continue;
            const p = { x: c.x - dx, y: c.y - dy };
            if (!model.inside(p.x, p.y, 0) || model.getSlope(p.x, p.y) > 26 || model.getSlope(c.x, c.y) > 26) continue;
            const observer = { ...camera, ...p, z: surfaceElevation(model, p.x, p.y) + eyeHeight };
            if (!consistent(observer, c)) continue;
            const desc = describe(observer), D = descriptorDistance(correctDesc, desc);
            if (D < band.min) { twin = true; break; }
            if (D <= band.max) alts.push({ D, cue: distinguishingCue(correctDesc, desc).magnitude });
          }
          if (twin) continue;
          const nearest = alts.reduce((a, b) => b.D < a.D ? b : a), near = alts.filter((a) => a.D < 2 * band.min);
          const summary = { closestD: nearest.D, rivals: alts.length, weakestCue: Math.min(...(near.length ? near : [nearest]).map((a) => a.cue)) };
          ({ hardness, confidence: reported } = friendGridScore({ ...summary, band, quality: vp.quality.total,
            blockedFrac: correctDesc.blockedFrac, edgeFrac: correctDesc.edgeFrac }));
          gridChecks = { rivalCells: summary.rivals, weakestCue: +summary.weakestCue.toFixed(2), lookalikeElsewhere: false };
        }
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
          validation: { ok: true, issues: [], confidence: reported, uniqueness: saturate(minDifference / (band.min * 2)),
            minDistance: minDifference, minRequiredDistance: band.min, minSeparation: separation,
            rangeSpread: Math.max(...options.map((p) => p.distance)) - Math.min(...options.map((p) => p.distance)),
            maxApparentHeightDifference: Math.max(...options.map((p) => Math.abs(p.angularHeight - chosen.angularHeight))),
            elevationTolerance, minCue: band.cue, ...gridChecks },
          hardness,
          stats: { viewpointsEvaluated: evaluated, terrainAttempt: attempt, viewTry: t }, log,
        };
        valid.push(q);
        if (centred) {
          // Lazy, for the final pick only: the same sighting from any lattice spot whose friend is in
          // another cell and at least 240 m away. Returns the smallest view distance (stops below band.min).
          const cam = { ...camera };
          farScans.set(q, () => {
            let min = Infinity;
            for (const p of grid) {
              const point = { x: p.x + dx, y: p.y + dy };
              if (Math.hypot(point.x - target.x, point.y - target.y) < 240 || !model.inside(point.x, point.y, 0) || model.getSlope(point.x, point.y) > 26
                || cellAt(point.x, point.y, model.size, divisions) === targetCell) continue;
              const observer = { ...cam, ...p, z: surfaceElevation(model, p.x, p.y) + eyeHeight };
              if (!consistent(observer, point)) continue;
              min = Math.min(min, descriptorDistance(correctDesc, describe(observer)));
              if (min < band.min) break;
            }
            return min;
          });
        }
        break;
      }
      // Centred targets constrain the geometry, so compare more views before settling.
      if (valid.length && t + 1 >= band.search * (centred ? 2 : 1)) break;
      if (t % 4 === 3) onProgress(`Checking terrain matches (${t + 1}/${picked.length})`);
    }
    if (valid.length) {
      valid.sort((a, b) => b.hardness - a.hardness);
      let q;
      if (centred) {
        // A clean shortlist candidate; else the hardest clean one; else the least ambiguous, flagged.
        const far = new Map(), farD = (v) => { if (!far.has(v)) far.set(v, farScans.get(v)()); return far.get(v); };
        const clean = friendShortlist(valid).filter((v) => farD(v) >= band.min);
        q = clean.length ? rng.fork('shortlist').pick(clean) : valid.find((v) => farD(v) >= band.min);
        if (!q) {
          q = valid.reduce((a, v) => farD(v) > farD(a) ? v : a);
          q.validation.lookalikeElsewhere = true;
          q.validation.confidence = Math.min(q.validation.confidence, 0.4);
        }
      } else q = rng.fork('shortlist').pick(valid.slice(0, 3));
      q.stats = { ...q.stats, questionsCompared: valid.length, distractorCandidates: considered, ms: Math.round(now() - t0) };
      log.push({ attempt, stage: 'question', try: q.stats.viewTry, ok: true, confidence: +q.validation.confidence.toFixed(3), issues: [] });
      return q;
    }
    log.push({ attempt, stage: 'question', try: picked.length, ok: false, confidence: 0, issues: ['no matched-range terrain sighting'] });
  }
  throw new Error('No clear friend sighting found. Try another seed or a lower difficulty.');
}

function generateKnownFriendQuiz({ seed, world = 'classic', difficulty = 'medium', variant = 0, headingMode = null,
  friendChallenge = 'standard', friendAnswer = 'point', gridSize = 4, tuning = null, size, n, maxTerrainAttempts = 4, onProgress = () => {} }) {
  const centred = friendOnCellCentre({ friendAnswer });
  const t0 = now(), challenge = normaliseFriendChallenge(friendChallenge);
  const base = applyTuning(getDifficulty(difficulty), tuning);
  const heading = ['exact', 'cardinal', 'intercardinal'].includes(headingMode) ? headingMode : base.heading;
  const preset = { ...base, heading }, seeds = new SeedManager(`${seed}#${difficulty}`), log = [];
  const fov = 50, eyeHeight = 1.7;
  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating friend terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n, world });
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
        let mapExtent = friendMapExtent(model, camera, options);
        if (centred) {
          mapExtent = centredFriendExtent(model, mapExtent, chosen, gridSize, [camera, ...options]);
          if (!mapExtent) continue;
        }
        log.push({ attempt, stage: 'question', try: t, ok: true, confidence: +confidence.toFixed(3), issues: [] });
        return {
          version: 1, mode: 'friend', seed, difficulty, variant, lowConfidence: false,
          terrain: terrainSummary(model, interval, terrainCheck), camera,
          friend: { x: chosen.x, y: chosen.y, z: chosen.z, height: FRIEND_HEIGHT, heading: wrap360(chosen.bearing + 180), challenge, observerHidden: false },
          mapExtent,
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
