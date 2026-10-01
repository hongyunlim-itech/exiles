await page.mouse.click(511, 319); await page.waitForTimeout(500);
await shot('29_prof_expand', {clip:{x:450,y:280,width:525,height:250}});
await page.mouse.move(740, 319); await page.waitForTimeout(800);
const t = await S.tip();
return [t, await page.evaluate(()=>document.querySelector('.win .prof-sub, [class*=prof] [class*=sub]')?.outerHTML?.slice(0,300))];
