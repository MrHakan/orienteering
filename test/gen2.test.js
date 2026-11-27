import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { cellAt } from '../src/engine/gridQuiz.js';
import { cellBorderMargin, personSight } from '../src/engine/friendQuiz.js';
import { fixSlack, rivalFixes, RESECTION_BANDS } from '../src/engine/resectionQuiz.js';
import {
  normaliseGen, GEN2_GRID_THRESHOLDS, GEN2_RESECTION_THRESHOLDS, GEN2_FRIEND_THRESHOLDS,
  analyzeSkylineFrame, interiorHorizonCue, descriptorHorizonPeaks, featureDistinction,
  adjacentSummitShift, gridGen2Scores, analyzeResectionPeakView,
} from '../src/engine/gen2.js';
import { runReport, formatMarkdown } from '../scripts/gen2-report.mjs';

/** Build a synthetic 2 km terrain from analytic Gaussian hills for deterministic rule-isolation tests. */
function makeSyntheticTerrain(hills, { size = 2000, n = 201, base = 100 } = {}) {
  const heights = new Float32Array(n * n);
  const cell = size / (n - 1);
  for (let j = 0; j < n; j++) {
    const y = j * cell;
    for (let i = 0; i < n; i++) {
      const x = i * cell;
      let z = base + 0.008 * y; // gentle backdrop slope so flat rays terminate inside the map
      for (const h of hills) {
        const dx = x - h.x, dy = y - h.y;
        const rx = h.rx ?? h.r, ry = h.ry ?? h.r;
        z += h.height * Math.exp(-0.5 * ((dx / rx) ** 2 + (dy / ry) ** 2));
      }
      heights[j * n + i] = z;
    }
  }
  return new TerrainModel({ size, n, heights, seed: 'synthetic-gen2' });
}

test('normaliseGen defaults to 1 and only enables 2 when explicitly requested', () => {
  assert.equal(normaliseGen(undefined), 1);
  assert.equal(normaliseGen(null), 1);
  assert.equal(normaliseGen(1), 1);
  assert.equal(normaliseGen('1'), 1);
  assert.equal(normaliseGen('2'), 2);
  assert.equal(normaliseGen(2), 2);
  assert.equal(normaliseGen(3), 1);
});

