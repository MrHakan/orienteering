// Question-quality report for the three main TopoGuess modes (Instagram series):
// grid, resection grid and friend grid at d=master.
//
//   node scripts/quality-report.mjs [--n 60] [--world auto] [--prefix qq] [--modes grid,resection,friend]
//                                   [--difficulty master] [--deep] [--json]
//
// Seeds are `${prefix}-0` … `${prefix}-${n - 1}`. Times include failed generations, and a per-world
// table shows where failures and slow seeds come from (e.g. repetitive dunes). Every fairness KPI is computed
// here, independently of the engine's own metrics, so the same report runs on
// older commits and before/after tables stay comparable. `--deep` adds the slow
// lattice scans (look-alike spots away from cell centres).
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { descriptorDistance } from '../src/engine/skyline.js';
import { personSight, cellBorderMargin } from '../src/engine/friendQuiz.js';
import { gridCells, cellAt } from '../src/engine/gridQuiz.js';
import { surfaceElevation } from '../src/engine/terrainSurface.js';
import { DEG, angleDiff } from '../src/engine/grid.js';
import { bearingTo } from '../src/engine/mapModes.js';
import { resolveWorld } from '../src/engine/worlds.js';
import { pathToFileURL } from 'node:url';

export const MODES = {
  grid: { mode: 'grid', gridSize: 8 },
  resection: { mode: 'resection', resectionAnswer: 'grid', gridSize: 8 },
  friend: { mode: 'friend', friendAnswer: 'grid', gridSize: 8 },
};
// LIMIT: a friend sighting from another cell closer than this is a second answer (the Master floor;
// fixed here so every engine version and level is judged alike).
const SIZE = 8, FAR = 240, LATTICE = 48, LIMIT = 0.8;

const modelOf = (quiz) => new TerrainModel({ ...quiz.terrain, meta: { world: quiz.terrain.world }, seed: quiz.terrain.modelSeed });
const rowCol = (label) => [label.charCodeAt(0) - 65, +label.slice(1) - 1];
const chebyshev = (a, b) => { const [r0, c0] = rowCol(a), [r1, c1] = rowCol(b); return Math.max(Math.abs(r0 - r1), Math.abs(c0 - c1)); };
const edgeCell = (label) => rowCol(label).some((v) => v === 0 || v === SIZE - 1) ? 1 : 0;
const wholeMap = (L) => ({ x: L / 2, y: L / 2, size: L });

function sees(model, a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.ceil(d / (model.cell / 2));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (model.getElevation(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) > a.z + (b.z - a.z) * t - 0.5) return false;
  }
  return true;
}

