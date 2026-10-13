/**
 * F3 lane-B SSE 探针（evidence-only）：定位「弹窗为何没出现」。
 * 挂钩 EventSource 记录每条 message/error，同时用后台 curl 造一个真实 pending
 * secret question，观察页面是否收到 agent.question 与弹窗是否渲染。
 * 用法：node f3m-sse-probe.js
 */
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require(path.join(__dirname, "../../../web/node_modules/playwright"));

const BASE = "http://localhost:3001";
const TEAM = "tm_0000000001";
const MAIN_MEMBER = "tmm_0000000002";
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const out = (k, v) => console.log(`${k}=${JSON.stringify(v)}`);

const BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "secret_command",
    arguments: {
      taskId: "t_0000000001",
      selfInstanceId: MAIN_MEMBER,
      command: "echo probe-{{TOKEN}}",
      variables: [{ name: "TOKEN", secret: true }],
      reason: "F3-LANE-B sse-probe",
    },
  },
});

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const events = [];
  const netEvents = [];
  page.on("response", (res) => {
    if (res.url().includes("/api/v1/events")) {
      netEvents.push({ url: res.url().slice(0, 120), status: res.status(), type: res.request().resourceType() });
    }
  });
  page.on("requestfailed", (req) => {
    if (req.url().includes("/api/v1/events")) netEvents.push({ url: req.url().slice(0, 120), failed: req.failure()?.errorText });
  });
  await page.addInitScript(() => {
    window.__sseLog = [];
    const Orig = window.EventSource;
    if (!Orig) return;
    const Wrapped = function (url, init) {
      const es = new Orig(url, init);
      window.__sseLog.push({ kind: "open-attempt", url: String(url).slice(0, 140) });
      es.addEventListener("message", (e) => {
        window.__sseLog.push({ kind: "message", id: e.lastEventId, data: String(e.data).slice(0, 400) });
      });
      es.addEventListener("error", () => {
        window.__sseLog.push({ kind: "error", readyState: es.readyState });
      });
      return es;
    };
    Wrapped.prototype = Orig.prototype;
    Wrapped.CONNECTING = Orig.CONNECTING;
    Wrapped.OPEN = Orig.OPEN;
    Wrapped.CLOSED = Orig.CLOSED;
    window.EventSource = Wrapped;
  });

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("username").fill("seed-admin");
  await page.getByTestId("password").fill("Admin@123456");
  await page.getByTestId("login-button").click();
  await page.waitForURL(/\/teams/, { timeout: 20000 });
  await page.goto(`${BASE}/teams/${TEAM}/session`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("team-session-root").waitFor({ state: "visible", timeout: 20000 });
  const dm = page.locator(`[data-testid="dm-tab-private-${MAIN_MEMBER}"]`);
  if (await dm.count()) await dm.first().click();
  await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(3000);
  out("SSE_LOG_AFTER_LOAD", await page.evaluate(() => window.__sseLog.slice(0, 6)));
  out("EVENTS_NET_AFTER_LOAD", netEvents);

  log("== trigger pending secret question via background curl ==");
  const curl = spawn("curl", [
    "-sN",
    "--max-time", "60",
    "-X", "POST", "http://localhost:13000/api/v1/platform-mcp",
    "-H", "content-type: application/json",
    "-H", "x-worker-id: w_compose_worker",
    "-H", "x-worker-token: compose-worker-token",
    "--data-binary", BODY,
  ]);
  let curlOut = "";
  curl.stdout.on("data", (d) => { curlOut += d.toString(); });
  curl.stderr.on("data", (d) => { curlOut += d.toString(); });

  const deadline = Date.now() + 30000;
  let modalVisible = false;
  while (Date.now() < deadline) {
    if (await page.getByTestId("question-modal").count()) { modalVisible = true; break; }
    await page.waitForTimeout(500);
  }
  out("MODAL_VISIBLE", { modalVisible, waitedMs: 30000 - (deadline - Date.now()) });
  out("SSE_LOG", await page.evaluate(() => window.__sseLog));
  out("EVENTS_NET", netEvents);
  out("CURL_OUT", curlOut.slice(0, 500));
  await page.screenshot({ path: path.join(__dirname, "f3m-sse-probe.png") });

  curl.kill("SIGKILL");
  await page.waitForTimeout(2500);
  out("SSE_LOG_AFTER_KILL", await page.evaluate(() => window.__sseLog.slice(-4)));
  out("MODAL_AFTER_KILL", await page.getByTestId("question-modal").count());
  await browser.close();
  log("== probe done ==");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e && e.stack ? e.stack : String(e)); process.exit(1); });
