/**
 * 团队统计看板常量（stats-dashboard，对齐 docs/agent-platform/35-团队统计看板设计.md §3/§6）。
 *
 * 【为什么需要这个模块】
 * 现有统计能力只有 `GET /teams/:teamsId/usage` 的**纯累计**「成员 × 模型」token/cost，
 * 回答不了「这个团队最近一周/一月干了多少活、花了多少钱、快不快、返工多不多」。
 * 本模块补上**时间维度**（日/周/月）与**任务/产出物维度**，并把效率与质量指标一并给出。
 *
 * 【设计红线（与设计文档口径字典逐条对应）】
 * - **只读零写入**：本域不产生任何写操作，数据源是 tasks / artifacts / model_usages /
 *   messages / task_events 的既有行。没有任何定时任务、没有新表（预聚合表见设计文档 §7
 *   的 `stats_daily` 提案，属后续优化，本轮不落库）。
 * - **聚合在 DB 侧完成**：全部走 Prisma `groupBy` / `$queryRaw` 聚合，绝不把原始行拉进
 *   node 侧再累加（`model_usages` 行数 = 调用次数，比聚合行高若干数量级）。
 * - **窗口有界**：最长处 90 天（`STATS_MAX_WINDOW_DAYS`），超限 400，**不静默截断**
 *   （静默截断会让「我查了 90 天」与实际口径不一致，指标就废了）。
 */

/** 统计窗口天数上限：90 天（覆盖「近三个月」的运营视野，且把扫描量钉死）。 */
export const STATS_MAX_WINDOW_DAYS = 90;

/** 缺省窗口天数：30 天（一个完整月，够看出趋势且请求最轻）。 */
export const STATS_DEFAULT_WINDOW_DAYS = 30;

/**
 * 时间粒度：日 / 周 / 月。
 *
 * 粒度只影响**返回的时间桶切分**，不影响总量口径——同一窗口下 day/week/month 的
 * 各桶求和必须等于窗口总量（前端据此把指标卡与趋势图对账）。
 */
export const STATS_GRANULARITIES = ['day', 'week', 'month'] as const;
export type StatsGranularity = (typeof STATS_GRANULARITIES)[number];

/** 缺省粒度：日。 */
export const STATS_DEFAULT_GRANULARITY: StatsGranularity = 'day';

/**
 * 统计域错误码（随异常响应 code 字段返回，命名沿用仓库既有大写 SNAKE 约定）。
 */
export const STATS_ERRORS = {
  /** 团队不存在 → 404（与 teams 模块既有码同名同义，复用不新增语义）。 */
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  /** 窗口/粒度参数非法 → 400（拒绝无界扫描，不静默截断）。 */
  QUERY_INVALID: 'STATS_QUERY_INVALID',
} as const;

export type StatsErrorCode = (typeof STATS_ERRORS)[keyof typeof STATS_ERRORS];

/**
 * 统计窗口时区：固定 Asia/Shanghai。
 *
 * 为什么不在请求里开时区参数：跨时区的「日」边界会让同一个数字在不同调用方那里
 * 变成两个值（口径漂移是统计功能最致命的缺陷）。平台是内网单区域部署，
 * 固定一个时区、并在文档里写死，比「灵活但不可对账」更可靠。
 *
 * 实现说明：本模块用**固定 +08:00 偏移**做日切，而不是引入 tz 数据库
 * （中国自 1991 年起无夏令时，+08:00 恒定，偏移法与 tz 库在本场景完全等价，
 * 且省掉一个依赖）。
 */
export const STATS_TIMEZONE = 'Asia/Shanghai';

/** 时区偏移（毫秒）：+08:00。 */
export const STATS_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 缓存 TTL（毫秒）。
 *
 * 统计是**只读重查询**，同一运营者连续切粒度/区间会重复打同一窗口；
 * 60s 内的结果对运营决策无差异（数据写入是分钟级节奏），故允许短缓存。
 * 缓存实现放 service 内的进程内 Map（单实例部署；多实例时各自缓存，仍正确、只是命中率低）。
 */
export const STATS_CACHE_TTL_MS = 60_000;
