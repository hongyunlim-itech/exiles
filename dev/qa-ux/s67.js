for (let i=0;i<2;i++){ await page.mouse.click(908, 634); await page.waitForTimeout(250); }
await page.mouse.click(908, 457); await page.waitForTimeout(250);
for (let i=0;i<3;i++){ await page.mouse.click(913, 354); await page.waitForTimeout(250); }
await page.keyboard.press('Digit1'); await page.waitForTimeout(4000); await page.keyboard.press('Space');
await page.waitForTimeout(500);
await shot('55_prof_after');
return await page.evaluate(()=>Object.entries(window.__app.game.state.citizens.reduce((a,c)=>(a[c.profession]=(a[c.profession]||0)+1,a),{})));
