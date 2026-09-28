// Generates quizzes off the main thread.
import { generateQuiz } from '../engine/quiz.js';

self.onmessage = (e) => {
  const { id, seed, difficulty, variant = 0 } = e.data;
  try {
    const quiz = generateQuiz({ seed, difficulty, variant, onProgress: (message) => self.postMessage({ id, type: 'progress', message }) });
    self.postMessage({ id, type: 'result', quiz }, [quiz.terrain.heights.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.stack || err) });
  }
};