test('mutation-style rule isolation: every skyline phone-legibility rule independently rejects its failure mode', () => {
  const cam = { x: 1000, y: 300, heading: 0, fov: 60, eyeHeight: 1.7 };

  // Clean baseline: two distinct, crisp closed-contour summits well inside [-30, +30] deg (at -14 deg and +14 deg)
  const baseHills = [
    { x: 750, y: 1300, height: 85, r: 95 },  // bearing ~346 deg (-14 deg), dist ~1031 m, angle ~4.6 deg
    { x: 1250, y: 1300, height: 75, r: 95 }, // bearing ~014 deg (+14 deg), dist ~1031 m, angle ~4.1 deg
  ];
  const cleanModel = makeSyntheticTerrain(baseHills);
  const clean = analyzeSkylineFrame(cleanModel, cam, { contourInterval: 10, thresholds: GEN2_GRID_THRESHOLDS });
  assert.equal(clean.passesSkyline, true, `baseline must pass: ${JSON.stringify({ cut: clean.edgeCut, p1: clean.primaryProm, p2: clean.secondaryProm, lp2: clean.secondaryLocalProm, sad: clean.saddleDrop })}`);
  assert.equal(clean.distinctPeaks, 2);
  assert.ok(clean.edgeCut <= GEN2_GRID_THRESHOLDS.maxEdgeCut);
  assert.ok(clean.primaryProm >= GEN2_GRID_THRESHOLDS.minPrimaryProm);
  assert.ok(clean.secondaryProm >= GEN2_GRID_THRESHOLDS.minSecondaryProm);
  assert.ok(clean.saddleDrop >= GEN2_GRID_THRESHOLDS.minSaddleDrop);

  // Rule 1a (edge cut): add a lower slope rising outside the right frame edge (+38 deg) so top stays interior
  const edgeCutModel = makeSyntheticTerrain([...baseHills, { x: 1700, y: 1200, height: 55, r: 170 }]);
  const cutRes = analyzeSkylineFrame(edgeCutModel, cam, { contourInterval: 10, thresholds: GEN2_GRID_THRESHOLDS });
  assert.ok(cutRes.cutRight > GEN2_GRID_THRESHOLDS.maxEdgeCut, `expected cutRight > 0.35, got ${cutRes.cutRight}`);
  assert.equal(cutRes.edgeWall, false);
  assert.equal(cutRes.runtimeEdgeCrop, false);
  assert.equal(cutRes.passesSkyline, false, 'edge-cut rule must reject slope rising outside frame');
  // Mutation check: disabling maxEdgeCut flips this case to pass (proves the rule is active)
  const cutMutated = analyzeSkylineFrame(edgeCutModel, cam, { contourInterval: 10, thresholds: { ...GEN2_GRID_THRESHOLDS, maxEdgeCut: 99 } });
  assert.equal(cutMutated.passesSkyline, true, 'mutating maxEdgeCut must make the edge-cut fixture pass');

  // Rule 1b (edge wall): a tall ridge terminating right on the right edge (cutRight ~ 0, but edge climbs to frame top)
  const edgeWallModel = makeSyntheticTerrain([...baseHills, { x: 1580, y: 1300, height: 110, r: 90 }]);
  const wallEdgeRes = analyzeSkylineFrame(edgeWallModel, cam, { contourInterval: 10, thresholds: GEN2_GRID_THRESHOLDS });
  assert.equal(wallEdgeRes.edgeWall, true, 'edge wall must be detected when a slope climbs straight into the edge');
  assert.equal(wallEdgeRes.passesSkyline, false);
  const wallEdgeMutated = analyzeSkylineFrame(edgeWallModel, cam, {
    contourInterval: 10,
    thresholds: { ...GEN2_GRID_THRESHOLDS, maxEdgeHigh: 2.0, maxEdgeCut: 99, maxSkylineAngle: 99 },
  });
  assert.equal(wallEdgeMutated.edgeWall, false, 'mutating maxEdgeHigh disables the edgeWall detector');

  // Rule 2 (edge margin): move second summit (narrow cone) to +26.5 deg (only 3.5 deg from the +30 deg frame edge)
  const edgePeakModel = makeSyntheticTerrain([
    baseHills[0],
    { x: 1500, y: 1300, height: 80, r: 42 }, // bearing ~26.6 deg -> edgeDist ~3.4 deg < 5.0 deg, drops cleanly before edge
  ]);
  const edgePeakRes = analyzeSkylineFrame(edgePeakModel, cam, { contourInterval: 10, thresholds: GEN2_GRID_THRESHOLDS });
  assert.equal(edgePeakRes.passesSkyline, false, 'minEdgeMargin must reject peak hugging the frame edge');
  const edgePeakMutated = analyzeSkylineFrame(edgePeakModel, cam, { contourInterval: 10, thresholds: { ...GEN2_GRID_THRESHOLDS, minEdgeMargin: 1.5 } });
  assert.equal(edgePeakMutated.passesSkyline, true, 'mutating minEdgeMargin must let the edge-hugging peak pass');

  // Rule 3 (secondary prominence / local prominence): shrink second summit so prom ~0.55 deg
  const subtlePeakModel = makeSyntheticTerrain([
    baseHills[0],
    { x: 1250, y: 1300, height: 18, r: 95 },
  ]);
  const subtleRes = analyzeSkylineFrame(subtlePeakModel, cam, { contourInterval: 5, thresholds: GEN2_GRID_THRESHOLDS });
  assert.equal(subtleRes.passesSkyline, false, 'secondary prominence rule must reject subtle phone bump');
  const subtleMutated = analyzeSkylineFrame(subtlePeakModel, cam, {
    contourInterval: 5,
    thresholds: { ...GEN2_GRID_THRESHOLDS, minSecondaryProm: 0.3, minSecondaryLocalProm: 0.3, minSaddleDrop: 0.3, minPeakSharpness: 0.2 },
  });
  assert.equal(subtleMutated.passesSkyline, true, 'mutating secondary prominence must allow the subtle bump');

  // Rule 4 (angular separation): place two sharp summits ~7.1 deg apart (< 8.0 deg minPeakSep)
  const closePairModel = makeSyntheticTerrain([
    { x: 920, y: 1300, height: 90, r: 35 },
    { x: 1045, y: 1300, height: 85, r: 35 },
  ]);
  const closeRes = analyzeSkylineFrame(closePairModel, cam, { contourInterval: 10, thresholds: GEN2_GRID_THRESHOLDS });
  assert.equal(closeRes.passesSkyline, false, 'minPeakSep must collapse peaks closer than 8 deg');
  const closeMutated = analyzeSkylineFrame(closePairModel, cam, {
    contourInterval: 10,
    thresholds: { ...GEN2_GRID_THRESHOLDS, minPeakSep: 4.0 },
  });
  assert.ok(closeMutated.distinctPeaks >= 2, 'mutating minPeakSep separates the close pair');
  assert.equal(closeMutated.passesSkyline, true, 'mutating minPeakSep alone lets the crisp 7-deg pair pass');

  // Rule 5 (closed-contour map summit requirement): when map prominence threshold is raised above both summits, none match
  const unmatchedRes = analyzeSkylineFrame(cleanModel, cam, {
    contourInterval: 10,
    thresholds: { ...GEN2_GRID_THRESHOLDS, minMapPromMetres: 200 },
  });
  assert.equal(unmatchedRes.distinctPeaks, 0);
  assert.equal(unmatchedRes.passesSkyline, false, 'unmatched skyline bumps without map summits must fail');

  // Rule 6 (maxSkylineAngle): huge close wall > 8.5 deg fails framing
  const wallModel = makeSyntheticTerrain([
    { x: 860, y: 780, height: 115, r: 75 },  // dist ~500 m -> ~12.8 deg tall
    { x: 1140, y: 780, height: 110, r: 75 },
  ]);
  const wallRes = analyzeSkylineFrame(wallModel, cam, { contourInterval: 10, thresholds: GEN2_GRID_THRESHOLDS });
  assert.ok(wallRes.maxAngle > GEN2_GRID_THRESHOLDS.maxSkylineAngle);
  assert.equal(wallRes.passesSkyline, false, 'maxSkylineAngle must reject looming wall filling the frame');
  const wallMutated = analyzeSkylineFrame(wallModel, cam, { contourInterval: 10, thresholds: { ...GEN2_GRID_THRESHOLDS, maxSkylineAngle: 18 } });
  assert.equal(wallMutated.passesSkyline, true, 'mutating maxSkylineAngle allows the looming wall');
});

