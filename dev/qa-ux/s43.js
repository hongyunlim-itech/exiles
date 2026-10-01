await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
const inMenu = await page.evaluate(()=>window.__app.inMenu);
await page.mouse.click(176, 602); await page.waitForTimeout(1200);
await shot('43_settings');
return [inMenu, await page.evaluate(()=>document.querySelector('.menu')?.innerText?.slice(0,800))];
