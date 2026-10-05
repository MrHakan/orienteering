// 2D topographic map renderer (Canvas 2D). Contours come straight from the
// TerrainModel's oriented Marching Squares output.

import { ContourGenerator } from '../engine/contours.js';
import { cellAtExtent, parseCell } from '../engine/gridQuiz.js';
import { TRAIL_COLORS } from '../engine/trailQuiz.js';

const COLORS = {
  bg: '#151a20',
  frame: 'rgba(230, 226, 214, 0.28)',
  contour: 'rgba(226, 222, 212, 0.62)',
  index: 'rgba(240, 236, 226, 0.95)',
  label: 'rgba(240, 236, 226, 0.95)',
  marker: '#f1ede4',
  correct: '#5fd08a',
  wrong: '#ff6b5e',
  cone: 'rgba(255, 214, 102, 0.20)',
  coneLine: 'rgba(255, 214, 102, 0.85)',
};

/**
 * Points to mark on the map for a quiz: the answer options in "Where are
 * you?", or the single (unlabelled) observer point in "Which way?".
 */
export function quizMarkers(quiz) {
  if (quiz.grid || quiz.mode === 'sniper') return [];
  if (quiz.map?.markers === false) return [];
  if (quiz.mode === 'facing') return [{ label: '', x: quiz.point.x, y: quiz.point.y, correct: true }];
  return quiz.options;
}

/** All candidates advance by clip time, independently of correctness. */
export function trailTracePoints(points, time, duration = 12) {
  if (!points.length) return [];
  const index = Math.max(0, Math.min(1, time / duration)) * (points.length - 1);
  const i = Math.floor(index), f = index - i, a = points[i], b = points[Math.min(i + 1, points.length - 1)];
  const trace = points.slice(0, i + 1);
  if (f > 0) trace.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  return trace;
}

function chaikin(pts, closed) {
  if (pts.length < 6) return pts;
  const out = [];
  const m = pts.length / 2;
  if (!closed) out.push(pts[0], pts[1]);
  const last = closed ? m : m - 1;
  for (let k = 0; k < last; k++) {
    const a = k * 2, b = ((k + 1) % m) * 2;
    out.push(0.75 * pts[a] + 0.25 * pts[b], 0.75 * pts[a + 1] + 0.25 * pts[b + 1]);
    out.push(0.25 * pts[a] + 0.75 * pts[b], 0.25 * pts[a + 1] + 0.75 * pts[b + 1]);
  }
  if (!closed) out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}

