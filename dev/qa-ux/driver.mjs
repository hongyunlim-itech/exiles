// QA driver: persistent Playwright browser controlled via HTTP POST (body = async JS function body with `page`, `shot`, `S` in scope).
// Usage: node dev/qa-ux/driver.mjs <ctrlPort> <gamePort> <w> <h>
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ctrlPort = Number(process.argv[2] ?? 5321);
const gamePort = process.argv[3] ?? '5221';
const W = Number(process.argv[4] ?? 1600);
const H = Number(process.argv[5] ?? 900);
const out = path.resolve('dev/qa-ux/shots');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
const logs = [];
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + '\n' + (e.stack ?? '').split('\n').slice(0, 5).join('\n')));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`console.${m.type()}: ${m.text()}`); });
page.on('dialog', async (d) => { logs.push('dialog: ' + d.type() + ' ' + d.message()); await d.dismiss(); });
const shot = async (name, opts = {}) => { const p = path.join(out, name + '.png'); await page.screenshot({ path: p, ...opts }); return p; };
const S = {}; // scratch state
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
        const fn = new AsyncFunction('page', 'shot', 'S', 'logs', 'ctx', body);
        result = await fn(page, shot, S, logs, ctx);
      }
      res.end(JSON.stringify(result ?? null, null, 1));
    } catch (e) {
      res.end('ERROR: ' + (e?.stack ?? String(e)));
    }
  });
}).listen(ctrlPort, () => console.log('driver ready on', ctrlPort));
