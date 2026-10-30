/**
 * 统计看板响应契约（**字段名即契约**，前端类型逐字镜像本文件）。
 *
 * 三条跨层铁律（与设计文档 §2.0 一致，任何一处违反都会让数字不可对账）：
 * 1. **未知 ≠ 0**：凡「上游没上报」的量（目前只有 cost）一律用 `null`，
 *    绝不用 -1 或 0 作哨兵。前端据此渲染「—」而不是 $0.00。
 * 2. **累计 ≠ 区间求和**：本契约全部字段都是**窗口内**的量（不是历史累计）。
 * 3. **去重产出物 ≠ 版本数**：`artifacts` 与 `artifactVersions` 是两个独立字段，不可相加。
 */

/** 数值总量（窗口内）。 */
export interface StatsTotals {
  /** 窗口内新建任务数（tasks.created_at 落窗）。 */
  tasksCreated: number;
  /** 窗口内完成（验收通过）任务数（tasks.completed_at 落窗）。 */
  tasksCompleted: number;
  /** 窗口内进入阻塞的任务数（task_events to_status=blocked 落窗）。 */
  tasksBlocked: number;
  /** 窗口内被驳回的任务数（task_events to_status=in_progress 且 event_type=reject 落窗）。 */
  tasksRejected: number;
  /** 窗口内新增产出物**去重**个数（artifacts.created_at 落窗）。 */
  artifacts: number;
  /** 窗口内新增产出物**版本**数（artifact_versions.created_at 落窗）。 */
  artifactVersions: number;
  /** 六个 token 口径（与 model_usages 六列逐字对应）。 */
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * 总 token = 上述五元组之和（**推导字段**，不让调用方自己加）。
   *
   * ⚠️ 不读 `model_usages.total_tokens` 列：该列历史上全为 0（上游 step-finish 不提供
   * `total`，见 worker-dispatcher 的 parseUsageTokens 注释）。求和是唯一可靠口径。
   */
  totalTokens: number;
  /**
   * 窗口内费用合计（美元）。`null` = **窗口内没有任何一行带费用上报（未知）**，
   * 不等于 0（免费）。部分未知时返回已知部分之和，并由 `costUnknownRatio` 标注覆盖度。
   */
  cost: number | null;
  /** 窗口内 cost 未知的日行占比 0..1（0 = 全额已知，1 = 整窗未知）。 */
  costUnknownRatio: number;
  /** 窗口内 agent 发出消息数（messages sender_type=agent 落窗）。 */
  agentMessages: number;
  /** 窗口内有产出的成员数（去重 team_member_id）。 */
  activeMembers: number;
  /** 每完成任务成本 = cost / tasksCompleted；cost 未知或分母为 0 ⇒ null。 */
  costPerTask: number | null;
  /** 每去重产出物成本 = cost / artifacts；同上。 */
  costPerArtifact: number | null;
  /** 每千 token 成本 = cost / (totalTokens/1000)；同上。 */
  costPerKToken: number | null;
  /** 缓存命中率 = cacheRead / (input + cacheRead)，0..1。分母不含 cacheWrite（理由见设计文档 §2.6）。 */
  cacheHitRate: number;
  /** 完成率 = tasksCompleted / tasksCreated，0..1（分母 0 ⇒ 0）。 */
  completionRate: number;
}

/** 时间桶（趋势图/柱状图的一个刻度）。 */
export interface StatsBucket {
  /** 桶键：day=`2026-10-30`；week=周一日期；month=`2026-10`。 */
  key: string;
  /** 横轴短标签：day=`10-30`；week=`10/26`；month=`10 月`。 */
  label: string;
  /** 窗口内该桶的总量（与 StatsTotals 同形）。 */
  totals: StatsTotals;
}

/** 单团队的区间汇总（全局看板「团队对比表」一行）。 */
export interface StatsTeamRow {
  teamId: string;
  teamName: string;
  /** 团队描述（可为 null）。 */
  description: string | null;
  /** 团队成员数（当前，非窗口内均值）。 */
  memberCount: number;
  /** 窗口内该团队总量。 */
  totals: StatsTotals;
  /** 平均交付周期（小时）：completedAt - startedAt 的均值；无完成样本 ⇒ null。 */
  avgCycleHours: number | null;
  /** 平均排队等待（小时）。**近似口径**，见 `queueWaitSource`。 */
  avgQueueWaitHours: number | null;
  /** 排队口径来源（当前恒为 `created_to_started`，因为 team_queues 已随并行执行退役）。 */
  queueWaitSource: string;
}

