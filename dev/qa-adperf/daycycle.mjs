// Day/night captures (summer + winter): town mid-zoom and a house close-up at several times of day;
// logs light intensities and average screen luminance.
import { open, DIR } from './lib.mjs';

const save = process.argv[2] ?? `${DIR}/summer.sav`;
const tag = process.argv[3] ?? 'summer';
const { browser, page, logs, shot } = await open({ save });
await page.evaluate(() => { window.__noToasts(); const s = window.__app.game.state; s.weather.precipitation = 'none'; s.weather.precipIntensity = 0; });
const spots = await page.evaluate(() => {
  const g = window.__app.game; const c = g.townCenter();
  const b = window.__b('woodenHouse', 3); const t = window.__b('tavern', 0);
  return { c: { x: c.x, z: c.z }, house: { x: b.x + b.w / 2, z: b.z + b.h / 2, yaw: window.__frontYaw(b) }, tavern: { x: t.x + t.w / 2, z: t.z + t.h / 2, yaw: window.__frontYaw(t) } };
});
const times = [['0.00_midnight', 0.0], ['0.18_predawn', 0.18], ['0.23_dawn', 0.23], ['0.28_sunrise', 0.28], ['0.36_morning', 0.36], ['0.50_noon', 0.5], ['0.64_afternoon', 0.64], ['0.72_dusk', 0.72], ['0.77_sunset', 0.77], ['0.83_twilight', 0.83], ['0.90_night', 0.9]];
const lum = async () => page.evaluate(() => {
  // average luminance of the canvas via readPixels-free 2D copy
  const src = window.__app.renderer.canvas;
  const cv = document.createElement('canvas'); cv.width = 160; cv.height = 90;
  const cx = cv.getContext('2d'); cx.drawImage(src, 0, 0, 160, 90);
  const d = cx.getImageData(0, 0, 160, 90).data; let s = 0; let mx = 0;
  for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; s += l; if (l > mx) mx = l; }
  return { avg: +(s / (d.length / 4)).toFixed(1), max: +mx.toFixed(0) };
});
for (const [name, t] of times) {
  await page.evaluate((tt) => { window.__app.game.state.time.dayTime = tt; }, t);
  await page.evaluate((c) => window.__look(c.x, c.z, 42, 0.8, 0.6), spots.c);
  await page.evaluate(() => window.__frames(25));
  const sky = await page.evaluate(() => { const st = window.__app.renderer.sky.state; return { daylight: +st.daylight.toFixed(2), sun: +st.lightIntensity.toFixed(2), hemi: +st.hemiIntensity.toFixed(2), shadow: +st.shadowStrength.toFixed(2) }; });
  await shot(`day_${tag}_${name}_town`);
  await page.evaluate((c) => window.__look(c.x, c.z, 12, 0.45, c.yaw + 0.3), spots.house);
  await page.evaluate(() => window.__frames(10));
  await shot(`day_${tag}_${name}_house`);
  console.log(name, JSON.stringify(sky));
}
console.log('logs', [...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
