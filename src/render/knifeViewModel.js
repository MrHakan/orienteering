import { normaliseAppearance, viewmodelMeshes } from './viewmodelMesh.js';

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute float aMetal;
uniform mat4 uModel;
uniform mat4 uProjection;
varying vec3 vPos;
varying vec3 vLocal;
varying vec3 vNormal;
varying vec3 vColor;
varying float vMetal;
void main() {
  vec4 p = uModel * vec4(aPos, 1.0);
  vPos = p.xyz; vLocal = aPos; vNormal = mat3(uModel) * aNormal;
  vColor = aColor; vMetal = aMetal; gl_Position = uProjection * p;
}`;
const FRAG = `
precision highp float;
varying vec3 vPos;
varying vec3 vLocal;
varying vec3 vNormal;
varying vec3 vColor;
varying float vMetal;
void main() {
  vec3 n = normalize(vNormal), light = normalize(vec3(-0.4, 0.7, 0.8));
  vec3 eye = normalize(-vPos), halfDir = normalize(light + eye);
  float diffuse = 0.52 + 0.48 * abs(dot(n, light));
  float grain = sin(vLocal.x * 1500.0) * sin(vLocal.y * 1300.0) * sin(vLocal.z * 1800.0);
  float rough = mix(0.045, 0.012, vMetal);
  float spec = pow(max(0.0, abs(dot(n, halfDir))), mix(12.0, 72.0, vMetal));
  float edge = pow(1.0 - abs(dot(n, eye)), 3.0);
  vec3 col = vColor * diffuse * (1.0 + rough * grain);
  col += vec3(0.92, 0.96, 1.0) * (spec * mix(0.06, 0.65, vMetal) + edge * vMetal * 0.12);
  gl_FragColor = vec4(col, 1.0);
}`;

const ease = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
export function inspectEnvelope(seconds) {
  return seconds < 0 || seconds > 2.8 ? 0 : ease(seconds / .42) * ease((2.8 - seconds) / .5);
}

/** Poses are computed from clip time, so encoder speed cannot change inspect. */
export function viewmodelPose(time, motion = {}, settings = {}) {
  const o = normaliseAppearance(settings), t = Number.isFinite(time) ? time : 0;
  const elapsed = Number.isFinite(motion.inspectElapsed) ? motion.inspectElapsed
    : t >= 7.4 && t <= 10.2 ? t - 7.4 : t - 1.2;
  const inspect = inspectEnvelope(elapsed), phase = Math.max(0, Math.min(1, elapsed / 2.8));
  const bob = Math.sin(t * 9) * .004 * Math.min(1, (motion.speed || 0) / 15);
  const lift = Math.max(-.012, Math.min(.012, (motion.vertical || 0) * -.0015)) - (motion.landing || 0) * .008;
  const mirror = o.handedness === 'left' ? -1 : 1;
  const angle = o.knife === 'karambit' ? Math.PI * 2 * ease(phase) : Math.sin(phase * Math.PI * 2) * .75;
  const right = { position: [(.285 - inspect * .12) * mirror, (o.knife === 'karambit' ? -.22 : -.265) + lift + bob + inspect * .13, -.67 - inspect * .025],
    rotation: [.08 + inspect * .20, inspect * Math.sin(phase * Math.PI) * .9, (o.knife === 'karambit' ? .8 : -.08) + inspect * -.35], mirror };
  return {
    inspect, right,
    left: { position: [-.30 * mirror, -.265 + lift - bob - inspect * .018, -.65],
      rotation: [0, -.18, .12], mirror },
    knife: { ...right, rotation: [right.rotation[0], right.rotation[1], right.rotation[2] + (o.knife === 'karambit' ? angle : inspect * angle)] },
  };
}

export function poseMatrix(pose) {
  const [rx, ry, rz] = pose.rotation, sx = Math.sin(rx), cx = Math.cos(rx), sy = Math.sin(ry), cy = Math.cos(ry), sz = Math.sin(rz), cz = Math.cos(rz);
  const mirror = pose.mirror || 1, [x, y, z] = pose.position;
  return new Float32Array([
    mirror * cy * cz, cy * sz, -sy, 0,
    mirror * (sx * sy * cz - cx * sz), sx * sy * sz + cx * cz, sx * cy, 0,
    mirror * (cx * sy * cz + sx * sz), cx * sy * sz - sx * cz, cx * cy, 0,
    x, y, z, 1,
  ]);
}

function compile(gl, type, source) {
  const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

export class KnifeViewModel {
  constructor(gl) {
    this.gl = gl;
    this.program = gl.createProgram();
    const shaders = [compile(gl, gl.VERTEX_SHADER, VERT), compile(gl, gl.FRAGMENT_SHADER, FRAG)];
    for (const shader of shaders) gl.attachShader(this.program, shader);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    for (const shader of shaders) gl.deleteShader(shader);
    this.buffers = Object.fromEntries(['left', 'right', 'knife'].map((id) => [id, gl.createBuffer()]));
    this.uniforms = Object.fromEntries(['uProjection', 'uModel'].map((id) => [id, gl.getUniformLocation(this.program, id)]));
    this.attributes = ['aPos', 'aNormal', 'aColor', 'aMetal'].map((id) => gl.getAttribLocation(this.program, id));
  }
  setOptions(settings) {
    const options = normaliseAppearance(settings), key = JSON.stringify(options);
    if (key === this.key) return;
    this.key = key; this.options = options; const meshes = viewmodelMeshes(options), gl = this.gl;
    this.counts = {};
    for (const id of Object.keys(this.buffers)) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[id]); gl.bufferData(gl.ARRAY_BUFFER, meshes[id], gl.STATIC_DRAW);
      this.counts[id] = meshes[id].length / 10;
    }
  }
  render(width, height, time, motion = {}) {
    if (!this.options) return;
    const gl = this.gl, aspect = width / height, f = aspect / Math.tan(76 * Math.PI / 360), near = .02, far = 4;
    const projection = new Float32Array([f / aspect,0,0,0,0,f,0,0,0,0,(far+near)/(near-far),-1,0,0,2*far*near/(near-far),0]);
    const pose = viewmodelPose(time, motion, this.options);
    // Viewmodel has its own depth range; nearby terrain cannot slice the hands.
    gl.clear(gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.useProgram(this.program); gl.uniformMatrix4fv(this.uniforms.uProjection, false, projection);
    for (const id of ['left', 'right', 'knife']) {
      gl.uniformMatrix4fv(this.uniforms.uModel, false, poseMatrix(pose[id]));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[id]);
      this.attributes.forEach((a, i) => { gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, i === 3 ? 1 : 3, gl.FLOAT, false, 40, [0,12,24,36][i]); });
      gl.drawArrays(gl.TRIANGLES, 0, this.counts[id]);
    }
    for (const a of this.attributes) gl.disableVertexAttribArray(a);
  }
  dispose() {
    for (const b of Object.values(this.buffers)) this.gl.deleteBuffer(b);
    this.gl.deleteProgram(this.program);
  }
}
