// Render perf probe: at several camera views, split renderer.info into main pass vs shadow pass and measure
// per-layer contributions (toggle each scene child). Also sim CPU cost per game-second (phase breakdown).
// Usage: node dev/qa-adperf/perf.mjs [quality] [shadows]
import { open, writeJSON } from './lib.mjs';

const quality = process.argv[2] ?? 'high';
const shadows = (process.argv[3] ?? 'on') === 'on';
const { browser, page, logs } = await open({ settings: { quality, shadows } });
await page.evaluate(() => { window.__noToasts(true); window.__app.game.state.time.dayTime = 0.45; });
await page.evaluate(() => {
  const app = window.__app;
  const R = app.renderer;
  const glr = R.renderer;
  window.__frameInfo = () => ({ calls: glr.info.render.calls, tris: glr.info.render.triangles, points: glr.info.render.points, lines: glr.info.render.lines });
  window.__renderOnce = () => { R.render(0.016, 0); return window.__frameInfo(); };
  window.__split = () => {
    const total = window.__renderOnce();
    const au = glr.shadowMap.autoUpdate;
    glr.shadowMap.autoUpdate = false; glr.shadowMap.needsUpdate = false;
    const main = window.__renderOnce();
    glr.shadowMap.autoUpdate = au;
    const layers = {};
    for (const ch of R.scene.children) {
      if (!ch.visible) continue;
      const name = ch.name || ch.type;
      ch.visible = false;
      const t = window.__renderOnce();
      glr.shadowMap.autoUpdate = false; glr.shadowMap.needsUpdate = false;
      const m = window.__renderOnce();
      glr.shadowMap.autoUpdate = au;
      ch.visible = true;
      const dT = { calls: total.calls - t.calls, tris: total.tris - t.tris };
      const dM = { calls: main.calls - m.calls, tris: main.tris - m.tris };
      if (dT.calls || dT.tris) layers[name] = { main: dM, shadow: { calls: dT.calls - dM.calls, tris: dT.tris - dM.tris } };
    }
    return { total, main, shadow: { calls: total.calls - main.calls, tris: total.tris - main.tris }, layers };
  };
});
const c = await page.evaluate(() => window.__app.game.townCenter());
const out = { quality, shadows, views: {} };
const views = [[8, 0.5], [16, 0.7], [30, 0.8], [50, 0.9], [80, 0.95], [120, 1.0], [120, 0.55]];
for (const [d, p] of views) {
  await page.evaluate(([x, z, dd, pp]) => window.__look(x, z, dd, pp, 0.6), [c.x, c.z, d, p]);
  await page.evaluate(() => window.__frames(15));
  const split = await page.evaluate(() => window.__split());
  const timing = await page.evaluate(() => window.__measure(20));
  const key = `d${d}_p${p}`;
  out.views[key] = { split, timing };
  console.log(key, 'total', JSON.stringify(split.total), 'main', JSON.stringify(split.main), 'shadow', JSON.stringify(split.shadow));
  for (const [n, v] of Object.entries(split.layers)) console.log('   ', n.padEnd(16), 'main', JSON.stringify(v.main), 'shadow', JSON.stringify(v.shadow));
}
// geometry per-LOD triangle counts for trees & instanced entities
out.geo = await page.evaluate(() => {
  const R = window.__app.renderer;
  const res = {};
  const nat = R.nature;
  res.treeLods = nat.bases.map((lods) => lods.map((g) => (g.index ? g.index.count : g.attributes.position.count) / 3));
  res.natureLodState = nat.chunks.map((ch) => ch.sets.slice(0, 3).map((s) => (s ? `${s.lod}:${s.mesh.count}` : '-')).join(' '));
  // unique geometries in the scene with tri counts
  const seen = new Map();
  R.scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const top = (() => { let p = o; while (p.parent && p.parent !== R.scene) p = p.parent; return p.name || p.type; })();
    const k = top + ':' + (o.name || g.type);
    const e = seen.get(k) ?? { tris: t, count: 0, inst: 0 };
    e.count++; e.inst += o.isInstancedMesh ? o.count : 1;
    seen.set(k, e);
  });
  res.meshes = [...seen.entries()].sort((a, b) => b[1].tris * b[1].inst - a[1].tris * a[1].inst).slice(0, 40);
  return res;
});
console.log('treeLods', JSON.stringify(out.geo.treeLods));
console.log('lodState', JSON.stringify(out.geo.natureLodState));
for (const [k, v] of out.geo.meshes) console.log('  mesh', k, JSON.stringify(v));
// sim cost per game-second (phase breakdown), town as-is
out.sim = await page.evaluate(async () => {
  const g = window.__app.game;
  g.profile = {};
  const t0 = performance.now();
  const N = 120; // game seconds
  let steps = 0;
  const end = g.state.time.elapsed + N;
  while (g.state.time.elapsed < end) { g.step(1 / 30); steps++; if (steps % 300 === 0) await new Promise((r) => setTimeout(r, 0)); }
  const ms = performance.now() - t0;
  const prof = g.profile; g.profile = null;
  const per = {}; for (const [k, v] of Object.entries(prof)) per[k] = +(v / N).toFixed(3);
  return { msPerGameSecond: +(ms / N).toFixed(3), steps, perGameSecond: per, pop: g.state.citizens.length };
});
console.log('sim', JSON.stringify(out.sim));
writeJSON(`perf_${quality}${shadows ? '' : '_noshadow'}.json`, out);
console.log([...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
