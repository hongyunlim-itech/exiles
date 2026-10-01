await page.mouse.click(540, 850); await page.waitForTimeout(500);
const f = await page.evaluate(()=>[...document.querySelectorAll('.flyout')].filter(e=>!e.hidden).map(e=>e.getAttribute('aria-label')));
if (!f.length) { await page.mouse.click(540, 850); await page.waitForTimeout(500); }
await page.mouse.move(310, 770); await page.waitForTimeout(900);
const tip = await S.tip();
await page.mouse.click(310, 770); await page.waitForTimeout(400);
const toasts = await page.evaluate(()=>[...document.querySelectorAll('.toast')].map(t=>t.innerText));
await shot('42_unaffordable');
return [f, tip, toasts];
