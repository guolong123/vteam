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
await page.goto(baseURL + '/tasks/t_0000000001', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
// Find and click the artifact
const html = await page.evaluate(() => {
  const panel = document.querySelector('[data-testid="task-info-panel"]');
  return panel ? panel.innerHTML.slice(0,5000) : 'no panel';
});
console.log('panel html snippet', html.slice(0,3000));
// Try to find the clickable artifact via evaluate
const clicked = await page.evaluate(() => {
  const spans = Array.from(document.querySelectorAll('span')).filter(s => s.textContent?.trim() === '任务管理原型');
  for (const span of spans) {
    let el = span;
    for (let i=0;i<5;i++) {
      if (!el) break;
      // Check if this element has onClick (has cursor pointer or is button)
      const style = el.getAttribute('style') || '';
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || style.includes('cursor')) {
        el.click();
        return { clicked: true, tag: el.tagName, outer: el.outerHTML.slice(0,300) };
      }
      el = el.parentElement;
    }
  }
  return { clicked: false };
});
console.log('clicked via evaluate', clicked);
await page.waitForTimeout(2000);
console.log('url after', page.url());
await page.screenshot({ path: '/tmp/proto-task2.png', fullPage: true });
await browser.close();
