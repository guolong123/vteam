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
const toc = await page.evaluate(() => {
  const btn = document.querySelector('aside nav button');
  if (!btn) return 'no btn';
  const s = getComputedStyle(btn);
  return { border: s.border, borderColor: s.borderColor, boxShadow: s.boxShadow, bg: s.backgroundColor, outer: btn.outerHTML.slice(0,600) };
});
console.log('toc btn', toc);
const table = await page.evaluate(() => {
  const th = document.querySelector('table th');
  if (!th) return 'no th';
  const s = getComputedStyle(th);
  return { border: s.border, borderColor: s.borderColor, bg: s.backgroundColor, outer: th.outerHTML.slice(0,400) };
});
console.log('table th', table);
await browser.close();
