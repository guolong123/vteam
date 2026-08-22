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
const hasFrame = await page.locator('[data-testid="proto-frame"]').count();
console.log('hasFrame', hasFrame);
if (hasFrame) {
  const frame = page.frameLocator('[data-testid="proto-frame"]');
  // Check for bg-slate-50
  const bgDiv = frame.locator('div.bg-slate-50').first();
  console.log('bgDiv count', await bgDiv.count());
  if (await bgDiv.count() > 0) {
    const bg = await bgDiv.evaluate(el => getComputedStyle(el).backgroundColor);
    console.log('bg-slate-50 bg', bg);
    const cls = await bgDiv.getAttribute('class');
    console.log('cls', cls);
  }
  // Check srcdoc contains bg-slate-50
  const srcdoc = await page.locator('[data-testid="proto-frame"]').getAttribute('srcdoc');
  console.log('srcdoc contains bg-slate-50', srcdoc.includes('bg-slate-50'));
  console.log('srcdoc contains --color-slate-50', srcdoc.includes('--color-slate-50'));
  // Check parent CSS
  const parentCssLen = await page.evaluate(() => {
    return Array.from(document.styleSheets).map(s => {
      try { return Array.from(s.cssRules).map(r=>r.cssText).join('\n').length } catch(e){ return 0 }
    }).join(',')
  });
  console.log('parent css len per sheet', parentCssLen);
  const fetched = await page.evaluate(() => fetch('/_next/static/css/dbe1be286447165a.css').then(r=>r.text()).then(t=>t.slice(0,500)));
  console.log('fetched css snippet', fetched.slice(0,500));
}
await page.screenshot({ path: '/tmp/proto-debug2.png', fullPage: true });
await browser.close();
