// Weather: roof snow vs ground snow at several covers, snowfall, rain; close/mid/far.
import { open, DIR } from './lib.mjs';

const mode = process.argv[2] ?? 'snow';
const save = mode === 'rain' ? `${DIR}/summer.sav` : `${DIR}/winter.sav`;
const { browser, page, logs, shot } = await open({ save });
await page.evaluate(() => window.__noToasts());
const spots = await page.evaluate(() => {
  const pick = (t, i = 0) => { const b = window.__b(t, i); return b ? { x: b.x + b.w / 2, z: b.z + b.h / 2, yaw: window.__frontYaw(b) } : null; };
  const c = window.__app.game.townCenter();
  return { c: { x: c.x, z: c.z, yaw: 0.6 }, house: pick('woodenHouse', 2), barn: pick('storageBarn', 0), stone: pick('stoneHouse', 0), chapel: pick('chapel', 0), market: pick('market', 0) };
});
const L = async (p, d, pitch, yawOff = 0, n = 8) => { await page.evaluate(([pp, dd, pt, yo]) => window.__look(pp.x, pp.z, dd, pt, pp.yaw + yo), [p, d, pitch, yawOff]); await page.evaluate((k) => window.__frames(k), n); };
if (mode === 'snow') {
  await page.evaluate(() => { const s = window.__app.game.state; s.time.dayTime = 0.45; s.weather.precipitation = 'none'; s.weather.precipIntensity = 0; });
  for (const cover of [0.1, 0.3, 0.6, 1.0]) {
    await page.evaluate((cv) => { window.__app.game.state.weather.snow = cv; }, cover);
    await page.evaluate(() => window.__frames(90)); // let the terrain's eased snow settle
    const vis = await page.evaluate(() => ({ terrain: +window.__app.renderer.terrain.snowCover.toFixed(2), sim: window.__app.game.state.weather.snow }));
    console.log('cover', cover, JSON.stringify(vis));
    await L(spots.house, 9, 0.5, 0.2); await shot(`snow_${cover}_house_d9`);
    await L(spots.stone, 10, 0.55, 0.4); await shot(`snow_${cover}_stone_d10`);
    await L(spots.c, 30, 0.75, 0); await shot(`snow_${cover}_street_d30`);
  }
  // mismatch: jump snow from 0 to 0.6 and capture after a few frames (roofs instant vs eased ground)
  await page.evaluate(() => { window.__app.game.state.weather.snow = 0; });
  await page.evaluate(() => window.__frames(120));
  await page.evaluate(() => { window.__app.game.state.weather.snow = 0.6; });
  await L(spots.house, 14, 0.55, 0.2, 3);
  console.log('jump', JSON.stringify(await page.evaluate(() => ({ terrain: +window.__app.renderer.terrain.snowCover.toFixed(2), sim: window.__app.game.state.weather.snow }))));
  await shot('snow_jump_0_to_0.6_after3frames');
  // snowfall
  await page.evaluate(() => { const s = window.__app.game.state; s.weather.snow = 0.5; s.weather.precipitation = 'snow'; s.weather.precipIntensity = 1; });
  for (const [d, p] of [[10, 0.35], [40, 0.8], [110, 0.95]]) { await L(spots.house, d, p, 0, 30); await shot(`snowfall_d${d}`); }
  // snowfall at night
  await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.95; });
  await L(spots.house, 25, 0.6, 0, 30); await shot('snowfall_night_d25');
} else {
  await page.evaluate(() => { const s = window.__app.game.state; s.time.dayTime = 0.45; s.weather.precipitation = 'rain'; s.weather.precipIntensity = 1; });
  for (const [d, p] of [[10, 0.35], [40, 0.8], [110, 0.95]]) { await L(spots.house, d, p, 0, 40); await shot(`rain_d${d}`); }
  await page.evaluate(() => { const s = window.__app.game.state; s.weather.precipIntensity = 0.3; });
  await L(spots.c, 30, 0.7, 0, 40); await shot('rain_light_d30');
  await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.92; window.__app.game.state.weather.precipIntensity = 1; });
  await L(spots.house, 25, 0.6, 0, 40); await shot('rain_night_d25');
}
console.log('logs', [...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
