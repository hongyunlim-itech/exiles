// Screenshot sequence of the sandbox (not shipped). Usage: node seq.mjs <outDir> <query> <count> <intervalMs>
import { chromium } from 'playwright';
const [outDir, q, count = '4', interval = '350'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
await page.goto(`http://localhost:5203/dev/render-entities/index.html?shot=1&${q}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
await page.waitForTimeout(1500);
for (let i = 0; i < Number(count); i++) {
  await page.screenshot({ path: `${outDir}/seq_${i}.png` });
  await page.waitForTimeout(Number(interval));
}
await browser.close();
