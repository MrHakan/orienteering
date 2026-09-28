// Generates quizzes off the main thread.
import { generate } from '../engine/quiz.js';

self.onmessage = async (e) => {
  const { id, seed, difficulty, variant = 0, mode, headingMode, tuning } = e.data;
  try {
    const quiz = await generate({ seed, difficulty, variant, mode, headingMode, tuning, onProgress: (message) => self.postMessage({ id, type: 'progress', message }) });
    self.postMessage({ id, type: 'result', quiz }, [quiz.terrain.heights.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.stack || err) });
  }
};
