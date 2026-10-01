// Time-of-day sweep and weather (rain/snow) at several zooms. Summer save (Y5 M4).
import { open } from './lib.mjs';

const { browser, page, logs, shot } = await open();
await page.evaluate(() => { window.__noToasts(); const s = window.__app.game.state; s.weather.precipitation = 'none'; s.weather.precipIntensity = 0; });
const c = await page.evaluate(() => window.__app.game.townCenter());
const times = [['t0_midnight', 0.0], ['t1_predawn', 0.2], ['t2_dawn', 0.26], ['t3_morning', 0.35], ['t4_noon', 0.5], ['t5_afternoon', 0.63], ['t6_dusk', 0.74], ['t7_evening', 0.8], ['t8_night', 0.9]];
for (const [name, t] of times) {
  await page.evaluate((tt) => { window.__app.game.state.time.dayTime = tt; }, t);
  for (const [d, p] of [[34, 0.72], [14, 0.45]]) {
    if (d === 14 && !['t0_midnight', 't2_dawn', 't4_noon', 't6_dusk', 't8_night'].includes(name)) continue;
    await page.evaluate(([x, z, dd, pp]) => window.__look(x + 3, z - 2, dd, pp, 0.6), [c.x, c.z, d, p]);
    await page.evaluate(() => window.__frames(4));
    const info = await page.evaluate(() => { const R = window.__app.renderer; const sk = R.sky; return { daylight: +sk.daylight.toFixed(2), sun: +sk.sun.intensity.toFixed(2), hemi: +sk.hemi.intensity.toFixed(2), fog: '#' + sk.fog.color.getHexString() }; });
    console.log(name, d, JSON.stringify(info));
    await shot(`${name}_d${d}`);
  }
}
// weather: rain and snowfall, noon & night, several zooms
for (const [kind, temp] of [['rain', 12], ['snow', -6]]) {
  for (const [tname, t] of [['noon', 0.5], ['night', 0.92]]) {
    await page.evaluate(([k, tt, tp]) => { const s = window.__app.game.state; s.weather.precipitation = k; s.weather.precipIntensity = 1; s.weather.temperature = tp; s.time.dayTime = tt; s.weather.snow = k === 'snow' ? 0.6 : 0; }, [kind, t, temp]);
    for (const [d, p] of [[12, 0.4], [30, 0.7], [100, 0.9]]) {
      await page.evaluate(([x, z, dd, pp]) => window.__look(x + 3, z - 2, dd, pp, 0.6), [c.x, c.z, d, p]);
      await page.evaluate(() => window.__frames(8));
      await shot(`w_${kind}_${tname}_d${d}`);
    }
  }
}
await page.evaluate(() => { const s = window.__app.game.state; s.weather.precipitation = 'none'; s.weather.precipIntensity = 0; s.weather.snow = 0; });
console.log([...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
