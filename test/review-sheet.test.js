// Review sheet (hard-master brief items 3/4): which clip moments the blind fairness reviewer gets besides the
// question still. Rendering-only: the quiz itself is pinned by generation-golden.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { reviewFrameTimes, REVIEW_STRIP_LABEL, parseReviewTimes, reviewMoment } from '../src/export/composer.js';
import { friendVideoZoom, friendSceneFrame } from '../src/export/friendZoom.js';
import { resectionFrame } from '../src/engine/resectionQuiz.js';

test('reviewFrameTimes: friend -> the 3x zoom moment; resection -> the view to every later peak; grid -> none', async () => {
  const friend = await generate({ seed: 'tg-2026-11-27-1d', difficulty: 'master', mode: 'friend', friendAnswer: 'grid', gridSize: 8 });
  const [z] = reviewFrameTimes(friend);
  assert.deepEqual(reviewFrameTimes(friend), [{ time: 6.5, animated: true, label: 'SAME CLIP AT 6.5 s · 3× ZOOM' }]);
  assert.equal(friendVideoZoom(z.time), 3, 'the strip shows the clip at its full zoom');
  const wide = friendSceneFrame(friend, 4, false).camera, zoomed = friendSceneFrame(friend, z.time, true).camera;
  assert.equal(wide.fov, friend.camera.fov, 'the question still (not animated) is the wide view');
  assert.ok(zoomed.fov < wide.fov / 2.5);
  assert.deepEqual([zoomed.x, zoomed.y, zoomed.heading], [wide.x, wide.y, wide.heading], 'zoom only: same eye, same bearing');

  const res = await generate({ seed: 'tg-2026-11-28-2a', difficulty: 'master', mode: 'resection', resectionAnswer: 'grid', gridSize: 8 });
  assert.equal(res.resection.peaks.length, 2);
  const times = reviewFrameTimes(res);
  assert.deepEqual(times, [{ time: 12, animated: false, label: 'SAME CLIP AT 12 s · VIEW TO P2' }]);
  const at = (t) => resectionFrame(res, t);
  assert.equal(at(4).focus, 0); assert.equal(at(12).focus, 1);
  assert.ok(Math.abs(((at(12).heading - res.resection.peaks[1].bearing + 540) % 360) - 180) < 1e-6, 'the pan to P2 is complete at 12 s');

  const grid = await generate({ seed: 'tg-2026-11-29-1f', difficulty: 'master', mode: 'grid', gridSize: 8, world: 'glacial' });
  assert.deepEqual(reviewFrameTimes(grid), []);
  assert.equal(REVIEW_STRIP_LABEL, 56);
});

test('review times chosen by the runtime (data-review-times): resection at 1 s and 14 s faces P1, then P2', async () => {
  assert.equal(parseReviewTimes(undefined), null);
  assert.equal(parseReviewTimes(' '), null);
  assert.deepEqual(parseReviewTimes('1,14'), [1, 14]);
  assert.deepEqual(parseReviewTimes(' 1 , 6.5 ,14', 15), [1, 6.5, 14]);
  for (const bad of ['14', '1,', '1,x', '14,1', '1,1', '-1,4', '1,15', '1,2,3,4,5'])
    assert.throws(() => parseReviewTimes(bad, 15), /invalid review times/, bad);
  const res = await generate({ seed: 'tg-2026-11-28-2a', difficulty: 'master', mode: 'resection', resectionAnswer: 'grid', gridSize: 8 });
  assert.equal(resectionFrame(res, 1).focus, 0, 'the still at 1 s looks at P1');
  assert.deepEqual(reviewMoment(res, 14), { time: 14, animated: false, label: 'SAME CLIP AT 14 s · VIEW TO P2' });
  const grid = await generate({ seed: 'tg-2026-11-29-1f', difficulty: 'master', mode: 'grid', gridSize: 8, world: 'glacial' });
  assert.deepEqual(reviewMoment(grid, 14), { time: 14, animated: false, label: 'SAME CLIP AT 14 s' });
});

test('friend high-visibility drawing: the walker figure only (never the sniper target), fog share 0.35', async () => {
  const { personHighVis, PERSON_HIGHVIS_FOG } = await import('../src/render/webglTerrain.js');
  assert.equal(PERSON_HIGHVIS_FOG, 0.35);
  assert.equal(personHighVis({ skin: 'classic' }), true);
  assert.equal(personHighVis({ skin: 'conquest' }), true);
  assert.equal(personHighVis({ skin: 'sniper', pose: 'prone' }), false);
  assert.equal(personHighVis(null), false);
});
