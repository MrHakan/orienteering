// Batch statistics: node scripts/batch.mjs [count] [difficulty...]
import { generateQuiz } from '../src/engine/quiz.js';

const count = +(process.argv[2] || 10);
const diffs = process.argv.slice(3).length ? process.argv.slice(3) : ['easy', 'medium', 'hard', 'expert'];
for (const difficulty of diffs) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const q = generateQuiz({ seed: `batch${i}`, difficulty });
    rows.push(q);
    console.log(difficulty, `batch${i}`, q.lowConfidence ? 'LOW ' : 'ok  ', `${q.stats.ms}ms`, `att=${q.stats.terrainAttempt}/${q.stats.viewTry}`,
      `q=${q.quality.total.toFixed(2)} conf=${q.validation.confidence.toFixed(2)}`, `D=[${q.options.filter((o) => !o.correct).map((o) => o.D).join(',')}]`,
      `ans=${q.correctLabel}`, q.heading.text, `int=${q.terrain.contourInterval}`, q.terrain.archetypes.join('+'),
      q.lowConfidence ? JSON.stringify(q.validation.issues) : '');
  }
  const ms = rows.map((r) => r.stats.ms);
  console.log(`== ${difficulty}: low=${rows.filter((r) => r.lowConfidence).length}/${count} avg=${Math.round(ms.reduce((a, b) => a + b) / count)}ms max=${Math.max(...ms)}ms`);
}
