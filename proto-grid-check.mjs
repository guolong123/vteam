import { chromium } from '/Users/mac/01work/git-project/vteam/web/node_modules/playwright/index.mjs';
const baseURL = 'http://localhost:13001';
const browser = await chromium.launch({ headless: true, channel: 'chrome', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(baseURL + '/login', { waitUntil: 'domcontentloaded' });
await page.fill('[data-testid="username"]', 'seed-admin');
await page.fill('[data-testid="password"]', 'Admin@123456');
await page.click('[data-testid="login-button"]');
await page.waitForURL('**/projects**', {timeout:10000});
await page.goto(baseURL + '/docs/t_0000000001?proto=44337dbf-d6b4-4d5a-b3aa-08b4bec3dd7d', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const frame = page.frameLocator('[data-testid="proto-frame"]');
const grid = frame.locator('div.grid').first();
console.log('grid count', await grid.count());
if (await grid.count()>0) {
  const style = await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns);
  console.log('gridTemplateColumns', style);
  const cls = await grid.getAttribute('class');
  console.log('grid class', cls);
  const bg = await frame.locator('div.bg-slate-50').first().evaluate(el => getComputedStyle(el).backgroundColor);
  console.log('bg-slate-50 bg', bg);
  const card = frame.locator('div.rounded-xl').first();
  console.log('card count', await card.count());
  if (await card.count()>0) {
    const cardBg = await card.evaluate(el => getComputedStyle(el).backgroundColor);
    console.log('card bg', cardBg);
    const cardBorder = await card.evaluate(el => getComputedStyle(el).borderColor);
    console.log('card border', cardBorder);
  }
}
await page.screenshot({ path: '/tmp/proto-grid.png', fullPage: true });
await browser.close();
