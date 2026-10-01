S.tip = async () => page.evaluate(() => { const e = document.querySelector('.ui-tip'); return e && !e.hidden ? e.innerText : ''; });
const tips = [];
for (const x of [60, 195, 430, 510, 590, 660, 740, 815, 885, 960, 1215, 1250, 1290, 1330, 1383, 1418, 1572]) {
  await page.mouse.move(x, 30); await page.mouse.move(x, 23);
  await page.waitForTimeout(700);
  tips.push([x, await S.tip()]);
  if (x === 430 || x === 1330 || x===195) await shot('03_tip_' + x);
}
for (const x of [1325,1373,1420,1467,1514,1561]) {
  await page.mouse.move(x, 862); await page.mouse.move(x, 860);
  await page.waitForTimeout(700);
  tips.push([x, await S.tip()]);
}
return tips;
