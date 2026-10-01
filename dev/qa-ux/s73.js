await page.mouse.click(1565, 83); await page.waitForTimeout(200);
const r = await S.ff(100, 'Digit3', 200000);
const extra = await page.evaluate(()=>{const s=window.__app.game.state; const f=s.buildings.find(b=>b.id===60); const st={}; for (const t of f.fieldTiles??[]) {const k=JSON.stringify(t.stage??t); st[k]=(st[k]||0)+1;} return {profs: Object.entries(s.citizens.reduce((a,c)=>(a[c.profession]=(a[c.profession]||0)+1,a),{})), field: st, ft: (f.fieldTiles??[]).slice(0,2), msgs: s.messages.slice(-5).map(m=>m.text)}});
return [r, extra];
