return await page.evaluate(async ()=>{
  const app = window.__app;
  const wrap = (obj, name, key) => { const o = obj[name].bind(obj); const acc = {t:0,n:0}; obj[name] = (...a)=>{const t=performance.now(); const r=o(...a); acc.t+=performance.now()-t; acc.n++; return r;}; return [acc, ()=>{obj[name]=o;}]; };
  const [ar, ur] = wrap(app.renderer, 'render');
  const [ai, ui] = wrap(app.input, 'update');
  const [au, uu] = wrap(app.ui, 'update');
  const [aa, ua] = wrap(app.audio, 'update');
  const [ag, ug] = wrap(app.game, 'update');
  const t0=performance.now(); let n=0; await new Promise(res=>{const f=()=>{n++; if(performance.now()-t0<3000) requestAnimationFrame(f); else res();}; requestAnimationFrame(f);});
  ur(); ui(); uu(); ua(); ug();
  return {frames:n, render: ar.t/ar.n, input: ai.t/ai.n, ui: au.t/au.n, audio: aa.t/aa.n, game: ag.t/Math.max(1,ag.n)};
});
