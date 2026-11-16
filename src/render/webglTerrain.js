// First-person WebGL terrain renderer. It only reads TerrainModel.getElevation,
// so the 3D scene is by construction the same surface the map is drawn from.
//
// GL axes: X = east, Y = up, Z = -north.
import { personVertices } from './personMesh.js';
import { RifleViewModel } from './rifleViewModel.js';
import { KnifeViewModel } from './knifeViewModel.js';
import { FriendSprite } from './friendSprite.js';
import { windGust, densityProfile, hazeDistance } from './environment.js';
import { EnvironmentTextures, terrainHeightPixels, TERRAIN_MATERIAL_GLSL } from './terrainDetail.js';
import { buildNatureMeshes, buildGroundCover, NATURE_STRIDE, NATURE_VERT, NATURE_FRAG } from './natureMesh.js';
import { WatchViewModel } from './watchViewModel.js';
import { normaliseTextureMode, terrainTexture } from './terrainTextures.js';

const PERSON_VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uProj;
uniform mat4 uView;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
void main() {
  vWorld = aPos; vNormal = aNormal; vColor = aColor;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;
const PERSON_FRAG = `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
uniform vec3 uEye;
uniform vec3 uSunDir;
uniform vec3 uFogColor;
uniform float uFogDensity;
void main() {
  float light = 0.72 + 0.28 * max(0.0, dot(normalize(vNormal), uSunDir));
  float fog = 1.0 - exp(-pow(length(vWorld - uEye) * uFogDensity, 1.35));
  gl_FragColor = vec4(mix(vColor * light, uFogColor, clamp(fog, 0.0, 1.0)), 1.0);
}`;

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vWorld = aPos;
  vNormal = aNormal;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
uniform vec3 uEye;
uniform vec3 uSunDir;
uniform vec2 uHeightRange;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
uniform float uCloud;   // 0..1 cloud cover (moving shadows)
uniform vec2 uWind;     // wind vector, m/s (east, north)
uniform vec2 uCloudWind;
uniform float uWet;     // 0..1 rain darkening
uniform float uHD, uSnow, uDusk, uGust;
uniform float uDeck, uMist; // closed cloud deck (flat light), valley mist

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

${TERRAIN_MATERIAL_GLSL}

void main() {
  vec3 n = normalize(vNormal);
  float d = length(vWorld - uEye);
  float h = (vWorld.y - uHeightRange.x) / max(1.0, uHeightRange.y - uHeightRange.x);
  float slope = 1.0 - n.y;

  vec3 col;
  SurfaceMaterial material;
  if (uHD > .5) {
    material = surfaceMaterial(vWorld, n, d, h);
    col = material.color;
  } else {
    vec2 ground = vWorld.xz / uTextureScale + uTextureOffset;
    float patchN = vnoise(ground / 160.0) - 0.5;
    col = mix(uGrassLow, uGrassHigh, smoothstep(0.1, 0.6, h + patchN * 0.3));
    col = mix(col, uDry, uTextureMix.x + (1.0 - uTextureMix.x) * smoothstep(0.35, 0.95, h + patchN * 0.2) * 0.85);
    col = mix(col, uRock, clamp(uTextureMix.y + smoothstep(.025, .16, slope) * uTextureMix.z, 0.0, .98));
    float fine = 1.0 - smoothstep(150.0, 900.0, d);
    float tex = (vnoise(ground / 5.0) - 0.5) * 0.35 * fine
              + (vnoise(ground / 21.0) - 0.5) * 0.3 * (1.0 - smoothstep(400.0, 2000.0, d))
              + (vnoise(ground / 75.0) - 0.5) * 0.25;
    col *= 1.0 + tex;
  }
  // Snow lies on gentle ground; steep slopes and some tussocks stay bare.
  float snowCover = uSnow * smoothstep(.5, .9, n.y + (vnoise(vec2(vWorld.x, -vWorld.z) / 13.0) - .5) * .32);
  vec3 snowCol = vec3(.74, .78, .84); // leaves headroom so the light still models the slopes
  col = mix(col, uHD > .5 ? pow(snowCol, vec3(2.2)) : snowCol, clamp(snowCover * 1.15, 0.0, .96));
  // Under a closed deck colours lose some saturation.
  col = mix(col, vec3(dot(col, vec3(.299, .587, .114))), .16 * uDeck * (1.0 - snowCover));

  // Wind: bands of bent grass sweeping downwind.
  float windSpeed = length(uWind);
  if (windSpeed > 0.01) {
    vec2 wd = uWind / windSpeed;
    vec2 ground = vec2(vWorld.x, -vWorld.z);
    float phase = dot(ground, wd) / 7.0 - uTime * (1.2 + windSpeed * 0.25) + vnoise(ground / 35.0) * 5.0;
    col *= 1.0 + 0.07 * sin(phase) * min(1.0, windSpeed / 8.0) * uGust * (1.0 - smoothstep(80.0, 700.0, d));
  }
  col *= 1.0 - 0.2 * uWet;

  vec3 lightNormal = uHD > .5 ? material.normal : n;
  float diff = max(dot(lightNormal, uSunDir), 0.0);
  float hemi = 0.55 + 0.45 * n.y;
  // Moving cloud shadows (and a duller, flatter light under overcast skies).
  float shadow = 0.0;
  if (uCloud > 0.0) {
    vec2 cp = (vec2(vWorld.x, -vWorld.z) - uCloudWind * uTime * 6.0) / 520.0;
    float c = vnoise(cp) * 0.6 + vnoise(cp * 2.3) * 0.3 + vnoise(cp * 5.1) * 0.1;
    shadow = smoothstep(0.62 - 0.35 * uCloud, 0.8 - 0.3 * uCloud, c) * uCloud * (1.0 - uDeck);
  }
  // A closed deck hides the sun: soft, nearly shadowless light from the whole sky.
  float sun = 0.95 * (1.0 - 0.35 * uWet) * (1.0 - 0.6 * shadow) * (1.0 - 0.82 * uDeck * (1.0 - .45 * uSnow));
  vec3 lit = col * ((0.42 + 0.12 * uWet + 0.34 * uDeck) * hemi + sun * diff);
  if (uHD > .5) {
    float visibility = terrainSunVisibility(vWorld, uSunDir);
    vec3 skyLight = mix(vec3(.32, .39, .47), vec3(.50, .53, .56), uDeck) * (.78 + .22 * lightNormal.y) * mix(.62, 1.0, material.ao);
    vec3 direct = mix(vec3(1.10, 1.01, .87), vec3(1.25, .76, .44), uDusk) * sun * diff * visibility;
    vec3 halfVector = normalize(uSunDir + normalize(uEye - vWorld));
    float rough = clamp(material.roughness * (1.0 - .32 * uWet), .18, 1.0);
    float spec = pow(max(0.0, dot(lightNormal, halfVector)), mix(72.0, 8.0, rough)) * (.018 + .08 * uWet);
    lit = col * (skyLight + direct) + spec * sun * visibility;
    lit = pow(lit / (vec3(1.0) + lit * .38), vec3(1.0 / 2.2));
  } else lit *= mix(vec3(1.0), vec3(1.14, .9, .71), uDusk);

  // Wet ground reflects the sky at grazing angles.
  float graze = pow(1.0 - max(dot(n, normalize(uEye - vWorld)), 0.0), 4.0);
  lit = mix(lit, uFogColor, graze * uWet * .28);
  float fog = 1.0 - exp(-pow(d * uFogDensity, 1.35));
  vec3 outCol = mix(lit, uFogColor, clamp(fog, 0.0, 1.0));
  // Valley mist: pools in low ground and thins with height, so ridges and the skyline stay sharp.
  float above = max(0.0, vWorld.y - uHeightRange.x);
  float mistDepth = 8.0 + .45 * (uHeightRange.y - uHeightRange.x);
  float mist = uMist * (exp(-above / mistDepth) * .9 + .12) * (1.0 - exp(-d / 260.0));
  outCol = mix(outCol, mix(uFogColor, vec3(.84, .86, .87), .5), clamp(mist, 0.0, .88));
  gl_FragColor = vec4(outCol, 1.0);
}`;

const SKY_VERT = `
attribute vec2 aPos;
varying vec2 vNdc;
void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.999, 1.0); }`;

const SKY_FRAG = `
precision highp float;
varying vec2 vNdc;
uniform float uPitch;
uniform float uTanHalfV;
uniform float uTanHalfH;
uniform float uHeading;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform float uTime;
uniform float uCloud;
uniform vec2 uWind;
uniform float uWet;
uniform float uNature, uBirdHeading;
uniform float uSolar;
uniform vec3 uSolarSun;
uniform vec3 uSunDir;                       // world (x east, y up, z = -north)
uniform float uDeck, uDeckTone, uDusk, uFog, uStorm;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
float fbm4(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.07; a *= 0.5; }
  return s;
}

