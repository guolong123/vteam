/**
 * F3 真实栈手工 QA 浏览器腿（evidence-only，不入库，不改产品文件）。
 * 用法：node f3-modal-run.js <scenario: success|cancel> [secretValue]
 * 产出：同目录 f3-<scenario>-*.png 截图 + stdout 原始记录（含 console、network payload）
 */
const path = require("node:path");
const fs = require("node:path");
const { chromium } = require(path.join(__dirname, "../../../web/node_modules/playwright"));

const scenario = process.argv[2] || "success";
const secretValue = process.argv[3] || "s3cr3t-A9f";
const BASE = "http://localhost:13001";

(async () => {
  const consoleMsgs = [];
  const pageErrors = [];
  const replyRequests = [];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("request", (req) => {
    if (req.url().includes("/questions/") && req.method() === "POST") {
      replyRequests.push({ url: req.url(), method: req.method(), postData: req.postData() });
    }
  });
  page.on("response", async (res) => {
    if (res.url().includes("/questions/") && res.url().includes("/reply")) {
      try {
        replyRequests[replyRequests.length - 1].status = res.status();
        replyRequests[replyRequests.length - 1].respBody = (await res.text()).slice(0, 500);
      } catch {}
    }
  });

  console.log("== step: login ==");
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await page.waitForURL(/\/teams/, { timeout: 15000 });
  console.log("login ok ->", page.url());

  console.log("== step: open team session page ==");
  await page.goto(`${BASE}/teams/tm_0000000001/session`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  console.log("== step: wait for question modal ==");
  // 弹窗可能在页面加载（pending 补拉）或 SSE 到达时出现；遮罩会挡住 tab 点击，
  // 故先等弹窗，private tab 在弹窗处理完后再补开。
  let modalVisible = true;
  try {
    await page.getByTestId("question-modal").waitFor({ state: "visible", timeout: 30000 });
  } catch {
    modalVisible = false;
  }
  if (!modalVisible) {
    console.log("modal not present yet; opening private tab and waiting again");
    const pmTab = page.locator('[data-testid="dm-tab-private-tmm_0000000002"]');
    if (await pmTab.count()) await pmTab.click();
    await page.waitForTimeout(1500);
    await page.getByTestId("question-modal").waitFor({ state: "visible", timeout: 30000 });
  }
  console.log("modal visible at", new Date().toISOString());
  await page.screenshot({ path: path.join(__dirname, `f3-${scenario}-modal.png`), fullPage: false });

  // DOM facts
  const modalKind = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="question-secret-body"]');
    const tpl = document.querySelector('[data-testid="question-secret-template"]');
    const reason = document.querySelector('[data-testid="question-secret-reason"]');
    const inputs = [...document.querySelectorAll('[data-testid^="question-secret-input-"]')].map((el) => ({
      testid: el.getAttribute("data-testid"),
      type: el.type,
      autoComplete: el.getAttribute("autocomplete"),
      readOnly: el.readOnly,
      value: el.value,
    }));
    const root = document.querySelector('[data-testid="question-modal"]');
    return {
      hasSecretBody: !!body,
      template: tpl ? tpl.value ?? tpl.textContent : null,
      templateReadonly: tpl ? tpl.readOnly : null,
      reason: reason ? reason.textContent : null,
      inputs,
      modalTextHasSentinel: root ? root.textContent.includes("s3cr3t-A9f") : false,
      submitDisabled: document.querySelector('[data-testid="question-secret-submit"]')?.disabled ?? null,
    };
  });
  console.log("DOM_FACTS=" + JSON.stringify(modalKind));

  // type into password field and prove masking
  const input = page.locator('[data-testid="question-secret-input-0"]');
  await input.fill(secretValue);
  const typed = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="question-secret-input-0"]');
    return {
      type: el.type,
      valueLen: el.value.length,
      domHasSentinel: document.body.innerHTML.includes("s3cr3t-A9f"),
      inputVisibleText: el.type === "password" ? "masked" : "plain",
    };
  });
  console.log("AFTER_FILL=" + JSON.stringify(typed));
  await page.screenshot({ path: path.join(__dirname, `f3-${scenario}-filled.png`) });

  const submitDisabledAfter = await page.locator('[data-testid="question-secret-submit"]').isDisabled();
  console.log("submitDisabledAfterFill=", submitDisabledAfter);

  let action;
  if (scenario === "cancel") {
    action = "question-secret-cancel";
    await page.getByTestId("question-secret-cancel").click();
    console.log("clicked cancel -> payload {secrets:null} expected");
  } else {
    action = "question-secret-submit";
    await page.getByTestId("question-secret-submit").click();
    console.log("clicked submit -> payload {secrets:{TOKEN:...}} expected");
  }

  await page.waitForTimeout(2500);
  // modal should be gone
  const modalCount = await page.getByTestId("question-modal").count();
  console.log("modalCountAfterAction=", modalCount);
  const domAfter = await page.evaluate(() => ({
    domHasSentinel: document.body.innerHTML.includes("s3cr3t-A9f"),
  }));
  console.log("AFTER_ACTION_DOM=" + JSON.stringify(domAfter));
  await page.screenshot({ path: path.join(__dirname, `f3-${scenario}-after.png`) });

  console.log("REPLY_REQUESTS=" + JSON.stringify(replyRequests));
  console.log("CONSOLE_MSGS(" + consoleMsgs.length + ")=" + JSON.stringify(consoleMsgs));
  console.log("PAGE_ERRORS(" + pageErrors.length + ")=" + JSON.stringify(pageErrors));

  await browser.close();
})().catch((err) => {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
