// SkylineAnalyzer: first-person line-of-sight ray marching over the
// elevation model. The same getElevation() used by the 3D renderer is used
// here, so what the analysis "sees" is what the player sees.

import { DEG, wrap360 } from './grid.js';

/** Distances (m) at which foreground terrain angles are probed. */
export const PROBES = [40, 120, 350];

export class SkylineAnalyzer {
  /** @param {import('./terrainModel.js').TerrainModel} model */
  constructor(model, { maxDist = 4200 } = {}) {
    this.model = model;
    this.maxDist = maxDist;
    const steps = [];
    let r = 3;
    const minStep = model.cell * 0.75;
    while (r < maxDist) { steps.push(r); r += Math.max(minStep, r * 0.024); }
    this.steps = Float32Array.from(steps);
    this.probeIdx = PROBES.map((p) => {
      let k = 0;
      while (k < steps.length - 1 && steps[k] < p) k++;
      return k;
    });
  }

  /**
   * Cast one ray. `detail` collects the visible samples for scene analysis.
   * Angles in degrees above horizontal; azimuth in degrees clockwise from north.
   */
  castRay(x, y, eyeZ, azimuth, detail = null) {
    const m = this.model;
    const a = azimuth * DEG;
    const sx = Math.sin(a), sy = Math.cos(a);
    const steps = this.steps;
    const L = m.size;
    const hMax = m.maxElevation;
    let maxTan = -Infinity, maxR = 0;
    let exitR = Infinity;
    let visible = true, layers = 0, hiddenStart = 0;
    const probes = [0, 0, 0];
    let pi = 0;
    for (let k = 0; k < steps.length; k++) {
      const r = steps[k];
      // Nothing farther along can rise above the current horizon.
      if (r > 400 && (hMax - eyeZ) / r < maxTan) break;
      const px = x + sx * r, py = y + sy * r;
      if (exitR === Infinity && (px < 0 || py < 0 || px > L || py > L)) exitR = r;
      const h = m.getElevation(px, py);
      const tan = (h - eyeZ) / r;
      if (pi < 3 && k === this.probeIdx[pi]) { probes[pi] = Math.atan(tan) / DEG; pi++; }
      if (tan >= maxTan) {
        if (!visible && r - hiddenStart > 25 && hiddenStart > 20) layers++;
        visible = true;
        maxTan = tan; maxR = r;
        if (detail && exitR === Infinity) detail(px, py, h, r);
      } else if (visible) {
        visible = false;
        hiddenStart = r;
      }
    }
    return {
      angle: Math.atan(maxTan) / DEG,
      dist: maxR,
      exitDist: exitR,
      edge: maxR > exitR,
      layers,
      probes,
    };
  }

  eyeZ(x, y, eyeHeight) {
    return this.model.getElevation(x, y) + eyeHeight;
  }

  /** Horizon elevation angles, `step` degrees apart, across `fov` centred on heading. */
  getSkyline(x, y, heading = 0, { fov = 360, step = 5, eyeHeight = 1.7 } = {}) {
    const z = this.eyeZ(x, y, eyeHeight);
    const out = [];
    const count = fov >= 360 ? Math.round(360 / step) : Math.floor(fov / step) + 1;
    const start = fov >= 360 ? heading : heading - fov / 2;
    for (let i = 0; i < count; i++) out.push(this.castRay(x, y, z, wrap360(start + i * step)).angle);
    return out;
  }

  /**
   * Compact description of what an observer sees across the field of view:
   * horizon angle plus foreground terrain angles at 40/120/350 m per column.
   * This is what is compared between the true location and distractors.
   */
  viewDescriptor(x, y, heading, fov, { eyeHeight = 1.7, columns = 33, detail = null } = {}) {
    const z = this.eyeZ(x, y, eyeHeight);
    const horizon = new Float32Array(columns);
    const dist = new Float32Array(columns);
    const near = [new Float32Array(columns), new Float32Array(columns), new Float32Array(columns)];
    let edge = 0, blocked = 0, layers = 0;
    for (let c = 0; c < columns; c++) {
      const az = wrap360(heading - fov / 2 + (fov * c) / (columns - 1));
      const r = this.castRay(x, y, z, az, detail ? (px, py, h, rr) => detail(px, py, h, rr, c) : null);
      horizon[c] = r.angle; dist[c] = r.dist;
      near[0][c] = r.probes[0]; near[1][c] = r.probes[1]; near[2][c] = r.probes[2];
      if (r.edge) edge++;
      if (r.dist < 150) blocked++;
      layers += r.layers;
    }
    return {
      x, y, heading, fov, eyeHeight,
      horizon, dist, near,
      edgeFrac: edge / columns,
      blockedFrac: blocked / columns,
      meanLayers: layers / columns,
    };
  }
}

/**
 * RMS difference (degrees) between two view descriptors taken with the same
 * heading and FOV. The horizon dominates; foreground probes are damped
 * because steep near-field angles are large but visually less decisive.
 */
export function descriptorDistance(a, b) {
  const n = a.horizon.length;
  let s = 0;
  const w = [0.45, 0.4, 0.35];
  for (let c = 0; c < n; c++) {
    s += (a.horizon[c] - b.horizon[c]) ** 2;
    for (let p = 0; p < 3; p++) {
      const d = Math.atan((a.near[p][c] - b.near[p][c]) / 6) * 6; // compress huge near-field gaps
      s += w[p] * d * d;
    }
  }
  return Math.sqrt(s / (n * (1 + w[0] + w[1] + w[2])));
}

/** RMS horizon-only difference; used for orientation identifiability. */
export function horizonDistance(h1, h2) {
  let s = 0;
  for (let c = 0; c < h1.length; c++) s += (h1[c] - h2[c]) ** 2;
  return Math.sqrt(s / h1.length);
}
