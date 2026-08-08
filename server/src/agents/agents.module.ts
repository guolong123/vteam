import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * Agent 模块：列表/详情 + 完整 CRUD（Phase 3 T5）。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 * （共享同一 id 生成器实例，与 tasks/chat/artifacts 同源）。
 * WorkersModule（T7/T8 已 export WorkersService + WorkerClient）：T11 available-models
 * 经 Scheduler.assignWorker + WorkerClient.listModels 动态获取。
 */
@Module({
  imports: [RealtimeModule, WorkersModule],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
