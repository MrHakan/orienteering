// Gen=1 vs Gen=2 comparison report across the three master 8x8 modes:
//   node scripts/gen2-report.mjs [--n 40] [--prefix g2r] [--modes grid,resection,friend]
//                                [--world auto] [--worlds classic,alpine,glacial,karst,canyon] [--json]
//
// Computes every skyline, uniqueness, and difficulty metric identically on both
// gen=1 and gen=2 quizzes for the exact same seeds so before/after tables are
// strictly apples-to-apples.

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { generate, framingPitch } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { resolveWorld } from '../src/engine/worlds.js';
import { gridCells } from '../src/engine/gridQuiz.js';
import { horizonDistance } from '../src/engine/skyline.js';
import { personSight } from '../src/engine/friendQuiz.js';
import { surfaceElevation } from '../src/engine/terrainSurface.js';
import { angleDiff, saturate } from '../src/engine/grid.js';
import {
  GEN2_GRID_THRESHOLDS, GEN2_TWIN_THRESHOLDS, GEN2_RESECTION_THRESHOLDS, GEN2_FRIEND_THRESHOLDS,
  qualifiedMapSummits, analyzeSkylineFrame, analyzeResectionPeakView, descriptorHorizonPeaks,
  featureDistinction, adjacentSummitShift, interiorHorizonCue, compareSkylineTwin, rankTwinScore,
  mapReasoningMetrics, gridGen2Scores,
} from '../src/engine/gen2.js';

export const MODES = {
  grid: { mode: 'grid', gridSize: 8 },
  resection: { mode: 'resection', resectionAnswer: 'grid', gridSize: 8 },
  friend: { mode: 'friend', friendAnswer: 'grid', gridSize: 8 },
};

const modelOf = (q) => new TerrainModel({ ...q.terrain, meta: { world: q.terrain.world }, seed: q.terrain.modelSeed });

