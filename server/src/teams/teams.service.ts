import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { sanitizeWorkDirName } from '../tasks/work-dir.util';
import { CreateTeamDto } from './dto/create-team.dto';
import { QueryTeamsDto } from './dto/query-teams.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { AddMemberDto, UpdateMemberDto } from './dto/add-member.dto';

const ID_PREFIX = {
  team: 'tm',
  teamMember: 'tmm',
  teamUserMember: 'tum',
  teamQueue: 'tq',
  channel: 'c',
} as const;

const ROLE_LABELS: Record<string, string> = {
  product: '产品经理',
  project_manager: '项目经理',
  architect: '架构师',
  developer: '开发者',
  tester: '测试',
} as const;

const TEAM_ERRORS = {
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  TEAM_NAME_CONFLICT: 'TEAM_NAME_CONFLICT',
  TEAM_BUSY: 'TEAM_BUSY',
  TEAM_QUEUE_NOT_EMPTY: 'TEAM_QUEUE_NOT_EMPTY',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_ALREADY_MEMBER: 'USER_ALREADY_MEMBER',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  TASK_NOT_QUEUED: 'TASK_NOT_QUEUED',
  TASK_NOT_PENDING: 'TASK_NOT_PENDING',
  QUEUE_ENTRY_NOT_FOUND: 'QUEUE_ENTRY_NOT_FOUND',
  MAIN_AGENT_NOT_MEMBER: 'MAIN_AGENT_NOT_MEMBER',
} as const;

type SeqModel = {
  findFirst(args: {
    orderBy: { id: 'desc' };
    select: { id: true };
  }): Promise<{ id: string } | null>;
};

@Injectable()
export class TeamsService implements OnModuleInit {
  private readonly logger = new Logger(TeamsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedPrefix(
      ID_PREFIX.team,
      this.prisma.team as unknown as SeqModel,
    );
    await this.seedPrefix(
      ID_PREFIX.teamMember,
      this.prisma.teamMember as unknown as SeqModel,
    );
    await this.seedPrefix(
      ID_PREFIX.teamUserMember,
      (this.prisma as any).teamUserMember as SeqModel,
    );
    await this.seedPrefix(
      ID_PREFIX.teamQueue,
      (this.prisma as any).teamQueue as SeqModel,
    );
  }

  async create(userId: string, dto: CreateTeamDto) {
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('团队名称不能为空');
    }
    const existing = await this.prisma.team.findUnique({ where: { name } });
    if (existing) {
      throw new ConflictException({
        code: TEAM_ERRORS.TEAM_NAME_CONFLICT,
        message: `团队名称 ${name} 已存在`,
      });
    }
    const members = dto.members ?? [];
    // validate agent existence before transaction (fast fail), also validated inside transaction
    for (const m of members) {
      if (!m.agentId) {
        throw new BadRequestException('成员 agentId 不能为空');
      }
    }

    const teamId = await this.idGen.nextId(ID_PREFIX.team);

