import { Random } from '../engine/rng.js';
import { surfaceElevation } from '../engine/terrainSurface.js';
import { densityProfile } from './environment.js';

export const NATURE_STRIDE = 16;
export const NATURE_VERT = `
attribute vec3 aPos, aNormal, aColor, aRoot;
attribute float aSway, aKind;
attribute vec2 aUV;
uniform mat4 uProj, uView;
uniform float uTime, uGust;
uniform vec2 uWind;
varying vec3 vWorld, vNormal, vColor, vRoot;
varying vec2 vUV;
varying float vKind;
void main() {
  vec3 p = aPos;
  float height = max(0.0, p.y - aRoot.y);
  float phase = dot(aRoot.xz, vec2(.13, .17)) - uTime * 2.1;
  float bend = height * aSway * (.65 + .35 * sin(phase)) * uGust * .045;
  p.xz += vec2(uWind.x, -uWind.y) * bend;
  p.y -= min(height * .1, abs(bend) * length(uWind) * .04);
  vWorld = p; vNormal = aNormal; vColor = aColor; vRoot = aRoot;
  vUV = aUV; vKind = aKind;
  gl_Position = uProj * uView * vec4(p, 1.0);
}`;
export const NATURE_FRAG = `
precision highp float;
varying vec3 vWorld, vNormal, vColor, vRoot;
varying vec2 vUV;
varying float vKind;
uniform vec3 uEye, uSunDir, uFogColor, uFriend;
uniform sampler2D uFoliage, uSurface;
uniform float uFogDensity, uWet, uSnow, uDusk, uHD;
float grain(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 n = normalize(vNormal), col = vColor;
  float d = length(vWorld - uEye);
  if (vKind > .5) {
    // Alpha-tested leaves write depth like solid geometry; crossed cards need no sorting.
    vec4 leaf = texture2D(uFoliage, vUV);
    float fade = vKind < 3.5 ? 1.0 - smoothstep(48.0, 85.0, length(vRoot.xz - uEye.xz)) : 1.0;
    if (leaf.a < .42 || fade < grain(gl_FragCoord.xy)) discard;
    // Keep the chosen friend's sightline readable when decorative plants are enabled.
    if (uFriend.z > .5) {
      vec2 line = uFriend.xy - uEye.xz;
      float t = dot(vRoot.xz - uEye.xz, line) / max(1.0, dot(line, line));
      if (t > 0.0 && t < 1.025 && length(vRoot.xz - uEye.xz - line * clamp(t, 0.0, 1.0)) < 1.5) discard;
    }
    col *= leaf.rgb;
    // Soft two-sided leaf lighting and subtle transmission avoid flat dark cards.
    float light = .69 + .24 * abs(dot(n, uSunDir)) + .07 * max(0.0, dot(normalize(vWorld - uEye), uSunDir));
    float rootShade = mix(.68, 1.0, smoothstep(0.0, .65, vWorld.y - vRoot.y));
    col *= light * rootShade;
  } else {
    if (uHD > .5 && vColor.r > .33 && vColor.g < .5) {
      vec2 uv = vec2(.5, 0.0) + .00390625 + fract(vWorld.xz / 2.0) * .4921875;
      col = texture2D(uSurface, uv).rgb * vColor * 2.0;
    }
    col *= .58 + .42 * max(0.0, dot(n, uSunDir));
  }
  col = mix(col, vec3(.78, .83, .83), uSnow * (.25 + .55 * max(0.0, n.y)));
  col *= (1.0 - .2 * uWet) * mix(vec3(1.0), vec3(1.14, .9, .71), uDusk);
  float fog = 1.0 - exp(-pow(d * uFogDensity, 1.35));
  gl_FragColor = vec4(mix(col, uFogColor, clamp(fog, 0.0, 1.0)), 1.0);
}`;

