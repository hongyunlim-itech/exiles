await page.mouse.move(800, 450);
for (let i=0;i<6;i++){ await page.mouse.wheel(0,-120); await page.waitForTimeout(80);}
await page.waitForTimeout(1000);
await shot('48_alice_zoom');
const c = await page.evaluate(()=>{const s=window.__app.game.state; const c=s.citizens.find(c=>c.id===50); return {x:c.x,z:c.z, cam:[window.__app.renderer.cameraController.target.x, window.__app.renderer.cameraController.target.z, window.__app.renderer.cameraController.distance]}});
return c;
