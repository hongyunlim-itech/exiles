await page.mouse.click(930,298, {clickCount:3});
await page.keyboard.type('12345');
await page.mouse.click(1065,694);
await page.waitForFunction(() => window.__app && !window.__app.inMenu, null, { timeout: 60000 });
await page.waitForTimeout(3000);
return await shot("02_start");
