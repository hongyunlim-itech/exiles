// resume via Esc
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
await page.keyboard.press('Digit1'); await page.waitForTimeout(100);
const t0 = await page.evaluate(()=>window.__app.game.state.time.elapsed); const r0 = Date.now();
await page.waitForTimeout(3000);
const t1 = await page.evaluate(()=>window.__app.game.state.time.elapsed); const r1 = Date.now();
await shot('34_tmp', {clip:{x:0,y:0,width:400,height:50}});
const t2 = await page.evaluate(()=>window.__app.game.state.time.elapsed); const r2 = Date.now();
await shot('34_tmp2');
const t3 = await page.evaluate(()=>window.__app.game.state.time.elapsed); const r3 = Date.now();
await page.keyboard.press('Space');
return {wait:[t1-t0, r1-r0], clipShot:[t2-t1, r2-r1], fullShot:[t3-t2, r3-r2]};
