import test from 'node:test';
import assert from 'node:assert/strict';
import { CONDITIONS, normaliseEnvironment, environmentFromWeather, weatherParams, windGust } from '../src/render/environment.js';
import { buildNatureMeshes, buildGroundCover, NATURE_STRIDE } from '../src/render/natureMesh.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { surfaceElevation } from '../src/engine/terrainSurface.js';
import { terrainHeightPixels } from '../src/render/terrainDetail.js';
import { TERRAIN_TEXTURES, terrainTexture, normaliseTextureMode } from '../src/render/terrainTextures.js';

test('environment preferences recover safely from stale or malformed storage', () => {
  for (const input of [null, false, '', { condition: 'lava', wind: 'hurricane', hd: 'true' }]) {
    assert.deepEqual(normaliseEnvironment(input), { condition: 'clear', wind: 'calm', texture: 'auto', hd: false, foliage: false, nature: false });
  }
  assert.equal(environmentFromWeather(['rain', 'wind']).condition, 'rain');
  assert.equal(environmentFromWeather(['rain', 'wind']).wind, 'strong');
  assert.equal(weatherParams(['rain'], 90).rain, true);
  assert.equal(weatherParams(['rain', 'fog'], 90).fog, 1);
});

test('automatic textures cover every style and replay the same raw seed deterministically', () => {
  const styles = new Set();
  for (let i = 0; i < 64; i++) {
    const seed = `texture-${i}`, texture = terrainTexture(seed);
    assert.deepEqual(texture, terrainTexture(seed, 'auto'));
    assert.deepEqual(texture, terrainTexture(seed, 'obsolete-mode'));
    assert.ok(TERRAIN_TEXTURES.some(p => p.id === texture.id));
    assert.ok(texture.scale > .5 && texture.scale < 1.6);
    assert.ok(texture.offset.every(Number.isFinite));
    for (const key of ['low', 'high', 'dry', 'rock']) assert.ok(texture[key].every(c => c > 0 && c < 1));
    styles.add(texture.id);
  }
  assert.equal(styles.size, TERRAIN_TEXTURES.length);
  assert.notDeepEqual(terrainTexture('texture-0').offset, terrainTexture('texture-1').offset);
});

test('manual texture choices persist safely and keep seed-specific world patterns', () => {
  const paletteKeys = new Set();
  for (const profile of TERRAIN_TEXTURES) {
    assert.equal(normaliseTextureMode(profile.id), profile.id);
    assert.equal(normaliseEnvironment({ texture: profile.id }).texture, profile.id);
    const a = terrainTexture('stable-seed', profile.id), b = terrainTexture('next-seed', profile.id);
    assert.equal(a.id, profile.id); assert.equal(b.id, profile.id);
    assert.notDeepEqual(a.offset, b.offset);
    assert.deepEqual(a, terrainTexture('stable-seed', profile.id));
    assert.deepEqual(a.offset, terrainTexture('stable-seed').offset);
    paletteKeys.add(JSON.stringify([a.low, a.rock, a.mix]));
  }
  assert.equal(paletteKeys.size, TERRAIN_TEXTURES.length);
  for (const value of [null, undefined, '', 'old', 5]) assert.equal(normaliseTextureMode(value), 'auto');
});

test('weather presets distinguish precipitation, ground treatment, mist and golden-hour light', () => {
  for (const { id } of CONDITIONS) {
    const w = weatherParams({ condition: id }, 23);
    for (const key of ['cloud', 'wet', 'fog', 'precipitation', 'snow', 'dusk']) assert.ok(w[key] >= 0 && w[key] <= 1);
    assert.ok(w.wind.every(Number.isFinite));
    assert.deepEqual(w, weatherParams({ condition: id }, 23));
  }
  assert.ok(weatherParams({ condition: 'drizzle' }).precipitation < weatherParams({ condition: 'rain' }).precipitation);
  assert.ok(weatherParams({ condition: 'rain' }).precipitation < weatherParams({ condition: 'storm' }).precipitation);
  assert.equal(weatherParams({ condition: 'snow' }).rain, false);
  assert.equal(weatherParams({ condition: 'snow' }).snow, 1);
  assert.equal(weatherParams({ condition: 'sunset' }).dusk, 1);
  assert.ok(weatherParams({ condition: 'fog' }).fog > .8);
  assert.equal(weatherParams({ condition: 'clouds' }).wind[0], 0);
  assert.ok(Math.hypot(...weatherParams({ condition: 'clouds' }).cloudWind) > 0);
});

