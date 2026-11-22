import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { buildAnswerExplanation } from '../src/engine/answerExplanation.js';
import { cellAtExtent, parseCell } from '../src/engine/gridQuiz.js';
import { scrambleLabels } from '../src/engine/scramble.js';
import { modeResultHTML } from '../src/render/mapModesView.js';
import { COMPASS_WORDS, SHORT_MAX, renderExplanation, resectionFacts, roundDistance, distanceText } from '../src/engine/explanationFacts.js';

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
const all = () => Object.values(quizzes).flat();

// Independent helpers (deliberately not the engine's own code).
const DEG = Math.PI / 180;
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
    for (const ft of f.features) assert.equal(ft.distanceText, distanceText(ft.distanceMetres), tag);
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
      assert.ok(Math.abs(off) < cam.fov / 2, `${q.seed}: ${ft.name} in the frame`);
      assert.ok(clearSight(model, cam, { x: lm.x, y: lm.y, z: model.getElevation(lm.x, lm.y) + 1.5 }), `${q.seed}: ${ft.name} in sight`);
      assert.equal(ft.compass, compass(az)); assert.equal(ft.distanceMetres, roundDistance(d));
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
      assert.equal(ft.distanceMetres, roundDistance(Math.hypot(p.x - o.x, p.y - o.y)));
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
    if (l.reason.type === 'landmark-range') assert.equal(l.reason.distanceMetres, roundDistance(Math.hypot(lm.x - alt.x, lm.y - alt.y)));
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
