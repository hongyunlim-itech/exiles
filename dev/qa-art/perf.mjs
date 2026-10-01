// Per-pass / per-layer draw-call & triangle attribution at several zoom levels.
import { open } from './lib.mjs';

const quality = process.argv[2] ?? 'high';
const { browser, page, logs } = await open({ settings: { quality, shadows: true } });
await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.45; });
const c = await page.evaluate(() => window.__app.game.townCenter());
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
    const pass = scene === null ? 'shadow' : 'main';
    let top = object; while (top.parent && top.parent !== R.scene) top = top.parent;
    let key = (top.name || top.type);
    if (key === 'buildings-root') key += object.isInstancedMesh ? '/inst' : '/mesh';
    const k = pass + ':' + key;
    A[k] ??= { calls: 0, tris: 0 };
    A[k].calls += glr.info.render.calls - c0; A[k].tris += glr.info.render.triangles - t0;
  };
});
const views = [
  ['d8', 8, 0.5], ['d15', 15, 0.6], ['d30', 30, 0.75], ['d60', 60, 0.85], ['d90', 90, 0.9], ['d120', 120, 0.95], ['d120low', 120, 0.49],
];
for (const [name, d, p] of views) {
  await page.evaluate(([x, z, dd, pp]) => window.__look(x, z, dd, pp, 0.6), [c.x, c.z, d, p]);
  await page.evaluate(() => window.__frames(4));
  const r = await page.evaluate(async () => {
    window.__attr = {};
    await window.__frames(1);
    const a = window.__attr; window.__attr = null;
    const st = window.__stats();
    const tot = { main: { calls: 0, tris: 0 }, shadow: { calls: 0, tris: 0 } };
    for (const [k, v] of Object.entries(a)) { const p = k.split(':')[0]; tot[p].calls += v.calls; tot[p].tris += v.tris; }
    return { st, tot, a };
  });
  console.log(`== ${name} (${quality}) info:`, JSON.stringify(r.st), 'passes:', JSON.stringify(r.tot));
  const rows = Object.entries(r.a).sort((x, y) => y[1].tris - x[1].tris);
  for (const [k, v] of rows) console.log('   ', k.padEnd(34), String(v.calls).padStart(4), 'calls', String(v.tris).padStart(9), 'tris');
}
// terrain + nature geometry facts
const facts = await page.evaluate(() => {
  const R = window.__app.renderer;
  const out = { terrain: [], natureInst: R.nature.instanceCount, treesByLod: {} };
  R.scene.traverse((o) => {
    if (o.isMesh && !o.isInstancedMesh) {
      let top = o; while (top.parent && top.parent !== R.scene) top = top.parent;
      if (top.name === 'terrain' || top.name === 'water') out.terrain.push({ name: o.name || top.name, tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3, verts: o.geometry.attributes.position.count, cast: o.castShadow });
    }
  });
  const s = window.__app.game.state;
  let trees = 0, rocks = 0; for (let i = 0; i < s.W * s.H; i++) { if (s.tiles.feature[i] === 1) trees++; else if (s.tiles.feature[i]) rocks++; }
  out.trees = trees; out.rocksIron = rocks; out.W = s.W; out.H = s.H;
  out.citizens = s.citizens.length; out.animals = s.animals.length; out.buildings = s.buildings.length;
  return out;
});
console.log(JSON.stringify(facts, null, 1));
console.log(logs.slice(0, 10).join('\n'));
await browser.close();
