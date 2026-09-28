// UI controller: wires the engine (in a worker), the WebGL scene and the map.

import { TerrainModel } from '../engine/terrainModel.js';
import { SeedManager } from '../engine/rng.js';
import { scrambleLabels } from '../engine/scramble.js';
import { DIFFICULTIES, TUNABLES, tunableValue, encodeTuning, decodeTuning } from '../engine/difficulty.js';
import { TerrainRenderer } from '../render/webglTerrain.js';
import { MapRenderer, quizMarkers } from '../render/mapRenderer.js';
import { drawCompassTape } from '../render/compassTape.js';
import { ExportComposer } from '../export/composer.js';
import { encodeCanvasVideo, pickVideoPath } from '../export/recorder.js';

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const state = {
  quiz: null,
  model: null,
  answered: false,
  chosen: null,
  viewing: null,
  score: store.get('otq.score', { correct: 0, total: 0, streak: 0 }),
  settings: store.get('otq.settings', { northUp: false, tape: true, hillshade: false, landforms: false, drainage: false }),
  requestId: 0,
};

let renderer = null;
try {
  renderer = new TerrainRenderer($('scene'));
} catch (err) {
  $('loading-text').textContent = `WebGL unavailable: ${err.message}`;
}
const map = new MapRenderer($('map'), { onPick: (label) => answer(label) });

// ---------------------------------------------------------------- generation

let worker = null;
function getWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch {
    worker = false;
  }
  return worker;
}

function requestQuiz({ seed, difficulty, variant = 0, mode, headingMode, tuning }) {
  const id = ++state.requestId;
  return new Promise((resolve, reject) => {
    const w = getWorker();
    if (!w) {
      // Fallback: generate on the main thread.
      import('../engine/quiz.js').then(({ generate }) => {
        setTimeout(() => generate({ seed, difficulty, variant, mode, headingMode, tuning }).then(resolve, reject), 30);
      }, reject);
      return;
    }
    const onMessage = (e) => {
      if (e.data.id !== id) return;
      if (e.data.type === 'progress') { $('loading-text').textContent = `${e.data.message}…`; return; }
      w.removeEventListener('message', onMessage);
      if (e.data.type === 'result') resolve(e.data.quiz);
      else reject(new Error(e.data.message));
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, seed, difficulty, variant, mode, headingMode, tuning });
  });
}

/**
 * req: { seed, difficulty, variant, scramble, mode, headingMode }.
 * Missing fields come from the controls.
 */
async function load(req) {
  const r = {
    seed: req.seed || SeedManager.randomSeed(),
    difficulty: req.difficulty || $('difficulty').value,
    variant: req.variant || 0,
    scramble: req.scramble || 0,
    mode: req.mode || $('mode').value,
    headingMode: req.headingMode || $('heading-mode').value,
    tuning: req.tuning || activeTuning(),
  };
  $('seed').value = r.seed;
  $('difficulty').value = r.difficulty;
  $('mode').value = r.mode;
  $('heading-mode').value = r.headingMode;
  syncControls();
  setLoading(true, r.difficulty === 'master' ? 'Searching for a devious question…' : 'Generating terrain…');
  setAnswersEnabled(false);
  const myId = state.requestId + 1;
  let quiz;
  try {
    quiz = await requestQuiz({ ...r, headingMode: r.headingMode === 'auto' ? null : r.headingMode });
  } catch (err) {
    console.error(err);
    setLoading(true, `Generation failed: ${err.message}`);
    return;
  }
  if (myId !== state.requestId) return; // superseded by a newer request
  quiz.headingChoice = r.headingMode;
  quiz.tuning = r.tuning;
  state.baseQuiz = quiz;
  show(r.scramble && quiz.mode !== 'facing' ? scrambleLabels(quiz, r.scramble) : quiz);
  updateHash();
}

