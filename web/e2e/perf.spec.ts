import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * 性能 E2E（Phase 5 T9 · 复用 T8 bench.mjs 思路，浏览器内测量）
 * =============================================
 * 1. 页面加载性能：performance.timing（domContentLoaded / load），dev 模式采样记录
 * 2. 群聊 SSE 计时：SSE 建立 → POST 无 @ 消息 → chat.message.new 到达（中位数，零模型调用）
 * 3. 首字（1 次真实 opencode 调用）：@a_product → 轮询 trigger-results 精确关联回复
 * 阈值对齐 T8：groupChat 通过线 1000ms；firstToken 记录目标线 15000ms（不阻断），
 * 硬门限与本页真实模型调用轮询的 90s timeout 对齐
 * 环境：web 3001（/api/v1 rewrites → server 3000）+ storageState（seed-admin）
 */
const TEAM_ID = "tm_0000000001";
const AGENT_ID = "a_product";
const FIRST_TOKEN_TARGET_MS = 15_000;
const FIRST_TOKEN_HARD_GATE_MS = 90_000;

type PerfTeam = { currentTaskId: string | null };
type PerfChannel = {
  id: string;
  type: string;
  teamId?: string | null;
  teamMemberId?: string | null;
  agentId?: string | null;
};
type PerfChannelList = { items: PerfChannel[]; total: number };
type PerfContext = { taskId: string; channelId: string };

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Resolve the live private team-session channel used by the first-token probe.
 * The team-session page opens a member's private tab through the idempotent
 * POST /dm-channels endpoint; the returned channel is where team-session
 * replies are stored after session unification.
 */
async function resolveTeamSessionChannel(
  request: APIRequestContext,
  token: string,
): Promise<string> {
  const response = await request.post("/api/v1/dm-channels", {
    headers: authHeaders(token),
    data: { teamId: TEAM_ID, agentId: AGENT_ID },
  });
  expect(response.status(), "团队私聊频道解析应成功").toBe(201);
  const channel = (await response.json()) as PerfChannel;
  expect(channel.id, "团队私聊频道应有 id").toBeTruthy();
  expect(channel.type, "首字探针必须使用当前团队私聊会话").toBe("private");
  expect(channel.teamId, "团队私聊频道应归属当前团队").toBe(TEAM_ID);
  expect(channel.agentId, "团队私聊频道应对应目标平台 Agent").toBe(AGENT_ID);
  return channel.id;
}

/**
 * Resolve the group channel with the same fallback order as the team-session
 * page's `/channels?teamId=...` query. This is intentionally only for the
 * transport-only SSE benchmark; the first-token benchmark uses the private
 * team-session channel above.
 */
async function resolveTeamGroupChannel(
  request: APIRequestContext,
  token: string,
): Promise<string> {
  const response = await request.get(
    `/api/v1/channels?teamId=${encodeURIComponent(TEAM_ID)}`,
    { headers: authHeaders(token) },
  );
  expect(response.ok(), "团队群聊频道解析应成功").toBeTruthy();
  const payload = (await response.json()) as PerfChannelList;
  const items = payload.items ?? [];
  const channel =
    items.find((item) => item.type === "team_group" && (item.teamId ?? null) === TEAM_ID) ??
    (items.length === 1 ? items[0] : undefined) ??
    items.find((item) => (item.teamId ?? null) === TEAM_ID) ??
    items[0];
  if (!channel) {
    throw new Error(`团队 ${TEAM_ID} 没有可访问的聊天频道`);
  }
  return channel.id;
}

