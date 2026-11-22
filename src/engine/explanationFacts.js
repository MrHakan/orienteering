// Public, checkable facts behind an answer, and the short template text built only from them.
// Facts hold what a viewer can check on the map or in the view: grid cells, 8-point compass words,
// rounded distances and heights, landform names, which side of the view. No internal measures
// (view distances, apparent sizes in degrees) and no raw coordinates. Pure and deterministic.
import { DEG, angleDiff, wrap360 } from './grid.js';
import { cellAtExtent } from './gridQuiz.js';
import { lineOfSight, landmarkWeight, landmarkRelief, MAX_LANDMARK_DIST } from './viewpoints.js';

export const FACTS_VERSION = 1;
export const COMPASS_WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const SHORT_MAX = 280;
export const compassOf = (deg) => COMPASS_WORDS[Math.round(wrap360(deg) / 45) % 8];
/** Distances are rounded to 10 m below 250 m, 50 m below 1 km, then 0.1 km. */
export function roundDistance(m) {
  return m < 250 ? Math.max(10, Math.round(m / 10) * 10) : m < 1000 ? Math.round(m / 50) * 50 : Math.round(m / 100) * 100;
}
export function distanceText(m) {
  const r = roundDistance(m);
  return r >= 1000 ? `${(r / 1000).toFixed(1)} km` : `${r} m`;
}

const LANDMARK_KINDS = new Set(['summit', 'knoll', 'saddle', 'depression']);
const MIN_RANGE = 80, MIN_SIZE = 0.5, MIN_SEPARATION = 8, TOP_MATCH_DEGREES = 3, TOP_MATCH_METRES = 150, NEAR_TARGET = 150;
// A claim is made only when it is clear: named landmarks are in the frame with ground-free sight to
// their top; "out of the picture" means beyond the frame edge by OUT_MARGIN (horizontally); "hidden"
// means ground hides even a point HIDDEN_LIFT above the top; a side change needs a shift of SIDE_SHIFT.
const FRAME_MARGIN = 2, OUT_MARGIN = 3, HIDDEN_LIFT = 2, SIDE_SHIFT = 10, SHOULDER = 150;
const signed = (a, b) => wrap360(a - b + 180) - 180;
const sideAt = (offset, fov) => offset < -fov / 6 ? 'left' : offset > fov / 6 ? 'right' : 'centre';
const extentOf = (q) => q.mapExtent || { x: q.terrain.size / 2, y: q.terrain.size / 2, size: q.terrain.size };
const cellOf = (q, p) => cellAtExtent(p.x, p.y, extentOf(q), q.grid.size);
const landmarkName = (kind, height) => kind === 'depression' ? 'the depression' : `the ${height} m ${kind}`;
const round1 = (v) => Math.round(v * 10) / 10;
const cellIndex = (label) => [label.charCodeAt(0) - 65, Number(label.slice(1)) - 1];
const adjacentCells = (a, b) => {
  const [ra, ca] = cellIndex(a), [rb, cb] = cellIndex(b);
  return Math.max(Math.abs(ra - rb), Math.abs(ca - cb)) === 1;
};

/**
 * How far ground in front of a target point rises above the line from the camera to it (metres;
 * > 0 blocked). Quarter-cell steps, no slack; the target's own shoulder (the last
 * min(150 m, 30 %) of the line) is not counted.
 */
export function sightBlock(model, cam, x, y, z) {
  const d = Math.hypot(x - cam.x, y - cam.y), steps = Math.ceil(d / (model.cell / 4)), shoulder = Math.min(SHOULDER, d * 0.3);
  let worst = -Infinity;
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (d * (1 - t) < shoulder) break;
    worst = Math.max(worst, model.getElevation(cam.x + (x - cam.x) * t, cam.y + (y - cam.y) * t) - (cam.z + (z - cam.z) * t));
  }
  return worst;
}

/**
 * How a landmark appears from a camera: bearing, screen side, inside the frame (with a margin),
 * clearly outside it (horizontally), and clear sight: the viewpoint line of sight to just above its
 * top and, beyond its own shoulder, no ground at all above the line to the top itself.
 */
