import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(300000);
await page.addInitScript(() => {
  const q = []; let t = performance.now();
  window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
  window.__pump = (n = 1, dtMs = 50) => { for (let i = 0; i < n; i++) { const cbs = q.splice(0); t += dtMs; for (const cb of cbs) cb(t); } };
});
await page.goto('http://localhost:5201/index.html', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__app);
const res = await page.evaluate(() => {
  const app = window.__app;
  app.newGame({ seed: 5, townName: 'P', mapSize: 'large', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: false });
  app.setSpeed(0);
  window.__pump(3);
  const r = app.renderer;
  const s = app.game.state;
  const ctx = { game: app.game, camera: r.camera, realTime: 1000, realDt: 0.016, gameDt: 0, daylight: 1, snow: 0, season: 'summer', yearProgress: 0.3, focusX: 100, focusZ: 100, cameraDistance: 40, quality: 'high' };
  const time = (label, prep, n = 20) => {
    let total = 0;
    for (let i = 0; i < n; i++) {
      prep?.(i);
      ctx.realTime += 10; // past all throttles
      const t0 = performance.now();
      r.terrain.update(ctx);
      total += performance.now() - t0;
    }
    return `${label}: ${(total / n).toFixed(2)} ms`;
  };
  const out = [];
  out.push(time('idle', null, 50));
  out.push(time('features (5 trees change)', (i) => { for (let k = 0; k < 5; k++) { const j = (i * 997 + k * 131) % (s.W * s.H); s.tiles.featureAmount[j] = (s.tiles.featureAmount[j] + 0.37) % 1; s.tiles.feature[j] = 1; } s.rev.features++; }));
  out.push(time('roads/buildings overlay', (i) => { s.tiles.road[(i * 31) % (s.W * s.H)] = 1; s.rev.roads++; }, 200));
  out.push(time('terrain heights (1 building flatten)', (i) => { const c = 50 * (s.W + 1) + 50 + i; s.tiles.height[c] += 0.01; s.rev.terrain++; }, 10));
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) { ctx.realTime += 0.016; r.sky.update(ctx); r.water.update(ctx); }
  out.push(`sky+water update: ${((performance.now() - t0) / 50).toFixed(3)} ms`);
  const t1 = performance.now();
  for (let i = 0; i < 50; i++) r.pickTile(320, 180);
  out.push(`pickTile: ${((performance.now() - t1) / 50).toFixed(3)} ms`);
  const t2 = performance.now();
  for (let i = 0; i < 50; i++) r.pickEntity(320, 180);
  out.push(`pickEntity: ${((performance.now() - t2) / 50).toFixed(3)} ms`);
  const t3 = performance.now();
  r.terrain.setGame(app.game);
  out.push(`terrain.setGame (208x208): ${(performance.now() - t3).toFixed(1)} ms`);
  const t4 = performance.now();
  r.water.setGame(app.game);
  out.push(`water.setGame: ${(performance.now() - t4).toFixed(1)} ms`);
  return out;
});
console.log(res.join('\n'));
await browser.close();
