// Three look-alike observations at DIFFERENT bearings. Knowing the bearing
// must rule out both other places; matching all three at one heading would
// make the wristwatch irrelevant to the location question.
import { SeedManager } from './rng.js';
import { getDifficulty } from './difficulty.js';
import { ViewpointGenerator } from './viewpoints.js';
import { buildTerrain, terrainSummary, landmarkSummary, framingPitch, now } from './quiz.js';
import { compareLookalikeViews, rankLookalikeTriples, sweepDescriptor, triangleSpread, DIRECTIONS } from './lookalikeQuiz.js';
import { descriptorDistance } from './skyline.js';
import { distinguishingCue, VIEW_COLUMNS } from './quizCandidates.js';
import { createSunWatch } from './sunWatch.js';
import { personSight, finishFriendQuiz, FRIEND_HEIGHT, normaliseFriendChallenge } from './friendQuiz.js';
import { surfaceElevation } from './terrainSurface.js';
import { angleDiff, DEG, saturate, wrap360 } from './grid.js';

const MAX_DIFFERENCE = 2.8;
const DIRECTION_MARGIN = 3.4;
const MIN_HEADING_GAP = 90;

export function compareSunWatchViews(a, b, preset, coarse = false) {
  const p = compareLookalikeViews(a, b, { ...preset, search: { cue: 0 } }, { coarse });
  const slack = coarse ? 1.2 : 1;
  return { ...p, ok: p.D <= MAX_DIFFERENCE * slack && p.horizon <= 3.2 * slack
    && p.depth <= .95 * slack && p.shape <= 4.2 * slack && p.anchors <= (coarse ? .24 : .14) };
}

const usable = (desc, quality, preset) => quality.total >= preset.minQuality
  && desc.blockedFrac <= .45 && desc.edgeFrac <= .35
  && (quality.components.skylineComplexity >= .25 || quality.components.landmarkVisibility >= .25);

/** Equal range/size, complete visibility, and comparable vertical angle. */
function friendTargets(model, cameras, rng, elevationTolerance) {
  for (const distance of rng.shuffle([140, 155, 170, 185, 200])) {
    const points = cameras.map(camera => {
      const p = { x: camera.x + Math.sin(camera.heading * DEG) * distance,
        y: camera.y + Math.cos(camera.heading * DEG) * distance };
      if (!model.inside(p.x, p.y, 70) || model.getSlope(p.x, p.y) > 26) return null;
      return { ...p, ...personSight(model, camera, p), observer: { ...camera } };
    });
    if (points.some(p => !p || !p.visible || p.angularHeight < .45 || Math.abs(p.elevation) > 14)) continue;
    if (Math.max(...points.map(p => p.elevation)) - Math.min(...points.map(p => p.elevation)) > elevationTolerance) continue;
    if (Math.max(...points.map(p => p.angularHeight)) - Math.min(...points.map(p => p.angularHeight)) > .015) continue;
    if (points.some((a, i) => points.slice(i + 1).some(b => Math.hypot(a.x - b.x, a.y - b.y) < 280))) continue;
    return points;
  }
  return null;
}

