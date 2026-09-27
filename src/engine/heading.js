// Heading selection and formatting.

import { wrap360 } from './grid.js';

export const CARDINALS = ['NORTH', 'EAST', 'SOUTH', 'WEST'];
export const INTERCARDINALS = ['NORTH', 'NORTH-EAST', 'EAST', 'SOUTH-EAST', 'SOUTH', 'SOUTH-WEST', 'WEST', 'NORTH-WEST'];
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

/** Candidate headings evaluated at each observer position. */
export function candidateHeadings(mode, rng) {
  if (mode === 'cardinal') return [0, 90, 180, 270];
  if (mode === 'intercardinal') return [0, 45, 90, 135, 180, 225, 270, 315];
  const base = rng.range(0, 45);
  return Array.from({ length: 8 }, (_, i) => Math.round(wrap360(base + i * 45 + rng.range(-10, 10))));
}

export function formatHeading(heading, mode) {
  const h = wrap360(Math.round(heading));
  const arrow = ARROWS[Math.round(h / 45) % 8];
  if (mode === 'cardinal') return { text: `FACING ${CARDINALS[Math.round(h / 90) % 4]}`, arrow };
  if (mode === 'intercardinal') return { text: `FACING ${INTERCARDINALS[Math.round(h / 45) % 8]}`, arrow };
  return { text: `FACING ${String(h).padStart(3, '0')}°`, arrow };
}