test('breezes have camera-relative direction and smooth deterministic, bounded gusts', () => {
  const light = weatherParams({ wind: 'breeze' }, 0), strong = weatherParams({ wind: 'strong' }, 0);
  assert.ok(Math.hypot(...strong.wind) > Math.hypot(...light.wind) * 3);
  assert.ok(Math.abs(Math.hypot(...light.wind) - 2.8) < 1e-10);
  const turned = weatherParams({ wind: 'breeze' }, 90);
  assert.ok(Math.abs(turned.wind[0] - light.wind[1]) < 1e-10);
  assert.ok(Math.abs(turned.wind[1] + light.wind[0]) < 1e-10);
  for (let t = 0; t < 30; t += .03) {
    const g = windGust(t, true);
    assert.ok(g >= .68 && g <= 1.32);
    assert.ok(Math.abs(g - windGust(t + .001, true)) < .001);
    assert.equal(g, windGust(t, true));
  }
  assert.ok(Number.isFinite(windGust(NaN)));
});

test('nature is seeded, bounded, and anchored on rendered ground without changing the terrain', () => {
  const n = 17, size = 1024;
  const heights = Float32Array.from({ length: n * n }, (_, k) => 30 + Math.sin(k % n * .5) * 8 + Math.cos(Math.floor(k / n) * .4) * 6);
  const before = heights.slice(), model = new TerrainModel({ size, n, heights, seed: 'nature-check' });
  const a = buildNatureMeshes(model), b = buildNatureMeshes(model);
  assert.deepEqual(a.foliage, b.foliage); assert.deepEqual(a.nature, b.nature);
  assert.deepEqual(heights, before);
  assert.ok(a.roots.length <= 56 * 56);
  assert.ok(a.foliage.length / NATURE_STRIDE > 10000 && a.foliage.length / NATURE_STRIDE < 150000);
  assert.ok(a.nature.length > 0 && a.nature.length / NATURE_STRIDE < 100000);
  for (const root of a.roots) {
    assert.ok(model.inside(root.x, root.y));
    assert.equal(root.z, surfaceElevation(model, root.x, root.y));
  }
  for (const mesh of [a.foliage, a.nature]) {
    assert.equal(mesh.length % (NATURE_STRIDE * 3), 0);
    for (let i = 0; i < mesh.length; i += NATURE_STRIDE) {
      const [x, z, south] = mesh.subarray(i + 9, i + 12);
      assert.ok(Math.abs(z - surfaceElevation(model, x, -south)) < .001);
      for (const value of mesh.subarray(i, i + NATURE_STRIDE)) assert.ok(Number.isFinite(value));
    }
  }
});

test('nearby meadow cells remain identical after movement, scrubbing and returning', () => {
  const n = 17, size = 1024, heights = new Float32Array(n * n).fill(30);
  const model = new TerrainModel({ size, n, heights, seed: 'meadow-check' });
  const a = buildGroundCover(model, { x: 512, y: 512 });
  assert.ok(a.roots.length > 1000 && a.vertices.length / NATURE_STRIDE < 50000);
  assert.deepEqual(a.vertices, buildGroundCover(model, { x: 520, y: 520 }).vertices);
  const moved = buildGroundCover(model, { x: 540, y: 512 });
  const shared = new Map();
  for (let i = 0; i < a.vertices.length; i += NATURE_STRIDE * 3) {
    const key = [...a.vertices.subarray(i + 9, i + 12)].join(',');
    const triangles = shared.get(key) || []; triangles.push([...a.vertices.subarray(i, i + NATURE_STRIDE * 3)]); shared.set(key, triangles);
  }
  let matched = 0;
  for (let i = 0; i < moved.vertices.length; i += NATURE_STRIDE * 3) {
    const key = [...moved.vertices.subarray(i + 9, i + 12)].join(',');
    if (shared.has(key)) {
      assert.ok(shared.get(key).some(t => t.every((v, k) => v === moved.vertices[i + k]))); matched++;
    }
  }
  assert.ok(matched > 5000);
  assert.deepEqual(a.vertices, buildGroundCover(model, { x: 512, y: 512 }).vertices);
  const edge = buildGroundCover(model, { x: 2, y: 2 });
  assert.ok(edge.roots.every(r => model.inside(r.x, r.y) && r.z === surfaceElevation(model, r.x, r.y)));
});

test('HD lighting height texture preserves elevations and leaves geometry unchanged', () => {
  const n = 17, size = 1024, heights = Float32Array.from({ length: n * n }, (_, k) => 22 + Math.sin(k * .5) * 15);
  const before = heights.slice(), model = new TerrainModel({ size, n, heights, seed: 'hd-height' });
  const pixels = terrainHeightPixels(model);
  for (let y = 0; y < 256; y += 7) for (let x = 0; x < 256; x += 7) {
    const k = (y * 256 + x) * 4;
    const reconstructed = model.min + ((pixels[k] << 8) + pixels[k + 1]) / 65535 * (model.max - model.min);
    assert.ok(Math.abs(reconstructed - surfaceElevation(model, x / 255 * size, y / 255 * size)) < .001);
    assert.equal(pixels[k + 3], 255);
  }
  assert.deepEqual(heights, before);
});
