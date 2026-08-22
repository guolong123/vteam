import { chromium } from '/Users/mac/01work/git-project/vteam/web/node_modules/playwright/index.mjs';
const baseURL = 'http://localhost:13001';
const taskId = 't_0000000001';
const browser = await chromium.launch({ headless: true, channel: 'chrome', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(baseURL + '/login', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
await page.fill('[data-testid="username"]', 'seed-admin');
await page.fill('[data-testid="password"]', 'Admin@123456');
await page.click('[data-testid="login-button"]');
await page.waitForURL('**/projects**', {timeout:10000});
console.log('logged in as seed-admin');
await page.goto(baseURL + '/tasks/' + taskId, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/task-t1-after.png', fullPage: true });
console.log('task screenshot after member fix');
console.log('page title', await page.title());
console.log('body text snippet', (await page.locator('body').textContent()).slice(0,500));
// Try docs
await page.goto(baseURL + '/docs/' + taskId, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/task-t1-docs-after.png', fullPage: true });
console.log('docs screenshot after');
// Check explorer
const explorerText = await page.locator('[data-testid="docs-explorer"]').textContent().catch(()=> 'not found');
console.log('explorer text snippet', explorerText?.slice(0,500));
const registryError = await page.locator('text=文档列表加载失败').count();
console.log('registry error count', registryError);
const protoTab = page.locator('[data-testid="docs-tab-protos"]');
if (await protoTab.count()>0) {
  await protoTab.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/task-t1-protos-after.png', fullPage: true });
  console.log('protos after', await page.locator('body').textContent().then(t=>t.slice(0,1000)));
}
await browser.close();
