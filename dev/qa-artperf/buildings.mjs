// Close-ups of every building type (front/back), construction stages, demolition, ruins and fire (day/night).
import { open } from './lib.mjs';

const { browser, page, logs, shot } = await open();
await page.evaluate(() => { window.__noToasts(); const s = window.__app.game.state; s.weather.precipitation = 'none'; s.weather.precipIntensity = 0; s.time.dayTime = 0.45; });
const types = await page.evaluate(() => [...new Set(window.__app.game.state.buildings.filter((b) => b.state === 'active').map((b) => b.type))]);
console.log(types.join(','));
for (const t of types) {
  const info = await page.evaluate((tt) => {
    const b = window.__b(tt, 0);
    const dist = Math.max(8, Math.max(b.w, b.h) * 1.7 + 4);
    window.__lookB(b, dist, 0.42, window.__frontYaw(b, 0.55));
    return { id: b.id, w: b.w, h: b.h, rot: b.rotation, dist };
  }, t);
  await page.evaluate(() => window.__frames(3));
  await shot(`b_${t}`);
  await page.evaluate((tt) => { const b = window.__b(tt, 0); window.__lookB(b, Math.max(8, Math.max(b.w, b.h) * 1.7 + 4), 0.5, window.__frontYaw(b, Math.PI - 0.5)); }, t);
  await page.evaluate(() => window.__frames(3));
  await shot(`b_${t}_back`);
}
// night lit windows
await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.92; });
for (const t of ['woodenHouse', 'stoneHouse', 'tavern', 'chapel', 'townHall', 'blacksmith']) {
  await page.evaluate((tt) => { const b = window.__b(tt, 0); if (!b) return; window.__lookB(b, 12, 0.4, window.__frontYaw(b, 0.55)); }, t);
  await page.evaluate(() => window.__frames(4));
  await shot(`bn_${t}`);
}
await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.45; });
// construction stages
const sites = await page.evaluate(() => {
  const g = window.__app.game;
  const c = g.townCenter();
  const out = [];
  for (const t of ['chapel', 'stoneHouse', 'woodenHouse', 'storageBarn', 'cropField']) {
    let best = null; let bs = -1e9;
    for (let dz = -45; dz <= 45; dz++) for (let dx = -45; dx <= 45; dx++) {
      const d = Math.hypot(dx, dz); if (d > 45 || d < 14) continue;
      const x = Math.round(c.x + dx); const z = Math.round(c.z + dz);
      const chk = t === 'cropField' ? g.checkPlacement(t, x, z, 0, 6, 6) : g.checkPlacement(t, x, z, 0);
      if (!chk.ok || !g.isWalkableXZ(chk.doorX, chk.doorZ)) continue;
      const sc = -d - chk.clearing.length * 3;
      if (sc > bs) { bs = sc; best = { x, z }; }
    }
    if (!best) continue;
    const b = t === 'cropField' ? g.placeBuilding(t, best.x, best.z, 0, 6, 6) : g.placeBuilding(t, best.x, best.z, 0);
    if (b) out.push({ id: b.id, type: t, state: b.state });
  }
  return out;
});
console.log('sites', JSON.stringify(sites));
const stages = [['clearing', 0], ['construction', 0.02], ['construction', 0.3], ['construction', 0.65], ['construction', 0.95], ['demolishing', 0.5], ['ruin', 0]];
for (const site of sites) {
  for (const [st, p] of stages) {
    if (site.type === 'cropField' && (st === 'demolishing' || st === 'ruin')) continue;
    await page.evaluate(([id, st, p]) => {
      const g = window.__app.game; const b = g.getBuilding(id);
      b.state = st; b.progress = p; if (st === 'demolishing') b.demolishProgress = p; g.state.rev.buildings++;
      window.__lookB(b, Math.max(9, Math.max(b.w, b.h) * 1.7 + 4), 0.45, window.__frontYaw(b, 0.55));
    }, [site.id, st, p]);
    await page.evaluate(() => window.__frames(3));
    await shot(`cs_${site.type}_${st}_${Math.round(p * 100)}`);
  }
}
// fire: tavern & a house, growing, day & night
const fires = await page.evaluate(() => { const a = window.__b('tavern', 0); const h = window.__b('woodenHouse', 2); window.__app.debug.fire(a.id); window.__app.debug.fire(h.id); return [a.id, h.id]; });
for (const f of [0.2, 0.6, 1.0]) {
  for (const [tn, t] of [['day', 0.45], ['night', 0.92]]) {
    await page.evaluate(([ids, f, t]) => { const g = window.__app.game; for (const id of ids) { const b = g.getBuilding(id); if (b) b.fire = f; } g.state.time.dayTime = t; const b = g.getBuilding(ids[0]); window.__lookB(b, 13, 0.42, window.__frontYaw(b, 0.7)); window.__app.setSpeed(1); }, [fires, f, t]);
    await page.evaluate(() => window.__frames(10));
    await page.evaluate(() => window.__app.setSpeed(0));
    await shot(`fire_${Math.round(f * 100)}_${tn}`);
  }
}
// burnt ruin via removeBuilding('fire')
await page.evaluate((ids) => { const g = window.__app.game; g.removeBuilding(ids[0], 'fire'); g.state.time.dayTime = 0.45; }, fires);
await page.evaluate(() => window.__frames(4));
const ruin = await page.evaluate((ids) => { const g = window.__app.game; const b = g.getBuilding(ids[0]); return b ? { state: b.state, type: b.type } : null; }, fires);
console.log('after fire', JSON.stringify(ruin));
await page.evaluate((ids) => { const g = window.__app.game; const b = g.getBuilding(ids[0]); if (b) { b.fire = 0; window.__lookB(b, 12, 0.45, window.__frontYaw(b, 0.7)); } }, fires);
await page.evaluate(() => window.__frames(4));
await shot('fire_ruin_tavern');
await page.evaluate((ids) => { const g = window.__app.game; const b = g.getBuilding(ids[1]); if (b) window.__lookB(b, 13, 0.42, window.__frontYaw(b, 0.7)); }, fires);
await page.evaluate(() => window.__frames(4));
await shot('fire_after_neighbor');
console.log([...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
