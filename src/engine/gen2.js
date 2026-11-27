// Generation version 2 (gen=2): phone-legible, hard-and-fair quiz selection
// calibrated against ~80 blind phone reviews (1080x1920, north-up maps).
//
// Core principles:
// 1. No edge-cropped slopes or edge walls rising out of the left/right frame.
// 2. Decisive skyline peaks must stand cleanly above their local shoulders
//    (both full prominence and +-12 deg local prominence), sit well inside the
//    frame, and match closed-contour summits/knolls inside the map.
// 3. Uniqueness is verified on the pure interior skyline and peak pattern
//    (never relying on 40 m foreground probes or frame-edge pixels).
// 4. Difficulty comes from genuine map reasoning: multiple decoy summit pairs,
//    single-peak ambiguity requiring 2-3 features, close-but-clearly-refutable
//    look-alike cells, rich multi-summit terrain, and non-corner observer cells.

import { DEG, angleDiff, wrap360, saturate } from './grid.js';
import { horizonDistance } from './skyline.js';

function gridCellAt(x, y, size, divisions) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > size || y > size) return null;
  const col = Math.min(divisions - 1, Math.floor((x / size) * divisions));
  const row = Math.min(divisions - 1, Math.floor(((size - y) / size) * divisions));
  return `${String.fromCharCode(65 + row)}${col + 1}`;
}

/** Normalise the generation version parameter (1 = legacy byte-for-byte, 2 = gen2). */
export const normaliseGen = (value) => Number(value) === 2 ? 2 : 1;

/**
 * Calibrated phone-legibility and fairness thresholds for master grid gen=2.
 * Exported and frozen so tests and mutation checks can verify each rule directly.
 */
export const GEN2_GRID_THRESHOLDS = Object.freeze({
  maxEdgeCut: 0.35,           // deg: max terrain rise outside left/right frame edge
  maxEdgeHigh: 0.88,          // fraction of relief at edge while still climbing into edge
  edgeRiseCheckDeg: 3.0,      // deg inside edge used to detect an edge-climbing wall
  maxSkylineAngle: 8.5,       // deg: avoid close-up looming walls filling the frame
  minRelief: 1.8,             // deg: minimum vertical skyline span inside frame
  minEdgeMargin: 5.0,         // deg: decisive peaks must sit >= 5 deg inside either edge
  minPeakDist: 220,           // m: ignore close-up foreground flank walls
  maxPeakDist: 1850,          // m: stay inside map and clear of heavy haze
  minPeakSep: 8.0,            // deg: minimum angular separation between distinct peaks
  minPrimaryProm: 1.35,       // deg: primary skyline peak prominence
  minPrimaryLocalProm: 1.10,  // deg: primary peak local prominence within +-12 deg
  minSecondaryProm: 0.95,     // deg: secondary skyline peak prominence
  minSecondaryLocalProm: 0.90,// deg: secondary peak local prominence within +-12 deg
  minPeakSharpness: 0.85,     // deg prominence per 10 deg FWHM (rejects flat plateaus)
  minPromAngleRatio: 0.14,    // prom / max(1, peakAngle) (rejects tiny bumps on tall walls)
  minSaddleDrop: 0.90,        // deg: visible dip between the two decisive peaks
  minMapPromFactor: 1.5,      // summit map prominence >= max(12 m, 1.5 * contourInterval)
  minMapPromMetres: 12,
  minHorizonRMS: 0.60,        // deg: pure horizon RMS to closest wrong cell
  minInteriorCue: 1.80,       // deg: interior smoothed skyline diff sufficient on its own
  minShiftedCue: 1.00,        // deg: interior cue when peak pattern shifts >= 6 deg & rel >= 0.35
  minShiftedRelCue: 0.35,
  minPeakShift: 6.0,          // deg: horizontal shift of a decisive skyline peak
  minLargeShiftCue: 0.90,     // deg: interior cue when peak shifts/vanishes >= 8 deg
  minLargePeakShift: 8.0,
  minAdjacentShift: 6.0,      // deg: adjacent cell summit bearing shift (or interior cue >= 1.7 deg)
  minAdjacentCue: 1.70,
  minLandmarkVisibility: 0.30,// aligns with runtime precheck
  maxBlockedFrac: 0.25,
  maxEdgeFrac: 0.35,
  targetDifficulty: 0.66,     // try a second terrain if attempt 0 falls below this
});

/** Calibrated thresholds for resection gen=2 (both P1 and P2 must be sharp, centred summits). */
export const GEN2_RESECTION_THRESHOLDS = Object.freeze({
  minMapPromFactor: 1.8,      // closed contours on 3 km map (>= max(15 m, 1.8 * interval))
  minMapPromMetres: 15,
  minDist: 300,
  maxDist: 1580,
  maxApexOffset: 2.2,         // deg: summit apex sits right under the P1/P2 label
  minDrop8: 0.60,             // deg: bilateral drop within +-8 deg (1b: 1.31 deg; 2a/3e/4d: <= 0.23 deg)
  minDrop12: 0.95,            // deg: bilateral drop within +-12 deg (2a/3e/4d: <= 0.66 deg)
  minProm: 1.10,              // deg: full in-frame prominence on both sides
  minPeakSize: 0.95,          // deg: atan(mapProminence / dist) (2a: 0.5, 4d: 0.8, 1b: 1.79)
  maxNeighbourOvershoot: 0.6, // deg: no taller wall immediately beside the peak within +-7 deg
  maxSkylineAngle: 15.0,      // deg: resection pitches camera to peak.elevation + 1.5 deg
  minFixTolerance: 5.5,       // deg: comfortably exceeds 5.1 deg master 8x8 slack
  minCrossing: 38,            // deg
  maxCrossing: 145,           // deg
  minWeakRivals: 2,           // preserves master difficulty (D8-9)
});

