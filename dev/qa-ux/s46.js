await page.setViewportSize({width: 640, height: 360}); await page.waitForTimeout(1500);
const r = await page.evaluate(async ()=>{ const t0=performance.now(); let n=0; await new Promise(res=>{const f=()=>{n++; if(performance.now()-t0<3000) requestAnimationFrame(f); else res();}; requestAnimationFrame(f);}); return n/3; });
return r;
