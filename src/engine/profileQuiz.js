// Profile matching: a straight line from ▲ to ◎ is drawn on the map; which of
// four elevation profiles is its cross-section? Distractors are the same line
// reversed (◎ to ▲), lines turned about the same centre, parallel lines a
// little to the side, or lines elsewhere — closer look-alikes on harder levels.

import { now } from './quiz.js';
import { terrains, scaffold, profileAlong } from './mapModes.js';

const BANDS = {
  easy: { kinds: ['reversed', 'elsewhere', 'elsewhere'], minRms: 10, turn: [18, 50], offset: [70, 140] },
  medium: { kinds: ['reversed', 'turned', 'elsewhere'], minRms: 7, turn: [18, 50], offset: [70, 140] },
  hard: { kinds: ['reversed', 'turned', 'parallel'], minRms: 5, turn: [14, 40], offset: [55, 120] },
  expert: { kinds: ['reversed', 'turned', 'parallel'], minRms: 4, turn: [12, 32], offset: [45, 100] },
  master: { kinds: ['reversed', 'turned', 'parallel'], minRms: 3.2, turn: [9, 24], offset: [35, 80] },
};
const rms = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);

export function generateProfileQuiz(opts) {
  const difficulty = BANDS[opts.difficulty] ? opts.difficulty : 'medium', band = BANDS[difficulty], t0 = now();
  for (const built of terrains({ ...opts, difficulty }, 'profile')) {
    const { model, rng } = built, L = model.size;
    const line = (c, angle, len) => ({ a: { x: c.x - Math.sin(angle) * len / 2, y: c.y - Math.cos(angle) * len / 2 }, b: { x: c.x + Math.sin(angle) * len / 2, y: c.y + Math.cos(angle) * len / 2 } });
    const inside = (l) => model.inside(l.a.x, l.a.y, 60) && model.inside(l.b.x, l.b.y, 60);
    for (let tries = 0; tries < 120; tries++) {
      const c = { x: rng.range(0.25, 0.75) * L, y: rng.range(0.25, 0.75) * L }, angle = rng.range(0, Math.PI * 2), len = rng.range(500, 1100);
      const main = line(c, angle, len);
      if (!inside(main)) continue;
      const truth = profileAlong(model, main.a, main.b);
      if (Math.max(...truth) - Math.min(...truth) < 25) continue;
      const distractors = [];
      const closest = ['hard', 'expert', 'master'].includes(difficulty);
      for (const kind of band.kinds) {
        let pick = null;
        for (let k = 0; k < 25; k++) {
          let l = null, profile;
          if (kind === 'reversed') { l = { a: main.b, b: main.a }; profile = [...truth].reverse(); }
          else {
            if (kind === 'turned') l = line(c, angle + rng.range(...band.turn) * Math.PI / 180 * rng.sign(), len);
            if (kind === 'parallel') { const off = rng.range(...band.offset) * rng.sign(); l = line({ x: c.x + Math.cos(angle) * off, y: c.y - Math.sin(angle) * off }, angle, len); }
            if (kind === 'elsewhere') l = line({ x: rng.range(0.25, 0.75) * L, y: rng.range(0.25, 0.75) * L }, rng.range(0, Math.PI * 2), len);
            if (!inside(l)) continue;
            profile = profileAlong(model, l.a, l.b);
          }
          if (![truth, ...distractors.map((d) => d.profile)].every((p) => rms(p, profile) >= band.minRms)) continue;
          // Harder levels keep the closest qualifying look-alike instead of the first.
          if (!pick || rms(truth, profile) < rms(truth, pick.profile)) pick = { kind, line: l, profile };
          if (!closest || kind === 'reversed') break;
        }
        if (pick) distractors.push(pick);
      }
      if (distractors.length < 3) continue;
      const what = { truth: 'the line ▲ → ◎', reversed: 'the same line backwards (◎ → ▲)', turned: 'a line turned about the same centre', parallel: 'a parallel line beside it', elsewhere: 'a line elsewhere on the map' };
      const options = rng.shuffle([{ kind: 'truth', line: main, profile: truth }, ...distractors]).map((d, i) => ({
        label: 'ABCD'[i], kind: d.kind, what: what[d.kind], correct: d.kind === 'truth', profile: d.profile,
        line: { a: { x: +d.line.a.x.toFixed(1), y: +d.line.a.y.toFixed(1) }, b: { x: +d.line.b.x.toFixed(1), y: +d.line.b.y.toFixed(1) } },
        rms: +rms(truth, d.profile).toFixed(2) }));
      const correct = options.find((o) => o.correct);
      const camera = { x: main.a.x, y: main.a.y, z: truth[0] + 1.7, eyeHeight: 1.7, heading: angle * 180 / Math.PI, fov: 52, pitch: 0, roll: 0 };
      const quiz = scaffold({ ...built, mode: 'profile', seed: opts.seed, difficulty, variant: opts.variant || 0, camera, t0, extra: {
        profileLine: { a: main.a, b: main.b, length: len }, options, correctLabel: correct.label,
        hardness: Math.min(1, 0.3 + (10 - band.minRms) / 10),
        map: {
          markers: false, centre: c, drone: { radius: Math.max(900, len * 1.15), height: 330 },
          extras: [{ type: 'line', points: [main.a, main.b], color: '#c34fd9', width: 2.6, halo: true },
            { type: 'point', shape: 'start', x: main.a.x, y: main.a.y, color: '#c34fd9' }, { type: 'point', shape: 'finish', x: main.b.x, y: main.b.y, color: '#c34fd9' }],
          revealExtras: options.filter((o) => !o.correct && o.kind !== 'reversed').map((o) => ({ type: 'line', points: [o.line.a, o.line.b], color: 'rgba(207, 211, 214, .7)', width: 1.4, dash: [5, 4], label: o.label, arrow: true })),
        },
      } });
      quiz.explanation = profileExplanation(quiz);
      return quiz;
    }
  }
  throw new Error('No clear profile question found for this seed. Try another seed.');
}