/** Per-quiz fairness numbers, one function per mode. */
const KPI = {
  grid(quiz, deep) {
    const wrong = quiz.options.filter((o) => !o.correct).sort((a, b) => a.D - b.D), minD = quiz.validation.minRequiredDistance;
    const closest = wrong[0], gate = [closest, ...wrong.filter((o) => o.D < 2 * minD)];
    const row = { margin: cellBorderMargin(quiz.camera.x, quiz.camera.y, wholeMap(quiz.terrain.size), SIZE),
      closestD: closest.D, weakCue: Math.min(...gate.map((o) => o.cue.magnitude)), lookalikes: gate.length - 1,
      adjacent: chebyshev(closest.label, quiz.correctLabel) === 1 ? 1 : 0, edge: edgeCell(quiz.correctLabel), faint: quiz.validation.faintCue ? 1 : 0 };
    if (deep) {
      // Off-centre spots in other cells, at least FAR m away, whose view is closer than the ambiguity limit.
      const model = modelOf(quiz), L = model.size, cam = quiz.camera;
      const describe = (x, y) => model.skyline.viewDescriptor(x, y, cam.heading, cam.fov, { eyeHeight: cam.eyeHeight, columns: 49 });
      const base = describe(cam.x, cam.y);
      let far = Infinity;
      for (let y = 40; y < L - 40; y += LATTICE) for (let x = 40; x < L - 40; x += LATTICE) {
        if (cellAt(x, y, L, SIZE) === quiz.correctLabel || model.getSlope(x, y) > 26 || Math.hypot(x - cam.x, y - cam.y) < FAR) continue;
        const desc = describe(x, y);
        if (desc.edgeFrac <= 0.45) far = Math.min(far, descriptorDistance(base, desc));
      }
      row.farSpotD = far;
      row.farLookalike = far < minD ? 1 : 0;
    }
    return row;
  },

  resection(quiz) {
    const model = modelOf(quiz), L = model.size, o = quiz.camera, own = quiz.correctLabel, peaks = quiz.resection.peaks, shown = peaks.map((p) => p.shown);
    const summits = model.analyzer.summits, ranges = peaks.map((p) => Math.hypot(p.x - o.x, p.y - o.y));
    const prominence = peaks.map((p) => summits.find((s) => Math.hypot(s.x - p.x, s.y - p.y) < 1)?.prominence || 0);
    // Rival fixes: two other labelled-size hills whose back-bearings cross in another cell, and no cue
    // (hidden hill, distance ×2/÷2, eye-level difference) tells that spot apart in the view.
    const hills = summits.filter((s) => model.inside(s.x, s.y, 60) && (s.kind === 'summit' || s.prominence >= 7))
      .map((s) => ({ x: s.x, y: s.y, z: surfaceElevation(model, s.x, s.y) + 2 }));
    const [u, v] = shown.map((b) => ({ x: Math.sin((b + 180) * DEG), y: Math.cos((b + 180) * DEG) })), det = v.x * u.y - u.x * v.y;
    const isPeak = (h, i) => Math.hypot(h.x - peaks[i].x, h.y - peaks[i].y) < 1;
    let rivals = 0, unrefuted = 0;
    for (const a of hills) for (const b of hills) {
      if (a === b || (isPeak(a, 0) && isPeak(b, 1))) continue;
      const dx = b.x - a.x, dy = b.y - a.y, t = (v.x * dy - v.y * dx) / det, s = (u.x * dy - u.y * dx) / det;
      if (!(t >= 250 && t <= 1600 && s >= 250 && s <= 1600)) continue;
      const pt = { x: a.x + u.x * t, y: a.y + u.y * t };
      if (!model.inside(pt.x, pt.y, 80) || model.getSlope(pt.x, pt.y) > 26 || cellAt(pt.x, pt.y, L, SIZE) === own) continue;
      rivals++;
      const at = { ...pt, z: surfaceElevation(model, pt.x, pt.y) + 1.7 };
      const cues = [a, b].filter((h, i) => {
        const d = Math.hypot(h.x - pt.x, h.y - pt.y), e = Math.atan2(h.z - at.z, d) / DEG, e0 = peaks[i].elevation;
        return !sees(model, at, h) || d / ranges[i] >= 2 || d / ranges[i] <= 0.5
          || (Math.sign(e) !== Math.sign(e0) && Math.abs(e - e0) >= 1.5) || Math.abs(e - e0) >= 4;
      }).length;
      if (!cues) unrefuted++;
    }
    // Fix tolerance: the smallest reading error (worst bearing) that lets a spot outside the answer cell fit.
    let tolerance = Infinity;
    for (let dy = -500; dy <= 500; dy += 10) for (let dx = -500; dx <= 500; dx += 10) {
      const q = { x: o.x + dx, y: o.y + dy };
      if (cellAt(q.x, q.y, L, SIZE) === own) continue;
      tolerance = Math.min(tolerance, Math.max(...peaks.map((p, k) => angleDiff(bearingTo(q, p), shown[k]))));
    }
    return { margin: cellBorderMargin(o.x, o.y, wholeMap(L), SIZE), rivalFixes: rivals, unrefuted, anyUnrefuted: unrefuted ? 1 : 0,
      fixTolerance: tolerance, minPeakSize: Math.min(...peaks.map((p, i) => Math.atan(prominence[i] / ranges[i]) / DEG)),
      farPeak: Math.max(...ranges), crossing: angleDiff(peaks[0].bearing, peaks[1].bearing), edge: edgeCell(own) };
  },

  friend(quiz, deep) {
    const model = modelOf(quiz), L = model.size, cam = quiz.camera, T = quiz.friend, dx = T.x - cam.x, dy = T.y - cam.y;
    const describe = (c) => model.skyline.viewDescriptor(c.x, c.y, c.heading, cam.fov, { eyeHeight: c.z - model.getElevation(c.x, c.y), columns: 33 });
    const base = describe(cam), seen = personSight(model, cam, T), tol = quiz.validation.elevationTolerance, minD = LIMIT;
    // Another place for the friend, seen at the same bearing, range and eye-level angle: its view distance.
    const scan = (points, { far = 0, inside = 70, cell = SIZE } = {}) => {
      let min = Infinity, ambiguous = 0;
      for (const c of points) {
        if (cellAt(c.x, c.y, L, cell) === quiz.correctLabel || Math.hypot(c.x - T.x, c.y - T.y) < far) continue;
        const p = { x: c.x - dx, y: c.y - dy };
        if (!model.inside(p.x, p.y, inside) || model.getSlope(p.x, p.y) > 26 || model.getSlope(c.x, c.y) > 26) continue;
        const obs = { ...cam, ...p, z: surfaceElevation(model, p.x, p.y) + cam.eyeHeight }, sight = personSight(model, obs, c);
        if (!sight.visible || Math.abs(sight.elevation - seen.elevation) > tol) continue;
        const D = descriptorDistance(base, describe(obs));
        if (D < minD) ambiguous++;
        min = Math.min(min, D);
      }
      return { min, ambiguous };
    };
    const centres = scan(gridCells(L, SIZE));
    const row = { margin: cellBorderMargin(T.x, T.y, quiz.mapExtent, SIZE), centreMinD: centres.min, centreAmbiguous: centres.ambiguous ? 1 : 0,
      matchMinD: quiz.validation.minDistance, edge: edgeCell(quiz.correctLabel), flagged: quiz.validation.lookalikeElsewhere ? 1 : 0 };
    if (deep) {
      const lattice = [];
      for (let y = 70; y < L - 70; y += LATTICE) for (let x = 70; x < L - 70; x += LATTICE) lattice.push({ x, y });
      const far = scan(lattice, { far: FAR, inside: 0 });
      row.farSpotD = far.min;
      row.farLookalike = far.ambiguous ? 1 : 0;
      row.farLookalikeFlagged = far.ambiguous && row.flagged ? 1 : 0;
    }
    return row;
  },
};