function vertex(out, p, normal, color, root, sway, uv = [0, 0], kind = 0) {
  out.push(...p, ...normal, ...color, ...root, sway, ...uv, kind);
}
function triangle(out, a, b, c, color, root, sway = 0) {
  const u = b.map((v, i) => v - a[i]), v = c.map((val, i) => val - a[i]);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  for (const p of [a, b, c]) vertex(out, p, n.map(val => val / l), color, root, sway);
}
function plant(out, root, width, height, slot, angle, tint = 1, sway = 1, cards = 3, bottom = 0) {
  const col = slot % 3, row = Math.floor(slot / 3);
  // Inset by two source pixels to protect neighbouring silhouettes at low mips.
  const uv = [[(col + .004) / 3, (row + .996) / 2], [(col + .996) / 3, (row + .996) / 2],
    [(col + .996) / 3, (row + .004) / 2], [(col + .004) / 3, (row + .004) / 2]];
  for (let i = 0; i < cards; i++) {
    const a = angle + i * Math.PI / cards, dx = Math.cos(a) * width * .5, dz = Math.sin(a) * width * .5;
    const p = [[root[0] - dx, root[1] + bottom, root[2] - dz], [root[0] + dx, root[1] + bottom, root[2] + dz],
      [root[0] + dx, root[1] + bottom + height, root[2] + dz], [root[0] - dx, root[1] + bottom + height, root[2] - dz]];
    const normal = [-Math.sin(a) * .95, .31, Math.cos(a) * .95];
    for (const k of [0, 1, 2, 0, 2, 3]) vertex(out, p[k], normal, [tint, tint, tint * .96], root, sway, uv[k], slot + 1);
  }
}
function stone(out, root, radius, rng) {
  // Irregular, rounded boulders rather than pointed cones.
  const sides = 8, rings = [], color = [.42, .41, .37];
  for (let j = 0; j < 3; j++) {
    const ring = [], r = [1, .88, .38][j] * radius, y = [-.1, .36, .62][j] * radius;
    for (let i = 0; i < sides; i++) {
      const a = i * Math.PI * 2 / sides, rough = rng.range(.8, 1.18);
      ring.push([root[0] + Math.cos(a) * r * rough, root[1] + y + rng.range(-.08, .08) * radius, root[2] + Math.sin(a) * r * rough]);
    }
    rings.push(ring);
  }
  for (let j = 0; j < 2; j++) for (let i = 0; i < sides; i++) {
    const k = (i + 1) % sides;
    triangle(out, rings[j][i], rings[j + 1][i], rings[j + 1][k], color, root);
    triangle(out, rings[j][i], rings[j + 1][k], rings[j][k], color, root);
  }
  const top = [root[0], root[1] + radius * .68, root[2]];
  for (let i = 0; i < sides; i++) triangle(out, rings[2][i], top, rings[2][(i + 1) % sides], color, root);
}

/** Bounded landscape plants. Roots rest on the exact rendered triangle surface. */
export function buildNatureMeshes(model, { foliageDensity, natureDensity } = {}) {
  const foliage = [], nature = [], roots = [];
  const coverage = { foliage: densityProfile(foliageDensity).coverage, nature: densityProfile(natureDensity).coverage };
  buildLandscapeLayer(model, `${model.seed}|nature-v2`, coverage, foliage, nature, roots);
  if (coverage.foliage > 1 || coverage.nature > 1) {
    buildLandscapeLayer(model, `${model.seed}|nature-heavy-v1`, {
      foliage: Math.max(0, coverage.foliage - 1), nature: Math.max(0, coverage.nature - 1),
    }, foliage, nature, roots);
  }
  return { foliage: new Float32Array(foliage), nature: new Float32Array(nature), roots };
}

