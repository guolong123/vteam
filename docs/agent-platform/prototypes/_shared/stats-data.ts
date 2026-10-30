/**
 * 统计看板 Mock 数据源（确定性，无 Math.random）
 * =====================================================================
 * 供 stats-dashboard（全局跨团队看板）与 team-stats（团队详情下钻页）两个原型共用，
 * 保证两页数字**同源、可对账**：同一区间、同一团队的指标在两页取值结果一致。
 *
 * 设计约束（重要，改数据前先读）：
 * 1. **确定性**：全部序列由固定种子的线性同余发生器（LCG）生成，任何机器、任何时刻
 *    跑出来的 90 天数据逐日一致 ⇒ 截图走查 / 文档里的示例数字不会自己漂移。
 * 2. **可聚合**：日粒度是唯一事实源，周 / 月粒度**必须**由 `bucketize()` 从日粒度聚合得出，
 *    严禁另写一套周/月假数据——否则切换粒度后顶部卡片与趋势图会对不上。
 * 3. **未知 ≠ 0**：`cost` 允许为 `null`（对应 `model_usages.cost` 的真实语义：
 *    NULL = 上游未上报「未知」，非 0 = 免费）。聚合时未知日**不参与求和**，
 *    但若整段窗口全部未知，聚合结果退回 `null`（UI 显示「—」而非 0）。
 * 4. **去重口径 vs 版本口径**：`artifacts` 是当日新增产出物**去重个数**，
 *    `artifactVersions` 是当日新增版本数（同一产出物改三版 = 1 个 artifact + 3 个 version）。
 *    两者不可相加，也不可在页面上互相替代。
 * 5. **权重聚合的平均值**：`cycleHours` / `queueHours` / `blockedHours` 在日行里是
 *    「当日完成任务的**平均值**」，聚合到周/月时按 `tasksCompleted` 加权，不能直接算术平均。
 */

import type { RoleKey } from "./styles";

/* ============================================================
 * 一、基础类型
 * ============================================================ */

/** 时间粒度（切换筛选时同时驱动聚合与横轴刻度）。 */
export type Granularity = "day" | "week" | "month";

/** 区间预设（与原型上的「近 7 天 / 近 30 天 / 近 90 天」一一对应）。 */
export type RangeKey = "7d" | "30d" | "90d";

/** 任务七态（对齐 `server/src/common/constants/task.constants.ts` 的 TASK_STATUS）。 */
export type TaskStatusKey =
  | "queued"
  | "pending"
  | "in_progress"
  | "blocked"
  | "pending_review"
  | "completed"
  | "archived";

/**
 * 单日 × 单团队指标行（**唯一事实源**）。
 * 命名刻意与后端表字段拉开：这里是「当日新增/当日平均」，后端 `tasks.status` 是「当前快照」。
 */
export interface DailyMetric {
  /** 日期 `YYYY-MM-DD`（Asia/Shanghai 本地日历日）。 */
  date: string;
  teamId: string;
  /** 当日新建任务数（对齐 tasks.created_at）。 */
  tasksCreated: number;
  /** 当日完成（验收通过）任务数（对齐 tasks.completed_at）。 */
  tasksCompleted: number;
  /** 当日新进入排队的任务数（对齐 team_queues.enqueued_at）。 */
  tasksQueued: number;
  /** 当日进入阻塞的任务数（对齐 tasks.status=blocked 的进入事件）。 */
  tasksBlocked: number;
  /** 当日被验收驳回（reject → 回到 in_progress）的任务数。 */
  tasksRejected: number;
  /** 当日新增产出物**去重**个数。 */
  artifacts: number;
  /** 当日新增产出物**版本**数（含同一产出物的多次修订）。 */
  artifactVersions: number;
  /** 六个 token 口径（与 ModelUsage 的六个计数逐字对应）。 */
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 当日费用（美元）。`null` = 上游未上报（未知），**不是 0（免费）**。 */
  cost: number | null;
  /** 当日 agent 发出消息数（对齐 messages sender_type=agent）。 */
  agentMessages: number;
  /** 当日评审轮次数（派发→评审闭环的轮次）。 */
  reviewRounds: number;
  /** 当日返工数（验收驳回后重新执行的任务数）。 */
  reworkCount: number;
  /** 当日完成任务的平均交付周期（小时，startedAt → completedAt）。 */
  cycleHours: number;
  /** 当日完成任务交付周期 P90（小时）。 */
  cycleHoursP90: number;
  /** 当日完成任务的平均排队等待（小时，enqueuedAt → startedAt）。 */
  queueHours: number;
  /** 当日被阻塞任务的平均阻塞时长（小时）。 */
  blockedHours: number;
  /** 当日有产出的成员数（活跃成员）。 */
  activeMembers: number;
}

