import test from 'node:test';
import assert from 'node:assert/strict';
import { solarPosition, createSunWatch, sunWatchFrame, WATCH_TIMING, FRIEND_WATCH_TIMING, SUN_WATCH_DURATION, usesSunWatch, watchTiming } from '../src/engine/sunWatch.js';
import { descriptorDistance } from '../src/engine/skyline.js';
import { compareSunWatchViews } from '../src/engine/sunWatchQuiz.js';
import { getDifficulty } from '../src/engine/difficulty.js';
import { friendSceneFrame } from '../src/export/friendZoom.js';
import { personSight, friendObserver } from '../src/engine/friendQuiz.js';
import { cellAtExtent } from '../src/engine/gridQuiz.js';
import { scrambleLabels } from '../src/engine/scramble.js';
import { captionText } from '../src/export/composer.js';
import { watchHandAngles } from '../src/render/watchViewModel.js';
import { angleDiff, wrap360 } from '../src/engine/grid.js';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';

const camera = Object.freeze({ x: 700, y: 850, z: 95, heading: 45, pitch: -2, fov: 50, eyeHeight: 1.7, roll: 0 });
const quiz = Object.freeze({ mode: 'where-am-i', seed: 'sun-watch', difficulty: 'sun-watch', camera, sunWatch: { hour24: 14, minute: 25, latitude: 40 } });

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
  assert.equal(sunWatchFrame(quiz, WATCH_TIMING.sky).watch.progress, 0);
});

