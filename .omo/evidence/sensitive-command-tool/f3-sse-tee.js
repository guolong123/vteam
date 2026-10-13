/** F3 live-SSE tee: wrap fetch reader for /api/v1/events to capture frames; page open BEFORE question creation. evidence-only */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require(path.join(__dirname, "../../../web/node_modules/playwright"));

(async () => {
  const consoleMsgs = [];
  const pageErrors = [];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newPage ? null : null; // noop
  const page = await browser.newPage();

  await page.addInitScript(() => {
    window.__sseTee = [];
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
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = dec.decode(value, { stream: true });
              if (text.includes("agent.question") || text.includes("secret")) {
                window.__sseTee.push({ t: Date.now(), frame: text.slice(0, 500) });
              }
            }
          })();
        }
      } catch (e) { window.__sseTee.push({ err: String(e) }); }
      return res;
    };
  });

  page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

  await page.goto("http://localhost:13001/login", { waitUntil: "domcontentloaded" });
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await page.waitForURL(/\/teams/, { timeout: 15000 });
  await page.goto("http://localhost:13001/teams/tm_0000000001/session", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000); // settle + SSE connect
  const pending = await page.evaluate(async () => {
    const tok = localStorage.getItem("token") || localStorage.getItem("access_token") || "";
    return { keys: Object.keys(localStorage), tokPresent: tok.length > 0 };
  });
  console.log("PAGE_READY", new Date().toISOString(), JSON.stringify(pending));
  fs.writeFileSync(path.join(__dirname, "f3-sse-tee-ready.txt"), new Date().toISOString());

  try {
    await page.getByTestId("question-modal").waitFor({ state: "visible", timeout: 90000 });
    console.log("MODAL_ARRIVED", new Date().toISOString());
    await page.screenshot({ path: path.join(__dirname, "f3-sse-live-modal.png") });
    await page.getByTestId("question-secret-cancel").click();
    await page.waitForTimeout(2500);
    console.log("CANCELLED_OK");
  } catch (e) {
    console.log("MODAL_NOT_ARRIVED_90s", new Date().toISOString());
    await page.screenshot({ path: path.join(__dirname, "f3-sse-live-notshown.png") });
  }
  const tee = await page.evaluate(() => window.__sseTee || []);
  console.log("SSE_TEE(" + tee.length + ")=" + JSON.stringify(tee).slice(0, 3000));
  console.log("CONSOLE(" + consoleMsgs.length + ")=" + JSON.stringify(consoleMsgs.slice(0, 8)));
  console.log("PAGE_ERRORS=" + JSON.stringify(pageErrors));
  await browser.close();
})().catch((e) => { console.error("FATAL:", String(e).slice(0, 400)); process.exit(1); });