function updateHash() {
  const q = state.quiz;
  if (!q) return;
  const parts = [`seed=${encodeURIComponent(q.seed)}`, `d=${q.difficulty}`];
  if (q.mode === 'facing') parts.push('m=facing');
  else if (q.headingChoice && q.headingChoice !== 'auto') parts.push(`h=${q.headingChoice}`);
  if (q.variant) parts.push(`v=${q.variant}`);
  if (q.tuning && Object.keys(q.tuning).length) parts.push(`dev=${encodeURIComponent(encodeTuning(q.tuning))}`);
  if (q.scramble) parts.push(`s=${q.scramble}`);
  history.replaceState(null, '', `#${parts.join('&')}`);
}

/** Show only the controls that apply to the selected mode. */
function syncControls() {
  const facing = $('mode').value === 'facing';
  $('heading-field').hidden = facing;
  $('scramble').hidden = facing;
  if (typeof dev !== 'undefined') renderDevPanel();
}

function show(quiz) {
  state.quiz = quiz;
  state.answered = false;
  state.chosen = null;
  state.viewing = null;
  const t = quiz.terrain;
  state.model = new TerrainModel({ size: t.size, n: t.n, heights: t.heights, seed: t.modelSeed });

  const facing = quiz.mode === 'facing';
  $('quiz-title').textContent = facing ? 'WHICH WAY ARE YOU FACING?' : 'WHERE ARE YOU?';
  $('quiz-title').classList.toggle('long', facing);
  $('facing-text').textContent = facing ? 'YOU ARE AT THE MARKED POINT' : quiz.heading.text;
  $('facing-arrow').textContent = facing || quiz.heading.mode === 'exact' ? '' : quiz.heading.arrow;
  $('prompt').textContent = facing ? 'You stand at the marked point. Which of the 8 directions are you looking in?'
    : 'You are at one of the marked points, facing the direction shown. Which one?';
  $('credit').textContent = `seed ${quiz.seed}${quiz.variant ? ` · positions #${quiz.variant}` : ''} · ${DIFFICULTIES[quiz.difficulty].label.toLowerCase()} · ${Math.round(t.size / 1000 * 10) / 10} km × ${Math.round(t.size / 1000 * 10) / 10} km`;
  $('viewing-badge').hidden = true;
  $('result').hidden = true;
  $('prompt').hidden = false;

  if (renderer) {
    renderer.setTerrain(state.model);
    renderScene(quiz.camera);
  }
  map.setData({
    model: state.model,
    interval: t.contourInterval,
    options: quizMarkers(quiz),
    rotation: state.settings.northUp ? 0 : quiz.mapRotation,
    landmarks: quiz.landmarks,
  });
  map.setOverlays(state.settings);

  renderAnswerButtons();
  renderFacts();
  setLoading(false);
  setAnswersEnabled(true);
}

const ROSE = ['NW', 'N', 'NE', 'W', '', 'E', 'SW', 'S', 'SE'];

function renderAnswerButtons() {
  const answers = $('answers');
  answers.innerHTML = '';
  const facing = state.quiz.mode === 'facing';
  answers.classList.toggle('rose', facing);
  if (facing) {
    for (const label of ROSE) {
      if (!label) {
        const c = document.createElement('div');
        c.className = 'rose-centre';
        c.setAttribute('aria-hidden', 'true');
        answers.append(c);
        continue;
      }
      const b = document.createElement('button');
      b.className = 'answer dir';
      b.type = 'button';
      b.textContent = label;
      b.dataset.label = label;
      b.addEventListener('click', () => answer(label));
      answers.append(b);
    }
    $('scramble').disabled = true;
    return;
  }
  for (const o of state.quiz.options) {
    const b = document.createElement('button');
    b.className = 'answer';
    b.type = 'button';
    b.textContent = o.label;
    b.dataset.label = o.label;
    b.addEventListener('click', () => answer(o.label));
    answers.append(b);
  }
  $('scramble').disabled = state.answered;
}

function renderScene(camera) {
  if (!renderer) return;
  renderer.render(camera);
  // In "Which way?" the bearing tape would give the answer away.
  const tapeAllowed = state.quiz.mode !== 'facing' || state.answered;
  if (state.settings.tape && tapeAllowed) drawCompassTape($('tape'), camera, { exact: state.quiz.heading.mode === 'exact' });
  else $('tape').getContext('2d').clearRect(0, 0, $('tape').width, $('tape').height);
}

