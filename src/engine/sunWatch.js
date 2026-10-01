import { Random } from './rng.js';
import { clamp, lerp, smoothstep, wrap360 } from './grid.js';

export const SUN_WATCH_DURATION = 12;
export const WATCH_TIMING = Object.freeze({ down: 2, readable: 2.5, end: 5.5, sky: 6.4, first: 7.3, second: 8.5, aim: 9.3, return: 10.7, finish: 12 });
export const usesSunWatch = quiz => quiz?.mode === 'facing' && !!quiz.sunWatch;

/** Equinox, northern mid-latitudes, local solar time. ENU -> WebGL east/up/-north. */
export function solarPosition(hour24, minute = 0, seconds = 0, latitude = 40) {
  const rad = Math.PI / 180;
  const h = ((hour24 + minute / 60 + seconds / 3600) - 12) * 15 * rad;
  const lat = latitude * rad;
  const east = -Math.sin(h), north = -Math.sin(lat) * Math.cos(h), up = Math.cos(lat) * Math.cos(h);
  return { azimuth: wrap360(Math.atan2(east, north) / rad), altitude: Math.asin(clamp(up, -1, 1)) / rad,
    direction: [east, up, -north] };
}

/** Time is drawn independently of the answer; never use the host's wall clock. */
export function createSunWatch(quiz, model) {
  const rng = new Random(`${quiz.seed}|${quiz.difficulty}|${quiz.variant || 0}|sun-watch-v1`);
  const times = rng.shuffle([9, 14].flatMap(hour => Array.from({ length: 13 }, (_, i) => hour * 60 + i * 5)));
  for (const minutes of times) {
    const plan = { hour24: Math.floor(minutes / 60), minute: minutes % 60, latitude: 40 };
    const sun = solarPosition(plan.hour24, plan.minute);
    const horizon = model.skyline.castRay(quiz.camera.x, quiz.camera.y, quiz.camera.z, sun.azimuth).angle;
    if (sun.altitude > horizon + 4) return plan;
  }
  // A near-noon sun also clears a steep nearby skyline; fail rather than offer
  // a question in which the only orientation cue is below the terrain.
  for (const hour24 of [11, 13]) {
    const plan = { hour24, minute: 0, latitude: 40 }, sun = solarPosition(hour24);
    if (sun.altitude > model.skyline.castRay(quiz.camera.x, quiz.camera.y, quiz.camera.z, sun.azimuth).angle + 4) return plan;
  }
  throw new Error('Could not find a visible daylight sun for this viewpoint.');
}

/** One deterministic camera/watch/sun sampler for the game, replay and exports. */
export function sunWatchFrame(quiz, seconds = 0, { camera = quiz.camera, active = true } = {}) {
  if (!usesSunWatch(quiz)) return { camera, watch: null, solar: null, done: true };
  const t = clamp(Number.isFinite(seconds) ? seconds : 0, 0, SUN_WATCH_DURATION), p = quiz.sunWatch;
  const solar = solarPosition(p.hour24, p.minute, t, p.latitude);
  let heading = camera.heading, pitch = camera.pitch, progress = 0;
  if (active) {
    const rise = smoothstep(WATCH_TIMING.end, 6.2, t);
    progress = smoothstep(WATCH_TIMING.down, WATCH_TIMING.readable, t) * (1 - rise);
    if (t <= WATCH_TIMING.end) pitch = lerp(camera.pitch, -64, smoothstep(WATCH_TIMING.down, WATCH_TIMING.readable, t));
    else if (t < WATCH_TIMING.finish) {
      const skyPitch = Math.min(58, solar.altitude - 6);
      pitch = lerp(-64, skyPitch, smoothstep(WATCH_TIMING.end, WATCH_TIMING.sky, t));
      if (t >= WATCH_TIMING.return) pitch = lerp(skyPitch, camera.pitch, smoothstep(WATCH_TIMING.return, WATCH_TIMING.finish, t));
      const relativeSun = wrap360(solar.azimuth - camera.heading + 180) - 180;
      const side = relativeSun >= 0 ? 1 : -1;
      const aim = clamp(relativeSun, -160, 160);
      let turn = 0;
      if (t <= WATCH_TIMING.first) turn = -side * 70 * smoothstep(WATCH_TIMING.sky, WATCH_TIMING.first, t);
      else if (t <= WATCH_TIMING.second) turn = lerp(-side * 70, side * 70, smoothstep(WATCH_TIMING.first, WATCH_TIMING.second, t));
      else if (t <= WATCH_TIMING.aim) turn = lerp(side * 70, aim, smoothstep(WATCH_TIMING.second, WATCH_TIMING.aim, t));
      else if (t <= WATCH_TIMING.return) turn = aim;
      else turn = lerp(aim, 0, smoothstep(WATCH_TIMING.return, WATCH_TIMING.finish, t));
      heading = wrap360(camera.heading + turn);
    }
  }
  return { camera: heading === camera.heading && pitch === camera.pitch ? camera : { ...camera, heading, pitch }, solar,
    watch: { progress, hour24: p.hour24, minute: p.minute, seconds: t }, done: t >= SUN_WATCH_DURATION };
}
