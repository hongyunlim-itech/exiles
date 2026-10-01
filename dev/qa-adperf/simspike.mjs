// Find which sim phase causes the worst single-step hitches.
import { open, writeJSON } from './lib.mjs';
const { browser, page, logs } = await open();
const res = await page.evaluate(async () => {
  const g = window.__app.game;
  const spikes = [];
  const N = 360;
  const end = g.state.time.elapsed + N;
  let steps = 0;
  while (g.state.time.elapsed < end) {
    g.profile = {};
    const t = { ...g.state.time };
    const a = performance.now(); g.step(1 / 30); const d = performance.now() - a;
    if (d > 20) spikes.push({ ms: +d.toFixed(1), month: t.month, elapsed: +t.elapsed.toFixed(2), prof: Object.fromEntries(Object.entries(g.profile).filter(([, v]) => v > 1).map(([k, v]) => [k, +v.toFixed(1)])) });
    steps++;
    if (steps % 300 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  g.profile = null;
  return { spikes, steps };
});
console.log(JSON.stringify(res, null, 0));
writeJSON('simspike.json', res);
await browser.close();
