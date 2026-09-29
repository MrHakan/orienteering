// CLI: node scripts/generate.mjs <seed> [difficulty] [mode] [direction]
import { generate } from '../src/engine/quiz.js';

const [seed = 'demo', difficulty = 'medium', mode = 'where-am-i', direction = 'auto'] = process.argv.slice(2);
const q = await generate({ seed, difficulty, mode, direction, onProgress: (m) => process.stderr.write(`· ${m}\n`) });
const { terrain, log, ...rest } = q;
console.log(JSON.stringify({ ...rest, terrain: { ...terrain, heights: `[${terrain.heights.length} floats]` }, log }, null, 1));
