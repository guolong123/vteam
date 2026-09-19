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
import { roleKeyOf, roleLabelOf } from '../common/agent-role-label';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { sanitizeWorkDirName } from '../tasks/work-dir.util';
import { WorkerClient } from '../workers/worker.client';
import { WorkersService } from '../workers/workers.service';
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

const TEAM_ERRORS = {
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  TEAM_NAME_CONFLICT: 'TEAM_NAME_CONFLICT',
  TEAM_TASK_RUNNING: 'TEAM_TASK_RUNNING',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  ROLE_DEFAULT_AGENT_MISSING: 'ROLE_DEFAULT_AGENT_MISSING',
  MEMBER_AGENT_REQUIRED: 'MEMBER_AGENT_REQUIRED',
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_ALREADY_MEMBER: 'USER_ALREADY_MEMBER',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  TASK_NOT_QUEUED: 'TASK_NOT_QUEUED',
  TASK_NOT_PENDING: 'TASK_NOT_PENDING',
  QUEUE_ENTRY_NOT_FOUND: 'QUEUE_ENTRY_NOT_FOUND',
  MAIN_AGENT_NOT_MEMBER: 'MAIN_AGENT_NOT_MEMBER',
} as const;

@Injectable()
export class TeamsService implements OnModuleInit {
  private readonly logger = new Logger(TeamsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
    private readonly workerClient: WorkerClient,
    private readonly workersService: WorkersService,
  ) {}

