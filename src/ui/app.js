// UI controller: wires the engine (in a worker), the WebGL scene and the map.

import { TerrainModel } from '../engine/terrainModel.js';
import { SeedManager } from '../engine/rng.js';
import { scrambleLabels } from '../engine/scramble.js';
import { explanationComparisons } from '../engine/answerExplanation.js';
import { appendAnswerExplanation } from './answerExplanation.js';
import { DIFFICULTIES, TUNABLES, tunableValue, encodeTuning, decodeTuning } from '../engine/difficulty.js';
import { getLookalikePreset, DIRECTIONS } from '../engine/lookalikeQuiz.js';
import { normaliseGridSize, normaliseGridChallenge, parseCell, headingHidden, usesGrid } from '../engine/gridQuiz.js';
import { normaliseFriendChallenge, normaliseFriendAnswer, friendObserver, friendOptionCamera } from '../engine/friendQuiz.js';
import { FRIEND_SKINS, normaliseFriendSkin } from '../engine/friendAppearance.js';
import { friendSceneFrame } from '../export/friendZoom.js';
import { normaliseMovement, trailFrame } from '../engine/trailMotion.js';
import { TRAIL_COLORS, normaliseTrailAnswer } from '../engine/trailQuiz.js';
import { KNIVES, normaliseAppearance } from '../render/knifeClips.js';
import { TrailPlayback } from './trailPlayback.js';
import { usesSunWatch, supportsSunWatch, sunWatchFrame, SUN_WATCH_DURATION } from '../engine/sunWatch.js';
import { sniperFrame, sniperWeather, SNIPER_DURATION, SNIPER_TIMING } from '../engine/sniper.js';
import { drawSniperOverlay } from '../render/sniperOverlay.js';
import { TerrainRenderer } from '../render/webglTerrain.js';
import { CONDITIONS, WINDS, DENSITIES, normaliseEnvironment, weatherParams, environmentAnimated } from '../render/environment.js';
import { TEXTURE_MODES, terrainTexture } from '../render/terrainTextures.js';
import { WORLDS, WORLD_CHOICES, normaliseWorld, worldLabel } from '../engine/worlds.js';
import { MapRenderer, quizMarkers } from '../render/mapRenderer.js';
import { drawCompassTape } from '../render/compassTape.js';
import { relativeBearing } from '../render/relativeBearing.js';
import { drawSkylineOverlay } from '../render/skylineOverlay.js';
import { ExportComposer, exportDuration } from '../export/composer.js';
import { planForChoice, describePlan, EASTER_CHOICES } from '../easter/index.js';
import { EXPORT_FPS, encodeCanvasVideo, pickVideoPath } from '../export/recorder.js';

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
  friendZoom: false,
  friendCinematicPlaying: false,
  friendCinematicTime: 0,
  trailTime: 0,
  sunTime: 0,
  appearance: normaliseAppearance(store.get('otq.appearance', {})),
  environment: normaliseEnvironment(store.get('otq.environment', {})),
  environmentStart: performance.now(),
  loading: true,
  score: store.get('otq.score', { correct: 0, total: 0, streak: 0 }),
  settings: store.get('otq.settings', { northUp: false, tape: true, hillshade: false, landforms: false, drainage: false }),
  requestId: 0,
};

let renderer = null;
let friendWaveRaf = 0, friendWaveStart = 0, friendCinematicStart = 0;
let lastAmbientFrame = 0;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
try {
  renderer = new TerrainRenderer($('scene'));
} catch (err) {
  console.error('Terrain renderer could not start:', err);
  $('scene-error').textContent = `3D view unavailable: ${err.message}`;
  $('scene-error').hidden = false;
}
const map = new MapRenderer($('map'), { onPick: (label) => {
  if (state.loading || state.answered) return;
  if (usesGrid(state.quiz)) selectCell(label);
  else answer(label);
} });


