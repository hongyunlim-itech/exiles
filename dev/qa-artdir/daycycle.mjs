// Time-of-day captures (clear weather, summer): town overview + house close-up at night/dawn/noon/dusk.
import { open } from './lib.mjs';

const { browser, page, logs, shot } = await open();
await page.evaluate(() => { window.__noToasts(); const w = window.__app.game.state.weather; w.precipitation = 'none'; w.precipIntensity = 0; });
const c = await page.evaluate(() => { const c = window.__app.game.townCenter(); return { x: c.x, z: c.z }; });
const house = await page.evaluate(() => { const b = window.__b('woodenHouse', 2); return { x: b.x + b.w / 2, z: b.z + b.h / 2, yaw: window.__frontYaw(b) }; });
const info = [];
for (const [name, t] of [['midnight', 0.0], ['predawn', 0.2], ['dawn', 0.26], ['morning', 0.33], ['noon', 0.5], ['afternoon', 0.64], ['dusk', 0.74], ['twilight', 0.79], ['night', 0.88]]) {
  await page.evaluate((tt) => { window.__app.game.state.time.dayTime = tt; }, t);
  await page.evaluate(([x, z]) => window.__look(x, z, 48, 0.85, 0.6), [c.x, c.z]);
  await page.evaluate(() => window.__frames(40));
  const d = await page.evaluate(() => ({ daylight: +window.__app.renderer.sky.daylight.toFixed(3) }));
  info.push({ name, t, ...d });
  await shot(`day_${name}_town`);
  await page.evaluate(([x, z, y]) => window.__look(x, z, 14, 0.45, y), [house.x, house.z, house.yaw]);
  await page.evaluate(() => window.__frames(20));
  await shot(`day_${name}_house`);
}
// average screen luminance per time of day (canvas readback via screenshot of the webgl canvas)
console.log(JSON.stringify(info));
console.log('logs', [...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