// ---------------------------------------------------------------- answering

function answer(label) {
  if (!state.quiz || state.answered) return;
  const quiz = state.quiz;
  if (!quiz.options.some((o) => o.label === label)) return;
  state.answered = true;
  state.chosen = label;
  const right = label === quiz.correctLabel;
  state.score.total++;
  if (right) { state.score.correct++; state.score.streak++; } else state.score.streak = 0;
  store.set('otq.score', state.score);
  renderScore();

  for (const b of $('answers').children) {
    b.disabled = true;
    if (b.dataset.label === quiz.correctLabel) b.classList.add('correct');
    else if (b.dataset.label === label) b.classList.add('wrong');
  }
  map.setReveal({ chosen: label, camera: quiz.camera });
  $('scramble').disabled = true;
  $('prompt').hidden = true;
  renderFacts();
  if (quiz.mode === 'facing') { showFacingResult(label, right); return; }

  const res = $('result');
  res.hidden = false;
  const verdict = right ? `<div class="verdict good">Correct — you were at ${quiz.correctLabel}.</div>`
    : `<div class="verdict bad">Not quite — you were at ${quiz.correctLabel}.</div>`;
  const cue = (o) => (o.cue ? `${String(o.cue.bearing).padStart(3, '0')}°: skyline ${Math.abs(o.cue.delta).toFixed(1)}° ${o.cue.delta > 0 ? 'higher' : 'lower'}` : '—');
  const rows = quiz.options.map((o) => `<tr><td><strong>${o.label}</strong>${o.correct ? ' ✓' : ''}</td><td>${o.landform}</td><td>${Math.round(o.z)} m</td><td>${o.correct ? '—' : `${o.D.toFixed(1)}°`}</td><td>${o.correct ? 'what you saw' : cue(o)}</td></tr>`).join('');
  res.innerHTML = `${verdict}
    <p>Compare the views: the dashed wedge on the map shows what each position looks at.</p>
    <div class="views">${quiz.options.map((o) => `<button type="button" class="btn ghost" data-view="${o.label}">View from ${o.label}${o.correct ? ' (true)' : ''}</button>`).join('')}</div>
    <table><tr><th>Point</th><th>Landform</th><th>Elevation</th><th>View diff.</th><th>Key difference</th></tr>${rows}</table>
    <p class="note">Key difference: the bearing where that point's skyline would differ most from the view you were shown.</p>
    <button type="button" class="btn primary" id="next">Next quiz (N)</button>`;
  res.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewFrom(b.dataset.view)));
  $('next').addEventListener('click', newQuiz);
  highlightView(quiz.correctLabel);
}

function showFacingResult(label, right) {
  const quiz = state.quiz;
  const res = $('result');
  res.hidden = false;
  const verdict = right ? `<div class="verdict good">Correct — you were facing ${quiz.correctLabel}.</div>`
    : `<div class="verdict bad">Not quite — you were facing ${quiz.correctLabel}, not ${label}.</div>`;
  // Where in the frame the difference is, since the other direction's view shares only the screen position.
  const side = (o) => {
    const rel = ((o.cue.bearing - quiz.camera.heading + 540) % 360) - 180;
    return rel < -quiz.camera.fov / 6 ? 'left side' : rel > quiz.camera.fov / 6 ? 'right side' : 'centre';
  };
  const cue = (o) => (o.cue ? `${side(o)}: skyline ${Math.abs(o.cue.delta).toFixed(1)}° ${o.cue.delta > 0 ? 'higher' : 'lower'}` : '—');
  const ranked = quiz.options.filter((o) => !o.correct).sort((a, b) => a.D - b.D);
  const rows = ranked.slice(0, 3).map((o) => `<tr><td><strong>${o.label}</strong>${o.label === label ? ' (your pick)' : ''}</td><td>${o.D.toFixed(1)}°</td><td>${cue(o)}</td></tr>`).join('');
  res.innerHTML = `${verdict}
    <p>Look in each direction from the point; the dashed wedge on the map shows the view.</p>
    <div class="views">${quiz.options.map((o) => `<button type="button" class="btn ghost" data-view="${o.label}">${o.label}${o.correct ? ' ✓' : ''}</button>`).join('')}</div>
    <table><tr><th>Most similar wrong directions</th><th>View diff.</th><th>Key difference</th></tr>${rows}</table>
    <p class="note">Key difference: where in the frame the skyline in that direction would differ most from the view you were shown.</p>
    <button type="button" class="btn primary" id="next">Next quiz (N)</button>`;
  res.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewFrom(b.dataset.view)));
  $('next').addEventListener('click', newQuiz);
  highlightView(quiz.correctLabel);
  renderScene(quiz.camera);
}

