// Playwright visual self-check for the input tools. Usage: node dev/input/shoot.mjs [baseUrl]
// Expects `npx vite --port 5205` running at the project root.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:5205';
const outDir = join(dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
});

await page.goto(`${base}/dev/input/index.html`);
await page.waitForFunction(() => window.__sb?.ready, null, { timeout: 60000 });
await page.waitForTimeout(500);
page.on('console', (m) => {
  if (m.text().startsWith('[sb]')) console.log(m.text());
});
await page.evaluate(() => {
  const app = window.__sb.app;
  const orig = app.select;
  app.select = (sel) => {
    console.log(`[sb] select ${JSON.stringify(sel)} <- ${new Error().stack.split(String.fromCharCode(10)).slice(2, 5).map((l) => l.trim().split(' ')[1]).join(' < ')}`);
    orig(sel);
  };
});

const sb = (fn, arg) => page.evaluate(fn, arg);
const screen = (x, z) => sb(([x, z]) => window.__sb.tileToScreen(x, z), [x, z]);
async function hover(x, z) {
  const p = await screen(x, z);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.waitForTimeout(250);
}
async function shot(name) {
  await page.waitForTimeout(200);
  await sb(() => window.__sb.freeze(true));
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  await sb(() => window.__sb.freeze(false));
  const hoverText = await sb(() => window.__sb.hover);
  console.log(`[shot] ${name}  hover="${hoverText}"`);
}
const setTool = (tool) => sb((t) => window.__sb.app.setTool(t), tool);
async function zoom(d) {
  await sb((d) => { window.__sb.renderer.cameraController.distance = d; }, d);
  await page.waitForTimeout(200); // let the camera re-render before projecting tiles to the screen
}

const start = await sb(() => ({ x: window.__sb.game.startX, z: window.__sb.game.startZ }));
console.log('start', start);

// Find interesting spots near the start.
const spots = await sb(({ sx, sz }) => {
  const g = window.__sb.game;
  const s = g.state;
  const t = s.tiles;
  const at = (x, z) => z * s.W + x;
  let forest = null;
  let shore = null;
  let bestTrees = 0;
  for (let r = 3; r < 40 && (!forest || !shore); r++) {
    for (let z = sz - r; z <= sz + r; z++) {
      for (let x = sx - r; x <= sx + r; x++) {
        if (x < 2 || z < 2 || x >= s.W - 2 || z >= s.H - 2) continue;
        if (!forest) {
          let trees = 0;
          let land = 0;
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
            const i = at(x + dx, z + dz);
            if (t.feature[i] === 1) trees++;
            if (t.terrain[i] <= 1) land++;
          }
          if (land === 9 && trees >= 3 && trees < 8 && trees > bestTrees) { bestTrees = trees; forest = { x, z }; }
        }
        if (!shore && t.terrain[at(x, z)] <= 1 && t.terrain[at(x + 1, z)] === 2) shore = { x, z };
      }
    }
  }
  return { forest, shore };
}, { sx: start.x, sz: start.z });
console.log('spots', spots);

// 1. House ghost on open ground
await zoom(20);
await setTool({ kind: 'build', type: 'woodenHouse' });
await hover(start.x, start.z);
await shot('01-house-ok');
// R rotates
await page.keyboard.press('KeyR');
await page.waitForTimeout(150);
console.log('rotation after R =', await sb(() => window.__sb.input.buildRotation));
await shot('01b-house-rotated');

// 2. House over trees → yellow clearing
if (spots.forest) {
  await sb(({ x, z }) => window.__sb.app.focusOn(x + 0.5, z + 0.5), spots.forest);
  await page.waitForTimeout(150);
  await hover(spots.forest.x, spots.forest.z);
  await shot('02-house-clearing');
}

// 3. Fishing dock on shore / house on water → red
if (spots.shore) {
  await sb(({ x, z }) => window.__sb.app.focusOn(x + 0.5, z + 0.5), spots.shore);
  await page.waitForTimeout(150);
  await hover(spots.shore.x + 1, spots.shore.z);
  await shot('03-house-blocked');
  await setTool({ kind: 'build', type: 'fishingDock' });
  await hover(spots.shore.x, spots.shore.z);
  await shot('03b-dock-shore');
}

// 4. Gatherer's hut: place one, then show cursor ring + faint ring of the existing hut
await zoom(55);
await sb(({ x, z }) => window.__sb.app.focusOn(x + 0.5, z + 0.5), start);
await page.waitForTimeout(150);
await setTool({ kind: 'build', type: 'gathererHut' });
await hover(start.x + 6, start.z);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(200);
console.log('buildings after place:', await sb(() => window.__sb.game.state.buildings.map((b) => `${b.type}@${b.x},${b.z}`)));
await hover(start.x - 6, start.z + 3);
await shot('04-gatherer-rings');

