// Investigate shadow-pass culling: which buildings intersect the sun shadow frustum at close zoom.
import { open } from './lib.mjs';

const { browser, page } = await open();
const c = await page.evaluate(() => window.__app.game.townCenter());
for (const dt of [0.3, 0.45, 0.6]) {
  await page.evaluate(([x, z, t]) => { window.__app.game.state.time.dayTime = t; window.__look(x, z, 8, 0.5, 0.6); }, [c.x, c.z, dt]);
  await page.evaluate(() => window.__frames(3));
  const r = await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js').catch(() => null);
    const R = window.__app.renderer;
    const sun = R.sky.sun;
    const cam = sun.shadow.camera;
    cam.updateMatrixWorld();
    const dir = sun.position.clone().sub(sun.target.position).normalize();
    const elev = Math.asin(dir.y) * 180 / Math.PI;
    // use the camera's own frustum class
    const F = R.camera.constructor; // not needed
    const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
    const fr = new (Object.getPrototypeOf(new (R.renderer.constructor)().constructor) ? Object : Object)();
    return { elev, left: cam.left, right: cam.right, near: cam.near, far: cam.far, sunPos: sun.position.toArray().map((v) => +v.toFixed(1)), target: sun.target.position.toArray().map((v) => +v.toFixed(1)) };
  });
  console.log('dayTime', dt, JSON.stringify(r));
}
// count building meshes inside the shadow frustum
const cnt = await page.evaluate(async () => {
  const R = window.__app.renderer;
  const mod = await import('/node_modules/three/build/three.module.js');
  const sun = R.sky.sun; const cam = sun.shadow.camera; cam.updateMatrixWorld();
  const fr = new mod.Frustum().setFromProjectionMatrix(new mod.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  let inside = 0, total = 0, noSphere = 0; const radii = [];
  R.buildings.root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.castShadow) return;
    total++;
    if (!o.geometry.boundingSphere) noSphere++;
    if (fr.intersectsObject(o)) inside++;
    o.geometry.computeBoundingSphere(); radii.push(+o.geometry.boundingSphere.radius.toFixed(1));
  });
  return { inside, total, noSphere, radii: radii.slice(0, 60) };
});
console.log(JSON.stringify(cnt));
await browser.close();
