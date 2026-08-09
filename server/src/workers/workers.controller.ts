import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { AdminGuard } from '../users/admin.guard';
import { HeartbeatWorkerDto } from './dto/heartbeat-worker.dto';
import { RegisterWorkerDto } from './dto/register-worker.dto';
import { UpdateWorkerModelDto } from './dto/update-worker-model.dto';
import {
  WorkerTokenGuard,
  WorkerTokenRequest,
} from './worker-token.guard';
import { WorkersService } from './workers.service';

/**
 * Worker 控制面端点（T7）。
 * - POST /workers/register、POST /workers/:id/heartbeat：`@Public()` 跳过全局 JWT，
 *   改由 WorkerTokenGuard 做 X-Worker-Token 鉴权（D1：与用户 JWT 隔离）。
 * - GET /workers、GET /workers/:id：用户 JWT + PermissionGuard（workers.view，
 *   09 篇 §3.7 [admin]（运维可见 FR-26）；内置 member 简写 view 放行）。
 * - PATCH /workers/:id：AdminGuard（写操作）。
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

  /** GET /api/v1/workers：worker 列表（用户 JWT + workers.view 权限）。 */
  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('workers.view')
  @ApiOperation({ summary: 'worker 列表' })
  findAll() {
    return this.workers.findAll();
  }

  /** GET /api/v1/workers/:id：worker 详情（用户 JWT + workers.view 权限）。 */
  @Get(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('workers.view')
  @ApiOperation({ summary: 'worker 详情' })
  findOne(@Param('id') id: string) {
    return this.workers.findOne(id);
  }

  /**
   * PATCH /api/v1/workers/:id：配置/清除 worker 默认模型（C8，AdminGuard）。
   * body {defaultModelId: string | null}——须存在于 models 目录且 enabled（否则 400），
   * null=清除；返回更新后的 WorkerView（含 defaultModelId）。
   */
  @Patch(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '配置 worker 默认模型（AdminGuard；null=清除）' })
  updateDefaultModel(@Param('id') id: string, @Body() dto: UpdateWorkerModelDto) {
    return this.workers.updateDefaultModel(id, dto);
  }
}
