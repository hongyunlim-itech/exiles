S.state = () => page.evaluate(()=>{const g=window.__app.game,s=g.state; const tot=g.resourceTotals(); const food = ['berries','mushrooms','roots','venison','fish','wheat','corn','potato','beans','apple','pear','cherry','mutton','beef','eggs','chicken','pumpkin','squash','peppers','cabbage'].reduce((a,k)=>a+(tot[k]||0),0);
 return {t: `Y${s.time.year} M${s.time.month} ${(s.time.monthProgress*100).toFixed(0)}% T=${s.time.elapsed.toFixed(0)}`, temp: s.weather?.temperature?.toFixed?.(1), food, fw: tot.firewood, log: tot.log, stone: tot.stone, iron: tot.iron, tools: tot.tool, herbs: tot.herbs, pop: g.populationSummary(), marked: g.rt.marked.size, speed: g.speed, over: s.gameOver};});
S.ff = async (gameSecs, key='Digit4', maxReal=240000, until=null) => {
  await page.setViewportSize({width: 640, height: 360}); await page.waitForTimeout(300);
  const t0 = await page.evaluate(()=>window.__app.game.state.time.elapsed);
  await page.keyboard.press(key);
  const r0 = Date.now();
  let hit = null;
  while (Date.now()-r0 < maxReal) {
    await page.waitForTimeout(1500);
    const t = await page.evaluate(()=>window.__app.game.state.time.elapsed);
    if (t - t0 >= gameSecs) break;
    if (until) { hit = await page.evaluate(until); if (hit) break; }
  }
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  let sp = await page.evaluate(()=>window.__app.game.speed);
  if (sp !== 0) { await page.keyboard.press('Space'); await page.waitForTimeout(200); sp = await page.evaluate(()=>window.__app.game.speed); }
  await page.setViewportSize({width: 1600, height: 900}); await page.waitForTimeout(800);
  return {hit, real: Date.now()-r0, speedAfter: sp, st: await S.state()};
};
return await S.state();
