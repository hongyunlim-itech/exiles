// Why do all building meshes render in the shadow pass at close zoom? Check bounding spheres vs the shadow box.
import { open } from './lib.mjs';

const { browser, page } = await open();
const c = await page.evaluate(() => window.__app.game.townCenter());
for (const [dt, d] of [[0.45, 8], [0.45, 30], [0.3, 8], [0.6, 120]]) {
  await page.evaluate(([x, z, t, dd]) => { window.__app.game.state.time.dayTime = t; window.__look(x, z, dd, 0.5, 0.6); }, [c.x, c.z, dt, d]);
  await page.evaluate(() => window.__frames(4));
  const r = await page.evaluate(() => {
    const R = window.__app.renderer;
    const sun = R.sky.sun; const cam = sun.shadow.camera; cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse.elements;
    const tx = (x, y, z) => [inv[0] * x + inv[4] * y + inv[8] * z + inv[12], inv[1] * x + inv[5] * y + inv[9] * z + inv[13], inv[2] * x + inv[6] * y + inv[10] * z + inv[14]];
    let inside = 0, total = 0; const big = [];
    const V = R.camera.position.clone();
    R.buildings.root.traverse((o) => {
      if (!o.isMesh || !o.castShadow || !o.visible) return;
      let p = o.parent; while (p) { if (!p.visible) return; p = p.parent; }
      total++;
      const g = o.geometry; if (!g.boundingSphere) g.computeBoundingSphere();
      const bs = g.boundingSphere;
      const w = V.copy(bs.center).applyMatrix4(o.matrixWorld);
      const sc = o.matrixWorld.getMaxScaleOnAxis();
      const r = bs.radius * sc;
      const [lx, ly] = tx(w.x, w.y, w.z);
      const hit = Math.abs(lx) <= cam.right + r && Math.abs(ly) <= cam.top + r;
      if (hit) inside++;
      if (r > 12) big.push({ name: o.name || o.parent?.name, r: +r.toFixed(1), center: [w.x, w.y, w.z].map((v) => +v.toFixed(1)), inst: !!o.isInstancedMesh, fc: o.frustumCulled });
    });
    const d = sun.position.clone().sub(sun.target.position).normalize();
    return { half: cam.right, elevDeg: +(Math.asin(d.y) * 57.3).toFixed(1), inside, total, big: big.slice(0, 12), camTarget: sun.target.position.toArray().map((v) => +v.toFixed(1)) };
  });
  console.log('dayTime', dt, 'dist', d, JSON.stringify(r));
}
// town extent
const ext = await page.evaluate(() => {
  const s = window.__app.game.state; let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const b of s.buildings) { x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.w); z0 = Math.min(z0, b.z); z1 = Math.max(z1, b.z + b.h); }
  return { x0, x1, z0, z1 };
});
console.log('town extent', JSON.stringify(ext));
await browser.close();
