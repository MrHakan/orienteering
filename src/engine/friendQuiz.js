// Locate a distant person from our observer's POV. Easy marks the observer;
// terrain challenges match each target with a plausible, unmarked observer.
import { SeedManager } from './rng.js';
import { getDifficulty, applyTuning } from './difficulty.js';
import { formatHeading } from './heading.js';
import { ViewpointGenerator } from './viewpoints.js';
import { buildTerrain, terrainSummary, landmarkSummary, now } from './quiz.js';
import { surfaceElevation, surfaceLineOfSight } from './terrainSurface.js';
import { descriptorDistance, horizonDistance } from './skyline.js';
import { distinguishingCue } from './quizCandidates.js';
import { DEG, saturate, angleDiff, wrap360 } from './grid.js';
import { normaliseGridSize, gridCells, cellAt, cellAtExtent } from './gridQuiz.js';
import { normaliseFriendSkin } from './friendAppearance.js';
import { withAnswerExplanation } from './answerExplanation.js';
import {
  normaliseGen, GEN2_FRIEND_THRESHOLDS, qualifiedMapSummits, sweepPanoramas,
  discoverPanoramaHeadings, fastWindowCheck, analyzeSkylineFrame, interiorHorizonCue, mapReasoningMetrics,
} from './gen2.js';

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
/**
 * Grid answers: a sighting from another cell whose view is closer than this is a second answer.
 * A skilled viewer tells views apart from the Master floor up, so the limit is the same at every
 * level (the higher Medium–Expert floors only keep the A/B/C matches easy).
 */
export const FRIEND_LOOKALIKE_LIMIT = FRIEND_BANDS.master.min;

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

/**
 * A grid question with a look-alike sighting in another cell is kept only when no clean one exists;
 * its numbers then rank it below clean questions (confidence ≤ 0.4, hardness ≤ 0.3) and it is marked
 * low-confidence (validation.ok false), so the explanation carries a caution.
 */
export function flagLookalike(q) {
  q.lowConfidence = true;
  Object.assign(q.validation, { ok: false, issues: [...q.validation.issues, 'look-alike sighting in another cell'], lookalikeElsewhere: true });
  q.validation.confidence = Math.min(q.validation.confidence, 0.4);
  q.hardness = Math.min(q.hardness, 0.3);
  return q;
}

/** The best three candidates, minus any much easier than the best (no 'too easy' day by chance). */
export const friendShortlist = (sorted, floor = 0.15) => sorted.slice(0, 3).filter((q) => q.hardness >= sorted[0].hardness - floor);

/** The terrain model each generated friend question was built on, so the explanation does not rebuild it. */
const generationModel = new WeakMap();

