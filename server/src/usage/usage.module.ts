import { Module } from '@nestjs/common';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

/**
 * 团队用量模块（token-usage-stats Todo 4）。
 *
 * 注册模式对齐 memories.module.ts：`controllers` 挂控制器、`providers` 挂 service，
 * PrismaService 由全局 PrismaModule（@Global）提供故无需 imports。
 *
 * 无环核验：本模块**不 import 任何业务模块**——它只读 `model_usage` /
 * `team_user_members` / `team_members` 三张表（后者经 Prisma 关系联表取
 * Agent 名 / Role 名），与 chat/worker-dispatcher、memories 等模块零耦合，
 * 因此不存在新的模块依赖边（app.module 单向引用本模块）。
 *
 * 无写端点：本模块只暴露一个 GET 聚合端点，写入链路仅由 worker 事件落库承担。
 */
@Module({
  controllers: [UsageController],
  providers: [UsageService],
})
export class UsageModule {}