/** Camera for an answer option: another point (where-am-i) or another heading (facing). */
function optionCamera(label) {
  const quiz = state.quiz;
  const o = quiz.options.find((p) => p.label === label);
  if (quiz.mode === 'facing') return { cam: { ...quiz.camera, heading: o.heading }, o };
  return { cam: { ...quiz.camera, x: o.x, y: o.y, z: state.model.getElevation(o.x, o.y) + quiz.camera.eyeHeight }, o };
}

function viewFrom(label) {
  const quiz = state.quiz;
  const { cam, o } = optionCamera(label);
  renderScene(cam);
  map.setViewing({ ...cam, color: o.correct ? '#5fd08a' : '#ff9f5e' });
  const badge = $('viewing-badge');
  badge.hidden = false;
  badge.textContent = quiz.mode === 'facing' ? `Facing ${label}${o.correct ? ' — true direction' : ''}`
    : `Viewing from ${label}${o.correct ? ' — true position' : ' — distractor'}`;
  highlightView(label);
}

function highlightView(label) {
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === label));
}

// ---------------------------------------------------------------- panels

function renderScore() {
  $('score-correct').textContent = state.score.correct;
  $('score-total').textContent = state.score.total;
  $('score-streak').textContent = state.score.streak;
}

function renderFacts() {
  const q = state.quiz;
  const facts = [
    ['Mode', q.mode === 'facing' ? 'Which way are you facing?' : 'Where are you?'],
    ['Heading', q.mode === 'facing' && !state.answered ? 'hidden until you answer' : `${String(Math.round(q.camera.heading)).padStart(3, '0')}° (${q.mode === 'facing' ? 'one of 8 directions' : q.heading.mode})`],
    ['Field of view', `${q.camera.fov}° · eye ${q.camera.eyeHeight} m`],
    ['Relief', `${Math.round(q.terrain.min)}–${Math.round(q.terrain.max)} m`],
    ['Contours', `${q.terrain.contourInterval} m (index every ${q.terrain.contourInterval * 5} m)`],
    ['Map', q.mapRotation && !state.settings.northUp ? `rotated ${q.mapRotation}° (see N arrow)` : 'north-up'],
    ['Terrain', q.terrain.archetypes.map((a) => a.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')],
    ['Confidence', `${Math.round(q.validation.confidence * 100)}%${q.lowConfidence ? ' (below threshold)' : ''}`],
    ['Hardness', `${Math.round(q.hardness * 100)}%${q.stats.questionsCompared ? ` (hardest of ${q.stats.questionsCompared} valid questions)` : ''}`],
    ...(q.tuning && Object.keys(q.tuning).length ? [['Tuning', `developer overrides: ${Object.entries(q.tuning).map(([k, v]) => `${k}=${v}`).join(', ')}`]] : []),
    ['Generated', `${q.stats.ms} ms · ${q.stats.viewpointsEvaluated} views scored`],
  ];
  $('facts').innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const comp = [
    ['Skyline complexity', q.quality.skylineComplexity],
    ['Landmark visibility', q.quality.landmarkVisibility],
    ['Terrain variation', q.quality.terrainVariation],
    ['Ridge / valley info', q.quality.ridgeValleyInformation],
    ['Foreground info', q.quality.foregroundInformation],
    ['Orientation identifiability', q.quality.orientationIdentifiability],
    ['Occlusion penalty', -q.quality.occlusionPenalty],
    ['Total quality', q.quality.total],
    ['Uniqueness', q.validation.uniqueness],
  ];
  $('quality').innerHTML = comp.map(([k, v]) => `<div class="bar"><span>${k}</span><span class="track"><span class="fill${v < 0 ? ' neg' : ''}" style="width:${Math.min(100, Math.abs(v) * 100).toFixed(0)}%"></span></span><span class="v">${v.toFixed(2)}</span></div>`).join('');
  $('gen-log').textContent = q.log.map((l) => l.stage === 'terrain'
    ? `terrain #${l.attempt}: rejected — ${l.issues.join('; ')}`
    : `terrain #${l.attempt} view ${l.try}: ${l.ok ? 'accepted' : 'rejected'} (confidence ${l.confidence})${l.issues.length ? ' — ' + l.issues.join('; ') : ''}`).join('\n');
}

function setLoading(on, text) {
  $('loading').classList.toggle('hidden', !on);
  if (text) $('loading-text').textContent = text;
}

function setAnswersEnabled(on) {
  for (const b of $('answers').children) b.disabled = !on;
}

// ---------------------------------------------------------------- controls

function newQuiz() {
  load({ seed: SeedManager.randomSeed() });
}

/**
 * Move the letters between the answer points (points and view unchanged).
 * Only before answering, so the result stays meaningful.
 */
function scrambleOptions() {
  const q = state.quiz;
  if (!q || state.answered || q.mode === 'facing') return;
  // Derived from the unscrambled quiz so "&s=N" in a link reproduces it.
  const quiz = scrambleLabels(state.baseQuiz, (q.scramble || 0) + 1);
  state.quiz = quiz;
  map.data.options = quiz.options;
  map.draw();
  renderAnswerButtons();
  updateHash();
  const btn = $('scramble');
  btn.classList.remove('flash'); void btn.offsetWidth; btn.classList.add('flash');
}

/** Same seed and terrain, next set of observer/answer positions. */
function newPositions() {
  if (!state.quiz) return;
  const q = state.quiz;
  const same = $('difficulty').value === q.difficulty && $('seed').value.trim() === q.seed
    && $('mode').value === q.mode && $('heading-mode').value === (q.headingChoice || 'auto');
  load({ seed: q.seed, variant: same ? (q.variant || 0) + 1 : 0 });
}

$('controls').addEventListener('submit', (e) => {
  e.preventDefault();
  load({ seed: $('seed').value.trim() });
});
$('new-quiz').addEventListener('click', newQuiz);
$('new-positions').addEventListener('click', newPositions);
$('scramble').addEventListener('click', scrambleOptions);
// Changing mode, difficulty or heading style keeps the seed, so the terrain carries over.
for (const id of ['difficulty', 'mode', 'heading-mode']) {
  $(id).addEventListener('change', () => { syncControls(); load({ seed: $('seed').value.trim() }); });
}
$('copy-link').addEventListener('click', async () => {
  const btn = $('copy-link');
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = 'Link copied';
  } catch {
    btn.textContent = location.href;
  }
  setTimeout(() => { btn.textContent = 'Copy link to this quiz'; }, 1600);
});

const toggles = { 'opt-northup': 'northUp', 'opt-tape': 'tape', 'opt-hillshade': 'hillshade', 'opt-landforms': 'landforms', 'opt-drainage': 'drainage' };
for (const [id, key] of Object.entries(toggles)) {
  const el = $(id);
  el.checked = !!state.settings[key];
  el.addEventListener('change', () => {
    state.settings[key] = el.checked;
    store.set('otq.settings', state.settings);
    $('legend').hidden = !state.settings.landforms;
    if (!state.quiz) return;
    if (key === 'northUp') {
      map.data.rotation = state.settings.northUp ? 0 : state.quiz.mapRotation;
      map.draw();
      renderFacts();
    } else if (key === 'tape') {
      renderScene(currentCamera());
    } else {
      map.setOverlays(state.settings);
    }
  });
}
$('legend').hidden = !state.settings.landforms;

function currentCamera() {
  const q = state.quiz;
  if (!state.answered) return q.camera;
  const active = document.querySelector('[data-view].active');
  if (!active) return q.camera;
  return optionCamera(active.dataset.view).cam;
}

document.addEventListener('keydown', (e) => {
  if ($('export-dialog').open) return;
  if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toUpperCase();
  if (state.quiz?.mode === 'facing') {
    // Q W E / A · D / Z X C laid out like the compass rose.
    const dir = { Q: 'NW', W: 'N', E: 'NE', A: 'W', D: 'E', Z: 'SW', X: 'S', C: 'SE' }[k];
    if (dir) { state.answered ? viewFrom(dir) : answer(dir); return; }
  }
  if (k === 'N') newQuiz();
  else if (k === 'P') newPositions();
  else if (k === 'S') scrambleOptions();
  else if (/^[A-E]$/.test(k)) {
    if (state.answered) { if (state.quiz.options.some((o) => o.label === k)) viewFrom(k); }
    else answer(k);
  }
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.quiz) return;
    renderScene(currentCamera());
    map.draw();
  }, 60);
});

