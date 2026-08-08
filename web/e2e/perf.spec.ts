import { test, expect } from "@playwright/test";

/**
 * 性能 E2E（Phase 5 T9 · 复用 T8 bench.mjs 思路，浏览器内测量）
 * =============================================
 * 1. 页面加载性能：performance.timing（domContentLoaded / load），dev 模式采样记录
 * 2. 群聊 SSE 计时：SSE 建立 → POST 无 @ 消息 → chat.message.new 到达（中位数，零模型调用）
 * 3. 首字（1 次真实 opencode 调用）：@a_product → 轮询 trigger-results 精确关联回复
 * 阈值对齐 T8：groupChat 通过线 1000ms；firstToken 通过线 15000ms（超时不阻断，如实记录）
 * 环境：web 3001（/api/v1 rewrites → server 3000）+ storageState（seed-admin）
 */
const CHANNEL_ID = "c_0000000001"; // T8 性能验收任务群聊频道
const AGENT_ID = "a_product";

async function readToken(page: import("@playwright/test").Page): Promise<string> {
  // 需先导航到同源页面（about:blank 下读 localStorage 会 SecurityError）
  await page.goto("/projects");
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem("agent-platform-auth");
    return raw ? (JSON.parse(raw).state?.token ?? null) : null;
  });
  expect(token, "storageState 应含 token").toBeTruthy();
  return token as string;
}

/** 群聊往返：SSE 建立 → POST 无 @ 消息 → chat.message.new 匹配 → 返回延迟 */
async function sseRoundtrip(
  page: import("@playwright/test").Page,
  channelId: string,
  token: string,
  text: string,
  timeout = 10_000,
): Promise<number> {
  return page.evaluate(
    async ({ channelId, token, text, timeout }) => {
      const t0 = Date.now();
      let msgId: string | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      // 已见帧记录：POST 响应可能晚于 SSE 广播（事件帧插在 backlog 重放流中先到），
      // 帧到达即记时，POST 后查表——避免"事件先到、msgId 后赋值"的漏匹配
      const seen = new Map<string, number>();
      const es = new EventSource(
        `/api/v1/events?token=${encodeURIComponent(token)}&scope=channel:${channelId}`,
      );
      const matched = new Promise<number>((resolve, reject) => {
        timer = setTimeout(() => {
          es.close();
          reject(new Error("SSE 匹配超时"));
        }, timeout);
        es.onmessage = (ev) => {
          let parsed: { type?: string; payload?: { message?: { id?: string } } };
          try {
            parsed = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (parsed?.type === "chat.message.new" && parsed?.payload?.message?.id) {
            const mid = parsed.payload.message.id;
            seen.set(mid, Date.now() - t0);
            if (msgId && mid === msgId) {
              if (timer) clearTimeout(timer);
              es.close();
              resolve(seen.get(mid)!);
            }
          }
        };
      });
      await new Promise<void>((res, rej) => {
        es.onopen = () => res();
        es.onerror = () => rej(new Error("SSE 连接失败"));
      });
      const resp = await fetch(`/api/v1/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text, mentions: [] }),
      });
      const data = await resp.json();
      msgId = data?.message?.id;
      if (resp.status !== 201 || !msgId) {
        es.close();
        throw new Error(`POST 消息失败 HTTP ${resp.status}`);
      }
      if (seen.has(msgId)) {
        if (timer) clearTimeout(timer);
        es.close();
        return seen.get(msgId)!;
      }
      return matched;
    },
    { channelId, token, text, timeout },
  );
}

test.describe("性能 E2E", () => {
  test("页面加载性能（/login 与 /projects）", async ({ page }) => {
    // warmup：dev 首编译不计入
    await page.goto("/login");
    await page.goto("/projects");
    const t1 = await page.evaluate(() => {
      const t = performance.timing;
      return {
        domContentLoadedMs: t.domContentLoadedEventEnd - t.navigationStart,
        loadMs: t.loadEventEnd - t.navigationStart,
      };
    });
    test.info().annotations.push({
      type: "perf",
      description: `页面加载 /projects（dev）：domContentLoaded=${t1.domContentLoadedMs}ms load=${t1.loadMs}ms`,
    });
    // dev 模式宽松线：load ≤ 15s（生产 standalone 另行以 Lighthouse/构建产物衡量）
    expect(t1.loadMs).toBeLessThan(15_000);
  });

  test("群聊 SSE 计时（无 @ 消息，零模型调用，3 采样中位数）", async ({ page }) => {
    const token = await readToken(page);
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      samples.push(
        await sseRoundtrip(page, CHANNEL_ID, token, `[qa/perf] 群聊 SSE 采样 ${i + 1}（无 @）`),
      );
    }
    const median = [...samples].sort((a, b) => a - b)[1];
    test.info().annotations.push({
      type: "perf",
      description: `groupChat 采样=${samples.join("/")}ms 中位数=${median}ms（通过线 1000ms）`,
    });
    expect(median, `群聊 SSE 中位数 ${median}ms 应 ≤ 1000ms`).toBeLessThanOrEqual(1000);
  });

  test("首字计时 @a_product（1 次真实 opencode 调用，双线记录不阻断）", async ({ page }) => {
    test.setTimeout(120_000);
    const token = await readToken(page);
    const elapsed = await page.evaluate(
      async ({ channelId, token, agentId, timeout }) => {
        const t0 = Date.now();
        const resp = await fetch(`/api/v1/channels/${channelId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            text: `[qa/perf] 首字计时 @${agentId}（真实调用，请简要回复一句话）`,
            mentions: [{ type: "agent", agentId }],
          }),
        });
        const data = await resp.json();
        const userMsgId = data?.message?.id;
        if (resp.status !== 201 || !userMsgId) {
          throw new Error(`@ 消息发送失败 HTTP ${resp.status}`);
        }
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const r = await fetch(`/api/v1/channels/${channelId}/trigger-results/${userMsgId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const triggers = (await r.json())?.triggers ?? [];
          if (triggers.some((t: { agentId?: string; replyMessageId?: string }) => t.agentId === agentId && t.replyMessageId)) {
            return Date.now() - t0;
          }
          await new Promise((res) => setTimeout(res, 500));
        }
        throw new Error("首字回复超时");
      },
      { channelId: CHANNEL_ID, token, agentId: AGENT_ID, timeout: 90_000 },
    );
    test.info().annotations.push({
      type: "perf",
      description: `firstToken=${elapsed}ms（通过线 15000ms / 目标线 5000ms，超目标不阻断）`,
    });
    // 通过线断言；超目标线仅记录（T8 实证首字由模型行为主导，波动大）
    expect(elapsed, `firstToken ${elapsed}ms 应 ≤ 15000ms`).toBeLessThanOrEqual(15_000);
  });
});
