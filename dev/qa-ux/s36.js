await page.mouse.click(985, 850); await page.waitForTimeout(500);
await page.mouse.click(960, 655); await page.waitForTimeout(300);
const tool = await page.evaluate(()=>window.__app.input.tool);
await page.mouse.move(680, 150, {steps:3}); await page.waitForTimeout(300);
await page.mouse.down();
await page.mouse.move(1000, 210, {steps:8}); await page.waitForTimeout(500);
const lbl = await page.evaluate(()=>[...document.querySelectorAll('.ui-hover, .exiles-tool-label')].filter(e=>e.getBoundingClientRect().height>0).map(e=>e.innerText));
await shot('39_clear_stone_drag');
await page.mouse.up(); await page.waitForTimeout(400);
const marked = await page.evaluate(()=>window.__app.game.rt.marked.size);
// second area NW
await page.mouse.move(430, 250, {steps:3});
await page.mouse.down();
await page.mouse.move(530, 330, {steps:6}); await page.waitForTimeout(300);
const lbl2 = await page.evaluate(()=>[...document.querySelectorAll('.ui-hover, .exiles-tool-label')].filter(e=>e.getBoundingClientRect().height>0).map(e=>e.innerText));
await page.mouse.up(); await page.waitForTimeout(400);
const marked2 = await page.evaluate(()=>window.__app.game.rt.marked.size);
return [tool, lbl, marked, lbl2, marked2];
