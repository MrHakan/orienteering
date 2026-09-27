// DrainageSimulator: priority-flood depression routing, D8 flow directions
// and flow accumulation over a square heightmap.

import { MinHeap } from './grid.js';

const DI = [1, 1, 0, -1, -1, -1, 0, 1];
const DJ = [0, 1, 1, 1, 0, -1, -1, -1];

export class DrainageSimulator {
  /**
   * @param {Float32Array} h heights
   * @param {number} n grid size
   * @param {number} cell cell size in metres
   * @param {number} eps minimum drop per cell imposed across filled depressions
   */
  static run(h, n, cell, eps = 1e-3) {
    const N = n * n;
    // Priority-flood (Barnes et al.) with epsilon so every cell drains.
    const filled = new Float32Array(N);
    const done = new Uint8Array(N);
    const heap = new MinHeap(4 * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (i === 0 || j === 0 || i === n - 1 || j === n - 1) {
          const k = j * n + i;
          filled[k] = h[k]; done[k] = 1; heap.push(h[k], k);
        }
      }
    }
    while (heap.size) {
      const k = heap.pop();
      const i = k % n, j = (k / n) | 0;
      for (let d = 0; d < 8; d++) {
        const ii = i + DI[d], jj = j + DJ[d];
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const kk = jj * n + ii;
        if (done[kk]) continue;
        done[kk] = 1;
        filled[kk] = Math.max(h[kk], filled[k] + eps);
        heap.push(filled[kk], kk);
      }
    }

    // D8 steepest descent on the filled surface; border cells drain off-map (-1).
    const receiver = new Int32Array(N).fill(-1);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        let best = 0, bk = -1;
        for (let d = 0; d < 8; d++) {
          const kk = (j + DJ[d]) * n + (i + DI[d]);
          const drop = (filled[k] - filled[kk]) / (d & 1 ? Math.SQRT2 : 1);
          if (drop > best) { best = drop; bk = kk; }
        }
        receiver[k] = bk;
      }
    }

    // Accumulate from high to low.
    const order = new Uint32Array(N);
    for (let k = 0; k < N; k++) order[k] = k;
    order.sort((a, b) => filled[b] - filled[a]);
    const acc = new Float32Array(N).fill(1);
    for (let q = 0; q < N; q++) {
      const k = order[q];
      const r = receiver[k];
      if (r >= 0) acc[r] += acc[k];
    }
    return { filled, receiver, accumulation: acc, cellArea: cell * cell };
  }
}