test('mutation-style rule isolation: featureDistinction ignores foreground probes and outer edge pixels', () => {
  const mkDesc = (horizonArr, nearOffset = 0) => ({
    fov: 60,
    horizon: Float32Array.from(horizonArr),
    near: [
      Float32Array.from(horizonArr, () => nearOffset),
      Float32Array.from(horizonArr, () => nearOffset),
      Float32Array.from(horizonArr, () => nearOffset),
    ],
  });
  // Two crisp domes at col 14 (-12.5 deg) and col 34 (+12.5 deg) on 49 columns over 60 deg
  const baseH = Array.from({ length: 49 }, (_, c) => {
    const d1 = Math.exp(-(((c - 14) / 3) ** 2)) * 2.2;
    const d2 = Math.exp(-(((c - 34) / 3) ** 2)) * 1.6;
    return 1.0 + d1 + d2;
  });
  const originDesc = mkDesc(baseH, 0);
  const originPeaks = descriptorHorizonPeaks(originDesc.horizon, 60, 0.5).sort((a, b) => b.prom - a.prom);
  const relief = Math.max(...baseH) - Math.min(...baseH);

  // Case A: identical horizon, HUGE foreground probe difference (+15 deg) + outer-edge spike at col 0 only
  const fgOnlyH = [...baseH];
  fgOnlyH[0] += 8.0; // outside interior (outer 3 deg ignored!)
  const fgDesc = mkDesc(fgOnlyH, 15.0);
  const fgRes = featureDistinction(originDesc, originPeaks, relief, fgDesc, descriptorHorizonPeaks(fgDesc.horizon, 60, 0.35));
  assert.equal(fgRes.clearOnPhone, false, 'foreground probe or frame-edge-only difference must NOT pass feature uniqueness');
  assert.ok(fgRes.intCue < 0.05);

  // Case B: low crisp dome shifts by ~10 deg horizontally (Episode #32 pattern) -> passes via peak shift + relative cue!
  const shiftedH = Array.from({ length: 49 }, (_, c) => {
    const d1 = Math.exp(-(((c - 14) / 3) ** 2)) * 2.2;
    const d2 = Math.exp(-(((c - 42) / 3) ** 2)) * 1.6; // shifted by 8 cols = 10 deg
    return 1.0 + d1 + d2;
  });
  const shiftedDesc = mkDesc(shiftedH, 0);
  const shiftedRes = featureDistinction(originDesc, originPeaks, relief, shiftedDesc, descriptorHorizonPeaks(shiftedDesc.horizon, 60, 0.35));
  assert.equal(shiftedRes.clearOnPhone, true, `10-deg peak shift on low domes must pass: ${JSON.stringify(shiftedRes)}`);
  assert.ok(shiftedRes.maxPeakShift >= 8.0);
  // Mutation check: raising minPeakShift & minLargePeakShift above 15 breaks the shifted-dome detection
  const shiftedMutated = featureDistinction(originDesc, originPeaks, relief, shiftedDesc, descriptorHorizonPeaks(shiftedDesc.horizon, 60, 0.35), {
    ...GEN2_GRID_THRESHOLDS, minInteriorCue: 5, minPeakShift: 20, minLargePeakShift: 20,
  });
  assert.equal(shiftedMutated.clearOnPhone, false);
});

