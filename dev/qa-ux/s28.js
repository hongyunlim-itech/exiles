await page.mouse.click(1572, 23); await page.waitForTimeout(1500);
await shot('33_ingame_menu');
return await page.evaluate(()=>({inMenu: window.__app.inMenu, speed: window.__app.game.speed, btns: [...document.querySelectorAll('.menu-btn')].map(b=>b.innerText)}));
