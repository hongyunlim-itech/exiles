// Integration runtime smoke test for the real app (index.html).
// Usage: node dev/integration/boot.mjs <outDir> [port] [seconds] [quality]
// Loads the page, captures console errors/warnings/page errors, screenshots the title menu, starts a new game via the
// UI, then drives the game through window.__app (speed 10, buildings, roads, clearing) and screenshots periodically.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '.';
const port = process.argv[3] ?? '5210';
const seconds = Number(process.argv[4] ?? 90);
const quality = process.argv[5] ?? 'high';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(180000);
await page.addInitScript((q) => {
  try {
    localStorage.clear();
    localStorage.setItem('exiles.settings', JSON.stringify({ quality: q, shadows: q !== 'low', showFps: true }));
  } catch { /* ignore */ }
}, quality);
const logs = [];
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + '\n' + (e.stack ?? '').split('\n').slice(0, 4).join('\n')));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`console.${m.type()}: ${m.text()}`);
});
const shot = async (name) => {
  await page.screenshot({ path: path.join(out, name + '.png') });
  console.log('shot', name);
};

const t0 = Date.now();
await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__app, null, { timeout: 60000 });
await page.waitForTimeout(4000);
console.log('boot ms', Date.now() - t0);
await shot('01_menu');

// start a new game through the UI
const menuOk = await page.evaluate(() => !!document.querySelector('.menu'));
console.log('menu present', menuOk);
try {
  await page.click('.menu-btn >> text=New Game', { timeout: 5000 });
  await page.waitForTimeout(800);
  await shot('02_newgame_form');
  // fixed seed for reproducibility
  await page.evaluate(() => {
    const seed = document.querySelector('.ng-form input[aria-label="World seed"]');
    if (seed) { seed.value = '777'; seed.dispatchEvent(new Event('input', { bubbles: true })); seed.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.click('.ng-form button[type=submit]', { timeout: 5000 });
} catch (err) {
  console.log('UI new game failed, falling back to __app.newGame:', err.message);
  await page.evaluate(() => window.__app.newGame({ seed: 777, townName: 'Testville', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: true }));
}
await page.waitForFunction(() => window.__app && !window.__app.inMenu, null, { timeout: 60000 });
await page.waitForTimeout(3000);
await shot('03_newgame');

const dump = async (label) => {
  const d = await page.evaluate(() => {
    const app = window.__app;
    const g = app.game;
    const s = g.state;
    const tot = g.resourceTotals();
    let food = 0;
    for (const [k, v] of Object.entries(tot)) if (['berries', 'mushrooms', 'roots', 'venison', 'fish', 'wheat', 'corn', 'potato', 'beans', 'apple', 'pear', 'cherry', 'mutton', 'beef', 'eggs', 'chicken'].includes(k)) food += v;
    const acts = {};
    for (const c of s.citizens) acts[c.activity] = (acts[c.activity] ?? 0) + 1;
    const profs = {};
    for (const c of s.citizens) profs[c.profession] = (profs[c.profession] ?? 0) + 1;
    return {
      time: `Y${s.time.year} M${s.time.month} ${s.time.elapsed.toFixed(0)}s`,
      speed: g.speed,
      pop: g.populationSummary(),
      food, logs: tot.log, stone: tot.stone, iron: tot.iron, firewood: tot.firewood, tools: tot.tool,
      buildings: s.buildings.map((b) => `${b.type}#${b.id}:${b.state}${b.state !== 'active' ? '(' + b.progress.toFixed(2) + ')' : ''} w${b.workerIds.length}/${b.workersDesired}`),
      acts, profs,
      labels: [...new Set(s.citizens.map((c) => c.taskLabel))].slice(0, 25),
      messages: s.messages.slice(-12).map((m) => `[${m.severity}] ${m.text}`),
      moduleErrors: g.moduleErrors(),
      invariants: g.validate().slice(0, 10),
      marked: g.rt.marked.size,
      renderStats: app.renderer.stats ? app.renderer.stats() : null,
    };
  });
  console.log(`---- ${label} ----\n` + JSON.stringify(d, null, 1));
  return d;
};
await dump('start');

// build helpers (in page)
await page.evaluate(() => {
  const app = window.__app;
  window.__place = (type, opts = {}) => {
    const g = app.game;
    const s = g.state;
    const B = g.constructor;
    const c = g.townCenter();
    const maxR = opts.maxR ?? 26;
    const w = opts.w;
    const h = opts.h;
    let best = null;
    let bestScore = -1e9;
    for (let dz = -maxR; dz <= maxR; dz += 2) {
      for (let dx = -maxR; dx <= maxR; dx += 2) {
        const d = Math.hypot(dx, dz);
        if (d > maxR || d < (opts.minR ?? 0)) continue;
        for (const rot of (w ? [0] : [0, 1, 2, 3])) {
          const x = Math.round(c.x + dx - (w ?? 3) / 2);
          const z = Math.round(c.z + dz - (h ?? 3) / 2);
          const chk = g.checkPlacement(type, x, z, rot, w, h);
          if (!chk.ok) continue;
          if (!g.isWalkableXZ(chk.doorX, chk.doorZ)) continue;
          let clear = true;
          const fw = w ?? (rot % 2 ? 3 : 3);
          for (let zz = z - 1; zz < z + (h ?? 4) + 1 && clear; zz++) for (let xx = x - 1; xx < x + (w ?? 4) + 1; xx++) {
            if (xx < 0 || zz < 0 || xx >= s.W || zz >= s.H) { clear = false; break; }
            if (s.tiles.building[zz * s.W + xx] >= 0 || g.rt.doorTiles.has(zz * s.W + xx)) { clear = false; break; }
          }
          if (!clear) continue;
          const sc = -d - chk.clearing.length * 0.5 + (opts.trees ? Math.min(60, g.countTrees(x, z, 12)) * 0.6 : 0) + (opts.water ? (() => { let n = 0; for (let a = -8; a <= 8; a++) for (let b2 = -8; b2 <= 8; b2++) { const tx = x + a, tz = z + b2; if (tx >= 0 && tz >= 0 && tx < s.W && tz < s.H && (s.tiles.terrain[tz * s.W + tx] === 2 || s.tiles.terrain[tz * s.W + tx] === 3)) n++; } return Math.min(n, 80) * 0.3; })() : 0);
          if (sc > bestScore) { bestScore = sc; best = { x, z, rot }; }
        }
      }
    }
    if (!best) return null;
    const b = g.placeBuilding(type, best.x, best.z, best.rot, w, h);
    return b ? { id: b.id, x: b.x, z: b.z, rot: b.rotation, state: b.state } : null;
  };
});

await page.evaluate(() => window.__app.setSpeed(10));
const placed = await page.evaluate(() => {
  const r = {};
  r.house1 = window.__place('woodenHouse');
  r.house2 = window.__place('woodenHouse');
  r.gatherer = window.__place('gathererHut', { trees: true, maxR: 30 });
  r.woodcutter = window.__place('woodcutter');
  r.field = window.__place('cropField', { w: 7, h: 7, maxR: 30 });
  r.hunter = window.__place('hunterCabin', { trees: true, maxR: 34 });
  r.dock = window.__place('fishingDock', { water: true, maxR: 45 });
  const g = window.__app.game;
  g.setBuilders(4);
  // mark trees near town, place a road from the barn door
  const c = g.townCenter();
  r.marked = g.markForRemoval(Math.round(c.x) + 8, Math.round(c.z) - 8, Math.round(c.x) + 16, Math.round(c.z) + 2, 'trees');
  const barn = g.state.buildings.find((b) => b.type === 'storageBarn');
  if (barn) {
    const tiles = [];
    for (let k = 1; k < 14; k++) tiles.push((barn.doorZ + 1) * g.state.W + barn.doorX + k);
    r.roadCheck = g.checkRoad(tiles, 'dirt');
    r.road = g.placeRoad(tiles, 'dirt');
  }
  return r;
});
console.log('placed', JSON.stringify(placed));

const start = Date.now();
let k = 0;
while (Date.now() - start < seconds * 1000) {
  await page.waitForTimeout(15000);
  k++;
  await shot(`10_run_${String(k).padStart(2, '0')}`);
  await dump(`t+${Math.round((Date.now() - start) / 1000)}s`);
  if (k === 2) {
    await page.evaluate(() => {
      window.__place('woodenHouse');
      window.__place('foresterLodge', { trees: true, maxR: 30 });
      window.__place('well');
    });
  }
}
// zoomed-in shot near the town
await page.evaluate(() => { const c = window.__app.game.townCenter(); window.__app.renderer.cameraController.jumpTo?.(c.x, c.z, 22); });
await page.waitForTimeout(1500);
await shot('20_town_close');
const fps = await page.evaluate(() => document.querySelector('.fps, .hud-fps, #fps')?.textContent ?? null);
console.log('fps text', fps);
console.log('==== console errors/warnings (' + logs.length + ') ====');
const uniq = [...new Set(logs)];
console.log(uniq.slice(0, 60).join('\n'));
await browser.close();
