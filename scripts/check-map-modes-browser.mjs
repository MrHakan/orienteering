// The six map-reading modes in the shipped app: links, clip player, overlays,
// map answers (route lines are tappable), reveal + explanation, PNG/video export.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/engine/quiz.js';
import { MAP_MODES } from '../src/engine/mapModes.js';

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultNavigationTimeout(90000);
  page.on('pageerror', error => errors.push(error.message));
  for (const mode of Object.keys(MAP_MODES)) {
    const q = await generate({ seed: `mm-${mode}`, difficulty: 'medium', mode });
    await page.goto(`${url}/#seed=mm-${mode}&d=medium&m=${mode}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(title => document.getElementById('loading').classList.contains('hidden') && document.getElementById('quiz-title').textContent === title,
      MAP_MODES[mode].title, { timeout: 120000 });
    assert.equal(await page.locator('#mode').inputValue(), mode);
    assert.equal(await page.locator('#direction-tools').isHidden(), false, `${mode}: 15 s clip player`);
    assert.equal(await page.locator('#scramble').isHidden(), true);
    assert.deepEqual(await page.locator('#answers .answer').evaluateAll(b => b.map(x => x.dataset.label)), q.options.map(o => o.label));
    await page.locator('#direction-scrub').evaluate(el => { el.value = '6'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(300);
    if (mode === 'profile') {
      // The four charts cover the scene.
      const cover = await page.locator('#tape').evaluate(c => c.getContext('2d').getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data[3]);
      assert.ok(cover >= 200, `charts cover the scene (${cover})`);
    }
    if (out) await page.locator('.layout').screenshot({ path: join(out, `map-mode-${mode}.png`) });
    await page.keyboard.press(q.correctLabel);
    await page.waitForSelector('#mode-replay');
    assert.match(await page.locator('#result').innerText(), /Correct — the answer is/);
    assert.ok((await page.locator('.answer-explanation').innerText()).length > 60, `${mode}: explanation`);
    assert.match(new URL(page.url()).hash, new RegExp(`m=${mode}`));
  }
  // Exports through the shipped composer: question PNG and a short clip for two modes.
  for (const mode of ['resection', 'profile']) {
    const q = await generate({ seed: `mm-${mode}`, difficulty: 'medium', mode });
    const exported = await page.evaluate(async (quiz) => {
      const src = new URL('../', document.querySelector('script[type="module"]').src);
      const { ExportComposer } = await import(new URL('export/composer.js', src));
      const { TerrainModel } = await import(new URL('engine/terrainModel.js', src));
      const { encodeCanvasVideo } = await import(new URL('export/recorder.js', src));
      const model = new TerrainModel({ ...quiz.terrain, heights: new Float32Array(quiz.terrain.heights), seed: quiz.terrain.modelSeed });
      const c = new ExportComposer({ ...quiz, terrain: { ...quiz.terrain, heights: model.heights } }, model, { format: 'reels', easterEgg: null });
      const blob = await c.toImage({ time: 6 });
      const png = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
      c.animated = true;
      const clip = await encodeCanvasVideo(c.canvas, t => c.drawFrameReady(t * 10), { duration: .3, fps: 10 });
      c.dispose();
      return { png, video: clip.blob.size };
    }, { ...q, terrain: { ...q.terrain, heights: Array.from(q.terrain.heights) } });
    assert.ok(exported.video > 1000);
    if (out) await writeFile(join(out, `map-mode-export-${mode}.png`), Buffer.from(exported.png.split(',')[1], 'base64'));
  }
  assert.deepEqual(errors, []);
  console.log('Map-reading mode browser checks passed: resection, route choice, intervisibility, profile charts, drainage and fog — links, clip player, reveal, explanations and PNG/video exports.');
} finally {
  await browser.close();
  server.close();
}
