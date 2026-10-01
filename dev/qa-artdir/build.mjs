// QA (art director / render perf): build a representative mid-game town with the scripted Bot for N years,
// then add every missing building type, livestock/crop variety, roads (dirt+stone), a bridge and extra citizens,
// simulate a bit more and save to dev/qa-artdir/town.sav.
// Usage: node dev/qa-artdir/build.mjs [years] [seed]
import { chromium } from 'playwright';
import fs from 'node:fs';

const years = Number(process.argv[2] ?? 4);
const seed = Number(process.argv[3] ?? 90210);
const port = 5222;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(3600000);
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('exiles.settings', JSON.stringify({ quality: 'high', shadows: true })); } catch { /* */ } });
const logs = [];
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`console.${m.type()}: ${m.text()}`); });
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => !!window.__app);
await page.evaluate((sd) => window.__app.newGame({ seed: sd, townName: 'Artford', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false }), seed);
await page.waitForFunction(() => !window.__app.inMenu);
await page.evaluate(() => window.__app.setSpeed(0));
const t0 = Date.now();
const res = await page.evaluate(async (yrs) => {
  const { Bot } = await import('/tests/simcore.bot.ts');
  const app = window.__app;
  const g = app.game;
  const bot = new Bot(g);
  const run = async (sec) => {
    const end = g.state.time.elapsed + sec;
    while (g.state.time.elapsed < end && !g.state.gameOver) {
      for (let k = 0; k < 240; k++) { g.step(0.25); bot.tick(); }
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  await run(yrs * 720);
  const botStats = { pop: g.state.citizens.length, buildings: g.state.buildings.length, placed: bot.placed.join(','), skipped: bot.skipped.join(','), time: { ...g.state.time } };
  const complete = (b) => {
    b.state = 'active'; b.progress = 1; b.delivered = { ...b.cost }; b.incoming = {}; b.workRemaining = 0; b.builtAt = g.state.time.elapsed;
    for (let zz = b.z; zz < b.z + b.h; zz++) for (let xx = b.x; xx < b.x + b.w; xx++) { const i = zz * g.state.W + xx; if (g.state.tiles.feature[i]) g.removeFeature(i); }
    g.state.rev.buildings++; g.rt.dirty = true;
    g.events.emit('buildingCompleted', { id: b.id });
  };
  const placeNear = (type, opts = {}) => {
    const c = g.townCenter(); const maxR = opts.maxR ?? 34;
    let best = null; let bs = -1e9;
    for (let dz = -maxR; dz <= maxR; dz += 1) for (let dx = -maxR; dx <= maxR; dx += 1) {
      const d = Math.hypot(dx, dz); if (d > maxR || d < (opts.minR ?? 0)) continue;
      for (const rot of (opts.w ? [0] : [0, 1, 2, 3])) {
        const x = Math.round(c.x + dx - 1); const z = Math.round(c.z + dz - 1);
        const chk = g.checkPlacement(type, x, z, rot, opts.w, opts.h);
        if (!chk.ok || !g.isWalkableXZ(chk.doorX, chk.doorZ)) continue;
        let clear = true;
        const bw = opts.w ?? 4; const bh = opts.h ?? 4;
        for (let zz = z - 1; zz <= z + bh && clear; zz++) for (let xx = x - 1; xx <= x + bw; xx++) {
          if (xx < 0 || zz < 0 || xx >= g.state.W || zz >= g.state.H) continue;
          const i = zz * g.state.W + xx; if (g.state.tiles.building[i] >= 0) { clear = false; break; }
        }
        if (!clear) continue;
        const sc = -d - chk.clearing.length * 1.5;
        if (sc > bs) { bs = sc; best = { x, z, rot }; }
      }
    }
    if (!best) return null;
    return g.placeBuilding(type, best.x, best.z, best.rot, opts.w, opts.h);
  };
  for (const [r, n] of [['log', 400], ['stone', 400], ['iron', 150], ['tool', 60], ['firewood', 300], ['wheat', 400], ['fish', 300], ['woolCoat', 40], ['herbs', 60], ['ale', 40]]) g.addToStorage(r, n);
  const have = new Set(g.state.buildings.filter((b) => b.state === 'active').map((b) => b.type));
  const added = [];
  const want = [
    ['townHall'], ['market'], ['chapel'], ['tavern'], ['school'], ['hospital'], ['blacksmith'], ['brewery'], ['tailor'], ['herbalist'],
    ['stoneHouse'], ['stoneHouse'], ['boardingHouse'], ['woodenHouse'], ['woodenHouse'],
    ['storageBarn'], ['well'], ['cemetery', { w: 5, h: 5 }], ['quarry', { maxR: 70 }], ['gathererHut'], ['hunterCabin', { maxR: 50 }], ['foresterLodge', { maxR: 50 }], ['woodcutter'],
    ['pasture', { w: 8, h: 7, maxR: 45, minR: 10 }], ['pasture', { w: 7, h: 6, maxR: 45, minR: 10 }], ['pasture', { w: 6, h: 6, maxR: 50, minR: 10 }],
    ['tradingPost', { maxR: 70 }], ['mine', { maxR: 70 }], ['orchard', { w: 7, h: 7, maxR: 45, minR: 8 }], ['fishingDock', { maxR: 60 }], ['cropField', { w: 8, h: 6, maxR: 45, minR: 8 }],
  ];
  const once = ['tailor', 'herbalist', 'cemetery', 'quarry', 'fishingDock', 'well', 'market', 'school', 'hospital', 'blacksmith', 'gathererHut', 'hunterCabin', 'foresterLodge', 'woodcutter', 'townHall', 'chapel', 'tavern', 'brewery', 'tradingPost', 'mine'];
  for (const [t, o] of want) {
    if (once.includes(t) && have.has(t)) continue;
    const b = placeNear(t, o ?? {});
    if (b) { complete(b); added.push(t); } else added.push('FAIL:' + t);
  }
  // finish any pending construction the bot left so the town is complete
  for (const b of g.state.buildings) if (b.state === 'construction' || b.state === 'clearing') complete(b);
  for (const l of ['sheep', 'cattle', 'chicken']) if (!g.state.unlocked.livestock.includes(l)) g.state.unlocked.livestock.push(l);
  for (const l of ['wheat', 'corn', 'potato', 'beans']) if (!g.state.unlocked.crops.includes(l)) g.state.unlocked.crops.push(l);
  for (const l of ['apple', 'pear', 'cherry']) if (!g.state.unlocked.orchards.includes(l)) g.state.unlocked.orchards.push(l);
  const pastures = g.state.buildings.filter((b) => b.type === 'pasture');
  if (pastures[0]) g.setCrop(pastures[0].id, 'sheep');
  if (pastures[1]) g.setCrop(pastures[1].id, 'cattle');
  if (pastures[2]) g.setCrop(pastures[2].id, 'chicken');
  const fields = g.state.buildings.filter((b) => b.type === 'cropField');
  const crops = ['wheat', 'corn', 'potato', 'beans'];
  fields.forEach((f, i) => g.setCrop(f.id, crops[i % 4]));
  const orch = g.state.buildings.filter((b) => b.type === 'orchard');
  if (orch[1]) g.setCrop(orch[1].id, 'cherry');
  const c = g.townCenter();
  for (let i = 0; i < 30; i++) g.spawnCitizen({ x: c.x + (i % 6) - 3, z: c.z + Math.floor(i / 6) - 3, age: 18 + (i * 7) % 30, gender: i % 2 ? 'M' : 'F' });
  const W = g.state.W;
  const lpath = (x0, z0, x1, z1) => {
    const t = [];
    const sx = Math.sign(x1 - x0) || 1; const sz = Math.sign(z1 - z0) || 1;
    for (let x = x0; x !== x1 + sx; x += sx) t.push(z0 * W + x);
    for (let z = z0; z !== z1 + sz; z += sz) t.push(z * W + x1);
    return t;
  };
  let roads = 0;
  const cx = Math.round(c.x); const cz = Math.round(c.z);
  for (const b of g.state.buildings) {
    if (b.doorX === undefined) continue;
    const kind = (b.id % 3 === 0) ? 'stone' : 'dirt';
    roads += g.placeRoad(lpath(b.doorX, b.doorZ, cx, cz), kind);
  }
  let bestBridge = null;
  for (let z = Math.max(1, cz - 60); z < Math.min(g.state.H - 1, cz + 60); z++) {
    for (let x = Math.max(1, cx - 60); x < Math.min(W - 1, cx + 60); x++) {
      const i = z * W + x;
      if (g.state.tiles.terrain[i] !== 0) continue;
      if (g.state.tiles.terrain[i + 1] !== 2) continue;
      let k = 1; while (x + k < W && g.state.tiles.terrain[i + k] === 2) k++;
      if (g.state.tiles.terrain[i + k] === 0 && k >= 3 && k <= 9) {
        const d = Math.hypot(x - cx, z - cz);
        if (!bestBridge || d < bestBridge.d) bestBridge = { x, z, k, d };
      }
    }
  }
  let bridge = 0;
  if (bestBridge) {
    const t = []; for (let k = 0; k <= bestBridge.k; k++) t.push(bestBridge.z * W + bestBridge.x + k);
    bridge = g.placeRoad(t, 'dirt');
  }
  await run(240);
  const counts = {};
  for (const b of g.state.buildings) counts[b.type + ':' + b.state] = (counts[b.type + ':' + b.state] ?? 0) + 1;
  let trees = 0; for (let i = 0; i < g.state.W * g.state.H; i++) if (g.state.tiles.feature[i] === 1) trees++;
  return { botStats, pop: g.state.citizens.length, animals: g.state.animals.length, trees, counts, time: g.state.time, added: added.join(','), roads, bridge, bestBridge };
}, years);
console.log('simulated in', Date.now() - t0, 'ms', JSON.stringify(res, null, 1));
const data = await page.evaluate(() => window.__app.game.save());
fs.writeFileSync('dev/qa-artdir/town.sav', data);
console.log('saved', data.length);
console.log([...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
