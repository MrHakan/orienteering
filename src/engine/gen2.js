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
  minRelief: 2.5,             // deg: minimum vertical skyline span (Round 1 F5 a10=2.25, F>=8 >=2.9)
  minEdgeMargin: 5.0,         // deg: decisive peaks must sit >= 5 deg inside either edge
  minPeakDist: 220,           // m: ignore close-up foreground flank walls
  maxPeakDist: 1850,          // m: stay inside map and clear of heavy haze
  minPeakSep: 8.0,            // deg: minimum angular separation between distinct peaks
  minPrimaryProm: 1.35,       // deg: primary skyline peak prominence
  minPrimaryLocalProm: 1.15,  // deg: primary peak local prominence within +-12 deg
  minSecondaryProm: 1.00,     // deg: secondary skyline peak prominence
  minSecondaryLocalProm: 1.00,// deg: secondary peak local prominence within +-12 deg
  minLocalPromRatio: 0.50,    // localProm / prom floor unless localProm >= 1.35 (rejects g5 broad ridge 0.43)
  minPeakSharpness: 0.90,     // deg prominence per 10 deg FWHM (allows crisp domes, rejects flat plateaus)
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
  minAdjacentShift: 5.5,      // deg: adjacent cell summit bearing shift (or interior cue >= 1.55 deg)
  minAdjacentCue: 1.55,
  minLandmarkVisibility: 0.30,// aligns with runtime precheck
  maxBlockedFrac: 0.25,
  maxEdgeFrac: 0.35,
  targetDifficulty: 0.66,     // try extra terrain if attempt 0 has not hit targetReady
});

/**
 * Round 3 look-alike twin thresholds: calibrated against Round 1/2 + rep32 blind
 * reviews so at least one rival cell produces a near-twin skyline & map structure
 * excluded by 1-2 phone-legible, contour-map-checkable decisive details (neither
 * sub-threshold/ambiguous nor glaringly different).
 */