/** Calibrated thresholds for friend gen=2 (50 deg wide view must fix observer position first). */
export const GEN2_FRIEND_THRESHOLDS = Object.freeze({
  maxEdgeCut: 0.40,
  maxEdgeHigh: 0.88,
  maxSkylineAngle: 11.5,
  minRelief: 1.6,
  minEdgeMargin: 4.5,
  minPeakDist: 200,
  maxPeakDist: 1850,
  minPeakSep: 8.0,
  minPrimaryProm: 1.15,
  minPrimaryLocalProm: 0.95,
  minSecondaryProm: 0.78,
  minSecondaryLocalProm: 0.75,
  minPeakSharpness: 0.75,
  minPromAngleRatio: 0.13,
  minSaddleDrop: 0.75,
  minMapPromFactor: 1.4,
  minMapPromMetres: 11,
  minFriendDist: 125,
  maxFriendDist: 198,
  minFriendAngularHeight: 0.48,
  maxAbsPitch: 11.5,
  minSkyAboveFriend: 0.4,     // deg: friend stands below the skyline against terrain
  maxPeakAbovePitch: 12.2,    // deg: peaks stay below compass tape in 50 deg (32.5 deg vfov, +-16.25 deg) frame
  minPeakAbovePitch: -9.0,
  minInteriorCue: 1.40,
  minHorizonRMS: 0.55,
  maxBlockedFrac: 0.30,
  maxEdgeFrac: 0.30,
});

const round2 = (v) => Number.isFinite(v) ? +v.toFixed(2) : null;
const round3 = (v) => Number.isFinite(v) ? +v.toFixed(3) : null;

/** Inside-map summits/knolls with enough map prominence to draw clear closed contour rings. */
export function qualifiedMapSummits(model, contourInterval, minFactor = 1.5, minMetres = 12, inset = 40) {
  const minProm = Math.max(minMetres, minFactor * contourInterval);
  return model.analyzer.summits
    .filter((s) => model.inside(s.x, s.y, inset) && (s.prominence || 0) >= minProm)
    .sort((a, b) => (b.prominence - a.prominence) || (a.x - b.x) || (a.y - b.y));
}

/** Match a skyline hit point (px, py, az, dist) to a qualified inside-map summit. */
function matchSummit(cam, az, dist, px, py, summits) {
  let best = null, bestDist = Infinity;
  const maxSD = Math.max(150, 0.18 * dist);
  for (const s of summits) {
    const sd = Math.hypot(s.x - px, s.y - py);
    if (sd > maxSD) continue;
    const sAz = wrap360(Math.atan2(s.x - cam.x, s.y - cam.y) / DEG);
    if (angleDiff(sAz, az) > 4.5) continue;
    if (sd < bestDist || (sd === bestDist && best && (s.x < best.x || (s.x === best.x && s.y < best.y)))) {
      bestDist = sd;
      best = s;
    }
  }
  return best;
}

/**
 * Exact skyline frame analysis over [-fov/2 - margin, +fov/2 + margin].
 * Shared by grid, friend, and reporting scripts.
 */
