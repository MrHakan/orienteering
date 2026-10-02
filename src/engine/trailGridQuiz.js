// A moving position question: each possible finish is a grid-cell centre.
// All candidate runs share one horizontal plan. The complete scene sequence
// must distinguish the answer from every other physically possible finish.
import { SeedManager } from './rng.js';
import { candidateHeadings, formatHeading } from './heading.js';
import { normaliseGridSize, gridCells } from './gridQuiz.js';
import { buildTerrain, terrainSummary, landmarkSummary, framingPitch, now } from './quiz.js';
import { ViewpointGenerator } from './viewpoints.js';
import { createTrailPlan, simulateTrail, planAt, normaliseMovement } from './trailMotion.js';
import { getTrailPreset, describeTrailRoute, compareTrailViews, trailMapExtent } from './trailQuiz.js';
import { terrainRunDuration, trailViewTimes, describeTrailTerrain, travelledCells } from './trailTerrain.js';
import { surfaceElevation } from './terrainSurface.js';
import { saturate, wrap360 } from './grid.js';

function cueVisible(pair, a, b, pitch, fov, times) {
  const index = times.indexOf(pair.cue.t), view = a.views[index];
  const offset = wrap360(pair.cue.bearing - view.heading + 180) - 180;
  const column = Math.max(0, Math.min(32, Math.round((offset + fov / 2) / fov * 32)));
  return [a, b].every(route => Math.abs(route.views[index].horizon[column]
    - pitch - route.views[index].pitchOffset) < 25);
}