function evaluateQuiz(mode, q) {
  const model = modelOf(q);
  const interval = q.terrain.contourInterval || model.chooseContourInterval();

  if (mode === 'grid') {
    const T = GEN2_GRID_THRESHOLDS;
    const sky = analyzeSkylineFrame(model, q.camera, { step: 0.5, contourInterval: interval, thresholds: T, divisions: 8 });
    const search2Pass = sky.cutLeft <= 0.6 && sky.cutRight <= 0.6
      && sky.allSkylinePeaks.filter((p) => p.prom >= 0.6 && p.edgeDist >= 2).length >= 2;
    let uniquenessMargin = q.gen2?.uniquenessMargin;
    let minInteriorCue = q.gen2?.minInteriorCue;
    let minHorizonRMS = q.gen2?.minHorizonRMS;
    let ambiguousCells = q.gen2?.ambiguousCells;
    let estDifficulty = q.gen2?.estimatedDifficulty;
    let estFairness = q.gen2?.estimatedFairness;
    let estReadability = q.gen2?.estimatedReadability;
    let decoySameOrder = q.gen2?.decoySameOrder;
    let hasTwin = q.gen2?.hasTwin;
    let nonAdjTwin = q.gen2 ? !!(q.gen2.hasTwin && !q.gen2.twinAdjacent) : undefined;
    let sameCountTwin = q.gen2?.twinSameCount;
    let twinSimilarity = q.gen2?.hasTwin ? q.gen2.twinSimilarity : NaN;
    let decisiveDetailCount = q.gen2?.hasTwin ? q.gen2.decisiveDetailCount : NaN;
    let targetReady = q.gen2?.targetReady;

    if (!Number.isFinite(uniquenessMargin) || !Number.isFinite(estDifficulty)) {
      const TW = GEN2_TWIN_THRESHOLDS;
      const cells = gridCells(model.size, 8);
      const origin = cells.find((c) => c.label === q.correctLabel);
      const summits = qualifiedMapSummits(model, interval, T.minMapPromFactor, T.minMapPromMetres);
      const baseDesc = model.skyline.viewDescriptor(q.camera.x, q.camera.y, q.camera.heading, q.camera.fov, { eyeHeight: q.camera.eyeHeight, columns: 49 });
      const pitch0 = framingPitch(Array.from(baseDesc.horizon));
      let minHD = Infinity, minIC = Infinity, minFM = Infinity, minAdj = Infinity, amb = 0, remH = 0;
      const shortlist = [];
      const hLen = baseDesc.horizon.length;
      const igCols = Math.ceil((3 / q.camera.fov) * (hLen - 1));
      for (const c of cells) {
        if (c.label === q.correctLabel) continue;
        const desc = model.skyline.viewDescriptor(c.x, c.y, q.camera.heading, q.camera.fov, { eyeHeight: q.camera.eyeHeight, columns: 49 });
        const candPeaks = descriptorHorizonPeaks(desc.horizon, q.camera.fov, 0.35);
        const fd = featureDistinction(baseDesc, sky.peaks, sky.relief, desc, candPeaks, T);
        if (fd.hRMS < minHD) minHD = fd.hRMS;
        if (fd.intCue < minIC) minIC = fd.intCue;
        if (fd.effectiveMargin < minFM) minFM = fd.effectiveMargin;
        if (!fd.clearOnPhone) amb++;
        const cheb = Math.max(Math.abs(c.row - origin.row), Math.abs(c.column - origin.column));
        if (cheb === 1) minAdj = Math.min(minAdj, adjacentSummitShift(model, q.camera, sky.peaks, c));
        else if (fd.hRMS < 1.8) remH++;
        if (sky.peaks.length >= 2 && candPeaks.length >= 1) {
          const pitch1 = framingPitch(Array.from(desc.horizon));
          if (Math.abs(pitch1 - pitch0) <= TW.maxPitchShift + 0.4) {
            let ss = 0, cnt = 0;
            for (let i = igCols; i < hLen - igCols; i++) {
              const ds = (desc.horizon[i] - pitch1) - (baseDesc.horizon[i] - pitch0);
              ss += ds * ds; cnt++;
            }
            const shapeRMS = cnt ? Math.sqrt(ss / cnt) : Infinity;
            if (shapeRMS <= Math.min(2.45, Math.max(TW.maxShapeRMS + 0.25, 0.50 * sky.relief))) {
              shortlist.push({ c, adj: cheb === 1, desc, pitch1, shapeRMS });
            }
          }
        }
      }
      if (!Number.isFinite(minAdj)) minAdj = 0;
      shortlist.sort((a, b) => (a.shapeRMS - b.shapeRMS) || a.c.label.localeCompare(b.c.label));
      const origData = {
        label: origin.label, fov: q.camera.fov, horizon: baseDesc.horizon, pitch: pitch0, relief: sky.relief,
        peaks: sky.peaks, allSkylinePeaks: sky.allSkylinePeaks,
        maxAngle: sky.maxAngle, blockedFrac: sky.blockedFrac, edgeFrac: sky.edgeFrac, edgeWall: sky.edgeWall,
      };
      const twins = [];
      for (const item of shortlist.slice(0, 10)) {
        const rSky = analyzeSkylineFrame(model, { x: item.c.x, y: item.c.y, heading: q.camera.heading, fov: q.camera.fov, eyeHeight: q.camera.eyeHeight }, {
          step: 0.5, margin: 10, contourInterval: interval, thresholds: T, summits, divisions: 8,
        });
        const cmp = compareSkylineTwin(origData, {
          label: item.c.label, fov: q.camera.fov, horizon: item.desc.horizon, pitch: item.pitch1,
          peaks: rSky.peaks, allSkylinePeaks: rSky.allSkylinePeaks,
          maxAngle: rSky.maxAngle, blockedFrac: rSky.blockedFrac, edgeFrac: rSky.edgeFrac, edgeWall: rSky.edgeWall,
        }, { adjacent: item.adj, thresholds: TW });
        if (cmp?.ambiguous) amb++;
        if (cmp?.isTwin) twins.push({ ...cmp, twinRank: rankTwinScore(cmp) });
      }
      twins.sort((a, b) => (b.twinRank - a.twinRank) || a.cell.localeCompare(b.cell));
      const primaryTwin = twins[0] || null;
      const reasoning = mapReasoningMetrics(model, origin, sky.peaks, cells, 8, interval);
      const strictGen1 = sky.passesSkyline && amb === 0 && !!primaryTwin && q.validation.ok && !q.lowConfidence;
      const scores = gridGen2Scores({
        sky, minHorizonRMS: minHD, minInteriorCue: minIC, minFeatureMargin: minFM,
        minAdjacentShift: minAdj, remoteCloseHorizon: remH, reasoning,
        originRow: origin.row, originCol: origin.column, divisions: 8, heading: q.camera.heading,
        twins, primaryTwin, ambiguousCells: amb, strict: strictGen1,
      });
      uniquenessMargin = +minFM.toFixed(2);
      minInteriorCue = +minIC.toFixed(2);
      minHorizonRMS = +minHD.toFixed(2);
      ambiguousCells = amb;
      decoySameOrder = reasoning.decoySameOrder;
      estDifficulty = scores.estimatedDifficulty;
      estFairness = scores.estimatedFairness;
      estReadability = scores.estimatedReadability;
      hasTwin = !!primaryTwin;
      nonAdjTwin = !!(primaryTwin && !primaryTwin.adjacent);
      sameCountTwin = !!primaryTwin?.sameCount;
      twinSimilarity = primaryTwin ? primaryTwin.similarity : NaN;
      decisiveDetailCount = primaryTwin ? primaryTwin.decisiveDetails.length : NaN;
      targetReady = scores.targetReady;
    }

    const strictPass = q.gen2 ? !!q.gen2.strict : (sky.passesSkyline && ambiguousCells === 0 && !!hasTwin && q.validation.ok && !q.lowConfidence);
    return {
      ok: !!(q.validation.ok && !q.lowConfidence),
      strictPass,
      strictSkyline: q.gen2 ? !!q.gen2.strictSkyline : (sky.passesSkyline && ambiguousCells === 0),
      targetReady: !!targetReady,
      hasTwin: !!hasTwin,
      nonAdjTwin: !!nonAdjTwin,
      sameCountTwin: !!sameCountTwin,
      twinSimilarity,
      decisiveDetailCount,
      search2Pass,
      edgeCut: sky.edgeCut,
      distinctPeaks: sky.distinctPeaks,
      primaryProm: sky.primaryProm,
      secondaryProm: sky.secondaryProm,
      secondaryLocalProm: sky.secondaryLocalProm,
      peakSep: sky.peakSep,
      uniquenessMargin,
      minInteriorCue,
      minHorizonRMS,
      decoySameOrder,
      estDifficulty,
      estFairness,
      estReadability,
    };
  }

  if (mode === 'resection') {
    const T = GEN2_RESECTION_THRESHOLDS;
    const pvs = q.resection.peaks.map((p) => {
      const s = model.analyzer.summits.find((x) => Math.hypot(x.x - p.x, x.y - p.y) < 10);
      return analyzeResectionPeakView(model, q.camera, { ...p, prominence: s?.prominence || 0 }, { thresholds: T });
    });
    const minDrop8 = Math.min(...pvs.map((v) => v.drop8));
    const minProm = Math.min(...pvs.map((v) => v.prom));
    const maxProm = Math.max(...pvs.map((v) => v.prom));
    const minPeakSize = Math.min(...pvs.map((v) => v.peakSize));
    const maxEdgeCut = Math.max(...pvs.map((v) => v.edgeCut));
    const crossing = q.resection.peaks.length >= 2 ? angleDiff(q.resection.peaks[0].bearing, q.resection.peaks[1].bearing) : 0;
    const tol = q.validation.fixTolerance ?? 0;
    const weak = q.validation.rivalFixes?.weak ?? 0;
    const sharpPeaks = pvs.filter((v) => v.strictOk).length;
    const strictPass = q.gen2 ? !!q.gen2.strict : (pvs.every((v) => v.strictOk) && tol >= T.minFixTolerance);
    const estDifficulty = q.gen2?.estimatedDifficulty ?? +(6.0 + 3.4 * saturate(q.hardness)).toFixed(1);
    const estFairness = q.gen2?.estimatedFairness ?? +(4.5 + 4.8 * Math.min(...pvs.map((v) => v.score))).toFixed(1);
    const estReadability = q.gen2?.estimatedReadability ?? +(4.5 + 4.3 * saturate(minDrop8 / 1.6)).toFixed(1);
    return {
      ok: !!(q.validation.ok && !q.lowConfidence),
      strictPass,
      search2Pass: sharpPeaks === pvs.length,
      edgeCut: +maxEdgeCut.toFixed(2),
      distinctPeaks: sharpPeaks,
      primaryProm: +maxProm.toFixed(2),
      secondaryProm: +minProm.toFixed(2),
      secondaryLocalProm: +minDrop8.toFixed(2),
      peakSep: +crossing.toFixed(1),
      uniquenessMargin: +tol.toFixed(2),
      minPeakSize: +minPeakSize.toFixed(2),
      weakRivals: weak,
      estDifficulty,
      estFairness,
      estReadability,
    };
  }

  // Friend mode
  const T = GEN2_FRIEND_THRESHOLDS;
  const sky = analyzeSkylineFrame(model, q.camera, { step: 0.5, contourInterval: interval, thresholds: T, divisions: 8 });
  const search2Pass = sky.cutLeft <= 0.6 && sky.cutRight <= 0.6
    && sky.allSkylinePeaks.filter((p) => p.prom >= 0.6 && p.edgeDist >= 2).length >= 2;
  let uniquenessMargin = q.gen2?.uniquenessMargin;
  if (!Number.isFinite(uniquenessMargin)) {
    const cam = q.camera, baseDesc = model.skyline.viewDescriptor(cam.x, cam.y, cam.heading, cam.fov, { eyeHeight: cam.eyeHeight, columns: 33 });
    let minIC = Infinity;
    for (const m of (q.friend.matches || []).filter((x) => !x.correct && x.observer)) {
      const desc = model.skyline.viewDescriptor(m.observer.x, m.observer.y, cam.heading, cam.fov, { eyeHeight: cam.eyeHeight, columns: 33 });
      minIC = Math.min(minIC, interiorHorizonCue(baseDesc, desc, 3));
    }
    uniquenessMargin = Number.isFinite(minIC) ? +minIC.toFixed(2) : (q.validation.weakestCue ?? 0);
  }
  const strictPass = q.gen2 ? !!q.gen2.strict : (sky.passesSkyline && q.validation.ok && !q.lowConfidence && uniquenessMargin >= T.minInteriorCue);
  const estDifficulty = q.gen2?.estimatedDifficulty ?? +(6.2 + 3.2 * saturate(q.hardness)).toFixed(1);
  const estFairness = q.gen2?.estimatedFairness ?? +(4.5 + 4.8 * sky.skylineScore).toFixed(1);
  const estReadability = q.gen2?.estimatedReadability ?? +(4.5 + 4.3 * sky.skylineScore).toFixed(1);
  return {
    ok: !!(q.validation.ok && !q.lowConfidence),
    strictPass,
    search2Pass,
    edgeCut: sky.edgeCut,
    distinctPeaks: sky.distinctPeaks,
    primaryProm: sky.primaryProm,
    secondaryProm: sky.secondaryProm,
    secondaryLocalProm: sky.secondaryLocalProm,
    peakSep: sky.peakSep,
    uniquenessMargin,
    estDifficulty,
    estFairness,
    estReadability,
  };
}