export function analyzeSkylineFrame(model, cam, {
  step = 0.5,
  margin = 20,
  contourInterval = null,
  thresholds = GEN2_GRID_THRESHOLDS,
  summits = null,
  divisions = 8,
} = {}) {
  const sk = model.skyline;
  const half = cam.fov / 2;
  const eyeHeight = cam.eyeHeight ?? 1.7;
  const z = sk.eyeZ(cam.x, cam.y, eyeHeight);
  const interval = contourInterval ?? model.chooseContourInterval();
  const mapSummits = summits ?? qualifiedMapSummits(model, interval, thresholds.minMapPromFactor, thresholds.minMapPromMetres);

  const cols = [];
  for (let d = -half - margin; d <= half + margin + 1e-9; d += step) {
    const az = wrap360(cam.heading + d);
    const ray = sk.castRay(cam.x, cam.y, z, az);
    cols.push({
      d: +d.toFixed(4),
      az,
      a: ray.angle,
      dist: ray.dist,
      edge: ray.edge,
      x: cam.x + Math.sin(az * DEG) * ray.dist,
      y: cam.y + Math.cos(az * DEG) * ray.dist,
    });
  }
  const inside = cols.filter((c) => Math.abs(c.d) <= half + 1e-6);
  const leftOut = cols.filter((c) => c.d < -half - 1e-6);
  const rightOut = cols.filter((c) => c.d > half + 1e-6);

  const edgeL = inside[0].a;
  const edgeR = inside[inside.length - 1].a;
  const maxOutL = leftOut.length ? Math.max(...leftOut.map((c) => c.a)) : edgeL;
  const maxOutR = rightOut.length ? Math.max(...rightOut.map((c) => c.a)) : edgeR;
  const cutLeft = maxOutL - edgeL;
  const cutRight = maxOutR - edgeR;
  const edgeCut = Math.max(cutLeft, cutRight);

  let minAngle = Infinity, maxAngle = -Infinity, topIdx = 0;
  let blocked = 0, edgeCnt = 0;
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i];
    if (c.a < minAngle) minAngle = c.a;
    if (c.a > maxAngle) { maxAngle = c.a; topIdx = i; }
    if (c.dist < 150) blocked++;
    if (c.edge) edgeCnt++;
  }
  const relief = maxAngle - minAngle;
  const blockedFrac = blocked / inside.length;
  const edgeFrac = edgeCnt / inside.length;

  // Runtime edgeProfile equivalent (edgeDist & edgeRise at the frame's top point)
  const top = inside[topIdx];
  const topEdgeDist = half - Math.abs(top.d);
  const topBeyond = top.d < 0 ? maxOutL : maxOutR;
  const topEdgeRise = topBeyond - top.a;
  const runtimeEdgeCrop = topEdgeDist <= 1 && topEdgeRise > 0.2;

  // Edge wall check: edge sitting near top of relief while climbing into the edge
  const riseSteps = Math.max(1, Math.round((thresholds.edgeRiseCheckDeg ?? 3.0) / step));
  const edgeHighL = (edgeL - minAngle) / Math.max(0.5, relief);
  const edgeHighR = (edgeR - minAngle) / Math.max(0.5, relief);
  const edgeRiseL = inside[0].a - inside[Math.min(inside.length - 1, riseSteps)].a;
  const edgeRiseR = inside[inside.length - 1].a - inside[Math.max(0, inside.length - 1 - riseSteps)].a;
  const edgeWall = (edgeHighL >= thresholds.maxEdgeHigh && edgeRiseL > 0.05)
    || (edgeHighR >= thresholds.maxEdgeHigh && edgeRiseR > 0.05);

  const rawPeaks = [];
  const rawAll = [];
  for (let i = 2; i < inside.length - 2; i++) {
    const c = inside[i];
    if (!(c.a >= inside[i - 1].a && c.a >= inside[i + 1].a && c.a > inside[i - 2].a && c.a > inside[i + 2].a)) continue;
    const edgeDist = half - Math.abs(c.d);
    if (edgeDist < 2.0) continue;
    let lmin = c.a, rmin = c.a, lmin12 = c.a, rmin12 = c.a;
    for (let j = i - 1; j >= 0 && inside[j].a <= c.a; j--) {
      if (inside[j].a < lmin) lmin = inside[j].a;
      if (c.d - inside[j].d <= 12 && inside[j].a < lmin12) lmin12 = inside[j].a;
    }
    for (let j = i + 1; j < inside.length && inside[j].a <= c.a; j++) {
      if (inside[j].a < rmin) rmin = inside[j].a;
      if (inside[j].d - c.d <= 12 && inside[j].a < rmin12) rmin12 = inside[j].a;
    }
    const prom = Math.min(c.a - lmin, c.a - rmin);
    const localProm = Math.min(c.a - lmin12, c.a - rmin12);
    if (prom < 0.5) continue;

    // Half-prominence angular width (FWHM) and sharpness
    let wL = 0, wR = 0;
    for (let j = i - 1; j >= 0; j--) { wL = c.d - inside[j].d; if (inside[j].a <= c.a - 0.5 * prom) break; }
    for (let j = i + 1; j < inside.length; j++) { wR = inside[j].d - c.d; if (inside[j].a <= c.a - 0.5 * prom) break; }
    const fwhm = wL + wR;
    const sharpness = (prom / Math.max(2, fwhm)) * 10;
    const promRatio = prom / Math.max(1, c.a);

    const matched = (!c.edge && c.dist >= thresholds.minPeakDist && c.dist <= thresholds.maxPeakDist)
      ? matchSummit(cam, c.az, c.dist, c.x, c.y, mapSummits)
      : null;

    const peakObj = {
      d: +c.d.toFixed(1),
      az: +c.az.toFixed(1),
      a: +c.a.toFixed(2),
      dist: Math.round(c.dist),
      prom: +prom.toFixed(2),
      localProm: +localProm.toFixed(2),
      fwhm: +fwhm.toFixed(1),
      sharpness: +sharpness.toFixed(2),
      promRatio: +promRatio.toFixed(3),
      edgeDist: +edgeDist.toFixed(1),
      inMap: !c.edge,
      summit: matched ? {
        x: matched.x, y: matched.y, z: matched.z,
        prominence: +matched.prominence.toFixed(1),
        kind: matched.kind,
        cell: gridCellAt(matched.x, matched.y, model.size, divisions),
      } : null,
    };
    rawAll.push(peakObj);

    if (matched
      && edgeDist >= thresholds.minEdgeMargin
      && prom >= thresholds.minSecondaryProm * 0.7
      && localProm >= thresholds.minSecondaryLocalProm * 0.7) {
      rawPeaks.push(peakObj);
    }
  }

  // Deterministic non-maximum suppression (>= minPeakSep apart, distinct map summits)
  const cmpPeak = (a, b) => (b.prom - a.prom) || (b.localProm - a.localProm) || (a.d - b.d);
  rawPeaks.sort(cmpPeak);
  const peaks = [];
  for (const p of rawPeaks) {
    if (peaks.every((o) => Math.abs(o.d - p.d) >= thresholds.minPeakSep
      && (o.summit.x !== p.summit.x || o.summit.y !== p.summit.y))) {
      peaks.push(p);
    }
  }
  rawAll.sort(cmpPeak);
  const allSkylinePeaks = [];
  for (const p of rawAll) {
    if (p.prom >= 0.6 && allSkylinePeaks.every((o) => Math.abs(o.d - p.d) >= 6)) {
      allSkylinePeaks.push(p);
    }
  }

  // Saddle drop and angular separation between the two primary matched peaks
  let saddleDrop = 0, peakSep = 0;
  if (peaks.length >= 2) {
    const [leftP, rightP] = [peaks[0], peaks[1]].sort((u, v) => u.d - v.d);
    peakSep = Math.abs(rightP.d - leftP.d);
    let trough = Infinity;
    for (const c of inside) {
      if (c.d >= leftP.d && c.d <= rightP.d && c.a < trough) trough = c.a;
    }
    saddleDrop = Number.isFinite(trough) ? Math.min(leftP.a, rightP.a) - trough : 0;
  }

  const p1 = peaks[0] || null;
  const p2 = peaks[1] || null;
  const pitchOk = cam.pitch === undefined || !Number.isFinite(thresholds.maxPeakAbovePitch)
    || (peaks.length >= 2 && [p1, p2].every((p) => (p.a - cam.pitch) <= thresholds.maxPeakAbovePitch
      && (p.a - cam.pitch) >= thresholds.minPeakAbovePitch));

  const passesSkyline = !runtimeEdgeCrop
    && cutLeft <= thresholds.maxEdgeCut
    && cutRight <= thresholds.maxEdgeCut
    && !edgeWall
    && maxAngle <= thresholds.maxSkylineAngle
    && relief >= thresholds.minRelief
    && blockedFrac <= thresholds.maxBlockedFrac
    && edgeFrac <= thresholds.maxEdgeFrac
    && peaks.length >= 2
    && p1.prom >= thresholds.minPrimaryProm
    && p1.localProm >= thresholds.minPrimaryLocalProm
    && p1.sharpness >= thresholds.minPeakSharpness
    && p1.promRatio >= thresholds.minPromAngleRatio
    && p2.prom >= thresholds.minSecondaryProm
    && p2.localProm >= thresholds.minSecondaryLocalProm
    && p2.sharpness >= thresholds.minPeakSharpness
    && p2.promRatio >= thresholds.minPromAngleRatio
    && saddleDrop >= thresholds.minSaddleDrop
    && pitchOk;

  // Continuous readability / framing score (0..1) for ranking both strict and fallback views
  const cutScore = saturate(1 - Math.max(0, edgeCut - 0.1) / 1.2) * (edgeWall ? 0.35 : 1) * (runtimeEdgeCrop ? 0.3 : 1);
  const edgeClean = 1 - 0.35 * Math.max(0, Math.max(edgeHighL, edgeHighR) - 0.55) / 0.45;
  const promScore = peaks.length >= 2
    ? 0.5 * saturate(p1.localProm / 2.2) + 0.5 * saturate(p2.localProm / 1.5)
    : peaks.length === 1 ? 0.35 * saturate(p1.localProm / 2.2) : 0;
  const saddleScore = saturate(saddleDrop / 2.0);
  const sepScore = peaks.length >= 2 ? saturate((peakSep - 6) / 22) : 0;
  const angleScore = saturate(1 - Math.max(0, maxAngle - 6.0) / 5.0);
  const skylineScore = saturate(
    0.26 * cutScore * edgeClean
    + 0.30 * promScore
    + 0.16 * saddleScore
    + 0.12 * sepScore
    + 0.08 * angleScore
    + 0.08 * saturate(1 - blockedFrac * 2 - edgeFrac * 1.5)
  );

  return {
    passesSkyline,
    skylineScore,
    cutLeft: round2(cutLeft),
    cutRight: round2(cutRight),
    edgeCut: round2(edgeCut),
    edgeWall,
    runtimeEdgeCrop,
    edgeHighMax: round2(Math.max(edgeHighL, edgeHighR)),
    minAngle: round2(minAngle),
    maxAngle: round2(maxAngle),
    relief: round2(relief),
    blockedFrac: round3(blockedFrac),
    edgeFrac: round3(edgeFrac),
    peaks,
    allSkylinePeaks,
    distinctPeaks: peaks.length,
    saddleDrop: round2(saddleDrop),
    peakSep: round1(peakSep),
    primaryProm: p1 ? p1.prom : 0,
    secondaryProm: p2 ? p2.prom : 0,
    primaryLocalProm: p1 ? p1.localProm : 0,
    secondaryLocalProm: p2 ? p2.localProm : 0,
    minEdgeDist: p2 ? Math.min(p1.edgeDist, p2.edgeDist) : p1 ? p1.edgeDist : 0,
  };
}

