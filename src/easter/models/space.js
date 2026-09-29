// Code-drawn space models for the May the Fourth scene: Death Star, Star
// Destroyer, TIE fighter and the explosion. Original vector art in local
// pixel units (y down). Pure functions of their arguments: no clock, no
// Math.random. Small deterministic hashes provide surface detail.

const TAU = Math.PI * 2;

/** Deterministic value in [0,1) from integers. */
export function hash01(i, salt = 0) {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const easeOut = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

// ------------------------------------------------------------------ Death Star

/**
 * Battle station: shaded sphere, restrained panel detail, equatorial trench
 * and a superlaser dish that glows green as `charge` (0..1) rises.
 * Centre at (x, y), radius r.
 */
export function drawDeathStar(ctx, { x = 0, y = 0, r = 60, charge = 0, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);

  // Sphere, lit from the upper left.
  const g = ctx.createRadialGradient(-0.38 * r, -0.42 * r, 0.08 * r, 0, 0, 1.02 * r);
  g.addColorStop(0, '#e6e9ed'); g.addColorStop(0.35, '#b4b9c0'); g.addColorStop(0.7, '#6c727a');
  g.addColorStop(0.92, '#30353b'); g.addColorStop(1, '#171a1e');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();

  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.clip();

  // Panel lines: latitudes (front half) and a few meridians.
  ctx.lineWidth = Math.max(0.6, r * 0.011);
  ctx.strokeStyle = 'rgba(15, 20, 26, 0.16)';
  for (let k = -3; k <= 3; k++) {
    if (k === 0) continue;
    const cy = k * 0.24 * r, rx = Math.sqrt(Math.max(0, r * r - cy * cy));
    ctx.beginPath(); ctx.ellipse(0, cy, rx, rx * 0.12, 0, 0, Math.PI); ctx.stroke();
  }
  for (const a of [0.3, 0.75, 1.15]) {
    ctx.beginPath(); ctx.ellipse(0, 0, r * Math.cos(a), r, 0, -Math.PI / 2, Math.PI / 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0, 0, r * Math.cos(a), r, 0, Math.PI / 2, Math.PI * 1.5); ctx.stroke();
  }
  // Greebles: sparse tiny plates, kept faint.
  for (let i = 0; i < 64; i++) {
    const a = hash01(i, 1) * TAU, d = Math.sqrt(hash01(i, 2)) * r * 0.96;
    const w = r * (0.015 + hash01(i, 3) * 0.045), h = r * (0.01 + hash01(i, 4) * 0.03);
    ctx.fillStyle = hash01(i, 5) > 0.5 ? 'rgba(20, 25, 32, 0.13)' : 'rgba(235, 240, 245, 0.10)';
    ctx.fillRect(Math.cos(a) * d - w / 2, Math.sin(a) * d - h / 2, w, h);
  }

  // Equatorial trench: the lower half of a slightly tilted ellipse (viewed from above).
  ctx.save();
  ctx.rotate(-0.09);
  const ty = r * 0.16;
  ctx.strokeStyle = 'rgba(8, 10, 14, 0.85)'; ctx.lineWidth = Math.max(1.4, r * 0.06);
  ctx.beginPath(); ctx.ellipse(0, 0, r * 1.01, ty, 0, 0, Math.PI); ctx.stroke();
  ctx.strokeStyle = 'rgba(225, 230, 236, 0.32)'; ctx.lineWidth = Math.max(0.7, r * 0.018);
  ctx.beginPath(); ctx.ellipse(0, r * 0.05, r * 1.01, ty, 0, 0.05, Math.PI - 0.05); ctx.stroke();
  for (let i = 0; i < 16; i++) { // trench lights
    const a = 0.12 + (i / 15) * (Math.PI - 0.24);
    ctx.fillStyle = `rgba(255, 236, 180, ${0.35 + 0.35 * hash01(i, 9)})`;
    ctx.fillRect(Math.cos(a) * r * 0.99 - 0.6, Math.sin(a) * ty * 0.99 - 0.6, 1.2, 1.2);
  }
  ctx.restore();

  // Superlaser dish (upper right of the face).
  const cx = 0.3 * r, cy = -0.3 * r, dr = 0.215 * r;
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(-0.78);
  ctx.scale(0.9, 1);
  const bowl = ctx.createRadialGradient(0.25 * dr, 0.25 * dr, 0, 0, 0, dr);
  bowl.addColorStop(0, '#c9ced5'); bowl.addColorStop(0.55, '#6a7078'); bowl.addColorStop(1, '#23272c');
  ctx.fillStyle = bowl; ctx.beginPath(); ctx.arc(0, 0, dr, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(10, 12, 16, 0.9)'; ctx.lineWidth = dr * 0.2;
  ctx.beginPath(); ctx.arc(0, 0, dr * 1.0, 0, TAU); ctx.stroke();
  ctx.strokeStyle = 'rgba(230, 235, 240, 0.45)'; ctx.lineWidth = Math.max(0.6, dr * 0.05);
  ctx.beginPath(); ctx.arc(0, 0, dr * 0.9, Math.PI * 0.85, Math.PI * 1.75); ctx.stroke();
  ctx.strokeStyle = 'rgba(15, 18, 24, 0.55)'; ctx.lineWidth = Math.max(0.6, dr * 0.05);
  ctx.beginPath(); ctx.arc(0, 0, dr * 0.55, 0, TAU); ctx.stroke();
  for (let i = 0; i < 6; i++) { // converging emitter struts
    const a = (i / 6) * TAU + 0.3;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * dr * 0.85, Math.sin(a) * dr * 0.85); ctx.lineTo(Math.cos(a) * dr * 0.2, Math.sin(a) * dr * 0.2); ctx.stroke();
  }
  ctx.fillStyle = charge > 0 ? `rgb(${Math.round(150 + 100 * charge)}, 255, ${Math.round(160 + 60 * charge)})` : '#161a1f';
  ctx.beginPath(); ctx.arc(0, 0, dr * 0.17, 0, TAU); ctx.fill();
  ctx.restore();
  ctx.restore(); // sphere clip

  // Charge glow (drawn additively, may spill past the dish rim).
  if (charge > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const gr = dr * (1.3 + 1.6 * charge);
    const gl = ctx.createRadialGradient(cx, cy, 0, cx, cy, gr);
    gl.addColorStop(0, `rgba(150, 255, 170, ${0.25 + 0.65 * charge})`);
    gl.addColorStop(0.35, `rgba(70, 230, 110, ${0.18 + 0.35 * charge})`);
    gl.addColorStop(1, 'rgba(40, 200, 90, 0)');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(cx, cy, gr, 0, TAU); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// -------------------------------------------------------------- Star Destroyer

/** Native size of a Star Destroyer (scale 1), nose towards +x. */
export const STAR_DESTROYER = { length: 142, height: 58 };

/** Wedge-shaped capital ship with a bridge tower, engine glows and hull detail. */
export function drawStarDestroyer(ctx, { x = 0, y = 0, scale = 1, alpha = 1, flip = false } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.scale(flip ? -scale : scale, scale);

  const N = [70, 4], A = [-70, -13], B = [-70, 9], C = [-70, 21];
  const poly = (pts) => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.closePath(); };

  // Underside / lower hull.
  poly([N, B, C]);
  ctx.fillStyle = '#434a53'; ctx.fill();
  // Upper hull.
  const top = ctx.createLinearGradient(-70, 0, 70, 0);
  top.addColorStop(0, '#78808a'); top.addColorStop(1, '#bcc2ca');
  poly([N, A, B]); ctx.fillStyle = top; ctx.fill();
  ctx.strokeStyle = 'rgba(15, 18, 24, 0.7)'; ctx.lineWidth = 0.8;
  poly([N, A, B]); ctx.stroke(); poly([N, B, C]); ctx.stroke();

  // Surface detail: spine trench, plate seams, panel ticks and running lights.
  ctx.strokeStyle = 'rgba(25, 30, 38, 0.55)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-60, -2); ctx.lineTo(52, 3.4); ctx.stroke();
  ctx.strokeStyle = 'rgba(25, 30, 38, 0.28)'; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(-70, -8); ctx.lineTo(60, 3.8); ctx.moveTo(-70, 3); ctx.lineTo(60, 4.2); ctx.stroke();
  for (let i = 0; i < 14; i++) {
    const px = -62 + i * 9;
    const yc = -2 + (px + 60) * (5.4 / 112);
    ctx.beginPath(); ctx.moveTo(px, yc - 3); ctx.lineTo(px + 1.5, yc + 3); ctx.stroke();
  }
  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = `rgba(255, 240, 190, ${0.25 + 0.4 * hash01(i, 21)})`;
    const px = -64 + i * 7.4;
    ctx.fillRect(px, -2 + (px + 60) * 0.048 + (hash01(i, 22) - 0.5) * 9, 1, 1);
  }

  // Bridge tower: base, neck, bridge deck with two shield domes.
  ctx.fillStyle = '#a2aab4'; ctx.fillRect(-54, -16, 26, 14);
  ctx.fillStyle = '#7d858f'; ctx.fillRect(-54, -6, 26, 4);
  ctx.fillStyle = '#95a0aa'; ctx.fillRect(-47, -26, 12, 10);
  ctx.fillStyle = '#c3c9d0'; ctx.fillRect(-54, -31, 26, 5);
  ctx.fillStyle = '#7d858f'; ctx.fillRect(-54, -27, 26, 1.4);
  ctx.fillStyle = '#d5dae0';
  ctx.beginPath(); ctx.arc(-50, -33.5, 3, 0, TAU); ctx.arc(-32, -33.5, 3, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(20, 24, 30, 0.6)'; ctx.lineWidth = 0.7;
  ctx.strokeRect(-54, -16, 26, 14); ctx.strokeRect(-54, -31, 26, 5);
  ctx.fillStyle = 'rgba(255, 245, 200, 0.75)';
  for (let i = 0; i < 8; i++) ctx.fillRect(-52 + i * 3.1, -29.2, 1.2, 1.2);

  // Engines.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const ey of [11, 15.5, 20]) {
    const gl = ctx.createRadialGradient(-71, ey, 0, -71, ey, 6);
    gl.addColorStop(0, 'rgba(190, 225, 255, 0.95)'); gl.addColorStop(1, 'rgba(80, 140, 255, 0)');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(-71, ey, 6, 0, TAU); ctx.fill();
  }
  ctx.restore();
  ctx.restore();
}

// ------------------------------------------------------------------ TIE fighter

/** Native size of a TIE fighter (scale 1). */
export const TIE_FIGHTER = { width: 42, height: 22 };

/** Ball cockpit, two struts and twin hexagonal wing panels. Centre at (x, y). */
export function drawTieFighter(ctx, { x = 0, y = 0, scale = 1, alpha = 1, roll = 0 } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(roll);
  ctx.scale(scale, scale);

  const wing = (cx) => {
    ctx.save();
    ctx.translate(cx, 0);
    const hex = [];
    for (let k = 0; k < 6; k++) hex.push([Math.cos((k * Math.PI) / 3) * 6.8, Math.sin((k * Math.PI) / 3) * 11.5]);
    ctx.beginPath(); ctx.moveTo(hex[0][0], hex[0][1]); for (const p of hex.slice(1)) ctx.lineTo(p[0], p[1]); ctx.closePath();
    ctx.fillStyle = '#1b1f25'; ctx.fill();
    ctx.strokeStyle = '#9098a3'; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.strokeStyle = 'rgba(120, 130, 142, 0.55)'; ctx.lineWidth = 0.7;
    ctx.beginPath(); for (const p of hex) { ctx.moveTo(0, 0); ctx.lineTo(p[0], p[1]); } ctx.stroke();
    ctx.fillStyle = '#3a414a'; ctx.beginPath(); ctx.arc(0, 0, 1.8, 0, TAU); ctx.fill();
    ctx.restore();
  };

  // Struts first (behind the cockpit), then wings, then the ball.
  ctx.strokeStyle = '#59616b'; ctx.lineWidth = 2.6; ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(14, 0); ctx.stroke();
  wing(-15.5); wing(15.5);
  const c = ctx.createRadialGradient(-1.6, -1.8, 0.5, 0, 0, 5.6);
  c.addColorStop(0, '#9aa3ad'); c.addColorStop(1, '#2a3037');
  ctx.fillStyle = c; ctx.beginPath(); ctx.arc(0, 0, 5.4, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#0d1014'; ctx.lineWidth = 0.8; ctx.stroke();
  ctx.fillStyle = '#0e1216'; ctx.beginPath(); ctx.arc(0, 0, 3.1, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(150, 160, 172, 0.6)'; ctx.lineWidth = 0.55;
  ctx.beginPath(); for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * 3.1, Math.sin(a) * 3.1); } ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 1.6, 0, TAU); ctx.stroke();
  ctx.restore();
}

