await page.mouse.move(800, 452); await page.waitForTimeout(300);
return [await page.evaluate(()=>window.__app.input.buildRotation), await shot('24_dock_zoomed')];