const round1 = (v) => Number.isFinite(v) ? +v.toFixed(1) : 0;

/**
 * Pure interior horizon cue (degrees): largest 3-column-smoothed elevation
 * difference across the interior of the frame (ignoring outer `edgeIgnoreDeg`
 * near either frame edge, and ignoring all foreground probes).
 */
export function interiorHorizonCue(a, b, edgeIgnoreDeg = 3) {
  const n = a.horizon.length;
  const fov = a.fov;
  const ignore = Math.ceil((edgeIgnoreDeg / fov) * (n - 1));
  let best = 0;
  for (let c = ignore; c < n - ignore; c++) {
    let s = 0, k = 0;
    for (let d = -1; d <= 1; d++) {
      const cc = c + d;
      if (cc < 0 || cc >= n) continue;
      s += b.horizon[cc] - a.horizon[cc];
      k++;
    }
    const v = Math.abs(s / k);
    if (v > best) best = v;
  }
  return best;
}

/** Fast 1D local peak extraction from a viewDescriptor horizon array. */
export function descriptorHorizonPeaks(horizon, fov, minProm = 0.35) {
  const n = horizon.length;
  const step = fov / (n - 1);
  const out = [];
  for (let i = 1; i < n - 1; i++) {
    const a = horizon[i];
    if (!(a >= horizon[i - 1] && a >= horizon[i + 1] && (a > horizon[i - 1] || a > horizon[i + 1]))) continue;
    let lm = a, rm = a;
    for (let j = i - 1; j >= 0 && horizon[j] <= a; j--) if (horizon[j] < lm) lm = horizon[j];
    for (let j = i + 1; j < n && horizon[j] <= a; j++) if (horizon[j] < rm) rm = horizon[j];
    const prom = Math.min(a - lm, a - rm);
    if (prom >= minProm) out.push({ d: -fov / 2 + i * step, a, prom });
  }
  return out;
}

/**
 * Feature-level uniqueness check between the true viewpoint and another cell/spot.
 * Combines pure interior skyline difference (no foreground probes) with azimuthal
 * shift / disappearance of the decisive skyline peaks.
 */
export function featureDistinction(originDesc, originPeaks, originRelief, candDesc, candPeaks, thresholds = GEN2_GRID_THRESHOLDS) {
  const intCue = interiorHorizonCue(originDesc, candDesc, 3);
  const relIntCue = intCue / Math.max(2.0, originRelief);
  const hRMS = horizonDistance(originDesc.horizon, candDesc.horizon);
  let maxPeakShift = 0;
  const checkPeaks = originPeaks.slice(0, 3);
  for (const p of checkPeaks) {
    let bestShift = 15;
    for (const cp of candPeaks) {
      if (cp.prom < Math.min(0.45, p.prom * 0.4)) continue;
      const shift = Math.abs(cp.d - p.d) + Math.abs(cp.a - p.a) * 1.5;
      if (shift < bestShift) bestShift = shift;
    }
    if (bestShift > maxPeakShift) maxPeakShift = bestShift;
  }
  const effectiveMargin = Math.max(intCue, Math.min(intCue * 1.6, maxPeakShift * 0.22));
  const clearOnPhone = hRMS >= thresholds.minHorizonRMS && (
    intCue >= thresholds.minInteriorCue
    || (intCue >= thresholds.minShiftedCue && relIntCue >= thresholds.minShiftedRelCue && maxPeakShift >= thresholds.minPeakShift)
    || (intCue >= thresholds.minLargeShiftCue && maxPeakShift >= thresholds.minLargePeakShift)
  );
  return { intCue, relIntCue, hRMS, maxPeakShift, effectiveMargin, clearOnPhone };
}

/**
 * True-summit bearing shift from another cell `c` relative to `origin`'s two
 * decisive map summits: how much a careful solver sees those named summits
 * shift (or leave frame / disappear) when testing an adjacent cell.
 */
export function adjacentSummitShift(model, originCam, peaks, otherCell) {
  if (peaks.length < 2 || !peaks[0].summit || !peaks[1].summit) return 0;
  const half = originCam.fov / 2;
  let maxShift = 0;
  for (const p of peaks.slice(0, 2)) {
    const s = p.summit;
    const dx = s.x - otherCell.x, dy = s.y - otherCell.y;
    const d = Math.hypot(dx, dy);
    if (d < 50) return 30; // standing on the summit itself
    const az = wrap360(Math.atan2(dx, dy) / DEG);
    const off = wrap360(az - originCam.heading + 180) - 180;
    if (Math.abs(off) > half - 1.5) return 25; // summit pushed to/out of frame edge
    const shift = angleDiff(az, p.az);
    if (shift > maxShift) maxShift = shift;
  }
  return maxShift;
}