test('mutation-style rule isolation: resection peak analyzer separates sharp cones from flat shoulders', () => {
  const observer = { x: 1000, y: 400 };
  const sharpModel = makeSyntheticTerrain([{ x: 1000, y: 1200, height: 95, r: 80 }]);
  const sharpPeak = { x: 1000, y: 1200, prominence: 55 };
  const sharpRes = analyzeResectionPeakView(sharpModel, observer, sharpPeak, { thresholds: GEN2_RESECTION_THRESHOLDS });
  assert.equal(sharpRes.strictOk, true, `sharp cone must pass: ${JSON.stringify(sharpRes)}`);
  assert.ok(sharpRes.drop8 >= GEN2_RESECTION_THRESHOLDS.minDrop8);
  assert.ok(Math.abs(sharpRes.apexOffset) <= GEN2_RESECTION_THRESHOLDS.maxApexOffset);

  // Broad flat ridge / shoulder (wide rx=320 m): drops barely anything within +-8 deg
  const flatModel = makeSyntheticTerrain([{ x: 1000, y: 1200, height: 50, rx: 340, ry: 120 }]);
  const flatPeak = { x: 1000, y: 1200, prominence: 35 };
  const flatRes = analyzeResectionPeakView(flatModel, observer, flatPeak, { thresholds: GEN2_RESECTION_THRESHOLDS });
  assert.ok(flatRes.drop8 < GEN2_RESECTION_THRESHOLDS.minDrop8, `expected flat drop8 < 0.70, got ${flatRes.drop8}`);
  assert.equal(flatRes.strictOk, false, 'minDrop8 must reject broad flat shoulders');
  // Mutation check: removing drop8/drop12/prom limits lets the flat ridge pass
  const flatMutated = analyzeResectionPeakView(flatModel, observer, flatPeak, {
    thresholds: { ...GEN2_RESECTION_THRESHOLDS, minDrop8: 0, minDrop12: 0, minProm: 0 },
  });
  assert.equal(flatMutated.strictOk, true, 'mutating sharpness thresholds allows the flat shoulder');
});

