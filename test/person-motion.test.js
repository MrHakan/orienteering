import test from 'node:test';
import assert from 'node:assert/strict';
import { personVertices } from '../src/render/personMesh.js';
import { TerrainRenderer } from '../src/render/webglTerrain.js';

const person = Object.freeze({ x: 100, y: 200, z: 50, height: 1.8, heading: 0 });
const feet = vertices => {
  const out = [];
  for (let i = 0; i < vertices.length; i += 9) if (vertices[i + 1] < person.z + .8) out.push(...vertices.slice(i, i + 9));
  return out;
};

test('waving changes the raised arm over time while keeping feet fixed and normals unit length', () => {
  const neutral = personVertices(person), a = personVertices(person, { wave: 1, time: .1 });
  const b = personVertices(person, { wave: 1, time: .3 });
  assert.notDeepEqual(a, b);
  assert.deepEqual(a, personVertices(person, { wave: 1, time: .1 })); // seeking/replay
  for (const wave of [0, .25, .5, 1]) for (const time of [0, .1, .3, 7]) {
    const vertices = personVertices(person, { wave, time });
    assert.deepEqual(feet(vertices), feet(neutral));
    for (let i = 0; i < vertices.length; i += 9) {
      assert.ok(Array.from(vertices.slice(i, i + 9)).every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...vertices.slice(i + 3, i + 6)) - 1) < 1e-6);
    }
  }
  assert.ok(Array.from(a).some((v, i) => i % 9 === 0 && v > person.x + .4)); // raised hand beyond torso
  assert.deepEqual(personVertices(person, { wave: 0, time: 7 }), neutral);
});

test('person GPU pose resets on zoom out and reuses unchanged poses without redundant uploads', () => {
  const renderer = Object.create(TerrainRenderer.prototype), uploads = [];
  renderer.gl = { bindBuffer() {}, bufferData: (_target, vertices) => uploads.push(vertices) };
  renderer.setPerson(person);
  const neutral = uploads.at(-1);
  renderer.updatePersonMotion({ wave: 1, time: .1 });
  const raised = uploads.at(-1), count = uploads.length;
  assert.notDeepEqual(raised, neutral);
  renderer.setPerson({ ...person }); // answer comparison at the same position
  renderer.updatePersonMotion({ wave: 1, time: .1 });
  assert.equal(uploads.length, count);
  renderer.updatePersonMotion({ wave: 1, time: .3 });
  assert.notDeepEqual(uploads.at(-1), raised);
  renderer.updatePersonMotion();
  assert.deepEqual(uploads.at(-1), neutral);
  renderer.setPerson(null);
  assert.equal(renderer.personCount, 0);
});
