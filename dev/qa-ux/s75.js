await page.mouse.move(800, 450);
await page.keyboard.down('s'); await page.waitForTimeout(1500); await page.keyboard.up('s');
await page.waitForTimeout(800);
const p = await S.scr(117, 87.5);
await shot('61_panned_s');
return p;
