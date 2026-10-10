/**
 * 用量统计 API 封装（用量域）
 * =============================================
 * 对齐 server/src/usage/usage.service.ts 的 `TeamUsageResponse`：
 * GET /teams/:teamId/usage[?model=providerID/modelID] —— 团队 Token 用量与费用聚合
 * （成员 × 模型 × 团队合计三层一次算好，**纯只读、零写操作**）。
 *
 * 口径说明（前端展示必须知道的三条，避免二次猜测）：
 * - **纯累计**：无时间序列、无分页（成员数量级小，服务端一次全量），故本封装无 params 类型；
 * - **cost 恒为数字**：DB 列可空（NULL = 上游未上报「未知」），聚合层按 0 参与求和并归一，
 *   前端**不需要 null 分支**（「未知」与「免费」的区分只保留在明细行）；
 * - **全员可见**：服务端成员门在 service（`team_user_members` 无行且非平台管理员 → 403），
 *   前端**不再叠加 admin 门**，403 由 isApiError 统一呈现。
 *
 * 所有方法经 web/lib/api 统一鉴权与错误归一（本文件不自建 fetch）。
 */
import { api } from "@/lib/api";

/**
 * 用量六元组（成员小计 / 模型桶 / 团队合计三处**同形同源**）。
 * 字段名与后端 `UsageTotals` 逐字对齐——服务端用同一个 addInto 累加，
 * 前端也只用同一组键派生三层汇总，杜绝各处各算一遍加法。
 */
export interface UsageTotals {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

/** 单个「成员 × 模型」用量桶（成员行的展开行）。 */
export interface UsageModelBreakdown extends UsageTotals {
  /** `providerID/modelID` 组合串；上游未上报时后端记固定串 `'unknown'`。 */
  model: string;
}

/** 单个团队成员的小计 + 其模型维度展开行。 */
export interface UsageMemberSummary extends UsageTotals {
  teamMemberId: string;
  /** 成员实例显示名（TeamMember.alias：别名或「角色中文名-序号」，如 测试-1；同 Agent 多实例据此区分）。 */
  memberName: string;
  agentName: string;
  /** AgentRole 名称（实时联表，非快照）；成员已删除 / 未绑角色时为 null。 */
  roleName: string | null;
  models: UsageModelBreakdown[];
}

/** GET /teams/:teamId/usage 响应（团队合计）。 */
export interface TeamStatsResponse {
  members: UsageMemberSummary[];
  teamTotal: UsageTotals;
}

/**
 * 用量汇总共享查询键（对齐 memoriesQueryKey 的导出模式）。
 * 前缀 `["team-stats"]` 失效即可连带刷新本域的全部团队查询。
 */
export function statsQueryKey(teamId: string): [string, string] {
  return ["team-stats", teamId];
}

export const statsApi = {
  /**
   * 团队用量聚合汇总（成员 × 模型 + 团队合计，一次算好三层）。
   *
   * 空团队 / 无任何用量行返回 `{members: [], teamTotal: 全 0}`（**不是 404**）：
   * 空数据是统计功能的正常初始状态（用量从功能上线后才开始累积），
   * 由前端渲染空态，不作为错误处理。
   */
  summary(teamId: string): Promise<TeamStatsResponse> {
    return api.get<TeamStatsResponse>(`/teams/${teamId}/usage`);
  },
};