export function generateTrailGridQuiz({ seed, difficulty = 'medium', variant = 0, headingMode = null,
  movement = 'go', gridSize = 6, tuning = null, size, n, maxTerrainAttempts = 4, onProgress = () => {} }) {
  const t0 = now(), preset = getTrailPreset(difficulty, tuning), band = preset.trailBand;
  const divisions = normaliseGridSize(gridSize), physics = normaliseMovement(movement);
  const style = ['exact', 'cardinal', 'intercardinal'].includes(headingMode) ? headingMode : preset.heading;
  const seeds = new SeedManager(seed + '#' + difficulty), fov = 90, eyeHeight = 1.7, log = [];
  for (let attempt = 0; attempt < maxTerrainAttempts; attempt++) {
    onProgress('Generating bunny-hop grid terrain (attempt ' + (attempt + 1) + ')');
    const { model, interval, terrainCheck } = buildTerrain({ seed, difficulty, attempt, preset, seeds, size, n });
    if (!terrainCheck.ok) { log.push({ attempt, stage: 'terrain', issues: terrainCheck.issues }); continue; }
    const rng = seeds.stream('trail-grid', attempt, variant, divisions, style);
    const cells = gridCells(model.size, divisions);
    const headings = rng.fork('headings').shuffle(candidateHeadings(style, rng.fork('angles')));
    for (let h = 0; h < 8; h++) {
      const heading = headings[h % headings.length];
      const plan = createTrailPlan(rng.fork('steering-' + h), heading, terrainRunDuration(model.size, divisions)), finish = planAt(plan, plan.duration);
      const times = trailViewTimes(plan.duration);
      const centre = cells[Math.floor(divisions / 2) * divisions + Math.floor(divisions / 2)];
      const path = Array.from({ length: plan.samples.length / 4 }, (_, i) => ({
        x: centre.x - finish.x + plan.samples[i * 4], y: centre.y - finish.y + plan.samples[i * 4 + 1],
      }));
      if (new Set(travelledCells(path, model.size, divisions)).size < 3) continue;
      const vg = new ViewpointGenerator(model, preset, rng.fork('quality-' + h), { fov, eyeHeight });
      const routes = [];
      onProgress('Checking runs ending in all ' + cells.length + ' cells');
      for (const cell of cells) {
        const route = simulateTrail(model, { x: cell.x - finish.x, y: cell.y - finish.y }, plan, physics);
        if (!route) continue;
        route.terrainRun = describeTrailTerrain(model, route, divisions);
        route.label = cell.label; route.finish = cell;
        route.views = describeTrailRoute(model, route, plan, fov, times, 33);
        routes.push(route);
      }
      const valid = [];
      for (const route of routes) {
        if (!route.terrainRun.ok || route.terrainRun.cellCount < 3) continue;
        if (route.views.some(view => view.edgeFrac > .35 || view.blockedFrac > .5)) continue;
        const quality = vg.score(vg.sweep(route), heading);
        if (quality.total < preset.minQuality) continue;
        const pitch = framingPitch(Array.from(route.views[0].horizon));
        const pairs = routes.filter(other => other !== route).map(other => ({
          label: other.label, ...compareTrailViews(route, other, band, times),
          visible: false,
        }));
        if (!pairs.length) continue;
        for (const pair of pairs) pair.visible = cueVisible(pair, route, routes.find(other => other.label === pair.label), pitch, fov, times);
        // Grid has no upper similarity limit: distant cells may be obviously
        // different. Each physically possible alternative still needs a cue.
        if (pairs.some(pair => pair.D < band.min || pair.cue.magnitude < band.cue || !pair.visible)) continue;
        const closest = pairs.reduce((a, b) => b.D < a.D ? b : a);
        const uniqueness = saturate(closest.D / (2 * band.min));
        const confidence = saturate(.6 * uniqueness + .4 * quality.total);
        if (confidence < preset.minConfidence) continue;
        valid.push({ route, quality, pitch, pairs, closest, uniqueness, confidence,
          hardness: saturate(Math.exp(-(closest.D - band.min) / 1.2)) });
      }
      log.push({ attempt, stage: 'question', try: h, ok: valid.length > 0, confidence: valid.length ? .85 : 0,
        issues: valid.length ? [] : ['no unambiguous moving grid sequence'] });
      if (!valid.length) continue;
      valid.sort((a, b) => (b.hardness + .35 * b.route.terrainRun.score) - (a.hardness + .35 * a.route.terrainRun.score));
      const chosen = rng.fork('choice-' + h).pick(valid.slice(0, difficulty === 'master' ? 2 : 6));
      const { route, quality, pitch, pairs, closest, uniqueness, confidence, hardness } = chosen;
      const correctLabel = route.label;
      const options = cells.map(cell => {
        const pair = pairs.find(p => p.label === cell.label);
        return { ...cell, correct: cell.label === correctLabel, D: pair?.D ?? null, cue: pair?.cue ?? null,
          admissible: cell.label === correctLabel || !!pair, z: surfaceElevation(model, cell.x, cell.y),
          landform: model.analyzer.classify(cell.x, cell.y) };
      });
      const { views, finish: cell, ...actual } = route;
      return {
        version: 1, mode: 'trail', seed, difficulty, variant, lowConfidence: false,
        terrain: terrainSummary(model, interval, terrainCheck),
        camera: { x: route.x, y: route.y, z: route.feet[0] + eyeHeight, heading, pitch, fov, eyeHeight, roll: 0 },
        trail: { plan, movement: physics, answerMode: 'grid', duration: plan.duration, routes: [{ ...actual, correct: true }],
          pairs, times },
        grid: { size: divisions, origin: 'trail-end-centre', cellMetres: model.size / divisions,
          target: { x: cell.x, y: cell.y, label: 'FINISH' } },
        options, correctLabel, closestLabel: closest.label,
        heading: { degrees: heading, ...formatHeading(heading, style), mode: style },
        mapExtent: trailMapExtent(model), mapRotation: preset.mapRotation ? rng.fork('rotation').pick([0, 90, 180, 270]) : 0,
        landmarks: landmarkSummary(model), hardness,
        quality: { total: quality.total, ...quality.components, blockedFrac: quality.blockedFrac,
          edgeFrac: quality.edgeFrac, landmarksInView: quality.landmarksInView },
        validation: { ok: true, issues: [], confidence, uniqueness, minDistance: closest.D,
          minRequiredDistance: band.min, minCue: band.cue },
        stats: { viewpointsEvaluated: routes.length * times.length, cellsChecked: cells.length,
          routesChecked: routes.length, questionsCompared: valid.length, terrainAttempt: attempt, ms: Math.round(now() - t0) }, log,
      };
    }
  }
  throw new Error('No unambiguous bunny-hop grid question found. Try another seed or a lower difficulty.');
}
