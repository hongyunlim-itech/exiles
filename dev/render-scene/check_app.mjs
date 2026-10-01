// Functional checks of GameRenderer / CameraController inside the real app (pumped frames, software GL).
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.setDefaultTimeout(300000);
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.addInitScript(() => {
  const q = [];
  let t = performance.now();
  window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
  window.__pump = (n = 1, dtMs = 50) => { for (let i = 0; i < n; i++) { const cbs = q.splice(0); t += dtMs; for (const cb of cbs) cb(t); } };
});
await page.goto('http://localhost:5201/index.html', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__app);
await page.evaluate(() => {
  window.__app.newGame({ seed: 99, townName: 'Check', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: false });
  window.__pump(4);
});
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail ?? ''}`);
const cam = () => page.evaluate(() => { const c = window.__app.renderer.cameraController; return { x: c.target.x, z: c.target.z, yaw: c.yaw, pitch: c.pitch, d: c.distance }; });

// picking & projection round trip at the canvas centre
const pick = await page.evaluate(() => {
  const r = window.__app.renderer;
  const p = r.pickTile(480, 270);
  const c = r.cameraController.target;
  const scr = p ? r.worldToScreen(p.wx, window.__app.game.state.tiles.height[0] * 0 + c.y, p.wz) : null;
  const ent = r.pickEntity(480, 270);
  const b = window.__app.game.state.buildings[0];
  const bs = r.worldToScreen(b.x + b.w / 2, c.y + 1, b.z + b.h / 2);
  const be = r.pickEntity(bs.x, bs.y);
  return { p, target: { x: c.x, z: c.z }, scr, ent, bId: b.id, be, bs };
});
check('pickTile centre ~ camera target', pick.p && Math.hypot(pick.p.wx - pick.target.x, pick.p.wz - pick.target.z) < 1.5, JSON.stringify(pick.p));
check('worldToScreen(pick) ~ centre', pick.scr && Math.hypot(pick.scr.x - 480, pick.scr.y - 270) < 6 && pick.scr.visible, JSON.stringify(pick.scr));
check('pickEntity on first building', pick.be && pick.be.kind === 'building' && pick.be.id === pick.bId, JSON.stringify(pick.be));

// keyboard pan (W) & rotate (Q) & zoom (=)
await page.locator('canvas').first().click({ position: { x: 5, y: 300 }, button: 'middle' }).catch(() => {});
let c0 = await cam();
await page.keyboard.down('KeyW');
await page.evaluate(() => window.__pump(10));
await page.keyboard.up('KeyW');
await page.evaluate(() => window.__pump(10));
let c1 = await cam();
const fwd = { x: -Math.sin(c0.yaw), z: -Math.cos(c0.yaw) };
const moved = (c1.x - c0.x) * fwd.x + (c1.z - c0.z) * fwd.z;
check('W pans forward', moved > 3, `moved ${moved.toFixed(2)}`);
await page.keyboard.down('KeyQ');
await page.evaluate(() => window.__pump(10));
await page.keyboard.up('KeyQ');
await page.evaluate(() => window.__pump(10));
let c2 = await cam();
check('Q rotates yaw', Math.abs(c2.yaw - c1.yaw) > 0.3, `yaw ${c1.yaw.toFixed(2)} -> ${c2.yaw.toFixed(2)}`);
await page.keyboard.down('Equal');
await page.evaluate(() => window.__pump(10));
await page.keyboard.up('Equal');
await page.evaluate(() => window.__pump(12));
let c3 = await cam();
check('= zooms in', c3.d < c2.d - 3, `dist ${c2.d.toFixed(1)} -> ${c3.d.toFixed(1)}`);
// wheel zoom out
await page.mouse.move(480, 270);
await page.mouse.wheel(0, 600);
await page.evaluate(() => window.__pump(20));
let c4 = await cam();
check('wheel zooms out', c4.d > c3.d + 3, `dist ${c3.d.toFixed(1)} -> ${c4.d.toFixed(1)}`);
// right drag rotates and reports rightDragMoved; right click (no move) stays < 5
await page.mouse.move(400, 300);
await page.mouse.down({ button: 'right' });
await page.mouse.move(520, 330, { steps: 6 });
await page.mouse.up({ button: 'right' });
await page.evaluate(() => window.__pump(12));
const rd = await page.evaluate(() => window.__app.renderer.cameraController.rightDragMoved);
let c5 = await cam();
check('right-drag rotates', Math.abs(c5.yaw - c4.yaw) > 0.3 && rd > 100, `rightDragMoved ${rd}, yaw ${c4.yaw.toFixed(2)} -> ${c5.yaw.toFixed(2)}`);
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
const rd2 = await page.evaluate(() => window.__app.renderer.cameraController.rightDragMoved);
check('right-click rightDragMoved < 5', rd2 < 5, `${rd2}`);
// typing in an input must not move the camera
await page.evaluate(() => { const i = document.createElement('input'); i.id = '__t'; i.style.position = 'fixed'; i.style.top = '0'; i.style.pointerEvents = 'auto'; i.style.zIndex = '99999'; document.body.appendChild(i); i.focus(); });
let c6 = await cam();
await page.keyboard.down('KeyD');
await page.evaluate(() => window.__pump(10));
await page.keyboard.up('KeyD');
await page.evaluate(() => { window.__pump(10); document.getElementById('__t').remove(); });
let c7 = await cam();
check('keys ignored while typing', Math.hypot(c7.x - c6.x, c7.z - c6.z) < 0.05, `moved ${Math.hypot(c7.x - c6.x, c7.z - c6.z).toFixed(3)}`);
// clamp: pan far outside the map
await page.evaluate(() => { window.__app.renderer.cameraController.focusOn(-500, 9999); window.__pump(30); });
let c8 = await cam();
const W = await page.evaluate(() => window.__app.game.state.W);
check('target clamped to map', c8.x >= 0 && c8.x <= W && c8.z >= 0 && c8.z <= W, `${c8.x.toFixed(1)},${c8.z.toFixed(1)}`);
// Home focuses the town
await page.keyboard.press('Home');
await page.evaluate(() => window.__pump(40));
const town = await page.evaluate(() => { const bs = window.__app.game.state.buildings; let x = 0, z = 0; for (const b of bs) { x += b.x + b.w / 2; z += b.z + b.h / 2; } return { x: x / bs.length, z: z / bs.length }; });
let c9 = await cam();
check('Home focuses town', Math.hypot(c9.x - town.x, c9.z - town.z) < 1.5, `${c9.x.toFixed(1)},${c9.z.toFixed(1)} vs ${town.x.toFixed(1)},${town.z.toFixed(1)}`);
// settings: shadows off / low quality / grid, then back
const set = await page.evaluate(() => {
  const r = window.__app.renderer;
  r.applySettings({ shadows: false, quality: 'low', showGrid: true });
  window.__pump(3);
  const a = { shadowMap: r.renderer.shadowMap.enabled, pr: r.renderer.getPixelRatio() };
  r.applySettings({ shadows: true, quality: 'high', showGrid: false });
  window.__pump(3);
  return { a, b: { shadowMap: r.renderer.shadowMap.enabled, cast: r.sky.sun.castShadow } };
});
check('settings toggle shadows/quality', !set.a.shadowMap && set.b.shadowMap && set.b.cast, JSON.stringify(set));
// setGame swap keeps rendering
const swap = await page.evaluate(() => {
  window.__app.newGame({ seed: 7, townName: 'B', mapSize: 'large', terrain: 'lakes', climate: 'harsh', difficulty: 'hard', disasters: true });
  window.__pump(4);
  const r = window.__app.renderer;
  return { calls: r.renderer.info.render.calls, W: window.__app.game.state.W, t: [r.cameraController.target.x, r.cameraController.target.z] };
});
check('new game (large) renders', swap.calls > 10 && swap.W === 208, JSON.stringify(swap));
console.log(results.join('\n'));
console.log(logs.slice(0, 30).join('\n'));
await browser.close();
