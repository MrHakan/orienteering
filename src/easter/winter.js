// Winter: layered snowfall for the whole render and, on Santa days, a sleigh
// with eight reindeer crossing the sky near the end. Every position is an
// analytic function of the elapsed time `t` and of values drawn once from the
// seeded generator, so any frame can be reproduced exactly.

import { clamp, smoothstep } from '../engine/grid.js';
import { drawSleighTeam, SLEIGH_TEAM } from './models/sleigh.js';

/** Santa's flight (seconds): enters at start, fully gone at end. */
export const SANTA = { start: 10.0, end: 14.4 };

const LAYERS = [
  { n: 900, r: [0.7, 1.15], a: 0.3, v: [18, 28], amp: [5, 11], wind: 5 },   // far
  { n: 430, r: [1.3, 1.9], a: 0.42, v: [40, 58], amp: [9, 18], wind: 9 },   // middle
  { n: 140, r: [2.2, 3.0], a: 0.5, v: [80, 110], amp: [14, 26], wind: 14 }, // near
];

const mod = (n, m) => ((n % m) + m) % m;

/** Flake list for one layer, drawn once from the seeded generator. */
function makeFlakes(rng, layer, W, H, pad) {
  const flakes = [];
  for (let i = 0; i < layer.n; i++) {
    flakes.push({
      x: rng.range(0, W), y: rng.range(0, H + 2 * pad),
      r: rng.range(layer.r[0], layer.r[1]),
      v: rng.range(layer.v[0], layer.v[1]),
      amp: rng.range(layer.amp[0], layer.amp[1]),
      f: rng.range(0.25, 0.7), ph: rng.range(0, Math.PI * 2),
    });
  }
  return flakes;
}

/** Snow position at time t (t = 0 when motion is reduced). */
export function flakePosition(f, layer, t, W, H, pad) {
  const y = mod(f.y + f.v * t, H + 2 * pad) - pad;
  const x = mod(f.x + layer.wind * t + f.amp * Math.sin(Math.PI * 2 * f.f * t + f.ph), W + 40) - 20;
  return [x, y];
}

/**
 * @param {{rng:import('../engine/rng.js').Random, stage:object, plan:object}} p
 * @returns {{drawFree:Function, drawSky:Function, santaPath:Function|null, sleigh:object}}
 */
export function createWinter({ rng, stage, plan }) {
  const { width: W, height: H } = stage.frame;
  const pad = 12;
  const layers = LAYERS.map((layer, i) => ({ layer, flakes: makeFlakes(rng.fork(`snow${i}`), layer, W, H, pad) }));

  // Sleigh size follows how much sky the scene has (25th percentile), and it
  // rides just under the top of the stage.
  const scale = clamp((stage.headroomPercentile(0.25) - 10) / (SLEIGH_TEAM.height * 1.15), 0.7, 1.4);
  const teamLen = SLEIGH_TEAM.length * scale;
  const baseY = stage.top + (SLEIGH_TEAM.height + 8) * scale;
  const sleigh = { scale, teamLen, baseY };

  // Position of the sleigh's rear at time t (null when not flying).
  const santaPath = plan.santa ? (t) => {
    if (plan.reducedMotion) {
      const a = smoothstep(10.4, 11.4, t) * (1 - smoothstep(13.3, 14.2, t));
      return a > 0 ? { x: stage.left + (stage.scene.w - teamLen) / 2, y: baseY, alpha: a, t: 0.3 } : null;
    }
    if (t < SANTA.start || t > SANTA.end) return null;
    const p = (t - SANTA.start) / (SANTA.end - SANTA.start);
    const x = (stage.left - teamLen - 12) + p * (stage.scene.w + teamLen + 24);
    return { x, y: baseY + 5 * Math.sin(p * Math.PI * 2 * 1.3), alpha: 1, t };
  } : null;

  return {
    sleigh,
    santaPath,
    /** Snow, clipped to the free (unprotected) area. */
    drawFree(ctx, t, env) {
      const tt = plan.reducedMotion ? 0 : t;
      ctx.fillStyle = '#fff';
      for (const { layer, flakes } of layers) {
        ctx.globalAlpha = layer.a * env;
        ctx.beginPath();
        for (const f of flakes) {
          const [x, y] = flakePosition(f, layer, tt, W, H, pad);
          ctx.moveTo(x + f.r, y);
          ctx.arc(x, y, f.r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
    /** Santa, clipped to the sky above the skyline. */
    drawSky(ctx, t, env) {
      const s = santaPath && santaPath(t);
      if (!s) return;
      drawSleighTeam(ctx, { x: s.x, y: s.y, scale, t: s.t, alpha: env * s.alpha });
    },
  };
}
