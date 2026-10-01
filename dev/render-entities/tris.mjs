// Ad-hoc debugging helper for the render-entities sandbox (not shipped): triangle breakdown per scene group.
import { chromium } from 'playwright';
const q = process.argv[2] ?? 'month=4&cam=stress&stress=1&prewarm=2';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`http://localhost:5203/dev/render-entities/index.html?shot=1&${q}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
await page.waitForTimeout(2000);
console.log(JSON.stringify(await page.evaluate(() => {
  const { scene, renderer } = window.__fx;
  const out = {};
  for (const top of scene.children) {
    let tris = 0;
    let meshes = 0;
    top.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const g = o.geometry;
      const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
      const n = o.isInstancedMesh ? o.count : g.isInstancedBufferGeometry ? g.instanceCount : 1;
      tris += t * n;
      meshes++;
    });
    out[top.name || top.type] = { tris: Math.round(tris), meshes };
  }
  out.renderInfo = { ...renderer.info.render };
  return out;
}), null, 1));
await browser.close();
