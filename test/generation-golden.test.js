// Golden generation digest (hard-master brief, compatibility rule): rendering-only changes (review sheet,
// friend high-visibility drawing) must never change WHICH quiz a seed/hash produces. Old episode hashes in the
// production ledger are re-rendered for answer images, so these digests pin the generated quiz content for the
// three main master modes at 8x8 (and grid lost-compass). If this fails, a change altered generation: put it
// behind a new hash parameter instead of updating the digest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generate } from '../src/engine/quiz.js';

const round = (v) => (typeof v === 'number' ? +v.toFixed(4) : v);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, round(o[k])]));
function fingerprint(q) {
  return {
    mode: q.mode, correctLabel: q.correctLabel, hardness: round(q.hardness), lowConfidence: !!q.lowConfidence, mapRotation: round(q.mapRotation),
    camera: pick(q.camera, ['x', 'y', 'z', 'heading', 'pitch', 'fov', 'eyeHeight']),
    heading: q.heading ? { text: q.heading.text, mode: q.heading.mode } : null,
    grid: q.grid ? { size: q.grid.size, challenge: q.grid.challenge ?? null, origin: q.grid.origin ?? null } : null,
    friend: q.friend ? pick(q.friend, ['x', 'y', 'z', 'height', 'heading', 'distance', 'angularHeight', 'challenge', 'skin']) : null,
    peaks: q.resection?.peaks?.map((p) => pick(p, ['x', 'y', 'bearing', 'elevation', 'label'])) ?? null,
    options: (q.options || []).map((o) => pick(o, ['label', 'x', 'y'])),
    terrain: { modelSeed: q.terrain?.modelSeed, world: q.terrain?.world, size: q.terrain?.size },
  };
}
const CASES = [
  ['grid-a', { seed: 'tg-2026-11-29-1f', world: 'glacial', mode: 'grid', gridSize: 8 }],
  ['grid-b', { seed: 'tg-2026-11-30-3c', world: 'classic', mode: 'grid', gridSize: 8 }],
  ['grid-lost-compass', { seed: 'tg-2026-11-30-2c', world: 'glacial', mode: 'grid', gridSize: 8, gridChallenge: 'lost-compass' }],
  ['resection-a', { seed: 'tg-2026-11-28-2a', world: 'classic', mode: 'resection', resectionAnswer: 'grid', gridSize: 8 }],
  ['resection-b', { seed: 'tg-2026-11-29-2c', world: 'alpine', mode: 'resection', resectionAnswer: 'grid', gridSize: 8 }],
  ['friend-a', { seed: 'tg-2026-11-27-1d', world: 'classic', mode: 'friend', friendAnswer: 'grid', gridSize: 8 }],
  ['friend-b', { seed: 'tg-2026-11-28-3b', world: 'karst', mode: 'friend', friendAnswer: 'grid', gridSize: 8 }],
];
// Recorded on engine 01d52b7 (origin/main, 2026-11-27) before any hard-master change.
const GOLDEN = {
  'grid-a': { label: 'E1', digest: 'c79f2e7b7873eea8' },
  'grid-b': { label: 'H3', digest: 'c58bf4c809972d79' },
  'grid-lost-compass': { label: 'C5', digest: 'b3f2200b8b5f0c3c' },
  'resection-a': { label: 'E3', digest: '5ca17046c047d566' },
  'resection-b': { label: 'E3', digest: 'a4a3ccbbe72e65ed' },
  'friend-a': { label: 'E7', digest: 'f9a78bb011578d3f' },
  'friend-b': { label: 'D3', digest: '1725a91a537cd75a' },
};

test('golden generation digest: master grid / lost-compass / resection / friend 8x8 quizzes are unchanged', async () => {
  const got = {};
  for (const [id, opts] of CASES) {
    const q = await generate({ difficulty: 'master', ...opts });
    got[id] = { label: q.correctLabel, digest: createHash('sha256').update(JSON.stringify(fingerprint(q))).digest('hex').slice(0, 16) };
  }
  if (process.env.PRINT_GOLDEN) console.log(JSON.stringify(got, null, 1));
  assert.deepEqual(got, GOLDEN);
});
