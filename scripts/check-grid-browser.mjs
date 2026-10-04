// Optional browser checks. Needs Playwright and Chromium (not app dependencies).
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_EXECUTABLE=/path/to/chromium
// node scripts/check-grid-browser.mjs [screenshot-directory]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/engine/quiz.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL(process.env.CHECK_SITE ? '../' + process.env.CHECK_SITE + '/' : '..', import.meta.url));
const out = process.argv[2];
if (out) await mkdir(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  try { const body = await readFile(join(root, path)); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404).end(); }
}).listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const browser = await chromium.launch({ ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
page.on('pageerror', (err) => errors.push(err.message));
const url = `http://localhost:${server.address().port}`;
const ready = (p) => p.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 90000 });

try {
  const opts = { seed: 'grid-check', difficulty: 'medium', mode: 'grid', gridSize: 4 };
  const q = await generate(opts);
  await page.goto(`${url}/#seed=grid-check&d=medium&m=grid&g=4`);
  await ready(page);
  assert.equal(await page.locator('#answers button').count(), 0);
  assert.equal(await page.locator('#quiz-title').textContent(), '4 × 4 GRID');
  await page.locator('#grid-cell').fill('E1');
  await page.locator('#grid-submit').click();
  assert.equal(await page.locator('#grid-cell').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#result').isVisible(), false);

  // Pointer coordinates are independent of the page's input parser.
  const box = await page.locator('#map').boundingBox();
  const s = Math.min(box.width, box.height) - 56;
  const a = q.mapRotation * Math.PI / 180, u = q.camera.x / q.terrain.size - 0.5, v = 0.5 - q.camera.y / q.terrain.size;
  await page.locator('#map').click({ position: { x: box.width / 2 + (u * Math.cos(a) - v * Math.sin(a)) * s, y: box.height / 2 + (u * Math.sin(a) + v * Math.cos(a)) * s } });
  assert.equal(await page.locator('#grid-cell').inputValue(), q.correctLabel);
  assert.equal(await page.locator('#result').isVisible(), false);
  if (out) await page.locator('.card').screenshot({ path: join(out, 'grid4-question.png') });
  await page.locator('#grid-submit').click();
  assert.match(await page.locator('#result .verdict').textContent(), /^Correct/);
  assert.equal(await page.locator('.answer-explanation').count(), 1);
  assert.equal(await page.locator('.answer-alternative').count(), 3);
  assert.match(await page.locator('#answer-explanation-title').textContent(), new RegExp(q.correctLabel));
  assert.equal(await page.locator('#grid-submit').isDisabled(), true);
  await page.locator('#new-positions').click();
  await ready(page);
  assert.match(page.url(), /v=1/);
  assert.equal(await page.locator('#grid-cell').isEnabled(), true);
  assert.equal(await page.locator('#result').isVisible(), false);

  await page.locator('#grid-size').selectOption('6');
  await ready(page);
  assert.match(page.url(), /g=6/);
  assert.equal(await page.locator('#quiz-title').textContent(), '6 × 6 GRID');
  await page.reload(); await ready(page);
  assert.equal(await page.locator('#grid-size').inputValue(), '6');
  await page.locator('#grid-cell').fill('G1'); await page.locator('#grid-submit').click();
  assert.equal(await page.locator('#grid-cell').getAttribute('aria-invalid'), 'true');
  const q6 = await generate({ ...opts, gridSize: 6 });
  await page.locator('#grid-cell').fill(q6.correctLabel.toLowerCase());
  await page.locator('#grid-cell').press('Enter');
  assert.match(await page.locator('#result .verdict').textContent(), /^Correct/);

  await page.locator('#grid-size').selectOption('8');
  await ready(page);
  assert.match(page.url(), /g=8/);
  const q8 = await generate({ ...opts, gridSize: 8 });
  const wrong = q8.options.find((o) => !o.correct).label;
  await page.locator('#grid-cell').fill(wrong.toLowerCase());
  await page.locator('#grid-cell').press('Enter');
  assert.match(await page.locator('#result .verdict').textContent(), /^Not quite/);
  assert.ok(await page.locator('#result [data-view]').count() <= 5);
  assert.equal(await page.locator(`.answer-alternative[data-label="${wrong}"][data-chosen="true"]`).count(), 1);
  await page.locator('#result [data-view]').last().click();
  assert.equal(await page.locator('#viewing-badge').isVisible(), true);

  const mobile = await browser.newPage({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  mobile.on('pageerror', (err) => errors.push(err.message));
  await mobile.goto(`${url}/#seed=grid-check&d=hard&m=grid&g=16&gc=lost-compass`);
  await ready(mobile);
  assert.equal(await mobile.locator('#heading-field').isVisible(), false);
  assert.equal(await mobile.locator('#scramble').isVisible(), false);
  assert.match(await mobile.locator('#facts').textContent(), /hidden until you answer/);
  assert.equal(await mobile.evaluate(() => {
    const c = document.getElementById('tape');
    return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v) => v !== 0);
  }), false);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const qm = await generate({ ...opts, difficulty: 'hard', gridSize: 16, gridChallenge: 'lost-compass' });
  await mobile.locator('#map').scrollIntoViewIfNeeded();
  const mb = await mobile.locator('#map').boundingBox(), ms = Math.min(mb.width, mb.height) - 56;
  const ma = qm.mapRotation * Math.PI / 180, mu = qm.camera.x / qm.terrain.size - 0.5, mv = 0.5 - qm.camera.y / qm.terrain.size;
  await mobile.touchscreen.tap(mb.x + mb.width / 2 + (mu * Math.cos(ma) - mv * Math.sin(ma)) * ms, mb.y + mb.height / 2 + (mu * Math.sin(ma) + mv * Math.cos(ma)) * ms);
  assert.equal(await mobile.locator('#grid-cell').inputValue(), qm.correctLabel);
  if (out) await mobile.locator('.card').screenshot({ path: join(out, 'grid16-mobile-question.png') });
  await mobile.locator('#grid-submit').click();
  assert.match(await mobile.locator('#result .verdict').textContent(), /^Correct/);
  assert.match(await mobile.locator('#result').textContent(), /compass was pointing/);
  if (out) await mobile.locator('.card').screenshot({ path: join(out, 'grid16-mobile-answer.png') });

  // Check actual exported drawing calls, including a tape-on setting, in both formats.
  const exports = await page.evaluate(async () => {
    const { generate } = await import('/src/engine/quiz.js');
    const { TerrainModel } = await import('/src/engine/terrainModel.js');
    const { ExportComposer } = await import('/src/export/composer.js');
    const q = await generate({ seed: 'grid-check', mode: 'grid', gridSize: 16, gridChallenge: 'lost-compass' });
    const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed });
    const results = [];
    for (const format of ['reels', 'post']) {
      const c = new ExportComposer(q, model, { format, tape: true });
      const texts = [], fillText = c.ctx.fillText.bind(c.ctx);
      c.ctx.fillText = (...args) => { texts.push(args[0]); fillText(...args); };
      c.drawFrame(0);
      const question = { texts: [...texts], image: c.canvas.toDataURL() };
      texts.length = 0;
      c.drawFrame(13, { reveal: true });
      results.push({ format, heading: q.heading.text, question, answer: { texts: [...texts], image: c.canvas.toDataURL() } });
      c.dispose();
    }
    return results;
  });
  for (const e of exports) {
    assert.ok(e.question.texts.includes('LOST COMPASS · FIND YOUR CELL'));
    assert.ok(!e.question.texts.some((s) => s.includes(e.heading)));
    assert.ok(!e.question.texts.some((s) => /^(N|NE|E|SE|S|SW|W|NW)$/.test(s)));
    assert.ok(e.answer.texts.some((s) => s.includes(e.heading)));
    assert.ok(e.answer.texts.some((s) => s.startsWith('Answer: ')));
    if (out) for (const stage of ['question', 'answer']) await writeFile(join(out, `grid16-export-${e.format}-${stage}.png`), Buffer.from(e[stage].image.split(',')[1], 'base64'));
  }
  // Existing question types still restore their answer controls after leaving grid.
  await page.locator('#mode').selectOption('where-am-i');
  await ready(page);
  assert.equal(await page.locator('#grid-answer').isVisible(), false);
  assert.ok(await page.locator('#answers button').count() >= 3);
  await page.locator('#mode').selectOption('facing');
  await ready(page);
  assert.equal(await page.locator('#answers button').count(), 8);
  assert.deepEqual(errors, []);
  console.log('Grid browser checks passed: selection, input, replay, mode switching, mobile touch, hidden heading and both export formats.');
} finally {
  await browser.close();
  server.close();
}
