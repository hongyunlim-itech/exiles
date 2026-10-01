await page.keyboard.press('Escape'); await page.waitForTimeout(300);
const open1 = await page.evaluate(()=>[...document.querySelectorAll('.win')].filter(w=>!w.hidden && w.getBoundingClientRect().height>0).length);
await page.keyboard.press('o'); await page.waitForTimeout(700);
await shot('30_overview');
await page.keyboard.press('o'); await page.waitForTimeout(200);
await page.keyboard.press('n'); await page.waitForTimeout(700);
await shot('31_citizens');
await page.keyboard.press('n'); await page.waitForTimeout(200);
return [open1, await page.evaluate(()=>window.__app.inMenu)];