// ---------------------------------------------------------------- export

const exportUi = { composer: null, raf: 0, start: 0, busy: false, last: null };

function exportOptions() {
  const form = $('export-form');
  return {
    format: form.querySelector('[name="format"]:checked').value,
    weather: [...form.querySelectorAll('[name="weather"]:checked')].map((el) => el.value),
    handle: $('export-handle').value.trim(),
    caption: $('export-caption').checked,
    tape: $('export-tape').checked,
    reveal: $('export-reveal').checked,
    northUp: state.settings.northUp,
    duration: 15,
  };
}

function restoreExportOptions() {
  const saved = store.get('otq.export', null);
  if (!saved) return;
  const form = $('export-form');
  const fmt = form.querySelector(`[name="format"][value="${saved.format}"]`);
  if (fmt) fmt.checked = true;
  form.querySelectorAll('[name="weather"]').forEach((el) => { el.checked = (saved.weather || []).includes(el.value); });
  $('export-handle').value = saved.handle || '';
  $('export-caption').checked = saved.caption !== false;
  $('export-tape').checked = saved.tape !== false;
  $('export-reveal').checked = saved.reveal !== false;
}

function previewLoop() {
  const c = exportUi.composer;
  if (!c) return;
  const d = c.options.duration;
  const t = ((performance.now() - exportUi.start) / 1000) % d;
  c.animated = true;
  c.drawFrame(t, { reveal: c.options.reveal && t >= d - 3 });
  exportUi.raf = requestAnimationFrame(previewLoop);
}

