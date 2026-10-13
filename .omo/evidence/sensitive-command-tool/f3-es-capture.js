/** F3 decisive: capture agent.question frames on the app's own EventSource + modal state, page open BEFORE creation. evidence-only */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require(path.join(__dirname, "../../../web/node_modules/playwright"));

(async () => {
  const consoleMsgs = [];
  const pageErrors = [];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();

  await page.addInitScript(() => {
    window.__esFrames = [];
    const OrigES = window.EventSource;
    window.EventSource = class extends OrigES {
      constructor(url, init) {
        super(url, init);
        this.addEventListener("message", (e) => {
          if (String(e.data).includes("agent.question") || String(e.data).includes("secret_input")) {
            window.__esFrames.push({ t: Date.now(), data: String(e.data).slice(0, 400) });
          }
        });
      }
    };
  });

  page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 180)}`));
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 180)));

  await page.goto("http://localhost:13001/login", { waitUntil: "domcontentloaded" });
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await page.waitForURL(/\/teams/, { timeout: 15000 });
  await page.goto("http://localhost:13001/teams/tm_0000000001/session", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  const modalAtLoad = await page.getByTestId("question-modal").count();
  console.log("PAGE_READY", new Date().toISOString(), "modalAtLoad=", modalAtLoad);
  fs.writeFileSync(path.join(__dirname, "f3-es-ready.txt"), new Date().toISOString());

  const deadline = Date.now() + 75000;
  let arrived = false;
  while (Date.now() < deadline) {
    if (await page.getByTestId("question-modal").count()) { arrived = true; break; }
    await page.waitForTimeout(1000);
  }
  if (arrived) {
    console.log("MODAL_ARRIVED_VIA_LIVE", new Date().toISOString());
    await page.screenshot({ path: path.join(__dirname, "f3-sse-live-modal.png") });
    await page.getByTestId("question-secret-cancel").click();
    await page.waitForTimeout(2500);
    console.log("CANCELLED_OK");
  } else {
    console.log("MODAL_NOT_ARRIVED_75s", new Date().toISOString());
    await page.screenshot({ path: path.join(__dirname, "f3-sse-live-notshown.png") });
  }
  const frames = await page.evaluate(() => window.__esFrames || []);
  console.log("ES_FRAMES(" + frames.length + ")=" + JSON.stringify(frames).slice(0, 2500));
  console.log("CONSOLE(" + consoleMsgs.length + ")=" + JSON.stringify(consoleMsgs.slice(0, 6)));
  console.log("PAGE_ERRORS=" + JSON.stringify(pageErrors));
  await browser.close();
})().catch((e) => { console.error("FATAL:", String(e).slice(0, 400)); process.exit(1); });
