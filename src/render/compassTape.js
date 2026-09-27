// Bearing tape drawn over the top of the first-person view.

import { INTERCARDINALS } from '../engine/heading.js';

const SHORT = { NORTH: 'N', 'NORTH-EAST': 'NE', EAST: 'E', 'SOUTH-EAST': 'SE', SOUTH: 'S', 'SOUTH-WEST': 'SW', WEST: 'W', 'NORTH-WEST': 'NW' };

/**
 * Draws onto `canvas` sized to its CSS box, or - with `target` - onto an
 * existing 2D context inside the rectangle {x, y, width, height, scale}.
 */
export function drawCompassTape(canvas, camera, { exact = false, target = null } = {}) {
  let ctx, w;
  if (target) {
    ctx = target.ctx;
    w = target.width / target.scale;
    ctx.save();
    ctx.translate(target.x, target.y);
    ctx.scale(target.scale, target.scale);
  } else {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
  }
  const half = (camera.fov / 2) * Math.PI / 180;
  const f = (w / 2) / Math.tan(half);
  const y = 0;
  const grad = ctx.createLinearGradient(0, 0, 0, 30);
  grad.addColorStop(0, 'rgba(10, 14, 18, 0.55)');
  grad.addColorStop(1, 'rgba(10, 14, 18, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, 30);
  ctx.strokeStyle = 'rgba(240, 236, 226, 0.75)';
  ctx.fillStyle = 'rgba(240, 236, 226, 0.92)';
  ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const start = Math.floor(camera.heading - camera.fov / 2 - 5), end = Math.ceil(camera.heading + camera.fov / 2 + 5);
  for (let b = start; b <= end; b++) {
    if (b % 5 !== 0) continue;
    const rel = ((b - camera.heading) * Math.PI) / 180;
    if (Math.abs(rel) >= Math.PI / 2) continue;
    const x = w / 2 + Math.tan(rel) * f;
    if (x < 4 || x > w - 4) continue;
    const bearing = ((b % 360) + 360) % 360;
    const major = bearing % 45 === 0;
    const mid = bearing % 15 === 0;
    ctx.lineWidth = major ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + (major ? 10 : mid ? 7 : 4));
    ctx.stroke();
    if (major) ctx.fillText(SHORT[INTERCARDINALS[bearing / 45]], x, y + 12);
    else if (exact && mid) ctx.fillText(String(bearing).padStart(3, '0'), x, y + 10);
  }
  // Centre marker.
  ctx.fillStyle = 'rgba(255, 214, 102, 0.95)';
  ctx.beginPath();
  ctx.moveTo(w / 2 - 5, 0); ctx.lineTo(w / 2 + 5, 0); ctx.lineTo(w / 2, 6); ctx.closePath(); ctx.fill();
  if (target) ctx.restore();
}