test('gridGen2Scores rewards decoy summit pairs, interior cells, and close-but-unique horizons', () => {
  const sky = { skylineScore: 0.85, distinctPeaks: 2, secondaryLocalProm: 1.4, edgeCut: 0.05, edgeWall: false };
  const easy = gridGen2Scores({
    sky, minHorizonRMS: 1.9, minInteriorCue: 2.5, minFeatureMargin: 2.8, minAdjacentShift: 10,
    remoteCloseHorizon: 0, reasoning: { mapSummits: 6, decoyPairs: 1, decoySameOrder: 1, singlePeakCells: 4 },
    originRow: 0, originCol: 0, divisions: 8, heading: 135,
  });
  const hard = gridGen2Scores({
    sky, minHorizonRMS: 0.85, minInteriorCue: 2.0, minFeatureMargin: 2.6, minAdjacentShift: 9,
    remoteCloseHorizon: 10, reasoning: { mapSummits: 15, decoyPairs: 22, decoySameOrder: 16, singlePeakCells: 18 },
    originRow: 4, originCol: 3, divisions: 8, heading: 133,
  });
  assert.ok(hard.difficulty > easy.difficulty + 0.35, `hard ${hard.difficulty} should strongly exceed easy ${easy.difficulty}`);
  assert.ok(hard.estimatedDifficulty >= 8.0 && easy.estimatedDifficulty < 7.2);
});

test('end-to-end master grid gen=2: deterministic, north-up, phone-fair metrics, and gen=1 untouched', async () => {
  const opts = { seed: 'g2-unit-0', difficulty: 'master', mode: 'grid', gridSize: 8, world: 'karst', gen: 2 };
  const a = await generate(opts);
  const b = await generate(opts);
  assert.deepEqual(a.camera, b.camera);
  assert.equal(a.correctLabel, b.correctLabel);
  assert.deepEqual(a.gen2, b.gen2);
  assert.equal(a.gen, 2);
  assert.equal(a.mapRotation, 0);
  assert.equal(a.gen2.strict, true);
  assert.equal(a.gen2.fallback, false);
  assert.equal(a.validation.ok, true);
  assert.equal(a.lowConfidence, false);
  assert.ok(a.gen2.edgeCut <= GEN2_GRID_THRESHOLDS.maxEdgeCut);
  assert.ok(a.gen2.distinctPeaks >= 2);
  assert.ok(a.gen2.secondaryLocalProm >= GEN2_GRID_THRESHOLDS.minSecondaryLocalProm);
  assert.ok(a.gen2.peakSep >= GEN2_GRID_THRESHOLDS.minPeakSep);
  assert.equal(a.gen2.ambiguousCells, 0);
  assert.ok(a.quality.landmarkVisibility >= GEN2_GRID_THRESHOLDS.minLandmarkVisibility);
  assert.ok(a.explanation?.steps?.length >= 2);

  // Gen=1 compatibility: omitting gen leaves quiz.gen and quiz.gen2 undefined
  const g1 = await generate({ ...opts, gen: undefined });
  assert.equal(g1.gen, undefined);
  assert.equal(g1.gen2, undefined);

  // Graceful fallback on flat dunes never throws
  const dunes = await generate({ seed: 'dunes-unit-1', difficulty: 'master', mode: 'grid', gridSize: 8, world: 'dunes', gen: 2 });
  assert.equal(dunes.gen, 2);
  assert.equal(dunes.mode, 'grid');
  assert.equal(typeof dunes.gen2.fallback, 'boolean');
  assert.equal(cellAt(dunes.camera.x, dunes.camera.y, dunes.terrain.size, 8), dunes.correctLabel);
});

