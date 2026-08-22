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
await page.screenshot({ path: '/tmp/proto-task-before.png', fullPage: true });
console.log('task loaded');
// Find prototype artifact
const protoItem = page.locator('text=任务管理原型');
console.log('protoItem count', await protoItem.count());
if (await protoItem.count() > 0) {
  const item = protoItem.first();
  // Find the clickable container (the artifact item)
  const artifactBtn = page.locator('[data-testid="task-info-panel"] >> text=任务管理原型').first();
  console.log('artifactBtn count', await artifactBtn.count());
  // Try to click the artifact item (the whole row)
  const artifactRow = page.locator('text=任务管理原型').locator('..').locator('..');
  // Let's just evaluate the handleArtifactClick by clicking the element that contains the text
  // The artifact items are in TaskPanel, each has onClick
  // We can find all elements with that text and click the parent button/div
  const all = await page.locator('text=任务管理原型').all();
  for (const a of all) {
    console.log('found', await a.evaluate(e => e.outerHTML.slice(0,300)));
  }
  // Click the first occurrence's closest clickable parent
  const clickable = page.locator('text=任务管理原型').first();
  await clickable.click({ timeout: 5000 }).catch(e=>console.log('click fail',e.message));
  await page.waitForTimeout(2000);
  console.log('after click url', page.url());
  await page.screenshot({ path: '/tmp/proto-after-click.png', fullPage: true });
  // Check if we navigated to docs with proto param
  if (page.url().includes('/docs/')) {
    console.log('navigated to docs proto as expected');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '/tmp/proto-docs.png', fullPage: true });
    const content = await page.textContent('body');
    console.log('docs page snippet', content.slice(0,1000));
  } else {
    console.log('NOT navigated to docs, still at', page.url());
    // Check if it opened new tab? No
  }
} else {
  console.log('no protoItem found');
}
await browser.close();
