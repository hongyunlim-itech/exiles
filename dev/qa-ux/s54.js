await page.keyboard.press('n'); await page.waitForTimeout(800);
await shot('47_alice_panel');
return await page.evaluate(()=>document.querySelector('.sel-panel, .selection, [class*=sel]')?.innerText);
