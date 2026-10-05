// Daily challenge, friend challenges and 10-question runs in the shipped app.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/engine/quiz.js';
import { dailyPlan, encodeChallenge, runPlan } from '../src/ui/play.js';

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
const ready = (page, test) => page.waitForFunction(test, null, { timeout: 120000 });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);
  page.on('pageerror', error => errors.push(error.message));

  // Daily: same question for everyone; one attempt; share card; reopening shows the result.
  const plan = dailyPlan('2026-10-05'), dq = await generate({ seed: plan.seed, mode: plan.mode, difficulty: plan.difficulty, world: plan.world });
  await page.goto(`${url}/#daily=2026-10-05`, { waitUntil: 'domcontentloaded' });
  await ready(page, () => document.getElementById('loading').classList.contains('hidden') && document.getElementById('play-banner').textContent.startsWith('DAILY'));
  assert.equal(await page.locator('#play-banner').textContent(), `DAILY #${plan.number} · 2026-10-05 · ${plan.difficulty.toUpperCase()} · ONE ATTEMPT`);
  assert.equal(new URL(page.url()).hash, '#daily=2026-10-05');
  assert.deepEqual(await page.locator('#answers .answer').evaluateAll(b => b.map(x => x.dataset.label)), dq.options.map(o => o.label));
  const before = Number(await page.locator('#score-total').textContent());
  await page.locator(`#answers [data-label="${dq.correctLabel}"]`).click();
  await page.waitForSelector('#play-share');
  assert.match(await page.locator('#play-extra').innerText(), /🟩 \d+ s/);
  await page.locator('#play-share').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), new RegExp(`Terrain Quiz Daily #${plan.number} · .*\\n🟩 \\d+ s\\n.*#daily=2026-10-05`));
  if (out) await page.locator('.layout').screenshot({ path: join(out, 'play-daily.png') });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page, () => document.getElementById('play-extra')?.textContent.includes('already played'));
  assert.equal(Number(await page.locator('#score-total').textContent()), before + 1, 'a replay is not scored again');

  // Challenge: the link carries a time and a result, never the answer; the reply compares.
  const cq = await generate({ seed: 'challenge-me', mode: 'where-am-i', difficulty: 'easy' });
  const token = encodeChallenge({ name: 'Ayşe', correct: true, seconds: 41 });
  await page.goto(`${url}/#seed=challenge-me&d=easy&ch=${token}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page, () => document.getElementById('loading').classList.contains('hidden') && document.getElementById('play-banner').textContent.includes('Ayşe'));
  assert.match(await page.locator('#play-banner').textContent(), /Ayşe got this right in 41 s — your turn/);
  await page.locator(`#answers [data-label="${cq.correctLabel}"]`).click();
  await page.waitForSelector('#challenge-copy');
  assert.match(await page.locator('#play-extra').innerText(), /You win[\s\S]*Ayşe: ✓ 41 s/);
  await page.locator('#challenge-name').fill('Hakan');
  await page.locator('#challenge-copy').click();
  const link = (await page.evaluate(() => navigator.clipboard.readText())).split('\n').pop();
  const ch = new URL(link).hash.match(/ch=([^&]+)/)[1];
  assert.ok(!link.includes(cq.correctLabel + '&') && !/[&#]a=/.test(link), 'no answer in the link');
  const reply = await page.evaluate(async (t) => { const src = new URL('../', document.querySelector('script[type="module"]').src);
    return (await import(new URL('ui/play.js', src))).decodeChallenge(t); }, ch);
  assert.equal(reply.name, 'Hakan'); assert.equal(reply.correct, true);

  // Run: ten questions; points and progress in the banner; N moves on.
  await page.locator('#run-start').click();
  await ready(page, () => document.getElementById('loading').classList.contains('hidden') && document.getElementById('play-banner').textContent.startsWith('RUN 1/10'));
  const label = await page.locator('#answers .answer').first().getAttribute('data-label');
  await page.locator(`#answers [data-label="${label}"]`).click();
  await page.waitForSelector('#play-extra');
  assert.match(await page.locator('#play-extra').innerText(), /\+\d+ pts · \d+ total/);
  await page.keyboard.press('n');
  await ready(page, () => document.getElementById('loading').classList.contains('hidden') && document.getElementById('play-banner').textContent.startsWith('RUN 2/10'));
  void runPlan;
  assert.deepEqual(errors, []);
  console.log('Play browser checks passed: daily challenge (banner, one attempt, share card, replay), friend challenge links (result only, comparison, send back) and 10-question runs.');
} finally {
  await browser.close();
  server.close();
}
