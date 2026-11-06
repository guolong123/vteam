import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { CreateMemberDto } from './dto/create-member.dto';
import { QueryMembersDto } from './dto/query-members.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import {
  MEMBER_ID_PREFIX,
  MEMBER_STATUS,
  MEMBERS_ERRORS,
} from './members.constants';

/** 成员列表/详情统一 include（角色/Agent/默认模型/默认 worker + 计数）。 */
const MEMBER_INCLUDE = {
  role: { select: { id: true, key: true, name: true } },
  agent: { select: { id: true, name: true, agentKey: true } },
  defaultModel: { select: { id: true, name: true, modelID: true } },
  preferredWorker: { select: { id: true, name: true, status: true } },
  _count: { select: { teamMembers: true, notificationLinks: true } },
} as const;

/** 详情额外展开（所在群聊 + 通知渠道绑定）。 */
const MEMBER_DETAIL_INCLUDE = {
  ...MEMBER_INCLUDE,
  teamMembers: {
    select: {
      id: true,
      teamId: true,
      alias: true,
      seq: true,
      roleId: true,
      team: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  notificationLinks: {
    select: {
      notificationChannel: {
        select: { id: true, name: true, type: true, enabled: true },
      },
    },
  },
} as const;

/**
 * 成员库服务（37 篇 §5.1）。
 *
 * - 成员 = 平台级实体；`team_members` 只是「席位」（本阶段仅补 member_id 指针，
 *   建群/加成员仍走旧的 agentId 形状，回填与切换在 P1）。
 * - 删除前校验无席位（MEMBER_IN_USE）；停用是软状态。
 * - 主键 mbr_ 由进程内序号生成，启动时按库内最大序号续号（id-resync）。
 */
@Injectable()
export class MembersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly sessionLifecycle: SessionLifecycleService,
  ) {}

  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.member, MEMBER_ID_PREFIX, this.idGen);
  }

  /** GET /members：关键字/岗位/状态过滤 + 分页（按创建时间升序，便于回填后按批次识别）。 */
  async findAll(query: QueryMembersDto = {}) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.roleId) where.defaultRoleId = query.roleId;
    if (query.keyword?.trim()) {
      const keyword = query.keyword.trim();
      where.OR = [
        { name: { contains: keyword } },
        { agent: { name: { contains: keyword } } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.member.count({ where }),
      this.prisma.member.findMany({
        where,
        include: MEMBER_INCLUDE,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // P3：列表顺带返回全局会话摘要（避免前端为每行再查详情）。
    const ids = rows.map((row) => row.id);
    const sessions =
      ids.length > 0
        ? await this.prisma.session.findMany({
            where: { memberKey: { in: ids } },
            select: {
              memberKey: true,
              id: true,
              status: true,
              workerId: true,
              instanceRef: true,
              busyState: true,
              busySince: true,
              turnSeq: true,
              lastTurnOutcome: true,
            },
          })
        : [];
    const sessionByMember = new Map(
      sessions
        .filter((s) => !!s.memberKey)
        .map((s) => [s.memberKey as string, s]),
    );
    return {
      items: rows.map((row) => ({
        ...this.toMemberDto(row),
        session: sessionByMember.get(row.id) ?? null,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** GET /members/:id：详情（含所在群聊与通知渠道绑定）。 */
  async findOne(id: string) {
    const row = await this.prisma.member.findUnique({
      where: { id },
      include: MEMBER_DETAIL_INCLUDE,
    });
    if (!row) this.throwNotFound(id);
    const session = await this.prisma.session.findUnique({
      where: { memberKey: id },
      select: {
        id: true,
        status: true,
        workerId: true,
        instanceRef: true,
        busyState: true,
        busySince: true,
        turnSeq: true,
        lastTurnOutcome: true,
      },
    });
    return {
      ...this.toMemberDto(row),
      groups: (row.teamMembers ?? []).map((seat) => ({
        teamId: seat.teamId,
        teamName: seat.team?.name ?? null,
        seatId: seat.id,
        alias: seat.alias,
        seq: seat.seq,
        roleId: seat.roleId,
      })),
      notificationChannels: (row.notificationLinks ?? []).map((link) => ({
        id: link.notificationChannel.id,
        name: link.notificationChannel.name,
        type: link.notificationChannel.type,
        enabled: link.notificationChannel.enabled,
      })),
      /** P3 全局会话摘要（null = 还没建立过会话）。 */
      session: session
        ? {
            ...session,
            busySince: session.busySince
              ? session.busySince.toISOString()
              : null,
          }
        : null,
    };
  }

  /**
   * POST /members/:id/reset-session：成员级全局会话重置（P3）。
   * 只重置该成员的引擎会话，不动消息/记忆；任务完成不再自动重置。
   */
  async resetSession(id: string) {
    const member = await this.prisma.member.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!member) this.throwNotFound(id);
    return this.sessionLifecycle.resetMemberSession(id, {
      reason: 'member_manual_reset',
    });
  }

  /**
   * POST /members：创建成员。
   * agentId 缺省取岗位 defaultAgentId；岗位/Agent/模型/worker 任一不存在 → 400；
   * 名称全局唯一冲突 → 409 MEMBER_NAME_CONFLICT。
   */
  async create(userId: string, dto: CreateMemberDto) {
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException({
        code: MEMBERS_ERRORS.MEMBER_NAME_CONFLICT,
        message: '成员名不能为空',
      });
    }

    const role = await this.prisma.agentRole.findUnique({
      where: { id: dto.roleId },
      select: { id: true, defaultAgentId: true },
    });
    if (!role) {
      throw new BadRequestException({
        code: MEMBERS_ERRORS.MEMBER_ROLE_NOT_FOUND,
        message: `岗位 ${dto.roleId} 不存在`,
      });
    }

    const agentId = dto.agentId ?? role.defaultAgentId ?? null;
    if (!agentId) {
      throw new BadRequestException({
        code: MEMBERS_ERRORS.MEMBER_AGENT_REQUIRED,
        message: `岗位 ${dto.roleId} 未绑定默认 Agent，且未显式提供 agentId`,
      });
    }
    await this.assertReferences({
      agentId,
      defaultModelId: dto.defaultModelId,
      preferredWorkerId: dto.preferredWorkerId,
    });

    const id = await this.idGen.nextId(MEMBER_ID_PREFIX);
    try {
      await this.prisma.member.create({
        data: {
          id,
          name,
          defaultRoleId: dto.roleId,
          agentId,
          defaultModelId: dto.defaultModelId ?? null,
          preferredWorkerId: dto.preferredWorkerId ?? null,
          privateWorkDir: dto.privateWorkDir?.trim() || null,
          status: MEMBER_STATUS.active,
          description: dto.description?.trim() || null,
          createdBy: userId,
        },
      });
    } catch (err) {
      this.rethrowNameConflict(err, name);
    }
    return this.findOne(id);
  }

  /** PATCH /members/:id：部分更新（引用校验 + 名称冲突）。 */
  async update(id: string, dto: UpdateMemberDto) {
    const existing = await this.prisma.member.findUnique({ where: { id } });
    if (!existing) this.throwNotFound(id);

    if (dto.roleId) {
      const role = await this.prisma.agentRole.findUnique({
        where: { id: dto.roleId },
        select: { id: true },
      });
      if (!role) {
        throw new BadRequestException({
          code: MEMBERS_ERRORS.MEMBER_ROLE_NOT_FOUND,
          message: `岗位 ${dto.roleId} 不存在`,
        });
      }
    }
    await this.assertReferences({
      agentId: dto.agentId,
      defaultModelId: dto.defaultModelId,
      preferredWorkerId: dto.preferredWorkerId,
    });

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.roleId !== undefined) data.defaultRoleId = dto.roleId;
    if (dto.agentId !== undefined) data.agentId = dto.agentId;
    if (dto.defaultModelId !== undefined)
      data.defaultModelId = dto.defaultModelId;
    if (dto.preferredWorkerId !== undefined) {
      data.preferredWorkerId = dto.preferredWorkerId;
    }
    if (dto.privateWorkDir !== undefined) {
      data.privateWorkDir = dto.privateWorkDir.trim() || null;
    }
    if (dto.description !== undefined) {
      data.description = dto.description.trim() || null;
    }
    if (dto.status !== undefined) data.status = dto.status;

    try {
      await this.prisma.member.update({ where: { id }, data });
    } catch (err) {
      this.rethrowNameConflict(err, String(data.name ?? existing.name));
    }
    return this.findOne(id);
  }

  /** DELETE /members/:id：仍有席位 → 409 MEMBER_IN_USE（建议先停用）。 */
  async remove(id: string) {
    const existing = await this.prisma.member.findUnique({ where: { id } });
    if (!existing) this.throwNotFound(id);
    const seats = await this.prisma.teamMember.count({
      where: { memberId: id },
    });
    if (seats > 0) {
      throw new ConflictException({
        code: MEMBERS_ERRORS.MEMBER_IN_USE,
        message: `成员仍属于 ${seats} 个群聊，请先移出席位或停用`,
      });
    }
    await this.prisma.member.delete({ where: { id } });
    return { deleted: true, id };
  }

  /** GET /members/:id/teams：所在群聊（席位）列表。 */
  async listTeams(id: string) {
    await this.assertExists(id);
    const seats = await this.prisma.teamMember.findMany({
      where: { memberId: id },
      select: {
        id: true,
        teamId: true,
        alias: true,
        seq: true,
        roleId: true,
        workDir: true,
        team: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      items: seats.map((seat) => ({
        teamId: seat.teamId,
        teamName: seat.team?.name ?? null,
        seatId: seat.id,
        alias: seat.alias,
        seq: seat.seq,
        roleId: seat.roleId,
        workDir: seat.workDir,
      })),
      total: seats.length,
    };
  }

  /** POST /members/:id/clone：复制一份成员（名称自动加后缀）。 */
  async clone(userId: string, id: string) {
    const source = await this.prisma.member.findUnique({ where: { id } });
    if (!source) this.throwNotFound(id);

    const name = await this.nextAvailableName(`${source.name}-副本`);
    const newId = await this.idGen.nextId(MEMBER_ID_PREFIX);
    await this.prisma.member.create({
      data: {
        id: newId,
        name,
        defaultRoleId: source.defaultRoleId,
        agentId: source.agentId,
        defaultModelId: source.defaultModelId,
        preferredWorkerId: source.preferredWorkerId,
        privateWorkDir: source.privateWorkDir,
        status: MEMBER_STATUS.active,
        description: source.description,
        createdBy: userId,
      },
    });
    return this.findOne(newId);
  }

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  private toMemberDto(row: any) {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      description: row.description ?? null,
      privateWorkDir: row.privateWorkDir ?? null,
      defaultRoleId: row.defaultRoleId,
      agentId: row.agentId,
      defaultModelId: row.defaultModelId ?? null,
      preferredWorkerId: row.preferredWorkerId ?? null,
      role: row.role
        ? { id: row.role.id, key: row.role.key, name: row.role.name }
        : null,
      agent: row.agent
        ? {
            id: row.agent.id,
            name: row.agent.name,
            agentKey: row.agent.agentKey ?? null,
          }
        : null,
      defaultModel: row.defaultModel
        ? {
            id: row.defaultModel.id,
            name: row.defaultModel.name,
            modelID: row.defaultModel.modelID,
          }
        : null,
      preferredWorker: row.preferredWorker
        ? {
            id: row.preferredWorker.id,
            name: row.preferredWorker.name,
            status: row.preferredWorker.status,
          }
        : null,
      groupCount: row._count?.teamMembers ?? row.teamMembers?.length ?? 0,
      notificationChannelCount:
        row._count?.notificationLinks ?? row.notificationLinks?.length ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** 引用存在性校验：Agent / 模型 / worker（岗位在调用方单独校验）。 */
  private async assertReferences(input: {
    agentId?: string;
    defaultModelId?: string;
    preferredWorkerId?: string;
  }): Promise<void> {
    if (input.agentId) {
      const agent = await this.prisma.agent.findUnique({
        where: { id: input.agentId },
        select: { id: true },
      });
      if (!agent) {
        throw new BadRequestException({
          code: MEMBERS_ERRORS.MEMBER_AGENT_NOT_FOUND,
          message: `Agent ${input.agentId} 不存在`,
        });
      }
    }
    if (input.defaultModelId) {
      const model = await this.prisma.model.findUnique({
        where: { id: input.defaultModelId },
        select: { id: true },
      });
      if (!model) {
        throw new BadRequestException({
          code: MEMBERS_ERRORS.MEMBER_MODEL_NOT_FOUND,
          message: `模型 ${input.defaultModelId} 不存在`,
        });
      }
    }
    if (input.preferredWorkerId) {
      const worker = await this.prisma.worker.findUnique({
        where: { id: input.preferredWorkerId },
        select: { id: true },
      });
      if (!worker) {
        throw new BadRequestException({
          code: MEMBERS_ERRORS.MEMBER_WORKER_NOT_FOUND,
          message: `Worker ${input.preferredWorkerId} 不存在`,
        });
      }
    }
  }

  private async assertExists(id: string): Promise<void> {
    const row = await this.prisma.member.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!row) this.throwNotFound(id);
  }

  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: MEMBERS_ERRORS.MEMBER_NOT_FOUND,
      message: `成员 ${id} 不存在`,
    });
  }

  private rethrowNameConflict(err: unknown, name: string): never {
    if ((err as { code?: string })?.code === 'P2002') {
      throw new ConflictException({
        code: MEMBERS_ERRORS.MEMBER_NAME_CONFLICT,
        message: `成员名「${name}」已存在`,
      });
    }
    throw err;
  }

  /** 克隆命名：`<name>-副本` 已被占用时追加序号，避免 409。 */
  private async nextAvailableName(base: string): Promise<string> {
    let name = base;
    let index = 1;
    // 最多尝试 100 次，防御极端情况下的死循环
    while (index <= 100) {
      const exists = await this.prisma.member.findUnique({
        where: { name },
        select: { id: true },
      });
      if (!exists) return name;
      index += 1;
      name = `${base}${index}`;
    }
    throw new ConflictException({
      code: MEMBERS_ERRORS.MEMBER_NAME_CONFLICT,
      message: `无法为「${base}」生成可用名称`,
    });
  }
}
