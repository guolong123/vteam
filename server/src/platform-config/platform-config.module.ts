import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { PlatformConfigController } from './platform-config.controller';
import { PlatformConfigService } from './platform-config.service';

/**
 * 平台配置模块（键值配置的读写与校验）。
 *
 * 注册模式对齐 stats.module.ts：`controllers` 挂控制器、`providers` 挂 service。
 * - PrismaService 由全局 PrismaModule（@Global）提供；
 * - IdGeneratorService（`pc_` 主键）由 RealtimeModule 导出——与 chat/tasks/
 *   external-users 共享同一实例，保证进程内序号单源（与既有模块同口径）。
 *
 * 无环核验：本模块只依赖基础设施（Prisma / IdGen / RealtimeModule），
 * 不 import 任何业务模块；被 worker-dispatcher 消费时仅注入 service 实例，
 * 不形成反向模块依赖。
 */
@Module({
  imports: [RealtimeModule],
  controllers: [PlatformConfigController],
  providers: [PlatformConfigService],
  exports: [PlatformConfigService],
})
export class PlatformConfigModule {}
