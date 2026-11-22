import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { buildAnswerExplanation } from '../src/engine/answerExplanation.js';
import { cellAtExtent, parseCell } from '../src/engine/gridQuiz.js';
import { scrambleLabels } from '../src/engine/scramble.js';
import { modeResultHTML } from '../src/render/mapModesView.js';
import { COMPASS_WORDS, SHORT_MAX, renderExplanation, resectionFacts, roundDistance, distanceText } from '../src/engine/explanationFacts.js';
import { surfaceElevation } from '../src/engine/terrainSurface.js';

const MODES = {
  grid: { mode: 'grid', gridSize: 8 },
  resection: { mode: 'resection', resectionAnswer: 'grid', gridSize: 8 },
  friend: { mode: 'friend', friendAnswer: 'grid', gridSize: 8 },
  visibility: { mode: 'visibility' },
};
const SEEDS = Array.from({ length: 12 }, (_, i) => `ef-${i + 1}`);
const quizzes = {};
for (const [id, opts] of Object.entries(MODES)) {
  quizzes[id] = [];
  for (const seed of SEEDS) {
    try { quizzes[id].push(await generate({ seed, difficulty: 'master', ...opts })); } catch { /* counted below */ }
  }
}
// Seeds that carry the rarer look-alike reasons (hidden, range, skyline, same-side eye level, a hill
// mistaken for P2, two hills of the same height) and a friend next to a landmark, so every claim is re-checked below.
const EXTRA = [['grid', 'classic', 'rv-2'], ['grid', 'classic', 'rv-13'], ['grid', 'classic', 'rv-1'], ['friend', 'classic', 'rv-10'], ['friend', 'karst', 'rv-2'], ['friend', 'classic', 'rv-2'],
  ['resection', 'karst', 'rv-6'], ['resection', 'alpine', 'rv-1'], ['resection', 'dunes', 'rv-3'], ['resection', 'classic', 'rv-4']];
for (const [id, world, seed] of EXTRA) quizzes[id].push(await generate({ seed, world, difficulty: 'master', ...MODES[id] }));
const all = () => Object.values(quizzes).flat();

// Independent helpers (deliberately not the engine's own code).
const DEG = Math.PI / 180;
/** The published rounding: 10 m steps below 250 m, 50 m below 1 km, then 0.1 km (pinned by a table below). */
const roundM = (m) => m < 250 ? Math.max(10, Math.round(m / 10) * 10) : m < 1000 ? Math.round(m / 50) * 50 : Math.round(m / 100) * 100;
const textM = (m) => roundM(m) >= 1000 ? `${(roundM(m) / 1000).toFixed(1)} km` : `${roundM(m)} m`;
const offsetOf = (cam, p) => ((bearing(cam, p) - cam.heading + 540) % 360) - 180;
/** Worst height (m) of ground above the line from `cam` to (x, y, z), fifth-cell steps, the last min(150 m, 30 %) not counted. */
function groundAbove(model, cam, x, y, z) {
  const d = Math.hypot(x - cam.x, y - cam.y), steps = Math.ceil(d / (model.cell / 5)), skip = Math.min(150, d * 0.3);
  let worst = -Infinity;
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (d * (1 - t) < skip) break;
    worst = Math.max(worst, model.getElevation(cam.x + (x - cam.x) * t, cam.y + (y - cam.y) * t) - (cam.z + (z - cam.z) * t));
  }
  return worst;
}
/** Highest skyline point across the frame by an own ray march: { angle, offset }. */
function ownSkylineTop(model, cam) {
  let best = null;
  for (let off = -cam.fov / 2; off <= cam.fov / 2 + 1e-9; off += 0.5) {
    const az = (cam.heading + off) * DEG;
    let top = -90;
    for (let d = 30; d <= 5000; d += model.cell / 2) {
      const x = cam.x + Math.sin(az) * d, y = cam.y + Math.cos(az) * d;
      if (!model.inside(x, y)) break;
      top = Math.max(top, Math.atan2(model.getElevation(x, y) - cam.z, d) / DEG);
    }
    if (!best || top > best.angle) best = { angle: top, offset: off };
  }
  return best;
}
const reliefOf = (lm) => lm.kind === 'summit' || lm.kind === 'knoll' ? lm.prominence : lm.kind === 'saddle' ? 12 : lm.depth;
const bearing = (a, b) => ((Math.atan2(b.x - a.x, b.y - a.y) / DEG) % 360 + 360) % 360;
const compass = (deg) => COMPASS_WORDS[Math.round(deg / 45) % 8];
const extentOf = (q) => q.mapExtent || { x: q.terrain.size / 2, y: q.terrain.size / 2, size: q.terrain.size };
const cellOf = (q, p) => cellAtExtent(p.x, p.y, extentOf(q), q.grid.size);
const modelOf = (q) => new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
function clearSight(model, a, b) { // every cell length, 1 m slack
  const d = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.ceil(d / model.cell);
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (model.getElevation(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) > a.z + (b.z - a.z) * t + 1) return false;
  }
  return true;
}

