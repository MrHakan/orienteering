// TerrainGenerator: builds the single elevation model that both the 3D scene
// and the contour map are derived from.
//
//   H(x,y) = H_base + H_landforms  (structured, domain-warped)
//          + H_noise               (multi-octave, scaled to a 20-35% share)
//          + H_erosion             (flow-accumulation channel carving, thermal)

import { LandformGenerator } from './landforms.js';
import { FractalNoise, DomainWarp } from './noise.js';
import { ErosionProcessor } from './erosion.js';
import { meanStd } from './grid.js';

export const DEFAULT_SIZE = 2000; // metres
export const DEFAULT_RES = 257;   // grid nodes per side

// Physical octave table from the spec (mid-range amplitudes, metres).
const NOISE_OCTAVES = [
  { wavelength: 1000, amplitude: 80 },
  { wavelength: 500, amplitude: 35 },
  { wavelength: 250, amplitude: 17 },
  { wavelength: 100, amplitude: 6 },
  { wavelength: 40, amplitude: 2 },
];

export class TerrainGenerator {
  /**
   * @param {import('./rng.js').Random} rng
   * @param {object} terrainPreset difficulty.terrain
   */
  static generate(rng, terrainPreset, { size = DEFAULT_SIZE, n = DEFAULT_RES } = {}) {
    const cell = size / (n - 1);
    const archetypeCount = rng.fork('count').int(terrainPreset.archetypes[0], terrainPreset.archetypes[1]);

    const landforms = new LandformGenerator(rng.fork('landforms'), {
      size, relief: terrainPreset.relief, complexity: terrainPreset.complexity, archetypeCount,
    }).build();

    const warp = new DomainWarp(rng.fork('warp'), {
      amplitude: rng.fork('warp-amp').range(55, 110),
    });
    const noise = new FractalNoise(rng.fork('noise'), NOISE_OCTAVES);

    // Calibrate the noise share on a coarse grid: std(noise) / (std(struct) + std(noise)) = share.
    const share = rng.fork('share').range(terrainPreset.noiseShare[0], terrainPreset.noiseShare[1]);
    const cn = 49;
    const cs = new Float32Array(cn * cn), cz = new Float32Array(cn * cn);
    const w = { x: 0, y: 0 };
    for (let j = 0; j < cn; j++) {
      for (let i = 0; i < cn; i++) {
        const x = (i / (cn - 1)) * size, y = (j / (cn - 1)) * size;
        warp.warp(x, y, w);
        cs[j * cn + i] = landforms.evaluate(w.x, w.y) - landforms.baseHeight(w.x, w.y);
        cz[j * cn + i] = noise.sample(x, y);
      }
    }
    const sStd = meanStd(cs).std, zStd = meanStd(cz).std || 1;
    const noiseScale = ((share / (1 - share)) * sStd) / zStd;

    const heights = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = i * cell, y = j * cell;
        warp.warp(x, y, w);
        heights[j * n + i] = landforms.evaluate(w.x, w.y) + noiseScale * noise.sample(x, y);
      }
    }

    // Erosion and drainage.
    const erosion = new ErosionProcessor({ n, cell });
    erosion.fluvial(heights, { strength: 0.9 + 0.6 * terrainPreset.complexity, threshold: 25, iterations: 2 });
    erosion.thermal(heights, { talusDeg: 33, iterations: 14 });
    const spikes = erosion.despike(heights, 2.0);
    // Small closed hollows (kettles, sinks) are post-erosion micro-landforms.
    landforms.applyDepressions(heights, n, cell, rng.fork('depressions'));
    // Closed depressions survive only where a depression/basin landform intended one.
    const keep = landforms.meta.depressions;
    erosion.resolveDepressions(heights, { keep });
    const depressions = erosion.resolveDepressions(heights, { keep, fillSlope: 0.005 }).kept;

    let min = Infinity, max = -Infinity;
    for (let k = 0; k < heights.length; k++) {
      if (heights[k] < min) min = heights[k];
      if (heights[k] > max) max = heights[k];
    }
    // Keep the lowest ground comfortably above sea level (whole-metre shift so
    // contour levels stay aligned with round numbers).
    const floor = Math.round(rng.fork('floor').range(15, 60));
    if (min < floor) {
      const shift = Math.ceil(floor - min);
      for (let k = 0; k < heights.length; k++) heights[k] += shift;
      min += shift; max += shift;
    }

    return {
      size, n, cell, heights,
      meta: {
        archetypes: landforms.meta.archetypes,
        landforms: landforms.meta,
        base: landforms.base,
        noiseShare: share,
        structStd: sStd,
        min, max,
        spikesRemoved: spikes,
        closedDepressions: depressions,
      },
    };
  }
}
