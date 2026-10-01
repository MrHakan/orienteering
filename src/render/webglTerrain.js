// First-person WebGL terrain renderer. It only reads TerrainModel.getElevation,
// so the 3D scene is by construction the same surface the map is drawn from.
//
// GL axes: X = east, Y = up, Z = -north.
import { personVertices } from './personMesh.js';
import { KnifeViewModel } from './knifeViewModel.js';
import { FriendSprite } from './friendSprite.js';
import { windGust } from './environment.js';
import { terrainDetailPixels } from './terrainDetail.js';
import { buildNatureMeshes, NATURE_VERT, NATURE_FRAG } from './natureMesh.js';

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
uniform sampler2D uDetail;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  vec3 n = normalize(vNormal);
  float d = length(vWorld - uEye);
  float h = (vWorld.y - uHeightRange.x) / max(1.0, uHeightRange.y - uHeightRange.x);
  float slope = 1.0 - n.y;

  vec3 grassLow = vec3(0.19, 0.28, 0.11);
  vec3 grassHigh = vec3(0.33, 0.35, 0.16);
  vec3 dry = vec3(0.46, 0.38, 0.21);
  float patchN = vnoise(vWorld.xz / 160.0) - 0.5;
  vec3 col = mix(grassLow, grassHigh, smoothstep(0.1, 0.6, h + patchN * 0.3));
  col = mix(col, dry, smoothstep(0.35, 0.95, h + patchN * 0.2) * 0.85);
  col = mix(col, dry * 0.92, smoothstep(0.1, 0.4, slope) * 0.45);

  float fine = 1.0 - smoothstep(150.0, 900.0, d);
  float tex = (vnoise(vWorld.xz / 5.0) - 0.5) * 0.35 * fine
            + (vnoise(vWorld.xz / 21.0) - 0.5) * 0.3 * (1.0 - smoothstep(400.0, 2000.0, d))
            + (vnoise(vWorld.xz / 75.0) - 0.5) * 0.25;
  col *= 1.0 + tex;
  if (uHD > 0.0) {
    // Real repeating detail texture, mipmapped to avoid distant shimmer.
    vec4 detail = texture2D(uDetail, vWorld.xz / 4.0);
    float close = 1.0 - smoothstep(25.0, 240.0, d);
    col *= mix(vec3(1.0), detail.rgb * 2.0, close * .65);
    float rock = smoothstep(.13, .42, slope) * .7;
    vec3 stone = vec3(.39, .38, .34) * (.8 + .4 * detail.a);
    stone *= .9 + .15 * sin(vWorld.y * 2.3 + vnoise(vWorld.xz / 9.0) * 4.0);
    col = mix(col, stone, rock);
  }
  col = mix(col, vec3(.78, .83, .83), uSnow * smoothstep(.35, .92, n.y) * .72);

  // Wind: bands of bent grass sweeping downwind.
  float windSpeed = length(uWind);
  if (windSpeed > 0.01) {
    vec2 wd = uWind / windSpeed;
    vec2 ground = vec2(vWorld.x, -vWorld.z);
    float phase = dot(ground, wd) / 7.0 - uTime * (1.2 + windSpeed * 0.25) + vnoise(ground / 35.0) * 5.0;
    col *= 1.0 + 0.07 * sin(phase) * min(1.0, windSpeed / 8.0) * uGust * (1.0 - smoothstep(80.0, 700.0, d));
  }
  col *= 1.0 - 0.2 * uWet;

  float diff = max(dot(n, uSunDir), 0.0);
  float hemi = 0.55 + 0.45 * n.y;
  // Moving cloud shadows (and a duller, flatter light under overcast skies).
  float shadow = 0.0;
  if (uCloud > 0.0) {
    vec2 cp = (vec2(vWorld.x, -vWorld.z) - uCloudWind * uTime * 6.0) / 520.0;
    float c = vnoise(cp) * 0.6 + vnoise(cp * 2.3) * 0.3 + vnoise(cp * 5.1) * 0.1;
    shadow = smoothstep(0.62 - 0.35 * uCloud, 0.8 - 0.3 * uCloud, c) * uCloud;
  }
  float sun = 0.95 * (1.0 - 0.35 * uWet) * (1.0 - 0.6 * shadow);
  vec3 lit = col * ((0.42 + 0.12 * uWet) * hemi + sun * diff);
  lit *= mix(vec3(1.0), vec3(1.14, .9, .71), uDusk);

  float fog = 1.0 - exp(-pow(d * uFogDensity, 1.35));
  gl_FragColor = vec4(mix(lit, uFogColor, clamp(fog, 0.0, 1.0)), 1.0);
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

