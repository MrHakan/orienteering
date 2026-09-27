// Spline construction and fast distance-to-polyline queries used by the
// ridge / valley / spur / re-entrant landform primitives.

/** Centripetal-ish uniform Catmull-Rom through control points -> dense polyline. */
export function catmullRom(ctrl, samplesPerSegment = 12) {
  if (ctrl.length < 2) return ctrl.slice();
  const pts = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
  const out = [];
  for (let s = 1; s < pts.length - 2; s++) {
    const p0 = pts[s - 1], p1 = pts[s], p2 = pts[s + 1], p3 = pts[s + 2];
    for (let k = 0; k < samplesPerSegment; k++) {
      const t = k / samplesPerSegment, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(ctrl[ctrl.length - 1]);
  return out;
}

/** Polyline with arc-length parameterisation and bounding-box culling. */
export class PolylineField {
  constructor(points) {
    this.points = points;
    const m = points.length - 1;
    this.ax = new Float64Array(m); this.ay = new Float64Array(m);
    this.dx = new Float64Array(m); this.dy = new Float64Array(m);
    this.len2 = new Float64Array(m); this.s0 = new Float64Array(m);
    let s = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < m; k++) {
      const a = points[k], b = points[k + 1];
      this.ax[k] = a.x; this.ay[k] = a.y;
      this.dx[k] = b.x - a.x; this.dy[k] = b.y - a.y;
      this.len2[k] = this.dx[k] ** 2 + this.dy[k] ** 2 || 1e-9;
      this.s0[k] = s;
      s += Math.sqrt(this.len2[k]);
      minX = Math.min(minX, a.x, b.x); maxX = Math.max(maxX, a.x, b.x);
      minY = Math.min(minY, a.y, b.y); maxY = Math.max(maxY, a.y, b.y);
    }
    this.length = s;
    this.bbox = { minX, minY, maxX, maxY };
    this.segCount = m;
  }

  /**
   * Closest point on the polyline. Returns false (and leaves `out` untouched)
   * if the point is farther than `maxDist` from the bounding box.
   * out.d = distance, out.t = normalised arc position [0,1], out.side = sign of cross product.
   */
  closest(x, y, maxDist, out) {
    const b = this.bbox;
    if (x < b.minX - maxDist || x > b.maxX + maxDist || y < b.minY - maxDist || y > b.maxY + maxDist) return false;
    let best = Infinity, bestK = 0, bestU = 0;
    const { ax, ay, dx, dy, len2 } = this;
    for (let k = 0; k < this.segCount; k++) {
      const px = x - ax[k], py = y - ay[k];
      let u = (px * dx[k] + py * dy[k]) / len2[k];
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = px - u * dx[k], ey = py - u * dy[k];
      const d2 = ex * ex + ey * ey;
      if (d2 < best) { best = d2; bestK = k; bestU = u; }
    }
    out.d = Math.sqrt(best);
    out.t = (this.s0[bestK] + bestU * Math.sqrt(len2[bestK])) / this.length;
    out.side = Math.sign(dx[bestK] * (y - ay[bestK]) - dy[bestK] * (x - ax[bestK]));
    return true;
  }

  /** Point and unit tangent at normalised arc position t. */
  at(t) {
    const s = Math.min(Math.max(t, 0), 1) * this.length;
    let k = 0;
    while (k < this.segCount - 1 && this.s0[k + 1] <= s) k++;
    const L = Math.sqrt(this.len2[k]);
    const u = (s - this.s0[k]) / L;
    return {
      x: this.ax[k] + u * this.dx[k],
      y: this.ay[k] + u * this.dy[k],
      tx: this.dx[k] / L,
      ty: this.dy[k] / L,
    };
  }
}

/**
 * Smooth random 1-D profile on [0,1]: cosine interpolation between random
 * control values. Used for amplitude/width variation along a spline.
 */
export function randomProfile(rng, knots, lo, hi) {
  const v = [];
  for (let i = 0; i < knots; i++) v.push(rng.range(lo, hi));
  return (t) => {
    const x = Math.min(Math.max(t, 0), 1) * (knots - 1);
    const i = Math.min(Math.floor(x), knots - 2);
    const f = x - i;
    const w = (1 - Math.cos(f * Math.PI)) / 2;
    return v[i] * (1 - w) + v[i + 1] * w;
  };
}
