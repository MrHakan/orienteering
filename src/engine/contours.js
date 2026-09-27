// ContourGenerator: oriented Marching Squares over the final heightmap.
//
// Segments are oriented so that higher ground is always on the LEFT of the
// direction of travel. Consequences used by the map renderer:
//   - closed contour running counter-clockwise encloses a hill,
//     clockwise encloses a depression (gets downhill tick marks)
//   - label "up" direction (towards higher ground) is known everywhere

import { percentile } from './grid.js';

export const CONTOUR_INTERVALS = [2, 5, 10, 20];

// Corner offsets (bottom-left, bottom-right, top-right, top-left) and the edges
// adjacent to each corner. Edges: 0 bottom, 1 right, 2 top, 3 left.
const CORNER_EDGES = [[0, 3], [0, 1], [1, 2], [2, 3]];

export class ContourGenerator {
  /**
   * Pick the smallest interval that keeps contours legible at the given map
   * pixel size and gives at most ~26 levels over the relief (2 m only for
   * genuinely flat terrain, where it avoids an almost empty map).
   */
  static chooseInterval(heights, n, cell, mapPixels = 800) {
    const lo = percentile(heights, 0.005), hi = percentile(heights, 0.995);
    const relief = hi - lo;
    // 98th percentile slope (rise over run).
    const slopes = [];
    for (let j = 1; j < n - 1; j += 2) {
      for (let i = 1; i < n - 1; i += 2) {
        const k = j * n + i;
        const gx = (heights[k + 1] - heights[k - 1]) / (2 * cell);
        const gy = (heights[k + n] - heights[k - n]) / (2 * cell);
        slopes.push(Math.hypot(gx, gy));
      }
    }
    slopes.sort((a, b) => a - b);
    const steep = slopes[Math.floor(slopes.length * 0.98)] || 0.1;
    const pxPerM = mapPixels / (cell * (n - 1));
    for (const interval of CONTOUR_INTERVALS) {
      const spacingPx = (interval / steep) * pxPerM;
      const levels = relief / interval;
      if (spacingPx >= 2.4 && levels <= 26 && (interval > 2 || relief < 45)) return { interval, relief, steepSlope: steep };
    }
    return { interval: 20, relief, steepSlope: steep };
  }

  static levels(min, max, interval) {
    const out = [];
    for (let v = Math.ceil(min / interval) * interval; v <= max; v += interval) out.push(v);
    return out;
  }

  /**
   * @returns {Array<{level:number,index:boolean,lines:Array<{points:number[],closed:boolean,onBoundary:boolean}>}>}
   * points are flat [x0,y0,x1,y1,...] in world metres.
   */
  static extract(heights, n, cell, interval, { indexEvery = 5 } = {}) {
    let min = Infinity, max = -Infinity;
    for (let k = 0; k < heights.length; k++) {
      if (heights[k] < min) min = heights[k];
      if (heights[k] > max) max = heights[k];
    }
    const result = [];
    for (const level of ContourGenerator.levels(min, max, interval)) {
      result.push({
        level,
        index: Math.round(level / interval) % indexEvery === 0,
        lines: ContourGenerator.traceLevel(heights, n, cell, level + 1e-4),
      });
    }
    return result;
  }

  static traceLevel(h, n, cell, level) {
    const segA = [], segB = [], segP = [];
    const edgeKey = (i, j, e) => {
      switch (e) {
        case 0: return j * n + i;
        case 2: return (j + 1) * n + i;
        case 3: return n * n + j * n + i;
        default: return n * n + j * n + i + 1;
      }
    };
    const cx = new Float64Array(4), cy = new Float64Array(4);
    const v = new Float64Array(4);
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const k = j * n + i;
        v[0] = h[k]; v[1] = h[k + 1]; v[2] = h[k + n + 1]; v[3] = h[k + n];
        const b0 = v[0] > level, b1 = v[1] > level, b2 = v[2] > level, b3 = v[3] > level;
        const code = (b0 ? 1 : 0) | (b1 ? 2 : 0) | (b2 ? 4 : 0) | (b3 ? 8 : 0);
        if (code === 0 || code === 15) continue;
        const above = [b0, b1, b2, b3];
        // Edge crossings.
        const has = [b0 !== b1, b1 !== b2, b3 !== b2, b0 !== b3];
        if (has[0]) { const t = (level - v[0]) / (v[1] - v[0]); cx[0] = (i + t) * cell; cy[0] = j * cell; }
        if (has[1]) { const t = (level - v[1]) / (v[2] - v[1]); cx[1] = (i + 1) * cell; cy[1] = (j + t) * cell; }
        if (has[2]) { const t = (level - v[3]) / (v[2] - v[3]); cx[2] = (i + t) * cell; cy[2] = (j + 1) * cell; }
        if (has[3]) { const t = (level - v[0]) / (v[3] - v[0]); cx[3] = i * cell; cy[3] = (j + t) * cell; }
        const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];

