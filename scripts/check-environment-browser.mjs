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
const ready = page => page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 90000 });
async function instrument(page) {
  await page.evaluate(async () => {
    const src = new URL('../', document.querySelector('script[type="module"]').src);
    const { TerrainRenderer } = await import(new URL('render/webglTerrain.js', src));
    const render = TerrainRenderer.prototype.render;
    window.environmentFrames = [];
    TerrainRenderer.prototype.render = function(camera, options) {
      const result = render.call(this, camera, options);
      if (this.canvas.id === 'scene') {
        window.sceneRenderer = this;
        window.environmentFrames.push({ camera, options });
      }
      return result;
    };
  });
}
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  page.on('pageerror', err => errors.push(err.message));
  const q = await generate({ seed: 'friend-demo', difficulty: 'easy', mode: 'friend', friendAnswer: 'grid', gridSize: 6 });
  // Exercise the shipped module graph, not a second source copy.
  await page.goto(`${url}/#seed=friend-demo&d=easy&m=friend&fa=grid&g=6`); await ready(page); await instrument(page);
  const hash = new URL(page.url()).hash;
  const mapBefore = await page.locator('#map').evaluate(canvas => canvas.toDataURL());
  for (const key of ['hd', 'foliage', 'nature']) await page.locator(`#scene-${key}`).check();
  await page.locator('#scene-wind').selectOption('strong');
  await page.locator('#scene-weather').selectOption('storm');
  await page.waitForFunction(() => window.environmentFrames.length > 8);
  const live = await page.evaluate(() => window.environmentFrames.at(-1));
  assert.deepEqual(live.camera, q.camera);
  assert.equal(live.options.weather.precipitation, 1);
  assert.equal(live.options.environment.hd, true);
  assert.equal(live.options.environment.foliage, true);
  assert.equal(live.options.environment.nature, true);
  assert.equal(new URL(page.url()).hash, hash);
  assert.equal(await page.locator('#map').evaluate(canvas => canvas.toDataURL()), mapBefore);
  if (out) await page.screenshot({ path: join(out, 'environment-live-storm.png') });

  await page.reload(); await ready(page); await instrument(page);
  assert.equal(await page.locator('#scene-weather').inputValue(), 'storm');
  assert.equal(await page.locator('#scene-hd').isChecked(), true);
  await page.locator('#scene-weather').selectOption('snow');
  await page.locator('#scene-wind').selectOption('breeze');
  await page.locator('#open-export').click();
  for (const key of ['hd', 'foliage', 'nature']) assert.equal(await page.locator(`#export-${key}`).isChecked(), true);
  assert.equal(await page.locator('#export-weather').inputValue(), 'snow');
  assert.equal(await page.locator('#export-wind').inputValue(), 'breeze');
  const pausedCount = await page.evaluate(() => window.environmentFrames.length);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.environmentFrames.length), pausedCount);
  await page.locator('#export-weather').selectOption('sunset');
  await page.locator('#export-close').click();
  assert.equal(await page.locator('#scene-weather').inputValue(), 'snow');
  await page.waitForFunction(count => window.environmentFrames.length > count, pausedCount);

  // Reduced motion freezes weather, without changing the camera or quiz.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => window.environmentFrames.at(-1)?.options.environmentTime === 0);
  const reducedCount = await page.evaluate(() => window.environmentFrames.length);
  await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => window.environmentFrames.length), reducedCount);
  await page.locator('#grid-cell').fill(q.correctLabel); await page.locator('#grid-cell').press('Enter');
  assert.match(await page.locator('#result .verdict').textContent(), /^Correct/);

  const plain = { ...q, terrain: { ...q.terrain, heights: [...q.terrain.heights] } };
  const audit = await page.evaluate(async q => {
    const src = new URL('../', document.querySelector('script[type="module"]').src);
    const { TerrainRenderer } = await import(new URL('render/webglTerrain.js', src));
    const { TerrainModel } = await import(new URL('engine/terrainModel.js', src));
    const { CONDITIONS, weatherParams } = await import(new URL('render/environment.js', src));
    const { ExportComposer } = await import(new URL('export/composer.js', src));
    const { encodeCanvasVideo } = await import(new URL('export/recorder.js', src));
    const model = new TerrainModel({ ...q.terrain, heights: new Float32Array(q.terrain.heights), seed: q.terrain.modelSeed });
    const canvas = document.createElement('canvas'), r = new TerrainRenderer(canvas); r.setTerrain(model); r.setFixedSize(480, 300);
    const pixels = () => { const data = new Uint8Array(canvas.width * canvas.height * 4); r.gl.readPixels(0, 0, canvas.width, canvas.height, r.gl.RGBA, r.gl.UNSIGNED_BYTE, data); return data; };
    const difference = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 2) n++; return n / (a.length / 4); };
    const environment = { hd: true, foliage: true, nature: true, wind: 'strong' };
    const result = { conditions: [], texture: {}, exports: [] };
    for (const { id } of CONDITIONS) {
      const weather = weatherParams({ ...environment, condition: id }, q.camera.heading);
      const options = { environment, weather, time: 4 };
      r.render(q.camera, options); const a = pixels();
      r.render(q.camera, options); const repeat = pixels();
      if (difference(a, repeat) > .001) throw new Error(`Non-deterministic ${id} frame`);
      r.render(q.camera, { ...options, time: 4.7 }); const b = pixels();
      if (difference(a, b) < .001) throw new Error(`Frozen ${id} animation`);
      if (r.gl.getError()) throw new Error(`WebGL error in ${id}`);
      if (a.some((value, i) => i % 4 === 3 && value !== 255)) throw new Error(`Weather damaged canvas opacity: ${id}`);
      result.conditions.push({ id, changed: difference(a, b) });
    }
    for (const id of ['rain', 'snow']) {
      const options = { environment, weather: weatherParams({ condition: id, wind: 'breeze' }, q.camera.heading), time: 4 };
      r.render(q.camera, options); const withParticles = pixels();
      const draw = r.drawWeather; r.drawWeather = () => {}; r.render(q.camera, options); const without = pixels(); r.drawWeather = draw;
      if (difference(withParticles, without) < .005) throw new Error(`Missing ${id} particles`);
    }
    r.render(q.camera); const basic = pixels();
    r.render(q.camera, { environment: { hd: true } }); const hd = pixels();
    if (difference(basic, hd) < .01) throw new Error('HD texture had no visible effect');
    r.render(q.camera, { environment: { foliage: true } }); const foliage = pixels();
    r.render(q.camera, { environment: { nature: true } }); const nature = pixels();
    if (difference(basic, foliage) < .0001 || difference(basic, nature) < .0001) throw new Error('Missing foliage/nature');
    result.texture.changed = difference(basic, hd);
    // The Conquest sprite must not replace the HD texture between depth passes.
    const away = { ...q.camera, heading: (q.camera.heading + 180) % 360 };
    r.render(away, { environment: { hd: true } }); const empty = pixels();
    r.setPerson({ ...q.friend, skin: 'conquest' }); await r.friendSprite.ready;
    r.render(away, { environment: { hd: true }, personMotion: { sprite: true, opacity: 1 } });
    if (difference(empty, pixels()) > .001) throw new Error('Friend sprite corrupted HD terrain');
    r.friendSprite.dispose(); r.gl.getExtension('WEBGL_lose_context')?.loseContext();

    for (const format of ['reels', 'post']) {
      const c = new ExportComposer(q, model, { format, environment: { ...environment, condition: 'snow', wind: 'breeze' }, easterEgg: null });
      c.animated = true; await c.drawFrameReady(4);
      if (c.renderer.lastFrame.options.environmentTime !== 4 || c.weather.snow !== 1) throw new Error('Export lost environment clock/settings');
      const question = c.canvas.toDataURL();
      await c.drawFrameReady(13, { reveal: true }); const answer = c.canvas.toDataURL();
      const png = await c.toImage({ time: 4 });
      if (png.size < 10000) throw new Error('Empty environment PNG');
      if (format === 'post') {
        const clip = await encodeCanvasVideo(c.canvas, t => c.drawFrameReady(t), { duration: .5, fps: 12 });
        if (clip.blob.size < 1000) throw new Error('Empty weather video');
        result.video = { bytes: clip.blob.size, type: clip.blob.type };
      }
      if (c.renderer.gl.getError()) throw new Error('Export WebGL error');
      result.exports.push({ format, question, answer }); c.dispose();
    }
    return result;
  }, plain);
  assert.equal(audit.conditions.length, 9);
  assert.ok(audit.video.bytes > 1000);
  if (out) for (const e of audit.exports) for (const stage of ['question', 'answer']) {
    await writeFile(join(out, `environment-${e.format}-${stage}.png`), Buffer.from(e[stage].split(',')[1], 'base64'));
  }
  // Ambient weather must not advance a paused run or interrupt knife inspect.
  await page.goto(`${url}/#seed=bhop-demo&d=medium&m=trail&k=classic`); await ready(page); await instrument(page);
  await page.locator('#trail-scrub').evaluate(el => { el.value = '4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#scene-weather').selectOption('rain');
  await page.waitForFunction(() => window.sceneRenderer?.viewmodel?.hasFrame, null, { timeout: 30000 });
  const trailCamera = await page.evaluate(() => window.sceneRenderer.lastFrame.camera);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const trailCount = await page.evaluate(() => window.environmentFrames.length);
  await page.waitForFunction(count => window.environmentFrames.length > count + 2, trailCount);
  assert.equal(await page.locator('#trail-scrub').inputValue(), '4');
  assert.deepEqual(await page.evaluate(() => window.sceneRenderer.lastFrame.camera), trailCamera);
  await page.locator('#trail-inspect').click();
  await page.waitForFunction(() => window.environmentFrames.at(-1)?.options.motion.inspectElapsed > .1);
  assert.deepEqual(await page.evaluate(() => window.sceneRenderer.lastFrame.camera), trailCamera);
  assert.equal(await page.evaluate(() => window.sceneRenderer.gl.getError()), 0);
  if (out) await page.screenshot({ path: join(out, 'environment-trail-rain.png') });
  // WebGL 1 fallback and a narrow mobile viewport must also render the settings.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  mobile.on('pageerror', err => errors.push(err.message));
  await mobile.addInitScript(() => {
    const context = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'webgl2' ? null : context.call(this, type, ...args); };
  });
  await mobile.goto(`${url}/#seed=friend-demo&d=easy&m=friend&fa=grid&g=6`); await ready(mobile); await instrument(mobile);
  await mobile.locator('#scene-hd').check(); await mobile.locator('#scene-foliage').check();
  await mobile.locator('#scene-weather').selectOption('rain');
  assert.equal(await mobile.locator('#scene-error').isVisible(), false);
  assert.equal(await mobile.evaluate(() => window.sceneRenderer.gl.getError()), 0);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (out) await mobile.screenshot({ path: join(out, 'environment-mobile.png'), fullPage: true });
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log('Environment browser checks passed: 9 animated conditions, gusts, HD detail, foliage/nature, preferences, stable quiz/map, reduced motion, PNG/video, Conquest texture isolation, paused trails/knife inspect, mobile and WebGL 1.');
} finally {
  await browser.close(); server.close();
}
