// Answer-only reasoning from the same terrain and sightlines as quiz validation.
// Plain JSON evidence is kept alongside English prose for automated consumers.
import { TerrainModel } from './terrainModel.js';
import { DEG, angleDiff, wrap360 } from './grid.js';
import { cellAtExtent } from './gridQuiz.js';
import { solarPosition } from './sunWatch.js';

const round = (value, places = 2) => +value.toFixed(places);
const bearingText = value => `${String(Math.round(wrap360(value)) % 360).padStart(3, '0')}°`;
const signedAngle = (a, b) => wrap360(a - b + 180) - 180;
const sideAt = (offset, fov) => offset < -fov / 6 ? 'left' : offset > fov / 6 ? 'right' : 'centre';
const evidence = (type, text, data) => ({ type, text, data });
const extentOf = q => q.mapExtent || { x: q.terrain.size / 2, y: q.terrain.size / 2, size: q.terrain.size };

function describe(model, camera, columns) {
  const probeVisible = [0, 1, 2].map(() => new Uint8Array(columns));
  const probeDistances = model.skyline.probeIdx.map(k => model.skyline.steps[k]);
  const descriptor = model.skyline.viewDescriptor(camera.x, camera.y, camera.heading, camera.fov, {
    eyeHeight: camera.z - model.getElevation(camera.x, camera.y), columns,
    detail: (x, y, z, distance, column) => {
      for (let p = 0; p < 3; p++) if (distance === probeDistances[p]) probeVisible[p][column] = 1;
    },
  });
  return { ...descriptor, probeVisible };
}

function cameraFor(q, option) {
  if (q.mode === 'friend') return q.friend.observerHidden ? option.observer : q.camera;
  if (q.mode === 'facing') return { ...q.camera, heading: option.heading };
  return { ...q.camera, x: option.x, y: option.y, z: option.z + q.camera.eyeHeight,
    heading: option.heading ?? q.camera.heading };
}

/** A visible, signed difference at the SAME screen position, even when headings differ. */
export function compareExplanationViews(shown, alternative, camera) {
  const count = shown.horizon.length, choices = [];
  const verticalLimit = Math.max(12, camera.fov * .3);
  for (let c = 0; c < count; c++) {
    const offset = shown.fov * c / (count - 1) - shown.fov / 2;
    const common = { screenSide: sideAt(offset, shown.fov), screenOffset: round(offset),
      observedBearing: round(wrap360(shown.heading + offset)),
      alternativeBearing: round(wrap360(alternative.heading + offset)) };
    for (let layer = -1; layer < 3; layer++) {
      const a = layer < 0 ? shown.horizon : shown.near[layer];
      const b = layer < 0 ? alternative.horizon : alternative.near[layer];
      if (Math.abs(a[c] - camera.pitch) > verticalLimit) continue;
      // A distant foreground probe hidden behind nearer ground is not a visible clue.
      if (layer >= 0 && (!shown.probeVisible?.[layer][c] || !alternative.probeVisible?.[layer][c])) continue;
      let observed = 0, predicted = 0, samples = 0;
      const blur = layer < 0 ? 1 : 0;
      for (let d = -blur; d <= blur; d++) if (c + d >= 0 && c + d < count) {
        observed += a[c + d]; predicted += b[c + d]; samples++;
      }
      observed /= samples; predicted /= samples;
      const delta = predicted - observed;
      choices.push({ ...common, feature: layer < 0 ? 'skyline' : 'foreground',
        ...(layer < 0 ? {} : { probeMetres: [40, 120, 350][layer] }),
        observedAngle: round(observed), alternativeAngle: round(predicted), deltaDegrees: round(delta),
        score: Math.abs(delta) * (layer < 0 ? 1 : .35) });
    }
  }
  choices.sort((a, b) => b.score - a.score);
  if (!choices.length || choices[0].score < .05) return null;
  const { score, ...data } = choices[0];
  const feature = data.feature === 'skyline' ? 'skyline' : `ground about ${data.probeMetres} m ahead`;
  const relative = Math.abs(data.deltaDegrees).toFixed(1);
  const direction = data.deltaDegrees > 0 ? 'higher' : 'lower';
  const bearings = angleDiff(data.observedBearing, data.alternativeBearing) > .1
    ? `shown bearing ${bearingText(data.observedBearing)}; candidate bearing ${bearingText(data.alternativeBearing)}`
    : `near ${bearingText(data.observedBearing)}`;
  const height = angle => `${Math.abs(angle).toFixed(1)}° ${angle < 0 ? 'below' : 'above'} the horizontal`;
  return evidence('view-mismatch', `On the ${data.screenSide} of the view (${bearings}), `
    + `this candidate puts the ${feature} about ${relative}° ${direction} than shown `
    + `(shown: ${height(data.observedAngle)}; candidate: ${height(data.alternativeAngle)}).`, data);
}

