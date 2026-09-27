// Small numeric helpers for square heightmap grids (row-major, index = j * n + i,
// i grows east, j grows north).

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const saturate = (x) => clamp(x, 0, 1);
/** 1 - exp(-x/k): soft saturation to [0,1). */
export const soft = (x, k) => 1 - Math.exp(-Math.max(0, x) / k);

export const DEG = Math.PI / 180;

/** Normalise an angle in degrees to [0, 360). */
export const wrap360 = (a) => ((a % 360) + 360) % 360;
/** Smallest absolute difference between two bearings in degrees. */
export const angleDiff = (a, b) => {
  const d = Math.abs(wrap360(a) - wrap360(b));
  return d > 180 ? 360 - d : d;
};

/** Bilinear sample at fractional grid coordinates (clamped). */
export function sampleBilinear(h, n, gx, gy) {
  if (gx < 0) gx = 0; else if (gx > n - 1) gx = n - 1;
  if (gy < 0) gy = 0; else if (gy > n - 1) gy = n - 1;
  let i = Math.floor(gx), j = Math.floor(gy);
  if (i >= n - 1) i = n - 2;
  if (j >= n - 1) j = n - 2;
  const fx = gx - i, fy = gy - j;
  const k = j * n + i;
  const a = h[k], b = h[k + 1], c = h[k + n], d = h[k + n + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Separable box blur, repeated `passes` times (approximates a Gaussian). */
export function boxBlur(src, n, radius, passes = 1) {
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let k = -radius; k <= radius; k++) {
          const ii = i + k;
          if (ii < 0 || ii >= n) continue;
          s += a[j * n + ii]; c++;
        }
        b[j * n + i] = s / c;
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let k = -radius; k <= radius; k++) {
          const jj = j + k;
          if (jj < 0 || jj >= n) continue;
          s += b[jj * n + i]; c++;
        }
        a[j * n + i] = s / c;
      }
    }
  }
  return a;
}

/**
 * Two-pass chamfer distance transform (metres) to the nearest cell where
 * mask[k] is truthy. Cells with no feature anywhere get a large value.
 */
export function distanceField(mask, n, cellSize) {
  const INF = 1e9;
  const d = new Float32Array(n * n);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? 0 : INF;
  const a = cellSize, b = cellSize * Math.SQRT2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + a);
      if (j > 0) {
        v = Math.min(v, d[k - n] + a);
        if (i > 0) v = Math.min(v, d[k - n - 1] + b);
        if (i < n - 1) v = Math.min(v, d[k - n + 1] + b);
      }
      d[k] = v;
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      let v = d[k];
      if (i < n - 1) v = Math.min(v, d[k + 1] + a);
      if (j < n - 1) {
        v = Math.min(v, d[k + n] + a);
        if (i < n - 1) v = Math.min(v, d[k + n + 1] + b);
        if (i > 0) v = Math.min(v, d[k + n - 1] + b);
      }
      d[k] = v;
    }
  }
  return d;
}

/** p in [0,1]; uses a strided subsample for large arrays. */
export function percentile(arr, p, maxSamples = 20000) {
  const stride = Math.max(1, Math.floor(arr.length / maxSamples));
  const s = [];
  for (let k = 0; k < arr.length; k += stride) s.push(arr[k]);
  s.sort((x, y) => x - y);
  return s[clamp(Math.round(p * (s.length - 1)), 0, s.length - 1)];
}

export function meanStd(arr) {
  let m = 0;
  for (let k = 0; k < arr.length; k++) m += arr[k];
  m /= arr.length;
  let v = 0;
  for (let k = 0; k < arr.length; k++) v += (arr[k] - m) ** 2;
  return { mean: m, std: Math.sqrt(v / arr.length) };
}

/** Minimal binary min-heap over (priority, value) pairs. */
export class MinHeap {
  constructor(capacity = 1024) {
    this.pri = new Float64Array(capacity);
    this.val = new Int32Array(capacity);
    this.size = 0;
  }
  push(p, v) {
    if (this.size === this.pri.length) {
      const np = new Float64Array(this.size * 2); np.set(this.pri); this.pri = np;
      const nv = new Int32Array(this.size * 2); nv.set(this.val); this.val = nv;
    }
    let i = this.size++;
    const pri = this.pri, val = this.val;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent] <= p) break;
      pri[i] = pri[parent]; val[i] = val[parent]; i = parent;
    }
    pri[i] = p; val[i] = v;
  }
  /** Pops and returns the value; priority available via lastPriority. */
  pop() {
    const pri = this.pri, val = this.val;
    const top = val[0];
    this.lastPriority = pri[0];
    const p = pri[--this.size], v = val[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && pri[c + 1] < pri[c]) c++;
      if (pri[c] >= p) break;
      pri[i] = pri[c]; val[i] = val[c]; i = c;
    }
    pri[i] = p; val[i] = v;
    return top;
  }
}
