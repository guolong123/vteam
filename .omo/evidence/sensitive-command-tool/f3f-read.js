/** 读取指定 reason 的最后一张工具卡到终态（evidence-only）。用法：node f3f-read.js "F3-FINAL timeout" */
const path = require("node:path");
const { chromium } = require(path.join(__dirname, "../../../web/node_modules/playwright"));

const tag = process.argv[2] || "F3-FINAL";
const BASE = "http://localhost:3001";
const TEAM = "tm_0000000001";
const MAIN_MEMBER = "tmm_0000000002";

const out = (k, v) => console.log(`${k}=${JSON.stringify(v)}`);

(async () => {
  const consoleMsgs = [];
  const pageErrors = [];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 400)));

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByTestId("username").fill("seed-admin");
  await page.getByTestId("password").fill("Admin@123456");
  await page.getByTestId("login-button").click();
  await page.waitForURL(/\/teams/, { timeout: 20000 });
  await page.goto(`${BASE}/teams/${TEAM}/session`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByTestId("team-session-root").waitFor({ state: "visible", timeout: 20000 });
  const dmSel = `[data-testid="dm-tab-private-${MAIN_MEMBER}"]`;
  let dmTab = page.locator(dmSel);
  if (!(await dmTab.count())) {
    const g = page.getByTestId("dm-tab-group");
    if (await g.count()) await g.click().catch(() => {});
    await page.waitForTimeout(800);
    dmTab = page.locator(dmSel);
  }
  await dmTab.first().waitFor({ state: "visible", timeout: 15000 });
  if (!(await dmTab.first().getAttribute("aria-selected"))) await dmTab.first().click().catch(() => {});
  await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(4000);

  const readCards = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="msg-tool"]')].map((c, i) => ({
        i,
        status: c.getAttribute("data-status"),
        text: c.textContent.slice(0, 200),
      })),
    );

  let found = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const cards = await readCards();
    const matches = cards.filter((c) => c.text.includes(tag));
    const last = matches[matches.length - 1];
    if (last && last.status !== "running" && last.status !== "awaiting-input") {
      found = last;
      break;
    }
    out("POLL", { atMs: Date.now() - t0, matches, runningTotal: cards.filter((c) => c.status === "running").length });
    await page.waitForTimeout(3000);
  }
  out("FOUND", found);

  const io = await page.evaluate((idx) => {
    const cards = [...document.querySelectorAll('[data-testid="msg-tool"]')];
    const target = cards[idx];
    if (!target) return null;
    const btn = target.querySelector("button");
    if (btn) btn.click();
    return { clicked: true };
  }, found ? found.i : -1);
  await page.waitForTimeout(800);
  const io2 = await page.evaluate((idx) => {
    const cards = [...document.querySelectorAll('[data-testid="msg-tool"]')];
    const target = cards[idx];
    if (!target) return null;
    const box = target.querySelector('[data-testid="msg-tool-io"]');
    return {
      status: target.getAttribute("data-status"),
      ioRows: box ? [...box.children].map((r) => r.textContent) : null,
      ioHasSentinel: box ? box.textContent.includes("s3cr3t-A9f") : null,
      ioHasCwdOrArgv: box ? /"cwd"|"argv"/.test(box.textContent) : null,
      ioHasRedactMask: box ? box.textContent.includes("{{REDACTED}}") : null,
    };
  }, found ? found.i : -1);
  out("IO", io2);
  await page.screenshot({ path: path.join(__dirname, "f3f-read-last.png"), fullPage: true });

  const all = await readCards();
  out("RUNNING_CARDS_REMAINING", all.filter((c) => c.status === "running" || c.status === "awaiting-input"));
  out("CONSOLE_MSGS", consoleMsgs);
  out("PAGE_ERRORS", pageErrors);
  await browser.close();
  out("DONE", true);
  process.exit(found ? 0 : 3);
})().catch((e) => {
  console.error("FATAL:", String(e).slice(0, 500));
  process.exit(1);
});
