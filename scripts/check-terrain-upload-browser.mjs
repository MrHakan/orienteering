// Uploading a real elevation file: every mode plays on it, it survives a reload and can be removed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const N = 360;
let asc = `ncols ${N}\nnrows ${N}\nxllcorner 0\nyllcorner 0\ncellsize 8\nNODATA_value -9999\n`;
for (let r = 0; r < N; r++) asc += Array.from({ length: N }, (_, c) => { const x = c * 8, y = (N - 1 - r) * 8;
  return (90 + 70 * Math.exp(-((x - 1400) ** 2 + (y - 1500) ** 2) / 250000) + 25 * Math.sin(y / 230) + 18 * Math.cos(x / 160)).toFixed(1); }).join(' ') + '\n';
const loaded = (page) => page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden') && document.getElementById('credit').textContent.includes('uploaded map'), null, { timeout: 120000 });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultNavigationTimeout(90000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/#seed=up1&d=medium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 120000 });
  await page.locator('#dem-file').setInputFiles({ name: 'my-hills.asc', mimeType: 'text/plain', buffer: Buffer.from(asc) });
  await loaded(page);
  assert.equal(await page.locator('#world').inputValue(), 'custom');
  assert.match(await page.locator('#dem-status').textContent(), /my-hills · ESRI ASCII grid · 2\.0 km × 2\.0 km/);
  if (out) await page.locator('.layout').screenshot({ path: join(out, 'terrain-upload.png') });
  // Other modes on the same uploaded ground.
  for (const mode of ['route', 'sniper']) {
    await page.locator('#mode').selectOption(mode);
    await loaded(page);
    assert.equal(await page.locator('#mode').inputValue(), mode);
  }
  // Survives a reload; removing it returns to Classic.
  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await loaded(page);
  await page.locator('#dem-remove').click();
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden') && !document.getElementById('credit').textContent.includes('uploaded'), null, { timeout: 120000 });
  assert.equal(await page.locator('#world option[value="custom"]').count(), 0);
  // A broken file explains itself instead of breaking the page.
  await page.locator('#dem-file').setInputFiles({ name: 'oops.asc', mimeType: 'text/plain', buffer: Buffer.from('not a grid') });
  await page.waitForFunction(() => document.getElementById('dem-status').textContent.startsWith('Could not use oops.asc'));
  assert.deepEqual(errors, []);
  console.log('Terrain upload browser checks passed: ASCII grid import, play in several modes, persistence across reloads, removal and error messages.');
} finally {
  await browser.close();
  server.close();
}
