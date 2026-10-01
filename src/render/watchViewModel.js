// Photographic cutout + a real, time-driven analog dial. No character mesh.
const VERT = `
attribute vec2 aPos;
uniform vec4 uRect;
varying vec2 vUV;
void main() {
  vUV = vec2(aPos.x, 1.0 - aPos.y);
  gl_Position = vec4(uRect.xy + aPos * uRect.zw, 0.0, 1.0);
}`;
const FRAG = `
precision mediump float;
uniform sampler2D uImage;
varying vec2 vUV;
void main() { gl_FragColor = texture2D(uImage, vUV); }`;

export function watchHandAngles({ hour24 = 0, minute = 0, seconds = 0 }) {
  const tau = Math.PI * 2;
  return { hour: ((hour24 % 12) + minute / 60 + seconds / 3600) * tau / 12,
    minute: (minute + seconds / 60) * tau / 60, second: seconds * tau / 60 };
}

export function drawWatchDial(ctx, motion) {
  const angles = watchHandAngles(motion);
  ctx.save(); ctx.translate(866, 468); ctx.scale(150, 144);
  ctx.lineCap = 'round'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < 60; i++) {
    const a = i * Math.PI / 30 - Math.PI / 2, major = i % 5 === 0;
    ctx.strokeStyle = major ? '#eee8c9' : 'rgba(223,226,222,.65)'; ctx.lineWidth = major ? .025 : .012;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * (major ? .80 : .86), Math.sin(a) * (major ? .80 : .86));
    ctx.lineTo(Math.cos(a) * .92, Math.sin(a) * .92); ctx.stroke();
  }
  ctx.fillStyle = '#eee8ce'; ctx.font = '600 .15px system-ui, sans-serif';
  for (let h = 1; h <= 12; h++) {
    const a = h * Math.PI / 6 - Math.PI / 2;
    ctx.fillText(String(h), Math.cos(a) * .67, Math.sin(a) * .67);
  }
  const hand = (angle, len, width, color) => {
    ctx.save(); ctx.rotate(angle); ctx.beginPath(); ctx.moveTo(0, .1); ctx.lineTo(0, -len);
    ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = width + .025; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.restore();
  };
  hand(angles.hour, .44, .052, '#eadbb7'); hand(angles.minute, .70, .035, '#f2ebd0'); hand(angles.second, .81, .012, '#d77d56');
  ctx.fillStyle = '#e0bb73'; ctx.beginPath(); ctx.arc(0, 0, .039, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}

function shader(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
export class WatchViewModel {
  constructor(gl, onReady = () => {}) {
    this.gl = gl; this.onReady = onReady;
    this.program = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
      const s = shader(gl, type, src); gl.attachShader(this.program, s); gl.deleteShader(s);
    }
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    this.attribute = gl.getAttribLocation(this.program, 'aPos');
    this.rect = gl.getUniformLocation(this.program, 'uRect'); this.sampler = gl.getUniformLocation(this.program, 'uImage');
    this.texture = gl.createTexture();
    this.canvas = document.createElement('canvas'); this.canvas.width = 1672; this.canvas.height = 941;
    this.ctx = this.canvas.getContext('2d'); this.image = new Image();
    this.ready = new Promise((resolve, reject) => {
      this.image.onload = () => { this.loaded = true; resolve(); this.onReady(); };
      this.image.onerror = () => reject(new Error('Wristwatch artwork could not be loaded.'));
      this.image.src = new URL('../assets/watch/field-watch.webp', import.meta.url).href;
    });
    this.ready.catch(error => { this.error = error; });
  }
  render(width, height, motion) {
    if (!this.loaded || !motion || motion.progress <= 0) return;
    const dialMotion = { ...motion, seconds: Math.floor(motion.seconds * 15) / 15 };
    const key = `${motion.hour24}:${motion.minute}:${dialMotion.seconds}`;
    const gl = this.gl;
    if (key !== this.lastDial) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(this.image, 0, 0); drawWatchDial(this.ctx, dialMotion);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.lastDial = key;
    }
    const scale = Math.min(width * .18, height * .31) / 150;
    const w = this.canvas.width * scale, h = this.canvas.height * scale;
    const x = width * .5 - 866 * scale, y = height * .52 - 468 * scale + (1 - motion.progress) * height;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program); gl.uniform4f(this.rect, x / width * 2 - 1, 1 - (y + h) / height * 2, w / width * 2, h / height * 2);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture); gl.uniform1i(this.sampler, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.enableVertexAttribArray(this.attribute);
    gl.vertexAttribPointer(this.attribute, 2, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(this.attribute); gl.disable(gl.BLEND);
  }
  dispose() { this.onReady = () => {}; this.gl.deleteBuffer(this.buffer); this.gl.deleteTexture(this.texture); this.gl.deleteProgram(this.program); }
}