  /** 进程启动：按库内各前缀纯数字序号最大值对齐 id 生成器（resyncIdPrefix 跳过 tum_admin_seed 等非数字 id，防主键冲突）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.team, ID_PREFIX.team, this.idGen);
    await resyncIdPrefix(
      this.prisma.teamMember,
      ID_PREFIX.teamMember,
      this.idGen,
    );
    await resyncIdPrefix(
      (this.prisma as any).teamUserMember,
      ID_PREFIX.teamUserMember,
      this.idGen,
    );
    await resyncIdPrefix(
      (this.prisma as any).teamQueue,
      ID_PREFIX.teamQueue,
      this.idGen,
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
    // 成员 agent 绑定解析（roleId 预填 / 显式 agentId 优先，见 resolveMemberBinding）
    // 在事务前完成：快速失败，且解析结果直接进入事务循环，避免事务内重复查询 AgentRole。
    const resolvedMembers = await Promise.all(
      members.map((m) => this.resolveMemberBinding(m)),
    );

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
      for (const item of resolvedMembers) {
        const agent = await tx.agent.findUnique({
          where: { id: item.agentId },
          select: { id: true, name: true },
        });
        if (!agent) {
          throw new NotFoundException({
            code: TEAM_ERRORS.AGENT_NOT_FOUND,
            message: `Agent ${item.agentId} 不存在`,
          });
        }
        const seq = await this.nextSeqForUpdate(tx, teamId, item.agentId);
        const alias =
          item.alias?.trim() || this.defaultAlias(agent, seq, item.role);
        const workDir = item.workDir?.trim() || this.defaultWorkDir(agent, seq);
        const memberId = await this.idGen.nextId(ID_PREFIX.teamMember);
        await tx.teamMember.create({
          data: {
            id: memberId,
            teamId,
            agentId: item.agentId,
            roleId: item.roleId ?? null,
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
              agent: { select: { id: true, name: true } },
              role: { select: { key: true, name: true } },
            },
            orderBy: [{ seq: 'asc' }, { id: 'asc' }],
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
          include: {
            agent: { select: { id: true, name: true } },
            role: { select: { key: true, name: true } },
          },
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
    // 主 Agent 变更回填：同步全部未终态任务（含 in_progress）。
    // 原实现刻意跳过 in_progress（怕干扰运行中会话路由），但标量停写会与
    // team.mainAgentMemberId 不一致，而读标量的地方（会话页主徽章 / 任务动作门 / MCP 门）
    // 会因此误判——实测表现为改主后旧主仍显示「主」（双主徽章）。运行时路由与鉴权
    // 已全部改判 team.mainAgentMemberId，此处同步标量只为消除陈旧读源。
    if ((dto as any).mainAgentMemberId !== undefined) {
      try {
        const mainId: string | null = (full as any).mainAgentMemberId ?? null;
        const member = mainId
          ? await this.prisma.teamMember.findUnique({ where: { id: mainId } })
          : null;
        const openTasks = await this.prisma.task.findMany({
          where: {
            teamId: id,
            status: { in: ['pending', 'queued', 'in_progress'] },
          },
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
      include: {
        queues: true,
        currentTask: { select: { id: true, status: true } },
      },
    });
    if (!team) {
      throw new NotFoundException({
        code: TEAM_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    // 执行中的任务不可随删（worker 侧执行会变孤儿）：仅放行未开始/已终态任务的级联删除。
    const runningTask = await this.prisma.task.findFirst({
      where: {
        teamId: id,
        status: { in: ['in_progress', 'pending_review'] },
      },
      select: { id: true, status: true },
    });
    if (runningTask) {
      throw new ConflictException({
        code: TEAM_ERRORS.TEAM_TASK_RUNNING,
        message: '团队有执行中的任务，请等待完成后再删除',
        details: { taskId: runningTask.id, status: runningTask.status },
      });
    }
    // 待删任务：当前任务 + 队列任务 + 归属该团队的其余任务（执行中已在上方拦截，此处均为可删态）。
    const queuedTaskIds = (team.queues ?? []).map((q: any) => q.taskId);
    const ownedTasks = await this.prisma.task.findMany({
      where: { teamId: id },
      select: { id: true },
    });
    const taskIds = [
      ...new Set(
        [
          team.currentTaskId,
          ...queuedTaskIds,
          ...ownedTasks.map((t: { id: string }) => t.id),
        ].filter(Boolean) as string[],
      ),
    ];
    await this.prisma.$transaction(async (tx) => {
      try {
        if (tx.team?.update)
          await tx.team.update({
            where: { id },
            data: { mainAgentMemberId: null, currentTaskId: null },
          });
      } catch {}
      // 任务级联（依赖 → 被依赖：先清任务子表再删任务行）：
      // 链接表(Cascade 兜底仍显式清) → 事件/计划子任务/问题动态 → 计划/问题/产出物版本 →
      // 产出物/记忆 → 任务消息 → 会话/实例解绑任务 → 队列 → 任务行。
      if (taskIds.length > 0) {
        await tx.taskMessageChannel.deleteMany({
          where: { taskId: { in: taskIds } },
        });
        await tx.taskNotificationChannel.deleteMany({
          where: { taskId: { in: taskIds } },
        });
        await tx.taskEvent.deleteMany({
          where: { taskId: { in: taskIds } },
        });
        const plans = await tx.plan.findMany({
          where: { taskId: { in: taskIds } },
          select: { id: true },
        });
        const planIds = plans.map((p: { id: string }) => p.id);
        if (planIds.length > 0) {
          await tx.planTask.deleteMany({
            where: { planId: { in: planIds } },
          });
        }
        await tx.plan.deleteMany({ where: { taskId: { in: taskIds } } });
        const issues = await tx.issue.findMany({
          where: { taskId: { in: taskIds } },
          select: { id: true },
        });
        const issueIds = issues.map((i: { id: string }) => i.id);
        if (issueIds.length > 0) {
          await tx.issueActivity.deleteMany({
            where: { issueId: { in: issueIds } },
          });
        }
        await tx.issue.deleteMany({ where: { taskId: { in: taskIds } } });
        const artifacts = await tx.artifact.findMany({
          where: { taskId: { in: taskIds } },
          select: { id: true },
        });
        const artifactIds = artifacts.map((a: { id: string }) => a.id);
        if (artifactIds.length > 0) {
          await tx.artifactVersion.deleteMany({
            where: { artifactId: { in: artifactIds } },
          });
        }
        await tx.artifact.deleteMany({ where: { taskId: { in: taskIds } } });
        await tx.memory.deleteMany({ where: { taskId: { in: taskIds } } });
        await tx.agentQuestion.deleteMany({
          where: { taskId: { in: taskIds } },
        });
        await tx.message.deleteMany({ where: { taskId: { in: taskIds } } });
        // sessions.team_member_key 为 task_id NULL 时物化的生成列（uk 唯一）：
        // 先删本团队任务会话（否则 taskId 置空后与已存在的团队级会话键冲突 P2002），
        // 再对他团队残留行保持原解绑语义（键内嵌各自 team_id，不冲突）。
        await tx.session.deleteMany({
          where: { taskId: { in: taskIds }, teamId: id },
        });
        await tx.session.updateMany({
          where: { taskId: { in: taskIds } },
          data: { taskId: null },
        });
        await tx.taskGroupInstance.updateMany({
          where: { taskId: { in: taskIds } },
          data: { taskId: null },
        });
        await tx.teamQueue.deleteMany({ where: { taskId: { in: taskIds } } });
        await tx.task.deleteMany({ where: { id: { in: taskIds } } });
      }
      // 级联清理（子表对 team/teamMember 全为 Restrict，必须先清否则 500）：
      // 消息 → 频道 → 会话/实例（解绑成员+团队）→ 用户成员 → 成员 → 团队。
      const memberIds = (
        await tx.teamMember.findMany({
          where: { teamId: id },
          select: { id: true },
        })
      ).map((m: { id: string }) => m.id);
      const channelIds = (
        await tx.chatChannel.findMany({
          where: { teamId: id },
          select: { id: true },
        })
      ).map((c: { id: string }) => c.id);
      if (channelIds.length > 0) {
        await tx.message.deleteMany({
          where: { channelId: { in: channelIds } },
        });
      }
      await tx.chatChannel.deleteMany({ where: { teamId: id } });
      if (memberIds.length > 0) {
        await tx.session.updateMany({
          where: { teamMemberId: { in: memberIds } },
          data: { teamMemberId: null, teamId: null },
        });
        await tx.taskGroupInstance.updateMany({
          where: { teamMemberId: { in: memberIds } },
          data: { teamMemberId: null, teamId: null },
        });
      } else {
        await tx.session.updateMany({
          where: { teamId: id },
          data: { teamId: null },
        });
        await tx.taskGroupInstance.updateMany({
          where: { teamId: id },
          data: { teamId: null },
        });
      }
      await tx.teamUserMember.deleteMany({ where: { teamId: id } });
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
    // roleId 预填 / 显式 agentId 优先的唯一判定点。
    const binding = await this.resolveMemberBinding(dto);
    const agent = await this.prisma.agent.findUnique({
      where: { id: binding.agentId },
      select: { id: true, name: true },
    });
    if (!agent) {
      throw new NotFoundException({
        code: TEAM_ERRORS.AGENT_NOT_FOUND,
        message: `Agent ${binding.agentId} 不存在`,
      });
    }

    const member = await this.prisma.$transaction(async (tx) => {
      const seq = await this.nextSeqForUpdate(tx, teamId, binding.agentId);
      const alias =
        dto.alias?.trim() || this.defaultAlias(agent, seq, binding.role);
      const workDir = dto.workDir?.trim() || this.defaultWorkDir(agent, seq);
      const created = await tx.teamMember.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.teamMember),
          teamId,
          agentId: binding.agentId,
          roleId: binding.roleId,
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
    if (dto.overrideModelId !== undefined)
      data.overrideModelId = dto.overrideModelId?.trim() || null;
    if (dto.agentId !== undefined || dto.roleId !== undefined) {
      // 同一优先级判定点（resolveMemberBinding）：显式 agentId 优先；只改 roleId 时用其默认
      // Agent 预填；roleId 显式清空（null/空串）仅解绑角色、agent 保持不变。
      const roleCleared =
        dto.roleId === null || String(dto.roleId ?? '').trim() === '';
      if (dto.agentId?.trim()) {
        data.agentId = dto.agentId.trim();
        if (!roleCleared) data.roleId = dto.roleId?.trim() || null;
      } else if (roleCleared) {
        data.roleId = null;
      } else {
        const binding = await this.resolveMemberBinding({ roleId: dto.roleId });
        data.agentId = binding.agentId;
        data.roleId = binding.roleId;
      }
      if (data.agentId && data.agentId !== member.agentId) {
        const nextAgent = await this.prisma.agent.findUnique({
          where: { id: data.agentId },
          select: { id: true },
        });
        if (!nextAgent) {
          throw new NotFoundException({
            code: TEAM_ERRORS.AGENT_NOT_FOUND,
            message: `Agent ${data.agentId} 不存在`,
          });
        }
      }
    }
    if (dto.opencodeAgentName !== undefined) {
      // 空串 → null（清除选择，回 opencode 默认 agent）；非空 → 弱校验后落库。
      // 弱校验：worker 可能离线，无法实时核对，故仅在取得清单时告警、不阻断写入
      // （执行期若 agent 不存在，由 opencode 报错并经既有 agent.status error 通路回流）。
      const name = dto.opencodeAgentName?.trim() || null;
      data.opencodeAgentName = name;
      if (name) {
        await this.warnIfOpencodeAgentUnknown(name, data.agentId ?? member.agentId);
      }
    }
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
   * opencodeAgentName 弱校验：能取到清单则核对，取不到（无在线 worker/worker 离线/
   * 旧版无 GET /agent）静默放行——**绝不因校验失败阻断用户写入**。
   *
   * 设计取舍：agent 是否真实存在，权威判定在 opencode 执行期（不存在则报错并经
   * agent.status error 回流前端）。此处仅做「尽力告警」，避免把 worker 可用性
   * 耦合进团队成员编辑这一纯配置操作。
   */
  private async warnIfOpencodeAgentUnknown(
    agentName: string,
    agentId: string,
  ): Promise<void> {
    try {
      const workerId = await this.workersService.assignWorker();
      if (!workerId) {
        return;
      }
      const agents = await this.workerClient.listAgents({ id: workerId });
      if (agents.length === 0) {
        return;
      }
      if (!agents.some((a) => a.name === agentName)) {
        this.logger.warn(
          `[teams] opencodeAgentName="${agentName}"（agent=${agentId}）不在 worker ${workerId} 的 agent 清单中，` +
            `仍按用户意图写入；执行期若不存在将由 opencode 报错`,
        );
      }
    } catch {
      // 弱校验：任何异常都不影响写入
    }
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
          teamId: teamId,
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

  /**
   * 成员 ⇄ 角色绑定解析（唯一优先级判定点，agent-role-entity todo 7）。
   *
   * **优先级规则（全流程唯一事实来源）**：
   *   1. 显式 `agentId` **恒胜出**——用户明确选了 agent，就绝不被角色的默认值覆盖。
   *   2. 只给 `roleId`（未显式给 `agentId`）→ 用 `AgentRole.defaultAgentId` 预填 `agentId`
   *      （「选岗位，Agent 随岗位来」）。
   *   3. `roleId` 指向的角色 `defaultAgentId` 为空 → 400 `ROLE_DEFAULT_AGENT_MISSING`
   *      （角色没有可预填的默认 Agent，无法只凭岗位定位 Agent）。
   *   4. 两者都缺 → 400 `MEMBER_AGENT_REQUIRED`（agent 必须可解析，向后兼容旧请求）。
   *
   * `roleId` 可选：只给 `agentId` 的存量请求走分支 1，行为与引入本表前逐字一致。
   */
  private async resolveMemberBinding<T extends { agentId?: string; roleId?: string }>(
    input: T,
  ): Promise<
    T & {
      agentId: string;
      roleId: string | null;
      role: { key: string; name: string } | null;
    }
  > {
    const explicitAgentId = input.agentId?.trim() || null;
    const roleId = input.roleId?.trim() || null;

    if (explicitAgentId) {
      // 规则 1：显式 agentId 优先；roleId 仅在给出时随行持久化（不覆盖 agent 选择）。
      return {
        ...input,
        agentId: explicitAgentId,
        roleId,
        role: await this.roleBindingOf(roleId),
      };
    }

    if (!roleId) {
      throw new BadRequestException({
        code: TEAM_ERRORS.MEMBER_AGENT_REQUIRED,
        message: '成员必须提供 agentId 或 roleId（给 roleId 时用角色默认 Agent 预填）',
      });
    }

    const role = await this.prisma.agentRole.findUnique({
      where: { id: roleId },
      select: { id: true, key: true, name: true, defaultAgentId: true },
    });
    if (!role) {
      throw new NotFoundException({
        code: TEAM_ERRORS.ROLE_NOT_FOUND,
        message: `AgentRole ${roleId} 不存在`,
      });
    }
    if (!role.defaultAgentId) {
      throw new BadRequestException({
        code: TEAM_ERRORS.ROLE_DEFAULT_AGENT_MISSING,
        message: `角色 ${roleId} 未设置默认 Agent，请显式指定 agentId`,
      });
    }
    // 规则 2：只给 roleId → 用角色默认 Agent 预填。
    return {
      ...input,
      agentId: role.defaultAgentId,
      roleId,
      role: { key: role.key, name: role.name },
    };
  }

  /** `roleId` → 角色标签（`AgentRole.key` + `name`）；null/未命中 → null（调用方回退 `agent.name`）。 */
  private async roleBindingOf(
    roleId: string | null,
  ): Promise<{ key: string; name: string } | null> {
    if (!roleId) {
      return null;
    }
    const row = await this.prisma.agentRole.findUnique({
      where: { id: roleId },
      select: { key: true, name: true },
    });
    return row ? { key: row.key, name: row.name } : null;
  }

  private async nextSeqForUpdate(
    tx: any,
    teamId: string,
    agentId: string,
  ): Promise<number> {    // row-level lock: SELECT MAX(seq) FOR UPDATE inside transaction
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

  /**
   * 实例默认别名：`<角色中文名>-<seq>`（FR-08 别名默认规则）。
   *
   * 标签来源（agent-role-decommission todo 5）：`TeamMember.roleId → AgentRole.name`；
   * 未绑角色/关联缺失 → 回退 `agent.name`（**绝不产出空标签**）。与迁移前
   * `ROLE_LABELS[agent.role] ?? agent.name` 对 seed 数据逐字节一致（内置行
   * `AgentRole.key === 旧 agents.role`，`name` 即原映射值）。
   */
  private defaultAlias(
    agent: { name: string },
    seq: number,
    role?: { key: string; name: string } | null,
  ): string {
    return `${roleLabelOf({ role }, agent.name)}-${seq}`;
  }

  private defaultWorkDir(
    agent: { name: string; id?: string },
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
      roleId: m.roleId ?? null,
      alias: m.alias,
      seq: m.seq,
      workDir: m.workDir,
      overrideModelId: m.overrideModelId,
      // opencode 原生 agent 选择（null = 用 opencode 默认 agent）——前端成员面板据此
      // 渲染/高亮当前选择；缺此字段会导致「切换后回显丢失」。
      opencodeAgentName: m.opencodeAgentName,
      agent: m.agent
        ? {
            id: m.agent.id,
            name: m.agent.name,
            // D1（agent-role-decommission todo 5）：字段名保留 `role`，值改为成员绑定角色
            // 的机器键 `AgentRole.key`（web 以 `ROLE_KEYS.includes(role)`/`toAvatarRole` 消费，
            // 必须是 key 而非展示名 `AgentRole.name`，否则头像配色掉兜底）。未绑角色 → null。
            role: roleKeyOf(m),
          }
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
}

export { TEAM_ERRORS };
