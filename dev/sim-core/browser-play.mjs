// Headless browser check: new game, place a starter town through the Game API, run at 10x and report errors.
// Usage: `npx vite --port 5188 --strictPort` then `node dev/sim-core/browser-play.mjs`.
import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://localhost:5188/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));
await page.goto(url);
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(3000);
const placed = await page.evaluate(() => {
  const app = window.__app;
  app.newGame({ seed: 777, townName: 'Play', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: true });
  const g = app.game;
  const c = g.townCenter();
  const out = [];
  const tryPlace = (type, w, h) => {
    for (let r = 4; r < 30; r += 2) {
      for (let a = 0; a < 16; a++) {
        const x = Math.round(c.x + Math.cos(a / 16 * Math.PI * 2) * r);
        const z = Math.round(c.z + Math.sin(a / 16 * Math.PI * 2) * r);
        const b = g.placeBuilding(type, x, z, 0, w, h);
        if (b) { out.push(type); return b; }
      }
    }
    return null;
  };
  tryPlace('woodenHouse'); tryPlace('woodenHouse'); tryPlace('gathererHut'); tryPlace('woodcutter');
  tryPlace('cropField', 8, 8); tryPlace('well');
  app.setSpeed(10);
  return out;
});
console.log('placed', placed);
for (let k = 0; k < 8; k++) {
  await page.waitForTimeout(5000);
  console.log(JSON.stringify(await page.evaluate(() => {
    const g = window.__app.game; const s = g.state;
    return { t: Math.round(s.time.elapsed), pop: s.citizens.length, food: Math.round(g.foodTotal()), states: s.buildings.map((b) => b.type[0] + b.type[1] + ':' + b.state[0]).join(' '), errs: g.moduleErrors() };
  })));
}
console.log('console errors:', errors.length);
for (const e of errors.slice(0, 15)) console.log('  ', e);
await page.screenshot({ path: 'dev/sim-core/browser-play.png' });
await browser.close();