    const team = await this.prisma.$transaction(async (tx) => {
      const created = await tx.team.create({
        data: {
          id: teamId,
          name,
          description: dto.description?.trim() || null,
          reuseSession: dto.reuseSession ?? true,
          createdBy: userId,
          version: 0,
        },
      });

      const createdMemberIds: string[] = [];
      const createdMembersMeta: Array<{
        id: string;
        agentId: string;
        seq: number;
      }> = [];
      for (const item of members) {
        const agent = await tx.agent.findUnique({
          where: { id: item.agentId },
          select: { id: true, name: true, role: true },
        });
        if (!agent) {
          throw new NotFoundException({
            code: TEAM_ERRORS.AGENT_NOT_FOUND,
            message: `Agent ${item.agentId} 不存在`,
          });
        }
        const seq = await this.nextSeqForUpdate(tx, teamId, item.agentId);
        const alias = item.alias?.trim() || this.defaultAlias(agent, seq);
        const workDir = item.workDir?.trim() || this.defaultWorkDir(agent, seq);
        const memberId = await this.idGen.nextId(ID_PREFIX.teamMember);
        await tx.teamMember.create({
          data: {
            id: memberId,
            teamId,
            agentId: item.agentId,
            alias,
            seq,
            workDir,
          },
        });
        createdMemberIds.push(memberId);
        createdMembersMeta.push({ id: memberId, agentId: item.agentId, seq });
      }

      const mainAgentRaw = (dto as any).mainAgentMemberId;
      if (
        mainAgentRaw !== undefined &&
        mainAgentRaw !== null &&
        String(mainAgentRaw).trim() !== ''
      ) {
        const raw = String(mainAgentRaw).trim();
        let resolvedId: string | null = null;
        if (createdMemberIds.includes(raw)) {
          resolvedId = raw;
        } else if (/^\d+$/.test(raw)) {
          const idx = parseInt(raw, 10);
          if (idx >= 0 && idx < createdMemberIds.length) {
            resolvedId = createdMemberIds[idx];
          }
        } else {
          const found = createdMembersMeta.find((m) => m.agentId === raw);
          if (found) resolvedId = found.id;
          if (!resolvedId && raw.includes(':')) {
            const [aid, seqStr] = raw.split(':');
            const seq = parseInt(seqStr, 10);
            const found2 = createdMembersMeta.find(
              (m) => m.agentId === aid && m.seq === seq,
            );
            if (found2) resolvedId = found2.id;
          }
        }
        if (!resolvedId) {
          throw new BadRequestException({
            code: TEAM_ERRORS.MAIN_AGENT_NOT_MEMBER,
            message: '主 Agent 必须是团队成员',
          });
        }
        await tx.team.update({
          where: { id: teamId },
          data: { mainAgentMemberId: resolvedId },
        });
      }

      // 建团队即写入创建者 owner 成员行（team_user_members；与 team 创建同事务）
      await tx.teamUserMember.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.teamUserMember),
          teamId,
          userId,
          role: 'owner',
          joinedAt: new Date(),
        },
      });

      // 建团队即建群聊频道（一团队一群；team_group_key 为生成列由 DB 自动计算，禁止显式写入）
      try {
        await tx.chatChannel.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.channel),
            type: CHANNEL_TYPE.team_group,
            teamId,
            taskId: null,
          } as any,
        });
      } catch (e) {
        this.logger.warn(
          `创建团队群聊频道失败 teamId=${teamId}（任务流会幂等补建）: ${(e as Error)?.message ?? e}`,
        );
      }

      return created;
    });

    const full = await this.findOne(teamId);
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId, action: 'create', name },
      { type: 'global' },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CREATED,
      { teamId, name },
      { type: 'team', id: teamId },
    );
    return full;
  }

  async findAll(query: QueryTeamsDto) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where: any = {};
    if (query.name?.trim()) {
      where.name = { contains: query.name.trim() };
    }
    const [total, items] = await this.prisma.$transaction([
      this.prisma.team.count({ where }),
      this.prisma.team.findMany({
        where,
        include: {
          members: {
            include: {
              agent: { select: { id: true, name: true, role: true } },
            },
            orderBy: { seq: 'asc' },
          },
          userMembers: { orderBy: { joinedAt: 'asc' } },
          queues: {
            include: { task: { select: { title: true, status: true } } },
            orderBy: { position: 'asc' },
          },
          currentTask: { select: { id: true, title: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: items.map((t) => this.toTeamDto(t)),
      total,
      page,
      pageSize,
    };
  }

  async findOne(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: {
        members: {
          include: { agent: { select: { id: true, name: true, role: true } } },
          orderBy: [{ agentId: 'asc' }, { seq: 'asc' }],
        },
        userMembers: { orderBy: { joinedAt: 'asc' } },
        queues: {
          include: { task: { select: { title: true, status: true } } },
          orderBy: { position: 'asc' },
        },
        currentTask: { select: { id: true, title: true, status: true } },
      },
    });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    return this.toTeamDto(team);
  }

  async update(id: string, dto: UpdateTeamDto) {
    const team = await this.prisma.team.findUnique({ where: { id } });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    const data: any = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('团队名称不能为空');
      if (name !== team.name) {
        const dup = await this.prisma.team.findUnique({ where: { name } });
        if (dup) {
          throw new ConflictException({
            code: TEAM_ERRORS.TEAM_NAME_CONFLICT,
            message: `团队名称 ${name} 已存在`,
          });
        }
        data.name = name;
      }
    }
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }
    if (dto.reuseSession !== undefined) {
      data.reuseSession = dto.reuseSession;
    }
    if (dto.managedMode !== undefined) {
      data.managedMode = dto.managedMode;
    }
    if ((dto as any).mainAgentMemberId !== undefined) {
      const raw = (dto as any).mainAgentMemberId;
      if (raw === null || String(raw).trim() === '') {
        data.mainAgentMemberId = null;
      } else {
        const memberId = String(raw).trim();
        const member = await this.prisma.teamMember.findUnique({
          where: { id: memberId },
        });
        if (!member || member.teamId !== id) {
          throw new BadRequestException({
            code: TEAM_ERRORS.MAIN_AGENT_NOT_MEMBER,
            message: '主 Agent 必须是团队成员',
          });
        }
        data.mainAgentMemberId = member.id;
      }
    }
    if (Object.keys(data).length === 0) {
      return this.findOne(id);
    }

    // version optimistic lock
    if (dto.version !== undefined) {
      const result = await this.prisma.team.updateMany({
        where: { id, version: dto.version },
        data: { ...data, version: { increment: 1 } },
      });
      if (result.count === 0) {
        throw new ConflictException({
          code: TEAM_ERRORS.VERSION_CONFLICT,
          message: '团队已被其他请求修改，请刷新后重试',
          details: { currentVersion: team.version },
        });
      }
    } else {
      await this.prisma.team.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      });
    }

    const full = await this.findOne(id);
    // 主 Agent 变更回填：仅同步尚未启动的任务（pending/queued），进行中任务不动（避免干扰运行中会话路由）
    if ((dto as any).mainAgentMemberId !== undefined) {
      try {
        const mainId: string | null = (full as any).mainAgentMemberId ?? null;
        const member = mainId
          ? await this.prisma.teamMember.findUnique({ where: { id: mainId } })
          : null;
        const openTasks = await this.prisma.task.findMany({
          where: { teamId: id, status: { in: ['pending', 'queued'] } },
          select: { id: true },
        });
        for (const t of openTasks) {
          if (!member) {
            await this.prisma.task.update({
              where: { id: t.id },
              data: { mainAgentId: null, mainAgentInstanceId: null },
            });
            continue;
          }
          // 主门团队化：任务侧只记模板 agent（mainAgentId），实例口径恒为团队成员
          // （mainAgentInstanceId 置空，运行时唯一主门为 team.mainAgentMemberId）。
          await this.prisma.task.update({
            where: { id: t.id },
            data: {
              mainAgentId: (member as any).agentId,
              mainAgentInstanceId: null,
            },
          });
        }
      } catch (e) {
        this.logger.warn(
          `回填团队主 Agent 到待启动任务失败 teamId=${id}: ${(e as Error)?.message ?? e}`,
        );
      }
    }
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId: id, action: 'update' },
      { type: 'global' },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_UPDATED,
      { teamId: id },
      { type: 'team', id },
    );
    return full;
  }

  async remove(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: { queues: true },
    });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    if (team.currentTaskId) {
      throw new ConflictException({
        code: TEAM_ERRORS.TEAM_BUSY,
        message: '团队正忙，无法删除',
        details: { currentTaskId: team.currentTaskId },
      });
    }
    if (team.queues.length > 0) {
      throw new ConflictException({
        code: TEAM_ERRORS.TEAM_QUEUE_NOT_EMPTY,
        message: '团队队列非空，无法删除',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      try {
        if (tx.team?.update)
          await tx.team.update({
            where: { id },
            data: { mainAgentMemberId: null },
          });
      } catch {}
      await tx.teamMember.deleteMany({ where: { teamId: id } });
      await tx.team.delete({ where: { id } });
    });
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId: id, action: 'delete' },
      { type: 'global' },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_DELETED,
      { teamId: id },
      { type: 'team', id },
    );
    return { deleted: true, id };
  }

  async addMember(teamId: string, dto: AddMemberDto) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    const agent = await this.prisma.agent.findUnique({
      where: { id: dto.agentId },
      select: { id: true, name: true, role: true },
    });
    if (!agent) {
      throw new NotFoundException({
        code: TEAM_ERRORS.AGENT_NOT_FOUND,
        message: `Agent ${dto.agentId} 不存在`,
      });
    }

    const member = await this.prisma.$transaction(async (tx) => {
      const seq = await this.nextSeqForUpdate(tx, teamId, dto.agentId);
      const alias = dto.alias?.trim() || this.defaultAlias(agent, seq);
      const workDir = dto.workDir?.trim() || this.defaultWorkDir(agent, seq);
      const created = await tx.teamMember.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.teamMember),
          teamId,
          agentId: dto.agentId,
          alias,
          seq,
          workDir,
        },
      });
      await tx.team.update({
        where: { id: teamId },
        data: { version: { increment: 1 } },
      });
      return created;
    });

    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      {
        teamId,
        action: 'member_add',
        memberId: member.id,
        agentId: member.agentId,
        alias: member.alias,
        seq: member.seq,
      },
      { type: 'global' },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_UPDATED,
      { teamId, action: 'member_add', memberId: member.id },
      { type: 'team', id: teamId },
    );
    return this.findOne(teamId);
  }

  async removeMember(teamId: string, memberId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    const member = await this.prisma.teamMember.findUnique({
      where: { id: memberId },
    });
    if (!member || member.teamId !== teamId) {
      throw new NotFoundException({
        code: TEAM_ERRORS.MEMBER_NOT_FOUND,
        message: '成员不存在',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.teamMember.delete({ where: { id: memberId } });
      const mainCleared = (team as any).mainAgentMemberId === memberId;
      await tx.team.update({
        where: { id: teamId },
        data: mainCleared
          ? { mainAgentMemberId: null, version: { increment: 1 } }
          : { version: { increment: 1 } },
      });
    });
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId, action: 'member_remove', memberId },
      { type: 'global' },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_UPDATED,
      { teamId, action: 'member_remove', memberId },
      { type: 'team', id: teamId },
    );
    return this.findOne(teamId);
  }

  async addUserMember(teamId: string, dto: { userId: string; role?: string }) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    const userId = dto?.userId?.trim();
    if (!userId) {
      throw new BadRequestException('用户 ID 不能为空');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({
        code: TEAM_ERRORS.USER_NOT_FOUND,
        message: `用户 ${userId} 不存在`,
      });
    }
    const existing = await (this.prisma as any).teamUserMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (existing) {
      throw new ConflictException({
        code: TEAM_ERRORS.USER_ALREADY_MEMBER,
        message: '用户已是团队成员',
      });
    }
    let created: any;
    try {
      created = await (this.prisma as any).teamUserMember.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.teamUserMember),
          teamId,
          userId,
          role: dto.role?.trim() || 'member',
          joinedAt: new Date(),
        },
      });
    } catch (err) {
      // 并发竞态：两请求同时 findUnique 未命中后同键 create → P2002，重读确认后报干净 409
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.warn(
          `addUserMember 并发竞态 team=${teamId} user=${userId}，重读确认`,
        );
        const raced = await (this.prisma as any).teamUserMember.findUnique({
          where: { teamId_userId: { teamId, userId } },
        });
        if (raced) {
          throw new ConflictException({
            code: TEAM_ERRORS.USER_ALREADY_MEMBER,
            message: '用户已是团队成员',
          });
        }
      }
      throw err;
    }
    await this.prisma.team.update({
      where: { id: teamId },
      data: { version: { increment: 1 } },
    });
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId, action: 'user_member_add', userMemberId: created.id, userId },
      { type: 'global' },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_UPDATED,
      { teamId, action: 'user_member_add', userMemberId: created.id },
      { type: 'team', id: teamId },
    );
    return this.findOne(teamId);
  }

  async removeUserMember(teamId: string, userId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    const member = await (this.prisma as any).teamUserMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) {
      throw new NotFoundException({
        code: TEAM_ERRORS.MEMBER_NOT_FOUND,
        message: '成员不存在',
      });
    }
    await (this.prisma as any).teamUserMember.delete({
      where: { id: member.id },
    });
    await this.prisma.team.update({
      where: { id: teamId },
      data: { version: { increment: 1 } },
    });
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId, action: 'user_member_remove', userMemberId: member.id, userId },
      { type: 'global' },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_UPDATED,
      { teamId, action: 'user_member_remove', userMemberId: member.id },
      { type: 'team', id: teamId },
    );
    return this.findOne(teamId);
  }

  async updateMember(teamId: string, memberId: string, dto: UpdateMemberDto) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    const member = await this.prisma.teamMember.findUnique({
      where: { id: memberId },
    });
    if (!member || member.teamId !== teamId) {
      throw new NotFoundException({
        code: TEAM_ERRORS.MEMBER_NOT_FOUND,
        message: '成员不存在',
      });
    }
    const data: any = {};
    if (dto.alias !== undefined) data.alias = dto.alias?.trim() || null;
    if (dto.workDir !== undefined) data.workDir = dto.workDir?.trim() || null;
    if (Object.keys(data).length === 0) {
      return this.findOne(teamId);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.teamMember.update({ where: { id: memberId }, data });
      await tx.team.update({
        where: { id: teamId },
        data: { version: { increment: 1 } },
      });
    });
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId, action: 'member_update', memberId },
      { type: 'global' },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_UPDATED,
      { teamId, action: 'member_update', memberId },
      { type: 'team', id: teamId },
    );
    return this.findOne(teamId);
  }

  /**
   * 手动重置团队会话（幂等，Todo7）：
   * 批量 soft-remove TaskGroupInstance 先于 delete，再 delete+create 新 s_ 行，Memory 不删，
   * 同事务写入系统消息“已为下一任务开新会话”并广播 chat.message.new + team.changed。
   */
  async resetSessions(teamId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      select: { id: true },
    });
    if (members.length === 0) {
      return { reset: 0, teamId };
    }
    const memberIds = members.map((m) => m.id);
    // 幂等：无会话需重置时直接返回（已重置状态再次调用 selections 为空即 0）
    const existingCount = await this.prisma.session.count({
      where: { teamMemberId: { in: memberIds } },
    } as any);
    if (existingCount === 0) {
      return { reset: 0, teamId };
    }

    // 查找团队群聊频道（若不存在则仍重置会话但不写系统消息）
    const teamChannel = await (this.prisma as any).chatChannel
      .findFirst({
        where: { teamId, type: CHANNEL_TYPE.team_group },
        select: { id: true },
      })
      .catch(() => null);
    // fallback: task_group 旧频道（过渡兼容）
    let channelId: string | null = teamChannel?.id ?? null;
    if (!channelId) {
      try {
        const fallback = await (this.prisma as any).chatChannel.findFirst({
          where: { teamId },
          select: { id: true },
        });
        channelId = fallback?.id ?? null;
      } catch {}
    }

    let resetCount = 0;
    let sysMsg: any = null;
    await this.prisma.$transaction(async (tx: any) => {
      const sessions = await tx.session.findMany({
        where: { teamMemberId: { in: memberIds } },
        select: {
          id: true,
          taskId: true,
          agentId: true,
          teamMemberId: true,
          workerId: true,
          instanceRef: true,
        },
      });
      if (!sessions || sessions.length === 0) {
        resetCount = 0;
        return;
      }
      for (const s of sessions as any[]) {
        if (s.workerId && s.instanceRef) {
          await tx.taskGroupInstance.updateMany({
            where: {
              taskId: s.taskId,
              workerId: s.workerId,
              instanceId: s.instanceRef,
              removedAt: null,
            },
            data: { removedAt: new Date() },
          });
        }
      }
      const ids = (sessions as any[]).map((s) => s.id);
      await tx.session.deleteMany({ where: { id: { in: ids } } });
      for (const s of sessions as any[]) {
        await tx.session.create({
          data: {
            id: await this.idGen.nextId('s'),
            taskId: null,
            agentId: s.agentId,
            teamMemberId: s.teamMemberId,
            status: 'created',
          },
        });
      }
      resetCount = sessions.length;
      if (channelId) {
        sysMsg = await tx.message.create({
          data: {
            id: await this.idGen.nextId('m'),
            channelId,
            senderType: SENDER_TYPE.system,
            senderId: null,
            content: { text: '已为下一任务开新会话', parts: [] },
            mentions: null,
            status: MESSAGE_STATUS.sent,
          },
        });
      }
    });

    if (sysMsg) {
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: {
            id: sysMsg.id,
            channelId: sysMsg.channelId,
            senderType: sysMsg.senderType,
            senderId: sysMsg.senderId,
            content: sysMsg.content,
            mentions: sysMsg.mentions ?? [],
            status: sysMsg.status,
            createdAt:
              sysMsg.createdAt?.toISOString?.() ?? new Date().toISOString(),
          },
        },
        { type: 'channel', id: sysMsg.channelId },
      );
    }
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId, action: 'reset_sessions', count: resetCount },
      { type: 'team', id: teamId },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId, action: 'reset_sessions', count: resetCount },
      { type: 'global' },
    );
    return { reset: resetCount, teamId };
  }

  async resetMemberSession(teamId: string, memberId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    const member = await this.prisma.teamMember.findUnique({
      where: { id: memberId },
    });
    if (!member || member.teamId !== teamId) {
      throw new NotFoundException({
        code: TEAM_ERRORS.MEMBER_NOT_FOUND,
        message: '成员不存在',
      });
    }
    const newId = await this.idGen.nextId('s');
    const session = await this.prisma.$transaction(async (tx: any) => {
      const sessions = await tx.session.findMany({
        where: { teamMemberId: memberId },
        select: {
          id: true,
          taskId: true,
          agentId: true,
          teamMemberId: true,
          workerId: true,
          instanceRef: true,
        },
      });
      for (const s of sessions ?? []) {
        if (s.workerId && s.instanceRef) {
          await tx.taskGroupInstance.updateMany({
            where: {
              taskId: s.taskId,
              workerId: s.workerId,
              instanceId: s.instanceRef,
              removedAt: null,
            },
            data: { removedAt: new Date() },
          });
        }
      }
      await tx.session.deleteMany({ where: { teamMemberId: memberId } });
      return tx.session.create({
        data: {
          id: newId,
          taskId: null,
          agentId: member.agentId,
          teamMemberId: memberId,
          status: 'created',
        },
      });
    });
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId, action: 'reset_session', memberId },
      { type: 'team', id: teamId },
    );
    return { teamId, memberId, session };
  }

  /**
   * 取消排队（仅 queued 可取消，Do NOT 拖拽重排）：
   * - FIFO 删除队内条目并重排 position 1..N
   * - 非 queued（无队列行或 task.status !== queued）→ 409 TASK_NOT_QUEUED
   * - 成功后广播 team.queue.changed（team + global）
   * - 同步将任务状态 queued → pending 避免孤儿 queued 无队列行（保证重入队顺序正确，即原队首空位被压缩）
   */
  async cancelQueue(teamId: string, taskId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    const queueEntry: any = await (this.prisma as any).teamQueue.findFirst({
      where: { teamId, taskId },
    });
    if (!queueEntry) {
      throw new ConflictException({
        code: TEAM_ERRORS.TASK_NOT_QUEUED,
        message: '仅排队中的任务可取消',
      });
    }
    const task: any = await (this.prisma as any).task.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, teamId: true },
    });
    if (!task || task.teamId !== teamId || task.status !== 'queued') {
      throw new ConflictException({
        code: TEAM_ERRORS.TASK_NOT_QUEUED,
        message: '仅排队中的任务可取消',
      });
    }
    await this.prisma.$transaction(async (tx: any) => {
      await tx.teamQueue.delete({ where: { id: queueEntry.id } });
      // 孤儿 queued → pending，避免无队列行仍为 queued
      try {
        await tx.task.update({
          where: { id: taskId },
          data: { status: 'pending' },
        });
      } catch {}
      const remaining: any[] = await tx.teamQueue.findMany({
        where: { teamId },
        orderBy: { position: 'asc' },
      });
      for (let i = 0; i < remaining.length; i++) {
        const expected = i + 1;
        if (remaining[i].position !== expected) {
          await tx.teamQueue.update({
            where: { id: remaining[i].id },
            data: { position: expected },
          });
        }
      }
    });
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_QUEUE_CHANGED,
      { teamId, taskId, action: 'cancel' },
      { type: 'team', id: teamId },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId, action: 'queue_cancel', taskId },
      { type: 'global' },
    );
    return this.findOne(teamId);
  }

  /**
   * 排队等待（pending 孤儿重入队）：
   * - 仅 pending 可排队（queued/进行中/已完成等 409）；队首任务直接点开始，无需排队；
   * - 任务须归属本团队；已有队列行 → 幂等返回；
   * - 位置 MAX(position)+1 行锁追加（FIFO），任务状态同步 queued。
   * - 成功后广播 team.queue.changed（team + global）
   */
  async enqueueQueue(teamId: string, taskId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    const task: any = await this.prisma.task.findUnique({
      where: { id: taskId },
    });
    if (!task || task.teamId !== teamId) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TASK_NOT_QUEUED,
        message: '任务不存在或不归属本团队',
      });
    }
    if ((team as any).currentTaskId === taskId) {
      throw new ConflictException({
        code: TEAM_ERRORS.TASK_NOT_PENDING,
        message: '队首任务请直接开始，无需排队',
      });
    }
    if (task.status !== 'pending') {
      throw new ConflictException({
        code: TEAM_ERRORS.TASK_NOT_PENDING,
        message: '仅待开始任务可排队等待',
      });
    }
    const existing = await (this.prisma as any).teamQueue.findFirst({
      where: { teamId, taskId },
    });
    if (existing) {
      return this.findOne(teamId);
    }
    await this.prisma.$transaction(async (tx: any) => {
      let maxPos = 0;
      try {
        const qRows: any[] = await tx.$queryRawUnsafe(
          'SELECT MAX(position) as maxPos FROM team_queues WHERE team_id = ? FOR UPDATE',
          teamId,
        );
        const v = qRows?.[0]?.maxPos;
        maxPos = typeof v === 'number' ? v : v != null ? Number(v) : 0;
        if (!Number.isFinite(maxPos)) maxPos = 0;
      } catch {
        try {
          const agg = await tx.teamQueue.aggregate({
            _max: { position: true },
            where: { teamId },
          });
          maxPos = agg._max.position ?? 0;
        } catch {
          maxPos = 0;
        }
      }
      await tx.teamQueue.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.teamQueue),
          teamId,
          taskId,
          position: maxPos + 1,
        },
      });
      await tx.task.update({
        where: { id: taskId },
        data: { status: 'queued' },
      });
    });
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_QUEUE_CHANGED,
      { teamId, taskId, action: 'enqueue' },
      { type: 'team', id: teamId },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.TEAM_CHANGED,
      { teamId, action: 'queue_enqueue', taskId },
      { type: 'global' },
    );
    return this.findOne(teamId);
  }

  private async nextSeqForUpdate(
    tx: any,
    teamId: string,
    agentId: string,
  ): Promise<number> {
    // row-level lock: SELECT MAX(seq) FOR UPDATE inside transaction
    const rows: Array<{ maxSeq: number | null }> = await tx.$queryRawUnsafe(
      'SELECT MAX(seq) as maxSeq FROM team_members WHERE team_id = ? AND agent_id = ? FOR UPDATE',
      teamId,
      agentId,
    );
    const max = rows[0]?.maxSeq ?? null;
    // fallback for prisma aggregate style (test mocks use aggregate), but raw is primary
    if (max === null || max === undefined) {
      // try aggregate as fallback if raw returns empty (e.g., sqlite test)
      try {
        const agg = await tx.teamMember.aggregate({
          _max: { seq: true },
          where: { teamId, agentId },
        });
        return (agg._max.seq ?? 0) + 1;
      } catch {
        return 1;
      }
    }
    return (max ?? 0) + 1;
  }

  private defaultAlias(
    agent: { name: string; role: string | null },
    seq: number,
  ): string {
    const roleLabel = ROLE_LABELS[agent.role ?? ''] ?? agent.name;
    return `${roleLabel}-${seq}`;
  }

  private defaultWorkDir(
    agent: { name: string; role: string | null; id?: string },
    seq: number,
  ): string {
    const base = sanitizeWorkDirName(agent.name ?? agent.id ?? 'agent');
    return seq > 1
      ? `/data/vteam-worker/${base}-${seq}`
      : `/data/vteam-worker/${base}`;
  }

  private toTeamDto(team: any) {
    const members = (team.members ?? []).map((m: any) => ({
      id: m.id,
      teamId: m.teamId,
      agentId: m.agentId,
      alias: m.alias,
      seq: m.seq,
      workDir: m.workDir,
      agent: m.agent
        ? { id: m.agent.id, name: m.agent.name, role: m.agent.role }
        : undefined,
      createdAt: m.createdAt,
    }));
    const userMembers = (team.userMembers ?? []).map((u: any) => ({
      id: u.id,
      userId: u.userId,
      role: u.role,
      joinedAt: u.joinedAt,
    }));
    const currentTask = (team as any).currentTask ?? null;
    return {
      id: team.id,
      name: team.name,
      description: team.description,
      reuseSession: team.reuseSession,
      managedMode: (team as any).managedMode ?? false,
      currentTaskId: team.currentTaskId ?? null,
      currentTaskTitle: currentTask?.title ?? null,
      currentTaskStatus: currentTask?.status ?? null,
      mainAgentMemberId: (team as any).mainAgentMemberId ?? null,
      version: team.version,
      createdBy: team.createdBy,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      members,
      userMembers,
      queue: (team.queues ?? []).map((q: any) => ({
        id: q.id,
        teamId: q.teamId,
        taskId: q.taskId,
        position: q.position,
        enqueuedAt: q.enqueuedAt,
        taskTitle: q.task?.title ?? null,
        taskStatus: q.task?.status ?? null,
      })),
    };
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

  private async seedPrefix(prefix: string, model: SeqModel): Promise<void> {
    const last = await model.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (last) {
      const seq = parseInt(last.id.slice(prefix.length + 1), 10);
      if (Number.isFinite(seq)) {
        this.idGen.seed(prefix, seq);
      }
    }
  }
}

export { TEAM_ERRORS };
