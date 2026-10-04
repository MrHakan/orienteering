import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/engine/quiz.js';
import { terrainTexture } from '../src/render/terrainTextures.js';

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
const ready = (page, title = 'WHERE IS YOUR FRIEND?') => page.waitForFunction(title => document.getElementById('loading').classList.contains('hidden') && document.getElementById('quiz-title').textContent === title, title, { timeout: 90000 });
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
  // CI may still be decoding 2K assets after the app is ready. Wait for the
  // explicit quiz-ready check rather than the navigation's global load event.
  page.setDefaultNavigationTimeout(90000);
  page.on('pageerror', err => errors.push(err.message));
  const q = await generate({ seed: 'friend-demo', difficulty: 'easy', mode: 'friend', friendAnswer: 'grid', gridSize: 6 });
  // Exercise the shipped module graph, not a second source copy.
  await page.goto(`${url}/#seed=friend-demo&d=easy&m=friend&fa=grid&g=6`, { waitUntil: 'domcontentloaded' }); await ready(page); await instrument(page);
  const hash = new URL(page.url()).hash;
  const mapBefore = await page.locator('#map').evaluate(canvas => canvas.toDataURL());
  assert.equal(await page.locator('#scene-texture').inputValue(), 'auto');
  assert.equal(await page.locator('#scene-texture option').count(), 6);
  assert.equal(await page.locator('#scene-texture-note').textContent(), `Seed style: ${terrainTexture(q.seed).label}.`);
  for (const key of ['foliage', 'nature']) {
    assert.equal(await page.locator(`#scene-${key}-density`).inputValue(), 'moderate');
    assert.equal(await page.locator(`#scene-${key}-density option`).count(), 3);
    assert.equal(await page.locator(`#scene-${key}-density`).isDisabled(), true);
  }
  await page.locator('#scene-texture').selectOption('desert');
  assert.equal(await page.locator('#scene-texture-note').textContent(), 'Texture style: Desert sandstone.');
  for (const key of ['hd', 'foliage', 'nature']) await page.locator(`#scene-${key}`).check();
  await page.locator('#scene-foliage-density').selectOption('heavy');
  await page.locator('#scene-nature-density').selectOption('light');
  await page.locator('#scene-nature').uncheck();
  assert.equal(await page.locator('#scene-nature-density').isDisabled(), true);
  assert.equal(await page.locator('#scene-nature-density').inputValue(), 'light');
  await page.locator('#scene-nature').check();
  await page.locator('#scene-wind').selectOption('strong');
  await page.locator('#scene-weather').selectOption('storm');
  await page.waitForFunction(() => window.environmentFrames.length > 8);
  await page.evaluate(() => window.sceneRenderer.prepareEnvironmentReady({ hd: true, foliage: true, nature: true, foliageDensity: 'heavy', natureDensity: 'light' }));
  const live = await page.evaluate(() => window.environmentFrames.at(-1));
  assert.deepEqual(live.camera, q.camera);
  assert.equal(live.options.weather.precipitation, 1);
  assert.equal(live.options.environment.hd, true);
  assert.equal(live.options.environment.foliage, true);
  assert.equal(live.options.environment.nature, true);
  assert.equal(live.options.environment.texture, 'desert');
  assert.equal(live.options.environment.foliageDensity, 'heavy');
  assert.equal(live.options.environment.natureDensity, 'light');
  assert.equal(await page.evaluate(() => window.sceneRenderer.terrainTexture.id), 'desert');
  assert.equal(new URL(page.url()).hash, hash);
  assert.equal(await page.locator('#map').evaluate(canvas => canvas.toDataURL()), mapBefore);
  if (out) await page.screenshot({ path: join(out, 'environment-live-storm.png') });

  await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await instrument(page);
  assert.equal(await page.locator('#scene-weather').inputValue(), 'storm');
  assert.equal(await page.locator('#scene-hd').isChecked(), true);
  assert.equal(await page.locator('#scene-texture').inputValue(), 'desert');
  assert.equal(await page.locator('#scene-foliage-density').inputValue(), 'heavy');
  assert.equal(await page.locator('#scene-nature-density').inputValue(), 'light');
  await page.locator('#scene-weather').selectOption('snow');
  await page.locator('#scene-wind').selectOption('breeze');
  await page.locator('#open-export').click();
  for (const key of ['hd', 'foliage', 'nature']) assert.equal(await page.locator(`#export-${key}`).isChecked(), true);
  assert.equal(await page.locator('#export-weather').inputValue(), 'snow');
  assert.equal(await page.locator('#export-wind').inputValue(), 'breeze');
  assert.equal(await page.locator('#export-texture').inputValue(), 'desert');
  assert.equal(await page.locator('#export-foliage-density').inputValue(), 'heavy');
  assert.equal(await page.locator('#export-nature-density').inputValue(), 'light');
  const pausedCount = await page.evaluate(() => window.environmentFrames.length);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.environmentFrames.length), pausedCount);
  await page.locator('#export-weather').selectOption('sunset');
  await page.locator('#export-texture').selectOption('alpine');
  await page.locator('#export-foliage-density').selectOption('light');
  await page.locator('#export-nature-density').selectOption('heavy');
  await page.locator('#export-foliage').uncheck();
  assert.equal(await page.locator('#export-foliage-density').isDisabled(), true);
  await page.locator('#export-foliage').check();
  assert.equal(await page.locator('#export-foliage-density').inputValue(), 'light');
  assert.equal(await page.locator('#export-texture-note').textContent(), 'Texture style: Alpine scree.');
  await page.locator('#export-close').click();
  assert.equal(await page.locator('#scene-weather').inputValue(), 'snow');
  assert.equal(await page.locator('#scene-texture').inputValue(), 'desert');
  assert.equal(await page.locator('#scene-foliage-density').inputValue(), 'heavy');
  assert.equal(await page.locator('#scene-nature-density').inputValue(), 'light');
  await page.waitForFunction(count => window.environmentFrames.length > count, pausedCount);

  // Reduced motion freezes weather, without changing the camera or quiz.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => window.environmentFrames.at(-1)?.options.environmentTime === 0);
  const reducedCount = await page.evaluate(() => window.environmentFrames.length);
  await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => window.environmentFrames.length), reducedCount);
  await page.locator('#grid-cell').fill(q.correctLabel); await page.locator('#grid-cell').press('Enter');
  assert.match(await page.locator('#result .verdict').textContent(), /^Correct/);
  await page.locator('#scene-texture').selectOption('auto');
  const seedTexture = terrainTexture(q.seed);
  await page.locator('#new-positions').click(); await ready(page);
  assert.deepEqual(await page.evaluate(() => window.sceneRenderer.terrainTexture), seedTexture);
  await page.locator('#difficulty').selectOption('medium'); await ready(page);
  assert.deepEqual(await page.evaluate(() => window.sceneRenderer.terrainTexture), seedTexture);

  console.log('Live preferences, quiz/map and reduced motion passed.');
  const plain = { ...q, terrain: { ...q.terrain, heights: [...q.terrain.heights] } };
  const audit = await page.evaluate(async q => {
    const src = new URL('../', document.querySelector('script[type="module"]').src);
    const { TerrainRenderer } = await import(new URL('render/webglTerrain.js', src));
    const { TerrainModel } = await import(new URL('engine/terrainModel.js', src));
    const { CONDITIONS, DENSITIES, weatherParams } = await import(new URL('render/environment.js', src));
    const { ExportComposer } = await import(new URL('export/composer.js', src));
    const { encodeCanvasVideo } = await import(new URL('export/recorder.js', src));
    const { TERRAIN_TEXTURES, terrainTexture } = await import(new URL('render/terrainTextures.js', src));
    const model = new TerrainModel({ ...q.terrain, heights: new Float32Array(q.terrain.heights), seed: q.terrain.modelSeed });
    const canvas = document.createElement('canvas'), r = new TerrainRenderer(canvas); r.setTerrain(model, { seed: q.seed }); r.setFixedSize(480, 300);
    const pixels = () => { const data = new Uint8Array(canvas.width * canvas.height * 4); r.gl.readPixels(0, 0, canvas.width, canvas.height, r.gl.RGBA, r.gl.UNSIGNED_BYTE, data); return data; };
    const difference = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 2) n++; return n / (a.length / 4); };
    const environment = { hd: true, foliage: true, nature: true, wind: 'strong' };
    await r.prepareEnvironmentReady(environment);
    if (!r.surfaceTextures.loaded || !r.plantTextures.loaded) throw new Error('Selected environment assets are not ready');
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
    result.densities = [];
    for (const { id, birds } of DENSITIES) {
      const options = { environment: { hd: true, foliage: true, nature: true, foliageDensity: id, natureDensity: id }, time: 4 };
      r.render(q.camera, options); const image = pixels();
      const snapshot = { id, foliage: r.natureMeshes.foliage.count, nature: r.natureMeshes.nature.count,
        ground: r.groundCover.count, image: canvas.toDataURL() };
      if (r.gl.getUniform(r.sky, r.gl.getUniformLocation(r.sky, 'uNature')) !== birds) throw new Error(`Incorrect ${id} bird count`);
      r.render(q.camera, options);
      if (difference(image, pixels()) > .001) throw new Error(`Unstable ${id} density`);
      if (r.gl.getError()) throw new Error(`Density WebGL error: ${id}`);
      result.densities.push(snapshot);
    }
    for (const category of ['foliage', 'nature', 'ground']) {
      const counts = result.densities.map(d => d[category]);
      if (!(counts[0] > 0 && counts[0] < counts[1] && counts[1] < counts[2])) throw new Error(`Density did not change ${category}`);
    }
    const buffers = { foliage: r.natureMeshes.foliage.buffer, nature: r.natureMeshes.nature.buffer, ground: r.groundCover.buffer };
    r.render(q.camera, { environment: { foliage: true, nature: true, foliageDensity: 'light', natureDensity: 'heavy' } });
    if (r.natureMeshes.foliage.count !== result.densities[0].foliage || r.groundCover.count !== result.densities[0].ground
      || r.natureMeshes.nature.count !== result.densities[2].nature) throw new Error('Foliage density affected Nature');
    r.render(q.camera, { environment: { foliage: true, nature: true, foliageDensity: 'light', natureDensity: 'moderate' } });
    if (r.natureMeshes.foliage.count !== result.densities[0].foliage || r.groundCover.count !== result.densities[0].ground
      || r.natureMeshes.nature.count !== result.densities[1].nature) throw new Error('Nature density affected Foliage');
    r.render(q.camera, { environment: { foliage: true, nature: true } });
    if (r.natureMeshes.foliage.count !== result.densities[1].foliage || r.natureMeshes.nature.count !== result.densities[1].nature
      || r.groundCover.count !== result.densities[1].ground) throw new Error('Moderate did not restore original counts');
    if (r.natureMeshes.foliage.buffer !== buffers.foliage || r.natureMeshes.nature.buffer !== buffers.nature
      || r.groundCover.buffer !== buffers.ground) throw new Error('Density changes leaked geometry buffers');
    result.texture.styles = [];
    for (const detail of [false, true]) {
      const shots = [];
      for (const { id, label } of TERRAIN_TEXTURES) {
        const options = { environment: { hd: detail, texture: id } };
        r.render(q.camera, options); const image = pixels();
        r.render(q.camera, options);
        if (difference(image, pixels()) > .001) throw new Error(`Unstable ${id} texture`);
        for (const other of shots) if (difference(other, image) < .03) throw new Error(`Indistinguishable ${id} texture`);
        if (r.gl.getError()) throw new Error(`Texture WebGL error: ${id}`);
        shots.push(image);
        result.texture.styles.push({ id, label, hd: detail, image: canvas.toDataURL() });
      }
    }
    r.render(q.camera, { environment: { hd: true, texture: 'auto' } }); const automatic = pixels();
    if (r.terrainTexture.id !== terrainTexture(q.seed).id) throw new Error('Renderer did not use the raw quiz seed');
    const nextSeed = Array.from({ length: 20 }, (_, i) => `other-texture-${i}`).find(seed => terrainTexture(seed).id !== terrainTexture(q.seed).id);
    r.setTerrain(model, { seed: nextSeed }); await r.prepareEnvironmentReady({ hd: true });
    r.render(q.camera, { environment: { hd: true } });
    if (difference(automatic, pixels()) < .03) throw new Error('Changing seed did not change the automatic texture');
    r.setTerrain(model, { seed: q.seed }); await r.prepareEnvironmentReady({ hd: true, foliage: true, nature: true });
    r.render(q.camera, { environment: { hd: true } });
    if (difference(automatic, pixels()) > .001) throw new Error('Replaying the seed changed its automatic texture');
    r.render(q.camera, { environment: { hd: true, foliage: true, nature: true } });
    if (r.groundCover.count < 1000) throw new Error('Nearby ground cover is missing');
    // The Conquest sprite must not replace the HD texture between depth passes.
    const away = { ...q.camera, heading: (q.camera.heading + 180) % 360 };
    r.render(away, { environment: { hd: true } }); const empty = pixels();
    r.setPerson({ ...q.friend, skin: 'conquest' }); await r.friendSprite.ready;
    r.render(away, { environment: { hd: true }, personMotion: { sprite: true, opacity: 1 } });
    if (difference(empty, pixels()) > .001) throw new Error('Friend sprite corrupted HD terrain');
    r.dispose();

    for (const format of ['reels', 'post']) {
      const c = new ExportComposer(q, model, { format, environment: { ...environment, foliageDensity: 'heavy', natureDensity: 'light', texture: 'moss', condition: 'snow', wind: 'breeze' }, easterEgg: null });
      c.animated = true; c.drawFrame(0, { preview: true });
      if (c.glCanvas.width > 720) throw new Error('Export preview exceeded its render budget');
      await c.drawFrameReady(4);
      if (c.glCanvas.width !== c.layout.scene.w || !c.renderer.surfaceTextures.loaded || !c.renderer.plantTextures.loaded) throw new Error('Export captured a reduced or incomplete frame');
      if (c.renderer.lastFrame.options.environmentTime !== 4 || c.weather.snow !== 1) throw new Error('Export lost environment clock/settings');
      if (c.renderer.terrainTexture.id !== 'moss') throw new Error('Export lost selected texture');
      if (c.environment.foliageDensity !== 'heavy' || c.environment.natureDensity !== 'light'
        || c.renderer.natureMeshes.foliage.count !== result.densities[2].foliage
        || c.renderer.natureMeshes.nature.count !== result.densities[0].nature) throw new Error('Export lost density settings');
      c.setOptions({ environment: { ...c.environment, texture: 'auto' } }); await c.drawFrameReady(4);
      if (JSON.stringify(c.renderer.terrainTexture) !== JSON.stringify(terrainTexture(q.seed))) throw new Error('Export auto texture differs from the live seed');
      c.setOptions({ environment: { ...c.environment, texture: 'moss' } }); await c.drawFrameReady(4);
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
  assert.equal(audit.texture.styles.length, 10);
  assert.equal(audit.densities.length, 3);
  if (out) for (const density of audit.densities)
    await writeFile(join(out, `density-${density.id}.png`), Buffer.from(density.image.split(',')[1], 'base64'));
  console.log('Independent Light/Moderate/Heavy density, bird counts, deterministic rendering and buffer reuse passed.');
  if (out) for (const style of audit.texture.styles)
    await writeFile(join(out, `texture-${style.id}-${style.hd ? 'hd' : 'standard'}.png`), Buffer.from(style.image.split(',')[1], 'base64'));
  if (out) for (const e of audit.exports) for (const stage of ['question', 'answer']) {
    await writeFile(join(out, `environment-${e.format}-${stage}.png`), Buffer.from(e[stage].split(',')[1], 'base64'));
  }
  console.log('HD materials, weather and full-resolution PNG/video exports passed.');
  // Use a controlled animation clock: CPU shader compilation must not consume
  // the 2.8-second inspect before its second frame. Captures above use native resolution.
  await page.setViewportSize({ width: 640, height: 960 });
  // Ambient weather must not advance a paused run or interrupt knife inspect.
  await page.goto(`${url}/?environment-trail=1#seed=bhop-demo&d=medium&m=trail&k=classic`, { waitUntil: 'domcontentloaded' }); await ready(page, 'WHICH TRAIL DID YOU FOLLOW?'); await instrument(page);
  await page.locator('#trail-scrub').evaluate(el => { el.value = '4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#scene-weather').selectOption('rain');
  await page.waitForFunction(() => window.sceneRenderer?.viewmodel?.hasFrame, null, { timeout: 30000 });
  await page.evaluate(() => window.sceneRenderer.prepareEnvironmentReady({ hd: true, foliage: true, nature: true }));
  const trailCamera = await page.evaluate(() => window.sceneRenderer.lastFrame.camera);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const trailCount = await page.evaluate(() => window.environmentFrames.length);
  await page.waitForFunction(count => window.environmentFrames.length > count + 2, trailCount, { timeout: 90000 });
  assert.equal(await page.locator('#trail-scrub').inputValue(), '4');
  assert.deepEqual(await page.evaluate(() => window.sceneRenderer.lastFrame.camera), trailCamera);
  await page.clock.install();
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 50));
  const inspectStart = await page.evaluate(() => window.environmentFrames.length);
  await page.locator('#trail-inspect').dispatchEvent('click');
  await page.clock.runFor(240);
  assert.ok(await page.evaluate(start => window.environmentFrames.slice(start).some(frame => frame.options.motion.inspectElapsed > .1), inspectStart));
  assert.deepEqual(await page.evaluate(() => window.sceneRenderer.lastFrame.camera), trailCamera);
  assert.equal(await page.evaluate(() => window.sceneRenderer.gl.getError()), 0);
  if (out) await page.screenshot({ path: join(out, 'environment-trail-rain.png') });
  console.log('Paused trails and knife inspect passed.');
  // WebGL 1 fallback and a narrow mobile viewport must also render the settings.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  mobile.on('pageerror', err => errors.push(err.message));
  await mobile.addInitScript(() => {
    const context = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'webgl2' ? null : context.call(this, type, ...args); };
  });
  await mobile.goto(`${url}/#seed=friend-demo&d=easy&m=friend&fa=grid&g=6`); await ready(mobile); await instrument(mobile);
  await mobile.locator('#scene-hd').check(); await mobile.locator('#scene-foliage').check();
  await mobile.locator('#scene-nature').check();
  await mobile.locator('#scene-foliage-density').selectOption('heavy');
  await mobile.locator('#scene-nature-density').selectOption('heavy');
  await mobile.locator('#scene-texture').selectOption('alpine');
  await mobile.locator('#scene-weather').selectOption('rain');
  await mobile.evaluate(() => window.sceneRenderer.prepareEnvironmentReady({ hd: true, foliage: true, nature: true, foliageDensity: 'heavy', natureDensity: 'heavy' }));
  assert.equal(await mobile.locator('#scene-error').isVisible(), false);
  assert.equal(await mobile.evaluate(() => window.sceneRenderer.gl.getError()), 0);
  assert.equal(await mobile.evaluate(() => window.sceneRenderer.terrainTexture.id), 'alpine');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (out) await mobile.screenshot({ path: join(out, 'environment-mobile.png'), fullPage: true });
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log('Environment browser checks passed: independent Light/Moderate/Heavy densities, 5 distinct seeded texture styles in standard/HD, raw-seed replay, live/export selection, 9 animated conditions, gusts, HD detail, foliage/nature, preferences, stable quiz/map, reduced motion, PNG/video, Conquest texture isolation, paused trails/knife inspect, mobile and WebGL 1.');
} finally {
  await browser.close(); server.close();
}
