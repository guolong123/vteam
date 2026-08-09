import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { SKILL_ERRORS } from '../common/constants/skill.constants';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { AdminGuard } from '../users/admin.guard';
import { WorkerOrJwtGuard } from '../workers/worker-or-jwt.guard';
import { QuerySkillsDto } from './dto/query-skills.dto';
import { UpdateSkillStatusDto } from './dto/update-skill-status.dto';
import {
  parseSkillMarkdown,
  UploadedSkillFile,
} from './skill-frontmatter.util';
import { SkillsService } from './skills.service';

/** SKILL.md 单文件上传上限（内存存储，frontmatter + 正文通常 < 100KB）。 */
const SKILL_FILE_SIZE_LIMIT = 100 * 1024;

/**
 * Skill 端点（T1 重构对齐 09 篇 §3.8）。
 * - POST /api/v1/skills：multipart/form-data 上传 SKILL.md（FileInterceptor，内存存储）→ 201 默认停用
 * - GET /api/v1/skills：enabled 过滤 + 分页；成员只读可见已启用，admin 全量
 * - GET /api/v1/skills/:id/content：SKILL.md 全文（T4b worker 注入拉取；X-Worker-Token 或用户 JWT）
 * - PATCH /api/v1/skills/:id/status：{enabled} 启停专用端点
 * - 无 DELETE（09 §3.8 不提供；停用 enabled=false 替代物理删除）
 * 鉴权：全局 JwtAuthGuard（APP_GUARD）兜底认证；POST/PATCH 管理端点加 AdminGuard（复用 users/admin.guard.ts）；
 * 读取端点（GET /、GET /:id/content）挂 @Public() + WorkerOrJwtGuard + PermissionGuard——
 * worker 可用 X-Worker-Token 拉取（WorkerOrJwtGuard 挂 request.workerToken，PermissionGuard 放行），
 * 用户走 JWT + skills.view 权限点（ISSUE-006：8 资源矩阵「技能工具」行，受限角色无 skills.view 则 403）。
 */
@ApiTags('skills')
@ApiBearerAuth()
@Controller('skills')
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  /**
   * 技能列表（enabled 过滤 + name 搜索 + 分页）。
   * GET /api/v1/skills?enabled=true&name=git&page=1&pageSize=20 → 200 {items, total, page, pageSize}
   * 成员只读：service 内强制 enabled=true；admin 遵循 query.enabled（缺省全量）。
   * worker（X-Worker-Token）拉取：service viewer 为空不强制过滤，显式带 enabled=true 即只取启用技能。
   */
  @Public()
  @UseGuards(WorkerOrJwtGuard, PermissionGuard)
  @RequirePermission('skills.view')
  @Get()
  @ApiOperation({ summary: '技能列表（enabled 过滤 + 分页；成员只读可见已启用）' })
  findAll(@Query() query: QuerySkillsDto, @Req() req: Request) {
    const viewer = req.user as { id?: string } | undefined;
    return this.skillsService.findAll(
      query,
      viewer?.id ? { id: viewer.id } : undefined,
    );
  }

  /**
   * 技能 SKILL.md 全文（T4b worker 注入拉取：GET /skills（enabled=true）→ 逐个拉 content → 写盘）。
   * GET /api/v1/skills/:id/content → 200 {id, name, content}；不存在 → 404 SKILL_NOT_FOUND。
   * 鉴权：X-Worker-Token 或用户 JWT 任一通过即可（skill 内容本身是下发到 worker/模型的指令文本）。
   */
  @Public()
  @UseGuards(WorkerOrJwtGuard, PermissionGuard)
  @RequirePermission('skills.view')
  @Get(':id/content')
  @ApiOperation({ summary: '技能 SKILL.md 全文（worker 注入拉取）' })
  findContent(@Param('id') id: string) {
    return this.skillsService.findContent(id);
  }

  /**
   * 上传 SKILL.md 注册技能（multipart/form-data，默认停用）。
   * POST /api/v1/skills（file 字段）→ 201 + Skill 对象；
   * 缺 file → 400 SKILL_FILE_REQUIRED；frontmatter 非法 → 400 SKILL_FRONTMATTER_INVALID；
   * name 重复 → 409 SKILL_NAME_EXISTS。
   */
  @Post()
  @UseGuards(AdminGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: SKILL_FILE_SIZE_LIMIT },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'SKILL.md 技能包' } },
    },
  })
  @ApiOperation({ summary: '上传 SKILL.md 注册技能（multipart，默认停用）' })
  create(@UploadedFile() file: UploadedSkillFile | undefined) {
    if (!file) {
      throw new BadRequestException({
        code: SKILL_ERRORS.SKILL_FILE_REQUIRED,
        message: '缺少 file 文件（SKILL.md 技能包）',
      });
    }
    const raw = file.buffer.toString('utf-8');
    const { frontmatter, content } = parseSkillMarkdown(raw);
    return this.skillsService.create({ frontmatter, content, file });
  }

  /**
   * 启用/停用技能（启停专用端点，替代 DELETE）。
   * PATCH /api/v1/skills/:id/status {enabled} → 200 + Skill 对象；不存在 → 404 SKILL_NOT_FOUND。
   */
  @Patch(':id/status')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '启用/停用技能（{enabled}，替代物理删除）' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateSkillStatusDto,
  ) {
    return this.skillsService.updateStatus(id, dto.enabled);
  }
}
