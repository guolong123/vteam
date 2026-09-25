import { test, expect } from "@playwright/test";
import { api, getAuthToken, setAuthToken } from "./api";

// 回归护栏：docs-site 的 /prototypes 与部分 /prd 端点返回 text/plain。
// 统一封装 web/lib/api.ts 若只支持 JSON.parse，这些纯文本响应会抛 SyntaxError，
// 导致文档站原型沙箱完全无法加载源码。此 spec 在只支持 JSON 的旧实现下必然失败。
test("parse=text 时 text/plain 响应体原样返回，不经过 JSON.parse", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = getAuthToken();
  let requestInit: RequestInit | undefined;

  const source = `export default function App() {
  return <main>prototype source</main>;
};
`;

  globalThis.fetch = async (_input, init) => {
    requestInit = init;
    return new Response(source, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  };
  setAuthToken("test-token");

  try {
    const content = await api.get<string>(
      "/docs-site/t_task/prototypes/demo.tsx",
      { parse: "text" },
    );
    expect(content).toBe(source);
    // 收敛到 lib/api 的同时不得丢失鉴权头
    expect(new Headers(requestInit?.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
  } finally {
    setAuthToken(originalToken);
    globalThis.fetch = originalFetch;
  }
});

test("默认仍为 JSON 解析（parse 缺省时行为不变）", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = getAuthToken();

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  setAuthToken("test-token");

  try {
    await expect(api.get<{ ok: boolean }>("/anything")).resolves.toEqual({
      ok: true,
    });
  } finally {
    setAuthToken(originalToken);
    globalThis.fetch = originalFetch;
  }
});