function sightEvidence(shown, other) {
  const measurements = [
    ['person-size', 'apparent height', shown.angularHeight, other.angularHeight],
    ['person-elevation', 'height above the horizontal', shown.elevation, other.elevation],
    ['person-bearing', 'bearing', shown.bearing, other.bearing],
  ].filter(([, , a, b]) => Number.isFinite(a) && Number.isFinite(b));
  measurements.sort((a, b) => (b[0] === 'person-bearing' ? angleDiff(b[2], b[3]) : Math.abs(b[2] - b[3]))
    - (a[0] === 'person-bearing' ? angleDiff(a[2], a[3]) : Math.abs(a[2] - a[3])));
  if (!measurements.length) return null;
  const [type, name, a, b] = measurements[0];
  if ((type === 'person-bearing' ? angleDiff(a, b) : Math.abs(a - b)) < .05) return null;
  return evidence(type, `The person's ${name} would be ${b.toFixed(2)}°, but the view shows ${a.toFixed(2)}°. `
    + (type === 'person-size' ? 'A 1.80 m person at a different range has a different apparent size.' : 'That changes where the person appears in the image.'),
  { observed: round(a), alternative: round(b), deltaDegrees: round(type === 'person-bearing' ? signedAngle(b, a) : b - a),
    observedRangeMetres: round(shown.distance), alternativeRangeMetres: round(other.distance) });
}

function sunEvidence(q, heading = q.camera.heading) {
  const plan = q.sunWatch, sun = solarPosition(plan.hour24, plan.minute, 0, plan.latitude);
  const turn = signedAngle(sun.azimuth, heading);
  const time = `${String(plan.hour24).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')}`;
  return evidence('sun-orientation', `At ${time} local solar time and latitude ${plan.latitude}°, `
    + `the sun is near ${bearingText(sun.azimuth)}. The ${Math.abs(turn).toFixed(1)}° turn ${turn < 0 ? 'left' : 'right'} `
    + `from the starting view to the sun fixes the starting direction near ${bearingText(heading)}.`,
  { time, latitude: plan.latitude, solarAzimuth: round(sun.azimuth), startingHeading: round(heading), turnDegrees: round(turn) });
}

function correctEvidence(q, model, shown, correct) {
  const result = [];
  if (q.sunWatch) result.push(sunEvidence(q));
  if (q.mode === 'trail') {
    const route = q.grid ? q.trail.routes[0] : correct, run = route.terrainRun;
    if (run) result.push(evidence('route-terrain', `Across the run, the ground changes by about ${Math.round(run.relief)} m `
      + `and follows this terrain sequence: ${run.featureSequence.join(' → ') || 'slope'}. `
      + 'Match the whole moving view, including the slopes and changing skyline, rather than one frame.',
    { reliefMetres: round(run.relief), featureSequence: run.featureSequence, durationSeconds: q.trail.duration }));
    if (q.grid) result.push(evidence('finish-cell', `The complete run ends in ${q.correctLabel}, after ${q.trail.duration} s. `
      + `The travelled cells are ${run?.cells.join(' → ') || q.correctLabel}. An earlier replay position is not the finish.`,
    { label: q.correctLabel, travelledCells: run?.cells || [], durationSeconds: q.trail.duration, target: q.grid.target }));
    return result;
  }
  if (q.mode === 'friend') {
    const target = q.grid ? q.friend.matches.find(o => o.correct) : correct;
    result.push(evidence('person-sighting', `From the original observation point, the visible 1.80 m person is about `
      + `${Math.round(target.distance)} m away near ${bearingText(target.bearing)}, with an apparent height of ${target.angularHeight.toFixed(2)}°. `
      + (q.friend.observerHidden ? 'Other candidate observers also fit the person, so the surrounding terrain must match as well.'
        : 'The bearing, apparent size and surrounding contours must agree together.'),
    { rangeMetres: round(target.distance), bearing: round(target.bearing), apparentHeightDegrees: round(target.angularHeight),
      observerHidden: q.friend.observerHidden }));
    if (q.grid) result.push(evidence('person-cell', `After locating the person, his exact position falls inside ${q.correctLabel}. `
      + 'He need not stand at the cell centre; use the displayed map extent and its grid boundaries.',
    { label: q.correctLabel, target: q.grid.target, extent: extentOf(q), divisions: q.grid.size }));
  }
  if (shown) {
    const visible = Array.from(shown.horizon, (angle, column) => ({ angle, column }))
      .filter(p => Math.abs(p.angle - q.camera.pitch) <= Math.max(12, q.camera.fov * .3));
    visible.sort((a, b) => b.angle - a.angle);
    if (visible.length) {
      const { angle, column } = visible[0], offset = shown.fov * column / (shown.horizon.length - 1) - shown.fov / 2;
      const bearing = wrap360(shown.heading + offset), distance = shown.dist[column];
      result.push(evidence('skyline-match', `On the ${sideAt(offset, shown.fov)} of the view, near ${bearingText(bearing)}, `
        + `the skyline reaches ${Math.abs(angle).toFixed(1)}° ${angle < 0 ? 'below' : 'above'} the horizontal, `
        + `at about ${Math.round(distance)} m. This position and direction reproduce that visible profile.`,
      { screenSide: sideAt(offset, shown.fov), bearing: round(bearing), angleDegrees: round(angle), distanceMetres: round(distance) }));
    }
    const x = q.camera.x, y = q.camera.y, az = q.camera.heading * DEG;
    const px = x + Math.sin(az) * 120, py = y + Math.cos(az) * 120;
    if (model.inside(px, py)) {
      const change = model.getElevation(px, py) - model.getElevation(x, y);
      result.push(evidence('contour-profile', `In the starting direction (${bearingText(q.camera.heading)}), `
        + `the map's ground ${Math.abs(change) < .5 ? 'stays nearly level' : `${change > 0 ? 'rises' : 'falls'} about ${Math.abs(change).toFixed(1)} m`} `
        + 'over the first 120 m. Check this contour pattern together with the skyline.',
      { bearing: round(q.camera.heading), distanceMetres: 120, elevationChangeMetres: round(change) }));
    }
  }
  return result;
}

