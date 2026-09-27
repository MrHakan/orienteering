// TerrainAnalyzer: per-cell morphometry, landform detection and the
// TerrainSignature descriptor used to find plausible distractors.
//
// Landforms are detected from the FINAL heightmap (after noise and erosion),
// not taken from the generator's primitive list, so they always match what
// the contour map and 3D scene actually show.

import { boxBlur, distanceField, percentile, DEG, angleDiff } from './grid.js';

export const LANDFORM_TYPES = ['summit', 'knoll', 'saddle', 'ridge', 'spur', 'valley', 'reentrant', 'depression', 'slope', 'flat'];

export class TerrainAnalyzer {
  /** @param {import('./terrainModel.js').TerrainModel} model */
  constructor(model) {
    this.model = model;
    const { n, cell, heights } = model;
    this.n = n; this.cell = cell;
    const N = n * n;

    const smooth = boxBlur(heights, n, 1, 2);
    this.smooth = smooth;

    // Slope and Laplacian curvature on the lightly smoothed surface.
    this.slope = new Float32Array(N);
    this.curv = new Float32Array(N);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        const gx = (smooth[k + 1] - smooth[k - 1]) / (2 * cell);
        const gy = (smooth[k + n] - smooth[k - n]) / (2 * cell);
        this.slope[k] = Math.atan(Math.hypot(gx, gy)) / DEG;
        this.curv[k] = (smooth[k + 1] + smooth[k - 1] + smooth[k + n] + smooth[k - n] - 4 * smooth[k]) / (cell * cell);
      }
    }
    const curvLo = percentile(this.curv, 0.15), curvHi = percentile(this.curv, 0.85);

    // Relative elevation: height above the ~300 m neighbourhood mean.
    const r = Math.max(2, Math.round(75 / cell));
    const regional = boxBlur(heights, n, r, 2);
    this.relElev = new Float32Array(N);
    for (let k = 0; k < N; k++) this.relElev[k] = heights[k] - regional[k];

    const acc = model.drainage.accumulation;
    this.channelThreshold = 40;

    // Ridge / valley masks.
    this.ridgeMask = new Uint8Array(N);
    this.valleyMask = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      if (acc[k] <= 2 && this.curv[k] < curvLo && this.relElev[k] > 0) this.ridgeMask[k] = 1;
      if (acc[k] >= this.channelThreshold || (this.curv[k] > curvHi && acc[k] >= 4 && this.relElev[k] < 0)) this.valleyMask[k] = 1;
    }

    this.summits = this.detectSummits();
    this.saddles = this.detectSaddles();
    this.depressions = this.detectDepressions();

    const pointMask = (pts) => {
      const m = new Uint8Array(N);
      for (const p of pts) m[p.j * n + p.i] = 1;
      return m;
    };
    this.ridgeDist = distanceField(this.ridgeMask, n, cell);
    this.valleyDist = distanceField(this.valleyMask, n, cell);
    this.summitDist = distanceField(pointMask(this.summits), n, cell);
    this.saddleDist = distanceField(pointMask(this.saddles), n, cell);
  }

  idx(x, y) {
    const n = this.n;
    const i = Math.max(0, Math.min(n - 1, Math.round(x / this.cell)));
    const j = Math.max(0, Math.min(n - 1, Math.round(y / this.cell)));
    return j * n + i;
  }

  ringSamples(g, i, j, radius, count) {
    const n = this.n, out = new Float32Array(count);
    for (let s = 0; s < count; s++) {
      const a = (s / count) * Math.PI * 2;
      const ii = Math.max(0, Math.min(n - 1, Math.round(i + Math.cos(a) * radius)));
      const jj = Math.max(0, Math.min(n - 1, Math.round(j + Math.sin(a) * radius)));
      out[s] = g[jj * n + ii];
    }
    return out;
  }

  /** Non-maximum suppression over a list sorted by descending score. */
  static suppress(list, minDist) {
    const kept = [];
    for (const p of list) if (!kept.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < minDist)) kept.push(p);
    return kept;
  }

  detectSummits() {
    const { n, cell, smooth } = this;
    const w = 4, ringR = Math.round(150 / cell);
    const out = [];
    for (let j = w; j < n - w; j++) {
      for (let i = w; i < n - w; i++) {
        const k = j * n + i, h = smooth[k];
        let isMax = true;
        for (let dj = -w; dj <= w && isMax; dj++) for (let di = -w; di <= w; di++) if ((di || dj) && smooth[k + dj * n + di] > h) { isMax = false; break; }
        if (!isMax) continue;
        const ring = this.ringSamples(smooth, i, j, ringR, 24);
        let mean = 0;
        for (const v of ring) mean += v;
        mean /= ring.length;
        const prominence = h - mean;
        if (prominence < 4) continue;
        const near = this.ringSamples(smooth, i, j, Math.round(60 / cell), 16);
        const local = h - Math.max(...near);
        out.push({ i, j, x: i * cell, y: j * cell, z: this.model.heights[k], prominence, kind: prominence < 14 || local > 0.35 * prominence && prominence < 22 ? 'knoll' : 'summit' });
      }
    }
    out.sort((a, b) => b.prominence - a.prominence);
    return TerrainAnalyzer.suppress(out, 90);
  }

  detectSaddles() {
    const { n, cell } = this;
    const g = boxBlur(this.model.heights, n, 2, 2);
    const r1 = Math.max(3, Math.round(45 / cell)), r2 = Math.round(110 / cell);
    const out = [];
    const signChanges = (ring, c, tol) => {
      let changes = 0, prev = 0, hiCount = 0, loCount = 0;
      const signs = [];
      for (const v of ring) {
        const s = v > c + tol ? 1 : v < c - tol ? -1 : 0;
        if (s) signs.push(s);
        if (s > 0) hiCount++; else if (s < 0) loCount++;
      }
      for (let q = 0; q < signs.length; q++) {
        const s = signs[q];
        if (q > 0 && s !== prev) changes++;
        prev = s;
      }
      if (signs.length > 1 && signs[0] !== signs[signs.length - 1]) changes++;
      return { changes, hiCount, loCount };
    };
    for (let j = r2; j < n - r2; j += 1) {
      for (let i = r2; i < n - r2; i += 1) {
        const k = j * n + i;
        const gx = (g[k + 1] - g[k - 1]) / (2 * cell), gy = (g[k + n] - g[k - n]) / (2 * cell);
        const grad = Math.hypot(gx, gy);
        if (grad > 0.035) continue;
        // Hessian determinant < 0 is the saddle signature.
        const hxx = (g[k + 1] - 2 * g[k] + g[k - 1]), hyy = (g[k + n] - 2 * g[k] + g[k - n]);
        const hxy = (g[k + n + 1] - g[k + n - 1] - g[k - n + 1] + g[k - n - 1]) / 4;
        if (hxx * hyy - hxy * hxy >= 0) continue;
        const c = g[k];
        const a = signChanges(this.ringSamples(g, i, j, r1, 24), c, 0.6);
        if (a.changes < 4) continue;
        const ringB = this.ringSamples(g, i, j, r2, 32);
        const b = signChanges(ringB, c, 2.0);
        if (b.changes < 4) continue;
        const rise = Math.max(...ringB) - c, drop = c - Math.min(...ringB);
        if (rise < 4 || drop < 2) continue;
        out.push({ i, j, x: i * cell, y: j * cell, z: this.model.heights[k], score: Math.min(rise, 30) - grad * 100, kind: 'saddle' });
      }
    }
    out.sort((p, q) => q.score - p.score);
    return TerrainAnalyzer.suppress(out, 120);
  }

  detectDepressions() {
    const { n, cell } = this;
    const h = this.model.heights, filled = this.model.drainage.filled;
    const out = [];
    for (let j = 2; j < n - 2; j++) {
      for (let i = 2; i < n - 2; i++) {
        const k = j * n + i;
        const depth = filled[k] - h[k];
        if (depth < 2.0) continue;
        let isMin = true;
        for (let dj = -2; dj <= 2 && isMin; dj++) for (let di = -2; di <= 2; di++) if ((di || dj) && h[k + dj * n + di] < h[k]) { isMin = false; break; }
        if (isMin) out.push({ i, j, x: i * cell, y: j * cell, z: h[k], depth, kind: 'depression' });
      }
    }
    out.sort((a, b) => b.depth - a.depth);
    return TerrainAnalyzer.suppress(out, 150);
  }

  /** Landmarks visible in a scene: summits, knolls, saddles, depressions. */
  get landmarks() {
    if (!this._landmarks) this._landmarks = [...this.summits, ...this.saddles, ...this.depressions];
    return this._landmarks;
  }

  /** Classify the landform at a point (for future quiz modes and overlays). */
  classify(x, y) {
    const k = this.idx(x, y);
    const near = (list, d) => list.some((p) => Math.hypot(p.x - x, p.y - y) < d);
    if (near(this.depressions, 35)) return 'depression';
    if (near(this.summits.filter((s) => s.kind === 'summit'), 45)) return 'summit';
    if (near(this.summits.filter((s) => s.kind === 'knoll'), 35)) return 'knoll';
    if (near(this.saddles, 45)) return 'saddle';
    const slope = this.slope[k];
    if (this.ridgeDist[k] < 1.5 * this.cell) return slope > 6 && this.summitDist[k] > 100 ? 'spur' : 'ridge';
    if (this.valleyDist[k] < 1.5 * this.cell) {
      const acc = this.model.drainage.accumulation[k];
      return slope > 6 && acc < 600 ? 'reentrant' : 'valley';
    }
    return slope < 3 ? 'flat' : 'slope';
  }

  /**
   * TerrainSignature = [elevation, localSlope, terrainAspect, curvature,
   * relativeElevation, ridgeDistance, valleyDistance, summitDistance,
   * saddleDistance, terrainOpenness, skylineProfile(72 x 5 deg)].
   */
  getTerrainSignature(x, y, { eyeHeight = 1.7, skyline = true } = {}) {
    const m = this.model;
    const k = this.idx(x, y);
    const sig = {
      elevation: m.getElevation(x, y),
      slope: m.getSlope(x, y),
      aspect: m.getAspect(x, y),
      curvature: m.getCurvature(x, y),
      relativeElevation: this.relElev[k],
      ridgeDistance: this.ridgeDist[k],
      valleyDistance: this.valleyDist[k],
      summitDistance: this.summitDist[k],
      saddleDistance: this.saddleDist[k],
      landform: this.classify(x, y),
    };
    if (skyline) {
      sig.skyline = m.getSkyline(x, y, 0, { fov: 360, step: 5, eyeHeight });
      let o = 0;
      for (const a of sig.skyline) o += 90 - Math.max(0, a);
      sig.openness = o / sig.skyline.length;
    }
    return sig;
  }

  /**
   * Normalised signature distance (0 = identical). The skyline term compares
   * full 360 profiles; pass skyline:false signatures for a cheap comparison.
   */
  static signatureDistance(a, b, relief = 100) {
    const logd = (u, v) => Math.abs(Math.log1p(Math.min(u, 800) / 40) - Math.log1p(Math.min(v, 800) / 40));
    const terms = [
      [1.0, Math.abs(a.elevation - b.elevation) / Math.max(15, relief * 0.25)],
      [0.8, Math.abs(a.slope - b.slope) / 10],
      [0.5, a.aspect < 0 || b.aspect < 0 ? 0.5 : (angleDiff(a.aspect, b.aspect) / 90) * Math.min(1, Math.min(a.slope, b.slope) / 5)],
      [0.5, Math.abs(a.curvature - b.curvature) / 0.004],
      [0.9, Math.abs(a.relativeElevation - b.relativeElevation) / 10],
      [0.5, logd(a.ridgeDistance, b.ridgeDistance)],
      [0.5, logd(a.valleyDistance, b.valleyDistance)],
      [0.4, logd(a.summitDistance, b.summitDistance)],
      [0.3, logd(a.saddleDistance, b.saddleDistance)],
    ];
    if (a.openness !== undefined && b.openness !== undefined) terms.push([0.6, Math.abs(a.openness - b.openness) / 4]);
    if (a.skyline && b.skyline) {
      let s = 0;
      for (let q = 0; q < a.skyline.length; q++) s += (a.skyline[q] - b.skyline[q]) ** 2;
      terms.push([1.0, Math.sqrt(s / a.skyline.length) / 3]);
    }
    let sw = 0, st = 0;
    for (const [w, t] of terms) { sw += w; st += w * Math.min(t, 3); }
    return st / sw;
  }
}
