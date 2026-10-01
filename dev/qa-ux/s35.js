await page.mouse.click(1565, 83); await page.waitForTimeout(300);
await page.keyboard.press('Home'); await page.waitForTimeout(800);
await page.mouse.move(800, 450);
for (let i=0;i<3;i++){ await page.mouse.wheel(0,120); await page.waitForTimeout(100);}
await page.waitForTimeout(800);
await shot('38_town_overview_cam');
return await page.evaluate(()=>window.__app.selection);
