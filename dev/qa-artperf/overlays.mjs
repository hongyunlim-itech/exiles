// Placement ghost (valid/invalid/clearing), zone drag, road drag, clear-rect, selection highlights, grid, toast stack.
import { open } from './lib.mjs';

const { browser, page, logs, shot } = await open();
await page.evaluate(() => { const s = window.__app.game.state; s.weather.precipitation = 'none'; s.weather.precipIntensity = 0; s.time.dayTime = 0.45; });
const c = await page.evaluate(() => window.__app.game.townCenter());
// find a free buildable spot near town, a water tile and a forest tile
const spots = await page.evaluate(([cx, cz]) => {
  const g = window.__app.game; const s = g.state;
  let free = null, water = null, forest = null;
  for (let r = 6; r < 60 && !(free && water && forest); r++) {
    for (let a = 0; a < 64; a++) {
      const x = Math.round(cx + Math.cos(a / 64 * Math.PI * 2) * r); const z = Math.round(cz + Math.sin(a / 64 * Math.PI * 2) * r);
      if (x < 2 || z < 2 || x >= s.W - 4 || z >= s.H - 4) continue;
      if (!free && g.checkPlacement('woodenHouse', x - 1, z - 1, 0).ok && g.checkPlacement('woodenHouse', x - 1, z - 1, 0).clearing.length === 0) free = { x, z };
      const i = z * s.W + x;
      if (!water && s.tiles.terrain[i] === 3) water = { x, z };
      if (!forest && s.tiles.feature[i] === 1 && s.tiles.feature[i + 1] === 1 && s.tiles.feature[i + s.W] === 1) forest = { x, z };
    }
  }
  return { free, water, forest };
}, [c.x, c.z]);
console.log('spots', JSON.stringify(spots));
const toScreen = (wx, wz) => page.evaluate(([x, z]) => { const app = window.__app; const y = app.renderer.cameraController.groundHeightAt ? app.renderer.cameraController.groundHeightAt(x, z) : 0; return app.renderer.worldToScreen(x, Math.max(0, y), z); }, [wx, wz]);
const ghost = async (name, type, at) => {
  await page.evaluate(([x, z, t]) => { window.__look(x, z, 22, 0.7, 0.6); window.__app.setTool({ kind: 'build', type: t }); }, [at.x + 0.5, at.z + 0.5, type]);
  await page.evaluate(() => window.__frames(3));
  const p = await toScreen(at.x + 0.5, at.z + 0.5);
  await page.mouse.move(p.x - 20, p.y - 10); await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.evaluate(() => window.__frames(4));
  await shot(name);
};
await ghost('o01_ghost_house_valid', 'woodenHouse', spots.free);
await ghost('o02_ghost_house_forest_clearing', 'woodenHouse', spots.forest);
await ghost('o03_ghost_house_water_invalid', 'woodenHouse', spots.water);
await ghost('o04_ghost_chapel', 'chapel', spots.free);
await ghost('o05_ghost_fishingdock', 'fishingDock', spots.water);
// zone drag (crop field)
await page.evaluate(([x, z]) => { window.__look(x, z, 26, 0.75, 0.6); window.__app.setTool({ kind: 'build', type: 'cropField' }); }, [spots.free.x + 3, spots.free.z + 3]);
await page.evaluate(() => window.__frames(3));
{
  const a = await toScreen(spots.free.x - 2, spots.free.z - 2); const b = await toScreen(spots.free.x + 7, spots.free.z + 6);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.evaluate(() => window.__frames(4));
  await shot('o06_zone_drag_field');
  await page.mouse.up({ button: 'left' });
  await page.evaluate(() => window.__frames(2));
  // undo placement if it happened
  await page.evaluate(() => { const g = window.__app.game; const b = g.state.buildings[g.state.buildings.length - 1]; if (b.type === 'cropField' && b.state !== 'active') g.demolish(b.id); });
}
await page.keyboard.press('Escape');
// road drag
await page.evaluate(([x, z]) => { window.__look(x, z, 24, 0.75, 0.6); window.__app.setTool({ kind: 'road', road: 'stone' }); }, [spots.free.x, spots.free.z]);
await page.evaluate(() => window.__frames(3));
{
  const a = await toScreen(spots.free.x - 6, spots.free.z - 3); const b = await toScreen(spots.free.x + 6, spots.free.z + 5);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.evaluate(() => window.__frames(4));
  await shot('o07_road_drag');
  await page.mouse.move(a.x, a.y, { steps: 2 });
  await page.mouse.up();
}
await page.keyboard.press('Escape');
// clear tool rect over forest
await page.evaluate(([x, z]) => { window.__look(x, z, 24, 0.75, 0.6); window.__app.setTool({ kind: 'clear', filter: 'all' }); }, [spots.forest.x, spots.forest.z]);
await page.evaluate(() => window.__frames(3));
{
  const a = await toScreen(spots.forest.x - 4, spots.forest.z - 4); const b = await toScreen(spots.forest.x + 4, spots.forest.z + 3);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.evaluate(() => window.__frames(4));
  await shot('o08_clear_drag');
  await page.keyboard.press('Escape');
  await page.mouse.up();
}
await page.evaluate(() => window.__app.setTool({ kind: 'select' }));
// selection: building & citizen
await page.evaluate(() => { const app = window.__app; const b = window.__b('tavern', 0) ?? window.__b('chapel', 0); app.select({ kind: 'building', id: b.id }); window.__lookB(b, 14, 0.5, window.__frontYaw(b, 0.6)); });
await page.evaluate(() => window.__frames(5));
await shot('o09_select_building');
await page.evaluate(() => { const app = window.__app; const b = window.__b('gathererHut', 0); app.select({ kind: 'building', id: b.id }); window.__lookB(b, 40, 0.8, 0.6); });
await page.evaluate(() => window.__frames(5));
await shot('o10_select_workplace_radius');
await page.evaluate(() => { const app = window.__app; const g = app.game; const cz = g.state.citizens.find((x) => x.moving && x.age > 16) ?? g.state.citizens[0]; app.select({ kind: 'citizen', id: cz.id }); window.__look(cz.x, cz.z, 9, 0.45, 0.8); });
await page.evaluate(() => window.__frames(5));
await shot('o11_select_citizen');
await page.evaluate(() => window.__app.select(null));
// demolish hover highlight
await page.evaluate(() => { const b = window.__b('woodenHouse', 1); window.__lookB(b, 16, 0.6, 0.6); window.__app.setTool({ kind: 'demolish' }); });
await page.evaluate(() => window.__frames(3));
{
  const b = await page.evaluate(() => { const b = window.__b('woodenHouse', 1); return { x: b.x + b.w / 2, z: b.z + b.h / 2 }; });
  const p = await toScreen(b.x, b.z);
  await page.mouse.move(p.x - 10, p.y); await page.mouse.move(p.x, p.y - 5, { steps: 3 });
  await page.evaluate(() => window.__frames(4));
  await shot('o12_demolish_hover');
}
await page.evaluate(() => window.__app.setTool({ kind: 'select' }));
// grid
await page.evaluate(([x, z]) => { window.__look(x, z, 30, 0.8, 0.6); window.__app.renderer.applySettings({ showGrid: true }); }, [c.x, c.z]);
await page.evaluate(() => window.__frames(3));
await shot('o13_grid');
await page.evaluate(() => window.__app.renderer.applySettings({ showGrid: false }));
// toast stack
const toastInfo = await page.evaluate(async () => {
  const ui = window.__app.ui; const g = window.__app.game;
  const msgs = [
    ['A child was born to the Smith family.', 'good'],
    ['Food is running low: about 1 month of food left.', 'warning'],
    ['Firewood is running low with winter approaching.', 'warning'],
    ['Aldric Thatcher died of old age at 71.', 'info'],
    ['The tavern is on fire! Citizens are rushing to put it out.', 'danger'],
    ['Construction of the Chapel is waiting for materials: stone 40, iron 10.', 'warning'],
    ['A merchant has arrived at the trading post.', 'good'],
    ['Nomads have arrived at the town hall and ask to join.', 'info'],
  ];
  for (const [t, s] of msgs) g.addMessage(t, s);
  await window.__frames(8);
  const el = document.querySelector('.toasts');
  const r = el.getBoundingClientRect();
  const items = [...el.querySelectorAll('.toast')].map((t) => Math.round(t.getBoundingClientRect().height));
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width), count: items.length, items, rootFont: getComputedStyle(document.documentElement).fontSize, vh: innerHeight };
});
console.log('toasts', JSON.stringify(toastInfo));
await page.evaluate(([x, z]) => window.__look(x, z, 30, 0.75, 0.6), [c.x, c.z]);
await page.evaluate(() => window.__frames(3));
await shot('o14_toast_stack');
console.log([...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
