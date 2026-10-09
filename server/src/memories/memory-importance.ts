/**
 * 记忆重要度公式（无 I/O、无副作用）。
 *
 * ## 为什么需要它
 * 记忆检索（`vteam_memory_search`）与每轮自动注入此前都按时间倒序取前 N，
 * 于是「老但高频被引用」的记忆必然沉底，而「刚建但没人用过的」记忆永远占位。
 * 重要度把两个正交信号合成一个可排序的标量：
 *
 *   score = ln(1 + refCount) + exp(-ageDays / halfLifeDays)
 *
 * - **引用项** `ln(1 + refCount)`：对数增长，引用次数翻倍带来的加分快速衰减——
 *   100 次被引用（+4.6）压不过一条昨天刚被引用的（+1.0），避免少数超级热门行
 *   永久霸榜。用 `ln(1+n)` 而非 `n` 也保证了 n=0 时该项恰为 0。
 * - **新鲜项** `exp(-ageDays / halfLifeDays)`：指数衰减，默认半衰期 30 天
 *   （即 30 天未触碰，新鲜项减半）。半衰期是本式唯一的可调旋钮：
 *   调小 → 更看重「最近是否有用」，调大 → 更看重「一直有用」。
 *
 * ## 语义边界（勿越界）
 * - **计龄基准 = `lastUsedAt ?? createdAt`**：被引用过的记忆从「最近一次命中」
 *   起算，而非创建时间——一条半年前建、昨天刚被命中的记忆是**热的**。
 *   从未被引用的行 `lastUsedAt` 为 NULL，退回创建时间。
 * - **注入路径不计 refCount**（见 worker-dispatcher 的 `buildTeamMemoryIndex`）：
 *   每轮自动注入都计会让主 Agent 一次会话把指标刷爆，指标随即失去意义。
 *   只有 agent 主动 `memory_search` 命中才 +1。
 * - 本模块**不做**分类/合并判断，也不参与过滤：它只给已通过 where 条件的
 *   候选行打分，排序由同模块的 `sortMemoriesByImportance` 统一给出
 *   （降序，同分时新者优先），避免各处各抄一份口径不同的比较器。
 */

/** 记忆重要度默认半衰期（天）。可用环境变量 `MEMORY_IMPORTANCE_HALF_LIFE_DAYS` 覆盖。 */
export const MEMORY_IMPORTANCE_HALF_LIFE_DAYS_DEFAULT = 30;

const MS_PER_DAY = 86_400_000;

/** `computeMemoryImportance` 所需的最小行形状（Prisma `Memory` 的相关子集）。 */
export interface MemoryImportanceInput {
  /** 主动检索命中次数（列默认值 0）。 */
  refCount: number;
  /** 最近一次被检索命中的时刻；NULL = 从未被引用。 */
  lastUsedAt: Date | null;
  /** 创建时刻（`lastUsedAt` 为空时的计龄基准）。 */
  createdAt: Date;
}

/**
 * 解析半衰期：环境变量优先，非法值（非数字/非有限/非正数）静默回落默认值。
 *
 * 对齐 `timers/trigger.service.ts` 的 `scanIntervalMs()` 惯例——配置项不该让
 * 进程起不来，运维手滑写错 env 只应降级到默认行为而非抛错。
 */
export function resolveMemoryImportanceHalfLifeDays(): number {
  const raw = process.env.MEMORY_IMPORTANCE_HALF_LIFE_DAYS;
  if (raw === undefined || raw === '') {
    return MEMORY_IMPORTANCE_HALF_LIFE_DAYS_DEFAULT;
  }
  const n = Number(raw);
  // 非有限值（NaN/±Infinity）与非正数都会让 exp() 退化（除零→±Infinity、
  // 负半衰期→分数反向增长，越老越高），两者都不可接受，一律回落默认。
  return Number.isFinite(n) && n > 0
    ? n
    : MEMORY_IMPORTANCE_HALF_LIFE_DAYS_DEFAULT;
}

