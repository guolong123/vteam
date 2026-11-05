import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { HeartbeatWorkerDto } from './dto/heartbeat-worker.dto';
import { RegisterWorkerDto } from './dto/register-worker.dto';
import { UpdateWorkerModelDto } from './dto/update-worker-model.dto';
import { WorkerClient } from './worker.client';
import { WorkerTokenGuard, WorkerTokenRequest } from './worker-token.guard';
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
 * - POST /workers/:id/restart|shutdown|update：用户 JWT + PermissionGuard（workers.edit）——
 *   与 PATCH :id 同级：管理型动作一律走权限点，不与 @Public 的 worker 侧通道混用。
 * 全局前缀 /api/v1（main.ts 已设置），故实际路由为 /api/v1/workers。
 */
/** 预览端点允许读取的图片扩展名（见 getWorkerImage 的安全边界说明）。 */
const PREVIEW_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** 扩展名 → Content-Type。 */
const PREVIEW_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 单张预览图上限：超过直接 413。 */
const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/** capabilities 归一：对象原样、JSON 字符串解析、其它 → undefined。 */
function parseCapabilities(raw: unknown): Record<string, unknown> | undefined {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch (err) {
      // 非法 JSON（脏数据）→ 按"无该字段"降级，不抛错
      void err;
      return undefined;
    }
  }
  return undefined;
}

