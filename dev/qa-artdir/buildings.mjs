// Close-ups of every building type (front 3/4 and back 3/4) at noon, clear weather, no toasts.
import { open } from './lib.mjs';

const { browser, page, logs, shot } = await open();
await page.evaluate(() => { window.__noToasts(); const s = window.__app.game.state; s.time.dayTime = 0.42; s.weather.precipitation = 'none'; s.weather.precipIntensity = 0; });
const list = await page.evaluate(() => {
  const seen = new Set(); const out = [];
  for (const b of window.__app.game.state.buildings) {
    if (b.state !== 'active' || seen.has(b.type)) continue;
    seen.add(b.type);
    out.push({ id: b.id, type: b.type, x: b.x + b.w / 2, z: b.z + b.h / 2, w: b.w, h: b.h, rot: b.rotation });
  }
  return out;
});
console.log(list.map((b) => b.type).join(','));
for (const b of list) {
  const dist = Math.max(9, Math.max(b.w, b.h) * 2.2 + 5);
  await page.evaluate(([bb, d]) => { const B = window.__app.game.getBuilding(bb.id); window.__look(bb.x, bb.z, d, 0.42, window.__frontYaw(B, 0.6)); }, [b, dist]);
  await page.evaluate(() => window.__frames(12));
  await shot(`bld_${b.type}_front`);
  await page.evaluate(([bb, d]) => { const B = window.__app.game.getBuilding(bb.id); window.__look(bb.x, bb.z, d, 0.55, window.__frontYaw(B, Math.PI + 0.7)); }, [b, dist]);
  await page.evaluate(() => window.__frames(12));
  await shot(`bld_${b.type}_back`);
}
console.log('logs', [...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
