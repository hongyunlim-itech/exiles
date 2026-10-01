await page.keyboard.press('Space');
await page.waitForTimeout(300);
const r = await page.evaluate(() => ({ seed: window.__app.game.state.settings.seed, speed: window.__app.game.speed, name: window.__app.game.state.settings.townName, W: window.__app.game.state.W }));
// hover the resources
const tips = [];
for (const x of [430, 510, 590, 660, 740, 815, 885, 960, 1215, 1250, 1290, 1330]) {
  await page.mouse.move(x, 23);
  await page.waitForTimeout(500);
  const t = await page.evaluate(() => { const el = [...document.querySelectorAll('.tooltip, .tip, [class*=tooltip]')].filter(e => e.getBoundingClientRect().height>0 && getComputedStyle(e).display!=='none' && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).opacity !== '0'); return el.map(e=>e.innerText).join(' | '); });
  tips.push([x, t]);
  if (x === 430 || x === 1330) await shot('03_tip_' + x);
}
return { r, tips };
