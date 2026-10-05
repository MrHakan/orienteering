import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKey, isDateKey, dailyPlan, dailyStreak, dailyShareText, DAILY_MODES, encodeChallenge, decodeChallenge, compareChallenge,
  RUN_LENGTH, runPlan, runPoints, runShareText } from '../src/ui/play.js';

test('daily: the same plan for everyone on a UTC day, rotating modes, weekday difficulty', () => {
  assert.equal(dateKey(Date.UTC(2026, 9, 5, 23, 59)), '2026-10-05');
  assert.ok(isDateKey('2026-10-05') && !isDateKey('2026-13-40') && !isDateKey('x'));
  const a = dailyPlan('2026-10-05');
  assert.deepEqual(a, dailyPlan('2026-10-05'));
  assert.equal(a.seed, 'daily-2026-10-05');
  assert.equal(a.difficulty, 'easy', 'Monday is easy');
  assert.equal(dailyPlan('2026-10-11').difficulty, 'master', 'Sunday is master');
  assert.equal(dailyPlan('2026-01-01').number, 1);
  const modes = new Set(Array.from({ length: DAILY_MODES.length }, (_, i) => dailyPlan(dateKey(Date.UTC(2026, 9, 1 + i))).mode));
  assert.equal(modes.size, DAILY_MODES.length, 'every mode in one cycle');
});

test('daily streak counts consecutive days, and stays alive until today is played', () => {
  const h = { '2026-10-02': { correct: true }, '2026-10-03': { correct: false }, '2026-10-04': { correct: true } };
  assert.deepEqual(dailyStreak(h, '2026-10-05'), { played: 3, won: 1 });
  assert.deepEqual(dailyStreak({ ...h, '2026-10-05': { correct: true } }, '2026-10-05'), { played: 4, won: 2 });
  assert.deepEqual(dailyStreak(h, '2026-10-07'), { played: 0, won: 0 });
  const text = dailyShareText(dailyPlan('2026-10-05'), { correct: true, seconds: 17.6 }, { played: 4 }, 'https://x/#daily=2026-10-05');
  assert.match(text, /Daily #278 · .* · Easy\n🟩 18 s · 🔥 4\nhttps:\/\/x\/#daily=2026-10-05/);
});

test('challenge links carry the result, never the answer, and survive tampering', () => {
  const token = encodeChallenge({ name: 'Ayşe <b>', correct: true, seconds: 12.34 });
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  const c = decodeChallenge(token);
  assert.deepEqual(c, { name: 'Ayşe b', correct: true, seconds: 12.3 });
  assert.equal(decodeChallenge('not-a-token'), null);
  assert.equal(decodeChallenge(encodeChallenge({ correct: true, seconds: 1 }).slice(3)), null);
  assert.equal(decodeChallenge(encodeChallenge({ correct: false, seconds: 3 })).name, 'A friend');
  assert.equal(compareChallenge({ correct: true, seconds: 20 }, { correct: false, seconds: 5 }), 'win');
  assert.equal(compareChallenge({ correct: true, seconds: 20 }, { correct: true, seconds: 5 }), 'lose');
  assert.equal(compareChallenge({ correct: false, seconds: 5 }, { correct: false, seconds: 5.02 }), 'draw');
});

test('run: ten mixed questions with rising difficulty and a speed bonus', () => {
  const plan = runPlan('abcd-1234');
  assert.equal(plan.length, RUN_LENGTH);
  assert.deepEqual(plan, runPlan('abcd-1234'));
  assert.equal(plan[0].difficulty, 'easy'); assert.equal(plan[9].difficulty, 'master');
  plan.forEach((q, i) => { if (i) assert.notEqual(q.mode, plan[i - 1].mode); });
  assert.equal(runPoints(false, 3), 0);
  assert.equal(runPoints(true, 2), 150);
  assert.equal(runPoints(true, 30), 125);
  assert.equal(runPoints(true, 300), 100);
  assert.match(runShareText([{ correct: true }, { correct: false }], 250, 200, 'u'), /250 pts · new best!\n🟩🟥\nu/);
});