/**
 * Sweep 360 degrees at `step` deg around a set of walkable positions once,
 * returning compact Float32Array panoramas so dozens of headings per position
 * can be evaluated in microseconds with zero extra raycasts.
 */
export function sweepPanoramas(model, positions, { step = 1.5, eyeHeight = 1.7 } = {}) {
  const sk = model.skyline;
  const count = Math.round(360 / step);
  const out = [];
  for (const p of positions) {
    const z = sk.eyeZ(p.x, p.y, eyeHeight);
    const angles = new Float32Array(count);
    const dists = new Float32Array(count);
    const edges = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const ray = sk.castRay(p.x, p.y, z, i * step);
      angles[i] = ray.angle;
      dists[i] = ray.dist;
      edges[i] = ray.edge ? 1 : 0;
    }
    out.push({ p, z, step, count, angles, dists, edges });
  }
  return out;
}

/**
 * Fast panorama window check from a precomputed 360 deg sweep.
 * Used to quickly discover promising (position, heading) pairs before exact
 * 0.5-deg verification and 64-cell uniqueness checks.
 */
export function fastWindowCheck(sw, heading, fov, summits, thresholds = GEN2_GRID_THRESHOLDS) {
  const { p, step, count, angles, dists, edges } = sw;
  const halfSteps = Math.round((fov / 2) / step);
  const marginSteps = Math.round(20 / step);
  const centre = Math.round(wrap360(heading) / step) % count;
  const idxAt = (off) => ((centre + off) % count + count) % count;

  const edgeL = angles[idxAt(-halfSteps)];
  const edgeR = angles[idxAt(halfSteps)];
  let outL = edgeL, outR = edgeR;
  for (let k = 1; k <= marginSteps; k++) {
    const al = angles[idxAt(-halfSteps - k)];
    const ar = angles[idxAt(halfSteps + k)];
    if (al > outL) outL = al;
    if (ar > outR) outR = ar;
  }
  const cutL = outL - edgeL;
  const cutR = outR - edgeR;
  const edgeCut = Math.max(cutL, cutR);

  const winLen = 2 * halfSteps + 1;
  let minA = Infinity, maxA = -Infinity, blocked = 0, edgeCnt = 0;
  const win = new Float32Array(winLen);
  const winD = new Float32Array(winLen);
  const winE = new Uint8Array(winLen);
  for (let k = 0; k < winLen; k++) {
    const idx = idxAt(k - halfSteps);
    const a = angles[idx], d = dists[idx], e = edges[idx];
    win[k] = a; winD[k] = d; winE[k] = e;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (d < 150) blocked++;
    if (e) edgeCnt++;
  }
  const relief = maxA - minA;
  const blockedFrac = blocked / winLen;
  const edgeFrac = edgeCnt / winLen;
  if (blockedFrac > 0.45 || edgeFrac > 0.42 || relief < 1.0) return null;

  const minEdgeIdx = Math.max(2, Math.floor((thresholds.minEdgeMargin - 1.0) / step));
  const localWin = Math.round(12 / step);
  const peaks = [];
  for (let k = minEdgeIdx; k < winLen - minEdgeIdx; k++) {
    const a = win[k];
    if (!(a >= win[k - 1] && a >= win[k + 1] && (a > win[k - 1] || a > win[k + 1]))) continue;
    if (winE[k] || winD[k] < thresholds.minPeakDist * 0.85 || winD[k] > thresholds.maxPeakDist) continue;
    let lm = a, rm = a, l12 = a, r12 = a;
    for (let j = k - 1; j >= 0 && win[j] <= a; j--) {
      if (win[j] < lm) lm = win[j];
      if (k - j <= localWin && win[j] < l12) l12 = win[j];
    }
    for (let j = k + 1; j < winLen && win[j] <= a; j++) {
      if (win[j] < rm) rm = win[j];
      if (j - k <= localWin && win[j] < r12) r12 = win[j];
    }
    const prom = Math.min(a - lm, a - rm);
    const localProm = Math.min(a - l12, a - r12);
    if (prom < 0.65 || localProm < 0.55) continue;
    const dDeg = (k - halfSteps) * step;
    const az = wrap360(heading + dDeg);
    const px = p.x + Math.sin(az * DEG) * winD[k];
    const py = p.y + Math.cos(az * DEG) * winD[k];
    const s = matchSummit(p, az, winD[k], px, py, summits);
    if (s) peaks.push({ d: dDeg, az, a, prom, localProm, s });
  }
  peaks.sort((a, b) => (b.prom - a.prom) || (a.d - b.d));
  const distinct = [];
  for (const pk of peaks) {
    if (distinct.every((o) => Math.abs(o.d - pk.d) >= thresholds.minPeakSep - 1.0 && o.s !== pk.s)) {
      distinct.push(pk);
    }
  }
  const edgeHigh = Math.max((edgeL - minA) / Math.max(0.5, relief), (edgeR - minA) / Math.max(0.5, relief));
  const quickStrict = edgeCut <= thresholds.maxEdgeCut + 0.2
    && maxA <= thresholds.maxSkylineAngle + 0.5
    && distinct.length >= 2
    && distinct[0].prom >= thresholds.minPrimaryProm - 0.15
    && distinct[1].prom >= thresholds.minSecondaryProm - 0.15
    && edgeHigh <= 0.92;

  const quickScore = (quickStrict ? 2.0 : 0)
    + 0.4 * saturate(1 - Math.max(0, edgeCut) / 1.5)
    + 0.35 * (distinct.length >= 2 ? saturate(distinct[1].localProm / 1.4) : distinct.length === 1 ? 0.25 * saturate(distinct[0].localProm / 2) : 0)
    + 0.15 * saturate(1 - Math.max(0, maxA - 6) / 6)
    + 0.10 * saturate(1 - blockedFrac * 2 - edgeFrac * 1.5);

  return { heading: wrap360(Math.round(heading)), edgeCut, maxA, relief, distinct, quickStrict, quickScore };
}

