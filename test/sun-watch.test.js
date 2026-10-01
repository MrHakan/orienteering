import test from 'node:test';
import assert from 'node:assert/strict';
import { solarPosition, createSunWatch, sunWatchFrame, WATCH_TIMING } from '../src/engine/sunWatch.js';
import { watchHandAngles } from '../src/render/watchViewModel.js';
import { angleDiff } from '../src/engine/grid.js';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';

const camera = Object.freeze({ x: 700, y: 850, z: 95, heading: 45, pitch: -2, fov: 50, eyeHeight: 1.7, roll: 0 });
const quiz = Object.freeze({ mode: 'facing', seed: 'sun-watch', difficulty: 'easy', camera, sunWatch: { hour24: 14, minute: 25, latitude: 40 } });

test('solar-time sunrise is east, afternoon is west, and the noon sun is south', () => {
  const morning = solarPosition(9), afternoon = solarPosition(15), noon = solarPosition(12);
  assert.ok(morning.azimuth > 90 && morning.azimuth < 180);
  assert.ok(afternoon.azimuth > 180 && afternoon.azimuth < 270);
  assert.ok(Math.abs(morning.altitude - afternoon.altitude) < 1e-10);
  assert.equal(noon.azimuth, 180);
  assert.ok(solarPosition(6).altitude < .000001 && solarPosition(18).altitude < .000001);
  assert.ok(solarPosition(0).altitude < 0);
  for (const time of [8, 9, 12, 14, 16]) assert.ok(Math.abs(Math.hypot(...solarPosition(time).direction) - 1) < 1e-12);
});

test('camera lowers at 2 seconds and the analog watch remains readable for 3 full seconds', () => {
  assert.equal(sunWatchFrame(quiz, 1.99).camera, camera);
  assert.equal(sunWatchFrame(quiz, 2).watch.progress, 0);
  assert.equal(WATCH_TIMING.end - WATCH_TIMING.readable, 3);
  for (let t = 2.5; t <= 5.5; t += .1) {
    const f = sunWatchFrame(quiz, t);
    assert.equal(f.camera.pitch, -64); assert.equal(f.camera.heading, camera.heading);
    assert.equal(f.watch.progress, 1);
    assert.equal(f.watch.hour24, quiz.sunWatch.hour24); assert.equal(f.watch.minute, quiz.sunWatch.minute);
  }
  assert.ok(sunWatchFrame(quiz, 2.25).camera.pitch < camera.pitch);
  assert.equal(sunWatchFrame(quiz, 6.4).watch.progress, 0);
});

test('look-around visits both sides, holds the visible sun, and returns to the original answer view', () => {
  for (const heading of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const q = { ...quiz, camera: { ...camera, heading } };
    const a = sunWatchFrame(q, WATCH_TIMING.first), b = sunWatchFrame(q, WATCH_TIMING.second);
    assert.ok(angleDiff(a.camera.heading, b.camera.heading) > 100);
    for (const t of [9.3, 9.8, 10.7]) {
      const f = sunWatchFrame(q, t);
      assert.ok(angleDiff(f.camera.heading, f.solar.azimuth) <= 20.1);
      assert.ok(Math.abs(f.camera.pitch - f.solar.altitude) <= 6.1);
    }
    for (const t of [0, 3.5, 7.5, 9.8, 12, 15, 1e6]) {
      const f = sunWatchFrame(q, t);
      for (const k of ['x', 'y', 'z', 'fov', 'roll', 'eyeHeight']) assert.equal(f.camera[k], q.camera[k]);
    }
    assert.deepEqual(sunWatchFrame(q, 12).camera, q.camera);
  }
  const before = JSON.stringify(quiz);
  for (const t of [9.8, 3.5, 12, 0, 3.5, NaN, -1]) assert.deepEqual(sunWatchFrame(quiz, t), sunWatchFrame(quiz, t));
  assert.equal(JSON.stringify(quiz), before);
  assert.equal(sunWatchFrame(quiz, 4, { active: false }).camera, camera);
});

test('analog hand positions include fractional hours, minutes and seconds', () => {
  const a = watchHandAngles({ hour24: 14, minute: 30, seconds: 0 });
  assert.ok(Math.abs(a.hour - Math.PI * 5 / 12) < 1e-12);
  assert.ok(Math.abs(a.minute - Math.PI) < 1e-12); assert.equal(a.second, 0);
  const b = watchHandAngles({ hour24: 9, minute: 15, seconds: 30 });
  assert.ok(Math.abs(b.minute - Math.PI * 31 / 60) < 1e-12);
  assert.ok(Math.abs(b.second - Math.PI) < 1e-12);
});

test('time selection is seeded independently of answer labels and rejects a hidden sun', () => {
  const model = { skyline: { castRay: () => ({ angle: 0 }) } };
  assert.deepEqual(createSunWatch(quiz, model), createSunWatch({ ...quiz, correctLabel: 'W' }, model));
  assert.throws(() => createSunWatch(quiz, { skyline: { castRay: () => ({ angle: 80 }) } }), /visible daylight/);
});

test('generated direction questions retain valid answers, reproducible time and a clear solar line of sight', async () => {
  const q = await generate({ seed: 'facing-t', difficulty: 'easy', mode: 'facing' });
  const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
  assert.deepEqual(q.sunWatch, createSunWatch(q, model));
  assert.equal(q.options.find(o => o.correct).heading, q.camera.heading);
  const sun = solarPosition(q.sunWatch.hour24, q.sunWatch.minute);
  assert.ok(sun.altitude > model.skyline.castRay(q.camera.x, q.camera.y, q.camera.z, sun.azimuth).angle + 4);
});