/** 聚合后的总量（区间 / 桶 / 团队 三级都用这一个结构，避免各处各写一套加法）。 */
export interface Totals {
  days: number;
  tasksCreated: number;
  tasksCompleted: number;
  tasksQueued: number;
  tasksBlocked: number;
  tasksRejected: number;
  artifacts: number;
  artifactVersions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 已知（非 null）费用之和；整段窗口全部未知时为 `null`。 */
  cost: number | null;
  /** 窗口内 cost 未知的天数占比 0..1（用于 UI 脚注「覆盖 xx% 天」）。 */
  costUnknownRatio: number;
  agentMessages: number;
  reviewRounds: number;
  reworkCount: number;
  /** 加权平均交付周期（按 tasksCompleted 加权）。 */
  avgCycleHours: number;
  /** 交付周期 P90（取窗口内日行最大值，保守口径）。 */
  cycleHoursP90: number;
  /** 加权平均排队等待。 */
  avgQueueHours: number;
  /** 加权平均阻塞时长。 */
  avgBlockedHours: number;
  /** 窗口内活跃成员数的日均值。 */
  avgActiveMembers: number;
  /** 命中率 = cacheRead / (input + cacheRead)；分母不含 cacheWrite（见设计文档口径章节）。 */
  cacheHitRate: number;
  /** 完成率 = tasksCompleted / tasksCreated（分母为 0 时返回 0）。 */
  completionRate: number;
  /** 验收一次通过率 = (completed - rework) / completed。 */
  firstPassRate: number;
  /** 每完成任务成本（cost 未知时为 null）。 */
  costPerTask: number | null;
  /** 每产出物成本（cost 未知或产出物为 0 时为 null）。 */
  costPerArtifact: number | null;
  /** 每千 token 成本（cost 未知时为 null）。 */
  costPerKToken: number | null;
}

/** 聚合桶（趋势图 / 柱状图的一个刻度）。 */
export interface Bucket {
  /** 桶键：日 = `2026-10-30`；周 = 周一日期；月 = `2026-10`。 */
  key: string;
  /** 横轴展示短标签：日 = `10-30`；周 = `10/26`；月 = `10 月`。 */
  label: string;
  /** 完整口径描述（tooltip / 标题用）。 */
  fullLabel: string;
  from: string;
  to: string;
  totals: Totals;
}

/** 团队成员（别名口径对齐 `team_members.alias`，如「开发者-1」）。 */
export interface MockMember {
  id: string;
  /** 成员别名（team_members.alias）。 */
  alias: string;
  /** 角色键（对应 _shared/styles.ts 的 RoleKey 四角色）。 */
  role: RoleKey;
}

/** 成员 × 日 指标行（用于成员产能表的区间筛选 / 时间趋势）。 */
export interface MemberDaily {
  date: string;
  teamId: string;
  memberId: string;
  /** 参与任务数（当日该成员经手的任务数）。 */
  tasks: number;
  artifacts: number;
  inputTokens: number;
  outputTokens: number;
  /** 推理 token（必须在此保留：成员合计要能和团队六元组求和逐位对上）。 */
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number | null;
  messages: number;
}

/** 成员区间汇总（成员产能表一行）。 */
export interface MemberSummary {
  memberId: string;
  alias: string;
  role: RoleKey;
  tasks: number;
  artifacts: number;
  totalTokens: number;
  cost: number | null;
  messages: number;
  /** 最近活跃日（窗口内最后一天有产出的日期；无产出为 null）。 */
  lastActive: string | null;
  /** 活跃率 = 有产出的天数 / 窗口天数。 */
  activeRate: number;
}

/** 团队静态档案 + 特征参数（决定该团队序列的「气质」，改这里即可调 mock 观感）。 */
export interface MockTeam {
  id: string;
  name: string;
  description: string;
  /** 团队头像用的首字缩写。 */
  initials: string;
  /** 成员（同一角色可多实例，如「开发者-1」「开发者-2」）。 */
  members: MockMember[];
  /** 当前进行中任务标题（概览条展示）。 */
  currentTask: string;
  /** 队列长度（概览条展示）。 */
  queueLength: number;
}

/* ============================================================
 * 二、确定性工具（LCG / 日期 / 整数分配）
 * ============================================================ */

const DAY_MS = 86_400_000;
/** 数据窗口总天数（90 天；区间筛选最多取这么多）。 */
export const TOTAL_DAYS = 90;
/** 数据窗口最后一天（固定值 ⇒ 序列稳定；与文档/截图保持对账一致）。 */
export const END_DATE = "2026-10-30";

/** 线性同余伪随机（确定性：同种子同序列，跨机器一致）。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 由「距离最后一天的天数偏移」换算日历日（UTC 取日，避免本地时区跨日误差）。 */
function dateAt(offsetFromEnd: number): string {
  const endUtc = Date.UTC(2026, 9, 30); // 2026-10-30
  const d = new Date(endUtc - offsetFromEnd * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=周日
}

/** ISO 周一（周粒度桶键：向前回退到最近的周一）。 */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const delta = (d.getUTCDay() + 6) % 7;
  return isoDate(d.getTime() - delta * DAY_MS);
}

function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * 把总量按权重切成**整数**且**和恰好等于总量**（最大余数法）。
 * 有无这一步决定了「成员汇总之和 == 团队汇总」这条自洽性是否成立——不能省。
 */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map((v) => Math.floor(v));
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (let k = 0; k < order.length && rest > 0; k++) {
    out[order[k].i] += 1;
    rest -= 1;
  }
  return out;
}

/* ============================================================
 * 三、团队档案与特征参数
 * ============================================================ */

