// Difficulty presets. Everything difficulty-dependent lives here so the
// generator, viewpoint search, distractor search and validator stay generic.

export const DIFFICULTIES = {
  'sun-watch': {
    label: 'Sun & watch',
    sunWatchLatitude: 0,
    terrain: { archetypes: [3, 4], relief: 1.45, complexity: 0.45, noiseShare: [0.22, 0.28] },
    heading: 'intercardinal', distractors: 2, fov: [60, 66],
    minSeparation: 420, minTrueDistance: 420,
    band: { min: 0, target: 1.2, max: 2.8 }, signatureWeight: 0.4,
    quality: { landmark: 1.1, occlusion: 1.2 }, minQuality: 0.42,
    minConfidence: 0.5, mapRotation: false,
  },
  easy: {
    label: 'Easy',
    terrain: { archetypes: [2, 3], relief: 1.6, complexity: 0.2, noiseShare: [0.18, 0.24] },
    heading: 'cardinal',
    distractors: 2,
    fov: [68, 75],
    minSeparation: 420,      // between any two options (m)
    minTrueDistance: 480,    // true position to each distractor (m)
    // View-descriptor distance band (degrees RMS) for distractors.
    band: { min: 2.6, target: 4.5, max: 9 },
    signatureWeight: 0.2,
    quality: { landmark: 1.3, occlusion: 1.4 },
    minQuality: 0.5,
    minConfidence: 0.55,
    mapRotation: false,
    // "Which way?" mode: the closest-looking wrong direction must differ by at
    // least minD (deg RMS); views where it differs by more than maxD are
    // only used when nothing harder is valid.
    facing: { minD: 3.2 },
  },
  medium: {
    label: 'Medium',
    terrain: { archetypes: [3, 4], relief: 1.45, complexity: 0.45, noiseShare: [0.22, 0.28] },
    heading: 'intercardinal',
    distractors: 2,
    fov: [60, 72],
    minSeparation: 380,
    minTrueDistance: 460,
    band: { min: 1.8, target: 3.2, max: 6.5 },
    signatureWeight: 0.4,
    quality: { landmark: 1.1, occlusion: 1.2 },
    minQuality: 0.45,
    minConfidence: 0.5,
    mapRotation: false,
    // "Which way?" mode: the closest-looking wrong direction must differ by at
    // least minD (deg RMS); views where it differs by more than maxD are
    // only used when nothing harder is valid.
    facing: { minD: 2.4, maxD: 6 },
  },
  hard: {
    label: 'Hard',
    terrain: { archetypes: [3, 5], relief: 1.35, complexity: 0.7, noiseShare: [0.25, 0.32] },
    heading: 'exact',
    distractors: 3,
    fov: [55, 70],
    minSeparation: 360,
    minTrueDistance: 460,
    band: { min: 1.3, target: 2.3, max: 4.5 },
    signatureWeight: 0.6,
    quality: { landmark: 1.0, occlusion: 1.0 },
    minQuality: 0.4,
    minConfidence: 0.45,
    mapRotation: true,
    // "Which way?" mode: the closest-looking wrong direction must differ by at
    // least minD (deg RMS); views where it differs by more than maxD are
    // only used when nothing harder is valid.
    facing: { minD: 1.8, maxD: 4 },
  },
  expert: {
    label: 'Expert',
    terrain: { archetypes: [4, 5], relief: 1.3, complexity: 0.95, noiseShare: [0.28, 0.35] },
    heading: 'exact',
    distractors: 3,
    fov: [55, 65],
    minSeparation: 360,
    minTrueDistance: 480,
    band: { min: 1.0, target: 1.8, max: 3.5 },
    signatureWeight: 0.85,
    quality: { landmark: 0.9, occlusion: 0.7 },
    minQuality: 0.35,
    minConfidence: 0.4,
    mapRotation: true,
    // "Which way?" mode: the closest-looking wrong direction must differ by at
    // least minD (deg RMS); views where it differs by more than maxD are
    // only used when nothing harder is valid.
    facing: { minD: 1.4, maxD: 3 },
  },
  // Brain-burner: many viewpoints are fully evaluated and the question whose
  // distractors are hardest to rule out - while each still differs visibly
  // somewhere in the scene - is kept.
  master: {
    label: 'Master',
    terrain: { archetypes: [4, 5], relief: 1.4, complexity: 1.0, noiseShare: [0.24, 0.3] },
    heading: 'exact',
    distractors: 2,
    fov: [58, 66],
    minSeparation: 380,
    minTrueDistance: 500,
    band: { min: 0.9, target: 1.3, max: 3.0 },
    signatureWeight: 0.35,
    quality: { landmark: 1.1, occlusion: 1.1 },
    minQuality: 0.55,
    minConfidence: 0.35,
    mapRotation: true,
    // "Which way?" mode: the closest-looking wrong direction must differ by at
    // least minD (deg RMS); views where it differs by more than maxD are
    // only used when nothing harder is valid.
    facing: { minD: 1.0 },
    search: {
      viewTries: 48,   // viewpoints fully evaluated per terrain
      cue: 1.6,        // every distractor needs a visible skyline difference of at least this (deg)
      shortlist: 3,    // final pick is random among the N hardest valid questions
      pickPower: 6,    // sharper preference for the closest-looking distractors
    },
  },
};