const trailPlayer = new TrailPlayback({
  draw: (t, playback) => {
    if (state.quiz?.mode !== 'trail' || state.loading) return;
    state.trailTime = t; renderScene(state.quiz.camera, playback);
  },
  onState: ({time, playing, duration}) => {
    state.trailTime = time;
    $('trail-play').textContent = playing ? 'Pause' : time >= duration ? 'Replay' : 'Play';
    $('trail-play').setAttribute('aria-pressed', String(playing));
    $('trail-time').textContent = `${time.toFixed(1)} / ${duration.toFixed(1)} s`;
    $('trail-scrub').value = String(time); $('trail-scrub').max = String(duration);
  },
});
/** Fixed 15-second sequences (sun & watch, sniper) share one player and timeline. */
const usesClip = (q) => usesSunWatch(q) || q?.mode === 'sniper';
const sunPlayer = new TrailPlayback({ duration: SUN_WATCH_DURATION,
  draw: (t) => { if (usesClip(state.quiz) && !state.loading) { state.sunTime = t; renderScene(currentCamera()); } },
  onState: ({ time, playing, duration }) => {
    state.sunTime = time;
    $('direction-play').textContent = playing ? 'Pause' : time >= duration ? 'Replay' : 'Play';
    $('direction-play').setAttribute('aria-pressed', String(playing));
    $('direction-time').textContent = `${time.toFixed(1)} / ${duration.toFixed(1)} s`;
    $('direction-scrub').value = String(time);
    $('direction-scrub').max = String(duration);
  },
});
$('direction-play').addEventListener('click', () => {
  if (!usesClip(state.quiz) || state.loading) return;
  if (sunPlayer.playing) sunPlayer.pause(); else sunPlayer.play();
});
$('direction-replay').addEventListener('click', () => { if (usesClip(state.quiz) && !state.loading) sunPlayer.replay(); });
$('direction-scrub').addEventListener('input', () => { if (usesClip(state.quiz) && !state.loading) sunPlayer.seek(Number($('direction-scrub').value)); });
$('trail-play').addEventListener('click', () => {
  if (state.loading || state.quiz?.mode !== 'trail') return;
  if (trailPlayer.playing) trailPlayer.pause(); else trailPlayer.play();
});
$('trail-replay').addEventListener('click', () => { if (!state.loading && state.quiz?.mode === 'trail') trailPlayer.replay(); });
$('trail-inspect').addEventListener('click', () => { if (!state.loading && state.quiz?.mode === 'trail') trailPlayer.inspect(); });
$('trail-scrub').addEventListener('input', () => { if (!state.loading && state.quiz?.mode === 'trail') trailPlayer.seek(Number($('trail-scrub').value)); });
document.addEventListener('visibilitychange', () => { if (document.hidden && state.quiz?.mode === 'trail') trailPlayer.pause(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && usesClip(state.quiz)) sunPlayer.pause(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopFriendWave(); else scheduleFriendWave(); });

function stopFriendWave() {
  cancelAnimationFrame(friendWaveRaf); friendWaveRaf = 0;
}
function scheduleFriendWave() {
  const friendActive = !usesSunWatch(state.quiz) && state.quiz?.mode === 'friend' && (state.quiz?.friend?.skin === 'conquest' ? state.friendCinematicPlaying : state.friendZoom);
  const ambientActive = !reducedMotion.matches && environmentAnimated(state.environment);
  if (friendWaveRaf || !renderer || (!friendActive && !ambientActive)
    || state.loading || document.hidden || $('export-dialog').open) return;
  friendWaveRaf = requestAnimationFrame((now) => {
    friendWaveRaf = 0;
    if (state.friendCinematicPlaying) {
      state.friendCinematicTime = Math.min(15, (performance.now() - friendCinematicStart) / 1000);
      if (state.friendCinematicTime >= 15) state.friendCinematicPlaying = false;
    }
    // Trail playback already renders its own frames. Static weather runs at
    // 30 fps; friend gestures retain their existing smooth animation clock.
    if ((friendActive || now - lastAmbientFrame >= 1000 / 30)
      && !(state.quiz?.mode === 'trail' && (trailPlayer.playing || trailPlayer.inspectAt !== null))) {
      if (usesSunWatch(state.quiz) && sunPlayer.playing) { scheduleFriendWave(); return; }
      lastAmbientFrame = now; renderScene(currentCamera());
    }
    scheduleFriendWave();
  });
}

function setEnvironmentControls(prefix, value) {
  const env = normaliseEnvironment(value);
  $(`${prefix}-weather`).value = env.condition; $(`${prefix}-wind`).value = env.wind;
  $(`${prefix}-texture`).value = env.texture;
  for (const key of ['hd', 'foliage', 'nature']) $(`${prefix}-${key}`).checked = env[key];
  for (const key of ['foliage', 'nature']) $(`${prefix}-${key}-density`).value = env[`${key}Density`];
  updateDensityControls(prefix);
  updateTextureNote(prefix);
}
function updateDensityControls(prefix) {
  for (const key of ['foliage', 'nature']) $(`${prefix}-${key}-density`).disabled = !$(`${prefix}-${key}`).checked;
}
function updateTextureNote(prefix) {
  const mode = $(`${prefix}-texture`).value;
  $(`${prefix}-texture-note`).textContent = state.quiz
    ? `${mode === 'auto' ? 'Seed style' : 'Texture style'}: ${terrainTexture(state.quiz.seed, mode, state.quiz.terrain.world).label}.`
    : 'Auto chooses a texture style for each seed.';
}
function readEnvironmentControls(prefix) {
  return normaliseEnvironment({ condition: $(`${prefix}-weather`).value, wind: $(`${prefix}-wind`).value,
    texture: $(`${prefix}-texture`).value,
    foliageDensity: $(`${prefix}-foliage-density`).value, natureDensity: $(`${prefix}-nature-density`).value,
    hd: $(`${prefix}-hd`).checked, foliage: $(`${prefix}-foliage`).checked, nature: $(`${prefix}-nature`).checked });
}
for (const prefix of ['scene', 'export']) {
  $(`${prefix}-weather`).innerHTML = CONDITIONS.map(c => `<option value="${c.id}">${c.label}</option>`).join('');
  $(`${prefix}-wind`).innerHTML = WINDS.map(w => `<option value="${w.id}">${w.label}</option>`).join('');
  $(`${prefix}-texture`).innerHTML = TEXTURE_MODES.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
  for (const key of ['foliage', 'nature'])
    $(`${prefix}-${key}-density`).innerHTML = DENSITIES.map(d => `<option value="${d.id}">${d.label}</option>`).join('');
  setEnvironmentControls(prefix, state.environment);
}
for (const key of ['weather', 'wind', 'texture', 'hd', 'foliage', 'nature', 'foliage-density', 'nature-density']) $(`scene-${key}`).addEventListener('change', () => {
  state.environment = readEnvironmentControls('scene'); store.set('otq.environment', state.environment);
  updateTextureNote('scene');
  updateDensityControls('scene');
  stopFriendWave();
  if (state.quiz && !state.loading) renderScene(currentCamera());
  scheduleFriendWave();
});
reducedMotion.addEventListener('change', () => {
  stopFriendWave();
  if (reducedMotion.matches && usesClip(state.quiz)) sunPlayer.pause();
  if (state.quiz && !state.loading) renderScene(currentCamera());
  scheduleFriendWave();
});

function syncFriendAppearance() {
  if (state.quiz?.mode !== 'friend') return;
  const conquest = state.quiz?.friend?.skin === 'conquest';
  $('friend-skin').value = normaliseFriendSkin(state.quiz?.friend?.skin);
  $('friend-arrival').hidden = !conquest || usesSunWatch(state.quiz);
  $('friend-zoom').hidden = usesSunWatch(state.quiz);
  $('friend-skin-note').textContent = usesSunWatch(state.quiz) ? 'Use Play or Replay to watch the full sequence.' : conquest
    ? '3 seconds to read the terrain, then zoom and a slow-motion arrival. The view follows Conquest as he lands.'
    : 'Your friend waves when you zoom in.';
  $('friend-status').textContent = conquest ? 'Conquest · slow-motion arrival · locate his landing cell or point'
    : state.quiz?.friend?.observerHidden ? 'Orange jacket · 1.80 m tall · locate him using the terrain'
    : 'Orange jacket · 1.80 m tall · your viewpoint stays fixed';
}

function startFriendArrival() {
  if (state.loading || state.quiz?.mode !== 'friend' || state.quiz.friend.skin !== 'conquest') return;
  stopFriendWave();
  state.friendZoom = false; state.friendCinematicTime = 0; state.friendCinematicPlaying = true;
  friendCinematicStart = performance.now();
  $('friend-zoom').textContent = 'Zoom 3×'; $('friend-zoom').setAttribute('aria-pressed', 'false');
  renderScene(currentCamera()); scheduleFriendWave();
}

$('friend-skin').innerHTML = FRIEND_SKINS.map(skin => `<option value="${skin.id}">${skin.label}</option>`).join('');
$('friend-skin').addEventListener('change', () => {
  const skin = normaliseFriendSkin($('friend-skin').value);
  store.set('otq.friendSkin', skin);
  if (state.loading || state.quiz?.mode !== 'friend') return;
  stopFriendWave();
  state.quiz.friend.skin = skin; state.baseQuiz.friend.skin = skin;
  state.friendZoom = false; state.friendCinematicPlaying = false; state.friendCinematicTime = 0;
  $('friend-zoom').textContent = 'Zoom 3×'; $('friend-zoom').setAttribute('aria-pressed', 'false');
  syncFriendAppearance(); updateHash();
  if (usesSunWatch(state.quiz)) {
    sunPlayer.reset(SUN_WATCH_DURATION);
    renderScene(currentCamera());
    if (!reducedMotion.matches && !document.hidden) sunPlayer.play();
  } else if (skin === 'conquest') startFriendArrival(); else renderScene(currentCamera());
  scheduleFriendWave();
});
$('friend-arrival').addEventListener('click', startFriendArrival);

function syncAppearanceControls() {
  const o = state.appearance;
  $('trail-knife').value = o.knife; $('trail-hand').value = o.handedness;
  $('trail-scale').value = String(o.scale);
}
$('trail-knife').innerHTML = KNIVES.map((o) => `<option value="${o.id}">${o.label}</option>`).join('');
syncAppearanceControls();
for (const id of ['trail-knife', 'trail-scale', 'trail-hand']) $(id).addEventListener('change', () => {
  state.appearance = normaliseAppearance({knife:$('trail-knife').value,
    scale:Number($('trail-scale').value),handedness:$('trail-hand').value});
  store.set('otq.appearance', state.appearance);
  if (state.quiz?.mode === 'trail') {
    state.quiz.appearance = {...state.appearance}; state.baseQuiz.appearance = {...state.appearance};
    trailPlayer.refresh(); updateHash();
  }
});
$('movement').value = normaliseMovement(store.get('otq.movement', 'go'));
$('movement').addEventListener('change', () => store.set('otq.movement', $('movement').value));

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

function requestQuiz({ seed, world, sniperWind, difficulty, variant = 0, mode, headingMode, direction, gridSize, gridChallenge, friendChallenge, friendAnswer, friendSkin, movement, trailAnswer, tuning }) {
  const id = ++state.requestId;
  return new Promise((resolve, reject) => {
    const w = getWorker();
    if (!w) {
      // Fallback: generate on the main thread.
      import('../engine/quiz.js').then(({ generate }) => {
        setTimeout(() => generate({ seed, world, sniperWind, difficulty, variant, mode, headingMode, direction, gridSize, gridChallenge, friendChallenge, friendAnswer, friendSkin, movement, trailAnswer, tuning }).then(resolve, reject), 30);
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
    w.postMessage({ id, seed, world, sniperWind, difficulty, variant, mode, headingMode, direction, gridSize, gridChallenge, friendChallenge, friendAnswer, friendSkin, movement, trailAnswer, tuning });
  });
}

/**
 * req: { seed, difficulty, variant, scramble, mode, headingMode }.
 * Missing fields come from the controls.
 */
async function load(req) {
  const r = {
    seed: req.seed || SeedManager.randomSeed(),
    world: normaliseWorld(req.world ?? $('world').value),
    sniperWind: (req.sniperWind ?? $('sniper-wind').value === 'on') === true,
    difficulty: req.difficulty || $('difficulty').value,
    variant: req.variant || 0,
    scramble: req.scramble || 0,
    mode: req.mode || $('mode').value,
    headingMode: req.headingMode || $('heading-mode').value,
    direction: req.direction || $('lookalike-direction').value,
    gridSize: normaliseGridSize(req.gridSize ?? $('grid-size').value),
    gridChallenge: normaliseGridChallenge(req.gridChallenge ?? $('grid-challenge').value),
    friendChallenge: normaliseFriendChallenge(req.friendChallenge ?? $('friend-challenge').value),
    friendAnswer: normaliseFriendAnswer(req.friendAnswer ?? $('friend-answer').value),
    friendSkin: normaliseFriendSkin(req.friendSkin ?? $('friend-skin').value),
    movement: normaliseMovement(req.movement ?? $('movement').value),
    trailAnswer: normaliseTrailAnswer(req.trailAnswer ?? $('trail-answer').value),
    appearance: normaliseAppearance(req.appearance || state.appearance),
    tuning: req.tuning || activeTuning(),
  };
  if (r.difficulty === 'sun-watch' && !supportsSunWatch(r.mode)) r.difficulty = 'medium';
  if (r.difficulty === 'sun-watch') { r.headingMode = 'auto'; r.direction = 'auto'; }
  stopFriendWave();
  state.friendCinematicPlaying = false;
  sunPlayer.reset(SUN_WATCH_DURATION); state.sunTime = 0;
  trailPlayer.reset(); state.trailTime = 0;
  if (r.mode === 'lookalike') r.headingMode = 'auto';
  if (r.mode === 'grid' && r.gridChallenge === 'lost-compass') r.headingMode = 'auto';
  $('seed').value = r.seed;
  $('world').value = r.world;
  $('sniper-wind').value = r.sniperWind ? 'on' : 'off';
  $('difficulty').value = r.difficulty;
  $('mode').value = r.mode;
  $('heading-mode').value = r.headingMode;
  $('lookalike-direction').value = r.direction;
  $('grid-size').value = r.gridSize;
  $('grid-challenge').value = r.gridChallenge;
  $('friend-challenge').value = r.friendChallenge;
  $('friend-answer').value = r.friendAnswer;
  $('friend-skin').value = r.friendSkin;
  $('movement').value = r.movement;
  $('trail-answer').value = r.trailAnswer;
  state.appearance = r.appearance; syncAppearanceControls();
  syncControls();
  setLoading(true, r.mode === 'lookalike' ? 'Searching for matching A/B/C views…' : r.difficulty === 'master' ? 'Searching for a devious question…' : 'Generating terrain…');
  setAnswersEnabled(false);
  map.pickable = false;
  const myId = state.requestId + 1;
  let quiz;
  try {
    quiz = await requestQuiz({ ...r, headingMode: r.headingMode === 'auto' ? null : r.headingMode });
  } catch (err) {
    if (myId !== state.requestId) return;
    console.error(err);
    setLoading(true, `Generation failed: ${err.message}`);
    return;
  }
  if (myId !== state.requestId) return; // superseded by a newer request
  quiz.headingChoice = r.headingMode;
  if (quiz.mode === 'trail') quiz.appearance = { ...r.appearance };
  quiz.tuning = r.tuning;
  state.baseQuiz = quiz;
  show(r.scramble && !['facing', 'grid'].includes(quiz.mode) ? scrambleLabels(quiz, r.scramble) : quiz);
  updateHash();
}

function updateHash() {
  const q = state.quiz;
  if (!q) return;
  const parts = [`seed=${encodeURIComponent(q.seed)}`, `d=${q.difficulty}`];
  if ((q.worldChoice || 'classic') !== 'classic') parts.push(`w=${q.worldChoice}`);
  if (q.mode === 'facing') parts.push('m=facing');
  else if (q.mode === 'grid') {
    parts.push('m=grid', `g=${q.grid.size}`);
    if (q.grid.challenge !== 'standard') parts.push(`gc=${q.grid.challenge}`);
    if (!headingHidden(q) && q.headingChoice !== 'auto') parts.push(`h=${q.headingChoice}`);
  }
  else if (q.mode === 'trail') {
    parts.push('m=trail');
    if (q.grid) parts.push('ta=grid', `g=${q.grid.size}`);
    if (q.trail.movement !== 'go') parts.push(`mv=${q.trail.movement}`);
    const o = normaliseAppearance(q.appearance);
    parts.push(`k=${o.knife}`, `hand=${o.handedness}`);
    if (o.scale !== 1) parts.push(`ks=${o.scale}`);
    if (q.headingChoice !== 'auto') parts.push(`h=${q.headingChoice}`);
  }
  else if (q.mode === 'friend') {
    parts.push('m=friend');
    if (usesGrid(q)) parts.push('fa=grid', `g=${q.grid.size}`);
    if (q.friend.skin === 'conquest') parts.push('fs=conquest');
    if (q.friend.challenge !== 'standard') parts.push(`fc=${q.friend.challenge}`);
    if (q.headingChoice !== 'auto') parts.push(`h=${q.headingChoice}`);
  }
  else if (q.mode === 'sniper') { parts.push('m=sniper'); if (q.sniper.wind) parts.push('wind=1'); }
  else if (q.mode === 'lookalike') {
    parts.push('m=lookalike');
    if (q.directionChoice !== 'auto') parts.push(`dir=${q.directionChoice}`);
  }
  else if (q.headingChoice && q.headingChoice !== 'auto') parts.push(`h=${q.headingChoice}`);
  if (q.variant) parts.push(`v=${q.variant}`);
  if (q.tuning && Object.keys(q.tuning).length) parts.push(`dev=${encodeURIComponent(encodeTuning(q.tuning))}`);
  if (q.scramble) parts.push(`s=${q.scramble}`);
  history.replaceState(null, '', `#${parts.join('&')}`);
}

/** Show only the controls that apply to the selected mode. */
function syncControls() {
  const facing = $('mode').value === 'facing';
  const lookalike = $('mode').value === 'lookalike';
  const grid = $('mode').value === 'grid';
  const friendGrid = $('mode').value === 'friend' && $('friend-answer').value === 'grid';
  const trailGrid = $('mode').value === 'trail' && $('trail-answer').value === 'grid';
  $('difficulty').querySelector('[value="sun-watch"]').disabled = !supportsSunWatch($('mode').value);
  if ($('difficulty').value === 'sun-watch' && !supportsSunWatch($('mode').value)) $('difficulty').value = 'medium';
  const watch = $('difficulty').value === 'sun-watch';
  $('friend-answer-field').hidden = $('mode').value !== 'friend';
  $('friend-challenge-field').hidden = $('mode').value !== 'friend';
  $('movement-field').hidden = $('mode').value !== 'trail';
  $('trail-answer-field').hidden = $('mode').value !== 'trail';
  $('grid-size-field').hidden = !(grid || friendGrid || trailGrid);
  $('grid-challenge-field').hidden = !grid;
  $('heading-field').hidden = watch || facing || lookalike || ['trail', 'sniper'].includes($('mode').value) || (grid && $('grid-challenge').value === 'lost-compass');
  $('direction-field').hidden = watch || !lookalike;
  const sniper = $('mode').value === 'sniper';
  $('sniper-wind-field').hidden = !sniper;
  $('scramble').hidden = facing || grid || friendGrid || trailGrid || sniper;
  if (typeof dev !== 'undefined') renderDevPanel();
}

function show(quiz) {
  stopFriendWave();
  state.quiz = quiz;
  state.environmentStart = performance.now();
  state.answered = false;
  state.chosen = null;
  state.viewing = null;
  state.friendZoom = false;
  state.friendCinematicTime = 0;
  state.friendCinematicPlaying = !usesSunWatch(quiz) && quiz.mode === 'friend' && quiz.friend.skin === 'conquest';
  state.trailTime = 0; trailPlayer.reset(quiz.trail?.duration || 12);
  state.sunTime = 0; sunPlayer.reset(SUN_WATCH_DURATION);
  $('direction-tools').hidden = !usesClip(quiz);
  $('trail-tools').hidden = quiz.mode !== 'trail';
  $('trail-legend').hidden = quiz.mode !== 'trail' || usesGrid(quiz);
  $('friend-tools').hidden = quiz.mode !== 'friend';
  $('friend-status').textContent = quiz.friend?.observerHidden
    ? 'Orange jacket · 1.80 m tall · locate him using the terrain'
    : 'Orange jacket · 1.80 m tall · your viewpoint stays fixed';
  $('friend-zoom').textContent = 'Zoom 3×';
  $('friend-zoom').setAttribute('aria-pressed', 'false');
  syncFriendAppearance();
  const t = quiz.terrain;
  state.model = new TerrainModel({ size: t.size, n: t.n, heights: t.heights, seed: t.modelSeed });

  const facing = quiz.mode === 'facing';
  const lookalike = quiz.mode === 'lookalike';
  const grid = usesGrid(quiz), friendGrid = quiz.mode === 'friend' && grid;
  $('quiz-title').textContent = quiz.mode === 'sniper' ? 'SNIPER · WHICH HOLD?' : quiz.mode === 'trail' ? grid ? 'WHERE DID YOU FINISH?' : 'WHICH TRAIL DID YOU FOLLOW?' : quiz.mode === 'friend' ? 'WHERE IS YOUR FRIEND?' : facing ? 'WHICH WAY ARE YOU FACING?' : lookalike ? 'LOOK-ALIKES' : grid ? `${quiz.grid.size} × ${quiz.grid.size} GRID` : 'WHERE ARE YOU?';
  $('quiz-title').classList.toggle('long', facing || ['friend', 'trail', 'sniper'].includes(quiz.mode));
  $('facing-text').textContent = quiz.mode === 'sniper' ? `PRONE · ${quiz.heading.text} · POSITION UNKNOWN` : quiz.mode === 'trail' ? grid ? 'BUNNY HOP · FIND YOUR FINISH CELL' : 'BUNNY HOP · READ THE MOVING TERRAIN' : facing ? 'YOU ARE AT THE MARKED POINT' : headingHidden(quiz) ? 'LOST COMPASS · FIND YOUR CELL' : quiz.heading.text;
  $('facing-arrow').textContent = quiz.mode === 'trail' || quiz.mode === 'sniper' || headingHidden(quiz) || quiz.heading.mode === 'exact' ? '' : quiz.heading.arrow;
  $('facing-text').closest('.facing').hidden = usesSunWatch(quiz);
  document.querySelector('.card').classList.toggle('sun-watch', usesSunWatch(quiz));
  document.querySelector('.about').hidden = usesSunWatch(quiz);
  $('prompt').textContent = quiz.mode === 'sniper' ? quiz.sniper.wind
    ? `Which scope mark and windage hold put the round on the enemy sniper's head? Wind ${quiz.sniper.wind.speed} m/s from ${String(quiz.sniper.wind.from).padStart(3, '0')}°: work out the crosswind against your line of fire, read the wind card (mil per 1 m/s at each range) and hold into the wind on the 0.5 mil stadia. Find yourself and the target on the map, and mind the height difference. Keys 1–${quiz.options.length}.`
    : `Which scope mark puts the round on the enemy sniper's head: ${quiz.options.map((o) => o.label).join(', ')}? Only your heading is known — find yourself and the target on the map, mind the height difference, or range his 0.50 m shoulders with the mil scale. Keys ${quiz.options.map((o) => String(o.metres / 100 % 10)).join('/')}.`
    : usesSunWatch(quiz) ? grid ? `${friendGrid ? "Locate your friend's cell" : 'Find your cell'}: A1–${String.fromCharCode(64 + quiz.grid.size)}${quiz.grid.size}.`
    : quiz.mode === 'friend' ? 'Where is your friend: A, B or C?' : 'You are at A, B or C. Which one?'
    : facing ? 'Which direction were you facing at the start?'
    : lookalike ? 'A, B and C have similar views in this direction. Match the ridge shapes and foreground to find your point.'
    : grid ? `${quiz.mode === 'trail' ? 'Find your finish cell' : friendGrid ? "Locate your friend's cell" : 'Find your cell'}: A1–${String.fromCharCode(64 + quiz.grid.size)}${quiz.grid.size} (row + column, e.g. B3).`
    : quiz.mode === 'trail' ? 'Which trail did you follow: A red, B green or C cyan? All three traces advance together. Match the slopes, ridges and hollows in the moving view. Circles mark the starts; arrows mark the ends.'
    : quiz.mode === 'friend' ? quiz.friend.observerHidden
      ? `Where is your friend: A, B or C? Your position is unmarked. All three spots fit his distance and apparent size; use the skyline, slopes and hollows to locate him.${quiz.friend.challenge === 'depth-trap' ? ' Depth trap also matches his vertical angle more closely.' : ''}`
      : `You stand at YOU. Where is your friend: A, B or C?${quiz.friend.challenge === 'depth-trap' ? ' All three spots share a bearing — compare distance, apparent size and slope.' : ' Match his position to the surrounding terrain.'}`
    : 'You are at one of the marked points, facing the direction shown. Which one?';
  $('prompt').classList.toggle('grid-remark', grid);
  (grid ? document.querySelector('.map-wrap') : document.querySelector('.answer-row')).before($('prompt'));
  $('credit').textContent = `seed ${quiz.seed}${quiz.variant ? ` · positions #${quiz.variant}` : ''} · ${DIFFICULTIES[quiz.difficulty].label.toLowerCase()}${t.world && t.world !== 'classic' ? ` · ${worldLabel(t.world).toLowerCase()} world` : ''} · ${Math.round(t.size / 1000 * 10) / 10} km × ${Math.round(t.size / 1000 * 10) / 10} km`;
  $('viewing-badge').hidden = true;
  $('result').hidden = true;
  $('prompt').hidden = false;
  $('map').setAttribute('aria-label', quiz.mode === 'trail' && !grid ? 'Contour map showing three candidate trails: A red, B green, C cyan. Tap a trail or choose its letter.' : grid ? `${quiz.grid.size} by ${quiz.grid.size} contour grid. Rows A to ${String.fromCharCode(64 + quiz.grid.size)} from north to south; columns 1 to ${quiz.grid.size} from west to east. Enter a cell code below to answer.` : 'Topographic contour map with candidate locations');

  if (renderer) {
    renderer.setTerrain(state.model, { seed: quiz.seed, world: quiz.terrain.world });
    renderer.setPerson(quiz.friend || null);
    renderScene(quiz.camera);
  }
  updateTextureNote('scene');
  map.setData({
    model: state.model,
    interval: t.contourInterval,
    options: quizMarkers(quiz), routes: quiz.trail?.routes,
    rotation: state.settings.northUp ? 0 : quiz.mapRotation,
    landmarks: quiz.landmarks,
    grid: grid ? { ...quiz.grid, correctLabel: quiz.correctLabel } : null,
    extent: quiz.mapExtent || null, trails: quiz.mode === 'trail', trailDuration: quiz.trail?.duration,
    observer: friendObserver(quiz), friendMode: quiz.mode === 'friend' || quiz.mode === 'sniper',
    target: quiz.mode === 'sniper' ? quiz.sniper.target : null,
  });
  map.setOverlays({ ...state.settings, landforms: usesSunWatch(quiz) ? false : state.settings.landforms });

  renderAnswerButtons();
  renderFacts();
  setLoading(false);
  setAnswersEnabled(true);
  if (!usesSunWatch(quiz) && quiz.mode === 'friend' && quiz.friend.skin === 'conquest') startFriendArrival();
  if (quiz.mode === 'trail' && renderer && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && !document.hidden) trailPlayer.play();
  if (quiz.mode === 'sniper' && renderer && !reducedMotion.matches && !document.hidden && !$('export-dialog').open) sunPlayer.play();
  if (usesSunWatch(quiz) && renderer) renderer.prepareWatch().then(() => {
    if (state.quiz !== quiz || state.loading) return;
    if (!state.answered && !reducedMotion.matches && !document.hidden && !$('export-dialog').open) sunPlayer.play();
  }).catch(error => {
    $('scene-error').textContent = error.message; $('scene-error').hidden = false;
  });
  scheduleFriendWave();
}

const ROSE = ['NW', 'N', 'NE', 'W', '', 'E', 'SW', 'S', 'SE'];

function renderAnswerButtons() {
  const answers = $('answers');
  answers.innerHTML = '';
  const facing = state.quiz.mode === 'facing';
  const grid = usesGrid(state.quiz);
  $('grid-answer').hidden = !grid;
  answers.parentElement.hidden = grid;
  if (grid) {
    $('grid-cell-label').textContent = state.quiz.mode === 'trail' ? 'Finish cell' : state.quiz.mode === 'friend' ? "Friend's cell" : 'Your cell';
    $('grid-cell').value = '';
    $('grid-cell').removeAttribute('aria-invalid');
    $('grid-help').textContent = `Tap a cell or enter A1–${String.fromCharCode(64 + state.quiz.grid.size)}${state.quiz.grid.size}.`;
    return;
  }
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
    if (state.quiz.mode === 'sniper') { b.classList.add('hold'); b.setAttribute('aria-label', `${o.label} scope mark`); }
    if (state.quiz.mode === 'trail') {
      b.classList.add('trail-choice'); b.style.setProperty('--trail-color', TRAIL_COLORS[o.label]);
      b.setAttribute('aria-label', `${o.label} — ${{A:'red', B:'green', C:'cyan'}[o.label]} trail`);
    }
    b.addEventListener('click', () => answer(o.label));
    answers.append(b);
  }
  $('scramble').disabled = state.answered;
}

function renderScene(camera, playback = {}) {
  if (!renderer) return;
  const startHeading = camera.heading;
  let relativeTurn = null;
  const environmentOptions = { environment: state.environment,
    weather: weatherParams(state.environment, state.quiz.camera.heading),
    environmentTime: reducedMotion.matches ? 0 : Math.max(0, (performance.now() - state.environmentStart) / 1000) };
  let friendPerson = null;
  if (state.quiz.mode === 'friend') {
    const o = state.quiz.options.find((p) => p.label === state.viewing);
    friendPerson = o ? { ...state.quiz.friend, x: o.x, y: o.y, z: o.z, heading: (o.bearing + 180) % 360 } : state.quiz.friend;
    renderer.setPerson(friendPerson);
    if (!usesSunWatch(state.quiz) && state.friendZoom && !state.friendCinematicPlaying) camera = { ...camera, fov: 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) / 3) * 180 / Math.PI };
  }
  if (state.quiz.mode === 'sniper') {
    const canvas = $('scene'), aspect = (canvas.clientWidth || 16) / (canvas.clientHeight || 10);
    const frame = sniperFrame(state.quiz, state.sunTime, aspect);
    renderer.setPerson(state.quiz.sniper.target);
    renderer.setViewmodel(null);
    renderer.render(frame.camera, { ...environmentOptions, weather: sniperWeather(state.quiz, environmentOptions.weather), time: state.sunTime, sunHeading: state.quiz.camera.heading,
      rifle: { raise: frame.raise, time: state.sunTime } });
    state.sniperFrame = frame; camera = frame.camera;
  } else if (state.quiz.mode === 'trail') {
    const frame = trailFrame(state.quiz, state.trailTime, state.viewing || state.quiz.correctLabel, state.model);
    camera = frame.camera;
    renderer.setViewmodel(state.appearance);
    renderer.render(camera, { ...environmentOptions, time: state.trailTime, sunHeading: state.quiz.camera.heading,
      motion: { ...frame.motion, ...playback, clockRunning: trailPlayer.playing || Number.isFinite(playback.inspectElapsed) } });
    if (Math.abs(state.trailTime - (state.lastTrailMapTime ?? -1)) > .04
      || (!trailPlayer.playing && state.trailTime !== state.lastTrailMapTime)
      || (state.answered && map.viewing?.label !== frame.route.label)
      || state.lastTrailMapLabel !== frame.route.label || state.trailTime === 0 || state.trailTime === state.quiz.trail.duration) {
      map.setTrailTime(state.trailTime, state.answered ? { ...camera, label: frame.route.label } : null);
      state.lastTrailMapTime = state.trailTime; state.lastTrailMapLabel = frame.route.label;
    }
  } else {
    const watchFrame = usesSunWatch(state.quiz) ? state.quiz.mode === 'friend'
      ? friendSceneFrame(state.quiz, state.sunTime, true, { camera, person: friendPerson })
      : sunWatchFrame(state.quiz, state.sunTime, { camera }) : null;
    const elapsed = state.quiz.mode === 'friend' && state.friendZoom ? Math.max(0, (performance.now() - friendWaveStart) / 1000) : 0;
    const lift = Math.min(1, elapsed / .35);
    const conquest = friendPerson?.skin === 'conquest';
    const frame = watchFrame || (conquest ? friendSceneFrame(state.quiz, state.friendCinematicTime,
      state.friendCinematicPlaying || state.friendCinematicTime > 0, { camera, person: friendPerson }) : null);
    if (frame) camera = frame.camera;
    if (watchFrame) camera = watchFrame.camera;
    if (watchFrame) relativeTurn = watchFrame.relativeTurn;
    renderer.setViewmodel(null); renderer.render(camera, { ...environmentOptions, time: watchFrame ? state.sunTime : conquest ? state.friendCinematicTime : elapsed,
      solar: watchFrame?.solar, watch: watchFrame?.watch,
      personMotion: frame ? frame.personMotion : { wave: state.friendZoom && state.quiz.mode === 'friend' ? lift * lift * (3 - 2 * lift) : 0 } });
  }
  const relative = $('relative-bearing');
  relative.hidden = relativeTurn === null;
  if (!relative.hidden) {
    const bearing = relativeBearing(camera.heading, startHeading, relativeTurn);
    $('relative-bearing-value').textContent = bearing.text;
    relative.dataset.side = bearing.side;
    relative.setAttribute('aria-label', `Relative bearing from starting view: ${bearing.text}`);
  }
  // In "Which way?" the bearing tape would give the answer away.
  const tapeAllowed = !usesSunWatch(state.quiz) && (!headingHidden(state.quiz) || state.answered)
    && !(state.quiz.mode === 'sniper' && state.sniperFrame?.raise > 0);
  const tape = $('tape');
  if (state.settings.tape && tapeAllowed) drawCompassTape(tape, camera, { exact: state.quiz.heading.mode === 'exact' });
  else {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    tape.width = Math.round(tape.clientWidth * dpr); tape.height = Math.round(tape.clientHeight * dpr);
  }
  if (state.quiz.mode === 'sniper' && state.sniperFrame) {
    const dpr = tape.width / (tape.clientWidth || 1) || 1, ctx = tape.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSniperOverlay(ctx, state.quiz, state.sniperFrame, { width: tape.clientWidth, height: tape.clientHeight });
  }
  // Developer check: engine skyline over the GPU render (hidden before answering in "Which way?").
  if (typeof dev !== 'undefined' && dev.enabled && dev.skyline && tapeAllowed) {
    const dpr = tape.width / tape.clientWidth || 1;
    const ctx = tape.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSkylineOverlay(ctx, camera, state.model, tape.clientWidth, tape.clientHeight);
  }
}

$('friend-zoom').addEventListener('click', () => {
  if (state.loading || state.quiz?.mode !== 'friend') return;
  state.friendZoom = !state.friendZoom;
  stopFriendWave();
  if (state.quiz.friend.skin === 'conquest') { state.friendCinematicPlaying = false; state.friendCinematicTime = 15; }
  friendWaveStart = performance.now();
  $('friend-zoom').setAttribute('aria-pressed', String(state.friendZoom));
  $('friend-zoom').textContent = state.friendZoom ? 'Overview 1×' : 'Zoom 3×';
  renderScene(currentCamera());
  scheduleFriendWave();
});

// ---------------------------------------------------------------- answering

function selectCell(label) {
  if (state.loading || state.answered || !usesGrid(state.quiz)) return;
  $('grid-cell').value = label;
  $('grid-cell').removeAttribute('aria-invalid');
  $('grid-help').textContent = `${label} selected — check your answer when ready.`;
  map.setSelection(label);
}

$('grid-cell').addEventListener('input', () => {
  if (!usesGrid(state.quiz)) return;
  const label = parseCell($('grid-cell').value, state.quiz.grid.size);
  $('grid-cell').removeAttribute('aria-invalid');
  map.setSelection(label);
});
$('grid-answer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.loading || state.answered || !usesGrid(state.quiz)) return;
  const label = parseCell($('grid-cell').value, state.quiz.grid.size);
  if (!label) {
    $('grid-cell').setAttribute('aria-invalid', 'true');
    $('grid-help').textContent = `Enter a cell from A1 to ${String.fromCharCode(64 + state.quiz.grid.size)}${state.quiz.grid.size}.`;
    $('grid-cell').focus();
    return;
  }
  $('grid-cell').value = label;
  answer(label);
});

