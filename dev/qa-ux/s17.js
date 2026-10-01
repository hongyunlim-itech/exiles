await page.mouse.move(960, 180, {steps:3}); await page.waitForTimeout(500);
await shot('23_dock_ghost', {clip:{x:760,y:80,width:400,height:250}});
await page.keyboard.press('r'); await page.waitForTimeout(400);
const h1 = await page.evaluate(()=>document.querySelector('.ui-hover')?.innerText);
await shot('23b_dock_ghost_r', {clip:{x:760,y:80,width:400,height:250}});
await page.keyboard.press('r'); await page.waitForTimeout(400);
const h2 = await page.evaluate(()=>document.querySelector('.ui-hover')?.innerText);
await shot('23c_dock_ghost_rr', {clip:{x:760,y:80,width:400,height:250}});
return [h1,h2, await page.evaluate(()=>window.__app.input.buildRotation)];
