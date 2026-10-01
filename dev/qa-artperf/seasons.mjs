// One year of monthly captures (noon, clear): town, crop field, orchard, pasture, forest, house close-up.
import { open } from './lib.mjs';

const { browser, page, logs, shot } = await open();
await page.evaluate(() => window.__noToasts());
const c = await page.evaluate(() => window.__app.game.townCenter());
// pick a deciduous-rich forest spot near town
const forest = await page.evaluate(([cx, cz]) => {
  const s = window.__app.game.state; let best = null; let bs = -1;
  for (let z = 10; z < s.H - 10; z += 3) for (let x = 10; x < s.W - 10; x += 3) {
    const d = Math.hypot(x - cx, z - cz); if (d > 45 || d < 15) continue;
    let n = 0; for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) { const i = (z + dz) * s.W + x + dx; if (s.tiles.feature[i] === 1 && (s.tiles.variant?.[i] ?? 1) % 3 !== 0) n++; }
    if (n > bs) { bs = n; best = { x, z }; }
  }
  return best;
}, [c.x, c.z]);
console.log('forest', JSON.stringify(forest));
for (let m = 0; m < 12; m++) {
  if (m > 0) await page.evaluate(() => window.__step(60));
  const info = await page.evaluate(() => { const s = window.__app.game.state; s.time.dayTime = 0.45; const w = s.weather; const r = { y: s.time.year, m: s.time.month, temp: +w.temperature.toFixed(1), snow: +w.snow.toFixed(2), precip: w.precipitation }; w.precipitation = 'none'; w.precipIntensity = 0; return r; });
  const tag = `s${String(m).padStart(2, '0')}_y${info.y}m${info.m}`;
  console.log(tag, JSON.stringify(info));
  const views = [
    ['town', null, 44, 0.8, 0.6],
    ['cropField', 'cropField', 16, 0.55, 0.9],
    ['orchard', 'orchard', 14, 0.5, 0.4],
    ['pasture', 'pasture', 13, 0.5, 2.0],
    ['forest', 'forest', 18, 0.42, 1.2],
    ['house', 'woodenHouse', 11, 0.42, 0.7],
  ];
  for (const [name, type, d, p, yaw] of views) {
    const ok = await page.evaluate(([type, d, p, yaw, cx, cz, f]) => {
      if (!type) { window.__look(cx, cz, d, p, yaw); return true; }
      if (type === 'forest') { window.__look(f.x, f.z, d, p, yaw); return true; }
      const b = window.__b(type, 0); if (!b) return false; window.__lookB(b, d, p, yaw); return true;
    }, [type, d, p, yaw, c.x, c.z, forest]);
    if (!ok) continue;
    await page.evaluate(() => window.__frames(4));
    await shot(`${tag}_${name}`);
  }
}
console.log([...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
