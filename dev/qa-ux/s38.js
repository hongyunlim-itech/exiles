await page.mouse.click(540, 850); await page.waitForTimeout(600);
const st = await page.evaluate(()=>{const f=[...document.querySelectorAll('.flyout')].filter(e=>!e.hidden); return f.map(e=>({t:e.getAttribute('aria-label'), r:e.getBoundingClientRect().toJSON()}))});
await shot('41_housing_again', {clip:{x:150,y:650,width:1000,height:250}});
return [st, await page.evaluate(()=>window.__app.input.tool)];
