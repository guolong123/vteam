import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { DOCS_SITE_ERRORS } from './docs-site.constants';
import { PrototypesService } from './prototypes.service';

/**
 * 文档站数据端点（docs-artifacts-merge T11：磁盘镜像层已退役，DB-only）。
 *
 * 形态：web 合站页经现有 `api.get`（Authorization 头）直接调用本控制器的
 * **纯数据端点**（prototypes 原型列表/源码）。T11 前的 registry/prd 镜像端点
 * 已删除（T8 合站页只读团队聚合端点 + artifacts 详情/版本端点）。
 *
 * 端点（路径均为 /api/v1 前缀，main.ts 全局前缀）：
 * - GET /docs-site/:taskId/prototypes       → 原型列表 { items: [{id, name, file}] }
 * - GET /docs-site/:taskId/prototypes/<file> → 原型源码（TSX / DSL JSON，文件白名单防路径穿越）
 *
 * 鉴权：全局 JwtAuthGuard 要求合法 access token；本控制器按 taskId → teamId →
 * teamUserMember 团队成员校验（AC-2 越权 401/403）。taskId 白名单 + 文件名白名单防路径穿越/跨任务。
 */
@ApiTags('docs-site')
@Controller('docs-site')
export class DocsSiteController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly protoService: PrototypesService,
  ) {}

  /** 原型列表 GET /docs-site/:taskId/prototypes → { items: [{id, name, file}] }。 */
  @Get(':taskId/prototypes')
  @ApiOperation({ summary: '任务原型列表' })
  @Header('Content-Type', 'application/json; charset=utf-8')
  async prototypes(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ items: Array<{ id: string; name: string; file: string }> }> {
    await this.assertMember(taskId, user.id);
    return { items: await this.protoService.listPrototypes(taskId) };
  }

  /** 原型源码内容 GET /docs-site/:taskId/prototypes/<file> → TSX / DSL JSON 文本。 */
  @Get(':taskId/prototypes/*')
  @ApiOperation({ summary: '读取任务原型源码' })
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async prototypeContent(
    @Param('taskId') taskId: string,
    @Param('0') filePath: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<string> {
    await this.assertMember(taskId, user.id);
    const content = await this.protoService.readPrototype(taskId, filePath);
    if (content === null) {
      throw new NotFoundException({
        code: DOCS_SITE_ERRORS.DOC_NOT_FOUND,
        message: `原型不存在: ${filePath}`,
      });
    }
    return content;
  }

  /** 鉴权：taskId 白名单 → 任务存在 → 团队成员（AC-2 越权 401/403）。 */
  private async assertMember(taskId: string, userId: string): Promise<void> {
    if (!/^t_[a-zA-Z0-9_]+$/.test(taskId)) {
      throw new BadRequestException({
        code: DOCS_SITE_ERRORS.PATH_OUT_OF_BOUNDS,
        message: '非法 taskId',
      });
    }
    const task = await (this.prisma as any).task.findUnique({
      where: { id: taskId },
      select: { teamId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: DOCS_SITE_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    // channel → taskId → teamId → teamUserMember：任务归属团队即授权域。
    const member = await (this.prisma as any).teamUserMember.findUnique({
      where: {
        teamId_userId: { teamId: task.teamId, userId },
      },
    });
    if (!member) {
      throw new ForbiddenException({
        code: DOCS_SITE_ERRORS.FORBIDDEN,
        message: '您不是该团队成员，无权访问该任务文档站',
      });
    }
  }
}
