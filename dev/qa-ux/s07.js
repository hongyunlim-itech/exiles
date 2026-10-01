await page.mouse.click(1200, 400, {button:'right'});
await page.waitForTimeout(300);
const t = await page.evaluate(()=>window.__app.input.tool);
await page.mouse.move(1200, 420);
for (let i=0;i<6;i++){ await page.mouse.wheel(0,120); await page.waitForTimeout(80);}
await page.waitForTimeout(800);
return [t, await shot('13_zoomout')];
