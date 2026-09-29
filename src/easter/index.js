// Seasonal Easter eggs for exported frames. Purely decorative: the layer
// receives only the render plan, the quiz seed, the export layout and the
// engine's skyline. It never sees the terrain data, options, correct answer
// or any saved state, so it cannot change or reveal them.

import { Random } from '../engine/rng.js';
import { smoothstep } from '../engine/grid.js';
import { EGG_DURATION } from './config.js';
import { createStage } from './stage.js';
import { createWinter } from './winter.js';
import { createMay4 } from './may4.js';

export { EASTER_CONFIG, EGG_DURATION } from './config.js';
export { resolveEasterEgg, selectEvent, parsePreview, isoDateInZone, isValidDate } from './schedule.js';

/**
 * Global envelope: fades in over the first 0.8 s and out by 14.9 s, exactly 0
 * from 0.1 s before the end. The last frame is therefore the ordinary render,
 * and the video loops without a seam.
 */
export function envelope(t, duration = EGG_DURATION) {
  if (t <= 0 || t >= duration - 0.1) return 0;
  return smoothstep(0, 0.8, t) * (1 - smoothstep(duration - 0.7, duration - 0.1, t));
}

/**
 * @param {{key:string, date:string, santa:boolean, reducedMotion:boolean}|null} plan
 * @param {{seed:string, layout:object, frame:{width:number,height:number}, skyline:number[][], duration?:number}} ctx
 * @returns {null | {key:string, plan:object, stage:object, scene:object, draw:(ctx:CanvasRenderingContext2D, elapsedSeconds:number)=>boolean}}
 */
export function createEasterEgg(plan, { seed, layout, frame, skyline, duration = EGG_DURATION }) {
  if (!plan || !plan.key) return null;
  const stage = createStage({ layout, frame, skyline });
  // Seed = quiz seed + event key + event date: the same inputs always give the same scene.
  const rng = new Random(`${seed}#${plan.key}#${plan.date}`);
  const scene = plan.key === 'winter' ? createWinter({ rng, stage, plan }) : plan.key === 'may4' ? createMay4({ rng, stage, plan }) : null;
  if (!scene) return null;

  return {
    key: plan.key, plan, stage, scene,
    /** Draws frame `elapsedSeconds`; returns false (touching nothing) when the layer is inactive. */
    draw(ctx, elapsedSeconds) {
      const env = envelope(elapsedSeconds, duration);
      if (env <= 0) return false;
      ctx.save();
      stage.clipFree(ctx);
      scene.drawFree(ctx, elapsedSeconds, env);
      ctx.restore();
      ctx.save();
      stage.clipSky(ctx);
      scene.drawSky(ctx, elapsedSeconds, env);
      ctx.restore();
      return true;
    },
  };
}
