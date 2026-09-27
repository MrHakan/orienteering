// Difficulty presets. Everything difficulty-dependent lives here so the
// generator, viewpoint search, distractor search and validator stay generic.

export const DIFFICULTIES = {
  easy: {
    label: 'Easy',
    terrain: { archetypes: [2, 3], relief: 1.6, complexity: 0.2, noiseShare: [0.18, 0.24] },
    heading: 'cardinal',
    distractors: 2,
    fov: [68, 75],
    minSeparation: 420,
    // View-descriptor distance band (degrees RMS) for distractors.
    band: { min: 2.6, target: 4.5, max: 9 },
    signatureWeight: 0.2,
    quality: { landmark: 1.3, occlusion: 1.4 },
    minQuality: 0.5,
    minConfidence: 0.55,
    mapRotation: false,
  },
  medium: {
    label: 'Medium',
    terrain: { archetypes: [3, 4], relief: 1.45, complexity: 0.45, noiseShare: [0.22, 0.28] },
    heading: 'intercardinal',
    distractors: 2,
    fov: [60, 72],
    minSeparation: 330,
    band: { min: 1.8, target: 3.2, max: 6.5 },
    signatureWeight: 0.4,
    quality: { landmark: 1.1, occlusion: 1.2 },
    minQuality: 0.45,
    minConfidence: 0.5,
    mapRotation: false,
  },
  hard: {
    label: 'Hard',
    terrain: { archetypes: [3, 5], relief: 1.35, complexity: 0.7, noiseShare: [0.25, 0.32] },
    heading: 'exact',
    distractors: 3,
    fov: [55, 70],
    minSeparation: 260,
    band: { min: 1.3, target: 2.3, max: 4.5 },
    signatureWeight: 0.6,
    quality: { landmark: 1.0, occlusion: 1.0 },
    minQuality: 0.4,
    minConfidence: 0.45,
    mapRotation: true,
  },
  expert: {
    label: 'Expert',
    terrain: { archetypes: [4, 5], relief: 1.3, complexity: 0.95, noiseShare: [0.28, 0.35] },
    heading: 'exact',
    distractors: 3,
    fov: [55, 65],
    minSeparation: 220,
    band: { min: 1.0, target: 1.8, max: 3.5 },
    signatureWeight: 0.85,
    quality: { landmark: 0.9, occlusion: 0.7 },
    minQuality: 0.35,
    minConfidence: 0.4,
    mapRotation: true,
  },
};

export function getDifficulty(name) {
  return DIFFICULTIES[name] || DIFFICULTIES.medium;
}
