import { chromium } from '/Users/mac/01work/git-project/vteam/web/node_modules/playwright/index.mjs';
const baseURL = 'http://localhost:13001';
const browser = await chromium.launch({ headless: true, channel: 'chrome', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
page.on('console', msg => console.log('page console:', msg.text()));
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
  const bodyText = await frame.locator('body').textContent().then(t=>t.slice(0,500)).catch(e=> 'error '+e.message);
  console.log('frame body text', bodyText);
  const h1 = await frame.locator('h1').textContent().catch(()=> 'no h1');
  console.log('h1', h1);
  // Check computed style of h1
  const h1Color = await frame.locator('h1').evaluate(el => getComputedStyle(el).color).catch(e=> 'error '+e.message);
  console.log('h1 color', h1Color);
  // Check if Tailwind class bg-slate-50 is applied
  const bg = await frame.locator('div').first().evaluate(el => getComputedStyle(el).backgroundColor).catch(e=> 'error');
  console.log('first div bg', bg);
  // Check stylesheet count in parent
  const sheetInfo = await page.evaluate(() => {
    return Array.from(document.styleSheets).map(s => ({ href: s.href, rules: (()=>{ try{ return s.cssRules.length } catch(e){ return 'blocked' } })() })).slice(0,10);
  });
  console.log('sheets', JSON.stringify(sheetInfo,null,2));
}
await page.screenshot({ path: '/tmp/proto-debug.png', fullPage: true });
await browser.close();
