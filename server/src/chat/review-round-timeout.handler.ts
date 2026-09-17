import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  TRIGGER_KIND,
  buildTriggerDedupKey,
} from '../common/constants/trigger.constants';
import {
  TriggerFireContext,
  TriggerOutcome,
  TriggerService,
} from '../timers/trigger.service';
import { ReviewRoundGateService } from '../issues/review-round-gate.service';
import { tryParseLedger } from '../issues/review-round-ledger';

/**
 * 评审轮次超时 timer kind（generic-timer 消费者；dedupKey 口径
 * `review_round_timeout:{issueId}:{round}`，与派发侧 openReviewRound 共用）。
 */
export const REVIEW_ROUND_TIMEOUT_KIND = 'review_round_timeout';

export interface ReviewRoundTimeoutPayload {
  issueId: string;
  taskId?: string | null;
  teamId?: string | null;
  round?: number;
}

export function buildReviewRoundTimeoutDedupKey(
  issueId: string,
  round: number,
): string {
  return buildTriggerDedupKey(
    TRIGGER_KIND.REVIEW_ROUND_TIMEOUT,
    issueId,
    round,
  );
}

/**
 * 评审轮次超时消费者（timeout→stale 的唯一 timer 消费者）。
 *
 * - `onModuleInit` 经 `TriggerService.registerHandler` 接入（receipt-nudge 同款）；
 * - 触发时只读账本做两态判断：非 `collecting`（complete/stale/无账本）一律 no-op；
 * - collecting 且过期与否的判定 + stale 翻转全部委托
 *   `ReviewRoundGateService.checkTimeout`（本文件永不复刻 stale 逻辑）；
 * - 任意失败只 warn（trigger 行由 TriggerService 记 failed，不阻断其余 trigger）。
 */
@Injectable()
export class ReviewRoundTimeoutHandler implements OnModuleInit {
  private readonly logger = new Logger(ReviewRoundTimeoutHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(TriggerService)
    private readonly timers?: TriggerService,
    @Optional()
    @Inject(ReviewRoundGateService)
    private readonly gate?: ReviewRoundGateService,
  ) {}

  onModuleInit() {
    try {
      this.timers?.registerHandler(REVIEW_ROUND_TIMEOUT_KIND, (timer) =>
        this.handle(timer),
      );
    } catch (err) {
      this.logger.warn(
        `[review-round-timeout] registerHandler 失败（超时转人工缺席）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async handle(timer: TriggerFireContext): Promise<TriggerOutcome> {
    const payload = (timer?.payload ??
      {}) as Partial<ReviewRoundTimeoutPayload>;
    const issueId = payload.issueId;
    if (!issueId || typeof issueId !== 'string') {
      this.logger.warn(
        `[review-round-timeout] timer ${timer?.id} 缺 issueId（跳过，不重排）`,
      );
      return { done: true };
    }
    let description: string | null = null;
    try {
      const issue = await this.prisma.issue.findUnique({
        where: { id: issueId },
      });
      description =
        (issue as unknown as { description?: string | null } | null)
          ?.description ?? null;
    } catch (err) {
      this.logger.warn(
        `[review-round-timeout] 读取宿主 issue=${issueId} 失败（跳过）：${err instanceof Error ? err.message : String(err)}`,
      );
      return { done: true };
    }
    const ledger = tryParseLedger(description);
    if (!ledger) {
      return { done: true };
    }
    if (payload.round !== undefined && payload.round !== ledger.round) {
      this.logger.warn(
        `[review-round-timeout] 旧轮 timer 跳过 issue=${issueId}（payload R${payload.round} ≠ 账本 R${ledger.round}，不越权触发）`,
      );
      return { done: true };
    }
    if (ledger.status !== 'collecting') {
      return { done: true };
    }
    if (!this.gate) {
      this.logger.warn(
        `[review-round-timeout] ReviewRoundGateService 未装配 issue=${issueId}（跳过 stale 翻转）`,
      );
      return { done: true };
    }
    try {
      await this.gate.checkTimeout(issueId, new Date());
    } catch (err) {
      this.logger.warn(
        `[review-round-timeout] checkTimeout 失败 issue=${issueId}（不重排）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { done: true };
  }
}