/** Every cell, compass word and number in `text` must come from the facts (the runtime validator's rule). */
function unsupportedTokens(text, facts) {
  const strings = [], numbers = new Set(), errors = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (typeof v === 'number') numbers.add(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(facts);
  for (const s of strings) for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) numbers.add(+m[0]);
  const size = facts.grid?.size, cells = new Set(strings.filter((s) => /^[A-P]\d{1,2}$/.test(s)));
  const cellRe = size ? new RegExp(`\\b[A-${String.fromCharCode(64 + size)}](?:${Array.from({ length: size }, (_, i) => size - i).join('|')})\\b`, 'g') : null;
  if (cellRe) for (const [cell] of text.matchAll(cellRe)) if (!cells.has(cell)) errors.push(`cell ${cell}`);
  for (const m of text.matchAll(/\b(north|south)(?:[- ]?(east|west))?\b|\b(east|west)\b/gi)) {
    const word = m[3] ? m[3].toLowerCase() : m[2] ? `${m[1]}-${m[2]}`.toLowerCase() : m[1].toLowerCase();
    if (!strings.includes(word)) errors.push(`compass ${word}`);
  }
  const plain = (cellRe ? text.replace(cellRe, ' ') : text).replace(/\bP\d\b/g, ' ');
  for (const [n] of plain.matchAll(/\d+(?:\.\d+)?/g)) if (!numbers.has(+n)) errors.push(`number ${n}`);
  return errors;
}

test('facts: generated for every master quiz of the four modes, answer and public values only (A2, A3)', () => {
  for (const [id, list] of Object.entries(quizzes)) assert.ok(list.length >= 10, `${id}: ${list.length}/12 generated`);
  for (const q of all()) {
    const f = q.explanation.facts, tag = `${q.mode} ${q.seed}`;
    assert.equal(f.version, 1, tag);
    assert.equal(f.answer.label, q.correctLabel, tag);
    assert.equal(f.answer.kind, q.grid ? 'cell' : 'option', tag);
    const json = JSON.stringify(f);
    assert.doesNotMatch(json, /apparent|angularHeight|"D":|\d\.\d\d°/, tag);
    assert.deepEqual(f, JSON.parse(json), `${tag}: plain JSON`);
    const cells = [...json.matchAll(/"(?:cell|observerCell)":"([^"]+)"/g)].map((m) => m[1]);
    if (q.grid) cells.push(f.answer.label, ...(f.lookalike ? [f.lookalike.label] : []));
    for (const cell of cells) assert.equal(parseCell(cell, q.grid.size), cell, `${tag}: ${cell}`);
    for (const [, word] of json.matchAll(/"(?:compass|facing|backCompass)":"([^"]+)"/g)) assert.ok(COMPASS_WORDS.includes(word), `${tag}: ${word}`);
    for (const ft of f.features) assert.equal(ft.distanceText, ft.distanceMetres >= 1000 ? `${(ft.distanceMetres / 1000).toFixed(1)} km` : `${ft.distanceMetres} m`, tag);
    const technical = [q.explanation.correct.summary, ...q.explanation.correct.evidence.map((x) => x.text)].join(' ');
    assert.doesNotMatch(technical, /also fit|apparent height of|terrain agree/, `${tag}: ${technical}`);
  }
  const rate = (list, ok) => list.filter(ok).length / list.length;
  assert.ok(rate(quizzes.grid, (q) => q.explanation.facts.features.some((f) => f.cell)) >= 0.9, 'grid: a feature with a cell');
  assert.ok(rate(quizzes.grid, (q) => q.explanation.facts.lookalike?.reason) >= 0.9, 'grid: a look-alike reason');
  assert.equal(rate(quizzes.friend, (q) => q.explanation.facts.observer?.cell && q.explanation.facts.target?.cell), 1, 'friend: YOU and target');
  assert.ok(rate(quizzes.friend, (q) => q.explanation.facts.features.some((f) => f.cell)) >= 0.8, 'friend: a feature with a cell');
});

test('facts: grid and friend landmarks are real, in the frame and in sight, re-checked independently', () => {
  let checked = 0;
  for (const q of [...quizzes.grid, ...quizzes.friend]) {
    const model = modelOf(q), cam = q.camera, f = q.explanation.facts;
    if (q.mode === 'grid') assert.equal(f.observer.cell, q.correctLabel);
    else assert.deepEqual([f.observer.cell, f.observer.marked], [cellOf(q, cam), false]);
    assert.equal(f.observer.facing, compass(cam.heading));
    for (const ft of f.features.filter((x) => ['summit', 'knoll', 'saddle', 'depression'].includes(x.kind))) {
      const lm = model.analyzer.landmarks.find((l) => l.kind === ft.kind && Math.round(l.z) === ft.heightMetres && cellOf(q, l) === ft.cell);
      assert.ok(lm, `${q.seed}: ${ft.name} in ${ft.cell} exists`);
      const az = bearing(cam, lm), off = ((az - cam.heading + 540) % 360) - 180, d = Math.hypot(lm.x - cam.x, lm.y - cam.y);
      assert.ok(Math.abs(off) <= cam.fov / 2 - 2, `${q.seed}: ${ft.name} in the frame, 2° from its edge`);
      assert.ok(clearSight(model, cam, { x: lm.x, y: lm.y, z: model.getElevation(lm.x, lm.y) + 1.5 }), `${q.seed}: ${ft.name} in sight`);
      assert.ok(groundAbove(model, cam, lm.x, lm.y, model.getElevation(lm.x, lm.y)) <= 0, `${q.seed}: no ground in front hides the top of ${ft.name}`);
      assert.ok(d >= 80 && d <= 1700, `${q.seed}: ${ft.name} at ${d} m`);
      assert.ok(Math.atan(reliefOf(lm) / d) / DEG >= 0.5, `${q.seed}: ${ft.name} at least 0.5° tall`);
      assert.equal(ft.compass, compass(az)); assert.equal(ft.distanceMetres, roundM(d)); assert.equal(ft.distanceText, textM(d));
      assert.equal(ft.side, off < -cam.fov / 6 ? 'left' : off > cam.fov / 6 ? 'right' : 'centre');
      checked++;
    }
    if (q.mode === 'friend') {
      const t = f.target, d = Math.hypot(q.friend.x - cam.x, q.friend.y - cam.y);
      assert.equal(t.cell, q.correctLabel);
      assert.ok(Math.abs(t.distanceMetres - d) <= 5, `${q.seed}: ${t.distanceMetres} vs ${d}`);
      assert.equal(t.compass, compass(bearing(cam, q.friend)));
      assert.equal(t.landform, model.analyzer.classify(q.friend.x, q.friend.y));
    }
  }
  assert.ok(checked >= 20, `${checked} landmark features checked`);
});

