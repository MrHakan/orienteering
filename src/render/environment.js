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
export const DENSITIES = [
  { id: 'light', label: 'Light', coverage: .4, birds: 2 },
  { id: 'moderate', label: 'Moderate', coverage: 1, birds: 4 },
  { id: 'heavy', label: 'Heavy', coverage: 1.7, birds: 8 },
];

export function densityProfile(value) {
  return DENSITIES.find(d => d.id === value) || DENSITIES[1];
}

export function normaliseEnvironment(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  return {
    condition: CONDITIONS.some(c => c.id === value.condition) ? value.condition : 'clear',
    wind: WINDS.some(w => w.id === value.wind) ? value.wind : 'calm',
    texture: normaliseTextureMode(value.texture),
    foliageDensity: densityProfile(value.foliageDensity).id,
    natureDensity: densityProfile(value.natureDensity).id,
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
  // cloud: broken cumulus cover; wet: rain-soaked ground; fog: distance haze; precipitation; snow cover;
  // deck: a closed stratus layer (flat, shadowless light) and deckTone its brightness; mist: valley fog.
  const presets = {
    //         cloud wet  fog  precip snow deck tone mist
    clear:    [0,    0,   0,   0,     0,   0,   .7,  0],
    clouds:   [.65,  0,   0,   0,     0,   0,   .7,  0],
    overcast: [.35,  0,   .12, 0,     0,   1,   .70, .1],
    drizzle:  [.5,   .35, .18, .28,   0,   .95, .62, .3],
    rain:     [.5,   1,   .22, .72,   0,   1,   .55, .35],
    storm:    [.6,   1,   .55, 1,     0,   1,   .40, .45],
    fog:      [.2,   0,   .85, 0,     0,   .75, .78, 1],
    snow:     [.3,   0,   .12, 0,     1,   .85, .66, .15],
    sunset:   [.35,  0,   0,   0,     0,   0,   .7,  0],
  };
  const [cloud, wet, fog, precipitation, snow, deck, deckTone, mist] = presets[env.condition];
  let speed = env.wind === 'strong' ? 11 : env.wind === 'breeze' ? 2.8 : 0;
  if (env.condition === 'storm') speed = Math.max(speed, 9);
  // Even calm cloudy skies drift slowly; vegetation only sways when there is wind.
  const cloudSpeed = Math.max(speed, cloud ? 1.4 : 0);
  const dir = ((Number.isFinite(heading) ? heading : 0) + 75) * Math.PI / 180;
  const vector = s => [Math.sin(dir) * s, Math.cos(dir) * s];
  return { cloud, wet, fog: Array.isArray(selected) && selected.includes('fog') ? 1 : fog, wind: vector(speed), cloudWind: vector(cloudSpeed),
    rain: precipitation > 0, precipitation, snow, deck, deckTone, mist, dusk: env.condition === 'sunset' ? 1 : 0,
    skyHeading: Number.isFinite(heading) ? heading : 0,
    gusts: speed > 0, storm: env.condition === 'storm' };
}

/** Distance (m) at which the haze reaches ~63 %: the renderer's fog scale for this weather. */
export function hazeDistance(w = {}) {
  return Math.max(1400, 5200 - 2200 * (w.fog || 0) - 1200 * (w.wet || 0) - 400 * (w.deck || 0));
}

/** Share (0..1) of a terrain feature `metres` away that is lost in the haze: same curve as the terrain shader. */
export function visibilityFactor(w, metres) {
  return 1 - Math.exp(-Math.pow(Math.max(0, metres) / hazeDistance(w), 1.35));
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
