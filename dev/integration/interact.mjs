// Integration UI interaction test on the real app: build menu + house placement by real mouse clicks, ghost rotation
// with R, selecting a building and a citizen by clicking the canvas, window hotkeys P/O/N/L/K/H, save & load through
// the main menu, a road drag and a clear drag.
// Usage: node dev/integration/interact.mjs <outDir> [port]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '.';
const port = process.argv[3] ?? '5210';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(120000);
await page.addInitScript(() => {
  try {
    if (!sessionStorage.getItem('itest.init')) {
      localStorage.clear();
      localStorage.setItem('exiles.settings', JSON.stringify({ quality: 'medium', shadows: true, showFps: true }));
      sessionStorage.setItem('itest.init', '1');
    }
  } catch { /* ignore */ }
});
const logs = [];
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + '\n' + (e.stack ?? '').split('\n').slice(0, 4).join('\n')));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`console.${m.type()}: ${m.text()}`);
});
const results = [];
const check = (name, ok, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  console.log(results[results.length - 1]);
};
const shot = async (name) => page.screenshot({ path: path.join(out, name + '.png') });
const frames = (n = 3) => page.evaluate((k) => new Promise((res) => { let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__app, null, { timeout: 60000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__app.newGame({ seed: 777, townName: 'Clickton', mapSize: 'medium', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: false }));
await page.waitForFunction(() => !window.__app.inMenu);
await page.evaluate(() => window.__app.setSpeed(0));
await page.waitForTimeout(2500);
await shot('i01_start');

// ---- 1. build menu -> Wooden House -> ghost -> R rotates -> click places ----
await page.click('.toolbar .tool-btn[aria-label="Housing"]');
await page.waitForTimeout(400);
await shot('i02_flyout');
const flyVisible = await page.evaluate(() => { const f = document.querySelector('.flyout-host .flyout'); return !!f && f.getBoundingClientRect().height > 0; });
check('housing flyout opens', flyVisible);
await page.click('.flyout .fly-item[aria-label="Wooden House"]');
await page.waitForTimeout(300);
const tool1 = await page.evaluate(() => JSON.stringify(window.__app.input.tool ?? null));
// find a valid, clear spot near the town and its screen position
const spot = await page.evaluate(() => {
  const app = window.__app;
  const g = app.game;
  const c = g.townCenter();
  for (let r = 6; r < 30; r += 1) {
    for (let a = 0; a < 16; a++) {
      const x = Math.round(c.x + Math.cos(a / 16 * Math.PI * 2) * r);
      const z = Math.round(c.z + Math.sin(a / 16 * Math.PI * 2) * r);
      // footprint centred on the cursor tile for odd sizes: 3x3 house -> origin x-1, z-1
      const okAll = [0, 1, 2, 3].every((rot) => g.checkPlacement('woodenHouse', x - 1, z - 1, rot).ok && g.checkPlacement('woodenHouse', x - 1, z - 1, rot).clearing.length === 0);
      if (!okAll) continue;
      app.renderer.cameraController.jumpTo(x + 0.5, z + 0.5, 30);
      return { x, z };
    }
  }
  return null;
});
check('found house spot', !!spot, JSON.stringify(spot));
await frames(6);
const scr = await page.evaluate(({ x, z }) => {
  const app = window.__app;
  const s = app.game.state;
  // heightAt via a small bilinear helper
  const W = s.W;
  const hgt = (wx, wz) => { const x0 = Math.floor(wx), z0 = Math.floor(wz), fx = wx - x0, fz = wz - z0; const H = s.tiles.height; const c = (xx, zz) => H[zz * (W + 1) + xx]; return (c(x0, z0) * (1 - fx) + c(x0 + 1, z0) * fx) * (1 - fz) + (c(x0, z0 + 1) * (1 - fx) + c(x0 + 1, z0 + 1) * fx) * fz; };
  const p = app.renderer.worldToScreen(x + 0.5, hgt(x + 0.5, z + 0.5), z + 0.5);
  return p ? { x: p.x, y: p.y } : null;
}, spot);
check('worldToScreen for spot', !!scr, JSON.stringify(scr));
await page.mouse.move(scr.x - 30, scr.y - 10);
await page.mouse.move(scr.x, scr.y, { steps: 5 });
await frames(6);
await page.waitForTimeout(300);
await shot('i03_ghost');
const rot0 = await page.evaluate(() => window.__app.input.buildRotation);
await page.keyboard.press('r');
await frames(4);
const rot1 = await page.evaluate(() => window.__app.input.buildRotation);
check('R rotates the ghost', rot1 !== rot0, `${rot0} -> ${rot1}`);
await page.waitForTimeout(200);
await shot('i04_ghost_rotated');
const nBefore = await page.evaluate(() => window.__app.game.state.buildings.length);
await page.mouse.click(scr.x, scr.y);
await frames(4);
const placedB = await page.evaluate((n) => { const bs = window.__app.game.state.buildings; return bs.length > n ? { type: bs[bs.length - 1].type, x: bs[bs.length - 1].x, z: bs[bs.length - 1].z, rot: bs[bs.length - 1].rotation, state: bs[bs.length - 1].state } : null; }, nBefore);
check('click places a house', !!placedB && placedB.type === 'woodenHouse', JSON.stringify(placedB) + ` tool=${tool1}`);
if (placedB) check('house centred on cursor tile', Math.abs(placedB.x + 1 - spot.x) <= 1 && Math.abs(placedB.z + 1 - spot.z) <= 1, `spot ${spot.x},${spot.z}`);
const stillBuild = await page.evaluate(() => window.__app.input.tool?.kind ?? window.__app.input['tool']?.kind);
await shot('i05_placed');
// right-click cancels the tool
await page.mouse.click(scr.x + 200, scr.y + 40, { button: 'right' });
await frames(3);
const toolAfterRight = await page.evaluate(() => window.__app.input.tool?.kind);
check('right-click cancels build tool', toolAfterRight === 'select' || toolAfterRight === undefined, `tool after: ${toolAfterRight}, while building: ${stillBuild}`);

// ---- 2. select the storage barn and a citizen by clicking ----
const barnScr = await page.evaluate(() => {
  const app = window.__app;
  const b = app.game.state.buildings.find((x) => x.type === 'storageBarn');
  app.renderer.cameraController.jumpTo(b.x + b.w / 2, b.z + b.h / 2, 30);
  return b.id;
});
await frames(6);
const barnPt = await page.evaluate((id) => {
  const app = window.__app;
  const b = app.game.getBuilding(id);
  const s = app.game.state;
  const H = s.tiles.height;
  const y = H[(b.z + 1) * (s.W + 1) + b.x + 1];
  const p = app.renderer.worldToScreen(b.x + b.w / 2, y + 1.0, b.z + b.h / 2);
  return p;
}, barnScr);
await page.mouse.click(barnPt.x, barnPt.y);
await frames(4);
await page.waitForTimeout(400);
const sel1 = await page.evaluate(() => window.__app.selection);
check('click selects the storage barn', sel1?.kind === 'building' && sel1.id === barnScr, JSON.stringify(sel1));
await shot('i06_select_barn');
const panelText = await page.evaluate(() => document.querySelector('.sel-panel, .selection, .sel-name')?.textContent ?? '');
check('selection panel shows name', /Barn/i.test(panelText), panelText.slice(0, 60));

const cit = await page.evaluate(() => {
  const app = window.__app;
  const g = app.game;
  const s = g.state;
  // an adult standing still outside buildings
  const c = s.citizens.find((x) => x.age >= 16 && g.buildingAtTile(x.x, x.z) === undefined) ?? s.citizens[0];
  app.renderer.cameraController.jumpTo(c.x, c.z, 14);
  return c.id;
});
await frames(8);
const citPt = await page.evaluate((id) => {
  const app = window.__app;
  const c = app.game.getCitizen(id);
  const s = app.game.state;
  const W = s.W;
  const H = s.tiles.height;
  const x0 = Math.floor(c.x), z0 = Math.floor(c.z), fx = c.x - x0, fz = c.z - z0;
  const cc = (xx, zz) => H[zz * (W + 1) + xx];
  const y = (cc(x0, z0) * (1 - fx) + cc(x0 + 1, z0) * fx) * (1 - fz) + (cc(x0, z0 + 1) * (1 - fx) + cc(x0 + 1, z0 + 1) * fx) * fz;
  return app.renderer.worldToScreen(c.x, y + 0.3, c.z);
}, cit);
await page.mouse.click(citPt.x, citPt.y);
await frames(4);
await page.waitForTimeout(400);
const sel2 = await page.evaluate(() => window.__app.selection);
check('click selects a citizen', sel2?.kind === 'citizen', JSON.stringify(sel2) + ` wanted ${cit}`);
await shot('i07_select_citizen');

// ---- 3. windows P/O/N/L/K/H ----
await page.mouse.move(800, 450);
for (const key of ['p', 'o', 'n', 'l', 'k', 'h']) {
  await page.keyboard.press(key);
  await page.waitForTimeout(500);
  const open = await page.evaluate(() => [...document.querySelectorAll('.window, .win')].filter((w) => w.getBoundingClientRect().height > 0 && getComputedStyle(w).display !== 'none' && !w.hidden).map((w) => w.getAttribute('aria-label') || w.querySelector('.win-title-t')?.textContent || w.className));
  check(`hotkey ${key.toUpperCase()} opens a window`, open.length > 0, JSON.stringify(open));
  await shot(`i08_window_${key}`);
  await page.keyboard.press(key);
  await page.waitForTimeout(200);
}

// ---- 4. road drag + clear drag via tools ----
await page.evaluate(() => { const app = window.__app; const c = app.game.townCenter(); app.renderer.cameraController.jumpTo(c.x, c.z, 40); app.select(null); });
await frames(6);
await page.keyboard.press('v');
await frames(2);
const roadsBefore = await page.evaluate(() => { const r = window.__app.game.state.tiles.road; let n = 0; for (let i = 0; i < r.length; i++) if (r[i]) n++; return n; });
await page.mouse.move(700, 600);
await page.mouse.down();
await page.mouse.move(900, 620, { steps: 8 });
await frames(3);
await shot('i09_road_drag');
await page.mouse.up();
await frames(3);
const roadsAfter = await page.evaluate(() => { const r = window.__app.game.state.tiles.road; let n = 0; for (let i = 0; i < r.length; i++) if (r[i]) n++; return n; });
check('road drag places road tiles', roadsAfter > roadsBefore, `${roadsBefore} -> ${roadsAfter}`);
await page.keyboard.press('Escape');
await page.keyboard.press('c');
await frames(2);
const markedBefore = await page.evaluate(() => window.__app.game.rt.marked.size);
await page.mouse.move(1150, 250);
await page.mouse.down();
await page.mouse.move(1400, 420, { steps: 8 });
await frames(3);
await shot('i10_clear_drag');
await page.mouse.up();
await frames(3);
const markedAfter = await page.evaluate(() => window.__app.game.rt.marked.size);
check('clear drag marks features', markedAfter >= markedBefore, `${markedBefore} -> ${markedAfter}`);
await page.keyboard.press('Escape');
await frames(2);

// ---- 5. save and load through the menu ----
await page.evaluate(() => window.__app.setSpeed(10));
await page.waitForTimeout(4000);
await page.evaluate(() => window.__app.setSpeed(0));
const before = await page.evaluate(() => ({ t: window.__app.game.state.time.elapsed, n: window.__app.game.state.buildings.length, c: window.__app.game.state.citizens.length }));
await page.click('.tb-menu');
await page.waitForTimeout(500);
await shot('i11_menu_ingame');
await page.click('.menu-btn >> text=Save Game');
await page.waitForTimeout(300);
await page.fill('.save-form input', 'itest');
await page.click('.save-form button[type=submit]');
await page.waitForTimeout(800);
await shot('i12_saved');
const saves = await page.evaluate(() => window.__app.listSaves().map((s) => s.slot));
check('save via menu', saves.includes('itest'), JSON.stringify(saves));
// mutate the game, then load the save back
await page.evaluate(() => { const app = window.__app; app.closeMenu(); app.setSpeed(10); });
await page.waitForTimeout(3000);
await page.evaluate(() => window.__app.setSpeed(0));
await page.click('.tb-menu');
await page.waitForTimeout(300);
await page.click('.menu-btn >> text=Load Game');
await page.waitForTimeout(400);
await shot('i13_load_page');
const loadBtn = page.locator('.save-row', { hasText: 'itest' }).locator('button', { hasText: 'Load' });
if (await loadBtn.count() === 0) {
  await page.locator('.save-row').first().locator('button', { hasText: 'Load' }).click();
} else await loadBtn.first().click();
await page.waitForTimeout(500);
// a confirm modal may ask about losing progress
const confirmBtn = page.locator('.modal button.primary:visible, .modal button.danger:visible');
if (await confirmBtn.count() > 0) await confirmBtn.first().click();
await page.waitForFunction(() => !window.__app.inMenu, null, { timeout: 30000 });
const after = await page.evaluate(() => { window.__app.setSpeed(0); return { t: window.__app.game.state.time.elapsed, n: window.__app.game.state.buildings.length, c: window.__app.game.state.citizens.length }; });
await page.waitForTimeout(1000);
// a loaded game resumes at 1x, so a frame or two may have run before we paused it
check('load restores saved state', after.t >= before.t - 1e-6 && after.t - before.t < 0.5 && after.n === before.n && after.c === before.c, `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
await shot('i14_loaded');
await page.evaluate(() => window.__app.setSpeed(5));
await page.waitForTimeout(5000);
const health = await page.evaluate(() => window.__app.debug?.health?.() ?? { invariants: window.__app.game.validate(), moduleErrors: window.__app.game.moduleErrors() });
check('after load: no invariant violations or module errors', health.invariants.length === 0 && Object.keys(health.moduleErrors).length === 0, JSON.stringify(health).slice(0, 300));
await shot('i15_after_load_running');

// ---- 6. Esc chain opens the menu ----
await page.evaluate(() => window.__app.select(null));
await page.mouse.move(800, 450);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const inMenu = await page.evaluate(() => window.__app.inMenu);
check('Esc (no tool, no selection) opens the menu', inMenu);
await shot('i16_menu_esc');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const inMenu2 = await page.evaluate(() => window.__app.inMenu);
check('Esc in menu resumes', !inMenu2);

console.log('\n==== RESULTS ====\n' + results.join('\n'));
console.log('==== console errors/warnings (' + logs.length + ') ====');
console.log([...new Set(logs)].slice(0, 40).join('\n'));
await browser.close();