function alternativeExplanation(q, model, shown, correct, option) {
  const reasons = [], compareHeading = cameraFor(q, option)?.heading;
  let plausibility = '';
  if (q.sunWatch && Number.isFinite(compareHeading) && angleDiff(compareHeading, q.camera.heading) > .1) {
    reasons.push(evidence('heading-mismatch', `This view requires a starting direction of ${bearingText(compareHeading)}, `
      + `${angleDiff(compareHeading, q.camera.heading).toFixed(1)}° away from the direction fixed by the watch and the observed turn to the sun. `
      + 'A similar terrain silhouette does not resolve that orientation mismatch.',
    { observedHeading: round(q.camera.heading), alternativeHeading: round(compareHeading), differenceDegrees: round(angleDiff(compareHeading, q.camera.heading)) }));
  }
  if (q.mode === 'trail') {
    if (option.admissible === false) reasons.push(evidence('invalid-route',
      'The terrain and movement checks did not produce a valid run ending in this cell. It cannot reproduce the recorded run under the same movement rules.',
      { admissible: false }));
    else if (option.cue) {
      const { t, bearing, delta } = option.cue;
      reasons.push(evidence('route-view-mismatch', `At ${t.toFixed(1)} s, near ${bearingText(bearing)}, `
        + `this route puts the skyline about ${Math.abs(delta).toFixed(1)}° ${delta > 0 ? 'higher' : 'lower'} than the recorded run. `
        + 'Replay that moment in the actual run and in this comparison to see the difference.',
      { timeSeconds: round(t), bearing: round(bearing), deltaDegrees: round(delta) }));
    }
    plausibility = 'The same turns and speed are used for every route, so the route shape alone does not settle the answer.';
  } else if (q.mode === 'friend' && !q.friend.observerHidden) {
    const sight = sightEvidence(correct, option);
    if (sight) reasons.push(sight);
    plausibility = q.friend.challenge === 'depth-trap' ? 'These spots share the same bearing; apparent size and terrain depth separate them.'
      : 'All three spots allow a visible person, but his screen position and apparent size differ.';
  } else {
    const camera = cameraFor(q, option);
    if (camera) {
      const clue = compareExplanationViews(shown, describe(model, camera, shown.horizon.length), q.camera);
      if (clue) reasons.push(clue);
    }
    if (q.mode === 'friend') plausibility = 'The range and apparent size are matched from this possible observer. Use the terrain, rather than distance alone.';
    else if (option.landform && option.landform === correct.landform) plausibility = `Both positions are classified as ${option.landform}. The same landform type can still give a different view.`;
    else if (q.mode === 'lookalike') plausibility = 'The candidates were chosen for similar terrain views. Match the position of the details, not just the general outline.';
  }
  if (!reasons.length) reasons.push(evidence('inconclusive',
    'No decisive visible difference was found for this comparison. This explanation does not establish that the alternative is impossible.', {}));
  return { label: option.label, comparisonHeading: Number.isFinite(compareHeading) ? round(compareHeading) : null,
    // Suppress last-bit Math differences between browser/Node without losing useful precision.
    difference: Number.isFinite(option.D) ? round(option.D, 6) : null, plausibility, reasons,
    status: reasons.some(r => r.type !== 'inconclusive') ? 'distinguished' : 'inconclusive' };
}

