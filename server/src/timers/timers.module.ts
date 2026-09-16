import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { TimerService } from './timer.service';

/**
 * 通用定时器模块（generic-timer 基础设施）。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule
 * 导出（共享同一 id 生成器实例，`tmr_` 前缀与 t/m/s 同源，对齐
 * tools/tools.module.ts 注释模式）。无 controller——消费者经
 * TimerService.schedule/registerHandler/fireDue 编程式接入。
 */
@Module({
  imports: [RealtimeModule],
  providers: [TimerService],
  exports: [TimerService],
})
export class TimersModule {}
