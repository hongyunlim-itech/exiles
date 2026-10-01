const r = await S.ff(90, 'Digit3', 200000);
const extra = await page.evaluate(()=>{const s=window.__app.game.state; return {warm: s.citizens.map(c=>Math.round(c.warmth)), msgs: s.messages.slice(-6).map(m=>m.text), bs: s.buildings.filter(b=>b.state!=='active').map(b=>b.type+':'+b.state+':'+b.progress.toFixed(2))}});
return [r, extra];
