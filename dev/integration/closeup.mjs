// Close-up screenshots of the real app for visual inspection.
// Usage: node dev/integration/closeup.mjs <outDir> [port] [years]
// Starts an easy game, optionally fast-forwards `years` (headless steps in page), then takes low-angle close-ups.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '.';
const port = process.argv[3] ?? '5210';
const years = Number(process.argv[4] ?? 0);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
await page.addInitScript(() => {
  try { localStorage.clear(); localStorage.setItem('exiles.settings', JSON.stringify({ quality: 'high', shadows: true, showFps: false })); } catch { /* */ }
});
const logs = [];
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`console.${m.type()}: ${m.text()}`); });
await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__app);
await page.waitForTimeout(2000);
await page.evaluate(() => window.__app.newGame({ seed: 777, townName: 'Closeup', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: false }));
await page.waitForFunction(() => !window.__app.inMenu);
await page.evaluate(() => window.__app.setSpeed(0));
if (years > 0) {
  // fast-forward headlessly with a small scripted build order
  const r = await page.evaluate(async (yrs) => {
    const app = window.__app;
    const g = app.game;
    const place = (type, w, h, maxR = 26, key) => {
      const c = g.townCenter();
      let best = null; let bs = -1e9;
      for (let dz = -maxR; dz <= maxR; dz += 2) for (let dx = -maxR; dx <= maxR; dx += 2) {
        const d = Math.hypot(dx, dz); if (d > maxR) continue;
        for (const rot of (w ? [0] : [0, 1, 2, 3])) {
          const x = Math.round(c.x + dx - (w ?? 3) / 2); const z = Math.round(c.z + dz - (h ?? 3) / 2);
          const chk = g.checkPlacement(type, x, z, rot, w, h);
          if (!chk.ok || !g.isWalkableXZ(chk.doorX, chk.doorZ)) continue;
          let clear = true;
          for (let zz = z - 1; zz < z + (h ?? 4) + 1 && clear; zz++) for (let xx = x - 1; xx < x + (w ?? 4) + 1; xx++) {
            const i = zz * g.state.W + xx; if (g.state.tiles.building[i] >= 0 || g.rt.doorTiles.has(i)) { clear = false; break; }
          }
          if (!clear) continue;
          const sc = -d - chk.clearing.length * 0.5 + (key === 'trees' ? Math.min(60, g.countTrees(x, z, 12)) * 0.6 : 0);
          if (sc > bs) { bs = sc; best = { x, z, rot }; }
        }
      }
      return best ? g.placeBuilding(type, best.x, best.z, best.rot, w, h) : null;
    };
    g.setBuilders(4);
    place('gathererHut', undefined, undefined, 30, 'trees');
    place('woodcutter');
    place('cropField', 8, 8, 30);
    place('hunterCabin', undefined, undefined, 34, 'trees');
    place('foresterLodge', undefined, undefined, 30, 'trees');
    place('well');
    place('stoneHouse');
    place('tavern');
    place('chapel');
    place('pasture', 8, 6, 30);
    place('orchard', 6, 6, 30);
    const end = g.state.time.elapsed + yrs * 720;
    while (g.state.time.elapsed < end) {
      for (let k = 0; k < 400; k++) g.step(0.25);
      await new Promise((r) => setTimeout(r, 0));
    }
    return { pop: g.state.citizens.length, t: g.state.time.elapsed, b: g.state.buildings.map((b) => b.type + ':' + b.state) };
  }, years);
  console.log(JSON.stringify(r));
}
const views = [
  { name: 'c01_houses', pick: 'woodenHouse', dist: 11, pitch: 0.38, yaw: 0.7 },
  { name: 'c02_barn', pick: 'storageBarn', dist: 14, pitch: 0.42, yaw: -0.6 },
  { name: 'c03_stockpile', pick: 'stockpile', dist: 12, pitch: 0.55, yaw: 2.2 },
  { name: 'c04_citizens', pick: 'citizen', dist: 7, pitch: 0.35, yaw: 1.4 },
  { name: 'c05_overview_low', pick: 'town', dist: 45, pitch: 0.45, yaw: 0.3 },
  { name: 'c06_field', pick: 'cropField', dist: 14, pitch: 0.5, yaw: 0.4 },
  { name: 'c07_tavern', pick: 'tavern', dist: 12, pitch: 0.4, yaw: 0.9 },
  { name: 'c08_chapel', pick: 'chapel', dist: 14, pitch: 0.35, yaw: -0.4 },
  { name: 'c09_pasture', pick: 'pasture', dist: 12, pitch: 0.45, yaw: 0.2 },
];
for (const v of views) {
  const ok = await page.evaluate((v) => {
    const app = window.__app;
    const g = app.game;
    let x, z;
    if (v.pick === 'citizen') { const c = g.state.citizens.find((c) => c.moving) ?? g.state.citizens[0]; x = c.x; z = c.z; }
    else if (v.pick === 'town') { const c = g.townCenter(); x = c.x; z = c.z; }
    else { const b = g.state.buildings.find((b) => b.type === v.pick); if (!b) return false; x = b.x + b.w / 2; z = b.z + b.h / 2; }
    const cc = app.renderer.cameraController;
    cc.jumpTo(x, z, v.dist);
    cc.goal.pitch = v.pitch; cc.goal.yaw = v.yaw;
    cc.jumpTo(x, z, v.dist);
    return true;
  }, v);
  if (!ok) { console.log('skip', v.name); continue; }
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, v.name + '.png') });
  console.log('shot', v.name);
}
console.log('errors', JSON.stringify([...new Set(logs)].slice(0, 20), null, 1));
await browser.close();
