// Zoom-level sweep: screenshots + renderer.info + per-pass/per-layer attribution + CPU timings.
// Usage: node dev/qa-artperf/zoom.mjs [quality]
import { open } from './lib.mjs';

const quality = process.argv[2] ?? 'high';
const { browser, page, logs, shot } = await open({ settings: { quality, shadows: true } });
await page.evaluate(() => { const s = window.__app.game.state; s.time.dayTime = 0.45; s.weather.precipitation = 'none'; s.weather.precipIntensity = 0; window.__noToasts(); });
const c = await page.evaluate(() => window.__app.game.townCenter());
console.log('center', JSON.stringify(c));
await page.evaluate(() => {
  const R = window.__app.renderer;
  const glr = R.renderer;
  const orig = glr.renderBufferDirect;
  window.__attr = null;
  glr.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    const A = window.__attr;
    if (!A) return orig.call(this, camera, scene, geometry, material, object, group);
    const t0 = glr.info.render.triangles; const c0 = glr.info.render.calls;
    orig.call(this, camera, scene, geometry, material, object, group);
    const pass = scene === null || camera.isOrthographicCamera ? 'shadow' : 'main';
    let top = object; while (top.parent && top.parent !== R.scene) top = top.parent;
    let key = (top.name || top.type);
    key += object.isInstancedMesh ? '/inst' : '/mesh';
    const k = pass + ':' + key;
    A[k] ??= { calls: 0, tris: 0 };
    A[k].calls += glr.info.render.calls - c0; A[k].tris += glr.info.render.triangles - t0;
  };
});
const views = [
  ['z01_d8', 8, 0.35], ['z02_d15', 15, 0.55], ['z03_d30', 30, 0.75], ['z04_d45', 45, 0.8], ['z05_d60', 60, 0.85],
  ['z06_d90', 90, 0.9], ['z07_d120', 120, 0.95], ['z08_d120_lowpitch', 120, 0.49], ['z09_d120_top', 120, 1.39],
];
const results = [];
for (const [name, d, p] of views) {
  await page.evaluate(([x, z, dd, pp]) => window.__look(x, z, dd, pp, 0.6), [c.x, c.z, d, p]);
  await page.evaluate(() => window.__frames(12));
  const r = await page.evaluate(async () => {
    window.__attr = {};
    await window.__frames(1);
    const a = window.__attr; window.__attr = null;
    const st = window.__stats();
    const tot = { main: { calls: 0, tris: 0 }, shadow: { calls: 0, tris: 0 } };
    for (const [k, v] of Object.entries(a)) { const p = k.split(':')[0]; tot[p].calls += v.calls; tot[p].tris += v.tris; }
    return { st, tot, a };
  });
  const m = await page.evaluate(() => window.__measure(20));
  await shot(`${name}_${quality}`);
  console.log(`== ${name} (${quality}) info:`, JSON.stringify(r.st), 'passes:', JSON.stringify(r.tot), 'cpu ms/frame:', JSON.stringify(m));
  const rows = Object.entries(r.a).sort((x, y) => y[1].tris - x[1].tris);
  for (const [k, v] of rows) console.log('   ', k.padEnd(34), String(v.calls).padStart(4), 'calls', String(v.tris).padStart(9), 'tris');
  results.push({ name, d, p, ...r.st, cpu: m });
}
// scene composition at widest view (before culling)
const comp = await page.evaluate(() => {
  const R = window.__app.renderer;
  const out = {};
  let total = 0;
  R.scene.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    if (!o.visible) return;
    let p = o.parent; while (p) { if (!p.visible) return; p = p.parent; }
    const g = o.geometry; if (!g) return;
    const idx = g.index ? g.index.count : g.attributes.position.count;
    const inst = o.isInstancedMesh ? o.count : 1;
    const tris = (idx / 3) * inst;
    let top = o; while (top.parent && top.parent !== R.scene) top = top.parent;
    const key = (top.name || top.type) + (o.isInstancedMesh ? ' [inst]' : '');
    out[key] ??= { objects: 0, tris: 0, castShadow: 0, frustumCulledOff: 0 };
    out[key].objects++; out[key].tris += tris; if (o.castShadow) out[key].castShadow++; if (!o.frustumCulled) out[key].frustumCulledOff++;
    total += tris;
  });
  const s = window.__app.game.state;
  let trees = 0, rocks = 0; for (let i = 0; i < s.W * s.H; i++) { if (s.tiles.feature[i] === 1) trees++; else if (s.tiles.feature[i]) rocks++; }
  return { total, out, trees, rocks, W: s.W, H: s.H, citizens: s.citizens.length, animals: s.animals.length, buildings: s.buildings.length, pr: R.renderer.getPixelRatio(), shadowMap: R.sky.sun.shadow.mapSize.x };
});
console.log('composition:', JSON.stringify(comp, null, 1));
console.log([...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
