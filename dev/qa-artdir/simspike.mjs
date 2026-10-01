// Probe sim CPU spikes: per-frame game.update() ms and per-phase profile deltas at a given speed.
// Usage: node dev/qa-artdir/simspike.mjs [speed] [frames]
import { open } from './lib.mjs';

const speed = Number(process.argv[2] ?? 5);
const frames = Number(process.argv[3] ?? 240);
const { browser, page, logs } = await open({ settings: { quality: 'low', shadows: false } });
const out = await page.evaluate(async ([sp, n]) => {
  const app = window.__app; const g = app.game;
  const rows = [];
  const orig = g.update.bind(g);
  let cur = null;
  g.update = (dt) => {
    g.profile = {};
    const t0 = performance.now(); orig(dt); const t = performance.now() - t0;
    cur = { t: +t.toFixed(2), dt: +dt.toFixed(3), month: g.state.time.month, elapsed: +g.state.time.elapsed.toFixed(1), prof: g.profile };
    g.profile = null;
  };
  app.setSpeed(sp);
  for (let i = 0; i < n; i++) {
    await window.__frames(1);
    if (cur) rows.push(cur);
    cur = null;
  }
  app.setSpeed(0);
  g.update = orig;
  const tot = rows.reduce((a, r) => a + r.t, 0);
  const sorted = [...rows].sort((a, b) => b.t - a.t);
  const top = sorted.slice(0, 8).map((r) => {
    const p = {}; for (const [k, v] of Object.entries(r.prof)) if (v > 1) p[k] = +v.toFixed(1);
    return { t: r.t, dt: r.dt, month: r.month, elapsed: r.elapsed, prof: p };
  });
  const med = sorted[Math.floor(sorted.length / 2)]?.t;
  return { frames: rows.length, avg: +(tot / rows.length).toFixed(2), median: med, over16: rows.filter((r) => r.t > 16).length, over50: rows.filter((r) => r.t > 50).length, top, pop: g.state.citizens.length };
}, [speed, frames]);
console.log(JSON.stringify(out, null, 1));
console.log('logs', [...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
