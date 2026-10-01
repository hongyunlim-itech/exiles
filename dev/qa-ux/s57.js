await page.keyboard.press('Escape'); await page.waitForTimeout(200);
const r = await S.ff(150, 'Digit3', 200000, ()=>window.__app.game.state.buildings.filter(b=>b.type==='woodenHouse' && b.state==='active').length>=5);
const extra = await page.evaluate(()=>{const s=window.__app.game.state; return {warm: s.citizens.map(c=>c.name+':'+Math.round(c.warmth)+':'+Math.round(c.health)+(c.homeId<0?':H':'')), msgs: s.messages.slice(-6).map(m=>m.text), bs: s.buildings.filter(b=>b.state!=='active').map(b=>b.type+':'+b.state+':'+b.progress.toFixed(2))}});
return [r, extra];
