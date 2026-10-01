// Headless browser smoke check for the simulation inside the real app (sim-core dev tool).
// Usage: start `npx vite --port 5188 --strictPort` then `node dev/sim-core/browser-check.mjs`.
import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://localhost:5188/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));
await page.goto(url);
await page.waitForTimeout(4000);
const boot = await page.evaluate(() => {
  const app = window.__app;
  if (!app) return { ok: false };
  app.newGame({ seed: 4242, townName: 'Check', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: true });
  app.setSpeed(10);
  return { ok: true };
});
console.log('boot', boot);
const samples = [];
for (let k = 0; k < 6; k++) {
  await page.waitForTimeout(5000);
  samples.push(await page.evaluate(() => {
    const g = window.__app.game;
    const s = g.state;
    const errs = g.moduleErrors ? g.moduleErrors() : {};
    return { t: Math.round(s.time.elapsed), y: s.time.year, m: s.time.month, pop: s.citizens.length, food: Math.round(g.foodTotal()), errs, acts: s.citizens.slice(0, 6).map((c) => c.activity + ':' + c.taskLabel) };
  }));
}
for (const x of samples) console.log(JSON.stringify(x));
console.log('console errors:', errors.length);
for (const e of errors.slice(0, 15)) console.log('  ', e);
await page.screenshot({ path: 'dev/sim-core/browser-check.png' });
await browser.close();
