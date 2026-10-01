// Close-ups of every building type (front + back), then construction stages / demolition / ruin / fire.
// Usage: node dev/qa-adperf/buildings.mjs [save] [part: types|stages|all]
import { open, DIR } from './lib.mjs';

const save = process.argv[2] ?? `${DIR}/summer.sav`;
const part = process.argv[3] ?? 'all';
const { browser, page, logs, shot } = await open({ save });
await page.evaluate(() => { window.__noToasts(); window.__noUI(true); const s = window.__app.game.state; s.time.dayTime = 0.45; s.weather.precipitation = 'none'; s.weather.precipIntensity = 0; s.weather.snow = 0; });
await page.evaluate(() => window.__frames(20));

if (part === 'types' || part === 'all') {
  const types = await page.evaluate(() => [...new Set(window.__app.game.state.buildings.map((b) => b.type))]);
  console.log('types', types.join(','));
  for (const t of types) {
    const info = await page.evaluate((tt) => { const b = window.__b(tt, tt === 'woodenHouse' ? 2 : 0); return { x: b.x + b.w / 2, z: b.z + b.h / 2, w: b.w, h: b.h, yaw: window.__frontYaw(b), rot: b.rotation, id: b.id, state: b.state }; }, t);
    const d = Math.max(7, Math.max(info.w, info.h) * 1.9 + 3);
    for (const [side, off] of [['front', 0], ['back', Math.PI]]) {
      await page.evaluate(([i, dd, o]) => window.__look(i.x, i.z, dd, 0.42, i.yaw + o), [info, d, off]);
      await page.evaluate(() => window.__frames(8));
      await shot(`bld_${t}_${side}`);
    }
  }
}

if (part === 'stages' || part === 'all') {
  // place fresh sites on open ground near the town
  const sites = await page.evaluate(() => {
    const g = window.__app.game; const s = g.state; const c = g.townCenter();
    const out = {};
    const find = (type, w, h, minR = 8) => {
      let best = null; let bs = 1e9;
      for (let r = minR; r < 60 && !best; r++) {
        for (let a = 0; a < 64; a++) {
          const x = Math.round(c.x + Math.cos(a / 64 * 6.283) * r); const z = Math.round(c.z + Math.sin(a / 64 * 6.283) * r);
          for (const rot of [0]) {
            const chk = g.checkPlacement(type, x, z, rot, w, h);
            if (!chk.ok || chk.clearing.length) continue;
            let clear = true;
            for (let zz = z - 2; zz <= z + 6 && clear; zz++) for (let xx = x - 2; xx <= x + 6; xx++) { const i = zz * s.W + xx; if (s.tiles.building[i] >= 0 || s.tiles.feature[i]) { clear = false; break; } }
            if (!clear) continue;
            if (r < bs) { bs = r; best = { x, z, rot }; }
          }
        }
      }
      return best;
    };
    for (const t of ['woodenHouse', 'chapel', 'storageBarn', 'blacksmith']) {
      const p = find(t);
      if (!p) { out[t] = null; continue; }
      const b = g.placeBuilding(t, p.x, p.z, p.rot);
      out[t] = b ? { id: b.id, x: b.x + b.w / 2, z: b.z + b.h / 2, w: b.w, h: b.h, yaw: window.__frontYaw(b) } : null;
    }
    // stop the sim from touching the sites: keep paused; builders can't act at speed 0
    return out;
  });
  console.log('sites', JSON.stringify(sites));
  const setState = (id, st, progress, extra = {}) => page.evaluate(([i, sst, p, e]) => {
    const g = window.__app.game; const b = g.getBuilding(i); if (!b) return null;
    b.state = sst; b.progress = p; Object.assign(b, e);
    if (sst === 'construction') { b.delivered = {}; for (const [k, v] of Object.entries(b.cost)) b.delivered[k] = Math.ceil(v * Math.min(1, p + 0.3)); }
    g.state.rev.buildings++;
    return { state: b.state, progress: b.progress, fire: b.fire };
  }, [id, st, progress, extra]);
  for (const [t, site] of Object.entries(sites)) {
    if (!site) continue;
    const d = Math.max(8, Math.max(site.w, site.h) * 1.9 + 3);
    const look = () => page.evaluate(([i, dd]) => window.__look(i.x, i.z, dd, 0.45, i.yaw + 0.5), [site, d]);
    const stages = [['clearing', 0], ['construction', 0.02], ['construction', 0.3], ['construction', 0.6], ['construction', 0.9], ['active', 1], ['demolishing', 0.5], ['ruin', 0]];
    for (const [st, p] of stages) {
      console.log(t, st, p, JSON.stringify(await setState(site.id, st, p)));
      await look(); await page.evaluate(() => window.__frames(10));
      await shot(`stage_${t}_${st}_${p}`);
    }
    if (t === 'woodenHouse' || t === 'chapel') {
      for (const f of [0.25, 0.6, 1.0]) {
        await setState(site.id, 'active', 1, { fire: f });
        await look(); await page.evaluate(() => { window.__app.setSpeed(1); }); await page.evaluate(() => window.__frames(30)); await page.evaluate(() => window.__app.setSpeed(0));
        await page.evaluate((i) => { const b = window.__app.game.getBuilding(i); if (b) b.fire = b.fire; }, site.id);
        await shot(`fire_${t}_${f}_day`);
      }
      await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.95; });
      await page.evaluate(() => { window.__app.setSpeed(1); }); await page.evaluate(() => window.__frames(30)); await page.evaluate(() => window.__app.setSpeed(0));
      await shot(`fire_${t}_night`);
      await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.45; });
      await setState(site.id, 'ruin', 0, { fire: 0 });
    }
  }
}
console.log('logs', [...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
