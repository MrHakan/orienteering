// LandformGenerator: structured, mathematically defined landform primitives
// and the macro-terrain archetypes that combine them.
//
// All primitives are evaluated in (domain-warped) world metres. They are
// composed in three channels:
//   add   - summed (hills, knolls, depressions, plateaus, basins)
//   union - smooth-max union (ridges and spurs) so branches merge into the
//           parent ridge without additive bumps at the junction
//   carve - summed negative relief (valleys, re-entrants)

import { PolylineField, catmullRom, randomProfile } from './splines.js';
import { smoothstep, clamp } from './grid.js';

const TAU = Math.PI * 2;
const scratch = { d: 0, t: 0, side: 0 };

// ---------------------------------------------------------------- primitives

/** Rotated, harmonically distorted elliptical Gaussian (hill / depression). */
export class EllipticalHill {
  constructor({ x, y, sx, sy, theta, amplitude, harmonics = [0, 0, 0, 0] }) {
    Object.assign(this, { x, y, sx, sy, theta, amplitude, harmonics });
    this.channel = 'add';
    this.c = Math.cos(theta); this.s = Math.sin(theta);
    this.reach = 4.2 * Math.max(sx, sy) * (1 + Math.abs(harmonics[0]) + Math.abs(harmonics[2]));
  }
  evaluate(px, py) {
    const dx = px - this.x, dy = py - this.y;
    if (Math.abs(dx) > this.reach || Math.abs(dy) > this.reach) return 0;
    const u = dx * this.c + dy * this.s;
    const v = -dx * this.s + dy * this.c;
    let q = (u * u) / (2 * this.sx * this.sx) + (v * v) / (2 * this.sy * this.sy);
    const [a2, p2, a3, p3] = this.harmonics;
    if (a2 || a3) {
      const phi = Math.atan2(v, u);
      const k = 1 + a2 * Math.cos(2 * phi + p2) + a3 * Math.cos(3 * phi + p3);
      q /= k * k;
    }
    return q > 14 ? 0 : this.amplitude * Math.exp(-q);
  }
}

/** Flat-topped super-ellipse: 1 / (1 + r^p). */
export class Plateau {
  constructor({ x, y, rx, ry, theta, amplitude, power }) {
    Object.assign(this, { x, y, rx, ry, theta, amplitude, power });
    this.channel = 'add';
    this.c = Math.cos(theta); this.s = Math.sin(theta);
  }
  evaluate(px, py) {
    const dx = px - this.x, dy = py - this.y;
    const u = (dx * this.c + dy * this.s) / this.rx;
    const v = (-dx * this.s + dy * this.c) / this.ry;
    const r = Math.sqrt(u * u + v * v);
    return this.amplitude / (1 + Math.pow(r, this.power));
  }
}

/**
 * Spline-distance landform: A(t) * exp(-d^2 / (2 w(t)^2)).
 * Ridges and spurs use the union channel; valleys and re-entrants carve.
 */
export class SplineLandform {
  constructor({ type, points, amplitude, width, maxWidth, channel }) {
    this.type = type;
    this.field = new PolylineField(points);
    this.amplitude = amplitude; // (t) => metres (positive)
    this.width = width;         // (t) => metres
    this.maxWidth = maxWidth;
    this.channel = channel;
    this.sign = channel === 'carve' ? -1 : 1;
  }
  evaluate(px, py) {
    if (!this.field.closest(px, py, 3.6 * this.maxWidth, scratch)) return 0;
    const w = this.width(scratch.t);
    const d = scratch.d;
    if (d > 3.6 * w) return 0;
    return this.sign * this.amplitude(scratch.t) * Math.exp(-(d * d) / (2 * w * w));
  }
}

/** Polynomial smooth maximum. */
function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

// ---------------------------------------------------------------- archetypes

