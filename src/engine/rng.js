// SeedManager + deterministic PRNG.
//
// Every random decision in the engine is drawn from a named stream derived
// from the quiz seed, so a quiz is fully reproducible from (seed, difficulty).
// Streams are derived from the seed *string*, never from another stream's
// state, which keeps unrelated subsystems from shifting each other's output.

/** cyrb128 string hash -> four 32-bit words. */
export function hashString(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export class Random {
  constructor(seed) {
    this.seed = String(seed);
    let [a, b, c, d] = hashString(this.seed);
    this._a = a; this._b = b; this._c = c; this._d = d;
    for (let i = 0; i < 12; i++) this.next(); // warm up sfc32
  }

  /** sfc32: uniform float in [0, 1). */
  next() {
    let a = this._a, b = this._b, c = this._c, d = this._d;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this._a = a; this._b = b; this._c = c; this._d = d;
    return (t >>> 0) / 4294967296;
  }

  range(min, max) { return min + (max - min) * this.next(); }
  /** Integer in [min, max] inclusive. */
  int(min, max) { return min + Math.floor(this.next() * (max - min + 1)); }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }

  normal(mean = 0, sd = 1) {
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Pick from items using weightFn(item) >= 0. Returns undefined if all weights are 0. */
  weighted(items, weightFn) {
    let total = 0;
    const w = items.map((it) => { const x = Math.max(0, weightFn(it)); total += x; return x; });
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= w[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Independent child stream, derived from this stream's seed (not its state). */
  fork(label) { return new Random(`${this.seed}/${label}`); }
}

export class SeedManager {
  constructor(seed) {
    this.seed = String(seed ?? SeedManager.randomSeed());
  }

  /** Named, independent random stream: stream('terrain', 2) etc. */
  stream(...labels) {
    return new Random(`${this.seed}|${labels.join('|')}`);
  }

  /** Human-friendly fresh seed. The only non-deterministic function in the engine. */
  static randomSeed() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    const bytes = new Uint32Array(8);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 2 ** 32);
    for (let i = 0; i < 8; i++) {
      if (i === 4) s += '-';
      s += alphabet[bytes[i] % alphabet.length];
    }
    return s;
  }
}
