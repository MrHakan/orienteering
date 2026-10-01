// Optional Playwright checks; no browser dependency is shipped with the app.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/engine/quiz.js';
import { cellAtExtent } from '../src/engine/gridQuiz.js';

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
await new Promise(resolve => server.once('listening', resolve));
const browser = await chromium.launch({ ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], url = `http://localhost:${server.address().port}`;
const watch = page => page.on('pageerror', err => errors.push(err.message));
const ready = page => page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 90000 });
const position = async (page, q, p) => {
  const box = await page.locator('#map').boundingBox(), s = Math.min(box.width, box.height) - 56;
  const a = q.mapRotation * Math.PI / 180, u = (p.x - q.mapExtent.x) / q.mapExtent.size, v = (q.mapExtent.y - p.y) / q.mapExtent.size;
  return { x: box.width / 2 + (u * Math.cos(a) - v * Math.sin(a)) * s, y: box.height / 2 + (u * Math.sin(a) + v * Math.cos(a)) * s };
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } }); watch(page);
  const opts = { seed: 'friend-demo', difficulty: 'easy', mode: 'friend', friendAnswer: 'grid', gridSize: 8 };
  const q = await generate(opts);
  await page.goto(`${url}/#seed=friend-demo&d=easy&m=friend&fa=grid&g=8`); await ready(page);
  assert.equal(await page.locator('#friend-answer').inputValue(), 'grid');
  assert.equal(await page.locator('#grid-size').inputValue(), '8');
  assert.equal(await page.locator('#grid-size-field').isVisible(), true);
  assert.equal(await page.locator('#grid-challenge-field').isVisible(), false);
  assert.equal(await page.locator('#answers button').count(), 0);
  assert.equal(await page.locator('#grid-cell-label').textContent(), "Friend's cell");
  assert.match(await page.locator('#prompt').textContent(), /Locate your friend/);
  const promptBox = await page.locator('#prompt').boundingBox(), mapBox = await page.locator('#map').boundingBox();
  assert.ok(promptBox.y + promptBox.height <= mapBox.y);
  await page.locator('#grid-cell').fill('P16'); await page.locator('#grid-submit').click();
  assert.equal(await page.locator('#grid-cell').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#result').isVisible(), false);
  await page.locator('#map').click({ position: await position(page, q, q.friend) });
  assert.equal(await page.locator('#grid-cell').inputValue(), q.correctLabel);
  assert.equal(await page.locator('#result').isVisible(), false);
  assert.equal(await page.locator('#scramble').isVisible(), false);
  await page.keyboard.press('s'); assert.ok(!page.url().includes('&s='));
  await page.locator('#friend-zoom').click(); assert.equal(await page.locator('#friend-zoom').getAttribute('aria-pressed'), 'true');
  await page.locator('#friend-zoom').click();
  if (out) await page.locator('.card').screenshot({ path: join(out, 'friend-grid8-question.png') });
  // The observer's cell is a valid but wrong answer: score the friend, not YOU.
  const observerCell = cellAtExtent(q.camera.x, q.camera.y, q.mapExtent, 8);
  assert.notEqual(observerCell, q.correctLabel);
  await page.locator('#grid-cell').fill(observerCell.toLowerCase()); await page.locator('#grid-cell').press('Enter');
  assert.match(await page.locator('#result .verdict').textContent(), new RegExp(`^Not quite.*friend was in ${q.correctLabel}`));
  assert.equal(await page.locator('#result [data-view]').count(), 0);
  assert.equal(await page.locator('#grid-submit').isDisabled(), true);
  if (out) await page.locator('.card').screenshot({ path: join(out, 'friend-grid8-answer.png') });
  await page.reload(); await ready(page);
  await page.locator('#grid-cell').fill(q.correctLabel.toLowerCase()); await page.locator('#grid-cell').press('Enter');
  assert.match(await page.locator('#result .verdict').textContent(), /^Correct/);
  await page.locator('#new-positions').click(); await ready(page);
  assert.match(page.url(), /v=1/); assert.equal(await page.locator('#grid-cell').isEnabled(), true);
  await page.locator('#friend-answer').selectOption('point'); await ready(page);
  assert.equal(await page.locator('#grid-answer').isVisible(), false);
  assert.equal(await page.locator('#answers button').count(), 3);
  assert.equal(await page.locator('#grid-size-field').isVisible(), false);
  await page.locator('#answers button').first().click();
  assert.equal(await page.locator('#result [data-view]').count(), 3);
  await page.locator('#friend-answer').selectOption('grid'); await ready(page);
  assert.equal(await page.locator('#grid-answer').isVisible(), true);
  assert.match(page.url(), /fa=grid/);
  await page.locator('#grid-size').selectOption('6'); await ready(page);
  assert.match(page.url(), /g=6/);
  await page.reload(); await ready(page);
  assert.equal(await page.locator('#grid-size').inputValue(), '6');
  assert.match(await page.locator('#prompt').textContent(), /A1–F6/);
  await page.locator('#grid-cell').fill('A7'); await page.locator('#grid-submit').click();
  assert.equal(await page.locator('#grid-cell').getAttribute('aria-invalid'), 'true');
  const q6 = await generate({ ...opts, gridSize: 6 });
  await page.locator('#map').click({ position: await position(page, q6, q6.friend) });
  assert.equal(await page.locator('#grid-cell').inputValue(), q6.correctLabel);
  if (out) await page.locator('.card').screenshot({ path: join(out, 'friend-grid6-question.png') });
  await page.locator('#grid-submit').click();
  assert.match(await page.locator('#result .verdict').textContent(), /^Correct/);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); watch(mobile);
  const qm = await generate({ ...opts, difficulty: 'medium', gridSize: 16, friendChallenge: 'depth-trap' });
  await mobile.goto(`${url}/#seed=friend-demo&d=medium&m=friend&fa=grid&g=16&fc=depth-trap`); await ready(mobile);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await mobile.locator('#map').scrollIntoViewIfNeeded();
  const p = await position(mobile, qm, qm.friend), box = await mobile.locator('#map').boundingBox();
  await mobile.touchscreen.tap(box.x + p.x, box.y + p.y);
  assert.equal(await mobile.locator('#grid-cell').inputValue(), qm.correctLabel);
  if (out) await mobile.locator('.card').screenshot({ path: join(out, 'friend-grid16-mobile-question.png') });
  await mobile.locator('#grid-submit').click(); assert.match(await mobile.locator('#result .verdict').textContent(), /^Correct/);
  if (out) await mobile.locator('.card').screenshot({ path: join(out, 'friend-grid16-mobile-answer.png') });
  await mobile.evaluate(() => { location.hash = '#seed=friend-demo&d=medium&m=friend&fa=grid&g=4'; });
  await mobile.waitForFunction(() => document.getElementById('grid-size').value === '4' && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 90000 });
  assert.equal(await mobile.locator('#grid-size').inputValue(), '4');
  assert.equal(await mobile.locator('#friend-challenge').inputValue(), 'standard');

  // Use the actual release module graph to capture PNGs and encode real frames.
  const exports = await page.evaluate(async () => {
    const src = new URL('../', document.querySelector('script[type="module"]').src);
    const { generate } = await import(new URL('engine/quiz.js', src));
    const { TerrainModel } = await import(new URL('engine/terrainModel.js', src));
    const { ExportComposer } = await import(new URL('export/composer.js', src));
    const { encodeCanvasVideo } = await import(new URL('export/recorder.js', src));
    const q = await generate({ seed: 'friend-demo', difficulty: 'medium', mode: 'friend', friendAnswer: 'grid', gridSize: 6 });
    const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed }), result = [];
    for (const format of ['reels', 'post']) {
      const c = new ExportComposer(q, model, { format, northUp: false });
      const texts = [], positions = [], fillText = c.ctx.fillText.bind(c.ctx);
      c.ctx.fillText = (...args) => { texts.push(args[0]); positions.push({ text: args[0], y: args[2] }); fillText(...args); };
      await c.toImage(); const question = c.canvas.toDataURL(), questionTexts = [...texts];
      texts.length = 0; await c.toImage({ reveal: true }); const answer = c.canvas.toDataURL(), answerTexts = [...texts];
      c.animated = true; c.drawFrame(7); c.drawFrame(13, { reveal: true });
      const clip = await encodeCanvasVideo(c.canvas, t => c.drawFrameReady(t), { duration: .2, fps: 10 });
      result.push({ format, question, answer, questionTexts, answerTexts, positions, layout: c.layout, correctLabel: q.correctLabel, bytes: clip.blob.size, type: clip.blob.type });
      c.dispose();
    }
    return result;
  });
  for (const e of exports) {
    assert.notEqual(e.question, e.answer);
    const questionRemark = "Find your friend's cell: A1–F6.", answerRemark = `Answer: ${e.correctLabel}`;
    assert.equal(e.questionTexts.filter(text => text === questionRemark).length, 1);
    assert.equal(e.answerTexts.filter(text => text === answerRemark).length, 1);
    for (const remark of e.positions.filter(p => [questionRemark, answerRemark].includes(p.text))) {
      assert.ok(remark.y > e.layout.scene.y + e.layout.scene.h + 14);
      assert.ok(remark.y < e.layout.map.y + 34); // above the row/column headers
    }
    assert.ok(e.bytes > 1000); assert.equal(e.type, 'video/mp4');
    if (out) for (const stage of ['question', 'answer']) await writeFile(join(out, `friend-grid6-export-${e.format}-${stage}.png`), Buffer.from(e[stage].split(',')[1], 'base64'));
  }
  assert.deepEqual(errors, []);
  console.log('Friend grid browser checks passed: 6×6 selection/replay, cropped selection, observer-cell rejection, keyboard input, variants, point switching, mobile touch, hash changes, single remarks, PNGs and encoded video in both formats.');
} finally { await browser.close(); server.close(); }
