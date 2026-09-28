// UI controller: wires the engine (in a worker), the WebGL scene and the map.

import { TerrainModel } from '../engine/terrainModel.js';
import { SeedManager } from '../engine/rng.js';
import { scrambleLabels } from '../engine/scramble.js';
import { DIFFICULTIES } from '../engine/difficulty.js';
import { TerrainRenderer } from '../render/webglTerrain.js';
import { MapRenderer } from '../render/mapRenderer.js';
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

function requestQuiz(seed, difficulty, variant = 0) {
  const id = ++state.requestId;
  return new Promise((resolve, reject) => {
    const w = getWorker();
    if (!w) {
      // Fallback: generate on the main thread.
      import('../engine/quiz.js').then(({ generateQuiz }) => {
        setTimeout(() => {
          try { resolve(generateQuiz({ seed, difficulty, variant })); } catch (e) { reject(e); }
        }, 30);
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
    w.postMessage({ id, seed, difficulty, variant });
  });
}

async function load(seed, difficulty, variant = 0, scramble = 0) {
  $('seed').value = seed;
  $('difficulty').value = difficulty;
  setLoading(true, difficulty === 'master' ? 'Searching for a devious question…' : 'Generating terrain…');
  setAnswersEnabled(false);
  const myId = state.requestId + 1;
  let quiz;
  try {
    quiz = await requestQuiz(seed, difficulty, variant);
  } catch (err) {
    console.error(err);
    setLoading(true, `Generation failed: ${err.message}`);
    return;
  }
  if (myId !== state.requestId) return; // superseded by a newer request
  state.baseQuiz = quiz;
  show(scramble ? scrambleLabels(quiz, scramble) : quiz);
  updateHash();
}

function updateHash() {
  const q = state.quiz;
  if (!q) return;
  history.replaceState(null, '', `#seed=${encodeURIComponent(q.seed)}&d=${q.difficulty}${q.variant ? `&v=${q.variant}` : ''}${q.scramble ? `&s=${q.scramble}` : ''}`);
}

function show(quiz) {
  state.quiz = quiz;
  state.answered = false;
  state.chosen = null;
  state.viewing = null;
  const t = quiz.terrain;
  state.model = new TerrainModel({ size: t.size, n: t.n, heights: t.heights, seed: t.modelSeed });

  $('facing-text').textContent = quiz.heading.text;
  $('facing-arrow').textContent = quiz.heading.mode === 'exact' ? '' : quiz.heading.arrow;
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
    options: quiz.options,
    rotation: state.settings.northUp ? 0 : quiz.mapRotation,
    landmarks: quiz.landmarks,
  });
  map.setOverlays(state.settings);

  renderAnswerButtons();
  renderFacts();
  setLoading(false);
  setAnswersEnabled(true);
}

function renderAnswerButtons() {
  const answers = $('answers');
  answers.innerHTML = '';
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
  if (state.settings.tape) drawCompassTape($('tape'), camera, { exact: state.quiz.heading.mode === 'exact' });
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

function viewFrom(label) {
  const quiz = state.quiz;
  const o = quiz.options.find((p) => p.label === label);
  const cam = { ...quiz.camera, x: o.x, y: o.y, z: state.model.getElevation(o.x, o.y) + quiz.camera.eyeHeight };
  renderScene(cam);
  map.setViewing({ ...cam, color: o.correct ? '#5fd08a' : '#ff9f5e' });
  const badge = $('viewing-badge');
  badge.hidden = false;
  badge.textContent = `Viewing from ${label}${o.correct ? ' — true position' : ' — distractor'}`;
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
    ['Heading', `${String(Math.round(q.camera.heading)).padStart(3, '0')}° (${q.heading.mode})`],
    ['Field of view', `${q.camera.fov}° · eye ${q.camera.eyeHeight} m`],
    ['Relief', `${Math.round(q.terrain.min)}–${Math.round(q.terrain.max)} m`],
    ['Contours', `${q.terrain.contourInterval} m (index every ${q.terrain.contourInterval * 5} m)`],
    ['Map', q.mapRotation && !state.settings.northUp ? `rotated ${q.mapRotation}° (see N arrow)` : 'north-up'],
    ['Terrain', q.terrain.archetypes.map((a) => a.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')],
    ['Confidence', `${Math.round(q.validation.confidence * 100)}%${q.lowConfidence ? ' (below threshold)' : ''}`],
    ['Hardness', `${Math.round(q.hardness * 100)}%${q.stats.questionsCompared ? ` (hardest of ${q.stats.questionsCompared} valid questions)` : ''}`],
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
  load(SeedManager.randomSeed(), $('difficulty').value);
}

/**
 * Move the letters between the answer points (points and view unchanged).
 * Only before answering, so the result stays meaningful.
 */
function scrambleOptions() {
  const q = state.quiz;
  if (!q || state.answered) return;
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
  const difficulty = $('difficulty').value;
  const sameTerrain = difficulty === q.difficulty && $('seed').value.trim() === q.seed;
  load(q.seed, difficulty, sameTerrain ? (q.variant || 0) + 1 : 0);
}

$('controls').addEventListener('submit', (e) => {
  e.preventDefault();
  const seed = $('seed').value.trim() || SeedManager.randomSeed();
  load(seed, $('difficulty').value);
});
$('new-quiz').addEventListener('click', newQuiz);
$('new-positions').addEventListener('click', newPositions);
$('scramble').addEventListener('click', scrambleOptions);
$('difficulty').addEventListener('change', () => load($('seed').value.trim() || SeedManager.randomSeed(), $('difficulty').value));
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
  const o = q.options.find((p) => p.label === active.dataset.view);
  return { ...q.camera, x: o.x, y: o.y, z: state.model.getElevation(o.x, o.y) + q.camera.eyeHeight };
}

document.addEventListener('keydown', (e) => {
  if ($('export-dialog').open) return;
  if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toUpperCase();
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
  return { seed: p.get('seed'), difficulty: d && DIFFICULTIES[d] ? d : null, variant: v, scramble: sc };
}

window.addEventListener('hashchange', () => {
  const { seed, difficulty, variant, scramble } = parseHash();
  if (seed && (seed !== state.quiz?.seed || difficulty !== state.quiz?.difficulty || variant !== (state.quiz?.variant || 0) || scramble !== (state.quiz?.scramble || 0))) load(seed, difficulty || 'medium', variant, scramble);
});

renderScore();
const initial = parseHash();
load(initial.seed || SeedManager.randomSeed(), initial.difficulty || store.get('otq.difficulty', 'medium'), initial.seed ? initial.variant : 0, initial.seed ? initial.scramble : 0);
$('difficulty').addEventListener('change', () => store.set('otq.difficulty', $('difficulty').value));
