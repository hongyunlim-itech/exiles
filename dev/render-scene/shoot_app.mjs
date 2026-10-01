// Screenshot the real app (index.html) through the dev server with a manually pumped frame loop (software GL is
// too slow for a free-running rAF). Starts a new game via window.__app, optionally fast-forwards the sim with
// game.step, runs a setup script, pumps frames, captures.
// Usage: node dev/render-scene/shoot_app.mjs name "<js run with (app) after newGame>" [frames] [simSeconds]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'shots');
mkdirSync(outDir, { recursive: true });
const name = process.argv[2] ?? 'app';
const script = process.argv[3] ?? '';
const frames = Number(process.argv[4] ?? 8);
const simSeconds = Number(process.argv[5] ?? 0);
const size = (process.env.SHOT_SIZE ?? '1600x900').split('x').map(Number);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
page.setDefaultTimeout(300000);
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.addInitScript(() => {
  const q = [];
  let t = performance.now();
  window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
  window.__pump = (n = 1, dtMs = 50) => {
    for (let i = 0; i < n; i++) {
      const cbs = q.splice(0);
      t += dtMs;
      for (const cb of cbs) cb(t);
    }
  };
});
await page.goto('http://localhost:5201/index.html', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__app, null, { timeout: 120000 });
const t0 = Date.now();
const info = await page.evaluate(async ({ src, simSeconds }) => {
  const app = window.__app;
  app.newGame({ seed: 1234, townName: 'Shot', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false });
  for (let s = 0; s < simSeconds; s += 0.25) app.game.step(0.25);
  if (src) await (0, eval)(`(async (app) => { ${src} })`)(app);
  return { pop: app.game.state.citizens.length, buildings: app.game.state.buildings.length, month: app.game.state.time.month };
}, { src: script, simSeconds });
await page.evaluate((n) => window.__pump(n), frames);
const stats = await page.evaluate(() => {
  const r = window.__app.renderer;
  const cc = r.cameraController;
  const i = r.renderer.info;
  return {
    calls: i.render.calls, tris: i.render.triangles, programs: i.programs?.length, geometries: i.memory.geometries,
    target: [+cc.target.x.toFixed(1), +cc.target.z.toFixed(1)], dist: +cc.distance.toFixed(1),
    day: +window.__app.game.state.time.dayTime.toFixed(2),
  };
});
const file = join(outDir, `${name}.png`);
await page.screenshot({ path: file });
console.log(JSON.stringify({ info, stats, ms: Date.now() - t0 }));
console.log(logs.slice(0, 40).join('\n'));
console.log(`-> ${file}`);
await browser.close();
