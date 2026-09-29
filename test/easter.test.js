import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EASTER_CONFIG, resolveEasterEgg, selectEvent, parsePreview, isoDateInZone, isValidDate, createEasterEgg, envelope, EGG_DURATION } from '../src/easter/index.js';
import { protectedRects, freeRects, createStage } from '../src/easter/stage.js';
import { SANTA } from '../src/easter/winter.js';
import { TIMELINE } from '../src/easter/may4.js';
import { flashAlpha, FLASH } from '../src/easter/models/space.js';
import { SLEIGH_TEAM } from '../src/easter/models/sleigh.js';
import { ExportComposer, FORMATS } from '../src/export/composer.js';
import { generate } from '../src/engine/quiz.js';
import { scrambleLabels } from '../src/engine/scramble.js';

const at = (iso) => new Date(`${iso}T12:00:00`);
const LAST_FRAME = 449 / 30; // final frame of the 15 s, 30 fps video

// --------------------------------------------------------------- helpers

/** A 2D context double that records every call and property write, with real save/restore state. */
function recorder() {
  const log = [];
  const r = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
  let state = { globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', globalCompositeOperation: 'source-over', font: '10px x', textAlign: 'start' };
  const stack = [];
  let gradId = 0;
  const api = {
    save() { stack.push({ ...state }); log.push(['save']); },
    restore() { state = stack.pop() || state; log.push(['restore']); },
    createLinearGradient: (...a) => grad('linear', a),
    createRadialGradient: (...a) => grad('radial', a),
    measureText: () => ({ width: 10 }),
  };
  function grad(kind, args) {
    const id = gradId++;
    log.push(['grad', kind, ...args.map(r)]);
    return { id, addColorStop: (...s) => log.push(['stop', id, ...s]) };
  }
  const ctx = new Proxy({}, {
    get(_, prop) {
      if (prop === 'log') return log;
      if (prop === 'depth') return stack.length;
      if (prop in api) return api[prop];
      if (prop in state) return state[prop];
      return (...args) => { log.push([String(prop), ...args.map(r)]); };
    },
    set(_, prop, value) {
      state[prop] = value;
      log.push(['=' + String(prop), typeof value === 'object' && value ? `g${value.id}` : r(value)]);
      return true;
    },
  });
  return ctx;
}

const hashLog = (log) => {
  const s = JSON.stringify(log);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${log.length}:${h >>> 0}`;
};

/** Synthetic skyline in scene pixels: rolling hills, or a low flat horizon. */
const skylineFor = (w, h, kind = 'hills') => {
  const pts = [];
  for (let x = 0; x <= w; x += 3) {
    const y = kind === 'hills' ? h * 0.5 + 60 * Math.sin(x / 140) + 35 * Math.sin(x / 47 + 1) : h * 0.62;
    pts.push([Math.min(x, w), y]);
  }
  return pts;
};

const layoutFor = (format) => ExportComposer.prototype.computeLayout.call(null, FORMATS[format]);
const frameFor = (format) => ({ width: FORMATS[format].width, height: FORMATS[format].height });

function makeEgg(plan, { format = 'reels', seed = 'seed-1', kind = 'hills' } = {}) {
  const layout = layoutFor(format);
  return createEasterEgg(plan, { seed, layout, frame: frameFor(format), skyline: skylineFor(layout.scene.w, layout.scene.h, kind) });
}

const winterPlan = (o = {}) => ({ key: 'winter', date: '2026-12-24', santa: true, preview: false, reducedMotion: false, ...o });
const may4Plan = (o = {}) => ({ key: 'may4', date: '2027-05-04', santa: false, preview: false, reducedMotion: false, ...o });

const drawLog = (egg, t) => { const c = recorder(); const drew = egg.draw(c, t); return { drew, log: c.log, depth: c.depth }; };
const freeze = (o) => { if (o && typeof o === 'object' && !ArrayBuffer.isView(o)) { Object.freeze(o); Object.values(o).forEach(freeze); } return o; };

// --------------------------------------------------------------- date selection

test('winter window: Dec 21 - Jan 6 inclusive, wrapping the new year', () => {
  for (const d of ['2026-12-21', '2026-12-31', '2027-01-01', '2027-01-06']) assert.equal(selectEvent(d)?.key, 'winter', d);
  for (const d of ['2026-12-20', '2027-01-07', '2026-06-15', '2026-09-29']) assert.equal(selectEvent(d), null, d);
});

test('Santa flies only on Dec 24 and 25', () => {
  assert.equal(selectEvent('2026-12-24').santa, true);
  assert.equal(selectEvent('2026-12-25').santa, true);
  for (const d of ['2026-12-23', '2026-12-26', '2027-01-01']) assert.equal(selectEvent(d).santa, false, d);
});

test('May the Fourth is May 4 only', () => {
  assert.deepEqual(selectEvent('2027-05-04'), { key: 'may4', santa: false });
  for (const d of ['2027-05-03', '2027-05-05', '2027-04-04']) assert.equal(selectEvent(d), null, d);
});

test('event windows are configurable', () => {
  const cfg = { ...EASTER_CONFIG, winter: { start: [12, 1], end: [12, 31], santaDays: [[12, 10]] }, may4: { days: [[5, 4], [5, 5]] } };
  assert.equal(selectEvent('2026-12-02', cfg).key, 'winter');
  assert.equal(selectEvent('2026-12-10', cfg).santa, true);
  assert.equal(selectEvent('2027-01-02', cfg), null);
  assert.equal(selectEvent('2027-05-05', cfg).key, 'may4');
  // A non-wrapping window works as well.
  assert.equal(selectEvent('2026-07-04', { ...cfg, winter: { start: [7, 1], end: [7, 10], santaDays: [] } }).key, 'winter');
});

test('the calendar day comes from the configured time zone, not the machine', () => {
  const instant = new Date('2026-12-24T23:30:00Z'); // still Dec 24 in Los Angeles, already Dec 25 in Istanbul
  assert.equal(isoDateInZone(instant, 'America/Los_Angeles'), '2026-12-24');
  assert.equal(isoDateInZone(instant, 'Europe/Istanbul'), '2026-12-25');
  const cfg = (timeZone) => ({ ...EASTER_CONFIG, timeZone });
  assert.equal(resolveEasterEgg({ now: instant, config: cfg('Pacific/Kiritimati') }).date, '2026-12-25');
  const b4 = new Date('2027-05-03T22:30:00Z');
  assert.equal(resolveEasterEgg({ now: b4, config: cfg('Europe/Istanbul') }).key, 'may4');
  assert.equal(resolveEasterEgg({ now: b4, config: cfg('America/New_York') }), null);
});

test('strict date validation', () => {
  assert.ok(isValidDate('2028-02-29'));
  for (const d of ['2026-02-29', '2026-13-01', '2026-1-1', 'abc', '', null, undefined]) assert.ok(!isValidDate(d), String(d));
});

// --------------------------------------------------------------- preview overrides

test('preview: ?easterEgg forces an event on any date', () => {
  const now = at('2026-09-29');
  assert.equal(resolveEasterEgg({ now }), null, 'no event in September');
  assert.equal(resolveEasterEgg({ now, search: '?easterEgg=winter' }).key, 'winter');
  assert.equal(resolveEasterEgg({ now, search: '?easterEgg=winter' }).santa, false, 'winter alone has no sleigh');
  const santa = resolveEasterEgg({ now, search: '?easterEgg=santa' });
  assert.deepEqual([santa.key, santa.santa, santa.date], ['winter', true, '2026-12-24']);
  const may = resolveEasterEgg({ now, search: '?easterEgg=may4' });
  assert.deepEqual([may.key, may.date, may.preview], ['may4', '2026-05-04', true]);
});

test('preview: ?easterDate picks the event by date, and combines with ?easterEgg', () => {
  const now = at('2026-09-29');
  assert.equal(resolveEasterEgg({ now, search: '?easterDate=2026-12-25' }).santa, true);
  assert.equal(resolveEasterEgg({ now, search: '?easterDate=2026-12-27' }).santa, false);
  assert.equal(resolveEasterEgg({ now, search: '?easterDate=2027-05-04' }).key, 'may4');
  assert.equal(resolveEasterEgg({ now, search: '?easterDate=2027-03-01' }), null);
  assert.equal(resolveEasterEgg({ now, search: '?easterEgg=winter&easterDate=2026-12-25' }).santa, true);
  assert.equal(resolveEasterEgg({ now, search: '?easterEgg=winter&easterDate=2026-12-28' }).santa, false);
});

test('preview: off wins on a real event day; junk is ignored', () => {
  const xmas = at('2026-12-24');
  assert.equal(resolveEasterEgg({ now: xmas }).santa, true);
  for (const off of ['off', 'none', '0', 'false']) assert.equal(resolveEasterEgg({ now: xmas, search: `?easterEgg=${off}` }), null, off);
  assert.equal(resolveEasterEgg({ now: xmas, search: '?easterEgg=banana&easterDate=nope' }).santa, true, 'falls back to the real date');
  assert.deepEqual(parsePreview('?easterEgg=MAY4&easterDate=2026-02-31'), { egg: 'may4', date: null, reducedMotion: null });
});

test('reduced motion: system preference, overridable from the URL', () => {
  const now = at('2026-12-24');
  assert.equal(resolveEasterEgg({ now, reducedMotion: true }).reducedMotion, true);
  assert.equal(resolveEasterEgg({ now, reducedMotion: true, search: '?reducedMotion=0' }).reducedMotion, false);
  assert.equal(resolveEasterEgg({ now, reducedMotion: false, search: '?reducedMotion=1' }).reducedMotion, true);
});

// --------------------------------------------------------------- envelope and timing

test('envelope: silent at the first and last frame, full in the middle, smooth in between', () => {
  assert.equal(envelope(0), 0);
  assert.equal(envelope(LAST_FRAME), 0, 'the last frame is the ordinary render');
  assert.equal(envelope(EGG_DURATION), 0);
  assert.equal(envelope(EGG_DURATION - 0.1), 0);
  assert.equal(envelope(8), 1);
  let prev = 0;
  for (let t = 0; t <= 0.8; t += 0.05) { const e = envelope(t); assert.ok(e >= prev - 1e-9); prev = e; }
  prev = 1;
  for (let t = 14.3; t <= 14.9; t += 0.05) { const e = envelope(t); assert.ok(e <= prev + 1e-9); prev = e; }
});

test('an inactive layer touches nothing: first frame, last frame, past the end', () => {
  for (const plan of [winterPlan(), may4Plan()]) {
    const egg = makeEgg(plan);
    for (const t of [0, LAST_FRAME, 15, 20]) {
      const { drew, log } = drawLog(egg, t);
      assert.equal(drew, false);
      assert.equal(log.length, 0, `${plan.key} t=${t} issued draw calls`);
    }
  }
});

test('no plan, no layer', () => {
  assert.equal(makeEgg(null), null);
  assert.equal(makeEgg({ key: 'nope', date: '2026-01-01' }), null);
});

// --------------------------------------------------------------- determinism

test('same seed, event, date and time give the identical drawing (any order, any number of times)', () => {
  for (const plan of [winterPlan(), winterPlan({ santa: false }), may4Plan()]) {
    const a = makeEgg(plan), b = makeEgg(plan);
    for (const t of [2, 7.5, 11.4, 12.2, 13.9]) {
      const first = hashLog(drawLog(a, t).log);
      assert.equal(hashLog(drawLog(b, t).log), first, `${plan.key} t=${t} across instances`);
      drawLog(a, t + 1); // an unrelated frame in between must not matter
      assert.equal(hashLog(drawLog(a, t).log), first, `${plan.key} t=${t} after another frame`);
    }
  }
});

test('seed, event date and time all change the drawing', () => {
  const base = hashLog(drawLog(makeEgg(winterPlan()), 5).log);
  assert.notEqual(hashLog(drawLog(makeEgg(winterPlan(), { seed: 'seed-2' }), 5).log), base, 'seed');
  assert.notEqual(hashLog(drawLog(makeEgg(winterPlan({ date: '2026-12-25' })), 5).log), base, 'date');
  assert.notEqual(hashLog(drawLog(makeEgg(winterPlan()), 6).log), base, 'time (snow moves)');
  const m = hashLog(drawLog(makeEgg(may4Plan()), 5).log);
  assert.notEqual(hashLog(drawLog(makeEgg(may4Plan(), { seed: 'seed-2' }), 5).log), m, 'seed (stars)');
});

test('per-frame code never reads the clock or randomness', () => {
  const realRandom = Math.random, realNow = Date.now, realPerf = globalThis.performance;
  Math.random = () => { throw new Error('Math.random used while drawing'); };
  Date.now = () => { throw new Error('Date.now used while drawing'); };
  try {
    for (const plan of [winterPlan(), may4Plan()]) {
      const egg = makeEgg(plan);
      for (const t of [1, 5, 11.3, 12.2, 14]) egg.draw(recorder(), t);
    }
  } finally { Math.random = realRandom; Date.now = realNow; globalThis.performance = realPerf; }

  // ...and the source says the same: no clock, randomness or network in the rendering modules.
  const dir = fileURLToPath(new URL('../src/easter/', import.meta.url));
  const files = ['index.js', 'stage.js', 'winter.js', 'may4.js', 'models/sleigh.js', 'models/space.js'];
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const bad of [/Math\.random/, /Date\.now/, /performance\.now/, /new Date\(/, /\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /localStorage/, /https?:\/\//]) {
      assert.ok(!bad.test(src), `${f} matches ${bad}`);
    }
  }
  // No bundled assets or new dependencies were added under src/easter.
  const all = [dir, join(dir, 'models')].flatMap((d) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name));
  assert.ok(all.length >= 8 && all.every((f) => f.endsWith('.js')), `unexpected non-code file in src/easter: ${all}`);
});

test('drawing is balanced: every save is restored, so no state leaks into the frame', () => {
  for (const plan of [winterPlan(), may4Plan()]) {
    const egg = makeEgg(plan);
    for (const t of [1, 3.5, 6.6, 10.5, 11.2, 12.2, 13.5, 14.2]) assert.equal(drawLog(egg, t).depth, 0, `${plan.key} t=${t}`);
  }
});

// --------------------------------------------------------------- quiz data untouched

test('the layer cannot change or reveal the quiz: frozen quiz, same data, answer-independent drawing', async () => {
  const quiz = await generate({ seed: 'egg-data', difficulty: 'hard' });
  const snapshot = () => JSON.stringify({ ...quiz, terrain: { ...quiz.terrain, heights: `${quiz.terrain.heights.length}:${quiz.terrain.heights[0]}:${quiz.terrain.heights[9999]}` } });
  const before = snapshot();
  const heightsBefore = Float32Array.from(quiz.terrain.heights);
  freeze(quiz);

  const drawsFor = (q, plan) => {
    const layout = layoutFor('reels');
    const egg = createEasterEgg(plan, { seed: q.seed, layout, frame: frameFor('reels'), skyline: skylineFor(layout.scene.w, layout.scene.h) });
    return [3, 11.4, 12.5].map((t) => hashLog(drawLog(egg, t).log));
  };
  for (const plan of [winterPlan(), may4Plan()]) {
    const a = drawsFor(quiz, plan);
    // A different lettering (scrambled options, another correct label) with the same seed draws the same picture.
    const scrambled = scrambleLabels(quiz, 3);
    assert.notEqual(scrambled.correctLabel, undefined);
    assert.deepEqual(drawsFor(scrambled, plan), a, `${plan.key}: drawing must not depend on the options or answer`);
  }
  assert.equal(snapshot(), before, 'quiz object unchanged');
  assert.deepEqual(Array.from(quiz.terrain.heights), Array.from(heightsBefore), 'terrain unchanged');
});

test('generating a quiz does not involve the layer at all', async () => {
  const a = await generate({ seed: 'egg-same', difficulty: 'medium' });
  const b = await generate({ seed: 'egg-same', difficulty: 'medium' });
  assert.deepEqual(a.options, b.options);
  assert.equal(a.correctLabel, b.correctLabel);
  const src = readFileSync(fileURLToPath(new URL('../src/engine/quiz.js', import.meta.url)), 'utf8');
  assert.ok(!/easter/i.test(src), 'engine must not know about Easter eggs');
});

// --------------------------------------------------------------- where it may draw

test('free areas never intersect protected content, in both formats and at other sizes', () => {
  const inter = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const variants = [
    ['reels', layoutFor('reels'), frameFor('reels')],
    ['post', layoutFor('post'), frameFor('post')],
    ['odd', { ...layoutFor('reels'), scene: { x: 40.5, y: 270.4, w: 999.3, h: 624.7 }, map: { x: 139.6, y: 953.2, s: 800 } }, frameFor('reels')],
  ];
  for (const [name, layout, frame] of variants) {
    const prot = protectedRects(layout, frame), free = freeRects(layout, frame);
    assert.ok(free.length >= 4, name);
    for (const f of free) {
      for (const p of prot) assert.ok(!inter(f, p), `${name}: free "${f.name}" overlaps protected "${p.name}"`);
      assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.w <= frame.width && f.y + f.h <= frame.height, `${name}: ${f.name} leaves the frame`);
      for (const k of ['x', 'y', 'w', 'h']) assert.equal(f[k], Math.round(f[k]), `${name}: ${f.name}.${k} is not a whole pixel`);
    }
    // The protected set covers the title, tape, countdown bar, map and caption.
    const S = layout.scene, M = layout.map;
    const covers = (x, y) => prot.some((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
    assert.ok(covers(frame.width / 2, layout.title.y - 10), `${name}: title`);
    assert.ok(covers(S.x + S.w / 2, S.y + 5), `${name}: tape`);
    for (const dy of [8, 11, 14]) assert.ok(covers(S.x + 50, S.y + S.h + dy), `${name}: countdown bar row +${dy}`);
    assert.ok(covers(S.x + 50, layout.rule) && covers(S.x + 50, layout.rule + 1), `${name}: rule line`);
    assert.ok(covers(S.x + S.w - 5, S.y + S.h + 11), `${name}: countdown bar, far end`);
    assert.ok(covers(M.x + M.s / 2, M.y + M.s / 2), `${name}: map`);
    assert.ok(covers(M.x + 3, M.y + 3), `${name}: map corner`);
    assert.ok(covers(frame.width / 2, layout.handle.y - 8), `${name}: handle`);
  }
});

test('sky area stays inside the scene, under the tape and above the skyline', () => {
  for (const format of ['reels', 'post']) for (const kind of ['hills', 'flat']) {
    const layout = layoutFor(format), S = layout.scene;
    const stage = createStage({ layout, frame: frameFor(format), skyline: skylineFor(S.w, S.h, kind) });
    const c = recorder();
    stage.clipSky(c);
    const pts = c.log.filter((e) => e[0] === 'moveTo' || e[0] === 'lineTo');
    assert.ok(pts.length > 100);
    for (const [, x, y] of pts) {
      assert.ok(x >= S.x - 2e-3 && x <= S.x + S.w + 2e-3, `${format}/${kind} x=${x}`);
      assert.ok(y >= stage.top - 2e-3 && y <= S.y + S.h + 2e-3, `${format}/${kind} y=${y}`); // recorder rounds to 3 decimals
    }
    // Every skyline vertex sits at least 4 px above the computed skyline (a margin for mesh/raymarch differences).
    stage.skyX.forEach((x, i) => assert.ok(stage.skyY[i] <= Math.max(stage.top, stage.skyRawY[i] - 4), `${format}/${kind} vertex ${i}`));
    const tape = protectedRects(layout, frameFor(format)).find((r) => r.name === 'tape');
    assert.ok(stage.top >= tape.y + tape.h, `${format}: sky starts below the tape`);
  }
});

// --------------------------------------------------------------- winter choreography

test('winter: snow runs the whole render (fading in and out); Santa only on Santa days', () => {
  const snowOnly = makeEgg(winterPlan({ santa: false }));
  for (const t of [1, 5, 9, 12, 14]) {
    const { drew, log } = drawLog(snowOnly, t);
    assert.ok(drew && log.some((e) => e[0] === 'arc'), `snow at t=${t}`);
    assert.ok(!log.some((e) => e[0] === 'ellipse'), `no sleigh on a non-Santa day (t=${t})`);
  }
  const santa = makeEgg(winterPlan());
  assert.ok(!drawLog(santa, 9).log.some((e) => e[0] === 'ellipse'), 'no sleigh before it enters');
  assert.ok(drawLog(santa, 12.2).log.some((e) => e[0] === 'ellipse'), 'sleigh in flight');
});

test('winter: the sleigh has 8 reindeer, a sleigh, reins and antlers, enters late and is gone before the end', () => {
  assert.equal(SLEIGH_TEAM.reindeer, 8);
  const egg = makeEgg(winterPlan());
  const bodies = (log) => log.filter((e) => e[0] === 'ellipse' && e[3] === 14.5 && e[4] === 7.8).length;
  assert.equal(bodies(drawLog(egg, 12.2).log), 8, 'eight reindeer bodies');
  assert.ok(SANTA.start >= 9.5 && SANTA.end <= 14.5, 'near the end, done before the last frame');

  const { scene, stage } = egg;
  const x = (t) => scene.santaPath(t).x;
  assert.equal(scene.santaPath(SANTA.start - 0.01), null);
  assert.equal(scene.santaPath(SANTA.end + 0.01), null);
  assert.ok(x(SANTA.start) + scene.sleigh.teamLen <= stage.left, 'starts fully outside the sky area');
  assert.ok(x(SANTA.end) >= stage.right, 'ends fully outside the sky area');
  for (let t = SANTA.start; t < SANTA.end - 0.05; t += 0.05) assert.ok(x(t + 0.05) > x(t), 'moves one way');

  // Every reindeer/sleigh feature is drawn: antler strokes (dark backing + cream), reins, runners, gift sack.
  const log = drawLog(egg, 12.2).log;
  assert.ok(log.filter((e) => e[0] === '=lineWidth' && e[1] === 3.6).length >= 16, 'antler backing strokes (2 antlers x 8 reindeer)');
  assert.ok(log.some((e) => e[0] === '=strokeStyle' && e[1] === '#f0d68a'), 'reins');
  assert.ok(log.some((e) => e[0] === '=strokeStyle' && e[1] === '#d5dbe0'), 'runner');
  assert.ok(log.some((e) => e[0] === '=fillStyle' && e[1] === '#7a4f26'), 'gift sack');
});

test('winter: the sleigh rides inside the sky area and scales to the sky available', () => {
  for (const kind of ['hills', 'flat']) {
    const egg = makeEgg(winterPlan(), { kind });
    const { sleigh } = egg.scene, { stage } = egg;
    assert.ok(sleigh.scale >= 0.7 && sleigh.scale <= 1.4);
    const topOfTeam = sleigh.baseY - SLEIGH_TEAM.height * sleigh.scale - 5 * sleigh.scale; // arc of +-5 px
    assert.ok(topOfTeam >= stage.top - 12, `${kind}: antlers stay under the tape (${topOfTeam} vs ${stage.top})`);
  }
});

test('winter: reduced motion freezes the snow and swaps the flight for a fade', () => {
  const rm = makeEgg(winterPlan({ reducedMotion: true, santa: false }));
  const snow = (t) => drawLog(rm, t).log.filter((e) => e[0] === 'arc').map((e) => e.slice(1, 4).join());
  assert.deepEqual(snow(3), snow(9), 'flakes do not move');
  const moving = makeEgg(winterPlan({ santa: false }));
  const s2 = drawLog(moving, 3).log.filter((e) => e[0] === 'arc').map((e) => e.slice(1, 4).join());
  const s3 = drawLog(moving, 9).log.filter((e) => e[0] === 'arc').map((e) => e.slice(1, 4).join());
  assert.notDeepEqual(s2, s3, 'control: flakes move without reduced motion');

  const still = makeEgg(winterPlan({ reducedMotion: true }));
  const xs = [11, 12.5, 13].map((t) => drawLog(still, t).log.find((e) => e[0] === 'translate'));
  assert.ok(xs.every(Boolean));
  assert.equal(new Set(xs.map((e) => e.join())).size, 1, 'the sleigh stays put');
});

// --------------------------------------------------------------- May the Fourth choreography

test('May 4: two or three Star Destroyers, a Death Star that fits the sky, TIE fighters', () => {
  const egg = makeEgg(may4Plan());
  const { ds, destroyers } = egg.scene, { stage } = egg;
  assert.ok(destroyers.length >= 2 && destroyers.length <= 3, `${destroyers.length} destroyers`);
  assert.ok(ds.r >= 22);
  assert.ok(ds.y - ds.r >= stage.top && stage.minHeadroom(ds.x - ds.r, ds.x + ds.r) >= 2 * ds.r + 6, 'the Death Star fits the sky at its position');
  const tieCockpits = (log) => log.filter((e) => e[0] === 'arc' && e[1] === 0 && e[2] === 0 && e[3] === 5.4).length;
  assert.ok(tieCockpits(drawLog(egg, 4).log) >= 3, 'patrol of TIE fighters');
  assert.ok(tieCockpits(drawLog(egg, 12.6).log) >= 3, 'TIE fighters flying away from the blast');
});

test('May 4: charges from 6.4 s, explodes at ~11 s, TIEs leave afterwards, fades out', () => {
  assert.ok(TIMELINE.charge[0] > 5 && TIMELINE.charge[1] <= TIMELINE.boom);
  assert.ok(Math.abs(TIMELINE.boom - 11) < 0.25);
  assert.ok(TIMELINE.tieOut > TIMELINE.boom);
  const egg = makeEgg(may4Plan());
  const sphere = (log) => log.filter((e) => e[0] === 'arc' && e[3] === egg.scene.ds.r).length;
  assert.ok(sphere(drawLog(egg, 10.5).log) >= 1, 'intact Death Star before the blast');
  const glow = (log) => log.filter((e) => e[0] === 'grad' && e[1] === 'radial').length;
  assert.ok(glow(drawLog(egg, 11.3).log) > glow(drawLog(egg, 9).log), 'fireball after the blast');
  // No explosion before the boom.
  const rings = (log) => log.filter((e) => e[0] === '=lineWidth').length;
  assert.ok(rings(drawLog(egg, 10.9).log) < rings(drawLog(egg, 11.6).log));
  // The layer is gone by the end.
  assert.equal(drawLog(egg, LAST_FRAME).log.length, 0);
});

test('May 4: one brief flash, never a strobe', () => {
  assert.ok(FLASH.peak <= 0.65, 'restrained peak');
  const samples = [];
  for (let t = -0.5; t <= 4; t += 0.005) samples.push(flashAlpha(t));
  assert.equal(samples[0], 0);
  assert.ok(samples[samples.length - 1] < 0.001);
  let peaks = 0;
  for (let i = 1; i < samples.length - 1; i++) if (samples[i] > samples[i - 1] && samples[i] >= samples[i + 1] && samples[i] > 0.05) peaks++;
  assert.equal(peaks, 1, 'exactly one flash');
  const above = samples.filter((v) => v > 0.1).length * 0.005;
  assert.ok(above < 0.6, `bright for ${above.toFixed(2)} s`);
  // Full-scene flashes per second stay far below the 3/s photosensitivity guideline: this is 1 in the whole render.
  const egg = makeEgg(may4Plan());
  const flashFills = (t) => drawLog(egg, t).log.filter((e, i, l) => e[0] === 'fillRect' && l[i - 1] && l[i - 1][0] === '=fillStyle' && l[i - 1][1] === 'rgb(255, 248, 230)').length;
  const total = Array.from({ length: 450 }, (_, i) => flashFills(i / 30)).filter(Boolean).length;
  assert.ok(total >= 1 && total <= 30, `${total} frames carry the flash`);
});

test('May 4: reduced motion is a still scene: no flash, no explosion, nothing moves or twinkles', () => {
  const rm = makeEgg(may4Plan({ reducedMotion: true }));
  const norm = (t) => drawLog(rm, t).log.filter((e) => !e[0].startsWith('=globalAlpha')).map((e) => JSON.stringify(e)).join('|');
  assert.equal(norm(3), norm(8), 'identical while visible');
  assert.equal(norm(8), norm(11.4), 'no explosion at 11 s');
  assert.ok(!drawLog(rm, 11.2).log.some((e) => e[0] === '=fillStyle' && e[1] === 'rgb(255, 248, 230)'), 'no flash');
  const live = makeEgg(may4Plan());
  const normLive = (t) => drawLog(live, t).log.filter((e) => !e[0].startsWith('=globalAlpha')).map((e) => JSON.stringify(e)).join('|');
  assert.notEqual(normLive(3), normLive(8), 'control: the normal scene moves');
});

test('both formats and a very low sky still produce a scene that fits', () => {
  for (const format of ['reels', 'post']) for (const plan of [winterPlan(), may4Plan()]) {
    const layout = layoutFor(format);
    const tiny = createEasterEgg(plan, {
      seed: 's', layout, frame: frameFor(format),
      skyline: skylineFor(layout.scene.w, layout.scene.h).map(([x, y]) => [x, 60 + 20 * Math.sin(x / 90) + (y - y)]), // hills right under the tape
    });
    for (const t of [3, 8, 11.3, 12.2]) assert.doesNotThrow(() => tiny.draw(recorder(), t), `${format}/${plan.key}/${t}`);
    if (plan.key === 'may4') assert.ok(tiny.scene.ds.r >= 22, 'Death Star shrinks rather than overlapping');
  }
});

// --------------------------------------------------------------- export dialog choice

import { planForChoice, describePlan, EASTER_CHOICES } from '../src/easter/index.js';

test('dialog choice: automatic follows the date and the preview link', () => {
  assert.equal(planForChoice('auto', { now: at('2026-09-29') }), null);
  assert.equal(planForChoice('auto', { now: at('2026-12-24') }).santa, true);
  assert.equal(planForChoice('auto', { now: at('2027-05-04') }).key, 'may4');
  assert.equal(planForChoice('auto', { now: at('2026-09-29'), search: '?easterEgg=may4' }).key, 'may4');
  assert.equal(planForChoice('anything-else', { now: at('2026-12-24') }).key, 'winter', 'unknown behaves like auto');
});

test('dialog choice: none, and forced events on any date', () => {
  const now = at('2026-09-29');
  assert.equal(planForChoice('off', { now: at('2026-12-24') }), null, 'off wins on an event day');
  assert.deepEqual([planForChoice('winter', { now }).key, planForChoice('winter', { now }).santa], ['winter', false]);
  const santa = planForChoice('santa', { now });
  assert.deepEqual([santa.key, santa.santa, santa.date], ['winter', true, '2026-12-24']);
  assert.deepEqual([planForChoice('may4', { now }).key, planForChoice('may4', { now }).date], ['may4', '2026-05-04']);
});

test('dialog choice: a forced event ignores the link event but keeps reduced motion', () => {
  const now = at('2026-09-29');
  assert.equal(planForChoice('may4', { now, search: '?easterEgg=winter&easterDate=2026-12-24' }).key, 'may4');
  assert.equal(planForChoice('winter', { now, search: '?easterEgg=santa' }).santa, false);
  assert.equal(planForChoice('may4', { now, reducedMotion: true }).reducedMotion, true, 'system preference');
  assert.equal(planForChoice('may4', { now, reducedMotion: true, search: '?reducedMotion=0' }).reducedMotion, false, 'link override');
});

test('dialog choices are the five documented ones, and plans are described for the dialog', () => {
  assert.deepEqual(EASTER_CHOICES.map((c) => c.value), ['auto', 'off', 'winter', 'santa', 'may4']);
  assert.equal(describePlan(null), 'No event on this date');
  assert.match(describePlan(planForChoice('santa', { now: at('2026-09-29') })), /Santa.*2026-12-24/);
  assert.match(describePlan(planForChoice('may4', { now: at('2026-09-29'), reducedMotion: true })), /May the Fourth.*reduced motion/);
});