test('camera turns directly to the centred sun, then retraces its path to the original view', () => {
  const signed = (a, b) => wrap360(a - b + 180) - 180;
  for (const mode of ['where-am-i', 'friend']) for (const hour24 of [8, 14]) {
    const sunWatch = { ...quiz.sunWatch, hour24 };
    const timing = watchTiming({ mode });
    const anchor = solarPosition(hour24, sunWatch.minute, timing.aim, sunWatch.latitude);
    // Include wraparound and a sun almost exactly behind the player.
    for (const heading of [0, 1, 45, 90, 135, 180, 225, 270, 315, 359,
      wrap360(anchor.azimuth + 180), wrap360(solarPosition(hour24, sunWatch.minute).azimuth + 180)]) {
      const q = { ...quiz, mode, sunWatch, camera: { ...camera, heading } };
      const target = signed(anchor.azimuth, heading), side = Math.sign(target) || 1;
      assert.equal(sunWatchFrame(q, timing.sky).camera.heading, heading);
      assert.equal(sunWatchFrame(q, timing.sky).camera.pitch, camera.pitch);
      let previous = heading, travelled = 0, previousTravel = 0;
      const dt = 1 / 60;
      for (let t = timing.sky; t < timing.finish; t += dt) {
        const f = sunWatchFrame(q, t), step = signed(f.camera.heading, previous);
        travelled += step; previous = f.camera.heading;
        // No snap at north or at the 180-degree shortest-path boundary.
        assert.ok(Math.abs(step) <= 130 * dt + .001, `${mode} turn is too fast at ${t}`);
        if (t <= timing.aim) assert.ok((travelled - previousTravel) * side >= -.001, 'no search away from the sun');
        if (t >= timing.return) assert.ok((travelled - previousTravel) * side <= .001, 'return follows the same arc');
        assert.ok(travelled * side >= -.02 && travelled * side <= Math.abs(target) + .02);
        previousTravel = travelled;
        for (const key of ['x', 'y', 'z', 'roll', 'eyeHeight']) assert.equal(f.camera[key], q.camera[key]);
      }
      for (const t of [timing.aim, (timing.aim + timing.return) / 2, timing.return]) {
        const f = sunWatchFrame(q, t);
        assert.ok(angleDiff(f.camera.heading, f.solar.azimuth) < 1e-9, 'sun is horizontally centred');
        assert.ok(Math.abs(f.camera.pitch - f.solar.altitude) < 1e-9, 'sun is vertically centred');
      }
      assert.deepEqual(sunWatchFrame(q, 15).camera, q.camera);
      assert.deepEqual(sunWatchFrame(q, 1e6).camera, q.camera);
    }
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

test('sun/watch is a location difficulty; ordinary direction questions keep their original camera', async () => {
  const ordinary = await generate({ seed: 'facing-t', difficulty: 'easy', mode: 'facing' });
  assert.equal(usesSunWatch(ordinary), false);
  assert.equal(ordinary.sunWatch, undefined);
  assert.deepEqual(sunWatchFrame(ordinary, 4).camera, ordinary.camera);
  const q = await generate({ seed: 'sun-places', difficulty: 'sun-watch', mode: 'where-am-i' });
  const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
  assert.deepEqual(q.sunWatch, createSunWatch(q, model));
  assert.equal(q.options.find(o => o.correct).heading, q.camera.heading);
  const sun = solarPosition(q.sunWatch.hour24, q.sunWatch.minute);
  assert.ok(sun.altitude > model.skyline.castRay(q.camera.x, q.camera.y, q.camera.z, sun.azimuth).angle + 4);
});

function verifyLocations(q) {
  const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
  const points = q.friend ? q.friend.matches || q.options : q.options;
  const cameras = points.map(o => o.observer || { ...q.camera, x: o.x, y: o.y, z: o.z + q.camera.eyeHeight, heading: o.heading });
  const describe = c => model.skyline.viewDescriptor(c.x, c.y, c.heading, c.fov,
    { eyeHeight: c.z - model.getElevation(c.x, c.y), columns: 49 });
  const views = cameras.map(describe), preset = getDifficulty('sun-watch');
  assert.equal(points.length, 3);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (a !== b) {
    assert.ok(angleDiff(cameras[a].heading, cameras[b].heading) >= 90);
    assert.ok(Math.hypot(cameras[a].x - cameras[b].x, cameras[a].y - cameras[b].y) >= 420);
    assert.ok(compareSunWatchViews(views[a], views[b], preset).ok, 'all pairs have similar terrain views');
    const wrongBearing = describe({ ...cameras[b], heading: cameras[a].heading });
    assert.ok(descriptorDistance(views[a], wrongBearing) >= 3.4, 'known heading eliminates each wrong place');
  }
  assert.equal(q.heading.text, ''); assert.equal(q.heading.arrow, ''); assert.equal(q.heading.mode, 'hidden');
  assert.doesNotMatch(captionText(q), /facing|\d+°|clock|watch|sun/i);
  return model;
}

test('three similar points need different bearings and the inferred bearing disambiguates every vertex', async () => {
  const relative = [];
  for (const seed of ['sun-places', 'facing-t', 'watch-d', 'watch-b', 'watch-e']) {
    const q = await generate({ seed, difficulty: 'sun-watch' });
    verifyLocations(q);
    relative.push((solarPosition(q.sunWatch.hour24, q.sunWatch.minute).azimuth - q.camera.heading + 540) % 360 - 180);
    const shuffled = scrambleLabels(q, 2);
    assert.deepEqual(shuffled.sunWatch, q.sunWatch);
    assert.deepEqual(shuffled.camera, q.camera);
    assert.deepEqual(shuffled.options.find(o => o.correct).heading, q.camera.heading);
  }
  assert.ok(relative.some(r => r > 30 && r < 90));
  assert.ok(relative.some(r => r < -90));
  assert.ok(relative.some(r => r > 90));
});

test('friend zoom finishes first, then waits one second before a three-second watch hold in a 15s sequence', () => {
  const q = { ...quiz, mode: 'friend', friend: { skin: 'classic' } };
  assert.equal(SUN_WATCH_DURATION, 15);
  const zoom = friendSceneFrame(q, 5, true);
  assert.ok(Math.abs(Math.tan(camera.fov * Math.PI / 360) / Math.tan(zoom.camera.fov * Math.PI / 360) - 3) < 1e-10);
  assert.equal(zoom.personMotion.wave, 1);
  assert.equal(zoom.watch.progress, 0);
  assert.equal(friendSceneFrame(q, 6, true).watch.progress, 0);
  assert.equal(FRIEND_WATCH_TIMING.down - 5, 1);
  assert.equal(FRIEND_WATCH_TIMING.end - FRIEND_WATCH_TIMING.readable, 3);
  for (const t of [6.5, 8, 9.5]) {
    const frame = friendSceneFrame(q, t, true);
    assert.equal(frame.watch.progress, 1); assert.equal(frame.camera.pitch, -64);
    assert.equal(frame.camera.fov, camera.fov);
  }
  assert.deepEqual(friendSceneFrame(q, 15, true).camera, camera);
  for (const t of [5, 8, 13.5, 15]) for (const key of ['x', 'y', 'z']) assert.equal(friendSceneFrame(q, t, true).camera[key], camera[key]);
});

test('friend point/grid sightings retain physical visibility, equal range and sun-qualified terrain matches', async () => {
  const opts = { seed: 'sun-places', difficulty: 'sun-watch', mode: 'friend' };
  const point = await generate(opts), model = verifyLocations(point);
  assert.equal(friendObserver(point), null);
  for (const o of point.options) {
    const sight = personSight(model, o.observer, o);
    assert.equal(sight.visible, true);
    assert.ok(Math.abs(sight.distance - point.options[0].distance) < 1e-9);
    assert.ok(Math.abs(sight.angularHeight - point.options[0].angularHeight) <= .015);
  }
  for (const size of [4, 6, 8, 16]) {
    const grid = await generate({ ...opts, friendAnswer: 'grid', gridSize: size, friendSkin: 'conquest' });
    verifyLocations(grid);
    assert.deepEqual(grid.camera, point.camera);
    assert.deepEqual(grid.sunWatch, point.sunWatch);
    assert.equal(grid.correctLabel, cellAtExtent(grid.friend.x, grid.friend.y, grid.mapExtent, size));
    assert.equal(grid.options.length, size * size);
    const landing = friendSceneFrame(grid, 6, true);
    assert.equal(landing.personMotion.altitude, 0); assert.equal(landing.personMotion.sprite, true);
    assert.equal(landing.watch.progress, 0);
  }
});

test('seeded replay ignores heading overrides and difficulty switches restore ordinary scenes', async () => {
  const opts = { seed: 'sun-places', difficulty: 'sun-watch', mode: 'lookalike' };
  const a = await generate(opts), b = await generate({ ...opts, headingMode: 'exact', direction: 'N', tuning: { distractors: 4 } });
  assert.deepEqual(a.camera, b.camera); assert.deepEqual(a.options, b.options); assert.deepEqual(a.sunWatch, b.sunWatch);
  verifyLocations(a);
  const ordinary = await generate({ ...opts, difficulty: 'medium', mode: 'where-am-i' });
  assert.equal(ordinary.sunWatch, undefined); assert.equal(usesSunWatch(ordinary), false);
  assert.ok(ordinary.heading.text.length > 0);
});
