// Enemy sniper for sniper mode: a 1.80 m figure in a shaggy ghillie suit,
// standing in a shooting stance with a scoped, suppressed rifle shouldered
// and pointed back at the observer. Built from tapered cylinders, low-poly
// spheres and grass-like ghillie strands; deterministic (no randomness at
// draw time) and metre-scale, so its apparent size is exact for mil ranging.
//
// Local frame: x right, y up, z forward (the person's heading).

// A little darker than dry grass so the head still reads through the scope at 1 km.
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
  const vertex = ([x, y, z], [nx, ny, nz], color) => {
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
  // Rifleman's stance: left foot forward, body bladed, rifle shouldered at the right.
  const pelvis = [0, 0.96, 0], chest = [0.01, 1.36, 0.04];
  const hipL = [-0.1, 0.94, 0.03], hipR = [0.1, 0.94, -0.03];
  const kneeL = [-0.13, 0.5, 0.14], kneeR = [0.14, 0.5, -0.1];
  const ankleL = [-0.15, 0.09, 0.2], ankleR = [0.17, 0.09, -0.2];
  const shoulderL = [-0.18, 1.41, 0.1], shoulderR = [0.17, 1.42, -0.05];
  const neck = [0.02, 1.5, 0.05], head = [0.05, 1.63, 0.09];
  const elbowR = [0.3, 1.28, 0.04], gripR = [0.13, 1.39, 0.16];
  const elbowL = [-0.15, 1.27, 0.33], forendL = [0.1, 1.41, 0.5];

  // Legs and boots.
  limb(hipL, kneeL, 0.1, 0.075, SUIT); limb(kneeL, ankleL, 0.075, 0.055, SUIT);
  limb(hipR, kneeR, 0.1, 0.075, SUIT); limb(kneeR, ankleR, 0.075, 0.055, SUIT);
  for (const a of [ankleL, ankleR]) blob([a[0], 0.05, a[2] + 0.05], [0.055, 0.05, 0.12], BOOT, 3, 7);
  // Torso, chest rig and hood.
  limb(pelvis, chest, 0.18, 0.2, SUIT, 9);
  blob([0, 1.4, -0.04], [0.23, 0.12, 0.17], GHILLIE[4], 4, 9); // ghillie cape over the shoulders
  blob([0.01, 1.3, 0.12], [0.15, 0.12, 0.06], [0.19, 0.21, 0.1], 3, 8);
  limb(chest, neck, 0.1, 0.06, SUIT);
  blob(head, [0.1, 0.115, 0.105], FACE);
  blob([head[0] - 0.01, head[1] + 0.03, head[2] - 0.03], [0.13, 0.12, 0.13], GHILLIE[2], 4, 9); // hood
  // Arms on the rifle.
  limb(shoulderR, elbowR, 0.06, 0.05, SUIT); limb(elbowR, gripR, 0.05, 0.04, SUIT);
  limb(shoulderL, elbowL, 0.06, 0.05, SUIT); limb(elbowL, forendL, 0.05, 0.04, SUIT);
  blob(gripR, [0.045, 0.04, 0.05], GLOVE, 3, 7); blob(forendL, [0.045, 0.04, 0.055], GLOVE, 3, 7);

  // ---------------------------------------------------------------- rifle
  const y = 1.45, x = 0.12;
  limb([x, y - 0.05, -0.14], [x, y - 0.01, 0.12], 0.035, 0.03, STOCK, 6);      // stock
  limb([x, y - 0.1, -0.16], [x, y - 0.02, -0.12], 0.02, 0.03, STOCK, 6);       // butt pad
  limb([x, y, 0.1], [x, y, 0.46], 0.032, 0.03, METAL, 6);                      // receiver + forend
  limb([x, y + 0.005, 0.46], [x, y + 0.005, 0.86], 0.011, 0.01, METAL, 6);     // barrel
  limb([x, y + 0.005, 0.84], [x, y + 0.005, 1.05], 0.022, 0.022, METAL, 8);    // suppressor
  limb([x, y + 0.075, 0.08], [x, y + 0.075, 0.4], 0.02, 0.02, METAL, 8);       // scope tube
  limb([x, y + 0.075, 0.4], [x, y + 0.08, 0.5], 0.022, 0.032, METAL, 8);       // objective bell
  limb([x, y + 0.08, 0.5], [x, y + 0.08, 0.505], 0.028, 0.028, LENS, 8);
  limb([x, y + 0.075, 0.03], [x, y + 0.075, 0.09], 0.026, 0.02, METAL, 8);     // eyepiece
  limb([x, y + 0.04, 0.22], [x, y + 0.115, 0.22], 0.012, 0.012, METAL, 6);     // turret
  for (const k of [-1, 1]) limb([x, y - 0.03, 0.44], [x + k * 0.03, y - 0.06, 0.62], 0.006, 0.006, METAL, 4); // folded bipod

  // -------------------------------------------------------------- ghillie
  // Grass-like strands hanging from the shoulders, back, hood, arms and thighs
  // break up the human outline the way a real ghillie suit does.
  const rnd = stream(0x9e3779b1);
  const strands = [
    [pelvis, chest, 0.19, 150], [[0, 1.36, -0.04], [0, 1.45, -0.04], 0.21, 60], [chest, neck, 0.11, 18],
    [head, add(head, [0, 0.1, -0.04]), 0.13, 60],
    [shoulderL, elbowL, 0.07, 26], [shoulderR, elbowR, 0.07, 26], [elbowL, forendL, 0.055, 12], [elbowR, gripR, 0.055, 12],
    [hipL, kneeL, 0.1, 40], [hipR, kneeR, 0.1, 40], [kneeL, ankleL, 0.075, 22], [kneeR, ankleR, 0.075, 22],
  ];
  for (const [a, b, radius, count] of strands) {
    const axis = norm(sub(b, a)), helper = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(axis, helper)), v = cross(axis, u);
    for (let i = 0; i < count; i++) {
      const t = rnd(), ang = rnd() * Math.PI * 2, out0 = add(mul(u, Math.cos(ang)), mul(v, Math.sin(ang)));
      const root = add(lerp3(a, b, t), mul(out0, radius * (0.85 + 0.2 * rnd())));
      const len = 0.08 + 0.16 * rnd(), width = 0.025 + 0.035 * rnd();
      // Strands splay outwards and droop under gravity.
      const dir = norm(add(mul(out0, 0.8), [0, -0.9 + 0.5 * rnd(), 0]));
      const tip = add(root, mul(dir, len)), side = mul(norm(cross(dir, out0)), width / 2);
      const color = GHILLIE[Math.floor(rnd() * GHILLIE.length)];
      tri(add(root, side), sub(root, side), tip, color);
      if (rnd() < 0.5) tri(root, add(tip, mul(side, 1.4)), sub(tip, mul(side, -0.2)), color);
    }
  }
  // Burlap wrap on the rifle so it does not read as a clean black line.
  for (let i = 0; i < 10; i++) {
    const z = 0.15 + i * 0.07, r = rnd();
    const root = [x + (r - 0.5) * 0.04, y + 0.03, z], tip = add(root, [(rnd() - 0.5) * 0.08, -0.07 - 0.05 * rnd(), 0.02]);
    tri(add(root, [0, 0, -0.015]), add(root, [0, 0, 0.015]), tip, GHILLIE[i % GHILLIE.length]);
  }
  return new Float32Array(out);
}
