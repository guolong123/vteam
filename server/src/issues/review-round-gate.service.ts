import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PLAN_LIFECYCLE_STATUS } from '../tasks/plan-lifecycle.service';
import {
  REVIEW_ROUND_ERRORS,
  ReviewRoundLedger,
  VerdictInput,
  createLedger,
  parseLedger,
} from './review-round-ledger';
import { ReviewRoundService } from './review-round.service';

/**
 * 收敛门与超时转人工（plan-review-execution-gates todo 7；docs 33 §3.3-§3.4）。
 *
 * 全部账本写复用 todo 6 的 `ReviewRoundService.applyRoundUpdate`
 *（issues 行 `SELECT ... FOR UPDATE` 串行化），本文件只做门裁决：
 *
 * - 版本校验：缺版本 → 打回（demanding version，本次永不计入 `received`，
 *   更不进 `superseded`）；版本 ≠ 当前轮次版本 → 由账本层标 `superseded`
 *   归档，永不触发修订；同轮同人多次 verdicts 取最后一次（账本层覆盖）。
 * - 收敛门：`received ⊇ expected` 即置 `complete`，经 `dispatchAgentMention`
 *   自动通知计划员可修订 + 抄 PM——两次调用一律 `kind='wake'`（todo 4 语义：
 *   豁免计划门禁、不记账、不计 throttle 预算、不产生回执环）。
 * - 修订拦截：非 `complete` 轮次的修订请求一律拒绝并提示 exact `待 N/N`
 *  （m_446 类“单份回执即修订”行为被拦）。
 * - 超时：`timeoutAt` 后仍未齐 → 置 `stale` 并产出待拍板项（等 / 催办指定
 *   缺席人 / 降级放行），绝不通知计划员；降级放行（N-1）只能由
 *   `confirmDegradedRelease` 显式确认，永不自动放行。
 *
 * 生产接线：`notifier` 传 `WorkerDispatcher`（结构兼容，
 * `dispatchAgentMention` 的 `kind='wake'` 分支），经 `IssuesModule`
 * 装配；单测传 mock。
 */

/** 超时时钟：每轮 30 分钟（docs 33 §3.4，超时转人工）。 */
export const REVIEW_ROUND_TIMEOUT_MS = 30 * 60 * 1000;

/** 收敛通知的派发输入（`kind` 恒为 `wake`，复用 todo 4 豁免路径）。 */
export interface ConvergenceDispatchInput {
  taskId?: string | null;
  teamId?: string | null;
  channelId: string;
  text: string;
  targetInstanceId: string;
  kind: 'wake';
  issueId?: string | null;
}

/** 收敛通知器（生产实现为 WorkerDispatcher，结构兼容即可，不直连 ChatModule）。 */
export interface ConvergenceNotifier {
  dispatchAgentMention(input: ConvergenceDispatchInput): Promise<string | void>;
}

/** 通知三元组：频道 + 计划员 + PM（收敛自动通知计划员并抄 PM）。 */
export interface ConvergenceNotifyOpts {
  channelId: string;
  plannerMemberId: string;
  pmMemberId: string;
  taskId?: string;
  teamId?: string;
}

/** 版本裁决结果（账本层三态 + 门层打回态）。 */
export type GateVerdictOutcome =
  'received' | 'missing-version' | 'superseded' | 'pending-hash';

export interface RecordVerdictResult {
  outcome: GateVerdictOutcome;
  ledger: ReviewRoundLedger;
  converged: boolean;
  /** 打回提示（含 exact `待 N/N`）；非打回时缺省。 */
  hint?: string;
}

/** 人工拍板项（stale 轮次的三选项）。 */
export type AdjudicationKind = 'wait' | 'nudge' | 'degraded-release';

export interface AdjudicationItem {
  kind: AdjudicationKind;
  detail: string;
  absentees?: string[];
  /** 降级放行恒为 true：必须显式确认调用，永不自动放行。 */
  requiresConfirm?: boolean;
}

export interface TimeoutCheckResult {
  stale: boolean;
  ledger: ReviewRoundLedger;
  absentees: string[];
  adjudications: AdjudicationItem[];
}

export interface DegradedReleaseResult {
  ledger: ReviewRoundLedger;
  waived: string[];
  confirmedBy: string;
}

/** 收敛后计划翻转槽（N/N 只到 pending_final 待定稿，永不直接 approved；
 * 定稿须用户显式 finalize，开始执行另需用户 confirm）。 */
export interface ConvergencePlanSink {
  transition(taskId: string, to: string): Promise<unknown>;
}