/**
 * 重要度半衰期（天），模块加载时按环境变量解析。
 *
 * 保持为导出常量而非每次调用读 env：排序是热路径（每次检索/每轮注入对几十行
 * 求值），且半衰期在进程生命周期内应当稳定——同一轮里不同候选用不同半衰期
 * 排序是不可复现的结果。改半衰期请重启进程。
 */
export const MEMORY_IMPORTANCE_HALF_LIFE_DAYS =
  resolveMemoryImportanceHalfLifeDays();

/**
 * 计算一条记忆的重要度分（越大越该被注入 / 排在前面）。
 *
 * 无副作用：不写库、不改入参、不读全局可变状态（`process.env` 已在模块加载时
 * 解析成常量）。唯一的外部输入是当前时刻，通过 `now` 参数显式注入——这样
 * 「同一条记忆在同一刻度的分」可被测试确定复现，也不会因调用方先后求值跨过
 * 一次时钟跳动而出现排序抖动。
 *
 * @param row 记忆行的时间戳与引用计数（Prisma `Memory` 的相关子集即可）
 * @param halfLifeDays 半衰期（天），默认取 {@link MEMORY_IMPORTANCE_HALF_LIFE_DAYS}
 * @param now 计龄基准的「当前时刻」，默认 `new Date()`
 */
export function computeMemoryImportance(
  row: MemoryImportanceInput,
  halfLifeDays: number = MEMORY_IMPORTANCE_HALF_LIFE_DAYS,
  now: Date = new Date(),
): number {
  const hl =
    Number.isFinite(halfLifeDays) && halfLifeDays > 0
      ? halfLifeDays
      : MEMORY_IMPORTANCE_HALF_LIFE_DAYS_DEFAULT;

  // refCount 是 INT NOT NULL DEFAULT 0，理论非负；但经 merge 累加 / 外部写入
  // 的行若为负，ln(1+refCount) 会得到 NaN 或负无穷并静默毁掉整个排序。
  // 钳到 0——「负引用」没有语义，退回「未被引用」是唯一安全的解释。
  const refCount = Number.isFinite(row.refCount)
    ? Math.max(0, Math.trunc(row.refCount))
    : 0;

  const recencyBase = row.lastUsedAt ?? row.createdAt;
  // 钳到 0：lastUsedAt 来自另一台机器写入，时钟漂移可能让它落在未来，
  // 那会让新鲜项 >1 并把「未来时间戳」排到最前。负龄没有语义，当 0 处理。
  const ageDays = Math.max(
    0,
    (now.getTime() - recencyBase.getTime()) / MS_PER_DAY,
  );

  return Math.log(1 + refCount) + Math.exp(-ageDays / hl);
}

/**
 * 按重要度降序排序候选记忆（检索 `memory_search` 与每轮自动注入共用）。
 *
 * - **`now` 每次调用只求值一次**并透传给全部行：若让
 *   {@link computeMemoryImportance} 的默认 `new Date()` 在比较器里逐次求值，
 *   同一批候选会跨一次时钟跳动打分，结果不可复现（排序抖动、测试难断言）。
 * - 同分时按 `lastUsedAt ?? createdAt` 新者优先（与原先 `createdAt desc` 的观感一致），
 *   且 `Array.prototype.sort` 稳定，同分同龄保持入参次序。
 * - 纯函数：不改入参、不触库，返回新数组（调用方可直接 `.slice()` 截断）。
 */
export function sortMemoriesByImportance<T extends MemoryImportanceInput>(
  rows: readonly T[],
  now: Date = new Date(),
): T[] {
  const recencyOf = (row: T) => (row.lastUsedAt ?? row.createdAt).getTime();
  return [...rows].sort((a, b) => {
    const diff =
      computeMemoryImportance(b, undefined, now) -
      computeMemoryImportance(a, undefined, now);
    if (diff !== 0) return diff;
    return recencyOf(b) - recencyOf(a);
  });
}