test('end-to-end master resection gen=2: deterministic, sharp P1/P2 peaks, zero unrefuted rivals', async () => {
  const opts = { seed: 'r2-unit-0', difficulty: 'master', mode: 'resection', resectionAnswer: 'grid', gridSize: 8, world: 'karst', gen: 2 };
  const a = await generate(opts);
  const b = await generate(opts);
  assert.deepEqual(a.camera, b.camera);
  assert.equal(a.correctLabel, b.correctLabel);
  assert.deepEqual(a.gen2, b.gen2);
  assert.equal(a.gen, 2);
  assert.equal(a.grid.onCellCentre, true);
  assert.equal(a.gen2.strict, true);
  assert.ok(a.gen2.minDrop8 >= GEN2_RESECTION_THRESHOLDS.minDrop8);
  assert.ok(a.gen2.minProm >= GEN2_RESECTION_THRESHOLDS.minProm);
  assert.ok(a.validation.fixTolerance >= fixSlack(RESECTION_BANDS.master, 8));
  const model = new TerrainModel({ ...a.terrain, meta: { world: a.terrain.world }, seed: a.terrain.modelSeed });
  const r = rivalFixes({
    model, observer: a.camera, eye: a.camera, peaks: a.resection.peaks,
    shown: a.resection.peaks.map((p) => p.shown), band: RESECTION_BANDS.master, ownCell: a.correctLabel, gridSize: 8,
  });
  assert.equal(r.unrefuted, 0);
});

test('end-to-end master friend gen=2: deterministic, friend on cell centre, self-locatable 50 deg skyline', async () => {
  const opts = { seed: 'f2-unit-1', difficulty: 'master', mode: 'friend', friendAnswer: 'grid', gridSize: 8, world: 'karst', gen: 2 };
  const a = await generate(opts);
  const b = await generate(opts);
  assert.deepEqual(a.camera, b.camera);
  assert.deepEqual(a.friend, b.friend);
  assert.equal(a.correctLabel, b.correctLabel);
  assert.deepEqual(a.gen2, b.gen2);
  assert.equal(a.gen, 2);
  assert.equal(a.mapRotation, 0);
  assert.equal(a.gen2.strict, true);
  assert.ok(Math.abs(cellBorderMargin(a.friend.x, a.friend.y, a.mapExtent, 8) - 0.5) < 1e-6);
  const model = new TerrainModel({ ...a.terrain, meta: { world: a.terrain.world }, seed: a.terrain.modelSeed });
  const sight = personSight(model, a.camera, a.friend);
  assert.equal(sight.visible, true);
  assert.ok(a.gen2.distinctPeaks >= 2);
  assert.ok(a.gen2.edgeCut <= GEN2_FRIEND_THRESHOLDS.maxEdgeCut);
  assert.equal(a.validation.ok, true);
});

test('gen2-report produces finite before/after comparison tables for all three modes', async () => {
  const report = await runReport({ n: 2, prefix: 'g2rep-unit', worlds: 'karst,glacial' });
  for (const mode of ['grid', 'resection', 'friend']) {
    for (const g of ['gen1', 'gen2']) {
      assert.equal(report[mode][g].generated, 2);
      assert.ok(Number.isFinite(report[mode][g].msMean));
      assert.ok(Number.isFinite(report[mode][g].edgeCutMean));
      assert.ok(Number.isFinite(report[mode][g].estDiffMean));
    }
  }
  const md = formatMarkdown(report);
  assert.match(md, /\| grid \| gen=2 \|/);
  assert.match(md, /\| resection \| gen=2 \|/);
  assert.match(md, /\| friend \| gen=2 \|/);
});
