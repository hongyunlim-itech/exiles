const f = ()=>page.evaluate(()=>{const s=window.__app.game.state; const c=s.citizens.find(c=>c.id===50); if(!c) return 'gone'; const h=window.__app.game.getBuilding(c.homeId); return {home:c.homeId, act:c.activity, label:c.taskLabel, warm:c.warmth.toFixed(1), health:c.health.toFixed(1), x:c.x.toFixed(1), z:c.z.toFixed(1), houseFw: h?.inventory?.firewood, houseSmoking: h?.smoking, residents: h?.residentIds, t: s.time.elapsed.toFixed(0), temp: s.weather.temperature.toFixed(1)}});
const out=[await f()];
await page.keyboard.press('Digit1');
for (let i=0;i<6;i++){ await page.waitForTimeout(4000); out.push(await f()); }
await page.keyboard.press('Space');
return out;
