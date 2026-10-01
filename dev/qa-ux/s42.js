await page.keyboard.press('Escape'); await page.waitForTimeout(200);
const tool = await page.evaluate(()=>({tool: window.__app.input.tool, fly: [...document.querySelectorAll('.flyout')].filter(e=>!e.hidden).length, menu: window.__app.inMenu}));
await page.mouse.click(1454, 23); await page.waitForTimeout(200);  // 2x button
const sp = await page.evaluate(()=>window.__app.game.speed);
await page.waitForTimeout(45000);
await page.keyboard.press('Space');
const st = await page.evaluate(()=>{const g=window.__app.game,s=g.state; const tot=g.resourceTotals(); return {time:s.time.month+'/'+s.time.year, stone: tot.stone, marked: g.rt.marked.size, msgs: s.messages.slice(-5).map(m=>m.text), bs: s.buildings.filter(b=>b.state!=='active').map(b=>b.type+':'+b.state)}});
return [tool, sp, st];
