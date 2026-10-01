// Deterministic sim hotspot hunt: fixed 0.25 s steps from the saved town, per-step wall time + phase profile.
// Usage: node dev/qa-artdir/simstep.mjs [gameSeconds]
import { open } from './lib.mjs';

const secs = Number(process.argv[2] ?? 400);
const { browser, page, logs } = await open({ settings: { quality: 'low', shadows: false } });
const out = await page.evaluate(async (S) => {
  const g = window.__app.game;
  const rows = [];
  const n = Math.round(S / 0.25);
  for (let i = 0; i < n; i++) {
    g.profile = {};
    const t0 = performance.now(); g.step(0.25); const t = performance.now() - t0;
    const p = {}; for (const [k, v] of Object.entries(g.profile)) if (v > 2 && !k.endsWith('.n') && !k.endsWith('.len')) p[k] = +v.toFixed(1);
    rows.push({ i, t: +t.toFixed(1), el: +g.state.time.elapsed.toFixed(2), p });
    if (i % 200 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  g.profile = null;
  const sorted = [...rows].sort((a, b) => b.t - a.t);
  const tot = rows.reduce((a, r) => a + r.t, 0);
  return { steps: n, avg: +(tot / n).toFixed(2), over16: rows.filter((r) => r.t > 16).length, top: sorted.slice(0, 12), pop: g.state.citizens.length };
}, secs);
console.log(JSON.stringify(out));
for (const r of out.top) console.log(JSON.stringify(r));
console.log('logs', [...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
