import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../projects/current-user.decorator';
import {
  DOCS_SITE_ERRORS,
} from './docs-site.constants';
import { DocsMirrorService } from './docs-mirror.service';

/**
 * 文档站数据端点（is_0000000024 · art_0000000039 v4 深度集成）。
 *
 * 深度集成形态：文档浏览/渲染组件内嵌 web（DocExplorer 移植），server 不再提供
 * 工具页 HTML/代理 upstream/cookie 换 token——web 组件经现有 `api.get`（Authorization
 * 头）直接调用本控制器的**纯数据端点**（registry + prd）。v3 的 query token/Set-Cookie/
 * 302/shell 全部移除，鉴权回归标准 JWT（全局 JwtAuthGuard）+ 项目成员校验。
 *
 * 端点（路径均为 /api/v1 前缀，main.ts 全局前缀）：
 * - GET /docs-site/:taskId/registry     → 动态 DocDef[]（任务 doc 产出物，AC-3 文档树）
 * - GET /docs-site/:taskId/prd/<file>   → 镜像 .md 内容（taskId 子树白名单 + 路径穿越防护）
 * - GET /docs-site/:taskId/prototypes       → 原型 DSL 列表 { items: [{id, name, file}] }
 * - GET /docs-site/:taskId/prototypes/<file> → 原型 DSL JSON 内容（文件白名单防路径穿越）
 *
 * 鉴权：全局 JwtAuthGuard 要求合法 access token；本控制器按 taskId → projectId →
 * 项目成员校验（AC-2 越权 401/403）。taskId 白名单 + 文件名白名单防路径穿越/跨任务。
 */
@Controller('docs-site')
export class DocsSiteController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mirror: DocsMirrorService,
  ) {}

  /** 动态注册表 GET /docs-site/:taskId/registry → DocDef[]。 */
  @Get(':taskId/registry')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async registry(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    await this.assertMember(taskId, user.id);
    return this.mirror.buildRegistry(taskId);
  }

  /** 镜像文档内容 GET /docs-site/:taskId/prd/:file。 */
  @Get(':taskId/prd/:file')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  async prd(
    @Param('taskId') taskId: string,
    @Param('file') file: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<string> {
    await this.assertMember(taskId, user.id);
    const content = await this.mirror.readMirrorDoc(taskId, file);
    if (content === null) {
      throw new NotFoundException({
        code: DOCS_SITE_ERRORS.DOC_NOT_FOUND,
        message: `文档不存在: ${file}`,
      });
    }
    return content;
  }

  /** 原型 DSL 列表 GET /docs-site/:taskId/prototypes → { items: [{id, name, file}] }。 */
  @Get(':taskId/prototypes')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async prototypes(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ items: Array<{ id: string; name: string; file: string }> }> {
    await this.assertMember(taskId, user.id);
    return { items: await this.mirror.listPrototypes(taskId) };
  }

  /** 原型 DSL 内容 GET /docs-site/:taskId/prototypes/:file → DSL JSON。 */
  @Get(':taskId/prototypes/:file')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async prototypeContent(
    @Param('taskId') taskId: string,
    @Param('file') file: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<string> {
    await this.assertMember(taskId, user.id);
    const content = await this.mirror.readPrototype(taskId, file);
    if (content === null) {
      throw new NotFoundException({
        code: DOCS_SITE_ERRORS.DOC_NOT_FOUND,
        message: `原型不存在: ${file}`,
      });
    }
    return content;
  }

  /** 鉴权：taskId 白名单 → 任务存在 → 项目成员（AC-2 越权 401/403）。 */
  private async assertMember(taskId: string, userId: string): Promise<void> {
    if (!/^t_[a-zA-Z0-9_]+$/.test(taskId)) {
      throw new BadRequestException({
        code: DOCS_SITE_ERRORS.PATH_OUT_OF_BOUNDS,
        message: '非法 taskId',
      });
    }
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: DOCS_SITE_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const member = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: task.projectId, userId },
      },
    });
    if (!member) {
      throw new ForbiddenException({
        code: DOCS_SITE_ERRORS.FORBIDDEN,
        message: '您不是该项目成员，无权访问该任务文档站',
      });
    }
  }
}
