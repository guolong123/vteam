import { test, expect } from "@playwright/test";
import { jwtExpiryMs, proactiveRefreshDelayMs } from "./jwt";

/**
 * jwt · token 续期排期纯逻辑门（lib-unit）
 * =============================================
 * 背景：accessToken 默认 2h 到期，前端此前只存 accessToken（refreshToken 拿到就丢），
 * 表现为「登录后很短时间就被踢回登录页」。续期链路依赖对 `exp` 的解析与排期：
 * - `jwtExpiryMs`：只读 payload 的 `exp`（epoch 秒）→ 毫秒；**不校验签名**
 *   （签名是服务端职责），解析不了就返回 null（回退到 401 被动续期）。
 * - `proactiveRefreshDelayMs`：按剩余寿命 80% 排期（2h token ≈ 1h36m 后刷新），
 *   剩余过短时退化为「剩余 - 1 分钟」且不小于 1 分钟；已过期 → null（不排期）。
 *
 * 运行：`npx playwright test lib/jwt.spec.ts --project=lib-unit`
 * 失败语义：改动前本模块不存在 → import 即红。
 */

/** 构造一个只含 payload 的假 JWT（签名段随便给，解析侧不校验签名）。 */
function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

test("读取 exp：返回毫秒时间戳（epoch 秒 × 1000）", () => {
  const exp = 1_790_000_000;
  expect(jwtExpiryMs(fakeJwt({ sub: "u_1", exp }))).toBe(exp * 1000);
});

test("非法/缺失 exp → null（不排期，回退 401 被动续期）", () => {
  expect(jwtExpiryMs(fakeJwt({ sub: "u_1" }))).toBeNull();
  expect(jwtExpiryMs(fakeJwt({ exp: "not-a-number" }))).toBeNull();
  expect(jwtExpiryMs("garbage")).toBeNull();
  expect(jwtExpiryMs("a.b")).toBeNull(); // payload 不是 JSON
  expect(jwtExpiryMs(null)).toBeNull();
  expect(jwtExpiryMs("")).toBeNull();
});

test("2h 寿命：按 80% 排期（约 1h36m 后刷新，不是等过期）", () => {
  const now = 1_790_000_000_000;
  const twoHours = 2 * 60 * 60 * 1000;
  const delay = proactiveRefreshDelayMs(now + twoHours, now);
  expect(delay).toBe(Math.floor(twoHours * 0.8));
  // 关键不变量：一定在过期**之前**触发
  expect(delay).toBeLessThan(twoHours);
});

test("剩余寿命很短：至少留 1 分钟余量，且不会排到负数/0", () => {
  const now = 1_790_000_000_000;
  // 剩余 90s：> 2×1min → 走 80% 比例（72s），仍 >= 1 分钟
  expect(proactiveRefreshDelayMs(now + 90_000, now)).toBeGreaterThanOrEqual(
    60_000,
  );
  // 剩余 70s：<= 2×1min → 退化为 70s-60s=10s，被下限抬到 60s
  expect(proactiveRefreshDelayMs(now + 70_000, now)).toBe(60_000);
});

test("已过期 / 无法解析 → null（不排期）", () => {
  const now = 1_790_000_000_000;
  expect(proactiveRefreshDelayMs(now - 1000, now)).toBeNull();
  expect(proactiveRefreshDelayMs(now, now)).toBeNull();
  expect(proactiveRefreshDelayMs(null, now)).toBeNull();
});

test("7 天 refresh 窗口：排期结果远小于 7 天（保证按时轮换、窗口滚动）", () => {
  const now = 1_790_000_000_000;
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const delay = proactiveRefreshDelayMs(now + sevenDays, now);
  expect(delay).not.toBeNull();
  expect(delay!).toBeLessThan(sevenDays);
});
