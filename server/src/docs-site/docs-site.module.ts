import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { DocsSiteController } from './docs-site.controller';
import { DocsMirrorService } from './docs-mirror.service';

/**
 * 文档站模块（is_0000000024）。
 *
 * - DocsMirrorService（F1）：任务 doc 产出物 → 镜像 .md（幂等导出，派生视图）；
 * - DocsSiteController（F4+F2）：鉴权代理 + 动态注册表 + 镜像内容；
 * - JwtModule：控制器手动校验 access token（query 换 cookie 的整页导航场景）；
 * - ArtifactsService 归档成功后经内部事件触发 DocsMirrorService.syncTask
 *   （在 ArtifactsModule 侧以依赖注入 + 可选注入方式接线，避免循环依赖）。
 */
@Module({
  imports: [ConfigModule, JwtModule.register({})],
  controllers: [DocsSiteController],
  providers: [DocsMirrorService],
  exports: [DocsMirrorService],
})
export class DocsSiteModule {}
