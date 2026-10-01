await page.mouse.click(1565, 83); await page.waitForTimeout(300);
await page.keyboard.press('p'); await page.waitForTimeout(700);
for (let i=0;i<3;i++){ await page.mouse.click(908, 251); await page.waitForTimeout(250); }
await page.waitForTimeout(300);
await shot('49_prof_builders_down');
const t = await page.evaluate(()=>document.querySelector('.w-professions, [class*=prof]')?.innerText?.slice(0,600));
return t;