// -------------------------------------------------------------------- Explosion

/** Peak flash alpha and its timing: one bright pulse, no repeats. */
export const FLASH = { peak: 0.6, rise: 0.05, decay: 0.16 };

/** Sky-wide flash strength `age` seconds after the detonation (0 before it). */
export function flashAlpha(age) {
  if (age <= 0) return 0;
  return FLASH.peak * smooth(0, FLASH.rise, age) * Math.exp(-Math.max(0, age - FLASH.rise) / FLASH.decay);
}

/**
 * Fireball, shockwave ring, sparks and debris around (x, y) at `age` seconds
 * after detonation. r is the size of the object that exploded.
 */
export function drawExplosion(ctx, { x = 0, y = 0, r = 60, age = 0, alpha = 1 } = {}) {
  if (age <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.globalCompositeOperation = 'lighter';

  const fadeAll = 1 - smooth(1.5, 3.1, age);
  // Fireball.
  const R = r * (0.55 + 2.1 * easeOut(age / 1.5));
  const fa = fadeAll * (1 - smooth(0.6, 2.4, age) * 0.4);
  const fb = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  fb.addColorStop(0, `rgba(255, 255, 240, ${0.95 * fa})`);
  fb.addColorStop(0.28, `rgba(255, 215, 120, ${0.85 * fa})`);
  fb.addColorStop(0.6, `rgba(255, 110, 40, ${0.55 * fa})`);
  fb.addColorStop(1, 'rgba(170, 30, 10, 0)');
  ctx.fillStyle = fb; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();

  // Shockwave ring.
  const ra = 1 - smooth(0, 2.3, age);
  if (ra > 0.01) {
    ctx.strokeStyle = `rgba(255, 240, 205, ${0.75 * ra})`;
    ctx.lineWidth = 0.5 + 3.2 * ra;
    ctx.beginPath(); ctx.arc(0, 0, r * (0.8 + 4.2 * easeOut(age / 2.3)), 0, TAU); ctx.stroke();
  }

  // Sparks: thin radial streaks.
  for (let i = 0; i < 40; i++) {
    const a = hash01(i, 31) * TAU, v = r * (1.4 + hash01(i, 32) * 3.2);
    const d0 = v * easeOut(age / 1.8), d1 = Math.max(0, v * easeOut((age - 0.12) / 1.8));
    const life = 1 - smooth(0.5 + hash01(i, 33) * 0.9, 1.6 + hash01(i, 33) * 1.2, age);
    if (life <= 0.01) continue;
    ctx.strokeStyle = `rgba(255, ${170 + Math.round(70 * hash01(i, 34))}, 90, ${0.8 * life})`;
    ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * d1, Math.sin(a) * d1); ctx.lineTo(Math.cos(a) * d0, Math.sin(a) * d0); ctx.stroke();
  }
  ctx.restore();

  // Debris: ordinary compositing, tumbling grey plates that cool from orange.
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  for (let i = 0; i < 22; i++) {
    const a = hash01(i, 41) * TAU, v = r * (0.9 + hash01(i, 42) * 2.3);
    const d = v * easeOut(age / 2.4);
    const life = 1 - smooth(1.6, 3.0, age);
    if (life <= 0.01) continue;
    const s = r * (0.03 + hash01(i, 43) * 0.07);
    const heat = 1 - smooth(0, 1.4, age);
    ctx.save();
    ctx.translate(Math.cos(a) * d, Math.sin(a) * d);
    ctx.rotate(hash01(i, 44) * TAU + age * (hash01(i, 45) - 0.5) * 6);
    ctx.fillStyle = `rgba(${Math.round(90 + 165 * heat)}, ${Math.round(94 + 70 * heat)}, ${Math.round(100 - 30 * heat)}, ${life})`;
    ctx.beginPath(); ctx.moveTo(-s, -s * 0.6); ctx.lineTo(s * 1.1, -s * 0.2); ctx.lineTo(-s * 0.2, s); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** Dev gallery: every model side by side (scripts/easter-models.html). */
export function drawGallery(ctx, { x, y, w, h, t = 0 }) {
  drawDeathStar(ctx, { x: x + 110, y: y + 110, r: 90, charge: 0 });
  drawDeathStar(ctx, { x: x + 320, y: y + 110, r: 90, charge: 0.85 });
  drawStarDestroyer(ctx, { x: x + 560, y: y + 110, scale: 2.4 });
  drawStarDestroyer(ctx, { x: x + 820, y: y + 60, scale: 1 });
  drawTieFighter(ctx, { x: x + 820, y: y + 150, scale: 2 });
  drawTieFighter(ctx, { x: x + 900, y: y + 60, scale: 1.2 });
  for (let i = 0; i < 4; i++) {
    const age = [0.05, 0.4, 1.0, 2.0][i];
    drawDeathStar(ctx, { x: x + 1030 + i * 105, y: y + 60, r: 40, alpha: 1 - smooth(0, 0.35, age) });
    drawExplosion(ctx, { x: x + 1030 + i * 105, y: y + 60, r: 40, age });
  }
  void w; void h; void t;
}