function startPreview() {
  cancelAnimationFrame(exportUi.raf);
  exportUi.start = performance.now();
  exportUi.raf = requestAnimationFrame(previewLoop);
}

function stopPreview() { cancelAnimationFrame(exportUi.raf); }

function openExport() {
  if (!state.quiz || !renderer) return;
  restoreExportOptions();
  exportUi.composer?.dispose();
  exportUi.composer = new ExportComposer(state.quiz, state.model, { ...exportOptions(), canvas: $('export-canvas') });
  exportUi.last = null;
  $('export-share').hidden = true;
  $('export-dialog').showModal();
  exportUi.videoPath = null;
  $('export-video').disabled = true;
  pickVideoPath(1080, 1920).then((p) => {
    exportUi.videoPath = p;
    $('export-video').disabled = !p || exportUi.busy;
    setExportStatus(!p ? 'Video export is not supported in this browser; images still work.'
      : p.h264 ? '' : 'This browser cannot encode H.264: the video will be VP9/WebM, which Instagram may reject. Chrome, Edge or Safari give an Instagram-ready MP4.');
  });
  startPreview();
}

function closeExport() {
  if (exportUi.busy) return;
  stopPreview();
  exportUi.composer?.dispose();
  exportUi.composer = null;
  $('export-dialog').close();
}

function setExportStatus(text) { $('export-status').textContent = text; }

