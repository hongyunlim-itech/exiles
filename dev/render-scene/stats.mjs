import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
for (const q of ['gen=real&seed=1234', 'gen=real&seed=77&size=large', 'gen=real&seed=5']) {
  await page.goto('http://localhost:5201/dev/render-scene/index.html?frames=1&' + q, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  const r = await page.evaluate(() => {
    const s = window.__sandbox.state;
    const h = s.tiles.height; const t = s.tiles.terrain; const W = s.W;
    const all = Array.from(h).sort((a, b) => a - b);
    const m = []; const land = [];
    for (let z = 0; z < s.H; z++) for (let x = 0; x < W; x++) {
      const v = h[z * (W + 1) + x];
      if (t[z * W + x] === 4) m.push(v); else if (t[z * W + x] <= 1) land.push(v);
    }
    m.sort((a, b) => a - b); land.sort((a, b) => a - b);
    const q = (a, p) => a.length ? +a[Math.floor(p * (a.length - 1))].toFixed(2) : null;
    let edge = [];
    for (let x = 0; x <= W; x++) { edge.push(h[x], h[s.H * (W + 1) + x]); }
    edge.sort((a, b) => a - b);
    const counts = [0, 0, 0, 0, 0]; for (const v of t) counts[v]++;
    return { W, min: q(all, 0), max: q(all, 1), mtn: [q(m, 0.1), q(m, 0.5), q(m, 0.9), q(m, 1)], land: [q(land, 0.05), q(land, 0.5), q(land, 0.95)], edge: [q(edge, 0), q(edge, 0.5), q(edge, 1)], counts, start: window.__start };
  });
  console.log(q, JSON.stringify(r));
}
await browser.close();
