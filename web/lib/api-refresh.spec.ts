import { test, expect } from "@playwright/test";
import { api, getAuthToken, setAuthToken, setRefreshHandler } from "./api";

/**
 * api 401 自动续期门（lib-unit）
 * =============================================
 * 背景（用户实测缺陷）：登录后很短时间就被踢回登录页。
 * 根因：服务端签发 access(2h) + refresh(7d)，但前端只存 access、拿到 refresh 就丢，
 * access 到期后任意接口 401 → 全局 handler 立刻清登录态跳 /login。
 *
 * 本 spec 锁住修复后的契约：
 * 1. 401 + 有 token + 有刷新处理器 → 调刷新，拿到新 token 后**原请求自动重试一次**，
 *    对调用方表现为成功（用户无感）。
 * 2. 刷新失败（refreshToken 也过期）→ 走 unauthorizedHandler（清登录态），
 *    且请求仍按错误抛出。
 * 3. 登录/刷新端点本身的 401 **绝不**触发续期（否则死循环）。
 * 4. 未注册刷新处理器时行为与改造前一致（直接登出）。
 *
 * 运行：`npx playwright test lib/api-refresh.spec.ts --project=lib-unit`
 * 失败语义：改动前 api.ts 没有 setRefreshHandler / 不重试 → 本 spec 红。
 */

/** 一次性 mock fetch：按调用次数返回不同响应，并记录 Authorization 头。 */
function mockFetch(
  responses: Array<{ status: number; body?: unknown; text?: string }>
): { authHeads: (string | null)[]; calls: () => number } {
  const authHeads: (string | null)[] = [];
  let i = 0;
  globalThis.fetch = async (_input, init) => {
    authHeads.push(new Headers(init?.headers).get("Authorization"));
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(
      spec.text !== undefined ? spec.text : JSON.stringify(spec.body ?? {}),
      {
        status: spec.status,
        headers: { "Content-Type": "application/json" },
      }
    );
  };
  return { authHeads, calls: () => i };
}

test("401 → 自动刷新 → 原请求重试成功（用户无感）", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = getAuthToken();
  let unauthorizedCalls = 0;
  let refreshCalls = 0;
  const { setUnauthorizedHandler } = await import("./api");

  setUnauthorizedHandler(() => {
    unauthorizedCalls += 1;
  });
  // 首调 401，刷新后第二次成功
  const { authHeads } = mockFetch([
    { status: 401, body: { code: "AUTH_UNAUTHORIZED", message: "token 已过期" } },
    { status: 200, body: { ok: true } },
  ]);
  setAuthToken("old-expired-token");
  setRefreshHandler(async () => {
    refreshCalls += 1;
    return "fresh-token";
  });

  try {
    const result = await api.get<{ ok: boolean }>("/teams");
    expect(result).toEqual({ ok: true });
    // 关键：重试用的是**新 token**
    expect(authHeads[0]).toBe("Bearer old-expired-token");
    expect(authHeads[1]).toBe("Bearer fresh-token");
    expect(refreshCalls).toBe(1);
    // 续期成功就不该登出
    expect(unauthorizedCalls).toBe(0);
    // 模块级 token 已更新，后续请求直接可用
    expect(getAuthToken()).toBe("fresh-token");
  } finally {
    setRefreshHandler(null);
    setUnauthorizedHandler(null);
    setAuthToken(originalToken);
    globalThis.fetch = originalFetch;
  }
});

test("刷新失败 → 走登出处理器，请求按 401 抛出", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = getAuthToken();
  let unauthorizedCalls = 0;
  const { setUnauthorizedHandler } = await import("./api");

  setUnauthorizedHandler(() => {
    unauthorizedCalls += 1;
  });
  mockFetch([
    { status: 401, body: { code: "AUTH_UNAUTHORIZED", message: "token 已过期" } },
  ]);
  setAuthToken("old-expired-token");
  setRefreshHandler(async () => null); // refreshToken 也失效

  try {
    await expect(api.get("/teams")).rejects.toMatchObject({ status: 401 });
    expect(unauthorizedCalls).toBe(1);
  } finally {
    setRefreshHandler(null);
    setUnauthorizedHandler(null);
    setAuthToken(originalToken);
    globalThis.fetch = originalFetch;
  }
});

test("登录/刷新端点自身的 401 不触发续期（防死循环）", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = getAuthToken();
  let refreshCalls = 0;
  let unauthorizedCalls = 0;
  const { setUnauthorizedHandler } = await import("./api");

  setUnauthorizedHandler(() => {
    unauthorizedCalls += 1;
  });
  mockFetch([
    { status: 401, body: { code: "AUTH_INVALID_CREDENTIALS", message: "用户名或密码错误" } },
  ]);
  setAuthToken("some-token");
  setRefreshHandler(async () => {
    refreshCalls += 1;
    return "fresh-token";
  });

  try {
    await expect(api.post("/auth/login", { username: "x", password: "y" })).rejects.toMatchObject({
      status: 401,
    });
    expect(refreshCalls).toBe(0);

    // /auth/refresh 自身 401 同样不续期
    await expect(
      api.post("/auth/refresh", { refreshToken: "bad" })
    ).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls).toBe(0);
    void unauthorizedCalls;
  } finally {
    setRefreshHandler(null);
    setUnauthorizedHandler(null);
    setAuthToken(originalToken);
    globalThis.fetch = originalFetch;
  }
});

test("未注册刷新处理器：401 行为与改造前一致（直接触发登出）", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = getAuthToken();
  let unauthorizedCalls = 0;
  const { setUnauthorizedHandler } = await import("./api");

  setUnauthorizedHandler(() => {
    unauthorizedCalls += 1;
  });
  const { calls } = mockFetch([
    { status: 401, body: { code: "AUTH_UNAUTHORIZED", message: "token 已过期" } },
  ]);
  setAuthToken("old-token");
  setRefreshHandler(null);

  try {
    await expect(api.get("/teams")).rejects.toMatchObject({ status: 401 });
    // 只打了一次，没有重试
    expect(calls()).toBe(1);
    expect(unauthorizedCalls).toBe(1);
  } finally {
    setUnauthorizedHandler(null);
    setAuthToken(originalToken);
    globalThis.fetch = originalFetch;
  }
});
