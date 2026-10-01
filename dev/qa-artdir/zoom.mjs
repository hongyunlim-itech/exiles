// Zoom ladder: screenshots + renderer.info + CPU timing per phase at each camera distance; per-scene-child
// triangle/draw-call breakdown; medium/low quality comparison.
// Usage: node dev/qa-artdir/zoom.mjs [quality] [shadows]
import { open } from './lib.mjs';

const quality = process.argv[2] ?? 'high';
const shadows = (process.argv[3] ?? '1') === '1';
const { browser, page, logs, shot } = await open({ settings: { quality, shadows } });
await page.evaluate(() => {
  const app = window.__app;
  window.__breakdown = () => {
    const R = app.renderer; const glr = R.renderer; const scene = R.scene; const cam = R.camera;
    glr.render(scene, cam);
    const base = { calls: glr.info.render.calls, tris: glr.info.render.triangles };
    const rows = [];
    for (const ch of scene.children) {
      if (!ch.visible) continue;
      ch.visible = false;
      glr.render(scene, cam);
      const d = { name: ch.name || ch.type, type: ch.type, calls: base.calls - glr.info.render.calls, tris: base.tris - glr.info.render.triangles };
      ch.visible = true;
      let meshes = 0; let inst = 0; let shadowCasters = 0;
      ch.traverse((o) => { if (o.isMesh) { meshes++; if (o.isInstancedMesh) inst += o.count; if (o.castShadow) shadowCasters++; } });
      d.meshes = meshes; d.instances = inst; d.casters = shadowCasters;
      if (d.calls || d.tris) rows.push(d);
    }
    glr.render(scene, cam);
    return { base, rows: rows.sort((a, b) => b.tris - a.tris) };
  };
  window.__shadowInfo = () => {
    const R = app.renderer; const glr = R.renderer;
    let light = null; R.scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow) light = o; });
    if (!light) return { enabled: glr.shadowMap.enabled };
    const c = light.shadow.camera;
    return { enabled: glr.shadowMap.enabled, type: glr.shadowMap.type, mapSize: light.shadow.mapSize.x, box: [c.left, c.right, c.top, c.bottom, c.near, c.far], bias: light.shadow.bias, normalBias: light.shadow.normalBias, radius: light.shadow.radius, autoUpdate: glr.shadowMap.autoUpdate };
  };
});
const res = {};
const center = await page.evaluate(() => { const c = window.__app.game.townCenter(); return { x: c.x, z: c.z }; });
await page.evaluate(() => { window.__app.game.state.time.dayTime = 0.45; });
res.shadow = await page.evaluate(() => window.__shadowInfo());
const tag = `${quality}${shadows ? '' : '_noshadow'}`;
for (const [dist, pitch] of [[8, 0.5], [16, 0.7], [30, 0.8], [50, 0.9], [80, 0.95], [120, 1.0], [120, 0.55]]) {
  await page.evaluate(([x, z, d, p]) => window.__look(x, z, d, p, 0.6), [center.x, center.z, dist, pitch]);
  await page.evaluate(() => window.__frames(20));
  const stats = await page.evaluate(() => window.__stats());
  const timing = await page.evaluate(() => window.__measure(40));
  const bd = await page.evaluate(() => window.__breakdown());
  res[`d${dist}_p${pitch}`] = { stats, timing, breakdown: bd.rows.slice(0, 14) };
  if (quality === 'high' && shadows) await shot(`zoom_${tag}_d${dist}_p${pitch}`);
  console.log(`d${dist} p${pitch}`, JSON.stringify(stats), JSON.stringify(timing));
}
// sim phases at 1x/5x/10x with rendering (CPU only) — profile over 60 frames
for (const sp of [1, 5, 10]) {
  await page.evaluate((s) => { window.__app.setSpeed(s); window.__app.debug.profile(true); }, sp);
  await page.evaluate(([x, z]) => window.__look(x, z, 45, 0.85, 0.6), [center.x, center.z]);
  const timing = await page.evaluate(() => window.__measure(60));
  const prof = await page.evaluate(() => { const p = window.__app.game.profile; window.__app.debug.profile(false); window.__app.setSpeed(0); return p; });
  const pr = {}; for (const [k, v] of Object.entries(prof ?? {})) pr[k] = +(v / 60).toFixed(3);
  res[`speed${sp}`] = { timing, simPhasesPerFrame: pr };
  console.log('speed', sp, JSON.stringify(timing), JSON.stringify(pr));
}
// object census
res.census = await page.evaluate(() => {
  const R = window.__app.renderer; const s = window.__app.game.state;
  let meshes = 0; let inst = 0; let instMeshes = 0; let casters = 0; let lights = 0; let mats = new Set(); let geos = new Set();
  R.scene.traverse((o) => {
    if (o.isLight) lights++;
    if (o.isMesh || o.isPoints || o.isLine) { meshes++; if (o.isInstancedMesh) { instMeshes++; inst += o.count; } if (o.castShadow) casters++; if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m.uuid)); if (o.geometry) geos.add(o.geometry.uuid); }
  });
  return { meshes, instMeshes, instances: inst, casters, lights, materials: mats.size, geometries: geos.size, citizens: s.citizens.length, buildings: s.buildings.length, animals: s.animals.length, W: s.W, H: s.H, programs: R.renderer.info.programs?.length };
});
console.log(JSON.stringify(res, null, 1));
import('node:fs').then((fs) => fs.writeFileSync(`dev/qa-artdir/zoom_${tag}.json`, JSON.stringify(res, null, 1)));
console.log('logs', [...new Set(logs)].slice(0, 20).join('\n'));
await new Promise((r) => setTimeout(r, 300));
await browser.close();
