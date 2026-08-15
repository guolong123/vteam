import { Module } from '@nestjs/common';
import { DocsSiteController } from './docs-site.controller';
import { DocsMirrorService } from './docs-mirror.service';

/**
 * 文档站模块（is_0000000024 · art_0000000039 v4 深度集成）。
 *
 * - DocsMirrorService（F1）：任务 doc 产出物 → 镜像 .md（幂等导出，派生视图）；
 * - DocsSiteController（F2/F4）：registry/prd 纯数据端点（全局 JwtAuthGuard 鉴权 +
 *   项目成员校验）；
 * - 无 JwtModule/cookie 依赖（v4 移除 query token/Set-Cookie/302/代理）；
 * - ArtifactsService 归档成功后经依赖注入触发 DocsMirrorService.syncTask
 *   （ArtifactsModule 侧可选注入，避免循环依赖）。
 */
@Module({
  controllers: [DocsSiteController],
  providers: [DocsMirrorService],
  exports: [DocsMirrorService],
})
export class DocsSiteModule {}
