// Behavioural checks of the UI against the sandbox mock. Usage: node dev/ui/interact.mjs
import { chromium } from 'playwright';

const BASE = process.env.UI_BASE ?? 'http://localhost:5204/dev/ui/index.html';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);
const visible = (sel) => ev((s) => { const e = document.querySelector(s); return !!e && !e.closest('[hidden]') && e.getClientRects().length > 0; }, sel);

await page.goto(`${BASE}?scene=game`, { waitUntil: 'networkidle' });
await wait(400);
// nomads dialog auto-opens in this scene
check('nomads dialog auto-opens', await visible('.w-nomads'));
await page.keyboard.press('Escape');
await wait(100);
check('Esc closes dialog first', !(await visible('.w-nomads')));

// speed buttons
await page.click('.tb-spd:nth-child(3)');
check('speed 2x via button', (await ev(() => window.__game.speed)) === 2);
check('speed button highlighted', await ev(() => document.querySelector('.tb-spd:nth-child(3)').classList.contains('on')));
await page.click('.tb-spd:nth-child(1)');
check('pause via button', (await ev(() => window.__game.speed)) === 0);
check('paused badge shown', await visible('.paused-badge'));
await page.click('.tb-spd:nth-child(1)');
check('pause toggles back to 1x', (await ev(() => window.__game.speed)) === 1);

// hotkeys
await page.keyboard.press('p');
await wait(50);
check('P opens professions', await visible('.w-prof'));
await page.keyboard.press('k');
await wait(50);
check('K opens statistics', await visible('.w-stats'));
check('winbar reflects open window', await ev(() => document.querySelectorAll('.win-btn.on').length === 2));
const escDefault = await ev(() => {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
});
await wait(50);
check('Esc closes top window (stats) and is consumed', escDefault && !(await visible('.w-stats')) && (await visible('.w-prof')));
await page.keyboard.press('p');
await wait(50);
check('P toggles professions closed', !(await visible('.w-prof')));
const escFree = await ev(() => {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
});
check('Esc with nothing open is left to input (not prevented)', !escFree);

// typing guard
await page.keyboard.press('n');
await wait(50);
await page.click('.w-citizens .search');
await page.keyboard.type('pk');
await wait(50);
check('typing in search does not toggle windows', !(await visible('.w-prof')) && !(await visible('.w-stats')));
check('search filters list', await ev(() => document.querySelectorAll('.cl-list .cl-row').length < window.__game.state.citizens.length));
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await wait(50);

// pointer over UI
await page.mouse.move(800, 20);
await wait(20);
check('pointer over top bar => isPointerOverUI', await ev(() => window.__ui.isPointerOverUI()));
await page.mouse.move(800, 450);
await wait(20);
check('pointer over canvas => !isPointerOverUI', !(await ev(() => window.__ui.isPointerOverUI())));

// hover info
await ev(() => window.__app.events.emit('hoverInfo', { text: 'Tree (mature)' }));
await page.mouse.move(700, 500);
await wait(30);
check('hover info shown over canvas', await visible('.ui-hover'));
await page.mouse.move(800, 20);
await wait(30);
check('hover info hidden over UI', !(await visible('.ui-hover')));
await ev(() => window.__app.events.emit('hoverInfo', { text: null }));

// build flyout & tool
await page.click('.tool-btn:nth-child(1)');
await wait(80);
check('housing flyout opens', await visible('.flyout:not([hidden])'));
await page.click('.flyout:not([hidden]) .fly-item:nth-child(1)');
await wait(50);
const tool = await ev(() => window.__app.input.tool);
check('flyout item sets build tool', tool.kind === 'build' && tool.type === 'woodenHouse', JSON.stringify(tool));
check('flyout closes after pick', !(await visible('.flyout:not([hidden])')));
check('tool hint visible', await visible('.tool-hint'));
check('category button highlighted', await ev(() => document.querySelector('.tool-btn:nth-child(1)').classList.contains('on')));
const escTool = await ev(() => {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
});
check('Esc with tool active is left to input', !escTool);
await page.click('.hint-x');
check('hint cancel sets select tool', (await ev(() => window.__app.input.tool.kind)) === 'select');
// unaffordable item
await ev(() => { const b = window.__game.state.buildings.find((x) => x.type === 'stockpile'); b.inventory.iron = 0; });
await page.click('.tool-btn:nth-child(5)');
await wait(80);
const unaff = await ev(() => [...document.querySelectorAll('.flyout:not([hidden]) .fly-item.unaffordable')].length);
check('unaffordable buildings flagged', unaff > 0, `${unaff}`);
await page.click('.flyout:not([hidden]) .fly-item.unaffordable', { force: true });
check('unaffordable pick does not set tool', (await ev(() => window.__app.input.tool.kind)) === 'select');
await page.mouse.click(800, 450);
await wait(50);
check('click outside closes flyout', !(await visible('.flyout:not([hidden])')));

