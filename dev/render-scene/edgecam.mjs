import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(300000);
await page.addInitScript(() => { const q = []; let t = performance.now(); window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; }; window.__pump = (n = 1) => { for (let i = 0; i < n; i++) { const c = q.splice(0); t += 50; for (const cb of c) cb(t); } }; });
await page.goto('http://localhost:5201/index.html', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__app);
const r = await page.evaluate(() => {
  const app = window.__app;
  app.newGame({ seed: 1234, townName: 'E', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: false });
  window.__pump(2);
  const rr = app.renderer; const c = rr.cameraController;
  const res = [];
  for (const [x, z, yaw] of [[0.5, 80, -Math.PI / 2], [80, 0.5, Math.PI], [159.5, 60, Math.PI / 2], [43, 0.5, Math.PI]]) {
    c.jumpTo(x, z, 12); c.yaw = yaw; c.goal.yaw = yaw; c.pitch = 0.3; c.goal.pitch = 0.3; c.update(0.016);
    const p = rr.camera.position;
    const g = rr.terrain.groundHeight(p.x, p.z);
    res.push({ cam: [+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1)], ground: +g.toFixed(2), ok: p.y >= g + 1.0 });
  }
  return res;
});
console.log(JSON.stringify(r));
await browser.close();
