// Time of day + precipitation captures.
import { open } from './lib.mjs';

const { browser, page, logs, shot } = await open();
const c = await page.evaluate(() => window.__app.game.townCenter());
await page.evaluate(() => { const w = window.__app.game.state.weather; w.precipitation = 'none'; w.precipIntensity = 0; });
const times = [['t0_midnight', 0.0], ['t1_predawn', 0.2], ['t2_dawn', 0.26], ['t3_morning', 0.35], ['t4_noon', 0.5], ['t5_afternoon', 0.65], ['t6_dusk', 0.74], ['t7_evening', 0.8], ['t8_night', 0.9]];
for (const [n, t] of times) {
  await page.evaluate(([x, z, tt]) => { window.__app.game.state.time.dayTime = tt; window.__look(x, z, 34, 0.72, 0.6); }, [c.x, c.z, t]);
  await page.evaluate(() => window.__frames(6));
  const d = await page.evaluate(() => ({ daylight: window.__app.renderer.sky.daylight, sun: window.__app.renderer.sky.sun.intensity, hemi: window.__app.renderer.sky.hemi.intensity }));
  console.log(n, JSON.stringify(d));
  await shot(`${n}_d34`);
  if (t === 0.0 || t === 0.26 || t === 0.74 || t === 0.5) {
    await page.evaluate(([x, z]) => window.__look(x, z, 14, 0.45, 1.3), [c.x, c.z]);
    await page.evaluate(() => window.__frames(4));
    await shot(`${n}_d14`);
  }
}
// rain & snowfall (noon and night)
for (const [kind, dt] of [['rain', 0.5], ['rain', 0.02], ['snow', 0.5], ['snow', 0.02]]) {
  await page.evaluate(([x, z, k, tt]) => {
    const s = window.__app.game.state; const w = s.weather;
    w.precipitation = k; w.precipIntensity = 1; s.time.dayTime = tt;
    if (k === 'snow') { w.snow = 0.6; w.temperature = -4; } else { w.snow = 0; w.temperature = 12; }
    window.__look(x, z, 30, 0.6, 0.6);
  }, [c.x, c.z, kind, dt]);
  await page.evaluate(() => window.__frames(10));
  await shot(`w_${kind}_${dt === 0.5 ? 'noon' : 'night'}_d30`);
  await page.evaluate(([x, z]) => window.__look(x, z, 12, 0.4, 0.6), [c.x, c.z]);
  await page.evaluate(() => window.__frames(6));
  await shot(`w_${kind}_${dt === 0.5 ? 'noon' : 'night'}_d12`);
  await page.evaluate(([x, z]) => window.__look(x, z, 100, 0.8, 0.6), [c.x, c.z]);
  await page.evaluate(() => window.__frames(6));
  await shot(`w_${kind}_${dt === 0.5 ? 'noon' : 'night'}_d100`);
}
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
