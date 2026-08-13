import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { IssuesController } from './issues.controller';
import { IssuesService } from './issues.service';

/**
 * Issue 模块（issue-management plan todo 2）。
 *
 * - PrismaService 由全局 PrismaModule 提供；
 * - RealtimeService + IdGeneratorService 由 RealtimeModule 导出（共享同一 id 生成器实例）；
 * - 权限：不挂 AdminGuard（任务成员可管理自己的任务 issue）、不挂 ProjectMembershipGuard
 *   （:id 会误解析为 taskId，Metis M2）——成员校验在 IssuesService 内完成，
 *   鉴权依赖全局 JwtAuthGuard（APP_GUARD）。
 */
@Module({
  imports: [RealtimeModule],
  controllers: [IssuesController],
  providers: [IssuesService],
  exports: [IssuesService],
})
export class IssuesModule {}
