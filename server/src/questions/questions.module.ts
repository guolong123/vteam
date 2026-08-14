import { Module } from '@nestjs/common';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';

/**
 * 模型提问 / 工具权限确认模块。
 * - PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 *   （共享同一 id 生成器实例，aq_ 前缀续号）；
 * - WorkersModule：导出 WorkerClient（reply 链路调 worker /question-reply 转发）；
 * - PermissionGuard 本模块注册供编译期解析（app.module 已全局注册，仿 workers/git-repos）。
 */
@Module({
  imports: [RealtimeModule, WorkersModule],
  controllers: [QuestionsController],
  providers: [QuestionsService, PermissionGuard],
  exports: [QuestionsService],
})
export class QuestionsModule {}
