// ViewpointGenerator: searches hundreds of candidate observer positions and
// headings and scores how informative each first-person view is.

import { soft, saturate, angleDiff, wrap360, DEG } from './grid.js';
import { horizonDistance } from './skyline.js';
import { candidateHeadings } from './heading.js';

const RAY_STEP = 2.5; // degrees between rays in the 360 degree sweep
const MAX_LANDMARK_DIST = 1700;

export class ViewpointGenerator {
  /**
   * @param {import('./terrainModel.js').TerrainModel} model
   * @param {object} preset difficulty preset
   * @param {import('./rng.js').Random} rng
   */
  constructor(model, preset, rng, { fov, eyeHeight, gridSize = 16, margin = 110, maxPicks = 16 } = {}) {
    this.model = model;
    this.analyzer = model.analyzer;
    this.preset = preset;
    this.rng = rng;
    this.fov = fov;
    this.eyeHeight = eyeHeight;
    this.gridSize = gridSize;
    this.margin = margin;
    this.maxPicks = maxPicks;
  }

  candidatePositions() {
    const { model, rng, gridSize, margin } = this;
    const span = model.size - 2 * margin;
    const cellW = span / gridSize;
    const out = [];
    for (let j = 0; j < gridSize; j++) {
      for (let i = 0; i < gridSize; i++) {
        const x = margin + (i + rng.range(0.15, 0.85)) * cellW;
        const y = margin + (j + rng.range(0.15, 0.85)) * cellW;
        if (model.getSlope(x, y) > 26) continue; // not walkable
        out.push({ x, y });
      }
    }
    return out;
  }

