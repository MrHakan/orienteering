import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/engine/quiz.js';
import { sunWatchFrame, WATCH_TIMING, FRIEND_WATCH_TIMING } from '../src/engine/sunWatch.js';
import { friendSceneFrame } from '../src/export/friendZoom.js';
import { relativeBearing } from '../src/render/relativeBearing.js';

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
// Node and Chromium can differ by a few ulps in trigonometric results.
// Match the same angular/vector tolerances used by the scene checks above.
function assertSolar(actual, expected) {
  for (const key of ['azimuth', 'altitude']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, 'solar ' + key);
  }
  assert.equal(actual.direction.length, expected.direction.length);
  expected.direction.forEach((value, i) =>
    assert.ok(Math.abs(actual.direction[i] - value) < 1e-12, 'solar direction ' + i));
}

try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', err => errors.push(err.message));
  page.on('response', response => { if (response.status() >= 400 && /\.(js|webp)($|\?)/.test(response.url())) errors.push(`Missing asset: ${response.url()}`); });
  const q = await generate({ seed: 'sun-places', difficulty: 'sun-watch', mode: 'where-am-i' });
  await page.goto(`${url}/#seed=sun-places&d=sun-watch`); await ready(page);
  const observeScene = () => page.evaluate(async () => {
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
  await observeScene();
  assert.equal(await page.locator('#direction-tools').isVisible(), true);
  assert.equal(await page.locator('#relative-bearing').isVisible(), true);
  assert.equal(await page.locator('.facing').isVisible(), false);
  assert.equal(await page.locator('#facts').isVisible(), false);
  assert.equal(await page.locator('.dev').isVisible(), true);
  assert.equal(await page.locator('#dev-form').isVisible(), false);
  assert.equal(q.sunWatch.latitude, 0);
  assert.equal(await page.locator('.about').isVisible(), false);
  assert.equal(await page.locator('#opt-tape').isVisible(), false);
  assert.equal(await page.locator('#opt-landforms').isVisible(), false);
  assert.equal(await page.locator('#answers button').count(), 3);
  assert.equal(await page.locator('#heading-field').isVisible(), false);
  assert.equal(await page.locator('#direction-scrub').getAttribute('max'), '15');
  assert.match(await page.locator('#prompt').textContent(), /^You are at A, B or C\. Which one\?$/);
  assert.equal(await page.locator('#open-export').isVisible(), true);
  const hash = new URL(page.url()).hash;
  for (const t of [0, 2, 2.5, 4, 5.5, 6.4, 8.3, 10.2, 11, 13, 15]) {
    await seek(page, t);
    const actual = await page.evaluate(() => window.sunFrames.at(-1));
    const expected = sunWatchFrame(q, t);
    for (const [key, value] of Object.entries(expected.camera)) assert.ok(Math.abs(actual.camera[key] - value) < 1e-9, `camera ${key} at ${t}`);
    assert.deepEqual(actual.options.watch, expected.watch);
    assert.equal(await page.locator('#relative-bearing-value').textContent(), relativeBearing(expected.camera.heading, q.camera.heading, expected.relativeTurn).text);
    if (t >= WATCH_TIMING.aim && t <= WATCH_TIMING.return) {
      assert.ok(Math.abs(actual.camera.heading - actual.options.solar.azimuth) < 1e-9);
      assert.ok(Math.abs(actual.camera.pitch - actual.options.solar.altitude) < 1e-9);
    }
    assert.equal(actual.options.solar.azimuth, q.sunWatch.hour24 < 12 ? 90 : 270);
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
  const pausedBearing = await page.locator('#relative-bearing-value').textContent();
  await page.waitForTimeout(150); assert.equal(await page.locator('#direction-scrub').inputValue(), paused);
  assert.equal(await page.locator('#relative-bearing-value').textContent(), pausedBearing);
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
    const { relativeBearing } = await import(new URL('render/relativeBearing.js', src));
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
      const text = [], fillText = c.ctx.fillText.bind(c.ctx);
      c.ctx.fillText = (...args) => { text.push(args[0]); return fillText(...args); };
      c.animated = true; await c.drawFrameReady(4);
      if (Math.abs(c.renderer.lastFrame.camera.pitch + 64) > 1e-9 || c.renderer.lastFrame.options.watch.progress !== 1) throw new Error('Export lost watch timing');
      const watchImage = c.canvas.toDataURL();
      await c.drawFrameReady(11); const sunImage = c.canvas.toDataURL();
      const held = sunWatchFrame(q, 11);
      if (!text.includes('FROM START') || !text.includes(relativeBearing(held.camera.heading, q.camera.heading, held.relativeTurn).text)) throw new Error('Export lost relative bearing');
      await c.drawFrameReady(13, { reveal: true });
      if (c.renderer.lastFrame.camera.heading === q.camera.heading) throw new Error('Reveal cut the 15-second sequence short');
      await c.drawFrameReady(15, { reveal: true });
      if (!text.includes('START 0°')) throw new Error('Export relative bearing did not return to zero');
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
  // Standalone Grid keeps the difficulty and uses the same watch/sun clock.
  await page.locator('#mode').selectOption('grid'); await ready(page);
  let exportGrid;
  for (const gridSize of [4, 6, 8, 16]) {
    if (gridSize !== 4) { await page.locator('#grid-size').selectOption(String(gridSize)); await ready(page); }
    const grid = await generate({ seed: 'sun-places', mode: 'grid', difficulty: 'sun-watch', gridSize });
    assert.equal(await page.locator('#difficulty').inputValue(), 'sun-watch');
    assert.equal(await page.locator('#difficulty option[value="sun-watch"]').isEnabled(), true);
    assert.equal(await page.locator('#direction-tools').isVisible(), true);
    assert.equal(await page.locator('#grid-answer').isVisible(), true);
    assert.equal(await page.locator('#grid-cell-label').textContent(), 'Your cell');
    assert.equal(await page.locator('#prompt').textContent(), `Find your cell: A1–${String.fromCharCode(64 + gridSize)}${gridSize}.`);
    assert.equal(await page.locator('.facing').isVisible(), false);
    assert.equal(await page.locator('#facts').isVisible(), false);
    for (const t of [4, 11, 15]) {
      await seek(page, t);
      const actual = await page.evaluate(() => window.sunFrames.at(-1)), expected = sunWatchFrame(grid, t);
      for (const [key, value] of Object.entries(expected.camera))
        assert.ok(Math.abs(actual.camera[key] - value) < 1e-9, `grid ${gridSize} ${key} at ${t}`);
      assert.deepEqual(actual.options.watch, expected.watch);
      assertSolar(actual.options.solar, expected.solar);
      assert.equal(await page.locator('#relative-bearing-value').textContent(), relativeBearing(expected.camera.heading, grid.camera.heading, expected.relativeTurn).text);
    }
    if (gridSize === 6) {
      exportGrid = { ...grid, terrain: { ...grid.terrain, heights: [...grid.terrain.heights] } };
      await seek(page, 4);
      if (out) await page.locator('.card').screenshot({ path: join(out, 'sun-grid6-question.png') });
      await page.locator('#grid-cell').fill('G1'); await page.locator('#grid-submit').click();
      assert.equal(await page.locator('#grid-cell').getAttribute('aria-invalid'), 'true');
    }
    await page.locator('#grid-cell').fill(grid.correctLabel.toLowerCase()); await page.locator('#grid-cell').press('Enter');
    assert.match(await page.locator('#result .verdict').textContent(), new RegExp(`Correct — your cell was ${grid.correctLabel}`));
    assert.equal(await page.locator('#direction-scrub').inputValue(), '15');
    assert.equal(await page.locator('#grid-submit').isDisabled(), true);
  }
  const gridExports = await page.evaluate(async q => {
    const src = new URL('../', document.querySelector('script[type="module"]').src);
    const { TerrainModel } = await import(new URL('engine/terrainModel.js', src));
    const { ExportComposer } = await import(new URL('export/composer.js', src));
    const model = new TerrainModel({ ...q.terrain, heights: new Float32Array(q.terrain.heights), seed: q.terrain.modelSeed });
    const results = [];
    for (const format of ['reels', 'post']) {
      const c = new ExportComposer(q, model, { format, tape: true, easterEgg: null });
      const texts = [], fillText = c.ctx.fillText.bind(c.ctx);
      c.ctx.fillText = (...args) => { texts.push(args[0]); return fillText(...args); };
      const png = await c.toImage({ time: 4 });
      if (png.size < 10000 || c.renderer.lastFrame.options.watch.progress !== 1) throw new Error('Grid export lost watch');
      if (!texts.includes('Find your cell: A1–F6.') || texts.some(t => t.startsWith('FACING'))) throw new Error('Grid export caption/heading');
      const question = c.canvas.toDataURL();
      c.animated = true; await c.drawFrameReady(11);
      if (Math.abs(c.renderer.lastFrame.camera.heading - c.renderer.lastFrame.options.solar.azimuth) > 1e-9) throw new Error('Grid export lost sun turn');
      await c.drawFrameReady(15, { reveal: true });
      if (!texts.includes('Answer: ' + q.correctLabel) || JSON.stringify(c.renderer.lastFrame.camera) !== JSON.stringify(q.camera)) throw new Error('Grid export lost answer');
      if (c.renderer.gl.getError()) throw new Error('Grid watch export WebGL error');
      results.push({ format, question, answer: c.canvas.toDataURL() }); c.dispose();
    }
    return results;
  }, exportGrid);
  if (out) for (const e of gridExports) for (const stage of ['question', 'answer'])
    await writeFile(join(out, `sun-grid6-${e.format}-${stage}.png`), Buffer.from(e[stage].split(',')[1], 'base64'));
  await page.locator('#grid-challenge').selectOption('lost-compass'); await ready(page);
  assert.equal(await page.locator('#difficulty').inputValue(), 'sun-watch');
  assert.equal(await page.locator('#direction-tools').isVisible(), true);
  await page.reload(); await ready(page);
  await observeScene();
  assert.equal(await page.locator('#difficulty').inputValue(), 'sun-watch');
  assert.equal(await page.locator('#grid-size').inputValue(), '16');
  assert.equal(await page.locator('#grid-challenge').inputValue(), 'lost-compass');
  await seek(page, 4); assert.equal(await page.locator('#relative-bearing').isVisible(), true);
  console.log('Standalone Grid passed: all four sizes, cell answers, watch/sun frames, exports and replay links.');
  // Switching difficulty or choosing an unsupported mode restores ordinary controls.
  await page.locator('#difficulty').selectOption('medium'); await ready(page);
  assert.equal(await page.locator('#relative-bearing').isVisible(), false);
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
      for (const t of [0, 5, 5.5, 6, 6.5, 8, 9.5, 10.2, 11.2, 12.3, 12.6, 12.9, 13.9, 15]) {
        await seek(page, t);
        const actual = await page.evaluate(() => window.sunFrames.at(-1));
        const expected = friendSceneFrame(friend, t, true);
        for (const [key, value] of Object.entries(expected.camera)) assert.ok(Math.abs(actual.camera[key] - value) < 1e-9, `friend ${skin} ${answerMode} ${key} at ${t}`);
        assert.deepEqual(actual.options.watch, expected.watch);
        assert.equal(await page.locator('#relative-bearing-value').textContent(), relativeBearing(expected.camera.heading, friend.camera.heading, expected.relativeTurn).text);
        if (t >= FRIEND_WATCH_TIMING.aim && t <= FRIEND_WATCH_TIMING.return) {
          assert.ok(Math.abs(actual.camera.heading - actual.options.solar.azimuth) < 1e-9);
          assert.ok(Math.abs(actual.camera.pitch - actual.options.solar.altitude) < 1e-9);
        }
        assert.equal(actual.options.personMotion.wave, expected.personMotion.wave);
        assert.equal(actual.options.personMotion.altitude, expected.personMotion.altitude);
        assert.equal(await page.locator('.facing').isVisible(), false);
        assert.equal(await page.locator('#facts').isVisible(), false);
        assert.equal(await page.locator('#scene-error').isVisible(), false);
        if (out && [5.5, 8, 12.6].includes(t)) await page.locator('.scene-wrap').screenshot({ path: join(out, `sun-friend-${answerMode}-${skin}-${t}.png`) });
      }
      const plain = { ...friend, terrain: { ...friend.terrain, heights: [...friend.terrain.heights] } };
      const shots = await page.evaluate(async q => {
        const src = new URL('../', document.querySelector('script[type="module"]').src);
        const { ExportComposer } = await import(new URL('export/composer.js', src));
        const { TerrainModel } = await import(new URL('engine/terrainModel.js', src));
        const { friendSceneFrame } = await import(new URL('export/friendZoom.js', src));
        const { relativeBearing } = await import(new URL('render/relativeBearing.js', src));
        const model = new TerrainModel({ ...q.terrain, heights: new Float32Array(q.terrain.heights), seed: q.terrain.modelSeed });
        const shots = [];
        for (const format of ['reels', 'post']) {
          const c = new ExportComposer(q, model, { format, tape: true, easterEgg: null }); c.animated = true;
          const text = [], fillText = c.ctx.fillText.bind(c.ctx);
          c.ctx.fillText = (...args) => { text.push(args[0]); return fillText(...args); };
          for (const t of [5.5, 8, 12.6, 13.95, 15]) {
            text.length = 0;
            await c.drawFrameReady(t, { reveal: t >= 12 });
            const expected = friendSceneFrame(q, t, true), actual = c.renderer.lastFrame;
            if (JSON.stringify(actual.camera) !== JSON.stringify(expected.camera)) throw new Error(`Friend export differs at ${t}`);
            if (JSON.stringify(actual.options.watch) !== JSON.stringify(expected.watch)) throw new Error('Friend watch mismatch');
            if (!text.includes('FROM START') || !text.includes(relativeBearing(expected.camera.heading, q.camera.heading, expected.relativeTurn).text)) throw new Error(`Friend export lost relative bearing at ${t}`);
            if (t === 8 || t === 12.6) shots.push({ format, t, image: c.canvas.toDataURL() });
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
  // Exercise the real developer form: worker generation, persistence, links,
  // live/export sky and restoring the default must all use the same latitude.
  const developer = await browser.newPage({ reducedMotion: 'reduce' });
  developer.on('pageerror', error => errors.push(error.message));
  const observeDeveloper = () => developer.evaluate(async () => {
    const src = new URL('../', document.querySelector('script[type="module"]').src);
    const { TerrainRenderer } = await import(new URL('render/webglTerrain.js', src));
    const render = TerrainRenderer.prototype.render;
    window.latitudeFrames = {};
    TerrainRenderer.prototype.render = function(camera, options) {
      const result = render.call(this, camera, options);
      window.latitudeFrames[this.canvas.id === 'scene' ? 'scene' : 'export'] = { camera, options };
      return result;
    };
  });
  const checkLatitude = async expectedQuiz => {
    await seek(developer, 11);
    const actual = await developer.evaluate(() => window.latitudeFrames.scene);
    const expected = sunWatchFrame(expectedQuiz, 11);
    for (const [key, value] of Object.entries(expected.camera))
      assert.ok(Math.abs(actual.camera[key] - value) < 1e-9, 'latitude camera ' + key);
    assertSolar(actual.options.solar, expected.solar);
    assert.equal(await developer.locator('#facts').isVisible(), false);
    assert.equal(await developer.locator('.facing').isVisible(), false);
  };
  const latitudeField = developer.locator('[data-key="sunLat"]');
  const developerDefault = await generate({ seed: 'sun-places', difficulty: 'sun-watch', variant: 1 });
  await developer.goto(`${url}/#seed=sun-places&d=sun-watch&v=1`); await ready(developer);
  await observeDeveloper(); await developer.locator('#dev-enabled').check();
  assert.equal(await latitudeField.isEnabled(), true);
  assert.equal(await latitudeField.getAttribute('placeholder'), '0');
  assert.equal(await developer.locator('#dev-sun-note').isVisible(), true);
  await latitudeField.fill('40'); await developer.locator('#dev-form [type="submit"]').click(); await ready(developer);
  const northern = await generate({ seed: 'sun-places', difficulty: 'sun-watch', variant: 1, tuning: { sunLat: 40 } });
  assert.deepEqual(northern.camera, developerDefault.camera);
  assert.deepEqual(northern.options, developerDefault.options);
  assert.equal(northern.correctLabel, developerDefault.correctLabel);
  await checkLatitude(northern);
  assert.equal(new URLSearchParams(new URL(developer.url()).hash.slice(1)).get('dev'), 'sunLat:40');
  await developer.locator('#open-export').click();
  await developer.waitForFunction(() => window.latitudeFrames.export?.options.solar);
  const exported = await developer.evaluate(() => window.latitudeFrames.export);
  assertSolar(exported.options.solar, sunWatchFrame(northern, exported.options.time).solar);
  await developer.locator('#export-close').click();
  await developer.reload(); await ready(developer); await observeDeveloper();
  assert.equal(await latitudeField.inputValue(), '40'); await checkLatitude(northern);
  // A new link without an override retains the user's saved developer setting.
  await developer.goto(`${url}/#seed=sun-places&d=sun-watch&v=1`); await ready(developer);
  await observeDeveloper(); assert.equal(await latitudeField.inputValue(), '40'); await checkLatitude(northern);
  await developer.locator('#dev-enabled').uncheck(); await ready(developer); await checkLatitude(developerDefault);
  assert.equal(new URLSearchParams(new URL(developer.url()).hash.slice(1)).has('dev'), false);
  await developer.locator('#dev-enabled').check(); await ready(developer); await checkLatitude(northern);
  await developer.locator('#dev-reset').click(); await ready(developer); await checkLatitude(developerDefault);
  assert.equal(await latitudeField.inputValue(), '');
  await developer.locator('#mode').selectOption('grid'); await ready(developer);
  assert.equal(await latitudeField.isEnabled(), true);
  assert.equal(await developer.locator('#dev-sun-note').isVisible(), true);
  await latitudeField.fill('40'); await developer.locator('#dev-form [type="submit"]').click(); await ready(developer);
  await checkLatitude(await generate({ seed: 'sun-places', mode: 'grid', difficulty: 'sun-watch', tuning: { sunLat: 40 } }));
  await developer.locator('#mode').selectOption('facing'); await ready(developer);
  assert.equal(await latitudeField.isDisabled(), true);
  assert.equal(await developer.locator('#dev-sun-note').isVisible(), false);
  await developer.close();
  console.log('Developer latitude passed: apply, saved settings, shared link, export, reset, disable and ordinary-mode gating.');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  mobile.on('pageerror', error => errors.push(error.message));
  await mobile.addInitScript(() => {
    const context = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'webgl2' ? null : context.call(this, type, ...args); };
  });
  await mobile.goto(`${url}/#seed=y6pw-zwtz&d=sun-watch&m=friend&fa=grid&g=6&fc=depth-trap&v=1&dev=sunLat:40`); await ready(mobile);
  assert.equal(await mobile.locator('[data-key="sunLat"]').inputValue(), '40');
  assert.equal(await mobile.locator('[data-key="sunLat"]').isEnabled(), true);
  await mobile.waitForTimeout(500); await seek(mobile, 8);
  assert.equal(await mobile.locator('#relative-bearing-value').textContent(), 'START 0°');
  await seek(mobile, 12.6);
  assert.equal(await mobile.locator('#relative-bearing-value').textContent(), 'RIGHT 136°');
  assert.equal(await mobile.locator('#scene-error').isVisible(), false);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (out) await mobile.screenshot({ path: join(out, 'sun-watch-mobile.png'), fullPage: true });
  await seek(mobile, 13.9);
  assert.equal(await mobile.locator('#relative-bearing-value').textContent(), 'RIGHT 73°');
  await seek(mobile, 15);
  assert.equal(await mobile.locator('#relative-bearing-value').textContent(), 'START 0°');
  await mobile.goto(`${url}/#seed=grid-check&d=sun-watch&m=grid&g=16&gc=lost-compass`); await ready(mobile);
  await seek(mobile, 4);
  assert.equal(await mobile.locator('#difficulty').inputValue(), 'sun-watch');
  assert.equal(await mobile.locator('.facing').isVisible(), false);
  assert.equal(await mobile.locator('#scene-error').isVisible(), false);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const mobileGrid = await generate({ seed: 'grid-check', mode: 'grid', difficulty: 'sun-watch', gridSize: 16, gridChallenge: 'lost-compass' });
  await mobile.locator('#map').scrollIntoViewIfNeeded();
  const bounds = await mobile.locator('#map').boundingBox(), scale = Math.min(bounds.width, bounds.height) - 56;
  await mobile.touchscreen.tap(bounds.x + bounds.width / 2 + (mobileGrid.camera.x / mobileGrid.terrain.size - .5) * scale,
    bounds.y + bounds.height / 2 + (.5 - mobileGrid.camera.y / mobileGrid.terrain.size) * scale);
  assert.equal(await mobile.locator('#grid-cell').inputValue(), mobileGrid.correctLabel);
  await mobile.locator('#grid-submit').tap();
  assert.match(await mobile.locator('#result .verdict').textContent(), /^Correct/);
  if (out) await mobile.screenshot({ path: join(out, 'sun-grid16-mobile.png'), fullPage: true });
  await mobile.close(); assert.deepEqual(errors, []);
  console.log('Sun/watch browser checks passed: difficulty, three locations, 15s video, varied sun bearings, no absolute heading, dynamic relative RIGHT/LEFT bearing, direct sun turn then return to friend, standalone 4/6/8/16 grids, friend zoom then watch, point/6×6 grid, both skins and export formats, replay/pause, ordinary modes restored, mobile and WebGL 1.');
} finally { await browser.close(); server.close(); }