@ApiTags('workers')
@ApiBearerAuth()
@Controller('workers')
export class WorkersController {
  constructor(
    private readonly workers: WorkersService,
    private readonly config: ConfigService,
    private readonly workerClient: WorkerClient,
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
  @ApiOperation({
    summary: 'worker 注册 token（workers.view；安装向导生成命令用）',
  })
  getRegisterToken() {
    return {
      token: this.config.get<string>('WORKER_TOKEN', DEFAULT_WORKER_TOKEN),
    };
  }

  /**
   * GET /api/v1/workers/file?path=<绝对路径>：**预览 worker 工作区里的图片**。
   *
   * 用途：agent 用工具读了一张截图时（DSH 的 `read` 对图片只返回
   * `<path>…</path><type>image</type><content>image/png image, 1440x900 px, …</content>`
   * 这样的**描述**，不带字节），前端要渲染缩略图就得有 URL —— 本端点提供。
   *
   * 安全边界（刻意的，别放宽）：
   * - **只允许图片扩展名**（png/jpg/jpeg/gif/webp）⇒ 读不到 .env / 私钥 / 数据库；
   * - 必须是绝对路径、不含 NUL；
   * - 单文件 ≤ 10MB，超限 413；
   * - 仍走用户 JWT + `workers.view` 权限点（与其它 worker 管理端点同级）。
   *
   * 为什么逐个 worker 试读：消息 DTO 没有 workerId，无法直接定位是哪个节点读的；
   * worker 数量是个位数，代价可接受。若后续把 workerId 写进 tool part 可退化为定向读。
   *
   * ⚠️ 路由必须排在 `@Get(':id')` 之前，否则 'file' 会被 :id 捕获。
   */
  @Get('file')
  @UseGuards(PermissionGuard)
  @RequirePermission('workers.view')
  @ApiOperation({ summary: '预览 worker 工作区里的图片（工具读图的缩略图）' })
  async getWorkerImage(
    @Query('path') path: string,
    @Res() res: Response,
  ): Promise<void> {
    const target = (path ?? '').trim();
    if (!target.startsWith('/') || target.includes('\0')) {
      res
        .status(400)
        .json({ code: 'BAD_PATH', message: 'path 必须是绝对路径' });
      return;
    }
    const ext = target.slice(target.lastIndexOf('.') + 1).toLowerCase();
    if (!PREVIEW_IMAGE_EXTS.has(ext)) {
      res.status(400).json({
        code: 'UNSUPPORTED_TYPE',
        message: '仅支持预览图片（png/jpg/jpeg/gif/webp）',
      });
      return;
    }

    const workers = await this.workers.findAll();
    for (const worker of workers) {
      if (worker.status === 'offline') continue;
      try {
        // ⚠️ 必须把 capabilities 一起带上：执行端点基址（HTTP 主机 + execPort）
        // 只存在于 capabilities 里，只传 { id } 会让 WorkerClient 解析不到地址
        // （回退成 `http://:4198`，请求必然失败 → 一律 404）。
        // ⚠️ **必须用 findOne 而不是 findAll 的视图**：findAll 是刻意的轻量摘要，
        // 其 capabilities 结构里**不含 baseUrl / execPort / port**（见 findAll 注释），
        // 拿它去解析执行基址只会拼出 `http://:4198` ⇒ 请求必失败 ⇒ 一律 404。
        // findOne 返回完整 capabilities（只剥 models），才有 baseUrl/execPort。
        const detail = await this.workers.findOne(worker.id);
        const buffer = await this.workerClient.fetchFile(
          {
            id: worker.id,
            capabilities: parseCapabilities(detail.capabilities),
          },
          target,
        );
        if (buffer.length === 0) continue;
        if (buffer.length > PREVIEW_MAX_BYTES) {
          res.status(413).json({
            code: 'FILE_TOO_LARGE',
            message: `图片超过 ${Math.floor(PREVIEW_MAX_BYTES / 1024 / 1024)}MB 上限`,
          });
          return;
        }
        res.setHeader(
          'Content-Type',
          PREVIEW_IMAGE_MIME[ext] ?? 'application/octet-stream',
        );
        res.setHeader('Content-Length', String(buffer.length));
        // 同路径内容基本不变（截图是新增文件），短暂缓存足够
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(buffer);
        return;
      } catch (err) {
        // 该节点没有这个文件 / 节点不可用 → 试下一个；失败原因不改变语义
        void err;
        continue;
      }
    }
    res.status(404).json({
      code: 'FILE_NOT_FOUND',
      message: 'worker 上找不到该图片（或节点不可用）',
    });
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
   * PATCH /api/v1/workers/:id：配置/清除 worker 默认模型（C8）+ 改并发上限（workers.edit）。
   * body {defaultModelId?: string | null, maxInstances?: number | null}——
   * defaultModelId 非空须存在于 models 目录且 enabled（否则 400），null=清除；
   * maxInstances（1..64，null=不修改）写 capabilities 并经心跳命令下发 worker。
   * 返回更新后的 WorkerView。
   */
  @Patch(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('workers.edit')
  @ApiOperation({
    summary:
      '配置 worker 默认模型 / 并发上限（workers.edit；null=清除/不修改）',
  })
  updateDefaultModel(
    @Param('id') id: string,
    @Body() dto: UpdateWorkerModelDto,
  ) {
    return this.workers.updateDefaultModel(id, dto);
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
   * POST /api/v1/workers/:id/update：下发自更新指令（worker-self-update，workers.edit）。
   *
   * 守卫对齐本控制器既有**管理型**端点（PATCH :id / POST :id/restart / POST :id/shutdown），
   * 即用户 JWT + PermissionGuard(workers.edit)——**刻意不是 @Public**：register/heartbeat
   * 公开是因为它们走 X-Worker-Token 鉴权，而本端点是纯管理员动作，任何能拿到共享
   * worker token 的进程都不该有权让别人的机器换码重启。
   *
   * 无请求体（更新目标版本由 server env CODE_VERSION 唯一决定，不接受客户端指定版本：
   * 否则一个越权请求就能把 worker 钉到任意版本）。响应 `{status:'pending', version}`。
   */
  @Post(':id/update')
  @UseGuards(PermissionGuard)
  @RequirePermission('workers.edit')
  @ApiOperation({
    summary:
      '下发 worker 自更新指令（workers.edit；经心跳命令下发，空闲后执行）',
  })
  requestUpdate(@Param('id') id: string) {
    return this.workers.requestUpdate(id);
  }

  /**
   * POST /api/v1/workers/:id/shutdown：远程下线（UX-01，workers.edit）。
   * 立即标 offline（调度器停止分配）+ 心跳命令触发 worker 优雅退出。
   */
  @Post(':id/shutdown')
  @UseGuards(PermissionGuard)
  @RequirePermission('workers.edit')
  @ApiOperation({
    summary: '下线 worker（workers.edit；立即标 offline + 心跳命令下发）',
  })
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
  @ApiOperation({
    summary: '删除离线 worker（workers.delete；仅 offline 可删）',
  })
  remove(@Param('id') id: string) {
    return this.workers.remove(id);
  }
}
