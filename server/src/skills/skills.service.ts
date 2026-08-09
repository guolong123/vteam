import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SKILL_ERRORS } from '../common/constants/skill.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import {
  WORKER_COMMAND_TYPES,
  WorkersService,
} from '../workers/workers.service';
import { QuerySkillsDto } from './dto/query-skills.dto';
import { UpdateSkillDto } from './dto/update-skill.dto';
import {
  assertSkillName,
  parseSkillMarkdown,
  rewriteFrontmatterField,
  SkillFrontmatter,
  UploadedSkillFile,
} from './skill-frontmatter.util';

/** Skill 域主键前缀（对齐 15 篇 §2.2：`sk_<零填充序号>`，本域首个 `sk_` 前缀域）。 */
const ID_PREFIX = 'sk' as const;

/** 上传入参：frontmatter 元数据 + SKILL.md 全文（content 落库原文）+ 文件信息（fileMeta）。 */
export interface CreateSkillInput {
  frontmatter: SkillFrontmatter;
  content: string;
  file: UploadedSkillFile;
}

/** GET /skills 调用方上下文（全局 JwtAuthGuard 填充 request.user）。 */
export interface SkillViewer {
  id: string;
}

/**
 * Skill 服务（T1 重构对齐 09 篇 §3.8）。
 * - create：multipart SKILL.md 上传 → frontmatter 解析 → name 唯一校验（409）→
 *   fileMeta 存元数据 + content 列存全文，enabled 默认停用
 * - findAll：enabled 过滤 + name 模糊搜索 + 分页；成员只读仅可见已启用（admin 全量）
 * - updateStatus：PATCH /skills/:id/status 启停专用（无 DELETE，停用 enabled=false 替代）
 */
@Injectable()
export class SkillsService implements OnModuleInit {
  private readonly logger = new Logger(SkillsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly workersService: WorkersService,
  ) {}