export function generateFriendQuiz(opts) {
  const quiz = opts.difficulty === 'easy'
    ? generateKnownFriendQuiz(opts)
    : normaliseGen(opts.gen) === 2 ? generateTerrainFriendQuizGen2(opts) : generateTerrainFriendQuiz(opts);
  return withAnswerExplanation(finishFriendQuiz(quiz, opts), generationModel.get(quiz));
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
    // twins: view distance of a look-alike sighting already found in another cell (grid answers).
    const valid = [], farScans = new Map(), twins = new Map(), twinD = FRIEND_LOOKALIKE_LIMIT;
    let clean = 0;
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
        let twin = Infinity;
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
          if (centred && D < twinD && cellAt(point.x, point.y, model.size, divisions) !== targetCell) twin = Math.min(twin, D);
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
        let hardness = saturate(1 - ((pair[0].D + pair[1].D) / 2 - band.min) / (band.max - band.min)), reported = confidence, gridChecks = {};
        if (centred) {
          // Every other cell centre that gives the same sighting: none may look the same.
          const alts = pair.map((p) => ({ D: p.D, cue: p.cue.magnitude }));
          for (const c of cells) {
            if (c.label === targetCell) continue;
            const p = { x: c.x - dx, y: c.y - dy };
            if (!model.inside(p.x, p.y, 0) || model.getSlope(p.x, p.y) > 26 || model.getSlope(c.x, c.y) > 26) continue;
            const observer = { ...camera, ...p, z: surfaceElevation(model, p.x, p.y) + eyeHeight };
            if (!consistent(observer, c)) continue;
            const desc = describe(observer), D = descriptorDistance(correctDesc, desc);
            if (D < twinD) twin = Math.min(twin, D);
            if (D <= band.max) alts.push({ D, cue: distinguishingCue(correctDesc, desc).magnitude });
          }
          const nearest = alts.reduce((a, b) => b.D < a.D ? b : a), near = alts.filter((a) => a.D < 2 * band.min);
          const summary = { closestD: nearest.D, rivals: alts.length, weakestCue: Math.min(...(near.length ? near : [nearest]).map((a) => a.cue)) };
          ({ hardness, confidence: reported } = friendGridScore({ ...summary, band, quality: vp.quality.total,
            blockedFrac: correctDesc.blockedFrac, edgeFrac: correctDesc.edgeFrac }));
          gridChecks = { rivalCells: summary.rivals, weakestCue: +summary.weakestCue.toFixed(2), lookalikeElsewhere: false, lookalikeLimit: twinD };
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
        generationModel.set(q, model);
        if (centred) log.push({ attempt, stage: 'candidate', try: t, line, ok: !(twin < twinD), confidence: +reported.toFixed(3),
          hardness: +hardness.toFixed(4), issues: twin < twinD ? ['look-alike sighting in another cell'] : [] });
        if (centred && twin < twinD) twins.set(q, twin);
        else if (centred) {
          clean++;
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
              if (min < twinD) break;
            }
            return min;
          });
        }
        break;
      }
      // Centred targets constrain the geometry, so compare more views before settling; while every
      // candidate so far has a look-alike in another cell (repetitive terrain), compare them all.
      if (centred ? clean && t + 1 >= band.search * 2 : valid.length && t + 1 >= band.search) break;
      if (t % 4 === 3) onProgress(`Checking terrain matches (${t + 1}/${picked.length})`);
    }
    if (valid.length) {
      valid.sort((a, b) => b.hardness - a.hardness);
      let q;
      let extra = {};
      if (centred) {
        // A clean shortlist candidate; else the hardest clean one; else the least ambiguous, flagged.
        const far = new Map(), lookalikeD = (v) => {
          if (!far.has(v)) far.set(v, twins.has(v) ? twins.get(v) : farScans.get(v)());
          return far.get(v);
        };
        const open = valid.filter((v) => !twins.has(v)), short = open.length ? friendShortlist(open).filter((v) => lookalikeD(v) >= twinD) : [];
        q = short.length ? rng.fork('shortlist').pick(short) : open.find((v) => lookalikeD(v) >= twinD);
        extra = { pick: short.length ? 'shortlist' : q ? 'clean' : 'flagged', lookalikeCandidates: twins.size };
        if (!q) q = flagLookalike(valid.reduce((a, v) => lookalikeD(v) > lookalikeD(a) ? v : a));
      } else q = rng.fork('shortlist').pick(valid.slice(0, 3));
      q.stats = { ...q.stats, questionsCompared: valid.length, distractorCandidates: considered, ...extra, ms: Math.round(now() - t0) };
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
        const known = {
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
        generationModel.set(known, model);
        return known;
      }
    }
    log.push({ attempt, stage: 'question', try: picked.length, ok: false, confidence: 0, issues: ['no clear and distinguishable sighting'] });
  }
  throw new Error('No clear friend sighting found. Try another seed or a lower difficulty.');
}

/**
 * Gen=2 friend generator: selects observer + friend-cell-centre sightings whose
 * wide 50 deg view frames >= 2 phone-legible, map-matched skyline summits with
 * zero edge-cut slopes (so the solver can fix their OWN position first!), while
 * preserving matched-range terrain look-alikes and twin-free cell uniqueness.
 */
