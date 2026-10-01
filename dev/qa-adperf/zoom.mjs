// Zoom sweep: screenshots + renderer.info + per-layer CPU timing + scene breakdown at each distance.
// Usage: node dev/qa-adperf/zoom.mjs [quality] [shadows]
import { open, writeJSON } from './lib.mjs';

const quality = process.argv[2] ?? 'high';
const shadows = (process.argv[3] ?? 'on') === 'on';
const tag = `${quality}${shadows ? '' : '_noshadow'}`;
const { browser, page, logs, shot } = await open({ settings: { quality, shadows } });
await page.evaluate(() => { window.__noToasts(true); const g = window.__app.game; g.state.time.dayTime = 0.45; });
const c = await page.evaluate(() => window.__app.game.townCenter());
const out = { quality, shadows };
const views = [[8, 0.5], [16, 0.7], [30, 0.8], [50, 0.9], [80, 0.95], [120, 1.0], [120, 0.55], [120, 1.35]];
for (const [d, p] of views) {
  await page.evaluate(([x, z, dd, pp]) => window.__look(x, z, dd, pp, 0.6), [c.x, c.z, d, p]);
  await page.evaluate(() => window.__frames(20));
  const actual = await page.evaluate(() => { const cc = window.__app.renderer.cameraController; return { dist: cc.distance, pitch: cc.pitch ?? cc.goal.pitch }; });
  const timing = await page.evaluate(() => window.__measure(20));
  const stats = await page.evaluate(() => window.__stats());
  const bd = await page.evaluate(() => window.__breakdown());
  const key = `d${d}_p${p}`;
  out[key] = { actual, stats, timing, breakdown: bd };
  console.log(key, JSON.stringify(actual), JSON.stringify(stats), JSON.stringify(timing));
  await shot(`zoom_${tag}_${key}`);
}
// renderer shadow config
out.shadow = await page.evaluate(() => {
  const R = window.__app.renderer;
  let light = null;
  R.scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow) light = o; });
  if (!light) return null;
  const cam = light.shadow.camera;
  return { mapSize: light.shadow.mapSize.x, box: [cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far], bias: light.shadow.bias, normalBias: light.shadow.normalBias, radius: light.shadow.radius, type: R.renderer.shadowMap.type, pixelRatio: R.renderer.getPixelRatio() };
});
console.log('shadow', JSON.stringify(out.shadow));
writeJSON(`zoom_${tag}.json`, out);
console.log([...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