/** 单个产出物类型构成。 */
export interface StatsArtifactTypeSlice {
  /** ARTIFACT_TYPES 三态：text / doc / file。 */
  type: string;
  /** 该类型在窗口内的去重产出物数。 */
  count: number;
  /** 占比 0..1（分母为该团队去重产出物总数）。 */
  share: number;
}

/** 单成员在窗口内的产出画像（团队详情「成员产能表」一行）。 */
export interface StatsMemberRow {
  teamMemberId: string;
  /** 成员实例显示名（team_members.alias，如「开发者-1」）。 */
  memberName: string;
  /** 所属 Agent 名。 */
  agentName: string;
  /** 岗位名（agent_roles.name；未绑岗位为 null）。 */
  roleName: string | null;
  /** 参与任务数：该成员在窗口内有会话的任务数（去重 task_id）。 */
  tasks: number;
  /** 该成员窗口内产出物数（artifact_versions.author_agent_id 归属）。 */
  artifacts: number;
  /** 六元组之和。 */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 窗口内该成员费用；`null` = 未知（与团队口径同源，不把未知拆成 0）。 */
  cost: number | null;
  /** 该成员窗口内 agent 消息数。 */
  messages: number;
}

/** 团队详情响应。 */
export interface StatsTeamDetailResponse {
  teamId: string;
  teamName: string;
  description: string | null;
  /** 口径回显（调用方据此确认窗口）。 */
  window: StatsWindow;
  /** 团队窗口总量。 */
  totals: StatsTotals;
  /** 时间桶序列（粒度由 query.granularity 决定）。 */
  buckets: StatsBucket[];
  /** 平均交付周期（小时）；无样本 ⇒ null。 */
  avgCycleHours: number | null;
  /** 交付周期 P90（小时）；无样本 ⇒ null。 */
  cycleHoursP90: number | null;
  /** 平均排队等待（小时）+ 口径来源（近似，见字段说明）。 */
  avgQueueWaitHours: number | null;
  queueWaitSource: string;
  /** 验收一次通过率 = (completed - rework) / completed，0..1。 */
  firstPassRate: number;
  /** 评审轮次数（task_events 中 round 类事件；当前无采集点 ⇒ 恒 0，见设计文档 §9）。 */
  reviewRounds: number;
  /** 返工数（被驳回后重新执行的任务数，当前口径 = tasksRejected）。 */
  reworkCount: number;
  /** 产出物类型构成（三态全覆盖，缺类型补 0）。 */
  artifactMix: StatsArtifactTypeSlice[];
  /** 成员产能表（按 totalTokens 降序）。 */
  members: StatsMemberRow[];
  /** 任务状态快照（当前盘子，**非窗口口径**）。 */
  statusMix: Record<string, number>;
}

/** 全局看板响应。 */
export interface StatsOverviewResponse {
  /** 口径回显。 */
  window: StatsWindow;
  /** 全部（选中）团队合计。 */
  totals: StatsTotals;
  /** 时间桶序列。 */
  buckets: StatsBucket[];
  /** 各团队汇总行（按 totalTokens 降序）。 */
  teams: StatsTeamRow[];
  /** 团队维度平均交付周期（行级加权后的团队均值）。 */
  avgCycleHours: number | null;
  /** 验收一次通过率（跨团队合计口径）。 */
  firstPassRate: number;
  /** 返工数。 */
  reworkCount: number;
}

/** 窗口口径回显（调用方据此确认「我查的到底是哪一段」）。 */
export interface StatsWindow {
  /** 窗口左端点（本地日历日，含）。 */
  from: string;
  /** 窗口右端点（本地日历日，含）。 */
  to: string;
  /** 窗口天数。 */
  days: number;
  /** 粒度。 */
  granularity: string;
  /** 时区（固定 Asia/Shanghai，回显便于前端标注）。 */
  timezone: string;
  /** 允许的最大天数（回显上限，便于前端提示）。 */
  maxDays: number;
}
