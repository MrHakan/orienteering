import { wrap360 } from '../engine/grid.js';

/** Signed horizontal offset from the starting view, never a compass bearing. */
export function relativeBearing(heading, startHeading, arc = null) {
  let turn = wrap360(heading - startHeading + 180) - 180;
  // Preserve the sampler's chosen turn through 180° and tiny solar drift.
  if (Number.isFinite(arc)) turn += 360 * Math.round((arc - turn) / 360);
  const degrees = Math.round(Math.abs(turn));
  const side = degrees === 0 ? 'start' : turn > 0 ? 'right' : 'left';
  return { side, degrees, text: `${side.toUpperCase()} ${degrees}°` };
}

/** The same relative readout on PNGs, video frames and export previews. */
export function drawRelativeBearing(ctx, bearing, { x, y, width, scale = 1 }) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  const left = width / scale - 180;
  ctx.fillStyle = 'rgba(10, 14, 18, .82)';
  ctx.beginPath(); ctx.roundRect(left, 12, 168, 52, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(255, 214, 102, .45)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = '600 9px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = '#cfd3d6'; ctx.fillText('FROM START', left + 84, 20);
  ctx.font = '700 18px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = '#ffd666'; ctx.fillText(bearing.text, left + 84, 34);
  ctx.restore();
}