test('facts: resection peaks, back-bearings and the trap cell match the bearing geometry', () => {
  for (const q of quizzes.resection) {
    const f = q.explanation.facts, o = q.resection.points.find((p) => p.correct);
    assert.equal(f.observer.cell, q.correctLabel);
    assert.equal(cellOf(q, o), q.correctLabel);
    q.resection.peaks.forEach((p, i) => {
      const ft = f.features[i];
      assert.deepEqual([ft.label, ft.cell, ft.heightMetres, ft.bearing], [p.label, cellOf(q, p), Math.round(p.z - 2), p.shown]);
      assert.equal(ft.backBearing, (p.shown + 180) % 360);
      assert.equal(ft.backCompass, compass((p.shown + 180) % 360));
      assert.equal(ft.compass, compass(bearing(o, p)));
      assert.equal(ft.distanceMetres, roundM(Math.hypot(p.x - o.x, p.y - o.y)));
    });
    const l = f.lookalike;
    assert.ok(l, q.seed);
    assert.notEqual(l.label, q.correctLabel);
    const alt = q.explanation.alternatives.find((a) => a.label === l.label);
    assert.equal(alt.scope, 'trap-point');
    assert.ok(q.resection.points.some((p) => !p.correct && cellOf(q, p) === l.label));
    for (const m of l.mistaken) assert.ok(q.resection.points.some((p) => p.lines?.some((x) => x.hill && cellOf(q, x.hill) === m.cell)), `${q.seed}: ${m.name}`);
    if (l.reason) assert.ok(['peak-range', 'peak-hidden', 'peak-eye-level', 'bearing-meets-no-hill', 'bearing-off'].includes(l.reason.type));
    assert.deepEqual(resectionFacts(q, l.label), f, 'pure');
  }
});

test('facts: look-alikes are wrong cells with a reason from the defined set, landmark reasons re-checked', () => {
  const VIEW = ['landmark-out-of-frame', 'landmark-hidden', 'landmark-side', 'landmark-range', 'skyline-higher', 'skyline-lower', 'person-range'];
  for (const q of [...quizzes.grid, ...quizzes.friend]) {
    const f = q.explanation.facts, l = f.lookalike;
    if (!l) continue;
    assert.notEqual(l.label, q.correctLabel);
    if (q.mode === 'grid') assert.equal(l.label, q.closestLabel);
    if (!l.reason) continue;
    assert.ok(VIEW.includes(l.reason.type), l.reason.type);
    if (!l.reason.type.startsWith('landmark-')) continue;
    const model = modelOf(q), ft = f.features[l.reason.feature];
    const lm = model.analyzer.landmarks.find((x) => x.kind === ft.kind && Math.round(x.z) === ft.heightMetres && cellOf(q, x) === ft.cell);
    const alt = q.mode === 'grid' ? (() => { const o = q.options.find((x) => x.label === l.label);
      return { ...q.camera, x: o.x, y: o.y, z: model.getElevation(o.x, o.y) + q.camera.eyeHeight, heading: o.heading }; })()
      : q.friend.matches.filter((m) => !m.correct && cellOf(q, m) === l.label).sort((a, b) => a.D - b.D)[0].observer;
    if (q.mode === 'friend') assert.equal(l.observerCell, cellOf(q, alt));
    const off = ((bearing(alt, lm) - alt.heading + 540) % 360) - 180;
    if (l.reason.type === 'landmark-out-of-frame') assert.ok(Math.abs(off) > alt.fov / 2 - 2.5, `${q.seed}: ${off}`);
    if (l.reason.type === 'landmark-side') assert.equal(l.reason.side, off < -alt.fov / 6 ? 'left' : off > alt.fov / 6 ? 'right' : 'centre');
    if (l.reason.type === 'landmark-range') assert.equal(l.reason.distanceMetres, roundM(Math.hypot(lm.x - alt.x, lm.y - alt.y)));
  }
});

