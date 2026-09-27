// CLI: node scripts/generate.mjs <seed> [difficulty]
import { generateQuiz } from '../src/engine/quiz.js';

const [seed = 'demo', difficulty = 'medium'] = process.argv.slice(2);
const q = generateQuiz({ seed, difficulty, onProgress: (m) => process.stderr.write(`· ${m}\n`) });
const { terrain, log, ...rest } = q;
console.log(JSON.stringify({ ...rest, terrain: { ...terrain, heights: `[${terrain.heights.length} floats]` }, log }, null, 1));
