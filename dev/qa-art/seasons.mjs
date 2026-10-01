// Seasons: advance the sim month by month and capture town / field / orchard / pasture views at noon.
import { open } from './lib.mjs';

const { browser, page, logs, shot } = await open();
const c = await page.evaluate(() => window.__app.game.townCenter());
const info = [];
for (let m = 0; m < 12; m++) {
  if (m > 0) await page.evaluate(() => window.__step(60));
  const st = await page.evaluate(() => {
    const s = window.__app.game.state;
    const w = s.weather;
    const r = { year: s.time.year, month: s.time.month, temp: +w.temperature.toFixed(1), snow: +w.snow.toFixed(2), precip: w.precipitation };
    w.precipitation = 'none'; w.precipIntensity = 0;
    s.time.dayTime = 0.45;
    return r;
  });
  const tag = `s${String(m).padStart(2, '0')}_y${st.year}m${st.month}`;
  info.push({ tag, ...st });
  console.log(JSON.stringify({ tag, ...st }));
  await page.evaluate(([x, z]) => window.__look(x, z, 34, 0.72, 0.6), [c.x, c.z]);
  await page.evaluate(() => window.__frames(4));
  await shot(`${tag}_town`);
  for (const [t, d, p, y] of [['cropField', 16, 0.55, 0.5], ['orchard', 16, 0.5, 1.0], ['pasture', 15, 0.5, 2.0]]) {
    await page.evaluate(([tt, dd, pp, yy]) => { const b = window.__b(tt, 0); if (b) window.__lookB(b, dd, pp, yy); }, [t, d, p, y]);
    await page.evaluate(() => window.__frames(3));
    await shot(`${tag}_${t}`);
  }
}
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