/** 团队静态档案（4 个团队，覆盖「健康高产 / 中等 / 低活跃 / 新建且成本未上报」四种画像）。 */
export const TEAMS: MockTeam[] = [
  {
    id: "tm_main",
    name: "vteam 开发团队",
    description: "平台主线迭代：需求拆解 → 架构设计 → 编码 → 测试验收全链路。",
    initials: "V",
    currentTask: "统计看板与用量对账",
    queueLength: 2,
    members: [
      { id: "mm_pm", alias: "产品-1", role: "product" },
      { id: "mm_arch", alias: "架构-1", role: "architect" },
      { id: "mm_dev1", alias: "开发者-1", role: "developer" },
      { id: "mm_dev2", alias: "开发者-2", role: "developer" },
      { id: "mm_qa", alias: "测试-1", role: "tester" },
    ],
  },
  {
    id: "tm_collect",
    name: "数据采集平台",
    description: "采集任务编排与数据上报校验，偏架构与开发型团队。",
    initials: "采",
    currentTask: "采集模板校验器",
    queueLength: 1,
    members: [
      { id: "cm_arch", alias: "架构-1", role: "architect" },
      { id: "cm_dev1", alias: "开发者-1", role: "developer" },
      { id: "cm_dev2", alias: "开发者-2", role: "developer" },
      { id: "cm_qa", alias: "测试-1", role: "tester" },
    ],
  },
  {
    id: "tm_alert",
    name: "告警中心",
    description: "告警规则编排与通知触达，产品与测试驱动、任务颗粒度偏小。",
    initials: "告",
    currentTask: "通知去重与静默策略",
    queueLength: 0,
    members: [
      { id: "am_pm", alias: "产品-1", role: "product" },
      { id: "am_qa", alias: "测试-1", role: "tester" },
      { id: "am_dev", alias: "开发者-1", role: "developer" },
    ],
  },
  {
    id: "tm_report",
    name: "报表中台",
    description: "新建团队（第 46 天起有产出），费用尚未由上游上报 ⇒ cost 全为「未知」。",
    initials: "报",
    currentTask: "指标口径对齐",
    queueLength: 3,
    members: [
      { id: "rm_pm", alias: "产品-1", role: "product" },
      { id: "rm_arch", alias: "架构-1", role: "architect" },
      { id: "rm_dev", alias: "开发者-1", role: "developer" },
    ],
  },
];

/** 通过 id 取团队档案；找不到时回退第一个（原型内不做异常分支）。 */
export function getTeam(teamId: string): MockTeam {
  return TEAMS.find((t) => t.id === teamId) ?? TEAMS[0];
}

/** 每个团队的特征参数（决定日序列的量纲与形状）。 */
interface Profile {
  seed: number;
  /** 基线日新建任务数。 */
  baseTasks: number;
  /** 完成率基线（当日完成 / 当日新建，含跨日滞后造成的偏差）。 */
  completionRate: number;
  /** 每完成 1 任务的新增产出物数。 */
  artifactsPerTask: number;
  /** 每任务 token 量（六元组总和）。 */
  tokensPerTask: number;
  /** token 六元组占比（合计 = 1）。 */
  tokenShares: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** 每百万 token 单价（美元）；决定 cost 量纲。 */
  costPerMToken: number;
  /** 第几天起 cost 变为「已知」（0 = 全窗口已知）；`null` = 全窗口未知。 */
  costKnownFromDay: number | null;
  /** 基线日 agent 消息数。 */
  baseMessages: number;
  /** 每任务评审轮次。 */
  reviewRoundsPerTask: number;
  /** 每任务返工数。 */
  reworkPerTask: number;
  baseCycleHours: number;
  baseQueueHours: number;
  baseBlockedHours: number;
  /** 产出物类型构成（text / doc / file，合计 = 1）。 */
  artifactTypeShares: { text: number; doc: number; file: number };
  /** 该团队序列的启动日（0 = 从窗口第一天就有数据；46 = 新建团队）。 */
  startDay: number;
}

const PROFILES: Record<string, Profile> = {
  tm_main: {
    seed: 0x51a1,
    baseTasks: 3.1,
    completionRate: 0.78,
    artifactsPerTask: 1.6,
    tokensPerTask: 148_000,
    tokenShares: { input: 0.46, output: 0.19, reasoning: 0.06, cacheRead: 0.22, cacheWrite: 0.07 },
    costPerMToken: 2.4,
    costKnownFromDay: 0,
    baseMessages: 46,
    reviewRoundsPerTask: 1.3,
    reworkPerTask: 0.22,
    baseCycleHours: 31,
    baseQueueHours: 6.5,
    baseBlockedHours: 9,
    artifactTypeShares: { text: 0.52, doc: 0.34, file: 0.14 },
    startDay: 0,
  },
  tm_collect: {
    seed: 0x0c0e,
    baseTasks: 1.9,
    completionRate: 0.71,
    artifactsPerTask: 1.35,
    tokensPerTask: 132_000,
    tokenShares: { input: 0.5, output: 0.17, reasoning: 0.05, cacheRead: 0.21, cacheWrite: 0.07 },
    costPerMToken: 2.1,
    costKnownFromDay: 0,
    baseMessages: 27,
    reviewRoundsPerTask: 1.6,
    reworkPerTask: 0.31,
    baseCycleHours: 46,
    baseQueueHours: 14,
    baseBlockedHours: 15,
    artifactTypeShares: { text: 0.44, doc: 0.36, file: 0.2 },
    startDay: 0,
  },
  tm_alert: {
    seed: 0xa1e7,
    baseTasks: 1.35,
    completionRate: 0.82,
    artifactsPerTask: 1.15,
    tokensPerTask: 96_000,
    tokenShares: { input: 0.42, output: 0.2, reasoning: 0.04, cacheRead: 0.27, cacheWrite: 0.07 },
    costPerMToken: 1.8,
    costKnownFromDay: 30, // 前 60 天成本未知（演示「部分窗口成本未知」）
    baseMessages: 19,
    reviewRoundsPerTask: 1.1,
    reworkPerTask: 0.14,
    baseCycleHours: 22,
    baseQueueHours: 4,
    baseBlockedHours: 6,
    artifactTypeShares: { text: 0.48, doc: 0.3, file: 0.22 },
    startDay: 0,
  },
  tm_report: {
    seed: 0x7e90,
    baseTasks: 1.6,
    completionRate: 0.63,
    artifactsPerTask: 1.5,
    tokensPerTask: 158_000,
    tokenShares: { input: 0.55, output: 0.16, reasoning: 0.06, cacheRead: 0.16, cacheWrite: 0.07 },
    costPerMToken: 3.1,
    costKnownFromDay: null, // 全窗口未知 ⇒ UI 必须显示「—」，而不是 $0.00
    baseMessages: 22,
    reviewRoundsPerTask: 1.9,
    reworkPerTask: 0.42,
    baseCycleHours: 58,
    baseQueueHours: 19,
    baseBlockedHours: 21,
    artifactTypeShares: { text: 0.4, doc: 0.4, file: 0.2 },
    startDay: 46,
  },
};

