// Letter scrambling: the answer points stay where they are, only the letters
// on them move. Each scramble step is a derangement (every point gets a new
// letter) drawn from the quiz seed, so "scramble #n" is reproducible.

import { Random } from './rng.js';

/** Returns a copy of `quiz` with its options relabelled by `steps` scrambles. */
export function scrambleLabels(quiz, steps) {
  const labels = quiz.options.map((o) => o.label).sort();
  let current = quiz.options.map((o) => ({ ...o }));
  for (let s = 1; s <= steps; s++) {
    const rng = new Random(`${quiz.seed}#${quiz.difficulty}#${quiz.variant || 0}|scramble|${s}`);
    let next;
    for (let tries = 0; tries < 50; tries++) {
      const perm = rng.shuffle(labels);
      if (current.every((o, i) => perm[i] !== o.label)) { next = perm; break; }
    }
    // Guaranteed fallback derangement: rotate letters by one.
    if (!next) next = current.map((o) => labels[(labels.indexOf(o.label) + 1) % labels.length]);
    current = current.map((o, i) => ({ ...o, label: next[i] }));
  }
  const options = current.sort((a, b) => a.label.localeCompare(b.label));
  return { ...quiz, options, correctLabel: options.find((o) => o.correct).label, scramble: steps };
}