async function ensurePerfTask(request: APIRequestContext, token: string): Promise<PerfContext> {
  const headers = authHeaders(token);
  const teamResponse = await request.get(`/api/v1/teams/${TEAM_ID}`, { headers });
  expect(teamResponse.ok()).toBeTruthy();
  const team = (await teamResponse.json()) as PerfTeam;
  let taskId = team.currentTaskId;

  if (!taskId) {
    const created = await request.post("/api/v1/tasks", {
      headers,
      data: { title: `e2e-perf-task-${Date.now()}`, teamId: TEAM_ID },
    });
    expect(created.status()).toBe(201);
    taskId = ((await created.json()) as { id: string }).id;
  }

  const taskResponse = await request.get(`/api/v1/tasks/${taskId}`, { headers });
  expect(taskResponse.ok()).toBeTruthy();
  const task = (await taskResponse.json()) as { status: string };
  if (task.status !== "in_progress") {
    expect(task.status).toBe("pending");
    const started = await request.post(`/api/v1/tasks/${taskId}/start`, { headers });
    expect(started.ok()).toBeTruthy();
  }
  return { taskId, channelId: await resolveTeamSessionChannel(request, token) };
}

async function readToken(page: import("@playwright/test").Page): Promise<string> {
  // 需先导航到同源页面（about:blank 下读 localStorage 会 SecurityError）
  await page.goto("/teams");
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
  test("页面加载性能（/login 与 /teams）", async ({ page }) => {
    // warmup：dev 首编译不计入
    await page.goto("/login");
    await page.goto("/teams");
    const t1 = await page.evaluate(() => {
      const t = performance.timing;
      return {
        domContentLoadedMs: t.domContentLoadedEventEnd - t.navigationStart,
        loadMs: t.loadEventEnd - t.navigationStart,
      };
    });
    test.info().annotations.push({
      type: "perf",
      description: `页面加载 /teams（dev）：domContentLoaded=${t1.domContentLoadedMs}ms load=${t1.loadMs}ms`,
    });
    // dev 模式宽松线：load ≤ 15s（生产 standalone 另行以 Lighthouse/构建产物衡量）
    expect(t1.loadMs).toBeLessThan(15_000);
  });

  test("群聊 SSE 计时（无 @ 消息，零模型调用，3 采样中位数）", async ({ page, request }) => {
    const token = await readToken(page);
    const channelId = await resolveTeamGroupChannel(request, token);
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      samples.push(
        await sseRoundtrip(page, channelId, token, `[qa/perf] 群聊 SSE 采样 ${i + 1}（无 @）`),
      );
    }
    const median = [...samples].sort((a, b) => a - b)[1];
    test.info().annotations.push({
      type: "perf",
      description: `groupChat 采样=${samples.join("/")}ms 中位数=${median}ms（通过线 1000ms）`,
    });
    expect(median, `群聊 SSE 中位数 ${median}ms 应 ≤ 1000ms`).toBeLessThanOrEqual(1000);
  });

  test("首字计时 @a_product（1 次真实 opencode 调用，双线记录不阻断）", async ({ page, request }) => {
    test.setTimeout(120_000);
    const token = await readToken(page);
    const { taskId, channelId } = await ensurePerfTask(request, token);
    const elapsed = await page.evaluate(
      async ({ channelId, token, agentId, taskId, timeout }) => {
        const t0 = Date.now();
        const resp = await fetch(`/api/v1/channels/${channelId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            text: `[qa/perf] 首字计时 @${agentId}（真实调用，请简要回复一句话）`,
            mentions: [{ type: "agent", agentId }],
            taskId,
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
        return -1;
      },
      { channelId, token, agentId: AGENT_ID, taskId, timeout: FIRST_TOKEN_HARD_GATE_MS },
    );
    const observed =
      elapsed < 0
        ? `>${FIRST_TOKEN_HARD_GATE_MS}ms 无回复`
        : `${elapsed}ms`;
    test.info().annotations.push({
      type: "perf",
      description: `firstToken=${observed}（目标线 ${FIRST_TOKEN_TARGET_MS}ms / 观测上限 ${FIRST_TOKEN_HARD_GATE_MS}ms）`,
    });
    // 只对「无回复」设门禁，延迟本身不设：观测上限内拿不到任何回复是真实故障，延迟数值只记录。
    expect(elapsed, `首字 ${observed}：${FIRST_TOKEN_HARD_GATE_MS}ms 内未取到任何回复`).toBeGreaterThan(0);
  });
});
