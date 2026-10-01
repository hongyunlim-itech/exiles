// Seasonal captures: step the sim month by month; at mid-month (noon, precipitation off for clarity) capture the
// town overview, a crop field, orchard, pasture and a forest edge. Winter: roof-snow close-ups at several covers.
import { open } from './lib.mjs';

const { browser, page, logs, shot } = await open();
await page.evaluate(() => window.__noToasts());
const spots = await page.evaluate(() => {
  const g = window.__app.game; const s = g.state; const c = g.townCenter();
  const pick = (t, i = 0) => { const b = window.__b(t, i); return b ? { x: b.x + b.w / 2, z: b.z + b.h / 2, yaw: window.__frontYaw(b) } : null; };
  // densest deciduous/birch forest patch 12..40 tiles from the centre
  let best = null; let bn = -1;
  for (let z = 4; z < s.H - 4; z += 2) for (let x = 4; x < s.W - 4; x += 2) {
    const d = Math.hypot(x - c.x, z - c.z); if (d < 14 || d > 40) continue;
    let n = 0; for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) { const i = (z + dz) * s.W + x + dx; if (s.tiles.feature[i] === 1 && (s.tiles.variant?.[i] ?? 1) % 3 !== 0) n++; }
    if (n > bn) { bn = n; best = { x: x + 0.5, z: z + 0.5, yaw: 0.6 }; }
  }
  return { c: { x: c.x, z: c.z }, field: pick('cropField', 0), field2: pick('cropField', 1), orchard: pick('orchard', 0), pasture: pick('pasture', 0), pasture2: pick('pasture', 1), forest: best, house: pick('woodenHouse', 2), stoneHouse: pick('stoneHouse', 0), chapel: pick('chapel', 0) };
});
console.log(JSON.stringify(spots));
const names = ['EarlySpring', 'Spring', 'LateSpring', 'EarlySummer', 'Summer', 'LateSummer', 'EarlyAutumn', 'Autumn', 'LateAutumn', 'EarlyWinter', 'Winter', 'LateWinter'];
const log = [];
const clear = async () => page.evaluate(() => { const g = window.__app.game.state; g.time.dayTime = 0.5; g.weather.precipitation = 'none'; g.weather.precipIntensity = 0; });
const capture = async (tag) => {
  await clear();
  const L = (p, d, pitch) => page.evaluate(([pp, dd, pt]) => window.__look(pp.x, pp.z, dd, pt, pp.yaw), [p, d, pitch]);
  await L({ ...spots.c, yaw: 0.6 }, 50, 0.85); await page.evaluate(() => window.__frames(30)); await shot(`season_${tag}_town`);
  if (spots.field) { await L(spots.field, 15, 0.55); await page.evaluate(() => window.__frames(15)); await shot(`season_${tag}_field`); }
  if (spots.orchard) { await L(spots.orchard, 15, 0.55); await page.evaluate(() => window.__frames(15)); await shot(`season_${tag}_orchard`); }
  if (spots.pasture) { await L(spots.pasture, 15, 0.55); await page.evaluate(() => window.__frames(15)); await shot(`season_${tag}_pasture`); }
  if (spots.forest) { await L(spots.forest, 20, 0.5); await page.evaluate(() => window.__frames(15)); await shot(`season_${tag}_forest`); }
};
// month 4 now → go through a full year
let month = await page.evaluate(() => window.__app.game.state.time.month);
for (let k = 0; k < 12; k++) {
  // advance to mid-month of the current month
  await page.evaluate(async () => {
    const t = window.__app.game.state.time;
    const need = (0.5 - t.monthProgress) * 60;
    if (need > 0) await window.__step(need);
  });
  const w = await page.evaluate(() => { const s = window.__app.game.state; return { month: s.time.month, year: s.time.year, snow: +s.weather.snow.toFixed(2), temp: +s.weather.temperature.toFixed(1), precip: s.weather.precipitation }; });
  log.push(w);
  console.log('month', JSON.stringify(w));
  await capture(`${String(k).padStart(2, '0')}_${names[w.month]}`);
  if (w.month === 10) {
    // roof snow close-ups at natural cover, then forced covers
    for (const [nm, cover] of [['natural', null], ['0.25', 0.25], ['0.5', 0.5], ['1.0', 1.0]]) {
      if (cover !== null) await page.evaluate((cv) => { window.__app.game.state.weather.snow = cv; }, cover);
      await page.evaluate(() => window.__frames(90));
      await page.evaluate((p) => window.__look(p.x, p.z, 11, 0.5, p.yaw), spots.house);
      await page.evaluate(() => window.__frames(10));
      await shot(`snowroof_${nm}_house`);
      await page.evaluate((p) => window.__look(p.x, p.z, 26, 0.7, p.yaw + 0.4), spots.house);
      await page.evaluate(() => window.__frames(10));
      await shot(`snowroof_${nm}_street`);
      if (spots.stoneHouse) { await page.evaluate((p) => window.__look(p.x, p.z, 11, 0.5, p.yaw), spots.stoneHouse); await page.evaluate(() => window.__frames(10)); await shot(`snowroof_${nm}_stonehouse`); }
    }
    await page.evaluate((sn) => { window.__app.game.state.weather.snow = sn; }, w.snow);
  }
  // advance to the start of next month
  await page.evaluate(async () => { const t = window.__app.game.state.time; await window.__step((1 - t.monthProgress) * 60 + 0.5); });
}
console.log(JSON.stringify(log));
console.log('logs', [...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
