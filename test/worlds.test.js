import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TerrainGenerator } from '../src/engine/terrainGenerator.js';
import { SeedManager } from '../src/engine/rng.js';
import { getDifficulty } from '../src/engine/difficulty.js';
import { buildTerrain, generate } from '../src/engine/quiz.js';
import { WORLDS, WORLD_IDS, WORLD_CHOICES, normaliseWorld, resolveWorld } from '../src/engine/worlds.js';
import { terrainTexture } from '../src/render/terrainTextures.js';

const hash = (heights) => createHash('sha256').update(Buffer.from(heights.buffer)).digest('hex').slice(0, 16);
const terrain = (world, seed = 'world-a', difficulty = 'medium') =>
  buildTerrain({ seed, difficulty, attempt: 0, preset: getDifficulty(difficulty), seeds: new SeedManager(`${seed}#${difficulty}`), world });

test('classic terrain is byte-for-byte the original recipe', () => {
  // Hashes recorded from the generator before world types existed: old links keep their terrain.
  for (const [seed, difficulty, expected] of [['golden-a', 'medium', 'ddc02126270e62de'], ['golden-b', 'master', '165912e084264fe5']]) {
    const preset = getDifficulty(difficulty).terrain, stream = () => new SeedManager(`${seed}#${difficulty}`).stream('terrain', 0);
    assert.equal(hash(TerrainGenerator.generate(stream(), preset).heights), expected);
    assert.equal(hash(TerrainGenerator.generate(stream(), preset, { world: 'classic' }).heights), expected);
  }
});

test('world choices normalise, and auto resolves from the seed alone', () => {
  assert.deepEqual(WORLD_CHOICES, ['auto', ...WORLD_IDS]);
  assert.equal(normaliseWorld(undefined), 'classic');
  assert.equal(normaliseWorld('lava'), 'classic');
  assert.equal(normaliseWorld('karst'), 'karst');
  assert.equal(resolveWorld('dunes', 'x'), 'dunes');
  const picks = new Set();
  for (let i = 0; i < 60; i++) {
    const world = resolveWorld('auto', `seed-${i}`);
    assert.ok(WORLD_IDS.includes(world));
    assert.equal(resolveWorld('auto', `seed-${i}`), world);
    picks.add(world);
  }
  assert.equal(picks.size, WORLD_IDS.length, 'auto reaches every world type');
  assert.throws(() => TerrainGenerator.generate(new SeedManager('x').stream('terrain', 0), getDifficulty('medium').terrain, { world: 'lava' }), /Unknown world/);
});

test('every world type is deterministic, valid and distinct from classic', () => {
  const classic = hash(terrain('classic').model.heights);
  for (const world of WORLD_IDS.filter((id) => id !== 'classic')) {
    const a = terrain(world), b = terrain(world);
    assert.equal(hash(a.model.heights), hash(b.model.heights), `${world} is deterministic`);
    assert.notEqual(hash(a.model.heights), classic, `${world} differs from classic`);
    assert.ok(a.terrainCheck.ok, `${world}: ${a.terrainCheck.issues.join('; ')}`);
    assert.equal(a.model.meta.world, world);
    assert.match(a.model.seed, new RegExp(`#${world}$`));
  }
});

test('world types carry their own landforms', () => {
  const meta = (world) => terrain(world).model.meta.landforms;
  assert.ok(meta('alpine').reentrants.some((r) => r.kind === 'cirque'), 'alpine cirques');

  const karst = terrain('karst').model.meta;
  assert.ok(karst.landforms.hills.filter((h) => h.kind === 'cone').length >= 4, 'karst cone hills');
  assert.ok(karst.landforms.depressions.filter((d) => d.kind === 'doline').length >= 6, 'karst dolines stamped');
  assert.ok(karst.closedDepressions >= 1, 'some dolines stay closed');

  const glacial = meta('glacial');
  const drumlins = glacial.hills.filter((h) => h.kind === 'drumlin');
  assert.ok(drumlins.length >= 10, 'drumlin swarm');
  assert.ok(glacial.ridges.some((r) => r.kind === 'esker'), 'esker');
  assert.ok(glacial.depressions.some((d) => d.kind === 'kettle'), 'kettle holes');

  const canyon = meta('canyon');
  assert.ok(canyon.valleys.some((v) => v.kind === 'canyon'), 'canyon gorge');
  assert.ok(canyon.plateaus.length >= 2, 'mesas and buttes');

  const dunes = meta('dunes');
  assert.ok(dunes.ridges.filter((r) => r.kind === 'dune').length >= 8, 'dune crests');
  assert.deepEqual(dunes.archetypes, [], 'dunes use only their own landforms');
});

test('quizzes record the world, and auto uses the resolved world', async () => {
  const q = await generate({ seed: 'world-quiz', difficulty: 'medium', mode: 'grid', world: 'karst' });
  assert.equal(q.terrain.world, 'karst');
  assert.equal(q.worldChoice, 'karst');
  const auto = await generate({ seed: 'world-quiz', difficulty: 'medium', mode: 'grid', world: 'auto' });
  assert.equal(auto.worldChoice, 'auto');
  assert.equal(auto.terrain.world, resolveWorld('auto', 'world-quiz'));
  const plain = await generate({ seed: 'world-quiz', difficulty: 'medium', mode: 'grid' });
  assert.equal(plain.terrain.world, 'classic');
  assert.equal(plain.worldChoice, 'classic');
});

test('auto texture follows the world surface; an explicit style still wins', () => {
  for (const world of WORLD_IDS) {
    const auto = terrainTexture('tex-seed', 'auto', world);
    if (WORLDS[world].texture) assert.equal(auto.id, WORLDS[world].texture);
    else assert.deepEqual(auto, terrainTexture('tex-seed'));
    assert.equal(terrainTexture('tex-seed', 'autumn', world).id, 'autumn');
  }
});