/* ============================================================
 * 四、日序列生成（唯一事实源）
 * ============================================================ */

/** 工作日强度因子：周末几乎停产（制造出「空态日」与热力图的自然空隙）。 */
function weekdayFactor(wd: number): number {
  if (wd === 0) return 0.12; // 周日
  if (wd === 6) return 0.34; // 周六
  if (wd === 5) return 0.86; // 周五
  return 1; // 周一~四
}

function buildDaily(team: MockTeam, p: Profile): DailyMetric[] {
  const rand = lcg(p.seed);
  const rows: DailyMetric[] = [];
  /**
   * 小数累加器（跨日累计）。
   * 为什么需要它：日粒度下完成任务只有 1~4 个，`reworkPerTask=0.14` 逐日四舍五入会**恒为 0**，
   * 「一次通过率」就永远是 100%——指标失去观测意义。累加器把「预期 0.14 个驳回/任务」
   * 摊平到多天后再取整：3 天攒够 1 个就落 1 个，长期均值仍等于画像设定值。
   * 这是 mock 数据的必要精度处理，真实实现直接按 task_events 计数即可，无此问题。
   */
  let rejectAcc = 0;
  let reworkAcc = 0;
  let blockAcc = 0;
  for (let i = 0; i < TOTAL_DAYS; i++) {
    const date = dateAt(TOTAL_DAYS - 1 - i);
    const wd = weekdayOf(date);
    const active = i >= p.startDay;
    // 趋势：窗口内缓慢爬升（新建团队爬升更陡）
    const trend = p.startDay > 0 ? 0.5 + 1.1 * ((i - p.startDay) / Math.max(1, TOTAL_DAYS - p.startDay)) : 0.88 + 0.26 * (i / (TOTAL_DAYS - 1));
    const wf = weekdayFactor(wd);
    const noise = 0.68 + 0.64 * rand();
    // 每 ~12 天制造一个零任务日（空态与热力图浅色格子的来源）
    const rareZero = rand() < 0.07;

    const tasksCreated = active && !rareZero ? Math.max(0, Math.round(p.baseTasks * wf * trend * noise)) : 0;
    const completedNoise = 0.78 + 0.44 * rand();
    const tasksCompleted = Math.max(0, Math.round(tasksCreated * p.completionRate * completedNoise));
    const tasksQueued = Math.round(tasksCreated * (0.3 + 0.28 * rand()));
    // 阻塞数也用累加器：小团队日粒度 1~2 个任务时，0.06~0.18 的比例四舍五入会恒为 0，
    // 于是「平均阻塞时长」长期显示 0.0h —— 那不是「从不阻塞」，而是算不出来。
    blockAcc += tasksCreated * (0.06 + 0.12 * rand());
    const tasksBlocked = Math.floor(blockAcc);
    blockAcc -= tasksBlocked;
    // 验收驳回：按「完成任务数 × 画像驳回率」进入累加器，攒够整数再落账（理由见循环前的注释）。
    const rejectRate = p.reworkPerTask * (0.7 + 0.6 * rand());
    rejectAcc += tasksCompleted * rejectRate;
    const tasksRejected = Math.min(tasksCompleted, Math.floor(rejectAcc));
    rejectAcc -= tasksRejected;

    const artifacts = Math.max(0, Math.round(tasksCompleted * p.artifactsPerTask * (0.75 + 0.5 * rand())));
    const artifactVersions = Math.round(artifacts * (1.35 + 0.9 * rand()));

    const tokenTotal = Math.round(
      (tasksCreated * p.tokensPerTask + tasksCompleted * p.tokensPerTask * 0.25) * (0.82 + 0.36 * rand()),
    );
    const tokenSplit = allocate(
      tokenTotal,
      [
        p.tokenShares.input,
        p.tokenShares.output,
        p.tokenShares.reasoning,
        p.tokenShares.cacheRead,
        p.tokenShares.cacheWrite,
      ],
    );
    const [inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens] = tokenSplit;

    const costKnown = p.costKnownFromDay === null ? false : i >= p.costKnownFromDay;
    const cost = costKnown
      ? Math.round((tokenTotal / 1_000_000) * p.costPerMToken * 100) / 100
      : null;

    const agentMessages = Math.max(
      0,
      Math.round(p.baseMessages * wf * trend * (0.7 + 0.6 * rand())),
    );
    const reviewRounds = Math.max(0, Math.round(tasksCreated * p.reviewRoundsPerTask * (0.8 + 0.4 * rand())));
    // 返工数 = 被驳回后重新执行的任务数（去重到「任务」粒度，不重复计同一任务的多轮驳回）。
    // 口径必须 ≤ 完成任务数，否则一次通过率会变负——累加器 + Math.min 双重夹紧。
    reworkAcc += tasksRejected * (0.55 + 0.5 * rand());
    const reworkCount = Math.min(tasksCompleted, Math.max(0, Math.floor(reworkAcc)));
    reworkAcc -= reworkCount;

    const cycleAvg = Math.round(p.baseCycleHours * (0.78 + 0.5 * rand()) * 10) / 10;
    const cycleP90 = Math.round(cycleAvg * (1.5 + 0.6 * rand()) * 10) / 10;
    const queueHours = Math.round(p.baseQueueHours * (0.6 + 0.85 * rand()) * 10) / 10;
    const blockedHours = Math.round(p.baseBlockedHours * (0.55 + 0.9 * rand()) * 10) / 10;

    const memberCount = team.members.length;
    const activeMembers = active
      ? Math.min(memberCount, Math.max(0, Math.round(memberCount * (0.5 + 0.5 * rand()) * (tasksCreated > 0 ? 1 : 0))))
      : 0;

    rows.push({
      date,
      teamId: team.id,
      tasksCreated,
      tasksCompleted,
      tasksQueued,
      tasksBlocked,
      tasksRejected,
      artifacts,
      artifactVersions,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
      agentMessages,
      reviewRounds,
      reworkCount,
      cycleHours: tasksCompleted > 0 ? cycleAvg : 0,
      cycleHoursP90: tasksCompleted > 0 ? cycleP90 : 0,
      queueHours: tasksCompleted > 0 ? queueHours : 0,
      blockedHours: tasksBlocked > 0 ? blockedHours : 0,
      activeMembers,
    });
  }
  return rows;
}

