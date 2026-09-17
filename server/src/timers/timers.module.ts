import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { TriggerReconcilerService } from '../triggers/trigger-reconciler.service';
import { TriggerService } from './trigger.service';
import { TriggersController } from './triggers.controller';
import { TriggersService } from './triggers.service';

/**
 * 通用触发器模块（generic-trigger 基础设施，前身 generic-timer）。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule
 * 导出（共享同一 id 生成器实例，`tmr_` 前缀冻结，对齐
 * tools/tools.module.ts 注释模式）。
 * REST：TriggersController（GET 列表 + DELETE 取消，todo-22，
 * /system/triggers 与团队会话触发 Tab 底座；owner/admin 复核在
 * TriggersService 内逐行执行）+ 编程式 TriggerService.schedule/
 * registerHandler/fireDue（消费者接入不变）。
 * TimerService 与 TriggerService 同引用，旧 token 注入零改动继续工作。
 * 自愈：TriggerReconcilerService（trigger-unification todo-3，启动即跑 +
 * 15min 周期，hook↔trigger 孤儿双向修复；仅依赖 Prisma/IdGen/Realtime，
 * 不依赖 HookService，无循环依赖）。
 */
@Module({
  imports: [RealtimeModule],
  controllers: [TriggersController],
  providers: [TriggerService, TriggersService, TriggerReconcilerService],
  exports: [TriggerService],
})
export class TimersModule {}

// 旧名重导出：按 token 注入的旧消费者（@Inject(TimerService)）类型位可用。
export { TimerService } from './trigger.service';
