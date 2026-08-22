import { chromium } from '/Users/mac/01work/git-project/vteam/web/node_modules/playwright/index.mjs';
const baseURL = 'http://localhost:13001';
const browser = await chromium.launch({ headless: true, channel: 'chrome', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
page.on('console', msg => console.log('console:', msg.text()));
await page.goto(baseURL + '/login', { waitUntil: 'domcontentloaded' });
await page.fill('[data-testid="username"]', 'seed-admin');
await page.fill('[data-testid="password"]', 'Admin@123456');
await page.click('[data-testid="login-button"]');
await page.waitForURL('**/projects**', {timeout:10000});
await page.goto(baseURL + '/docs/t_0000000001?proto=44337dbf-d6b4-4d5a-b3aa-08b4bec3dd7d', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
// Check for proto-frame
const frameCount = await page.locator('[data-testid="proto-frame"]').count();
console.log('frameCount', frameCount);
if (frameCount > 0) {
  const frame = page.locator('[data-testid="proto-frame"]').first();
  const srcdoc = await frame.getAttribute('srcdoc');
  console.log('srcdoc length', srcdoc?.length);
  console.log('srcdoc snippet', srcdoc?.slice(0,2000));
  // Check iframe content via evaluate
  const isVisible = await frame.isVisible();
  console.log('isVisible', isVisible);
  const box = await frame.boundingBox();
  console.log('box', box);
  // Try to get iframe's contentDocument via evaluate in frame
  const frameEl = await frame.elementHandle();
  const content = await page.evaluate(el => {
    const iframe = el;
    try {
      const doc = iframe.contentDocument;
      if (!doc) return 'no doc';
      return doc.documentElement.outerHTML.slice(0,3000);
    } catch(e) { return 'error ' + e.message; }
  }, frameEl);
  console.log('iframe doc', content.slice(0,3000));
  await page.screenshot({ path: '/tmp/proto-style.png', fullPage: true });
  console.log('screenshot done');
} else {
  console.log('no frame, check for error');
  const error = await page.locator('[data-testid="proto-error"]').textContent().catch(()=> 'no error');
  console.log('error', error);
  await page.screenshot({ path: '/tmp/proto-no-frame.png', fullPage: true });
}
await browser.close();
