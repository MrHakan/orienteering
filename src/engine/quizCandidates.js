// QuizCandidateGenerator: finds distractor locations that are geographically
// different from the true observer position but produce a plausible,
// moderately similar view for the same heading.

import { descriptorDistance, horizonDistance } from './skyline.js';
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

    // Similarity is searched across the whole map; distance and landform are
    // hard constraints, never part of the similarity itself. Nearby points
    // always look alike, so without these rules the "most similar" options
    // simply line up on the same slope as the true position.
    const minTrue = preset.minTrueDistance ?? preset.minSeparation;
    const sameLandform = preset.rejectSameLandform !== false;
    const candidates = [];
    let considered = 0;
    for (const p of grid) {
      if (Math.hypot(p.x - view.x, p.y - view.y) < minTrue) continue;
      considered++;
      const desc = descs[p.id];
      // An option the player cannot evaluate from the map is not a fair distractor.
      if (desc.edgeFrac > 0.45) continue;
      if (desc.blockedFrac > Math.max(0.5, correctDesc.blockedFrac + 0.25)) continue;
      const D = descriptorDistance(correctDesc, desc);
      if (D < band.min || D > band.max) continue;
      candidates.push({ ...p, D, desc, cue: distinguishingCue(correctDesc, desc) });
    }

    const w = preset.signatureWeight;
    const spread = 0.5 * (band.max - band.min);
    const kept = [];
    for (const c of candidates) {
      if (sameLandform && analyzer.sameFeature(view.x, view.y, c.x, c.y)) continue; // same hillside / valley floor
      c.signature = this.signature(c, view.eyeHeight);
      c.sigDist = TerrainAnalyzer.signatureDistance(correctSig, c.signature, relief);
      // Visual similarity of the view in the given heading.
      const viewSim = c.D <= band.target ? 1 : Math.exp(-(((c.D - band.target) / spread) ** 2));
      const horizonSim = Math.exp(-horizonDistance(correctDesc.horizon, c.desc.horizon) / 2);
      const slopeSim = Math.exp(-Math.abs(c.signature.slope - correctSig.slope) / 8);
      const elevSim = Math.exp(-Math.abs(c.signature.elevation - correctSig.elevation) / Math.max(8, 0.15 * relief));
      const depthSim = Math.exp(-depthDifference(correctDesc, c.desc) / 0.5);
      const visual = (0.55 * viewSim + 0.2 * horizonSim + 0.15 * slopeSim + 0.1 * elevSim) * (0.7 + 0.3 * depthSim);
      c.score = (1 - w) * visual + w * Math.exp(-1.6 * c.sigDist);
      // A distractor must differ somewhere the player can actually see.
      if (preset.search && c.cue.magnitude < preset.search.cue) c.score *= 0.05;
      kept.push(c);
    }

    const chosen = [];
    const pool = kept;
    const power = preset.search?.pickPower ?? 3;
    while (chosen.length < count && pool.length) {
      const c = rng.weighted(pool, (p) => p.score ** power);
      pool.splice(pool.indexOf(c), 1);
      if (chosen.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < preset.minSeparation)) continue;
      if (sameLandform && chosen.some((q) => analyzer.sameFeature(q.x, q.y, c.x, c.y))) continue;
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

/** Mean |ln| ratio of horizon distances: do the skylines sit at similar depths? */
export function depthDifference(a, b) {
  let s = 0;
  for (let c = 0; c < a.dist.length; c++) s += Math.abs(Math.log(Math.max(20, a.dist[c]) / Math.max(20, b.dist[c])));
  return s / a.dist.length;
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
