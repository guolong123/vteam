import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactsMockConsumer } from './artifacts-mock-consumer';
import { ArtifactsService } from './artifacts.service';

/**
 * 产出物模块（Phase 3 骨架，09 篇 §3.4 Artifacts / 11 篇 产出物域）。
 *
 * - PrismaService 由全局 PrismaModule 提供；
 * - RealtimeService + IdGeneratorService 由 RealtimeModule 导出（共享同一 id 生成器实例）；
 * - ArtifactsMockConsumer 模拟 Phase 4 worker 归档回流（simulateSubmission 触发式广播
 *   `artifact.submitted`），本任务只广播不落库；T6 归档链路消费事件后落库，
 *   T14 测试经此触发事件。
 */
@Module({
  imports: [RealtimeModule],
  controllers: [ArtifactsController],
  providers: [ArtifactsService, ArtifactsMockConsumer],
  exports: [ArtifactsService, ArtifactsMockConsumer],
})
export class ArtifactsModule {}
