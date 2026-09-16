/**
 * Agent-originated mention 触发硬节流（@ storm 熔断）。
 *
 * 背景：单个用户 `@all` 曾引发失控 ping-pong（测试-1 ↔ 开发-1 约 10 轮 +
 * manager 重复广播）。此前仅靠 prompt 软约束，无服务端轮数/速率/链长上限。
 *
 * 作用域（硬性）：
 * - 仅约束 **agent-originated** 触发（MCP `group_post` / `notify_agent` 经由
 *   `dispatchAgentMention` 的路径）；用户-originated 消息（`chat.service`
 *   `createMessage` / `resolveMentions`）不受影响，本模块不得被用户路径引用。
 * - agent-originated `@all` / 团队级 fan-out 永不展开为触发（display-only）：
 *   消息照常落库 + 广播（可见），但不产生任何 `dispatchAgentMention` 调用。
 *
 * 确定性：纯内存滑动窗口，时钟经 `now` 参数注入（测试传固定值，生产传
 * `Date.now()`），无 wall-clock 内读、无新依赖。
 */

/** 单次分派判定结果。 */
export interface MentionThrottleDecision {
  allow: boolean;
  /** 拒绝原因（`pair_limit` | `task_budget`），allow=true 时缺省。 */
  reason?: 'pair_limit' | 'task_budget';
}

/** 滑动窗口配额（构造函数注入，缺省见 DEFAULT_*）。 */
export interface MentionThrottleOptions {
  /** 同一无序对窗口内最大分派数（缺省 3）。 */
  pairMax?: number;
  /** 对窗口毫秒数（缺省 60_000）。 */
  pairWindowMs?: number;
  /** 单任务窗口内全局最大分派数（缺省 20）。 */
  taskBudgetMax?: number;
  /** 任务窗口毫秒数（缺省 120_000）。 */
  taskWindowMs?: number;
}

/** 单次分派申请。 */
export interface MentionDispatchRequest {
  taskId: string;
  fromInstanceId: string;
  toInstanceId: string;
  /** 注入时钟（毫秒时间戳）。 */
  now: number;
}

export const DEFAULT_PAIR_MAX = 3;
export const DEFAULT_PAIR_WINDOW_MS = 60_000;
export const DEFAULT_TASK_BUDGET_MAX = 20;
export const DEFAULT_TASK_WINDOW_MS = 120_000;

/**
 * 节流豁免 kind（plan-review-execution-gates Todo 5）：
 * 内部 wake / round-notify 不计 pair/task 预算（不咨询、不记账），
 * pair/task 预算只约束外部派发。预算常量（上 4 行）字节一致，禁改。
 */
export const THROTTLE_EXEMPT_KINDS: readonly string[] = [
  'wake',
  'round-notify',
];

/** 指定 kind 是否免节流（null/undefined/空串一律不免，走外部派发预算）。 */
export function isThrottleExemptKind(
  kind: string | null | undefined,
): boolean {
  if (!kind) return false;
  return THROTTLE_EXEMPT_KINDS.includes(kind);
}

/** 团队级 fan-out 标记（agent 内容命中任一即视为 team-wide，仅展示不触发）。 */
const TEAM_WIDE_MARKERS = ['@all', '@所有人', '@全体', '@here'] as const;

interface DispatchRecord {
  taskId: string;
  pairKey: string;
  at: number;
}

/** 无序对 key（A→B 与 B→A 同一配额，ping-pong 双向共用）。 */
export function pairKeyOf(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 内容是否含团队级 fan-out 标记（agent-originated `@all` 等）。
 * 命中 → 调用方不得展开为触发（display-only：落库 + 广播保留）。
 */
export function containsTeamWideMention(content: string | null | undefined): boolean {
  if (!content || !content.includes('@')) return false;
  return TEAM_WIDE_MARKERS.some((m) => content.includes(m));
}

export class MentionThrottle {
  private readonly pairMax: number;
  private readonly pairWindowMs: number;
  private readonly taskBudgetMax: number;
  private readonly taskWindowMs: number;
  private history: DispatchRecord[] = [];

  constructor(opts: MentionThrottleOptions = {}) {
    this.pairMax = opts.pairMax ?? DEFAULT_PAIR_MAX;
    this.pairWindowMs = opts.pairWindowMs ?? DEFAULT_PAIR_WINDOW_MS;
    this.taskBudgetMax = opts.taskBudgetMax ?? DEFAULT_TASK_BUDGET_MAX;
    this.taskWindowMs = opts.taskWindowMs ?? DEFAULT_TASK_WINDOW_MS;
  }

  /**
   * 申请一次 agent 触发分派。allow=true 时调用方须随后执行真实分派
   * （本方法同步记账：先占配额，避免同 tick 并发穿透）。
   */
  shouldDispatch(req: MentionDispatchRequest): MentionThrottleDecision {
    const { taskId, fromInstanceId, toInstanceId, now } = req;
    const pairKey = pairKeyOf(fromInstanceId, toInstanceId);
    this.prune(now);
    const pairHits = this.history.filter(
      (r) =>
        r.taskId === taskId &&
        r.pairKey === pairKey &&
        r.at > now - this.pairWindowMs,
    ).length;
    if (pairHits >= this.pairMax) {
      return { allow: false, reason: 'pair_limit' };
    }
    const taskHits = this.history.filter(
      (r) => r.taskId === taskId && r.at > now - this.taskWindowMs,
    ).length;
    if (taskHits >= this.taskBudgetMax) {
      return { allow: false, reason: 'task_budget' };
    }
    this.history.push({ taskId, pairKey, at: now });
    return { allow: true };
  }

  /** 过期记录淘汰（保留仍在任一窗口内的记录）。 */
  private prune(now: number): void {
    const oldest = now - Math.max(this.pairWindowMs, this.taskWindowMs);
    if (this.history.length === 0) return;
    this.history = this.history.filter((r) => r.at > oldest);
  }
}