export function getDifficulty(name) {
  return DIFFICULTIES[name] || DIFFICULTIES.medium;
}

/**
 * Developer-mode tunables. Each maps a short key (used in links: &dev=key:value)
 * to a path in a difficulty preset. Unset keys keep the preset's value.
 */
export const TUNABLES = [
  { key: 'sunLat', label: 'Sun/watch latitude: north +, south −', unit: '°', path: ['sunWatchLatitude'], min: -80, max: 80, step: 1 },
  { key: 'minTrue', label: 'Min distance, true point to distractor', unit: 'm', path: ['minTrueDistance'], min: 0, max: 1500, step: 10 },
  { key: 'minSep', label: 'Min distance between options', unit: 'm', path: ['minSeparation'], min: 0, max: 1500, step: 10 },
  { key: 'sameLandform', label: 'Reject options on the same landform', type: 'bool', path: ['rejectSameLandform'], fallback: true },
  { key: 'bandMin', label: 'View difference: min (ambiguity limit)', unit: '°', path: ['band', 'min'], min: 0, max: 20, step: 0.1 },
  { key: 'bandTarget', label: 'View difference: target', unit: '°', path: ['band', 'target'], min: 0, max: 20, step: 0.1 },
  { key: 'bandMax', label: 'View difference: max (plausibility limit)', unit: '°', path: ['band', 'max'], min: 0, max: 30, step: 0.1 },
  { key: 'distractors', label: 'Distractors', path: ['distractors'], min: 1, max: 4, step: 1 },
  { key: 'minQuality', label: 'Min view quality', path: ['minQuality'], min: 0, max: 1, step: 0.05 },
  { key: 'minConfidence', label: 'Min confidence', path: ['minConfidence'], min: 0, max: 1, step: 0.05 },
  { key: 'cue', label: 'Min visible skyline cue (Master)', unit: '°', path: ['search', 'cue'], min: 0, max: 10, step: 0.1 },
  { key: 'viewTries', label: 'Viewpoints searched (Master)', path: ['search', 'viewTries'], min: 4, max: 120, step: 1 },
  { key: 'facingMinD', label: '"Which way?": min difference to other directions', unit: '°', path: ['facing', 'minD'], min: 0, max: 20, step: 0.1 },
  { key: 'facingMaxD', label: '"Which way?": prefer views below', unit: '°', path: ['facing', 'maxD'], min: 0, max: 30, step: 0.1 },
];

const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Current (default) value of a tunable for a preset. */
export function tunableValue(preset, t) {
  const v = getPath(preset, t.path);
  return v === undefined ? t.fallback : v;
}

/**
 * Returns a copy of `preset` with developer overrides applied. Values are
 * clamped to each tunable's range; unknown keys are ignored. Paths into
 * objects the preset lacks (e.g. search on non-Master presets) are skipped.
 */
export function applyTuning(preset, tuning) {
  if (!tuning || !Object.keys(tuning).length) return preset;
  const out = structuredClone(preset);
  for (const t of TUNABLES) {
    if (!(t.key in tuning)) continue;
    let v = tuning[t.key];
    if (t.type === 'bool') v = v === true || v === 'true' || v === 1 || v === '1';
    else {
      v = Number(v);
      if (!Number.isFinite(v)) continue;
      v = Math.min(t.max, Math.max(t.min, v));
    }
    let o = out;
    for (let i = 0; i < t.path.length - 1; i++) {
      if (o[t.path[i]] == null) { o = null; break; }
      o = o[t.path[i]];
    }
    if (o) o[t.path[t.path.length - 1]] = v;
  }
  if (out.band.min > out.band.max) out.band.max = out.band.min;
  out.band.target = Math.min(out.band.max, Math.max(out.band.min, out.band.target));
  return out;
}

/** "key:value,key:value" <-> object, for links. */
export function encodeTuning(tuning) {
  return Object.entries(tuning || {}).map(([k, v]) => `${k}:${v}`).join(',');
}
export function decodeTuning(str) {
  const out = {};
  for (const part of String(str || '').split(',')) {
    const [k, v] = part.split(':');
    if (k && v !== undefined && TUNABLES.some((t) => t.key === k)) out[k] = v;
  }
  return out;
}
