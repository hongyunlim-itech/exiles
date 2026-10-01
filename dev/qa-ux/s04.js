await page.mouse.click(300,775);
await page.waitForTimeout(300);
await page.mouse.move(640, 380, {steps: 5});
await page.waitForTimeout(500);
const p1 = await shot('09_ghost');
await page.keyboard.press('r');
await page.waitForTimeout(400);
const p2 = await shot('09b_ghost_rot');
return [p1,p2, await page.evaluate(()=>({tool: window.__app.input.tool, rot: window.__app.input.buildRotation}))];