/**
 * Find promising (cell, heading) candidates from 360 deg cell panoramas.
 * Tests both regular 5-deg headings and exact peak-pair-centred framing
 * headings (with +-3 deg / +-6 deg edge-dodge offsets) so alpine and classic
 * terrains reliably find crisp, uncropped peak pairs.
 */
export function discoverPanoramaHeadings(sw, fov, summits, thresholds = GEN2_GRID_THRESHOLDS) {
  const { p, step, count, angles, dists, edges } = sw;
  const headingSet = new Set();
  for (let h = 0; h < 360; h += 5) headingSet.add(h);

  // Detect 360 deg peaks around the panorama to propose exact peak-pair framings
  const panoPeaks = [];
  const win = Math.round(12 / step);
  for (let i = 0; i < count; i++) {
    const prev = angles[(i - 1 + count) % count];
    const next = angles[(i + 1) % count];
    const a = angles[i];
    if (!(a >= prev && a >= next && (a > prev || a > next))) continue;
    if (edges[i] || dists[i] < thresholds.minPeakDist * 0.85 || dists[i] > thresholds.maxPeakDist) continue;
    let l12 = a, r12 = a;
    for (let k = 1; k <= win; k++) {
      const al = angles[(i - k + count) % count];
      const ar = angles[(i + k) % count];
      if (al < l12) l12 = al;
      if (ar < r12) r12 = ar;
    }
    if (Math.min(a - l12, a - r12) < 0.65) continue;
    const az = i * step;
    const px = p.x + Math.sin(az * DEG) * dists[i];
    const py = p.y + Math.cos(az * DEG) * dists[i];
    const s = matchSummit(p, az, dists[i], px, py, summits);
    if (s) panoPeaks.push({ az, a, s });
  }
  for (let i = 0; i < panoPeaks.length; i++) {
    for (let j = i + 1; j < panoPeaks.length; j++) {
      if (panoPeaks[i].s === panoPeaks[j].s) continue;
      const diff = wrap360(panoPeaks[j].az - panoPeaks[i].az + 180) - 180;
      const sep = Math.abs(diff);
      if (sep < thresholds.minPeakSep || sep > fov - 2 * thresholds.minEdgeMargin) continue;
      const mid = wrap360(panoPeaks[i].az + diff / 2);
      const slack = Math.max(0, (fov / 2 - thresholds.minEdgeMargin) - sep / 2);
      headingSet.add(wrap360(Math.round(mid)));
      for (const off of [-6, -3, 3, 6]) {
        if (Math.abs(off) <= slack + 0.5) headingSet.add(wrap360(Math.round(mid + off)));
      }
    }
  }

  const hits = [];
  for (const h of headingSet) {
    const res = fastWindowCheck(sw, h, fov, summits, thresholds);
    if (res) hits.push(res);
  }
  hits.sort((a, b) => (b.quickScore - a.quickScore) || (a.heading - b.heading));

  // Keep up to 4 angularly diverse headings per cell (>= 18 deg apart)
  const kept = [];
  for (const h of hits) {
    if (kept.every((k) => angleDiff(k.heading, h.heading) >= 18)) {
      kept.push(h);
      if (kept.length >= 4) break;
    }
  }
  return kept;
}

/**
 * Fast approximate pure-horizon RMS across all swept cells for a given heading,
 * directly from the precomputed 360 deg panoramas (zero extra raycasts).
 */
export function fastSweepHorizonMinRMS(sweeps, originSweep, heading, fov) {
  const step = originSweep.step, count = originSweep.count;
  const halfSteps = Math.round((fov / 2) / step);
  const centre = Math.round(wrap360(heading) / step) % count;
  const winLen = 2 * halfSteps + 1;
  const idxs = new Int32Array(winLen);
  for (let k = 0; k < winLen; k++) idxs[k] = ((centre + k - halfSteps) % count + count) % count;
  const a0 = originSweep.angles;
  let minRMS = Infinity;
  for (const sw of sweeps) {
    if (sw === originSweep) continue;
    const a1 = sw.angles;
    let s = 0;
    for (let k = 0; k < winLen; k++) {
      const d = a0[idxs[k]] - a1[idxs[k]];
      s += d * d;
    }
    const rms = Math.sqrt(s / winLen);
    if (rms < minRMS) minRMS = rms;
  }
  return minRMS;
}

/**
 * Count decoy summit pairs on the contour map whose back-bearings at the top
 * two skyline peak bearings cross near ANOTHER cell centre, plus single-peak
 * ambiguity (how many other cells see some summit along Peak 1's bearing).
 * Directly calibrated against D8+ vs D6-7 north-up blind reviews.
 */
export function mapReasoningMetrics(model, origin, peaks, cells, divisions, contourInterval) {
  const allSummits = model.analyzer.summits.filter((s) => model.inside(s.x, s.y, 40)
    && (s.prominence || 0) >= Math.max(8, contourInterval));
  let decoyPairs = 0, decoySameOrder = 0, singlePeakCells = 0;

  if (peaks.length >= 2 && peaks[0].summit && peaks[1].summit) {
    const [p1, p2] = peaks;
    const u = { x: Math.sin((p1.az + 180) * DEG), y: Math.cos((p1.az + 180) * DEG) };
    const v = { x: Math.sin((p2.az + 180) * DEG), y: Math.cos((p2.az + 180) * DEG) };
    const det = v.x * u.y - u.x * v.y;
    const cellMetres = model.size / divisions;
    const nearCentre = cellMetres * 0.55;
    if (Math.abs(det) > 0.08) {
      for (const a of allSummits) {
        for (const b of allSummits) {
          if (a === b) continue;
          if (Math.hypot(a.x - p1.summit.x, a.y - p1.summit.y) < 30
            && Math.hypot(b.x - p2.summit.x, b.y - p2.summit.y) < 30) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const t = (v.x * dy - v.y * dx) / det;
          const s = (u.x * dy - u.y * dx) / det;
          if (t < 150 || t > 1800 || s < 150 || s > 1800) continue;
          const qx = a.x + u.x * t, qy = a.y + u.y * t;
          if (!model.inside(qx, qy, 60)) continue;
          const cl = gridCellAt(qx, qy, model.size, divisions);
          if (!cl || cl === origin.label) continue;
          const cc = cells.find((c) => c.label === cl);
          if (!cc || Math.hypot(cc.x - qx, cc.y - qy) > nearCentre) continue;
          decoyPairs++;
          const ez = model.getElevation(cc.x, cc.y) + 1.7;
          const a1 = Math.atan2(a.z - ez, Math.hypot(a.x - cc.x, a.y - cc.y)) / DEG;
          const a2 = Math.atan2(b.z - ez, Math.hypot(b.x - cc.x, b.y - cc.y)) / DEG;
          if (a1 > 0 && a2 > 0 && ((p1.a >= p2.a) === (a1 >= a2) || Math.abs(p1.a - p2.a) < 1.5)) {
            decoySameOrder++;
          }
        }
      }
    }
    for (const cc of cells) {
      if (cc.label === origin.label) continue;
      if (allSummits.some((s) => {
        const d = Math.hypot(s.x - cc.x, s.y - cc.y);
        return d >= 150 && d <= 1800 && angleDiff(wrap360(Math.atan2(s.x - cc.x, s.y - cc.y) / DEG), p1.az) <= 5;
      })) singlePeakCells++;
    }
  }
  return { mapSummits: allSummits.length, decoyPairs, decoySameOrder, singlePeakCells };
}

