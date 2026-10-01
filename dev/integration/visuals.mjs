// Visual check: growing fire (day/night), merchant boat, trade dialog vs toasts, roof snow.
// Usage: node dev/integration/visuals.mjs <outDir> [port]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '.';
const port = process.argv[3] ?? '5210';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('exiles.settings', JSON.stringify({ quality: 'high', shadows: true })); } catch { /* */ } });
const logs = [];
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + ' ' + (e.stack ?? '').split('\n')[1]));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`console.${m.type()}: ${m.text()}`); });
const shot = async (n) => { await page.screenshot({ path: path.join(out, n + '.png') }); console.log('shot', n); };
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => !!window.__app);
await page.evaluate(() => window.__app.newGame({ seed: 4242, townName: 'Eventide', mapSize: 'medium', terrain: 'lakes', climate: 'fair', difficulty: 'easy', disasters: false }));
await page.waitForFunction(() => !window.__app.inMenu);
await page.evaluate(() => window.__app.setSpeed(0));

// helpers in page
await page.evaluate(() => {
  const app = window.__app;
  window.__complete = (b) => {
    const g = app.game;
    b.state = 'active'; b.progress = 1; b.delivered = { ...b.cost }; b.incoming = {}; b.workRemaining = 0; b.builtAt = g.state.time.elapsed;
    for (let zz = b.z; zz < b.z + b.h; zz++) for (let xx = b.x; xx < b.x + b.w; xx++) { const i = zz * g.state.W + xx; if (g.state.tiles.feature[i]) g.removeFeature(i); }
    g.state.rev.buildings++; g.rt.dirty = true;
    g.events.emit('buildingCompleted', { id: b.id });
  };
  window.__placeNear = (type, opts = {}) => {
    const g = app.game; const c = g.townCenter(); const maxR = opts.maxR ?? 30;
    let best = null; let bs = -1e9;
    for (let dz = -maxR; dz <= maxR; dz += 1) for (let dx = -maxR; dx <= maxR; dx += 1) {
      const d = Math.hypot(dx, dz); if (d > maxR) continue;
      for (const rot of (opts.w ? [0] : [0, 1, 2, 3])) {
        const x = Math.round(c.x + dx - 1); const z = Math.round(c.z + dz - 1);
        const chk = g.checkPlacement(type, x, z, rot, opts.w, opts.h);
        if (!chk.ok || !g.isWalkableXZ(chk.doorX, chk.doorZ)) continue;
        const sc = -d - chk.clearing.length * 2;
        if (sc > bs) { bs = sc; best = { x, z, rot }; }
      }
    }
    if (!best) return null;
    return g.placeBuilding(type, best.x, best.z, best.rot, opts.w, opts.h);
  };
  window.__fast = async (seconds) => {
    const g = app.game; const end = g.state.time.elapsed + seconds;
    while (g.state.time.elapsed < end) { for (let k = 0; k < 200 && g.state.time.elapsed < end; k++) g.step(0.25); await new Promise((r) => setTimeout(r, 0)); }
  };
  window.__look = (x, z, dist, pitch, yaw) => { const cc = app.renderer.cameraController; cc.goal.pitch = pitch ?? 0.7; cc.goal.yaw = yaw ?? 0.4; cc.jumpTo(x, z, dist ?? 30); };
});

// build a small town instantly
await page.evaluate(() => {
  for (const t of ['woodenHouse', 'woodenHouse', 'townHall', 'tavern', 'blacksmith', 'chapel']) { const b = window.__placeNear(t); if (b) window.__complete(b); }
  const tp = window.__placeNear('tradingPost', { maxR: 60 });
  if (tp) { window.__complete(tp); window.__app.game.setWorkers(tp.id, 1); }
});
await page.evaluate(() => window.__fast(30));
// fire without a well: let it grow
const fireId = await page.evaluate(() => { const b = window.__app.game.state.buildings.find((x) => x.type === 'tavern'); window.__app.debug.fire(b.id); return b.id; });
await page.evaluate(() => window.__fast(30));
await page.evaluate((id) => { const g = window.__app.game; g.state.time.dayTime = 0.5; const b = g.getBuilding(id); window.__look(b.x + 1.5, b.z + 1.5, 18, 0.45, 0.8); window.__app.setSpeed(1); }, fireId);
await page.waitForTimeout(2500);
console.log('fire', JSON.stringify(await page.evaluate((id) => { const b = window.__app.game.getBuilding(id); return b ? { fire: b.fire, ff: b.fireFighters, state: b.state } : null; }, fireId)));
await shot('f01_fire_day');
await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.02; });
await page.waitForTimeout(2000);
await shot('f02_fire_night');
await page.evaluate(() => window.__app.setSpeed(0));
// merchant + trade dialog with toasts
await page.evaluate(() => window.__app.debug.merchant('goods'));
await page.evaluate(() => window.__fast(12));
await page.evaluate(() => { const g = window.__app.game; g.state.time.dayTime = 0.5; const tp = g.state.buildings.find((b) => b.type === 'tradingPost'); if (tp) window.__look(tp.x + 2, tp.z + 2, 20, 0.45, 2.4); });
await page.waitForTimeout(1200);
await shot('f03_merchant');
await page.evaluate(() => window.__app.ui.openWindow('trade'));
await page.waitForTimeout(600);
await shot('f04_trade_dialog');
await page.evaluate(() => window.__app.ui.closeWindow('trade'));
// winter snow on roofs at partial and full cover
await page.evaluate(() => window.__fast(60 * 9.2));
await page.evaluate(() => { const g = window.__app.game; g.state.time.dayTime = 0.5; const b = g.state.buildings.find((x) => x.type === 'chapel') ?? g.state.buildings[0]; window.__look(b.x + 2, b.z + 2, 20, 0.5, 1.1); });
await page.waitForTimeout(1500);
console.log('snow', await page.evaluate(() => window.__app.game.state.weather.snow));
await shot('f05_winter_partial');
await page.evaluate(() => { window.__app.game.state.weather.snow = 1; });
await page.waitForTimeout(2500);
await shot('f06_winter_full');
console.log('==== console errors/warnings (' + logs.length + ') ====');
console.log([...new Set(logs)].slice(0, 30).join(String.fromCharCode(10)));
await browser.close();
