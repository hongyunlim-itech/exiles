// Winter: step to Early Winter, save winter.sav; roof-snow vs ground-snow close-ups at several covers; snowfall.
import { open } from './lib.mjs';
import fs from 'node:fs';

const { browser, page, logs, shot } = await open();
await page.evaluate(() => window.__noToasts());
if (!fs.existsSync('dev/qa-artdir/winter.sav')) {
  await page.evaluate(async () => { const t = window.__app.game.state.time; await window.__step(((9 - t.month) + 0.5 - t.monthProgress) * 60); });
  fs.writeFileSync('dev/qa-artdir/winter.sav', await page.evaluate(() => window.__app.game.save()));
} else {
  // reload from winter save
  const data = fs.readFileSync('dev/qa-artdir/winter.sav', 'utf8');
  await page.evaluate((d) => { localStorage.setItem('exiles.save.qa', d); window.__app.loadGame('qa'); window.__app.setSpeed(0); }, data);
}
const w = await page.evaluate(() => { const s = window.__app.game.state; return { month: s.time.month, snow: s.weather.snow, t: s.weather.temperature, p: s.weather.precipitation }; });
console.log('winter state', JSON.stringify(w));
const spots = await page.evaluate(() => {
  const pick = (t, i = 0) => { const b = window.__b(t, i); return b ? { x: b.x + b.w / 2, z: b.z + b.h / 2, yaw: window.__frontYaw(b) } : null; };
  return { house: pick('woodenHouse', 2), barn: pick('storageBarn', 0), stoneHouse: pick('stoneHouse', 0), chapel: pick('chapel', 0), tp: pick('tradingPost', 0) };
});
await page.evaluate(() => { const s = window.__app.game.state; s.time.dayTime = 0.45; s.weather.precipitation = 'none'; s.weather.precipIntensity = 0; });
for (const cover of [0.12, 0.33, 0.6, 1.0]) {
  await page.evaluate((cv) => { window.__app.game.state.weather.snow = cv; }, cover);
  await page.evaluate(() => window.__frames(25));
  await page.evaluate((p) => window.__look(p.x, p.z, 10, 0.5, p.yaw), spots.house);
  await page.evaluate(() => window.__frames(6));
  await shot(`snow_${cover}_house_d10`);
  await page.evaluate((p) => window.__look(p.x, p.z, 12, 0.6, p.yaw + 0.5), spots.barn);
  await page.evaluate(() => window.__frames(6));
  await shot(`snow_${cover}_barn_d12`);
  await page.evaluate((p) => window.__look(p.x, p.z, 28, 0.75, p.yaw + 0.3), spots.house);
  await page.evaluate(() => window.__frames(6));
  await shot(`snow_${cover}_street_d28`);
}
// snowfall (precipitation) at natural cover, close and far
await page.evaluate((sn) => { const s = window.__app.game.state; s.weather.snow = sn; s.weather.precipitation = 'snow'; s.weather.precipIntensity = 1; }, w.snow);
for (const [d, p] of [[12, 0.4], [40, 0.8], [110, 0.9]]) {
  await page.evaluate(([pp, dd, pt]) => window.__look(pp.x, pp.z, dd, pt, pp.yaw), [spots.house, d, p]);
  await page.evaluate(() => window.__frames(30));
  await shot(`snowfall_d${d}`);
}
console.log('logs', [...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