/**
 * Calibrated gen=2 difficulty, fairness, and readability scores (0..1) plus
 * 1..10 projected blind-review estimates for grid quizzes.
 */
export function gridGen2Scores({
  sky,
  minHorizonRMS,
  minInteriorCue,
  minFeatureMargin,
  minAdjacentShift,
  remoteCloseHorizon,
  reasoning,
  originRow,
  originCol,
  divisions,
  heading,
}) {
  const borderDist = Math.min(originRow, divisions - 1 - originRow, originCol, divisions - 1 - originCol);
  const isCorner = (originRow === 0 || originRow === divisions - 1)
    && (originCol === 0 || originCol === divisions - 1);
  const oblique = Math.min(...[0, 90, 180, 270].map((c) => angleDiff(heading, c))) / 45;

  const decoyTerm = 1 - Math.exp(-reasoning.decoySameOrder / 8);
  const summitRichness = saturate((reasoning.mapSummits - 6) / 12);
  const closenessTerm = saturate(1 - (minHorizonRMS - 0.65) / 1.35);
  const lookalikeTerm = 1 - Math.exp(-remoteCloseHorizon / 6);
  const interiorTerm = isCorner ? 0 : borderDist === 0 ? 0.45 : 1.0;
  const singleAmbTerm = 1 - Math.exp(-reasoning.singlePeakCells / 12);
  const multiPeakTerm = sky.distinctPeaks >= 3 ? 1.0 : sky.distinctPeaks === 2 ? 0.5 : 0.1;
  const obliqueTerm = 0.3 + 0.7 * saturate(oblique / 0.4);

  const difficulty = saturate(
    0.26 * decoyTerm
    + 0.16 * closenessTerm
    + 0.14 * lookalikeTerm
    + 0.14 * interiorTerm
    + 0.12 * summitRichness
    + 0.08 * singleAmbTerm
    + 0.05 * multiPeakTerm
    + 0.05 * obliqueTerm
  );

  const fairness = saturate(
    0.35 * sky.skylineScore
    + 0.25 * saturate((minFeatureMargin - 0.9) / 1.8)
    + 0.20 * saturate((minInteriorCue - 0.9) / 1.5)
    + 0.20 * saturate((minAdjacentShift - 4.0) / 8.0)
  );

  const readability = saturate(
    0.55 * sky.skylineScore
    + 0.25 * saturate((sky.secondaryLocalProm - 0.5) / 1.2)
    + 0.20 * saturate(1 - Math.max(0, sky.edgeCut) / 1.0) * (sky.edgeWall ? 0.4 : 1)
  );

  return {
    difficulty: round3(difficulty),
    fairness: round3(fairness),
    readability: round3(readability),
    estimatedDifficulty: +(5.5 + 3.8 * difficulty).toFixed(1),
    estimatedFairness: +(4.5 + 4.8 * fairness).toFixed(1),
    estimatedReadability: +(4.5 + 4.3 * readability).toFixed(1),
    borderDist,
    isCorner,
  };
}

/**
 * Evaluate a resection peak's skyline silhouette in its 50-deg centred view.
 * Measures apex accuracy, bilateral drop within +-8 deg and +-12 deg, full
 * in-frame prominence, edge cuts, and secondary context peaks.
 */
