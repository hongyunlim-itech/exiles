await page.mouse.click(748, 286); await page.waitForTimeout(500);
await page.mouse.click(604, 685); await page.waitForTimeout(500);
await page.mouse.click(166, 403); await page.waitForTimeout(1500);
const r = await page.evaluate(async ()=>{ const t0=performance.now(); let n=0; await new Promise(res=>{const f=()=>{n++; if(performance.now()-t0<3000) requestAnimationFrame(f); else res();}; requestAnimationFrame(f);}); return {fps: n/3, inMenu: window.__app.inMenu, s: localStorage.getItem('exiles.settings'), info: window.__app.renderer.renderer.info.render, speed: window.__app.game.speed}; });
return r;