test('facts are pure: same quiz and model give the same facts; map rotation and terrain do not change them (A4)', () => {
  for (const q of [quizzes.grid[0], quizzes.friend[0], quizzes.friend[1]]) {
    const model = modelOf(q), before = q.terrain.heights.slice();
    assert.deepEqual(buildAnswerExplanation(q, model), q.explanation, `${q.mode} ${q.seed}: rebuilt model`);
    assert.deepEqual(buildAnswerExplanation({ ...q, mapRotation: (q.mapRotation + 90) % 360 }, model).facts, q.explanation.facts);
    assert.deepEqual(q.terrain.heights, before);
  }
});

test('template: 2–4 steps, short ≤ 280 with the answer, no garbage or internals, every token from the facts (B1, B2)', () => {
  let lookalikes = 0;
  for (const q of all()) {
    const e = q.explanation, tag = `${q.mode} ${q.seed}`;
    assert.ok(e.steps.length >= 2 && e.steps.length <= 4, `${tag}: ${e.steps.length} steps`);
    assert.ok(e.short.length <= SHORT_MAX, `${tag}: ${e.short.length}`);
    assert.match(e.short, new RegExp(`\\b${q.correctLabel}\\b`), tag);
    for (const text of [e.short, ...e.steps]) {
      assert.doesNotMatch(text, /\b(?:undefined|NaN|null|Infinity)\b|\[object /, tag);
      assert.doesNotMatch(text, /terrain agree|also fit|apparent height|\d\.\d\d°/, tag);
      assert.deepEqual(unsupportedTokens(text, e.facts), [], `${tag}: ${text}`);
    }
    if (/\bNot [A-H]\d?:/.test(e.short)) lookalikes++;
    assert.deepEqual(renderExplanation(e.facts), { steps: e.steps, short: e.short }, `${tag}: pure`);
  }
  assert.ok(lookalikes >= all().length / 2, `${lookalikes}/${all().length} captions name the closest look-alike`);
});

test('template: the token check rejects invented cells, directions and numbers', () => {
  const facts = quizzes.grid[0].explanation.facts;
  const other = ['A1', 'H8', 'D4', 'E5'].find((c) => !JSON.stringify(facts).includes(`"${c}"`));
  assert.deepEqual(unsupportedTokens(`It is ${other}.`, facts), [`cell ${other}`]);
  const wrongWay = COMPASS_WORDS.find((w) => !JSON.stringify(facts).includes(`"${w}"`));
  assert.deepEqual(unsupportedTokens(`Look ${wrongWay}.`, facts), [`compass ${wrongWay}`]);
  assert.deepEqual(unsupportedTokens('About 1234 m away.', facts), ['number 1234']);
});

test('template: scrambled intervisibility letters re-render the steps with the new letters (B3)', () => {
  const q = quizzes.visibility[0];
  for (const steps of [1, 2]) {
    const s = scrambleLabels(q, steps), e = s.explanation;
    assert.equal(e.facts.answer.label, s.correctLabel);
    assert.ok(e.short.startsWith(`${s.correctLabel} is the only flag`), e.short);
    const near = q.options.find((o) => o.label === q.explanation.facts.lookalike.label);
    const moved = s.options.find((o) => o.x === near.x && o.y === near.y);
    assert.equal(e.facts.lookalike.label, moved.label);
    assert.match(e.steps[2], new RegExp(`^Not ${moved.label}:`));
    assert.deepEqual(renderExplanation(e.facts), { steps: e.steps, short: e.short });
  }
});

test('map-mode result panel lists the reasoning steps first (Resection grid, Intervisibility)', () => {
  for (const q of [quizzes.resection[0], quizzes.visibility[0]]) {
    const html = modeResultHTML(q, q.correctLabel, true);
    const list = html.match(/<ol class="answer-steps">(.*?)<\/ol>/)[1];
    assert.deepEqual([...list.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]), q.explanation.steps);
    assert.ok(html.indexOf('answer-steps') < html.indexOf(q.explanation.correct.summary));
  }
});

test('facts: a flagged (low-confidence) friend grid is marked as caution and never says "only"', async () => {
  const q = await generate({ seed: 'w2-11', world: 'dunes', mode: 'friend', difficulty: 'master', friendAnswer: 'grid', gridSize: 8 });
  assert.equal(q.lowConfidence, true);
  assert.equal(q.explanation.facts.caution, true);
  assert.match(q.explanation.short, /best/);
});

// ------------------------------------------------------------ hand-built facts: one sentence per reason

const feature = (over) => ({ role: 'landmark', kind: 'summit', name: 'the 192 m summit', heightMetres: 192, cell: 'E4', compass: 'south-west',
  distanceMetres: 950, distanceText: '950 m', side: 'right', ...over });
const gridFacts = (over = {}) => ({ version: 1, mode: 'grid', answer: { label: 'B7', kind: 'cell' }, grid: { size: 8, cellMetres: 250 },
  observer: { cell: 'B7', facing: 'south', landform: 'flat', ahead: 'falls' },
  features: [feature(), feature({ kind: 'knoll', name: 'the 124 m knoll', heightMetres: 124, cell: 'D7', compass: 'south', distanceMetres: 500, distanceText: '500 m', side: 'centre' })],
  lookalike: { label: 'A7', adjacent: true, reason: { type: 'landmark-side', feature: 1, side: 'left' } }, ...over });
