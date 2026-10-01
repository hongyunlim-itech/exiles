// Load town.sav, add citizens (to ~65 pop), a bridge (search both axes), run 2 months and re-save.
import fs from 'node:fs';
import { open, DIR } from './lib.mjs';

const { browser, page, logs } = await open();
const res = await page.evaluate(async () => {
  const g = window.__app.game;
  const s = g.state;
  const W = s.W, H = s.H;
  const c = g.townCenter();
  for (let i = 0; i < 40; i++) g.spawnCitizen({ x: c.x + (i % 8) - 4, z: c.z + Math.floor(i / 8) - 3, age: i < 8 ? 3 + i : 16 + (i * 7) % 45, gender: i % 2 ? 'M' : 'F' });
  const cx = Math.round(c.x), cz = Math.round(c.z);
  const terrains = new Map();
  for (let i = 0; i < W * H; i++) terrains.set(s.tiles.terrain[i], (terrains.get(s.tiles.terrain[i]) ?? 0) + 1);
  let best = null;
  for (let z = 1; z < H - 1; z++) for (let x = 1; x < W - 1; x++) {
    const i = z * W + x;
    if (s.tiles.terrain[i] !== 0) continue;
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      let k = 1;
      while (s.tiles.terrain[(z + dz * k) * W + x + dx * k] === 2 && k < 12) k++;
      if (k >= 3 && k <= 9 && s.tiles.terrain[(z + dz * k) * W + x + dx * k] === 0) {
        const d = Math.hypot(x - cx, z - cz);
        if (!best || d < best.d) best = { x, z, dx, dz, k, d };
      }
    }
  }
  let bridge = 0;
  if (best) {
    const t = []; for (let k = 0; k <= best.k; k++) t.push((best.z + best.dz * k) * W + best.x + best.dx * k);
    bridge = g.placeRoad(t, 'dirt');
  }
  const end = s.time.elapsed + 120;
  while (s.time.elapsed < end) { for (let k = 0; k < 200; k++) g.step(0.25); await new Promise((r) => setTimeout(r, 0)); }
  return { pop: s.citizens.length, best, bridge, terrains: [...terrains.entries()], time: s.time };
});
console.log(JSON.stringify(res));
const data = await page.evaluate(() => window.__app.game.save());
fs.writeFileSync(`${DIR}/town.sav`, data);
console.log('saved', data.length);
console.log([...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
