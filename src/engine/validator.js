// QuizValidator: rejects unfair, ambiguous or broken questions and computes a
// uniqueness / confidence score.

import { ContourGenerator } from './contours.js';
import { saturate } from './grid.js';

export class QuizValidator {
  /** Terrain-level checks, run once per generated terrain. */
  static validateTerrain(model, contours) {
    const { heights, n, cell } = model;
    let maxDev = 0, maxSlope = 0;
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        const m = (heights[k - 1] + heights[k + 1] + heights[k - n] + heights[k + n]) / 4;
        maxDev = Math.max(maxDev, Math.abs(heights[k] - m));
        const gx = (heights[k + 1] - heights[k - 1]) / (2 * cell), gy = (heights[k + n] - heights[k - n]) / (2 * cell);
        maxSlope = Math.max(maxSlope, Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI);
      }
    }
    const geometry = ContourGenerator.validate(contours);
    const issues = [];
    if (maxDev > 3.5) issues.push(`spike: cell deviates ${maxDev.toFixed(1)} m from neighbours`);
    if (maxSlope > 60) issues.push(`implausible slope ${maxSlope.toFixed(0)}°`);
    if (!geometry.ok) issues.push(`${geometry.broken} broken contour lines`);
    if (model.max - model.min < 25) issues.push('relief too low');
    return { ok: issues.length === 0, issues, maxDeviation: maxDev, maxSlope, contourLines: geometry.total };
  }

  /**
   * @param {object} q { view, quality, candidates (QuizCandidateGenerator result) }
   * @param {object} preset difficulty preset
   */
  static validateQuestion({ view, quality, candidates }, preset) {
    const issues = [];
    const { correct, distractors } = candidates;
    const band = preset.band;
    const c = quality.components;

    if (quality.total < preset.minQuality) issues.push(`view quality ${quality.total.toFixed(2)} below ${preset.minQuality}`);
    if (c.skylineComplexity < 0.25 && c.landmarkVisibility < 0.25) issues.push('scene has almost no recognisable terrain');
    const maxBlocked = preset.quality.occlusion < 1 ? 0.6 : 0.45;
    if (correct.desc.blockedFrac > maxBlocked) issues.push('terrain blocks most of the view');
    if (correct.desc.edgeFrac > 0.4) issues.push('view relies on terrain outside the map');
    if (distractors.length < preset.distractors) issues.push(`only ${distractors.length}/${preset.distractors} plausible distractors`);

    let minSep = Infinity;
    for (let a = 0; a < distractors.length; a++) for (let b = a + 1; b < distractors.length; b++) minSep = Math.min(minSep, Math.hypot(distractors[a].x - distractors[b].x, distractors[a].y - distractors[b].y));
    const minTrue = distractors.reduce((m, d) => Math.min(m, Math.hypot(d.x - correct.x, d.y - correct.y)), Infinity);
    if (minSep < preset.minSeparation * 0.99) issues.push('distractors too close together');
    if (minTrue < (preset.minTrueDistance ?? preset.minSeparation) * 0.99) issues.push('a distractor is too close to the true position');
    minSep = Math.min(minSep, minTrue);

    const ds = distractors.map((d) => d.D);
    const minD = ds.length ? Math.min(...ds) : 0;
    if (ds.length && minD < band.min) issues.push('correct location visually ambiguous with a distractor');
    if (ds.some((d) => d > band.max)) issues.push('a distractor is obviously impossible');

    if (preset.search) {
      const weak = distractors.filter((d) => d.cue.magnitude < preset.search.cue);
      if (weak.length) issues.push(`${weak.length} distractor(s) without a visible distinguishing feature`);
    }

    const uniqueness = ds.length ? saturate((minD - 0.6 * band.min) / (band.target - 0.6 * band.min)) : 0;
    const plausibility = ds.length ? ds.reduce((a, d) => a + saturate(1 - Math.abs(d - band.target) / (band.max - band.min)), 0) / ds.length : 0;
    const confidence = saturate(0.45 * uniqueness + 0.35 * quality.total / 0.8 + 0.1 * plausibility + 0.1 * (1 - correct.desc.blockedFrac));
    if (confidence < preset.minConfidence) issues.push(`confidence ${confidence.toFixed(2)} below ${preset.minConfidence}`);

    return { ok: issues.length === 0, issues, uniqueness, plausibility, confidence, minSeparation: minSep, minDistance: minD };
  }
}