/** 逐团队日序列（模块加载时一次性生成并缓存 ⇒ 每次 import 都是同一份数据）。 */
const DAILY: Map<string, DailyMetric[]> = new Map(
  TEAMS.map((team) => {
    const profile = PROFILES[team.id] ?? PROFILES.tm_main;
    return [team.id, buildDaily(team, profile)] as const;
  }),
);

/** 取某团队完整 90 天日序列（升序，最后一天 = END_DATE）。 */
export function dailyOf(teamId: string): DailyMetric[] {
  return DAILY.get(teamId) ?? DAILY.get(TEAMS[0].id) ?? [];
}

/** 某天在 90 天序列中的下标（供热力图按列取数）。 */
export function dayIndex(date: string): number {
  const first = dateAt(TOTAL_DAYS - 1);
  const diff = Math.round(
    (new Date(`${date}T00:00:00Z`).getTime() - new Date(`${first}T00:00:00Z`).getTime()) / DAY_MS,
  );
  return diff;
}

/* ============================================================
 * 五、聚合（日 → 桶 / 区间 / 团队）
 * ============================================================ */

function emptyTotals(): Totals {
  return {
    days: 0,
    tasksCreated: 0,
    tasksCompleted: 0,
    tasksQueued: 0,
    tasksBlocked: 0,
    tasksRejected: 0,
    artifacts: 0,
    artifactVersions: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: null,
    costUnknownRatio: 0,
    agentMessages: 0,
    reviewRounds: 0,
    reworkCount: 0,
    avgCycleHours: 0,
    cycleHoursP90: 0,
    avgQueueHours: 0,
    avgBlockedHours: 0,
    avgActiveMembers: 0,
    cacheHitRate: 0,
    completionRate: 0,
    firstPassRate: 0,
    costPerTask: null,
    costPerArtifact: null,
    costPerKToken: null,
  };
}

/** 区间 / 桶聚合：计数器求和、比率重算、加权平均按 tasksCompleted 加权。 */
export function aggregate(rows: DailyMetric[]): Totals {
  if (rows.length === 0) return emptyTotals();
  const t = emptyTotals();
  t.days = rows.length;
  let knownCost = 0;
  let knownCostDays = 0;
  let cycleWeighted = 0;
  let queueWeighted = 0;
  let blockedWeighted = 0;
  let p90 = 0;

  for (const r of rows) {
    t.tasksCreated += r.tasksCreated;
    t.tasksCompleted += r.tasksCompleted;
    t.tasksQueued += r.tasksQueued;
    t.tasksBlocked += r.tasksBlocked;
    t.tasksRejected += r.tasksRejected;
    t.artifacts += r.artifacts;
    t.artifactVersions += r.artifactVersions;
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.reasoningTokens += r.reasoningTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.cacheWriteTokens += r.cacheWriteTokens;
    if (r.cost !== null) {
      knownCost += r.cost;
      knownCostDays += 1;
    }
    t.agentMessages += r.agentMessages;
    t.reviewRounds += r.reviewRounds;
    t.reworkCount += r.reworkCount;
    cycleWeighted += r.cycleHours * r.tasksCompleted;
    queueWeighted += r.queueHours * r.tasksCompleted;
    blockedWeighted += r.blockedHours * r.tasksBlocked;
    p90 = Math.max(p90, r.cycleHoursP90);
    t.avgActiveMembers += r.activeMembers;
  }

  // cost：未知不是 0 —— 全部未知 ⇒ null；部分未知 ⇒ 已知部分求和（配 costUnknownRatio 告警）
  t.cost = knownCostDays === 0 ? null : Math.round(knownCost * 100) / 100;
  t.costUnknownRatio = 1 - knownCostDays / rows.length;

  t.avgCycleHours = t.tasksCompleted > 0 ? Math.round((cycleWeighted / t.tasksCompleted) * 10) / 10 : 0;
  t.avgQueueHours = t.tasksCompleted > 0 ? Math.round((queueWeighted / t.tasksCompleted) * 10) / 10 : 0;
  t.avgBlockedHours = t.tasksBlocked > 0 ? Math.round((blockedWeighted / t.tasksBlocked) * 10) / 10 : 0;
  t.cycleHoursP90 = Math.round(p90 * 10) / 10;
  t.avgActiveMembers = Math.round((t.avgActiveMembers / rows.length) * 10) / 10;

  const totalTokens = t.inputTokens + t.outputTokens + t.reasoningTokens + t.cacheReadTokens + t.cacheWriteTokens;
  t.cacheHitRate = t.inputTokens + t.cacheReadTokens > 0 ? t.cacheReadTokens / (t.inputTokens + t.cacheReadTokens) : 0;
  t.completionRate = t.tasksCreated > 0 ? Math.min(1, t.tasksCompleted / t.tasksCreated) : 0;
  t.firstPassRate = t.tasksCompleted > 0 ? Math.max(0, (t.tasksCompleted - t.reworkCount) / t.tasksCompleted) : 0;

  if (t.cost !== null) {
    t.costPerTask = t.tasksCompleted > 0 ? Math.round((t.cost / t.tasksCompleted) * 100) / 100 : null;
    t.costPerArtifact = t.artifacts > 0 ? Math.round((t.cost / t.artifacts) * 100) / 100 : null;
    t.costPerKToken = totalTokens > 0 ? Math.round((t.cost / (totalTokens / 1000)) * 1000) / 1000 : null;
  }
  return t;
}

