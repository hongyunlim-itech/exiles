// Real-app placement check: finds a valid house spot via the real Game.checkPlacement, clicks it and verifies the
// building appears, the tool stays active and a repeat click is ignored. Serve with dev/input/vite.sandbox.config.mjs.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('[vite]')) problems.push(m.text().slice(0, 300)); });
await page.goto('http://localhost:5205/index.html');
await page.waitForFunction(() => window.__app, null, { timeout: 90000 });
await page.evaluate(() => { const a = window.__app; a.newGame({ seed: 4242, townName: 'P', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false }); a.setSpeed(0); a.updateSettings({ quality: 'low', shadows: false }); a.setTool({ kind: 'build', type: 'woodenHouse' }); });
await page.waitForTimeout(1500);
// find a valid 3x3 spot near the camera target whose centre projects on screen
const spot = await page.evaluate(() => {
  const app = window.__app; const g = app.game; const cc = app.renderer.cameraController;
  for (let r = 3; r < 20; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const x = Math.floor(cc.target.x) + dx; const z = Math.floor(cc.target.z) + dz;
    const c = g.checkPlacement('woodenHouse', x - 1, z - 1, 0);
    if (c.ok && c.clearing.length === 0) {
      const s = g.state; const h = s.tiles.height[z * (s.W + 1) + x];
      const p = app.renderer.worldToScreen(x + 0.5, h, z + 0.5);
      if (p.visible && p.x > 50 && p.y > 80 && p.x < 950 && p.y < 520) return { x, z, sx: p.x, sy: p.y };
    }
  }
  return null;
});
console.log('spot', JSON.stringify(spot));
await page.mouse.move(spot.sx, spot.sy, { steps: 3 });
await page.waitForTimeout(400);
const n0 = await page.evaluate(() => window.__app.game.state.buildings.length);
await page.mouse.click(spot.sx, spot.sy);
await page.waitForTimeout(300);
const res = await page.evaluate(() => { const b = window.__app.game.state.buildings.at(-1); return { n: window.__app.game.state.buildings.length, last: b && `${b.type}@${b.x},${b.z} rot${b.rotation} ${b.state}`, tool: window.__app.input.tool }; });
console.log('before', n0, 'after', JSON.stringify(res));
// same spot again → should fail with a toast (blocked) but tool stays active
await page.mouse.click(spot.sx, spot.sy);
await page.waitForTimeout(700);
await page.mouse.move(spot.sx + 200, spot.sy, { steps: 3 });
await page.mouse.click(spot.sx + 200, spot.sy);
await page.waitForTimeout(300);
console.log('after 2nd/3rd click', await page.evaluate(() => window.__app.game.state.buildings.length));
// demolish the first house via tool + confirm dialog (accept via UI's confirm button if present)
console.log('problems:', problems.length ? problems.join('\n') : 'none');
await browser.close();
