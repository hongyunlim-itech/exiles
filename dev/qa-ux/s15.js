await page.mouse.move(1010, 600, {steps:4}); await page.waitForTimeout(300);
await page.mouse.down();
await page.mouse.move(1180, 700, {steps:8}); await page.waitForTimeout(400);
const h1 = await page.evaluate(()=>[...document.querySelectorAll('.ui-hover, .exiles-tool-label')].filter(e=>e.getBoundingClientRect().height>0).map(e=>e.innerText));
await shot('22_field_drag2');
await page.mouse.up(); await page.waitForTimeout(400);
await page.mouse.click(1200, 300, {button:'right'}); await page.waitForTimeout(200);
const bs = await page.evaluate(()=>window.__app.game.state.buildings.filter(b=>b.type==='cropField').map(b=>`${b.id}:${b.type}@${b.x},${b.z} ${b.w}x${b.h} ${b.state} crop=${b.crop}`));
return [h1,bs];
