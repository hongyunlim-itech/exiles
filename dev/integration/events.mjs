// Visual check of events in the real app: winter + snow, fire (day & night), merchant boat + trade dialog, nomads
// dialog, tornado, disease, game-over overlay. Usage: node dev/integration/events.mjs <outDir> [port]
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

// build a small town instantly: houses, trading post, town hall, well, chapel
const built = await page.evaluate(() => {
  const r = {};
  for (const t of ['woodenHouse', 'woodenHouse', 'townHall', 'well', 'tavern', 'blacksmith']) { const b = window.__placeNear(t); if (b) { window.__complete(b); r[t + b.id] = [b.x, b.z]; } }
  const tp = window.__placeNear('tradingPost', { maxR: 60 });
  if (tp) { window.__complete(tp); r.tradingPost = [tp.x, tp.z]; window.__app.game.setWorkers(tp.id, 1); }
  const dock = window.__placeNear('fishingDock', { maxR: 60 });
  if (dock) { window.__complete(dock); r.fishingDock = [dock.x, dock.z]; }
  return r;
});
console.log('built', JSON.stringify(built));
await page.evaluate(() => window.__fast(30));
await page.evaluate(() => { const c = window.__app.game.townCenter(); window.__look(c.x, c.z, 34, 0.6, 0.5); });
await page.waitForTimeout(800);
await shot('e01_town');

// fire: day then night
const fireId = await page.evaluate(() => { const b = window.__app.game.state.buildings.find((x) => x.type === 'blacksmith'); window.__app.debug.fire(b.id); return b.id; });
await page.evaluate(() => window.__fast(25));
await page.evaluate((id) => { const b = window.__app.game.getBuilding(id); window.__look(b.x + 1.5, b.z + 1.5, 16, 0.45, 0.8); window.__app.setSpeed(1); }, fireId);
await page.waitForTimeout(1500);
await shot('e02_fire_day');
const fireState = await page.evaluate((id) => { const b = window.__app.game.getBuilding(id); return b ? { fire: b.fire, ff: b.fireFighters, state: b.state } : null; }, fireId);
console.log('fire', JSON.stringify(fireState));
await page.evaluate(() => window.__app.setSpeed(0));

// merchant + trade dialog
const merchant = await page.evaluate(() => window.__app.debug.merchant('seeds'));
console.log('merchant summoned', merchant);
await page.evaluate(() => window.__fast(12));
await page.evaluate(() => { const g = window.__app.game; const tp = g.state.buildings.find((b) => b.type === 'tradingPost'); if (tp) window.__look(tp.x + 2, tp.z + 2, 22, 0.5, 0.3); });
await page.waitForTimeout(800);
await shot('e03_merchant_boat');
const hasTradeBtn = await page.evaluate(() => !!window.__app.game.state.trade.merchant);
if (hasTradeBtn) {
  await page.evaluate(() => window.__app.ui.openWindow?.('trade'));
  await page.waitForTimeout(600);
  await shot('e04_trade_dialog');
  await page.evaluate(() => window.__app.ui.closeWindow?.('trade'));
}

// nomads
const nomads = await page.evaluate(() => window.__app.debug.nomads(5));
console.log('nomads summoned', nomads);
await page.waitForTimeout(800);
await shot('e05_nomads');
await page.evaluate(() => { try { window.__app.game.respondToNomads(true); } catch (e) { return String(e); } window.__app.ui.closeWindow?.('nomads'); });

// winter + snow + night
await page.evaluate(() => window.__fast(60 * 9.3));
await page.evaluate(() => { const g = window.__app.game; g.state.time.dayTime = 0.5; const c = g.townCenter(); window.__look(c.x, c.z, 30, 0.55, 1.1); });
await page.waitForTimeout(1500);
const w = await page.evaluate(() => { const s = window.__app.game.state; return { month: s.time.month, temp: s.weather.temperature, snow: s.weather.snow, precip: s.weather.precipitation }; });
console.log('winter', JSON.stringify(w));
await shot('e06_winter_day');
await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.97; });
await page.waitForTimeout(1500);
await shot('e07_winter_night');

// tornado
await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.5; window.__app.debug.tornado(); });
await page.evaluate(() => window.__fast(6));
await page.evaluate(() => { const t = window.__app.game.state.tornado; if (t) window.__look(t.x, t.z, 40, 0.5, 0.2); });
await page.waitForTimeout(1200);
await shot('e08_tornado');

// disease
await page.evaluate(() => window.__app.debug.outbreak());
await page.waitForTimeout(500);

// game over
await page.evaluate(() => { const g = window.__app.game; for (const c of [...g.state.citizens]) g.killCitizen(c.id, 'oldAge'); window.__app.setSpeed(1); });
await page.waitForTimeout(2500);
await shot('e09_game_over');
const go = await page.evaluate(() => window.__app.game.state.gameOver);
console.log('gameOver', go);
console.log('==== console errors/warnings (' + logs.length + ') ====');
console.log([...new Set(logs)].slice(0, 30).join('\n'));
await browser.close();