  /** 进程启动对齐 skill 域前缀序号（重启续号，只统计 sk_<数字> 行）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.skill, ID_PREFIX, this.idGen);
  }

  /**
   * POST /skills：SKILL.md 上传注册技能。
   * frontmatter name 必填且匹配 ^[a-z0-9]+(-[a-z0-9]+)*$（400 SKILL_FRONTMATTER_INVALID）；
   * name 全局唯一 → 409 SKILL_NAME_EXISTS（先查 + P2002 并发兜底）；
   * fileMeta 存 {name, description, version, allowedTools, originalname, size, mimetype}；
   * content 列存 SKILL.md 全文（worker 注入需原文写出）；enabled 固定 false（默认停用）。
   */
  async create(input: CreateSkillInput) {
    const name = assertSkillName(input.frontmatter);
    const description = input.frontmatter.description?.trim() || null;
    await this.assertNameFree(name);
    const fileMeta = {
      name,
      description,
      version: input.frontmatter.version ?? null,
      allowedTools: input.frontmatter['allowed-tools'] ?? [],
      originalname: input.file.originalname,
      size: input.file.size,
      mimetype: input.file.mimetype,
    };
    try {
      const skill = await this.prisma.skill.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX),
          name,
          description,
          content: input.content,
          fileMeta: fileMeta as Prisma.InputJsonValue,
          enabled: false,
        },
      });
      await this.broadcastReloadConfig();
      return skill;
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        this.throwNameExists(name);
      }
      throw e;
    }
  }

  /**
   * GET /skills：enabled 过滤 + name 模糊搜索 + 分页。
   * viewer 为空（无鉴权上下文）不强制过滤；admin 遵循 query.enabled（缺省全量）；
   * 成员只读：强制 enabled=true（09 §3.8「成员只读可见已启用」，仅启用技能可供 Agent 勾选）。
   */
  async findAll(query: QuerySkillsDto = {}, viewer?: SkillViewer) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where: Prisma.SkillWhereInput = query.name
      ? { name: { contains: query.name } }
      : {};

    if (viewer && !(await this.isPlatformAdmin(viewer))) {
      where.enabled = true;
    } else if (query.enabled !== undefined) {
      where.enabled = query.enabled;
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.skill.count({ where }),
      this.prisma.skill.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { items: rows, total, page, pageSize };
  }

  /**
   * PATCH /skills/:id/status：启停专用端点（09 §3.8，替代物理删除）。
   * 技能不存在 → 404 SKILL_NOT_FOUND；enabled=false 停用后已勾选该技能的 Agent 不再注入。
   */
  async updateStatus(id: string, enabled: boolean) {
    const skill = await this.prisma.skill.findUnique({ where: { id } });
    if (!skill) {
      this.throwNotFound(id);
    }
    const updated = await this.prisma.skill.update({
      where: { id },
      data: { enabled },
    });
    await this.broadcastReloadConfig();
    return updated;
  }

  /**
   * PATCH /skills/:id：编辑技能元信息与内容（UX-15，JSON body）。
   * - 全空请求体 → 400 SKILL_UPDATE_EMPTY；技能不存在 → 404 SKILL_NOT_FOUND
   * - name：assertSkillName 校验（400 SKILL_FRONTMATTER_INVALID）+ 唯一性（排除自身，409 SKILL_NAME_EXISTS）
   * - content：parseSkillMarkdown 校验为合法 SKILL.md（400 SKILL_FRONTMATTER_INVALID）后落库原文
   * - 一致性（不变量「DB 列 = content frontmatter」）：显式提供的 name/description 用
   *   rewriteFrontmatterField 同步重写 content frontmatter；未显式提供但更新了 content 时，
   *   name/description 列反向取 content frontmatter 解析值。
   */
  async update(id: string, dto: UpdateSkillDto) {
    if (
      dto.name === undefined &&
      dto.description === undefined &&
      dto.content === undefined
    ) {
      throw new BadRequestException({
        code: SKILL_ERRORS.SKILL_UPDATE_EMPTY,
        message: '无可更新字段（name/description/content 至少提供一个）',
      });
    }
    const existing = await this.prisma.skill.findUnique({ where: { id } });
    if (!existing) {
      this.throwNotFound(id);
    }

    let content = existing.content;
    let parsedFrontmatter: SkillFrontmatter | undefined;
    if (dto.content !== undefined) {
      parsedFrontmatter = parseSkillMarkdown(dto.content).frontmatter;
      content = dto.content;
    }

    const name =
      dto.name !== undefined
        ? assertSkillName({ name: dto.name })
        : parsedFrontmatter?.name
          ? assertSkillName(parsedFrontmatter)
          : existing.name;
    if (name !== existing.name) {
      await this.assertNameFree(name, id);
    }

    const description =
      dto.description !== undefined
        ? dto.description.trim() || null
        : parsedFrontmatter
          ? parsedFrontmatter.description?.trim() || null
          : existing.description;

    if (dto.name !== undefined) {
      content = rewriteFrontmatterField(content, 'name', name);
    }
    if (dto.description !== undefined) {
      content = rewriteFrontmatterField(content, 'description', description);
    }

    const updated = await this.prisma.skill.update({
      where: { id },
      data: { name, description, content },
    });
    await this.broadcastReloadConfig();
    return updated;
  }

  /**
   * GET /skills/:id/content：SKILL.md 全文拉取（T4b worker 注入需原文写出——
   * 分布式 worker 无法读 server 本地盘，DB content 列为唯一事实源）。
   * 返回 {id, name, content}；不存在 → 404 SKILL_NOT_FOUND。
   */
  async findContent(id: string) {
    const skill = await this.prisma.skill.findUnique({ where: { id } });
    if (!skill) {
      this.throwNotFound(id);
    }
    return { id: skill.id, name: skill.name, content: skill.content };
  }

  /**
   * 调用方是否为平台管理员（复用 admin.guard.ts 判定语义）：
   * permissions.all === true（seed 简写）或 permissions.users.manage === true（权限矩阵）。
   * 用于 GET 成员只读过滤——与 AdminGuard 的授权校验保持一致，不重复走守卫。
   */
  private async isPlatformAdmin(viewer: SkillViewer): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: viewer.id },
      include: { role: true },
    });
    if (!user || !user.enabled) {
      return false;
    }
    const permissions = (user.role.permissions ?? {}) as Record<string, unknown>;
    if (permissions.all === true) {
      return true;
    }
    const usersPerm = permissions.users as { manage?: boolean } | undefined;
    return usersPerm?.manage === true;
  }

  /** 技能变更落库成功后向全部在线 worker 广播 reload-config（F1 MAJOR 闭环）。 */
  private async broadcastReloadConfig(): Promise<void> {
    try {
      const n = await this.workersService.broadcastCommand({
        type: WORKER_COMMAND_TYPES.RELOAD_CONFIG,
        resourceVersion: new Date().toISOString(),
      });
      if (n > 0) {
        this.logger.log(`技能变更：已广播 reload-config 到 ${n} 个 worker`);
      }
    } catch (e) {
      this.logger.warn(`技能变更后广播 reload-config 失败: ${e}`);
    }
  }

  /** name 唯一预检：已存在同名技能 → 409 SKILL_NAME_EXISTS。excludeId 用于 update 排除自身。 */
  private async assertNameFree(name: string, excludeId?: string): Promise<void> {
    const existing = await this.prisma.skill.findUnique({ where: { name } });
    if (existing && (excludeId === undefined || existing.id !== excludeId)) {
      this.throwNameExists(name);
    }
  }

  /** 409：SKILL_NAME_EXISTS（skills.name @unique 冲突）。 */
  private throwNameExists(name: string): never {
    throw new ConflictException({
      code: SKILL_ERRORS.SKILL_NAME_EXISTS,
      message: `技能名称「${name}」已存在`,
    });
  }

  /** 404：SKILL_NOT_FOUND（SKILL_ERRORS，值与 agents 域风格一致）。 */
  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: SKILL_ERRORS.SKILL_NOT_FOUND,
      message: `技能 ${id} 不存在`,
    });
  }

  /** Prisma 唯一约束冲突（P2002）→ name 重复（并发兜底）。 */
  private isUniqueViolation(e: unknown): boolean {
    return (
      e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
    );
  }

  private normalizePage(page?: number): number {
    const p = Number(page ?? 1);
    return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
  }

  private normalizePageSize(pageSize?: number): number {
    const ps = Number(pageSize ?? 20);
    if (!Number.isFinite(ps)) return 20;
    return Math.min(Math.max(Math.floor(ps), 1), 100);
  }
}
