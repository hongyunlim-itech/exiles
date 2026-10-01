await page.mouse.click(760, 205); await page.waitForTimeout(400);
await page.mouse.click(1300, 500, {button:'right'}); await page.waitForTimeout(300);
// Home key to return to town
await page.keyboard.press('Home'); await page.waitForTimeout(1500);
const bs = await page.evaluate(()=>window.__app.game.state.buildings.map(b=>`${b.id}:${b.type}@${b.x},${b.z} r${b.rotation} ${b.state}`));
return [bs, await shot('26_home')];
