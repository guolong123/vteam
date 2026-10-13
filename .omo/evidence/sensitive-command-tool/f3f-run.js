/**
 * F3 lane-B FINAL run harness（todo-12 修复后的「实时 SSE、不刷新」验证）— evidence-only。
 * 用法：node f3f-run.js <success|cancel|cancel-btn|cancel-mask|failure|timeout>
 * 与旧 f3m-run.js 的差别（关键）：
 *   - 绝不 page.reload()：modal 必须由 live SSE 帧直接弹出（todo 12 修复回归）
 *   - 记录 send→frame→modal 时间轴、期间的 navigation 数与 GET /questions 补拉次数
 *   - SSE tee 抓取 /api/v1/events 中 agent.question 帧原文
 * 产出：f3f-<scenario>-{modal,filled,after}.png + stdout 结构化原始记录
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
  success: `请立即调用 vteam MCP 工具 secret_command，参数固定为：taskId="${TASK}"，selfInstanceId="${MAIN_MEMBER}"，command="printf 'deploy-ok {{TOKEN}}\\\\n'"，variables=[{"name":"TOKEN","label":"部署 Token","secret":true}]，reason="F3-FINAL success"。secret 必须是布尔 true。除了这次工具调用之外不要输出任何文字，不要做任何别的事。`,
  cancel: `调用 vteam MCP 工具 secret_command，参数固定为：taskId="${TASK}"，selfInstanceId="${MAIN_MEMBER}"，command="printf '{{TOKEN}}\\\\n'"，variables=[{"name":"TOKEN","label":"取消测试 Token","secret":true}]，reason="F3-FINAL cancel-esc"。secret 必须是布尔 true。不要输出任何其他文字。`,
  "cancel-btn": `调用 vteam MCP 工具 secret_command，参数固定为：taskId="${TASK}"，selfInstanceId="${MAIN_MEMBER}"，command="printf '{{TOKEN}}\\\\n'"，variables=[{"name":"TOKEN","label":"取消按钮 Token","secret":true}]，reason="F3-FINAL cancel-btn"。secret 必须是布尔 true。不要输出任何其他文字。`,
  "cancel-mask": `调用 vteam MCP 工具 secret_command，参数固定为：taskId="${TASK}"，selfInstanceId="${MAIN_MEMBER}"，command="printf '{{TOKEN}}\\\\n'"，variables=[{"name":"TOKEN","label":"遮罩关闭 Token","secret":true}]，reason="F3-FINAL cancel-mask"。secret 必须是布尔 true。不要输出任何其他文字。`,
  failure: `再次调用 vteam MCP 工具 secret_command，参数固定为：taskId="${TASK}"，selfInstanceId="${MAIN_MEMBER}"，command="ls /f3-final-missing/{{TOKEN}}"，variables=[{"name":"TOKEN","label":"路径 Token","secret":true}]，reason="F3-FINAL failure"。secret 必须是布尔 true。不要输出任何其他文字。`,
  timeout: `调用 vteam MCP 工具 secret_command，参数固定为：taskId="${TASK}"，selfInstanceId="${MAIN_MEMBER}"，command="test -n \\"{{TOKEN}}\\" && sleep 30"，variables=[{"name":"TOKEN","label":"超时测试 Token","secret":true}]，timeoutSec=1，reason="F3-FINAL timeout"。secret 必须是布尔 true。不要输出任何其他文字。`,
};

const REASONS = {
  success: "F3-FINAL success",
  cancel: "F3-FINAL cancel-esc",
  "cancel-btn": "F3-FINAL cancel-btn",
  "cancel-mask": "F3-FINAL cancel-mask",
  failure: "F3-FINAL failure",
  timeout: "F3-FINAL timeout",
};

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const out = (k, v) => console.log(`${k}=${JSON.stringify(v)}`);

(async () => {
  const consoleMsgs = [];
  const pageErrors = [];
  const replyReqs = [];
  const sentReqs = [];
  const questionsGets = [];
  const navEvents = [];

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // SSE tee：抓 /api/v1/events 的 agent.question 帧（证明 modal 来自实时帧）
  // use-sse.ts 用原生 EventSource（非 fetch 流），故同时包一层 EventSource。
  await page.addInitScript(() => {
    window.__sseTee = [];
    const OrigES = window.EventSource;
    if (OrigES) {
      window.EventSource = class TeeES extends OrigES {
        constructor(url, init) {
          super(url, init);
          try {
            window.__sseTee.push({ t: Date.now(), via: "EventSource.open", url: String(url).slice(0, 160) });
          } catch {}
          this.addEventListener("message", (ev) => {
            try {
              const data = String(ev.data);
              if (data.includes("agent.question")) {
                window.__sseTee.push({ t: Date.now(), via: "EventSource", frame: data.slice(0, 900) });
              }
            } catch (e) {
              window.__sseTee.push({ err: String(e) });
            }
          });
        }
      };
    }
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (url.includes("/api/v1/events") && res.body) {
          const tees = res.body.tee();
          res.body = tees[0];
          (async () => {
            const reader = tees[1].getReader();
            const dec = new TextDecoder();
            let buf = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i;
              while ((i = buf.indexOf("\n\n")) >= 0) {
                const frame = buf.slice(0, i);
                buf = buf.slice(i + 2);
                if (frame.includes("agent.question")) {
                  window.__sseTee.push({ t: Date.now(), frame: frame.slice(0, 900) });
                }
              }
            }
          })();
        }
      } catch (e) {
        window.__sseTee.push({ err: String(e) });
      }
      return res;
    };
  });

  page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => pageErrors.push(String(e && e.stack ? e.stack : e).slice(0, 400)));
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navEvents.push({ t: Date.now(), url: f.url() });
  });
  page.on("load", () => navEvents.push({ t: Date.now(), kind: "load" }));
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/questions") && req.method() === "GET") questionsGets.push({ t: Date.now(), url: u.slice(0, 160) });
    if (u.includes("/questions/") && u.includes("/reply") && req.method() === "POST") {
      replyReqs.push({ t: Date.now(), url: u, postData: req.postData() });
    }
    if (u.includes("/channels/") && u.endsWith("/messages") && req.method() === "POST") {
      sentReqs.push({ t: Date.now(), url: u.slice(0, 160), postData: req.postData() });
    }
  });
  page.on("response", async (res) => {
    const u = res.url();
    if (u.includes("/questions/") && u.includes("/reply")) {
      const rec = replyReqs[replyReqs.length - 1];
      if (rec) {
        try {
          rec.status = res.status();
          rec.respBody = (await res.text()).slice(0, 900);
        } catch {}
      }
    }
    if (u.includes("/channels/") && u.endsWith("/messages") && res.request().method() === "POST") {
      const rec = sentReqs[sentReqs.length - 1];
      if (rec) {
        try {
          rec.status = res.status();
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
  await page.waitForTimeout(6000); // SSE 连接稳定 + 列表回放

  const prompt = PROMPTS[scenario];
  if (!prompt) throw new Error(`unknown scenario ${scenario}`);

  const tSend = Date.now();
  const navCountBefore = navEvents.length;
  const questionsGetBefore = questionsGets.length;
  const bubblesBefore = await page.locator('[data-testid="chat-bubble"]').count();
  out("SENT", { scenario, prompt, tSend });

  log("== step send prompt ==");
  await page.getByTestId("message-input").fill(prompt);
  await page.getByTestId("message-input-send").click();

  // 等实时 modal（有界 150s；期间绝不 reload）
  log("== step wait for LIVE secret modal (bounded 150s, NO reload) ==");
  let modalVisible = false;
  const tWait0 = Date.now();
  let earlyText = null;
  const poll = setInterval(async () => {
    try {
      const n = await page.locator('[data-testid="chat-bubble"]').count();
      if (n > bubblesBefore) {
        const t = (await lastAssistantText(page)) || "";
        if (/调用失败|MCP error|拒绝执行|不可用|Unknown tool|唯一约束/.test(t)) earlyText = t;
      }
    } catch {}
  }, 800);
  try {
    await page.getByTestId("question-modal").waitFor({ state: "visible", timeout: 150000 });
    modalVisible = true;
  } catch {}
  clearInterval(poll);
  const tModal = Date.now();
  const modalWaitMs = tModal - tWait0;

  const sseTee = await page.evaluate(() => window.__sseTee || []);
  const frames = sseTee.filter((f) => f.frame);
  const questionFrames = frames.filter((f) => f.frame.includes('"type":"agent.question"') || f.frame.includes("agent.question"));
  const firstQuestionFrame = questionFrames[0] || null;
  const navEventsDuringWait = navEvents.slice(navCountBefore);
  const questionsGetsDuringWait = questionsGets.slice(questionsGetBefore);

  out("LIVE_MODAL", {
    modalVisible,
    modalWaitMs,
    tSend,
    tModal,
    tFrameFirst: firstQuestionFrame ? firstQuestionFrame.t : null,
    frameBeforeModal: firstQuestionFrame ? firstQuestionFrame.t <= tModal : null,
    questionFrameCount: questionFrames.length,
    navEventsDuringWait,
    reloadHappened: navEventsDuringWait.some((e) => e.kind === "load" || e.url),
    questionsBackfillGetsDuringWait: questionsGetsDuringWait,
    noBackfillGet: questionsGetsDuringWait.length === 0,
  });
  out("SSE_FRAMES", questionFrames.slice(0, 4));
  out("EARLY_TEXT", earlyText);

  if (!modalVisible) {
    out("NO_MODAL", { note: "bounded 150s 内实时 modal 未出现", lastAssistant: await lastAssistantText(page) });
    await page.screenshot({ path: path.join(__dirname, `f3f-${scenario}-nomodal.png`), fullPage: true });
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
  await page.screenshot({ path: path.join(__dirname, `f3f-${scenario}-modal.png`) });

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
  await page.screenshot({ path: path.join(__dirname, `f3f-${scenario}-filled.png`) });

  let action;
  if (scenario === "cancel") {
    action = "Esc";
    log("== step cancel via Esc ==");
    await page.keyboard.press("Escape");
  } else if (scenario === "cancel-btn") {
    action = "取消按钮";
    log("== step cancel via 取消 button ==");
    await page.getByTestId("question-secret-cancel").click();
  } else if (scenario === "cancel-mask") {
    action = "遮罩点击";
    log("== step cancel via mask click ==");
    await page.locator('[data-testid="question-modal-mask"]').click({ position: { x: 5, y: 5 } }).catch(async () => {
      await page.mouse.click(20, 20);
    });
  } else {
    action = "submit";
    log("== step confirm ==");
    await page.getByTestId("question-secret-submit").click();
  }
  out("ACTION", { action });

  try {
    await page.getByTestId("question-modal").waitFor({ state: "hidden", timeout: 15000 });
    out("MODAL_GONE", { gone: true });
  } catch {
    out("MODAL_GONE", { gone: false, count: await page.getByTestId("question-modal").count() });
  }
  await page.waitForTimeout(1500);

  log("== step wait THIS run's tool card terminal state (bounded 120s) ==");
  await openDm(page, dmSel).catch(() => {});
  await page.waitForTimeout(1500);
  const reasonTag = REASONS[scenario];
  let terminal = null;
  let ownCardAt = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const all = await toolSnapshot(page);
    const idx = all.findIndex((c) => c.text.includes(reasonTag));
    const own = idx >= 0 ? { ...all[idx], cardIndex: idx } : null;
    terminal = { allCount: all.length, ownIdx: idx, own };
    if (own && !ownCardAt) ownCardAt = Date.now() - t0;
    if (own && own.status !== "running" && own.status !== "awaiting-input") break;
    if (idx < 0 && Date.now() - t0 > 60000) break;
    await page.waitForTimeout(1500);
  }
  out("TOOL_TERMINAL_WAIT_MS", { total: Date.now() - t0, ownCardAt, terminal });

  const toolCards = await page.evaluate((tag) => {
    const cards = [...document.querySelectorAll('[data-testid="msg-tool"]')];
    const hits = cards.map((c, i) => ({ i, text: c.textContent.slice(0, 500) })).filter((c) => c.text.includes(tag));
    return { total: cards.length, matches: hits, tail: cards.slice(-2).map((c, i) => c.textContent.slice(0, 300)) };
  }, reasonTag);
  out("TOOL_CARDS", toolCards);

  const io = await page.evaluate((tag) => {
    const cards = [...document.querySelectorAll('[data-testid="msg-tool"]')];
    let target = cards.find((c) => c.textContent.includes(tag)) || cards[cards.length - 1];
    if (!target) return null;
    const btn = target.querySelector("button");
    if (btn) btn.click();
    return { expanded: true, label: target.textContent.slice(0, 200) };
  }, reasonTag);
  await page.waitForTimeout(700);
  const io2 = await page.evaluate((tag) => {
    const cards = [...document.querySelectorAll('[data-testid="msg-tool"]')];
    const target = cards.find((c) => c.textContent.includes(tag)) || cards[cards.length - 1];
    if (!target) return null;
    const box = target.querySelector('[data-testid="msg-tool-io"]');
    const rows = box ? [...box.children].map((r) => r.textContent) : [];
    return {
      status: target.getAttribute("data-status"),
      label: target.textContent.slice(0, 200),
      ioRows: rows,
      ioHasSentinel: box ? box.textContent.includes("s3cr3t-A9f") : null,
      ioHasRenderedCwdOrArgv: box ? /"cwd"|"argv"/.test(box.textContent) : null,
      ioHasTripleStar: box ? box.textContent.includes("***") : null,
      ioHasRedactMask: box ? box.textContent.includes("{{REDACTED}}") : null,
    };
  }, reasonTag);
  out("TOOL_IO_EXPAND", io);
  out("TOOL_IO", io2);
  await page.screenshot({ path: path.join(__dirname, `f3f-${scenario}-after.png`), fullPage: true });

  const after = await page.evaluate(() => ({
    domHasSentinel: document.body.innerHTML.includes("s3cr3t-A9f"),
    awaitingCards: document.querySelectorAll('[data-testid="msg-tool"][data-status="awaiting-input"]').length,
    modalCount: document.querySelectorAll('[data-testid="question-modal"]').length,
  }));
  out("AFTER_FACTS", after);
  out("LAST_ASSISTANT_TEXT", await lastAssistantText(page));
  out("REPLY_REQUESTS", replyReqs);
  out("SENT_REQUESTS", sentReqs.map((r) => ({ url: r.url, status: r.status, postData: (r.postData || "").slice(0, 400) })));
  out("ALL_QUESTIONS_GETS", questionsGets);
  out("NAV_EVENTS_TOTAL", navEvents);
  out("CONSOLE_MSGS", consoleMsgs);
  out("PAGE_ERRORS", pageErrors);

  await browser.close();
  log("== done ==");
  process.exit(0);
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
        text: c.textContent.slice(0, 300),
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
