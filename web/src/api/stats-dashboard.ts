/**
 * 统计看板 API 封装（stats 域）
 * =============================================
 * 对齐 server/src/stats/stats.types.ts 的两个端点（**纯只读、零写操作**）：
 * - `GET /stats/overview`   —— 全局跨团队看板（仅平台管理员，AdminGuard）
 * - `GET /stats/teams/:id`  —— 单团队详情（团队成员可见）
 *
 * ## 口径说明（前端展示必须知道的三条，避免二次猜测）
 *
 * 1. **未知 ≠ 0**：`cost` 为 `null` 时表示「上游没上报费用」，UI 必须渲染「—」，
 *    **绝不能**渲染 $0.00（那会把「没统计到」误读成「不花钱」）。
 *    部分未知时服务端返回已知部分之和 + `costUnknownRatio`（覆盖率），前端据此加「未知」标。
 * 2. **去重产出物 ≠ 版本数**：`artifacts` 与 `artifactVersions` 是两个独立字段，不可相加。
 * 3. **`totalTokens` 是推导字段**：服务端已用五元组求和算好（不读 `total_tokens` 列，
 *    该列历史上全为 0）。前端**直接用它**，不要再自己加一遍。
 *
 * ## 权限（与原型约定一致）
 * - overview 需要平台管理员；普通成员调用会 403，由 isApiError 统一呈现。
 * - teamDetail 对团队成员开放，服务端已做 `team_user_members` 判定，前端**不叠加门禁**。
 */
import { api } from "@/lib/api";

/** 时间粒度（只影响桶切分，不影响总量口径）。 */
export type StatsGranularity = "day" | "week" | "month";

/** 统计窗口回显（服务端算好的口径，前端据此标注「你查的到底是哪一段」）。 */
export interface StatsWindow {
  from: string;
  to: string;
  days: number;
  granularity: string;
  timezone: string;
  maxDays: number;
}

/** 窗口内数值总量（与后端 `StatsTotals` 逐字对齐）。 */
export interface StatsTotals {
  tasksCreated: number;
  tasksCompleted: number;
  tasksBlocked: number;
  tasksRejected: number;
  artifacts: number;
  artifactVersions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 五元组之和（服务端推导，前端直接用）。 */
  totalTokens: number;
  /** `null` = 窗口内一行费用都没有上报（**未知**，不是 0/免费）。 */
  cost: number | null;
  /** 窗口内 cost 未知的日行占比 0..1。 */
  costUnknownRatio: number;
  agentMessages: number;
  activeMembers: number;
  costPerTask: number | null;
  costPerArtifact: number | null;
  costPerKToken: number | null;
  /** cacheRead / (input + cacheRead)。 */
  cacheHitRate: number;
  completionRate: number;
}

/** 时间桶（趋势图的一个刻度）。 */
export interface StatsBucket {
  key: string;
  label: string;
  totals: StatsTotals;
}

/** 单团队汇总行（全局看板「团队对比表」）。 */
export interface StatsTeamRow {
  teamId: string;
  teamName: string;
  description: string | null;
  memberCount: number;
  totals: StatsTotals;
  avgCycleHours: number | null;
  avgQueueWaitHours: number | null;
  /** 排队口径来源（当前恒为 `created_to_started`，UI 需标注「近似」）。 */
  queueWaitSource: string;
}

/** 产出物类型构成分片。 */
export interface StatsArtifactTypeSlice {
  type: string;
  count: number;
  share: number;
}

/** 成员产能行。 */
export interface StatsMemberRow {
  teamMemberId: string;
  memberName: string;
  agentName: string;
  roleName: string | null;
  tasks: number;
  artifacts: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number | null;
  messages: number;
}

/** GET /stats/overview 响应。 */
export interface StatsOverviewResponse {
  window: StatsWindow;
  totals: StatsTotals;
  buckets: StatsBucket[];
  teams: StatsTeamRow[];
  avgCycleHours: number | null;
  firstPassRate: number;
  reworkCount: number;
}

/** GET /stats/teams/:teamId 响应。 */
export interface StatsTeamDetailResponse {
  teamId: string;
  teamName: string;
  description: string | null;
  window: StatsWindow;
  totals: StatsTotals;
  buckets: StatsBucket[];
  avgCycleHours: number | null;
  cycleHoursP90: number | null;
  avgQueueWaitHours: number | null;
  queueWaitSource: string;
  firstPassRate: number;
  reviewRounds: number;
  reworkCount: number;
  artifactMix: StatsArtifactTypeSlice[];
  members: StatsMemberRow[];
  statusMix: Record<string, number>;
}

/** 查询参数（两个端点共用）。 */
export interface StatsQuery {
  /** 窗口天数 1..90（缺省 30；超上限服务端 400，不静默截断）。 */
  days?: number;
  granularity?: StatsGranularity;
  /** 窗口右端点（本地日历日 YYYY-MM-DD，缺省今天 Asia/Shanghai）。 */
  to?: string;
  /** 全局看板专用：逗号分隔团队 id（缺省全部）。 */
  teamIds?: string;
}

/**
 * 统计查询键（React Query）。
 *
 * 前缀 `["stats"]` 单独失效整个域；两个端点用不同二级键（`overview` / `team`），
 * 保证「刷新团队详情」不会误刷全局看板。
 */
export function statsOverviewQueryKey(query: StatsQuery): readonly unknown[] {
  return [
    "stats",
    "overview",
    query.days ?? 30,
    query.granularity ?? "day",
    query.to ?? "-",
    query.teamIds ?? "-",
  ] as const;
}

export function statsTeamQueryKey(teamId: string, query: StatsQuery): readonly unknown[] {
  return [
    "stats",
    "team",
    teamId,
    query.days ?? 30,
    query.granularity ?? "day",
    query.to ?? "-",
  ] as const;
}

export const statsApi = {
  /**
   * 全局跨团队统计看板（仅平台管理员）。
   *
   * 空团队 / 空窗口返回零值结构与完整桶序列（**不是 404**）：空数据是统计功能的正常初始状态。
   */
  overview(query: StatsQuery = {}): Promise<StatsOverviewResponse> {
    return api.get<StatsOverviewResponse>("/stats/overview", {
      query: {
        days: query.days,
        granularity: query.granularity,
        to: query.to,
        teamIds: query.teamIds,
      },
    });
  },

  /**
   * 单团队统计详情（团队成员可见）。
   *
   * 团队不存在 → 404 TEAM_NOT_FOUND；非成员且非管理员 → 403 PERMISSION_TEAM_NOT_MEMBER。
   */
  teamDetail(teamId: string, query: StatsQuery = {}): Promise<StatsTeamDetailResponse> {
    return api.get<StatsTeamDetailResponse>(`/stats/teams/${teamId}`, {
      query: {
        days: query.days,
        granularity: query.granularity,
        to: query.to,
      },
    });
  },
};
