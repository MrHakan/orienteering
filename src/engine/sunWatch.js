import { Random } from './rng.js';
import { clamp, lerp, smoothstep, wrap360 } from './grid.js';

export const SUN_WATCH_DURATION = 15;
export const DEFAULT_SUN_LATITUDE = 0;
export const WATCH_TIMING = Object.freeze({ down: 2, readable: 2.5, end: 5.5, sky: 6.4, aim: 10.2, return: 11.2, finish: 15 });
export const FRIEND_WATCH_TIMING = Object.freeze({ down: 6, readable: 6.5, end: 9.5, sky: 10.2, aim: 12.3, return: 12.9, finish: 15 });
export const supportsSunWatch = mode => ['where-am-i', 'lookalike', 'friend', 'grid'].includes(mode);
export const usesSunWatch = quiz => quiz?.difficulty === 'sun-watch' && !!quiz.sunWatch;
export const watchTiming = quiz => quiz?.mode === 'friend' ? FRIEND_WATCH_TIMING : WATCH_TIMING;

/** Finish the 3× optical zoom at 5s, wait one second, then lower the wrist. */
export function sunFriendZoom(seconds) {
  return 1 + 2 * smoothstep(3, 5, seconds) * (1 - smoothstep(6, 6.5, seconds));
}

/** Equinox, local solar time. ENU -> WebGL east/up/-north. */
export function solarPosition(hour24, minute = 0, seconds = 0, latitude = DEFAULT_SUN_LATITUDE) {
  const rad = Math.PI / 180;
  const h = ((hour24 + minute / 60 + seconds / 3600) - 12) * 15 * rad;
  const lat = latitude * rad;
  const east = -Math.sin(h), north = -Math.sin(lat) * Math.cos(h), up = Math.cos(lat) * Math.cos(h);
  return { azimuth: wrap360(Math.atan2(east, north) / rad), altitude: Math.asin(clamp(up, -1, 1)) / rad,
    direction: [east, up, -north] };
}

/** Time is drawn independently of the answer; never use the host's wall clock. */
export function createSunWatch(quiz, model, { latitude = DEFAULT_SUN_LATITUDE } = {}) {
  const rng = new Random(`${quiz.seed}|${quiz.difficulty}|${quiz.variant || 0}|sun-watch-v1`);
  const times = rng.shuffle([8, 14].flatMap(hour => Array.from({ length: 25 }, (_, i) => hour * 60 + i * 5)));
  for (const minutes of times) {
    const plan = { hour24: Math.floor(minutes / 60), minute: minutes % 60, latitude };
    const sun = solarPosition(plan.hour24, plan.minute, 0, plan.latitude);
    const horizon = model.skyline.castRay(quiz.camera.x, quiz.camera.y, quiz.camera.z, sun.azimuth).angle;
    if (sun.altitude > horizon + 4) return plan;
  }
  // A near-noon sun also clears a steep nearby skyline; fail rather than offer
  // a question in which the only orientation cue is below the terrain.
  for (const hour24 of [11, 13]) {
    const plan = { hour24, minute: 0, latitude }, sun = solarPosition(hour24, 0, 0, latitude);
    if (sun.altitude > model.skyline.castRay(quiz.camera.x, quiz.camera.y, quiz.camera.z, sun.azimuth).angle + 4) return plan;
  }
  throw new Error('Could not find a visible daylight sun for this viewpoint.');
}

/** One deterministic camera/watch/sun sampler for the game, replay and exports. */
export function sunWatchFrame(quiz, seconds = 0, { camera = quiz.camera, active = true } = {}) {
  if (!usesSunWatch(quiz)) return { camera, watch: null, solar: null, done: true };
  const t = clamp(Number.isFinite(seconds) ? seconds : 0, 0, SUN_WATCH_DURATION), p = quiz.sunWatch, timing = watchTiming(quiz);
  const solar = solarPosition(p.hour24, p.minute, t, p.latitude);
  let heading = camera.heading, pitch = camera.pitch, progress = 0, relativeTurn = 0;
  let fov = camera.fov;
  if (active) {
    const zoom = quiz.mode === 'friend' ? sunFriendZoom(t) : 1;
    if (zoom !== 1) fov = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) / zoom) * 180 / Math.PI;
    const rise = smoothstep(timing.end, timing.sky, t);
    progress = smoothstep(timing.down, timing.readable, t) * (1 - rise);
    if (t <= timing.end) pitch = lerp(camera.pitch, -64, smoothstep(timing.down, timing.readable, t));
    else if (t < timing.finish) {
      // Raise the head at the original bearing before one direct turn. Keeping
      // that reference view makes the rotation back to the friend easy to follow.
      pitch = lerp(-64, camera.pitch, rise);
      if (t >= timing.sky) {
        const orient = smoothstep(timing.sky, timing.aim, t)
          * (1 - smoothstep(timing.return, timing.finish, t));
        // Choose the shortest arc once, then track the sun's tiny physical drift.
        // Rechoosing the arc per frame could flip sides at the 180° boundary.
        const anchor = solarPosition(p.hour24, p.minute, timing.aim, p.latitude);
        const turn = wrap360(anchor.azimuth - camera.heading + 180) - 180;
        const drift = wrap360(solar.azimuth - anchor.azimuth + 180) - 180;
        relativeTurn = (turn + drift) * orient;
        heading = wrap360(camera.heading + relativeTurn);
        pitch = lerp(camera.pitch, solar.altitude, orient);
      }
    }
  }
  return { camera: heading === camera.heading && pitch === camera.pitch && fov === camera.fov ? camera : { ...camera, heading, pitch, fov }, solar,
    watch: { progress, hour24: p.hour24, minute: p.minute, seconds: t }, relativeTurn, done: t >= SUN_WATCH_DURATION };
}
