await page.mouse.click(685, 850);
await page.waitForTimeout(900);
const p = await shot('14_food_flyout');
const items = await page.evaluate(()=>[...document.querySelectorAll('.flyout .fly-item')].map(e=>({l:e.getAttribute('aria-label'), dis: e.classList.contains('disabled')||e.disabled, t:e.innerText.replace(/\n/g,' ')})));
return [p, items];
