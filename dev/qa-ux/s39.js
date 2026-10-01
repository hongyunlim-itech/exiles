await page.mouse.click(300, 775); await page.waitForTimeout(300);
const t1 = await page.evaluate(()=>window.__app.input.tool);
await page.mouse.click(1300, 500, {button:'right'}); await page.waitForTimeout(300);
const t2 = await page.evaluate(()=>window.__app.input.tool);
await page.mouse.click(540, 850); await page.waitForTimeout(500);
const f = await page.evaluate(()=>[...document.querySelectorAll('.flyout')].filter(e=>!e.hidden).map(e=>e.getAttribute('aria-label')));
await page.mouse.click(300, 775); await page.waitForTimeout(300);
const t3 = await page.evaluate(()=>window.__app.input.tool);
return [t1,t2,f,t3];