const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const quantile = (a, p) => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const fmt = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : '—';

export async function runReport({
  n = 40,
  prefix = 'g2r',
  modes = ['grid', 'resection', 'friend'],
  world = 'auto',
  worlds = null,
  difficulty = 'master',
} = {}) {
  const worldList = worlds ? worlds.split(',') : null;
  const out = {};

  for (const mode of modes) {
    if (!MODES[mode]) throw new Error(`Unknown mode ${mode}`);
    out[mode] = {};
    for (const gen of [1, 2]) {
      const rows = [];
      const failed = [];
      const byWorld = {};
      for (let i = 0; i < n; i++) {
        const seed = `${prefix}-${mode}-${i}`;
        const w = worldList ? worldList[i % worldList.length] : world;
        const resolved = resolveWorld(w, seed);
        const t0 = performance.now();
        let q;
        try {
          q = await generate({ seed, world: w, difficulty, gen, ...MODES[mode] });
        } catch (err) {
          const ms = performance.now() - t0;
          failed.push({ seed, world: resolved, ms, error: err.message });
          (byWorld[resolved] ??= []).push({ seed, world: resolved, failed: true, ms });
          continue;
        }
        const ms = performance.now() - t0;
        const metrics = evaluateQuiz(mode, q);
        const row = { seed, world: q.terrain.world, label: q.correctLabel, ms, ...metrics };
        rows.push(row);
        (byWorld[q.terrain.world] ??= []).push(row);
      }
      const allMs = [...rows, ...failed].map((r) => r.ms);
      const col = (k) => rows.map((r) => r[k]).filter(Number.isFinite);
      out[mode][`gen${gen}`] = {
        n,
        generated: rows.length,
        failed: failed.length,
        valid: rows.filter((r) => r.ok).length,
        strictPass: rows.filter((r) => r.strictPass).length,
        targetReady: rows.filter((r) => r.targetReady).length,
        hasTwin: rows.filter((r) => r.hasTwin).length,
        nonAdjTwin: rows.filter((r) => r.nonAdjTwin).length,
        sameCountTwin: rows.filter((r) => r.sameCountTwin).length,
        twinSimMean: mean(col('twinSimilarity')),
        detailCountMean: mean(col('decisiveDetailCount')),
        search2Pass: rows.filter((r) => r.search2Pass).length,
        msMean: mean(allMs),
        msP50: quantile(allMs, 0.5),
        msP90: quantile(allMs, 0.9),
        edgeCutMean: mean(col('edgeCut')),
        edgeCutP50: quantile(col('edgeCut'), 0.5),
        edgeCutP90: quantile(col('edgeCut'), 0.9),
        peaksMean: mean(col('distinctPeaks')),
        primaryPromMean: mean(col('primaryProm')),
        secondaryPromMean: mean(col('secondaryProm')),
        secondaryLocalPromMean: mean(col('secondaryLocalProm')),
        peakSepMean: mean(col('peakSep')),
        uniquenessMean: mean(col('uniquenessMargin')),
        uniquenessP10: quantile(col('uniquenessMargin'), 0.1),
        estDiffMean: mean(col('estDifficulty')),
        estDiffP50: quantile(col('estDifficulty'), 0.5),
        estDiffGe8: rows.filter((r) => r.estDifficulty >= 8.0).length,
        estFairMean: mean(col('estFairness')),
        estReadMean: mean(col('estReadability')),
        byWorld: Object.fromEntries(Object.entries(byWorld).sort((a, b) => a[0].localeCompare(b[0])).map(([w, list]) => {
          const okList = list.filter((x) => !x.failed);
          return [w, {
            n: list.length,
            generated: okList.length,
            strictPass: okList.filter((x) => x.strictPass).length,
            targetReady: okList.filter((x) => x.targetReady).length,
            nonAdjTwin: okList.filter((x) => x.nonAdjTwin).length,
            sameCountTwin: okList.filter((x) => x.sameCountTwin).length,
            msMean: mean(list.map((x) => x.ms)),
            edgeCutMean: mean(okList.map((x) => x.edgeCut)),
            secondaryPromMean: mean(okList.map((x) => x.secondaryProm)),
            twinSimMean: mean(okList.map((x) => x.twinSimilarity).filter(Number.isFinite)),
            estDiffMean: mean(okList.map((x) => x.estDifficulty)),
          }];
        })),
        rows,
      };
    }
  }
  return out;
}

