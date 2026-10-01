// Seasonal captures: step the sim month by month from the save; at mid-month noon (precip cleared for clarity)
// capture the town, a crop field, orchard, pasture and a forest patch. Saves a winter snapshot for later scripts.
import fs from 'node:fs';
import { open, DIR } from './lib.mjs';

const { browser, page, logs, shot } = await open();
await page.evaluate(() => window.__noToasts());
const spots = await page.evaluate(() => {
  const g = window.__app.game; const s = g.state; const c = g.townCenter();
  const pick = (t, i = 0) => { const b = window.__b(t, i); return b ? { x: b.x + b.w / 2, z: b.z + b.h / 2, yaw: window.__frontYaw(b) } : null; };
  let best = null; let bn = -1;
  for (let z = 4; z < s.H - 4; z += 2) for (let x = 4; x < s.W - 4; x += 2) {
    const d = Math.hypot(x - c.x, z - c.z); if (d < 14 || d > 45) continue;
    let n = 0; for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) { const i = (z + dz) * s.W + x + dx; if (s.tiles.feature[i] === 1) n++; }
    if (n > bn) { bn = n; best = { x: x + 0.5, z: z + 0.5, yaw: 0.6 }; }
  }
  const fields = s.buildings.filter((b) => b.type === 'cropField').map((b) => ({ id: b.id, crop: b.crop, x: b.x + b.w / 2, z: b.z + b.h / 2, yaw: 0.5 }));
  return { c: { x: c.x, z: c.z, yaw: 0.6 }, fields, orchard: pick('orchard', 0), orchard2: pick('orchard', 1), pasture: pick('pasture', 0), pasture2: pick('pasture', 1), pasture3: pick('pasture', 2), forest: best };
});
console.log(JSON.stringify(spots));
const names = ['EarlySpring', 'Spring', 'LateSpring', 'EarlySummer', 'Summer', 'LateSummer', 'EarlyAutumn', 'Autumn', 'LateAutumn', 'EarlyWinter', 'Winter', 'LateWinter'];
const log = [];
const L = async (p, d, pitch, n = 12) => { await page.evaluate(([pp, dd, pt]) => window.__look(pp.x, pp.z, dd, pt, pp.yaw), [p, d, pitch]); await page.evaluate((k) => window.__frames(k), n); };
const capture = async (tag, full) => {
  await page.evaluate(() => { const g = window.__app.game.state; g.time.dayTime = 0.5; g.weather.precipitation = 'none'; g.weather.precipIntensity = 0; });
  await L(spots.c, 55, 0.85, 40); await shot(`season_${tag}_town`);
  if (!full) return;
  const f = spots.fields[0]; if (f) { await L(f, 16, 0.55); await shot(`season_${tag}_field_${f.crop}`); }
  const f2 = spots.fields[1]; if (f2) { await L(f2, 16, 0.55); await shot(`season_${tag}_field_${f2.crop}`); }
  if (spots.orchard) { await L(spots.orchard, 14, 0.55); await shot(`season_${tag}_orchard`); }
  if (spots.pasture) { await L(spots.pasture, 14, 0.55); await shot(`season_${tag}_pasture`); }
  if (spots.forest) { await L(spots.forest, 22, 0.5); await shot(`season_${tag}_forest`); }
};
for (let k = 0; k < 12; k++) {
  await page.evaluate(async () => { const t = window.__app.game.state.time; const need = (0.5 - t.monthProgress) * 60; if (need > 0) await window.__step(need); });
  const w = await page.evaluate(() => {
    const s = window.__app.game.state;
    const fields = s.buildings.filter((b) => b.type === 'cropField').map((b) => b.crop + ':' + (b.tiles ? '' : '') + JSON.stringify(b.farm ?? b.cropStage ?? null).slice(0, 60));
    return { month: s.time.month, year: s.time.year, snow: +s.weather.snow.toFixed(2), temp: +s.weather.temperature.toFixed(1), precip: s.weather.precipitation, fields };
  });
  log.push(w);
  console.log('month', JSON.stringify(w));
  const full = [0, 2, 4, 5, 7, 8, 10].includes(w.month);
  await capture(`${String(k).padStart(2, '0')}_${names[w.month]}`, full);
  if (w.month === 10 && !fs.existsSync(`${DIR}/winter.sav`)) fs.writeFileSync(`${DIR}/winter.sav`, await page.evaluate(() => window.__app.game.save()));
  if (w.month === 3 && !fs.existsSync(`${DIR}/summer.sav`)) fs.writeFileSync(`${DIR}/summer.sav`, await page.evaluate(() => window.__app.game.save()));
  await page.evaluate(async () => { const t = window.__app.game.state.time; await window.__step((1 - t.monthProgress) * 60 + 0.5); });
}
console.log(JSON.stringify(log));
console.log('logs', [...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