  /** One 360 degree sweep per position; per-ray statistics reused for every heading. */
  sweep(p) {
    const { model, analyzer } = this;
    const sky = model.skyline;
    const z = sky.eyeZ(p.x, p.y, this.eyeHeight);
    const count = Math.round(360 / RAY_STEP);
    const rays = [];
    const n = model.n;
    for (let r = 0; r < count; r++) {
      const st = { n: 0, s: 0, s2: 0, ridge: 0, valley: 0 };
      const ray = sky.castRay(p.x, p.y, z, r * RAY_STEP, (px, py, h, dist) => {
        if (dist < 15) return;
        // Weight samples by the screen angle they subtend (rough): nearer = bigger.
        st.n++; st.s += h; st.s2 += h * h;
        const k = Math.round(py / model.cell) * n + Math.round(px / model.cell);
        if (analyzer.ridgeMask[k]) st.ridge++;
        if (analyzer.valleyMask[k]) st.valley++;
      });
      rays.push({ ...ray, st });
    }
    // Landmark line-of-sight, once per position.
    const visible = [];
    for (const lm of analyzer.landmarks) {
      const dx = lm.x - p.x, dy = lm.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 60 || d > MAX_LANDMARK_DIST) continue;
      if (this.lineOfSight(p.x, p.y, z, lm.x, lm.y, model.getElevation(lm.x, lm.y) + 1.5)) {
        const weight = lm.kind === 'summit' ? Math.min(1.2, 0.4 + lm.prominence / 30)
          : lm.kind === 'knoll' ? 0.6 : lm.kind === 'saddle' ? 0.8 : 0.35;
        // Apparent size: how far the feature stands out, as an angle.
        const relief = lm.kind === 'summit' || lm.kind === 'knoll' ? lm.prominence : lm.kind === 'saddle' ? 12 : lm.depth;
        visible.push({ az: wrap360(Math.atan2(dx, dy) / DEG), d, weight, kind: lm.kind, angularSize: Math.atan(relief / d) / DEG });
      }
    }
    return { p, z, rays, visible };
  }

  lineOfSight(x0, y0, z0, x1, y1, z1) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(d / (this.model.cell * 1.2));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const h = this.model.getElevation(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      if (h > z0 + (z1 - z0) * t + 0.5) return false;
    }
    return true;
  }

  /** Quality of the view from a sweep at a given heading. */
  score(sw, heading) {
    const fov = this.fov;
    const count = sw.rays.length;
    const half = Math.floor(fov / 2 / RAY_STEP);
    const centre = Math.round(heading / RAY_STEP);
    const win = [];
    for (let c = -half; c <= half; c++) win.push(sw.rays[(centre + c + count) % count]);
    const horizon = win.map((r) => r.angle);

    // Skyline complexity: total variation, range and number of extrema.
    let tv = 0, extrema = 0;
    for (let c = 1; c < horizon.length; c++) tv += Math.abs(horizon[c] - horizon[c - 1]);
    for (let c = 1; c < horizon.length - 1; c++) {
      const a = horizon[c] - horizon[c - 1], b = horizon[c + 1] - horizon[c];
      if (a * b < 0 && (Math.abs(a) > 0.15 || Math.abs(b) > 0.15)) extrema++;
    }
    const maxAngle = Math.max(...horizon);
    const range = maxAngle - Math.min(...horizon);
    const skylineComplexity = 0.3 * soft(tv, 6) + 0.3 * soft(range, 5) + 0.15 * soft(extrema, 3) + 0.25 * soft(maxAngle, 6);

    // Landmarks within the field of view, counting angularly separated ones.
    const inView = sw.visible.filter((v) => angleDiff(v.az, heading) < fov / 2 - 1.5).sort((a, b) => a.az - b.az);
    let lmScore = 0, lastAz = -99;
    for (const v of inView) {
      const sep = angleDiff(v.az, lastAz) >= 6;
      lmScore += v.weight * (sep ? 1 : 0.35) * soft(v.angularSize, 1.2);
      if (sep) lastAz = v.az;
    }
    const landmarkVisibility = soft(lmScore * this.preset.quality.landmark, 1.4);

    // Terrain variation and ridge/valley content of visible ground.
    let n = 0, s = 0, s2 = 0, ridge = 0, valley = 0;
    for (const r of win) { n += r.st.n; s += r.st.s; s2 += r.st.s2; ridge += r.st.ridge; valley += r.st.valley; }
    const std = n > 1 ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
    const terrainVariation = soft(std, 16);
    const ridgeValleyInformation = 0.55 * soft(ridge / Math.max(1, n), 0.05) + 0.45 * soft(valley / Math.max(1, n), 0.04);

    // Foreground: variation of near-field terrain angles across the view.
    const nearStd = (p) => {
      const v = win.map((r) => r.probes[p]);
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    };
    const meanLayers = win.reduce((a, r) => a + r.layers, 0) / win.length;
    const foregroundInformation = 0.4 * soft(nearStd(1), 1.5) + 0.3 * soft(nearStd(2), 1.2) + 0.3 * soft(meanLayers, 1.5);

    // Orientation identifiability: this window vs windows 90/180/270 degrees away.
    let minOther = Infinity;
    for (const off of [60, 90, 135, 180, 225, 270, 300]) {
      const c2 = Math.round(wrap360(heading + off) / RAY_STEP);
      const other = [];
      for (let c = -half; c <= half; c++) other.push(sw.rays[(c2 + c + count) % count].angle);
      minOther = Math.min(minOther, horizonDistance(horizon, other));
    }
    const orientationIdentifiability = soft(minOther, 1.2);

    const blockedFrac = win.filter((r) => r.dist < 150).length / win.length;
    const edgeFrac = win.filter((r) => r.edge).length / win.length;
    const occlusionPenalty = this.preset.quality.occlusion * (1.3 * Math.max(0, blockedFrac - 0.12) + 0.8 * Math.max(0, edgeFrac - 0.25));

    // Bonus for a clearly visible dominant feature (big apparent height).
    const total =
      0.20 * skylineComplexity +
      0.10 * soft(maxAngle - 1, 5) +
      0.20 * landmarkVisibility +
      0.15 * terrainVariation +
      0.15 * ridgeValleyInformation +
      0.15 * foregroundInformation +
      0.15 * orientationIdentifiability -
      occlusionPenalty;

    return {
      total: saturate(total),
      maxAngle,
      components: { skylineComplexity, landmarkVisibility, terrainVariation, ridgeValleyInformation, foregroundInformation, orientationIdentifiability, occlusionPenalty },
      blockedFrac, edgeFrac, landmarksInView: inView.length,
    };
  }

  /**
   * Evaluate all positions x headings and return candidate viewpoints in the
   * order they should be tried: a weighted random draw (without replacement)
   * from the high-quality pool, so the best view is not always chosen.
   */
  generate() {
    const headings = candidateHeadings(this.preset.heading, this.rng.fork('headings'));
    const all = [];
    for (const p of this.candidatePositions()) {
      const sw = this.sweep(p);
      for (const h of headings) {
        const q = this.score(sw, h);
        if (q.edgeFrac > 0.45 || q.blockedFrac > 0.7) continue;
        all.push({ x: p.x, y: p.y, heading: h, quality: q });
      }
    }
    all.sort((a, b) => b.quality.total - a.quality.total);
    const poolSize = Math.max(24, this.maxPicks * 2, Math.round(all.length * 0.1));
    const pool = all.slice(0, poolSize);
    const picked = [];
    const rng = this.rng.fork('pick');
    while (pool.length && picked.length < this.maxPicks) {
      const c = rng.weighted(pool, (v) => v.quality.total ** 2);
      pool.splice(pool.indexOf(c), 1);
      // Diversity: skip views from (nearly) the same spot as an earlier pick.
      if (picked.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < 120)) continue;
      picked.push(c);
    }
    return { picked, evaluated: all.length, best: all[0] };
  }
}
