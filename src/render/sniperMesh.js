// Enemy sniper for sniper mode: a 1.80 m man in a shaggy ghillie suit lying
// prone on his elbows behind a scoped, suppressed rifle on its bipod, aimed
// back at the observer. The body follows the slope (person.pitch). Built from
// tapered cylinders, low-poly ellipsoids and grass-like ghillie strands;
// deterministic and metre-scale, so his apparent size is exact for ranging.
//
// Local frame: x right, y up, z forward (the person's heading). The origin is
// on the ground under the head; the head centre is 0.30 m above it.

const GHILLIE = [[0.19, 0.23, 0.10], [0.25, 0.26, 0.13], [0.14, 0.18, 0.07], [0.27, 0.23, 0.14], [0.21, 0.19, 0.10], [0.12, 0.15, 0.06]];
const SUIT = [0.15, 0.17, 0.09], BOOT = [0.09, 0.08, 0.06], GLOVE = [0.14, 0.13, 0.10];
const METAL = [0.07, 0.075, 0.07], STOCK = [0.15, 0.15, 0.12], FACE = [0.19, 0.18, 0.12], LENS = [0.05, 0.08, 0.10];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => add(a, mul(sub(b, a), t));

/** Tiny deterministic hash stream for the ghillie layout. */
function stream(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

export function sniperVertices(person) {
  const out = [], scale = person.height / 1.8;
  const az = person.heading * Math.PI / 180, c = Math.cos(az), s = Math.sin(az);
  // Lie along the slope: positive pitch raises the boots (behind, -z).
  const pitch = (person.pitch || 0) * Math.PI / 180, pc = Math.cos(pitch), ps = Math.sin(pitch);
  const tilt = ([x, y, z]) => [x, y * pc - z * ps, y * ps + z * pc];
  const vertex = (p, n, color) => {
    const [x, y, z] = tilt(p), [nx, ny, nz] = tilt(n);
    out.push(person.x + (x * c + z * s) * scale, person.z + y * scale, -person.y + (x * s - z * c) * scale,
      nx * c + nz * s, ny, nx * s - nz * c, ...color);
  };
  const tri = (a, b, d, color, normal = norm(cross(sub(b, a), sub(d, a)))) => {
    vertex(a, normal, color); vertex(b, normal, color); vertex(d, normal, color);
  };
  /** Tapered cylinder from a (radius ra) to b (radius rb), with end caps. */
  const limb = (a, b, ra, rb, color, sides = 8) => {
    const axis = norm(sub(b, a));
    const helper = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(axis, helper)), v = cross(axis, u);
    const ring = (p, r, i) => { const t = i / sides * Math.PI * 2, d = add(mul(u, Math.cos(t)), mul(v, Math.sin(t))); return [add(p, mul(d, r)), d]; };
    for (let i = 0; i < sides; i++) {
      const [a0, n0] = ring(a, ra, i), [a1, n1] = ring(a, ra, i + 1), [b0] = ring(b, rb, i), [b1] = ring(b, rb, i + 1);
      vertex(a0, n0, color); vertex(b0, n0, color); vertex(b1, n1, color);
      vertex(a0, n0, color); vertex(b1, n1, color); vertex(a1, n1, color);
      tri(a, a1, a0, color, mul(axis, -1)); tri(b, b0, b1, color, axis);
    }
  };
  /** Low-poly ellipsoid. */
  const blob = (centre, [rx, ry, rz], color, rings = 5, segs = 9) => {
    const p = (i, j) => {
      const th = i / rings * Math.PI, ph = j / segs * Math.PI * 2;
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      return [[centre[0] + n[0] * rx, centre[1] + n[1] * ry, centre[2] + n[2] * rz], norm([n[0] / rx, n[1] / ry, n[2] / rz])];
    };
    for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
      const [a, na] = p(i, j), [b, nb] = p(i + 1, j), [d, nd] = p(i + 1, j + 1), [e, ne] = p(i, j + 1);
      vertex(a, na, color); vertex(b, nb, color); vertex(d, nd, color);
      vertex(a, na, color); vertex(d, nd, color); vertex(e, ne, color);
    }
  };

  // ---------------------------------------------------------------- pose
  // Prone on the elbows, cheek on the stock, legs spread for stability.
  const head = [0, 0.3, 0], neck = [0, 0.26, -0.1];
  const shoulderL = [-0.21, 0.22, -0.2], shoulderR = [0.2, 0.24, -0.22];
  const chest = [0, 0.18, -0.27], pelvis = [0.02, 0.15, -0.78];
  const hipL = [-0.1, 0.12, -0.8], hipR = [0.12, 0.12, -0.8];
  const kneeL = [-0.24, 0.08, -1.2], kneeR = [0.24, 0.09, -1.17];
  const ankleL = [-0.32, 0.08, -1.57], ankleR = [0.33, 0.09, -1.54];
  const elbowL = [-0.24, 0.06, 0.06], elbowR = [0.28, 0.06, -0.04];
  const handL = [0.06, 0.13, -0.08], gripR = [0.14, 0.18, -0.05];

  limb(chest, pelvis, 0.19, 0.17, SUIT, 9);
  blob([0, 0.27, -0.42], [0.25, 0.1, 0.32], GHILLIE[4], 4, 9);      // ghillie cape over the back
  limb(neck, chest, 0.07, 0.11, SUIT);
  blob(head, [0.1, 0.105, 0.11], FACE);
  blob([0, 0.34, -0.04], [0.135, 0.11, 0.14], GHILLIE[2], 4, 9);     // hood
  limb(hipL, kneeL, 0.1, 0.075, SUIT); limb(kneeL, ankleL, 0.075, 0.055, SUIT);
  limb(hipR, kneeR, 0.1, 0.075, SUIT); limb(kneeR, ankleR, 0.075, 0.055, SUIT);
  for (const a of [ankleL, ankleR]) blob([a[0], 0.09, a[2] - 0.04], [0.055, 0.11, 0.05], BOOT, 3, 7); // toes dug in
  limb(shoulderL, elbowL, 0.065, 0.055, SUIT); limb(elbowL, handL, 0.05, 0.04, SUIT);
  limb(shoulderR, elbowR, 0.065, 0.055, SUIT); limb(elbowR, gripR, 0.05, 0.04, SUIT);
  blob(handL, [0.045, 0.04, 0.05], GLOVE, 3, 7); blob(gripR, [0.045, 0.045, 0.05], GLOVE, 3, 7);

  // ---------------------------------------------------------------- rifle
  const x = 0.1, y = 0.2;
  limb([x + 0.02, y - 0.03, -0.24], [x, y, 0.02], 0.035, 0.03, STOCK, 6);       // stock in the shoulder
  limb([x, y, 0.02], [x, y + 0.005, 0.38], 0.032, 0.03, METAL, 6);              // receiver + forend
  limb([x, y + 0.01, 0.38], [x, y + 0.01, 0.92], 0.011, 0.01, METAL, 6);        // barrel
  limb([x, y + 0.01, 0.9], [x, y + 0.01, 1.12], 0.022, 0.022, METAL, 8);        // suppressor
  limb([x, y + 0.075, -0.04], [x, y + 0.075, 0.3], 0.02, 0.02, METAL, 8);       // scope tube
  limb([x, y + 0.075, 0.3], [x, y + 0.08, 0.4], 0.022, 0.032, METAL, 8);        // objective bell
  limb([x, y + 0.08, 0.4], [x, y + 0.08, 0.405], 0.028, 0.028, LENS, 8);
  limb([x, y + 0.075, -0.1], [x, y + 0.075, -0.04], 0.026, 0.02, METAL, 8);     // eyepiece at his eye
  limb([x, y + 0.04, 0.12], [x, y + 0.115, 0.12], 0.012, 0.012, METAL, 6);      // turret
  for (const k of [-1, 1]) limb([x, y - 0.02, 0.5], [x + k * 0.07, 0.0, 0.58], 0.007, 0.006, METAL, 4); // deployed bipod

  // -------------------------------------------------------------- ghillie
  // Strands splay off the back, hood and legs and droop to the ground, so the
  // outline reads as a grassy mound rather than a person.
  const rnd = stream(0x9e3779b1);
  const strands = [
    [chest, pelvis, 0.19, 170], [[0, 0.28, -0.2], [0, 0.28, -0.62], 0.17, 70], [neck, chest, 0.1, 16],
    [[0, 0.33, -0.02], [0, 0.36, -0.1], 0.14, 60],
    [shoulderL, elbowL, 0.07, 22], [shoulderR, elbowR, 0.07, 22],
    [hipL, kneeL, 0.1, 40], [hipR, kneeR, 0.1, 40], [kneeL, ankleL, 0.075, 24], [kneeR, ankleR, 0.075, 24],
  ];
  for (const [a, b, radius, count] of strands) {
    const axis = norm(sub(b, a)), helper = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(axis, helper)), v = cross(axis, u);
    for (let i = 0; i < count; i++) {
      const t = rnd(), ang = rnd() * Math.PI * 2, out0 = add(mul(u, Math.cos(ang)), mul(v, Math.sin(ang)));
      if (out0[1] < -0.35) continue; // nothing grows into the ground
      const root = add(lerp3(a, b, t), mul(out0, radius * (0.85 + 0.2 * rnd())));
      const width = 0.025 + 0.035 * rnd(), len = (0.08 + 0.16 * rnd()) * (out0[1] > 0.5 ? 0.6 : 1);
      const dir = norm(add(mul(out0, 0.55), [0, -0.85 + 0.5 * rnd(), 0])); // lying flat, drooping
      const tip = add(root, mul(dir, len)), side = mul(norm(cross(dir, out0)), width / 2);
      if (tip[1] < 0.005) tip[1] = 0.005;
      const color = GHILLIE[Math.floor(rnd() * GHILLIE.length)];
      tri(add(root, side), sub(root, side), tip, color);
      if (rnd() < 0.5) tri(root, add(tip, mul(side, 1.4)), sub(tip, mul(side, -0.2)), color);
    }
  }
  // Burlap wrap on the rifle so it does not read as a clean black line.
  for (let i = 0; i < 10; i++) {
    const z = 0.05 + i * 0.07, r = rnd();
    const root = [x + (r - 0.5) * 0.04, y + 0.03, z], tip = add(root, [(rnd() - 0.5) * 0.08, -0.07 - 0.05 * rnd(), 0.02]);
    tri(add(root, [0, 0, -0.015]), add(root, [0, 0, 0.015]), tip, GHILLIE[i % GHILLIE.length]);
  }
  return new Float32Array(out);
}
