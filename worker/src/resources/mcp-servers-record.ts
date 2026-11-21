/**
 * 平台 MCP 服务器记录形状（控制面 `GET /mcp-servers` 的行）。
 *
 * ── 为什么单独成模块 ────────────────────────────────────────────────────
 * 这个类型此前定义在 `resources/injector.ts`（opencode 注入器）里。dsh 注入器同样要
 * 消费平台 MCP 列表，但它**不应该**为了一个类型去 import 整个 opencode 注入器链
 * （那条链会拉起 serve 插件产物、omo 配置、custom-tool 渲染等一堆与 dsh 无关的东西，
 * 既扩大 dsh 运行时的加载面，也让"dsh 是否依赖 opencode 实现"变得不可判定）。
 *
 * 纯类型 + 纯函数、零运行时依赖 ⇒ 两引擎都可以放心引用。
 *
 * @module resources/mcp-servers-record
 */

/** 平台 MCP 服务器记录（字段对齐 11 篇 §5.1 opencode mcp 配置节）。 */
export interface McpServerRecord {
  id: string;
  name: string;
  /** `local`（子进程）或 `remote`（HTTP 服务）。 */
  type: string;
  command: { command?: string[]; cwd?: string; environment?: unknown; timeout?: number } | null;
  url: string | null;
  headers: Record<string, string> | null;
  oauth: unknown;
  enabled?: boolean;
  /** remote 顶层可选超时（11 §5.1 remote 字段含 timeout?；服务端当前模型未提供，兼容预留）。 */
  timeout?: number;
}

/** 平台内置 MCP 服务器名（与 server `PLATFORM_MCP_SERVER_NAME` 对齐）。 */
export const VTEAM_MCP_SERVER_NAME = 'vteam';

/**
 * vteam 远端条目 MCP 客户端超时下限 ms：`secret_command` 阻塞调用最坏总预算
 * 855s（540s 敏感值输入 + 300s 命令 + 15s 裕量），不设下限会被引擎默认超时
 * 在预算内掐断 → 注入点硬编码本下限，不依赖客户端默认值、不要求 DB 迁移。
 *
 * ⚠️ dsh 侧同样适用：`dsh-mcp-client` 的 `toolCallTimeoutMs` 缺省只有 60s，
 * 平台工具里 `secret_command` / 长任务轮询会**在预算内**被掐断（表现为"工具超时"
 * 而不是"工具不存在"，但同样是平台能力不可用）。
 */
export const VTEAM_MCP_TIMEOUT_FLOOR_MS = 900_000;

/**
 * vteam 远端条目最终 timeout：`VTEAM_MCP_TIMEOUT_MS` 可覆盖，但一律 clamp 到
 * `VTEAM_MCP_TIMEOUT_FLOOR_MS`（缺省/空串/非十进制整数/非正数 → 直接取下限）。
 */
export function resolveVteamMcpTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.VTEAM_MCP_TIMEOUT_MS;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    return VTEAM_MCP_TIMEOUT_FLOOR_MS;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return VTEAM_MCP_TIMEOUT_FLOOR_MS;
  }
  return Math.max(parsed, VTEAM_MCP_TIMEOUT_FLOOR_MS);
}