void main() {
  float elev = uPitch + atan(vNdc.y * uTanHalfV);
  float t = smoothstep(-0.02, 0.6, elev);
  vec3 c = mix(uHorizon, uZenith, pow(t, 0.8));
  if (uCloud > 0.0 && elev > 0.0) {
    // Project the view ray onto a cloud deck and scroll it with the wind.
    float az = uHeading + atan(vNdc.x * uTanHalfH);
    vec2 dir = vec2(sin(az), cos(az));
    float dist = 1.0 / max(sin(elev), 0.03);
    vec2 p = dir * dist * 0.9 - uWind * uTime * 0.012;
    float n = fbm(p);
    float cover = smoothstep(0.62 - 0.4 * uCloud, 0.9 - 0.3 * uCloud, n);
    vec3 cloudCol = mix(vec3(0.86, 0.87, 0.88), vec3(0.52, 0.55, 0.58), uWet * 0.8 + 0.25 * (1.0 - n));
    c = mix(c, cloudCol, cover * smoothstep(0.0, 0.08, elev) * 0.95);
  }
  // A small flock in the world sky, never over the ground or map.
  if (uNature > 0.0 && elev > .03) {
    float az = uHeading + atan(vNdc.x * uTanHalfH);
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float birdAz = uBirdHeading - .12 + fi * .027 + uTime * .006;
      float dx = atan(sin(az - birdAz), cos(az - birdAz));
      float dy = elev - (.20 + fi * .012 + sin(uTime * .45 + fi) * .008);
      float wing = abs(dx) * (.4 + .45 * sin(uTime * 5.0 + fi));
      float bird = (1.0 - smoothstep(.0012, .0028, abs(dy - wing))) * (1.0 - smoothstep(.006, .009, abs(dx)));
      c = mix(c, vec3(.17, .2, .22), bird * .6);
    }
  }
  gl_FragColor = vec4(c, 1.0);
}`;

// One precipitation layer for both live play and exports. Far, middle and near
// particles fall at different speeds, with camera-relative wind and soft edges.
const WEATHER_FRAG = `
precision highp float;
varying vec2 vNdc;
uniform vec2 uResolution;
uniform float uTime, uRain, uSnow, uAcross, uGust, uMist;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 uv = vNdc * .5 + .5;
  vec2 screen = vec2(uv.x * uResolution.x / uResolution.y, uv.y);
  float rain = 0.0, snow = 0.0;
  for (int i = 0; i < 3; i++) {
    float layer = float(i), scale = 22.0 + layer * 12.0;
    float speed = .65 + layer * .35;
    float slant = uAcross * .025 * uGust;
    vec2 p = vec2(screen.x + screen.y * slant, screen.y + uTime * speed);
    vec2 id = floor(p * vec2(scale, scale * .6));
    vec2 cell = fract(p * vec2(scale, scale * .6));
    float seed = hash(id + layer * 73.0);
    float cx = .2 + .6 * hash(id + 11.7), cy = .1 + .65 * hash(id + 29.3);
    float streak = (1.0 - smoothstep(.012, .038, abs(cell.x - cx)))
                 * (1.0 - smoothstep(.09, .3, abs(cell.y - cy)));
    rain += streak * step(seed, uRain * .38) * (.16 + .08 * layer);

    vec2 sp = screen;
    sp.x -= uAcross * uTime * .012;
    sp.x += sin(uTime * .65 + screen.y * 5.0 + layer) * .025 * (1.0 + abs(uAcross) * .06);
    sp.y += uTime * (.09 + layer * .075);
    vec2 sid = floor(sp * scale), sc = fract(sp * scale);
    vec2 center = vec2(.25 + .5 * hash(sid + 13.0), .25 + .5 * hash(sid + 31.0));
    float radius = .025 + .045 * hash(sid + 17.0);
    snow += (1.0 - smoothstep(radius, radius + .026, length(sc - center)))
          * step(hash(sid + layer * 57.0), .34 * uSnow) * (.4 + .16 * layer);
  }
  float mist = uMist * .045 * (1.0 - uv.y)
    * (.5 + .5 * sin(screen.x * 4.0 + sin(screen.y * 8.0 + uTime * .13) + uTime * .07));
  float alpha = clamp(rain + snow + mist, 0.0, .75);
  gl_FragColor = vec4(mix(vec3(.73, .8, .85), vec3(.94, .97, 1.0), min(1.0, snow * 3.0)), alpha);
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

