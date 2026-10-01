// zoom in towards the barn
await page.mouse.move(780, 420);
for (let i=0;i<4;i++){ await page.mouse.wheel(0,-120); await page.waitForTimeout(100);}
await page.waitForTimeout(800);
await page.mouse.move(760, 440, {steps:3});
await page.waitForTimeout(400);
return [await shot('10_zoomed'), await page.evaluate(()=>{const c=window.__app.renderer.cameraController; return {d: c.distance ?? c.dist, t: c.target ? [c.target.x,c.target.z]:null}})];
