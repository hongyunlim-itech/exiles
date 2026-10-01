await page.mouse.click(978, 337); await page.waitForTimeout(1500);
const sel = await page.evaluate(()=>window.__app.selection);
const open = await page.evaluate(()=>[...document.querySelectorAll('.win')].filter(w=>!w.hidden && w.getBoundingClientRect().height>0).map(w=>w.getAttribute('aria-label')));
await shot('36_goto_hunter');
return [sel, open];
