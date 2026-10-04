// World types in the shipped app: selector, shared links, saved preference and surface texture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORLD_CHOICES, resolveWorld } from '../src/engine/worlds.js';

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
const ready = (page, seed) => page.waitForFunction(seed => document.getElementById('loading').classList.contains('hidden')
  && document.getElementById('credit').textContent.startsWith(`seed ${seed} `), seed, { timeout: 120000 });
// The scene renderer's resolved surface texture, read from the shipped module graph.
const texture = page => page.evaluate(async () => {
  const src = new URL('../', document.querySelector('script[type="module"]').src);
  const { TerrainRenderer } = await import(new URL('render/webglTerrain.js', src));
  if (!window.worldRenderer) {
    const render = TerrainRenderer.prototype.render;
    TerrainRenderer.prototype.render = function(...args) { if (this.canvas.id === 'scene') window.worldRenderer = this; return render.apply(this, args); };
    window.dispatchEvent(new Event('resize'));
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  return window.worldRenderer?.terrainTexture?.id;
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  page.setDefaultNavigationTimeout(90000);
  page.on('pageerror', error => errors.push(error.message));

  await page.goto(`${url}/#seed=world-link&d=easy&w=dunes`, { waitUntil: 'domcontentloaded' });
  await ready(page, 'world-link');
  assert.deepEqual(await page.locator('#world option').evaluateAll(o => o.map(x => x.value)), WORLD_CHOICES);
  assert.equal(await page.locator('#world').inputValue(), 'dunes');
  assert.match(await page.locator('#credit').textContent(), /dunes world/);
  assert.equal(await texture(page), 'desert', 'auto texture follows the dunes surface');
  if (out) await page.locator('.scene-wrap').screenshot({ path: join(out, 'world-dunes.png') });

  // Changing the selector keeps the seed, rebuilds the terrain and updates the shareable link.
  await page.locator('#world').selectOption('glacial');
  await page.waitForFunction(() => location.hash.includes('w=glacial') && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 120000 });
  assert.match(await page.locator('#credit').textContent(), /^seed world-link .*glacial world/);
  assert.equal(await texture(page), 'meadow');

  // Auto shows the world resolved from the seed and shares as w=auto.
  await page.locator('#world').selectOption('auto');
  await page.waitForFunction(() => location.hash.includes('w=auto') && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 120000 });
  const resolved = resolveWorld('auto', 'world-link');
  assert.equal((await page.locator('#credit').textContent()).includes(`${resolved} world`), resolved !== 'classic');

  // Classic is the default: the link carries no world parameter at all.
  await page.locator('#world').selectOption('classic');
  await page.waitForFunction(() => !location.hash.includes('w=') && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 120000 });
  assert.doesNotMatch(await page.locator('#credit').textContent(), /· [a-z]+ world ·/);

  // The selection is remembered for new quizzes, but an old link without w= stays classic.
  await page.locator('#world').selectOption('canyon');
  await page.waitForFunction(() => location.hash.includes('w=canyon') && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 120000 });
  await page.goto(`${url}/#seed=old-link&d=easy`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page, 'old-link');
  assert.equal(await page.locator('#world').inputValue(), 'classic');
  assert.doesNotMatch(await page.locator('#credit').textContent(), /· [a-z]+ world ·/);
  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden') && location.hash.includes('w=canyon'), null, { timeout: 120000 });
  assert.equal(await page.locator('#world').inputValue(), 'canyon');

  assert.deepEqual(errors, []);
  console.log('World browser checks passed: selector, w= links, auto resolution, classic default for old links, remembered choice and world surface textures.');
} finally {
  await browser.close();
  server.close();
}
