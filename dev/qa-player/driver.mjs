// QA (player/UX) driver: persistent Playwright browser controlled via HTTP POST.
// Body = async JS function body with `page`, `shot`, `S`, `logs`, `ctx`, `H` (helpers) in scope.
// Usage: node dev/qa-player/driver.mjs <ctrlPort> <gamePort> <w> <h>
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ctrlPort = Number(process.argv[2] ?? 6221);
const gamePort = process.argv[3] ?? '5221';
const W = Number(process.argv[4] ?? 1600);
const H = Number(process.argv[5] ?? 900);
const out = path.resolve('dev/qa-player/shots');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
let page = await ctx.newPage();
page.setDefaultTimeout(60000);
const logs = [];
const hook = (p) => {
  p.on('pageerror', (e) => logs.push('pageerror: ' + e.message + '\n' + (e.stack ?? '').split('\n').slice(0, 5).join('\n')));
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`console.${m.type()}: ${m.text()}`); });
  p.on('dialog', async (d) => { logs.push('dialog: ' + d.type() + ' ' + d.message()); await d.dismiss(); });
};
hook(page);
await page.addInitScript(() => {
  try {
    if (!sessionStorage.getItem('qa.init')) {
      localStorage.clear();
      sessionStorage.setItem('qa.init', '1');
    }
  } catch { /* ignore */ }
});
const shot = async (name, opts = {}) => { const p = path.join(out, name + '.png'); await page.screenshot({ path: p, ...opts }); return p; };
const S = {};
const Hlp = {
  // world -> screen via renderer (for aiming only)
  w2s: (x, z, dy = 0) => page.evaluate(([x, z, dy]) => {
    const app = window.__app; const s = app.game.state; const Wd = s.W; const Hh = s.tiles.height;
    const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
    const c = (xx, zz) => Hh[zz * (Wd + 1) + xx];
    const y = (c(x0, z0) * (1 - fx) + c(x0 + 1, z0) * fx) * (1 - fz) + (c(x0, z0 + 1) * (1 - fx) + c(x0 + 1, z0 + 1) * fx) * fz;
    const p = app.renderer.worldToScreen(x, y + dy, z); return p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
  }, [x, z, dy]),
  frames: (n = 3) => page.evaluate((k) => new Promise((res) => { let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n),
  st: () => page.evaluate(() => {
    const a = window.__app; const g = a.game; const s = g.state;
    return { t: `Y${s.time.year} M${s.time.month}`, speed: g.speed, pop: g.populationSummary?.(), nb: s.buildings.length, inMenu: a.inMenu, tool: a.input?.tool, sel: a.selection };
  }),
};
await page.goto(`http://localhost:${gamePort}/`, { waitUntil: 'load' });

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let result;
    try {
      if (body.trim() === '__quit') { res.end('bye'); await browser.close(); process.exit(0); }
      if (body.trim() === '__logs') { result = logs.splice(0); }
      else {
        const fn = new AsyncFunction('page', 'shot', 'S', 'logs', 'ctx', 'H', body);
        result = await fn(page, shot, S, logs, ctx, Hlp);
      }
      res.end(JSON.stringify(result ?? null, null, 1));
    } catch (e) {
      res.end('ERROR: ' + (e?.stack ?? String(e)));
    }
  });
}).listen(ctrlPort, () => console.log('driver ready on', ctrlPort));