        const emit = (ea, eb, refCorner, refAbove) => {
          // Orient so that the reference corner is on the left iff it is above.
          const [ci, cj] = corners[refCorner];
          const px = cx[ea], py = cy[ea], qx = cx[eb], qy = cy[eb];
          const cross = (qx - px) * (cj * cell - py) - (qy - py) * (ci * cell - px);
          const left = cross > 0;
          if (left === refAbove) {
            segA.push(edgeKey(i, j, ea)); segB.push(edgeKey(i, j, eb)); segP.push(px, py, qx, qy);
          } else {
            segA.push(edgeKey(i, j, eb)); segB.push(edgeKey(i, j, ea)); segP.push(qx, qy, px, py);
          }
        };

        if (code === 5 || code === 10) {
          // Saddle: resolve with the cell-centre value.
          const centreAbove = (v[0] + v[1] + v[2] + v[3]) / 4 > level;
          for (let c = 0; c < 4; c++) {
            if (above[c] !== centreAbove) {
              const [ea, eb] = CORNER_EDGES[c];
              emit(ea, eb, c, above[c]);
            }
          }
        } else {
          const edges = [];
          for (let e = 0; e < 4; e++) if (has[e]) edges.push(e);
          const ref = above.indexOf(true);
          emit(edges[0], edges[1], ref, true);
        }
      }
    }

    // Link oriented segments into polylines.
    const m = segA.length;
    const byStart = new Map();
    for (let s = 0; s < m; s++) byStart.set(segA[s], s);
    const hasPrev = new Uint8Array(m);
    const next = new Int32Array(m).fill(-1);
    for (let s = 0; s < m; s++) {
      const t = byStart.get(segB[s]);
      if (t !== undefined) { next[s] = t; hasPrev[t] = 1; }
    }
    const used = new Uint8Array(m);
    const lines = [];
    const isBoundaryKey = (key) => {
      if (key < n * n) { const j = Math.floor(key / n); return j === 0 || j === n - 1; }
      const i = (key - n * n) % n;
      return i === 0 || i === n - 1;
    };
    const walk = (s0) => {
      const pts = [segP[4 * s0], segP[4 * s0 + 1]];
      let s = s0, closed = false;
      while (s >= 0 && !used[s]) {
        used[s] = 1;
        pts.push(segP[4 * s + 2], segP[4 * s + 3]);
        s = next[s];
        if (s === s0) { closed = true; break; }
      }
      return { points: pts, closed };
    };
    // Open chains first (start where nothing precedes), then loops.
    for (let s = 0; s < m; s++) {
      if (used[s] || hasPrev[s]) continue;
      const line = walk(s);
      let e = s;
      while (next[e] >= 0 && next[e] !== s) e = next[e];
      line.onBoundary = isBoundaryKey(segA[s]) && isBoundaryKey(segB[e]);
      lines.push(line);
    }
    for (let s = 0; s < m; s++) {
      if (used[s]) continue;
      const line = walk(s);
      line.onBoundary = false;
      lines.push(line);
    }
    return lines;
  }

  /** Geometry check: every line is either closed or runs boundary-to-boundary. */
  static validate(contours) {
    let total = 0, broken = 0;
    for (const c of contours) {
      for (const l of c.lines) {
        total++;
        if (!l.closed && !l.onBoundary) broken++;
      }
    }
    return { total, broken, ok: broken === 0 };
  }

  /** Signed area of a closed polyline (positive = counter-clockwise = hill). */
  static signedArea(points) {
    let a = 0;
    for (let k = 0; k < points.length - 2; k += 2) a += points[k] * points[k + 3] - points[k + 2] * points[k + 1];
    return a / 2;
  }
}
