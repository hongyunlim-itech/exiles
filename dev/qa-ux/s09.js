await page.mouse.click(440, 712);
await page.waitForTimeout(300);
await page.mouse.move(860, 470, {steps:5});
await page.waitForTimeout(600);
return [await shot('15_gatherer_ghost'), await S.tip(), await page.evaluate(()=>{const e=document.querySelector('.hover-info, .ui-hover, [class*=hover]'); return e? e.innerText:null})];
