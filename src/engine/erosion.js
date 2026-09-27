// ErosionProcessor: fluvial channel carving driven by flow accumulation,
// a light thermal (talus) pass, spike removal and shallow-pit filling.

import { DrainageSimulator } from './drainage.js';
import { boxBlur } from './grid.js';

export class ErosionProcessor {
  constructor({ n, cell }) {
    this.n = n;
    this.cell = cell;
  }

  /**
   * H_new = H_old - k * max(0, ln(1 + A) - ln(1 + A0)), blurred into a valley
   * cross-section. Repeated a few times with decreasing strength.
   */
  fluvial(h, { strength = 1.1, threshold = 25, iterations = 2 } = {}) {
    const n = this.n;
    let drainage;
    for (let it = 0; it < iterations; it++) {
      drainage = DrainageSimulator.run(h, n, this.cell);
      const acc = drainage.accumulation;
      const k = strength / (it + 1);
      const base = Math.log(1 + threshold);
      const { filled } = drainage;
      const n1 = n - 1;
      let carve = new Float32Array(h.length);
      for (let q = 0; q < h.length; q++) {
        // No channels across filled depressions (they would be straight D8
        // artefacts across a lake floor), and shallower channels on flats.
        if (filled[q] - h[q] > 0.05) continue;
        const i = q % n, j = (q / n) | 0;
        const gx = (filled[j * n + Math.min(i + 1, n1)] - filled[j * n + Math.max(i - 1, 0)]) / (2 * this.cell);
        const gy = (filled[Math.min(j + 1, n1) * n + i] - filled[Math.max(j - 1, 0) * n + i]) / (2 * this.cell);
        const flatness = 0.25 + 0.75 * Math.min(1, Math.hypot(gx, gy) / 0.03);
        carve[q] = flatness * k * Math.max(0, Math.log(1 + acc[q]) - base);
      }
      // Sharp channel + wider valley component.
      const wide = boxBlur(carve, n, 2, 2);
      for (let q = 0; q < h.length; q++) h[q] -= 0.35 * carve[q] + 0.9 * wide[q];
    }
    return drainage;
  }

  /** Move material down slopes steeper than the talus angle. */
  thermal(h, { talusDeg = 34, rate = 0.35, iterations = 12 } = {}) {
    const n = this.n, cell = this.cell;
    const talus = Math.tan((talusDeg * Math.PI) / 180);
    const lim = [talus * cell, talus * cell * Math.SQRT2];
    const delta = new Float32Array(h.length);
    const offs = [1, -1, n, -n, n + 1, n - 1, -n + 1, -n - 1];
    const lims = [lim[0], lim[0], lim[0], lim[0], lim[1], lim[1], lim[1], lim[1]];
    for (let it = 0; it < iterations; it++) {
      delta.fill(0);
      let moved = 0;
      for (let j = 1; j < n - 1; j++) {
        for (let i = 1; i < n - 1; i++) {
          const k = j * n + i;
          const hk = h[k];
          for (let q = 0; q < 8; q++) {
            const kk = k + offs[q];
            const d = hk - h[kk] - lims[q];
            if (d > 0) {
              const m = rate * d * 0.125;
              delta[k] -= m; delta[kk] += m; moved += m;
            }
          }
        }
      }
      for (let k = 0; k < h.length; k++) h[k] += delta[k];
      if (moved < 1e-3) break;
    }
  }

  /** Replace isolated cells that deviate strongly from their neighbourhood. */
  despike(h, threshold = 2.5) {
    const n = this.n;
    let fixed = 0;
    const src = Float32Array.from(h);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        const m = (src[k - 1] + src[k + 1] + src[k - n] + src[k + n] + src[k - n - 1] + src[k - n + 1] + src[k + n - 1] + src[k + n + 1]) / 8;
        if (Math.abs(src[k] - m) > threshold) { h[k] = m; fixed++; }
      }
    }
    return fixed;
  }

  /**
   * Resolve closed depressions. Real fluvial landscapes rarely hold closed
   * hollows, so every depression is filled unless it belongs to an intended
   * depression / basin landform (`keep`: [{x, y, depth, radius}]), is at
   * least `keepDepth` deep and not much deeper than the landform intended.
   * Filled areas
   * get a gentle gradient towards their outlet and are softened at the rim,
   * which reads as a flat valley floor rather than a lake.
   */
  resolveDepressions(h, { keep = [], keepDepth = 2, fillSlope = 0.02 } = {}) {
    const n = this.n, cell = this.cell, N = h.length;
    const { filled } = DrainageSimulator.run(h, n, cell, fillSlope);
    const region = new Int32Array(N).fill(-1);
    const mask = new Uint8Array(N);
    const stack = [];
    let kept = 0, resolved = 0;
    for (let k = 0; k < N; k++) {
      if (region[k] >= 0 || filled[k] - h[k] < 0.01) continue;
      const cells = [];
      let maxD = 0, intended = null;
      stack.push(k); region[k] = k;
      while (stack.length) {
        const c = stack.pop();
        cells.push(c);
        maxD = Math.max(maxD, filled[c] - h[c]);
        const i = c % n, j = (c / n) | 0;
        if (!intended) for (const p of keep) if (Math.hypot(i * cell - p.x, j * cell - p.y) < p.radius) { intended = p; break; }
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          const cc = jj * n + ii;
          if (region[cc] < 0 && filled[cc] - h[cc] >= 0.01) { region[cc] = k; stack.push(cc); }
        }
      }
      if (intended && maxD >= keepDepth && maxD <= intended.depth * 1.5 + 3) { kept++; continue; }
      resolved++;
      for (const c of cells) { h[c] = filled[c]; mask[c] = 1; }
    }
    // Soften the fill rim: blur within the filled area plus a 2-cell band.
    if (resolved) {
      const band = new Uint8Array(mask);
      for (let r = 0; r < 2; r++) {
        const src = Uint8Array.from(band);
        for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
          const k = j * n + i;
          if (!src[k] && (src[k - 1] || src[k + 1] || src[k - n] || src[k + n])) band[k] = 1;
        }
      }
      for (let pass = 0; pass < 2; pass++) {
        const src = Float32Array.from(h);
        for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
          const k = j * n + i;
          if (!band[k]) continue;
          h[k] = (src[k] * 4 + src[k - 1] + src[k + 1] + src[k - n] + src[k + n]) / 8;
        }
      }
    }
    return { kept, resolved };
  }

}
