/**
 * opencode 引擎的能力位（P1）。
 *
 * 这些能力位是**从既有实现反推**的，不是新加功能：
 * - opencode serve 暴露 `/todos`、`/agents`、`/integrations`、`/omo-config`、计划文件，
 *   且支持会话内切换模型与在途 steer；
 * - MCP 状态可直查 serve 的 `GET /api/mcp`（既有 `McpStatusProbe`）。
 *
 * 上报后 server 侧据此决定是否调用对应端点（P6），从而**不再**用 `if (engine === 'opencode')`。
 *
 * @module engine/opencode/capabilities
 */

import type { EngineCapabilities } from '../types';

/**
 * 构造 opencode 的能力位。
 *
 * @param engineVersion - 规范化版本串（`OpencodeServer.version`，形如 `2.0.32`）。
 *   缺失/探测失败时用 `'unknown'`（与既有上报口径一致）。
 */
export function opencodeCapabilities(engineVersion: string): EngineCapabilities {
  return {
    engineVersion,
    // serve 暴露 POST …/model，可会话级切换；vteam 既有实现按消息覆盖模型。
    perMessageModelSwitch: true,
    // GET /todos
    todos: true,
    // GET /agents（per-directory 发现 opencode.json）
    externalAgents: true,
    // GET /integrations（集成注册表）
    integrations: true,
    // GET/POST /omo-config（OmO 是 opencode 生态的插件）
    omoConfig: true,
    // `.opencode/plans/*.md`（既有约定；P1 起优先读 `.vteam/plans`，见 WorkspaceLayout）
    planFiles: true,
    // prompt body 的 delivery: 'steer'
    steer: true,
    // GET /api/mcp
    mcpStatusProbe: true,
  };
}
