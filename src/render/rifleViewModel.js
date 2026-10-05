// First-person rifle for sniper mode: a lofted, lit 3D bolt-action rifle with
// scope, rail, bipod and the shooter's gloved hand, drawn in view space on
// top of the scene while observing (and lowered as the scope comes up).
// Geometry is built once in rifle space; one model matrix places it.

const STRIDE = 10; // position 3, normal 3, colour 3, specular 1

const VERT = `
attribute vec3 aPos; attribute vec3 aNormal; attribute vec3 aColor; attribute float aSpec;
uniform mat4 uProj; uniform mat4 uModel;
varying vec3 vPos; varying vec3 vNormal; varying vec3 vColor; varying float vSpec;
void main() {
  vec4 p = uModel * vec4(aPos, 1.0);
  vPos = p.xyz; vNormal = mat3(uModel) * aNormal; vColor = aColor; vSpec = aSpec;
  gl_Position = uProj * p;
}`;
const FRAG = `
precision highp float;
varying vec3 vPos; varying vec3 vNormal; varying vec3 vColor; varying float vSpec;
uniform vec3 uSky; uniform vec3 uKey; uniform vec3 uKeyColor;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(-vPos);
  if (dot(n, v) < 0.0) n = -n;
  float diffuse = max(0.0, dot(n, uKey));
  float sky = 0.5 + 0.5 * n.y;
  vec3 h = normalize(uKey + v);
  float spec = pow(max(0.0, dot(n, h)), 6.0 + 60.0 * vSpec) * vSpec;
  float rim = pow(1.0 - max(0.0, dot(n, v)), 3.0) * 0.35;
  vec3 col = vColor * (uSky * (0.35 + 0.45 * sky) + uKeyColor * diffuse * 0.95)
    + uKeyColor * spec * 0.9 + uSky * rim * (0.4 + vSpec);
  gl_FragColor = vec4(pow(col, vec3(0.95)), 1.0);
}`;

// ------------------------------------------------------------- geometry

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Rounded rectangle outline (width w, height h, corner radius r), centred. */
function roundRect(w, h, r, steps = 4) {
  const pts = [], cx = w / 2 - r, cy = h / 2 - r;
  for (const [sx, sy, a0] of [[1, 1, 0], [-1, 1, 90], [-1, -1, 180], [1, -1, 270]]) {
    for (let i = 0; i <= steps; i++) {
      const a = (a0 + 90 * i / steps) * Math.PI / 180;
      pts.push([sx * cx + Math.cos(a) * r, sy * cy + Math.sin(a) * r]);
    }
  }
  return pts;
}
const circle = (r, n = 18) => Array.from({ length: n }, (_, i) => [Math.cos(i / n * Math.PI * 2) * r, Math.sin(i / n * Math.PI * 2) * r]);

