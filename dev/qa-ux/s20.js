await page.keyboard.press('r'); await page.waitForTimeout(200);
const res=[];
for (const [x,y] of [[760,200],[760,185],[760,170],[900,180],[1000,160]]) {
  await page.mouse.move(x, y, {steps:2}); await page.waitForTimeout(350);
  res.push([x,y, await page.evaluate(()=>document.querySelector('.ui-hover')?.innerText)]);
}
await shot('25_dock_rot0');
return [await page.evaluate(()=>window.__app.input.buildRotation), res];
