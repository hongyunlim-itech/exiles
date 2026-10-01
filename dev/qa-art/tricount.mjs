// Triangle counts of entity/building model geometries.
import { open } from './lib.mjs';

const { browser, page } = await open();
const r = await page.evaluate(async () => {
  const tm = await import('/src/render/entities/treeModels.ts');
  const tri = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  const out = {};
  for (let sp = 0; sp < 3; sp++) for (const lod of [0, 1]) out[`tree${sp}_lod${lod}`] = tri(tm.buildTree(sp, lod));
  out.rock = tri(tm.buildRock()); out.iron = tri(tm.buildIron()); out.marker = tri(tm.buildMarker());
  // citizens / animals: inspect scene instanced meshes
  const R = window.__app.renderer;
  const per = {};
  for (const name of ['citizens', 'animals', 'crops', 'nature']) {
    const top = R.scene.children.find((o) => o.name === name);
    if (!top) continue;
    const list = [];
    top.traverse((o) => { if (o.isInstancedMesh) list.push({ n: o.name, tris: tri(o.geometry), count: o.count, cast: o.castShadow, fc: o.frustumCulled }); });
    per[name] = list.slice(0, 20);
  }
  // building meshes: tris per type
  const s = window.__app.game.state;
  const byType = {};
  for (const b of s.buildings) {
    const v = R.buildings.getVisual(b.id);
    if (!v) continue;
    let t = 0; let meshes = 0;
    v.group.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) { t += tri(o.geometry); meshes++; } });
    byType[b.type] = { tris: t, meshes };
  }
  return { out, per, byType };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