export function landmarkView(model, cam, lm) {
  const dx = lm.x - cam.x, dy = lm.y - cam.y, d = Math.hypot(dx, dy);
  const az = wrap360(Math.atan2(dx, dy) / DEG), offset = signed(az, cam.heading);
  const z = model.getElevation(lm.x, lm.y), elevation = Math.atan2(z - cam.z, d) / DEG;
  const inFrame = Math.abs(offset) <= cam.fov / 2 - FRAME_MARGIN && Math.abs(elevation - cam.pitch) <= Math.max(12, cam.fov * 0.3);
  const outOfFrame = Math.abs(offset) >= cam.fov / 2 + OUT_MARGIN;
  const clear = inFrame && lineOfSight(model, cam.x, cam.y, cam.z, lm.x, lm.y, z + 1.5) && sightBlock(model, cam, lm.x, lm.y, z) <= 0;
  return { d, az, z, offset, inFrame, outOfFrame, clear, side: sideAt(offset, cam.fov) };
}

/** Landmarks in the frame with a clear line of sight, most conspicuous (weight × apparent size) first. */
export function visibleLandmarks(model, cam) {
  const out = [];
  for (const lm of model.analyzer.landmarks) {
    const d = Math.hypot(lm.x - cam.x, lm.y - cam.y);
    if (d < MIN_RANGE || d > MAX_LANDMARK_DIST) continue;
    const view = landmarkView(model, cam, lm);
    if (!view.clear) continue;
    const size = Math.atan(landmarkRelief(lm) / d) / DEG;
    out.push({ lm, view, size, score: landmarkWeight(lm) * size });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The highest skyline point in the frame (same column as the skyline-match evidence). */
function skylineTop(q, model, shown) {
  const cam = q.camera, limit = Math.max(12, cam.fov * 0.3), n = shown.horizon.length;
  let best = -1;
  for (let c = 0; c < n; c++) if (Math.abs(shown.horizon[c] - cam.pitch) <= limit && (best < 0 || shown.horizon[c] > shown.horizon[best])) best = c;
  if (best < 0) return null;
  const offset = shown.fov * best / (n - 1) - shown.fov / 2, az = wrap360(shown.heading + offset), d = shown.dist[best];
  if (!Number.isFinite(d)) return null;
  return { az, d, side: sideAt(offset, shown.fov), x: cam.x + Math.sin(az * DEG) * d, y: cam.y + Math.cos(az * DEG) * d };
}

function landmarkFeature(q, { lm, view }, role) {
  const height = Math.round(lm.z);
  return { role, kind: lm.kind, name: landmarkName(lm.kind, height), heightMetres: height, cell: cellOf(q, lm),
    compass: compassOf(view.az), distanceMetres: roundDistance(view.d), distanceText: distanceText(view.d), side: view.side };
}

/** Up to three features: the most conspicuous visible landmarks (distinct cells, ≥ 8° apart) and the skyline top. */
function viewFeatures(q, model, shown) {
  const all = visibleLandmarks(model, q.camera), picked = [];
  for (const c of all) {
    if (c.size < MIN_SIZE) continue;
    const cell = cellOf(q, c.lm);
    if (!cell || picked.some((p) => angleDiff(p.view.az, c.view.az) < MIN_SEPARATION || cellOf(q, p.lm) === cell)) continue;
    picked.push(c);
    if (picked.length === 2) break;
  }
  const top = skylineTop(q, model, shown);
  // Named as a summit only when a verified visible summit/knoll is at that skyline point.
  const match = top && all.find((c) => (c.lm.kind === 'summit' || c.lm.kind === 'knoll')
    && angleDiff(c.view.az, top.az) <= TOP_MATCH_DEGREES && Math.hypot(c.lm.x - top.x, c.lm.y - top.y) <= TOP_MATCH_METRES);
  const items = picked.map((c) => ({ feature: landmarkFeature(q, c, c === match ? 'skyline-top' : 'landmark'), lm: c.lm }));
  if (top && !(match && picked.includes(match))) {
    if (match) items.push({ feature: landmarkFeature(q, match, 'skyline-top'), lm: match.lm });
    else {
      const cell = cellOf(q, top), form = cell ? model.analyzer.classify(top.x, top.y) : null;
      const kind = form === 'ridge' || form === 'spur' ? form : 'high-ground';
      items.push({ lm: null, feature: { role: 'skyline-top', kind, name: kind === 'high-ground' ? 'the high ground' : `the ${kind}`,
        heightMetres: cell ? Math.round(model.getElevation(top.x, top.y)) : null, cell, compass: compassOf(top.az),
        distanceMetres: roundDistance(top.d), distanceText: distanceText(top.d), side: top.side } });
    }
  }
  // Features with a map cell first (stable), at most three.
  return [...items.filter((i) => i.feature.cell), ...items.filter((i) => !i.feature.cell)].slice(0, 3);
}

function observerFacts(model, cam, cell) {
  const az = cam.heading * DEG, px = cam.x + Math.sin(az) * 120, py = cam.y + Math.cos(az) * 120;
  const change = model.inside(px, py) ? model.getElevation(px, py) - model.getElevation(cam.x, cam.y) : null;
  return { cell, facing: compassOf(cam.heading), landform: model.analyzer.classify(cam.x, cam.y),
    ahead: change === null ? null : change >= 3 ? 'rises' : change <= -3 ? 'falls' : 'level' };
}

/**
 * Why a look-alike camera does not give the same view, from the first landmark feature where the
 * difference is clear: out of the picture, hidden, on another side (shift ≥ SIDE_SHIFT), or much
 * nearer / farther. Borderline cases (near the frame edge, partly hidden, small shifts) say nothing.
 */
function landmarkReason(model, items, cam, altCam) {
  for (const [index, { lm, feature }] of items.entries()) {
    if (!lm) continue;
    const seen = landmarkView(model, cam, lm), alt = landmarkView(model, altCam, lm);
    if (alt.outOfFrame) return { type: 'landmark-out-of-frame', feature: index, direction: alt.offset < 0 ? 'left' : 'right' };
    if (!alt.inFrame) continue;
    if (!alt.clear) {
      if (sightBlock(model, altCam, lm.x, lm.y, alt.z + HIDDEN_LIFT) > 0) return { type: 'landmark-hidden', feature: index };
      continue;
    }
    if (alt.side !== seen.side && Math.abs(alt.offset - seen.offset) >= SIDE_SHIFT) return { type: 'landmark-side', feature: index, side: alt.side };
    const ratio = alt.d / seen.d;
    if ((ratio >= 1.5 || ratio <= 0.67) && distanceText(alt.d) !== feature.distanceText) {
      return { type: 'landmark-range', feature: index, distanceMetres: roundDistance(alt.d), distanceText: distanceText(alt.d), looks: ratio > 1 ? 'smaller' : 'larger' };
    }
  }
  return null;
}

/** The existing skyline comparison, when the difference is at least 1°. */
function skylineReason(alternative) {
  const r = alternative?.reasons.find((x) => x.type === 'view-mismatch' && x.data.feature === 'skyline' && Math.abs(x.data.deltaDegrees) >= 1);
  return r ? { type: r.data.deltaDegrees > 0 ? 'skyline-higher' : 'skyline-lower', side: r.data.screenSide } : null;
}

/**
 * Facts for Grid and Friend grid answers. `cameraFor(q, option)` is the comparison camera of an
 * option or friend match; `alternatives` the explanation's comparison records.
 */
export function viewExplanationFacts(q, model, shown, { alternatives, cameraFor }) {
  const items = viewFeatures(q, model, shown), features = items.map((i) => i.feature);
  const facts = { version: FACTS_VERSION, mode: q.mode, answer: { label: q.correctLabel, kind: 'cell' },
    grid: { size: q.grid.size, cellMetres: Math.round(q.grid.cellMetres) }, observer: null, features, lookalike: null };
  if (q.mode === 'grid') {
    facts.observer = observerFacts(model, q.camera, q.correctLabel);
    const option = q.options.find((o) => o.label === q.closestLabel);
    if (option && !option.correct) {
      const reason = landmarkReason(model, items, q.camera, cameraFor(q, option))
        || skylineReason(alternatives.find((a) => a.label === option.label));
      facts.lookalike = { label: option.label, adjacent: adjacentCells(option.label, q.correctLabel), reason };
    }
  } else {
    const f = q.friend, cam = q.camera, d = Math.hypot(f.x - cam.x, f.y - cam.y);
    facts.observer = { ...observerFacts(model, cam, cellOf(q, cam)), marked: !q.friend.observerHidden };
    const near = model.analyzer.landmarks.map((lm) => ({ lm, d: Math.hypot(lm.x - f.x, lm.y - f.y) }))
      .filter((o) => o.d <= NEAR_TARGET).sort((a, b) => a.d - b.d)[0];
    facts.target = { cell: q.correctLabel, compass: compassOf(Math.atan2(f.x - cam.x, f.y - cam.y) / DEG),
      distanceMetres: roundDistance(d), distanceText: distanceText(d), landform: model.analyzer.classify(f.x, f.y),
      near: near ? { kind: near.lm.kind, name: landmarkName(near.lm.kind, Math.round(near.lm.z)), cell: cellOf(q, near.lm) } : null };
    const rival = q.friend.matches.filter((m) => !m.correct).map((m) => ({ m, label: cellOf(q, m) }))
      .filter((o) => o.label && o.label !== q.correctLabel)
      .sort((a, b) => a.m.D - b.m.D || a.label.localeCompare(b.label))[0];
    if (rival) {
      let reason = null, observerCell = null;
      if (q.friend.observerHidden) {
        const altCam = cameraFor(q, rival.m);
        observerCell = cellOf(q, altCam);
        reason = landmarkReason(model, items, cam, altCam) || skylineReason(alternatives.find((a) => a.label === rival.label));
      } else {
        const ratio = rival.m.distance / d;
        if (ratio >= 1.25 || ratio <= 0.8) reason = { type: 'person-range', distanceMetres: roundDistance(rival.m.distance),
          distanceText: distanceText(rival.m.distance), looks: ratio > 1 ? 'smaller' : 'larger' };
      }
      facts.lookalike = { label: rival.label, adjacent: adjacentCells(rival.label, q.correctLabel), observerCell, reason };
    }
  }
  if (q.lowConfidence) facts.caution = true;
  return facts;
}

/** Facts for Resection grid answers: the labelled peaks, their back-bearings and the first trap cell. */
export function resectionFacts(quiz, trapLabel) {
  const { peaks, points, rounding } = quiz.resection, correct = points.find((p) => p.correct), onHill = rounding / 2 + 1;
  const cell = (p) => cellOf(quiz, p);
  const features = peaks.map((p, i) => {
    const kind = correct.lines?.[i]?.hill?.kind === 'knoll' ? 'knoll' : 'summit', height = Math.round(p.z - 2);
    const d = Math.hypot(p.x - correct.x, p.y - correct.y), back = wrap360(p.shown + 180);
    return { role: 'peak', label: p.label, kind, name: `the ${height} m ${kind}`, heightMetres: height, cell: cell(p),
      compass: compassOf(p.bearing), distanceMetres: roundDistance(d), distanceText: distanceText(d),
      bearing: p.shown, backBearing: back, backCompass: compassOf(back) };
  });
  const facts = { version: FACTS_VERSION, mode: 'resection', answer: { label: quiz.correctLabel, kind: 'cell' },
    grid: { size: quiz.grid.size, cellMetres: Math.round(quiz.grid.cellMetres) },
    observer: { cell: quiz.correctLabel, facing: null, landform: correct.landform, ahead: null }, features, lookalike: null };
  const trap = trapLabel && points.find((o) => !o.correct && cell(o) === trapLabel);
  if (trap) {
    const hillName = (hill) => hill.peak >= 0 ? peaks[hill.peak].label : `the ${hill.height} m ${hill.kind === 'knoll' ? 'knoll' : 'hill'}`;
    const mistaken = (trap.lines || []).map((l, i) => ({ l, i })).filter(({ l, i }) => l.error <= onHill && l.hill && l.hill.peak !== i)
      .map(({ l, i }) => ({ peak: peaks[i].label, name: hillName(l.hill), cell: cell(l.hill) }));
    const cues = trap.cues || [], cue = ['distance', 'hidden', 'elevation'].map((t) => cues.find((c) => c.type === t)).find(Boolean);
    let reason = null;
    if (cue) {
      // The cue is about the hill on bearing cue.peak: the true peak (named by its label) or a
      // mistaken hill (named, with its cell, by the mistaken entry of that same bearing).
      const peak = peaks[cue.peak].label, hill = trap.lines[cue.peak].hill, subject = hill.peak === cue.peak ? peak : hillName(hill);
      if (cue.type === 'distance') reason = { type: 'peak-range', peak, subject, distanceMetres: roundDistance(cue.metres),
        distanceText: distanceText(cue.metres), seenText: distanceText(cue.seen), looks: cue.metres > cue.seen ? 'smaller' : 'larger' };
      else if (cue.type === 'hidden') reason = { type: 'peak-hidden', peak, subject };
      else {
        const from = cue.degrees < 0 ? 'below' : 'above', seen = cue.seen < 0 ? 'below' : 'above';
        // Same side of eye level (the cue fired on a ≥ 4° difference): say higher / lower instead.
        reason = { type: 'peak-eye-level', peak, subject, from, seen, ...(from === seen ? { relative: cue.degrees > cue.seen ? 'higher' : 'lower' } : {}) };
      }
    } else if (trap.lines) {
      const miss = trap.lines.findIndex((l) => l.error > onHill);
      if (miss >= 0) reason = { type: 'bearing-meets-no-hill', peak: peaks[miss].label };
    } else if (trap.errors?.length) {
      const worst = trap.errors.indexOf(Math.max(...trap.errors));
      if (Math.round(trap.errors[worst]) >= 1) reason = { type: 'bearing-off', peak: peaks[worst].label, degrees: Math.round(trap.errors[worst]) };
    }
    facts.lookalike = { label: trapLabel, adjacent: adjacentCells(trapLabel, quiz.correctLabel), mistaken, reason };
  }
  return facts;
}

/** Facts for Intervisibility: the flag in sight and the hidden flag that comes closest to showing. */
export function visibilityFacts(quiz) {
  const correct = quiz.options.find((o) => o.correct);
  const near = quiz.options.filter((o) => !o.correct).sort((a, b) => a.minHeight - b.minHeight || a.label.localeCompare(b.label))[0];
  return { version: FACTS_VERSION, mode: 'visibility', answer: { label: correct.label, kind: 'option' }, grid: null, observer: null, features: [],
    target: { label: correct.label, compass: compassOf(correct.bearing), distanceMetres: roundDistance(correct.distance),
      distanceText: distanceText(correct.distance), flagMetres: 2, hiddenLowestMetres: Math.max(0, round1(correct.minHeight)) },
    lookalike: near ? { label: near.label, adjacent: false, reason: { type: 'flag-hidden', blockDistanceMetres: roundDistance(near.blockDistance),
      blockDistanceText: distanceText(near.blockDistance), neededMetres: round1(near.minHeight) } } : null };
}

/** Facts with option letters remapped (scrambling). Grid cells never change. */
export function relabelFacts(facts, labels) {
  if (facts.answer.kind !== 'option') return facts;
  const map = (label) => labels.get(label) ?? label;
  return { ...facts, answer: { ...facts.answer, label: map(facts.answer.label) },
    ...(facts.target?.label ? { target: { ...facts.target, label: map(facts.target.label) } } : {}),
    lookalike: facts.lookalike && { ...facts.lookalike, label: map(facts.lookalike.label) } };
}

// ------------------------------------------------------------------ template text

const SIDE = { left: 'on the left', right: 'on the right', centre: 'in the centre' };
const FORM = { valley: 'in a valley', reentrant: 'in a re-entrant', depression: 'in a depression', slope: 'on a slope', flat: 'on flat ground',
  ridge: 'on a ridge', spur: 'on a spur', summit: 'on a summit', knoll: 'on a knoll', saddle: 'on a saddle' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const bearing3 = (deg) => `${String(deg).padStart(3, '0')}°`;
const isLandmark = (f) => LANDMARK_KINDS.has(f.kind);
const join = (list) => list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
/** Parts the caption may leave out, least useful first: the ground ahead, side details, the second feature, the look-alike. */
const OMIT_ORDER = [['ahead'], ['ahead', 'detail'], ['ahead', 'detail', 'feature2'], ['ahead', 'detail', 'feature2', 'lookalike']];

/** "the 192 m summit on the right of the view, the top of the skyline, is in E4, about 950 m to your south-west" */
function featureWhere(f, omit) {
  const side = `${SIDE[f.side]}${omit.has('detail') ? '' : ' of the view'}`, about = omit.has('detail') ? '' : 'about ';
  return isLandmark(f)
    ? `${f.name} ${side}${f.role === 'skyline-top' ? ', the top of the skyline,' : ''} is in ${f.cell}, ${about}${f.distanceText} to your ${f.compass}`
    : `the top of the skyline, ${side}, is ${f.name} in ${f.cell}, ${about}${f.distanceText} to your ${f.compass}`;
}
function findStep(f, omit) {
  const side = `${SIDE[f.side]}${omit.has('detail') ? '' : ' of the view'}`, about = omit.has('detail') ? '' : 'about ';
  return isLandmark(f)
    ? `Find ${f.name} ${side}${f.role === 'skyline-top' ? ', the top of the skyline' : ''}: it is in ${f.cell}, ${about}${f.distanceText} to your ${f.compass}.`
    : `Find the top of the skyline ${side}: it is ${f.name} in ${f.cell}, ${about}${f.distanceText} to your ${f.compass}.`;
}
function featureAlso(f) {
  return isLandmark(f) ? `${cap(f.name)} in ${f.cell} is ${SIDE[f.side]}, ${f.distanceText} away.`
    : `The top of the skyline, ${f.name} in ${f.cell}, is ${SIDE[f.side]}, ${f.distanceText} away.`;
}

/** "the 197 m summit would be out of the picture, off to the right" */
function viewReason(r, features, omit) {
  const f = features[r.feature];
  if (r.type.startsWith('landmark-') && !f) return null;
  switch (r.type) {
    case 'landmark-out-of-frame': return `${f.name} would be out of the picture${omit.has('detail') ? '' : `, off to the ${r.direction}`}`;
    case 'landmark-hidden': return `${f.name} would be hidden behind nearer ground`;
    case 'landmark-side': return `${f.name} would sit ${SIDE[r.side]}, not ${SIDE[f.side]}`;
    case 'landmark-range': return `${f.name} would be ${r.distanceText} away, not ${f.distanceText}${omit.has('detail') ? '' : `, and look much ${r.looks}`}`;
    case 'skyline-higher': return `the skyline ${SIDE[r.side]} would sit higher`;
    case 'skyline-lower': return `the skyline ${SIDE[r.side]} would sit lower`;
    default: return null;
  }
}

/** Why the trap cell fails, about `subject` ("that hill" for the mistaken hill already named, or a peak label). */
function resectionReason(r, subject, compact) {
  switch (r.type) {
    case 'peak-range': return compact ? `${subject} would be ${r.distanceText} away, not ${r.seenText}`
      : `${subject} would be ${r.distanceText} away, but ${r.peak} in the view is ${r.seenText} away`;
    case 'peak-hidden': return compact ? `${subject} would be hidden` : `${subject} would be hidden behind higher ground, yet ${r.peak} is in view`;
    case 'peak-eye-level':
      if (r.relative) return `${subject} would sit much ${r.relative} than ${subject === r.peak ? '' : `${r.peak} `}in the view`;
      return compact ? `you would look ${r.from === 'below' ? 'down' : 'up'} at ${subject}, not ${r.seen === 'below' ? 'down' : 'up'}`
        : `you would look ${r.from === 'below' ? 'down' : 'up'} at ${subject}, but ${r.peak} in the view is ${r.seen} eye level`;
    case 'bearing-meets-no-hill': return `the ${r.peak} bearing meets no hill`;
    case 'bearing-off': return `${r.peak} would be ${r.degrees}° off its bearing`;
    default: return null;
  }
}

function gridSteps(facts, omit) {
  const { answer: { label }, observer: o, caution, lookalike: l } = facts, cells = facts.features.filter((f) => f.cell);
  const a = cells[0], b = omit.has('feature2') ? null : cells[1], steps = [];
  if (a) steps.push(findStep(a, omit));
  else steps.push(`Match the skyline and the ground ahead: you face ${o.facing}, standing ${FORM[o.landform] || 'on open ground'}.`);
  if (b) steps.push(featureAlso(b));
  let pin = !a ? `Facing ${o.facing}, this view fits ${caution ? `${label} best` : `${label} and no other cell`}.`
    : b ? caution ? `Both line up best from ${label}, facing ${o.facing}.` : `Both line up like this only from ${label}, facing ${o.facing}.`
      : caution ? `It sits there best from ${label}, facing ${o.facing}.` : `It sits there only when you stand in ${label}, facing ${o.facing}.`;
  if (!omit.has('ahead') && (o.ahead === 'rises' || o.ahead === 'falls')) pin += ` The ground ahead ${o.ahead}, as the contours show.`;
  else if (!omit.has('ahead') && !a && o.ahead === 'level') pin += ' The ground ahead stays nearly level, as the contours show.';
  steps.push(pin);
  const reason = !omit.has('lookalike') && l?.reason && viewReason(l.reason, facts.features, omit);
  if (reason) steps.push(`Not ${l.label}: from there ${reason}.`);
  return steps;
}

function friendSteps(facts, omit) {
  const { answer: { label }, observer: o, target: t, caution, lookalike: l } = facts, cells = facts.features.filter((f) => f.cell);
  const a = cells[0], b = omit.has('feature2') ? null : cells[1], steps = [];
  const ahead = !omit.has('ahead') && (o.ahead === 'rises' || o.ahead === 'falls') ? `, and the ground ahead ${o.ahead}` : '';
  steps.push((o.marked ? `YOU are marked on the map in ${o.cell}, facing ${o.facing}${ahead}.`
    : a ? `First find YOU: ${featureWhere(a, omit)}, so you are in ${o.cell}, facing ${o.facing}.`
      : `First find YOU from the ground around you: you stand ${FORM[o.landform] || 'on open ground'} in ${o.cell}, facing ${o.facing}${ahead}.`)
    + (b && !o.marked ? ` ${featureAlso(b)}` : ''));
  steps.push(`Your friend is about ${t.distanceText} ${t.compass} of you, ${FORM[t.landform] || 'in the open'}`
    + `${t.near ? ` near ${t.near.name}` : ''}: ${caution ? `that fits ${label} best` : label}.`);
  if (!omit.has('lookalike') && l?.reason) {
    const reason = l.reason.type === 'person-range' ? null : viewReason(l.reason, facts.features, omit);
    if (l.reason.type === 'person-range') steps.push(`Not ${l.label}: he would be ${l.reason.distanceText} away and look much ${l.reason.looks}.`);
    else if (reason && l.observerCell) steps.push(`Not ${l.label}: YOU would then be in ${l.observerCell}${l.observerCell === l.label ? ' too' : ''}, and from there ${reason}.`);
  }
  return steps;
}

/**
 * "Not C2: it needs the 132 m knoll in B3 to be P1; from there P2 would be 200 m away, …". The
 * reason is about the hill on one bearing: that bearing's mistaken hill ("that hill", introduced
 * with its cell) or, when the bearing still meets its true peak, the peak label.
 */
function resectionLookalike(l, omit) {
  const r = l.reason, compact = omit.has('compact');
  const own = r?.subject !== undefined && r.subject !== r.peak ? l.mistaken?.find((m) => m.peak === r.peak) : null;
  const m = own || l.mistaken?.[0];
  const about = !r ? null : r.subject === undefined || r.subject === r.peak ? r.subject ?? r.peak : own ? 'that hill' : null;
  const reason = r && about !== null ? resectionReason(r, about, compact) : null;
  if (m && reason) return compact ? `that takes ${m.name} in ${m.cell} for ${m.peak}, and ${reason}` : `it needs ${m.name} in ${m.cell} to be ${m.peak}; from there ${reason}`;
  if (m) return `it only works if you take ${m.name} in ${m.cell} for ${m.peak}`;
  return reason ? `from there ${reason}` : null;
}

function resectionSteps(facts, omit) {
  const { answer: { label }, features: peaks, lookalike: l } = facts, steps = [];
  steps.push(`${peaks[0].label} is ${peaks[0].name} in ${peaks[0].cell}`
    + `${peaks.length > 1 ? `, ${join(peaks.slice(1).map((p) => `${p.label} ${p.name} in ${p.cell}`))}` : ''}.`);
  steps.push(`Draw the back-bearings: ${join(peaks.map((p) => `${bearing3(p.backBearing)} (${p.backCompass}) from ${p.label}`))}.`);
  steps.push(`They cross in ${label}.`);
  const text = l && !omit.has('lookalike') ? resectionLookalike(l, omit) : null;
  if (text) steps.push(`Not ${l.label}: ${text}.`);
  return steps;
}

function visibilitySteps(facts, omit) {
  const { answer: { label }, target: t, lookalike: l } = facts, steps = [];
  steps.push(`${label} is the only flag in sight from YOU: it stands about ${t.distanceText} to your ${t.compass}.`);
  steps.push(t.hiddenLowestMetres > 0
    ? `The ground hides only its lowest ${t.hiddenLowestMetres.toFixed(1)} m, so the top of the ${t.flagMetres} m flag still shows.`
    : 'Nothing rises above the line from your eye to its foot, so the whole flag shows.');
  if (l?.reason && !omit.has('lookalike')) steps.push(`Not ${l.label}: ground about ${l.reason.blockDistanceText} out on that line hides it; `
    + `it would need to be ${l.reason.neededMetres.toFixed(1)} m tall to show.`);
  return steps;
}

const STEPS = { grid: gridSteps, friend: friendSteps, resection: resectionSteps, visibility: visibilitySteps };

/**
 * Template text from facts only. steps: 2–4 short steps for the site (feature → where it is on the
 * map → how it pins the answer → why not the closest look-alike); short: the same reasoning in
 * ≤ 280 characters for a caption, leaving out the ground ahead, then the second feature, then the
 * look-alike while it is too long.
 */
export function renderExplanation(facts) {
  const build = STEPS[facts?.mode];
  if (!build) return null;
  const steps = build(facts, new Set());
  let short = steps.join(' '), last = steps;
  for (const omit of OMIT_ORDER) {
    if (short.length <= SHORT_MAX) break;
    last = build(facts, new Set(omit));
    short = last.join(' ');
  }
  // Last resort (very long names): shorten the first step and keep the steps that reach the answer.
  const cut = (text, max) => `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  if (short.length > SHORT_MAX) {
    const tail = last.slice(1).join(' ');
    short = tail && tail.length < SHORT_MAX - 20 ? `${cut(last[0], SHORT_MAX - tail.length - 1)} ${tail}` : cut(short, SHORT_MAX);
  }
  return { steps, short };
}
