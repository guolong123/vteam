/**
 * 协调度指标（批次 E · pm-coordination-hardening「协调度指标」）常量。
 *
 * 【为什么要有这批指标】
 * 用户报告「项目经理总是去直接干活」。改造前，平台**没有任何办法**看出一个团队是在
 * 协调还是在单干——「PM 只做传话人/流程协调，不亲自产出交付物」这条纪律只以
 * agent 自写的记忆散落在 4 个团队的 6 处（无法度量、无法执行）。
 * 指标把这条纪律变成**可测量**的东西：偏离（PM 亲做）从此是**看得见**的数字，
 * 而不是只能靠人读聊天记录去「感觉」。
 *
 * 【本地基线（tm_0000000001，7 成员 / 242 消息 / 7 产出物）】
 *   - PM 消息 106 / 全部 agent 消息 155 ⇒ **68%**（这正是用户注意到的那个数）
 *   - PM 产出物 **0**（目标恒 0：PM 产出交付物 = 越界）
 *   - PM 群聊 67 / 私聊 39（私聊多为「已在群聊回复：…」的转述 ⇒ 双报可见）
 *   - PM 定向派发 12 次 / PM 亲发结论 ≈ 94 条
 * 健康团队应显著低于 68%；本批只做**观测**，不做任何权限收窄（用户已明确决定）。
 */

/**
 * 统计窗口上限（小时）= 720h（30 天）。
 *
 * 定夺依据（为什么不放开到「全量」）：
 * - 指标回答的是「这个团队**最近**的协调姿态」，运营者复核的合理视野是「上个月」；
 *   更长的窗口需要跨月对比，应由调用方分片自查，而不是让一次请求扫全表。
 * - 三张事实表（messages / artifact_versions / message_receipts）都随时间线性增长，
 *   窗口不设上限 ⇒ 单请求扫描量无界 ⇒ 一次体检就能把库拖垮（本批硬约束：只读且有界）。
 * - 量级估算：线上基线 tm_0000000001 ≈ 77 条 agent 消息/天 ⇒ 上限窗口 ≈ 5.5 万行
 *   扫描，且全部聚合在 DB 侧完成（只回聚合行，不把原始行拉进 node 内存）。
 */
export const COORDINATION_METRICS_MAX_WINDOW_HOURS = 720;

/**
 * 缺省统计窗口（小时）= 168h（7 天）。
 *
 * 7 天覆盖一个完整工作周，足够看出「谁在说话」的稳定姿态；比 30 天上限更贴近
 * 「最近的协调习惯」，也让默认请求的扫描量最小。
 */
export const COORDINATION_METRICS_DEFAULT_WINDOW_HOURS = 168;

/**
 * 协调度指标域错误码（随异常响应的 code 字段返回）。
 *
 * 命名沿用仓库既有约定（大写 SNAKE）：
 * - TEAM_NOT_FOUND：团队不存在（404）——与 teams 模块既有码同名同义，复用不新增语义。
 * - WINDOW_INVALID：窗口参数非法（400）——超上限 / 非整数 / 右端点不可解析。
 */
export const COORDINATION_METRICS_ERRORS = {
  /** 团队不存在 → 404。 */
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  /** 窗口参数越界/不可解析 → 400（拒绝无界扫描，不静默截断）。 */
  WINDOW_INVALID: 'COORDINATION_METRICS_WINDOW_INVALID',
} as const;

export type CoordinationMetricsErrorCode =
  (typeof COORDINATION_METRICS_ERRORS)[keyof typeof COORDINATION_METRICS_ERRORS];
