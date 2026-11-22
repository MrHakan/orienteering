import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, markdown, stats, correlation, byWorld, summarise } from '../scripts/quality-report.mjs';

const KEYS = {
  grid: ['weakCue', 'lookalikes', 'closestD', 'adjacent', 'edge'],
  resection: ['anyUnrefuted', 'unrefuted', 'fixTolerance', 'minPeakSize', 'farPeak', 'edge'],
  friend: ['centreAmbiguous', 'centreMinD', 'flagged', 'edge'],
};

test('quality report measures every main mode with finite numbers and repeats exactly', async () => {
  const first = await measure({ n: 2, prefix: 'qr' }), again = await measure({ n: 1, prefix: 'qr' });
  assert.deepEqual(Object.keys(first), ['grid', 'resection', 'friend']);
  for (const [mode, m] of Object.entries(first)) {
    assert.equal(m.failed.length, 0, mode);
    assert.equal(m.rows.length, 2, mode);
    for (const row of m.rows) {
      for (const key of ['hardness', 'confidence', 'margin', 'ms', ...KEYS[mode]]) assert.ok(Number.isFinite(row[key]), `${mode}.${key} = ${row[key]}`);
      assert.ok(row.hardness >= 0 && row.hardness <= 1 && row.confidence >= 0 && row.confidence <= 1, mode);
      assert.ok(row.margin >= 0 && row.margin <= 0.5, mode);
    }
    for (const key of ['min', 'p10', 'p50', 'p90', 'max', 'sd', 'uniq']) assert.ok(Number.isFinite(m.stats.hardness[key]), `${mode} hardness ${key}`);
    const pick = (r) => r.rows.map(({ seed, label, hardness, confidence }) => ({ seed, label, hardness, confidence }));
    assert.deepEqual(pick(again[mode]), pick(m).slice(0, 1), mode);
    assert.equal(m.stats.ms.n, 2, `${mode}: every seed is timed`);
    assert.equal(Object.values(m.worlds).reduce((s, w) => s + w.n, 0), 2, `${mode}: per-world rows cover every seed`);
  }
  const text = markdown(first);
  for (const mode of Object.keys(KEYS)) assert.match(text, new RegExp(`\\| ${mode} \\| 2/2 \\(\\d\\) \\|`));
  assert.doesNotMatch(text, /\[deep\]/);
  assert.match(text, /\| mode \| world \| generated \|/);
});

test('quality report per-world breakdown counts and times failed generations', () => {
  const rows = [{ world: 'dunes', ok: true, hardness: 0.5, confidence: 0.9, ms: 100, flagged: 1 },
    { world: 'classic', ok: true, hardness: 0.7, confidence: 0.8, ms: 200 }];
  const failed = [{ seed: 'dn-9', world: 'dunes', error: 'No clear friend sighting found.', ms: 700 }];
  const w = byWorld(rows, failed);
  assert.deepEqual(Object.keys(w), ['dunes', 'classic']);
  assert.deepEqual(w.dunes, { n: 2, generated: 1, msMean: 400, hardnessP50: 0.5, confidenceP50: 0.9, flagged: 1 });
  assert.equal(w.classic.generated, 1);
  const m = summarise(rows, failed);
  assert.deepEqual([m.generated, m.valid, m.flagged, m.stats.ms.n, m.stats.ms.max, m.stats.hardness.n], [2, 2, 1, 3, 700, 2], 'failures are timed, not scored');
  assert.match(markdown({ friend: { n: 3, ...m } }), /FAILED dn-9 \(dunes, 700 ms\)/);
});

test('quality report statistics', () => {
  const s = stats([1, 2, 3, 4, NaN]);
  assert.equal(s.n, 4);
  assert.equal(s.min, 1);
  assert.equal(s.max, 4);
  assert.equal(s.p50, 3);
  assert.equal(s.uniq, 4);
  assert.equal(correlation([1, 2, 3], [2, 4, 6]).toFixed(6), '1.000000');
  assert.equal(correlation([1, 2, 3], [3, 2, 1]).toFixed(6), '-1.000000');
  assert.ok(Number.isNaN(correlation([1, 1, 1], [1, 2, 3])));
});
