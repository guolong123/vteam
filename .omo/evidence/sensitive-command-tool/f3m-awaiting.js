/**
 * F3 lane-B awaiting-input 探针（evidence-only）：真实模型流中，工具卡第四态
 * 「等待填写敏感信息」能否由真实 pending secret_input 点亮（非 fixture 注入）。
 * 触发后用 Esc 收敛（不留下 pending）。用法：node f3m-awaiting.js
 */
const path = require("node:path");
const { chromium } = require(path.join(__dirname, "../../../web/node_modules/playwright"));

const BASE = "http://localhost:3001";
const TEAM = "tm_0000000001";
const MAIN = "tmm_0000000002";
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const out = (k, v) => console.log(`${k}=${JSON.stringify(v)}`);

(async () => {
  const pageErrors = [];
  const consoleMsgs = [];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("username").fill("seed-admin");
  await page.getByTestId("password").fill("Admin@123456");
  await page.getByTestId("login-button").click();
  await page.waitForURL(/\/teams/, { timeout: 20000 });
  await page.goto(`${BASE}/teams/${TEAM}/session`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("team-session-root").waitFor({ state: "visible", timeout: 20000 });
  const dmSel = `[data-testid="dm-tab-private-${MAIN}"]`;
  await page.locator(dmSel).first().click();
  await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 15000 });

  const prompt =
    '调用 vteam MCP 工具 secret_command，参数固定为：taskId="t_0000000001"，selfInstanceId="tmm_0000000002"，command="echo {{TOKEN}}"，variables=[{"name":"TOKEN","secret":true}]，reason="F3-LANE-B awaiting"。secret 必须是布尔 true。不要输出任何其他文字。';
  await page.getByTestId("message-input").fill(prompt);
  await page.getByTestId("message-input-send").click();
  out("SENT", prompt);
  const t0 = Date.now();
  await page.waitForTimeout(6000);
  log("== trigger React Query refetch via focus/visibility (no reload, DM tab stays open) ==");
  const refetchProbe = await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    return document.querySelectorAll('[data-testid="msg-tool"]').length;
  });
  out("TOOL_CARDS_BEFORE_REFETCH", refetchProbe);

  let awaitingAt = null;
  let modalAt = null;
  const seen = [];
  while (Date.now() - t0 < 90000) {
    const st = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="msg-tool"]')].map((c) => c.getAttribute("data-status")),
    );
    if (st.join(",") !== seen.join(",")) seen.push(...st.filter((s) => !seen.includes(s)));
    if (st.includes("awaiting-input") && !awaitingAt) {
      awaitingAt = Date.now() - t0;
      await page.screenshot({ path: path.join(__dirname, "f3m-awaiting-card.png") });
    }
    if ((await page.getByTestId("question-modal").count()) && !modalAt) modalAt = Date.now() - t0;
    if (awaitingAt && modalAt) break;
    await page.waitForTimeout(700);
  }
  out("AWAITING_CARD", { seenStatuses: seen, awaitingAtMs: awaitingAt, modalAtMs: modalAt, elapsedMs: Date.now() - t0 });

  if (await page.getByTestId("question-modal").count()) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2000);
    out("CANCELLED_AT_END", {
      modalGone: (await page.getByTestId("question-modal").count()) === 0,
      statusesAfter: await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="msg-tool"]')].map((c) => c.getAttribute("data-status")),
      ),
    });
  }
  await page.screenshot({ path: path.join(__dirname, "f3m-awaiting-after.png"), fullPage: true });
  out("DOM_SENTINEL", await page.evaluate(() => document.body.innerHTML.includes("s3cr3t-A9f")));
  out("PAGE_ERRORS", pageErrors);
  out("CONSOLE_MSGS", consoleMsgs);
  await browser.close();
  log("== awaiting probe done ==");
})().catch((e) => { console.error("FATAL:", e && e.stack ? e.stack : String(e)); process.exit(1); });
