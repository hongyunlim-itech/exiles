await page.mouse.click(540, 850); await page.waitForTimeout(500);
await page.mouse.click(300, 775); await page.waitForTimeout(300);
const res=[];
for (const [x,y] of [[560,590],[650,630],[560,660]]) {
  await page.mouse.move(x, y, {steps:3}); await page.waitForTimeout(400);
  const h = await page.evaluate(()=>document.querySelector('.ui-hover')?.innerText);
  res.push([x,y,h]);
  if (h && h.includes('click to place')) { await page.mouse.click(x,y); await page.waitForTimeout(300); }
}
await shot('44_more_houses');
await page.mouse.click(1300, 500, {button:'right'}); await page.waitForTimeout(200);
return [res, await page.evaluate(()=>window.__app.game.state.buildings.filter(b=>b.type==='woodenHouse').map(b=>`${b.id}@${b.x},${b.z} ${b.state}`))];
