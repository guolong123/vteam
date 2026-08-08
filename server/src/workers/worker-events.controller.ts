import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { WorkerEventDto } from './dto/worker-event.dto';
import { WorkerTokenGuard } from './worker-token.guard';
import { WorkerEventIngress } from './worker-event.ingress';

/**
 * Worker 事件回流端点（T9，架构决策 D1 全 push 三通道之事件回调）。
 *
 * - `POST /api/v1/worker/events`：worker 上送事件（X-Worker-Token 鉴权，与用户 JWT 隔离）。
 * - `@Public()` 跳过全局 JwtAuthGuard，改由 WorkerTokenGuard 独立把关（对齐
 *   register/heartbeat 端点模式，见 workers.controller.ts）。
 * - 恒 202 Accepted：事件回流尽力而为（幂等 + 内存去重 D4），各事件语义转换在
 *   WorkerEventIngress 内吞错记日志，不因单个事件失败影响 worker 重试语义。
 * - 路由路径为 `worker/events`（单数 worker），与 worker 侧 EventSender
 *   `{serverUrl}/api/v1/worker/events` 严格对齐（T6 实测 URL）。
 */
@ApiTags('worker')
@Controller('worker')
export class WorkerEventsController {
  constructor(private readonly ingress: WorkerEventIngress) {}

  @Public()
  @UseGuards(WorkerTokenGuard)
  @Post('events')
  @HttpCode(202)
  @ApiOperation({ summary: 'worker 事件回流（X-Worker-Token 鉴权，幂等去重）' })
  async events(@Body() dto: WorkerEventDto): Promise<void> {
    await this.ingress.handleEvent(dto);
  }
}