export class MapRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onPick?:Function, fixedSize?:{width:number,height:number,dpr:number}}} opts
   *   fixedSize renders at an explicit CSS size / pixel ratio (offscreen exports).
   */
  constructor(canvas, { onPick, fixedSize = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPick = onPick;
    this.fixedSize = fixedSize;
    this.overlays = { hillshade: false, landforms: false, drainage: false };
    this.hover = null;
    if (fixedSize) return; // no pointer interaction offscreen
    canvas.addEventListener('mousemove', (e) => {
      const o = this.hit(e);
      const label = o ? o.label : null;
      if (label !== this.hover) { this.hover = label; if (this.data?.grid) this._trailBase = null; this.canvas.style.cursor = label && this.pickable ? 'pointer' : 'default'; this.draw(); }
    });
    canvas.addEventListener('mouseleave', () => { this.hover = null; if (this.data?.grid) this._trailBase = null; this.draw(); });
    canvas.addEventListener('click', (e) => {
      const o = this.hit(e);
      if (o && this.onPick) this.onPick(o.label);
    });
  }

  /** data: { model, interval, options, rotation, landmarks } */
  setData(data) {
    this.data = data;
    this.contours = data.model.getContours(data.interval);
    this.reveal = null;
    this.viewing = null;
    this.trailTime = 0;
    this.selection = null;
    this.hover = null;
    this._lines = null;
    this.pickable = true;
    this._hillshade = null;
    this._trailBase = null;
    this.draw();
  }

  setReveal(reveal) { this.reveal = reveal; this.pickable = !reveal; this._trailBase = null; this.draw(); }
  setSelection(label) { this.selection = label; this._trailBase = null; this.draw(); }
  setViewing(v) { this.viewing = v; this.draw(); }
  setTrailTime(time, viewing = null) {
    if (!this.data?.trails) return;
    this.trailTime = time; this.viewing = viewing; this.draw();
  }
  setOverlays(o) { Object.assign(this.overlays, o); this._trailBase = null; this.draw(); }

  layout() {
    const f = this.fixedSize;
    const dpr = f ? f.dpr : Math.min(window.devicePixelRatio || 1, 2);
    const w = f ? f.width : this.canvas.clientWidth, h = f ? f.height : this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    }
    const pad = this.data?.grid ? 28 : Math.max(14, Math.min(w, h) * 0.035);
    this.dpr = dpr;
    this.S = Math.min(w, h) - 2 * pad;
    this.cx = w / 2; this.cy = h / 2;
    const th = ((this.data?.rotation || 0) * Math.PI) / 180;
    this.cos = Math.cos(th); this.sin = Math.sin(th);
  }

  /** World metres -> CSS pixels. Map rotation is a pure display transform. */
  toCanvas(x, y) {
    const L = this.data.extent?.size || this.data.model.size;
    const u = (x - (this.data.extent?.x ?? L / 2)) / L, v = ((this.data.extent?.y ?? L / 2) - y) / L;
    return [this.cx + (u * this.cos - v * this.sin) * this.S, this.cy + (u * this.sin + v * this.cos) * this.S];
  }

  /** CSS pixels -> world metres (inverse of toCanvas). */
  toWorld(px, py) {
    const L = this.data.extent?.size || this.data.model.size;
    const a = (px - this.cx) / this.S, b = (py - this.cy) / this.S;
    const u = a * this.cos + b * this.sin, v = -a * this.sin + b * this.cos;
    return [u * L + (this.data.extent?.x ?? L / 2), (this.data.extent?.y ?? L / 2) - v * L];
  }

  hit(e) {
    if (!this.data) return null;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (this.data.grid) {
      const [x, y] = this.toWorld(px, py);
      const label = cellAtExtent(x, y, this.gridExtent(), this.data.grid.size);
      return label ? { label } : null;
    }
    if (this.data.trails) {
      let best = null, nearest = 18;
      for (const route of this.data.options) {
        for (let i = 1; i < route.points.length; i++) {
          const a = this.toCanvas(route.points[i - 1].x, route.points[i - 1].y);
          const b = this.toCanvas(route.points[i].x, route.points[i].y);
          const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
          const t = length2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / length2)) : 0;
          const d = Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
          if (d < nearest) { nearest = d; best = route; }
        }
      }
      return best;
    }
    let best = null, bd = 22;
    // Map-reading modes may answer with lines (route choice): pick the nearest one.
    for (const line of this.data.lineOptions || []) {
      for (let i = 1; i < line.points.length; i++) {
        const a = this.toCanvas(line.points[i - 1].x, line.points[i - 1].y), b = this.toCanvas(line.points[i].x, line.points[i].y);
        const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
        const t = length2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / length2)) : 0;
        const d = Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
        if (d < Math.min(bd, 14)) { bd = d; best = line; }
      }
    }
    for (const o of this.data.options) {
      const [x, y] = this.toCanvas(o.x, o.y);
      const d = Math.hypot(x - px, y - py);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  draw({ staticOnly = false } = {}) {
    if (!this.data) return;
    this.layout();
    const { ctx, dpr } = this;
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    this.cssW = w; this.cssH = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Contours are static during playback. Cache them once so every trace
    // update only paints three short paths, including in mobile exports.
    if (this.data.trails && !staticOnly) {
      const key = `${this.canvas.width}:${this.canvas.height}:${this.data.rotation}`;
      if (!this._trailBase || this._trailBaseKey !== key) {
        this.draw({ staticOnly: true });
        const base = document.createElement('canvas');
        base.width = this.canvas.width; base.height = this.canvas.height;
        base.getContext('2d').drawImage(this.canvas, 0, 0);
        this._trailBase = base; this._trailBaseKey = key;
      }
      ctx.drawImage(this._trailBase, 0, 0, w, h);
      this.drawTrails(); this.drawTrailLabels();
      return;
    }
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    const extent = this.data.extent || { x: this.data.model.size / 2, y: this.data.model.size / 2, size: this.data.model.size };
    const left = extent.x - extent.size / 2, right = extent.x + extent.size / 2;
    const bottom = extent.y - extent.size / 2, top = extent.y + extent.size / 2;
    const corners = [[left, bottom], [right, bottom], [right, top], [left, top]].map(([x, y]) => this.toCanvas(x, y));
    ctx.save();
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.clip();

    if (this.overlays.hillshade) this.drawHillshade();

    const lines = this.prepareLines();
    const labels = this.placeLabels(lines);

    // Knock the label boxes out of the contour lines.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    for (const l of labels) {
      const c = Math.cos(l.angle), s = Math.sin(l.angle);
      const hw = l.w / 2 + 3, hh = 7;
      const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => [l.x + a * c - b * s, l.y + a * s + b * c]);
      ctx.moveTo(pts[3][0], pts[3][1]);
      for (const p of pts) ctx.lineTo(p[0], p[1]);
      ctx.closePath();
    }
    ctx.clip('evenodd');
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const l of lines) {
      ctx.strokeStyle = l.index ? COLORS.index : COLORS.contour;
      ctx.lineWidth = l.index ? 1.5 : 0.8;
      ctx.beginPath();
      const p = l.px;
      ctx.moveTo(p[0], p[1]);
      for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1]);
      if (l.closed) ctx.closePath();
      ctx.stroke();
      if (l.depression) this.drawTicks(l);
    }
    ctx.restore();

    ctx.fillStyle = COLORS.label;
    ctx.font = '600 10.5px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of labels) {
      ctx.save();
      ctx.translate(l.x, l.y);
      ctx.rotate(l.angle);
      ctx.fillText(l.text, 0, 0.5);
      ctx.restore();
    }

    if (this.overlays.drainage) this.drawDrainage();
    if (this.overlays.landforms) this.drawLandforms();
    if (this.data.grid) this.drawGrid();
    if (this.data.trails && !staticOnly) this.drawTrails();
    if (!this.data.trails) this.drawCone();
    this.drawExtras('lines');
    ctx.restore();

    ctx.strokeStyle = COLORS.frame;
    ctx.lineWidth = 1;
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();

    this.drawNorthArrow();
    this.drawScaleBar();
    if (this.data.grid) { this.drawGridLabels(); this.drawGridTarget(); }
    else if (this.data.trails) { if (!staticOnly) this.drawTrailLabels(); }
    else this.drawMarkers(); // last, so nothing ever hides an answer option
    this.drawExtras('points');
    if (this.reveal && this.data.target) this.drawTarget();
    if (this.currentObserver()) this.drawObserver();
  }

  /**
   * Map-reading modes: `extras` are always drawn, `revealExtras` after answering.
   * Lines: { type: 'line', points, color, width, dash, label, arrow }.
   * Points: { type: 'point', x, y, label, shape: 'peak'|'drop'|'flag'|'start'|'finish'|'dot'|'number', color }.
   */
  drawExtras(phase) {
    const items = [...(this.data.extras || []), ...(this.reveal ? this.data.revealExtras || [] : [])];
    const { ctx } = this;
    for (const e of items) {
      if (phase === 'lines' && e.type === 'line') {
        const pts = e.points.map((p) => this.toCanvas(p.x, p.y));
        ctx.save();
        ctx.strokeStyle = e.color || '#ffd666'; ctx.lineWidth = e.width || 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.setLineDash(e.dash || []);
        if (e.halo) { ctx.save(); ctx.strokeStyle = 'rgba(21, 26, 32, .8)'; ctx.lineWidth = (e.width || 2) + 3; ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); ctx.restore(); }
        ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
        ctx.setLineDash([]);
        if (e.arrow && pts.length > 1) {
          const [x1, y1] = pts[pts.length - 1], [x0, y0] = pts[pts.length - 2], a = Math.atan2(y1 - y0, x1 - x0);
          ctx.fillStyle = e.color || '#ffd666'; ctx.beginPath(); ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - Math.cos(a - 0.45) * 10, y1 - Math.sin(a - 0.45) * 10); ctx.lineTo(x1 - Math.cos(a + 0.45) * 10, y1 - Math.sin(a + 0.45) * 10); ctx.closePath(); ctx.fill();
        }
        if (e.label) {
          const [x, y] = pts[Math.floor(pts.length * (e.labelAt ?? 0.5))] || pts[0];
          ctx.font = '800 12px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(21, 26, 32, .9)'; ctx.strokeText(e.label, x, y - 10);
          ctx.fillStyle = e.color || '#ffd666'; ctx.fillText(e.label, x, y - 10);
        }
        ctx.restore();
      }
      if (phase === 'points' && e.type === 'point') {
        const [x, y] = this.toCanvas(e.x, e.y), c = e.color || '#ffd666';
        ctx.save();
        ctx.fillStyle = c; ctx.strokeStyle = COLORS.bg; ctx.lineWidth = 2;
        ctx.beginPath();
        if (e.shape === 'peak') { ctx.moveTo(x, y - 9); ctx.lineTo(x + 8, y + 6); ctx.lineTo(x - 8, y + 6); ctx.closePath(); }
        else if (e.shape === 'drop') { ctx.moveTo(x, y - 11); ctx.quadraticCurveTo(x + 8, y, x, y + 7); ctx.quadraticCurveTo(x - 8, y, x, y - 11); }
        else if (e.shape === 'start') { ctx.moveTo(x, y - 10); ctx.lineTo(x + 9, y + 6); ctx.lineTo(x - 9, y + 6); ctx.closePath(); ctx.fillStyle = 'rgba(0,0,0,0)'; }
        else if (e.shape === 'finish') { ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.moveTo(x + 5, y); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0)'; }
        else if (e.shape === 'flag') { ctx.rect(x - 1, y - 12, 2, 12); ctx.moveTo(x + 1, y - 12); ctx.lineTo(x + 10, y - 8.5); ctx.lineTo(x + 1, y - 5); }
        else ctx.arc(x, y, e.shape === 'number' ? 10 : 4, 0, Math.PI * 2);
        if (['start', 'finish'].includes(e.shape)) { ctx.strokeStyle = c; ctx.lineWidth = 2.4; ctx.stroke(); }
        else { ctx.fill(); ctx.stroke(); }
        if (e.label) {
          ctx.font = `800 ${e.shape === 'number' ? 12 : 11}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          if (e.shape === 'number') { ctx.fillStyle = COLORS.bg; ctx.fillText(e.label, x, y + 0.5); }
          else { const dy = e.shape === 'peak' || e.shape === 'flag' ? -19 : 17; ctx.lineWidth = 3; ctx.strokeStyle = COLORS.bg; ctx.strokeText(e.label, x, y + dy); ctx.fillStyle = c; ctx.fillText(e.label, x, y + dy); }
        }
        ctx.restore();
      }
    }
  }

  /** Sniper answer: the enemy and the line of fire, shown only after answering. */
  drawTarget() {
    const { ctx } = this, t = this.data.target, o = this.reveal.camera;
    const [x, y] = this.toCanvas(t.x, t.y);
    if (o) {
      const [ox, oy] = this.toCanvas(o.x, o.y);
      ctx.strokeStyle = 'rgba(232, 70, 60, .85)'; ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
      const metres = Math.round(Math.hypot(t.x - o.x, t.y - o.y));
      ctx.font = '800 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffb4ad'; ctx.strokeStyle = COLORS.bg; ctx.lineWidth = 3;
      ctx.strokeText(`${metres} m`, (ox + x) / 2, (oy + y) / 2 - 9); ctx.fillText(`${metres} m`, (ox + x) / 2, (oy + y) / 2 - 9);
    }
    ctx.fillStyle = '#e8463c'; ctx.strokeStyle = COLORS.bg; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.font = '800 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffb4ad'; ctx.lineWidth = 3;
    ctx.strokeText('ENEMY', x, y + 17); ctx.fillText('ENEMY', x, y + 17);
  }

  gridExtent() {
    const L = this.data.model.size;
    return this.data.extent || { x: L / 2, y: L / 2, size: L };
  }

  gridPolygon(label) {
    const grid = this.data.grid, code = parseCell(label, grid.size);
    if (!code) return;
    const extent = this.gridExtent(), step = extent.size / grid.size;
    const row = code.charCodeAt(0) - 65, col = Number(code.slice(1)) - 1;
    const x = extent.x - extent.size / 2 + col * step, y = extent.y + extent.size / 2 - row * step;
    const { ctx } = this;
    ctx.beginPath();
    [[x, y], [x + step, y], [x + step, y - step], [x, y - step]].forEach(([wx, wy], i) => {
      const [px, py] = this.toCanvas(wx, wy);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.closePath();
  }

  drawGrid() {
    const { ctx } = this, { size: n, correctLabel } = this.data.grid;
    const highlight = (label, color, fill) => {
      if (!label) return;
      this.gridPolygon(label);
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    };
    if (this.reveal) {
      if (this.reveal.chosen !== correctLabel) highlight(this.reveal.chosen, COLORS.wrong, 'rgba(255,107,94,0.22)');
      highlight(correctLabel, COLORS.correct, 'rgba(95,208,138,0.22)');
    } else {
      highlight(this.selection, '#ffd666', 'rgba(255,214,102,0.18)');
      if (this.pickable && this.hover !== this.selection) highlight(this.hover, '#ffd666', 'rgba(255,214,102,0.10)');
    }
    ctx.strokeStyle = 'rgba(125,185,219,0.65)'; ctx.lineWidth = 0.7;
    const extent = this.gridExtent(), L = extent.size;
    const left = extent.x - L / 2, bottom = extent.y - L / 2;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      for (const ends of [[[i / n * L, 0], [i / n * L, L]], [[0, i / n * L], [L, i / n * L]]]) {
        const a = this.toCanvas(ends[0][0] + left, ends[0][1] + bottom), b = this.toCanvas(ends[1][0] + left, ends[1][1] + bottom);
        ctx.moveTo(...a); ctx.lineTo(...b);
      }
    }
    ctx.stroke();
    if (this.reveal?.camera && !this.data.grid.target) {
      const [x, y] = this.toCanvas(this.reveal.camera.x, this.reveal.camera.y);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = COLORS.correct; ctx.fill();
    }
  }

  drawGridLabels() {
    const { ctx } = this, n = this.data.grid.size, extent = this.gridExtent(), L = extent.size;
    const left = extent.x - L / 2, bottom = extent.y - L / 2;
    const label = (text, x, y, font = 10) => {
      ctx.font = `700 ${font}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = COLORS.bg; ctx.strokeText(text, x, y);
      ctx.fillStyle = '#bde0f5'; ctx.fillText(text, x, y);
    };
    // References come from the edge headers; keep cell interiors clear so the
    // contours stay readable at every grid size. Text stays upright on rotation.
    const offset = 11 / this.S * L;
    for (let i = 0; i < n; i++) {
      label(String(i + 1), ...this.toCanvas(left + (i + 0.5) / n * L, bottom + L + offset));
      label(String.fromCharCode(65 + i), ...this.toCanvas(left - offset, bottom + L - (i + 0.5) / n * L));
    }
  }

  drawGridTarget() {
    const target = this.data.grid.target;
    if (!this.reveal || !target || this.data.grid.origin === 'observer') return; // resection grids reveal YOU instead
    const { ctx } = this, [x, y] = this.toCanvas(target.x, target.y);
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.bg; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = COLORS.correct; ctx.fill();
    ctx.font = '700 10px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.strokeText(target.label || 'FRIEND', x, y - 11); ctx.fillText(target.label || 'FRIEND', x, y - 11);
  }

  prepareLines() {
    if (this._lines && this._linesKey === `${this.S}|${this.data.rotation}|${this.data.interval}`) return this._lines;
    const out = [];
    for (const c of this.contours) {
      for (const line of c.lines) {
        const src = chaikin(line.points, line.closed);
        const px = new Float32Array(src.length);
        for (let k = 0; k < src.length; k += 2) {
          const [x, y] = this.toCanvas(src[k], src[k + 1]);
          px[k] = x; px[k + 1] = y;
        }
        const depression = line.closed && ContourGenerator.signedArea(line.points) < 0;
        out.push({ level: c.level, index: c.index, closed: line.closed, px, world: line.points, depression });
      }
    }
    this._lines = out;
    this._linesKey = `${this.S}|${this.data.rotation}|${this.data.interval}`;
    return out;
  }

  /** Downhill tick marks on depression contours (right side of travel). */
  drawTicks(l) {
    const { ctx } = this;
    const p = l.px;
    let acc = 0;
    ctx.beginPath();
    for (let k = 2; k < p.length; k += 2) {
      const dx = p[k] - p[k - 2], dy = p[k + 1] - p[k - 1];
      const len = Math.hypot(dx, dy);
      acc += len;
      if (acc < 9 || len < 1e-6) continue;
      acc = 0;
      // Canvas y is flipped relative to the world, so the world's right side is canvas-left.
      const [ax, ay] = this.toCanvas(0, 0), [bx, by] = this.toCanvas(1, 0), [cx2, cy2] = this.toCanvas(0, 1);
      const mirrored = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax) < 0;
      const s = mirrored ? -1 : 1;
      const nx = (dy / len) * s, ny = (-dx / len) * s;
      const mx = (p[k] + p[k - 2]) / 2, my = (p[k + 1] + p[k - 1]) / 2;
      ctx.moveTo(mx, my);
      ctx.lineTo(mx + nx * 3.5, my + ny * 3.5);
    }
    ctx.stroke();
  }

  placeLabels(lines) {
    const labels = [];
    const markers = this.data.options.map((o) => this.toCanvas(o.x, o.y));
    const model = this.data.model;
    this.ctx.font = '600 10.5px system-ui, -apple-system, "Segoe UI", sans-serif';
    const candidates = lines.filter((l) => l.index).map((l) => {
      let len = 0;
      for (let k = 2; k < l.px.length; k += 2) len += Math.hypot(l.px[k] - l.px[k - 2], l.px[k + 1] - l.px[k - 1]);
      return { l, len };
    }).filter((c) => c.len > 70).sort((a, b) => b.len - a.len);

    for (const { l, len } of candidates) {
      const text = String(Math.round(l.level));
      const tw = this.ctx.measureText(text).width;
      const every = Math.max(260, len / 3);
      let acc = every * 0.45, placedOnLine = 0;
      const p = l.px;
      for (let k = 2; k < p.length - 2 && placedOnLine < 3; k += 2) {
        acc += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
        if (acc < every) continue;
        // Straightness over a short window.
        const k0 = Math.max(0, k - 8), k1 = Math.min(p.length - 2, k + 8);
        const a0 = Math.atan2(p[k + 1] - p[k0 + 1], p[k] - p[k0]);
        const a1 = Math.atan2(p[k1 + 1] - p[k + 1], p[k1] - p[k]);
        let da = Math.abs(a0 - a1); if (da > Math.PI) da = 2 * Math.PI - da;
        if (da > 0.45) continue;
        const x = p[k], y = p[k + 1];
        if (markers.some(([mx, my]) => Math.hypot(mx - x, my - y) < 34)) continue;
        if (labels.some((o) => Math.hypot(o.x - x, o.y - y) < 70)) continue;
        if (x < 30 || y < 16 || x > this.cssW - 30 || y > this.cssH - 16) continue;
        let angle = Math.atan2(p[k1 + 1] - p[k0 + 1], p[k1] - p[k0]);
        // Cartographic convention: the top of the number faces uphill.
        const [wx, wy] = this.toWorld(x, y);
        const [ux, uy] = this.uphill(model, wx, wy);
        if (Math.sin(angle) * ux - Math.cos(angle) * uy < 0) angle += Math.PI;
        labels.push({ x, y, angle, text, w: tw });
        placedOnLine++;
        acc = 0;
      }
    }
    return labels;
  }

  /** Uphill direction in canvas space at a world point. */
  uphill(model, x, y) {
    const { gx, gy } = model.getGradient(x, y, model.cell * 2);
    const [ax, ay] = this.toCanvas(x, y);
    const [bx, by] = this.toCanvas(x + gx * 1000, y + gy * 1000);
    const l = Math.hypot(bx - ax, by - ay) || 1;
    return [(bx - ax) / l, (by - ay) / l];
  }

  drawHillshade() {
    const { model } = this.data;
    if (!this._hillshade) {
      const n = model.n, h = model.heights, cell = model.cell;
      const c = document.createElement('canvas');
      c.width = n; c.height = n;
      const cx = c.getContext('2d');
      const img = cx.createImageData(n, n);
      const lx = -0.5, ly = 0.5, lz = 0.7; // light from the north-west
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const gx = (h[j * n + Math.min(i + 1, n - 1)] - h[j * n + Math.max(i - 1, 0)]) / (2 * cell);
          const gy = (h[Math.min(j + 1, n - 1) * n + i] - h[Math.max(j - 1, 0) * n + i]) / (2 * cell);
          const l = Math.hypot(gx, gy, 1);
          const shade = (-gx * lx - gy * ly + lz) / l;
          const o = ((n - 1 - j) * n + i) * 4;
          const v = Math.max(0, Math.min(255, shade * 255));
          img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v;
          img.data[o + 3] = Math.round(Math.abs(shade - 0.7) * 260);
        }
      }
      cx.putImageData(img, 0, 0);
      this._hillshade = c;
    }
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.translate(this.cx, this.cy);
    ctx.rotate(Math.atan2(this.sin, this.cos));
    const L = model.size, extent = this.data.extent || { x: L / 2, y: L / 2, size: L };
    const scale = this.S / extent.size;
    ctx.drawImage(this._hillshade, -extent.x * scale, (extent.y - L) * scale, L * scale, L * scale);
    ctx.restore();
  }

  drawDrainage() {
    const { model } = this.data;
    const { accumulation, receiver } = model.drainage;
    const n = model.n, cell = model.cell;
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(90, 170, 255, 0.8)';
    for (let k = 0; k < accumulation.length; k++) {
      const a = accumulation[k];
      if (a < 120 || receiver[k] < 0) continue;
      const r = receiver[k];
      const [x0, y0] = this.toCanvas((k % n) * cell, Math.floor(k / n) * cell);
      const [x1, y1] = this.toCanvas((r % n) * cell, Math.floor(r / n) * cell);
      ctx.lineWidth = Math.min(3, 0.5 + Math.log10(a / 120) * 1.2);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
  }

  drawLandforms() {
    const { ctx } = this;
    const lm = this.data.landmarks;
    const tri = (x, y, r, up) => {
      ctx.beginPath();
      ctx.moveTo(x, y - r * up); ctx.lineTo(x + r * 0.9, y + r * 0.6 * up); ctx.lineTo(x - r * 0.9, y + r * 0.6 * up); ctx.closePath();
    };
    for (const s of lm.summits) {
      const [x, y] = this.toCanvas(s.x, s.y);
      ctx.fillStyle = s.kind === 'summit' ? '#ffb347' : '#ffd79a';
      tri(x, y, s.kind === 'summit' ? 6 : 4.5, 1); ctx.fill();
    }
    for (const s of lm.saddles) {
      const [x, y] = this.toCanvas(s.x, s.y);
      ctx.strokeStyle = '#c792ea'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y - 5, 5, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y + 5, 5, 1.2 * Math.PI, 1.8 * Math.PI); ctx.stroke();
    }
    for (const s of lm.depressions) {
      const [x, y] = this.toCanvas(s.x, s.y);
      ctx.fillStyle = '#7fdbff';
      tri(x, y, 5, -1); ctx.fill();
    }
  }

  drawTrails() {
    if (this.data.grid && !this.reveal) return;
    const { ctx } = this;
    for (const route of this.data.routes || this.data.options) {
      const color = this.data.grid ? '#ffd666' : TRAIL_COLORS[route.label];
      const active = !!this.reveal && this.viewing?.label === route.label, hovered = this.pickable && this.hover === route.label;
      ctx.globalAlpha = this.reveal && !route.correct && !active ? .5 : 1;
      const points = route.points.map((p) => this.toCanvas(p.x, p.y));
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const line = () => { ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); };
      line(); ctx.strokeStyle = COLORS.bg; ctx.lineWidth = active || hovered ? 7 : 6; ctx.stroke();
      const opacity = ctx.globalAlpha;
      ctx.globalAlpha = opacity * .48;
      line(); ctx.strokeStyle = color; ctx.lineWidth = active || hovered ? 3.8 : 3; ctx.stroke();
      ctx.globalAlpha = opacity;
      const trace = trailTracePoints(route.points, this.trailTime || 0, this.data.trailDuration || 12)
        .map(p => this.toCanvas(p.x, p.y));
      ctx.beginPath(); trace.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y)); ctx.stroke();
      if ((this.trailTime || 0) > 0 && trace.length) {
        const [x,y] = trace.at(-1);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
      const end = points.at(-1), before = points[Math.max(0, points.length - 5)], az = Math.atan2(end[1] - before[1], end[0] - before[0]);
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(end[0] + Math.cos(az) * 6, end[1] + Math.sin(az) * 6);
      for (const a of [az + 2.5, az - 2.5]) ctx.lineTo(end[0] + Math.cos(a) * 5, end[1] + Math.sin(a) * 5);
      ctx.closePath(); ctx.fill();
      if (this.reveal && route.correct) {
        line(); ctx.strokeStyle = '#fff3cf'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;
    // The moving dot is answer-only; showing it earlier would give the trail away.
    if (this.reveal && this.viewing) {
      const [x, y] = this.toCanvas(this.viewing.x, this.viewing.y);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = COLORS.bg; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
    }
  }

  drawTrailLabels() {
    if (this.data.grid && !this.reveal) return;
    const { ctx } = this;
    for (const route of this.data.routes || this.data.options) {
      if (this.data.grid) {
        const [x, y] = this.toCanvas(route.x, route.y);
        ctx.strokeStyle = '#ffd666'; ctx.fillStyle = COLORS.bg; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ffd666'; ctx.font = '700 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('START', x, y - 9);
        continue;
      }
      const [x, y] = this.toCanvas(route.x, route.y), color = TRAIL_COLORS[route.label];
      ctx.strokeStyle = color; ctx.fillStyle = COLORS.bg; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '800 13px system-ui';
      ctx.fillText(route.label, x, y + .5);
      if (this.reveal && route.correct) { ctx.fillStyle = '#fff3cf'; ctx.font = '800 12px system-ui'; ctx.fillText('✓', x, y - 21); }
    }
  }

  drawCone() {
    const v = this.viewing || (this.reveal && this.reveal.camera ? { ...this.reveal.camera, color: COLORS.coneLine } : this.data.observer);
    if (!v || !v.fov) return; // a bare observer point (map-reading modes) has no view wedge
    const { ctx } = this;
    const len = this.data.extent ? this.data.extent.size * 0.8 : 750;
    const a0 = ((v.heading - v.fov / 2) * Math.PI) / 180, a1 = ((v.heading + v.fov / 2) * Math.PI) / 180;
    const [ox, oy] = this.toCanvas(v.x, v.y);
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    for (let t = 0; t <= 16; t++) {
      const a = a0 + ((a1 - a0) * t) / 16;
      const [x, y] = this.toCanvas(v.x + Math.sin(a) * len, v.y + Math.cos(a) * len);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = COLORS.cone;
    ctx.fill();
    ctx.strokeStyle = v.color || COLORS.coneLine;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawMarkers() {
    const { ctx } = this;
    for (const o of this.data.options) {
      const [x, y] = this.toCanvas(o.x, o.y);
      let ring = COLORS.marker, fill = COLORS.bg, text = COLORS.marker;
      if (this.reveal) {
        if (o.correct) { ring = COLORS.correct; text = COLORS.correct; }
        else if (o.label === this.reveal.chosen) { ring = COLORS.wrong; text = COLORS.wrong; }
      }
      const hovered = this.pickable && this.hover === o.label;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.strokeStyle = ring;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, y, hovered ? 13.5 : 12, 0, Math.PI * 2);
      ctx.fillStyle = hovered ? '#27313b' : fill;
      ctx.fill();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = ring;
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.font = '700 13px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (o.label) ctx.fillText(o.label, x, y + 0.5);
      else { ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fillStyle = ring; ctx.fill(); }
    }
  }

  currentObserver() {
    // A hidden friend observer is revealed only after an answer. Comparison
    // views show the hypothetical observer, never the target's own POV.
    return this.data.friendMode ? this.viewing || this.reveal?.camera || this.data.observer : this.data.observer;
  }

  drawObserver() {
    const { ctx } = this, o = this.currentObserver(), [x, y] = this.toCanvas(o.x, o.y);
    ctx.fillStyle = '#ffd666'; ctx.strokeStyle = COLORS.bg; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
    ctx.font = '800 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.strokeText('YOU', x, y + 17); ctx.fillText('YOU', x, y + 17);
  }

  drawNorthArrow() {
    const { ctx } = this;
    if (this.data.grid) {
      const angle = (this.data.rotation || 0) * Math.PI / 180;
      const x = this.cssW - 12, y = 14, dx = Math.sin(angle), dy = -Math.cos(angle);
      ctx.strokeStyle = COLORS.marker; ctx.fillStyle = COLORS.marker; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - dx * 7, y - dy * 7); ctx.lineTo(x + dx * 7, y + dy * 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + dx * 9, y + dy * 9);
      ctx.lineTo(x + dx * 3 - dy * 3, y + dy * 3 + dx * 3);
      ctx.lineTo(x + dx * 3 + dy * 3, y + dy * 3 - dx * 3); ctx.closePath(); ctx.fill();
      ctx.font = '700 9px system-ui'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText('N', x - 12, y);
      return;
    }
    const L = this.data.model.size;
    const [ax, ay] = this.toCanvas(L / 2, L / 2), [bx, by] = this.toCanvas(L / 2, L / 2 + 1);
    const l = Math.hypot(bx - ax, by - ay);
    const dx = (bx - ax) / l, dy = (by - ay) / l;
    const ox = this.cssW - 64, oy = 46;
    ctx.fillStyle = 'rgba(21, 26, 32, 0.8)';
    ctx.beginPath(); ctx.arc(ox, oy, 38, 0, Math.PI * 2); ctx.fill();
    const x0 = ox - dx * 26, y0 = oy - dy * 26, x1 = ox + dx * 26, y1 = oy + dy * 26;
    ctx.strokeStyle = COLORS.marker; ctx.fillStyle = COLORS.marker; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1 + dx * 4, y1 + dy * 4);
    ctx.lineTo(x1 - dx * 6 - dy * 4, y1 - dy * 6 + dx * 4);
    ctx.lineTo(x1 - dx * 6 + dy * 4, y1 - dy * 6 - dx * 4);
    ctx.closePath(); ctx.fill();
    ctx.font = '700 13px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', x0 - dx * 10, y0 - dy * 10);
  }

  drawScaleBar() {
    const { ctx } = this;
    if (this.data.grid) {
      ctx.fillStyle = COLORS.marker; ctx.font = '500 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(`${Math.round(this.gridExtent().size / this.data.grid.size)} m per cell · ${this.data.interval} m contours`, this.cx, this.cssH - 4);
      return;
    }
    const L = this.data.extent?.size || this.data.model.size;
    const pxPerM = this.S / L;
    const metres = this.data.extent ? [25, 50, 100, 250, 500].filter((m) => m * pxPerM <= 140).at(-1) || 25
      : pxPerM * 500 > 140 ? 250 : 500;
    const len = metres * pxPerM;
    const x = 22, y = this.cssH - 20;
    ctx.fillStyle = 'rgba(21, 26, 32, 0.75)';
    ctx.fillRect(x - 6, y - 26, len + 70, 34);
    ctx.strokeStyle = COLORS.marker; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 4); ctx.stroke();
    ctx.fillStyle = COLORS.marker;
    ctx.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${metres} m`, x + len + 8, y + 1);
    ctx.fillText(`${this.data.interval} m contours`, x, y - 12);
  }
}
