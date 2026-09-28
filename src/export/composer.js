// ExportComposer: lays the quiz out as a social-media frame (title, heading,
// first-person scene with optional animated weather, contour map, caption).
// It renders with its own offscreen WebGL renderer and map renderer, so the
// exported picture comes from exactly the same TerrainModel as the page.

import { TerrainRenderer } from '../render/webglTerrain.js';
import { MapRenderer, quizMarkers } from '../render/mapRenderer.js';
import { drawCompassTape } from '../render/compassTape.js';
import { Random } from '../engine/rng.js';

export const FORMATS = {
  reels: { label: 'Reels / Story 9:16', width: 1080, height: 1920 },
  post: { label: 'Post 4:5', width: 1080, height: 1350 },
};

export const WEATHER_TYPES = ['wind', 'rain', 'clouds', 'fog'];

/** Shader + overlay parameters for a set of weather effects. */
export function weatherParams(selected, heading) {
  const has = (k) => selected.includes(k);
  // Wind blows across the view so both clouds and grass visibly move.
  const dir = ((heading + 75) * Math.PI) / 180;
  let speed = 0;
  if (has('clouds')) speed = 3;
  if (has('rain')) speed = Math.max(speed, 4);
  if (has('wind')) speed = 11;
  return {
    cloud: has('rain') ? 0.95 : has('clouds') ? 0.7 : 0,
    wind: [Math.sin(dir) * speed, Math.cos(dir) * speed],
    wet: has('rain') ? 1 : 0,
    fog: has('fog') ? 1 : 0,
    rain: has('rain'),
    gusts: has('wind'),
  };
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function captionText(quiz) {
  if (quiz.mode === 'facing') return 'Which way: N, NE, E, SE, S, SW, W or NW?';
  const labels = quiz.options.map((o) => o.label);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}` : labels[0];
  return `You are at ${list}, ${quiz.heading.text.toLowerCase()}.`;
}

export class ExportComposer {
  /**
   * @param {object} quiz generated quiz
   * @param {import('../engine/terrainModel.js').TerrainModel} model
   * @param {{canvas?:HTMLCanvasElement, format?:string, weather?:string[], handle?:string, caption?:boolean, reveal?:boolean, tape?:boolean, northUp?:boolean, duration?:number}} options
   */
  constructor(quiz, model, options = {}) {
    this.quiz = quiz;
    this.model = model;
    this.canvas = options.canvas || document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.glCanvas = document.createElement('canvas');
    this.renderer = new TerrainRenderer(this.glCanvas);
    this.renderer.setTerrain(model);
    this.setOptions(options);
  }

  setOptions(options) {
    const rest = { ...options };
    delete rest.canvas;
    const prev = this.options || {};
    this.options = { format: 'reels', weather: [], handle: '', caption: true, reveal: true, tape: true, northUp: false, duration: 15, ...prev, ...rest };
    const o = this.options;
    const f = FORMATS[o.format] || FORMATS.reels;
    const formatChanged = prev.format !== o.format;
    if (formatChanged) {
      this.canvas.width = f.width;
      this.canvas.height = f.height;
      this.layout = this.computeLayout(f);
      this.renderer.setFixedSize(this.layout.scene.w, this.layout.scene.h);
      this.buildRain();
    }
    if (formatChanged || prev.northUp !== o.northUp) this.buildMaps();
    this.weather = weatherParams(o.weather, this.quiz.camera.heading);
  }

  computeLayout({ width: W, height: H }) {
    const m = 40;
    if (H / W > 1.5) {
      // 9:16 — mirrors the classic puzzle layout.
      const sceneW = W - 2 * m, sceneH = Math.round(sceneW * 0.625);
      const map = 800;
      return {
        title: { y: 150, size: 88 }, facing: { y: 222, size: 38 },
        scene: { x: m, y: 270, w: sceneW, h: sceneH },
        rule: 270 + sceneH + 32,
        map: { x: (W - map) / 2, y: 270 + sceneH + 58, s: map },
        caption: { y: H - 118, size: 38 }, handle: { y: H - 56, size: 28 },
      };
    }
    // 4:5
    const sceneW = W - 2 * m, sceneH = Math.round(sceneW * 0.5);
    const map = 600;
    return {
      title: { y: 100, size: 66 }, facing: { y: 152, size: 30 },
      scene: { x: m, y: 185, w: sceneW, h: sceneH },
      rule: 185 + sceneH + 18,
      map: { x: (W - map) / 2, y: 185 + sceneH + 30, s: map },
      caption: null, handle: { y: H - 22, size: 24 },
    };
  }

  buildMaps() {
    const q = this.quiz;
    const s = this.layout.map.s;
    const make = (reveal) => {
      const c = document.createElement('canvas');
      const mr = new MapRenderer(c, { fixedSize: { width: s / 2, height: s / 2, dpr: 2 } });
      mr.setData({ model: this.model, interval: q.terrain.contourInterval, options: quizMarkers(q), rotation: this.options.northUp ? 0 : q.mapRotation, landmarks: q.landmarks });
      if (reveal) mr.setReveal({ chosen: null, camera: q.camera });
      return c;
    };
    this.mapCanvas = make(false);
    this.mapRevealCanvas = make(true);
  }

  buildRain() {
    const rng = new Random(`${this.quiz.seed}|rain`);
    const { w, h } = this.layout.scene;
    this.drops = Array.from({ length: 520 }, () => {
      const depth = rng.next(); // 0 far .. 1 near
      return { x: rng.range(-0.2, 1.2) * w, y: rng.range(0, h), len: 10 + depth * 34, speed: 900 + depth * 1400, alpha: 0.12 + depth * 0.35, width: 0.8 + depth * 1.6 };
    });
  }

  /** Draw one frame. t = seconds since start. */
  drawFrame(t = 0, { reveal = false } = {}) {
    const { ctx, layout: L, quiz: q } = this;
    const W = this.canvas.width, H = this.canvas.height;
    const duration = this.options.duration;
    ctx.save();
    ctx.fillStyle = '#151a20';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#efe9dc';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `800 ${L.title.size}px ${FONT}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(L.title.size * 0.06)}px`;
    const facingMode = q.mode === 'facing';
    ctx.fillText(facingMode ? 'WHICH WAY?' : 'WHERE ARE YOU?', W / 2, L.title.y);
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(L.facing.size * 0.08)}px`;
    ctx.font = `500 ${L.facing.size}px ${FONT}`;
    ctx.fillStyle = '#cfd3d6';
    const facing = facingMode ? 'YOU ARE AT THE MARKED POINT' : q.heading.mode === 'exact' ? q.heading.text : `${q.heading.text} ${q.heading.arrow}`;
    ctx.fillText(facing, W / 2, L.facing.y);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    // Scene.
    const S = L.scene;
    this.renderer.render(q.camera, { weather: this.weather, time: t });
    ctx.drawImage(this.glCanvas, S.x, S.y, S.w, S.h);
    ctx.save();
    ctx.beginPath(); ctx.rect(S.x, S.y, S.w, S.h); ctx.clip();
    if (this.weather.rain) this.drawRain(t);
    // The bearing tape would reveal the answer in "Which way?" until the reveal.
    if (this.options.tape && (!facingMode || reveal)) drawCompassTape(null, q.camera, { exact: q.heading.mode === 'exact', target: { ctx, x: S.x, y: S.y, width: S.w, scale: S.w / 666 } });
    ctx.restore();

    // Countdown bar under the scene (video only).
    if (this.animated) {
      const p = Math.min(1, t / duration);
      ctx.fillStyle = 'rgba(230, 226, 214, 0.15)';
      ctx.fillRect(S.x, S.y + S.h + 8, S.w, 6);
      ctx.fillStyle = reveal ? '#5fd08a' : '#ffd666';
      ctx.fillRect(S.x, S.y + S.h + 8, S.w * p, 6);
    }

    ctx.fillStyle = 'rgba(230, 226, 214, 0.14)';
    ctx.fillRect(S.x, L.rule, S.w, 2);

    const M = L.map;
    ctx.drawImage(reveal ? this.mapRevealCanvas : this.mapCanvas, M.x, M.y, M.s, M.s);

    ctx.textAlign = 'center';
    if (L.caption && this.options.caption) {
      ctx.font = `500 ${L.caption.size}px ${FONT}`;
      ctx.fillStyle = reveal ? '#5fd08a' : '#e9e4d8';
      ctx.fillText(reveal ? `Answer: ${q.correctLabel}` : captionText(q), W / 2, L.caption.y);
    } else if (reveal) {
      this.drawBadge(`Answer: ${q.correctLabel}`, W / 2, M.y + 34);
    }
    if (this.options.handle) {
      ctx.font = `500 ${L.handle.size}px ${FONT}`;
      ctx.fillStyle = 'rgba(207, 211, 214, 0.7)';
      ctx.fillText(this.options.handle, W / 2, L.handle.y);
    }
    ctx.restore();
  }

  drawBadge(text, x, y) {
    const { ctx } = this;
    ctx.font = `700 30px ${FONT}`;
    const w = ctx.measureText(text).width + 40;
    ctx.fillStyle = 'rgba(21, 26, 32, 0.85)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x - w / 2, y - 26, w, 48, 24) : ctx.rect(x - w / 2, y - 26, w, 48);
    ctx.fill();
    ctx.fillStyle = '#5fd08a';
    ctx.fillText(text, x, y + 10);
  }

  drawRain(t) {
    const { ctx } = this;
    const S = this.layout.scene;
    // Screen-space slant from the wind component across the view.
    const hd = (this.quiz.camera.heading * Math.PI) / 180;
    const [we, wn] = this.weather.wind;
    const across = we * Math.cos(hd) - wn * Math.sin(hd);
    const slant = across * 0.035;
    ctx.lineCap = 'round';
    for (const d of this.drops) {
      const y = (d.y + d.speed * t) % (S.h + d.len) - d.len;
      const x = ((d.x + slant * d.speed * t) % (S.w * 1.4) + S.w * 1.4) % (S.w * 1.4) - S.w * 0.2;
      ctx.strokeStyle = `rgba(215, 225, 235, ${d.alpha})`;
      ctx.lineWidth = d.width;
      ctx.beginPath();
      ctx.moveTo(S.x + x, S.y + y);
      ctx.lineTo(S.x + x + slant * d.len, S.y + y + d.len);
      ctx.stroke();
    }
  }

  /** PNG of a single frame. */
  async toImage({ reveal = false, time = 4 } = {}) {
    this.animated = false;
    this.drawFrame(time, { reveal });
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  dispose() {
    this.renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
