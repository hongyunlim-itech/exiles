// Screenshot helper for the render-scene sandbox.
// Usage: node dev/render-scene/shoot.mjs name1="t=0.5&m=4.5" name2="t=0.8&snow=1" ...
// Requires `npx vite --port 5201` running from the project root.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'shots');
mkdirSync(outDir, { recursive: true });
const base = process.env.SANDBOX_URL ?? 'http://localhost:5201/dev/render-scene/index.html';
const jobs = process.argv.slice(2).map((a) => {
  const k = a.indexOf('=');
  return { name: a.slice(0, k), query: a.slice(k + 1) };
});

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text().slice(0, 400));
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const job of jobs) {
  const t0 = Date.now();
  await page.goto(`${base}?${job.query}`, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  } catch {
    console.log(`[${job.name}] timed out waiting for __ready`);
  }
  await page.waitForTimeout(300);
  const file = join(outDir, `${job.name}.png`);
  await page.screenshot({ path: file });
  const hud = await page.evaluate(() => document.getElementById('hud')?.textContent ?? '');
  console.log(`[${job.name}] ${Date.now() - t0}ms ${hud} -> ${file}`);
}
await browser.close();
