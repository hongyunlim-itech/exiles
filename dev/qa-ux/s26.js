await page.keyboard.press('Space'); await page.waitForTimeout(200);
await page.keyboard.press('Digit3'); await page.waitForTimeout(200);
const sp = await page.evaluate(()=>window.__app.game.speed);
await page.waitForTimeout(20000);
const st = await page.evaluate(()=>{const s=window.__app.game.state; return {t:s.time, bs: s.buildings.map(b=>`${b.type}:${b.state}:${b.progress?.toFixed(2)}`), pop: window.__app.game.populationSummary(), acts: s.citizens.map(c=>c.taskLabel)}});
await shot('32_running');
return [sp, st];