const sorted = (a) => [...a].sort((x, y) => x - y);
const quantile = (a, p) => { const s = sorted(a); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
export function stats(values) {
  const a = values.filter(Number.isFinite), m = mean(a);
  return { n: a.length, min: Math.min(...a), p10: quantile(a, 0.1), p50: quantile(a, 0.5), p90: quantile(a, 0.9), max: Math.max(...a), mean: m,
    sd: Math.sqrt(mean(a.map((v) => (v - m) ** 2))), uniq: new Set(a.map((v) => v.toFixed(2))).size };
}
export function correlation(x, y) {
  const mx = mean(x), my = mean(y), c = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  const sx = Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0)), sy = Math.sqrt(y.reduce((s, v) => s + (v - my) ** 2, 0));
  return sx && sy ? c / (sx * sy) : NaN;
}
/** Per world: generated / failed, mean time (failures included), medians and flagged (low-confidence) count. */
export function byWorld(rows, failed) {
  const out = {};
  for (const r of [...rows, ...failed]) {
    const w = out[r.world] ??= { n: 0, generated: 0, ms: [], hardness: [], confidence: [], flagged: 0 };
    w.n++; w.ms.push(r.ms);
    if (r.error) continue;
    w.generated++; w.hardness.push(r.hardness); w.confidence.push(r.confidence); w.flagged += r.flagged || 0;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].n - a[1].n).map(([k, w]) => [k, { n: w.n, generated: w.generated,
    msMean: mean(w.ms), hardnessP50: quantile(w.hardness, 0.5), confidenceP50: quantile(w.confidence, 0.5), flagged: w.flagged }]));
}

/**
 * Generate `n` quizzes per mode (d=master unless `difficulty` says otherwise) and summarise them.
 * Failed generations are timed too: `stats.ms` covers every seed.
 */
export async function measure({ n = 60, world = 'auto', prefix = 'qq', modes = Object.keys(MODES), deep = false, difficulty = 'master' } = {}) {
  const out = {};
  for (const name of modes) {
    if (!MODES[name]) throw new Error(`Unknown mode ${name}`);
    const rows = [], failed = [];
    for (let i = 0; i < n; i++) {
      const seed = `${prefix}-${i}`, t0 = performance.now();
      let quiz;
      try { quiz = await generate({ seed, world, difficulty, ...MODES[name] }); } catch (e) {
        failed.push({ seed, world: resolveWorld(world, seed), error: e.message, ms: performance.now() - t0 }); continue;
      }
      const ms = performance.now() - t0;
      rows.push({ seed, world: quiz.terrain.world, label: quiz.correctLabel, ok: !!quiz.validation.ok, hardness: quiz.hardness,
        confidence: quiz.validation.confidence, ms, flagged: quiz.lowConfidence || !quiz.validation.ok ? 1 : 0, ...KPI[name](quiz, deep) });
    }
    out[name] = { n, difficulty, ...summarise(rows, failed) };
  }
  return out;
}

/** Statistics of one mode's rows; failed generations count in the time and per-world numbers. */
export function summarise(rows, failed) {
  const numeric = rows.length ? Object.keys(rows[0]).filter((k) => typeof rows[0][k] === 'number') : [];
  return { generated: rows.length, valid: rows.filter((r) => r.ok).length, flagged: rows.filter((r) => r.flagged).length, failed, rows,
    stats: { ...Object.fromEntries(numeric.map((k) => [k, stats(rows.map((r) => r[k]))])), ms: stats([...rows, ...failed].map((r) => r.ms)) },
    corr: correlation(rows.map((r) => r.hardness), rows.map((r) => r.confidence)),
    worlds: byWorld(rows, failed), labels: new Set(rows.map((r) => r.label)).size };
}

