import { chromium } from '/Users/mac/01work/git-project/vteam/web/node_modules/playwright/index.mjs';

const baseURL = 'http://localhost:13001';
const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
const context = await browser.newContext();
const page = await context.newPage();

console.log('Goto login');
await page.goto(baseURL + '/login', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/dark-login-light.png', fullPage: true });
console.log('login light done');

// Check theme toggle
const toggle = page.locator('[data-testid="theme-toggle"]');
await toggle.waitFor({ timeout: 5000 });
console.log('toggle found:', await toggle.textContent());

// Switch to dark
await toggle.click();
const darkOpt = page.locator('[data-testid="theme-option-dark"]');
await darkOpt.waitFor({ timeout: 5000 });
await darkOpt.click();
await page.waitForTimeout(1000);
console.log('switched to dark, html class:', await page.evaluate(() => document.documentElement.className + ' data-theme=' + document.documentElement.getAttribute('data-theme')));
await page.screenshot({ path: '/tmp/dark-login-dark.png', fullPage: true });
console.log('login dark done');

// Try system
await toggle.click();
await page.locator('[data-testid="theme-option-system"]').click();
await page.waitForTimeout(500);
console.log('system mode html:', await page.evaluate(() => document.documentElement.getAttribute('data-theme')));

// Back to dark for walk
await toggle.click();
await page.locator('[data-testid="theme-option-dark"]').click();
await page.waitForTimeout(500);

// Login to enter main
await page.goto(baseURL + '/login');
await page.fill('[data-testid="username"]', 'seed-admin');
await page.fill('[data-testid="password"]', 'Admin@123456');
await page.click('[data-testid="login-button"]');
await page.waitForURL('**/projects**', { timeout: 10000 });
console.log('logged in, url=', page.url());
await page.waitForTimeout(2000);
await page.screenshot({ path: '/tmp/dark-projects.png', fullPage: true });

// Walk common pages
const pages = ['/projects','/board?pid=p_seed_1','/agents','/workers','/skills','/messages','/issues','/models','/users','/roles','/memories','/artifacts','/git-repos'];
for (const p of pages) {
  try {
    await page.goto(baseURL + p, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const name = p.replace(/[\/?=]/g, '_') || 'root';
    await page.screenshot({ path: `/tmp/dark-${name}.png`, fullPage: true });
    // Check for light backgrounds remaining: count elements with white bg
    const whiteCount = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      let count = 0;
      let samples = [];
      for (const el of els) {
        const bg = getComputedStyle(el).backgroundColor;
        const style = el.getAttribute('style') || '';
        // check inline style contains #FFFFFF or rgb(255,255,255)
        if (bg === 'rgb(255, 255, 255)' || bg === 'rgba(255, 255, 255, 1)') {
          // only count if element is visible and has size
          const rect = el.getBoundingClientRect();
          if (rect.width > 20 && rect.height > 20) {
            count++;
            if (samples.length < 5) samples.push({ tag: el.tagName, cls: el.className, style: style.slice(0,120), bg, rect: `${Math.round(rect.width)}x${Math.round(rect.height)}` });
          }
        }
      }
      return { count, samples };
    });
    console.log(`PAGE ${p}: whiteBgCount=${whiteCount.count}`, JSON.stringify(whiteCount.samples).slice(0,500));
  } catch(e) { console.log('fail', p, e.message) }
}

await browser.close();
console.log('done');