function exportName(suffix, ext) {
  const q = state.quiz;
  return `where-are-you-${q.seed}-${q.difficulty}${suffix}.${ext}`.replace(/[^a-z0-9._-]+/gi, '-');
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  exportUi.last = new File([blob], name, { type: blob.type });
  $('export-share').hidden = !(navigator.canShare && navigator.canShare({ files: [exportUi.last] }));
}

function setExportBusy(on) {
  exportUi.busy = on;
  for (const id of ['export-png', 'export-answer-png', 'export-video', 'export-close']) $(id).disabled = on || (id === 'export-video' && !exportUi.videoPath);
  $('export-form').querySelectorAll('input').forEach((el) => { el.disabled = on; });
}

async function exportImage(reveal) {
  const c = exportUi.composer;
  stopPreview();
  const blob = await c.toImage({ reveal });
  download(blob, exportName(reveal ? '-answer' : '', 'png'));
  setExportStatus(`Saved ${exportName(reveal ? '-answer' : '', 'png')}`);
  startPreview();
}

async function exportVideo() {
  const c = exportUi.composer;
  stopPreview();
  setExportBusy(true);
  const progress = $('export-progress');
  progress.hidden = false;
  setExportStatus(exportUi.videoPath?.kind === 'recorder' ? 'Recording 15 s in real time — keep this tab visible…' : 'Rendering 450 frames…');
  try {
    c.animated = true;
    const d = c.options.duration;
    const { blob, extension, h264 } = await encodeCanvasVideo(c.canvas, (t) => c.drawFrame(t, { reveal: c.options.reveal && t >= d - 3 }), {
      duration: d, fps: 30, onProgress: (p) => { progress.value = p; },
    });
    const name = exportName('', extension);
    download(blob, name);
    setExportStatus(h264 ? `Saved ${name} (H.264, ${(blob.size / 1e6).toFixed(1)} MB)` : `Saved ${name}. Not H.264, so convert it to MP4/H.264 before uploading to Instagram.`);
  } catch (err) {
    setExportStatus(`Recording failed: ${err.message}`);
  } finally {
    progress.hidden = true;
    setExportBusy(false);
    startPreview();
  }
}

$('open-export').addEventListener('click', openExport);
$('export-close').addEventListener('click', closeExport);
$('export-dialog').addEventListener('cancel', (e) => { e.preventDefault(); closeExport(); });
$('export-form').addEventListener('change', () => {
  const opts = exportOptions();
  store.set('otq.export', opts);
  exportUi.composer?.setOptions(opts);
  startPreview();
});
$('export-handle').addEventListener('input', () => {
  const opts = exportOptions();
  store.set('otq.export', opts);
  exportUi.composer?.setOptions({ handle: opts.handle });
});
$('export-png').addEventListener('click', () => exportImage(false));
$('export-answer-png').addEventListener('click', () => exportImage(true));
$('export-video').addEventListener('click', exportVideo);
$('export-share').addEventListener('click', async () => {
  if (!exportUi.last) return;
  try { await navigator.share({ files: [exportUi.last], title: 'Where are you?' }); } catch { /* dismissed */ }
});

// ---------------------------------------------------------------- boot

function parseHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const d = p.get('d');
  const v = Math.max(0, Math.floor(+p.get('v') || 0));
  const sc = Math.max(0, Math.floor(+p.get('s') || 0));
  const h = p.get('h');
  return {
    seed: p.get('seed'), difficulty: d && DIFFICULTIES[d] ? d : null, variant: v, scramble: sc,
    mode: p.get('m') === 'facing' ? 'facing' : 'where-am-i',
    headingMode: ['exact', 'intercardinal', 'cardinal'].includes(h) ? h : 'auto',
    tuning: p.has('dev') ? decodeTuning(p.get('dev')) : null,
  };
}

window.addEventListener('hashchange', () => {
  const h = parseHash();
  const q = state.quiz;
  if (h.seed && (h.seed !== q?.seed || h.difficulty !== q?.difficulty || h.variant !== (q?.variant || 0) || h.scramble !== (q?.scramble || 0)
    || h.mode !== q?.mode || h.headingMode !== (q?.headingChoice || 'auto')
    || encodeTuning(h.tuning || {}) !== encodeTuning(q?.tuning || {}))) { adoptLinkTuning(h.tuning); load({ ...h, difficulty: h.difficulty || 'medium' }); }
});