// Per-mode fairness lines: [label, how to show it].
const count = (key) => (m) => `${m.rows.filter((r) => r[key]).length}/${m.rows.length}`;
const dist = (key, d = 2) => (m) => m.stats[key] ? `min ${fmt(m.stats[key].min, d)} p10 ${fmt(m.stats[key].p10, d)} p50 ${fmt(m.stats[key].p50, d)}` : '—';
const KPI_LINES = {
  grid: [['weakest look-alike cue (°)', dist('weakCue')], ['look-alike cells (D < 2·minD)', dist('lookalikes', 0)], ['closest cell D', dist('closestD')],
    ['closest look-alike adjacent', count('adjacent')], ['answer on an edge cell', count('edge')], ['faint-cue fallback (flagged)', count('faint')], ['[deep] far off-centre look-alike', count('farLookalike')]],
  resection: [['quiz with an unrefuted rival fix', count('anyUnrefuted')], ['unrefuted rival fixes', dist('unrefuted', 0)],
    ['fix tolerance T (°)', dist('fixTolerance')], ['smallest peak size (°)', dist('minPeakSize')], ['farthest peak (m)', dist('farPeak', 0)],
    ['answer on an edge cell', count('edge')]],
  friend: [['other cell centre ambiguous', count('centreAmbiguous')], ['closest other centre D', dist('centreMinD')],
    ['flagged lookalikeElsewhere', count('flagged')], ['[deep] far lattice ambiguous', count('farLookalike')],
    ['[deep] … of which flagged', count('farLookalikeFlagged')], ['answer on an edge cell', count('edge')]],
};
const fmt = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : '—';
const q3 = (s) => s ? `${fmt(s.p10)}/${fmt(s.p50)}/${fmt(s.p90)} (sd ${fmt(s.sd, 3)}, uniq ${s.uniq})` : '—';

export function markdown(result, { deep = false } = {}) {
  const lines = ['| mode | generated (flagged) | hardness p10/p50/p90 | confidence p10/p50/p90 | corr(h,c) | margin min/p10/p50 | ms mean/p50/p90/max (all seeds) | labels |',
    '|------|---------------------|----------------------|------------------------|-----------|--------------------|---------------------------------|--------|'];
  for (const [name, m] of Object.entries(result)) {
    const s = m.stats, ms = s.ms || {};
    lines.push(`| ${name} | ${m.generated}/${m.n} (${m.flagged}) | ${q3(s.hardness)} | ${q3(s.confidence)} | ${fmt(m.corr)} | ${s.margin ? `${fmt(s.margin.min)}/${fmt(s.margin.p10)}/${fmt(s.margin.p50)}` : '—'} `
      + `| ${fmt(ms.mean, 0)}/${fmt(ms.p50, 0)}/${fmt(ms.p90, 0)}/${fmt(ms.max, 0)} | ${m.labels} |`);
  }
  lines.push('', '| mode | world | generated | ms mean (all seeds) | hardness p50 | confidence p50 | flagged |', '|------|-------|-------|---------------------|--------------|----------------|---------|');
  for (const [name, m] of Object.entries(result)) for (const [world, w] of Object.entries(m.worlds)) {
    lines.push(`| ${name} | ${world} | ${w.generated}/${w.n} | ${fmt(w.msMean, 0)} | ${fmt(w.hardnessP50)} | ${fmt(w.confidenceP50)} | ${w.flagged} |`);
  }
  for (const [name, m] of Object.entries(result)) {
    lines.push('', `${name}:`);
    for (const [label, show] of KPI_LINES[name]) if (deep || !label.startsWith('[deep]')) lines.push(`  ${label.padEnd(36)} ${show(m)}`);
    for (const f of m.failed) lines.push(`  FAILED ${f.seed} (${f.world}, ${fmt(f.ms, 0)} ms): ${f.error}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  const opts = { n: +arg('n', 60), world: arg('world', 'auto'), prefix: arg('prefix', 'qq'), modes: arg('modes', Object.keys(MODES).join(',')).split(','),
    deep: args.includes('--deep'), difficulty: arg('difficulty', 'master') };
  const result = await measure(opts);
  if (args.includes('--json')) console.log(JSON.stringify({ options: opts, result }, (k, v) => typeof v === 'number' && !Number.isFinite(v) ? null : v, 1));
  else console.log(`Quality report: d=${opts.difficulty}, g=${SIZE}, world=${opts.world}, seeds ${opts.prefix}-0…${opts.prefix}-${opts.n - 1}${opts.deep ? ', deep' : ''}\n\n${markdown(result, opts)}`);
}