export function profileExplanation(quiz) {
  const correct = quiz.options.find((o) => o.correct), p = correct.profile;
  const hi = p.indexOf(Math.max(...p)), lo = p.indexOf(Math.min(...p)), at = (i) => Math.round(i / (p.length - 1) * quiz.profileLine.length);
  return { version: 1, language: 'en', source: 'elevation-profile', kind: 'profile',
    correct: { label: correct.label, summary: `${correct.label} is the cross-section of the line from ▲ to ◎.`,
      evidence: [{ type: 'profile-shape', text: `Along the line the ground starts at ${Math.round(p[0])} m, reaches its highest point (${Math.round(p[hi])} m) about ${at(hi)} m from ▲ and its lowest (${Math.round(p[lo])} m) about ${at(lo)} m from ▲, ending at ${Math.round(p[p.length - 1])} m.`,
        data: { startMetres: p[0], endMetres: p[p.length - 1], highMetres: p[hi], highAt: at(hi), lowMetres: p[lo], lowAt: at(lo) } }] },
    closestLabels: quiz.options.filter((o) => !o.correct).sort((a, b) => a.rms - b.rms).map((o) => o.label),
    alternatives: quiz.options.filter((o) => !o.correct).map((o) => ({ label: o.label, difference: o.rms, status: 'distinguished',
      plausibility: o.kind === 'reversed' ? 'The right shape, but read from the wrong end.' : '',
      reasons: [{ type: 'other-line', text: `${o.label} is ${o.what}; it differs from the true profile by ${o.rms.toFixed(1)} m on average${o.kind === 'reversed' ? ` — its start is the ${Math.round(o.profile[0])} m of ◎` : ''}.`,
        data: { kind: o.kind, rmsMetres: o.rms } }] })) };
}
