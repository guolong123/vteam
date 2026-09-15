import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import { QueryMemoriesDto, UpdateMemoryDto } from './dto/query-memories.dto';
import {
  MEMORY_ERRORS,
  MEMORY_LEVELS,
  computeMemoryContentHash,
} from './memory.constants';

/** Memory 主键前缀（15 篇 §2.2：<prefix>_<零填充序号>，me_0000000001 起）。 */
const MEMORY_ID_PREFIX = 'me';

/**
 * 记忆服务（memory-management Todo 1 表结构 + 启动续号骨架；Todo 5 REST 端点）。
 *
 * findAll/remove 对齐 tools/issues 平台模式：列表硬过滤软删 + 分页 {items, total, page, pageSize}，
 * 删除为软删（deletedAt=now，GET 不可见）。onModuleInit 续号逻辑保留（只统计 me_<数字> 行最大序号，
 * 命名 id 不参与——parseInt NaN 防护见 common/id-resync.ts）。
 */
@Injectable()
export class MemoriesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /**
   * 进程启动对齐 Memory 域前缀序号（重启续号，me_ 前缀）。
   * 复用 common/id-resync.ts 的 resyncIdPrefix：findMany 按 me_ 前缀过滤仅取 id 列，
   * JS 侧解析纯数字序号取 max 后 idGen.seed，防命名 id 干扰计数器。
   */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.memory, MEMORY_ID_PREFIX, this.idGen);
  }

  /**
   * GET /memories：level/teamId 过滤 + keyword 内容模糊搜索 + 分页。
   * 硬过滤 deletedAt: null（软删不可见，对齐 issue 列表语义）。
   * session-unification Todo 9：仅 team/global；level=task（含任务级过滤 taskId，
   * 已随任务级记忆删除）→ 400 MEMORY_LEVEL_INVALID。
   * 返回 {items, total, page, pageSize}（对齐 tools.findMany 模式）。
   */
  async findAll(query: QueryMemoriesDto = {}) {
    if (
      query.level !== undefined &&
      query.level !== MEMORY_LEVELS.team &&
      query.level !== MEMORY_LEVELS.global
    ) {
      throw new BadRequestException({
        code: MEMORY_ERRORS.MEMORY_LEVEL_INVALID,
        message: `非法记忆级别：${query.level}（仅支持 team/global，任务级记忆已删除）`,
      });
    }
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where: Prisma.MemoryWhereInput = {
      deletedAt: null,
      ...(query.level ? { level: query.level } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.keyword
        ? {
            OR: [
              { content: { contains: query.keyword } },
              { description: { contains: query.keyword } },
            ],
          }
        : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.memory.count({ where }),
      this.prisma.memory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { items: rows, total, page, pageSize };
  }

  /**
   * PATCH /memories/:id：部分更新 content/description/tags（T4 记忆演进）。
   * 不存在（含已软删）→ 404 MEMORY_NOT_FOUND；全空 → 400 MEMORY_UPDATE_EMPTY；
   * team 级行要求调用者是该团队成员（403 PERMISSION_TEAM_NOT_MEMBER，AdminGuard
   * 已前置，此处叠加团队归属）；global 级行仅管理员可改（AdminGuard 已保证）。
   * content 更新时同步重算 contentHash（去重键与正文一致）。
   */
  async update(
    id: string,
    dto: UpdateMemoryDto,
    viewer?: { id: string },
  ) {
    const existing = await this.prisma.memory.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new NotFoundException({
        code: MEMORY_ERRORS.MEMORY_NOT_FOUND,
        message: '记忆条目不存在',
      });
    }
    if (
      dto.content === undefined &&
      dto.description === undefined &&
      dto.tags === undefined
    ) {
      throw new BadRequestException({
        code: MEMORY_ERRORS.MEMORY_UPDATE_EMPTY,
        message: '至少提供 content/description/tags 之一',
      });
    }
    if (existing.teamId) {
      const member = viewer?.id
        ? await this.prisma.teamUserMember.findUnique({
            where: {
              teamId_userId: { teamId: existing.teamId, userId: viewer.id },
            },
            select: { id: true },
          })
        : null;
      if (!member) {
        throw new ForbiddenException({
          code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
          message: '您不是该团队成员',
        });
      }
    }
    const data: Prisma.MemoryUpdateInput = {};
    if (dto.content !== undefined) {
      data.content = dto.content;
      data.contentHash = computeMemoryContentHash(dto.content);
    }
    if (dto.description !== undefined) {
      data.description = dto.description;
    }
    if (dto.tags !== undefined) {
      data.tags = dto.tags as Prisma.InputJsonValue;
    }
    return this.prisma.memory.update({ where: { id }, data });
  }

  /**
   * DELETE /memories/:id：软删（deletedAt=now，GET 列表/详情不可见）。
   * 不存在（含已软删条目）→ 404 MEMORY_NOT_FOUND；存在 → 返回软删后的条目。
   * F2-M5：与 PATCH 对齐团队归属校验——team 级行要求调用者是该团队成员
   * （403 PERMISSION_TEAM_NOT_MEMBER，AdminGuard 已前置，此处叠加团队归属）；
   * global 级行仅管理员可删（AdminGuard 已保证）。
   */
  async remove(id: string, viewer?: { id: string }) {
    const existing = await this.prisma.memory.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new NotFoundException({
        code: MEMORY_ERRORS.MEMORY_NOT_FOUND,
        message: '记忆条目不存在',
      });
    }
    if (existing.teamId) {
      const member = viewer?.id
        ? await this.prisma.teamUserMember.findUnique({
            where: {
              teamId_userId: { teamId: existing.teamId, userId: viewer.id },
            },
            select: { id: true },
          })
        : null;
      if (!member) {
        throw new ForbiddenException({
          code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
          message: '您不是该团队成员',
        });
      }
    }
    return this.prisma.memory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
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
