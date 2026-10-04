// Exercise answer-only prose, comparison selection and downloaded automation JSON.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/engine/quiz.js';
import { scrambleLabels } from '../src/engine/scramble.js';
import { explanationComparisons } from '../src/engine/answerExplanation.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL(process.env.CHECK_SITE ? '../' + process.env.CHECK_SITE + '/' : '..', import.meta.url));
const out = process.argv[2]; if (out) await mkdir(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.mp4': 'video/mp4' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  try { const body = await readFile(join(root, path)); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404).end(); }
}).listen(0);
await new Promise(resolve => server.once('listening', resolve));
const browser = await chromium.launch({ ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const url = `http://localhost:${server.address().port}`, errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  page.setDefaultNavigationTimeout(90000);
  page.on('pageerror', error => errors.push(error.message));
  const cases = [
    { opts: { seed: 'grid-check', mode: 'grid', gridSize: 4, difficulty: 'medium' }, hash: 'seed=grid-check&d=medium&m=grid&g=4', selected: 'far' },
    { opts: { seed: 'variant', difficulty: 'easy' }, hash: 'seed=variant&d=easy', scramble: 1 },
    { opts: { seed: 'coverage', mode: 'lookalike', direction: 'NW', difficulty: 'easy' }, hash: 'seed=coverage&d=easy&m=lookalike&dir=NW' },
    { opts: { seed: 'sun-watch-demo', difficulty: 'sun-watch' }, hash: 'seed=sun-watch-demo&d=sun-watch' },
    { opts: { seed: 'friend-demo', mode: 'friend', difficulty: 'easy', friendAnswer: 'grid', gridSize: 6 }, hash: 'seed=friend-demo&d=easy&m=friend&fa=grid&g=6' },
    { opts: { seed: 'bhop-demo', mode: 'trail', difficulty: 'medium' }, hash: 'seed=bhop-demo&d=medium&m=trail' },
    { opts: { seed: 'bhop-grid', mode: 'trail', difficulty: 'easy', trailAnswer: 'grid', gridSize: 4 }, hash: 'seed=bhop-grid&d=easy&m=trail&ta=grid&g=4' },
  ];
  for (const entry of cases) {
    let q = await generate(entry.opts);
    await page.goto(`${url}/#${entry.hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 90000 });
    assert.equal(await page.locator('.answer-explanation').isVisible(), false);
    assert.equal(await page.locator('#download-explanation').isVisible(), false);
    if (entry.scramble) { await page.locator('#scramble').click(); q = scrambleLabels(q, entry.scramble); }
    const chosen = entry.selected === 'far'
      ? q.options.find(o => !o.correct && !q.explanation.closestLabels.includes(o.label)).label
      : q.explanation.closestLabels[0];
    if (q.grid) { await page.locator('#grid-cell').fill(chosen); await page.locator('#grid-cell').press('Enter'); }
    else await page.locator(`#answers button[data-label="${chosen}"]`).click();
    assert.equal(await page.locator('.answer-explanation').count(), 1);
    assert.equal(await page.locator('.answer-explanation').isVisible(), true);
    assert.equal(await page.locator('#answer-explanation-title').textContent(), `Why ${q.correctLabel} is the answer`);
    const comparisons = explanationComparisons(q, chosen);
    assert.deepEqual(await page.locator('.answer-alternative').evaluateAll(nodes => nodes.map(node => node.dataset.label)), comparisons.map(o => o.label));
    assert.equal(await page.locator(`.answer-alternative[data-label="${chosen}"][data-chosen="true"]`).count(), 1);
    const text = await page.locator('.answer-explanation').textContent();
    for (const clue of q.explanation.correct.evidence) assert.ok(text.includes(clue.text));
    for (const comparison of comparisons) for (const reason of comparison.reasons) assert.ok(text.includes(reason.text));
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-explanation').click()]);
    const report = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(report.seed, q.seed); assert.equal(report.chosenLabel, chosen); assert.equal(report.correctLabel, q.correctLabel);
    assert.deepEqual(report.explanation, q.explanation);
    if (out) await page.locator('#result').screenshot({ path: join(out, `explanation-${q.mode}${q.grid ? '-grid' : ''}-${q.difficulty}.png`), style: 'header { visibility: hidden !important; }' });
    console.log(`${q.mode}${q.grid ? ' grid' : ''} ${q.difficulty}: answer-only reasoning, selected alternative and JSON passed.`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const opts = { seed: 'grid-check', difficulty: 'hard', mode: 'grid', gridSize: 16, gridChallenge: 'lost-compass' };
  const q = await generate(opts);
  await page.goto(`${url}/#seed=grid-check&d=hard&m=grid&g=16&gc=lost-compass`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 90000 });
  await page.locator('#grid-cell').fill(q.correctLabel); await page.locator('#grid-cell').press('Enter');
  assert.equal(await page.locator('.answer-alternative').count(), 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('#result [data-view]').count(), 4);
  await page.locator('#result [data-view]').last().click();
  assert.equal(await page.locator('#viewing-badge').isVisible(), true);
  if (out) await page.locator('#result').screenshot({ path: join(out, 'explanation-grid16-mobile.png'), style: 'header { visibility: hidden !important; }' });
  assert.deepEqual(errors, []);
  console.log('Answer explanation browser checks passed: Grid, selected wrong cells, A/B/C, scrambling, Sun/watch, friend grid, trails/finish cells, machine-readable download and mobile lost compass.');
} finally { await browser.close(); server.close(); }
