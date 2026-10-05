// Play layer around the quizzes: the daily challenge, friend challenges and
// 10-question runs. Pure functions (no DOM, no clock of their own) so links,
// streaks and scores are reproducible and testable in Node.

import { Random } from '../engine/rng.js';

// ------------------------------------------------------------------ daily

/** Modes that rotate through the daily challenge (all reliable at every difficulty). */
export const DAILY_MODES = ['where-am-i', 'route', 'facing', 'resection', 'visibility', 'lookalike', 'profile', 'sniper', 'drainage', 'friend', 'fog', 'grid'];
/** Monday easy … Sunday master (UTC weekday). */
export const DAILY_DIFFICULTY = ['master', 'easy', 'medium', 'medium', 'hard', 'hard', 'expert'];
const EPOCH = Date.UTC(2026, 0, 1);

export const MODE_NAMES = {
  'where-am-i': 'Where are you?', facing: 'Which way?', lookalike: 'Look-alikes', grid: 'Grid', friend: 'Find your friend', trail: 'Bunny-hop',
  sniper: 'Sniper', resection: 'Resection', route: 'Route choice', visibility: 'Intervisibility', profile: 'Profile', drainage: 'Drainage', fog: 'Fog navigation',
};

/** UTC calendar date of a timestamp, as YYYY-MM-DD. */
export const dateKey = (ms) => new Date(ms).toISOString().slice(0, 10);
export const isDateKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const dayIndex = (key) => Math.round((Date.parse(`${key}T00:00:00Z`) - EPOCH) / 86400000);

/** The same question for everyone on a given UTC day. */
export function dailyPlan(key) {
  const day = dayIndex(key), weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
  return { date: key, number: day + 1, seed: `daily-${key}`, mode: DAILY_MODES[((day % DAILY_MODES.length) + DAILY_MODES.length) % DAILY_MODES.length],
    difficulty: DAILY_DIFFICULTY[weekday], world: 'auto' };
}

const shiftDay = (key, days) => dateKey(Date.parse(`${key}T00:00:00Z`) + days * 86400000);

/** Consecutive days played (and won) up to today — or up to yesterday while today is still open. */
export function dailyStreak(history, today) {
  let day = history[today] ? today : shiftDay(today, -1), played = 0, won = 0, winning = true;
  while (history[day]) { played++; if (winning && history[day].correct) won++; else winning = false; day = shiftDay(day, -1); }
  return { played, won };
}

export function dailyShareText(plan, result, streak, url) {
  const mark = result.correct ? '🟩' : '🟥';
  return `Terrain Quiz Daily #${plan.number} · ${MODE_NAMES[plan.mode] || plan.mode} · ${plan.difficulty[0].toUpperCase()}${plan.difficulty.slice(1)}\n`
    + `${mark} ${Math.round(result.seconds)} s${streak.played > 1 ? ` · 🔥 ${streak.played}` : ''}\n${url}`;
}

// -------------------------------------------------------------- challenge

const b64 = (s) => (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, 'utf8').toString('base64'))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => { const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return typeof atob === 'function' ? decodeURIComponent(escape(atob(t))) : Buffer.from(t, 'base64').toString('utf8'); };

/** A friend's result travels in the link — never the answer itself. */
export function encodeChallenge({ name = '', correct, seconds }) {
  return b64(JSON.stringify({ v: 1, n: String(name).slice(0, 24), ok: correct ? 1 : 0, t: Math.round(seconds * 10) / 10 }));
}

export function decodeChallenge(token) {
  try {
    const c = JSON.parse(unb64(String(token)));
    if (c.v !== 1 || !Number.isFinite(c.t) || c.t < 0 || c.t > 36000) return null;
    return { name: String(c.n || '').replace(/[<>&"']/g, '').slice(0, 24) || 'A friend', correct: c.ok === 1, seconds: c.t };
  } catch { return null; }
}

/** Correct beats wrong; between equal results, the faster time wins. */
export function compareChallenge(mine, theirs) {
  if (mine.correct !== theirs.correct) return mine.correct ? 'win' : 'lose';
  const d = mine.seconds - theirs.seconds;
  return Math.abs(d) < 0.05 ? 'draw' : d < 0 ? 'win' : 'lose';
}

// -------------------------------------------------------------------- run

export const RUN_LENGTH = 10;
export const RUN_DIFFICULTY = ['easy', 'easy', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard', 'expert', 'master'];
const RUN_MODES = ['where-am-i', 'facing', 'route', 'resection', 'visibility', 'profile', 'drainage', 'sniper', 'lookalike', 'fog', 'friend', 'grid'];

/** Ten mixed questions with rising difficulty; no mode twice in a row. */
export function runPlan(runSeed) {
  const rng = new Random(`run-v1|${runSeed}`), modes = rng.shuffle(RUN_MODES);
  return RUN_DIFFICULTY.map((difficulty, i) => ({ index: i, seed: `${runSeed}-${i + 1}`, mode: modes[i % modes.length], difficulty }));
}

/** 100 for a correct answer plus up to 50 for speed (1 point per second after the first 5). */
export const runPoints = (correct, seconds) => (correct ? 100 + Math.max(0, Math.min(50, Math.round(55 - seconds))) : 0);

export function runShareText(results, total, best, url) {
  return `Terrain Quiz run · ${total} pts${total >= best ? ' · new best!' : ` · best ${best}`}\n${results.map((r) => (r.correct ? '🟩' : '🟥')).join('')}\n${url}`;
}
