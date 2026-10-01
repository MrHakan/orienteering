import { Random } from '../engine/rng.js';

/** A seamless, mipmapped grass/soil detail tile; alpha carries stone grain. */
export function terrainDetailPixels(size = 512) {
  const rng = new Random('terrain-detail-v1'), data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const k = (y * size + x) * 4;
    const grain = rng.range(-25, 25);
    const fibre = Math.sin(x * .72 + Math.sin(y * .13) * 2) * 10;
    const soil = rng.chance(.035);
    data[k] = (soil ? 115 : 124) + grain + fibre;
    data[k + 1] = (soil ? 102 : 143) + grain + fibre;
    data[k + 2] = (soil ? 83 : 103) + grain;
    data[k + 3] = 128 + rng.range(-48, 48);
  }
  // Small overlapping blades make the tile read as grass at eye height.
  for (let i = 0; i < size * 5; i++) {
    const x = rng.int(0, size - 1), y = rng.int(0, size - 1), len = rng.int(4, 18);
    for (let j = 0; j < len; j++) {
      const xx = (x + Math.round(Math.sin(j / len * 2) * 2)) % size;
      const k = (((y + j) % size) * size + xx) * 4;
      data[k] = 108 + j * 2; data[k + 1] = 138 + j * 2; data[k + 2] = 79 + j;
    }
  }
  return data;
}