export const ARCHETYPES = {
  rollingHills:  { weight: 1.0, major: true },
  mountainRidge: { weight: 1.3, major: true, excludes: ['ridgeNetwork', 'plateau'] },
  ridgeNetwork:  { weight: 0.9, major: true, excludes: ['mountainRidge', 'plateau'] },
  plateau:       { weight: 0.45, major: true, excludes: ['mountainRidge', 'ridgeNetwork', 'basin'] },
  broadValley:   { weight: 0.8, excludes: ['basin'] },
  narrowValley:  { weight: 0.9 },
  basin:         { weight: 0.35, excludes: ['broadValley', 'plateau'] },
  saddlePass:    { weight: 0.7 },
  knoll:         { weight: 0.9 },
  depression:    { weight: 0.45 },
};

/** Pick 2-5 compatible archetypes, always including at least one major system. */
export function chooseArchetypes(rng, count) {
  const chosen = [];
  const allowed = (name) =>
    !chosen.includes(name) &&
    !chosen.some((c) => (ARCHETYPES[c].excludes || []).includes(name) || (ARCHETYPES[name].excludes || []).includes(c));
  const majors = Object.keys(ARCHETYPES).filter((k) => ARCHETYPES[k].major);
  chosen.push(rng.weighted(majors, (k) => ARCHETYPES[k].weight));
  while (chosen.length < count) {
    const options = Object.keys(ARCHETYPES).filter(allowed);
    if (!options.length) break;
    chosen.push(rng.weighted(options, (k) => ARCHETYPES[k].weight));
  }
  return chosen;
}

export class LandformGenerator {
  /**
   * @param {import('./rng.js').Random} rng
   * @param {object} opts { size, relief, complexity, archetypeCount }
   */
  constructor(rng, opts) {
    this.rng = rng;
    this.L = opts.size;
    this.relief = opts.relief;        // amplitude multiplier
    this.complexity = opts.complexity; // 0..1: spurs, re-entrants, extra knolls
    this.archetypeCount = opts.archetypeCount;
    this.primitives = [];
    this.meta = { archetypes: [], ridges: [], valleys: [], spurs: [], reentrants: [], hills: [], plateaus: [], depressions: [], saddles: [] };
    this.unionK = 10;
  }

  build() {
    const rng = this.rng;
    const tiltDir = rng.range(0, TAU);
    const tiltMag = rng.range(10, 40) * this.relief;
    this.base = {
      elevation: rng.range(45, 110),
      tx: Math.cos(tiltDir) * tiltMag,
      ty: Math.sin(tiltDir) * tiltMag,
      downhill: tiltDir + Math.PI, // direction in which the base plane descends
    };

    const names = chooseArchetypes(rng.fork('archetypes'), this.archetypeCount);
    // Build large structures first so drainage-following valleys can use them.
    const order = ['basin', 'plateau', 'broadValley', 'mountainRidge', 'ridgeNetwork', 'rollingHills', 'saddlePass', 'narrowValley', 'knoll', 'depression'];
    names.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    for (const name of names) {
      this.meta.archetypes.push(name);
      this[name](rng.fork(name));
    }
    // Every landscape gets a little small-scale morphology.
    if (!names.includes('knoll') && rng.chance(0.4 + 0.4 * this.complexity)) this.knoll(rng.fork('extra-knoll'), 1, 2);
    this.primitivesByChannel = {
      add: this.primitives.filter((p) => p.channel === 'add'),
      union: this.primitives.filter((p) => p.channel === 'union'),
      carve: this.primitives.filter((p) => p.channel === 'carve'),
    };
    return this;
  }

  baseHeight(x, y) {
    const b = this.base;
    return b.elevation + b.tx * (x / this.L - 0.5) + b.ty * (y / this.L - 0.5);
  }

  /** Structured elevation (base + landforms) at world position. */
  evaluate(x, y) {
    const ch = this.primitivesByChannel || this._liveChannels();
    let h = this.baseHeight(x, y);
    for (const p of ch.add) h += p.evaluate(x, y);
    let u = 0;
    for (const p of ch.union) {
      const v = p.evaluate(x, y);
      if (v > 0.01) u = smax(u, v, this.unionK);
    }
    h += u;
    for (const p of ch.carve) h += p.evaluate(x, y);
    return h;
  }

