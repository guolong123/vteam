/**
 * MCP `headers` 的 `{env:VAR}` 模板解析（**两引擎共用**）。
 *
 * ── 为什么单独成模块 ────────────────────────────────────────────────────
 * 平台的 MCP 条目（尤其 seed 的内置 `vteam`）用 `{env:X_WORKER_TOKEN}` /
 * `{env:WORKER_ID}` 引用鉴权材料，真值只有 worker 侧知道。此前这段解析**只**存在于
 * opencode 注入器的 `resolveHeaders` 里，于是 dsh 引擎写出的 patch 把模板串**原样**
 * 当成 header 值发出去 ⇒ 平台 MCP 收到字面量 `{env:X_WORKER_TOKEN}` ⇒ 401/403
 * ⇒ 「工具全部消失、没有任何报错」（静默失败，正是 dsh worker 上 MCP 不通的形态之一）。
 *
 * 抽到本模块后，两引擎对同一份数据给出**同一种** header，不会再出现
 * 「opencode 通、dsh 不通」这种只能靠翻代码才能解释的差异。
 *
 * ⚠️ 未知变量**保留原样**：worker 不知道宿主环境里还有什么（外部部署可能自己注入），
 * 交给引擎侧兜底替换；把它替换成空串会让 header 变成空值，反而更难排查。
 *
 * @module resources/mcp-headers
 */

/** worker 侧已知的模板变量（`{env:NAME}` → 实际值）。 */
export interface McpHeaderEnv {
  /** `{env:WORKER_ID}` 的值（= config.workerId）。 */
  workerId: string;
  /** `{env:X_WORKER_TOKEN}` 的值（= config.workerToken）。 */
  workerToken: string;
}

/** `{env:NAME}` 形态的模板占位。 */
const ENV_TEMPLATE_RE = /\{env:([A-Z0-9_]+)\}/g;

/**
 * 解析 MCP headers 里的 `{env:...}` 模板。
 *
 * @param headers - 平台下发的 header 表（值可能含模板；非字符串值原样透传）。
 * @param env - worker 侧已知变量。
 * @returns 解析后的新对象（不修改入参）；`headers` 为 undefined 时原样返回。
 */
export function resolveMcpHeaders(
  headers: Record<string, unknown> | undefined,
  env: McpHeaderEnv,
): Record<string, unknown> | undefined {
  if (!headers) {
    return headers;
  }
  const knownEnv: Record<string, string> = {
    WORKER_ID: env.workerId,
    X_WORKER_TOKEN: env.workerToken,
  };
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] =
      typeof value === 'string'
        ? value.replace(ENV_TEMPLATE_RE, (match, name: string) => knownEnv[name] ?? match)
        : value;
  }
  return resolved;
}

/**
 * 只保留值为字符串的 header（dsh 的 `dsh-mcp-client` 的 `headers` 是 `z.dict(String)`，
 * 非字符串值会让插件配置校验失败 ⇒ 整条 MCP 挂载不生效）。
 *
 * 平台数据里 oauth/environment 等字段是任意 JSON，混进 headers 时不能直接透传。
 */
export function stringifyMcpHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) {
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}