const friendFacts = (over = {}) => ({ version: 1, mode: 'friend', answer: { label: 'E6', kind: 'cell' }, grid: { size: 8, cellMetres: 250 },
  observer: { cell: 'D6', facing: 'south', landform: 'reentrant', ahead: 'rises', marked: false },
  features: [feature({ name: 'the 197 m summit', heightMetres: 197, cell: 'G6', compass: 'south', distanceMetres: 650, distanceText: '650 m', side: 'left' })],
  target: { cell: 'E6', compass: 'south', distanceMetres: 160, distanceText: '160 m', landform: 'slope', near: null },
  lookalike: { label: 'G7', adjacent: false, observerCell: 'F7', reason: { type: 'landmark-out-of-frame', feature: 0, direction: 'right' } }, ...over });
const peak = (label, over) => ({ role: 'peak', label, kind: 'knoll', name: 'the 155 m knoll', heightMetres: 155, cell: 'A5', compass: 'north-east',
  distanceMetres: 700, distanceText: '700 m', bearing: 30, backBearing: 210, backCompass: 'south-west', ...over });
const resection = (reason, mistaken = []) => ({ version: 1, mode: 'resection', answer: { label: 'C4', kind: 'cell' }, grid: { size: 8, cellMetres: 375 },
  observer: { cell: 'C4', facing: null, landform: 'valley', ahead: null },
  features: [peak('P1'), peak('P2', { name: 'the 128 m knoll', heightMetres: 128, cell: 'C1', compass: 'west', distanceMetres: 950, distanceText: '950 m', bearing: 270, backBearing: 90, backCompass: 'east' })],
  lookalike: { label: 'C2', adjacent: false, mistaken, reason } });

test('template: one sentence for every look-alike reason type', () => {
  const look = (facts) => renderExplanation(facts).steps.at(-1);
  const grid = (reason) => look(gridFacts({ lookalike: { label: 'A7', adjacent: true, reason } }));
  assert.equal(grid({ type: 'landmark-side', feature: 1, side: 'left' }), 'Not A7: from there the 124 m knoll would sit on the left, not in the centre.');
  assert.equal(grid({ type: 'landmark-out-of-frame', feature: 0, direction: 'left' }), 'Not A7: from there the 192 m summit would be out of the picture, off to the left.');
  assert.equal(grid({ type: 'landmark-hidden', feature: 0 }), 'Not A7: from there the 192 m summit would be hidden behind nearer ground.');
  assert.equal(grid({ type: 'landmark-range', feature: 0, distanceMetres: 1600, distanceText: '1.6 km', looks: 'smaller' }),
    'Not A7: from there the 192 m summit would be 1.6 km away, not 950 m, and look much smaller.');
  assert.equal(grid({ type: 'skyline-higher', side: 'left' }), 'Not A7: from there the skyline on the left would sit higher.');
  assert.equal(grid({ type: 'skyline-lower', side: 'centre' }), 'Not A7: from there the skyline in the centre would sit lower.');
  assert.equal(look(friendFacts()), 'Not G7: YOU would then be in F7, and from there the 197 m summit would be out of the picture, off to the right.');
  assert.equal(look(friendFacts({ lookalike: { label: 'E5', adjacent: true, observerCell: null, reason: { type: 'person-range', distanceMetres: 80, distanceText: '80 m', looks: 'larger' } } })),
    'Not E5: he would be 80 m away and look much larger.');
  const mistaken = [{ peak: 'P1', name: 'the 132 m knoll', cell: 'B3' }];
  assert.equal(look(resection({ type: 'peak-range', peak: 'P2', subject: 'P2', distanceMetres: 200, distanceText: '200 m', seenText: '950 m', looks: 'larger' }, mistaken)),
    'Not C2: it needs the 132 m knoll in B3 to be P1; from there P2 would be 200 m away, but P2 in the view is 950 m away.');
  assert.equal(look(resection({ type: 'peak-hidden', peak: 'P1', subject: 'the 132 m knoll' }, mistaken)),
    'Not C2: it needs the 132 m knoll in B3 to be P1; from there that hill would be hidden behind higher ground, yet P1 is in view.');
  assert.equal(look(resection({ type: 'peak-eye-level', peak: 'P2', subject: 'P2', from: 'below', seen: 'above' })),
    'Not C2: from there you would look down at P2, but P2 in the view is above eye level.');
  assert.equal(look(resection({ type: 'bearing-meets-no-hill', peak: 'P1' })), 'Not C2: from there the P1 bearing meets no hill.');
  assert.equal(look(resection({ type: 'bearing-off', peak: 'P2', degrees: 12 })), 'Not C2: from there P2 would be 12° off its bearing.');
  assert.equal(look(resection(null, mistaken)), 'Not C2: it only works if you take the 132 m knoll in B3 for P1.');
  assert.equal(renderExplanation(resection(null)).steps.length, 3, 'nothing to say about the trap: no sentence');
  const vis = { version: 1, mode: 'visibility', answer: { label: 'B', kind: 'option' }, grid: null, observer: null, features: [],
    target: { label: 'B', compass: 'south-west', distanceMetres: 300, distanceText: '300 m', flagMetres: 2, hiddenLowestMetres: 0 },
    lookalike: { label: 'E', adjacent: false, reason: { type: 'flag-hidden', blockDistanceMetres: 600, blockDistanceText: '600 m', neededMetres: 2.8 } } };
  assert.deepEqual(renderExplanation(vis).steps, ['B is the only flag in sight from YOU: it stands about 300 m to your south-west.',
    'Nothing rises above the line from your eye to its foot, so the whole flag shows.',
    'Not E: ground about 600 m out on that line hides it; it would need to be 2.8 m tall to show.']);
});

