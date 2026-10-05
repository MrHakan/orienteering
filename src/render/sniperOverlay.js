// 2D layer for sniper mode, shared by the live scene and exports: the enemy
// spot while observing (the 3D rifle is drawn by the renderer), then the scope picture with a BDC
// reticle. Horizontal stadia are in mils (2/4/6/8); the vertical marks are the
// rifle's bullet-drop holds for 200–1000 m, placed from the same ballistics
// that decide the answer, so they spread out with range like a real BDC.

import { MARKS, MARK_MILS, SCOPE_CIRCLE, pixelsPerMil } from '../engine/sniper.js';
import { smoothstep } from '../engine/grid.js';

const DEG = Math.PI / 180;

/** Screen position of a world direction for the frame's camera (null when behind). */
function project(camera, bearing, elevation, w, h) {
  const tanH = Math.tan(camera.fov * DEG / 2), tanV = tanH / (w / h);
  const dx = ((bearing - camera.heading + 540) % 360) - 180, dy = elevation - camera.pitch;
  if (Math.abs(dx) >= 89) return null;
  return { x: w / 2 + Math.tan(dx * DEG) / tanH * w / 2, y: h / 2 - Math.tan(dy * DEG) / tanV * h / 2 };
}

function drawSpot(ctx, p, alpha, s) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(p.x, p.y - 22 * s);
  ctx.fillStyle = '#e8463c'; ctx.strokeStyle = 'rgba(20, 8, 8, .8)'; ctx.lineWidth = 2 * s;
  ctx.beginPath(); ctx.moveTo(0, -10 * s); ctx.lineTo(9 * s, 0); ctx.lineTo(0, 10 * s); ctx.lineTo(-9 * s, 0); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 2.2 * s, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawReticle(ctx, cx, cy, ppm, radius, alpha) {
  const line = Math.max(1, ppm * 0.07), post = Math.max(3, ppm * 0.42);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#050505'; ctx.fillStyle = '#050505';
  ctx.lineCap = 'butt';
  // Thick posts from the scope edge.
  ctx.fillRect(cx - radius, cy - post / 2, radius - 8 * ppm, post);
  ctx.fillRect(cx + 8 * ppm, cy - post / 2, radius - 8 * ppm, post);
  ctx.fillRect(cx - post / 2, cy - radius, post, radius - 7.8 * ppm);
  const bottom = MARK_MILS[1000] + 1.6;
  ctx.fillRect(cx - post / 2, cy + bottom * ppm, post, radius);
  // Small crosses on the posts (like a range card reference).
  ctx.lineWidth = line;
  for (const [x, y, dx, dy] of [[-10.3, 0, 0, 1], [10.3, 0, 0, 1], [0, -9.9, 1, 0]]) {
    ctx.beginPath(); ctx.moveTo(cx + (x - dx * 0.8) * ppm, cy + (y - dy * 0.8) * ppm); ctx.lineTo(cx + (x + dx * 0.8) * ppm, cy + (y + dy * 0.8) * ppm); ctx.stroke();
  }
  // Fine crosshair: horizontal ±8 mil, vertical up 7.8 mil and down past the 1000 m mark.
  ctx.beginPath();
  ctx.moveTo(cx - 8 * ppm, cy); ctx.lineTo(cx + 8 * ppm, cy);
  ctx.moveTo(cx, cy - 7.8 * ppm); ctx.lineTo(cx, cy + bottom * ppm);
  ctx.stroke();
  // Mil stadia: ticks every 0.5 mil, longer each mil; numbers 2/4/6/8 under the right arm.
  for (let m = -8; m <= 8; m += 0.5) {
    if (!m) continue;
    const big = Number.isInteger(m), len = (big ? 0.42 : 0.24) * ppm;
    ctx.beginPath(); ctx.moveTo(cx + m * ppm, cy - len); ctx.lineTo(cx + m * ppm, cy + len); ctx.stroke();
  }
  for (let m = -7; m < 0; m += 0.5) {
    const len = (Number.isInteger(m) ? 0.42 : 0.24) * ppm;
    ctx.beginPath(); ctx.moveTo(cx - len, cy + m * ppm); ctx.lineTo(cx + len, cy + m * ppm); ctx.stroke();
  }
  const font = Math.max(9, ppm * 0.95);
  ctx.font = `600 ${font}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const m of [2, 4, 6, 8]) ctx.fillText(String(m), cx + m * ppm, cy + 0.9 * ppm);
  // BDC holds (hundreds of metres): every mark ticked, even ones numbered with widening wind wings.
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const metres of MARKS.slice(1)) {
    const y = cy + MARK_MILS[metres] * ppm, even = metres % 200 === 0;
    const half = (even ? 0.5 + metres / 1000 * 1.6 : 0.35) * ppm;
    ctx.beginPath(); ctx.moveTo(cx - half, y); ctx.lineTo(cx + half, y); ctx.stroke();
    if (even && metres >= 400) for (const k of [-1, 1]) for (let i = 1; i <= Math.round(metres / 250); i++) {
      const x = cx + k * i * 0.5 * ppm; // wind wing ticks every 0.5 mil
      if (Math.abs(x - cx) > half) break;
      ctx.beginPath(); ctx.moveTo(x, y - 0.18 * ppm); ctx.lineTo(x, y + 0.18 * ppm); ctx.stroke();
    }
    if (even) ctx.fillText(String(metres / 100), cx - half - 0.35 * ppm, y);
  }
  ctx.restore();
}

/**
 * Wind call (optional mode): speed, the direction it comes from, an arrow of
 * where it blows relative to the view, and the rifle's wind card. Top-left
 * while observing; in the black margin beside the lens through the scope.
 */
function drawWindHud(ctx, quiz, frame, w, h, s) {
  const wind = quiz.sniper.wind;
  if (!wind) return;
  const scoped = frame.raise >= 0.6;
  const margin = scoped ? (w - 2 * SCOPE_CIRCLE * Math.min(w, h)) / 2 : w;
  if (scoped && margin < 120 * s) return; // no room beside the lens (portrait)
  const font = Math.max(10, 15 * s), line = font * 1.32, x = 12 * s + 4, top = (scoped ? 16 : 44) * s + 6;
  const rows = wind.card.map((c) => [`${c.metres} m`, c.milPerMps.toFixed(2)]);
  const boxW = Math.min(scoped ? margin - 20 * s : 240 * s, 250 * s), boxH = line * (rows.length + 3.4);
  ctx.save();
  ctx.fillStyle = scoped ? 'rgba(0, 0, 0, 0)' : 'rgba(10, 14, 18, .66)';
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - 6, top - 4, boxW, boxH, 8) : ctx.rect(x - 6, top - 4, boxW, boxH); ctx.fill();
  ctx.fillStyle = '#ffd666'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = `800 ${font}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText(`WIND ${wind.speed.toFixed(1)} m/s`, x, top);
  ctx.font = `600 ${font * 0.86}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillStyle = '#e9e4d8';
  ctx.fillText(`FROM ${String(wind.from).padStart(3, '0')}°`, x, top + line);
  // Arrow: where the air moves, seen from above with the view direction up.
  const ax = x + boxW - 34 * s, ay = top + line * 0.9, r = 13 * s;
  const a = ((wind.from + 180 - frame.camera.heading) * Math.PI) / 180;
  ctx.strokeStyle = '#ffd666'; ctx.lineWidth = 2.2 * s;
  ctx.beginPath(); ctx.arc(ax, ay, r + 4 * s, 0, Math.PI * 2); ctx.globalAlpha = 0.35; ctx.stroke(); ctx.globalAlpha = 1;
  const dx = Math.sin(a), dy = -Math.cos(a);
  ctx.beginPath(); ctx.moveTo(ax - dx * r, ay - dy * r); ctx.lineTo(ax + dx * r, ay + dy * r); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ax + dx * r, ay + dy * r);
  ctx.lineTo(ax + dx * r * 0.35 - dy * r * 0.45, ay + dy * r * 0.35 + dx * r * 0.45);
  ctx.lineTo(ax + dx * r * 0.35 + dy * r * 0.45, ay + dy * r * 0.35 - dx * r * 0.45); ctx.closePath(); ctx.fillStyle = '#ffd666'; ctx.fill();
  ctx.fillStyle = '#cfd3d6'; ctx.font = `700 ${font * 0.72}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText('WIND CARD · mil per 1 m/s', x, top + line * 2.25);
  ctx.font = `600 ${font * 0.8}px ui-monospace, Menlo, Consolas, monospace`;
  rows.forEach(([range, mil], i) => {
    const y = top + line * (3.1 + i * 0.92);
    ctx.fillStyle = '#e9e4d8'; ctx.fillText(range, x, y);
    ctx.fillStyle = '#ffd666'; ctx.textAlign = 'right'; ctx.fillText(mil, x + boxW - 18 * s, y); ctx.textAlign = 'left';
  });
  ctx.restore();
}

