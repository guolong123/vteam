import { chromium } from '/Users/mac/01work/git-project/vteam/web/node_modules/playwright/index.mjs';
const baseURL = 'http://localhost:13001';
const browser = await chromium.launch({ headless: true, channel: 'chrome', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(baseURL + '/login', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
const toggle = page.locator('[data-testid="theme-toggle"]');
await toggle.click();
await page.locator('[data-testid="theme-option-dark"]').click();
await page.waitForTimeout(500);
await page.fill('[data-testid="username"]', 'seed-admin');
await page.fill('[data-testid="password"]', 'Admin@123456');
await page.click('[data-testid="login-button"]');
await page.waitForURL('**/projects**', {timeout:10000});
await page.waitForTimeout(2000);
console.log('logged in');

const extra = ['/tasks/new?pid=p_seed_1','/login','/register','/workers/w_compose_worker','/docs/p_seed_1'];
for (const p of extra) {
  try {
    await page.goto(baseURL + p, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const name = p.replace(/[\/?=]/g,'_');
    await page.screenshot({ path: `/tmp/dark2-${name}.png`, fullPage: true });
    const info = await page.evaluate(() => {
      const el = document.documentElement;
      return { theme: el.getAttribute('data-theme'), cls: el.className, bg: getComputedStyle(document.body).backgroundColor };
    });
    const whiteCount = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('*')).filter(e => {
        const bg = getComputedStyle(e).backgroundColor;
        return bg === 'rgb(255, 255, 255)';
      }).length;
    });
    console.log(`PAGE ${p}: theme=${info.theme} bodyBg=${info.bg} whiteCount=${whiteCount}`);
  } catch(e){ console.log('fail',p,e.message)}
}
await browser.close();
console.log('done2');
