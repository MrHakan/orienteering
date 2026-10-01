import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { conquestArrival, normaliseFriendSkin } from '../src/engine/friendAppearance.js';
import { friendSceneFrame, friendVideoZoom } from '../src/export/friendZoom.js';

test('Conquest waits three seconds, zooms normally, descends slowly and returns before the answer', () => {
  for (const t of [0, 1, 3, 4, 4.99]) {
    const frame = conquestArrival(t);
    assert.equal(frame.zoom, friendVideoZoom(t)); assert.equal(frame.sprite, false);
  }
  assert.equal(conquestArrival(5).altitude, 24);
  let previous = 24;
  for (let t = 5; t <= 10; t += 1 / 30) {
    const frame = conquestArrival(t);
    assert.equal(frame.sprite, true); assert.equal(frame.zoom, 3);
    assert.ok(frame.altitude >= 0 && frame.altitude <= previous);
    previous = frame.altitude;
  }
  for (const t of [10, 11, 12, 15]) assert.equal(conquestArrival(t).altitude, 0);
  for (const t of [12, 15]) {
    assert.equal(conquestArrival(t).zoom, 1); assert.equal(conquestArrival(t).focus, 0);
  }
  assert.equal(normaliseFriendSkin('conquest'), 'conquest');
  assert.equal(normaliseFriendSkin('missing'), 'classic');
});

test('camera tracks the descending image from the fixed observer and seeking reproduces the frame', () => {
  const quiz = Object.freeze({ mode: 'friend', camera: Object.freeze({ x: 50, y: 100, z: 20, heading: 15, pitch: -3, fov: 50 }),
    friend: Object.freeze({ x: 80, y: 200, z: 18, height: 1.8, skin: 'conquest' }) });
  const original = JSON.stringify(quiz);
  for (const t of [6, 9, 7, 6, 10]) {
    const frame = friendSceneFrame(quiz, t, true), camera = frame.camera;
    assert.deepEqual(frame, friendSceneFrame(quiz, t, true));
    for (const key of ['x', 'y', 'z']) assert.equal(camera[key], quiz.camera[key]);
    assert.ok(Math.abs(camera.heading - Math.atan2(30, 100) * 180 / Math.PI) < 1e-10);
    const pitch = Math.atan2(quiz.friend.z + frame.personMotion.altitude + .9 - camera.z, Math.hypot(30, 100)) * 180 / Math.PI;
    assert.ok(Math.abs(camera.pitch - pitch) < 1e-10);
    assert.ok(Math.abs(Math.tan(25 * Math.PI / 180) / Math.tan(camera.fov * Math.PI / 360) - 3) < 1e-10);
  }
  assert.equal(friendSceneFrame(quiz, 12, true).camera, quiz.camera);
  const png = friendSceneFrame(quiz, 7, false);
  assert.equal(png.camera, quiz.camera); assert.equal(png.personMotion.altitude, 0); assert.equal(png.personMotion.sprite, true);
  assert.equal(JSON.stringify(quiz), original);
});

test('character selection preserves qualified terrain, target position and the correct grid cell', async () => {
  const opts = { seed: 'friend-demo', difficulty: 'medium', mode: 'friend', friendAnswer: 'grid', gridSize: 6 };
  const classic = await generate(opts), conquest = await generate({ ...opts, friendSkin: 'conquest' });
  assert.equal(conquest.friend.skin, 'conquest');
  assert.deepEqual(conquest.camera, classic.camera);
  assert.deepEqual(conquest.terrain.heights, classic.terrain.heights);
  assert.deepEqual(conquest.options, classic.options);
  assert.deepEqual(conquest.grid, classic.grid);
  assert.equal(conquest.correctLabel, classic.correctLabel);
  for (const key of ['x', 'y', 'z', 'height']) assert.equal(conquest.friend[key], classic.friend[key]);
});