export const GEN2_TWIN_THRESHOLDS = Object.freeze({
  rivalMinPeakProm: 0.65,        // deg: distinct crest prominence on rival skyline
  rivalMinEdgeDist: 3.0,         // deg: rival crest sits inside frame
  rivalMaxAngle: 11.0,           // deg: rival not staring into a looming close-up wall
  rivalMaxBlockedFrac: 0.35,     // rival not heavily occluded in foreground
  rivalMaxEdgeFrac: 0.45,        // rival skyline mostly inside map
  maxPitchShift: 2.6,            // deg: comparable observer vantage (not deep pit vs hilltop)
  maxShapeRMS: 1.55,             // deg: pitch-centered interior skyline shape RMS upper bound
  maxHorizonRMS: 2.40,           // deg: raw interior horizon RMS upper bound
  minSimilarity: 0.56,           // 0..1 feature-based skyline twin similarity floor (non-adj)
  minAdjSimilarity: 0.64,        // stricter similarity floor when rival is adjacent
  maxMatchedBearingShift: 11.0,  // deg: upper bound so matched crests are not glaringly off
  maxAnchorBearingShift: 4.5,    // deg: at least one crest closely aligned (anchor lock)
  maxMatchedHeightDiff: 2.60,    // deg: pitch-compensated screen height diff upper bound
  maxRawHeightDiff: 3.20,        // deg: raw elevation-angle diff upper bound
  maxDecisiveDetails: 2,         // 1-2 decisive details (3+ = glaring everywhere, D5-6)
  minShiftDetail: 5.0,           // deg: crest bearing shift (~90 px at 60 deg FOV on 1080 px)
  minHeightDetail: 1.00,         // deg: raw crest height diff lower bound (with screen >= 0.85)
  minScreenHeightDetail: 0.85,   // deg: pitch-compensated crest height diff lower bound
  minHeightContrastDetail: 1.15, // deg: relative crest-to-crest height contrast change
  minOrderFlipContrast: 0.95,    // deg: contrast change when tallest crest flips side
  minSaddleDetail: 0.85,         // deg: saddle depth difference (deeper saddle >= 1.1 deg)
  maxSaddleDetail: 2.60,         // deg: upper bound on saddle difference
  minPresenceProm: 1.10,         // deg: absent/extra mapped summit prominence lower bound
  minPresenceLocalProm: 0.95,    // deg: absent/extra mapped summit local prominence
  maxPresenceProm: 3.20,         // deg: upper bound so extra summit isn't a glaring wall
  minTwinInteriorCue: 1.00,      // deg: ensures clear in-frame silhouette difference
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

  // Saddle drops between consecutive left-to-right skyline crests (for both peaks and allSkylinePeaks)
  const saddleBetween = (leftP, rightP) => {
    let trough = Infinity, troughD = (leftP.d + rightP.d) / 2;
    for (const c of inside) {
      if (c.d >= leftP.d && c.d <= rightP.d && c.a < trough) { trough = c.a; troughD = c.d; }
    }
    const drop = Number.isFinite(trough) ? Math.min(leftP.a, rightP.a) - trough : 0;
    return { d: round1(troughD), a: Number.isFinite(trough) ? round2(trough) : 0, drop: round2(drop) };
  };
  let saddleDrop = 0, peakSep = 0;
  const saddles = [];
  if (peaks.length >= 2) {
    const [leftP, rightP] = [peaks[0], peaks[1]].sort((u, v) => u.d - v.d);
    peakSep = Math.abs(rightP.d - leftP.d);
    saddleDrop = saddleBetween(leftP, rightP).drop;
    const ordered = peaks.slice().sort((u, v) => u.d - v.d);
    for (let i = 0; i < ordered.length - 1; i++) {
      saddles.push({
        leftD: ordered[i].d, rightD: ordered[i + 1].d,
        leftCell: ordered[i].summit?.cell ?? null, rightCell: ordered[i + 1].summit?.cell ?? null,
        ...saddleBetween(ordered[i], ordered[i + 1]),
      });
    }
  }
  const allSaddles = [];
  if (allSkylinePeaks.length >= 2) {
    const orderedAll = allSkylinePeaks.slice().sort((u, v) => u.d - v.d);
    for (let i = 0; i < orderedAll.length - 1; i++) {
      allSaddles.push({
        leftD: orderedAll[i].d, rightD: orderedAll[i + 1].d,
        leftCell: orderedAll[i].summit?.cell ?? null, rightCell: orderedAll[i + 1].summit?.cell ?? null,
        ...saddleBetween(orderedAll[i], orderedAll[i + 1]),
      });
    }
  }

  const p1 = peaks[0] || null;
  const p2 = peaks[1] || null;
  const minRatio = thresholds.minLocalPromRatio ?? 0;
  const peakNotFlat = (p) => !minRatio || p.localProm >= 1.35 || (p.localProm / Math.max(0.01, p.prom)) >= minRatio;
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
    && peakNotFlat(p1)
    && p1.sharpness >= thresholds.minPeakSharpness
    && p1.promRatio >= thresholds.minPromAngleRatio
    && p2.prom >= thresholds.minSecondaryProm
    && p2.localProm >= thresholds.minSecondaryLocalProm
    && peakNotFlat(p2)
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
    saddles,
    allSaddles,
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
 * Extract a fast pitch-centred skyline profile and local crests from a 360 deg
 * cell panorama at (heading, fov), with zero extra raycasts.
 */
export function extractSweepWindow(sw, heading, fov, minProm = 0.55) {
  const { step, count, angles } = sw;
  const half = Math.round((fov / 2) / step);
  const centre = Math.round(wrap360(heading) / step) % count;
  const len = 2 * half + 1;
  const win = new Float32Array(len);
  let minA = Infinity, maxA = -Infinity;
  for (let k = 0; k < len; k++) {
    const a = angles[((centre + k - half) % count + count) % count];
    win[k] = a;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
  }
  const pitch = (minA + maxA) * 0.5;
  const peaks = [];
  for (let k = 2; k < len - 2; k++) {
    const a = win[k];
    if (!(a >= win[k - 1] && a >= win[k + 1] && (a > win[k - 1] || a > win[k + 1]))) continue;
    let lm = a, rm = a;
    for (let j = k - 1; j >= 0 && win[j] <= a; j--) if (win[j] < lm) lm = win[j];
    for (let j = k + 1; j < len && win[j] <= a; j++) if (win[j] < rm) rm = win[j];
    const prom = Math.min(a - lm, a - rm);
    if (prom >= minProm) peaks.push({ d: (k - half) * step, a, y: a - pitch, prom });
  }
  peaks.sort((x, y) => (y.prom - x.prom) || (x.d - y.d));
  const kept = [];
  for (const pk of peaks) if (kept.every((o) => Math.abs(o.d - pk.d) >= 7)) kept.push(pk);
  kept.sort((x, y) => x.d - y.d);
  return { win, pitch, minA, maxA, relief: maxA - minA, peaks: kept };
}

/**
 * Scan all candidate headings directly on precomputed 360 deg panoramas to find
 * phone-legible (origin, heading) windows that have at least one near-twin rival
 * cell at the SAME heading (zero extra raycasts).
 */
export function fastTwinScan(sweeps, fov, summits, {
  fixedHeadings = null,
  divisions = 8,
  gridThresholds = GEN2_GRID_THRESHOLDS,
  twinThresholds = GEN2_TWIN_THRESHOLDS,
  headingStep = 6,
} = {}) {
  const headingSet = new Set(fixedHeadings || Array.from({ length: Math.round(360 / headingStep) }, (_, i) => i * headingStep));

  // Add peak-pair-centred headings when exact headings are allowed (crucial for sparse classic/alpine terrains)
  if (!fixedHeadings) {
    const win = Math.round(12 / (sweeps[0]?.step || 1.5));
    for (const sw of sweeps) {
      const { p, step, count, angles, dists, edges } = sw;
      const panoPeaks = [];
      for (let i = 0; i < count; i++) {
        const prev = angles[(i - 1 + count) % count];
        const next = angles[(i + 1) % count];
        const a = angles[i];
        if (!(a >= prev && a >= next && (a > prev || a > next))) continue;
        if (edges[i] || dists[i] < gridThresholds.minPeakDist * 0.85 || dists[i] > gridThresholds.maxPeakDist) continue;
        let l12 = a, r12 = a;
        for (let k = 1; k <= win; k++) {
          const al = angles[(i - k + count) % count];
          const ar = angles[(i + k) % count];
          if (al < l12) l12 = al;
          if (ar < r12) r12 = ar;
        }
        if (Math.min(a - l12, a - r12) < 0.70) continue;
        const az = i * step;
        const px = p.x + Math.sin(az * DEG) * dists[i];
        const py = p.y + Math.cos(az * DEG) * dists[i];
        const s = matchSummit(p, az, dists[i], px, py, summits);
        if (s) panoPeaks.push({ az, s });
      }
      for (let i = 0; i < panoPeaks.length; i++) {
        for (let j = i + 1; j < panoPeaks.length; j++) {
          if (panoPeaks[i].s === panoPeaks[j].s) continue;
          const diff = wrap360(panoPeaks[j].az - panoPeaks[i].az + 180) - 180;
          const sep = Math.abs(diff);
          if (sep < gridThresholds.minPeakSep || sep > fov - 2 * gridThresholds.minEdgeMargin) continue;
          const mid = wrap360(Math.round((panoPeaks[i].az + diff / 2) / 2) * 2);
          headingSet.add(mid);
        }
      }
    }
  }
  const headings = [...headingSet].sort((a, b) => a - b);
  const byKey = new Map();

  const scoreHeading = (h) => {
    const clean = [];
    for (let oi = 0; oi < sweeps.length; oi++) {
      const chk = fastWindowCheck(sweeps[oi], h, fov, summits, gridThresholds);
      if (chk && chk.quickStrict && chk.relief >= Math.max(2.2, gridThresholds.minRelief - 0.25)) {
        clean.push({ oi, chk });
      }
    }
    if (!clean.length) return;
    const profs = sweeps.map((sw) => extractSweepWindow(sw, h, fov, 0.55));
    for (const { oi, chk } of clean) {
      const sw0 = sweeps[oi];
      const oCell = sw0.p;
      const p0 = profs[oi];
      if (p0.peaks.length < 2) continue;

      let bestTwinScore = 0;
      let bestTwinInfo = null;
      let minSweepRMS = Infinity;
      const n = p0.win.length;
      const maxShapeAllowed = Math.min(2.35, Math.max(twinThresholds.maxShapeRMS + 0.15, 0.48 * p0.relief));

      for (let ti = 0; ti < sweeps.length; ti++) {
        if (ti === oi) continue;
        const p1 = profs[ti];
        let sRaw = 0, sShape = 0;
        for (let k = 2; k < n - 2; k++) {
          const dr = p1.win[k] - p0.win[k];
          const ds = (p1.win[k] - p1.pitch) - (p0.win[k] - p0.pitch);
          sRaw += dr * dr;
          sShape += ds * ds;
        }
        const rms = Math.sqrt(sRaw / (n - 4));
        if (rms < minSweepRMS) minSweepRMS = rms;
        const shapeRMS = Math.sqrt(sShape / (n - 4));
        if (shapeRMS > maxShapeAllowed) continue;
        if (Math.abs(p1.pitch - p0.pitch) > twinThresholds.maxPitchShift + 0.4) continue;
        if (p1.peaks.length < 1 || Math.abs(p1.peaks.length - p0.peaks.length) > 1) continue;

        const tCell = sweeps[ti].p;
        const adj = Math.max(Math.abs(tCell.row - oCell.row), Math.abs(tCell.column - oCell.column)) === 1;
        let tScore = 0;
        let kind = null;
        const relShapeSim = saturate(1 - (shapeRMS / Math.max(2.8, p0.relief)) / 0.58);
        if (p1.peaks.length === p0.peaks.length) {
          let maxD = 0, minD = Infinity, maxDY = 0, maxDA = 0, sumD = 0, sumDY = 0, sumDP = 0;
          for (let j = 0; j < p0.peaks.length; j++) {
            const dd = Math.abs(p1.peaks[j].d - p0.peaks[j].d);
            const dy = Math.abs(p1.peaks[j].y - p0.peaks[j].y);
            const da = Math.abs(p1.peaks[j].a - p0.peaks[j].a);
            const dp = Math.abs(p1.peaks[j].prom - p0.peaks[j].prom);
            if (dd > maxD) maxD = dd;
            if (dd < minD) minD = dd;
            if (dy > maxDY) maxDY = dy;
            if (da > maxDA) maxDA = da;
            sumD += dd; sumDY += dy; sumDP += dp;
          }
          const relC = p0.peaks.length >= 2
            ? Math.abs((p1.peaks[1].a - p1.peaks[0].a) - (p0.peaks[1].a - p0.peaks[0].a))
            : 0;
          if (minD <= twinThresholds.maxAnchorBearingShift + 1.0
            && maxD <= twinThresholds.maxMatchedBearingShift + 1.0
            && maxDY <= twinThresholds.maxMatchedHeightDiff + 0.3
            && maxDA <= twinThresholds.maxRawHeightDiff + 0.4) {
            const bearingLocked = maxD <= twinThresholds.maxAnchorBearingShift + 0.5;
            const hasDetail = maxD >= twinThresholds.minShiftDetail - 0.5
              || (maxDY >= twinThresholds.minScreenHeightDetail - 0.1 && maxDA >= twinThresholds.minHeightDetail - 0.1)
              || relC >= twinThresholds.minHeightContrastDetail - 0.15;
            if (hasDetail) {
              const m = p0.peaks.length;
              const sim = 0.34 * saturate(1 - (sumD / m) / 12.5)
                + 0.26 * saturate(1 - (sumDY / m) / 2.4)
                + 0.18 * saturate(1 - (sumDP / m) / 2.4)
                + 0.22 * relShapeSim;
              if (sim >= (adj ? 0.56 : 0.50)) {
                kind = bearingLocked ? 'bearing-locked' : 'same-count';
                tScore = (adj ? 1.5 : 3.0) + (bearingLocked ? 0.70 : 0.30) + sim;
              }
            }
          }
        } else if (!adj) {
          const big = p0.peaks.length > p1.peaks.length ? p0.peaks : p1.peaks;
          const small = p0.peaks.length > p1.peaks.length ? p1.peaks : p0.peaks;
          let matched = 0, sumD = 0, sumDY = 0, sumDP = 0;
          const used = new Set();
          for (const sp of small) {
            let bj = -1, bc = Infinity;
            for (let j = 0; j < big.length; j++) {
              if (used.has(j)) continue;
              const dd = Math.abs(big[j].d - sp.d), dy = Math.abs(big[j].y - sp.y);
              if (dd <= 5.5 && dy <= 1.2 && dd + dy * 3 < bc) { bc = dd + dy * 3; bj = j; }
            }
            if (bj >= 0) {
              used.add(bj); matched++;
              sumD += Math.abs(big[bj].d - sp.d);
              sumDY += Math.abs(big[bj].y - sp.y);
              sumDP += Math.abs(big[bj].prom - sp.prom);
            }
          }
          const miss = big.find((_, j) => !used.has(j));
          if (matched === small.length && miss && miss.prom >= twinThresholds.minPresenceProm - 0.15 && miss.prom <= twinThresholds.maxPresenceProm) {
            const sim = (small.length >= 2 ? 0.86 : 0.78)
              * (0.34 * saturate(1 - (sumD / small.length) / 12.5)
                + 0.26 * saturate(1 - (sumDY / small.length) / 2.4)
                + 0.18 * saturate(1 - (sumDP / small.length) / 2.4)
                + 0.22 * relShapeSim);
            if (sim >= 0.50) {
              kind = small.length >= 2 ? 'presence-3v2' : 'presence-2v1';
              tScore = (small.length >= 2 ? 2.45 : 1.05) + sim;
            }
          }
        }
        if (tScore > bestTwinScore) {
          bestTwinScore = tScore;
          bestTwinInfo = { cell: tCell.label, adj, kind, shapeRMS: round2(shapeRMS), tScore: round3(tScore) };
        }
      }

      if (bestTwinScore <= 0 && minSweepRMS < 0.45) continue;
      const borderDist = Math.min(oCell.row, divisions - 1 - oCell.row, oCell.column, divisions - 1 - oCell.column);
      const isCorner = (oCell.row === 0 || oCell.row === divisions - 1) && (oCell.column === 0 || oCell.column === divisions - 1);
      const interiorBias = isCorner ? 0 : borderDist === 0 ? 0.08 : 0.20;
      const reliefMod = chk.relief <= 5.2 ? 0.10 : -0.15 * saturate((chk.relief - 5.2) / 3.0);
      const rmsOk = minSweepRMS >= 0.45 ? 0.30 : -0.80;
      const propScore = bestTwinScore + 0.30 * chk.quickScore + interiorBias + reliefMod + rmsOk;
      const key = `${oCell.label}:${h}`;
      const existing = byKey.get(key);
      if (!existing || propScore > existing.propScore) {
        byKey.set(key, {
          sw: sw0, origin: oCell, heading: h, quickStrict: chk.quickStrict,
          minSweepRMS, fastTwin: bestTwinInfo, propScore,
        });
      }
    }
  };

  for (const h of headings) scoreHeading(h);

  // Local +-3 deg refinement around the top twin hits when exact headings are allowed
  if (!fixedHeadings && headingStep >= 6) {
    const topHits = [...byKey.values()]
      .filter((x) => x.fastTwin)
      .sort((a, b) => (b.propScore - a.propScore) || a.origin.label.localeCompare(b.origin.label) || (a.heading - b.heading))
      .slice(0, 12);
    const extraHeadings = new Set();
    for (const hit of topHits) {
      extraHeadings.add(wrap360(hit.heading - 3));
      extraHeadings.add(wrap360(hit.heading + 3));
    }
    for (const eh of extraHeadings) scoreHeading(eh);
  }

  const all = [...byKey.values()].sort((a, b) => (b.propScore - a.propScore)
    || a.origin.label.localeCompare(b.origin.label)
    || (a.heading - b.heading));

  // Keep diverse (origin, heading) entries: at most 2 headings (>= 12 deg apart) per cell
  const kept = [];
  const perCell = new Map();
  for (const item of all) {
    const list = perCell.get(item.origin.label) || [];
    if (list.length >= 2 || list.some((h) => angleDiff(h, item.heading) < 12)) continue;
    list.push(item.heading);
    perCell.set(item.origin.label, list);
    kept.push(item);
    if (kept.length >= 60) break;
  }
  return kept;
}

function horizonSaddleDrop(horizon, fov, pLeft, pRight) {
  const n = horizon.length;
  const step = fov / (n - 1);
  const i0 = Math.max(0, Math.round((pLeft.d + fov / 2) / step));
  const i1 = Math.min(n - 1, Math.round((pRight.d + fov / 2) / step));
  let trough = Infinity;
  for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) {
    if (horizon[i] < trough) trough = horizon[i];
  }
  if (!Number.isFinite(trough)) return { drop: 0, trough: 0 };
  return { drop: Math.max(0, Math.min(pLeft.a, pRight.a) - trough), trough };
}

function sideOfOffset(d, fov) {
  return d < -fov / 6 ? 'left' : d > fov / 6 ? 'right' : 'centre';
}

/**
 * Feature-based skyline near-twin comparison between the true cell and a rival
 * cell at the same heading/FOV. Evaluates ONLY namable skyline features (crests,
 * bearings, pitch-adjusted heights, saddles, and mapped contour summits — zero
 * foreground probes). Returns similarity, decisive details, ambiguity flag, and
 * qualification verdict `isTwin`.
 */
export function compareSkylineTwin(originData, rivalData, {
  adjacent = false,
  thresholds = GEN2_TWIN_THRESHOLDS,
} = {}) {
  const T = thresholds;
  const fov = originData.fov;
  const h0 = originData.horizon;
  const h1 = rivalData.horizon;
  const pitch0 = originData.pitch;
  const pitch1 = rivalData.pitch;

  // Interior pure-skyline RMS and pitch-centred shape RMS (ignore outer 3 deg)
  const n = h0.length;
  const ig = Math.ceil((3 / fov) * (n - 1));
  let sRaw = 0, sShape = 0, cnt = 0;
  for (let i = ig; i < n - ig; i++) {
    const dr = h1[i] - h0[i];
    const ds = (h1[i] - pitch1) - (h0[i] - pitch0);
    sRaw += dr * dr;
    sShape += ds * ds;
    cnt++;
  }
  const hRMS = cnt ? Math.sqrt(sRaw / cnt) : Infinity;
  const shapeRMS = cnt ? Math.sqrt(sShape / cnt) : Infinity;
  const intCue = interiorHorizonCue({ horizon: h0, fov }, { horizon: h1, fov }, 3);
  const pitchShift = Math.abs(pitch1 - pitch0);

  const p0 = (originData.peaks || []).slice().sort((a, b) => a.d - b.d);
  const p1 = (rivalData.allSkylinePeaks || rivalData.peaks || [])
    .filter((p) => p.prom >= T.rivalMinPeakProm && (p.edgeDist ?? (fov / 2 - Math.abs(p.d))) >= T.rivalMinEdgeDist)
    .sort((a, b) => a.d - b.d);

  if (p0.length < 2 || p1.length < 1 || Math.abs(p0.length - p1.length) > 1) return null;

  // Order-preserving crest alignment
  const pairs = [];
  let missing = null, extra = null;
  if (p0.length === p1.length) {
    for (let i = 0; i < p0.length; i++) pairs.push([p0[i], p1[i]]);
  } else if (p0.length === p1.length + 1) {
    let bestCost = Infinity, bestSkip = 0;
    for (let skip = 0; skip < p0.length; skip++) {
      let cost = 0, k = 0;
      for (let i = 0; i < p0.length; i++) {
        if (i === skip) continue;
        cost += Math.abs(p0[i].d - p1[k].d) + 3 * Math.abs((p0[i].a - pitch0) - (p1[k].a - pitch1));
        k++;
      }
      if (cost < bestCost) { bestCost = cost; bestSkip = skip; }
    }
    missing = p0[bestSkip];
    let k = 0;
    for (let i = 0; i < p0.length; i++) if (i !== bestSkip) pairs.push([p0[i], p1[k++]]);
  } else {
    let bestCost = Infinity, bestSkip = 0;
    for (let skip = 0; skip < p1.length; skip++) {
      let cost = 0, k = 0;
      for (let i = 0; i < p1.length; i++) {
        if (i === skip) continue;
        cost += Math.abs(p0[k].d - p1[i].d) + 3 * Math.abs((p0[k].a - pitch0) - (p1[i].a - pitch1));
        k++;
      }
      if (cost < bestCost) { bestCost = cost; bestSkip = skip; }
    }
    extra = p1[bestSkip];
    let k = 0;
    for (let i = 0; i < p1.length; i++) if (i !== bestSkip) pairs.push([p0[k++], p1[i]]);
  }

  const sameCount = p0.length === p1.length;
  const dds = pairs.map(([a, b]) => b.d - a.d);
  const dys = pairs.map(([a, b]) => (b.a - pitch1) - (a.a - pitch0));
  const das = pairs.map(([a, b]) => b.a - a.a);
  const absDs = dds.map(Math.abs);
  const absYs = dys.map(Math.abs);
  const absAs = das.map(Math.abs);
  const maxD = Math.max(...absDs);
  const minD = Math.min(...absDs);
  const meanD = absDs.reduce((s, v) => s + v, 0) / absDs.length;
  const maxDY = Math.max(...absYs);
  const meanDY = absYs.reduce((s, v) => s + v, 0) / absYs.length;
  const maxDA = Math.max(...absAs);

  const rivalMapped = pairs.filter(([, b]) => !!b.summit).length + (extra?.summit ? 1 : 0);
  const requiredMapped = sameCount ? Math.min(2, p1.length) : Math.min(2, pairs.length) + (extra ? 1 : 0);
  const parallelLandforms = pairs.some(([a, b]) => a.summit && b.summit
    && Math.hypot(a.summit.x - b.summit.x, a.summit.y - b.summit.y) > 40)
    || (!adjacent && !!(missing?.summit || extra?.summit));

  const cleanRival = (rivalData.maxAngle ?? 0) <= T.rivalMaxAngle
    && (rivalData.blockedFrac ?? 0) <= T.rivalMaxBlockedFrac
    && (rivalData.edgeFrac ?? 0) <= T.rivalMaxEdgeFrac
    && !rivalData.edgeWall
    && pitchShift <= T.maxPitchShift
    && rivalMapped >= requiredMapped;

  // Build map-checkable, phone-legible decisive details
  const details = [];

  // 1. Present vs absent mapped summit/knoll
  if (missing) {
    const okPresence = missing.prom >= T.minPresenceProm
      && (missing.localProm ?? missing.prom) >= T.minPresenceLocalProm
      && missing.prom <= T.maxPresenceProm
      && (missing.edgeDist ?? (fov / 2 - Math.abs(missing.d))) >= 5
      && maxD <= 5.5 && maxDY <= 1.25;
    if (okPresence) {
      details.push({
        type: 'summit-absent',
        size: round2(missing.prom),
        unit: 'deg',
        side: sideOfOffset(missing.d, fov),
        originCell: missing.summit?.cell ?? null,
        rivalCell: null,
        originAz: missing.az,
        mapCheckable: !!missing.summit,
      });
    }
  } else if (extra) {
    const okPresence = extra.prom >= T.minPresenceProm
      && (extra.localProm ?? extra.prom) >= T.minPresenceLocalProm
      && extra.prom <= T.maxPresenceProm
      && (extra.edgeDist ?? (fov / 2 - Math.abs(extra.d))) >= 5
      && maxD <= 5.5 && maxDY <= 1.25;
    if (okPresence) {
      details.push({
        type: 'summit-extra',
        size: round2(extra.prom),
        unit: 'deg',
        side: sideOfOffset(extra.d, fov),
        originCell: null,
        rivalCell: extra.summit?.cell ?? null,
        rivalAz: extra.az,
        mapCheckable: !!extra.summit,
      });
    }
  }

  // 2. Crest bearing shifts (>= minShiftDetail)
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i];
    const dd = dds[i];
    if (Math.abs(dd) >= T.minShiftDetail) {
      details.push({
        type: 'crest-shift',
        size: round1(Math.abs(dd)),
        delta: round1(dd),
        unit: 'deg',
        direction: dd < 0 ? 'left' : 'right',
        side: sideOfOffset(a.d, fov),
        originCell: a.summit?.cell ?? null,
        rivalCell: b.summit?.cell ?? null,
        originAz: a.az,
        rivalAz: b.az,
        mapCheckable: !!(a.summit && b.summit),
      });
    }
  }

  // 3. Crest height / relative height-order change (deduplicated per crest pair)
  let bestContrast = null;
  if (pairs.length >= 2) {
    for (let i = 0; i < pairs.length - 1; i++) {
      const [a0, b0] = pairs[i];
      const [a1, b1] = pairs[i + 1];
      const origDiff = a1.a - a0.a;
      const rivalDiff = b1.a - b0.a;
      const contrastDelta = rivalDiff - origDiff;
      const orderFlip = Math.sign(origDiff) !== Math.sign(rivalDiff)
        && Math.abs(origDiff) >= 0.35 && Math.abs(rivalDiff) >= 0.35
        && Math.abs(contrastDelta) >= T.minOrderFlipContrast;
      if (orderFlip || Math.abs(contrastDelta) >= T.minHeightContrastDetail) {
        const mag = Math.abs(contrastDelta);
        if (!bestContrast || (orderFlip && !bestContrast.orderFlip) || (orderFlip === bestContrast.orderFlip && mag > bestContrast.mag)) {
          const movedIdx = Math.abs(dys[i + 1]) >= Math.abs(dys[i]) ? i + 1 : i;
          const [am, bm] = pairs[movedIdx];
          bestContrast = {
            i, mag, orderFlip, contrastDelta,
            movedIdx, am, bm, dy: dys[movedIdx], da: das[movedIdx],
            a0, b0, a1, b1,
            tallerOriginSide: origDiff >= 0 ? sideOfOffset(a1.d, fov) : sideOfOffset(a0.d, fov),
            tallerRivalSide: rivalDiff >= 0 ? sideOfOffset(b1.d, fov) : sideOfOffset(b0.d, fov),
          };
        }
      }
    }
  }
  const heightCovered = new Set();
  if (bestContrast) {
    heightCovered.add(bestContrast.i);
    heightCovered.add(bestContrast.i + 1);
    const { am, bm, dy, da, orderFlip, contrastDelta, a0, b0, a1, b1 } = bestContrast;
    details.push({
      type: 'crest-height',
      size: round2(Math.max(Math.abs(contrastDelta), Math.abs(dy))),
      contrastDelta: round2(contrastDelta),
      screenDelta: round2(dy),
      rawDelta: round2(da),
      unit: 'deg',
      orderFlip,
      direction: dy >= 0 ? 'higher' : 'lower',
      side: sideOfOffset(am.d, fov),
      originCell: am.summit?.cell ?? null,
      rivalCell: bm.summit?.cell ?? null,
      tallerOriginSide: bestContrast.tallerOriginSide,
      tallerRivalSide: bestContrast.tallerRivalSide,
      pairCells: [a0.summit?.cell ?? null, a1.summit?.cell ?? null],
      rivalPairCells: [b0.summit?.cell ?? null, b1.summit?.cell ?? null],
      mapCheckable: !!(a0.summit && a1.summit && b0.summit && b1.summit),
    });
  }
  for (let i = 0; i < pairs.length; i++) {
    if (heightCovered.has(i)) continue;
    const [a, b] = pairs[i];
    const dy = dys[i], da = das[i];
    if (Math.abs(dy) >= T.minScreenHeightDetail && Math.abs(da) >= T.minHeightDetail) {
      details.push({
        type: 'crest-height',
        size: round2(Math.abs(da)),
        screenDelta: round2(dy),
        rawDelta: round2(da),
        unit: 'deg',
        orderFlip: false,
        direction: dy >= 0 ? 'higher' : 'lower',
        side: sideOfOffset(a.d, fov),
        originCell: a.summit?.cell ?? null,
        rivalCell: b.summit?.cell ?? null,
        mapCheckable: !!(a.summit && b.summit),
      });
    }
  }

  // 4. Saddle depth difference between matched consecutive crests
  if (sameCount && pairs.length >= 2) {
    let bestSad = null;
    for (let i = 0; i < pairs.length - 1; i++) {
      const [a0, b0] = pairs[i];
      const [a1, b1] = pairs[i + 1];
      const s0 = horizonSaddleDrop(h0, fov, a0, a1);
      const s1 = horizonSaddleDrop(h1, fov, b0, b1);
      const dsad = s1.drop - s0.drop;
      const troughDY = (s1.trough - pitch1) - (s0.trough - pitch0);
      const hasHeightOnPair = details.some((d) => d.type === 'crest-height' && heightCovered.has(i) && heightCovered.has(i + 1));
      if (Math.abs(dsad) >= T.minSaddleDetail
        && Math.abs(dsad) <= T.maxSaddleDetail
        && Math.max(s0.drop, s1.drop) >= 1.10
        && (!hasHeightOnPair || Math.abs(troughDY) >= 0.65)) {
        if (!bestSad || Math.abs(dsad) > Math.abs(bestSad.dsad)) {
          bestSad = { dsad, a0, a1, b0, b1 };
        }
      }
    }
    if (bestSad) {
      details.push({
        type: 'saddle-depth',
        size: round2(Math.abs(bestSad.dsad)),
        delta: round2(bestSad.dsad),
        unit: 'deg',
        direction: bestSad.dsad > 0 ? 'deeper' : 'shallower',
        side: 'centre',
        originCell: bestSad.a0.summit?.cell ?? null,
        rivalCell: bestSad.b0.summit?.cell ?? null,
        pairCells: [bestSad.a0.summit?.cell ?? null, bestSad.a1.summit?.cell ?? null],
        rivalPairCells: [bestSad.b0.summit?.cell ?? null, bestSad.b1.summit?.cell ?? null],
        mapCheckable: !!(bestSad.a0.summit && bestSad.a1.summit && bestSad.b0.summit && bestSad.b1.summit),
      });
    }
  }

  // Feature-level skyline similarity (0..1, purely on namable skyline features — zero foreground probes)
  const originRelief = Number.isFinite(originData.relief)
    ? originData.relief
    : (Math.max(...h0) - Math.min(...h0));
  const meanPromDiff = pairs.reduce((s, [a, b]) => s + Math.abs((b.prom ?? 0) - (a.prom ?? 0)), 0) / pairs.length;
  const countSim = sameCount ? 1.0 : (Math.min(p0.length, p1.length) >= 2 ? 0.86 : 0.78);
  const bearingSim = saturate(1 - meanD / 12.5);
  const heightSim = saturate(1 - meanDY / 2.4);
  const promSim = saturate(1 - meanPromDiff / 2.4);
  const relShapeSim = saturate(1 - (shapeRMS / Math.max(2.8, originRelief)) / 0.58);
  const similarity = round3(countSim * (0.34 * bearingSim + 0.26 * heightSim + 0.18 * promSim + 0.22 * relShapeSim));

  const bearingLocked = sameCount && maxD <= T.maxAnchorBearingShift;
  const anchorLocked = minD <= T.maxAnchorBearingShift;
  const shapeCap = Math.min(2.25, Math.max(T.maxShapeRMS, 0.45 * originRelief));
  const horizonCap = Math.min(3.00, Math.max(T.maxHorizonRMS, 0.60 * originRelief));
  const notGlaring = maxD <= T.maxMatchedBearingShift
    && maxDY <= T.maxMatchedHeightDiff
    && maxDA <= T.maxRawHeightDiff
    && shapeRMS <= shapeCap
    && hRMS <= horizonCap;

  const minSim = adjacent ? T.minAdjSimilarity : T.minSimilarity;
  const hasVisibleCue = intCue >= T.minTwinInteriorCue
    || details.some((d) => (d.type === 'crest-shift' && d.size >= 5.5)
      || (d.type === 'crest-height' && d.size >= 1.15)
      || ((d.type === 'summit-absent' || d.type === 'summit-extra') && d.size >= 1.15));

  const ambiguous = cleanRival && notGlaring && similarity >= T.minSimilarity
    && details.length === 0 && intCue < 1.65;

  const adjOk = !adjacent || (sameCount && (parallelLandforms || similarity >= 0.68));
  const presenceOk = sameCount || details.some((d) => d.type === 'summit-absent' || d.type === 'summit-extra');
  const contrastNotGlaring = !details.some((d) => d.type === 'crest-height' && d.size > 3.2);
  const isTwin = cleanRival
    && notGlaring
    && contrastNotGlaring
    && presenceOk
    && similarity >= minSim
    && anchorLocked
    && adjOk
    && hasVisibleCue
    && details.length >= 1
    && details.length <= T.maxDecisiveDetails
    && details.every((d) => d.mapCheckable);

  // Subtlety score (0..1): rewards details clearly above lower bound yet below glaring ceiling
  let subtlety = 0;
  if (details.length) {
    const subs = details.map((d) => {
      if (d.type === 'crest-shift') return saturate(1 - Math.max(0, d.size - 5.5) / 6.0);
      if (d.type === 'crest-height') return saturate(1 - Math.max(0, d.size - 1.1) / 1.8);
      if (d.type === 'saddle-depth') return saturate(1 - Math.max(0, d.size - 1.0) / 1.6);
      return saturate(1 - Math.max(0, d.size - 1.2) / 2.0);
    });
    subtlety = round3(subs.reduce((s, v) => s + v, 0) / subs.length);
  }

  return {
    cell: rivalData.label,
    adjacent,
    sameCount,
    originPeaks: p0.length,
    rivalPeaks: p1.length,
    parallelLandforms,
    bearingLocked,
    anchorLocked,
    similarity,
    shapeRMS: round2(shapeRMS),
    hRMS: round2(hRMS),
    intCue: round2(intCue),
    pitchShift: round2(pitchShift),
    maxBearingShift: round1(maxD),
    minBearingShift: round1(minD),
    maxScreenHeightDiff: round2(maxDY),
    subtlety,
    cleanRival,
    notGlaring,
    ambiguous,
    isTwin,
    decisiveDetails: details,
  };
}

