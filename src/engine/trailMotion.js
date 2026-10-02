// Deterministic autobhop over the rendered triangular surface. Positions use
// metres; movement constants are converted from the familiar 800-unit gravity
// and 30-unit air wish-speed cap. Rendering never advances this simulation.
import { DEG, clamp, lerp, wrap360 } from './grid.js';
import { surfaceElevation } from './terrainSurface.js';

export const TRAIL_DURATION = 12;
export const TRAIL_TICK = 1 / 128;
export const METRES_PER_UNIT = 0.0254;
export const MOVEMENT_PROFILES = {
  classic: { label: 'CS 1.6 style', gravity: 800 * METRES_PER_UNIT, jump: Math.sqrt(2 * 800 * 45) * METRES_PER_UNIT },
  go: { label: 'CS:GO style', gravity: 800 * METRES_PER_UNIT, jump: 301.993 * METRES_PER_UNIT },
};
export const normaliseMovement = (value) => value === 'classic' ? 'classic' : 'go';

/** Projection-limited air acceleration; perpendicular strafes can gain speed. */
export function airAccelerate(vx, vy, wx, wy, dt, { accel = 12, wishSpeed = 250 * METRES_PER_UNIT, cap = 30 * METRES_PER_UNIT } = {}) {
  const add = cap - vx * wx - vy * wy;
  if (add <= 0) return [vx, vy];
  const amount = Math.min(add, accel * wishSpeed * dt);
  return [vx + wx * amount, vy + wy * amount];
}

/** One steering/speed plan shared by ALL choices: shape and timing give no letter away. */
export function createTrailPlan(rng, heading, duration = TRAIL_DURATION) {
  const dt = TRAIL_TICK, count = Math.round(duration / dt) + 1;
  const samples = new Float64Array(count * 4);
  const phase = rng.range(0, 2 * Math.PI), turn = rng.range(12, 25) * rng.sign();
  let x = 0, y = 0, vx = Math.sin(heading * DEG) * 6.35, vy = Math.cos(heading * DEG) * 6.35, length = 0;
  for (let i = 0; i < count; i++) {
    const t = i * dt, speed = Math.hypot(vx, vy);
    const az = Math.atan2(vx, vy) / DEG;
    samples.set([x, y, wrap360(az), speed], i * 4);
    if (i === count - 1) break;
    const wanted = heading + turn * Math.sin(t / duration * Math.PI * 1.7 + phase) - turn * Math.sin(phase);
    const error = wrap360(wanted - az + 180) - 180;
    const sign = Math.abs(error) > 2.4 ? Math.sign(error) : Math.floor(t / 0.32) % 2 ? 1 : -1;
    const optimal = Math.acos(Math.min(1, 10 * METRES_PER_UNIT / speed)) / DEG;
    const wish = (az + sign * optimal) * DEG;
    [vx, vy] = airAccelerate(vx, vy, Math.sin(wish), Math.cos(wish), dt);
    const nextSpeed = Math.hypot(vx, vy), maxSpeed = 700 * METRES_PER_UNIT;
    if (nextSpeed > maxSpeed) { vx *= maxSpeed / nextSpeed; vy *= maxSpeed / nextSpeed; }
    x += vx * dt; y += vy * dt; length += Math.hypot(vx, vy) * dt;
  }
  return { duration, dt, samples, length };
}

export function planAt(plan, seconds) {
  const t = clamp(Number.isFinite(seconds) ? seconds : 0, 0, plan.duration);
  const index = t / plan.dt, a = Math.min(plan.samples.length / 4 - 1, Math.floor(index));
  const b = Math.min(plan.samples.length / 4 - 1, a + 1), f = index - a, s = plan.samples;
  const angle = wrap360(s[b * 4 + 2] - s[a * 4 + 2] + 180) - 180;
  return { t, index: a, fraction: f, x: lerp(s[a * 4], s[b * 4], f), y: lerp(s[a * 4 + 1], s[b * 4 + 1], f),
    heading: wrap360(s[a * 4 + 2] + angle * f), speed: lerp(s[a * 4 + 3], s[b * 4 + 3], f) };
}

export function simulateTrail(model, start, plan, movement = 'go') {
  const profile = MOVEMENT_PROFILES[normaliseMovement(movement)], dt = plan.dt;
  const count = plan.samples.length / 4, feet = new Float64Array(count), ground = new Float64Array(count);
  const vertical = new Float64Array(count), landings = [], points = [];
  let z = surfaceElevation(model, start.x, start.y), vz = profile.jump, lastJump = 0, maxSlope = 0;
  for (let i = 0; i < count; i++) {
    const t = i * dt, x = start.x + plan.samples[i * 4], y = start.y + plan.samples[i * 4 + 1];
    if (!model.inside(x, y, 65)) return null;
    const h = surfaceElevation(model, x, y);
    if (i % 8 === 0) {
      maxSlope = Math.max(maxSlope, model.getSlope(x, y));
      if (maxSlope > 24) return null;
    }
    if (i) {
      // Constant-gravity integration gives the same parabola at every frame rate.
      z += vz * dt - 0.5 * profile.gravity * dt * dt;
      vz -= profile.gravity * dt;
      if (z <= h) {
        const flight = t - lastJump;
        if (flight < 0.22 || flight > 1.5) return null;
        landings.push({ t, impact: Math.max(0, -vz), flight });
        z = h; vz = profile.jump; lastJump = t;
      }
    }
    feet[i] = z; ground[i] = h; vertical[i] = vz;
    if (i % 16 === 0 || i === count - 1) points.push({ x, y });
  }
  if (landings.length < 8) return null;
  return { x: start.x, y: start.y, feet, ground, vertical, landings, points, maxSlope };
}

/** Shared landing punch for both the rendered camera and clue validation. */
export function landingPulse(route, seconds) {
  const recent = route.landings.findLast((l) => l.t <= seconds);
  const since = recent ? seconds - recent.t : Infinity;
  return since < 0.13 ? Math.exp(-since / 0.035) * Math.min(1, recent.impact / 9) : 0;
}

/** Random-access sampler used by live playback, comparisons and encoded frames. */
export function trailFrame(quiz, seconds, label = quiz.correctLabel, model = null) {
  const routes = quiz.trail.routes || quiz.options;
  const route = routes.find((p) => p.label === label) || routes.find((p) => p.correct);
  const p = planAt(quiz.trail.plan, seconds), i = p.index, j = Math.min(route.feet.length - 1, i + 1), f = p.fraction;
  const x = route.x + p.x, y = route.y + p.y;
  const ground = model ? surfaceElevation(model, x, y) : lerp(route.ground[i], route.ground[j], f);
  const foot = Math.max(ground, lerp(route.feet[i], route.feet[j], f));
  const landing = landingPulse(route, p.t);
  const look = Math.sin(p.t * Math.PI / 0.32) * 1.1;
  return {
    camera: { ...quiz.camera, x, y, z: foot + quiz.camera.eyeHeight, heading: wrap360(p.heading + look),
      pitch: quiz.camera.pitch - landing * 0.45, roll: 0 },
    motion: { t: p.t, speed: p.speed, airborne: foot - ground, vertical: lerp(route.vertical[i], route.vertical[j], f), landing },
    route,
  };
}
