await page.mouse.move(800, 300);
await page.keyboard.press('l'); await page.waitForTimeout(800);
await shot('35_eventlog');
const msgs = await page.evaluate(()=>window.__app.game.state.messages.map(m=>`[${m.severity}] t=${(m.time??0).toFixed?.(0)} ${m.text}`));
const bs = await page.evaluate(()=>window.__app.game.state.buildings.map(b=>`${b.id}:${b.type} ${b.state} p=${b.progress?.toFixed(2)} w${b.workerIds.length}/${b.workersDesired} del=${JSON.stringify(b.delivered??{})}`));
return [msgs, bs];
