import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/engine/quiz.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL(process.env.CHECK_SITE ? '../' + process.env.CHECK_SITE + '/' : '..', import.meta.url));
const out = process.argv[2]; if (out) await mkdir(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  try { const body = await readFile(join(root, path)); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404).end(); }
}).listen(0);
await new Promise(resolve => server.once('listening', resolve));
const browser = await chromium.launch({ ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const url = `http://localhost:${server.address().port}`, errors = [];
const ready = page => page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 90000 });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
  page.on('pageerror', err => errors.push(err.message));
  const opts = { seed: 'friend-demo', difficulty: 'easy', mode: 'friend', friendAnswer: 'grid', gridSize: 6 };
  const q = await generate(opts);
  await page.goto(`${url}/#seed=friend-demo&d=easy&m=friend&fa=grid&g=6`); await ready(page);
  await page.evaluate(async () => {
    const src = new URL('../', document.querySelector('script[type="module"]').src);
    const { TerrainRenderer } = await import(new URL('render/webglTerrain.js', src));
    const render = TerrainRenderer.prototype.render;
    window.arrivalFrames = [];
    TerrainRenderer.prototype.render = function(camera, options) {
      const result = render.call(this, camera, options);
      if (this.canvas.id === 'scene' && this.person?.skin === 'conquest') window.arrivalFrames.push({ camera,
        time: options.time, motion: { ...options.personMotion }, person: this.person, loaded: this.friendSprite?.loaded });
      return result;
    };
  });
  await page.locator('.friend-customise summary').click();
  await page.locator('#friend-skin').selectOption('conquest');
  assert.match(page.url(), /fs=conquest/);
  assert.equal(await page.locator('#friend-arrival').isVisible(), true);
  const opening = await page.evaluate(() => window.arrivalFrames[0]);
  assert.deepEqual(opening.camera, q.camera); assert.equal(opening.motion.sprite, false);
  await page.waitForFunction(() => window.arrivalFrames.at(-1)?.time >= 6, null, { timeout: 20000 });
  const falling = await page.evaluate(() => window.arrivalFrames.at(-1));
  assert.equal(falling.loaded, true); assert.equal(falling.motion.sprite, true);
  assert.ok(falling.motion.altitude > 0 && falling.motion.altitude < 24);
  const targetPitch = Math.atan2(q.friend.z + falling.motion.altitude + q.friend.height / 2 - q.camera.z,
    Math.hypot(q.friend.x - q.camera.x, q.friend.y - q.camera.y)) * 180 / Math.PI;
  assert.ok(Math.abs(falling.camera.pitch - targetPitch) < 1e-8);
  for (const key of ['x', 'y', 'z']) assert.equal(falling.camera[key], q.camera[key]);
  if (out) {
    const image = await page.locator('#scene').evaluate(canvas => canvas.toDataURL());
    await writeFile(join(out, 'conquest-live-descent.png'), Buffer.from(image.split(',')[1], 'base64'));
  }
  await page.waitForFunction(() => window.arrivalFrames.at(-1)?.time >= 12, null, { timeout: 15000 });
  const landed = await page.evaluate(() => window.arrivalFrames.at(-1));
  assert.equal(landed.motion.altitude, 0); assert.deepEqual(landed.camera, q.camera);
  await page.locator('#grid-cell').fill(q.correctLabel); await page.locator('#grid-cell').press('Enter');
  assert.match(await page.locator('#result .verdict').textContent(), /^Correct/);
  await page.evaluate(() => { window.arrivalFrames = []; });
  await page.locator('#friend-arrival').click();
  assert.equal(await page.evaluate(() => window.arrivalFrames.some(frame => frame.time === 0)), true);
  await page.locator('#friend-skin').selectOption('classic');
  assert.ok(!page.url().includes('fs=conquest'));
  assert.equal(await page.locator('#friend-arrival').isVisible(), false);
  assert.match(await page.locator('#result .verdict').textContent(), /^Correct/);

  // Linked selection reaches the worker too; mobile Point and Grid share it.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.on('pageerror', err => errors.push(err.message));
  await mobile.goto(`${url}/#seed=friend-demo&d=easy&m=friend&fs=conquest`); await ready(mobile);
  assert.equal(await mobile.locator('#friend-skin').inputValue(), 'conquest');
  assert.equal(await mobile.locator('#answers button').count(), 3);
  assert.equal(await mobile.locator('#friend-arrival').isVisible(), true);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.reload(); await ready(mobile);
  assert.equal(await mobile.locator('#friend-skin').inputValue(), 'conquest');
  await mobile.locator('#friend-zoom').click(); // skip arrival and inspect landed artwork at 3×
  await mobile.locator('#friend-answer').selectOption('grid'); await ready(mobile);
  assert.equal(await mobile.locator('#friend-skin').inputValue(), 'conquest');
  assert.equal(await mobile.locator('#grid-answer').isVisible(), true);
  await mobile.locator('#friend-zoom').click();

  const result = await page.evaluate(async () => {
    const src = new URL('../', document.querySelector('script[type="module"]').src);
    const { generate } = await import(new URL('engine/quiz.js', src));
    const { TerrainModel } = await import(new URL('engine/terrainModel.js', src));
    const { TerrainRenderer } = await import(new URL('render/webglTerrain.js', src));
    const { ExportComposer } = await import(new URL('export/composer.js', src));
    const { encodeCanvasVideo } = await import(new URL('export/recorder.js', src));
    const q = await generate({ seed: 'friend-demo', difficulty: 'easy', mode: 'friend', friendAnswer: 'grid', gridSize: 6, friendSkin: 'conquest' });
    const model = new TerrainModel({ ...q.terrain, seed: q.terrain.modelSeed }), exports = [];
    for (const format of ['reels', 'post']) {
      const c = new ExportComposer(q, model, { format }); c.animated = true;
      const samples = [];
      for (const t of [0, 4, 6, 8, 10, 12]) {
        await c.drawFrameReady(t, { reveal: t >= 12 });
        samples.push({ t, camera: c.renderer.lastFrame.camera, motion: c.renderer.personMotion });
      }
      await c.drawFrameReady(7); const descent = c.canvas.toDataURL();
      await c.toImage(); const question = c.canvas.toDataURL(), png = c.renderer.personMotion;
      c.animated = true;
      const clip = await encodeCanvasVideo(c.canvas, t => c.drawFrameReady(t + 7), { duration: .4, fps: 10 });
      exports.push({ format, samples, descent, question, png, loaded: c.renderer.friendSprite.loaded,
        bytes: clip.blob.size, type: clip.blob.type });
      c.dispose();
    }
    // A foreground ridge must hide the distant cutout in both depth passes.
    const canvas = document.createElement('canvas'), renderer = new TerrainRenderer(canvas);
    renderer.setFixedSize(640, 400);
    const camera = { x: 500, y: 200, z: 1.7, heading: 0, pitch: 0, fov: 40 };
    const person = { x: 500, y: 700, z: 0, height: 1.8, heading: 180, skin: 'conquest' };
    const images = [];
    for (const ridge of [false, true]) {
      const heights = new Float32Array(81);
      if (ridge) for (let x = 0; x < 9; x++) heights[4 * 9 + x] = 80;
      renderer.setTerrain(new TerrainModel({ size: 1000, n: 9, heights }));
      renderer.setPerson(person); await renderer.friendSprite.ready;
      renderer.render(camera, { personMotion: { sprite: true, opacity: 1, altitude: 0 } });
      const withPerson = canvas.toDataURL();
      renderer.setPerson(null); renderer.render(camera);
      images.push({ ridge, withPerson, withoutPerson: canvas.toDataURL() });
    }
    renderer.friendSprite.dispose(); renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { exports, images };
  });
  for (const e of result.exports) {
    assert.equal(e.loaded, true);
    assert.equal(e.samples[0].motion.sprite, false);
    assert.equal(e.samples.at(-1).motion.altitude, 0);
    assert.equal(e.png.sprite, true); assert.equal(e.png.altitude, 0);
    assert.ok(e.bytes > 1000); assert.equal(e.type, 'video/mp4');
    if (out) for (const stage of ['descent', 'question']) await writeFile(join(out, `conquest-${e.format}-${stage}.png`), Buffer.from(e[stage].split(',')[1], 'base64'));
  }
  assert.notEqual(result.images[0].withPerson, result.images[0].withoutPerson);
  assert.equal(result.images[1].withPerson, result.images[1].withoutPerson);
  assert.deepEqual(errors, []);
  console.log('Conquest browser checks passed: character selection, 3-second opening, normal zoom, slow descent, camera tracking, replay, unchanged answer, mobile, links, PNG/video in both formats and terrain occlusion.');
} finally { await browser.close(); server.close(); }