function buildLandscapeLayer(model, seed, coverage, foliage, nature, roots) {
  const rng = new Random(seed);
  // Density streams never consume placement randomness or reshuffle the other category.
  const foliageRng = new Random(`${seed}|foliage-density`), natureRng = new Random(`${seed}|nature-density`);
  const axis = Math.min(56, Math.max(4, Math.floor(model.size / 18))), step = model.size / axis;
  for (let j = 0; j < axis; j++) for (let i = 0; i < axis; i++) {
    const foliageStart = foliage.length, natureStart = nature.length;
    const keepFoliage = foliageRng.next() < coverage.foliage, keepNature = natureRng.next() < coverage.nature;
    const x = (i + rng.range(.18, .82)) * step, y = (j + rng.range(.18, .82)) * step;
    const z = surfaceElevation(model, x, y), root = [x, z, -y], slope = model.getSlope(x, y);
    if (keepFoliage || keepNature) roots.push({ x, y, z });
    if (slope < 32) {
      const a = rng.range(0, Math.PI * 2), tint = rng.range(.84, 1.07);
      plant(foliage, root, rng.range(1.2, 2.2), rng.range(.55, .95), rng.int(0, 1), a, tint);
      if (rng.chance(.48)) plant(foliage, root, rng.range(1.4, 2.8), rng.range(.9, 1.7), 3, a + .5, tint, .25);
      if (rng.chance(.045)) {
        const h = rng.range(5.5, 9.5);
        plant(foliage, root, h * .72, h, 4, a, tint, .035, 2);
        // Needle branches add volume around the crossed full-tree silhouettes.
        for (let k = 0; k < 3; k++) plant(foliage, root, h * (.65 - k * .14), h * .27, 5, a + k * .9, tint * .9, .035, 2, h * (.28 + k * .2));
      }
      if (rng.chance(.3)) plant(nature, root, rng.range(.8, 1.4), rng.range(.5, .9), 2, a, .93, .65);
      if (rng.chance(.22)) for (let f = 0; f < 3; f++) {
        const xx = x + rng.range(-1, 1), yy = y + rng.range(-1, 1), r = [xx, surfaceElevation(model, xx, yy), -yy];
        const h = rng.range(.25, .55), color = rng.pick([[.87, .76, .28], [.69, .59, .81], [.87, .85, .71]]);
        triangle(nature, r, [xx + .035, r[1] + h, -yy], [xx - .035, r[1] + h, -yy], [.28, .38, .12], r, 1);
        for (let p = 0; p < 5; p++) {
          const a = p * Math.PI * 2 / 5, b = (p + 1) * Math.PI * 2 / 5;
          triangle(nature, [xx, r[1] + h, -yy], [xx + Math.cos(a) * .12, r[1] + h - .03, -yy + Math.sin(a) * .12],
            [xx + Math.cos(b) * .12, r[1] + h - .03, -yy + Math.sin(b) * .12], color, r, 1);
        }
      }
    }
    if (rng.chance(.085)) stone(nature, root, rng.range(.4, 1.35), rng);
    // Generate each original cell before filtering so Moderate stays byte-for-byte identical.
    if (!keepFoliage) foliage.length = foliageStart;
    if (!keepNature) nature.length = natureStart;
  }
}

/** Dense nearby meadow streamed by world cells, independent of playback/seek order. */
export function buildGroundCover(model, camera, radius = 85, density = 'moderate') {
  const vertices = [], roots = [], profile = densityProfile(density);
  // Quantising the centre avoids regenerating buffers for every small camera movement.
  const cx = Math.floor(camera.x / 16) * 16 + 8, cy = Math.floor(camera.y / 16) * 16 + 8;
  buildMeadowLayer(model, cx, cy, radius, 'meadow', Math.min(1, profile.coverage), vertices, roots);
  if (profile.coverage > 1) buildMeadowLayer(model, cx, cy, radius, 'meadow-heavy-v1', profile.coverage - 1, vertices, roots);
  return { vertices: new Float32Array(vertices), roots, key: `${Math.floor(camera.x / 16)}:${Math.floor(camera.y / 16)}:${profile.id}` };
}

function buildMeadowLayer(model, cx, cy, radius, layer, coverage, vertices, roots) {
  const step = 3.5;
  for (let j = Math.floor((cy - radius) / step); j <= Math.ceil((cy + radius) / step); j++) {
    for (let i = Math.floor((cx - radius) / step); i <= Math.ceil((cx + radius) / step); i++) {
      const seed = `${model.seed}|${layer}|${i}|${j}`;
      if (coverage < 1 && new Random(`${seed}|density`).next() >= coverage) continue;
      const rng = new Random(seed);
      const x = (i + rng.range(.12, .88)) * step, y = (j + rng.range(.12, .88)) * step;
      if (!model.inside(x, y) || Math.hypot(x - cx, y - cy) > radius || model.getSlope(x, y) > 36) continue;
      const z = surfaceElevation(model, x, y), root = [x, z, -y], a = rng.range(0, Math.PI * 2);
      roots.push({ x, y, z });
      const slot = rng.chance(.09) ? 2 : rng.int(0, 1), h = rng.range(.4, .82), width = h * rng.range(1.5, 2.2);
      plant(vertices, root, width, h, slot, a, rng.range(.83, 1.06), slot === 2 ? .65 : 1);
      if (rng.chance(.035)) plant(vertices, root, rng.range(1.1, 1.8), rng.range(.7, 1.15), 3, a, .92, .25);
    }
  }
}
