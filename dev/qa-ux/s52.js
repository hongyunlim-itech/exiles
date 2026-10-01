const c = await page.evaluate(()=>{const s=window.__app.game.state; const c=s.citizens.find(c=>c.warmth<1); return c? {id:c.id, name:c.name, age:c.age, home:c.homeId, act:c.activity, label:c.taskLabel, health:c.health, prof:c.profession, food:c.food, coat:c.coatWear}:null});
await page.keyboard.press('n'); await page.waitForTimeout(800);
await shot('45_citizens_winter');
return c;
