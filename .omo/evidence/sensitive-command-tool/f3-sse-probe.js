/** F3: live-SSE delivery probe — page open FIRST, then question created; capture SSE frames + queue state. evidence-only */
const path = require("node:path");
const { chromium } = require(path.join(__dirname, "../../../web/node_modules/playwright"));

(async () => {
  const consoleMsgs = [];
  const pageErrors = [];
  const sseFrames = [];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("response", async (res) => {
    const ct = res.headers()["content-type"] || "";
    if (ct.includes("text/event-stream")) {
      console.log("SSE_STREAM", res.url());
      try {
        const body = await res.text();
        for (const line of body.split("\n")) {
          if (line.includes("agent.question") || line.includes("secret")) sseFrames.push(line.slice(0, 300));
        }
      } catch (e) { console.log("sse-body-read-fail", String(e).slice(0, 120)); }
    }
    if (res.url().includes("/questions")) console.log("QUESTIONS_REQ", res.status(), res.url());
  });

  console.log("login...");
  await page.goto("http://localhost:13001/login", { waitUntil: "domcontentloaded" });
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await page.waitForURL(/\/teams/, { timeout: 15000 });
  await page.goto("http://localhost:13001/teams/tm_0000000001/session", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  console.log("PAGE_READY", new Date().toISOString());
  console.log("PENDING_BEFORE=" + JSON.stringify(await page.evaluate(async () => {
    const r = await fetch("/api/v1/questions?teamId=tm_0000000001&status=pending", { credentials: "include" });
    return await r.json();
  }).catch(e => String(e))).slice(0, 300));
  // signal readiness for outer script
  require("fs").writeFileSync(path.join(__dirname, "f3-sse-probe-ready.txt"), new Date().toISOString());

  // wait for modal up to 75s (question will be created by outer script ~now)
  try {
    await page.getByTestId("question-modal").waitFor({ state: "visible", timeout: 75000 });
    console.log("MODAL_ARRIVED", new Date().toISOString());
    await page.screenshot({ path: path.join(__dirname, "f3-sse-live-modal.png") });
    // cancel to settle
    await page.getByTestId("question-secret-cancel").click();
    await page.waitForTimeout(2000);
    console.log("CANCELLED");
  } catch (e) {
    console.log("MODAL_TIMEOUT_75s", new Date().toISOString());
    await page.screenshot({ path: path.join(__dirname, "f3-sse-live-notshown.png") });
    console.log("QUEUE_STATE=" + JSON.stringify(await page.evaluate(() => {
      const m = document.querySelector('[data-testid="question-modal"]');
      return { modalInDom: !!m, bodyText: document.body.innerText.slice(0, 200) };
    })));
  }
  console.log("SSE_FRAMES=" + JSON.stringify(sseFrames.slice(0, 10)));
  console.log("CONSOLE(" + consoleMsgs.length + ")=" + JSON.stringify(consoleMsgs.slice(0, 10)));
  console.log("PAGE_ERRORS=" + JSON.stringify(pageErrors));
  await browser.close();
})().catch((err) => { console.error("FATAL:", String(err).slice(0, 500)); process.exit(1); });
