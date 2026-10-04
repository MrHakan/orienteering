// World types: alternative terrain recipes built on the same generator.
//
// 'classic' is the original landscape and stays byte-for-byte identical, so
// shared links and saved quizzes keep their terrain. Every other world tunes
// the archetype mix, noise spectrum and erosion, and adds its own landforms
// (see LandformGenerator: cirques, drumlins, eskers, kettles, dolines, cone
// karst, mesas, canyons and dunes). 'auto' picks a world from the seed.

import { Random } from './rng.js';

export const WORLDS = {
  classic: {
    label: 'Classic', description: 'Mixed hills, ridges, valleys and hollows.',
  },
  alpine: {
    label: 'Alpine', texture: 'alpine',
    description: 'High, sharp ridges and arêtes with cirque bowls cut into their flanks.',
    terrain: { relief: 1.22, complexity: 1.1, archetypes: [2, 4] },
    weights: { mountainRidge: 2.4, ridgeNetwork: 1.8, saddlePass: 1.3, narrowValley: 1.3, rollingHills: 0.2, plateau: 0, basin: 0, depression: 0, broadValley: 0.3 },
    ridgeWidth: 0.9,
    noise: [1.15, 1.15, 1.05, 0.95, 0.9], warp: [70, 130],
    erosion: { fluvial: 1.15, talus: 36, thermalIterations: 40, thermalRate: 0.9 },
    features: ['cirques'],
  },
  karst: {
    label: 'Karst', texture: 'moss',
    description: 'Limestone plateau pitted with dolines, around steep cone hills.',
    terrain: { relief: 0.95, complexity: 1, archetypes: [2, 3] },
    weights: { plateau: 1.2, rollingHills: 0.7, mountainRidge: 0.4, ridgeNetwork: 0.3, broadValley: 0.2, narrowValley: 0.2, basin: 0.6, depression: 0 },
    noise: [0.8, 0.9, 1, 1.1, 1.1], warp: [50, 90],
    erosion: { fluvial: 0.45, talus: 36 },
    features: ['coneKarst', 'dolines'],
  },
  glacial: {
    label: 'Glacial', texture: 'meadow',
    description: 'Ice-moulded ground: drumlin swarms, sinuous eskers and kettle holes.',
    terrain: { relief: 0.85, complexity: 0.8, archetypes: [1, 3] },
    weights: { broadValley: 1.6, rollingHills: 1, mountainRidge: 0, ridgeNetwork: 0.2, plateau: 0, basin: 0.6, narrowValley: 0.3, saddlePass: 0.3, depression: 0 },
    noise: [0.7, 0.75, 0.75, 0.7, 0.6], warp: [40, 80],
    erosion: { fluvial: 0.7, talus: 30 },
    features: ['drumlins', 'eskers', 'kettles'],
  },
  canyon: {
    label: 'Canyon', texture: 'desert',
    description: 'Stepped mesas and buttes above a deep, winding canyon.',
    terrain: { relief: 1.15, complexity: 0.9, archetypes: [2, 3] },
    weights: { plateau: 2, rollingHills: 0.35, mountainRidge: 0.3, ridgeNetwork: 0.3, broadValley: 0.8, basin: 0, narrowValley: 0.9, depression: 0, knoll: 0.4 },
    noise: [0.9, 1, 1, 0.85, 0.7], warp: [45, 85],
    erosion: { fluvial: 0.6, talus: 44 },
    features: ['mesas', 'canyon'],
    terrace: { step: 9, strength: 0.35 },
  },
  dunes: {
    label: 'Dunes', texture: 'desert',
    description: 'Sand sea: long asymmetric dune crests riding on giant draa ridges.',
    terrain: { relief: 0.8, complexity: 0.5, archetypes: [0, 0] }, // dunes and draa only
    noise: [0.45, 0.5, 0.55, 0.6, 0.5], warp: [30, 60],
    erosion: { fluvial: 0.15, talus: 32 },
    features: ['duneField'],
  },
};

export const WORLD_IDS = Object.keys(WORLDS);
export const WORLD_CHOICES = ['auto', ...WORLD_IDS];

/** Unknown or missing values mean the original 'classic' world. */
export function normaliseWorld(value) {
  return WORLD_CHOICES.includes(value) ? value : 'classic';
}

/** Resolves 'auto' to a concrete world from the seed alone (shared links reproduce it). */
export function resolveWorld(choice, seed) {
  const world = normaliseWorld(choice);
  if (world !== 'auto') return world;
  return new Random(`world-v1|${seed}`).pick(WORLD_IDS);
}

export function worldLabel(id) {
  return WORLDS[id]?.label || WORLDS.classic.label;
}
