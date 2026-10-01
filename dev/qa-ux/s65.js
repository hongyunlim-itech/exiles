await page.keyboard.press('p'); await page.waitForTimeout(200);
await page.mouse.click(1565, 83); await page.waitForTimeout(200);
const r = await S.ff(400, 'Digit4', 200000, ()=>window.__app.game.state.time.year>=2 && window.__app.game.state.time.month>=0 && window.__app.game.state.time.monthProgress>0.2);
const extra = await page.evaluate(()=>{const s=window.__app.game.state; return {msgs: s.messages.slice(-8).map(m=>m.severity+': '+m.text), saves: window.__app.listSaves().map(x=>x.slot+'|'+(x.name??'')), profs: Object.entries(s.citizens.reduce((a,c)=>(a[c.profession]=(a[c.profession]||0)+1,a),{}))}});
return [r, extra];
