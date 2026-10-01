await page.mouse.move(760, 205, {steps:2}); await page.waitForTimeout(400);
const h = await page.evaluate(()=>document.querySelector('.ui-hover')?.innerText);
await shot('25_dock_rot0');
return h;