/** 区间 → 天数。 */
export function rangeDays(range: RangeKey): number {
  return range === "7d" ? 7 : range === "30d" ? 30 : 90;
}

/** 取某团队「近 N 天」日序列（含 END_DATE 当天，长度 = min(N, 90)）。 */
export function windowOf(teamId: string, range: RangeKey): DailyMetric[] {
  return dailyOf(teamId).slice(-rangeDays(range));
}

/** 全团队同区间日序列合并（跨团队聚合的输入）。 */
export function windowAllTeams(range: RangeKey): DailyMetric[] {
  return TEAMS.flatMap((t) => windowOf(t.id, range));
}

/** 按团队聚合（全局看板「团队对比表」一行）。 */
export interface TeamRollup {
  team: MockTeam;
  totals: Totals;
}

export function teamRollups(range: RangeKey): TeamRollup[] {
  return TEAMS.map((team) => ({ team, totals: aggregate(windowOf(team.id, range)) }));
}

/** 周 / 月桶键与展示标签。 */
function bucketOf(date: string, g: Granularity): { key: string; label: string; full: string; from: string; to: string } {
  if (g === "day") {
    const [, m, d] = date.split("-");
    return { key: date, label: `${m}-${d}`, full: date, from: date, to: date };
  }
  if (g === "week") {
    const from = mondayOf(date);
    const toDate = isoDate(new Date(`${from}T00:00:00Z`).getTime() + 6 * DAY_MS);
    const [, m, d] = from.split("-");
    return { key: from, label: `${m}/${d}`, full: `${from} ~ ${toDate}（周一始）`, from, to: toDate };
  }
  const month = date.slice(0, 7);
  const [y, m] = month.split("-");
  return {
    key: month,
    label: `${Number(m)} 月`,
    full: `${y}-${m}`,
    from: `${month}-01`,
    to: `${month}-31`,
  };
}

/** 日序列 → 粒度桶（趋势图 / 柱状图的横轴）。 */
export function bucketize(rows: DailyMetric[], g: Granularity): Bucket[] {
  const map = new Map<string, { meta: ReturnType<typeof bucketOf>; rows: DailyMetric[] }>();
  for (const row of rows) {
    const meta = bucketOf(row.date, g);
    const hit = map.get(meta.key);
    if (hit) hit.rows.push(row);
    else map.set(meta.key, { meta, rows: [row] });
  }
  return [...map.values()]
    .sort((a, b) => (a.meta.key < b.meta.key ? -1 : 1))
    .map(({ meta, rows: bucketRows }) => ({
      key: meta.key,
      label: meta.label,
      fullLabel: meta.full,
      from: meta.from,
      to: meta.to,
      totals: aggregate(bucketRows),
    }));
}

/** 环比：当前区间 vs 等长上一区间（上一区间不足时返回 null）。 */
export function compareToPrevious(
  teamId: string | "all",
  range: RangeKey,
): { current: Totals; previous: Totals | null } {
  const days = rangeDays(range);
  const series = teamId === "all" ? windowAllTeams("90d") : dailyOf(teamId);
  const current = series.slice(-days);
  const prevStart = series.length - days * 2;
  const previous = prevStart >= 0 ? series.slice(prevStart, series.length - days) : null;
  return {
    current: aggregate(current),
    previous: previous && previous.length === days ? aggregate(previous) : null,
  };
}

/** 环比变化率（previous 为 0 / 缺失时返回 null ⇒ UI 显示「—」）。 */
export function deltaRate(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return (current - previous) / previous;
}

/* ============================================================
 * 六、成员维度
 * ============================================================ */

/** 成员权重（按角色给的产能系数 ⇒ 产品/架构产出少、开发多，符合真实团队形态）。 */
const ROLE_WEIGHT: Record<RoleKey, number> = {
  product: 0.16,
  architect: 0.24,
  developer: 0.52,
  tester: 0.3,
};

/**
 * 角色出勤率（当日是否有产出的概率）。
 * 开发/测试盯得紧、产品与架构更多在评审和设计上花时间 ⇒ 出勤率略低。
 * 数值无外部依据，只用于让「活跃率 / 最近活跃」这两个指标看起来是活的（不再是 100%）。
 */
const ROLE_ATTENDANCE: Record<RoleKey, number> = {
  product: 0.55,
  architect: 0.6,
  developer: 0.78,
  tester: 0.68,
};

