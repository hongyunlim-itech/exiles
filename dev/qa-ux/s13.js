await page.mouse.click(758, 850); await page.waitForTimeout(400);
await page.mouse.click(735, 655); await page.waitForTimeout(300);
await page.mouse.move(1190, 470, {steps:4}); await page.waitForTimeout(500);
const h1 = await page.evaluate(()=>document.querySelector('[class*=hover]')?.innerText);
await page.mouse.click(1190, 470); await page.waitForTimeout(400);
// forester lodge
await page.mouse.click(758, 850); await page.waitForTimeout(400);
await page.mouse.click(517, 655); await page.waitForTimeout(300);
await page.mouse.move(1290, 560, {steps:4}); await page.waitForTimeout(500);
const h2 = await page.evaluate(()=>document.querySelector('[class*=hover]')?.innerText);
await shot('20_forester_ghost', {type:'jpeg', quality:70});
await page.mouse.click(1290, 560); await page.waitForTimeout(400);
await page.mouse.click(1200, 300, {button:'right'}); await page.waitForTimeout(200);
const bs = await page.evaluate(()=>window.__app.game.state.buildings.map(b=>`${b.id}:${b.type}@${b.x},${b.z} r${b.rotation} ${b.state}`));
return [h1,h2,bs];
