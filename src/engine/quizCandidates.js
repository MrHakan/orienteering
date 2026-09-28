// QuizCandidateGenerator: finds distractor locations that are geographically
// different from the true observer position but produce a plausible,
// moderately similar view for the same heading.

import { descriptorDistance } from './skyline.js';
import { TerrainAnalyzer } from './analyzer.js';
import { wrap360 } from './grid.js';

export const VIEW_COLUMNS = 33;

export class QuizCandidateGenerator {
  /**
   * @param {import('./terrainModel.js').TerrainModel} model
   * @param {object} preset difficulty preset
   * @param {import('./rng.js').Random} rng
   */
  constructor(model, preset, rng) {
    this.model = model;
    this.preset = preset;
    this.rng = rng;
    // The candidate grid and its per-heading view descriptors are cached so
    // that many viewpoints can be tried on one terrain (Master mode).
    this.grid = null;
    this.descCache = new Map();
    this.sigCache = new Map();
  }

  describe(x, y, view) {
    return this.model.skyline.viewDescriptor(x, y, view.heading, view.fov, { eyeHeight: view.eyeHeight, columns: VIEW_COLUMNS });
  }

  candidateGrid() {
    if (this.grid) return this.grid;
    const { model, rng } = this;
    const margin = 100, spacing = 62;
    const cells = Math.floor((model.size - 2 * margin) / spacing);
    const grid = [];
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const x = margin + (i + rng.range(0.1, 0.9)) * spacing;
        const y = margin + (j + rng.range(0.1, 0.9)) * spacing;
        if (model.getSlope(x, y) > 28) continue;
        grid.push({ id: grid.length, x, y });
      }
    }
    return (this.grid = grid);
  }

  descriptors(view) {
    const key = `${view.heading}|${view.fov}|${view.eyeHeight}`;
    if (!this.descCache.has(key)) this.descCache.set(key, this.candidateGrid().map((p) => this.describe(p.x, p.y, view)));
    return this.descCache.get(key);
  }

  signature(p, eyeHeight) {
    if (!this.sigCache.has(p.id)) this.sigCache.set(p.id, this.model.analyzer.getTerrainSignature(p.x, p.y, { eyeHeight }));
    return this.sigCache.get(p.id);
  }

  /**
   * @param {{x:number,y:number,heading:number,fov:number,eyeHeight:number}} view true observer
   * @returns {{distractors:Array, correct:object, considered:number, inBand:number}}
   */
  generate(view, count = this.preset.distractors) {
    const { model, preset, rng } = this;
    const analyzer = model.analyzer;
    const relief = model.max - model.min;
    const correctDesc = this.describe(view.x, view.y, view);
    const correctSig = analyzer.getTerrainSignature(view.x, view.y, { eyeHeight: view.eyeHeight });
    const band = preset.band;
    const grid = this.candidateGrid();
    const descs = this.descriptors(view);

    const candidates = [];
    let considered = 0;
    for (const p of grid) {
      if (Math.hypot(p.x - view.x, p.y - view.y) < preset.minSeparation) continue;
      considered++;
      const desc = descs[p.id];
      // An option the player cannot evaluate from the map is not a fair distractor.
      if (desc.edgeFrac > 0.45) continue;
      if (desc.blockedFrac > Math.max(0.5, correctDesc.blockedFrac + 0.25)) continue;
      const D = descriptorDistance(correctDesc, desc);
      if (D < band.min || D > band.max) continue;
      candidates.push({ ...p, D, desc, cue: distinguishingCue(correctDesc, desc) });
    }

    // Terrain signature similarity (includes the full 360 skyline).
    const w = preset.signatureWeight;
    const spread = 0.5 * (band.max - band.min);
    for (const c of candidates) {
      c.signature = this.signature(c, view.eyeHeight);
      c.sigDist = TerrainAnalyzer.signatureDistance(correctSig, c.signature, relief);
      const bandScore = Math.exp(-(((c.D - band.target) / spread) ** 2));
      const sigScore = Math.exp(-1.6 * c.sigDist);
      c.score = (1 - w) * bandScore + w * sigScore;
      // A distractor must differ somewhere the player can actually see.
      if (preset.search && c.cue.magnitude < preset.search.cue) c.score *= 0.05;
    }

    const chosen = [];
    const pool = candidates.slice();
    const power = preset.search?.pickPower ?? 3;
    while (chosen.length < count && pool.length) {
      const c = rng.weighted(pool, (p) => p.score ** power);
      pool.splice(pool.indexOf(c), 1);
      if (chosen.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < preset.minSeparation)) continue;
      if (chosen.some((q) => descriptorDistance(q.desc, c.desc) < band.min * 0.8)) continue;
      chosen.push(c);
    }

    return {
      correct: { x: view.x, y: view.y, desc: correctDesc, signature: correctSig },
      distractors: chosen,
      considered,
      inBand: candidates.length,
    };
  }
}

/**
 * Where the distractor's view differs most from the true view: the bearing
 * and size (degrees) of the largest, slightly smoothed horizon difference.
 * This is the detail a careful solver has to spot.
 */
export function distinguishingCue(a, b) {
  const n = a.horizon.length;
  let best = 0, bestC = 0;
  for (let c = 0; c < n; c++) {
    let s = 0, k = 0;
    for (let d = -1; d <= 1; d++) {
      const cc = c + d;
      if (cc < 0 || cc >= n) continue;
      s += b.horizon[cc] - a.horizon[cc]; k++;
    }
    const v = s / k;
    if (Math.abs(v) > Math.abs(best)) { best = v; bestC = c; }
  }
  return {
    magnitude: Math.abs(best),
    delta: best,
    bearing: Math.round(wrap360(a.heading - a.fov / 2 + (a.fov * bestC) / (n - 1))),
  };
}