/** 轮次账本域错误码（复用账本层命名，不碰 issues.constants / task machine）。 */
export const REVIEW_ROUND_GATE_ERRORS = {
  ...REVIEW_ROUND_ERRORS,
  /** 非收敛轮次的修订请求（m_446 类行为被拦，message 含 exact `待 N/N`）。 */
  REVISION_REFUSED: 'REVIEW_ROUND_REVISION_REFUSED',
  /** 仅 stale 轮次可降级放行（防误调）。 */
  NOT_STALE: 'REVIEW_ROUND_NOT_STALE',
} as const;

@Injectable()
export class ReviewRoundGateService {
  private readonly logger = new Logger(ReviewRoundGateService.name);
  private planSink: ConvergencePlanSink | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rounds: ReviewRoundService,
    @Optional() private notifier: ConvergenceNotifier | null = null,
  ) {}

  /**
   * 装配收敛后计划翻转槽（缺省 null=不翻转，收敛照常 complete+通知）。
   * 生产由调用方传入 PlanLifecycleService（结构兼容 transition 即可，
   * 不直连 TasksModule，无模块循环）。
   */
  attachPlanSink(sink: ConvergencePlanSink | null): void {
    this.planSink = sink;
  }

  /**
   * 装配收敛通知器（缺省 null=不通知，收敛照常 complete+翻转）。
   * 生产由调用方传入 WorkerDispatcher（结构兼容 dispatchAgentMention
   * 的 `kind='wake'` 分支即可，不直连 ChatModule，无模块循环）。
   */
  attachNotifier(notifier: ConvergenceNotifier | null): void {
    this.notifier = notifier;
  }

  /**
   * 记录单成员 verdict 并执行收敛门：
   * 1. 缺版本 → 打回（只读账本计数，本次永不写入）；
   * 2. 否则经 `applyRoundUpdate` 串行写入（superseded/pending-hash/last-wins
   *    均由账本层裁决，本层只读结果判定 outcome）；
   * 3. `received ⊇ expected` 且尚未 complete → 置 `complete` 并自动通知
   *    计划员 + 抄 PM（`kind='wake'` 两次调用）。
   */
  async recordVerdict(
    issueId: string,
    input: VerdictInput,
    notify: ConvergenceNotifyOpts,
  ): Promise<RecordVerdictResult> {
    const stated = (input.version ?? '').trim();
    if (!stated) {
      const ledger = await this.readLedger(issueId);
      const { receivedCount, expectedCount } = this.counts(ledger);
      return {
        outcome: 'missing-version',
        ledger,
        converged: false,
        hint:
          `打回：成员 ${input.member} 的回执缺版本号（msgId=${input.msgId}），` +
          `请引用当前版本 ${ledger.planVersion.version} 后重发；` +
          `待 ${receivedCount}/${expectedCount}，本次未计入`,
      };
    }
    const preLedger = await this.readLedger(issueId);
    if (preLedger.status === 'complete' || preLedger.status === 'stale') {
      // F2#5：终态账本不再接受任何 received 写入（同版本新 msgId 重发也不覆盖），
      // 直接以写前快照返回；outcome 经 outcomeOf 判定（同 msgId 幂等返回 received，
      // 新 msgId 报 superseded——均不声称本次计入）。
      const outcome = this.outcomeOf(preLedger, input);
      return {
        outcome,
        ledger: preLedger,
        converged: preLedger.status === 'complete',
      };
    }
    const ledger = await this.rounds.applyRoundUpdate(issueId, {
      received: input,
    });
    const outcome = this.outcomeOf(ledger, input);
    const converged = this.isConverged(ledger);
    if (!converged || ledger.status === 'complete') {
      return { outcome, ledger, converged };
    }
    const completed = await this.rounds.applyRoundUpdate(issueId, {
      status: 'complete',
    });
    // §6.1 极性门：people-complete（isConverged）只管"人齐→complete+通知"；
    // 计划翻转另看 verdict 极性——全部 APPROVE → pending_final，
    // 任一 REJECT → draft（§6.1 REJECT 回流分支）。通知两种情况都发
    // （计划员需知"可修订"，极性由 buildRoundSummary 的 per-member 明细呈现）。
    const allApprove = this.isAllApprove(completed);
    await this.transitionPlanStatus(
      completed,
      notify,
      allApprove
        ? PLAN_LIFECYCLE_STATUS.pending_final
        : PLAN_LIFECYCLE_STATUS.draft,
    );
    await this.notifyConvergence(completed, issueId, notify, null);
    return { outcome, ledger: completed, converged: true };
  }

  /**
   * 修订请求门（拦 m_446 类行为）：仅 `complete` 且收敛的轮次放行，
   * 其余一律抛错，message 含 exact `待 N/N`。
   */
  async requestRevision(
    issueId: string,
    requester: string,
  ): Promise<{ allowed: true; ledger: ReviewRoundLedger }> {
    const ledger = await this.readLedger(issueId);
    if (ledger.status === 'complete' && this.isConverged(ledger)) {
      return { allowed: true, ledger };
    }
    const { receivedCount, expectedCount } = this.counts(ledger);
    const absentees = this.absentees(ledger);
    const err = new Error(
      `修订被拒：成员 ${requester} 请求修订 R${ledger.round} ${ledger.planVersion.version}，` +
        `但待 ${receivedCount}/${expectedCount}` +
        `（缺席：${absentees.join('、') || '无'}），收敛前计划员不得修订`,
    ) as Error & { code?: string };
    err.code = REVIEW_ROUND_GATE_ERRORS.REVISION_REFUSED;
    throw err;
  }

  /**
   * 超时检查（30 分钟时钟）：`timeoutAt` 已过且仍在收集中 → 置 `stale`
   * 并产出三选项待拍板项。本路径永不调用 notifier（超时绝不自动通知计划员）。
   */
  async checkTimeout(
    issueId: string,
    now: Date = new Date(),
  ): Promise<TimeoutCheckResult> {
    const ledger = await this.readLedger(issueId);
    const absentees = this.absentees(ledger);
    if (ledger.status !== 'collecting') {
      return { stale: false, ledger, absentees, adjudications: [] };
    }
    const timeoutAt = ledger.timeoutAt ? new Date(ledger.timeoutAt) : null;
    if (!timeoutAt || Number.isNaN(timeoutAt.getTime()) || now < timeoutAt) {
      return { stale: false, ledger, absentees, adjudications: [] };
    }
    const staleLedger = await this.rounds.applyRoundUpdate(issueId, {
      status: 'stale',
    });
    return {
      stale: true,
      ledger: staleLedger,
      absentees,
      adjudications: this.buildAdjudications(staleLedger, absentees),
    };
  }

  /**
   * 降级放行显式确认（N-1）：仅 `stale` 轮次可调；豁免名单须为“期望但未
   * 回执”的成员。确认后置 `complete` 并通知计划员 + 抄 PM（人类拍板后的
   * 通知，非自动放行）。任何自动路径不得调用本方法。
   */
  async confirmDegradedRelease(
    issueId: string,
    confirmer: string,
    opts: ConvergenceNotifyOpts & { waived: string[] },
  ): Promise<DegradedReleaseResult> {
    const ledger = await this.readLedger(issueId);
    if (ledger.status !== 'stale') {
      throw new Error(
        `降级放行被拒：轮次状态为 ${ledger.status}（需 stale，超时转人工后由 ${confirmer} 显式确认）`,
      );
    }
    const missing = this.absentees(ledger);
    const illegal = opts.waived.filter(
      (w) => !ledger.expected.includes(w) || !missing.includes(w),
    );
    if (opts.waived.length === 0 || illegal.length > 0) {
      throw new Error(
        `降级放行被拒：豁免名单须为缺席成员的子集（缺席：${missing.join('、') || '无'}）`,
      );
    }
    const completed = await this.rounds.applyRoundUpdate(issueId, {
      status: 'complete',
    });
    await this.markPendingFinal(completed, opts);
    await this.notifyConvergence(completed, issueId, opts, {
      confirmer,
      waived: [...opts.waived],
    });
    return {
      ledger: completed,
      waived: [...opts.waived],
      confirmedBy: confirmer,
    };
  }

  /** 收敛判定：期望名单非空且全部已收（同一人多视角按 expected 条目计）。 */
  isConverged(ledger: ReviewRoundLedger): boolean {
    return (
      ledger.expected.length > 0 &&
      ledger.expected.every((m) => ledger.received[m] !== undefined)
    );
  }

  /** 极性判定：人齐且期望名单每条回执均为 APPROVE（§6.1 全 APPROVE 门）。 */
  isAllApprove(ledger: ReviewRoundLedger): boolean {
    return (
      ledger.expected.length > 0 &&
      ledger.expected.every((m) => ledger.received[m]?.verdict === 'APPROVE')
    );
  }

  /** 缺席名单：期望但未收回执的成员（stale 催办点名用）。 */
  absentees(ledger: ReviewRoundLedger): string[] {
    return ledger.expected.filter((m) => ledger.received[m] === undefined);
  }

  /** 轮次摘要（收敛通知正文，含 R{n}·版本·n/N + 各成员 VERDICT）。 */
  buildRoundSummary(
    ledger: ReviewRoundLedger,
    extra?: { confirmer: string; waived: string[] } | null,
  ): string {
    const { receivedCount, expectedCount } = this.counts(ledger);
    const verdicts = ledger.expected
      .map((m) => {
        const r = ledger.received[m];
        return `${m}:${r ? r.verdict : '缺席'}`;
      })
      .join('，');
    const degraded = extra
      ? `（降级放行：${extra.confirmer} 确认，豁免 ${extra.waived.join('、')}）`
      : '';
    return (
      `【评审收敛 R${ledger.round} · ${ledger.planVersion.version} · ` +
      `${receivedCount}/${expectedCount}】${verdicts}${degraded}——计划员可修订`
    );
  }

  private counts(ledger: ReviewRoundLedger): {
    receivedCount: number;
    expectedCount: number;
  } {
    return {
      receivedCount: ledger.expected.filter(
        (m) => ledger.received[m] !== undefined,
      ).length,
      expectedCount: ledger.expected.length,
    };
  }

  private outcomeOf(
    ledger: ReviewRoundLedger,
    input: VerdictInput,
  ): Exclude<GateVerdictOutcome, 'missing-version'> {
    const hit = ledger.received[input.member];
    if (hit && hit.msgId === input.msgId) return 'received';
    const pending = (ledger.pending ?? []).some((p) => p.msgId === input.msgId);
    if (pending) return 'pending-hash';
    return 'superseded';
  }

  private buildAdjudications(
    ledger: ReviewRoundLedger,
    absentees: string[],
  ): AdjudicationItem[] {
    const { receivedCount, expectedCount } = this.counts(ledger);
    return [
      {
        kind: 'wait',
        detail:
          `继续等待：R${ledger.round} ${ledger.planVersion.version} ` +
          `待 ${receivedCount}/${expectedCount}，等缺席人补回执`,
        absentees: [...absentees],
      },
      {
        kind: 'nudge',
        detail: `催办指定缺席人：${absentees.join('、') || '无'}（nudge，不阻塞本轮）`,
        absentees: [...absentees],
      },
      {
        kind: 'degraded-release',
        detail:
          `降级放行（N-1）：缺席视角记豁免后放行，需 ${'PM/老师'} 显式调用 ` +
          `confirmDegradedRelease 确认，绝不自动放行`,
        absentees: [...absentees],
        requiresConfirm: true,
      },
    ];
  }

  /**
   * 收敛后计划翻转：目标状态由调用方携带（全 APPROVE→pending_final 待定稿，
   * 任一 REJECT→draft 回流修订；永不直接 approved/executing。
   * 定稿须用户显式 finalize，开始执行另需用户 confirm）。
   * 无 sink / 无 taskId 照常跳过；翻转失败只 warn，永不阻断收敛 complete+通知。
   */
  private async transitionPlanStatus(
    ledger: ReviewRoundLedger,
    notify: ConvergenceNotifyOpts,
    target: string,
  ): Promise<void> {
    if (!this.planSink) return;
    const taskId = ledger.taskId ?? notify.taskId ?? null;
    if (!taskId) return;
    try {
      await this.planSink.transition(taskId, target);
    } catch (err) {
      this.logger.warn(
        `收敛翻转 ${target} 失败 task=${taskId}（轮次已 complete）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async markPendingFinal(
    ledger: ReviewRoundLedger,
    notify: ConvergenceNotifyOpts,
  ): Promise<void> {
    await this.transitionPlanStatus(
      ledger,
      notify,
      PLAN_LIFECYCLE_STATUS.pending_final,
    );
  }

  private async notifyConvergence(
    ledger: ReviewRoundLedger,
    issueId: string,
    notify: ConvergenceNotifyOpts,
    extra: { confirmer: string; waived: string[] } | null,
  ): Promise<void> {
    if (!this.notifier) return;
    const summary = this.buildRoundSummary(ledger, extra);
    const base = {
      channelId: notify.channelId,
      kind: 'wake' as const,
      issueId: ledger.issueId ?? issueId,
      ...(notify.taskId !== undefined ? { taskId: notify.taskId } : {}),
      ...(notify.teamId !== undefined ? { teamId: notify.teamId } : {}),
    };
    try {
      await this.notifier.dispatchAgentMention({
        ...base,
        targetInstanceId: notify.plannerMemberId,
        text: summary,
      });
    } catch (err) {
      this.logger.warn(
        `收敛通知计划员失败 issue=${issueId}（尽力通知，不阻断收敛）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await this.notifier.dispatchAgentMention({
        ...base,
        targetInstanceId: notify.pmMemberId,
        text: `【抄送PM】${summary}`,
      });
    } catch (err) {
      this.logger.warn(
        `收敛通知抄送PM失败 issue=${issueId}（尽力通知，不阻断收敛）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async readLedger(issueId: string): Promise<ReviewRoundLedger> {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId },
    });
    if (!issue) {
      throw new NotFoundException({
        code: REVIEW_ROUND_GATE_ERRORS.ISSUE_NOT_FOUND,
        message: `Issue ${issueId} 不存在`,
      });
    }
    return parseLedger(issue.description ?? null) ?? createLedger({ issueId });
  }
}
