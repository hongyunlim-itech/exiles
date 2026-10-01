// Shared helpers for the art-director / render-perf QA capture scripts (port 5222, 1600x900).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

export const PORT = 5222;
export const OUT = 'dev/qa-artdir/shots';

export async function open({ settings = { quality: 'high', shadows: true }, width = 1600, height = 900, save = 'dev/qa-artdir/town.sav' } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(3600000);
  const data = fs.readFileSync(save, 'utf8');
  await page.addInitScript(([s, st]) => {
    try {
      localStorage.clear();
      localStorage.setItem('exiles.settings', JSON.stringify(st));
      localStorage.setItem('exiles.save.qa', s);
      localStorage.setItem('exiles.saves', JSON.stringify([{ slot: 'qa', townName: 'Artford', year: 5, month: 4, population: 59, savedAt: Date.now() }]));
    } catch { /* */ }
  }, [data, settings]);
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
    try { app.audio.unlock(); } catch { /* */ }
    const g = () => app.game;
    window.__look = (x, z, dist, pitch, yaw) => {
      const cc = app.renderer.cameraController;
      cc.goal.pitch = pitch ?? 0.7; cc.goal.yaw = yaw ?? 0.4;
      cc.jumpTo(x, z, dist ?? 30);
    };
    window.__frames = (n) => new Promise((res) => { let k = 0; const f = () => { if (++k >= n) res(); else requestAnimationFrame(f); }; requestAnimationFrame(f); });
    window.__b = (type, idx = 0) => g().state.buildings.filter((b) => b.type === type)[idx];
    window.__lookB = (b, dist, pitch, yaw) => window.__look(b.x + b.w / 2, b.z + b.h / 2, dist, pitch, yaw);
    window.__frontYaw = (b, off = 0.55) => { const dir = [[0, 1], [-1, 0], [0, -1], [1, 0]][b.rotation]; return Math.atan2(dir[0], dir[1]) + off; };
    window.__step = async (seconds) => {
      const gg = g(); const end = gg.state.time.elapsed + seconds;
      while (gg.state.time.elapsed < end) { for (let k = 0; k < 200 && gg.state.time.elapsed < end; k++) gg.step(0.25); await new Promise((r) => setTimeout(r, 0)); }
    };
    window.__stats = () => app.renderer.stats();
    let hideStyle = null;
    window.__noToasts = (on = true) => {
      if (on && !hideStyle) { hideStyle = document.createElement('style'); hideStyle.textContent = '.toast,.toasts,#toasts,[class*=toast]{display:none!important}'; document.head.appendChild(hideStyle); }
      if (!on && hideStyle) { hideStyle.remove(); hideStyle = null; }
    };
    window.__noUI = (on = true) => { document.getElementById('ui').style.visibility = on ? 'hidden' : 'visible'; };
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
    const wrap = (obj, key, label) => {
      const o = obj[key].bind(obj);
      obj[key] = (...a) => {
        if (!window.__timing.on) return o(...a);
        const t0 = performance.now(); const r = o(...a); window.__timing.acc[label] = (window.__timing.acc[label] ?? 0) + performance.now() - t0; return r;
      };
    };
    wrap(app.ui, 'update', 'ui');
    wrap(app.game, 'update', 'sim');
    wrap(app.input, 'update', 'input');
    wrap(app.audio, 'update', 'audio');
    window.__measure = async (frames = 30) => {
      window.__timing = { on: true, acc: {}, n: 0 };
      await window.__frames(frames);
      window.__timing.on = false;
      const o = {};
      for (const [k, v] of Object.entries(window.__timing.acc)) o[k] = +(v / Math.max(1, window.__timing.n)).toFixed(3);
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
