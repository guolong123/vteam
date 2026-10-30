import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * 团队统计看板模块（stats-dashboard）。
 *
 * 注册模式对齐 usage.module.ts：`controllers` 挂控制器、`providers` 挂 service，
 * PrismaService 由全局 PrismaModule（@Global）提供故无需 imports。
 *
 * 无环核验：本模块**不 import 任何业务模块**——它只读 6 张表（tasks / task_events /
 * artifacts / artifact_versions / model_usages / messages + chat_channels），
 * 与 chat、tasks、usage 等模块零运行时耦合，因此不引入新的模块依赖边。
 * 唯一 import 的是 `artifacts/artifacts.constants`（产出物三态词表）与
 * `common/constants/task.constants`（七态状态机）——两者是**纯常量**，无 DI 依赖。
 *
 * 无写端点：本模块只暴露两个 GET，写入链路由各域既有事件落库承担。
 */
@Module({
  controllers: [StatsController],
  providers: [StatsService],
  exports: [StatsService],
})
export class StatsModule {}
