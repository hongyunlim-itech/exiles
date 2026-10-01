await page.mouse.click(937, 251); await page.waitForTimeout(250);
await page.mouse.click(937, 251); await page.waitForTimeout(400);
const b = await page.evaluate(()=>({desired: window.__app.game.state.buildersDesired ?? null, pop: window.__app.game.populationSummary()}));
await page.mouse.move(700, 600);
await page.mouse.wheel(0, 400); await page.waitForTimeout(500);
await shot('28_prof_scrolled');
// expand farmer row
await page.mouse.wheel(0, -800); await page.waitForTimeout(300);
await page.mouse.click(545, 319); await page.waitForTimeout(500);
await shot('28b_prof_farmer_expanded');
return b;
