import { Module } from '@nestjs/common';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { DocsSiteModule } from '../docs-site/docs-site.module';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';

/**
 * 产出物模块（Phase 3 骨架，09 篇 §3.4 Artifacts / 11 篇 产出物域）。
 *
 * - PrismaService 由全局 PrismaModule 提供；
 * - RealtimeService + IdGeneratorService 由 RealtimeModule 导出（共享同一 id 生成器实例）；
 * - 归档回流由真实 worker 链路（worker-dispatcher / platform-mcp submit_artifact）完成；
 *   T6 归档链路消费事件后落库。
 * - PermissionGuard（CONF-02 方案②补齐矩阵守卫）：端点叠加 artifacts.view/create。
 */
@Module({
  imports: [RealtimeModule, DocsSiteModule],
  controllers: [ArtifactsController],
  providers: [ArtifactsService, PermissionGuard],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
