await page.mouse.click(685, 850); await page.waitForTimeout(400);
await page.mouse.click(895, 712); await page.waitForTimeout(300);
const res = [];
for (const [x,y] of [[900,185],[960,180],[1000,170],[1050,165],[1080,160]]) {
  await page.mouse.move(x, y, {steps:3}); await page.waitForTimeout(400);
  res.push([x,y, await page.evaluate(()=>document.querySelector('.ui-hover')?.innerText)]);
}
await shot('23_dock_ghost');
return res;
