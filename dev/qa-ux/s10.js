await page.mouse.move(810, 480, {steps:3});
await page.waitForTimeout(400);
const t1 = await page.evaluate(()=>document.querySelector('.hover-info, .ui-hover, [class*=hover]')?.innerText);
await page.mouse.click(810, 480);
await page.waitForTimeout(500);
// hunting cabin
await page.mouse.click(685, 850);
await page.waitForTimeout(600);
await page.mouse.click(670, 712);
await page.waitForTimeout(300);
await page.mouse.move(700, 560, {steps:5});
await page.waitForTimeout(500);
const t2 = await page.evaluate(()=>document.querySelector('.hover-info, .ui-hover, [class*=hover]')?.innerText);
await shot('16_hunter_ghost');
await page.mouse.click(700, 560);
await page.waitForTimeout(500);
const bs = await page.evaluate(()=>window.__app.game.state.buildings.map(b=>`${b.id}:${b.type}@${b.x},${b.z} r${b.rotation} ${b.state}`));
return [t1,t2,bs, await shot('17_after_food')];
