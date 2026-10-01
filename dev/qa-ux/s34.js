await page.keyboard.press('l'); await page.waitForTimeout(600);
await shot('37_hunter_view');
await page.mouse.click(1374, 397); await page.waitForTimeout(500);
const pr = await page.evaluate(()=>{const b=window.__app.game.getBuilding(56); return {priority:b.priority, paused:b.paused}});
await shot('37b_hunter_priority', {clip:{x:1230,y:60,width:370,height:380}});
return pr;
