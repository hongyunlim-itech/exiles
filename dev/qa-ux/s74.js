S.scr = (wx, wz) => page.evaluate(([x,z])=>{const app=window.__app; const s=app.game.state; const W=s.W; const H=s.tiles.height; const x0=Math.floor(x), z0=Math.floor(z), fx=x-x0, fz=z-z0; const c=(xx,zz)=>H[zz*(W+1)+xx]; const y=(c(x0,z0)*(1-fx)+c(x0+1,z0)*fx)*(1-fz)+(c(x0,z0+1)*(1-fx)+c(x0+1,z0+1)*fx)*fz; return app.renderer.worldToScreen(x,y,z);}, [wx,wz]);
const p = await S.scr(117, 87.5);
return p;
