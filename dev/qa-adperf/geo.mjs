// Geometry inventory: tree LOD tri counts, per-mesh tris x instances, building visual tris.
import { open, writeJSON } from './lib.mjs';
const { browser, page, logs } = await open();
const c = await page.evaluate(() => window.__app.game.townCenter());
await page.evaluate(([x, z]) => window.__look(x, z, 8, 0.5, 0.6), [c.x, c.z]);
await page.evaluate(() => window.__frames(10));
const res = await page.evaluate(() => {
  const R = window.__app.renderer;
  const tri = (g) => (g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)) / 3;
  const res = {};
  const nat = R.nature;
  res.treeLods = nat.bases.map((lods) => lods.map(tri));
  res.natureLodState = nat.chunks.map((ch) => ch.sets.slice(0, 5).map((s) => (s ? `${s.lod}:${s.mesh.count}` : '-')).join(' '));
  const seen = new Map();
  R.scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const t = tri(g);
    const top = (() => { let p = o; while (p.parent && p.parent !== R.scene) p = p.parent; return p.name || p.type; })();
    const k = top + ':' + (o.name || (o.isInstancedMesh ? 'inst' : 'mesh')) + ':' + t;
    const e = seen.get(k) ?? { tris: t, meshes: 0, inst: 0, cast: o.castShadow, fc: o.frustumCulled };
    e.meshes++; e.inst += o.isInstancedMesh ? o.count : 1;
    seen.set(k, e);
  });
  res.meshes = [...seen.entries()].map(([k, v]) => ({ k, ...v, total: v.tris * v.inst })).sort((a, b) => b.total - a.total).slice(0, 45);
  // building visuals: tris per building type
  const bt = {};
  for (const b of window.__app.game.state.buildings) {
    const v = R.buildings.getVisual(b.id);
    if (!v) continue;
    let t = 0, m = 0;
    v.group.traverse((o) => { if (o.isMesh) { t += tri(o.geometry) * (o.isInstancedMesh ? o.count : 1); m++; } });
    const e = bt[b.type] ?? { n: 0, tris: 0, meshes: 0 };
    e.n++; e.tris = Math.max(e.tris, t); e.meshes = Math.max(e.meshes, m);
    bt[b.type] = e;
  }
  res.buildingTris = bt;
  // terrain meshes
  res.terrain = [];
  R.terrain && R.scene.getObjectByName('terrain')?.traverse((o) => { if (o.isMesh) res.terrain.push({ name: o.name, tris: tri(o.geometry), cast: o.castShadow, recv: o.receiveShadow, fc: o.frustumCulled, verts: o.geometry.attributes.position.count }); });
  return res;
});
console.log('treeLods', JSON.stringify(res.treeLods));
console.log('natureLodState'); res.natureLodState.forEach((s, i) => console.log('  chunk', i, s));
for (const m of res.meshes) console.log('  ', JSON.stringify(m));
console.log('buildings', JSON.stringify(res.buildingTris, null, 0));
console.log('terrain', JSON.stringify(res.terrain));
writeJSON('geo.json', res);
console.log([...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