test('template: reasoning order, no invented features, caution wording', () => {
  assert.deepEqual(renderExplanation(gridFacts()).steps, [
    'Find the 192 m summit on the right of the view: it is in E4, about 950 m to your south-west.',
    'The 124 m knoll in D7 is in the centre, 500 m away.',
    'Both line up like this only from B7, facing south. The ground ahead falls, as the contours show.',
    'Not A7: from there the 124 m knoll would sit on the left, not in the centre.']);
  const bare = renderExplanation(gridFacts({ features: [], lookalike: null, observer: { cell: 'B7', facing: 'south', landform: 'valley', ahead: 'level' } }));
  assert.deepEqual(bare.steps, ['Match the skyline and the ground ahead: you face south, standing in a valley.',
    'Facing south, this view fits B7 and no other cell. The ground ahead stays nearly level, as the contours show.']);
  assert.doesNotMatch(bare.short, /summit|knoll|ridge|spur|saddle/);
  const caution = renderExplanation(gridFacts({ caution: true }));
  assert.match(caution.short, /line up best from B7/); assert.doesNotMatch(caution.short, /\bonly\b/);
  const friend = renderExplanation(friendFacts({ caution: true, features: [] }));
  assert.equal(friend.steps[0], 'First find YOU from the ground around you: you stand in a re-entrant in D6, facing south, and the ground ahead rises.');
  assert.equal(friend.steps[1], 'Your friend is about 160 m south of you, on a slope: that fits E6 best.');
  const marked = renderExplanation(friendFacts({ observer: { ...friendFacts().observer, marked: true } }));
  assert.equal(marked.steps[0], 'YOU are marked on the map in D6, facing south, and the ground ahead rises.');
  assert.match(renderExplanation(friendFacts()).steps[0], /^First find YOU: the 197 m summit on the left of the view is in G6, about 650 m to your south, so you are in D6, facing south\.$/);
  assert.deepEqual(renderExplanation(resection(null)).steps.slice(0, 3), ['P1 is the 155 m knoll in A5, P2 the 128 m knoll in C1.',
    'Draw the back-bearings: 210° (south-west) from P1 and 090° (east) from P2.', 'They cross in C4.']);
  assert.equal(renderExplanation({ mode: 'route' }), null);
});

test('template: a long caption drops the ground ahead, side details, the second feature, then the look-alike', () => {
  const long = (n) => 'the ' + 'very '.repeat(n) + 'high summit';
  const at = (n) => renderExplanation(gridFacts({ features: [feature({ name: long(n) }), gridFacts().features[1]] })).short;
  const full = renderExplanation(gridFacts()).steps.join(' ');
  assert.ok(full.length > SHORT_MAX && /ground ahead/.test(full));
  assert.equal(renderExplanation(gridFacts()).short, full.replace(' The ground ahead falls, as the contours show.', ''), 'first the ground ahead goes');
  const lengths = [];
  for (let n = 0; n < 60; n++) {
    const s = at(n);
    assert.ok(s.length <= SHORT_MAX, `${n}: ${s.length}`);
    assert.match(s, /\bB7\b/);
    lengths.push([/ground ahead/.test(s), / of the view/.test(s), /D7 is in the centre/.test(s), /Not A7/.test(s)]);
  }
  const firstLost = (k) => lengths.findIndex((x) => !x[k]);
  assert.ok(firstLost(0) === 0 && firstLost(1) > 0 && firstLost(1) < firstLost(2) && firstLost(2) < firstLost(3), JSON.stringify([0, 1, 2, 3].map(firstLost)));
  assert.ok(at(59).length <= SHORT_MAX);
});

// ------------------------------------------------------------ review 1: claims re-checked independently (M1, M3, M4, M5)

test('distances: published steps (10 m < 250 m, 50 m < 1 km, then 0.1 km)', () => {
  const table = [[5, 10, '10 m'], [44, 40, '40 m'], [244, 240, '240 m'], [246, 250, '250 m'], [262, 250, '250 m'], [276, 300, '300 m'],
    [974, 950, '950 m'], [976, 1000, '1.0 km'], [1049, 1000, '1.0 km'], [1051, 1100, '1.1 km'], [1649, 1600, '1.6 km']];
  for (const [m, r, t] of table) assert.deepEqual([roundDistance(m), distanceText(m), roundM(m), textM(m)], [r, t, r, t], String(m));
});

test('facts: grid observer — facing and the ground 120 m ahead (rises / falls / level at ±3 m)', () => {
  const seen = new Set();
  for (const q of quizzes.grid) {
    const model = modelOf(q), cam = q.camera, a = cam.heading * DEG;
    const x = cam.x + Math.sin(a) * 120, y = cam.y + Math.cos(a) * 120;
    if (!model.inside(x, y)) { assert.equal(q.explanation.facts.observer.ahead, null); continue; }
    const change = model.getElevation(x, y) - model.getElevation(cam.x, cam.y);
    const want = change >= 3 ? 'rises' : change <= -3 ? 'falls' : 'level';
    assert.equal(q.explanation.facts.observer.ahead, want, `${q.seed}: ${change.toFixed(1)} m`);
    if (Math.abs(change) >= 3 && Math.abs(change) < 30) seen.add(want);
  }
  assert.ok(seen.size >= 1, 'a modest rise or fall is in the sample');
});

