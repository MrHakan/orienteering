// QuizCandidateGenerator: finds distractor locations that are geographically
// different from the true observer position but produce a plausible,
// moderately similar view for the same heading.

import { descriptorDistance } from './skyline.js';
import { TerrainAnalyzer } from './analyzer.js';

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
  }

  describe(x, y, view) {
    return this.model.skyline.viewDescriptor(x, y, view.heading, view.fov, { eyeHeight: view.eyeHeight, columns: VIEW_COLUMNS });
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

    const margin = 100, spacing = 62;
    const cells = Math.floor((model.size - 2 * margin) / spacing);
    const band = preset.band;
    const candidates = [];
    let considered = 0;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const x = margin + (i + rng.range(0.1, 0.9)) * spacing;
        const y = margin + (j + rng.range(0.1, 0.9)) * spacing;
        if (Math.hypot(x - view.x, y - view.y) < preset.minSeparation) continue;
        if (model.getSlope(x, y) > 28) continue;
        considered++;
        const desc = this.describe(x, y, view);
        // An option the player cannot evaluate from the map is not a fair distractor.
        if (desc.edgeFrac > 0.45) continue;
        if (desc.blockedFrac > Math.max(0.5, correctDesc.blockedFrac + 0.25)) continue;
        const D = descriptorDistance(correctDesc, desc);
        if (D < band.min || D > band.max) continue;
        candidates.push({ x, y, D, desc });
      }
    }

    // Terrain signature similarity (includes the full 360 skyline).
    for (const c of candidates) {
      c.signature = analyzer.getTerrainSignature(c.x, c.y, { eyeHeight: view.eyeHeight });
      c.sigDist = TerrainAnalyzer.signatureDistance(correctSig, c.signature, relief);
      const spread = 0.5 * (band.max - band.min);
      const bandScore = Math.exp(-(((c.D - band.target) / spread) ** 2));
      const sigScore = Math.exp(-1.6 * c.sigDist);
      const w = preset.signatureWeight;
      c.score = (1 - w) * bandScore + w * sigScore;
    }

    const chosen = [];
    const pool = candidates.slice();
    while (chosen.length < count && pool.length) {
      const c = rng.weighted(pool, (p) => p.score ** 3);
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
