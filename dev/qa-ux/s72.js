await page.mouse.click(135, 510); await page.waitForTimeout(800);
const sel = await page.evaluate(()=>window.__app.selection);
await shot('60_gatherer_panel');
return [sel, await page.evaluate(()=>document.querySelector('.sel-panel, [class*=sel-]')?.innerText)];