/**
 * Draw the sniper layer into a scene rectangle. `frame` comes from sniperFrame().
 * `spot` marks the enemy while observing (location only — never the range).
 */
export function drawSniperOverlay(ctx, quiz, frame, { x = 0, y = 0, width: w, height: h, spot = true } = {}) {
  const s = Math.min(w, h * 1.6) / 1000;
  const raise = frame.raise, scopeAlpha = smoothstep(0.15, 1, raise);
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.translate(x, y);
  if (raise < 1) {
    const target = quiz.sniper;
    const p = project(frame.camera, target.bearing, target.elevation, w, h);
    if (spot && p && p.x > 0 && p.x < w && p.y > 0 && p.y < h) drawSpot(ctx, p, 1 - smoothstep(0, 0.4, raise), Math.max(0.8, s * 1.4));
  }
  if (raise > 0) {
    const R = SCOPE_CIRCLE * Math.min(w, h), cx = w / 2, cy = h / 2;
    const far = Math.hypot(w, h);
    const r = far + (R - far) * smoothstep(0, 1, raise);
    // Black housing outside the lens, with a soft inner edge.
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.arc(cx, cy, r, 0, Math.PI * 2, true); ctx.fill('evenodd');
    const edge = ctx.createRadialGradient(cx, cy, r * 0.78, cx, cy, r);
    edge.addColorStop(0, 'rgba(0,0,0,0)'); edge.addColorStop(0.75, 'rgba(0,0,0,.35)'); edge.addColorStop(1, 'rgba(0,0,0,.95)');
    ctx.fillStyle = edge;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    if (scopeAlpha > 0.01) {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
      drawReticle(ctx, cx, cy, pixelsPerMil(w, h), r, scopeAlpha);
      ctx.restore();
    }
  }
  drawWindHud(ctx, quiz, frame, w, h, s);
  ctx.restore();
}
