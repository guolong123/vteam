import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { IssuesController } from './issues.controller';
import { IssuesService } from './issues.service';
import { ReviewRoundGateService } from './review-round-gate.service';
import { ReviewRoundService } from './review-round.service';
import { ReviewVerdictListener } from './review-verdict.listener';

/**
 * Issue 模块（issue-management plan todo 2）。
 *
 * - PrismaService 由全局 PrismaModule 提供；
 * - RealtimeService + IdGeneratorService 由 RealtimeModule 导出（共享同一 id 生成器实例）；
 * - 权限：不挂 AdminGuard（任务成员可管理自己的任务 issue）、不挂 TeamMembershipGuard
 *   （:id 会误解析为 taskId，Metis M2）——成员校验在 IssuesService 内完成，
 *   鉴权依赖全局 JwtAuthGuard（APP_GUARD）。
 */
@Module({
  imports: [RealtimeModule],
  controllers: [IssuesController],
  // ReviewRoundService（todo 6 串行写）+ ReviewRoundGateService（todo 7 收敛门）：
  // 纯账本/门裁决，不建 review_rounds 表；notifier 缺省 null（生产由调用方
  // 传入 WorkerDispatcher 作 ConvergenceNotifier，kind=wake 复用 todo 4 豁免路径）。
  providers: [
    IssuesService,
    ReviewRoundService,
    ReviewRoundGateService,
    ReviewVerdictListener,
  ],
  exports: [IssuesService, ReviewRoundService, ReviewRoundGateService],
})
export class IssuesModule {}