const MEMBER_DAILY: Map<string, MemberDaily[]> = new Map(
  TEAMS.map((team) => {
    const rows = dailyOf(team.id);
    const weights = team.members.map((m) => ROLE_WEIGHT[m.role]);
    const rand = lcg(0x6d3b + rows.length);
    const out: MemberDaily[] = [];
    for (const row of rows) {
      // 「当天是否在场」：每个成员按角色出勤率抽一次，不在场 ⇒ 当日权重归 0。
      // 没有这一步，allocate() 会把每天的任务/消息都摊给每个成员，
      // 结果「活跃率」恒等于 100%、成员之间只剩产能差异 —— 看起来像假数据。
      const attendance = team.members.map((m) => {
        const rate = ROLE_ATTENDANCE[m.role];
        return rand() < rate ? 1 : 0;
      });
      // 全员都不在场（小团队 + 低出勤率时会撞上）⇒ 至少留权重最高的一人在场，
      // 否则当天已有的团队级活动会被分摊成 0，破坏「成员求和 == 团队汇总」的自洽性。
      if (attendance.every((a) => a === 0)) {
        let best = 0;
        for (let i = 1; i < weights.length; i++) if (weights[i] > weights[best]) best = i;
        attendance[best] = 1;
      }
      const jitter = team.members.map(() => 0.8 + 0.4 * rand());
      const w = weights.map((x, i) => x * jitter[i] * attendance[i]);
      const taskShares = allocate(row.tasksCreated, w);
      const artifactShares = allocate(row.artifacts, w);
      const messageShares = allocate(row.agentMessages, w);
      const tokenShares = allocate(row.inputTokens, w);
      const reasoningShares = allocate(row.reasoningTokens, w);
      const outputShares = allocate(row.outputTokens, w);
      const cacheReadShares = allocate(row.cacheReadTokens, w);
      const cacheWriteShares = allocate(row.cacheWriteTokens, w);
      team.members.forEach((m, i) => {
        out.push({
          date: row.date,
          teamId: team.id,
          memberId: m.id,
          tasks: taskShares[i],
          artifacts: artifactShares[i],
          inputTokens: tokenShares[i],
          outputTokens: outputShares[i],
          reasoningTokens: reasoningShares[i],
          cacheReadTokens: cacheReadShares[i],
          cacheWriteTokens: cacheWriteShares[i],
          // cost 未知时成员侧同样未知（不拆解散步 → 不伪造「某成员免费」）
          cost: row.cost === null ? null : Math.round((row.cost * (w[i] / w.reduce((a, b) => a + b, 0))) * 100) / 100,
          messages: messageShares[i],
        });
      });
    }
    return [team.id, out] as const;
  }),
);

/** 某团队某区间的成员汇总（成员产能表）。 */
export function memberSummaries(teamId: string, range: RangeKey): MemberSummary[] {
  const team = getTeam(teamId);
  const days = rangeDays(range);
  const windowDates = new Set(dailyOf(teamId).slice(-days).map((d) => d.date));
  const rows = (MEMBER_DAILY.get(teamId) ?? []).filter((r) => windowDates.has(r.date));
  const byMember = new Map<string, MemberDaily[]>();
  for (const r of rows) {
    const list = byMember.get(r.memberId);
    if (list) list.push(r);
    else byMember.set(r.memberId, [r]);
  }
  const summaries: MemberSummary[] = team.members.map((m) => {
    const list = byMember.get(m.id) ?? [];
    let knownCost = 0;
    let knownCostDays = 0;
    const acc = list.reduce(
      (acc, r) => {
        if (r.cost !== null) {
          knownCost += r.cost;
          knownCostDays += 1;
        }
        acc.tasks += r.tasks;
        acc.artifacts += r.artifacts;
        acc.tokens +=
          r.inputTokens + r.outputTokens + r.reasoningTokens + r.cacheReadTokens + r.cacheWriteTokens;
        acc.messages += r.messages;
        if (r.tasks > 0 || r.artifacts > 0 || r.messages > 0) acc.activeDays += 1;
        return acc;
      },
      { tasks: 0, artifacts: 0, tokens: 0, messages: 0, activeDays: 0 },
    );
    return {
      memberId: m.id,
      alias: m.alias,
      role: m.role,
      tasks: acc.tasks,
      artifacts: acc.artifacts,
      totalTokens: acc.tokens,
      cost: knownCostDays === 0 ? null : Math.round(knownCost * 100) / 100,
      messages: acc.messages,
      lastActive: acc.activeDays > 0 ? list.filter((r) => r.tasks > 0 || r.artifacts > 0 || r.messages > 0).at(-1)?.date ?? null : null,
      activeRate: days > 0 ? Math.min(1, acc.activeDays / days) : 0,
    };
  });
  return summaries.sort((a, b) => b.totalTokens - a.totalTokens);
}

/* ============================================================
 * 七、任务生命周期漏斗 / 产出物构成 / 健康度
 * ============================================================ */

export interface FunnelStage {
  status: TaskStatusKey;
  label: string;
  value: number;
  /** 相对首阶段的留存率 0..1。 */
  retention: number;
}

/**
 * 任务生命周期漏斗（**mock 口径**：由区间新建/完成数按该团队的历史留存比例推导，
 * 真实实现应直接按 `task_events` 的 to_status 去重计数，见设计文档 §2/§6）。
 */
