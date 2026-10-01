import { knifeClip, knifeClipTime, knifeOverlayRect, normaliseAppearance } from './knifeClips.js';

const VERT = `
attribute vec2 aPos;
uniform vec4 uRect;
uniform bool uMirror;
varying vec2 vUV;
void main() {
  vec2 uv = aPos * 0.5 + 0.5;
  gl_Position = vec4(uRect.xy + uv * uRect.zw, 0.0, 1.0);
  vUV = vec2(uMirror ? 1.0 - uv.x : uv.x, 1.0 - uv.y);
}`;
const FRAG = `
precision mediump float;
uniform sampler2D uVideo;
varying vec2 vUV;
void main() {
  vec3 rgb = texture2D(uVideo, vUV).rgb;
  // Relative green dominance tolerates shadows/compression. Preserve dark
  // gloves and skin; remove green spill independently at the soft edge.
  float dominance = (rgb.g - max(rgb.r, rgb.b)) / max(rgb.g, 0.05);
  float alpha = 1.0 - smoothstep(0.12, 0.42, dominance);
  if (alpha < 0.01) discard;
  float spill = max(0.0, rgb.g - max(rgb.r, rgb.b));
  rgb.g -= spill * smoothstep(0.04, 0.20, dominance);
  gl_FragColor = vec4(rgb, alpha);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function mediaEvent(video, name) {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); video.removeEventListener(name, done); video.removeEventListener('error', fail); };
    const done = () => { clean(); resolve(); };
    const fail = () => { clean(); reject(new Error('Knife video could not be decoded.')); };
    const timer = setTimeout(() => { clean(); reject(new Error('Knife video loading timed out.')); }, 15000);
    video.addEventListener(name, done, { once: true }); video.addEventListener('error', fail, { once: true });
  });
}

export class KnifeViewModel {
  constructor(gl, onFrame = () => {}) {
    this.gl = gl; this.onFrame = onFrame;
    this.program = gl.createProgram();
    const shaders = [compile(gl, gl.VERTEX_SHADER, VERT), compile(gl, gl.FRAGMENT_SHADER, FRAG)];
    for (const shader of shaders) gl.attachShader(this.program, shader);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    for (const shader of shaders) gl.deleteShader(shader);
    this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    this.attribute = gl.getAttribLocation(this.program, 'aPos');
    this.uniforms = Object.fromEntries(['uRect', 'uMirror', 'uVideo'].map(id => [id, gl.getUniformLocation(this.program, id)]));
    this.texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setOptions(settings) {
    const options = normaliseAppearance(settings);
    this.options = options;
    if (this.clip?.id === options.knife) return;
    this.releaseVideo(); this.clip = knifeClip(options); this.hasFrame = false; this.error = null; this.requestedTarget = null;
    const video = this.video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.src = new URL('../assets/knives/' + this.clip.file, import.meta.url).href;
    this.ready = mediaEvent(video, 'loadeddata');
    this.ready.catch(error => { if (this.video === video) { this.error = error; this.onFrame(); } });
    const decoded = () => {
      if (this.video !== video) return;
      this.uploadFrame(); if (!this.preparing) this.onFrame();
    };
    video.addEventListener('loadeddata', decoded); video.addEventListener('seeked', decoded);
    video.load();
  }

  uploadFrame() {
    if (!this.video || this.video.readyState < 2 || this.video.seeking) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    this.hasFrame = true;
  }

  sync(time, motion) {
    const video = this.video;
    if (!video || video.readyState < 2 || video.seeking) return;
    const target = knifeClipTime(time, motion, this.options);
    if (target !== this.requestedTarget && Math.abs(video.currentTime - target) > .45 / this.clip.fps) {
      this.requestedTarget = target; video.currentTime = target;
    }
  }

  /** Export waits for the exact decoded frame instead of capturing a stale seek. */
  async prepare(time, motion = {}) {
    const video = this.video;
    if (!video) return;
    this.preparing = true;
    try {
      await this.ready;
      if (video.seeking) await mediaEvent(video, 'seeked');
      const target = knifeClipTime(time, motion, this.options);
      if (Math.abs(video.currentTime - target) > .45 / this.clip.fps) {
        const sought = mediaEvent(video, 'seeked'); this.requestedTarget = target; video.currentTime = target; await sought;
      }
      if (Math.abs(video.currentTime - target) > 1 / this.clip.fps || video.readyState < 2) {
        throw new Error('Knife video seek failed. Reload the clip and try again.');
      }
      this.uploadFrame();
    } finally {
      this.preparing = false;
    }
  }

  render(width, height, time, motion = {}) {
    if (!this.options) return;
    this.sync(time, motion);
    if (!this.hasFrame) return;
    const gl = this.gl, rect = knifeOverlayRect(width, height, time, motion, this.options);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    gl.uniform4f(this.uniforms.uRect, rect.x / width * 2 - 1, 1 - (rect.y + rect.h) / height * 2, rect.w / width * 2, rect.h / height * 2);
    gl.uniform1i(this.uniforms.uMirror, rect.mirror ? 1 : 0); gl.uniform1i(this.uniforms.uVideo, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.enableVertexAttribArray(this.attribute);
    gl.vertexAttribPointer(this.attribute, 2, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(this.attribute); gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST);
  }

  releaseVideo() {
    if (!this.video) return;
    const video = this.video; this.video = null;
    video.pause(); video.removeAttribute('src'); video.load();
  }
  dispose() {
    this.onFrame = () => {}; this.releaseVideo();
    this.gl.deleteBuffer(this.buffer); this.gl.deleteTexture(this.texture); this.gl.deleteProgram(this.program);
  }
}
