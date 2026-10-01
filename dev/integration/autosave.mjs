// Autosave at the new year + "Continue" from the title screen after a page reload.
// Usage: node dev/integration/autosave.mjs <outDir> [port]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '.';
const port = process.argv[3] ?? '5210';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.setDefaultTimeout(300000);
const logs = [];
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`console.${m.type()}: ${m.text()}`); });
await page.goto(`http://localhost:${port}/`);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('exiles.settings', JSON.stringify({ quality: 'low', shadows: false })); });
await page.reload();
await page.waitForFunction(() => !!window.__app);
await page.evaluate(() => window.__app.newGame({ seed: 31337, townName: 'Savetown', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: false }));
await page.waitForFunction(() => !window.__app.inMenu);
// jump to the last seconds of the year, then let the real loop cross the new year
const r = await page.evaluate(async () => {
  const app = window.__app;
  const g = app.game;
  app.setSpeed(0);
  while (g.state.time.elapsed < 720 - 3) { for (let k = 0; k < 200 && g.state.time.elapsed < 717; k++) g.step(0.25); await new Promise((res) => setTimeout(res, 0)); }
  app.setSpeed(10);
  const t0 = performance.now();
  while (g.state.time.year < 2 && performance.now() - t0 < 60000) await new Promise((res) => setTimeout(res, 100));
  app.setSpeed(0);
  return { year: g.state.time.year, saves: app.listSaves(), pop: g.state.citizens.length, elapsed: g.state.time.elapsed };
});
console.log('after new year', JSON.stringify(r));
const ok1 = r.saves.some((s) => s.slot === 'autosave');
console.log(ok1 ? 'PASS autosave written at new year' : 'FAIL no autosave');
await page.reload();
await page.waitForFunction(() => !!window.__app);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, 'a01_title_continue.png') });
const cont = page.locator('.menu-btn', { hasText: 'Continue' });
const visible = await cont.isVisible().catch(() => false);
console.log(visible ? 'PASS Continue visible on title' : 'FAIL Continue not visible');
if (visible) {
  await cont.click();
  await page.waitForFunction(() => !window.__app.inMenu, null, { timeout: 30000 });
  const s = await page.evaluate(() => ({ town: window.__app.game.state.settings.townName, year: window.__app.game.state.time.year, pop: window.__app.game.state.citizens.length }));
  console.log(s.town === 'Savetown' && s.year === 2 ? 'PASS Continue loaded the autosave' : 'FAIL wrong game loaded', JSON.stringify(s));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, 'a02_continued.png') });
}
console.log('==== console errors/warnings (' + logs.length + ') ====');
console.log([...new Set(logs)].slice(0, 20).join(String.fromCharCode(10)));
await browser.close();
