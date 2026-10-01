await page.mouse.move(960, 180);
for (let i=0;i<5;i++){ await page.mouse.wheel(0,-120); await page.waitForTimeout(80);}
await page.waitForTimeout(700);
const shots = [];
for (let r=0;r<4;r++){
  await page.mouse.move(800, 450, {steps:2}); await page.mouse.move(800, 452); await page.waitForTimeout(400);
  shots.push([await page.evaluate(()=>window.__app.input.buildRotation), await page.evaluate(()=>document.querySelector('.ui-hover')?.innerText)]);
  await shot('24_dock_rot'+r, {type:'jpeg', quality: 60, path: undefined});
  await page.keyboard.press('r'); await page.waitForTimeout(300);
}
return shots;
