// May the Fourth: a brief space scene in the sky above the horizon.
//
//    0.0  starfield fades in (and the sky dims a little)
//    1.2  Star Destroyers glide in; a TIE patrol crosses from the right
//    2.8  the Death Star slides in
//    6.4  superlaser charges (monotonic glow, no flicker)
//   11.0  Death Star explodes: one flash, fireball, shockwave, debris
//  11.15  TIE fighters emerge from the blast and fly away from it
//  14.3+  the global envelope fades everything out; the last frame is clean

import { clamp, lerp, smoothstep } from '../engine/grid.js';
import {
  drawDeathStar, drawStarDestroyer, drawTieFighter, drawExplosion, flashAlpha, hash01,
  STAR_DESTROYER,
} from './models/space.js';

export const TIMELINE = {
  starsIn: [0, 1.6],
  shipsIn: 1.2,
  tiePatrol: [2.4, 7.2],
  dsIn: [2.8, 5.8],
  charge: [6.4, 10.9],
  boom: 11.0,
  tieOut: 11.15,
};

const easeOut = (t) => 1 - (1 - clamp(t, 0, 1)) ** 3;

export function createMay4({ rng, stage, plan }) {
  const S = stage.scene;
  const left = stage.left, right = stage.right, W = S.w;
  const rm = plan.reducedMotion;

  // ---- Death Star: on the right half where the sky is tallest.
  let r = clamp(0.135 * S.h, 30, 78);
  let best = { h: -Infinity, x: left + 0.72 * W };
  for (let x = left + 0.5 * W; x <= left + 0.88 * W; x += 12) {
    const h = stage.minHeadroom(x - r, x + r);
    if (h >= best.h - 0.5) best = { h, x };
  }
  r = clamp((best.h - 14) / 2, 22, r);
  const ds = { x: best.x, y: stage.top + 8 + r, r };

  // ---- Star Destroyers: the best-headroom anchors away from the Death Star.
  const bases = [1.05, 0.85, 0.66];
  const anchors = [0.1, 0.26, 0.42, 0.58, 0.74, 0.9].map((f) => left + f * W)
    .filter((x) => Math.abs(x - ds.x) > ds.r * 1.3 + 80);
  const ranked = anchors
    .map((x, i) => ({ x, i, h: stage.minHeadroom(x - 75, x + 75), j: rng.fork(`a${i}`).next() }))
    .sort((a, b) => b.h + b.j * 6 - (a.h + a.j * 6));
  const chosen = [];
  for (const c of ranked) {
    if (chosen.length < 3 && chosen.every((o) => Math.abs(o.x - c.x) >= 170)) chosen.push(c);
  }
  const destroyers = chosen.map((c, k) => {
    const offset = [0, 16, 6][k];
    const fit = (c.h - 16 - offset) / STAR_DESTROYER.height;
    const scale = Math.min(bases[k], fit);
    if (scale < 0.4) return null;
    const half = (STAR_DESTROYER.height * scale) / 2;
    const fromLeft = k % 2 === 0;
    return {
      anchor: c.x, y: stage.top + 12 + offset + half, scale, fromLeft,
      entry: fromLeft ? left - 90 * scale : right + 90 * scale,
      t0: TIMELINE.shipsIn + k * 0.7, dur: 2.6, drift: (fromLeft ? 1 : -1) * 3,
    };
  }).filter(Boolean);

  // ---- Stars.
  const stars = Array.from({ length: 120 }, (_, i) => {
    const q = rng.fork(`star${i}`);
    return { x: q.range(left, right), y: q.range(stage.top, stage.bottom), r: q.range(0.6, 1.5), a: q.range(0.3, 0.85), f: q.range(0.2, 0.6), ph: q.range(0, 6.28), warm: q.next() };
  });

  // ---- TIE patrol (crosses right to left) and outbound flight from the blast.
  const patrol = [0, 1, 2].map((k) => ({
    y: stage.top + 30 + k * 15 + (k === 1 ? -6 : 0), dx: k * 46, scale: 1.25 - k * 0.1,
  }));
  const outbound = [-172, -128, -24, -8, -156].map((deg, k) => ({
    a: (deg + (hash01(k, 51) - 0.5) * 8) * (Math.PI / 180),
    speed: 130 + hash01(k, 52) * 90, t0: TIMELINE.tieOut + k * 0.12, roll: (hash01(k, 53) - 0.5) * 0.9,
  }));
  const staticTies = [{ x: left + 0.2 * W, y: stage.top + 34 }, { x: left + 0.36 * W, y: stage.top + 52 }, { x: left + 0.62 * W, y: stage.top + 30 }];

  const dsX = (t) => ds.x + (1 - easeOut((t - TIMELINE.dsIn[0]) / (TIMELINE.dsIn[1] - TIMELINE.dsIn[0]))) * (right - ds.x + r + 20);

  function drawStatic(ctx, t, env) {
    const a = smoothstep(0.8, 1.8, t) * (1 - smoothstep(13.3, 14.2, t)) * env;
    if (a <= 0) return;
    ctx.globalAlpha = a;
    for (const d of destroyers) drawStarDestroyer(ctx, { x: d.anchor, y: d.y, scale: d.scale, flip: !d.fromLeft });
    drawDeathStar(ctx, { x: ds.x, y: ds.y, r: ds.r, charge: 0.35 });
    for (const [i, p] of staticTies.entries()) drawTieFighter(ctx, { x: p.x, y: p.y, scale: 1.2 - i * 0.1 });
  }

  return {
    ds, destroyers, stars,
    /** No snow-like particles here; nothing is drawn outside the sky. */
    drawFree() {},
    drawSky(ctx, t, env) {
      const base = smoothstep(TIMELINE.starsIn[0], TIMELINE.starsIn[1], t);
      // Dim the sky a little so the ships read, then stars.
      // The dim eases in over the first 60 px so no hard band shows under the compass tape.
      const dim = ctx.createLinearGradient(0, stage.top, 0, stage.top + 60);
      dim.addColorStop(0, 'rgba(4, 8, 20, 0)'); dim.addColorStop(1, 'rgba(4, 8, 20, 0.34)');
      ctx.globalAlpha = base * env;
      ctx.fillStyle = dim;
      ctx.fillRect(left, stage.top, W, stage.bottom - stage.top);
      for (const s of stars) {
        const tw = rm ? 1 : 1 + 0.15 * Math.sin(Math.PI * 2 * s.f * t + s.ph);
        ctx.globalAlpha = clamp(s.a * tw, 0, 1) * 0.75 * base * env;
        ctx.fillStyle = s.warm > 0.8 ? '#ffe9c4' : s.warm < 0.25 ? '#cfe0ff' : '#ffffff';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = env;

      if (rm) { drawStatic(ctx, t, env); ctx.globalAlpha = 1; return; }

      // Star Destroyers glide in, then keep drifting slowly.
      for (const d of destroyers) {
        const p = easeOut((t - d.t0) / d.dur);
        if (t < d.t0) continue;
        const x = lerp(d.entry, d.anchor, p) + d.drift * Math.max(0, t - d.t0 - d.dur);
        ctx.globalAlpha = env;
        drawStarDestroyer(ctx, { x, y: d.y, scale: d.scale, flip: !d.fromLeft });
      }

      // TIE patrol crossing right to left.
      const [p0, p1] = TIMELINE.tiePatrol;
      if (t >= p0 && t <= p1) {
        const u = (t - p0) / (p1 - p0);
        for (const [k, tie] of patrol.entries()) {
          const x = lerp(right + 70 + tie.dx, left - 70 + tie.dx, u);
          ctx.globalAlpha = env;
          drawTieFighter(ctx, { x, y: tie.y + Math.sin(u * 9 + k) * 3, scale: tie.scale, roll: Math.sin(u * 6 + k) * 0.06 });
        }
      }

      // Death Star: slide in, charge, tremble, explode.
      const age = t - TIMELINE.boom;
      const charge = smoothstep(TIMELINE.charge[0], TIMELINE.charge[1], t);
      const ripple = 1 + 0.05 * Math.sin(Math.PI * 2 * 1.2 * t);
      const tremble = 1.2 * smoothstep(10.0, 11.0, t) * Math.sin(Math.PI * 2 * 5 * t);
      const dsAlpha = smoothstep(TIMELINE.dsIn[0], TIMELINE.dsIn[0] + 1.4, t) * (age > 0 ? 1 - smoothstep(0, 0.35, age) : 1);
      if (dsAlpha > 0) {
        ctx.globalAlpha = env;
        drawDeathStar(ctx, { x: dsX(t) + tremble, y: ds.y, r: ds.r, charge: Math.min(1, charge * ripple), alpha: dsAlpha });
      }

      if (age > 0) {
        ctx.globalAlpha = env;
        drawExplosion(ctx, { x: ds.x, y: ds.y, r: ds.r, age });
        // TIE fighters emerge from the blast and fly away from it.
        for (const o of outbound) {
          const a = t - o.t0;
          if (a <= 0) continue;
          const x = ds.x + Math.cos(o.a) * o.speed * a, y = ds.y + Math.sin(o.a) * o.speed * a;
          const alpha = smoothstep(0, 0.35, a) * stage.edgeFade(x, y, 34);
          if (alpha <= 0.01) continue;
          ctx.globalAlpha = env;
          drawTieFighter(ctx, { x, y, scale: lerp(1.15, 0.55, smoothstep(0, 3, a)), alpha, roll: o.roll * a });
        }
        // One brief flash over the sky (never over terrain or UI).
        const f = flashAlpha(age);
        if (f > 0.002) {
          ctx.globalAlpha = f * env;
          ctx.fillStyle = 'rgb(255, 248, 230)';
          ctx.fillRect(left, stage.top, W, stage.bottom - stage.top);
        }
      }
      ctx.globalAlpha = 1;
    },
  };
}
