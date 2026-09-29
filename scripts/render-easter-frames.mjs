// Renders sample export frames for an Easter egg preview and audits them:
//   - the first and last frames must be pixel-identical to the ordinary render;
//   - the layer must change no pixel inside protected content (title, tape,
//     countdown bar, map and markers, caption/handle);
//   - May the Fourth must change no terrain pixel (below the computed skyline).
// Exits non-zero if any check fails.
//
//   node scripts/render-easter-frames.mjs <outDir> <easterEgg> [easterDate] [seed]
//   e.g. node scripts/render-easter-frames.mjs /tmp/frames may4
//        node scripts/render-easter-frames.mjs /tmp/frames winter 2026-12-24
// Env: FORMAT=post for 4:5, REDUCED=1 for the reduced-motion version.
//
// Needs Playwright (not a project dependency): set PLAYWRIGHT_MODULE to its
// index.js if `import('playwright')` does not resolve. Serves the repo itself.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const [outDir, egg = 'may4', date = '', seed = 'eg1'] = process.argv.slice(2);
if (!outDir) { console.error('usage: render-easter-frames.mjs <outDir> <winter|santa|may4> [date] [seed]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const pw = (await import(process.env.PLAYWRIGHT_MODULE || 'playwright')).default;
const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try { res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' }); res.end(await readFile(join(root, p))); }
  catch { res.writeHead(404).end(); }
}).listen(0);
const port = server.address().port;

const times = egg === 'may4'
  ? { start: 0.4, patrol: 4.2, mid: 7.5, charge: 10.2, explosion: 11.12, blast: 11.6, flyaway: 12.6, late: 13.8, end: 449 / 30 }
  : { start: 0.4, mid: 7.5, entering: 10.5, flyby: 12.2, leaving: 13.7, end: 449 / 30 };

const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 700, height: 1100 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
const qs = new URLSearchParams({ easterEgg: egg, seed, ...(date ? { easterDate: date } : {}), ...(process.env.REDUCED ? { reducedMotion: '1' } : {}), ...(process.env.FORMAT ? { format: process.env.FORMAT } : {}) });
await page.goto(`http://localhost:${port}/scripts/easter-harness.html?${qs}`);
await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });

const tag = `${egg}${process.env.REDUCED ? '-reduced' : ''}${process.env.FORMAT ? `-${process.env.FORMAT}` : ''}`;
const save = (name, url) => writeFileSync(join(outDir, `${tag}-${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
for (const [name, t] of Object.entries(times)) save(name, await page.evaluate((t) => window.harness.frame(t), t));

// The first and last frames must be pixel-identical to the frame without the layer.
const same = await page.evaluate(([a, b]) => [a, b].map((t) => window.harness.frame(t) === window.harness.frame(t, { egg: false })), [0, times.end]);
// Pixel audit of what the layer itself changes.
let violations = 0;
for (const [name, t] of Object.entries(times)) {
  const a = await page.evaluate((t) => Promise.resolve(window.harness.audit(t)), t);
  const prot = Object.values(a.protectedRects).reduce((x, y) => x + y, 0);
  const terrainBad = egg === 'may4' && a.terrain > 0;
  if (prot || terrainBad) violations++;
  console.log(`${name.padEnd(10)} t=${t.toFixed(2)}  changed=${String(a.changed).padStart(6)}  protected=${prot}  terrain=${a.terrain} (${(100 * a.terrain / a.terrainPixels).toFixed(2)}%)  ${prot || terrainBad ? 'VIOLATION ' + JSON.stringify(a.protectedRects) : 'ok'}`);
}
console.log(JSON.stringify({ plan: await page.evaluate(() => window.harness.plan), firstFrameClean: same[0], lastFrameClean: same[1], violations }));
await browser.close();
server.close();
process.exit(same[0] && same[1] && !violations ? 0 : 1);