  _liveChannels() {
    return {
      add: this.primitives.filter((p) => p.channel === 'add'),
      union: this.primitives.filter((p) => p.channel === 'union'),
      carve: this.primitives.filter((p) => p.channel === 'carve'),
    };
  }

  // ------------------------------------------------------------ helpers

  randomPoint(rng, margin = 0) {
    return { x: rng.range(margin, this.L - margin), y: rng.range(margin, this.L - margin) };
  }

  hill(rng, x, y, amplitude, sMin, sMax, maxAspect = 2.0, distortion = 0.18) {
    const s = rng.range(sMin, sMax);
    const aspect = rng.range(1, maxAspect);
    const h = new EllipticalHill({
      x, y, sx: s * Math.sqrt(aspect), sy: s / Math.sqrt(aspect),
      theta: rng.range(0, Math.PI), amplitude,
      harmonics: [rng.range(-distortion, distortion), rng.range(0, TAU), rng.range(-distortion * 0.6, distortion * 0.6), rng.range(0, TAU)],
    });
    this.primitives.push(h);
    return h;
  }

  /** Wiggly spline through a straight guide line. */
  guideSpline(rng, a, b, nCtrl, wiggle) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len;
    const ctrl = [];
    let off = 0;
    for (let i = 0; i < nCtrl; i++) {
      const t = i / (nCtrl - 1);
      off = 0.55 * off + rng.normal(0, wiggle);
      const o = i === 0 || i === nCtrl - 1 ? off * 0.5 : off;
      ctrl.push({ x: a.x + dx * t + nx * o, y: a.y + dy * t + ny * o });
    }
    return catmullRom(ctrl, Math.max(6, Math.ceil(len / nCtrl / 25)));
  }

  /** Main ridge spine plus peaks, spurs and re-entrants. Returns the ridge landform. */
  ridge(rng, a, b, amp0, width0, { spurs = 3, reentrants = 2, peaks = 2, taperStart = true, taperEnd = true, rootProfile = null } = {}) {
    const pts = this.guideSpline(rng, a, b, rng.int(4, 6), 0.07 * this.L);
    const ampShape = randomProfile(rng, rng.int(5, 8), 0.5, 1.0);
    const widthShape = randomProfile(rng, rng.int(4, 6), 0.7, 1.3);
    const amp = (t) => {
      let k = ampShape(t);
      if (taperStart) k *= 0.3 + 0.7 * smoothstep(0, 0.18, t);
      if (taperEnd) k *= 0.3 + 0.7 * smoothstep(0, 0.18, 1 - t);
      if (rootProfile) k *= rootProfile(t);
      return amp0 * k;
    };
    const width = (t) => width0 * widthShape(t);
    const ridge = new SplineLandform({ type: 'ridge', points: pts, amplitude: amp, width, maxWidth: width0 * 1.3, channel: 'union' });
    this.primitives.push(ridge);
    this.meta.ridges.push({ points: pts });

    // Distinct summits along the spine (elongated along the ridge).
    for (let i = 0; i < peaks; i++) {
      const t = rng.range(0.15, 0.85);
      const p = ridge.field.at(t);
      const along = rng.range(60, 150), across = width(t) * rng.range(0.35, 0.6);
      const theta = Math.atan2(p.ty, p.tx);
      this.primitives.push(new EllipticalHill({
        x: p.x, y: p.y, sx: along, sy: across, theta,
        amplitude: amp(t) * rng.range(0.12, 0.3),
        harmonics: [rng.range(-0.15, 0.15), rng.range(0, TAU), rng.range(-0.1, 0.1), rng.range(0, TAU)],
      }));
      this.meta.hills.push({ x: p.x, y: p.y, kind: 'ridge-summit' });
    }

    // Spurs: secondary ridges extending downhill from the spine.
    for (let i = 0; i < spurs; i++) {
      const t = rng.range(0.12, 0.88);
      const p = ridge.field.at(t);
      const side = rng.sign();
      const ang = Math.atan2(p.tx * side, -p.ty * side) + rng.range(-0.6, 0.6);
      const dir = { x: Math.cos(ang), y: Math.sin(ang) };
      const w = width(t);
      const len = w * rng.range(1.6, 3.0);
      const bend = rng.normal(0, len * 0.18);
      const ctrl = [
        { x: p.x, y: p.y },
        { x: p.x + dir.x * len * 0.5 - dir.y * bend, y: p.y + dir.y * len * 0.5 + dir.x * bend },
        { x: p.x + dir.x * len, y: p.y + dir.y * len },
      ];
      const root = amp(t) * rng.range(0.55, 0.82);
      const decay = rng.range(0.9, 1.5);
      const sw = w * rng.range(0.35, 0.55);
      const spur = new SplineLandform({
        type: 'spur', points: catmullRom(ctrl, 10), channel: 'union', maxWidth: sw,
        amplitude: (s) => root * Math.pow(1 - s, decay), width: (s) => sw * (1 - 0.35 * s),
      });
      this.primitives.push(spur);
      this.meta.spurs.push({ points: spur.field.points });
    }

    // Re-entrants: small valleys cutting uphill into the flanks.
    for (let i = 0; i < reentrants; i++) {
      const t = rng.range(0.12, 0.88);
      const p = ridge.field.at(t);
      const side = rng.sign();
      const nx = -p.ty * side, ny = p.tx * side;
      const w = width(t);
      const lo = w * rng.range(1.5, 2.4), hi = w * rng.range(0.35, 0.7);
      const skew = rng.range(-0.3, 0.3) * w;
      const pts2 = catmullRom([
        { x: p.x + nx * lo + p.tx * skew, y: p.y + ny * lo + p.ty * skew },
        { x: p.x + nx * (lo + hi) / 2 + p.tx * skew * 0.4, y: p.y + ny * (lo + hi) / 2 + p.ty * skew * 0.4 },
        { x: p.x + nx * hi, y: p.y + ny * hi },
      ], 10);
      const depth = rng.range(6, 16) * Math.min(1.4, amp(t) / 70);
      const rw = rng.range(24, 50);
      const re = new SplineLandform({
        type: 'reentrant', points: pts2, channel: 'carve', maxWidth: rw,
        amplitude: (s) => depth * Math.pow(1 - s, 0.7) * smoothstep(0, 0.2, s + 0.1), width: () => rw,
      });
      this.primitives.push(re);
      this.meta.reentrants.push({ points: pts2 });
    }
    return ridge;
  }

  lineAcross(rng, lengthFactorMin, lengthFactorMax, centreSpread = 0.22, angle = rng.range(0, Math.PI)) {
    const L = this.L;
    const c = { x: L * (0.5 + rng.range(-centreSpread, centreSpread)), y: L * (0.5 + rng.range(-centreSpread, centreSpread)) };
    const half = (L * rng.range(lengthFactorMin, lengthFactorMax)) / 2;
    return {
      a: { x: c.x - Math.cos(angle) * half, y: c.y - Math.sin(angle) * half },
      b: { x: c.x + Math.cos(angle) * half, y: c.y + Math.sin(angle) * half },
    };
  }

  // ------------------------------------------------------------ archetypes

  mountainRidge(rng) {
    const { a, b } = this.lineAcross(rng, 1.0, 1.7);
    const c = this.complexity;
    this.ridge(rng, a, b, rng.range(60, 115) * this.relief, rng.range(95, 170), {
      spurs: rng.int(2, 3 + Math.round(4 * c)),
      reentrants: rng.int(1, 2 + Math.round(4 * c)),
      peaks: rng.int(2, 4),
    });
  }

  ridgeNetwork(rng) {
    const { a, b } = this.lineAcross(rng, 1.0, 1.5);
    const c = this.complexity;
    const amp0 = rng.range(45, 90) * this.relief;
    const main = this.ridge(rng, a, b, amp0, rng.range(85, 150), {
      spurs: rng.int(1, 2 + Math.round(3 * c)), reentrants: rng.int(1, 2 + Math.round(3 * c)), peaks: rng.int(1, 3),
    });
    const branches = rng.int(1, 3);
    for (let i = 0; i < branches; i++) {
      const t = rng.range(0.2, 0.8);
      const p = main.field.at(t);
      const side = rng.sign();
      const ang = Math.atan2(p.tx * side, -p.ty * side) + rng.range(-0.7, 0.7);
      const len = this.L * rng.range(0.3, 0.6);
      const end = { x: p.x + Math.cos(ang) * len, y: p.y + Math.sin(ang) * len };
      const rootAmp = main.amplitude(t) * rng.range(0.7, 0.95);
      this.ridge(rng.fork(`branch${i}`), p, end, rootAmp, rng.range(70, 120), {
        spurs: rng.int(0, 1 + Math.round(2 * c)), reentrants: rng.int(0, 1 + Math.round(2 * c)), peaks: rng.int(0, 2),
        taperStart: false,
        rootProfile: (s) => 1 - 0.55 * s,
      });
    }
  }

  rollingHills(rng) {
    const n = rng.int(4, 7 + Math.round(3 * this.complexity));
    const placed = [];
    for (let tries = 0; placed.length < n && tries < 200; tries++) {
      const p = this.randomPoint(rng, -0.05 * this.L);
      if (placed.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < this.L * 0.16)) continue;
      placed.push(p);
      this.hill(rng, p.x, p.y, rng.range(14, 42) * this.relief, 110, 280, 2.3, 0.22);
      this.meta.hills.push({ ...p, kind: 'hill' });
    }
  }

  plateau(rng) {
    const p = { x: this.L * rng.range(0.3, 0.7), y: this.L * rng.range(0.3, 0.7) };
    const rx = this.L * rng.range(0.14, 0.24);
    const pl = new Plateau({ ...p, rx, ry: rx * rng.range(0.55, 0.95), theta: rng.range(0, Math.PI), amplitude: rng.range(35, 65) * this.relief, power: rng.range(4.5, 7.5) });
    this.primitives.push(pl);
    this.meta.plateaus.push(p);
    // Re-entrants cut into the plateau edge.
    const k = rng.int(2, 3 + Math.round(3 * this.complexity));
    for (let i = 0; i < k; i++) {
      const ang = rng.range(0, TAU);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const r = Math.hypot(pl.rx * Math.cos(ang - pl.theta), pl.ry * Math.sin(ang - pl.theta));
      const pts = catmullRom([
        { x: p.x + dx * r * 1.35, y: p.y + dy * r * 1.35 },
        { x: p.x + dx * r * 0.95 + rng.normal(0, 20), y: p.y + dy * r * 0.95 + rng.normal(0, 20) },
        { x: p.x + dx * r * 0.65, y: p.y + dy * r * 0.65 },
      ], 10);
      const depth = pl.amplitude * rng.range(0.3, 0.55), w = rng.range(30, 55);
      this.primitives.push(new SplineLandform({ type: 'reentrant', points: pts, channel: 'carve', maxWidth: w, amplitude: (s) => depth * (1 - s * s), width: () => w }));
      this.meta.reentrants.push({ points: pts });
    }
  }

  basin(rng) {
    const p = { x: this.L * rng.range(0.25, 0.75), y: this.L * rng.range(0.25, 0.75) };
    const depth = rng.range(12, 28) * this.relief;
    this.hill(rng, p.x, p.y, -depth, 260, 420, 1.8, 0.15);
    this.meta.depressions.push({ ...p, depth, radius: 420, kind: 'basin' });
  }

  broadValley(rng) {
    // Runs down the regional slope, entering and leaving the map.
    const L = this.L;
    const dir = this.base.downhill + rng.range(-0.5, 0.5);
    const off = rng.range(-0.25, 0.25) * L;
    const c = { x: L / 2 - Math.sin(dir) * off, y: L / 2 + Math.cos(dir) * off };
    const a = { x: c.x - Math.cos(dir) * L, y: c.y - Math.sin(dir) * L };
    const b = { x: c.x + Math.cos(dir) * L, y: c.y + Math.sin(dir) * L };
    const pts = this.guideSpline(rng, a, b, 6, 0.09 * L);
    const depth = rng.range(22, 50) * this.relief;
    const w0 = rng.range(200, 380);
    const wp = randomProfile(rng, 5, 0.75, 1.25);
    this.primitives.push(new SplineLandform({ type: 'valley', points: pts, channel: 'carve', maxWidth: w0 * 1.25, amplitude: (t) => depth * (0.75 + 0.25 * t), width: (t) => w0 * wp(t) }));
    this.meta.valleys.push({ points: pts, kind: 'broad' });
  }

  /** Valley that follows the steepest descent of the structure built so far. */
  narrowValley(rng) {
    const count = rng.int(1, 1 + Math.round(1.5 * this.complexity));
    for (let v = 0; v < count; v++) {
      const samples = [];
      for (let i = 0; i < 40; i++) {
        const p = this.randomPoint(rng, 0.1 * this.L);
        samples.push({ ...p, h: this.evaluate(p.x, p.y) });
      }
      samples.sort((a, b) => a.h - b.h);
      const start = samples[Math.floor(samples.length * rng.range(0.55, 0.85))];
      const path = this.traceDescent(rng, start);
      if (path.length < 6) continue;
      const ctrl = path.filter((_, i) => i % 3 === 0 || i === path.length - 1);
      const pts = catmullRom(ctrl, 6);
      const depth = rng.range(10, 26) * this.relief;
      const w = rng.range(45, 100);
      this.primitives.push(new SplineLandform({
        type: 'valley', points: pts, channel: 'carve', maxWidth: w * 1.3,
        amplitude: (t) => depth * (0.25 + 0.75 * smoothstep(0, 0.35, t)), width: (t) => w * (0.7 + 0.6 * t),
      }));
      this.meta.valleys.push({ points: pts, kind: 'narrow' });
    }
  }

  /**
   * Steepest-descent path with limited turning. The turn limit keeps the
   * path from oscillating inside a local pit (which would carve a deep closed
   * hole); instead it carries on and breaches the rim, like a real outlet.
   */
  traceDescent(rng, start) {
    const step = 40, eps = 25, maxTurn = 0.6;
    const path = [{ x: start.x, y: start.y }];
    let p = { x: start.x, y: start.y };
    let dir = null;
    for (let i = 0; i < 120; i++) {
      const gx = (this.evaluate(p.x + eps, p.y) - this.evaluate(p.x - eps, p.y)) / (2 * eps);
      const gy = (this.evaluate(p.x, p.y + eps) - this.evaluate(p.x, p.y - eps)) / (2 * eps);
      let want = Math.hypot(gx, gy) > 1e-4 ? Math.atan2(-gy, -gx) : dir ?? rng.range(0, TAU);
      want += rng.normal(0, 0.12);
      if (dir === null) dir = want;
      else {
        let d = want - dir;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        dir += Math.max(-maxTurn, Math.min(maxTurn, d * 0.6));
      }
      p = { x: p.x + Math.cos(dir) * step, y: p.y + Math.sin(dir) * step };
      path.push(p);
      const m = 0.15 * this.L;
      if (p.x < -m || p.y < -m || p.x > this.L + m || p.y > this.L + m) break;
    }
    return path;
  }

  saddlePass(rng) {
    const L = this.L;
    const c = { x: L * rng.range(0.25, 0.75), y: L * rng.range(0.25, 0.75) };
    const ang = rng.range(0, Math.PI);
    const sep = rng.range(330, 560) / 2;
    const A1 = rng.range(38, 75) * this.relief, A2 = A1 * rng.range(0.7, 1.1);
    const p1 = { x: c.x + Math.cos(ang) * sep, y: c.y + Math.sin(ang) * sep };
    const p2 = { x: c.x - Math.cos(ang) * sep, y: c.y - Math.sin(ang) * sep };
    this.hill(rng, p1.x, p1.y, A1, 100, 170, 1.5);
    this.hill(rng, p2.x, p2.y, A2, 100, 170, 1.5);
    const pts = this.guideSpline(rng, p1, p2, 4, 25);
    const low = Math.min(A1, A2) * rng.range(0.4, 0.62);
    const w = rng.range(70, 120);
    this.primitives.push(new SplineLandform({ type: 'ridge', points: pts, channel: 'union', maxWidth: w, amplitude: () => low, width: () => w }));
    this.meta.saddles.push(c);
    this.meta.hills.push({ ...p1, kind: 'hill' }, { ...p2, kind: 'hill' });
  }

  knoll(rng, min = 2, max = 4 + Math.round(2 * this.complexity)) {
    const n = rng.int(min, max);
    for (let i = 0; i < n; i++) {
      const p = this.randomPoint(rng, 0.08 * this.L);
      this.hill(rng, p.x, p.y, rng.range(7, 22) * clamp(this.relief, 0.8, 1.2), 35, 85, 1.7, 0.2);
      this.meta.hills.push({ ...p, kind: 'knoll' });
    }
  }

  /**
   * Depressions are small enough that the noise layer decides whether a hollow
   * actually closes, so they are only scheduled here and stamped onto the
   * final grid (after noise) by applyDepressions().
   */
  depression(rng) {
    const n = rng.int(1, 3);
    this.pendingDepressions = this.pendingDepressions || [];
    for (let i = 0; i < n; i++) this.pendingDepressions.push({ depth: rng.range(5, 11), sigma: rng.range(32, 58), aspect: rng.range(1, 1.5), theta: rng.range(0, Math.PI) });
  }

  /** Stamp scheduled depressions onto the flattest suitable spots of the grid. */
  applyDepressions(heights, n, cell, rng) {
    for (const d of this.pendingDepressions || []) {
      let best = null, bestG = Infinity;
      for (let t = 0; t < 40; t++) {
        const i = rng.int(Math.round(n * 0.1), Math.round(n * 0.9)), j = rng.int(Math.round(n * 0.1), Math.round(n * 0.9));
        const r = Math.max(2, Math.round(d.sigma / cell));
        const k = j * n + i;
        const g = Math.hypot(heights[k + r] - heights[k - r], heights[k + r * n] - heights[k - r * n]) / (2 * r * cell);
        if (this.meta.depressions.some((q) => Math.hypot(q.x - i * cell, q.y - j * cell) < 250)) continue;
        if (g < bestG) { bestG = g; best = { x: i * cell, y: j * cell }; }
      }
      if (!best) continue;
      const hill = new EllipticalHill({ x: best.x, y: best.y, sx: d.sigma * Math.sqrt(d.aspect), sy: d.sigma / Math.sqrt(d.aspect), theta: d.theta, amplitude: -d.depth, harmonics: [rng.range(-0.15, 0.15), rng.range(0, TAU), 0, 0] });
      const reach = Math.ceil((4 * d.sigma * 1.5) / cell);
      const ci = Math.round(best.x / cell), cj = Math.round(best.y / cell);
      for (let j = Math.max(0, cj - reach); j <= Math.min(n - 1, cj + reach); j++) {
        for (let i = Math.max(0, ci - reach); i <= Math.min(n - 1, ci + reach); i++) heights[j * n + i] += hill.evaluate(i * cell, j * cell);
      }
      this.meta.depressions.push({ ...best, depth: d.depth, radius: 150, kind: 'depression' });
    }
  }

}
