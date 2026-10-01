await page.mouse.click(1364, 480); await page.waitForTimeout(300);
for (let i=0;i<3;i++){ await page.mouse.click(1262, 230); await page.waitForTimeout(250); }
await page.waitForTimeout(300);
const b = await page.evaluate(()=>{const b=window.__app.game.getBuilding(56); return {pr:b.priority, wd:b.workersDesired, w:b.workerIds.length}});
await shot('53_hunter_zero', {clip:{x:1230,y:60,width:370,height:450}});
return b;
