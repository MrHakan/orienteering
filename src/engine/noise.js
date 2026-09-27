// Seeded 2D gradient noise, fractal sums and domain warping.

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export class GradientNoise {
  /** @param {import('./rng.js').Random} rng */
  constructor(rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    this.gx = new Float32Array(256);
    this.gy = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const a = rng.next() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
    this.ox = rng.range(0, 256);
    this.oy = rng.range(0, 256);
  }

  /** Perlin-style gradient noise, roughly in [-1, 1]. Unit lattice spacing. */
  noise(x, y) {
    x += this.ox; y += this.oy;
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const p = this.perm, gx = this.gx, gy = this.gy;
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
    const n00 = gx[aa] * xf + gy[aa] * yf;
    const n10 = gx[ba] * (xf - 1) + gy[ba] * yf;
    const n01 = gx[ab] * xf + gy[ab] * (yf - 1);
    const n11 = gx[bb] * (xf - 1) + gy[bb] * (yf - 1);
    const u = fade(xf), v = fade(yf);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.41421356;
  }
}

/**
 * Multi-octave noise with explicit physical octaves.
 * octaves: [{ wavelength: metres, amplitude: metres }]
 */
export class FractalNoise {
  constructor(rng, octaves) {
    this.octaves = octaves.map((o, i) => ({
      ...o,
      freq: 1 / o.wavelength,
      noise: new GradientNoise(rng.fork(`octave${i}`)),
    }));
  }

  sample(x, y) {
    let s = 0;
    for (const o of this.octaves) s += o.amplitude * o.noise.noise(x * o.freq, y * o.freq);
    return s;
  }
}

/** Two-level domain warp; returns warped coordinates. */
export class DomainWarp {
  constructor(rng, { wavelength = 700, amplitude = 90, fineWavelength = 180, fineAmplitude = 18 } = {}) {
    this.nx = new GradientNoise(rng.fork('wx'));
    this.ny = new GradientNoise(rng.fork('wy'));
    this.fx = new GradientNoise(rng.fork('fx'));
    this.fy = new GradientNoise(rng.fork('fy'));
    this.f = 1 / wavelength; this.a = amplitude;
    this.ff = 1 / fineWavelength; this.fa = fineAmplitude;
  }

  warp(x, y, out) {
    const wx = x + this.a * this.nx.noise(x * this.f, y * this.f);
    const wy = y + this.a * this.ny.noise(x * this.f, y * this.f);
    out.x = wx + this.fa * this.fx.noise(wx * this.ff, wy * this.ff);
    out.y = wy + this.fa * this.fy.noise(wx * this.ff, wy * this.ff);
    return out;
  }
}