/** Deterministic preference score for ranking qualified twins (non-adjacent parallel twins first). */
export function rankTwinScore(tw) {
  if (!tw || !tw.isTwin) return -1;
  const twoCrestRival = Math.min(tw.originPeaks, tw.rivalPeaks) >= 2;
  const nonAdj = tw.adjacent ? 0 : 1.05;
  const parallel = tw.parallelLandforms ? 0.35 : 0;
  const countBonus = tw.sameCount ? 0.85 : (twoCrestRival ? 0.55 : -0.45);
  const lockBonus = tw.bearingLocked ? 0.60 : (tw.decisiveDetails.length === 1 ? 0.30 : 0.10);
  const flipBonus = tw.decisiveDetails.some((d) => d.orderFlip) ? 0.20 : 0;
  return round3(nonAdj + parallel + countBonus + lockBonus + flipBonus + 1.15 * tw.similarity + 0.25 * tw.subtlety);
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
 * Calibrated Round 3 gen=2 difficulty, fairness, and readability estimates
 * (fit against Round 1/2 + rep32 north-up blind reviews). Without a real
 * skyline near-twin, clean multi-summit views predict D ~5.5-6.6; reaching
 * D >= 8.0 requires a strong parallel-error near-twin with 1-2 clear details.
 */
export function gridGen2Scores({
  sky,
  minHorizonRMS,
  minInteriorCue,
  minFeatureMargin,
  minAdjacentShift,
  remoteCloseHorizon = 0,
  reasoning,
  originRow,
  originCol,
  divisions,
  heading,
  twins = [],
  primaryTwin = null,
  ambiguousCells = 0,
  strict = false,
}) {
  const borderDist = Math.min(originRow, divisions - 1 - originRow, originCol, divisions - 1 - originCol);
  const isCorner = (originRow === 0 || originRow === divisions - 1)
    && (originCol === 0 || originCol === divisions - 1);
  const oblique = Math.min(...[0, 90, 180, 270].map((c) => angleDiff(heading, c))) / 45;

  const decoyTerm = 1 - Math.exp(-(reasoning?.decoySameOrder ?? 0) / 8);
  const summitRichness = saturate(((reasoning?.mapSummits ?? 6) - 6) / 12);
  const interiorTerm = isCorner ? 0 : borderDist === 0 ? 0.45 : 1.0;
  const obliqueTerm = 0.3 + 0.7 * saturate(oblique / 0.4);
  const relief = Number.isFinite(sky?.relief) ? sky.relief : 3.5;
  const passesSkyline = sky?.passesSkyline ?? (sky?.skylineScore >= 0.65 && !sky?.edgeWall);
  const reliefPenalty = saturate((relief - 4.8) / 3.2);
  const compactBonus = saturate((4.5 - relief) / 1.8) * (passesSkyline ? 1 : 0);

  const nonAdjTwins = twins.filter((t) => !t.adjacent);
  const multiCrestNonAdj = nonAdjTwins.filter((t) => Math.min(t.originPeaks, t.rivalPeaks) >= 2);
  const twin = primaryTwin || twins[0] || null;
  let estD = 5.35
    + 0.42 * decoyTerm
    + 0.35 * interiorTerm
    + 0.18 * summitRichness
    + 0.12 * obliqueTerm
    + 0.30 * compactBonus
    - 0.65 * reliefPenalty;

  const hasMultiCrestTwin = !!(twin && twin.isTwin && Math.min(twin.originPeaks, twin.rivalPeaks) >= 2);
  if (twin && twin.isTwin) {
    if (hasMultiCrestTwin) {
      const nonAdjBoost = twin.adjacent ? 0.55 : 1.05;
      const parallelBoost = twin.parallelLandforms ? 0.22 : 0;
      const simBoost = 1.05 * saturate((twin.similarity - 0.52) / 0.34);
      const structureBoost = twin.sameCount
        ? (twin.bearingLocked ? 0.65 : twin.decisiveDetails.length === 1 ? 0.42 : 0.22)
        : 0.34;
      const subtletyBoost = 0.28 * (twin.subtlety ?? 0.5);
      const multiTwinBoost = multiCrestNonAdj.length >= 2 ? 0.22 : twins.length >= 2 ? 0.10 : 0;
      estD += nonAdjBoost + parallelBoost + simBoost + structureBoost + subtletyBoost + multiTwinBoost;
    } else {
      // 2->1 twin (rival sees only 1 summit): real blind reviews (g22) rate ~D7, not D8+
      const simBoost = 0.65 * saturate((twin.similarity - 0.52) / 0.34);
      estD += (twin.adjacent ? 0.35 : 0.65) + simBoost + 0.12 * (twin.subtlety ?? 0.5);
    }
  } else {
    // Legacy mild closeness credit when no qualified skyline twin exists (keeps D in 5.3-6.5)
    const closenessTerm = saturate(1 - (minHorizonRMS - 0.65) / 1.35);
    const lookalikeTerm = 1 - Math.exp(-remoteCloseHorizon / 6);
    estD += 0.18 * closenessTerm + 0.12 * lookalikeTerm;
  }

  const estimatedDifficulty = +Math.max(4.0, Math.min(9.4, estD)).toFixed(1);
  const difficulty = saturate((estimatedDifficulty - 5.0) / 4.2);

  // Detail legibility term for fairness when a twin exists
  let detailClarity = 0.75;
  if (twin?.decisiveDetails?.length) {
    const d0 = twin.decisiveDetails[0];
    if (d0.type === 'crest-shift') detailClarity = saturate((d0.size - 4.5) / 3.5);
    else if (d0.type === 'crest-height') detailClarity = saturate((d0.size - 0.85) / 1.0);
    else if (d0.type === 'saddle-depth') detailClarity = saturate((d0.size - 0.75) / 0.9);
    else detailClarity = saturate((d0.size - 0.95) / 0.9);
    if (d0.orderFlip) detailClarity = Math.max(detailClarity, 0.85);
  }

  // Smoothly calibrated fairness & readability (fit to Round 1/2 + rep32 north-up reviews)
  const edgeCutVal = Number.isFinite(sky?.edgeCut) ? Math.max(0, sky.edgeCut) : 0;
  const distinctPeaks = Number.isFinite(sky?.distinctPeaks) ? sky.distinctPeaks : 2;
  const secLocalProm = Number.isFinite(sky?.secondaryLocalProm) ? sky.secondaryLocalProm : 1.2;
  const secProm = Number.isFinite(sky?.secondaryProm) ? sky.secondaryProm : secLocalProm;
  const secRatio = secProm > 0 ? secLocalProm / secProm : 1;

  const peakPenalty = distinctPeaks >= 2 ? 0 : distinctPeaks === 1 ? 2.4 : 3.8;
  const cutPenalty = edgeCutVal <= 0.35 ? 0 : 1.65 * saturate((edgeCutVal - 0.35) / 1.5);
  const wallPenalty = (sky?.edgeWall || sky?.runtimeEdgeCrop) ? 1.2 : 0;
  const reliefLowPenalty = relief >= 2.5 ? 0 : 1.4 * saturate((2.5 - relief) / 1.0);
  const broadPenalty = (secLocalProm >= 1.35 || secRatio >= 0.50) ? 0 : 2.1 * saturate((0.50 - secRatio) / 0.20);
  const lowPromPenalty = secLocalProm >= 1.0 ? 0 : 1.6 * saturate((1.0 - secLocalProm) / 0.6);
  const ambPenalty = 1.15 * Math.min(3, ambiguousCells);

  const estF = 7.25
    + 0.85 * (sky?.skylineScore ?? 0.5)
    + 0.45 * detailClarity
    + 0.40 * saturate((minFeatureMargin - 0.95) / 1.4)
    + 0.25 * saturate((minAdjacentShift - 4.5) / 7.5)
    - peakPenalty - cutPenalty - wallPenalty - reliefLowPenalty - broadPenalty - lowPromPenalty - ambPenalty;
  const estimatedFairness = +Math.max(2.0, Math.min(9.5, estF)).toFixed(1);
  const fairness = saturate((estimatedFairness - 4.0) / 5.2);

  const estR = 6.35
    + 1.30 * (sky?.skylineScore ?? 0.5)
    + 0.60 * saturate((secLocalProm - 0.85) / 1.0)
    + 0.45 * saturate(1 - edgeCutVal / 0.6)
    - 0.60 * peakPenalty - 0.70 * cutPenalty - 0.75 * wallPenalty - 0.55 * reliefLowPenalty - 0.45 * broadPenalty;
  const estimatedReadability = +Math.max(3.0, Math.min(9.2, estR)).toFixed(1);
  const readability = saturate((estimatedReadability - 4.0) / 5.0);

  const targetReady = !!(strict && hasMultiCrestTwin
    && estimatedDifficulty >= 8.0
    && estimatedFairness >= 8.0
    && estimatedReadability >= 7.0);

  return {
    difficulty: round3(difficulty),
    fairness: round3(fairness),
    readability: round3(readability),
    estimatedDifficulty,
    estimatedFairness,
    estimatedReadability,
    targetReady,
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