// ---------------------------------------------------------------- developer mode

const dev = store.get('otq.dev', { enabled: false, values: {} });

/** Overrides to send with a request (none unless developer mode is on). */
function activeTuning() {
  if (!dev.enabled) return {};
  return Object.fromEntries(Object.entries(dev.values).filter(([, v]) => v !== '' && v !== null && v !== undefined));
}

function saveDev() { store.set('otq.dev', dev); }

/** A link carrying &dev= switches developer mode on with those values. */
function adoptLinkTuning(tuning) {
  if (!tuning || !Object.keys(tuning).length) return;
  dev.enabled = true;
  dev.values = { ...tuning };
  saveDev();
  renderDevPanel();
}

function renderDevPanel() {
  $('dev-enabled').checked = dev.enabled;
  $('dev-form').hidden = !dev.enabled;
  const preset = DIFFICULTIES[$('difficulty').value] || DIFFICULTIES.medium;
  $('dev-difficulty').textContent = preset.label;
  const mode = $('mode').value;
  $('dev-fields').innerHTML = TUNABLES.map((t) => {
    const def = tunableValue(preset, t);
    const applies = def !== undefined && (!t.key.startsWith('facing') || mode === 'facing') && !(mode === 'facing' && ['minTrue', 'minSep', 'sameLandform', 'bandMin', 'bandTarget', 'bandMax', 'distractors', 'minConfidence'].includes(t.key));
    const v = dev.values[t.key];
    const label = `${t.label}${t.unit ? ` (${t.unit})` : ''}`;
    if (t.type === 'bool') {
      const checked = v === undefined || v === '' ? def : v === true || v === 'true';
      return `<label class="dev-field${applies ? '' : ' na'}"><span>${label}</span><input type="checkbox" data-key="${t.key}" ${checked ? 'checked' : ''}></label>`;
    }
    return `<label class="dev-field${applies ? '' : ' na'}" title="${applies ? '' : 'Not used by this difficulty / mode'}"><span>${label}</span><input type="number" data-key="${t.key}" min="${t.min}" max="${t.max}" step="${t.step}" placeholder="${def ?? '—'}" value="${v ?? ''}"></label>`;
  }).join('');
}

function readDevForm() {
  const preset = DIFFICULTIES[$('difficulty').value] || DIFFICULTIES.medium;
  const values = {};
  $('dev-fields').querySelectorAll('[data-key]').forEach((el) => {
    const t = TUNABLES.find((x) => x.key === el.dataset.key);
    if (t.type === 'bool') { if (el.checked !== tunableValue(preset, t)) values[t.key] = el.checked; }
    else if (el.value !== '') values[t.key] = el.value;
  });
  return values;
}

$('dev-enabled').addEventListener('change', () => {
  dev.enabled = $('dev-enabled').checked;
  saveDev();
  renderDevPanel();
  if (Object.keys(dev.values).length) load({ seed: $('seed').value.trim() });
});
$('dev-form').addEventListener('submit', (e) => {
  e.preventDefault();
  dev.values = readDevForm();
  saveDev();
  load({ seed: $('seed').value.trim(), variant: state.quiz?.variant || 0 });
});
$('dev-reset').addEventListener('click', () => {
  dev.values = {};
  saveDev();
  renderDevPanel();
  load({ seed: $('seed').value.trim(), variant: state.quiz?.variant || 0 });
});
for (const id of ['difficulty', 'mode']) $(id).addEventListener('change', renderDevPanel);

renderScore();
const initial = parseHash();
adoptLinkTuning(initial.tuning);
renderDevPanel();
if (initial.seed) load({ ...initial, difficulty: initial.difficulty || store.get('otq.difficulty', 'medium') });
else load({ difficulty: store.get('otq.difficulty', 'medium'), mode: store.get('otq.mode', 'where-am-i') });
$('difficulty').addEventListener('change', () => store.set('otq.difficulty', $('difficulty').value));
$('mode').addEventListener('change', () => store.set('otq.mode', $('mode').value));