export function funnelOf(teamId: string, range: RangeKey): FunnelStage[] {
  const totals = aggregate(windowOf(teamId, range));
  const created = totals.tasksCreated;
  const completed = Math.min(created, totals.tasksCompleted);
  const ratios = STAGE_RATIOS[teamId] ?? STAGE_RATIOS.tm_main;
  const stages: { status: TaskStatusKey; label: string; value: number }[] = [
    { status: "queued", label: "进入排队", value: created },
    { status: "pending", label: "待开始", value: Math.round(created * ratios.started) },
    { status: "in_progress", label: "进行中", value: Math.round(created * ratios.inProgress) },
    { status: "pending_review", label: "待验收", value: Math.max(completed, Math.round(created * ratios.review)) },
    { status: "completed", label: "已完成", value: completed },
  ];
  // 单调递减修正（漏斗语义要求逐级不增长，避免 mock 比例抖动出现「倒挂」）
  for (let i = 1; i < stages.length; i++) {
    if (stages[i].value > stages[i - 1].value) stages[i].value = stages[i - 1].value;
  }
  const first = stages[0].value || 1;
  return stages.map((s) => ({ ...s, retention: s.value / first }));
}

const STAGE_RATIOS: Record<string, { started: number; inProgress: number; review: number }> = {
  tm_main: { started: 0.97, inProgress: 0.93, review: 0.86 },
  tm_collect: { started: 0.95, inProgress: 0.88, review: 0.78 },
  tm_alert: { started: 0.98, inProgress: 0.95, review: 0.9 },
  tm_report: { started: 0.93, inProgress: 0.82, review: 0.7 },
};

/** 产出物类型构成（text / doc / file，对齐 ARTIFACT_TYPES）。 */
export interface ArtifactSlice {
  type: "text" | "doc" | "file";
  label: string;
  value: number;
  share: number;
}

export function artifactMixOf(teamId: string, range: RangeKey): ArtifactSlice[] {
  const total = aggregate(windowOf(teamId, range)).artifacts;
  const shares = PROFILES[teamId]?.artifactTypeShares ?? PROFILES.tm_main.artifactTypeShares;
  const values = allocate(total, [shares.text, shares.doc, shares.file]);
  const labels: Record<"text" | "doc" | "file", string> = {
    text: "文本产出",
    doc: "文档类",
    file: "文件/代码类",
  };
  return (["text", "doc", "file"] as const).map((type, i) => ({
    type,
    label: labels[type],
    value: values[i],
    share: total > 0 ? values[i] / total : 0,
  }));
}

/** 团队状态快照（概览条 / 健康度）。 */
export interface TeamSnapshot {
  team: MockTeam;
  totals: Totals;
  /** 健康度 0..100：完成率、一次通过率、周期、阻塞 四项加权。 */
  healthScore: number;
  /** 状态快照条（当前盘子里的任务分布，非区间口径）。 */
  statusMix: Record<TaskStatusKey, number>;
}

/** 各团队的当前任务盘子（mock 快照，用于「任务状态分布」堆叠条）。 */
const STATUS_MIX: Record<string, Record<TaskStatusKey, number>> = {
  tm_main: { queued: 2, pending: 3, in_progress: 4, blocked: 1, pending_review: 2, completed: 38, archived: 26 },
  tm_collect: { queued: 1, pending: 2, in_progress: 2, blocked: 1, pending_review: 1, completed: 19, archived: 12 },
  tm_alert: { queued: 0, pending: 1, in_progress: 3, blocked: 0, pending_review: 2, completed: 24, archived: 9 },
  tm_report: { queued: 3, pending: 2, in_progress: 1, blocked: 1, pending_review: 1, completed: 6, archived: 0 },
};

export function snapshotOf(teamId: string, range: RangeKey): TeamSnapshot {
  const team = getTeam(teamId);
  const totals = aggregate(windowOf(teamId, range));
  const healthScore = Math.round(
    Math.min(
      100,
      Math.max(
        0,
        46 * totals.completionRate +
          26 * totals.firstPassRate +
          18 * Math.min(1, 40 / Math.max(1, totals.avgCycleHours)) +
          10 * (1 - Math.min(1, totals.avgBlockedHours / 30)),
      ),
    ),
  );
  return { team, totals, healthScore, statusMix: STATUS_MIX[teamId] ?? STATUS_MIX.tm_main };
}

/** 全部团队快照（全局看板表格 / 排行 / 热力图）。 */
export function snapshots(range: RangeKey): TeamSnapshot[] {
  return TEAMS.map((t) => snapshotOf(t.id, range));
}

/** 活跃热力图：行为团队、列为 90 天上的日期（用 tasksCreated + artifacts 做强度）。 */
export function activityHeat(teamId: string): number[] {
  return dailyOf(teamId).map((r) => r.tasksCreated + r.artifacts);
}

/** 90 天的日期标签（热力图列标签用，隔几天显示一个）。 */
export function heatDates(): string[] {
  return dailyOf(TEAMS[0].id).map((r) => r.date);
}

/* ============================================================
 * 八、格式化（与 charts.tsx 的格式化保持同一组入口，页面直接从这里 import）
 * ============================================================ */

/** 整数千分位。 */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** token 紧凑展示：12,345 → 12.3K / 1,234,567 → 1.23M。 */
export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/** 金额：未知（null）显示「—」，不显示 $0.00。 */
export function fmtMoney(n: number | null | undefined, currency = "$"): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1000) return `${currency}${(n / 1000).toFixed(2)}K`;
  return `${currency}${n.toFixed(2)}`;
}

/** 百分比：0.7823 → 78.2%。 */
export function fmtPct(r: number | null | undefined, digits = 1): string {
  if (r === null || r === undefined) return "—";
  return `${(r * 100).toFixed(digits)}%`;
}

/** 时长：小时 → `31.0h` / 超过 24h 补天数（如 `2.3d`）。 */
export function fmtHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return "—";
  if (h >= 24) return `${(h / 24).toFixed(1)}d`;
  return `${h.toFixed(1)}h`;
}
