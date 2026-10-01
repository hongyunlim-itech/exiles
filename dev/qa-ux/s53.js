await page.mouse.click(575, 277); await page.waitForTimeout(1000);
const sel = await page.evaluate(()=>window.__app.selection);
const open = await page.evaluate(()=>[...document.querySelectorAll('.win')].filter(w=>!w.hidden && w.getBoundingClientRect().height>0).map(w=>w.className));
await shot('46_alice');
return [sel, open];
