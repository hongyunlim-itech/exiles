// Long play in the real app: the scripted bot (tests/simcore.bot.ts, served by the Vite dev server) builds a town
// for N years (headless stepping inside the page), then screenshots the town and every window.
// Usage: node dev/integration/longplay.mjs <outDir> [port] [years] [width] [height]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '.';
const port = process.argv[3] ?? '5210';
const years = Number(process.argv[4] ?? 3);
const width = Number(process.argv[5] ?? 1280);
const height = Number(process.argv[6] ?? 720);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width, height } });
page.setDefaultTimeout(900000);
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('exiles.settings', JSON.stringify({ quality: 'high', shadows: true, showFps: true })); } catch { /* */ } });
const logs = [];
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + ' ' + (e.stack ?? '').split('\n')[1]));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`console.${m.type()}: ${m.text()}`); });
const shot = async (n) => { await page.screenshot({ path: path.join(out, n + '.png') }); console.log('shot', n); };
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => !!window.__app);
await page.evaluate(() => window.__app.newGame({ seed: 101, townName: 'Longmere', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: true }));
await page.waitForFunction(() => !window.__app.inMenu);
await page.evaluate(() => window.__app.setSpeed(0));
const t0 = Date.now();
const res = await page.evaluate(async (yrs) => {
  const { Bot } = await import('/tests/simcore.bot.ts');
  const app = window.__app;
  const g = app.game;
  const bot = new Bot(g);
  const end = g.state.time.elapsed + yrs * 720;
  let frames = 0;
  while (g.state.time.elapsed < end && !g.state.gameOver) {
    for (let k = 0; k < 240; k++) { g.step(0.25); bot.tick(); }
    frames++;
    await new Promise((r) => setTimeout(r, 0));
  }
  const p = g.populationSummary();
  return { pop: p, buildings: g.state.buildings.length, active: g.state.buildings.filter((b) => b.state === 'active').length, errors: g.moduleErrors(), invariants: g.validate().slice(0, 5), placed: bot.placed.join(','), history: g.state.history.length };
}, years);
console.log('simulated in', Date.now() - t0, 'ms', JSON.stringify(res));
await page.evaluate(() => { const app = window.__app; app.game.state.time.dayTime = 0.45; app.setSpeed(1); app.renderer.focusTown(true); });
await page.waitForTimeout(2500);
await shot('l01_town');
await page.evaluate(() => { const cc = window.__app.renderer.cameraController; cc.goal.pitch = 0.5; cc.goal.yaw = 2.2; const c = window.__app.game.townCenter(); cc.jumpTo(c.x, c.z, 60); });
await page.waitForTimeout(1500);
await shot('l02_town_wide');
const perf = await page.evaluate(async () => {
  // measure sim + render cost per frame (CPU side) for 60 frames at 10x
  const app = window.__app;
  app.setSpeed(10);
  const t = [];
  for (let i = 0; i < 60; i++) {
    const a = performance.now();
    await new Promise((r) => requestAnimationFrame(r));
    t.push(performance.now() - a);
  }
  const g = app.game;
  g.profile = {};
  const a = performance.now();
  for (let i = 0; i < 40; i++) g.step(0.25);
  const simMs = (performance.now() - a) / 40;
  const prof = g.profile; g.profile = null;
  app.setSpeed(0);
  t.sort((x, y) => x - y);
  return { frameMsMedian: t[30], frameMsP90: t[54], simStepMs: simMs, prof, render: app.renderer.stats() };
});
console.log('perf', JSON.stringify(perf));
for (const key of ['p', 'o', 'n', 'l', 'k']) {
  await page.mouse.move(width / 2, height / 2);
  await page.keyboard.press(key);
  await page.waitForTimeout(700);
  await shot(`l1_${key}`);
  await page.keyboard.press(key);
}
// select a busy building and a citizen
await page.evaluate(() => { const app = window.__app; const b = app.game.state.buildings.find((x) => x.type === 'cropField' && x.state === 'active') ?? app.game.state.buildings[0]; app.select({ kind: 'building', id: b.id }); app.focusOn(b.x + b.w / 2, b.z + b.h / 2); });
await page.waitForTimeout(1200);
await shot('l20_field_panel');
await page.evaluate(() => { const app = window.__app; const c = app.game.state.citizens.find((x) => x.profession === 'gatherer') ?? app.game.state.citizens[0]; app.select({ kind: 'citizen', id: c.id }); app.focusOn(c.x, c.z); });
await page.waitForTimeout(1200);
await shot('l21_citizen_panel');
console.log('==== console errors/warnings (' + logs.length + ') ====');
console.log([...new Set(logs)].slice(0, 30).join(String.fromCharCode(10)));
await browser.close();
