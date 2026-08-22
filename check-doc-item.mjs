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
const style = await page.evaluate(() => {
  const btn = document.querySelector('[data-testid="docs-explorer"] button[aria-current="page"]');
  if (!btn) return 'no btn';
  const s = getComputedStyle(btn);
  return { border: s.border, borderColor: s.borderColor, borderWidth: s.borderWidth, boxShadow: s.boxShadow, bg: s.backgroundColor, outer: btn.outerHTML.slice(0,500) };
});
console.log('active btn style', style);
const inactive = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('[data-testid="docs-explorer"] button'));
  const inactiveBtn = btns.find(b => b.getAttribute('aria-current') !== 'page');
  if (!inactiveBtn) return 'no inactive';
  const s = getComputedStyle(inactiveBtn);
  return { border: s.border, borderColor: s.borderColor, boxShadow: s.boxShadow, bg: s.backgroundColor, outer: inactiveBtn.outerHTML.slice(0,500) };
});
console.log('inactive', inactive);
await page.screenshot({ path: '/tmp/check-doc-item.png', fullPage: true });
await browser.close();
