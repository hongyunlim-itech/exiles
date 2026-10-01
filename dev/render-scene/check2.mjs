import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.setDefaultTimeout(300000);
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.addInitScript(() => {
  const q = []; let t = performance.now();
  window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
  window.__pump = (n = 1, dtMs = 50) => { for (let i = 0; i < n; i++) { const cbs = q.splice(0); t += dtMs; for (const cb of cbs) cb(t); } };
});
await page.goto('http://localhost:5201/index.html', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__app);
await page.evaluate(() => { window.__app.newGame({ seed: 3, townName: 'E', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: false }); window.__pump(3); });
const out = [];
// edge scroll: pointer at the right edge pans right
const before = await page.evaluate(() => { const c = window.__app.renderer.cameraController; c.edgeScroll = true; return { x: c.target.x, z: c.target.z, yaw: c.yaw }; });
await page.mouse.move(799, 225);
await page.evaluate(() => window.__pump(10));
const after = await page.evaluate(() => { const c = window.__app.renderer.cameraController; c.edgeScroll = false; return { x: c.target.x, z: c.target.z }; });
const right = { x: Math.cos(before.yaw), z: -Math.sin(before.yaw) };
const moved = (after.x - before.x) * right.x + (after.z - before.z) * right.z;
out.push(`${moved > 2 ? 'PASS' : 'FAIL'} edge scroll right moved ${moved.toFixed(2)}`);
// high speed damps the day cycle: daylight stays high through a night at 10x
const d = await page.evaluate(() => {
  const app = window.__app;
  app.setSpeed(10);
  app.game.state.time.dayTime = 0.0;
  const vals = [];
  for (let i = 0; i < 40; i++) { window.__pump(1, 100); vals.push(app.renderer.sky.daylight); }
  app.setSpeed(1);
  return { min: Math.min(...vals.slice(20)), last: vals[vals.length - 1] };
});
out.push(`${d.min > 0.6 ? 'PASS' : 'FAIL'} 10x speed keeps steady light (min daylight after settle ${d.min.toFixed(2)})`);
// dispose releases everything without throwing, canvas removed
const disp = await page.evaluate(() => {
  const r = window.__app.renderer;
  try { r.dispose(); r.render(0.016, 0); r.dispose(); } catch (e) { return 'threw ' + e.message; }
  return document.querySelectorAll('#app canvas').length === 0 ? 'ok' : 'canvas still attached';
});
out.push(`${disp === 'ok' ? 'PASS' : 'FAIL'} dispose (${disp})`);
console.log(out.join('\n'));
console.log(logs.filter((l) => !l.includes('[frame] error')).slice(0, 20).join('\n'));
await browser.close();