export function rifleGeometry() {
  const out = [];
  const vertex = (p, n, color, spec) => out.push(...p, ...n, ...color, spec);
  const tri = (a, b, c, color, spec) => {
    const n = norm(cross(sub(b, a), sub(c, a)));
    vertex(a, n, color, spec); vertex(b, n, color, spec); vertex(c, n, color, spec);
  };
  /**
   * Loft closed outlines along an axis from a to b. `sections` are
   * [t (0..1), outline, offsetX, offsetY]; every outline has the same count.
   * Smooth normals around the ring, flat caps.
   */
  const loft = (a, b, sections, color, spec, up = [0, 1, 0]) => {
    const axis = norm(sub(b, a)), side = norm(cross(axis, up)), upv = cross(side, axis);
    const rings = sections.map(([t, outline, ox = 0, oy = 0]) => outline.map(([x, y]) =>
      add(add(add(a, mul(sub(b, a), t)), mul(side, x + ox)), mul(upv, y + oy))));
    const centre = (ring) => mul(ring.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / ring.length);
    const ringNormals = rings.map((ring) => { const c = centre(ring); return ring.map((p) => { const d = sub(p, c); return norm(sub(d, mul(axis, dot(d, axis)))); }); });
    for (let k = 0; k < rings.length - 1; k++) {
      const r0 = rings[k], r1 = rings[k + 1], n0 = ringNormals[k], n1 = ringNormals[k + 1], m = r0.length;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        vertex(r0[i], n0[i], color, spec); vertex(r1[i], n1[i], color, spec); vertex(r1[j], n1[j], color, spec);
        vertex(r0[i], n0[i], color, spec); vertex(r1[j], n1[j], color, spec); vertex(r0[j], n0[j], color, spec);
      }
    }
    for (const [ring, dir] of [[rings[0], -1], [rings[rings.length - 1], 1]]) {
      const c = centre(ring), n = mul(axis, dir);
      for (let i = 0; i < ring.length; i++) { const j = (i + 1) % ring.length; vertex(c, n, color, spec); vertex(ring[i], n, color, spec); vertex(ring[j], n, color, spec); }
    }
  };
  const cyl = (a, b, r0, r1, color, spec, n = 18) => loft(a, b, [[0, circle(r0, n)], [1, circle(r1, n)]], color, spec);
  const box = (a, b, w, h, r, color, spec, up) => loft(a, b, [[0, roundRect(w, h, r)], [1, roundRect(w, h, r)]], color, spec, up);
  const ball = (c, r, color, spec, rings = 6, segs = 10) => {
    const p = (i, j) => { const th = i / rings * Math.PI, ph = j / segs * Math.PI * 2;
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]; return [add(c, mul(n, r)), n]; };
    for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
      const [a, na] = p(i, j), [b, nb] = p(i + 1, j), [d, nd] = p(i + 1, j + 1), [e, ne] = p(i, j + 1);
      vertex(a, na, color, spec); vertex(b, nb, color, spec); vertex(d, nd, color, spec);
      vertex(a, na, color, spec); vertex(d, nd, color, spec); vertex(e, ne, color, spec);
    }
  };

  const COYOTE = [0.34, 0.28, 0.2], BLACK = [0.045, 0.047, 0.05], GUNMETAL = [0.09, 0.095, 0.1], RUBBER = [0.025, 0.025, 0.025];
  const GLASS = [0.05, 0.09, 0.13], GLOVE = [0.15, 0.14, 0.11], SLEEVE = [0.2, 0.23, 0.12];

  // Stock: butt pad, tapering butt, adjustable cheek riser, wrist and pistol grip.
  loft([0, 0, -0.8], [0, 0, -0.24], [
    [0, roundRect(0.046, 0.15, 0.016), 0, -0.055], [0.18, roundRect(0.046, 0.145, 0.018), 0, -0.052],
    [0.5, roundRect(0.043, 0.11, 0.018), 0, -0.042], [0.78, roundRect(0.04, 0.072, 0.016), 0, -0.03],
    [1, roundRect(0.05, 0.07, 0.014), 0, -0.02],
  ], COYOTE, 0.18);
  box([0, -0.055, -0.83], [0, -0.055, -0.8], 0.05, 0.155, 0.016, RUBBER, 0.05);
  box([0, 0.026, -0.66], [0, 0.026, -0.4], 0.034, 0.028, 0.012, COYOTE, 0.2);
  for (const z of [-0.6, -0.46]) cyl([-0.024, 0.008, z], [0.024, 0.008, z], 0.004, 0.004, BLACK, 0.7, 8);
  loft([0, -0.035, -0.28], [0, -0.13, -0.33], [[0, roundRect(0.032, 0.045, 0.014)], [1, roundRect(0.034, 0.05, 0.016)]], COYOTE, 0.15, [0, 0, 1]);

  // Receiver, rail with recoil slots, bolt and magazine.
  box([0, 0, -0.26], [0, 0, 0.18], 0.058, 0.064, 0.012, GUNMETAL, 0.55);
  box([0, 0.038, -0.22], [0, 0.038, 0.17], 0.022, 0.012, 0.002, BLACK, 0.5);
  for (let z = -0.21; z <= 0.16; z += 0.012) box([0, 0.046, z], [0, 0.046, z + 0.006], 0.024, 0.006, 0.001, BLACK, 0.4);
  cyl([0.03, 0.005, -0.12], [0.075, -0.025, -0.1], 0.005, 0.005, GUNMETAL, 0.8, 10);
  ball([0.08, -0.029, -0.098], 0.012, BLACK, 0.6);
  box([0, -0.07, -0.04], [0, -0.07, 0.03], 0.034, 0.075, 0.006, BLACK, 0.35, [0, 0, 1]);
  cyl([0, -0.048, -0.2], [0, -0.048, -0.12], 0.0035, 0.0035, BLACK, 0.5, 6);
  cyl([0, -0.048, -0.12], [0, -0.03, -0.11], 0.0035, 0.0035, BLACK, 0.5, 6);

  // Octagonal handguard with M-LOK slots, heavy barrel and suppressor.
  loft([0, -0.004, 0.18], [0, -0.004, 0.64], [[0, circle(0.03, 8)], [1, circle(0.029, 8)]], COYOTE, 0.22);
  for (const side of [-1, 1]) for (let z = 0.23; z < 0.6; z += 0.06) box([side * 0.028, -0.004, z], [side * 0.028, -0.004, z + 0.035], 0.006, 0.012, 0.003, BLACK, 0.1);
  cyl([0, 0, 0.64], [0, 0, 1.0], 0.012, 0.0105, GUNMETAL, 0.7);
  cyl([0, 0, 0.96], [0, 0, 1.2], 0.021, 0.021, [0.11, 0.11, 0.1], 0.35, 20);

  // Scope: rings, tube, ocular with rubber eyecup, objective bell and turrets.
  const sy = 0.085;
  for (const z of [-0.12, 0.1]) { box([0, 0.055, z], [0, 0.055, z + 0.022], 0.03, 0.03, 0.004, BLACK, 0.5); cyl([0, sy, z], [0, sy, z + 0.022], 0.017, 0.017, BLACK, 0.55); }
  cyl([0, sy, -0.2], [0, sy, 0.24], 0.0127, 0.0127, BLACK, 0.75, 22);
  loft([0, sy, -0.36], [0, sy, -0.2], [[0, circle(0.02, 22)], [0.55, circle(0.02, 22)], [0.75, circle(0.018, 22)], [1, circle(0.0135, 22)]], BLACK, 0.7);
  cyl([0, sy, -0.395], [0, sy, -0.36], 0.0205, 0.02, RUBBER, 0.08, 22);
  cyl([0, sy, -0.396], [0, sy, -0.393], 0.016, 0.016, GLASS, 1, 22);
  loft([0, sy, 0.24], [0, sy, 0.46], [[0, circle(0.0127, 22)], [0.4, circle(0.026, 22)], [1, circle(0.026, 22)]], BLACK, 0.75);
  cyl([0, sy + 0.012, 0.02], [0, sy + 0.05, 0.02], 0.017, 0.017, BLACK, 0.6, 20);
  for (let i = 0; i < 20; i++) { // knurled elevation cap
    const a = i / 20 * Math.PI * 2, x = Math.cos(a) * 0.0178, z = 0.02 + Math.sin(a) * 0.0178;
    box([x, sy + 0.032, z], [x, sy + 0.05, z], 0.003, 0.003, 0.001, GUNMETAL, 0.6, [1, 0, 0]);
  }
  cyl([0.012, sy, 0.02], [0.045, sy, 0.02], 0.015, 0.015, BLACK, 0.6, 18);
  cyl([-0.012, sy, 0.02], [-0.04, sy, 0.02], 0.016, 0.016, BLACK, 0.6, 18);

  // Deployed bipod.
  box([0, -0.035, 0.5], [0, -0.035, 0.56], 0.04, 0.02, 0.006, BLACK, 0.4);
  for (const k of [-1, 1]) { cyl([k * 0.015, -0.04, 0.53], [k * 0.1, -0.33, 0.63], 0.007, 0.006, GUNMETAL, 0.6, 10); ball([k * 0.1, -0.335, 0.632], 0.012, RUBBER, 0.1); }

  // Gloved right hand on the grip and the ghillie sleeve running to the bottom of the view.
  ball([0.005, -0.1, -0.31], 0.034, GLOVE, 0.12);
  cyl([0.01, -0.105, -0.33], [0.06, -0.33, -0.72], 0.04, 0.062, SLEEVE, 0.05, 14);
  for (let i = 0; i < 26; i++) {
    const t = (i * 0.618) % 1, a = i * 2.4, c = [0.01 + 0.05 * t, -0.105 - 0.225 * t, -0.33 - 0.39 * t];
    const r = 0.045 + 0.02 * t, root = add(c, [Math.cos(a) * r, Math.sin(a) * r * 0.8, 0]);
    const tip = add(root, [Math.cos(a) * 0.05, -0.05 - 0.03 * ((i * 7) % 3), 0.02]);
    tri(add(root, [0, 0, -0.012]), add(root, [0, 0, 0.012]), tip, [[0.25, 0.28, 0.13], [0.33, 0.3, 0.18], [0.18, 0.21, 0.09]][i % 3], 0.02);
  }
  return new Float32Array(out);
}

