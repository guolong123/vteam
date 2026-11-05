/**
 * JWT 过期时间解析（纯逻辑，供 lib-unit 测试）。
 *
 * 为什么需要：`accessToken` 默认只有 2h，到期后任意接口/SSE 都会 401。
 * 客户端据此可以**主动续期**（在过期前 refresh），而不是等 401 再被动出错。
 * 只解析 payload 的 `exp`（epoch 秒），**不校验签名**——签名由服务端负责，
 * 这里仅用于排期，解析失败一律返回 null（调用方跳过主动续期，回退到 401 触发）。
 */

/** 取 JWT `exp`（毫秒时间戳）；token 非法/缺 exp/非 3 段 → null。 */
export function jwtExpiryMs(token: string | null | undefined): number | null {
  if (!token) return null;
  const segments = token.split(".");
  if (segments.length < 2) return null;
  try {
    // base64url → base64（补齐 padding），浏览器与 Node 都能 atob
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return null;
    }
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/** 主动续期提前量下限（毫秒）：剩余寿命再短也不做「到期前 0ms」的抖动排期。 */
const MIN_LEAD_MS = 60_000;

/**
 * 计算「下一次主动续期」的延迟（毫秒）。
 *
 * 策略：按剩余寿命的 80% 排期（2h token → 约 1h36m 后刷新），
 * 这样刷新发生在过期前，且不会频繁请求；剩余寿命不足 2×MIN_LEAD 时退化为
 * `剩余 - MIN_LEAD`（至少留 1 分钟余量）；已过期/无法解析 → null（不排期）。
 */
export function proactiveRefreshDelayMs(
  expiresAtMs: number | null,
  nowMs: number = Date.now(),
): number | null {
  if (expiresAtMs === null) return null;
  const remaining = expiresAtMs - nowMs;
  if (remaining <= 0) return null;
  const byRatio = Math.floor(remaining * 0.8);
  const withLead = remaining - MIN_LEAD_MS;
  const delay = remaining > MIN_LEAD_MS * 2 ? byRatio : withLead;
  return Math.max(delay, MIN_LEAD_MS);
}
