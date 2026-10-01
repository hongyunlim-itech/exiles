// Shared helpers for QA art/perf capture scripts (port 5222, 1600x900).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

export const PORT = 5222;
export const OUT = 'dev/qa-art/shots';

export async function open({ settings = { quality: 'high', shadows: true }, width = 1600, height = 900 } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(1800000);
  const save = fs.readFileSync('dev/qa-art/town.sav', 'utf8');
  await page.addInitScript(([s, st]) => {
    try {
      localStorage.clear();
      localStorage.setItem('exiles.settings', JSON.stringify(st));
      localStorage.setItem('exiles.save.qa', s);
      localStorage.setItem('exiles.saves', JSON.stringify([{ slot: 'qa', townName: 'Artmoor', year: 5, month: 6, population: 58, savedAt: Date.now() }]));
    } catch { /* */ }
  }, [save, settings]);
  const logs = [];
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + ' ' + (e.stack ?? '').split('\n')[1]));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`console.${m.type()}: ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => !!window.__app);
  await page.evaluate(() => window.__app.loadGame('qa'));
  await page.waitForFunction(() => !window.__app.inMenu);
  await page.evaluate(() => {
    const app = window.__app;
    app.setSpeed(0);
    const g = () => app.game;
    window.__look = (x, z, dist, pitch, yaw) => {
      const cc = app.renderer.cameraController;
      cc.goal.pitch = pitch ?? 0.7; cc.goal.yaw = yaw ?? 0.4;
      cc.jumpTo(x, z, dist ?? 30);
    };
    window.__frames = (n) => new Promise((res) => { let k = 0; const f = () => { if (++k >= n) res(); else requestAnimationFrame(f); }; requestAnimationFrame(f); });
    window.__b = (type, idx = 0) => g().state.buildings.filter((b) => b.type === type)[idx];
    window.__lookB = (b, dist, pitch, yaw) => window.__look(b.x + b.w / 2, b.z + b.h / 2, dist, pitch, yaw);
    window.__step = async (seconds) => {
      const gg = g(); const end = gg.state.time.elapsed + seconds;
      while (gg.state.time.elapsed < end) { for (let k = 0; k < 200 && gg.state.time.elapsed < end; k++) gg.step(0.25); await new Promise((r) => setTimeout(r, 0)); }
    };
    window.__stats = () => app.renderer.stats();
    // wrap per-layer update and the WebGL render() to measure CPU ms
    const R = app.renderer;
    window.__timing = { on: false, acc: {}, n: 0 };
    for (const L of R.layers) {
      const orig = L.r.update.bind(L.r);
      L.r.update = (ctx) => {
        if (!window.__timing.on) return orig(ctx);
        const t0 = performance.now(); orig(ctx); const t = performance.now() - t0;
        window.__timing.acc[L.name] = (window.__timing.acc[L.name] ?? 0) + t;
      };
    }
    const glr = R.renderer;
    const origRender = glr.render.bind(glr);
    glr.render = (s, c) => {
      if (!window.__timing.on) return origRender(s, c);
      const t0 = performance.now(); origRender(s, c); const t = performance.now() - t0;
      window.__timing.acc.webglRender = (window.__timing.acc.webglRender ?? 0) + t;
      window.__timing.n++;
    };
    const ui = app.ui;
    const origUi = ui.update.bind(ui);
    ui.update = (dt) => {
      if (!window.__timing.on) return origUi(dt);
      const t0 = performance.now(); origUi(dt); window.__timing.acc.ui = (window.__timing.acc.ui ?? 0) + performance.now() - t0;
    };
    const gm = app.game;
    window.__measure = async (frames = 30) => {
      window.__timing = { on: true, acc: {}, n: 0 };
      await window.__frames(frames);
      window.__timing.on = false;
      const o = {};
      for (const [k, v] of Object.entries(window.__timing.acc)) o[k] = +(v / window.__timing.n).toFixed(3);
      return o;
    };
  });
  const shot = async (name, opts = {}) => {
    const p = path.join(OUT, name + '.png');
    await page.screenshot({ path: p, ...opts });
    console.log('shot', p);
    return p;
  };
  return { browser, page, logs, shot };
}