// ------------------------------------------------------------- rendering

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

/** Rifle → view-space placement, lowered and swung away by `raise` (0..1). */
export function rifleModelMatrix(aspect, raise = 0, time = 0) {
  const e = raise * raise * (3 - 2 * raise);
  const bob = Math.sin(time * Math.PI * 0.5) * 0.004, sway = Math.sin(time * 0.9) * 0.002;
  // Lower right, pointing straight ahead; wider screens move it right.
  const origin = [0.16 + 0.05 * Math.max(0, aspect - 1.2) + 0.2 * e + sway, -0.165 + bob - 0.9 * e, -0.6 + 0.1 * e];
  // Barrel parallel to the line of sight: it converges on the target at the centre of the view.
  const f = norm([-0.25 * e, 0.03 - 0.25 * e, -1]);
  const roll = (-2 - 18 * e) * Math.PI / 180;
  let up = norm(sub([0, 1, 0], mul(f, f[1])));
  let right = norm(cross(f, up));
  up = add(mul(up, Math.cos(roll)), mul(right, Math.sin(roll)));
  right = norm(cross(f, up));
  return new Float32Array([...right, 0, ...up, 0, ...f, 0, ...origin, 1]);
}

export class RifleViewModel {
  constructor(gl) {
    this.gl = gl;
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.program = p;
    const data = rifleGeometry();
    this.count = data.length / STRIDE;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  }