function answer(label) {
  if (!state.quiz || state.answered || state.loading) return;
  const quiz = state.quiz;
  if (!quiz.options.some((o) => o.label === label)) return;
  if (quiz.mode === 'trail') trailPlayer.pause();
  if (usesSunWatch(quiz)) sunPlayer.seek(SUN_WATCH_DURATION);
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
  $('grid-cell').disabled = true;
  $('grid-submit').disabled = true;
  $('scramble').disabled = true;
  $('prompt').hidden = true;
  renderFacts();
  showAnswerResult(label, right);
  appendAnswerExplanation($('result'), quiz, label, state.model);
}

function showAnswerResult(label, right) {
  const quiz = state.quiz;
  if (quiz.mode === 'trail') { if (quiz.grid) showTrailGridResult(label, right); else showTrailResult(label, right); return; }
  if (quiz.mode === 'facing') { showFacingResult(label, right); return; }
  if (quiz.mode === 'sniper') { showSniperResult(label, right); return; }
  if (quiz.mode === 'grid') { showGridResult(label, right); return; }
  if (quiz.mode === 'friend' && usesGrid(quiz)) { showFriendGridResult(label, right); return; }
  if (quiz.mode === 'friend') { showFriendResult(label, right); return; }

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


function showSniperResult(label, right) {
  const q = state.quiz, s = q.sniper, res = $('result');
  res.hidden = false;
  const cm = (v, plus, minus) => Math.abs(v) < 0.005 ? '0' : `${(Math.abs(v) * 100).toFixed(0)} cm ${v > 0 ? plus : minus}`;
  const wind = s.wind;
  const off = (o) => wind ? Math.hypot(o.miss, o.lateral) : Math.abs(o.miss);
  const verdictOf = (o) => off(o) <= 0.12 ? 'head shot' : (!wind || Math.abs(o.lateral) < 0.25) && o.miss < 0 && o.miss >= -1.5 ? 'body, not the head' : 'miss';
  const rows = q.options.map((o) => `<tr><td><strong>${o.label}</strong>${o.correct ? ' ✓' : o.label === label ? ' (your pick)' : ''}</td><td>${o.mil.toFixed(1)} mil${wind ? ` · ${o.windMil > 0 ? 'R' : 'L'} ${Math.abs(o.windMil).toFixed(1)}` : ''}</td>`
    + `<td>${cm(o.miss, 'high', 'low')}${wind ? `, ${cm(o.lateral, 'right', 'left')}` : ''}</td><td>${verdictOf(o)}</td></tr>`).join('');
  res.innerHTML = `<div class="verdict ${right ? 'good' : 'bad'}">${right ? 'Hit' : 'Miss'} — ${q.correctLabel} was right.</div>
    <p>Target: ${Math.round(s.horizontal)} m horizontally, ${Math.abs(s.rise).toFixed(1)} m ${s.rise >= 0 ? 'higher' : 'lower'} (${Math.abs(s.angle).toFixed(1)}° ${s.rise >= 0 ? 'uphill' : 'downhill'}) · straight-line ${Math.round(s.slant)} m.${wind ? ` Crosswind ${Math.abs(wind.cross).toFixed(1)} m/s from the ${wind.cross > 0 ? 'right' : 'left'} → hold ${Math.abs(wind.holdMil).toFixed(1)} mil ${wind.holdMil > 0 ? 'right' : 'left'}.` : ''} YOU and the target are now on the map.</p>
    <table><tr><th>Option</th><th>Hold</th><th>Impact vs. head</th><th>Result</th></tr>${rows}</table>
    <p class="note">Rifle zeroed at 100 m, ${s.rifle.muzzle} m/s. Each mark is the hold for that range on flat ground; up- or downhill, use the horizontal distance.</p>
    <button type="button" class="btn ghost" id="sniper-replay">Replay the shot view</button>
    <button type="button" class="btn primary" id="next">Next quiz (N)</button>`;
  $('sniper-replay').addEventListener('click', () => sunPlayer.replay());
  $('next').addEventListener('click', newQuiz);
}

function showTrailGridResult(label, right) {
  const q = state.quiz, res = $('result');
  res.hidden = false;
  res.innerHTML = `<div class="verdict ${right ? 'good' : 'bad'}">${right ? 'Correct' : 'Not quite'} — you finished in ${q.correctLabel}.</div>
    <p>${right ? '' : `You selected ${label}. `}The green cell is your finish; FINISH marks its centre. The yellow trace shows the actual run, and the white dot follows the replay.</p>
    <p class="note">Find where the full run ends. Pausing or replaying an earlier moment keeps the same finish cell.</p>
    <button type="button" class="btn ghost" id="grid-replay">Replay actual run</button>
    <button type="button" class="btn primary" id="next">Next quiz (N)</button>`;
  $('grid-help').textContent = `Your answer: ${label} · finish cell: ${q.correctLabel}`;
  $('grid-replay').addEventListener('click', () => trailPlayer.replay());
  $('next').addEventListener('click', newQuiz);
  state.viewing = q.correctLabel;
  trailPlayer.refresh();
}

function showTrailResult(label, right) {
  const q = state.quiz, res = $('result');
  res.hidden = false;
  res.innerHTML = `<div class="verdict ${right ? 'good' : 'bad'}">${right ? 'Correct' : 'Not quite'} — you followed trail ${q.correctLabel}.</div>
    <p>Replay each route with the same turns and speed. Watch how the nearby slopes and distant skyline shift as you move.</p>
    <div class="views">${q.options.map(o => `<button type="button" class="btn ghost" data-view="${o.label}" style="border-color:${TRAIL_COLORS[o.label]}">Replay ${o.label}${o.correct ? ' (actual)' : ''}</button>`).join('')}</div>
    <table><tr><th>Trail</th><th>Terrain difference</th><th>Detail to check</th></tr>
    ${q.options.map(o => `<tr><td><strong>${o.label}</strong></td><td>${o.correct ? 'Matches' : `${o.D.toFixed(1)}°`}</td><td>${o.correct ? 'Actual run' : `At ${o.cue.t.toFixed(1)} s, skyline ${Math.abs(o.cue.delta).toFixed(1)}° ${o.cue.delta > 0 ? 'higher' : 'lower'} near ${String(o.cue.bearing).padStart(3,'0')}° <button class="btn ghost small" type="button" data-cue="${o.label}" data-actual="true">Actual here</button> <button class="btn ghost small" type="button" data-cue="${o.label}">Compare here</button>`}</td></tr>`).join('')}</table>
    <p class="note">The dotted highlight marks the correct trail; the white dot follows the replay. Before answering, all three coloured traces advance together. Knife choices do not change the answer.</p>
    <button type="button" class="btn primary" id="next">Next quiz (N)</button>`;
  res.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => viewFrom(b.dataset.view)));
  res.querySelectorAll('[data-cue]').forEach(b => b.addEventListener('click', () => {
    const o = q.options.find(p => p.label === b.dataset.cue);
    state.viewing = b.dataset.actual ? q.correctLabel : o.label; highlightView(state.viewing); trailPlayer.seek(o.cue.t);
    $('viewing-badge').hidden = false; $('viewing-badge').textContent = `Trail ${state.viewing} · ${b.dataset.actual ? 'actual run' : 'comparison'} at ${o.cue.t.toFixed(1)} s`;
  }));
  $('next').addEventListener('click', newQuiz);
  state.viewing = q.correctLabel; highlightView(q.correctLabel); trailPlayer.refresh();
}