export function analyzeResectionPeakView(model, observer, peak, {
  fov = 50,
  step = 0.5,
  margin = 20,
  eyeHeight = 1.7,
  thresholds = GEN2_RESECTION_THRESHOLDS,
} = {}) {
  const sk = model.skyline;
  const half = fov / 2;
  const z = sk.eyeZ(observer.x, observer.y, eyeHeight);
  const dist = Math.hypot(peak.x - observer.x, peak.y - observer.y);
  const bearing = wrap360(Math.atan2(peak.x - observer.x, peak.y - observer.y) / DEG);
  const peakSize = Math.atan((peak.prominence || 0) / Math.max(1, dist)) / DEG;

  const cols = [];
  for (let d = -half - margin; d <= half + margin + 1e-9; d += step) {
    const az = wrap360(bearing + d);
    const ray = sk.castRay(observer.x, observer.y, z, az);
    cols.push({ d: +d.toFixed(4), a: ray.angle, dist: ray.dist, edge: ray.edge });
  }
  const inside = cols.filter((c) => Math.abs(c.d) <= half + 1e-6);
  const leftOut = cols.filter((c) => c.d < -half - 1e-6);
  const rightOut = cols.filter((c) => c.d > half + 1e-6);
  const cutLeft = (leftOut.length ? Math.max(...leftOut.map((c) => c.a)) : inside[0].a) - inside[0].a;
  const cutRight = (rightOut.length ? Math.max(...rightOut.map((c) => c.a)) : inside[inside.length - 1].a) - inside[inside.length - 1].a;

  // Find apex within +-3.5 deg of peak bearing
  let apexIdx = -1;
  for (let i = 0; i < inside.length; i++) {
    if (Math.abs(inside[i].d) <= 3.5 && (apexIdx < 0 || inside[i].a > inside[apexIdx].a)) apexIdx = i;
  }
  const apex = inside[apexIdx];
  const centreRay = inside[Math.floor(inside.length / 2)];
  const distMatch = !centreRay.edge && Math.abs(centreRay.dist - dist) <= Math.max(150, 0.22 * dist);

  let lmin = apex.a, rmin = apex.a;
  let l8 = apex.a, r8 = apex.a, l12 = apex.a, r12 = apex.a;
  let maxNear = apex.a;
  for (let j = apexIdx - 1; j >= 0; j--) {
    const off = apex.d - inside[j].d;
    const a = inside[j].a;
    if (off <= 7 && a > maxNear) maxNear = a;
    if (off <= 8 && a < l8) l8 = a;
    if (off <= 12 && a < l12) l12 = a;
  }
  for (let j = apexIdx + 1; j < inside.length; j++) {
    const off = inside[j].d - apex.d;
    const a = inside[j].a;
    if (off <= 7 && a > maxNear) maxNear = a;
    if (off <= 8 && a < r8) r8 = a;
    if (off <= 12 && a < r12) r12 = a;
  }
  for (let j = apexIdx - 1; j >= 0 && inside[j].a <= apex.a + 0.05; j--) if (inside[j].a < lmin) lmin = inside[j].a;
  for (let j = apexIdx + 1; j < inside.length && inside[j].a <= apex.a + 0.05; j++) if (inside[j].a < rmin) rmin = inside[j].a;

  const drop8 = Math.min(apex.a - l8, apex.a - r8);
  const drop12 = Math.min(apex.a - l12, apex.a - r12);
  const prom = Math.min(apex.a - lmin, apex.a - rmin);
  const neighbourOvershoot = maxNear - apex.a;
  const maxAngle = Math.max(...inside.map((c) => c.a));
  const relief = maxAngle - Math.min(...inside.map((c) => c.a));

  // Count distinct secondary context peaks in frame (>= 6 deg from apex)
  let contextPeaks = 0;
  for (let i = 2; i < inside.length - 2; i++) {
    const c = inside[i];
    if (Math.abs(c.d - apex.d) < 6 || half - Math.abs(c.d) < 3) continue;
    if (!(c.a >= inside[i - 1].a && c.a >= inside[i + 1].a && c.a > inside[i - 2].a && c.a > inside[i + 2].a)) continue;
    let lm = c.a, rm = c.a;
    for (let j = i - 1; j >= 0 && inside[j].a <= c.a; j--) if (inside[j].a < lm) lm = inside[j].a;
    for (let j = i + 1; j < inside.length && inside[j].a <= c.a; j++) if (inside[j].a < rm) rm = inside[j].a;
    if (Math.min(c.a - lm, c.a - rm) >= 0.7) contextPeaks++;
  }

  const strictOk = distMatch
    && dist >= thresholds.minDist && dist <= thresholds.maxDist
    && Math.abs(apex.d) <= thresholds.maxApexOffset
    && drop8 >= thresholds.minDrop8
    && drop12 >= thresholds.minDrop12
    && prom >= thresholds.minProm
    && peakSize >= thresholds.minPeakSize
    && neighbourOvershoot <= thresholds.maxNeighbourOvershoot
    && maxAngle <= thresholds.maxSkylineAngle;

  const score = saturate(
    0.34 * saturate(drop8 / 1.8)
    + 0.24 * saturate(prom / 2.5)
    + 0.16 * saturate(peakSize / 2.2)
    + 0.10 * saturate(1 - Math.abs(apex.d) / 3.0)
    + 0.08 * saturate(1 - Math.max(0, Math.max(cutLeft, cutRight)) / 2.5)
    + 0.08 * (contextPeaks > 0 ? 1 : 0.4)
  ) * (distMatch ? 1 : 0.35) * (neighbourOvershoot <= thresholds.maxNeighbourOvershoot ? 1 : 0.5);

  return {
    strictOk,
    score: round3(score),
    dist: Math.round(dist),
    peakSize: round2(peakSize),
    apexOffset: round1(apex.d),
    apexAngle: round2(apex.a),
    drop8: round2(drop8),
    drop12: round2(drop12),
    prom: round2(prom),
    neighbourOvershoot: round2(neighbourOvershoot),
    cutLeft: round2(cutLeft),
    cutRight: round2(cutRight),
    edgeCut: round2(Math.max(cutLeft, cutRight)),
    relief: round2(relief),
    maxAngle: round2(maxAngle),
    contextPeaks,
    distMatch,
  };
}

/** Fast 11-ray sharpness probe for resection peak filtering before full skyline analysis. */
export function quickResectionPeakOk(model, observer, peak, eyeHeight = 1.7, thresholds = GEN2_RESECTION_THRESHOLDS) {
  const sk = model.skyline;
  const dist = Math.hypot(peak.x - observer.x, peak.y - observer.y);
  if (dist < thresholds.minDist || dist > thresholds.maxDist) return false;
  if (Math.atan((peak.prominence || 0) / dist) / DEG < thresholds.minPeakSize * 0.85) return false;
  const z = sk.eyeZ(observer.x, observer.y, eyeHeight);
  const bearing = wrap360(Math.atan2(peak.x - observer.x, peak.y - observer.y) / DEG);
  const c = sk.castRay(observer.x, observer.y, z, bearing);
  if (c.edge || Math.abs(c.dist - dist) > Math.max(150, 0.22 * dist) || c.angle > thresholds.maxSkylineAngle) return false;
  let l8 = c.angle, r8 = c.angle, l12 = c.angle, r12 = c.angle;
  for (const off of [-12, -8, -5, -2.5, 2.5, 5, 8, 12]) {
    const a = sk.castRay(observer.x, observer.y, z, wrap360(bearing + off)).angle;
    if (Math.abs(off) <= 5.5 && a > c.angle + thresholds.maxNeighbourOvershoot + 0.4) return false;
    if (off < 0) { if (off >= -8 && a < l8) l8 = a; if (a < l12) l12 = a; }
    else { if (off <= 8 && a < r8) r8 = a; if (a < r12) r12 = a; }
  }
  return Math.min(c.angle - l8, c.angle - r8) >= thresholds.minDrop8 * 0.75
    && Math.min(c.angle - l12, c.angle - r12) >= thresholds.minDrop12 * 0.75;
}