function friendGridAlternatives(q, model, shown) {
  const matches = q.friend.matches, correct = matches.find(o => o.correct), extent = extentOf(q);
  const byCell = new Map();
  for (const point of matches.filter(o => !o.correct)) {
    const label = cellAtExtent(point.x, point.y, extent, q.grid.size);
    if (label === q.correctLabel) continue;
    const record = alternativeExplanation(q, model, shown, correct, point);
    const existing = byCell.get(label);
    if (!existing || record.difference < existing.difference) byCell.set(label, { ...record, label,
      scope: 'qualified-point', comparisonPoint: { x: point.x, y: point.y },
      plausibility: 'A qualified comparison point lies inside this cell. ' + record.plausibility });
  }
  return q.options.filter(o => !o.correct).map(option => byCell.get(option.label) || {
    label: option.label, difference: null, status: 'located-elsewhere', scope: 'cell-bounds', plausibility: '',
    reasons: [evidence('person-outside-cell', 'The person located by the sighting and terrain evidence falls outside this cell. '
      + 'Cell centres are not assumed to be possible person positions; a person may stand anywhere inside a cell.',
    { target: q.grid.target, extent, divisions: q.grid.size })],
  });
}

export function buildAnswerExplanation(q, model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed })) {
  const correct = q.options.find(o => o.correct);
  const shown = q.mode === 'trail' ? null : describe(model, q.camera, q.mode === 'grid' ? 49 : 33);
  const alternatives = q.mode === 'friend' && q.grid ? friendGridAlternatives(q, model, shown)
    : q.options.filter(o => !o.correct).map(option => alternativeExplanation(q, model, shown, correct, option));
  const ranked = alternatives.filter(o => Number.isFinite(o.difference)).sort((a, b) => a.difference - b.difference || a.label.localeCompare(b.label));
  return { version: 1, language: 'en', source: 'terrain-and-sightline-analysis',
    kind: q.mode === 'trail' ? q.grid ? 'finish-cell' : 'route' : q.mode === 'friend' ? q.grid ? 'person-cell' : 'person-position'
      : q.mode === 'facing' ? 'direction' : q.grid ? 'observer-cell' : 'observer-position',
    correct: { label: q.correctLabel,
      summary: q.mode === 'trail' ? 'The complete terrain sequence matches this run, including its finish.'
        : q.mode === 'friend' ? 'The person sighting and the surrounding terrain agree at this location.'
          : 'This position and direction reproduce the skyline and the contour pattern in the starting view.',
      evidence: correctEvidence(q, model, shown, correct) },
    closestLabels: ranked.slice(0, 3).map(o => o.label), alternatives,
    ...(q.lowConfidence ? { caution: 'Generation confidence was below the target. Treat this answer and its comparisons as uncertain.' } : {}) };
}

export function withAnswerExplanation(quiz, model) {
  return { ...quiz, explanation: buildAnswerExplanation(quiz, model) };
}

/** Show the submitted wrong answer as well as the closest-looking alternatives. */
export function explanationComparisons(quiz, chosenLabel, explanation = quiz.explanation) {
  if (!explanation) return [];
  if (!quiz.grid && quiz.mode !== 'facing') return explanation.alternatives;
  const labels = [...new Set([chosenLabel !== quiz.correctLabel ? chosenLabel : null, ...explanation.closestLabels].filter(Boolean))];
  return labels.map(label => explanation.alternatives.find(o => o.label === label)).filter(Boolean);
}

export function explanationReport(quiz, chosenLabel) {
  return { version: 1, seed: quiz.seed, difficulty: quiz.difficulty, mode: quiz.mode, variant: quiz.variant || 0,
    scramble: quiz.scramble || 0, correctLabel: quiz.correctLabel, chosenLabel,
    explanation: quiz.explanation };
}

export function relabelExplanation(explanation, labels) {
  if (!explanation) return undefined;
  return { ...explanation, correct: { ...explanation.correct, label: labels.get(explanation.correct.label) },
    closestLabels: explanation.closestLabels.map(label => labels.get(label)),
    alternatives: explanation.alternatives.map(o => ({ ...o, label: labels.get(o.label) })) };
}
