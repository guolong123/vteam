import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { HeartbeatWorkerDto } from './dto/heartbeat-worker.dto';
import { RegisterWorkerDto } from './dto/register-worker.dto';
import { UpdateWorkerModelDto } from './dto/update-worker-model.dto';
import {
  WorkerTokenGuard,
  WorkerTokenRequest,
} from './worker-token.guard';
import { WorkersService } from './workers.service';
import { DEFAULT_WORKER_TOKEN } from './workers.constants';

/**
 * Worker 控制面端点（T7）。
 * - POST /workers/register、POST /workers/:id/heartbeat：`@Public()` 跳过全局 JWT，
 *   改由 WorkerTokenGuard 做 X-Worker-Token 鉴权（D1：与用户 JWT 隔离）。
 * - GET /workers、GET /workers/:id：用户 JWT + PermissionGuard（workers.view，
 *   09 篇 §3.7 [admin]（运维可见 FR-26）；内置 member 简写 view 放行）。
 * - PATCH /workers/:id：用户 JWT + PermissionGuard（workers.edit，CONF-03 读写守卫
 *   同资源权限点，替代原 AdminGuard 的 users.manage 语义倒挂）。
 * 全局前缀 /api/v1（main.ts 已设置），故实际路由为 /api/v1/workers。
 */
@ApiTags('workers')
@ApiBearerAuth()
@Controller('workers')
export class WorkersController {
  constructor(
    private readonly workers: WorkersService,
    private readonly config: ConfigService,
  ) {}

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

  /**
   * GET /api/v1/workers/register-token：worker 注册 token（workers.view）。
   * 安装向导页生成「复制即成功」的 curl 命令用——脚本需 X_WORKER_TOKEN 与
   * server 的 WORKER_TOKEN 一致，向导页拉取后拼进 --token 参数。
   * 注意：路由须在 @Get(':id') 之前（否则 register-token 被 :id 捕获）。
   */
  @Get('register-token')
  @UseGuards(PermissionGuard)
  @RequirePermission('workers.view')
  @ApiOperation({ summary: 'worker 注册 token（workers.view；安装向导生成命令用）' })
  getRegisterToken() {
    return { token: this.config.get<string>('WORKER_TOKEN', DEFAULT_WORKER_TOKEN) };
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
   * PATCH /api/v1/workers/:id：配置 worker 默认模型 / 全局默认标记（C8 + 默认 worker，workers.edit）。
   * body {defaultModelId: string | null, isDefault?: boolean}——defaultModelId 须存在于 models
   * 目录且 enabled（否则 400），null=清除；isDefault true=设为全局默认（自动取消其他 worker）、
   * false=取消默认、缺省=不更新；返回更新后的 WorkerView（含 isDefault）。
   */
  @Patch(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('workers.edit')
  @ApiOperation({ summary: '配置 worker 默认模型 / 全局默认标记（workers.edit）' })
  async update(@Param('id') id: string, @Body() dto: UpdateWorkerModelDto) {
    let view = await this.workers.updateDefaultModel(id, dto);
    if (dto.isDefault !== undefined) {
      view = await this.workers.setDefaultWorker(id, dto.isDefault);
    }
    return view;
  }

  /**
   * POST /api/v1/workers/:id/restart：远程重启（UX-01，workers.edit）。
   * worker 独立进程/容器，server 无进程控制能力——命令经心跳下行下发，
   * worker 侧 RestartCoordinator 重启 serve（无活跃会话立即、有则挂起）。
   */
  @Post(':id/restart')
  @UseGuards(PermissionGuard)
  @RequirePermission('workers.edit')
  @ApiOperation({ summary: '重启 worker（workers.edit；经心跳命令下发）' })
  requestRestart(@Param('id') id: string) {
    return this.workers.requestRestart(id);
  }

  /**
   * POST /api/v1/workers/:id/shutdown：远程下线（UX-01，workers.edit）。
   * 立即标 offline（调度器停止分配）+ 心跳命令触发 worker 优雅退出。
   */
  @Post(':id/shutdown')
  @UseGuards(PermissionGuard)
  @RequirePermission('workers.edit')
  @ApiOperation({ summary: '下线 worker（workers.edit；立即标 offline + 心跳命令下发）' })
  requestShutdown(@Param('id') id: string) {
    return this.workers.requestShutdown(id);
  }

  /**
   * DELETE /api/v1/workers/:id：删除离线 worker（workers.delete）。
   * 仅 offline 可删（online/degraded → 409 WORKER_ONLINE_NOT_REMOVABLE）；
   * 事务内清理全部 workerId 关联后物理删除（sessions/agents 置空、availability/instances 硬删）。
   */
  @Delete(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('workers.delete')
  @ApiOperation({ summary: '删除离线 worker（workers.delete；仅 offline 可删）' })
  remove(@Param('id') id: string) {
    return this.workers.remove(id);
  }
}
