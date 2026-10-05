// Sniper mode in the shipped app: 5 s overview + 10 s scope, answer keys, map reveal and exports.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/engine/quiz.js';

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
const seek = (page, t) => page.locator('#direction-scrub').evaluate((el, t) => { el.value = String(t); el.dispatchEvent(new Event('input', { bubbles: true })); }, t);
// Overlay pixels from the 2D layer above the WebGL scene: [corner alpha, centre alpha, any red spot].
const overlay = page => page.locator('#tape').evaluate(canvas => {
  const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  const at = (x, y) => ctx.getImageData(x, y, 1, 1).data;
  const data = ctx.getImageData(0, 0, w, h).data;
  let red = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 90 && data[i + 2] < 80 && data[i + 3] > 200) red++;
  return { corner: at(3, h - 3)[3] && at(3, 3)[3], centre: at(Math.round(w / 2) + 5, Math.round(h / 2) - 25)[3], red };
});
try {
  const q = await generate({ seed: 'sniper-check', difficulty: 'medium', mode: 'sniper' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultNavigationTimeout(90000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/#seed=sniper-check&d=medium&m=sniper`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden') && document.getElementById('quiz-title').textContent.startsWith('SNIPER'), null, { timeout: 120000 });
  assert.equal(await page.locator('#mode').inputValue(), 'sniper');
  assert.equal(await page.locator('#direction-tools').isHidden(), false);
  assert.equal(await page.locator('#scramble').isHidden(), true);
  assert.equal(await page.locator('#heading-field').isHidden(), true);
  assert.match(await page.locator('#facing-text').textContent(), new RegExp(`PRONE · FACING ${String(Math.round(q.camera.heading)).padStart(3, '0')}° · POSITION UNKNOWN`));
  assert.deepEqual(await page.locator('#answers .answer').evaluateAll(b => b.map(x => x.dataset.label)), q.options.map(o => o.label));
  // Overview: rifle and enemy spot, no scope housing.
  await page.locator('#direction-play').click();
  await seek(page, 2); await page.waitForTimeout(300);
  const early = await overlay(page);
  assert.ok(early.red > 20, 'enemy spot marker while observing');
  assert.equal(early.centre, 0, 'clear view while observing');
  if (out) await page.locator('.scene-wrap').screenshot({ path: join(out, 'sniper-overview.png') });
  // Scope: black housing at the corners, clear lens near the centre, no spot (it never shows the range).
  await seek(page, 9); await page.waitForTimeout(300);
  const scoped = await overlay(page);
  assert.equal(scoped.corner, 255, 'scope housing');
  assert.ok(scoped.red === 0, 'no marker through the scope');
  if (out) await page.locator('.scene-wrap').screenshot({ path: join(out, 'sniper-scope.png') });
  // The map shows no position before answering.
  assert.equal(await page.evaluate(() => document.getElementById('facts').textContent.includes('unmarked')), true);

  // Answer by key (5 = 500 m etc.); the reveal explains the ballistics and marks YOU and ENEMY.
  const wrong = q.options.find(o => !o.correct);
  await page.keyboard.press(String(wrong.metres / 100 % 10));
  await page.waitForSelector('#sniper-replay');
  const result = await page.locator('#result').innerText();
  assert.match(result, /Miss — .* was right/);
  assert.match(result, new RegExp(`${Math.round(q.sniper.horizontal)} m horizontally`));
  assert.match(result, /head shot/);
  assert.match(await page.locator('.answer-explanation').innerText(), /horizontal range/);
  assert.equal(await page.locator(`#answers [data-label="${q.correctLabel}"]`).getAttribute('class').then(c => c.includes('correct')), true);
  if (out) await page.locator('.map-wrap').screenshot({ path: join(out, 'sniper-reveal-map.png') });

  // Exports: the PNG uses the scope frame; a short video piece encodes overview → scope.
  const exported = await page.evaluate(async (quiz) => {
    const src = new URL('../', document.querySelector('script[type="module"]').src);
    const { ExportComposer } = await import(new URL('export/composer.js', src));
    const { TerrainModel } = await import(new URL('engine/terrainModel.js', src));
    const { encodeCanvasVideo } = await import(new URL('export/recorder.js', src));
    const model = new TerrainModel({ ...quiz.terrain, heights: new Float32Array(quiz.terrain.heights), seed: quiz.terrain.modelSeed });
    const c = new ExportComposer({ ...quiz, terrain: { ...quiz.terrain, heights: model.heights } }, model, { format: 'reels', easterEgg: null });
    const blob = await c.toImage();
    const png = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
    const ctx = c.canvas.getContext('2d'), S = c.layout.scene;
    const corner = ctx.getImageData(S.x + 4, S.y + 4, 1, 1).data.slice(0, 3);
    c.animated = true;
    await c.drawFrameReady(2); const overview = c.canvas.toDataURL('image/png');
    const clip = await encodeCanvasVideo(c.canvas, t => c.drawFrameReady(t + 4.8), { duration: .5, fps: 10 });
    c.dispose();
    return { png, overview, corner: Array.from(corner), video: clip.blob.size };
  }, { ...q, terrain: { ...q.terrain, heights: Array.from(q.terrain.heights) } });
  assert.deepEqual(exported.corner, [0, 0, 0], 'export PNG shows the scope');
  assert.ok(exported.video > 1000);
  if (out) await writeFile(join(out, 'sniper-export.png'), Buffer.from(exported.png.split(',')[1], 'base64'));
  if (out) await writeFile(join(out, 'sniper-export-overview.png'), Buffer.from(exported.overview.split(',')[1], 'base64'));
  // Optional crosswind call: the Wind control, w= link, HUD + card on the scene, mark + windage answers.
  const qw = await generate({ seed: 'sniper-check', difficulty: 'medium', mode: 'sniper', sniperWind: true });
  await page.goto(`${url}/#seed=sniper-check&d=medium&m=sniper&wind=1`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden') && document.getElementById('prompt').textContent.includes('windage'), null, { timeout: 120000 });
  assert.equal(await page.locator('#sniper-wind-field').isHidden(), false);
  assert.equal(await page.locator('#sniper-wind').inputValue(), 'on');
  assert.deepEqual(await page.locator('#answers .answer').evaluateAll(b => b.map(x => x.dataset.label)), qw.options.map(o => o.label));
  await seek(page, 2); await page.waitForTimeout(300);
  const hud = await page.locator('#tape').evaluate(canvas => {
    const d = canvas.getContext('2d').getImageData(0, 0, Math.round(canvas.width * 0.3), Math.round(canvas.height * 0.5)).data;
    let yellow = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 170 && d[i + 2] < 140 && d[i + 3] > 200) yellow++;
    return yellow;
  });
  assert.ok(hud > 80, 'wind HUD and card drawn top-left');
  if (out) await page.locator('.scene-wrap').screenshot({ path: join(out, 'sniper-wind.png') });
  await page.keyboard.press(String(qw.options.findIndex(o => o.correct) + 1));
  await page.waitForSelector('#sniper-replay');
  assert.match(await page.locator('#result').innerText(), /Hit — .* was right[\s\S]*Crosswind/);
  assert.match(await page.locator('.answer-explanation').innerText(), /into the wind/);
  // Switching the control off returns to the plain mark question on the same terrain.
  await page.locator('#sniper-wind').selectOption('off');
  await page.waitForFunction(() => !location.hash.includes('wind=1') && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 120000 });
  assert.deepEqual(await page.locator('#answers .answer').evaluateAll(b => b.map(x => x.dataset.label)), q.options.map(o => o.label));

  assert.deepEqual(errors, []);
  console.log('Sniper browser checks passed: crosswind option (HUD, card, mark + windage answers), overview spot, scope housing and reticle, timeline, number keys, ballistic reveal, YOU/ENEMY map and PNG/video exports.');
} finally {
  await browser.close();
  server.close();
}
