// Sim CPU cost per game-second with phase breakdown + worst single step, and per-frame cost at speeds 1/2/5/10 @60fps.
import { open, writeJSON } from './lib.mjs';
const { browser, page, logs } = await open();
const res = await page.evaluate(async () => {
  const g = window.__app.game;
  const out = {};
  for (const stepDt of [1 / 60, 0.1]) {
    g.profile = {};
    const N = 180;
    let worst = 0, steps = 0;
    const t0 = performance.now();
    const end = g.state.time.elapsed + N;
    const hist = [];
    while (g.state.time.elapsed < end) {
      const a = performance.now(); g.step(stepDt); const d = performance.now() - a;
      hist.push(d); if (d > worst) worst = d; steps++;
      if (steps % 300 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const ms = performance.now() - t0;
    hist.sort((x, y) => x - y);
    const prof = g.profile; g.profile = null;
    const per = {}; for (const [k, v] of Object.entries(prof)) per[k] = +(v / N).toFixed(3);
    out['dt' + stepDt.toFixed(3)] = { msPerGameSecond: +(ms / N).toFixed(3), steps, worstStepMs: +worst.toFixed(2), p99: +hist[Math.floor(hist.length * 0.99)].toFixed(3), p50: +hist[Math.floor(hist.length * 0.5)].toFixed(3), perGameSecond: per };
  }
  out.pop = g.state.citizens.length; out.animals = g.state.animals.length; out.buildings = g.state.buildings.length;
  return out;
});
console.log(JSON.stringify(res, null, 1));
writeJSON('simcpu.json', res);
console.log([...new Set(logs)].slice(0, 10).join('\n'));
await browser.close();