function showFriendGridResult(label, right) {
  const q = state.quiz, res = $('result');
  res.hidden = false;
  res.innerHTML = `<div class="verdict ${right ? 'good' : 'bad'}">${right ? 'Correct' : 'Not quite'} — your friend was in ${q.correctLabel}.</div>
    <p>${right ? '' : `You selected ${label}. `}The green cell contains your friend; FRIEND marks his exact position. YOU marks your observation point.</p>
    <p class="note">Cell references locate your friend. He can stand anywhere inside a cell. Use the terrain, bearing and his apparent size from your original viewpoint.</p>
    <button type="button" class="btn primary" id="next">Next quiz (N)</button>`;
  $('grid-help').textContent = `Your answer: ${label} · friend's cell: ${q.correctLabel}`;
  $('next').addEventListener('click', newQuiz);
}

function showFriendResult(label, right) {
  const q = state.quiz, res = $('result'), hidden = q.friend.observerHidden;
  const cue = (o) => {
    if (o.correct) return 'Matches the view';
    if (!o.cue) return '—';
    const rel = ((o.cue.bearing - q.camera.heading + 540) % 360) - 180;
    const side = rel < -q.camera.fov / 6 ? 'Left' : rel > q.camera.fov / 6 ? 'Right' : 'Centre';
    return `${side}: skyline ${Math.abs(o.cue.delta).toFixed(1)}° ${o.cue.delta > 0 ? 'higher' : 'lower'}`;
  };
  res.hidden = false;
  res.innerHTML = `<div class="verdict ${right ? 'good' : 'bad'}">${right ? 'Correct' : 'Not quite'} — your friend was at ${q.correctLabel}.</div>
    <p>${hidden ? 'Your position is now marked YOU. Compare the terrain from the possible observation point for each answer; the person stays at the same range. These are observer views, looking towards your friend.'
      : 'Compare the person at each spot. You keep looking from YOU; the terrain and camera stay fixed.'}</p>
    <div class="views">${q.options.map((o) => `<button type="button" class="btn ghost" data-view="${o.label}">Friend at ${o.label}${o.correct ? ' (true)' : ''}</button>`).join('')}</div>
    <table><tr><th>Spot</th><th>Range</th><th>Apparent height</th><th>${hidden ? 'Terrain clue' : 'Elevation'}</th></tr>
    ${q.options.map((o) => `<tr><td><strong>${o.label}</strong></td><td>${Math.round(o.distance)} m</td><td>${o.angularHeight.toFixed(2)}°</td><td>${hidden ? cue(o) : `${Math.round(o.z)} m`}</td></tr>`).join('')}</table>
    <p class="note">${hidden ? 'The range and apparent height fit all three answers. The skyline and the slopes between the observer and the person distinguish the true spot. On comparisons, YOU marks the possible observation point.'
      : 'A 1.80 m person appears smaller farther away. Match his height in the view to the contours and slopes around the candidate spot.'}</p>
    <button type="button" class="btn primary" id="next">Next quiz (N)</button>`;
  res.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewFrom(b.dataset.view)));
  $('next').addEventListener('click', newQuiz);
  highlightView(q.correctLabel);
}

