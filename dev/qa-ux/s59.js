const f = ()=>page.evaluate(()=>{const s=window.__app.game.state; const c=s.citizens.find(c=>c.id===50); if(!c) return 'gone'; const h=window.__app.game.getBuilding(c.homeId); return {act:c.activity, label:c.taskLabel, warm:c.warmth.toFixed(1), health:c.health.toFixed(1), houseFw: JSON.stringify(h?.inventory), houseSmoking: h?.smoking, t: s.time.elapsed.toFixed(0), temp: s.weather.temperature.toFixed(1)}});
const out=[await f()];
await page.setViewportSize({width:640,height:360});
await page.keyboard.press('Digit2');
for (let i=0;i<8;i++){ await page.waitForTimeout(3000); out.push(await f()); }
await page.keyboard.press('Space');
await page.setViewportSize({width:1600,height:900});
return out;
