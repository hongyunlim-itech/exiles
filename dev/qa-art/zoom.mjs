// Zoom-level sweep: screenshots + renderer.info + CPU timings per layer.
import { open } from './lib.mjs';

const { browser, page, logs, shot } = await open();
await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.45; });
const c = await page.evaluate(() => window.__app.game.townCenter());
console.log('center', c);
const results = [];
const views = [
  ['z01_d8', 8, 0.5], ['z02_d15', 15, 0.6], ['z03_d30', 30, 0.75], ['z04_d45', 45, 0.8], ['z05_d60', 60, 0.85],
  ['z06_d90', 90, 0.9], ['z07_d120', 120, 0.95], ['z08_d120_lowpitch', 120, 0.49], ['z09_d120_top', 120, 1.39],
];
for (const [name, d, p] of views) {
  await page.evaluate(([x, z, dd, pp]) => window.__look(x, z, dd, pp, 0.6), [c.x, c.z, d, p]);
  await page.evaluate(() => window.__frames(20));
  const m = await page.evaluate(() => window.__measure(20));
  const st = await page.evaluate(() => window.__stats());
  await shot(name);
  results.push({ name, d, pitch: p, ...st, cpu: m });
}
for (const r of results) console.log(JSON.stringify(r));
// scene composition at the widest view
await page.evaluate(([x, z]) => window.__look(x, z, 120, 0.49, 0.6), [c.x, c.z]);
await page.evaluate(() => window.__frames(10));
const comp = await page.evaluate(() => {
  const R = window.__app.renderer;
  const cam = R.camera;
  const THREE_frustum = null;
  const out = {};
  let total = 0;
  R.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isPoints && !o.isLine) return;
    if (!o.visible) return;
    // check ancestors visible
    let p = o.parent; while (p) { if (!p.visible) return; p = p.parent; }
    const g = o.geometry; if (!g) return;
    const idx = g.index ? g.index.count : g.attributes.position.count;
    const inst = o.isInstancedMesh ? o.count : 1;
    const tris = (idx / 3) * inst;
    // top-level layer name
    let top = o; while (top.parent && top.parent !== R.scene) top = top.parent;
    const key = (top.name || top.type) + (o.isInstancedMesh ? ' [inst]' : '');
    out[key] ??= { objects: 0, tris: 0, castShadow: 0 };
    out[key].objects++; out[key].tris += tris; if (o.castShadow) out[key].castShadow++;
    total += tris;
  });
  return { total, out };
});
console.log('composition (all visible objects, before frustum culling):', JSON.stringify(comp, null, 1));
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