function showGridResult(label, right) {
  const q = state.quiz, res = $('result');
  const comparisons = explanationComparisons(q, label);
  const codes = [...new Set([q.correctLabel, label, ...comparisons.map(o => o.label), q.closestLabel].filter(Boolean))];
  const options = codes.map((code) => q.options.find((o) => o.label === code));
  const trueHeading = `${String(Math.round(q.camera.heading)).padStart(3, '0')}°`;
  res.hidden = false;
  res.innerHTML = `<div class="verdict ${right ? 'good' : 'bad'}">${right ? 'Correct' : 'Not quite'} — your cell was ${q.correctLabel}.</div>
    <p>${label !== q.correctLabel ? `You selected ${label}. ` : ''}The green cell marks your position; the wedge shows your view.${headingHidden(q) ? ` Your compass was pointing ${trueHeading}.` : ''}</p>
    <div class="views">${options.map((o) => `<button type="button" class="btn ghost" data-view="${o.label}">View ${o.label}${o.correct ? ' (true)' : o.label === label ? ' (your pick)' : ' (closest match)'}</button>`).join('')}</div>
    <table><tr><th>Cell</th><th>Landform</th><th>Elevation</th><th>View diff.</th>${headingHidden(q) ? '<th>Compared heading</th>' : ''}</tr>
    ${options.map((o) => `<tr><td><strong>${o.label}</strong></td><td>${o.landform}</td><td>${Math.round(o.z)} m</td><td>${o.correct ? '—' : `${o.D.toFixed(1)}°`}</td>${headingHidden(q) ? `<td>${String(o.heading).padStart(3, '0')}°</td>` : ''}</tr>`).join('')}</table>
    <p class="note">Views are compared from cell centres.${q.grid.challenge === 'lost-compass' ? ' Wrong cells use their closest-looking compass direction.' : ''}</p>
    <button type="button" class="btn primary" id="next">Next quiz (N)</button>`;
  res.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewFrom(b.dataset.view)));
  $('next').addEventListener('click', newQuiz);
  $('grid-help').textContent = `Your answer: ${label} · correct cell: ${q.correctLabel}`;
  if (headingHidden(q)) {
    $('facing-text').textContent = q.heading.text;
    $('facing-arrow').textContent = q.heading.arrow;
  }
  highlightView(q.correctLabel);
  renderScene(q.camera);
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
  if (quiz.mode === 'trail') return { cam: trailFrame(quiz, state.trailTime, label, state.model).camera, o };
  if (quiz.mode === 'friend') return { cam: friendOptionCamera(quiz, o), o };
  if (quiz.mode === 'facing') return { cam: { ...quiz.camera, heading: o.heading }, o };
  if (usesSunWatch(quiz)) return { cam: { ...quiz.camera, x: o.x, y: o.y, z: o.z + quiz.camera.eyeHeight, heading: o.heading }, o };
  return { cam: { ...quiz.camera, heading: o.heading ?? quiz.camera.heading, x: o.x, y: o.y, z: state.model.getElevation(o.x, o.y) + quiz.camera.eyeHeight }, o };
}

