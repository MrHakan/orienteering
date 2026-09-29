// Event selection and preview overrides. Pure functions of their inputs: the
// clock is read once by the caller (never per frame) and passed in as `now`.

import { EASTER_CONFIG } from './config.js';

const pad = (n) => String(n).padStart(2, '0');

/** Strict YYYY-MM-DD check (rejects 2026-02-31). */
export function isValidDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Calendar day (YYYY-MM-DD) of `now` in `timeZone` (null = local zone). */
export function isoDateInZone(now, timeZone = null) {
  if (timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const md = (dateStr) => {
  const [, m, d] = dateStr.split('-').map(Number);
  return m * 100 + d;
};
const mdOf = ([m, d]) => m * 100 + d;

function inWindow(dateStr, [start, end]) {
  const v = md(dateStr), a = mdOf(start), b = mdOf(end);
  return a <= b ? v >= a && v <= b : v >= a || v <= b;
}

/** Which event (if any) a calendar day belongs to. */
export function selectEvent(dateStr, config = EASTER_CONFIG) {
  if (!isValidDate(dateStr)) return null;
  if (config.may4.days.some((d) => mdOf(d) === md(dateStr))) return { key: 'may4', santa: false };
  if (inWindow(dateStr, [config.winter.start, config.winter.end])) {
    return { key: 'winter', santa: config.winter.santaDays.some((d) => mdOf(d) === md(dateStr)) };
  }
  return null;
}

/** Reads ?easterEgg=, ?easterDate=, ?reducedMotion= from a query string. */
export function parsePreview(search) {
  const p = new URLSearchParams(search || '');
  const egg = (p.get('easterEgg') || '').toLowerCase();
  const date = p.get('easterDate');
  const rm = p.get('reducedMotion');
  return {
    egg: ['winter', 'santa', 'may4', 'off'].includes(egg) ? egg : ['none', '0', 'false'].includes(egg) ? 'off' : null,
    date: isValidDate(date) ? date : null,
    reducedMotion: rm === '1' || rm === 'true' ? true : rm === '0' || rm === 'false' ? false : null,
  };
}

/**
 * Decides the Easter egg for one render.
 *
 * Priority: ?easterEgg=off, then ?easterEgg=winter|santa|may4 (any date),
 * then ?easterDate=, then the real day in the configured zone.
 * `santa` is shorthand for winter with the sleigh (Dec 24 unless a date is given).
 *
 * @param {{now?:Date, search?:string, config?:object, reducedMotion?:boolean}} opts
 * @returns {null | {key:'winter'|'may4', date:string, santa:boolean, preview:boolean, reducedMotion:boolean}}
 */
export function resolveEasterEgg({ now = new Date(), search = '', config = EASTER_CONFIG, reducedMotion = false } = {}) {
  const pv = parsePreview(search);
  const today = isoDateInZone(now, config.timeZone);
  const year = today.slice(0, 4);
  const rm = pv.reducedMotion ?? reducedMotion;
  if (pv.egg === 'off') return null;

  if (pv.egg === 'winter' || pv.egg === 'santa' || pv.egg === 'may4') {
    const key = pv.egg === 'may4' ? 'may4' : 'winter';
    const date = pv.date || (pv.egg === 'santa' ? `${year}-12-24` : pv.egg === 'may4' ? `${year}-05-04` : today);
    const santa = key === 'winter' && (pv.egg === 'santa' || selectEvent(date, config)?.santa === true);
    return { key, date, santa, preview: true, reducedMotion: rm };
  }

  const date = pv.date || today;
  const ev = selectEvent(date, config);
  return ev ? { key: ev.key, date, santa: ev.santa, preview: !!pv.date, reducedMotion: rm } : null;
}
