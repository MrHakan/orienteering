// Visual settings have their own stream. They never participate in quiz generation.
import { normaliseTextureMode } from './terrainTextures.js';

export const CONDITIONS = [
  ['clear', 'Clear'], ['clouds', 'Passing clouds'], ['overcast', 'Overcast'],
  ['drizzle', 'Light drizzle'], ['rain', 'Rain'], ['storm', 'Rainstorm'],
  ['fog', 'Morning mist'], ['snow', 'Snowfall'], ['sunset', 'Golden hour'],
].map(([id, label]) => ({ id, label }));
export const WINDS = [
  { id: 'calm', label: 'Calm' }, { id: 'breeze', label: 'Light breeze' },
  { id: 'strong', label: 'Strong breeze' },
];

export function normaliseEnvironment(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  return {
    condition: CONDITIONS.some(c => c.id === value.condition) ? value.condition : 'clear',
    wind: WINDS.some(w => w.id === value.wind) ? value.wind : 'calm',
    texture: normaliseTextureMode(value.texture),
    hd: value.hd === true, foliage: value.foliage === true, nature: value.nature === true,
  };
}

/** Also accepts the original export weather checkbox array for saved preferences/API clients. */
export function environmentFromWeather(selected = []) {
  const has = key => Array.isArray(selected) && selected.includes(key);
  const condition = ['storm', 'snow', 'rain', 'drizzle', 'fog', 'overcast', 'clouds', 'sunset'].find(has) || 'clear';
  return normaliseEnvironment({ condition, wind: has('wind') ? 'strong' : has('breeze') ? 'breeze' : 'calm' });
}

export function weatherParams(selected, heading = 0) {
  const env = Array.isArray(selected) ? environmentFromWeather(selected) : normaliseEnvironment(selected);
  const presets = {
    clear: [0, 0, 0, 0, 0], clouds: [.65, 0, 0, 0, 0], overcast: [1, 0, .12, 0, 0],
    drizzle: [.82, .35, .18, .28, 0], rain: [.95, 1, .22, .72, 0],
    storm: [1, 1, .55, 1, 0], fog: [.2, 0, .85, 0, 0], snow: [.85, 0, .28, 0, 1],
    sunset: [.2, 0, 0, 0, 0],
  };
  const [cloud, wet, fog, precipitation, snow] = presets[env.condition];
  let speed = env.wind === 'strong' ? 11 : env.wind === 'breeze' ? 2.8 : 0;
  if (env.condition === 'storm') speed = Math.max(speed, 9);
  // Even calm cloudy skies drift slowly; vegetation only sways when there is wind.
  const cloudSpeed = Math.max(speed, cloud ? 1.4 : 0);
  const dir = ((Number.isFinite(heading) ? heading : 0) + 75) * Math.PI / 180;
  const vector = s => [Math.sin(dir) * s, Math.cos(dir) * s];
  return { cloud, wet, fog: Array.isArray(selected) && selected.includes('fog') ? 1 : fog, wind: vector(speed), cloudWind: vector(cloudSpeed),
    rain: precipitation > 0, precipitation, snow, dusk: env.condition === 'sunset' ? 1 : 0,
    skyHeading: Number.isFinite(heading) ? heading : 0,
    gusts: speed > 0, storm: env.condition === 'storm' };
}

/** Smooth, bounded gusts: no random frame-to-frame changes or export clock dependencies. */
export function windGust(time = 0, strong = false) {
  const t = Number.isFinite(time) ? Math.max(0, time) : 0;
  return 1 + (strong ? .32 : .16) * (Math.sin(t * .83) * .65 + Math.sin(t * 1.71 + .8) * .35);
}

export function environmentAnimated(settings) {
  const e = normaliseEnvironment(settings);
  return e.wind !== 'calm' || e.condition !== 'clear' || e.nature;
}