void main() {
  vec3 fwd = vec3(sin(uHeading) * cos(uPitch), sin(uPitch), -cos(uHeading) * cos(uPitch));
  vec3 right = vec3(cos(uHeading), 0.0, sin(uHeading));
  vec3 up = vec3(-sin(uHeading) * sin(uPitch), cos(uPitch), cos(uHeading) * sin(uPitch));
  vec3 ray = normalize(fwd + right * vNdc.x * uTanHalfH + up * vNdc.y * uTanHalfV);
  float elev = uPitch + atan(vNdc.y * uTanHalfV);
  if (uSolar > .5) elev = asin(clamp(ray.y, -1.0, 1.0));
  float t = smoothstep(-0.02, 0.6, elev);
  vec3 c = mix(uHorizon, uZenith, pow(t, 0.65));
  vec3 sunDir = normalize(uSunDir);
  float sunDot = max(dot(ray, sunDir), 0.0);
  vec3 sunCol = mix(vec3(1.0, .96, .88), vec3(1.0, .62, .32), uDusk);
  float open = 1.0 - uDeck;
  // Forward scattering towards the sun, and a pale band of haze just above the horizon.
  c += sunCol * (pow(sunDot, 3.0) * (.08 + .14 * uDusk) + pow(sunDot, 24.0) * .16) * open;
  c = mix(c, mix(uHorizon, vec3(.86, .88, .9), .3 * open), exp(-max(elev, 0.0) * 16.0) * .45);
  float az = uHeading + atan(vNdc.x * uTanHalfH);
  vec2 dir = vec2(sin(az), cos(az));
  float dist = 1.0 / max(sin(max(elev, 0.0)), 0.025);   // distance along the cloud layer, in deck heights
  vec2 drift = uWind * uTime * 0.012;
  float farFade = exp(-dist * 0.035);
  if (uCloud > 0.0 && elev > 0.0) {
    // Cumulus: domain-warped noise gives rounded, clumped shapes instead of streaks.
    vec2 p = dir * dist * 0.8 - drift;
    vec2 w = vec2(fbm4(p * .5 + 3.1), fbm4(p * .5 - 1.7));
    float n = fbm(p + w * .8);
    float cover = smoothstep(0.6 - 0.3 * uCloud, 0.72 - 0.24 * uCloud, n);
    // Self-shadowing: where the cloud is denser towards the sun, this side is in shade.
    vec2 sd = normalize(vec2(sunDir.x, -sunDir.z) + vec2(1e-4));
    float n2 = fbm(p + w * .8 + sd * 0.3);
    float lit = clamp(0.58 + (n - n2) * 3.6, 0.0, 1.0);
    float thick = smoothstep(.55, 1.0, n);
    vec3 shade = mix(vec3(.52, .56, .62), vec3(.34, .37, .42), clamp(uWet + uStorm * .5, 0.0, 1.0));
    vec3 bright = mix(vec3(.98, .98, .97), sunCol, .3 + .45 * uDusk) * (1.0 - .3 * uWet);
    vec3 cloudCol = mix(shade, bright, lit * (1.0 - .4 * thick));
    cloudCol = mix(c, cloudCol, farFade * .85 + .15);   // distant clouds dissolve into the haze
    c = mix(c, cloudCol, cover * smoothstep(0.0, 0.05, elev) * .97);
  }
  if (uDeck > 0.0) {
    // Stratus deck: a closed, softly modulated layer with darker rolls in rain.
    vec2 q = dir * dist * 0.5 - drift * .5;
    float s = fbm(q);
    float rolls = fbm4(q * vec2(3.2, 1.4) + 7.0);
    float tone = uDeckTone * (0.74 + 0.42 * s - (0.10 + 0.18 * clamp(uWet + uStorm, 0.0, 1.0)) * rolls);
    vec3 deck = vec3(tone) * vec3(.97, 1.0, 1.04);
    deck = mix(deck, uHorizon, 1.0 - exp(-dist * .05));
    // Rain curtains hanging from the deck near the horizon.
    float shaft = smoothstep(.42, .78, fbm4(vec2(az * 9.0 + uTime * .01, .5))) * (1.0 - smoothstep(0.0, 0.10, elev));
    deck = mix(deck, deck * .8, shaft * clamp(uWet - .3, 0.0, 1.0) * .9);
    c = mix(c, deck, uDeck * smoothstep(-0.01, 0.03, elev));
  }
  if (uSolar > .5 && elev > 0.0) {
    float angle = acos(clamp(dot(ray, normalize(uSolarSun)), -1.0, 1.0));
    float disk = 1.0 - smoothstep(.007, .009, angle);
    float halo = exp(-angle * angle / .0018) * .26;
    c += vec3(1.0, .76, .42) * halo;
    c = mix(c, vec3(1.0, .95, .76), disk);
  }
  // A small flock in the world sky, never over the ground or map.
  if (uNature > 0.0 && elev > .03) {
    for (int i = 0; i < 8; i++) {
      float fi = float(i);
      if (fi >= uNature) continue;
      float birdAz = uBirdHeading - .12 + fi * .027 + uTime * .006;
      float dx = atan(sin(az - birdAz), cos(az - birdAz));
      float dy = elev - (.20 + fi * .012 + sin(uTime * .45 + fi) * .008);
      float wing = abs(dx) * (.4 + .45 * sin(uTime * 5.0 + fi));
      float bird = (1.0 - smoothstep(.0012, .0028, abs(dy - wing))) * (1.0 - smoothstep(.006, .009, abs(dx)));
      c = mix(c, vec3(.17, .2, .22), bird * .6);
    }
  }
  c = mix(c, uHorizon, uFog * .5);   // fog washes the sky out
  gl_FragColor = vec4(c, 1.0);
}`;

// One precipitation layer for both live play and exports. Far, middle and near
// particles fall at different speeds, with camera-relative wind and soft edges.
const WEATHER_FRAG = `
precision highp float;
varying vec2 vNdc;
uniform vec2 uResolution;
uniform float uTime, uRain, uSnow, uAcross, uGust;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 uv = vNdc * .5 + .5;
  vec2 screen = vec2(uv.x * uResolution.x / uResolution.y, uv.y);
  float rain = 0.0, snow = 0.0;
  for (int i = 0; i < 4; i++) {
    float layer = float(i);                          // 0 = far, 3 = near
    // Rain: far drops are fine and dense, near ones longer (motion blur), wider and faster; all lean with the wind.
    float scale = 46.0 - layer * 9.0;
    float speed = 1.6 + layer * .9;
    float slant = clamp(uAcross * (.018 + layer * .012) * uGust, -.6, .6);
    vec2 p = vec2(screen.x + screen.y * slant + layer * .37, screen.y + uTime * speed);
    vec2 id = floor(p * vec2(scale, scale * .35));
    vec2 cell = fract(p * vec2(scale, scale * .35));
    float seed = hash(id + layer * 73.0);
    float cx = .15 + .7 * hash(id + 11.7);
    float len = .25 + .08 * layer;
    float cy = .05 + (.9 - len) * hash(id + 29.3);
    float w = .010 + .009 * layer;
    float streak = (1.0 - smoothstep(w * .35, w, abs(cell.x - cx)))
                 * smoothstep(cy, cy + .06, cell.y) * (1.0 - smoothstep(cy + len - .1, cy + len, cell.y));
    rain += streak * step(seed, uRain * (.30 + .08 * (3.0 - layer))) * (.07 + .05 * layer);

    // Snow: soft flakes, larger and faster when near, swaying as they fall.
    float sscale = 30.0 - layer * 5.5;
    vec2 sp = screen;
    sp.x -= uAcross * uTime * (.008 + layer * .006);
    sp.x += sin(uTime * (.5 + layer * .15) + screen.y * 5.0 + layer * 1.7) * (.012 + layer * .006);
    sp.y += uTime * (.06 + layer * .05);
    vec2 sid = floor(sp * sscale), sc = fract(sp * sscale);
    vec2 center = vec2(.25 + .5 * hash(sid + 13.0), .25 + .5 * hash(sid + 31.0));
    float radius = (.025 + .03 * hash(sid + 17.0)) * (.6 + layer * .25);
    float soft = .02 + layer * .03;
    snow += (1.0 - smoothstep(radius - soft, radius + soft, length(sc - center)))
          * step(hash(sid + layer * 57.0), .22 * uSnow) * (.22 + .12 * layer);
  }
  float veil = uRain * .05;                          // rain softens contrast a little
  float alpha = clamp(rain + snow + veil, 0.0, .7);
  gl_FragColor = vec4(mix(vec3(.80, .84, .88), vec3(.96, .97, 1.0), min(1.0, snow * 3.0)), alpha);
}`;

/** [near, far] view-depth ranges, drawn in order (see render()). */
const RANGES = [[250, 16000], [1.5, 260]];

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function perspective(vfov, aspect, near, far) {
  const f = 1 / Math.tan(vfov / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function lookDir(eye, fwd) {
  const up = [0, 1, 0];
  const z = [-fwd[0], -fwd[1], -fwd[2]];
  let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
  const xl = Math.hypot(...x); x = x.map((v) => v / xl);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const dot = (a) => a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x), -dot(y), -dot(z), 1]);
}

function materialProgram(gl) {
  const modern = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  if (modern) {
    const vs = '#version 300 es\n' + VERT.replace(/attribute/g, 'in').replace(/varying/g, 'out');
    const fs = '#version 300 es\n#define MATERIAL_GRADIENTS\n#define MATERIAL_GRAD textureGrad\n'
      + FRAG.replace('precision highp float;', 'precision highp float;\nout vec4 fragColor;')
        .replace(/varying/g, 'in').replace(/texture2D/g, 'texture').replace(/gl_FragColor/g, 'fragColor');
    return program(gl, vs, fs);
  }
  const gradients = gl.getExtension('EXT_shader_texture_lod') && gl.getExtension('OES_standard_derivatives');
  const prefix = gradients ? '#extension GL_EXT_shader_texture_lod : enable\n#extension GL_OES_standard_derivatives : enable\n#define MATERIAL_GRADIENTS\n#define MATERIAL_GRAD texture2DGradEXT\n' : '';
  return program(gl, VERT, prefix + FRAG);
}

export class TerrainRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    // Stencil marks rendered terrain so decorative plants can never cut into the sky.
    const opts = { antialias: true, preserveDrawingBuffer: true, depth: true, stencil: true };
    const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    this.uint32 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? true : !!gl.getExtension('OES_element_index_uint');
    this.prog = materialProgram(gl);
    this.sky = program(gl, SKY_VERT, SKY_FRAG);
    this.personProg = program(gl, PERSON_VERT, PERSON_FRAG);
    this.weatherProg = program(gl, SKY_VERT, WEATHER_FRAG);
    this.natureProg = program(gl, NATURE_VERT, NATURE_FRAG);
    // Complete placeholder shared by disabled material samplers.
    this.placeholder = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.placeholder);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.personBuf = gl.createBuffer();
    this.skyBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.meshes = [];
  }

  setViewmodel(settings = null) {
    this.viewmodelEnabled = !!settings;
    if (!settings) return;
    if (!this.viewmodel) this.viewmodel = new KnifeViewModel(this.gl, () => {
      if (this.viewmodelEnabled && this.lastFrame && !this.lastFrame.options.motion.clockRunning) {
        this.render(this.lastFrame.camera, this.lastFrame.options);
      }
    });
    this.viewmodel.setOptions(settings);
  }

  async prepareViewmodel(time, motion = {}) {
    if (this.viewmodelEnabled) await this.viewmodel.prepare(time, motion);
  }

  async prepareWatch() {
    if (!this.watchViewmodel) this.watchViewmodel = new WatchViewModel(this.gl, () => {
      if (this.lastFrame?.options.watch) this.render(this.lastFrame.camera, this.lastFrame.options);
    });
    await this.watchViewmodel.ready;
  }

  setPerson(person = null) {
    if (person?.skin === 'conquest' && !this.friendSprite) this.friendSprite = new FriendSprite(this.gl, () => {
      if (this.lastFrame) this.render(this.lastFrame.camera, this.lastFrame.options);
    });
    if (person && this.person && ['x', 'y', 'z', 'height', 'heading', 'pitch', 'pose', 'skin'].every(k => person[k] === this.person[k])) return;
    this.person = person;
    if (!person) { this.personCount = 0; return; }
    this.personPose = null;
    this.updatePersonMotion();
  }

  updatePersonMotion({ wave = 0, time = 0 } = {}) {
    if (!this.person) return;
    wave = Number.isFinite(wave) ? Math.max(0, Math.min(1, wave)) : 0;
    time = wave && Number.isFinite(time) ? time : 0;
    if (this.personPose?.wave === wave && this.personPose.time === time) return;
    const vertices = personVertices(this.person, { wave, time }), gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.personBuf);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    this.personCount = vertices.length / 9;
    this.personPose = { wave, time };
  }

  drawPerson(projection, view, eye, sun, horizon, fogDensity, camera) {
    if (this.person?.skin === 'conquest' && this.personMotion?.sprite && this.friendSprite?.loaded) {
      this.friendSprite.render(this.person, this.personMotion, projection, view, camera, eye, horizon, fogDensity);
      return;
    }
    if (!this.personCount) return;
    const gl = this.gl, p = this.personProg;
    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uProj'), false, projection);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uView'), false, view);
    gl.uniform3fv(gl.getUniformLocation(p, 'uEye'), eye);
    gl.uniform3fv(gl.getUniformLocation(p, 'uSunDir'), sun);
    gl.uniform3fv(gl.getUniformLocation(p, 'uFogColor'), horizon);
    gl.uniform1f(gl.getUniformLocation(p, 'uFogDensity'), fogDensity);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.personBuf);
    const attrs = ['aPos', 'aNormal', 'aColor'].map((name) => gl.getAttribLocation(p, name));
    attrs.forEach((a, i) => { gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 36, i * 12); });
    // Bodies use the same depth buffer and projection as the terrain in BOTH
    // passes, so a near ridge can cover a more distant friend correctly.
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES, 0, this.personCount);
    gl.enable(gl.CULL_FACE);
    attrs.forEach((a) => gl.disableVertexAttribArray(a));
  }

  /** @param {import('../engine/terrainModel.js').TerrainModel} model */
  setTerrain(model, { seed = model.seed, world = model.meta?.world || 'classic' } = {}) {
    const gl = this.gl;
    if (this.natureMeshes) for (const mesh of Object.values(this.natureMeshes)) gl.deleteBuffer(mesh.buffer);
    this.natureMeshes = null;
    if (this.groundCover) gl.deleteBuffer(this.groundCover.buffer);
    this.groundCover = null;
    if (this.heightTexture) gl.deleteTexture(this.heightTexture);
    this.heightTexture = null;
    for (const m of this.meshes) { gl.deleteBuffer(m.vbo); gl.deleteBuffer(m.ibo); }
    this.model = model;
    this.textureSeed = seed;
    this.textureWorld = world;
    this.textureMode = null;
    const L = model.size, n = model.n;
    const main = [];
    for (let j = 0; j < n; j++) main.push(j * model.cell);
    this.meshes = [this.buildMesh(main, main, null, 0)];

    // Coarse skirt around the map (the model's outer lowland), overlapping the
    // map edge slightly and sunk a little so the full-resolution mesh wins.
    const stride = 8;
    const out = [6500, 4200, 2800, 1900, 1300, 900, 620, 420, 280, 180, 100, 45];
    const inner = [];
    for (let j = 0; j < n; j += stride) inner.push(j * model.cell);
    if (inner[inner.length - 1] < L) inner.push(L);
    const axis = [...out.map((d) => -d), ...inner, ...out.slice().reverse().map((d) => L + d)];
    const s = stride * model.cell;
    this.meshes.push(this.buildMesh(axis, axis, (x0, y0, x1, y1) => x0 >= s && y0 >= s && x1 <= L - s && y1 <= L - s, 0.6));
  }

  prepareEnvironment(environment, camera = null) {
    const gl = this.gl;
    const redraw = () => { if (this.lastFrame && !this.disposed) this.render(this.lastFrame.camera, this.lastFrame.options); };
    if (environment.hd && !this.surfaceTextures) this.surfaceTextures = new EnvironmentTextures(gl, {
      albedo: 'surface-albedo-roughness.webp', normal: 'surface-normal-ao.webp',
    }, redraw);
    if (environment.hd && !this.heightTexture) {
      this.heightTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, terrainHeightPixels(this.model));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    if ((environment.foliage || environment.nature) && !this.plantTextures)
      this.plantTextures = new EnvironmentTextures(gl, { foliage: 'foliage-atlas.webp' }, redraw);
    const densities = { foliage: densityProfile(environment.foliageDensity).id, nature: densityProfile(environment.natureDensity).id };
    const changed = ['foliage', 'nature'].filter(key => environment[key] && this.natureMeshes?.[key]?.density !== densities[key]);
    if (changed.length) {
      const data = buildNatureMeshes(this.model, { foliageDensity: densities.foliage, natureDensity: densities.nature });
      this.natureMeshes ||= {};
      for (const key of changed) {
        const buffer = this.natureMeshes[key]?.buffer || gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data[key], gl.STATIC_DRAW);
        this.natureMeshes[key] = { buffer, count: data[key].length / NATURE_STRIDE, density: densities[key] };
      }
    }
    if (environment.foliage && camera) {
      const key = `${Math.floor(camera.x / 16)}:${Math.floor(camera.y / 16)}:${densities.foliage}`;
      if (key !== this.groundCover?.key) {
        const data = buildGroundCover(this.model, camera, 85, densities.foliage);
        const buffer = this.groundCover?.buffer || gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.DYNAMIC_DRAW);
        this.groundCover = { buffer, count: data.vertices.length / NATURE_STRIDE, key };
      }
    }
  }

  async prepareEnvironmentReady(environment) {
    this.prepareEnvironment(environment);
    await Promise.all([environment.hd ? this.surfaceTextures?.ready : null,
      environment.foliage || environment.nature ? this.plantTextures?.ready : null]);
  }

  drawNature(projection, view, eye, sun, horizon, fogDensity, environment, weather, time, gust) {
    if (!this.natureMeshes || (!environment.foliage && !environment.nature) || !this.plantTextures?.loaded) return;
    const gl = this.gl, p = this.natureProg;
    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uProj'), false, projection);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uView'), false, view);
    for (const [key, value] of Object.entries({ uEye: eye, uSunDir: sun, uFogColor: horizon,
      uFriend: this.person ? [this.person.x, -this.person.y, 1] : [0, 0, 0] })) gl.uniform3fv(gl.getUniformLocation(p, key), value);
    for (const [key, value] of Object.entries({ uFogDensity: fogDensity, uTime: time, uGust: gust,
      uWet: weather.wet || 0, uSnow: weather.snow || 0, uDusk: weather.dusk || 0,
      uHD: environment.hd && this.surfaceTextures?.loaded ? 1 : 0 })) gl.uniform1f(gl.getUniformLocation(p, key), value);
    gl.uniform2fv(gl.getUniformLocation(p, 'uWind'), weather.wind || [0, 0]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.plantTextures.textures.foliage);
    gl.uniform1i(gl.getUniformLocation(p, 'uFoliage'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.surfaceTextures?.textures.albedo || this.placeholder);
    gl.uniform1i(gl.getUniformLocation(p, 'uSurface'), 1);
    const names = ['aPos', 'aNormal', 'aColor', 'aRoot', 'aSway', 'aUV', 'aKind'];
    const sizes = [3, 3, 3, 3, 1, 2, 1], offsets = [0, 3, 6, 9, 12, 13, 15];
    const attrs = names.map(name => gl.getAttribLocation(p, name));
    gl.disable(gl.CULL_FACE);
    const meshes = ['foliage', 'nature'].filter(key => environment[key]).map(key => this.natureMeshes[key]);
    if (environment.foliage && this.groundCover) meshes.push(this.groundCover);
    for (const mesh of meshes) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
      attrs.forEach((a, i) => { gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, sizes[i], gl.FLOAT, false, NATURE_STRIDE * 4, offsets[i] * 4); });
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    }
    attrs.forEach(a => gl.disableVertexAttribArray(a)); gl.enable(gl.CULL_FACE);
  }

  dispose() {
    this.disposed = true; this.lastFrame = null;
    this.surfaceTextures?.dispose(); this.plantTextures?.dispose();
    this.viewmodel?.dispose(); this.friendSprite?.dispose(); this.watchViewmodel?.dispose(); this.rifleViewmodel?.dispose();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  drawWeather(weather, camera, time, gust) {
    const rain = weather.precipitation ?? (weather.rain ? .72 : 0), snow = weather.snow || 0;
    if (!rain && !snow) return;
    const gl = this.gl, p = this.weatherProg;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.useProgram(p); gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    const a = gl.getAttribLocation(p, 'aPos'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(gl.getUniformLocation(p, 'uResolution'), this.canvas.width, this.canvas.height);
    const hd = camera.heading * Math.PI / 180, wind = weather.wind || [0, 0];
    const across = wind[0] * Math.cos(hd) - wind[1] * Math.sin(hd);
    for (const [key, value] of Object.entries({ uTime: time, uRain: rain, uSnow: snow, uAcross: across, uGust: gust })) gl.uniform1f(gl.getUniformLocation(p, key), value);
    gl.drawArrays(gl.TRIANGLES, 0, 3); gl.disableVertexAttribArray(a); gl.disable(gl.BLEND);
  }

  buildMesh(xs, ys, skipQuad, sink) {
    const gl = this.gl, m = this.model;
    const nx = xs.length, ny = ys.length;
    const pos = new Float32Array(nx * ny * 3), nor = new Float32Array(nx * ny * 3);
    const e = m.cell;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = xs[i], y = ys[j];
        const inside = m.inside(x, y);
        const k = (j * nx + i) * 3;
        const step = inside ? e : Math.max(e, 0.5 * Math.min(Math.abs(xs[Math.min(i + 1, nx - 1)] - x) || e, Math.abs(ys[Math.min(j + 1, ny - 1)] - y) || e));
        pos[k] = x; pos[k + 1] = m.getElevation(x, y) - (inside ? sink : 0); pos[k + 2] = -y;
        const gx = (m.getElevation(x + step, y) - m.getElevation(x - step, y)) / (2 * step);
        const gy = (m.getElevation(x, y + step) - m.getElevation(x, y - step)) / (2 * step);
        // Normal of y = h(x, z') with z' = -north: (-dh/dx, 1, dh/dnorth)
        const l = Math.hypot(gx, 1, gy);
        nor[k] = -gx / l; nor[k + 1] = 1 / l; nor[k + 2] = gy / l;
      }
    }
    const idx = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        if (skipQuad && skipQuad(xs[i], ys[j], xs[i + 1], ys[j + 1])) continue;
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx.push(a, b, c, b, d, c); // counter-clockwise seen from above
      }
    }
    const interleaved = new Float32Array(nx * ny * 6);
    for (let v = 0; v < nx * ny; v++) {
      interleaved.set(pos.subarray(v * 3, v * 3 + 3), v * 6);
      interleaved.set(nor.subarray(v * 3, v * 3 + 3), v * 6 + 3);
    }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    const big = nx * ny > 65535;
    if (big && !this.uint32) throw new Error('32-bit indices not supported');
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, big ? new Uint32Array(idx) : new Uint16Array(idx), gl.STATIC_DRAW);
    return { vbo, ibo, count: idx.length, type: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }

  /** Render at a fixed pixel size instead of the canvas's CSS size (exports). */
  setFixedSize(width, height) {
    this.fixedSize = width && height ? { width, height } : null;
  }

  resize() {
    if (this.fixedSize) {
      const { width, height } = this.fixedSize;
      if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  /**
   * camera: { x, y, z (eye elevation), heading, fov (horizontal), pitch } in metres / degrees.
   * weather: { cloud, wind [east, north] m/s, wet, fog, precipitation, snow, dusk }.
   * environment: optional hd / foliage / nature flags; environmentTime in seconds.
   * Weather is purely visual: it never changes the terrain geometry.
   */
  render(camera, { weather = {}, environment = {}, time = 0, environmentTime = time, motion = {}, personMotion = {}, sunHeading = camera.heading, solar = null, watch = null, rifle = null, fogDistance = 0 } = {}) {
    if (!this.model) return;
    const textureMode = normaliseTextureMode(environment.texture);
    if (textureMode !== this.textureMode) {
      this.textureMode = textureMode;
      this.terrainTexture = terrainTexture(this.textureSeed, textureMode, this.textureWorld);
    }
    this.lastFrame = { camera, options: { weather, environment, time, environmentTime, motion, personMotion, sunHeading, solar, watch } };
    this.prepareEnvironment(environment, camera);
    this.personMotion = personMotion;
    this.updatePersonMotion({ wave: personMotion.wave, time });
    this.resize();
    const gl = this.gl, m = this.model;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    const aspect = W / H;
    const hf = (camera.fov * Math.PI) / 180;
    const vfov = 2 * Math.atan(Math.tan(hf / 2) / aspect);
    const hd = (camera.heading * Math.PI) / 180, pt = (camera.pitch * Math.PI) / 180;
    const eye = [camera.x, camera.z, -camera.y];
    const fwd = [Math.sin(hd) * Math.cos(pt), Math.sin(pt), -Math.cos(hd) * Math.cos(pt)];
    const { cloud = 0, wind = [0, 0], wet = 0, fog = 0 } = weather;
    const { snow = 0, dusk = 0, deck = 0, mist = 0 } = weather;
    const deckTone = weather.deckTone ?? .7;
    const gust = weather.gusts ? windGust(environmentTime, Math.hypot(...wind) > 5) : 1;
    const grey = [0.52, 0.55, 0.58];
    const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    let horizon = [0.56, 0.64, 0.73], zenith = [0.25, 0.41, 0.63];
    const overcast = Math.max(deck * 0.85, wet * 0.9, cloud * 0.35);
    horizon = mixc(horizon, grey, overcast); zenith = mixc(zenith, [0.38, 0.42, 0.46], overcast);
    if (fog > 0) { horizon = mixc(horizon, [0.66, 0.69, 0.71], fog); zenith = mixc(zenith, [0.55, 0.59, 0.62], fog * 0.8); }
    if (dusk) { horizon = mixc(horizon, [.78, .53, .34], dusk * .8); zenith = mixc(zenith, [.29, .34, .47], dusk); }
    if (fogDistance) { horizon = [0.68, 0.7, 0.71]; zenith = [0.62, 0.65, 0.67]; } // milky whiteout
    if (weather.storm) { horizon = mixc(horizon, [.31, .36, .4], .6); zenith = mixc(zenith, [.23, .28, .33], .65); }

    // Low sun from the side of the view direction: cross-lighting reveals slopes.
    const sunAz = ((sunHeading + 125) * Math.PI) / 180, sunEl = ((27 - dusk * 17) * Math.PI) / 180;
    const sun = solar?.direction || [Math.sin(sunAz) * Math.cos(sunEl), Math.sin(sunEl), -Math.cos(sunAz) * Math.cos(sunEl)];

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.sky);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    const sp = gl.getAttribLocation(this.sky, 'aPos');
    gl.enableVertexAttribArray(sp);
    gl.vertexAttribPointer(sp, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uPitch'), pt);
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uTanHalfV'), Math.tan(vfov / 2));
    gl.uniform3fv(gl.getUniformLocation(this.sky, 'uHorizon'), horizon);
    gl.uniform3fv(gl.getUniformLocation(this.sky, 'uZenith'), zenith);
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uTanHalfH'), Math.tan(hf / 2));
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uHeading'), hd);
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uTime'), environmentTime);
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uCloud'), Math.max(cloud, wet * 0.9));
    gl.uniform2fv(gl.getUniformLocation(this.sky, 'uWind'), weather.cloudWind || wind);
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uWet'), wet);
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uNature'), environment.nature ? densityProfile(environment.natureDensity).birds : 0);
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uBirdHeading'), (weather.skyHeading ?? sunHeading) * Math.PI / 180);
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uSolar'), solar ? 1 : 0);
    gl.uniform3fv(gl.getUniformLocation(this.sky, 'uSolarSun'), solar?.direction || [0, 1, 0]);
    gl.uniform3fv(gl.getUniformLocation(this.sky, 'uSunDir'), sun);
    for (const [key, value] of Object.entries({ uDeck: fogDistance ? 0 : deck, uDeckTone: deckTone, uDusk: dusk, uFog: fogDistance ? 1 : fog, uStorm: weather.storm ? 1 : 0 }))
      gl.uniform1f(gl.getUniformLocation(this.sky, key), value);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(sp);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    const p = this.prog;
    gl.useProgram(p);
    const view = lookDir(eye, fwd);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uView'), false, view);
    gl.uniform3fv(gl.getUniformLocation(p, 'uEye'), eye);
    gl.uniform3fv(gl.getUniformLocation(p, 'uSunDir'), sun);
    gl.uniform2fv(gl.getUniformLocation(p, 'uHeightRange'), [m.min, m.max]);
    gl.uniform3fv(gl.getUniformLocation(p, 'uFogColor'), horizon);
    // Fog shortens visibility to ~1.5 km but keeps the near and middle distance readable.
    // fogDistance (fog navigation) forces a whiteout: ~63% fog at that range, nearly opaque at twice it.
    // Daily weather fog: environment.js hazeDistance(), shared with visibilityFactor() so tools can keep clues in sight.
    const fogDensity = fogDistance ? 1 / fogDistance : 1 / hazeDistance(weather);
    gl.uniform1f(gl.getUniformLocation(p, 'uFogDensity'), fogDensity);
    gl.uniform1f(gl.getUniformLocation(p, 'uTime'), environmentTime);
    gl.uniform1f(gl.getUniformLocation(p, 'uCloud'), Math.max(cloud, wet * 0.6));
    gl.uniform2fv(gl.getUniformLocation(p, 'uWind'), wind);
    gl.uniform2fv(gl.getUniformLocation(p, 'uCloudWind'), weather.cloudWind || wind);
    gl.uniform1f(gl.getUniformLocation(p, 'uWet'), wet);
    gl.uniform1f(gl.getUniformLocation(p, 'uHD'), environment.hd && this.surfaceTextures?.loaded ? 1 : 0);
    const texture = this.terrainTexture;
    for (const [uniform, key] of [['uGrassLow', 'low'], ['uGrassHigh', 'high'], ['uDry', 'dry'], ['uRock', 'rock']])
      gl.uniform3fv(gl.getUniformLocation(p, uniform), texture[key]);
    gl.uniform4fv(gl.getUniformLocation(p, 'uTextureMix'), texture.mix);
    gl.uniform2fv(gl.getUniformLocation(p, 'uTextureOffset'), texture.offset);
    gl.uniform1f(gl.getUniformLocation(p, 'uTextureScale'), texture.scale);
    gl.uniform1f(gl.getUniformLocation(p, 'uMapSize'), m.size);
    gl.uniform1f(gl.getUniformLocation(p, 'uSnow'), snow);
    gl.uniform1f(gl.getUniformLocation(p, 'uDusk'), dusk);
    gl.uniform1f(gl.getUniformLocation(p, 'uDeck'), fogDistance ? 0 : deck);
    gl.uniform1f(gl.getUniformLocation(p, 'uMist'), fogDistance ? 0 : mist);
    gl.uniform1f(gl.getUniformLocation(p, 'uGust'), gust);
    gl.uniform1i(gl.getUniformLocation(p, 'uAlbedo'), 0);
    gl.uniform1i(gl.getUniformLocation(p, 'uNormalMap'), 1);
    gl.uniform1i(gl.getUniformLocation(p, 'uTerrainHeight'), 2);
    const aPos = gl.getAttribLocation(p, 'aPos'), aNor = gl.getAttribLocation(p, 'aNormal');
    const uProj = gl.getUniformLocation(p, 'uProj');
    // Two depth ranges, far first. A single 0.5 m - 16 km frustum needs a
    // 24-bit depth buffer; some mobile GPUs give 16 bits, where the error at
    // 1 km reaches ~30 m and distant ground bleeds through nearer hills (a
    // wrong skyline). Splitting keeps the error below ~1 m even with 16 bits.
    // Anything drawn in the near pass is closer than everything left from the
    // far pass on the same pixel, so clearing depth in between is exact.
    // Terrain writes stencil 1 in both passes; plants draw only over it, so the
    // skyline stays the exact terrain silhouette the quiz and its explanation use.
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    for (const [near, far] of RANGES) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.ALWAYS, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      const projection = perspective(vfov, aspect, near, far);
      gl.useProgram(p);
      // Plants and friend sprites bind textures too: restore all material units in BOTH passes.
      const textures = [this.surfaceTextures?.textures.albedo, this.surfaceTextures?.textures.normal, this.heightTexture];
      textures.forEach((texture, unit) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture || this.placeholder); });
      gl.uniformMatrix4fv(uProj, false, projection);
      for (const mesh of this.meshes) {
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(aNor);
        gl.vertexAttribPointer(aNor, 3, gl.FLOAT, false, 24, 12);
        gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0);
      }
      gl.disableVertexAttribArray(aPos);
      gl.disableVertexAttribArray(aNor);
      gl.stencilFunc(gl.EQUAL, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      this.drawNature(projection, view, eye, sun, horizon, fogDensity, environment, weather, environmentTime, gust);
      gl.disable(gl.STENCIL_TEST);
      this.drawPerson(projection, view, eye, sun, horizon, fogDensity, camera);
    }
    this.drawWeather(weather, camera, environmentTime, gust);
    // Sniper mode: the shooter's own rifle, nearest of all, over the weather.
    if (rifle && rifle.raise < 1) { this.rifleViewmodel ||= new RifleViewModel(gl); this.rifleViewmodel.render(W, H, rifle, horizon); }
    if (watch && this.watchViewmodel) this.watchViewmodel.render(W, H, watch);
    if (this.viewmodelEnabled) this.viewmodel.render(W, H, time, motion);
  }
}
