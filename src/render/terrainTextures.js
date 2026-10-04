import { Random } from '../engine/rng.js';
import { WORLDS } from '../engine/worlds.js';

// Surface appearance has its own seed stream; it never enters terrain or quiz generation.
// mix = soil coverage, exposed rock, slope-to-rock weight, scanned-color tint.
export const TERRAIN_TEXTURES = [
  { id: 'meadow', label: 'Green meadow', low: [.17, .30, .10], high: [.32, .40, .16],
    dry: [.46, .40, .24], rock: [.48, .47, .42], mix: [.05, 0, .92, .45], scale: 1 },
  { id: 'moss', label: 'Mossy moorland', low: [.10, .23, .16], high: [.24, .34, .22],
    dry: [.33, .30, .21], rock: [.29, .34, .32], mix: [.22, .08, .85, .72], scale: .85 },
  { id: 'autumn', label: 'Autumn grassland', low: [.40, .30, .12], high: [.57, .43, .19],
    dry: [.55, .34, .18], rock: [.42, .35, .29], mix: [.30, .04, .90, .86], scale: 1.15 },
  { id: 'desert', label: 'Desert sandstone', low: [.57, .43, .27], high: [.70, .56, .36],
    dry: [.60, .36, .21], rock: [.61, .42, .29], mix: [.88, .15, .72, .94], scale: 1.35 },
  { id: 'alpine', label: 'Alpine scree', low: [.33, .39, .32], high: [.47, .49, .40],
    dry: [.52, .49, .41], rock: [.56, .60, .62], mix: [.52, .34, 1.15, .82], scale: .72 },
].map(profile => Object.freeze(Object.fromEntries(Object.entries(profile)
  .map(([key, value]) => [key, Array.isArray(value) ? Object.freeze(value) : value]))));

export const TEXTURE_MODES = [{ id: 'auto', label: 'Auto — by seed' },
  ...TERRAIN_TEXTURES.map(({ id, label }) => ({ id, label }))];

export const normaliseTextureMode = value => TEXTURE_MODES.some(mode => mode.id === value) ? value : 'auto';

/**
 * Raw quiz seed keeps the style stable across difficulty, variants and terrain retries.
 * In Auto, a world type with a natural surface (alpine scree, desert sand…) uses it.
 */
export function terrainTexture(seed, mode = 'auto', world = 'classic') {
  const rng = new Random(`terrain-texture-v1|${String(seed ?? '')}`);
  const seeded = rng.pick(TERRAIN_TEXTURES);
  const automatic = TERRAIN_TEXTURES.find(p => p.id === WORLDS[world]?.texture) || seeded;
  const profile = TERRAIN_TEXTURES.find(p => p.id === normaliseTextureMode(mode)) || automatic;
  const brightness = rng.range(.96, 1.04);
  return { ...profile,
    ...Object.fromEntries(['low', 'high', 'dry', 'rock'].map(key => [key, profile[key].map(c => c * brightness)])),
    offset: [rng.range(0, 4096), rng.range(0, 4096)], scale: profile.scale * rng.range(.88, 1.12) };
}