  /** Draw over the finished scene. `sky` tints the ambient light like the weather. */
  render(width, height, { raise = 0, time = 0 } = {}, sky = [0.36, 0.43, 0.5]) {
    if (raise >= 0.8) return; // fully out of view before the scope picture opens
    const gl = this.gl, p = this.program, aspect = width / height;
    gl.useProgram(p);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uProj'), false, perspective(46 * Math.PI / 180, aspect, 0.02, 5));
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uModel'), false, rifleModelMatrix(aspect, raise, time));
    gl.uniform3fv(gl.getUniformLocation(p, 'uSky'), sky.map((c) => 0.55 + c * 0.9));
    gl.uniform3fv(gl.getUniformLocation(p, 'uKey'), norm([-0.45, 0.8, 0.35]));
    gl.uniform3fv(gl.getUniformLocation(p, 'uKeyColor'), [1.05, 1.0, 0.92]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const attrs = [['aPos', 3, 0], ['aNormal', 3, 3], ['aColor', 3, 6], ['aSpec', 1, 9]].map(([name, size, offset]) => {
      const a = gl.getAttribLocation(p, name);
      gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
      return a;
    });
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    attrs.forEach((a) => gl.disableVertexAttribArray(a));
    gl.enable(gl.CULL_FACE);
  }

  dispose() { this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program); }
}
