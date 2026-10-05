// ExportComposer: lays the quiz out as a social-media frame (title, heading,
// first-person scene with optional animated weather, contour map, caption).
// It renders with its own offscreen WebGL renderer and map renderer, so the
// exported picture comes from exactly the same TerrainModel as the page.

import { TerrainRenderer } from '../render/webglTerrain.js';
import { MapRenderer, quizMarkers } from '../render/mapRenderer.js';
import { drawCompassTape } from '../render/compassTape.js';
import { relativeBearing, drawRelativeBearing } from '../render/relativeBearing.js';
import { skylineScreenPoints } from '../render/skylineOverlay.js';
import { createEasterEgg } from '../easter/index.js';
import { renderSoundtrack, clipCues } from '../audio/soundscape.js';
import { normaliseEnvironment, environmentFromWeather, weatherParams } from '../render/environment.js';
import { headingHidden } from '../engine/gridQuiz.js';
import { friendSceneFrame } from './friendZoom.js';
import { friendObserver } from '../engine/friendQuiz.js';
import { trailFrame } from '../engine/trailMotion.js';
import { usesSunWatch, sunWatchFrame } from '../engine/sunWatch.js';
import { sniperFrame, sniperWeather } from '../engine/sniper.js';
import { drawSniperOverlay } from '../render/sniperOverlay.js';
import { isMapMode } from '../engine/mapModes.js';
import { modeTitle, modeSubtitle, modeCaption, modeFrame, drawModeOverlay } from '../render/mapModesView.js';

export const FORMATS = {
  reels: { label: 'Reels / Story 9:16', width: 1080, height: 1920 },
  post: { label: 'Post 4:5', width: 1080, height: 1350 },
};