export class TerrainRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = { antialias: true, preserveDrawingBuffer: true, depth: true };
    const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    this.uint32 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? true : !!gl.getExtension('OES_element_index_uint');
    this.prog = program(gl, VERT, FRAG);
    this.sky = program(gl, SKY_VERT, SKY_FRAG);
    this.personProg = program(gl, PERSON_VERT, PERSON_FRAG);
    this.weatherProg = program(gl, SKY_VERT, WEATHER_FRAG);
    this.natureProg = program(gl, NATURE_VERT, NATURE_FRAG);
    // Keep the sampler complete even when HD detail is disabled.
    this.detailTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.detailTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 128]));
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

  setPerson(person = null) {
    if (person?.skin === 'conquest' && !this.friendSprite) this.friendSprite = new FriendSprite(this.gl, () => {
      if (this.lastFrame) this.render(this.lastFrame.camera, this.lastFrame.options);
    });
    if (person && this.person && ['x', 'y', 'z', 'height', 'heading', 'skin'].every(k => person[k] === this.person[k])) return;
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
  setTerrain(model) {
    const gl = this.gl;
    if (this.natureMeshes) for (const mesh of Object.values(this.natureMeshes)) gl.deleteBuffer(mesh.buffer);
    this.natureMeshes = null;
    for (const m of this.meshes) { gl.deleteBuffer(m.vbo); gl.deleteBuffer(m.ibo); }
    this.model = model;
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

  prepareEnvironment(environment) {
    const gl = this.gl;
    if (environment.hd && !this.detailReady) {
      gl.bindTexture(gl.TEXTURE_2D, this.detailTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 512, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, terrainDetailPixels());
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.generateMipmap(gl.TEXTURE_2D);
      const ext = gl.getExtension('EXT_texture_filter_anisotropic');
      if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      this.detailReady = true;
    }
    if ((environment.foliage || environment.nature) && !this.natureMeshes) {
      const data = buildNatureMeshes(this.model);
      this.natureMeshes = {};
      for (const key of ['foliage', 'nature']) {
        const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data[key], gl.STATIC_DRAW);
        this.natureMeshes[key] = { buffer, count: data[key].length / 13 };
      }
    }
  }

  drawNature(projection, view, eye, sun, horizon, fogDensity, environment, weather, time, gust) {
    if (!this.natureMeshes || (!environment.foliage && !environment.nature)) return;
    const gl = this.gl, p = this.natureProg;
    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uProj'), false, projection);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uView'), false, view);
    for (const [key, value] of Object.entries({ uEye: eye, uSunDir: sun, uFogColor: horizon })) gl.uniform3fv(gl.getUniformLocation(p, key), value);
    for (const [key, value] of Object.entries({ uFogDensity: fogDensity, uTime: time, uGust: gust,
      uWet: weather.wet || 0, uSnow: weather.snow || 0, uDusk: weather.dusk || 0 })) gl.uniform1f(gl.getUniformLocation(p, key), value);
    gl.uniform2fv(gl.getUniformLocation(p, 'uWind'), weather.wind || [0, 0]);
    const attrs = ['aPos', 'aNormal', 'aColor', 'aRoot', 'aSway'].map(name => gl.getAttribLocation(p, name));
    gl.disable(gl.CULL_FACE);
    for (const key of ['foliage', 'nature']) if (environment[key]) {
      const mesh = this.natureMeshes[key]; gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
      attrs.forEach((a, i) => { gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, i === 4 ? 1 : 3, gl.FLOAT, false, 52, i * 12); });
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    }
    attrs.forEach(a => gl.disableVertexAttribArray(a)); gl.enable(gl.CULL_FACE);
  }

  drawWeather(weather, camera, time, gust) {
    const rain = weather.precipitation ?? (weather.rain ? .72 : 0), snow = weather.snow || 0, mist = weather.fog || 0;
    if (!rain && !snow && !mist) return;
    const gl = this.gl, p = this.weatherProg;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.useProgram(p); gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    const a = gl.getAttribLocation(p, 'aPos'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(gl.getUniformLocation(p, 'uResolution'), this.canvas.width, this.canvas.height);
    const hd = camera.heading * Math.PI / 180, wind = weather.wind || [0, 0];
    const across = wind[0] * Math.cos(hd) - wind[1] * Math.sin(hd);
    for (const [key, value] of Object.entries({ uTime: time, uRain: rain, uSnow: snow, uAcross: across, uGust: gust, uMist: mist })) gl.uniform1f(gl.getUniformLocation(p, key), value);
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
  render(camera, { weather = {}, environment = {}, time = 0, environmentTime = time, motion = {}, personMotion = {}, sunHeading = camera.heading } = {}) {
    if (!this.model) return;
    this.lastFrame = { camera, options: { weather, environment, time, environmentTime, motion, personMotion, sunHeading } };
    this.prepareEnvironment(environment);
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
    const { snow = 0, dusk = 0 } = weather;
    const gust = weather.gusts ? windGust(environmentTime, Math.hypot(...wind) > 5) : 1;
    const grey = [0.52, 0.55, 0.58];
    const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    let horizon = [0.36, 0.43, 0.5], zenith = [0.23, 0.34, 0.47];
    const overcast = Math.max(wet * 0.9, cloud * 0.35);
    horizon = mixc(horizon, grey, overcast); zenith = mixc(zenith, [0.38, 0.42, 0.46], overcast);
    if (fog > 0) { horizon = mixc(horizon, [0.66, 0.69, 0.71], fog); zenith = mixc(zenith, [0.55, 0.59, 0.62], fog * 0.8); }
    if (dusk) { horizon = mixc(horizon, [.78, .53, .34], dusk * .8); zenith = mixc(zenith, [.29, .34, .47], dusk); }
    if (weather.storm) { horizon = mixc(horizon, [.31, .36, .4], .6); zenith = mixc(zenith, [.23, .28, .33], .65); }

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
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uNature'), environment.nature ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.sky, 'uBirdHeading'), (weather.skyHeading ?? sunHeading) * Math.PI / 180);
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
    // Low sun from the side of the view direction: cross-lighting reveals slopes.
    const sunAz = ((sunHeading + 125) * Math.PI) / 180, sunEl = ((27 - dusk * 17) * Math.PI) / 180;
    const sun = [Math.sin(sunAz) * Math.cos(sunEl), Math.sin(sunEl), -Math.cos(sunAz) * Math.cos(sunEl)];
    gl.uniform3fv(gl.getUniformLocation(p, 'uSunDir'), sun);
    gl.uniform2fv(gl.getUniformLocation(p, 'uHeightRange'), [m.min, m.max]);
    gl.uniform3fv(gl.getUniformLocation(p, 'uFogColor'), horizon);
    // Fog shortens visibility to ~1.5 km but keeps the near and middle distance readable.
    const fogDensity = 1 / Math.max(1400, 5200 - 3700 * fog - 1200 * wet);
    gl.uniform1f(gl.getUniformLocation(p, 'uFogDensity'), fogDensity);
    gl.uniform1f(gl.getUniformLocation(p, 'uTime'), environmentTime);
    gl.uniform1f(gl.getUniformLocation(p, 'uCloud'), Math.max(cloud, wet * 0.6));
    gl.uniform2fv(gl.getUniformLocation(p, 'uWind'), wind);
    gl.uniform2fv(gl.getUniformLocation(p, 'uCloudWind'), weather.cloudWind || wind);
    gl.uniform1f(gl.getUniformLocation(p, 'uWet'), wet);
    gl.uniform1f(gl.getUniformLocation(p, 'uHD'), environment.hd ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(p, 'uSnow'), snow);
    gl.uniform1f(gl.getUniformLocation(p, 'uDusk'), dusk);
    gl.uniform1f(gl.getUniformLocation(p, 'uGust'), gust);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.detailTexture || null);
    gl.uniform1i(gl.getUniformLocation(p, 'uDetail'), 0);
    const aPos = gl.getAttribLocation(p, 'aPos'), aNor = gl.getAttribLocation(p, 'aNormal');
    const uProj = gl.getUniformLocation(p, 'uProj');
    // Two depth ranges, far first. A single 0.5 m - 16 km frustum needs a
    // 24-bit depth buffer; some mobile GPUs give 16 bits, where the error at
    // 1 km reaches ~30 m and distant ground bleeds through nearer hills (a
    // wrong skyline). Splitting keeps the error below ~1 m even with 16 bits.
    // Anything drawn in the near pass is closer than everything left from the
    // far pass on the same pixel, so clearing depth in between is exact.
    for (const [near, far] of RANGES) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const projection = perspective(vfov, aspect, near, far);
      gl.useProgram(p);
      // A world-space friend sprite can bind its own texture in the far pass.
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.detailTexture);
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
      this.drawNature(projection, view, eye, sun, horizon, fogDensity, environment, weather, environmentTime, gust);
      this.drawPerson(projection, view, eye, sun, horizon, fogDensity, camera);
    }
    this.drawWeather(weather, camera, environmentTime, gust);
    if (this.viewmodelEnabled) this.viewmodel.render(W, H, time, motion);
  }
}