test('facts: chosen landmarks are ≥ 8° apart; a named skyline top is at the highest skyline point', () => {
  let tops = 0;
  for (const q of [...quizzes.grid, ...quizzes.friend]) {
    const model = modelOf(q), cam = q.camera, f = q.explanation.facts;
    // The chosen landmarks keep 8° apart; the skyline top is named as such even next to one of them.
    const named = f.features.filter((x) => x.role === 'landmark' && ['summit', 'knoll', 'saddle', 'depression'].includes(x.kind))
      .map((ft) => model.analyzer.landmarks.find((l) => l.kind === ft.kind && Math.round(l.z) === ft.heightMetres && cellOf(q, l) === ft.cell));
    for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++) {
      const gap = Math.abs(((bearing(cam, named[i]) - bearing(cam, named[j]) + 540) % 360) - 180);
      assert.ok(gap >= 8, `${q.mode} ${q.seed}: ${gap.toFixed(1)}° apart`);
    }
    const top = f.features.find((x) => x.role === 'skyline-top' && ['summit', 'knoll'].includes(x.kind));
    if (!top) continue;
    const lm = model.analyzer.landmarks.find((l) => l.kind === top.kind && Math.round(l.z) === top.heightMetres && cellOf(q, l) === top.cell);
    const sky = ownSkylineTop(model, cam);
    assert.ok(Math.abs(offsetOf(cam, lm) - sky.offset) <= 5, `${q.mode} ${q.seed}: ${top.name} at ${offsetOf(cam, lm).toFixed(1)}°, skyline top at ${sky.offset}°`);
    tops++;
  }
  assert.ok(tops >= 5, `${tops} named skyline tops checked`);
});

test('facts: friend — the landmark "near" him is within 150 m and the closest; the look-alike is the closest wrong sighting', () => {
  let nears = 0;
  for (const q of quizzes.friend) {
    const model = modelOf(q), f = q.explanation.facts, t = f.target;
    const byDistance = model.analyzer.landmarks.map((l) => ({ l, d: Math.hypot(l.x - q.friend.x, l.y - q.friend.y) })).sort((a, b) => a.d - b.d);
    if (byDistance[0].d <= 150) {
      nears++;
      assert.equal(t.near.cell, cellOf(q, byDistance[0].l), q.seed);
      assert.match(t.near.name, new RegExp(byDistance[0].l.kind === 'depression' ? 'depression' : `${Math.round(byDistance[0].l.z)} m ${byDistance[0].l.kind}`));
    } else assert.equal(t.near, null, `${q.seed}: nothing within 150 m`);
    const wrong = q.friend.matches.filter((m) => !m.correct && cellOf(q, m) && cellOf(q, m) !== q.correctLabel);
    if (!wrong.length) { assert.equal(f.lookalike, null); continue; }
    const minD = Math.min(...wrong.map((m) => m.D));
    assert.ok(wrong.some((m) => m.D === minD && cellOf(q, m) === f.lookalike.label), `${q.seed}: ${f.lookalike.label} is the closest wrong sighting`);
  }
  assert.ok(nears >= 1, 'a friend near a landmark is in the sample');
});

test('facts: landmark look-alike reasons hold from the look-alike camera (clearly out, clearly hidden, ≥ 10° shift, range)', () => {
  const types = new Set();
  for (const q of [...quizzes.grid, ...quizzes.friend]) {
    const f = q.explanation.facts, r = f.lookalike?.reason;
    if (!r?.type.startsWith('landmark-')) continue;
    types.add(r.type);
    const model = modelOf(q), ft = f.features[r.feature], cam = q.camera;
    const lm = model.analyzer.landmarks.find((x) => x.kind === ft.kind && Math.round(x.z) === ft.heightMetres && cellOf(q, x) === ft.cell);
    const alt = q.mode === 'grid' ? (() => { const o = q.options.find((x) => x.label === f.lookalike.label);
      return { ...cam, x: o.x, y: o.y, z: model.getElevation(o.x, o.y) + cam.eyeHeight, heading: o.heading ?? cam.heading }; })()
      : q.friend.matches.filter((m) => !m.correct && cellOf(q, m) === f.lookalike.label).sort((a, b) => a.D - b.D)[0].observer;
    const oa = offsetOf(alt, lm), os = offsetOf(cam, lm), z = model.getElevation(lm.x, lm.y), tag = `${q.mode} ${q.seed} ${r.type}`;
    const da = Math.hypot(lm.x - alt.x, lm.y - alt.y), ds = Math.hypot(lm.x - cam.x, lm.y - cam.y);
    if (r.type === 'landmark-out-of-frame') {
      assert.ok(Math.abs(oa) >= alt.fov / 2 + 3, `${tag}: ${oa.toFixed(1)}° vs ±${alt.fov / 2}°`);
      assert.equal(r.direction, oa < 0 ? 'left' : 'right', tag);
    } else {
      assert.ok(Math.abs(oa) <= alt.fov / 2, `${tag}: in the picture`);
      if (r.type === 'landmark-hidden') assert.ok(groundAbove(model, alt, lm.x, lm.y, z + 2) > 0, `${tag}: ground hides even 2 m above the top`);
      else assert.ok(groundAbove(model, alt, lm.x, lm.y, z) <= 0, `${tag}: in sight`);
      if (r.type === 'landmark-side') {
        assert.ok(Math.abs(oa - os) >= 10, `${tag}: shift ${Math.abs(oa - os).toFixed(1)}°`);
        assert.equal(r.side, oa < -alt.fov / 6 ? 'left' : oa > alt.fov / 6 ? 'right' : 'centre', tag);
      }
      if (r.type === 'landmark-range') {
        assert.ok(da / ds >= 1.5 || da / ds <= 0.67, tag);
        assert.equal(r.looks, da > ds ? 'smaller' : 'larger', tag);
        assert.equal(r.distanceText, textM(da), tag);
      }
    }
  }
  assert.deepEqual([...types].sort(), ['landmark-hidden', 'landmark-out-of-frame', 'landmark-range', 'landmark-side']);
});

