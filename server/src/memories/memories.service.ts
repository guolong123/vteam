import {
  BadRequestException,
  ConflictException,
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
import { isPlatformAdminByUserId } from '../users/admin-permission';
import { QueryMemoriesDto, UpdateMemoryDto } from './dto/query-memories.dto';
import {
  MEMORY_ERRORS,
  MEMORY_LEVELS,
  computeMemoryContentHash,
} from './memory.constants';

/** Memory 主键前缀（15 篇 §2.2：<prefix>_<零填充序号>，me_0000000001 起）。 */
const MEMORY_ID_PREFIX = 'me';

/**
 * 调用方上下文（全局 JwtAuthGuard 填充的 request.user 之 userId）。
 * 管理员与否不在此处声明——由 service 内部按 AdminGuard 口径（users/admin-permission.ts）
 * 查库判定，避免「调用方自称 admin」成为提权面。
 */
export interface MemoryViewer {
  id: string;
}

/** 行级鉴权所需的最小行字段（teamId 决定走团队成员门还是管理员门）。 */
type MemoryRowScope = { teamId: string | null };

/**
 * 记忆服务（memory-management Todo 1 表结构 + 启动续号骨架；Todo 5 REST 端点）。
 *
 * findAll/remove 对齐 tools/issues 平台模式：列表硬过滤软删 + 分页 {items, total, page, pageSize}，
 * 删除为软删（deletedAt=now，GET 不可见）。onModuleInit 续号逻辑保留（只统计 me_<数字> 行最大序号，
 * 命名 id 不参与——parseInt NaN 防护见 common/id-resync.ts）。
 *
 * memory-enhancement Todo 2：GET/DELETE 去 AdminGuard，权限下沉到本 service——
 * 读走 `findAll` 的成员感知过滤，写走 `assertRowWritable`（团队行=成员，全局行=管理员）；
 * PATCH 仍由 AdminGuard 前置，行为零变更。
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
   * GET /memories：level/teamId/roleId/autoInject/archived 过滤 + keyword 内容模糊搜索 + 分页。
   * 归档三态（复用 deletedAt 软删列，不新增状态列）：`undefined`/`false`=只看活跃
   * （deletedAt null），`true`=只看已归档（deletedAt 非空）。
   * 2026-09-30：level 扩为 team/role/global；level=task（含任务级过滤 taskId，
   * 已随任务级记忆删除）→ 400 MEMORY_LEVEL_INVALID。
   * memory-enhancement Todo 2：管理员全量；非管理员强制收窄到「全局 ∪ 自己团队」（见下方安全红线注释）。
   * 返回 {items, total, page, pageSize}（对齐 tools.findMany 模式）。
   * items 为完整行（含 autoInject / roleId），记忆页据此渲染行标识与岗位徽标。
   */
  async findAll(query: QueryMemoriesDto = {}, viewer?: MemoryViewer) {
    if (
      query.level !== undefined &&
      query.level !== MEMORY_LEVELS.team &&
      query.level !== MEMORY_LEVELS.role &&
      query.level !== MEMORY_LEVELS.global
    ) {
      throw new BadRequestException({
        code: MEMORY_ERRORS.MEMORY_LEVEL_INVALID,
        message: `非法记忆级别：${query.level}（仅支持 team/role/global，任务级记忆已删除）`,
      });
    }
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const isAdmin = await this.resolvePlatformAdmin(viewer);
    // 非管理员的可见团队集：无 viewer（如未认证直入 service）视为空集 → 只剩 global 行（fail closed）。
    const viewerTeamIds = isAdmin ? [] : await this.loadViewerTeamIds(viewer?.id);
    const where: Prisma.MemoryWhereInput = {
      // 归档三态：显式 archived=true → 已归档；缺省/false → 活跃（软删不可见，对齐 issue 列表语义）。
      ...(query.archived === true ? { deletedAt: { not: null } } : { deletedAt: null }),
      ...(query.level ? { level: query.level } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.roleId ? { roleId: query.roleId } : {}),
      // 仅在显式传入时筛：`undefined`=不筛，`false`=只看按需检索的记忆。
      ...(query.autoInject !== undefined
        ? { autoInject: query.autoInject }
        : {}),
      ...(query.keyword
        ? {
            OR: [
              { content: { contains: query.keyword } },
              { description: { contains: query.keyword } },
            ],
          }
        : {}),
      // **安全红线**：GET 已去 AdminGuard，非管理员必须收窄到「全局 ∪ 自己团队」。
      // 走 AND 包裹，避免与上方 keyword 的 OR 互相覆盖。
      ...(!isAdmin
        ? {
            AND: [
              {
                OR: [
                  { level: MEMORY_LEVELS.global },
                  { teamId: { in: viewerTeamIds } },
                ],
              },
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
   * PATCH /memories/:id：部分更新 content/description/tags/autoInject（T4 记忆演进；
   * 2026-09-30 增 autoInject，记忆页行内开关走此处）。
   * 不存在（含已软删）→ 404 MEMORY_NOT_FOUND；全空 → 400 MEMORY_UPDATE_EMPTY；
   * team/role 级行要求调用者是该团队成员（403 PERMISSION_TEAM_NOT_MEMBER，AdminGuard
   * 已前置，此处叠加团队归属）；global 级行仅管理员可改（AdminGuard 已保证）。
   * content 更新时同步重算 contentHash（去重键与正文一致）。
   */
  async update(id: string, dto: UpdateMemoryDto, viewer?: { id: string }) {
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
      dto.tags === undefined &&
      dto.autoInject === undefined
    ) {
      throw new BadRequestException({
        code: MEMORY_ERRORS.MEMORY_UPDATE_EMPTY,
        message: '至少提供 content/description/tags/autoInject 之一',
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
    if (dto.autoInject !== undefined) {
      data.autoInject = dto.autoInject;
    }
    return this.prisma.memory.update({ where: { id }, data });
  }

  /**
   * DELETE /memories/:id：归档（软删 deletedAt=now，GET 活跃列表不可见）。
   * 语义不变（对齐既有管理页 delete 调用；硬删走 `purge`）。
   * 不存在（含已软删条目）→ 404 MEMORY_NOT_FOUND；存在 → 返回软删后的条目。
   * memory-enhancement Todo 2：AdminGuard 已从控制器移除，鉴权改由 `assertRowWritable` 承担
   * （团队行=该团队成员，global 行=管理员，否则 403 MEMORY_FORBIDDEN）。
   */
  async remove(id: string, viewer?: MemoryViewer) {
    const existing = await this.findRowOrThrow(id);
    if (existing.deletedAt) {
      throw this.memoryNotFound();
    }
    await this.assertRowWritable(existing, viewer);
    return this.prisma.memory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * POST /memories/:id/restore：把已归档行恢复为活跃（清 deletedAt）。
   * 行不存在或本就活跃 → 404 MEMORY_NOT_FOUND；同 scope 已有活跃同 contentHash 行
   * （level/teamId/roleId 一致、id 不同）→ 409 MEMORY_RESTORE_DUPLICATE
   * （条件抄 platform-mcp.service.ts findDuplicateMemory，避免恢复出检索层面重复行）。
   * 鉴权与归档/硬删同一出口 `assertRowWritable`。
   */
  async restore(id: string, viewer?: MemoryViewer) {
    const existing = await this.findRowOrThrow(id);
    if (!existing.deletedAt) {
      throw this.memoryNotFound();
    }
    await this.assertRowWritable(existing, viewer);
    // contentHash 为 null 的存量行没有去重键，跳过查重（否则 `contentHash: null` 会命中任意无 hash 行 → 误报 409）
    const duplicate = existing.contentHash
      ? await this.prisma.memory.findFirst({
          where: {
            id: { not: existing.id },
            deletedAt: null,
            level: existing.level,
            teamId: existing.teamId,
            roleId: existing.roleId,
            contentHash: existing.contentHash,
          },
          select: { id: true },
        })
      : null;
    if (duplicate) {
      throw new ConflictException({
        code: MEMORY_ERRORS.MEMORY_RESTORE_DUPLICATE,
        message: '同内容记忆已处于活跃状态，请先删除重复条目',
      });
    }
    return this.prisma.memory.update({
      where: { id },
      data: { deletedAt: null },
    });
  }

  /**
   * POST /memories/:id/purge：**真硬删**（prisma.memory.delete，唯一不可逆入口）。
   * 仅供记忆 tab / 管理页的「永久删除」人工确认触发——不做任何自动 purge（plan 护栏）。
   * 行不存在 → 404 MEMORY_NOT_FOUND；鉴权同 `assertRowWritable`。
   */
  async purge(id: string, viewer?: MemoryViewer) {
    const existing = await this.findRowOrThrow(id);
    await this.assertRowWritable(existing, viewer);
    return this.prisma.memory.delete({ where: { id } });
  }

  private memoryNotFound(): NotFoundException {
    return new NotFoundException({
      code: MEMORY_ERRORS.MEMORY_NOT_FOUND,
      message: '记忆条目不存在',
    });
  }

  private async findRowOrThrow(id: string) {
    const existing = await this.prisma.memory.findUnique({ where: { id } });
    if (!existing) {
      throw this.memoryNotFound();
    }
    return existing;
  }

  /**
   * 行级写鉴权唯一出口（归档/恢复/硬删共用；PATCH 不走此处，保留 AdminGuard + 原校验）：
   * - `teamId` 非空（team/role 行）→ 调用者必须是该团队 team_user_members 成员；
   * - `teamId` 为空（global 行）→ 必须是平台管理员（AdminGuard 移除后由这里补上）。
   * 不满足 → 403 MEMORY_FORBIDDEN。管理员判定复用 AdminGuard 口径（users/admin-permission.ts）。
   */
  private async assertRowWritable(
    row: MemoryRowScope,
    viewer?: MemoryViewer,
  ): Promise<void> {
    if (row.teamId) {
      const member = viewer?.id
        ? await this.prisma.teamUserMember.findUnique({
            where: {
              teamId_userId: { teamId: row.teamId, userId: viewer.id },
            },
            select: { id: true },
          })
        : null;
      if (!member) {
        throw new ForbiddenException({
          code: MEMORY_ERRORS.MEMORY_FORBIDDEN,
          message: '您不是该团队成员，无权操作该团队记忆',
        });
      }
      return;
    }
    if (!(await this.resolvePlatformAdmin(viewer))) {
      throw new ForbiddenException({
        code: MEMORY_ERRORS.MEMORY_FORBIDDEN,
        message: '全局记忆仅平台管理员可操作',
      });
    }
  }

  /** 调用者是否平台管理员（复用 AdminGuard 口径）；无 viewer → false。 */
  private async resolvePlatformAdmin(viewer?: MemoryViewer): Promise<boolean> {
    if (!viewer?.id) {
      return false;
    }
    return isPlatformAdminByUserId(this.prisma, viewer.id);
  }

  /** 调用者的 team_user_members 团队 id 集（findAll 成员过滤用，先例见 chat.service.ts:216-226）。 */
  private async loadViewerTeamIds(userId?: string): Promise<string[]> {
    if (!userId) {
      return [];
    }
    const memberships = await this.prisma.teamUserMember.findMany({
      where: { userId },
      select: { teamId: true },
    });
    return memberships.map((m) => m.teamId);
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
