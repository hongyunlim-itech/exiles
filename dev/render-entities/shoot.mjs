// Screenshot the render-entities sandbox with headless Chromium (SwiftShader).
// Usage: node dev/render-entities/shoot.mjs <outDir> [name=query ...]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? 'shots';
fs.mkdirSync(outDir, { recursive: true });
const custom = process.argv.slice(3).map((a) => {
  const i = a.indexOf('=');
  return { name: a.slice(0, i), q: a.slice(i + 1) };
});
const shots = custom.length ? custom : [
  { name: 'spring', q: 'month=1&cam=overview' },
  { name: 'summer', q: 'month=4&cam=overview' },
  { name: 'autumn', q: 'month=7&cam=overview' },
  { name: 'winter', q: 'month=10&cam=overview&weather=snow' },
];
const base = process.env.SANDBOX_URL ?? 'http://localhost:5203/dev/render-entities/index.html';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const logs = [];
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${s.name}][${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[${s.name}][pageerror] ${e.message}`));
  const t0 = Date.now();
  await page.goto(`${base}?shot=1&${s.q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  await page.waitForTimeout(Number(process.env.WAIT ?? 1500));
  const file = path.join(outDir, `${s.name}.png`);
  await page.screenshot({ path: file });
  const stats = await page.evaluate(() => window.__stats && window.__stats());
  console.log(`${s.name}: ${file} (${Date.now() - t0} ms) ${JSON.stringify(stats)}`);
  await page.close();
}
for (const l of logs.slice(0, 40)) console.log(l);
await browser.close();