function generateTerrainFriendQuizGen2({ seed, world = 'classic', difficulty = 'medium', variant = 0, headingMode = null,
  friendChallenge = 'standard', friendAnswer = 'point', gridSize = 4, tuning = null, size, n, maxTerrainAttempts = 4, onProgress = () => {} }) {
  const centred = friendOnCellCentre({ friendAnswer });
  const divisions = normaliseGridSize(gridSize);
  const t0 = now();
  const challenge = normaliseFriendChallenge(friendChallenge);
  const base = applyTuning(getDifficulty(difficulty), tuning);
  const band = FRIEND_BANDS[difficulty] || FRIEND_BANDS.medium;
  const heading = ['exact', 'cardinal', 'intercardinal'].includes(headingMode) ? headingMode : base.heading;
  const preset = { ...base, heading };
  const seeds = new SeedManager(`${seed}#${difficulty}`);
  const log = [];
  const fov = 50, eyeHeight = 1.7;
  const elevationTolerance = challenge === 'depth-trap' ? 0.25 : 0.5;
  const T = GEN2_FRIEND_THRESHOLDS;
  const twinD = FRIEND_LOOKALIKE_LIMIT;
  const formGroup = (form) => ['valley', 'reentrant'].includes(form) ? 'hollow'
    : ['ridge', 'spur'].includes(form) ? 'crest' : form;

  let bestStrict = null;
  let bestFallback = null;
  let totalEvaluated = 0;
  let zeroPeakTerrains = 0;
  const attemptCap = Math.min(Math.max(0, maxTerrainAttempts), 3);

  const cmpCand = (a, b) => (b.rankScore - a.rankScore)
    || (a.camera.x - b.camera.x) || (a.camera.y - b.camera.y) || (a.camera.heading - b.camera.heading);

  for (let attempt = 0; attempt < attemptCap; attempt++) {
    onProgress(`Generating gen=2 friend terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n, world });
    if (!terrainCheck.ok) { log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues }); continue; }

    const rng = seeds.stream('friend-gen2', attempt, challenge, heading, variant);
    const margin = 70;
    const obsMargin = Math.min(200, model.size / 5);
    const summits = qualifiedMapSummits(model, interval, T.minMapPromFactor, T.minMapPromMetres);
    const cells = centred ? gridCells(model.size, divisions) : null;
    const centres = centred ? cells.filter((c) => model.inside(c.x, c.y, margin) && model.getSlope(c.x, c.y) <= 26) : null;

    // Inverted friend-centred panorama search:
    // 1. Sweep walkable target positions (cell centres for grid answers) over 360 deg.
    // 2. Discover headings where the 50 deg wide view frames >= 2 clean map-matched summits.
    // 3. Place the observer 135..195 m BEHIND the friend along that heading, so the friend sits
    //    dead-centre in front of a self-locatable skyline!
    let targetsToSweep;
    if (centred) {
      targetsToSweep = centres.map((c, id) => ({ id, x: c.x, y: c.y, label: c.label }));
    } else {
      const obsRng = rng.fork('targets');
      targetsToSweep = [];
      for (let k = 0; k < 48; k++) {
        const tx = obsRng.range(obsMargin, model.size - obsMargin), ty = obsRng.range(obsMargin, model.size - obsMargin);
        if (model.getSlope(tx, ty) <= 26) targetsToSweep.push({ id: targetsToSweep.length, x: tx, y: ty, label: null });
      }
    }
    if (!targetsToSweep.length) continue;

    onProgress(`Scanning ${targetsToSweep.length} friend targets for self-location skylines`);
    const targetSweeps = sweepPanoramas(model, targetsToSweep, { step: 1.5, eyeHeight });

    // Stage 1: propose (observer, friend, heading) triples by stepping backwards from skyline-rich (target, heading) pairs.
    const proposals = [];
    let obsIdCounter = 0;
    const stepDists = [170, 145, 192];
    for (const sw of targetSweeps) {
      const target = sw.p;
      const heads = discoverPanoramaHeadings(sw, fov, summits, T);
      for (const hInfo of heads) {
        const hBase = hInfo.heading;
        let bestDistProp = null;
        for (const dist of stepDists) {
          const ox = target.x - Math.sin(hBase * DEG) * dist;
          const oy = target.y - Math.cos(hBase * DEG) * dist;
          if (!model.inside(ox, oy, margin) || model.getSlope(ox, oy) > 26) continue;
          const oz = surfaceElevation(model, ox, oy) + eyeHeight;
          const obs = { id: obsIdCounter++, x: ox, y: oy, z: oz };
          const sight = personSight(model, obs, target);
          if (!sight.visible || Math.abs(sight.elevation) > T.maxAbsPitch || sight.angularHeight < T.minFriendAngularHeight) continue;
          const idxFriend = Math.round(wrap360(sight.bearing) / sw.step) % sw.count;
          const approxSkyAbove = sw.angles[idxFriend] - sight.elevation;
          const vertOk = hInfo.distinct.length >= 2 && hInfo.distinct.slice(0, 2).every((pk) => {
            const rel = pk.a - sight.elevation;
            return rel <= T.maxPeakAbovePitch + 1.5 && rel >= T.minPeakAbovePitch - 1.5;
          });
          // Gentle sightline pitch (|elevation| <= 5 deg) yields far more matched-range terrain look-alikes & cleaner framing.
          const levelBonus = 0.35 * saturate(1 - Math.abs(sight.elevation) / 9);
          const propScore = hInfo.quickScore + levelBonus + (vertOk ? 0.5 : -0.3) + (approxSkyAbove >= T.minSkyAboveFriend ? 0.3 : -0.3);
          const candProp = { obs, target: { x: target.x, y: target.y }, cell: target.label, sight, heading: wrap360(Math.round(sight.bearing)), propScore };
          if (!bestDistProp || candProp.propScore > bestDistProp.propScore) bestDistProp = candProp;
        }
        if (bestDistProp) proposals.push(bestDistProp);
      }
    }
    totalEvaluated += proposals.length;
    proposals.sort((a, b) => (b.propScore - a.propScore)
      || (a.obs.x - b.obs.x) || (a.obs.y - b.obs.y) || (a.heading - b.heading));

    // Stage 2: exact 0.5-deg skyline verification FROM THE OBSERVER'S TRUE EYE (with +-2 deg edge-dodge).
    const exactStrict = [];
    const exactFallback = [];
    const exactLimit = Math.min(proposals.length, 80);
    for (let i = 0; i < exactLimit; i++) {
      const pr = proposals[i];
      const zEye = model.skyline.eyeZ(pr.obs.x, pr.obs.y, eyeHeight);
      const skyAtFriend = model.skyline.castRay(pr.obs.x, pr.obs.y, zEye, pr.sight.bearing).angle;
      const skyAboveFriend = skyAtFriend - pr.sight.elevation;
      const friendSkyOk = skyAboveFriend >= T.minSkyAboveFriend;

      let bestCam = null, bestSky = null;
      for (const off of [0, -2, 2]) {
        const h = wrap360(Math.round(pr.sight.bearing + off));
        if (angleDiff(h, pr.sight.bearing) > 3.0) continue;
        const cam = { x: pr.obs.x, y: pr.obs.y, z: pr.obs.z, eyeHeight, heading: h, fov, pitch: pr.sight.elevation, roll: 0 };
        const sky = analyzeSkylineFrame(model, cam, { step: 0.5, margin: 20, contourInterval: interval, thresholds: T, summits, divisions });
        if (!bestSky || (sky.passesSkyline && !bestSky.passesSkyline)
          || (sky.passesSkyline === bestSky.passesSkyline && sky.skylineScore > bestSky.skylineScore)) {
          bestCam = cam; bestSky = sky;
        }
        if (bestSky.passesSkyline && bestSky.edgeCut <= 0.15) break;
      }
      const item = { ...pr, cam: bestCam, sky: bestSky, skyAboveFriend, friendSkyOk };
      if (bestSky.passesSkyline && friendSkyOk) {
        exactStrict.push(item);
        if (exactStrict.length >= 30) break;
      } else if (exactFallback.length < 10) {
        exactFallback.push(item);
      }
    }
    exactStrict.sort((a, b) => (b.sky.skylineScore + 0.25 * saturate(1 - Math.abs(b.sight.elevation) / 9))
      - (a.sky.skylineScore + 0.25 * saturate(1 - Math.abs(a.sight.elevation) / 9))
      || (a.obs.x - b.obs.x) || (a.obs.y - b.obs.y) || (a.heading - b.heading));
    exactFallback.sort((a, b) => (b.sky.skylineScore - a.sky.skylineScore)
      || (a.obs.x - b.obs.x) || (a.obs.y - b.obs.y) || (a.heading - b.heading));

    if (exactStrict.length === 0 && (!exactFallback.length || exactFallback[0].sky.distinctPeaks === 0)) zeroPeakTerrains++;

    // Keep diverse target cells in the evaluation shortlist
    const toEval = [];
    const source = exactStrict.length ? exactStrict : exactFallback;
    const perCell = new Map();
    for (const item of source) {
      const key = item.cell || `${Math.round(item.target.x / 100)}:${Math.round(item.target.y / 100)}`;
      const c = perCell.get(key) || 0;
      if (c >= 2) continue;
      perCell.set(key, c + 1);
      toEval.push(item);
      if (toEval.length >= (exactStrict.length ? 22 : 5)) break;
    }

    const grid = hypothesisLattice(model, rng.fork('hypotheses'), 48, margin);
    const vg = new ViewpointGenerator(model, preset, rng.fork('vg'), { fov, eyeHeight, maxPicks: 1 });
    const vgSweepCache = new Map();
    const vgScoreOf = (obs, h) => {
      if (!vgSweepCache.has(obs.id)) vgSweepCache.set(obs.id, vg.sweep(obs));
      return vg.score(vgSweepCache.get(obs.id), h);
    };

    const describe = (c) => model.skyline.viewDescriptor(c.x, c.y, c.heading, fov, {
      eyeHeight: c.z - model.getElevation(c.x, c.y), columns: 33,
    });

    let considered = 0;
    let terrainStrictClean = 0;
    for (const [idx, cand] of toEval.entries()) {
      onProgress(`Validating gen=2 friend sighting (${idx + 1}/${toEval.length})`);
      const { obs, target, cell: targetCell, sight: chosenSight, cam: camera, sky, friendSkyOk } = cand;
      const chosen = { ...target, ...chosenSight };
      const dx = target.x - camera.x, dy = target.y - camera.y;
      const distance = chosen.distance;
      const vpQuality = vgScoreOf(obs, camera.heading);
      const correctDesc = describe(camera);
      const inFrame = Array.from(correctDesc.horizon).filter((h) => Math.abs(h - camera.pitch) < 14).length;
      if (inFrame < 18 || correctDesc.edgeFrac > 0.35 || correctDesc.blockedFrac > 0.5) continue;

      const targetLandform = model.analyzer.classify(chosen.x, chosen.y);
      const consistent = (observer, point) => Math.abs(Math.atan2(surfaceElevation(model, point.x, point.y) + FRIEND_HEIGHT / 2 - observer.z, distance) / DEG
        - chosen.elevation) <= elevationTolerance && personSight(model, observer, point).visible;

      const pool = [];
      let twin = Infinity;
      let minInteriorCue = Infinity;
      let minHorizonRMS = Infinity;

      for (const p of grid) {
        if (Math.hypot(p.x - camera.x, p.y - camera.y) < 280) continue;
        const point = { x: p.x + dx, y: p.y + dy };
        if (!model.inside(point.x, point.y, margin) || model.getSlope(point.x, point.y) > 26) continue;
        if (['expert', 'master'].includes(difficulty)
          && formGroup(model.analyzer.classify(point.x, point.y)) !== formGroup(targetLandform)) continue;
        const observer = { ...camera, ...p, z: surfaceElevation(model, p.x, p.y) + eyeHeight };
        const z = surfaceElevation(model, point.x, point.y);
        const elevation = Math.atan2(z + FRIEND_HEIGHT / 2 - observer.z, distance) / DEG;
        if (Math.abs(elevation - chosen.elevation) > elevationTolerance) continue;
        const sight = personSight(model, observer, point);
        if (!sight.visible || Math.abs(sight.angularHeight - chosen.angularHeight) > 0.015) continue;
        considered++;
        const desc = describe(observer);
        const D = descriptorDistance(correctDesc, desc);
        if (centred && D < twinD && cellAt(point.x, point.y, model.size, divisions) !== targetCell) twin = Math.min(twin, D);
        if (desc.edgeFrac > 0.3 || desc.blockedFrac > 0.5 || D < band.min || D > band.max) continue;
        const cue = distinguishingCue(correctDesc, desc);
        const cueOffset = wrap360(cue.bearing - camera.heading + 180) - 180;
        const cueColumn = Math.max(0, Math.min(32, Math.round((cueOffset + fov / 2) / fov * 32)));
        if (cue.magnitude < band.cue || Math.abs(correctDesc.horizon[cueColumn] - camera.pitch) > 14) continue;
        pool.push({ ...point, ...sight, observer, D, cue, desc });
      }
      pool.sort((a, b) => (a.D - b.D) || (a.x - b.x) || (a.y - b.y));
      let pair = null, cost = Infinity;
      for (let i = 0; i < Math.min(pool.length, 24); i++) {
        for (let j = i + 1; j < Math.min(pool.length, 40); j++) {
          const a = pool[i], b = pool[j];
          if (Math.hypot(a.x - b.x, a.y - b.y) < 280 || descriptorDistance(a.desc, b.desc) < band.min * 0.8) continue;
          const next = a.D + b.D;
          if (next < cost) { cost = next; pair = [a, b]; }
        }
      }
      if (!pair) continue;

      for (const m of pair) {
        const ic = interiorHorizonCue(correctDesc, m.desc, 3);
        const hr = horizonDistance(correctDesc.horizon, m.desc.horizon);
        if (ic < minInteriorCue) minInteriorCue = ic;
        if (hr < minHorizonRMS) minHorizonRMS = hr;
      }

      const minDifference = Math.min(...pair.map((p) => p.D));
      const baseConf = saturate(0.5 + 0.25 * Math.min(1, minDifference / band.min - 0.5) + 0.25 * vpQuality.total);
      let hardness = saturate(1 - ((pair[0].D + pair[1].D) / 2 - band.min) / (band.max - band.min));
      let reported = baseConf;
      let gridChecks = {};

      if (centred) {
        const alts = pair.map((p) => ({ D: p.D, cue: p.cue.magnitude }));
        for (const c of cells) {
          if (c.label === targetCell) continue;
          const p = { x: c.x - dx, y: c.y - dy };
          if (!model.inside(p.x, p.y, 0) || model.getSlope(p.x, p.y) > 26 || model.getSlope(c.x, c.y) > 26) continue;
          const observer = { ...camera, ...p, z: surfaceElevation(model, p.x, p.y) + eyeHeight };
          if (!consistent(observer, c)) continue;
          const desc = describe(observer);
          const D = descriptorDistance(correctDesc, desc);
          if (D < twinD) twin = Math.min(twin, D);
          const ic = interiorHorizonCue(correctDesc, desc, 3);
          const hr = horizonDistance(correctDesc.horizon, desc.horizon);
          if (ic < minInteriorCue) minInteriorCue = ic;
          if (hr < minHorizonRMS) minHorizonRMS = hr;
          if (D <= band.max) alts.push({ D, cue: distinguishingCue(correctDesc, desc).magnitude });
        }
        // Also run the far lattice twin check eagerly on strict candidates so our winner is verified clean.
        if (twin >= twinD) {
          for (const p of grid) {
            const point = { x: p.x + dx, y: p.y + dy };
            if (Math.hypot(point.x - target.x, point.y - target.y) < 240 || !model.inside(point.x, point.y, 0) || model.getSlope(point.x, point.y) > 26
              || cellAt(point.x, point.y, model.size, divisions) === targetCell) continue;
            const observer = { ...camera, ...p, z: surfaceElevation(model, p.x, p.y) + eyeHeight };
            if (!consistent(observer, point)) continue;
            const D = descriptorDistance(correctDesc, describe(observer));
            if (D < twin) twin = D;
            if (twin < twinD) break;
          }
        }
        const nearest = alts.reduce((a, b) => (b.D < a.D ? b : a));
        const near = alts.filter((a) => a.D < 2 * band.min);
        const summary = { closestD: nearest.D, rivals: alts.length, weakestCue: Math.min(...(near.length ? near : [nearest]).map((a) => a.cue)) };
        ({ hardness, confidence: reported } = friendGridScore({
          ...summary, band, quality: vpQuality.total, blockedFrac: correctDesc.blockedFrac, edgeFrac: correctDesc.edgeFrac,
        }));
        gridChecks = { rivalCells: summary.rivals, weakestCue: +summary.weakestCue.toFixed(2), lookalikeElsewhere: false, lookalikeLimit: twinD };
      }

      const hasTwin = centred && twin < twinD;
      const obsCellObj = { label: cellAt(camera.x, camera.y, model.size, divisions) || 'A1' };
      const reasoning = cells ? mapReasoningMetrics(model, obsCellObj, sky.peaks, cells, divisions, interval)
        : { mapSummits: summits.length, decoyPairs: 0, decoySameOrder: 0, singlePeakCells: 0 };

      const strict = !hasTwin
        && sky.passesSkyline
        && friendSkyOk
        && vpQuality.total >= base.minQuality
        && vpQuality.components.landmarkVisibility >= 0.30
        && baseConf >= base.minConfidence
        && minInteriorCue >= T.minInteriorCue
        && minHorizonRMS >= T.minHorizonRMS;

      const friendFairness = saturate(
        0.48 * sky.skylineScore
        + 0.24 * saturate((minInteriorCue - 0.8) / 1.8)
        + 0.14 * saturate((minHorizonRMS - 0.45) / 1.0)
        + 0.14 * saturate((cand.skyAboveFriend - 0.4) / 2.5)
      );
      const friendReadability = saturate(
        0.50 * sky.skylineScore
        + 0.25 * saturate((chosen.angularHeight - 0.42) / 0.35)
        + 0.25 * saturate(1 - Math.max(0, sky.edgeCut) / 1.0)
      );
      const friendDifficulty = saturate(
        0.55 * hardness
        + 0.25 * (1 - Math.exp(-reasoning.decoySameOrder / 8))
        + 0.20 * saturate((reasoning.mapSummits - 6) / 12)
      );
      const rankScore = (strict ? 2.0 : hasTwin ? -0.5 : 0.3)
        + 0.45 * friendFairness + 0.35 * friendDifficulty + 0.20 * friendReadability;

      const entry = {
        attempt, idx, model, interval, terrainCheck, camera: { ...camera }, chosen, pair, vpQuality, correctDesc,
        minDifference, hardness, reported, gridChecks, hasTwin, twin, sky, skyAboveFriend: cand.skyAboveFriend,
        minInteriorCue, minHorizonRMS, reasoning, friendFairness, friendReadability, friendDifficulty,
        strict, rankScore, considered, rng: rng.fork(`labels-${idx}`),
      };

      log.push({
        attempt, stage: 'gen2', try: idx, cell: targetCell, ok: strict,
        hardness: +friendDifficulty.toFixed(4), fairness: +friendFairness.toFixed(3),
        issues: strict ? [] : [hasTwin ? 'look-alike sighting in another cell' : 'below gen2 self-location skyline bar'],
      });

      if (strict) {
        terrainStrictClean++;
        if (!bestStrict || cmpCand(entry, bestStrict) < 0) bestStrict = entry;
        if (terrainStrictClean >= 5 && bestStrict.friendDifficulty >= 0.55) break;
      } else if (!bestFallback || cmpCand(entry, bestFallback) < 0) {
        bestFallback = entry;
      }
    }

    if (bestStrict && (bestStrict.friendDifficulty >= 0.50 || attempt >= 1)) break;
    if (!bestStrict && zeroPeakTerrains >= 2 && bestFallback) break;
  }

  const win = bestStrict || bestFallback;
  if (!win) {
    // Ultimate safety fallback to legacy generator so gen=2 never throws on a seed gen=1 can solve.
    const legacy = generateTerrainFriendQuiz({ seed, world, difficulty, variant, headingMode, friendChallenge, friendAnswer, gridSize, tuning, size, n, maxTerrainAttempts, onProgress });
    legacy.gen = 2;
    legacy.mapRotation = 0;
    legacy.gen2 = { version: 2, mode: 'friend', strict: false, fallback: true, distinctPeaks: 0, edgeCut: null };
    return legacy;
  }

  const isFallback = !bestStrict;
  const e = win;
  const { model, interval, terrainCheck, camera, chosen, pair, vpQuality, correctDesc, sky } = e;
  const points = [{ ...chosen, observer: { ...camera }, D: 0 }, ...pair.map(({ desc, ...p }) => p)];
  const options = e.rng.shuffle(points).map((p, i) => ({
    ...p, label: ['A', 'B', 'C'][i], correct: p.D === 0, landform: model.analyzer.classify(p.x, p.y),
  }));
  const separation = Math.min(...options.flatMap((a, i) => options.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));

  const q = {
    version: 2,
    gen: 2,
    mode: 'friend',
    seed,
    difficulty,
    variant,
    lowConfidence: isFallback && (e.hasTwin || sky.distinctPeaks === 0),
    terrain: terrainSummary(model, interval, terrainCheck),
    camera: { ...camera },
    friend: {
      x: chosen.x, y: chosen.y, z: chosen.z, height: FRIEND_HEIGHT,
      heading: wrap360(chosen.bearing + 180), challenge, observerHidden: true,
    },
    mapExtent: { x: model.size / 2, y: model.size / 2, size: model.size },
    heading: { degrees: camera.heading, ...formatHeading(camera.heading, heading), mode: heading },
    mapRotation: 0,
    options,
    correctLabel: options.find((p) => p.correct).label,
    landmarks: landmarkSummary(model),
    quality: {
      total: vpQuality.total,
      ...vpQuality.components,
      blockedFrac: correctDesc.blockedFrac,
      edgeFrac: correctDesc.edgeFrac,
      landmarksInView: vpQuality.landmarksInView,
    },
    gen2: {
      version: 2,
      mode: 'friend',
      strict: !isFallback,
      fallback: isFallback,
      cutLeft: sky.cutLeft,
      cutRight: sky.cutRight,
      edgeCut: sky.edgeCut,
      edgeWall: sky.edgeWall,
      maxAngle: sky.maxAngle,
      relief: sky.relief,
      distinctPeaks: sky.distinctPeaks,
      primaryProm: sky.primaryProm,
      secondaryProm: sky.secondaryProm,
      primaryLocalProm: sky.primaryLocalProm,
      secondaryLocalProm: sky.secondaryLocalProm,
      peakSep: sky.peakSep,
      saddleDrop: sky.saddleDrop,
      minEdgeDist: sky.minEdgeDist,
      friendDist: Math.round(chosen.distance),
      friendAngularHeight: +chosen.angularHeight.toFixed(3),
      skyAboveFriend: +e.skyAboveFriend.toFixed(2),
      minInteriorCue: Number.isFinite(e.minInteriorCue) ? +e.minInteriorCue.toFixed(2) : null,
      minHorizonRMS: Number.isFinite(e.minHorizonRMS) ? +e.minHorizonRMS.toFixed(2) : null,
      uniquenessMargin: Number.isFinite(e.minInteriorCue) ? +e.minInteriorCue.toFixed(2) : null,
      hasTwin: e.hasTwin,
      decoySameOrder: e.reasoning.decoySameOrder,
      mapSummits: e.reasoning.mapSummits,
      difficulty: +e.friendDifficulty.toFixed(3),
      fairness: +e.friendFairness.toFixed(3),
      readability: +e.friendReadability.toFixed(3),
      estimatedDifficulty: +(6.2 + 3.2 * e.friendDifficulty).toFixed(1),
      estimatedFairness: +(4.5 + 4.8 * e.friendFairness).toFixed(1),
      estimatedReadability: +(4.5 + 4.3 * e.friendReadability).toFixed(1),
      rankScore: +e.rankScore.toFixed(4),
      peaks: sky.peaks.map(({ d, az, a, dist, prom, localProm, sharpness, edgeDist, summit }) => ({
        d, az, a, dist, prom, localProm, sharpness, edgeDist,
        summit: summit ? { cell: summit.cell, kind: summit.kind, prominence: summit.prominence } : null,
      })),
    },
    validation: {
      ok: !e.hasTwin,
      issues: [],
      confidence: isFallback ? Math.min(e.friendFairness, 0.5) : e.friendFairness,
      uniqueness: saturate(e.minDifference / (band.min * 2)),
      minDistance: e.minDifference,
      minRequiredDistance: band.min,
      minSeparation: separation,
      rangeSpread: Math.max(...options.map((p) => p.distance)) - Math.min(...options.map((p) => p.distance)),
      maxApparentHeightDifference: Math.max(...options.map((p) => Math.abs(p.angularHeight - chosen.angularHeight))),
      elevationTolerance,
      minCue: band.cue,
      ...e.gridChecks,
    },
    hardness: isFallback && e.hasTwin ? Math.min(e.friendDifficulty, 0.3) : e.friendDifficulty,
    stats: {
      viewpointsEvaluated: totalEvaluated,
      terrainAttempt: e.attempt,
      viewTry: e.idx,
      questionsCompared: log.filter((l) => l.stage === 'gen2').length,
      distractorCandidates: e.considered,
      pick: !isFallback ? 'gen2-strict' : e.hasTwin ? 'flagged' : 'gen2-fallback',
      ms: Math.round(now() - t0),
    },
    log,
  };
  if (centred && e.hasTwin) flagLookalike(q);
  generationModel.set(q, model);
  return q;
}
