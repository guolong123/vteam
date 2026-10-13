/**
 * F3 lane-B（manual）真实栈浏览器腿 — evidence-only，不入库、不改产品文件。
 * 用法：node f3m-run.js <success|cancel|failure|timeout>
 * 产出：f3m-<scenario>-{modal,filled,after}.png + stdout 结构化原始记录
 *       （DOM 事实、reply payload、tool 卡片输入输出、console、pageerror）
 * BASE = http://localhost:3001（pw-bridge → compose web 13001，见仓库外 bridge.js）
 */
const path = require("node:path");
const { chromium } = require(path.join(__dirname, "../../../web/node_modules/playwright"));

const scenario = process.argv[2] || "success";
const SECRET = "s3cr3t-A9f";
const BASE = "http://localhost:3001";
const TEAM = "tm_0000000001";
const MAIN_MEMBER = "tmm_0000000002";
const TASK = "t_0000000001";

const PROMPTS = {
  success: `请立即调用 vteam MCP 工具 secret_command，参数固定为：taskId="${TASK}"，selfInstanceId="${MAIN_MEMBER}"，command="echo \\"laneB-ok {{TOKEN}}\\""，variables=[{"name":"TOKEN","label":"部署 Token","secret":true}]，reason="F3-LANE-B success"。secret 必须是布尔 true。除了这次工具调用之外不要输出任何文字，不要做任何别的事。`,
  cancel: `调用 vteam MCP 工具 secret_command，参数固定为：taskId="${TASK}"，selfInstanceId="${MAIN_MEMBER}"，command="echo {{TOKEN}}"，variables=[{"name":"TOKEN","label":"取消测试 Token","secret":true}]，reason="F3-LANE-B cancel"。secret 必须是布尔 true。不要输出任何其他文字。`,
  failure: `再次调用 vteam MCP 工具 secret_command，参数固定为：taskId="${TASK}"，selfInstanceId="${MAIN_MEMBER}"，command="ls /f3-laneb-missing/{{TOKEN}}"，variables=[{"name":"TOKEN","label":"路径 Token","secret":true}]，reason="F3-LANE-B failure"。secret 必须是布尔 true。不要输出任何其他文字。`,
  timeout: `调用 vteam MCP 工具 secret_command，参数固定为：taskId="${TASK}"，selfInstanceId="${MAIN_MEMBER}"，command="test -n \\"{{TOKEN}}\\" && sleep 30"，variables=[{"name":"TOKEN","label":"超时测试 Token","secret":true}]，timeoutSec=1，reason="F3-LANE-B timeout"。secret 必须是布尔 true。不要输出任何其他文字。`,
};

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const out = (k, v) => console.log(`${k}=${JSON.stringify(v)}`);

