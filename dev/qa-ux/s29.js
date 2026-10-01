const a = await page.evaluate(()=>({t: {...window.__app.game.state.time}, speed: window.__app.game.speed, paused: window.__app.game.paused}));
await page.waitForTimeout(5000);
const b = await page.evaluate(()=>({t: {...window.__app.game.state.time}, speed: window.__app.game.speed}));
return [a,b];