export function generateSunWatchQuiz({ seed, difficulty = 'sun-watch', mode = 'where-am-i', variant = 0,
  size, n, maxTerrainAttempts = 8, onProgress = () => {}, ...opts }) {
  const t0 = now(), friendMode = mode === 'friend', preset = getDifficulty('sun-watch');
  const seeds = new SeedManager(`${seed}#${difficulty}`), log = [];
  const fov = friendMode ? 50 : 64, eyeHeight = 1.7;
  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress(`Generating terrain (attempt ${attempt + 1})`);
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n });
    if (!terrainCheck.ok) { log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues }); continue; }
    const rng = seeds.stream('sun-places', mode, attempt, variant);
    const vg = new ViewpointGenerator(model, preset, rng.fork('positions'), { fov, eyeHeight, gridSize: 18, margin: 210 });
    const positions = vg.candidatePositions(), byHeading = DIRECTIONS.map(() => []);
    onProgress('Comparing terrain views in different directions');
    for (const [id, p] of positions.entries()) {
      const sw = vg.sweep(p), z = surfaceElevation(model, p.x, p.y), slope = model.getSlope(p.x, p.y);
      for (const [di, d] of DIRECTIONS.entries()) {
        const quality = vg.score(sw, d.heading);
        if (!usable(quality, quality, preset)) continue;
        byHeading[di].push({ ...p, id, heading: d.heading, z, slope, quality,
          desc: sweepDescriptor(sw, d.heading, fov, eyeHeight) });
      }
    }
    // A seeded sample of every direction bounds the graph without selecting
    // the answer or privileging one bearing before the views are matched.
    const nodes = byHeading.flatMap((pool, di) => rng.fork(`pool-${di}`).shuffle(pool).slice(0, 96));
    const geographic = (a, b) => a.id !== b.id && angleDiff(a.heading, b.heading) >= MIN_HEADING_GAP
      && Math.hypot(a.x - b.x, a.y - b.y) >= preset.minSeparation
      && Math.abs(a.z - b.z) <= .18 * (model.max - model.min) && Math.abs(a.slope - b.slope) <= 8;
    const graph = rankLookalikeTriples(nodes, (a, b) => {
      if (!geographic(a, b)) return null;
      const pair = compareSunWatchViews(a.desc, b.desc, preset, true);
      return pair.ok ? pair : null;
    }, friendMode ? 512 : 192, pts => triangleSpread(pts) >= .08);
    const cache = new Map();
    const describe = (p, heading = p.heading) => {
      const key = `${p.id}:${heading}`;
      if (!cache.has(key)) cache.set(key, model.skyline.viewDescriptor(p.x, p.y, heading, fov,
        { eyeHeight: p.z + eyeHeight - model.getElevation(p.x, p.y), columns: VIEW_COLUMNS }));
      return cache.get(key);
    };
    const valid = [];
    for (const [i, triple] of graph.triples.entries()) {
      const descs = triple.points.map(p => describe(p));
      if (descs.some((d, j) => !usable(d, triple.points[j].quality, preset))) continue;
      const pairs = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => ({ a, b, ...compareSunWatchViews(descs[a], descs[b], preset) }));
      if (pairs.some(p => !p.ok)) continue;
      // All six directed checks matter, since the correct vertex is chosen
      // later. At the observed bearing neither wrong point may still fit.
      let minBearingDifference = Infinity;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (a !== b) {
        minBearingDifference = Math.min(minBearingDifference,
          descriptorDistance(descs[a], describe(triple.points[b], triple.points[a].heading)));
      }
      if (minBearingDifference < DIRECTION_MARGIN) continue;
      const pitch = framingPitch(descs.flatMap(d => Array.from(d.horizon)));
      const cameras = triple.points.map(p => ({ x: p.x, y: p.y, z: p.z + eyeHeight,
        heading: p.heading, fov, eyeHeight, pitch, roll: 0 }));
      const targets = friendMode ? friendTargets(model, cameras, rng.fork(`targets-${i}`), opts.friendChallenge === 'depth-trap' ? .25 : .7) : null;
      if (friendMode && !targets) continue;
      valid.push({ ...triple, descs, pairs, minBearingDifference, cameras, targets });
      if (valid.length >= 3) break;
      if (i % 24 === 23) onProgress(`Checking similar locations (${i + 1}/${graph.triples.length})`);
    }
    if (!valid.length) { log.push({ attempt, stage: 'question', try: graph.triples.length, ok: false,
      confidence: 0, issues: ['no three-way match with a unique observed bearing'] }); continue; }
    const chosen = rng.fork('triple').pick(valid), ci = rng.fork('observer').int(0, 2);
    const camera = { ...chosen.cameras[ci] };
    if (friendMode) camera.pitch = chosen.targets[ci].elevation;
    const options = rng.fork('labels').shuffle(chosen.points.map((p, i) => {
      const target = friendMode ? chosen.targets[i] : p;
      const cue = distinguishingCue(chosen.descs[ci], chosen.descs[i]);
      return { ...target, heading: p.heading, correct: i === ci,
        D: i === ci ? 0 : descriptorDistance(chosen.descs[ci], chosen.descs[i]),
        landform: model.analyzer.classify(target.x, target.y),
        cue: { bearing: cue.bearing, delta: cue.delta } };
    })).map((p, i) => {
      // Keep only plain public data; sweep descriptors/quality caches do not
      // belong in a quiz payload or worker message.
      const { id, desc, quality, slope, ...option } = p;
      if (friendMode) option.observer.pitch = camera.pitch;
      return { ...option, label: ['A', 'B', 'C'][i] };
    });
    const quality = chosen.points[ci].quality;
    const quiz = {
      version: 2, mode, seed, difficulty, variant, lowConfidence: false,
      terrain: terrainSummary(model, interval, terrainCheck), camera,
      heading: { degrees: camera.heading, text: '', arrow: '', mode: 'hidden' },
      mapRotation: 0, options, correctLabel: options.find(o => o.correct).label,
      quality: { total: quality.total, ...quality.components, blockedFrac: quality.blockedFrac,
        edgeFrac: quality.edgeFrac, landmarksInView: quality.landmarksInView },
      validation: { ok: true, issues: [], confidence: saturate(.55 + .25 * Math.min(1, chosen.minBearingDifference / 6) + .2 * quality.total), uniqueness: saturate(chosen.minBearingDifference / 6),
        minDistance: Math.min(...chosen.pairs.map(p => p.D)), minBearingDifference: chosen.minBearingDifference,
        requiredBearingDifference: DIRECTION_MARGIN, minHeadingGap: MIN_HEADING_GAP,
        minSeparation: preset.minSeparation },
      hardness: saturate(1 - chosen.cost), landmarks: landmarkSummary(model),
      matching: { direction: 'hidden', minSeparation: preset.minSeparation,
        pairs: chosen.pairs.map(({ a, b, D, horizon, depth, shape, anchors }) => ({
          from: { x: chosen.points[a].x, y: chosen.points[a].y }, to: { x: chosen.points[b].x, y: chosen.points[b].y },
          D, horizon, depth, shape, anchors })) },
      stats: { viewpointsEvaluated: positions.length * 8, terrainAttempt: attempt, viewTry: ci,
        questionsCompared: valid.length, pairsExamined: graph.pairsExamined,
        directions: DIRECTIONS.map((d, i) => ({ ...d, viewpoints: byHeading[i].length })), ms: Math.round(now() - t0) }, log,
    };
    if (mode === 'lookalike') quiz.directionChoice = 'auto';
    quiz.sunWatch = createSunWatch(quiz, model);
    if (friendMode) {
      const target = chosen.targets[ci];
      quiz.friend = { x: target.x, y: target.y, z: target.z, height: FRIEND_HEIGHT,
        heading: wrap360(camera.heading + 180), observerHidden: true, challenge: normaliseFriendChallenge(opts.friendChallenge) };
      quiz.mapExtent = { x: model.size / 2, y: model.size / 2, size: model.size };
      finishFriendQuiz(quiz, opts);
    }
    log.push({ attempt, stage: 'question', try: ci, ok: true, confidence: quiz.validation.confidence, issues: [] });
    return quiz;
  }
  throw new Error('No fair sun/watch location matches found. Try another seed.');
}
