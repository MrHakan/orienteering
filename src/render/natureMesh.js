import { Random } from '../engine/rng.js';
import { surfaceElevation } from '../engine/terrainSurface.js';

export const NATURE_VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec3 aRoot;
attribute float aSway;
uniform mat4 uProj, uView;
uniform float uTime, uGust;
uniform vec2 uWind;
varying vec3 vWorld, vNormal, vColor;
void main() {
  vec3 p = aPos;
  float height = max(0.0, p.y - aRoot.y);
  float phase = dot(aRoot.xz, vec2(.13, .17)) - uTime * 2.1;
  float bend = height * aSway * (.65 + .35 * sin(phase)) * uGust * .045;
  p.xz += vec2(uWind.x, -uWind.y) * bend;
  p.y -= min(height * .1, bend * length(uWind) * .04);
  vWorld = p; vNormal = aNormal; vColor = aColor;
  gl_Position = uProj * uView * vec4(p, 1.0);
}`;
export const NATURE_FRAG = `
precision highp float;
varying vec3 vWorld, vNormal, vColor;
uniform vec3 uEye, uSunDir, uFogColor;
uniform float uFogDensity, uWet, uSnow, uDusk;
void main() {
  vec3 n = normalize(vNormal);
  float light = .60 + .40 * max(0.0, dot(n, uSunDir));
  vec3 col = mix(vColor, vec3(.78, .83, .83), uSnow * max(0.0, n.y) * .75);
  col *= light * (1.0 - .2 * uWet);
  col *= mix(vec3(1.0), vec3(1.14, .9, .71), uDusk);
  float fog = 1.0 - exp(-pow(length(vWorld - uEye) * uFogDensity, 1.35));
  gl_FragColor = vec4(mix(col, uFogColor, clamp(fog, 0.0, 1.0)), 1.0);
}`;

/** Bounded, seeded batches. Each root rests on the rendered triangle surface. */
export function buildNatureMeshes(model) {
  const foliage = [], nature = [], roots = [];
  const rng = new Random(`${model.seed}|nature-v1`);
  const axis = Math.min(56, Math.max(4, Math.floor(model.size / 18))), step = model.size / axis;
  const vertex = (out, p, normal, color, root, sway) => out.push(...p, ...normal, ...color, ...root, sway);
  const triangle = (out, a, b, c, color, root, sway = 0) => {
    const u = b.map((v, i) => v - a[i]), v = c.map((val, i) => val - a[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    for (const p of [a, b, c]) vertex(out, p, n.map(val => val / l), color, root, sway);
  };
  const cone = (out, root, bottom, height, radius, color, sway, sides = 7) => {
    const tip = [root[0], root[1] + bottom + height, root[2]];
    for (let i = 0; i < sides; i++) {
      const a = i * Math.PI * 2 / sides, b = (i + 1) * Math.PI * 2 / sides;
      triangle(out, [root[0] + Math.cos(a) * radius, root[1] + bottom, root[2] + Math.sin(a) * radius],
        tip, [root[0] + Math.cos(b) * radius, root[1] + bottom, root[2] + Math.sin(b) * radius], color, root, sway);
    }
  };
  for (let j = 0; j < axis; j++) for (let i = 0; i < axis; i++) {
    const x = (i + rng.range(.18, .82)) * step, y = (j + rng.range(.18, .82)) * step;
    const z = surfaceElevation(model, x, y), root = [x, z, -y];
    const slope = model.getSlope(x, y);
    roots.push({ x, y, z });
    if (slope < 32) {
      const tint = rng.range(.85, 1.2);
      for (let b = 0; b < 7; b++) {
        const a = rng.range(0, Math.PI * 2), dx = rng.range(-.7, .7), dy = rng.range(-.7, .7);
        const h = rng.range(.35, .9), w = rng.range(.08, .19);
        const r = [x + dx, surfaceElevation(model, x + dx, y + dy), -y - dy];
        triangle(foliage, [r[0] - Math.cos(a) * w, r[1], r[2] - Math.sin(a) * w],
          [r[0] + .08, r[1] + h, r[2] + .06], [r[0] + Math.cos(a) * w, r[1], r[2] + Math.sin(a) * w],
          [.25 * tint, .34 * tint, .11 * tint], r, 1);
      }
      if (rng.chance(.12)) {
        cone(foliage, root, 0, rng.range(.7, 1.3), rng.range(.8, 1.5), [.22, .3, .12], .3);
        cone(foliage, root, .15, .75, .65, [.29, .37, .15], .3);
      }
      if (rng.chance(.018)) {
        const h = rng.range(3.5, 5.5);
        cone(foliage, root, 0, h * .65, .14, [.27, .21, .15], 0, 5);
        for (let k = 0; k < 3; k++) cone(foliage, root, h * (.22 + k * .19), h * (.5 - k * .09),
          h * (.23 - k * .045), [.14 + k * .025, .25 + k * .02, .14], .045);
      }
      if (rng.chance(.48)) for (let f = 0; f < 3; f++) {
        const xx = x + rng.range(-1, 1), yy = y + rng.range(-1, 1);
        const r = [xx, surfaceElevation(model, xx, yy), -yy], h = rng.range(.25, .55);
        triangle(nature, r, [xx + .035, r[1] + h, -yy], [xx - .035, r[1] + h, -yy], [.28, .38, .12], r, 1);
        const color = rng.pick([[.87, .76, .28], [.69, .59, .81], [.87, .85, .71]]);
        for (let p = 0; p < 5; p++) {
          const a = p * Math.PI * 2 / 5, b = (p + 1) * Math.PI * 2 / 5;
          triangle(nature, [xx, r[1] + h, -yy], [xx + Math.cos(a) * .12, r[1] + h - .03, -yy + Math.sin(a) * .12],
            [xx + Math.cos(b) * .12, r[1] + h - .03, -yy + Math.sin(b) * .12], color, r, 1);
        }
      }
    }
    if (rng.chance(.10)) {
      const r = rng.range(.4, 1.1), h = r * rng.range(.5, .85);
      cone(nature, root, -.12, h, r, [.4, .39, .35], 0, 6);
      cone(nature, root, h * .22, h * .6, r * .75, [.46, .44, .39], 0, 5);
    }
  }
  return { foliage: new Float32Array(foliage), nature: new Float32Array(nature), roots };
}
