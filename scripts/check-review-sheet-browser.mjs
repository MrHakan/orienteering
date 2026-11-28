// Optional Playwright check: the review sheet export (data-review="1" on #export-png) for friend and resection
// (default moments and data-review-times="1,14"),
// and the unchanged single question still without it. usage:
// PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... node scripts/check-review-sheet-browser.mjs [outdir]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2];
if (out) await mkdir(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  try { const body = await readFile(join(root, path)); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404).end(); }
}).listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const browser = await chromium.launch({ ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], url = `http://localhost:${server.address().port}`;
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

async function questionPng(hash, review, times = null) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}/#${hash}`);
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 120000 });
  assert.equal(await page.evaluate(() => document.getElementById('export-png').dataset.reviewSheet), '2', 'feature flag');
  for (let i = 0; ; i++) {
    await page.click('#open-export');
    if (await page.waitForFunction(() => document.getElementById('export-dialog').open, null, { timeout: 5000 }).then(() => true, () => false)) break;
    if (i >= 30) throw new Error('export dialog never opened');
  }
  await page.check('input[name=format][value=reels]');
  await page.uncheck('#export-reveal');
  if (review) await page.evaluate((t) => { const b = document.getElementById('export-png'); b.dataset.review = '1'; if (t) b.dataset.reviewTimes = t; }, times);
  await page.waitForFunction(() => !document.querySelector('#export-png').disabled, null, { timeout: 60000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export-png')]);
  const buf = await readFile(await dl.path());
  await page.close();
  return buf;
}

try {
  const cases = [
    ['friend', 'seed=tg-2026-11-27-1d&d=master&m=friend&fa=grid&g=8', 1],
    ['resection', 'seed=tg-2026-11-28-2a&d=master&m=resection&ra=grid&g=8', 1],
    ['grid', 'seed=tg-2026-11-29-1f&d=master&m=grid&g=8&w=glacial', 0],
  ];
  for (const [name, hash, strips] of cases) {
    const sheet = await questionPng(hash, true), still = await questionPng(hash, false);
    assert.deepEqual(pngSize(still), { width: 1080, height: 1920 }, `${name}: the plain question still is unchanged`);
    assert.deepEqual(pngSize(sheet), { width: 1080, height: 1920 + strips * (56 + 625) }, `${name}: sheet with ${strips} strip(s)`);
    if (out) { await writeFile(join(out, `${name}-sheet.png`), sheet); await writeFile(join(out, `${name}-still.png`), still); }
    console.log(`${name}: still 1080x1920, sheet ${pngSize(sheet).width}x${pngSize(sheet).height}`);
  }
  // Runtime-chosen moments: resection at 1 s (top still, P1) and 14 s (strip, P2).
  const timed = await questionPng('seed=tg-2026-11-28-2a&d=master&m=resection&ra=grid&g=8', true, '1,14');
  assert.deepEqual(pngSize(timed), { width: 1080, height: 1920 + 56 + 625 }, 'resection 1,14: one strip');
  if (out) await writeFile(join(out, 'resection-1-14-sheet.png'), timed);
  console.log(`resection 1,14: sheet ${pngSize(timed).width}x${pngSize(timed).height}`);
  assert.deepEqual(errors, []);
  console.log('review sheet browser check passed');
} finally {
  await browser.close();
  server.close();
}
