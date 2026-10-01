// Headless screenshots of the render-models sandbox.
// Usage: node dev/render-models/shot.mjs <outDir> [view[,snow,day]] ...
//   e.g. node dev/render-models/shot.mjs ./shots overview grid1 "focus:woodenHouse:30:30" "grid1@snow=1" "stages@day=0.1"
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? 'shots';
const views = process.argv.slice(3);
const base = process.env.SANDBOX_URL ?? 'http://localhost:5202/dev/render-models/index.html';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(base + (process.env.SANDBOX_QUERY ?? ''), { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
for (const spec of views.length ? views : ['overview']) {
  const [view, opts] = spec.split('@');
  const o = Object.fromEntries((opts ?? '').split('&').filter(Boolean).map((kv) => kv.split('=')));
  await page.evaluate(({ view, o }) => {
    const s = window.__sandbox;
    s.setSnow(Number(o.snow ?? 0));
    s.setDaylight(Number(o.day ?? 1));
    s.highlight(o.hl ?? null);
    if (o.arrive && s.setArrive) s.setArrive(Number(o.arrive));
    if (o.fire) s.setFire(o.fire.split(':')[0], Number(o.fire.split(':')[1]));
    if (!s.view(view)) throw new Error('unknown view ' + view);
  }, { view, o });
  await page.waitForTimeout(Number(o.wait ?? 700));
  const file = path.join(outDir, spec.replace(/[^a-z0-9._=-]+/gi, '_') + '.png');
  const dataUrl = await page.evaluate(() => (window.__sandbox.capture ? window.__sandbox.capture() : null));
  if (dataUrl) fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  else await page.screenshot({ path: file, timeout: 300000 });
  const info = await page.evaluate(() => window.__sandbox.info());
  console.log(file, JSON.stringify(info));
}
const errs = logs.filter((l) => /error|warn/i.test(l));
if (errs.length) console.log(errs.slice(0, 30).join('\n'));
await browser.close();
