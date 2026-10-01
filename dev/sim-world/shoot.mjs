// Dev-only: node dev/sim-world/shoot.mjs "<query>" out.png
// Expects `npx vite --port 5187` serving the project root.
import { chromium } from 'playwright';

const [query, out] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('console:', m.text());
});
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://localhost:5187/dev/sim-world/index.html?${query}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
await page.screenshot({ path: out });
console.log(await page.textContent('#info'));
await browser.close();
