// Drive the REAL app (index.html) with Playwright to check input tools + audio in integration.
// Usage: node dev/input/real.mjs [baseUrl]   (serve with: npx vite --config dev/input/vite.sandbox.config.mjs)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:5205';
const outDir = join(dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' || m.type() === 'warning') && !t.includes('[vite]')) problems.push(`${m.type()}: ${t.slice(0, 400)}`);
  if (t.startsWith('[rt]')) console.log(t);
});

await page.goto(`${base}/index.html`);
await page.waitForFunction(() => window.__app, null, { timeout: 90000 });
await page.waitForTimeout(1000);

const ev = (fn, arg) => page.evaluate(fn, arg);
// Start a new game directly through the AppContext and freeze the sim so the scene is stable.
await ev(() => {
  const app = window.__app;
  app.newGame({ seed: 777, townName: 'Testford', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false });
  app.setSpeed(0);
  app.updateSettings({ quality: 'low', shadows: false });
  app.events.on('hoverInfo', ({ text }) => { window.__hover = text; });
});
await page.waitForTimeout(1500);

const info = await ev(() => {
  const app = window.__app;
  const s = app.game.state;
  const cc = app.renderer.cameraController;
  return { W: s.W, buildings: s.buildings.map((b) => `${b.type}@${b.x},${b.z}`), target: { x: cc.target.x, z: cc.target.z }, dist: cc.distance };
});
console.log('game', JSON.stringify(info));

const center = { x: 550, y: 340 };
async function shot(name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, `${name}.png`), timeout: 120000 });
  console.log(`[shot] ${name} hover=${JSON.stringify(await ev(() => window.__hover ?? null))}`);
}

// Unlock audio with a real gesture on the canvas (select tool: click empty ground).
await page.mouse.move(center.x, center.y);
await page.mouse.click(center.x + 150, center.y + 120);
await page.waitForTimeout(300);
console.log('audio running:', await ev(() => window.__app.audio.running));

// Build a wooden house near the camera focus.
await ev(() => window.__app.setTool({ kind: 'build', type: 'woodenHouse' }));
await page.mouse.move(center.x + 60, center.y + 40, { steps: 4 });
await shot('real-01-house-ghost');
const before = await ev(() => window.__app.game.state.buildings.length);
await page.mouse.click(center.x + 60, center.y + 40);
await page.waitForTimeout(200);
const after = await ev(() => window.__app.game.state.buildings.length);
console.log('placed house:', after > before, 'voices:', await ev(() => window.__app.audio.activeVoices));

// Gatherer hut rings (faint + cursor), then a zone drag.
await ev(() => window.__app.setTool({ kind: 'build', type: 'gathererHut' }));
await page.mouse.move(center.x - 200, center.y - 60, { steps: 4 });
await shot('real-02-gatherer');
await ev(() => window.__app.setTool({ kind: 'build', type: 'cropField' }));
await page.mouse.move(center.x - 250, center.y + 120);
await page.mouse.down();
await page.mouse.move(center.x - 90, center.y + 230, { steps: 8 });
await shot('real-03-field-drag');
await page.mouse.up();

// Road drag.
await ev(() => window.__app.setTool({ kind: 'road', road: 'dirt' }));
await page.mouse.move(center.x - 300, center.y - 150);
await page.mouse.down();
await page.mouse.move(center.x + 250, center.y - 60, { steps: 10 });
await shot('real-04-road-drag');
await page.mouse.up();

// Clear tool drag.
await ev(() => window.__app.setTool({ kind: 'clear', filter: 'all' }));
await page.mouse.move(center.x + 200, center.y - 250);
await page.mouse.down();
await page.mouse.move(center.x + 520, center.y - 60, { steps: 8 });
await shot('real-05-clear-drag');
await page.mouse.up();

// Select tool: click a building → selection ring; Esc chain.
await ev(() => window.__app.setTool({ kind: 'select' }));
const sel = await ev(() => {
  const app = window.__app;
  const b = app.game.state.buildings.find((x) => x.type === 'storageBarn') ?? app.game.state.buildings[0];
  if (!b) return null;
  const s = app.game.state;
  const cx = b.x + b.w / 2;
  const cz = b.z + b.h / 2;
  const y = s.tiles.height[Math.floor(cz) * (s.W + 1) + Math.floor(cx)];
  return app.renderer.worldToScreen(cx, y + 0.5, cz);
});
if (sel?.visible) {
  await page.mouse.click(sel.x, sel.y);
  await page.waitForTimeout(200);
  console.log('selection after click:', JSON.stringify(await ev(() => window.__app.selection)));
}
await page.keyboard.press('KeyG');
await shot('real-06-select-grid');
await page.keyboard.press('KeyG');
await page.keyboard.press('Escape');
console.log('after Esc selection:', JSON.stringify(await ev(() => window.__app.selection)));

// Perf: time input.update + audio.update in the real app.
const perf = await ev(() => {
  const app = window.__app;
  const cc = app.renderer.cameraController;
  const t0 = performance.now();
  for (let k = 0; k < 300; k++) app.input.update(0.016);
  const t1 = performance.now();
  for (let k = 0; k < 300; k++) app.audio.update(0.016, cc.target.x, cc.target.z, cc.distance);
  const t2 = performance.now();
  return { input: (t1 - t0) / 300, audio: (t2 - t1) / 300 };
});
console.log(`perf input.update ${perf.input.toFixed(4)} ms, audio.update ${perf.audio.toFixed(4)} ms`);
// Run the sim for a bit at 10x to hear/see event sounds and check for errors.
await ev(() => window.__app.setSpeed(10));
await page.waitForTimeout(4000);
console.log('voices after sim:', await ev(() => window.__app.audio.activeVoices));
console.log('problems:', problems.length ? '\n' + problems.join('\n') : 'none');
await browser.close();
