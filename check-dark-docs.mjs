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
await page.waitForTimeout(2000);
// Switch to dark
await page.locator('[data-testid="theme-toggle"]').click();
await page.locator('[data-testid="theme-option-dark"]').click();
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/docs-dark.png', fullPage: true });
console.log('dark screenshot done');
await browser.close();