// 5. Crop field zone drag with size label
await zoom(34);
await setTool({ kind: 'build', type: 'cropField' });
{
  const a = await screen(start.x - 10, start.z + 6);
  const b = await screen(start.x - 1, start.z + 12);
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.waitForTimeout(250);
  await shot('05-zone-drag');
  await page.mouse.up();
  await page.waitForTimeout(200);
}

// 6. Road L-drag
await setTool({ kind: 'road', road: 'dirt' });
{
  const a = await screen(start.x - 12, start.z - 5);
  const b = await screen(start.x + 8, start.z - 1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.waitForTimeout(250);
  await shot('06-road-drag');
  await page.mouse.up();
  await page.waitForTimeout(200);
}

// 7. Clear area drag over forest
if (spots.forest) {
  await sb(({ x, z }) => window.__sb.app.focusOn(x + 0.5, z + 0.5), spots.forest);
  await page.waitForTimeout(150);
  await setTool({ kind: 'clear', filter: 'all' });
  const a = await screen(spots.forest.x - 5, spots.forest.z - 4);
  const b = await screen(spots.forest.x + 5, spots.forest.z + 4);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.waitForTimeout(250);
  await shot('07-clear-drag');
  await page.mouse.up();
  await page.waitForTimeout(300);
  await shot('07b-cleared-marked');
}

// 8. Demolish hover + click (fake confirm resolves true)
await zoom(30);
await sb(({ x, z }) => window.__sb.app.focusOn(x + 0.5, z + 0.5), start);
await page.waitForTimeout(150);
await setTool({ kind: 'demolish' });
await hover(start.x + 6, start.z);
await shot('08-demolish-hover');

// 9. Select the hut → selection ring; right click deselects
await zoom(50);
await setTool({ kind: 'select' });
await hover(start.x + 6, start.z);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(200);
console.log('selection:', await sb(() => window.__sb.app.selection));
await hover(start.x + 2, start.z + 2);
await shot('09-selection-ring');

// 10. Right-click cancels tool; Esc chain; Space pause; digits; G grid
await setTool({ kind: 'build', type: 'well' });
await hover(start.x, start.z);
await page.mouse.click((await screen(start.x, start.z)).x, (await screen(start.x, start.z)).y, { button: 'right' });
await page.waitForTimeout(100);
console.log('after right-click tool =', JSON.stringify(await sb(() => window.__sb.input.tool)));
await page.keyboard.press('Space');
console.log('after Space speed =', await sb(() => window.__sb.game.speed));
await page.keyboard.press('Digit4');
console.log('after 4 speed =', await sb(() => window.__sb.game.speed));
await page.keyboard.press('Space');
await page.keyboard.press('Space');
console.log('after Space x2 speed =', await sb(() => window.__sb.game.speed));
await page.keyboard.press('KeyV');
console.log('after V tool =', JSON.stringify(await sb(() => window.__sb.input.tool)));
await page.keyboard.press('Escape');
console.log('after Esc tool =', JSON.stringify(await sb(() => window.__sb.input.tool)), 'selection', JSON.stringify(await sb(() => window.__sb.app.selection)));
await page.keyboard.press('Escape');
console.log('after Esc selection =', JSON.stringify(await sb(() => window.__sb.app.selection)));
await page.keyboard.press('Escape');
await page.keyboard.press('KeyG');
await page.waitForTimeout(150);
await shot('10-grid');

// 11. Delete key demolishes the selected building (confirm stub resolves true)
const hutId = await sb(() => window.__sb.game.state.buildings.find((b) => b.type === 'gathererHut')?.id ?? -1);
await sb((id) => window.__sb.app.select({ kind: 'building', id }), hutId);
await page.keyboard.press('Delete');
await page.waitForTimeout(100);
console.log('after Delete hut exists =', await sb((id) => !!window.__sb.game.getBuilding(id), hutId));

// 12. Perf probe: per-frame cost of input.update with the build tool active & pointer moving
await setTool({ kind: 'build', type: 'cropField' });
const perf = await sb(() => {
  const inp = window.__sb.input;
  const t0 = performance.now();
  for (let k = 0; k < 500; k++) inp.update(0.016);
  return (performance.now() - t0) / 500;
});
console.log(`input.update avg ${perf.toFixed(4)} ms (steady state)`);
console.log('log:', JSON.stringify(await sb(() => window.__sb.log)));
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
