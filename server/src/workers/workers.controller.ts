import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { HeartbeatWorkerDto } from './dto/heartbeat-worker.dto';
import { RegisterWorkerDto } from './dto/register-worker.dto';
import {
  WorkerTokenGuard,
  WorkerTokenRequest,
} from './worker-token.guard';
import { WorkersService } from './workers.service';

/**
 * Worker 控制面端点（T7）。
 * - POST /workers/register、POST /workers/:id/heartbeat：`@Public()` 跳过全局 JWT，
 *   改由 WorkerTokenGuard 做 X-Worker-Token 鉴权（D1：与用户 JWT 隔离）。
 * - GET /workers、GET /workers/:id：用户 JWT 保护（全局 JwtAuthGuard 默认生效）。
 * 全局前缀 /api/v1（main.ts 已设置），故实际路由为 /api/v1/workers。
 */
@ApiTags('workers')
@ApiBearerAuth()
@Controller('workers')
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  /**
   * POST /api/v1/workers/register：worker 注册（X-Worker-Token 鉴权）。
   * guard 校验通过后把 token 挂到 request.workerToken，落库 tokenHash。
   */
  @Public()
  @UseGuards(WorkerTokenGuard)
  @Post('register')
  @ApiOperation({ summary: 'worker 注册（X-Worker-Token 鉴权）' })
  register(@Req() req: WorkerTokenRequest, @Body() dto: RegisterWorkerDto) {
    return this.workers.register(req.workerToken!, dto);
  }

  /** POST /api/v1/workers/:id/heartbeat：心跳（X-Worker-Token 鉴权 + F2 M2 tokenHash 比对）。 */
  @Public()
  @UseGuards(WorkerTokenGuard)
  @Post(':id/heartbeat')
  @ApiOperation({ summary: 'worker 心跳（X-Worker-Token 鉴权）' })
  heartbeat(
    @Param('id') id: string,
    @Req() req: WorkerTokenRequest,
    @Body() dto: HeartbeatWorkerDto,
  ) {
    return this.workers.heartbeat(id, dto, req.workerToken);
  }

  /** GET /api/v1/workers：worker 列表（用户 JWT 保护）。 */
  @Get()
  @ApiOperation({ summary: 'worker 列表' })
  findAll() {
    return this.workers.findAll();
  }

  /** GET /api/v1/workers/:id：worker 详情（用户 JWT 保护）。 */
  @Get(':id')
  @ApiOperation({ summary: 'worker 详情' })
  findOne(@Param('id') id: string) {
    return this.workers.findOne(id);
  }
}