test('facts: a skyline look-alike reason says higher / lower as an own skyline ray march sees it', () => {
  const horizonAt = (model, cam, off) => {
    const az = (cam.heading + off) * DEG;
    let top = -90;
    for (let d = 30; d <= 5000; d += model.cell / 2) {
      const x = cam.x + Math.sin(az) * d, y = cam.y + Math.cos(az) * d;
      if (!model.inside(x, y)) break;
      top = Math.max(top, Math.atan2(model.getElevation(x, y) - cam.z, d) / DEG);
    }
    return top;
  };
  let checked = 0;
  for (const q of [...quizzes.grid, ...quizzes.friend]) {
    const f = q.explanation.facts, r = f.lookalike?.reason;
    if (r?.type !== 'skyline-higher' && r?.type !== 'skyline-lower') continue;
    const alt = q.explanation.alternatives.find((a) => a.label === f.lookalike.label);
    const v = alt.reasons.find((x) => x.type === 'view-mismatch' && x.data.feature === 'skyline' && Math.abs(x.data.deltaDegrees) >= 1);
    assert.equal(r.side, v.data.screenSide);
    const model = modelOf(q), cam = q.camera;
    const altCam = q.mode === 'grid' ? (() => { const o = q.options.find((x) => x.label === f.lookalike.label);
      return { ...cam, x: o.x, y: o.y, z: o.z + cam.eyeHeight, heading: o.heading ?? cam.heading }; })()
      : q.friend.matches.filter((m) => !m.correct && cellOf(q, m) === f.lookalike.label).sort((a, b) => a.D - b.D)[0].observer;
    const delta = horizonAt(model, altCam, v.data.screenOffset) - horizonAt(model, cam, v.data.screenOffset);
    assert.equal(r.type, delta > 0 ? 'skyline-higher' : 'skyline-lower', `${q.mode} ${q.seed}: own delta ${delta.toFixed(2)}°`);
    checked++;
  }
  assert.ok(checked >= 2, `${checked} skyline reasons checked`);
});

test('facts: intervisibility numbers re-computed from the terrain (distance, compass, hidden foot, closest hidden flag)', () => {
  const needed = (model, eye, p) => { // lowest visible height above the flag's foot, own sampling
    const d = Math.hypot(p.x - eye.x, p.y - eye.y), steps = Math.ceil(d / 1.5), zT = surfaceElevation(model, p.x, p.y);
    let worst = -Infinity, at = 0;
    for (let i = 1; i < steps - 1; i++) {
      const t = i / steps, need = (surfaceElevation(model, eye.x + (p.x - eye.x) * t, eye.y + (p.y - eye.y) * t) - eye.z) / t;
      if (need > worst) { worst = need; at = d * t; }
    }
    return { height: worst + eye.z - zT, at };
  };
  for (const q of quizzes.visibility) {
    const model = modelOf(q), f = q.explanation.facts, o = q.map.observer, eye = { ...o, z: surfaceElevation(model, o.x, o.y) + 1.7 };
    const flag = (label) => q.options.find((x) => x.label === label);
    const answer = flag(f.answer.label), own = needed(model, eye, answer), d = Math.hypot(answer.x - o.x, answer.y - o.y);
    assert.equal(f.target.distanceText, textM(d), q.seed);
    assert.equal(f.target.compass, compass(bearing(o, answer)), q.seed);
    assert.ok(Math.abs(f.target.hiddenLowestMetres - Math.max(0, own.height)) <= 0.2, `${q.seed}: hidden ${f.target.hiddenLowestMetres} vs ${own.height.toFixed(2)}`);
    const hidden = q.options.filter((x) => !x.correct).map((x) => ({ x, own: needed(model, eye, x) })).sort((a, b) => a.own.height - b.own.height);
    const near = hidden.find((h) => h.x.label === f.lookalike.label);
    assert.ok(near.own.height <= hidden[0].own.height + 0.2, `${q.seed}: ${f.lookalike.label} is the hidden flag closest to showing`);
    assert.ok(Math.abs(f.lookalike.reason.neededMetres - near.own.height) <= 0.2, `${q.seed}: needs ${f.lookalike.reason.neededMetres} vs ${near.own.height.toFixed(2)}`);
    assert.ok(Math.abs(f.lookalike.reason.blockDistanceMetres - near.own.at) <= Math.max(30, 0.06 * near.own.at), `${q.seed}: block at ${near.own.at.toFixed(0)}`);
    assert.ok(f.lookalike.reason.neededMetres > f.target.flagMetres, `${q.seed}: the look-alike is really hidden`);
  }
});

