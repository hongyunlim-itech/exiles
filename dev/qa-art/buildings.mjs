// Close-ups of every building type, construction stages, ruins and fire.
import { open } from './lib.mjs';

const { browser, page, logs, shot } = await open();
await page.evaluate(() => { const s = window.__app.game.state; s.weather.precipitation = 'none'; s.weather.precipIntensity = 0; s.time.dayTime = 0.45; });
const types = await page.evaluate(() => [...new Set(window.__app.game.state.buildings.map((b) => b.type))]);
console.log(types.join(','));
for (const t of types) {
  const r = await page.evaluate((tt) => {
    const b = window.__b(tt, 0);
    const dir = [[0, 1], [-1, 0], [0, -1], [1, 0]][b.rotation];
    const yaw = Math.atan2(dir[0], dir[1]) + 0.55;
    const dist = Math.max(9, Math.max(b.w, b.h) * 1.9 + 5);
    window.__lookB(b, dist, 0.42, yaw);
    return { id: b.id, w: b.w, h: b.h, rot: b.rotation, state: b.state, dist };
  }, t);
  await page.evaluate(() => window.__frames(3));
  await shot(`b_${t}`);
  // back view
  await page.evaluate((tt) => { const b = window.__b(tt, 0); const dir = [[0, 1], [-1, 0], [0, -1], [1, 0]][b.rotation]; window.__lookB(b, Math.max(9, Math.max(b.w, b.h) * 1.9 + 5), 0.5, Math.atan2(dir[0], dir[1]) + Math.PI - 0.4); }, t);
  await page.evaluate(() => window.__frames(3));
  await shot(`b_${t}_back`);
}
// night lit windows for a few
await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.9; });
for (const t of ['woodenHouse', 'stoneHouse', 'tavern', 'chapel', 'townHall']) {
  await page.evaluate((tt) => { const b = window.__b(tt, 0); if (!b) return; const dir = [[0, 1], [-1, 0], [0, -1], [1, 0]][b.rotation]; window.__lookB(b, 13, 0.42, Math.atan2(dir[0], dir[1]) + 0.55); }, t);
  await page.evaluate(() => window.__frames(4));
  await shot(`bn_${t}`);
}
await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.45; });
// construction stages: place 4 buildings in an open area and pin their progress
const sites = await page.evaluate(() => {
  const g = window.__app.game;
  const c = g.townCenter();
  const out = [];
  const types = ['chapel', 'stoneHouse', 'woodenHouse', 'townHall', 'blacksmith'];
  for (const t of types) {
    let best = null; let bs = -1e9;
    for (let dz = -40; dz <= 40; dz++) for (let dx = -40; dx <= 40; dx++) {
      const d = Math.hypot(dx, dz); if (d > 40 || d < 12) continue;
      const x = Math.round(c.x + dx); const z = Math.round(c.z + dz);
      const chk = g.checkPlacement(t, x, z, 0);
      if (!chk.ok || !g.isWalkableXZ(chk.doorX, chk.doorZ)) continue;
      const sc = -d - chk.clearing.length * 3;
      if (sc > bs) { bs = sc; best = { x, z }; }
    }
    if (!best) continue;
    const b = g.placeBuilding(t, best.x, best.z, 0);
    if (b) out.push({ id: b.id, type: t, state: b.state, clearing: b.state });
  }
  return out;
});
console.log('sites', JSON.stringify(sites));
const stages = [['clearing', 0], ['construction', 0.05], ['construction', 0.35], ['construction', 0.7], ['construction', 0.95]];
for (const site of sites.slice(0, 3)) {
  for (const [st, p] of stages) {
    await page.evaluate(([id, st, p]) => {
      const g = window.__app.game; const b = g.getBuilding(id);
      b.state = st; b.progress = p; g.state.rev.buildings++;
      const dir = [[0, 1], [-1, 0], [0, -1], [1, 0]][b.rotation];
      window.__lookB(b, Math.max(10, Math.max(b.w, b.h) * 1.9 + 5), 0.45, Math.atan2(dir[0], dir[1]) + 0.55);
    }, [site.id, st, p]);
    await page.evaluate(() => window.__frames(3));
    await shot(`cs_${site.type}_${st}_${Math.round(p * 100)}`);
  }
}
// fire: grow a fire on the tavern & a house, day and night
const fires = await page.evaluate(() => {
  const g = window.__app.game;
  const ids = [window.__b('tavern', 0)?.id, window.__b('woodenHouse', 2)?.id].filter((x) => x !== undefined);
  for (const id of ids) window.__app.debug.fire(id);
  return ids;
});
for (const secs of [8, 25]) {
  await page.evaluate((s) => window.__step(s), secs);
  for (const id of fires) {
    const f = await page.evaluate((id) => { const b = window.__app.game.getBuilding(id); if (!b) return null; window.__lookB(b, 13, 0.42, 0.9); return { fire: b.fire, state: b.state }; }, id);
    console.log('fire', id, JSON.stringify(f));
    if (!f) continue;
    await page.evaluate(() => window.__app.setSpeed(1));
    await page.evaluate(() => window.__frames(8));
    await page.evaluate(() => window.__app.setSpeed(0));
    await shot(`fire_${id}_${secs}s_day`);
    await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.92; });
    await page.evaluate(() => window.__frames(4));
    await shot(`fire_${id}_${secs}s_night`);
    await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.45; });
  }
}
// ruins: burn down two buildings
const ruins = await page.evaluate(() => {
  const g = window.__app.game;
  const out = [];
  for (const t of ['stoneHouse', 'blacksmith']) { const b = window.__b(t, 0); if (b) { g.removeBuilding(b.id, 'fire'); out.push(b.id); } }
  return out;
});
for (const id of ruins) {
  const r = await page.evaluate((id) => { const b = window.__app.game.getBuilding(id); if (!b) return null; window.__lookB(b, 11, 0.45, 0.9); return { state: b.state, type: b.type }; }, id);
  console.log('ruin', id, JSON.stringify(r));
  await page.evaluate(() => window.__frames(4));
  await shot(`ruin_${id}`);
}
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
