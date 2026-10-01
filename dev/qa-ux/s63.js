await page.mouse.click(511, 492); await page.waitForTimeout(500);
await shot('51_prof_hunter_exp', {clip:{x:450,y:470,width:525,height:100}});
// click the building name row
await page.mouse.click(570, 527); await page.waitForTimeout(1200);
const sel = await page.evaluate(()=>window.__app.selection);
await shot('52_after_click_building_row');
return sel;