export const WEATHER_TYPES = ['breeze', 'wind', 'clouds', 'overcast', 'drizzle', 'rain', 'storm', 'fog', 'snow', 'sunset'];
export { weatherParams } from '../render/environment.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function captionText(quiz) {
  if (isMapMode(quiz)) return modeCaption(quiz);
  if (quiz.mode === 'sniper') return quiz.sniper.wind ? `Wind ${quiz.sniper.wind.speed} m/s: which mark and windage hit his head?`
    : `Which hold hits his head: ${quiz.options.map((o) => o.label).join(', ')}?`;
  if (quiz.mode === 'facing') return 'Which way: N, NE, E, SE, S, SW, W or NW?';
  if (quiz.mode === 'trail' && quiz.grid) return `Find your finish cell: A1–${String.fromCharCode(64 + quiz.grid.size)}${quiz.grid.size}.`;
  if (quiz.mode === 'trail') return 'Which trail: A red, B green or C cyan?';
  if (quiz.mode === 'friend' && quiz.grid) return `Find your friend's cell: A1–${String.fromCharCode(64 + quiz.grid.size)}${quiz.grid.size}.`;
  if (quiz.mode === 'grid') return `Find your cell: A1–${String.fromCharCode(64 + quiz.grid.size)}${quiz.grid.size}.`;
  const labels = quiz.options.map((o) => o.label);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}` : labels[0];
  if (usesSunWatch(quiz)) return quiz.mode === 'friend' ? `Find your friend: ${list}.` : `You are at ${list}. Which one?`;
  if (quiz.mode === 'friend') return quiz.friend.observerHidden
    ? `Find your friend: ${list}. Read the terrain.` : `From YOU, locate your friend: ${list}.`;
  return `You are at ${list}, ${quiz.heading.text.toLowerCase()}.`;
}

export const exportDuration = quiz => quiz.mode === 'trail' ? quiz.trail.duration + 3 : 15;

export class ExportComposer {
  /**
   * @param {object} quiz generated quiz
   * @param {import('../engine/terrainModel.js').TerrainModel} model
   * `easterEgg` is a plan from resolveEasterEgg() (or null): a decorative
   * seasonal layer chosen once per render, never per frame.
   * @param {{canvas?:HTMLCanvasElement, easterEgg?:object|null, format?:string, environment?:object, weather?:string[], handle?:string, caption?:boolean, reveal?:boolean, tape?:boolean, northUp?:boolean, duration?:number}} options
   */
  constructor(quiz, model, options = {}) {
    this.quiz = quiz;
    this.model = model;
    this.canvas = options.canvas || document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.glCanvas = document.createElement('canvas');
    this.renderer = new TerrainRenderer(this.glCanvas);
    this.renderer.setTerrain(model, { seed: quiz.seed, world: quiz.terrain.world });
    this.renderer.setPerson(quiz.friend || quiz.sniper?.target || null);
    this.setOptions(options);
    if (usesSunWatch(quiz)) this.renderer.prepareWatch().catch(error => { this.watchError = error; });
  }

  setOptions(options) {
    const rest = { ...options };
    delete rest.canvas;
    const prev = this.options || {};
    this.options = { format: 'reels', weather: [], handle: '', caption: true, reveal: true, tape: true, northUp: false, duration: exportDuration(this.quiz), ...prev, ...rest };
    if (this.quiz.mode === 'trail') this.options.duration = Math.max(exportDuration(this.quiz), this.options.duration);
    if ('weather' in rest && !('environment' in rest)) delete this.options.environment;
    const o = this.options;
    this.renderer.setViewmodel?.(this.quiz.mode === 'trail' ? o.appearance || this.quiz.appearance || {} : null);
    const f = FORMATS[o.format] || FORMATS.reels;
    const formatChanged = prev.format !== o.format;
    if (formatChanged) {
      this.canvas.width = f.width;
      this.canvas.height = f.height;
      this.layout = this.computeLayout(f);
      this.renderer.setFixedSize(this.layout.scene.w, this.layout.scene.h);
      this.previewResolution = false;
    }
    if (formatChanged || prev.northUp !== o.northUp) this.buildMaps();
    this.environment = o.environment ? normaliseEnvironment(o.environment) : environmentFromWeather(o.weather);
    this.weather = weatherParams(o.environment ? this.environment : o.weather, this.quiz.camera.heading);
    if (formatChanged || 'easterEgg' in rest) this.buildEasterEgg();
  }

  /**
   * The seasonal layer only receives the plan, the quiz seed, the layout and the
   * engine's skyline, so it cannot alter or reveal the quiz.
   */
  buildEasterEgg() {
    this.easterFov = this.quiz.camera.fov;
    this.easterCameraKey = JSON.stringify(this.quiz.camera);
    const plan = this.options.easterEgg || null;
    if (!plan) { this.easter = null; return; }
    const S = this.layout.scene;
    this.easter = createEasterEgg(plan, {
      seed: this.quiz.seed,
      layout: this.layout,
      frame: { width: this.canvas.width, height: this.canvas.height },
      skyline: skylineScreenPoints(this.quiz.camera, this.model, S.w, S.h),
      duration: this.options.duration,
    });
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
        remark: { y: 270 + sceneH + 50, size: 28 },
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
      remark: { y: 185 + sceneH + 46, size: 26 },
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
      mr.setData({ model: this.model, interval: q.terrain.contourInterval, options: quizMarkers(q), rotation: this.options.northUp ? 0 : q.mapRotation, landmarks: q.landmarks,
        grid: q.grid ? { ...q.grid, correctLabel: q.correctLabel } : null,
        extent: q.mapExtent || null, routes: q.trail?.routes, trails: q.mode === 'trail', trailDuration: q.trail?.duration, observer: friendObserver(q),
        friendMode: q.mode === 'friend' || q.mode === 'sniper' || !!q.map?.revealYou, target: q.mode === 'sniper' ? q.sniper.target : null,
        extras: q.map?.extras, revealExtras: q.map?.revealExtras, lineOptions: q.map?.lineOptions });
      if (q.mode === 'trail') {
        if (reveal) this.trailRevealMap = mr;
        else this.trailQuestionMap = mr;
      }
      if (reveal) {
        mr.setReveal({ chosen: null, camera: isMapMode(q) && !q.map.revealYou ? null : q.camera });
        if (q.mode === 'trail') {
          mr.setViewing({ ...trailFrame(q, q.trail.duration, q.correctLabel, this.model).camera, label: q.correctLabel });
          this.trailRevealMap = mr; this.trailRevealMapTime = q.trail.duration;
        }
      }
      return c;
    };
    this.mapCanvas = make(false);
    this.mapRevealCanvas = make(true);
  }

  /** Draw one frame. t = seconds since start. */
  drawFrame(t = 0, { reveal = false, preview = false } = {}) {
    const { ctx, layout: L, quiz: q } = this;
    const frame = q.mode === 'trail' ? trailFrame(q, t, q.correctLabel, this.model) : null;
    const friendFrame = friendSceneFrame(q, t, this.animated || (!reveal && usesSunWatch(q)));
    const watchFrame = usesSunWatch(q) ? q.mode === 'friend' ? friendFrame
      : sunWatchFrame(q, t, { active: this.animated || !reveal }) : null;
    const sniper = q.mode === 'sniper' ? sniperFrame(q, t, this.layout.scene.w / this.layout.scene.h) : null;
    const mode = isMapMode(q) ? modeFrame(q, this.model, t, this.layout.scene.w / this.layout.scene.h) : null;
    const camera = mode ? mode.camera : sniper ? sniper.camera : watchFrame ? watchFrame.camera : frame ? frame.camera : friendFrame.camera;
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
    ctx.fillText(isMapMode(q) ? modeTitle(q) : q.mode === 'sniper' ? 'SNIPER · WHICH HOLD?' : q.mode === 'trail' ? q.grid ? 'WHERE DID YOU FINISH?' : 'WHICH TRAIL?' : q.mode === 'friend' ? 'FIND YOUR FRIEND' : facingMode ? 'WHICH WAY?' : q.mode === 'lookalike' ? 'LOOK-ALIKES' : q.mode === 'grid' ? `${q.grid.size} × ${q.grid.size} GRID` : 'WHERE ARE YOU?', W / 2, L.title.y, W - 80);
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(L.facing.size * 0.08)}px`;
    ctx.font = `500 ${L.facing.size}px ${FONT}`;
    ctx.fillStyle = '#cfd3d6';
    const facing = isMapMode(q) ? modeSubtitle(q) : q.mode === 'sniper' ? q.heading.text : q.mode === 'trail' ? q.grid ? 'BUNNY HOP · FIND YOUR FINISH CELL' : 'BUNNY HOP · READ THE MOVING TERRAIN' : facingMode ? 'YOU ARE AT THE MARKED POINT' : headingHidden(q) && !reveal ? 'LOST COMPASS · FIND YOUR CELL' : q.heading.mode === 'exact' ? q.heading.text : `${q.heading.text} ${q.heading.arrow}`;
    if (!usesSunWatch(q)) ctx.fillText(q.mode === 'friend' ? `${q.friend.observerHidden && !reveal ? 'READ THE TERRAIN' : 'FROM YOU'} · ${facing}` : facing, W / 2, L.facing.y);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    // Scene.
    const S = L.scene;
    if (this.previewResolution !== preview && this.renderer.setFixedSize) {
      const scale = preview ? Math.min(1, 720 / S.w) : 1;
      this.renderer.setFixedSize(Math.round(S.w * scale), Math.round(S.h * scale));
      this.previewResolution = preview;
    }
    this.renderer.render(camera, { weather: sniper ? sniperWeather(q, this.weather) : this.weather, environment: this.environment, environmentTime: t, time: frame ? frame.motion.t : t,
      personMotion: friendFrame.personMotion,
      solar: watchFrame?.solar, watch: watchFrame?.watch,
      motion: frame ? { ...frame.motion, clockRunning: this.animated } : {}, sunHeading: q.mode === 'trail' ? q.camera.heading : camera.heading,
      rifle: sniper ? { raise: sniper.raise, time: t } : null, ...(mode ? mode.options : {}) });
    ctx.drawImage(this.glCanvas, S.x, S.y, S.w, S.h);
    ctx.save();
    ctx.beginPath(); ctx.rect(S.x, S.y, S.w, S.h); ctx.clip();
    // The bearing tape would reveal the answer in "Which way?" until the reveal.
    if (sniper) drawSniperOverlay(ctx, q, sniper, { x: S.x, y: S.y, width: S.w, height: S.h });
    if (mode) drawModeOverlay(ctx, q, mode, { x: S.x, y: S.y, width: S.w, height: S.h, answered: reveal });
    if (!usesSunWatch(q) && this.options.tape && (!headingHidden(q) || reveal) && !(sniper && sniper.raise > 0) && q.mode !== 'profile') drawCompassTape(null, camera, { exact: q.heading.mode === 'exact', target: { ctx, x: S.x, y: S.y, width: S.w, scale: S.w / 666 } });
    if (watchFrame) drawRelativeBearing(ctx, relativeBearing(camera.heading, q.camera.heading, watchFrame.relativeTurn), {
      x: S.x, y: S.y, width: S.w, scale: S.w / 666,
    });
    ctx.restore();

    // Countdown bar under the scene (video only).
    if (this.animated) {
      const p = Math.min(1, t / duration);
      ctx.fillStyle = 'rgba(230, 226, 214, 0.15)';
      ctx.fillRect(S.x, S.y + S.h + 8, S.w, 6);
      ctx.fillStyle = reveal ? '#5fd08a' : '#ffd666';
      ctx.fillRect(S.x, S.y + S.h + 8, S.w * p, 6);
    }

    if (!q.grid) {
      ctx.fillStyle = 'rgba(230, 226, 214, 0.14)';
      ctx.fillRect(S.x, L.rule, S.w, 2);
    }

    const M = L.map;
    if (frame) {
      const trailMap = reveal ? this.trailRevealMap : this.trailQuestionMap;
      trailMap?.setTrailTime?.(frame.motion.t, reveal ? { ...camera, label: q.correctLabel } : null);
    }
    if (frame && reveal && this.trailRevealMap && this.trailRevealMapTime !== frame.motion.t) {
      this.trailRevealMap.setViewing({ ...camera, label: q.correctLabel });
      this.trailRevealMapTime = frame.motion.t;
    }
    ctx.drawImage(reveal ? this.mapRevealCanvas : this.mapCanvas, M.x, M.y, M.s, M.s);

    ctx.textAlign = 'center';
    if (q.grid && (this.options.caption || reveal)) {
      // One remark above the grid in both formats, including video frames.
      // Draw after the map so its empty header margin cannot erase the text.
      ctx.font = `500 ${L.remark.size}px ${FONT}`;
      ctx.fillStyle = reveal ? '#5fd08a' : '#e9e4d8';
      ctx.fillText(reveal ? `Answer: ${q.correctLabel}` : captionText(q), W / 2, L.remark.y, W - 80);
    } else if (!q.grid && L.caption && this.options.caption) {
      ctx.font = `500 ${L.caption.size}px ${FONT}`;
      ctx.fillStyle = reveal ? '#5fd08a' : '#e9e4d8';
      ctx.fillText(reveal ? `Answer: ${q.correctLabel}` : captionText(q), W / 2, L.caption.y);
    } else if (!q.grid && reveal) {
      this.drawBadge(`Answer: ${q.correctLabel}`, W / 2, M.y + 34);
    }
    if (this.options.handle) {
      ctx.font = `500 ${L.handle.size}px ${FONT}`;
      ctx.fillStyle = 'rgba(207, 211, 214, 0.7)';
      ctx.fillText(this.options.handle, W / 2, L.handle.y);
    }
    // Seasonal Easter egg: last, clipped away from every protected element.
    // Inactive (and untouched) outside an event and after the fade-out.
    // Through the scope the decorative layer would cover the reticle: overview only.
    if (this.easter && !(sniper && sniper.raise > 0)) {
      // Sky objects must still disappear behind the terrain as the lens zooms.
      if (this.easterFov !== camera.fov || ((usesSunWatch(q) || ['trail', 'friend', 'sniper'].includes(q.mode) || isMapMode(q)) && this.easterCameraKey !== JSON.stringify(camera))) {
        this.easter.stage.setSkyline(skylineScreenPoints(camera, this.model, S.w, S.h));
        this.easterFov = camera.fov;
        this.easterCameraKey = JSON.stringify(camera);
      }
      this.easter.draw(ctx, t);
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

  /** PNG of a single frame. */
  async toImage({ reveal = false, time = this.quiz.mode === 'trail' && this.quiz.grid ? this.quiz.trail.duration : this.quiz.mode === 'sniper' ? 7.5
    : usesSunWatch(this.quiz) && this.quiz.mode === 'friend' ? 8 : 4 } = {}) {
    this.animated = false;
    await this.drawFrameReady(time, { reveal });
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  dispose() {
    this.renderer.dispose();
  }

  /** The clip's soundtrack: weather ambience plus mode cues (sniper scope and shot, reveal chime). */
  renderSoundtrack() {
    const q = this.quiz, wind = q.sniper?.wind;
    const weather = wind ? { ...this.weather, wind: [wind.speed * Math.sin((wind.from + 180) * Math.PI / 180), wind.speed * Math.cos((wind.from + 180) * Math.PI / 180)] } : this.weather;
    return renderSoundtrack({ duration: this.options.duration, weather, seed: `${q.seed}|${q.mode}`,
      cues: clipCues(q, this.options.duration, { reveal: this.options.reveal }) });
  }

  async drawFrameReady(time = 0, options = {}) {
    await this.renderer.prepareEnvironmentReady(this.environment);
    if (usesSunWatch(this.quiz)) await this.renderer.prepareWatch();
    if (this.quiz.mode === 'friend' && this.quiz.friend.skin === 'conquest') await this.renderer.friendSprite?.ready;
    if (this.quiz.mode === 'trail') {
      const frame = trailFrame(this.quiz, time, this.quiz.correctLabel, this.model);
      await this.renderer.prepareViewmodel?.(frame.motion.t, frame.motion);
    }
    this.drawFrame(time, options);
  }
}