export function formatMarkdown(report) {
  const lines = [
    '| mode | gen | generated | valid | strict gen2 | targetReady | twin (nonAdj/sameCnt) | twinSim | ms mean/p50/p90 | edgeCut mean/p90 (°) | peaks | prom1/prom2 (°) | uniqMargin mean/p10 | estD mean (≥8) | estF | estR |',
    '|------|-----|-----------|-------|-------------|-------------|-----------------------|---------|-----------------|----------------------|-------|-----------------|---------------------|----------------|------|------|',
  ];
  for (const [mode, pair] of Object.entries(report)) {
    for (const g of [1, 2]) {
      const m = pair[`gen${g}`];
      const pct = (v) => `${v}/${m.n} (${Math.round((v / m.n) * 100)}%)`;
      const twinCol = mode === 'grid' ? `${m.hasTwin}/${m.n} (${m.nonAdjTwin}/${m.sameCountTwin})` : '—';
      const readyCol = mode === 'grid' ? pct(m.targetReady) : '—';
      lines.push(
        `| ${mode} | gen=${g} | ${m.generated}/${m.n} | ${m.valid}/${m.n} | ${pct(m.strictPass)} | ${readyCol} | ${twinCol} | ${fmt(m.twinSimMean)} `
        + `| ${fmt(m.msMean, 0)}/${fmt(m.msP50, 0)}/${fmt(m.msP90, 0)} `
        + `| ${fmt(m.edgeCutMean)}/${fmt(m.edgeCutP90)} | ${fmt(m.peaksMean)} `
        + `| ${fmt(m.primaryPromMean)}/${fmt(m.secondaryPromMean)} `
        + `| ${fmt(m.uniquenessMean)}/${fmt(m.uniquenessP10)} `
        + `| ${fmt(m.estDiffMean, 1)} (${m.estDiffGe8}/${m.n}) | ${fmt(m.estFairMean, 1)} | ${fmt(m.estReadMean, 1)} |`
      );
    }
  }

  lines.push('', '### Per-world breakdown (gen=1 vs gen=2)', '');
  lines.push('| mode | world | n | gen=1 strict | gen=2 strict | gen=2 ready | gen=2 nonAdj/same | gen=1 ms | gen=2 ms | gen=2 edgeCut | gen=2 twinSim | gen=2 estD |');
  lines.push('|------|-------|---|--------------|--------------|-------------|-------------------|----------|----------|---------------|---------------|------------|');
  for (const [mode, pair] of Object.entries(report)) {
    const g1 = pair.gen1.byWorld, g2 = pair.gen2.byWorld;
    for (const w of Object.keys(g2).sort()) {
      const a = g1[w] || { n: 0, strictPass: 0, msMean: NaN };
      const b = g2[w];
      const rdy = mode === 'grid' ? `${b.targetReady}/${b.n}` : '—';
      const na = mode === 'grid' ? `${b.nonAdjTwin}/${b.sameCountTwin}` : '—';
      lines.push(`| ${mode} | ${w} | ${b.n} | ${a.strictPass}/${a.n} | ${b.strictPass}/${b.n} | ${rdy} | ${na} | ${fmt(a.msMean, 0)} | ${fmt(b.msMean, 0)} | ${fmt(b.edgeCutMean)} | ${fmt(b.twinSimMean)} | ${fmt(b.estDiffMean, 1)} |`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  const opts = {
    n: Number(arg('n', 40)),
    prefix: arg('prefix', 'g2r'),
    modes: arg('modes', 'grid,resection,friend').split(','),
    world: arg('world', 'auto'),
    worlds: arg('worlds', null),
    difficulty: arg('difficulty', 'master'),
  };
  const report = await runReport(opts);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ options: opts, report }, null, 2));
  } else {
    console.log(`Gen=1 vs Gen=2 Report (d=${opts.difficulty}, g=8, N=${opts.n}, worlds=${opts.worlds || opts.world}, prefix=${opts.prefix})\n`);
    console.log(formatMarkdown(report));
  }
}
