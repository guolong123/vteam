import { chromium } from '/Users/mac/01work/git-project/vteam/web/node_modules/playwright/index.mjs';
const baseURL = 'http://localhost:13001';
const browser = await chromium.launch({ headless: true, channel: 'chrome', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(baseURL + '/login', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
await page.locator('[data-testid="theme-toggle"]').click();
await page.locator('[data-testid="theme-option-dark"]').click();
await page.waitForTimeout(500);
await page.fill('[data-testid="username"]', 'seed-admin');
await page.fill('[data-testid="password"]', 'Admin@123456');
await page.click('[data-testid="login-button"]');
await page.waitForURL('**/projects**', {timeout:10000});
await page.goto(baseURL + '/roles', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.screenshot({ path: '/tmp/dark-roles-after.png', fullPage: true });
console.log('screenshot done');
const results = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('*'));
  const light = [];
  for (const el of els) {
    const style = getComputedStyle(el);
    const bg = style.backgroundColor;
    // parse rgb
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) continue;
    const r = parseInt(m[1]), g=parseInt(m[2]), b=parseInt(m[3]), a= parseFloat(m[4] ?? '1');
    if (a < 0.5) continue;
    // skip transparent
    if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 30 || rect.height < 20) continue;
    // lightness: average or luminance
    const lum = 0.2126*r + 0.7152*g + 0.0722*b;
    if (lum > 180) {
      light.push({ tag: el.tagName, cls: el.className?.slice(0,50), bg, lum: Math.round(lum), rect: `${Math.round(rect.width)}x${Math.round(rect.height)}`, text: (el.textContent||'').slice(0,30).replace(/\n/g,' ') });
      if (light.length >= 20) break;
    }
  }
  return light;
});
console.log('light backgrounds in dark mode (lum>180):', JSON.stringify(results, null, 2));
await browser.close();
console.log('done');
