import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/engine/quiz.js';
import { sunWatchFrame } from '../src/engine/sunWatch.js';
import { friendSceneFrame } from '../src/export/friendZoom.js';

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
const seek = (page, time) => page.locator('#direction-scrub').evaluate((el, time) => { el.value = String(time); el.dispatchEvent(new Event('input', { bubbles: true })); }, time);
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', err => errors.push(err.message));
  page.on('response', response => { if (response.status() >= 400 && /\.(js|webp)($|\?)/.test(response.url())) errors.push(`Missing asset: ${response.url()}`); });
  const q = await generate({ seed: 'sun-places', difficulty: 'sun-watch', mode: 'where-am-i' });
  await page.goto(`${url}/#seed=sun-places&d=sun-watch`); await ready(page);
  await page.evaluate(async () => {
    const src = new URL('../', document.querySelector('script[type="module"]').src);
    const { TerrainRenderer } = await import(new URL('render/webglTerrain.js', src));
    const render = TerrainRenderer.prototype.render;
    window.sunFrames = [];
    TerrainRenderer.prototype.render = function(camera, options) {
      const result = render.call(this, camera, options);
      if (this.canvas.id === 'scene') { window.sceneRenderer = this; window.sunFrames.push({ camera, options }); }
      return result;
    };
  });
  assert.equal(await page.locator('#direction-tools').isVisible(), true);
  assert.equal(await page.locator('.facing').isVisible(), false);
  assert.equal(await page.locator('#facts').isVisible(), false);
  assert.equal(await page.locator('.dev').isVisible(), false);
  assert.equal(await page.locator('.about').isVisible(), false);
  assert.equal(await page.locator('#opt-tape').isVisible(), false);
  assert.equal(await page.locator('#opt-landforms').isVisible(), false);
  assert.equal(await page.locator('#answers button').count(), 3);
  assert.equal(await page.locator('#heading-field').isVisible(), false);
  assert.equal(await page.locator('#direction-scrub').getAttribute('max'), '15');
  assert.match(await page.locator('#prompt').textContent(), /^You are at A, B or C\. Which one\?$/);
  assert.equal(await page.locator('#open-export').isVisible(), true);
  const hash = new URL(page.url()).hash;
  for (const t of [0, 2, 2.5, 4, 5.5, 6.4, 7.4, 9, 11, 12, 15]) {
    await seek(page, t);
    const actual = await page.evaluate(() => window.sunFrames.at(-1));
    const expected = sunWatchFrame(q, t);
    for (const [key, value] of Object.entries(expected.camera)) assert.ok(Math.abs(actual.camera[key] - value) < 1e-9, `camera ${key} at ${t}`);
    assert.deepEqual(actual.options.watch, expected.watch);
    for (const key of ['azimuth', 'altitude']) assert.ok(Math.abs(actual.options.solar[key] - expected.solar[key]) < 1e-9);
    expected.solar.direction.forEach((value, i) => assert.ok(Math.abs(actual.options.solar.direction[i] - value) < 1e-12));
    assert.equal(await page.locator('#tape').evaluate(c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0)), false);
    assert.equal(await page.locator('#scene-error').isVisible(), false);
    if (out && [4, 11].includes(t)) await page.locator('.scene-wrap').screenshot({ path: join(out, `sun-watch-live-${t}.png`) });
  }
  assert.equal(new URL(page.url()).hash, hash);
  await seek(page, 4); await page.locator('#direction-play').click();
  await page.waitForFunction(() => Number(document.getElementById('direction-scrub').value) > 4.2);
  await page.locator('#direction-play').click();
  const paused = await page.locator('#direction-scrub').inputValue();
  await page.waitForTimeout(150); assert.equal(await page.locator('#direction-scrub').inputValue(), paused);
  await page.locator('#direction-replay').click();
  await page.waitForFunction(() => Number(document.getElementById('direction-scrub').value) < 1);
  await page.locator('#direction-play').click(); await seek(page, 4);
  await page.locator('#open-export').click();
  assert.equal(await page.locator('#export-sequence-note').isVisible(), true);
  await page.locator('#export-close').click();
  await page.locator(`#answers [data-label="${q.correctLabel}"]`).click();
  assert.match(await page.locator('#result .verdict').textContent(), /^Correct/);
  assert.equal(await page.locator('#direction-scrub').inputValue(), '15');
  assert.equal(await page.locator('#facts').isVisible(), true);

  const plain = { ...q, terrain: { ...q.terrain, heights: [...q.terrain.heights] } };
  const audit = await page.evaluate(async q => {
    const src = new URL('../', document.querySelector('script[type="module"]').src);
    const { TerrainRenderer } = await import(new URL('render/webglTerrain.js', src));
    const { TerrainModel } = await import(new URL('engine/terrainModel.js', src));
    const { sunWatchFrame } = await import(new URL('engine/sunWatch.js', src));
    const { ExportComposer } = await import(new URL('export/composer.js', src));
    const { encodeCanvasVideo } = await import(new URL('export/recorder.js', src));
    const model = new TerrainModel({ ...q.terrain, heights: new Float32Array(q.terrain.heights), seed: q.terrain.modelSeed });
    const canvas = document.createElement('canvas'), r = new TerrainRenderer(canvas); r.setTerrain(model); r.setFixedSize(480, 300); await r.prepareWatch();
    const pixels = () => { const data = new Uint8Array(canvas.width * canvas.height * 4); r.gl.readPixels(0, 0, canvas.width, canvas.height, r.gl.RGBA, r.gl.UNSIGNED_BYTE, data); return data; };
    const result = { directions: [], exports: [] };
    for (const heading of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const frame = sunWatchFrame({ ...q, camera: { ...q.camera, heading } }, 11);
      r.render(frame.camera, { solar: frame.solar, watch: frame.watch, time: 11 });
      let bright = 0;
      const data = pixels();
      for (let i = 0; i < data.length; i += 4) if (data[i] > 245 && data[i + 1] > 220 && data[i + 2] > 170) bright++;
      if (bright < 10) throw new Error(`Sun not visible from initial heading ${heading}`);
      if (r.gl.getError()) throw new Error('Solar shader WebGL error');
      result.directions.push({ heading, bright });
    }
    const watch = sunWatchFrame(q, 4);
    r.render(watch.camera, { solar: watch.solar, watch: watch.watch, time: 4 }); const first = pixels();
    r.render(q.camera); r.render(watch.camera, { solar: watch.solar, watch: watch.watch, time: 4 }); const repeat = pixels();
    let changed = 0;
    for (let i = 0; i < first.length; i++) if (Math.abs(first[i] - repeat[i]) > 2) changed++;
    if (changed > first.length * .001) throw new Error('Non-deterministic watch replay');
    r.watchViewmodel.dispose(); r.gl.getExtension('WEBGL_lose_context')?.loseContext();
    for (const format of ['reels', 'post']) {
      const c = new ExportComposer(q, model, { format, tape: true, easterEgg: null });
      c.animated = true; await c.drawFrameReady(4);
      if (Math.abs(c.renderer.lastFrame.camera.pitch + 64) > 1e-9 || c.renderer.lastFrame.options.watch.progress !== 1) throw new Error('Export lost watch timing');
      const watchImage = c.canvas.toDataURL();
      await c.drawFrameReady(11); const sunImage = c.canvas.toDataURL();
      await c.drawFrameReady(13, { reveal: true });
      if (c.renderer.lastFrame.camera.heading === q.camera.heading) throw new Error('Reveal cut the 15-second sequence short');
      await c.drawFrameReady(15, { reveal: true });
      if (JSON.stringify(c.renderer.lastFrame.camera) !== JSON.stringify(q.camera)) throw new Error('Reveal changed the answer viewpoint');
      const png = await c.toImage({ time: 4 }); if (png.size < 10000) throw new Error('Empty watch PNG');
      if (format === 'post') {
        c.animated = true;
        const times = [];
        const clip = await encodeCanvasVideo(c.canvas, t => { times.push(t); return c.drawFrameReady(t, { reveal: t >= 12 }); }, { duration: 15, fps: 2 });
        if (clip.blob.size < 1000) throw new Error('Empty watch video');
        if (times.length !== 30 || times.at(-1) !== 14.5) throw new Error('Video lost its 15-second duration');
        result.video = { bytes: clip.blob.size, type: clip.blob.type, frames: times.length };
      }
      if (c.renderer.gl.getError()) throw new Error('Watch export WebGL error');
      result.exports.push({ format, watchImage, sunImage }); c.dispose();
    }
    return result;
  }, plain);
  assert.equal(audit.directions.length, 8);
  if (out) for (const e of audit.exports) for (const key of ['watchImage', 'sunImage']) {
    await writeFile(join(out, `sun-watch-${e.format}-${key}.png`), Buffer.from(e[key].split(',')[1], 'base64'));
  }
  console.log('Location difficulty, solar visibility and 15-second video exports passed.');
  // Leaving the mode restores the existing interface and never runs its camera clock.
  await page.locator('#mode').selectOption('grid'); await ready(page);
  assert.equal(await page.locator('#direction-tools').isVisible(), false);
  assert.equal(await page.locator('.facing').isVisible(), true);
  assert.equal(await page.locator('#facts').isVisible(), true);
  assert.equal(await page.locator('.about').isVisible(), true);
  assert.equal(await page.locator('#difficulty').inputValue(), 'medium');
  await page.locator('#mode').selectOption('facing'); await ready(page);
  assert.equal(await page.locator('#direction-tools').isVisible(), false);
  assert.equal(await page.locator('#answers button').count(), 8);
  await page.locator('#mode').selectOption('friend'); await ready(page);
  await page.locator('#difficulty').selectOption('sun-watch'); await ready(page);
  await page.locator('.friend-customise summary').click();
  for (const answerMode of ['point', 'grid']) {
    await page.locator('#friend-answer').selectOption(answerMode); await ready(page);
    if (answerMode === 'grid') { await page.locator('#grid-size').selectOption('6'); await ready(page); }
    for (const skin of ['classic', 'conquest']) {
      await page.locator('#friend-skin').selectOption(skin);
      const friend = await generate({ seed: 'sun-places', mode: 'friend', difficulty: 'sun-watch', friendAnswer: answerMode, gridSize: 6, friendSkin: skin });
      assert.equal(await page.locator('#friend-zoom').isVisible(), false);
      for (const t of [0, 5, 5.5, 6, 6.5, 8, 9.5, 10.2, 13.5, 15]) {
        await seek(page, t);
        const actual = await page.evaluate(() => window.sunFrames.at(-1));
        const expected = friendSceneFrame(friend, t, true);
        for (const [key, value] of Object.entries(expected.camera)) assert.ok(Math.abs(actual.camera[key] - value) < 1e-9, `friend ${skin} ${answerMode} ${key} at ${t}`);
        assert.deepEqual(actual.options.watch, expected.watch);
        assert.equal(actual.options.personMotion.wave, expected.personMotion.wave);
        assert.equal(actual.options.personMotion.altitude, expected.personMotion.altitude);
        assert.equal(await page.locator('.facing').isVisible(), false);
        assert.equal(await page.locator('#facts').isVisible(), false);
        assert.equal(await page.locator('#scene-error').isVisible(), false);
        if (out && [5.5, 8, 13.5].includes(t)) await page.locator('.scene-wrap').screenshot({ path: join(out, `sun-friend-${answerMode}-${skin}-${t}.png`) });
      }
      const plain = { ...friend, terrain: { ...friend.terrain, heights: [...friend.terrain.heights] } };
      const shots = await page.evaluate(async q => {
        const src = new URL('../', document.querySelector('script[type="module"]').src);
        const { ExportComposer } = await import(new URL('export/composer.js', src));
        const { TerrainModel } = await import(new URL('engine/terrainModel.js', src));
        const { friendSceneFrame } = await import(new URL('export/friendZoom.js', src));
        const model = new TerrainModel({ ...q.terrain, heights: new Float32Array(q.terrain.heights), seed: q.terrain.modelSeed });
        const shots = [];
        for (const format of ['reels', 'post']) {
          const c = new ExportComposer(q, model, { format, tape: true, easterEgg: null }); c.animated = true;
          for (const t of [5.5, 8, 13.5, 15]) {
            await c.drawFrameReady(t, { reveal: t >= 12 });
            const expected = friendSceneFrame(q, t, true), actual = c.renderer.lastFrame;
            if (JSON.stringify(actual.camera) !== JSON.stringify(expected.camera)) throw new Error(`Friend export differs at ${t}`);
            if (JSON.stringify(actual.options.watch) !== JSON.stringify(expected.watch)) throw new Error('Friend watch mismatch');
            if (t === 8 || t === 13.5) shots.push({ format, t, image: c.canvas.toDataURL() });
          }
          const png = await c.toImage();
          if (png.size < 10000 || c.renderer.lastFrame.options.watch.progress !== 1) throw new Error('Empty/mistimed friend PNG');
          if (c.renderer.gl.getError()) throw new Error('Friend sun export WebGL error');
          c.dispose();
        }
        return shots;
      }, plain);
      if (out) for (const s of shots) await writeFile(join(out, `sun-friend-export-${answerMode}-${skin}-${s.format}-${s.t}.png`), Buffer.from(s.image.split(',')[1], 'base64'));
      console.log(`Friend ${answerMode}/${skin} camera and export sequence passed.`);
    }
  }
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  mobile.on('pageerror', error => errors.push(error.message));
  await mobile.addInitScript(() => {
    const context = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'webgl2' ? null : context.call(this, type, ...args); };
  });
  await mobile.goto(`${url}/#seed=sun-places&d=sun-watch&m=friend&fa=grid&g=6`); await ready(mobile);
  await mobile.waitForTimeout(500); await seek(mobile, 8);
  assert.equal(await mobile.locator('#scene-error').isVisible(), false);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (out) await mobile.screenshot({ path: join(out, 'sun-watch-mobile.png'), fullPage: true });
  await mobile.close(); assert.deepEqual(errors, []);
  console.log('Sun/watch browser checks passed: difficulty, three locations, 15s video, varied sun bearings, no heading/hints, friend zoom then watch, point/6×6 grid, both skins and export formats, replay/pause, ordinary modes restored, mobile and WebGL 1.');
} finally { await browser.close(); server.close(); }
