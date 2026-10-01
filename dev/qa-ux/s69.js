await page.mouse.click(908, 634); await page.waitForTimeout(200);
await page.keyboard.press('p'); await page.waitForTimeout(300);
// Go look at the fields: Home then zoom out
await page.keyboard.press('Home'); await page.waitForTimeout(500);
await page.mouse.move(800, 450);
for (let i=0;i<3;i++){ await page.mouse.wheel(0,120); await page.waitForTimeout(100);}
await page.keyboard.press('Digit2'); await page.waitForTimeout(8000); await page.keyboard.press('Space');
await page.waitForTimeout(500);
await shot('56_y2_spring_town');
return await S.state();
