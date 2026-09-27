// TerrainModel: the single queryable elevation model. Both the WebGL scene
// and the contour map read from this object; nothing else holds terrain data.

import { sampleBilinear, smoothstep, lerp, percentile, DEG } from './grid.js';
import { GradientNoise } from './noise.js';
import { Random } from './rng.js';
import { DrainageSimulator } from './drainage.js';
import { ContourGenerator } from './contours.js';
import { SkylineAnalyzer } from './skyline.js';
import { TerrainAnalyzer } from './analyzer.js';

export class TerrainModel {
  /**
   * @param {{size:number,n:number,heights:Float32Array,meta?:object,seed?:string}} data
   * Coordinates: x east, y north, metres, origin at the south-west map corner.
   */
  constructor({ size, n, heights, meta = {}, seed = 'terrain' }) {
    this.size = size;
    this.n = n;
    this.cell = size / (n - 1);
    this.heights = heights;
    this.meta = meta;
    this.seed = seed;
    let min = Infinity, max = -Infinity;
    for (let k = 0; k < heights.length; k++) {
      if (heights[k] < min) min = heights[k];
      if (heights[k] > max) max = heights[k];
    }
    this.min = min; this.max = max;

    // Beyond the map edge the land relaxes to a gently undulating lowland so the
    // 3D horizon is not a cliff. This is part of the model (not a render trick)
    // so the skyline analysis sees exactly what the renderer draws.
    const border = [];
    for (let i = 0; i < n; i++) border.push(heights[i], heights[(n - 1) * n + i], heights[i * n], heights[i * n + n - 1]);
    this.outerLevel = percentile(Float32Array.from(border), 0.3);
    this.extNoise = new GradientNoise(new Random(`${seed}|outer`));
    this._contourCache = new Map();
  }

  inside(x, y, margin = 0) {
    return x >= margin && y >= margin && x <= this.size - margin && y <= this.size - margin;
  }

  getElevation(x, y) {
    const L = this.size;
    if (x >= 0 && y >= 0 && x <= L && y <= L) {
      // Inlined bilinear sample: this is the hottest function in the engine.
      const n = this.n, h = this.heights;
      const gx = x / this.cell, gy = y / this.cell;
      let i = gx | 0, j = gy | 0;
      if (i > n - 2) i = n - 2;
      if (j > n - 2) j = n - 2;
      const fx = gx - i, fy = gy - j;
      const k = j * n + i;
      const a = h[k], b = h[k + 1], c = h[k + n], d = h[k + n + 1];
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }
    const dx = x < 0 ? -x : x > L ? x - L : 0;
    const dy = y < 0 ? -y : y > L ? y - L : 0;
    const d = Math.hypot(dx, dy);
    const target = this.outerLevel + 14 * this.extNoise.noise(x / 900, y / 900) + 6 * this.extNoise.noise(x / 300 + 17, y / 300);
    if (d >= 900) return target;
    const hEdge = sampleBilinear(this.heights, this.n, x / this.cell, y / this.cell);
    return lerp(hEdge, target, smoothstep(0, 900, d));
  }

  /** Upper bound of getElevation anywhere (used for early ray termination). */
  get maxElevation() {
    return Math.max(this.max, this.outerLevel + 20.5);
  }

  /** dz/dx (east) and dz/dy (north), dimensionless. */
  getGradient(x, y, step = this.cell) {
    return {
      gx: (this.getElevation(x + step, y) - this.getElevation(x - step, y)) / (2 * step),
      gy: (this.getElevation(x, y + step) - this.getElevation(x, y - step)) / (2 * step),
    };
  }

  /** Slope in degrees. */
  getSlope(x, y) {
    const { gx, gy } = this.getGradient(x, y);
    return Math.atan(Math.hypot(gx, gy)) / DEG;
  }

  /** Aspect: bearing (deg clockwise from north) the slope faces, i.e. downhill direction. */
  getAspect(x, y) {
    const { gx, gy } = this.getGradient(x, y);
    if (Math.hypot(gx, gy) < 1e-4) return -1; // flat
    return ((Math.atan2(-gx, -gy) / DEG) + 360) % 360;
  }

  /** Laplacian curvature (1/m) over a ~2-cell stencil; positive = concave (hollow). */
  getCurvature(x, y, step = 2 * this.cell) {
    const c = this.getElevation(x, y);
    return (this.getElevation(x + step, y) + this.getElevation(x - step, y) + this.getElevation(x, y + step) + this.getElevation(x, y - step) - 4 * c) / (step * step);
  }

  get drainage() {
    if (!this._drainage) this._drainage = DrainageSimulator.run(this.heights, this.n, this.cell);
    return this._drainage;
  }

  /** Upstream contributing cells at the nearest grid node. */
  getFlowAccumulation(x, y) {
    const i = Math.max(0, Math.min(this.n - 1, Math.round(x / this.cell)));
    const j = Math.max(0, Math.min(this.n - 1, Math.round(y / this.cell)));
    return this.drainage.accumulation[j * this.n + i];
  }

  chooseContourInterval(mapPixels = 800) {
    return ContourGenerator.chooseInterval(this.heights, this.n, this.cell, mapPixels).interval;
  }

  getContours(interval = this.chooseContourInterval()) {
    if (!this._contourCache.has(interval)) {
      this._contourCache.set(interval, ContourGenerator.extract(this.heights, this.n, this.cell, interval));
    }
    return this._contourCache.get(interval);
  }

  get skyline() {
    if (!this._skyline) this._skyline = new SkylineAnalyzer(this);
    return this._skyline;
  }

  get analyzer() {
    if (!this._analyzer) this._analyzer = new TerrainAnalyzer(this);
    return this._analyzer;
  }

  getSkyline(x, y, heading = 0, opts) {
    return this.skyline.getSkyline(x, y, heading, opts);
  }

  getTerrainSignature(x, y, opts) {
    return this.analyzer.getTerrainSignature(x, y, opts);
  }
}
