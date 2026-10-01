// Boot the real game on the dev server and screenshot it (not shipped). Usage: node game.mjs <outDir> [seconds]
import { chromium } from 'playwright';
const outDir = process.argv[2];
const secs = Number(process.argv[3] ?? 20);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 400)}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5203/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => !!window.__app, null, { timeout: 120000 }).catch(() => {});
const ok = await page.evaluate(() => !!window.__app);
console.log('app?', ok);
if (ok) {
  await page.evaluate(() => { window.__app.closeMenu(); window.__app.updateSettings({ quality: 'medium' }); window.__app.setSpeed(10); });
  await page.waitForTimeout(secs * 1000);
  const info = await page.evaluate(() => {
    const a = window.__app; const s = a.game.state;
    return { year: s.time.year, month: s.time.month, citizens: s.citizens.length, buildings: s.buildings.length, animals: s.animals.length,
      acts: s.citizens.slice(0, 12).map((c) => `${c.profession}:${c.activity}:${c.moving}`) };
  });
  console.log(JSON.stringify(info));
  await page.evaluate(() => { window.__app.setSpeed(1); window.__app.game.state.time.dayTime = 0.45; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/game.png`, timeout: 180000 });
  // close-up on the first citizen
  await page.evaluate(() => {
    const a = window.__app; a.closeMenu();
    const cs = a.game.state.citizens.filter((c) => c.moving || c.activity !== 'idle');
    const c = cs[0] ?? a.game.state.citizens[0];
    a.game.state.time.dayTime = 0.45;
    if (c) a.renderer.cameraController.focusOn(c.x, c.z, 14);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${outDir}/game_close.png`, timeout: 180000 });
}
for (const e of errors.slice(0, 30)) console.log(e);
await browser.close();
