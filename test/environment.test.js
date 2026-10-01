import test from 'node:test';
import assert from 'node:assert/strict';
import { CONDITIONS, normaliseEnvironment, environmentFromWeather, weatherParams, windGust } from '../src/render/environment.js';
import { buildNatureMeshes } from '../src/render/natureMesh.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { surfaceElevation } from '../src/engine/terrainSurface.js';

test('environment preferences recover safely from stale or malformed storage', () => {
  for (const input of [null, false, '', { condition: 'lava', wind: 'hurricane', hd: 'true' }]) {
    assert.deepEqual(normaliseEnvironment(input), { condition: 'clear', wind: 'calm', hd: false, foliage: false, nature: false });
  }
  assert.equal(environmentFromWeather(['rain', 'wind']).condition, 'rain');
  assert.equal(environmentFromWeather(['rain', 'wind']).wind, 'strong');
  assert.equal(weatherParams(['rain'], 90).rain, true);
  assert.equal(weatherParams(['rain', 'fog'], 90).fog, 1);
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
  assert.ok(a.foliage.length / 13 > 10000 && a.foliage.length / 13 < 150000);
  assert.ok(a.nature.length > 0 && a.nature.length / 13 < 100000);
  for (const root of a.roots) {
    assert.ok(model.inside(root.x, root.y));
    assert.equal(root.z, surfaceElevation(model, root.x, root.y));
  }
  for (const mesh of [a.foliage, a.nature]) {
    assert.equal(mesh.length % 39, 0);
    for (let i = 0; i < mesh.length; i += 13) {
      const [x, z, south] = mesh.subarray(i + 9, i + 12);
      assert.ok(Math.abs(z - surfaceElevation(model, x, -south)) < .001);
      for (const value of mesh.subarray(i, i + 13)) assert.ok(Number.isFinite(value));
    }
  }
});
