// Screenshot every UI scene of the sandbox at several resolutions.
// Usage: node dev/ui/shoot.mjs <outDir> [scene,scene...] [WxH,WxH...]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'shots';
const onlyScenes = process.argv[3] ? process.argv[3].split(',') : null;
const sizes = (process.argv[4] ?? '1920x1080,1280x720').split(',').map((s) => s.split('x').map(Number));
const BASE = process.env.UI_BASE ?? 'http://localhost:5204/dev/ui/index.html';

const SCENES = [
  'title', 'newgame', 'load', 'pause', 'save', 'settings', 'controls',
  'game', 'house', 'field', 'workshop', 'construction', 'clearing', 'storage', 'stockpile', 'pasture', 'orchard', 'fire',
  'post', 'cemetery', 'ruin', 'gatherer', 'citizen', 'elder',
  'professions', 'overview', 'citizens', 'log', 'stats', 'trade', 'nomads', 'help',
  'flyout', 'tool', 'confirm', 'gameover', 'toasts', 'hover',
];

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
for (const [w, h] of sizes) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${w}x${h}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${w}x${h} console.${m.type()}: ${m.text()}`);
  });
  for (const s of SCENES) {
    if (onlyScenes && !onlyScenes.includes(s)) continue;
    const extra = s === 'game' ? '&paused=1' : '';
    await page.goto(`${BASE}?scene=${s}${extra}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(700);
    if (s === 'stats') {
      await page.mouse.move(Math.round(w * 0.45), Math.round(h * 0.45));
      await page.waitForTimeout(100);
    }
    if (s === 'field') {
      // hover the happiness-less field crop tooltip: hover first seg button
      const el = await page.$('.sel-panel .seg-btn');
      if (el) await el.hover({ timeout: 2000 }).catch((e) => errors.push('hover failed: ' + s));
      await page.waitForTimeout(500);
    }
    if (s === 'citizen') {
      const el = await page.$$('.need');
      if (el[1]) await el[1].hover({ timeout: 2000 }).catch(() => errors.push('hover failed: ' + s));
      await page.waitForTimeout(500);
    }
    if (s === 'flyout') {
      const el = await page.$$('.flyout:not([hidden]) .fly-item');
      if (el[1]) await el[1].hover({ timeout: 2000 }).catch(() => errors.push('hover failed: ' + s));
      await page.waitForTimeout(500);
    }
    if (s === 'game') {
      const el = await page.$('.tb-cell');
      if (el) await el.hover({ timeout: 2000 }).catch((e) => errors.push('hover failed: ' + s));
      await page.waitForTimeout(500);
    }
    const file = path.join(out, `${s}_${w}x${h}.png`);
    await page.screenshot({ path: file });
    console.log('shot', file);
  }
  await ctx.close();
}
await browser.close();
if (errors.length) {
  console.log('--- page errors ---');
  for (const e of [...new Set(errors)]) console.log(e);
}
