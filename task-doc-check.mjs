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
console.log('logged in');
// Go to task
await page.goto(baseURL + '/tasks/' + taskId, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/task-t1.png', fullPage: true });
console.log('task screenshot');
// Try to click docs link if exists
const docsLink = page.locator('a[href*="/docs/"]');
const count = await docsLink.count();
console.log('docs links count', count);
for (let i=0;i<count;i++) {
  console.log('docs link', i, await docsLink.nth(i).getAttribute('href'), await docsLink.nth(i).textContent());
}
// Check for prototype or docs tab
const docsTab = page.locator('[data-testid="docs-tab-docs"]');
console.log('docsTab exists', await docsTab.count());
// Check if there's a docs button in task page (maybe "查看文档站" button)
const allButtons = await page.locator('button, a').all();
for (const b of allButtons) {
  const txt = (await b.textContent())?.trim();
  if (txt && (txt.includes('文档') || txt.includes('原型') || txt.includes('查看'))) {
    console.log('btn:', txt, await b.getAttribute('data-testid'), await b.getAttribute('href'));
  }
}
// Directly goto docs page
await page.goto(baseURL + '/docs/' + taskId, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/task-t1-docs.png', fullPage: true });
console.log('docs screenshot');
const explorer = page.locator('[data-testid="docs-explorer"]');
console.log('explorer count', await explorer.count());
const shell = page.locator('[data-testid="docs-shell"]');
console.log('shell count', await shell.count());
console.log('docs page content', (await page.content()).slice(0,2000));
// Try prototype tab
const protoTab = page.locator('[data-testid="docs-tab-protos"]');
if (await protoTab.count() > 0) {
  await protoTab.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/task-t1-protos.png', fullPage: true });
  console.log('protos screenshot');
  console.log('protos content', (await page.content()).slice(0,3000));
}
await browser.close();