(async () => {
  const consoleMsgs = [];
  const pageErrors = [];
  const replyReqs = [];
  const sentReqs = [];

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/questions/") && u.includes("/reply") && req.method() === "POST") {
      replyReqs.push({ url: u, method: req.method(), postData: req.postData() });
    }
    if (u.includes("/channels/") && u.endsWith("/messages") && req.method() === "POST") {
      sentReqs.push({ url: u, postData: req.postData() });
    }
  });
  page.on("response", async (res) => {
    const u = res.url();
    if (u.includes("/questions/") && u.includes("/reply")) {
      const rec = replyReqs[replyReqs.length - 1];
      if (rec) {
        try {
          rec.status = res.status();
          rec.respBody = (await res.text()).slice(0, 800);
        } catch {}
      }
    }
    if (u.includes("/channels/") && u.endsWith("/messages") && res.request().method() === "POST") {
      const rec = sentReqs[sentReqs.length - 1];
      if (rec) {
        try {
          rec.status = res.status();
          rec.respBody = (await res.text()).slice(0, 800);
        } catch {}
      }
    }
  });

  log("== step login (real form, repository seed admin) ==");
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByTestId("username").fill("seed-admin");
  await page.getByTestId("password").fill("Admin@123456");
  await page.getByTestId("login-button").click();
  await page.waitForURL(/\/teams/, { timeout: 20000 });
  out("LOGIN", { ok: true, url: page.url() });

  log("== step open team session + private DM with main agent ==");
  await page.goto(`${BASE}/teams/${TEAM}/session`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByTestId("team-session-root").waitFor({ state: "visible", timeout: 20000 });
  const dmSel = `[data-testid="dm-tab-private-${MAIN_MEMBER}"]`;
  await openDm(page, dmSel);
  out("DM_TAB", { selector: dmSel, found: true });

  if (scenario === "capture") {
    await page.waitForTimeout(4000);
    await openDm(page, dmSel);
    const listText = await page.evaluate(() => {
      const l = document.querySelector('[data-testid="chat-message-list"]');
      return l ? l.textContent.slice(0, 200) : null;
    });
    out("DM_LIST_HEAD", listText);
    out("TOOL_CARD_COUNT", await page.locator('[data-testid="msg-tool"]').count());
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="msg-tool"]')].map((c) => ({
        status: c.getAttribute("data-status"),
        text: c.textContent.slice(0, 160),
      })),
    );
    out("TOOL_CARDS", cards);
    const n = await page.locator('[data-testid="msg-tool"]').count();
    for (let i = Math.max(0, n - 4); i < n; i++) {
      const card = page.locator('[data-testid="msg-tool"]').nth(i);
      await card.locator("button").first().click().catch(() => {});
      await page.waitForTimeout(300);
      const io = await card.evaluate((el) => {
        const box = el.querySelector('[data-testid="msg-tool-io"]');
        return {
          status: el.getAttribute("data-status"),
          rows: box ? [...box.children].map((r) => r.textContent) : null,
          ioHasSentinel: box ? box.textContent.includes("s3cr3t-A9f") : null,
          ioHasCwdOrArgv: box ? /"cwd"|"argv"/.test(box.textContent) : null,
        };
      });
      out(`TOOL_IO_${i}`, io);
      await page.screenshot({ path: path.join(__dirname, `f3m-capture-card${i}.png`) });
    }
    out("CAPTURE_DOM_SENTINEL", await page.evaluate(() => document.body.innerHTML.includes("s3cr3t-A9f")));
    out("CAPTURE_PAGE_ERRORS", pageErrors);
    await browser.close();
    log("== capture done ==");
    process.exit(0);
  }

  // resume：复用已 pending 的 secret question（刷新补拉路径），不再发新 prompt
  const prompt = PROMPTS[scenario];
  if (scenario !== "resume" && !prompt) throw new Error(`unknown scenario ${scenario}`);
  if (scenario === "resume") {
    log("== step resume: reload page to backfill pending secret question ==");
    out("SENT", { scenario, prompt: "(none — reload backfill path)" });
  } else {
    log("== step send prompt ==", scenario);
    await page.getByTestId("message-input").fill(prompt);
    await page.getByTestId("message-input-send").click();
    out("SENT", { scenario, prompt });
  }

  // 等弹窗（有界 150s）；同时观察工具卡 awaiting-input，并对「模型侧报错/拒绝」早退
  log("== step wait for secret modal (bounded 150s) ==");
  let awaitingSeen = false;
  const modalStart = Date.now();
  let modalVisible = false;
  let earlyText = null;
  const bubblesBefore = await page.locator('[data-testid="chat-bubble"]').count();
  const poll = setInterval(async () => {
    try {
      if (await page.locator('[data-testid="msg-tool"][data-status="awaiting-input"]').count()) {
        awaitingSeen = true;
      }
      const n = await page.locator('[data-testid="chat-bubble"]').count();
      if (n > bubblesBefore) {
        const t = (await lastAssistantText(page)) || "";
        if (/调用失败|MCP error|唯一约束|拒绝执行|不可用|Unknown tool/.test(t)) earlyText = t;
      }
    } catch {}
  }, 700);
  const waitHandle = page
    .getByTestId("question-modal")
    .waitFor({ state: "visible", timeout: 150000 })
    .then(() => {
      modalVisible = true;
    })
    .catch(() => {});
  // 实测缺陷 DEFECT-B：生产 agent.question 帧 taskId=真实任务 id、无 teamId，
  // 被 matchesScope(team:<teamId>) 过滤掉 → 仅实时帧不弹窗；计划的「刷新补拉」路径可用。
  // 故等待期间按节流 reload 触发 GET /questions 补拉（每次 reload 都记录）。
  let reloads = 0;
  const reloadLog = [];
  while (Date.now() - modalStart < 150000) {
    if (modalVisible || earlyText) break;
    if (Date.now() - modalStart > 8000 + reloads * 5000) {
      reloads += 1;
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
        reloadLog.push({ n: reloads, atMs: Date.now() - modalStart });
      } catch (e) {
        reloadLog.push({ n: reloads, error: String(e).slice(0, 120) });
      }
      await page.waitForTimeout(1500);
      await openDm(page, dmSel).catch(() => {});
      await page.waitForTimeout(1000);
      if (await page.getByTestId("question-modal").count()) modalVisible = true;
    } else {
      await page.waitForTimeout(500);
    }
  }
  out("MODAL_BACKFILL_RELOADS", reloadLog);
  clearInterval(poll);
  if (earlyText && !modalVisible) {
    out("EARLY_ABORT", { reason: "模型侧报错/未发起，提前结束等待", text: earlyText.slice(0, 600) });
  }
  await waitHandle.catch(() => {});
  const modalWaitMs = Date.now() - modalStart;
  out("MODAL_WAIT", { modalVisible, modalWaitMs, awaitingInputSeen: awaitingSeen });
  if (!modalVisible) {
    out("NO_MODAL_REASON", {
      note: "模型未发起 secret_command 或弹窗未出现（bounded 150s）",
      lastAssistant: await lastAssistantText(page),
    });
    await page.screenshot({ path: path.join(__dirname, `f3m-${scenario}-nomodal.png`) });
    out("CONSOLE_MSGS", consoleMsgs);
    out("PAGE_ERRORS", pageErrors);
    await browser.close();
    process.exit(2);
  }

  const domFacts = await page.evaluate(() => {
    const tpl = document.querySelector('[data-testid="question-secret-template"]');
    const reason = document.querySelector('[data-testid="question-secret-reason"]');
    const inputs = [...document.querySelectorAll('[data-testid^="question-secret-input-"]')].map((el) => ({
      testid: el.getAttribute("data-testid"),
      type: el.type,
      autoComplete: el.getAttribute("autocomplete"),
      readOnly: el.readOnly,
      valueLen: el.value.length,
    }));
    const root = document.querySelector('[data-testid="question-modal"]');
    const submit = document.querySelector('[data-testid="question-secret-submit"]');
    const cancel = document.querySelector('[data-testid="question-secret-cancel"]');
    const mask = document.querySelector('[data-testid="question-modal-mask"]');
    return {
      hasSecretBody: !!document.querySelector('[data-testid="question-secret-body"]'),
      template: tpl ? tpl.value : null,
      templateReadOnly: tpl ? tpl.readOnly : null,
      templateTag: tpl ? tpl.tagName : null,
      reasonText: reason ? reason.textContent : null,
      inputs,
      submitDisabledBeforeFill: submit ? submit.disabled : null,
      submitLabel: submit ? submit.textContent : null,
      cancelLabel: cancel ? cancel.textContent : null,
      hasMask: !!mask,
      modalHasSentinel: root ? root.textContent.includes("s3cr3t-A9f") : false,
    };
  });
  out("DOM_FACTS", domFacts);
  await page.screenshot({ path: path.join(__dirname, `f3m-${scenario}-modal.png`) });

  // 必填门控：清空时 submit 必须 disabled
  const gating = { submitDisabledEmpty: await page.getByTestId("question-secret-submit").isDisabled() };
  const input0 = page.locator('[data-testid^="question-secret-input-"]').first();
  await input0.fill(SECRET);
  const fillFacts = await page.evaluate((sentinel) => {
    const el = document.querySelector('[data-testid^="question-secret-input-"]');
    const hits = [];
    for (const node of document.querySelectorAll("body *")) {
      if (hits.length >= 5) break;
      const html = node.outerHTML || "";
      if (html.includes(sentinel) && html.length < 4000) {
        hits.push({ tag: node.tagName, testid: node.getAttribute("data-testid"), snippet: html.slice(0, 200) });
      }
    }
    return {
      type: el.type,
      autoComplete: el.getAttribute("autocomplete"),
      valueLen: el.value.length,
      valueAttrHasSentinel: (el.getAttribute("value") || "").includes(sentinel),
      bodyHasSentinel: document.body.innerHTML.includes(sentinel),
      modalHasSentinel: (document.querySelector('[data-testid="question-modal"]')?.textContent || "").includes(sentinel),
      inputMasked: el.type === "password",
      sentinelLocations: hits,
    };
  }, SECRET);
  gating.submitDisabledAfterFill = await page.getByTestId("question-secret-submit").isDisabled();
  out("FILL_FACTS", fillFacts);
  out("GATING", gating);
  await page.screenshot({ path: path.join(__dirname, `f3m-${scenario}-filled.png`) });

  let action;
  if (scenario === "cancel") {
    action = "Esc";
    log("== step cancel via Esc ==");
    await page.keyboard.press("Escape");
  } else {
    action = "submit";
    log("== step confirm ==");
    await page.getByTestId("question-secret-submit").click();
  }
  out("ACTION", { action });

  // 弹窗应消失
  try {
    await page.getByTestId("question-modal").waitFor({ state: "hidden", timeout: 15000 });
    out("MODAL_GONE", { gone: true });
  } catch {
    out("MODAL_GONE", { gone: false, count: await page.getByTestId("question-modal").count() });
  }
  await page.waitForTimeout(1500);

  // 等工具卡终态（有界 120s；无卡片时 45s 早退并记录）
  log("== step wait tool terminal state (bounded 120s) ==");
  await openDm(page, dmSel).catch(() => {});
  await page.waitForTimeout(1500);
  let terminal = null;
  let firstCardAt = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    terminal = await toolSnapshot(page);
    if (terminal.length > 0 && !firstCardAt) firstCardAt = Date.now() - t0;
    if (terminal.some((t) => t.status !== "running" && t.status !== "awaiting-input")) break;
    if (terminal.length === 0 && Date.now() - t0 > 45000) break;
    await page.waitForTimeout(1500);
  }
  out("TOOL_TERMINAL_WAIT_MS", { total: Date.now() - t0, firstCardAt, cards: terminal });

  // 展开最后一张工具卡读 输入/输出
  const toolCards = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="msg-tool"]')];
    return cards.map((c) => ({ status: c.getAttribute("data-status"), text: c.textContent.slice(0, 400) }));
  });
  out("TOOL_CARDS", toolCards);

  const lastCard = page.locator('[data-testid="msg-tool"]').last();
  if (await lastCard.count()) {
    await lastCard.locator("button").first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
  const io = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="msg-tool"]')];
    const last = cards[cards.length - 1];
    if (!last) return null;
    const box = last.querySelector('[data-testid="msg-tool-io"]');
    const rows = box ? [...box.children].map((r) => r.textContent) : [];
    return {
      status: last.getAttribute("data-status"),
      label: last.textContent.slice(0, 120),
      ioRows: rows,
      ioHasSentinel: box ? box.textContent.includes("s3cr3t-A9f") : null,
      ioHasRenderedCwd: box ? /"cwd"|"argv"/.test(box.textContent) : null,
    };
  });
  out("TOOL_IO", io);

  const after = await page.evaluate(() => ({
    domHasSentinel: document.body.innerHTML.includes("s3cr3t-A9f"),
    awaitingCards: document.querySelectorAll('[data-testid="msg-tool"][data-status="awaiting-input"]').length,
    modalCount: document.querySelectorAll('[data-testid="question-modal"]').length,
  }));
  out("AFTER_FACTS", after);
  out("LAST_ASSISTANT_TEXT", await lastAssistantText(page));
  await page.screenshot({ path: path.join(__dirname, `f3m-${scenario}-after.png`), fullPage: true });

  out("REPLY_REQUESTS", replyReqs);
  out("SENT_REQUESTS", sentReqs);
  out("CONSOLE_MSGS", consoleMsgs);
  out("PAGE_ERRORS", pageErrors);

  await browser.close();
  log("== done ==");
})().catch((err) => {
  console.error("FATAL:", err && err.stack ? err.stack : String(err));
  process.exit(1);
});

async function openDm(page, dmSel) {
  let dmTab = page.locator(dmSel);
  if (!(await dmTab.count())) {
    const group = page.getByTestId("dm-tab-group");
    if (await group.count()) await group.click().catch(() => {});
    await page.waitForTimeout(800);
    dmTab = page.locator(dmSel);
  }
  await dmTab.first().waitFor({ state: "visible", timeout: 15000 });
  if (!(await dmTab.first().getAttribute("aria-selected"))) {
    await dmTab.first().click().catch(() => {});
  }
  await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 15000 });
}

async function toolSnapshot(page) {
  try {
    return await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="msg-tool"]')].map((c) => ({
        status: c.getAttribute("data-status"),
        text: c.textContent.slice(0, 200),
      })),
    );
  } catch {
    return [];
  }
}

async function lastAssistantText(page) {
  try {
    return await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll('[data-testid="chat-bubble"]')];
      return bubbles.length ? bubbles[bubbles.length - 1].textContent.slice(0, 1200) : null;
    });
  } catch {
    return null;
  }
}
