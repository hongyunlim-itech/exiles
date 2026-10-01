// Triangle census: per geometry tris/instance, instance counts, casters; camera-frustum and shadow-frustum
// visible triangle estimates at several zoom distances.
import { open } from './lib.mjs';
import fs from 'node:fs';

const { browser, page, logs } = await open({ settings: { quality: 'high', shadows: true } });
const res = await page.evaluate(async () => {
  const app = window.__app; const R = app.renderer; const THREE_ = null;
  const center = app.game.townCenter();
  const triOf = (g) => (g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)) / 3;
  const out = {};
  // per top-level group: unique geometry tri counts
  const geoTable = [];
  R.scene.traverse((o) => {
    if (!o.isMesh) return;
    let top = o; while (top.parent && top.parent !== R.scene) top = top.parent;
    const g = o.geometry;
    geoTable.push({ top: top.name, name: o.name, tris: Math.round(triOf(g)), count: o.isInstancedMesh ? o.count : 1, cast: o.castShadow, culled: o.frustumCulled, visible: o.visible });
  });
  // aggregate
  const agg = {};
  for (const r of geoTable) {
    const k = r.top;
    agg[k] ??= { meshes: 0, totalTris: 0, casterTris: 0, maxTrisPerInstance: 0 };
    if (!r.visible) continue;
    agg[k].meshes++; agg[k].totalTris += r.tris * r.count; if (r.cast) agg[k].casterTris += r.tris * r.count; agg[k].maxTrisPerInstance = Math.max(agg[k].maxTrisPerInstance, r.tris);
  }
  out.agg = agg;
  // nature: distinct geometries (tree LODs)
  const natureGeos = new Map();
  R.scene.getObjectByName('nature').traverse((o) => { if (o.isInstancedMesh) { const k = o.geometry.uuid; const e = natureGeos.get(k) ?? { tris: Math.round(triOf(o.geometry)), inst: 0, meshes: 0 }; e.inst += o.count; e.meshes++; natureGeos.set(k, e); } });
  out.natureGeos = [...natureGeos.values()].sort((a, b) => b.tris - a.tris);
  // citizens / animals geos
  for (const nm of ['citizens', 'animals', 'crops', 'effects']) {
    const m = new Map();
    R.scene.getObjectByName(nm)?.traverse((o) => { if (o.isMesh) { const k = o.name || o.geometry.uuid.slice(0, 6); const e = m.get(k) ?? { tris: Math.round(triOf(o.geometry)), inst: 0, cast: o.castShadow }; e.inst += o.isInstancedMesh ? o.count : 1; m.set(k, e); } });
    out[nm + 'Geos'] = Object.fromEntries(m);
  }
  // buildings: tris per building type
  const bt = {};
  const broot = R.scene.getObjectByName('buildings-root');
  broot.traverse((o) => { if (o.isMesh && o.visible) { let p = o; let tname = null; while (p && p !== broot) { if (p.userData?.buildingType) { tname = p.userData.buildingType; break; } if (p.name && /^b(ld)?[-:_]/.test(p.name)) tname = p.name; p = p.parent; } const k = tname ?? o.name ?? 'unknown'; bt[k] = (bt[k] ?? 0) + triOf(o.geometry) * (o.isInstancedMesh ? o.count : 1); } });
  out.buildingsByNode = bt;
  out.buildingsChildren = broot.children.slice(0, 10).map((c) => ({ name: c.name, type: c.type, ud: Object.keys(c.userData ?? {}), n: c.children.length }));
  return out;
});
console.log(JSON.stringify(res, null, 1));
fs.writeFileSync('dev/qa-artdir/tris.json', JSON.stringify(res, null, 1));
console.log('logs', [...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
