import { Module } from '@nestjs/common';
import { DocsSiteController } from './docs-site.controller';
import { PrototypesService } from './prototypes.service';

/**
 * 文档站模块（docs-artifacts-merge T11：磁盘镜像层已退役，DB-only）。
 *
 * - PrototypesService：任务 file 型原型产出物 → DB 直读列表/源码（派生视图，
 *   权威在 DB(artifacts)+uploads，无磁盘写入）；
 * - DocsSiteController：prototypes 纯数据端点（全局 JwtAuthGuard 鉴权 +
 *   团队成员校验）；
 * - 无 JwtModule/cookie 依赖；registry/prd 镜像端点已删除。
 */
@Module({
  controllers: [DocsSiteController],
  providers: [PrototypesService],
})
export class DocsSiteModule {}
