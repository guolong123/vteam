import { Module } from '@nestjs/common';
import { ModelsModule } from '../models/models.module';
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
 * ModelsModule（C3）：available-models 目录优先数据源（listCatalogModels，enabled=true）。
 */
@Module({
  imports: [RealtimeModule, WorkersModule, ModelsModule],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