function viewFrom(label) {
  const quiz = state.quiz;
  const { cam, o } = optionCamera(label);
  state.viewing = label;
  if (quiz.mode === 'trail') {
    $('viewing-badge').hidden = false;
    $('viewing-badge').textContent = `Trail ${label}${o.correct ? ' · actual run' : ' · comparison'}`;
    highlightView(label); trailPlayer.seek(0); trailPlayer.play(); return;
  }
  renderScene(cam);
  map.setViewing({ ...cam, color: o.correct ? '#5fd08a' : '#ff9f5e' });
  const badge = $('viewing-badge');
  badge.hidden = false;
  badge.textContent = quiz.mode === 'friend' ? `Friend at ${label}${o.correct ? ' — true spot' : ' — comparison'} · ${quiz.friend.observerHidden && !o.correct ? 'possible observer' : 'your viewpoint'}` : quiz.mode === 'facing' ? `Facing ${label}${o.correct ? ' — true direction' : ''}`
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
  const sealed = usesSunWatch(q) && !state.answered;
  $('facts').hidden = sealed;
  $('facts').closest('.box').querySelectorAll('h2, details').forEach(el => { el.hidden = sealed; });
  $('dev-enabled').closest('.box').hidden = false;
  $('opt-landforms').closest('label').hidden = sealed;
  $('opt-tape').closest('label').hidden = usesSunWatch(q);
  $('legend').hidden = sealed || !state.settings.landforms;
  const facts = [
    ['Mode', q.mode === 'sniper' ? 'Sniper · holdover' : q.mode === 'trail' ? q.grid ? 'Bunny-hop · finish cell' : 'Bunny-hop trails' : q.mode === 'friend' ? `Where is your friend?${q.friend.challenge === 'depth-trap' ? ' · Depth trap' : ''}` : q.mode === 'facing' ? 'Which way are you facing?' : q.mode === 'lookalike' ? 'Look-alikes (A / B / C)' : q.mode === 'grid' ? `Grid ${q.grid.size} × ${q.grid.size}${q.grid.challenge === 'lost-compass' ? ' · Lost compass' : ''}` : 'Where are you?'],
    ...(!sealed ? [['Heading', headingHidden(q) && !state.answered ? 'hidden until you answer' : `${String(Math.round(q.camera.heading)).padStart(3, '0')}° (${q.mode === 'facing' ? 'one of 8 directions' : q.heading.mode})`]] : []),
    ...(q.mode === 'trail' ? [['Run', `${q.trail.duration} s · ${Math.round(q.trail.plan.length)} m · ${q.grid ? 'find the finish' : 'three matched routes'}`],
      ['Movement', q.trail.movement === 'classic' ? 'CS 1.6 style' : 'CS:GO style']] : []),
    ...(q.mode === 'trail' && q.grid ? [['Cells', `${q.options.length} · ${Math.round(q.grid.cellMetres)} m per side · finish at centre`]] : []),
    ...(q.mode === 'grid' ? [['Cells', `${q.options.length} · ${Math.round(q.grid.cellMetres)} m per side · observer at centre`]] : []),
    ...(q.mode === 'sniper' ? [['Target', 'enemy sniper · prone · shoulders 0.50 m · aim for the head'], ['Scope', 'BDC marks 200–1000 m · mil stadia 2/4/6/8 · zero 100 m'],
      ['Viewpoint', state.answered ? `YOU · ${Math.round(q.sniper.horizontal)} m to the target` : 'unmarked · only the heading is known'],
      ...(q.sniper.wind ? [['Wind', `${q.sniper.wind.speed} m/s from ${String(q.sniper.wind.from).padStart(3, '0')}° · steady`],
        ['Wind card', q.sniper.wind.card.map((c) => `${c.metres} m ${c.milPerMps.toFixed(2)}`).join(' · ') + ' mil per m/s']] : [])] : []),
    ...(q.mode === 'friend' ? [['Person', 'orange jacket · 1.80 m tall'], ['Find by', q.grid ? `${q.grid.size} × ${q.grid.size} grid · ${Math.round(q.grid.cellMetres)} m per side` : 'Point · A / B / C'], ['Viewpoint', q.friend.observerHidden && !state.answered ? 'unmarked · infer from terrain' : 'YOU · observer position'], ['Map area', `${Math.round(q.mapExtent.size)} m × ${Math.round(q.mapExtent.size)} m`]] : []),
    ['Field of view', `${q.camera.fov}° · eye ${q.camera.eyeHeight} m`],
    ['Relief', `${Math.round(q.terrain.min)}–${Math.round(q.terrain.max)} m`],
    ['Contours', `${q.terrain.contourInterval} m (index every ${q.terrain.contourInterval * 5} m)`],
    ['Map', q.mapRotation && !state.settings.northUp ? `rotated ${q.mapRotation}° (see N arrow)` : 'north-up'],
    ['Terrain', q.terrain.archetypes.map((a) => a.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')],
    ['Confidence', `${Math.round(q.validation.confidence * 100)}%${q.lowConfidence ? ' (below threshold)' : ''}`],
    ['Hardness', `${Math.round(q.hardness * 100)}%${q.stats.questionsCompared ? ` (hardest of ${q.stats.questionsCompared} valid questions)` : ''}`],
    ...(q.matching ? [
      ['All three views', `${Math.min(...q.matching.pairs.map((p) => p.D)).toFixed(2)}–${Math.max(...q.matching.pairs.map((p) => p.D)).toFixed(2)}° pairwise difference`],
      ['Option spacing', `at least ${Math.round(q.matching.minSeparation)} m`],
      ['Directions searched', `${q.stats.directions.length} · facing ${q.matching.direction}`],
    ] : []),
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
    : l.stage === 'matching' ? `terrain #${l.attempt} ${l.direction}: ${l.coarse} coarse triples, ${l.refined} refined, ${l.valid} accepted`
    : `terrain #${l.attempt} view ${l.try}: ${l.ok ? 'accepted' : 'rejected'} (confidence ${l.confidence})${l.issues.length ? ' — ' + l.issues.join('; ') : ''}`).join('\n');
}

function setLoading(on, text) {
  state.loading = on;
  $('loading').classList.toggle('hidden', !on);
  if (text) $('loading-text').textContent = text;
}

function setAnswersEnabled(on) {
  for (const b of $('answers').children) b.disabled = !on;
  $('grid-cell').disabled = !on;
  $('grid-submit').disabled = !on;
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
  if (!q || state.answered || state.loading || q.mode === 'facing' || q.mode === 'sniper' || usesGrid(q)) return;
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
    && $('world').value === (q.worldChoice || 'classic') && (q.mode !== 'sniper' || ($('sniper-wind').value === 'on') === !!q.sniper.wind)
    && $('mode').value === q.mode && $('heading-mode').value === (q.headingChoice || 'auto')
    && (q.mode !== 'lookalike' || $('lookalike-direction').value === q.directionChoice);
  const gridSame = q.mode !== 'grid' || (Number($('grid-size').value) === q.grid.size && $('grid-challenge').value === q.grid.challenge);
  const friendSame = q.mode !== 'friend' || ($('friend-challenge').value === q.friend.challenge
    && $('friend-answer').value === q.friend.answerMode && (!q.grid || Number($('grid-size').value) === q.grid.size));
  const trailSame = q.mode !== 'trail' || ($('movement').value === q.trail.movement
    && $('trail-answer').value === q.trail.answerMode && (!q.grid || Number($('grid-size').value) === q.grid.size));
  load({ seed: q.seed, variant: same && gridSame && friendSame && trailSame ? (q.variant || 0) + 1 : 0 });
}

$('controls').addEventListener('submit', (e) => {
  e.preventDefault();
  load({ seed: $('seed').value.trim() });
});
$('new-quiz').addEventListener('click', newQuiz);
$('new-positions').addEventListener('click', newPositions);
$('scramble').addEventListener('click', scrambleOptions);
// Changing mode, difficulty or heading style keeps the seed, so the terrain carries over.
for (const id of ['world', 'sniper-wind', 'difficulty', 'mode', 'heading-mode', 'lookalike-direction', 'grid-size', 'grid-challenge', 'friend-challenge', 'friend-answer', 'movement', 'trail-answer']) {
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
      map.setOverlays({ ...state.settings, landforms: usesSunWatch(state.quiz) && !state.answered ? false : state.settings.landforms });
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
  if (usesClip(state.quiz) && e.code === 'Space') {
    e.preventDefault(); if (sunPlayer.playing) sunPlayer.pause(); else sunPlayer.play(); return;
  }
  if (state.quiz?.mode === 'trail' && (e.code === 'Space' || k === 'F')) {
    e.preventDefault();
    if (k === 'F') trailPlayer.inspect(); else if (trailPlayer.playing) trailPlayer.pause(); else trailPlayer.play();
    return;
  }
  if (state.quiz?.mode === 'facing') {
    // Q W E / A · D / Z X C laid out like the compass rose.
    const dir = { Q: 'NW', W: 'N', E: 'NE', A: 'W', D: 'E', Z: 'SW', X: 'S', C: 'SE' }[k];
    if (dir) { state.answered ? viewFrom(dir) : answer(dir); return; }
  }
  if (state.quiz?.mode === 'sniper' && /^[0-9]$/.test(k)) {
    // With wind, keys pick the n-th mark + windage pair; otherwise the mark (0 = 1000 m).
    const label = state.quiz.sniper.wind ? state.quiz.options[Number(k) - 1]?.label : `${(Number(k) || 10) * 100} m`;
    if (!state.answered) answer(label);
    return;
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

const exportUi = { composer: null, raf: 0, start: 0, busy: false, last: null, now: null };

function exportOptions() {
  const form = $('export-form');
  return {
    format: form.querySelector('[name="format"]:checked').value,
    environment: readEnvironmentControls('export'),
    handle: $('export-handle').value.trim(),
    caption: $('export-caption').checked,
    tape: $('export-tape').checked,
    reveal: $('export-reveal').checked,
    northUp: state.settings.northUp,
    appearance: { ...state.appearance },
    duration: exportDuration(state.quiz),
    easter: $('export-easter').value,
  };
}

/**
 * The seasonal plan for the dialog's choice. `now` was read once when the
 * dialog opened, so the event cannot change between captured frames.
 */
function easterPlan() {
  return planForChoice($('export-easter').value, {
    now: exportUi.now,
    search: location.search,
    reducedMotion: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
  });
}

function updateEasterNote(plan) {
  const auto = $('export-easter').value === 'auto';
  $('export-easter-note').textContent = `${auto ? 'Automatic: ' : ''}${describePlan(plan)}`;
}

/** Only "None" is remembered: a forced Santa or Death Star should not outlive the session. */
function persistableExportOptions(opts) {
  const { easter, ...rest } = opts;
  return { ...rest, easter: easter === 'off' ? 'off' : 'auto' };
}

function restoreExportOptions() {
  setEnvironmentControls('export', state.environment);
  const saved = store.get('otq.export', null);
  if (!saved) return;
  const form = $('export-form');
  const fmt = form.querySelector(`[name="format"][value="${saved.format}"]`);
  if (fmt) fmt.checked = true;
  $('export-handle').value = saved.handle || '';
  $('export-caption').checked = saved.caption !== false;
  $('export-tape').checked = saved.tape !== false;
  $('export-reveal').checked = saved.reveal !== false;
  $('export-easter').value = saved.easter === 'off' ? 'off' : 'auto';
}

function previewLoop() {
  const c = exportUi.composer;
  if (!c) return;
  const now = performance.now();
  if (now >= exportUi.nextFrame) {
    const d = c.options.duration, t = ((now - exportUi.start) / 1000) % d;
    c.animated = true;
    // The dialog displays a small preview; PNG/video capture restores native resolution.
    c.drawFrame(t, { reveal: c.options.reveal && t >= d - 3, preview: true });
    exportUi.nextFrame = now + 50;
  }
  exportUi.raf = requestAnimationFrame(previewLoop);
}

function startPreview() {
  cancelAnimationFrame(exportUi.raf);
  exportUi.start = performance.now();
  exportUi.nextFrame = 0;
  exportUi.raf = requestAnimationFrame(previewLoop);
}

function stopPreview() { cancelAnimationFrame(exportUi.raf); }

function openExport() {
  if (!state.quiz || !renderer) return;
  stopFriendWave();
  exportUi.sunResume = usesClip(state.quiz) && sunPlayer.playing;
  if (usesClip(state.quiz)) sunPlayer.pause();
  $('export-sequence-note').hidden = !usesSunWatch(state.quiz);
  if (state.quiz.mode === 'trail') trailPlayer.pause();
  exportUi.now = new Date();
  $('export-easter').innerHTML = EASTER_CHOICES.map((c) => `<option value="${c.value}">${c.label}</option>`).join('');
  $('export-easter').value = 'auto';
  restoreExportOptions();
  exportUi.composer?.dispose();
  // The seasonal layer follows the dialog's choice; the date was read once above.
  const { easter, ...composerOptions } = exportOptions();
  void easter;
  const plan = easterPlan();
  updateEasterNote(plan);
  exportUi.composer = new ExportComposer(state.quiz, state.model, { ...composerOptions, easterEgg: plan, canvas: $('export-canvas') });
  exportUi.last = null;
  $('export-share').hidden = true;
  $('export-dialog').showModal();
  exportUi.videoPath = null;
  $('export-video').textContent = `Record ${exportUi.composer.options.duration} s video`;
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
  if (exportUi.sunResume && usesClip(state.quiz) && !state.answered && !document.hidden && !reducedMotion.matches) sunPlayer.play();
  scheduleFriendWave();
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
  // Includes the Easter egg select: changing the event mid-recording would mix two events in one video.
  $('export-form').querySelectorAll('input, select').forEach((el) => { el.disabled = on; });
}

async function exportImage(reveal) {
  const c = exportUi.composer;
  stopPreview();
  setExportBusy(true);
  try {
    const blob = await c.toImage({ reveal });
    download(blob, exportName(reveal ? '-answer' : '', 'png'));
    setExportStatus(`Saved ${exportName(reveal ? '-answer' : '', 'png')}`);
  } catch (error) {
    setExportStatus(`Image export failed: ${error.message}`);
  } finally {
    setExportBusy(false); startPreview();
  }
}

async function exportVideo() {
  const c = exportUi.composer;
  stopPreview();
  setExportBusy(true);
  const progress = $('export-progress');
  progress.hidden = false;
  setExportStatus(exportUi.videoPath?.kind === 'recorder' ? `Recording ${c.options.duration} s in real time — keep this tab visible…` : `Rendering ${Math.round(c.options.duration * EXPORT_FPS)} frames…`);
  try {
    c.animated = true;
    const d = c.options.duration;
    const { blob, extension, h264 } = await encodeCanvasVideo(c.canvas, (t) => c.drawFrameReady(t, { reveal: c.options.reveal && t >= d - 3 }), {
      duration: d, fps: EXPORT_FPS, onProgress: (p) => { progress.value = p; },
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
  updateTextureNote('export');
  updateDensityControls('export');
  store.set('otq.export', persistableExportOptions(opts));
  const { easter, ...composerOptions } = opts;
  void easter;
  const plan = easterPlan();
  updateEasterNote(plan);
  exportUi.composer?.setOptions({ ...composerOptions, easterEgg: plan });
  startPreview();
});
$('export-handle').addEventListener('input', () => {
  const opts = exportOptions();
  store.set('otq.export', persistableExportOptions(opts));
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
    seed: p.get('seed'), world: normaliseWorld(p.get('w')), sniperWind: p.get('wind') === '1', difficulty: d && DIFFICULTIES[d] ? d : null, variant: v, scramble: sc,
    mode: ['facing', 'lookalike', 'grid', 'friend', 'trail', 'sniper'].includes(p.get('m')) ? p.get('m') : 'where-am-i',
    gridSize: normaliseGridSize(p.get('g')),
    trailAnswer: normaliseTrailAnswer(p.get('ta')),
    gridChallenge: normaliseGridChallenge(p.get('gc')),
    friendChallenge: normaliseFriendChallenge(p.get('fc')),
    friendAnswer: normaliseFriendAnswer(p.get('fa')),
    friendSkin: normaliseFriendSkin(p.get('fs')),
    movement: normaliseMovement(p.get('mv')),
    appearance: p.get('m') === 'trail' ? normaliseAppearance({ knife: p.get('k'), scale: p.get('ks') === null ? 1 : Number(p.get('ks')), handedness: p.get('hand') }) : null,
    direction: DIRECTIONS.some((d) => d.label === p.get('dir')) ? p.get('dir') : 'auto',
    headingMode: ['exact', 'intercardinal', 'cardinal'].includes(h) ? h : 'auto',
    tuning: p.has('dev') ? decodeTuning(p.get('dev')) : null,
  };
}

window.addEventListener('hashchange', () => {
  const h = parseHash();
  const q = state.quiz;
  if (h.seed && (h.seed !== q?.seed || h.world !== (q?.worldChoice || 'classic') || (h.mode === 'sniper' && h.sniperWind !== !!q?.sniper?.wind) || h.difficulty !== q?.difficulty || h.variant !== (q?.variant || 0) || h.scramble !== (q?.scramble || 0)
    || h.mode !== q?.mode || h.headingMode !== (q?.headingChoice || 'auto')
    || (h.mode === 'lookalike' && h.direction !== q?.directionChoice)
    || (h.mode === 'trail' && (h.movement !== q?.trail?.movement || h.trailAnswer !== q?.trail?.answerMode
      || (h.trailAnswer === 'grid' && h.gridSize !== q?.grid?.size) || JSON.stringify(h.appearance) !== JSON.stringify(q?.appearance)))
    || (h.mode === 'friend' && (h.friendSkin !== q?.friend?.skin || h.friendChallenge !== q?.friend?.challenge || h.friendAnswer !== q?.friend?.answerMode
      || (h.friendAnswer === 'grid' && h.gridSize !== q?.grid?.size)))
    || (h.mode === 'grid' && (h.gridSize !== q?.grid?.size || h.gridChallenge !== q?.grid?.challenge))
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
  $('dev-skyline').checked = !!dev.skyline;
  $('dev-form').hidden = !dev.enabled;
  const watch = $('difficulty').value === 'sun-watch';
  $('dev-sun-note').hidden = !watch;
  const preset = !watch && $('mode').value === 'lookalike' ? getLookalikePreset($('difficulty').value) : DIFFICULTIES[$('difficulty').value] || DIFFICULTIES.medium;
  $('dev-difficulty').textContent = preset.label;
  const mode = $('mode').value;
  $('dev-fields').innerHTML = TUNABLES.map((t) => {
    const def = tunableValue(preset, t);
    const applies = t.key === 'sunLat' ? watch && supportsSunWatch(mode) : def !== undefined && (!t.key.startsWith('facing') || mode === 'facing')
      && !(mode === 'facing' && ['minTrue', 'minSep', 'sameLandform', 'bandMin', 'bandTarget', 'bandMax', 'distractors', 'minConfidence'].includes(t.key))
      && !(mode === 'trail' && !['minQuality', 'minConfidence'].includes(t.key))
      && !(mode === 'friend' && !['minQuality', 'minConfidence'].includes(t.key))
      && !(mode === 'grid' && !['bandMin', 'minQuality', 'minConfidence', 'viewTries'].includes(t.key))
      && !(mode === 'lookalike' && ['distractors', 'viewTries'].includes(t.key));
    const v = dev.values[t.key];
    const label = `${t.label}${t.unit ? ` (${t.unit})` : ''}`;
    if (t.type === 'bool') {
      const checked = v === undefined || v === '' ? def : v === true || v === 'true';
      return `<label class="dev-field${applies ? '' : ' na'}"><span>${label}</span><input type="checkbox" data-key="${t.key}" ${checked ? 'checked' : ''} ${applies ? '' : 'disabled'}></label>`;
    }
    return `<label class="dev-field${applies ? '' : ' na'}" title="${applies ? '' : 'Not used by this difficulty / mode'}"><span>${label}</span><input type="number" data-key="${t.key}" min="${t.min}" max="${t.max}" step="${t.step}" placeholder="${def ?? '—'}" value="${v ?? ''}" ${applies ? '' : 'disabled'}></label>`;
  }).join('');
}

function readDevForm() {
  const preset = $('difficulty').value !== 'sun-watch' && $('mode').value === 'lookalike' ? getLookalikePreset($('difficulty').value) : DIFFICULTIES[$('difficulty').value] || DIFFICULTIES.medium;
  const values = {};
  $('dev-fields').querySelectorAll('[data-key]').forEach((el) => {
    if (el.disabled) return;
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
  if (Object.keys(dev.values).length) load({ seed: $('seed').value.trim(), variant: state.quiz?.variant || 0 });
});
$('dev-form').addEventListener('submit', (e) => {
  e.preventDefault();
  dev.values = readDevForm();
  saveDev();
  load({ seed: $('seed').value.trim(), variant: state.quiz?.variant || 0 });
});
$('dev-skyline').addEventListener('change', () => {
  dev.skyline = $('dev-skyline').checked;
  saveDev();
  if (state.quiz) renderScene(currentCamera());
});
$('dev-reset').addEventListener('click', () => {
  dev.values = {};
  saveDev();
  renderDevPanel();
  load({ seed: $('seed').value.trim(), variant: state.quiz?.variant || 0 });
});
for (const id of ['difficulty', 'mode']) $(id).addEventListener('change', renderDevPanel);

renderScore();
$('trail-answer').value = normaliseTrailAnswer(store.get('otq.trailAnswer', 'trail'));
$('trail-answer').addEventListener('change', () => store.set('otq.trailAnswer', $('trail-answer').value));
const savedGrid = store.get('otq.grid', {});
$('grid-size').value = normaliseGridSize(savedGrid.size);
$('grid-challenge').value = normaliseGridChallenge(savedGrid.challenge);
for (const id of ['grid-size', 'grid-challenge']) $(id).addEventListener('change', () => {
  store.set('otq.grid', { size: Number($('grid-size').value), challenge: $('grid-challenge').value });
});
$('friend-challenge').value = normaliseFriendChallenge(store.get('otq.friend', 'standard'));
$('friend-challenge').addEventListener('change', () => store.set('otq.friend', $('friend-challenge').value));
$('friend-answer').value = normaliseFriendAnswer(store.get('otq.friendAnswer', 'point'));
$('friend-answer').addEventListener('change', () => store.set('otq.friendAnswer', $('friend-answer').value));
$('friend-skin').value = normaliseFriendSkin(store.get('otq.friendSkin', 'classic'));
$('world').innerHTML = WORLD_CHOICES.map((id) => `<option value="${id}" title="${id === 'auto' ? 'A world type chosen from the seed' : WORLDS[id].description}">${id === 'auto' ? 'Auto — by seed' : worldLabel(id)}</option>`).join('');
$('world').value = normaliseWorld(store.get('otq.world', 'classic'));
$('sniper-wind').value = store.get('otq.sniperWind', 'off') === 'on' ? 'on' : 'off';
const initial = parseHash();
adoptLinkTuning(initial.tuning);
renderDevPanel();
if (initial.seed) load({ ...initial, difficulty: initial.difficulty || store.get('otq.difficulty', 'medium') });
else load({ difficulty: store.get('otq.difficulty', 'medium'), mode: store.get('otq.mode', 'where-am-i') });
$('difficulty').addEventListener('change', () => store.set('otq.difficulty', $('difficulty').value));
$('world').addEventListener('change', () => store.set('otq.world', $('world').value));
$('sniper-wind').addEventListener('change', () => store.set('otq.sniperWind', $('sniper-wind').value));
$('mode').addEventListener('change', () => store.set('otq.mode', $('mode').value));
