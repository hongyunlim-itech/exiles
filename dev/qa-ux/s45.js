return await page.evaluate(async ()=>{
  const app = window.__app; const R = app.renderer;
  const r3 = R.renderer; const orig = r3.render.bind(r3); let tr=0, nr=0;
  r3.render = (a,b)=>{const t=performance.now(); orig(a,b); tr+=performance.now()-t; nr++;};
  const t0=performance.now(); let n=0; await new Promise(res=>{const f=()=>{n++; if(performance.now()-t0<3000) requestAnimationFrame(f); else res();}; requestAnimationFrame(f);});
  r3.render = orig;
  // gl finish timing
  const gl = r3.getContext(); const t1=performance.now(); gl.finish(); const tf = performance.now()-t1;
  return {frames:n, renderCalls:nr, avgRenderMs: tr/nr, totalMs: performance.now()-t0, finish: tf, size:[r3.domElement.width, r3.domElement.height], pr: r3.getPixelRatio()};
});
