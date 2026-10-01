// The supplied transparent artwork is a world-space, camera-facing cutout.
// It shares the terrain depth buffer, so foreground slopes still occlude it.
const VERT = `
attribute vec2 aUV;
uniform mat4 uProj;
uniform mat4 uView;
uniform vec3 uOrigin;
uniform vec3 uRight;
uniform vec2 uSize;
varying vec2 vUV;
varying vec3 vWorld;
void main() {
  vWorld = uOrigin + uRight * (aUV.x - 0.5) * uSize.x + vec3(0.0, aUV.y * uSize.y, 0.0);
  vUV = vec2(aUV.x, 1.0 - aUV.y);
  gl_Position = uProj * uView * vec4(vWorld, 1.0);
}`;
const FRAG = `
precision mediump float;
uniform sampler2D uImage;
uniform float uOpacity;
uniform vec3 uEye;
uniform vec3 uFogColor;
uniform float uFogDensity;
varying vec2 vUV;
varying vec3 vWorld;
void main() {
  vec4 pixel = texture2D(uImage, vUV);
  if (pixel.a * uOpacity < 0.02) discard;
  float fog = 1.0 - exp(-pow(length(vWorld - uEye) * uFogDensity, 1.35));
  vec3 color = mix(pixel.rgb, uFogColor * pixel.a, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(color * uOpacity, pixel.a * uOpacity);
}`;

function shader(gl, type, source) {
  const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class FriendSprite {
  constructor(gl, onReady = () => {}) {
    this.gl = gl; this.onReady = onReady;
    this.program = gl.createProgram();
    const shaders = [shader(gl, gl.VERTEX_SHADER, VERT), shader(gl, gl.FRAGMENT_SHADER, FRAG)];
    for (const s of shaders) gl.attachShader(this.program, s);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    for (const s of shaders) gl.deleteShader(s);
    this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]), gl.STATIC_DRAW);
    this.attribute = gl.getAttribLocation(this.program, 'aUV');
    this.uniforms = Object.fromEntries(['uProj', 'uView', 'uOrigin', 'uRight', 'uSize', 'uImage', 'uOpacity', 'uEye', 'uFogColor', 'uFogDensity']
      .map(key => [key, gl.getUniformLocation(this.program, key)]));
    this.texture = gl.createTexture();
    const image = new Image();
    this.ready = new Promise((resolve, reject) => {
      image.onload = () => {
        if (this.disposed) { resolve(); return; }
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
        // Premultiply before filtering: hidden RGB in transparent image pixels
        // must not produce white/grey fringes around a distant character.
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.aspect = image.width / image.height; this.loaded = true;
        resolve(); this.onReady();
      };
      image.onerror = () => reject(new Error('Conquest artwork could not be loaded.'));
      image.src = new URL('../assets/friends/conquest.webp', import.meta.url).href;
    });
    this.ready.catch(error => { this.error = error; });
  }

  render(person, motion, projection, view, camera, eye, horizon, fogDensity) {
    if (!this.loaded || motion.opacity === 0) return;
    const gl = this.gl, u = this.uniforms, heading = camera.heading * Math.PI / 180;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.uProj, false, projection); gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniform3f(u.uOrigin, person.x, person.z + (motion.altitude || 0), -person.y);
    gl.uniform3f(u.uRight, Math.cos(heading), 0, Math.sin(heading));
    gl.uniform2f(u.uSize, person.height * this.aspect, person.height);
    gl.uniform1f(u.uOpacity, motion.opacity ?? 1);
    gl.uniform3fv(u.uEye, eye); gl.uniform3fv(u.uFogColor, horizon); gl.uniform1f(u.uFogDensity, fogDensity);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture); gl.uniform1i(u.uImage, 0);
    gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.enableVertexAttribArray(this.attribute);
    gl.vertexAttribPointer(this.attribute, 2, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(this.attribute); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
  }

  dispose() {
    this.disposed = true; this.onReady = () => {};
    this.gl.deleteBuffer(this.buffer); this.gl.deleteTexture(this.texture); this.gl.deleteProgram(this.program);
  }
}
