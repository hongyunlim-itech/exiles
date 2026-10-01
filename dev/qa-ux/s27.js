const r = await page.evaluate(async ()=>{ const t0=performance.now(); let n=0; await new Promise(res=>{const f=()=>{n++; if(performance.now()-t0<3000) requestAnimationFrame(f); else res();}; requestAnimationFrame(f);}); return {fps: n/3, prof: window.__app.debug.profile ? window.__app.debug.profile() : null, info: window.__app.renderer.renderer.info.render}; });
return r;
