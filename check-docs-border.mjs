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
await page.goto(baseURL + '/docs/t_0000000001', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const border = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="docs-explorer"] aside');
  if (!el) return 'no aside';
  const style = getComputedStyle(el);
  return { borderRightColor: style.borderRightColor, borderRightWidth: style.borderRightWidth, borderRightStyle: style.borderRightStyle, bg: style.backgroundColor, outer: el.outerHTML.slice(0,500) };
});
console.log('border', border);
const docTree = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="docs-explorer"] div');
  return el ? getComputedStyle(el).borderColor : 'no';
});
console.log('docTree', docTree);
await page.screenshot({ path: '/tmp/check-docs-border.png', fullPage: true });
await browser.close();