// selection panel: workers stepper, demolish confirm
const fieldId = await ev(() => window.__game.state.buildings.find((b) => b.type === 'cropField').id);
await ev((id) => window.__app.select({ kind: 'building', id }), fieldId);
await wait(80);
check('building panel opens', await visible('.sel-panel'));
const before = await ev((id) => window.__game.getBuilding(id).workersDesired, fieldId);
await page.click('.sel-panel .stepper .step-btn:last-child');
check('workers + increments', (await ev((id) => window.__game.getBuilding(id).workersDesired, fieldId)) === before + 1);
await page.click('.sel-panel .seg-btn:nth-child(2)');
check('crop selector sets crop', (await ev((id) => window.__game.getBuilding(id).crop, fieldId)) === 'beans');
await page.click('.sel-panel .btn.danger');
await wait(50);
check('demolish opens confirm', await visible('.modal-backdrop'));
await page.keyboard.press('Escape');
await wait(50);
check('Esc cancels confirm', !(await visible('.modal-backdrop')) && (await ev((id) => window.__game.getBuilding(id).state, fieldId)) === 'active');
await page.click('.sel-panel .btn.danger');
await wait(50);
await page.click('.modal .btn.danger');
await wait(350);
check('confirm demolish => demolishing', (await ev((id) => window.__game.getBuilding(id).state, fieldId)) === 'demolishing');
check('panel rebuilt for new state', await ev(() => document.querySelector('.sel-panel .badge').textContent === 'Being demolished'));
await page.click('.sel-panel .sel-btns .ibtn:last-child');
check('close button deselects', (await ev(() => window.__app.selection)) === null && !(await visible('.sel-panel')));

// citizen panel & links
const cid = await ev(() => window.__game.state.citizens[0].id);
await ev((id) => window.__app.select({ kind: 'citizen', id }), cid);
await wait(80);
check('citizen panel opens', await visible('.sel-view.cit'));
await page.click('.sel-view.cit .kv .link');
await wait(50);
check('home link selects building', (await ev(() => window.__app.selection?.kind)) === 'building');

// trade
await page.click('.tb-alert.merchant');
await wait(100);
check('trade window opens from alert', await visible('.w-trade'));
check('trade button disabled initially', await ev(() => document.querySelector('.w-trade .tr-actions .btn.primary').disabled));
await page.click('.w-trade .tr-buy >> nth=0');
await page.fill('.w-trade .tr-col:first-child .qty-input >> nth=0', '100');
await wait(50);
check('trade enabled when give >= take', !(await ev(() => document.querySelector('.w-trade .tr-actions .btn.primary').disabled)), await ev(() => document.querySelector('.tr-bal-text').textContent));
await page.click('.w-trade .tr-actions .btn.primary');
await wait(100);
check('trade executed (offer amount decreased)', (await ev(() => window.__game.state.trade.merchant.offers[0].amount)) === 0);
check('trade toast shown', await ev(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Trade complete'))));
await page.keyboard.press('Escape');

// nomads accept
await ev(() => { window.__game.state.nomads = { count: 5, expiresIn: 30, diseaseRisk: 0.1 }; });
await wait(400);
check('nomads dialog re-opens for new group', await visible('.w-nomads'));
await page.click('.w-nomads .btn.primary');
check('accept nomads clears state', (await ev(() => window.__game.state.nomads)) === null);

// game messages -> toasts
await ev(() => window.__game.addMessage('Test danger message', 'danger'));
await wait(50);
check('message event creates toast', await ev(() => [...document.querySelectorAll('.toast.sev-danger')].some((t) => t.textContent.includes('Test danger message'))));

// menu
await page.click('.tb-menu');
await wait(100);
check('menu opens in-game', (await visible('.menu')) && (await ev(() => window.__app.inMenu)));
check('HUD hidden behind menu', !(await visible('.topbar')));
check('pointer over menu counts as UI', await ev(() => window.__ui.isPointerOverUI()));
await page.click('.menu-btn >> text=Settings');
await wait(50);
await page.click('.settings .tgl >> nth=1');
await wait(50);
check('settings toggle updates app settings', (await ev(() => window.__app.settings.edgeScroll)) === true);
await page.keyboard.press('Escape');
await wait(50);
check('Esc backs out of settings page', (await visible('.menu')) && !(await visible('.settings')));
await page.keyboard.press('Escape');
await wait(50);
check('Esc resumes game from menu', !(await visible('.menu')) && !(await ev(() => window.__app.inMenu)));

// new game flow
await page.click('.tb-menu');
await page.click('.menu-btn >> text=New Game');
await page.fill('.ng-form input[aria-label="Town name"]', 'Testville');
await page.click('.ng-form button[type=submit]');
await wait(400);
check('new game applied', (await ev(() => window.__game.state.settings.townName)) === 'Testville' && !(await visible('.menu')));

// game over overlay
await ev(() => { window.__game.state.gameOver = true; });
await wait(400);
check('game over overlay shown', await visible('.go-overlay'));
await page.click('.go-box .btn >> text=Keep watching');
check('game over dismissable', !(await visible('.go-overlay')));

console.log(`\n${pass} passed, ${fail} failed`);
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
process.exit(fail ? 1 : 0);
