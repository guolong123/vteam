import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import {
  ReviewRoundGateService,
} from '../issues/review-round-gate.service';
import { PlanLifecycleService } from './plan-lifecycle.service';

/**
 * 评审收敛接线（生产启动装配）：
 * TasksModule 已静态导入 ChatModule（导出 WorkerDispatcher）与
 * IssuesModule（导出 ReviewRoundGateService），故接线落在本模块——
 * 零新增模块边，不产生 IssuesModule → ChatModule 环。
 *
 * onModuleInit 先装 planSink（收敛翻转 pending_final）再装
 * notifier（收敛通知计划员+抄 PM）；任一缺席/装配失败只 warn
 * 跳过，永不抛错、永不阻塞启动（best-effort sidecar 口径）。
 */
@Injectable()
export class PlanReviewWiring implements OnModuleInit {
  private readonly logger = new Logger(PlanReviewWiring.name);

  constructor(
    private readonly gate: ReviewRoundGateService,
    @Optional() private readonly workerDispatcher: WorkerDispatcher | null = null,
    @Optional() private readonly planLifecycle: PlanLifecycleService | null = null,
  ) {}

  onModuleInit(): void {
    try {
      if (!this.planLifecycle) {
        this.logger.warn(
          '[plan-review-wiring] PlanLifecycleService 缺席，跳过 planSink 装配（收敛只 complete+通知，不翻转）',
        );
      } else {
        this.gate.attachPlanSink(this.planLifecycle);
      }
    } catch (err) {
      this.logger.warn(
        `[plan-review-wiring] planSink 装配失败（收敛只 complete+通知，不翻转）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      if (!this.workerDispatcher) {
        this.logger.warn(
          '[plan-review-wiring] WorkerDispatcher 缺席，跳过 notifier 装配（收敛只 complete+翻转，不通知）',
        );
      } else {
        this.gate.attachNotifier(this.workerDispatcher);
      }
    } catch (err) {
      this.logger.warn(
        `[plan-review-wiring] notifier 装配失败（收敛只 complete+翻转，不通知）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
