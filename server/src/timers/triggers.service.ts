import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Trigger } from '@prisma/client';
import {
  TRIGGER_API_ERRORS,
  TRIGGER_KIND,
  TRIGGER_KIND_LABEL,
  TRIGGER_SOURCE,
  triggerSourceOf,
  type TriggerSource,
} from '../common/constants/trigger.constants';
import { PrismaService } from '../prisma/prisma.service';
import { roleKeyOf } from '../common/agent-role-label';
import { TRIGGER_STATUS } from './trigger.service';
import { QueryTriggersDto } from './dto/query-triggers.dto';

/** GET/DELETE /triggers 调用方上下文（全局 JwtAuthGuard 填充 request.user）。 */
export interface TriggerViewer {
  id: string;
}

/**
 * 触发器列表项：行字段白名单 + `source` 派生。
 * payload/dedupKey/guardKey/intervalMs 等执行细节不外泄（最小暴露）。
 */
export interface TriggerListItem {
  id: string;
  kind: string;
  status: string;
  dueAt: Date | null;
  nextFireAt: Date | null;
  scopeType: string | null;
  scopeId: string | null;
  ownerInstanceId: string | null;
  fireCount: number;
  skipReason: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: Date;
  source: TriggerSource;
  display: TriggerDisplay;
}

/**
 * 列表项人类可读展示（triggers-display，一次列表请求内批量解析、内存 join）。
 * 缺失引用一律降级为 `rawId（已删除）`，永不抛错、永不 500 列表。
 */
export interface TriggerDisplay {
  scopeLabel: string;
  scopeTeam: string | null;
  ownerLabel: string;
  taskLabel: string | null;
  description: string;
}

/** 已删除标记（缺失引用的统一降级后缀，行内保留 raw id 可追查）。 */
const DELETED_MARK = '（已删除）';

/** 已终态：cancel 幂等直返当前行（200，不重写 fired/cancelled 历史）。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>([
  TRIGGER_STATUS.CANCELLED,
  TRIGGER_STATUS.FIRED,
]);

/**
 * 触发器只读列表 + 取消（trigger-unification todo-22，/system/triggers 与
 * 团队会话触发 Tab 的 REST 底座）。
 *
 * 鉴权（计划锁定决策 5：取消必须服务端复核 owner/admin，UI 隐藏不算权限）：
 * - 列表：admin 看全局；成员必须带 `teamId`（缺失 → 403
 *   TRIGGER_TEAM_SCOPE_REQUIRED，fail closed），且仅返回归属该团队的行；
 *   非该团队成员带其 teamId → 空集（对齐 chat 频道列表“不泄漏存在性”惯例）。
 * - 取消：行不存在 → 404；admin 全放行；成员仅可取消本团队的 agent 项
 *   （hook_fire/hook_poll），系统项只读 → 403 TRIGGER_SYSTEM_READONLY，
 *   跨团队 → 403 TRIGGER_FORBIDDEN。
 *
 * 归属说明：REST JWT 身份是 userId，无法与 `tmm_` 级 ownerInstanceId 逐字
 * 相等（逐字 owner 复核归 MCP hook_cancel，见 todo-12，其 callerId 即 tmm_）。
 * REST 侧的所有权域 = 触发器归属团队，服务端经 team_user_members /
 * team_members / payload.teamId / task 归属多路解析，不信任客户端传参。
 */
@Injectable()
export class TriggersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /triggers：过滤 + 分页 {items, total, page, pageSize}
   *（对齐 tools.findAll/memories.findAll 契约与 normalize 口径）。
   */
  async findAll(query: QueryTriggersDto = {}, viewer: TriggerViewer) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where = await this.buildWhere(query, viewer);
    if (where === null) {
      return { items: [], total: 0, page, pageSize };
    }
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.trigger.count({ where }),
      this.prisma.trigger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const displays = await this.enrichDisplays(rows as Trigger[]);
    return {
      items: (rows as Trigger[]).map((row, i) => this.toItem(row, displays[i])),
      total,
      page,
      pageSize,
    };
  }

  /**
   * DELETE /triggers/:id：取消（status→cancelled）。
   * 已 cancelled/fired → 200 直返当前态（幂等，不抛 500/409，不重写终态）；
   * 其余状态 → 置 cancelled 后返回。
   */
  async cancelForUser(id: string, viewer: TriggerViewer) {
    const row = (await this.prisma.trigger.findUnique({
      where: { id },
    })) as Trigger | null;
    if (!row) {
      throw new NotFoundException({
        code: TRIGGER_API_ERRORS.TRIGGER_NOT_FOUND,
        message: `触发器 ${id} 不存在`,
      });
    }
    if (!(await this.isPlatformAdmin(viewer))) {
      await this.assertMemberCancellable(row, viewer);
    }
    if (TERMINAL_STATUSES.has(row.status)) {
      const [display] = await this.enrichDisplays([row]);
      return this.toItem(row, display);
    }
    const updated = (await this.prisma.trigger.update({
      where: { id },
      data: { status: TRIGGER_STATUS.CANCELLED },
    })) as Trigger;
    const [display] = await this.enrichDisplays([updated]);
    return this.toItem(updated, display);
  }

  /**
   * 列表 where 构建（服务端授权核心）。
   * admin → 全局过滤；成员 → teamId 必填 + 行归属约束；非成员 → null（空集）。
   */
  private async buildWhere(
    query: QueryTriggersDto,
    viewer: TriggerViewer,
  ): Promise<Prisma.TriggerWhereInput | null> {
    const scalar: Prisma.TriggerWhereInput = {
      scopeType: query.scopeType ? { equals: query.scopeType } : undefined,
      scopeId: query.scopeId ? { equals: query.scopeId } : undefined,
      status: query.status ? { equals: query.status } : undefined,
      kind: query.kind ? { equals: query.kind } : undefined,
    };
    // payload JSON 双条件（teamId/taskId）必须各自独立子句——同 key 会覆盖，
    // 故一律走 AND 数组；path 须 `$.` 前缀（MySQL JSON_EXTRACT 口径，
    // 无前缀报 3143 Invalid JSON path，见 todo-22 live 证据）。
    const payloadAnd: Prisma.TriggerWhereInput[] = [];
    if (query.taskId) {
      payloadAnd.push({ payload: { path: '$.taskId', equals: query.taskId } });
    }
    if (await this.isPlatformAdmin(viewer)) {
      if (query.teamId) {
        payloadAnd.push({
          payload: { path: '$.teamId', equals: query.teamId },
        });
      }
      return {
        ...scalar,
        ...(payloadAnd.length > 0 ? { AND: payloadAnd } : {}),
      };
    }
    if (!query.teamId) {
      throw new ForbiddenException({
        code: TRIGGER_API_ERRORS.TRIGGER_TEAM_SCOPE_REQUIRED,
        message: '成员查看触发器列表必须带 teamId（全局列表仅管理员可见）',
      });
    }
    if (!(await this.isTeamMember(query.teamId, viewer.id))) {
      return null;
    }
    if (query.taskId) {
      payloadAnd.push({ payload: { path: '$.taskId', equals: query.taskId } });
    }
    return {
      ...scalar,
      OR: await this.teamAttributionOr(query.teamId),
      ...(payloadAnd.length > 0 ? { AND: payloadAnd } : {}),
    };
  }

  /**
   * 行归属团队的多路 OR（与 resolveTriggerTeam 同口径的 SQL 版）：
   * scope 直标 team → payload.teamId → owner 所在团队。
   * payload.taskId→task 归属仅 DELETE 逐行解析（LIST 不做全表 task join）。
   */
  private async teamAttributionOr(
    teamId: string,
  ): Promise<Prisma.TriggerWhereInput[]> {
    const or: Prisma.TriggerWhereInput[] = [
      { scopeType: 'team', scopeId: teamId },
      { payload: { path: '$.teamId', equals: teamId } },
    ];
    const memberIds = await this.teamInstanceIds(teamId);
    if (memberIds.length > 0) {
      or.push({ ownerInstanceId: { in: memberIds } });
    }
    return or;
  }

  /**
   * 成员取消复核（assertWorkerTask/Team 同风格：维度内精确匹配，无回退）。
   * 系统项成员一律 403；agent 项要求调用者是行归属团队成员，否则 403。
   */
  private async assertMemberCancellable(
    row: Trigger,
    viewer: TriggerViewer,
  ): Promise<void> {
    if (triggerSourceOf(row.kind) === TRIGGER_SOURCE.SYSTEM) {
      throw new ForbiddenException({
        code: TRIGGER_API_ERRORS.TRIGGER_SYSTEM_READONLY,
        message: '系统触发器仅管理员可取消',
      });
    }
    const teamId = await this.resolveTriggerTeam(row);
    if (!teamId || !(await this.isTeamMember(teamId, viewer.id))) {
      throw new ForbiddenException({
        code: TRIGGER_API_ERRORS.TRIGGER_FORBIDDEN,
        message: '仅该触发器归属团队成员或管理员可取消',
      });
    }
  }

  /**
   * 行归属团队解析：scope 直标 → owner 实例所在团队 → payload.teamId →
   * payload.taskId 经任务归属；全空 → null（调用方 fail closed）。
   */
  private async resolveTriggerTeam(row: Trigger): Promise<string | null> {
    if (row.scopeType === 'team' && row.scopeId) {
      return row.scopeId;
    }
    if (row.ownerInstanceId) {
      const member = await this.prisma.teamMember.findUnique({
        where: { id: row.ownerInstanceId },
        select: { teamId: true },
      });
      if (member?.teamId) {
        return member.teamId;
      }
    }
    const payload = row.payload as
      { teamId?: unknown; taskId?: unknown } | null | undefined;
    if (payload && typeof payload.teamId === 'string' && payload.teamId) {
      return payload.teamId;
    }
    if (payload && typeof payload.taskId === 'string' && payload.taskId) {
      const task = await this.prisma.task.findUnique({
        where: { id: payload.taskId },
        select: { teamId: true },
      });
      if (task?.teamId) {
        return task.teamId;
      }
    }
    return null;
  }

  private async isTeamMember(teamId: string, userId: string): Promise<boolean> {
    const hit = await this.prisma.teamUserMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { id: true },
    });
    return hit !== null;
  }

  private async teamInstanceIds(teamId: string): Promise<string[]> {
    const rows = await this.prisma.teamMember.findMany({
      where: { teamId },
      select: { id: true },
    });
    return (rows ?? []).map((row) => row.id);
  }

  /**
   * 平台管理员判定（复用 AdminGuard 语义，见 users/admin.guard.ts 与
   * tools.service.ts isPlatformAdmin：permissions.all 或 users.manage）。
   */
  private async isPlatformAdmin(viewer: TriggerViewer): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: viewer.id },
      include: { role: true },
    });
    if (!user || !user.enabled) {
      return false;
    }
    const permissions = (user.role.permissions ?? {}) as Record<
      string,
      unknown
    >;
    if (permissions.all === true) {
      return true;
    }
    const usersPerm = permissions.users as { manage?: boolean } | undefined;
    return usersPerm?.manage === true;
  }

  /** 行 → 列表项（字段白名单 + source 唯一映射入口 + display 展示）。 */
  private toItem(row: Trigger, display?: TriggerDisplay): TriggerListItem {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      dueAt: row.dueAt,
      nextFireAt: row.nextFireAt,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      ownerInstanceId: row.ownerInstanceId,
      fireCount: row.fireCount,
      skipReason: row.skipReason,
      lastError: row.lastError,
      attempts: row.attempts,
      createdAt: row.createdAt,
      source: triggerSourceOf(row.kind),
      display: display ?? this.fallbackDisplay(row),
    };
  }

  /**
   * display 批量富化（triggers-display）：每页列表共 8 个 `findMany … where
   * id in […]`（teams / channels+team / tasks+team / members+agent /
   * sessions / hooks / receipts / issues），缺席集合直接跳过查询，然后
   * 内存 join 逐行组装。
   * sessions 需先行（其 teamMemberId 合并进 memberIds 后再批量查 members），
   * 其余 7 个并行。任意一步异常 → 整页回退 fallbackDisplay（列表永不 500）。
   * 查询计数/列表调用：count + findMany（1 个 $transaction）+ ≤8 富化 = ≤10，
   * 无 N+1。
   */
  private async enrichDisplays(rows: Trigger[]): Promise<TriggerDisplay[]> {
    try {
      const teamIds = new Set<string>();
      const channelIds = new Set<string>();
      const taskIds = new Set<string>();
      const memberIds = new Set<string>();
      const sessionIds = new Set<string>();
      const hookIds = new Set<string>();
      const receiptIds = new Set<string>();
      const issueIds = new Set<string>();
      const payloads = rows.map((row) => this.payloadOf(row));
      rows.forEach((row, i) => {
        if (row.scopeType === 'team' && row.scopeId) teamIds.add(row.scopeId);
        if (row.scopeType === 'channel' && row.scopeId)
          channelIds.add(row.scopeId);
        if (row.scopeType === 'task' && row.scopeId) taskIds.add(row.scopeId);
        if (row.ownerInstanceId) memberIds.add(row.ownerInstanceId);
        const p = payloads[i];
        for (const key of ['teamId', 'taskId', 'channelId'] as const) {
          const v = p[key];
          if (typeof v === 'string' && v) {
            if (key === 'teamId') teamIds.add(v);
            else if (key === 'taskId') taskIds.add(v);
            else channelIds.add(v);
          }
        }
        for (const key of [
          'toInstanceId',
          'fromInstanceId',
          'teamMemberId',
        ] as const) {
          const v = p[key];
          if (typeof v === 'string' && v) memberIds.add(v);
        }
        const sessionId = p['sessionId'];
        if (typeof sessionId === 'string' && sessionId)
          sessionIds.add(sessionId);
        const hookId = p['hookId'];
        if (typeof hookId === 'string' && hookId) hookIds.add(hookId);
        const receiptId = p['receiptId'];
        if (typeof receiptId === 'string' && receiptId)
          receiptIds.add(receiptId);
        const issueId = p['issueId'];
        if (typeof issueId === 'string' && issueId) issueIds.add(issueId);
      });
      // sessions 先行：带 teamMember include（Prisma 内部批处理 join，无 N+1），
      // 解析出的成员 id 合并进 memberIds 后再走 members 批量，ctx 保持扁平形状
      const sessions = await this.inIds<{
        id: string;
        teamMember: {
          id: string;
          alias: string | null;
          agent: { name: string } | null;
          role: { key: string; name: string } | null;
        } | null;
      }>(
        'session',
        {
          id: true,
          teamMember: {
            select: {
              id: true,
              alias: true,
              agent: { select: { name: true } },
              role: { select: { key: true, name: true } },
            },
          },
        },
        sessionIds,
      );
      for (const s of sessions) {
        if (s.teamMember) memberIds.add(s.teamMember.id);
      }
      const [teams, channels, tasks, members, hooks, receipts, issues] =
        await Promise.all([
          this.inIds<{ id: string; name: string }>(
            'team',
            { id: true, name: true },
            teamIds,
          ),
          this.inIds<{
            id: string;
            type: string;
            team: { id: string; name: string } | null;
          }>(
            'chatChannel',
            {
              id: true,
              type: true,
              team: { select: { id: true, name: true } },
            },
            channelIds,
          ),
          this.inIds<{
            id: string;
            title: string;
            team: { id: string; name: string } | null;
          }>(
            'task',
            {
              id: true,
              title: true,
              team: { select: { id: true, name: true } },
            },
            taskIds,
          ),
          this.inIds<{
            id: string;
            alias: string | null;
            agent: { name: string } | null;
            role: { key: string; name: string } | null;
          }>(
            'teamMember',
            {
              id: true,
              alias: true,
              agent: { select: { name: true } },
              role: { select: { key: true, name: true } },
            },
            memberIds,
          ),
          this.inIds<{ id: string; wakeText: string }>(
            'hook',
            { id: true, wakeText: true },
            hookIds,
          ),
          this.inIds<{ id: string; summary: string }>(
            'messageReceipt',
            { id: true, summary: true },
            receiptIds,
          ),
          this.inIds<{ id: string; title: string }>(
            'issue',
            { id: true, title: true },
            issueIds,
          ),
        ]);
      const byId = <T extends { id: string }>(list: T[]): Map<string, T> =>
        new Map(list.map((e) => [e.id, e]));
      const ctx = {
        teams: byId<{ id: string; name: string }>(teams),
        channels: byId<{
          id: string;
          type: string;
          team: { id: string; name: string } | null;
        }>(channels),
        tasks: byId<{
          id: string;
          title: string;
          team: { id: string; name: string } | null;
        }>(tasks),
        members: byId<{
          id: string;
          alias: string | null;
          agent: { name: string } | null;
          role: { key: string; name: string } | null;
        }>(members),
        sessions: byId<{ id: string; teamMemberId: string | null }>(
          sessions.map((s) => ({
            id: s.id,
            teamMemberId: s.teamMember?.id ?? null,
          })),
        ),
        hooks: byId<{ id: string; wakeText: string }>(hooks),
        receipts: byId<{ id: string; summary: string }>(receipts),
        issues: byId<{ id: string; title: string }>(issues),
      };
      return rows.map((row, i) => this.buildDisplay(row, payloads[i], ctx));
    } catch {
      return rows.map((row) => this.fallbackDisplay(row));
    }
  }

  /** 缺席 delegate（旧单测 mock 未挂载）与空集合直接回 []，不抛错。 */
  private async inIds<T>(
    delegate: string,
    select: object,
    ids: Set<string>,
  ): Promise<T[]> {
    if (ids.size === 0) return [];
    try {
      const table = (
        this.prisma as unknown as Record<
          string,
          { findMany?: (args: unknown) => Promise<T[]> } | undefined
        >
      )[delegate];
      if (!table?.findMany) return [];
      return (
        (await table.findMany({
          where: { id: { in: [...ids] } },
          select,
        })) ?? []
      );
    } catch {
      return [];
    }
  }

  private payloadOf(row: Trigger): Record<string, unknown> {
    const p = row.payload as unknown;
    return typeof p === 'object' && p !== null
      ? (p as Record<string, unknown>)
      : {};
  }

  private str(v: unknown): string | null {
    return typeof v === 'string' && v ? v : null;
  }

  private collapse(v: string, max: number): string {
    return v.replace(/\s+/g, ' ').trim().slice(0, max);
  }

  private kindLabel(kind: string): string {
    return TRIGGER_KIND_LABEL[kind] ?? kind;
  }

  private fallbackDisplay(row: Trigger): TriggerDisplay {
    return {
      scopeLabel:
        row.scopeType && row.scopeId
          ? `${row.scopeType}/${row.scopeId}`
          : '全局',
      scopeTeam: null,
      ownerLabel: row.ownerInstanceId ?? '—',
      taskLabel: null,
      description: this.kindLabel(row.kind),
    };
  }

  private buildDisplay(
    row: Trigger,
    p: Record<string, unknown>,
    ctx: {
      teams: Map<string, { id: string; name: string }>;
      channels: Map<
        string,
        { id: string; type: string; team: { id: string; name: string } | null }
      >;
      tasks: Map<
        string,
        { id: string; title: string; team: { id: string; name: string } | null }
      >;
      members: Map<
        string,
        {
          id: string;
          alias: string | null;
          agent: { name: string } | null;
          role: { key: string; name: string } | null;
        }
      >;
      sessions: Map<string, { id: string; teamMemberId: string | null }>;
      hooks: Map<string, { id: string; wakeText: string }>;
      receipts: Map<string, { id: string; summary: string }>;
      issues: Map<string, { id: string; title: string }>;
    },
  ): TriggerDisplay {
    const taskId = this.str(p['taskId']);
    const teamId = this.str(p['teamId']);
    const channelId = this.str(p['channelId']);
    const task = taskId ? ctx.tasks.get(taskId) : undefined;
    const payloadTeam = teamId ? ctx.teams.get(teamId) : undefined;
    const channel = channelId ? ctx.channels.get(channelId) : undefined;

    let scopeLabel: string;
    let scopeTeam: string | null = null;
    let taskLabel: string | null = null;
    if (row.scopeType === 'team' && row.scopeId) {
      const t = ctx.teams.get(row.scopeId);
      scopeLabel = t ? t.name : `${row.scopeId}${DELETED_MARK}`;
      scopeTeam = t ? t.name : null;
    } else if (row.scopeType === 'channel' && row.scopeId) {
      const c = ctx.channels.get(row.scopeId);
      if (c) {
        scopeLabel = `${c.team?.name ?? c.type} · ${this.channelLabel(c.type)}`;
        scopeTeam = c.team?.name ?? null;
      } else {
        scopeLabel = `${row.scopeId}${DELETED_MARK}`;
      }
    } else if (row.scopeType === 'task' && row.scopeId) {
      const t = ctx.tasks.get(row.scopeId);
      if (t) {
        scopeLabel = t.title;
        scopeTeam = t.team?.name ?? null;
        taskLabel = t.title;
      } else {
        scopeLabel = `${row.scopeId}${DELETED_MARK}`;
      }
    } else if (task) {
      scopeLabel = task.title;
      scopeTeam = task.team?.name ?? payloadTeam?.name ?? null;
      taskLabel = task.title;
    } else if (taskId) {
      scopeLabel = `${taskId}${DELETED_MARK}`;
      scopeTeam = payloadTeam?.name ?? null;
    } else if (channel) {
      scopeLabel = `${channel.team?.name ?? channel.type} · ${this.channelLabel(channel.type)}`;
      scopeTeam = channel.team?.name ?? null;
    } else if (channelId) {
      scopeLabel = `${channelId}${DELETED_MARK}`;
      scopeTeam = payloadTeam?.name ?? null;
    } else if (payloadTeam) {
      scopeLabel = payloadTeam.name;
      scopeTeam = payloadTeam.name;
    } else if (teamId) {
      scopeLabel = `${teamId}${DELETED_MARK}`;
    } else {
      scopeLabel = '全局';
    }
    if (!taskLabel && task) taskLabel = task.title;

    const ownerId =
      row.ownerInstanceId ??
      this.str(p['toInstanceId']) ??
      this.str(p['teamMemberId']) ??
      this.str(p['fromInstanceId']);
    let ownerLabel = '—';
    if (ownerId) {
      const m = ctx.members.get(ownerId);
      if (m) {
        const alias = m.alias ?? m.agent?.name ?? ownerId;
        // 角色来源（agent-role-decommission todo 5）：成员绑定角色的机器键
        // `AgentRole.key`；未绑 → 回退 agent.name（与旧 `agent.role ?? agent.name` 同规则）。
        const role = roleKeyOf(m) ?? m.agent?.name;
        ownerLabel = role && alias !== role ? `${alias}（${role}）` : alias;
      } else {
        ownerLabel = `${ownerId}${DELETED_MARK}`;
      }
    }

    return {
      scopeLabel,
      scopeTeam,
      ownerLabel,
      taskLabel,
      description: this.buildDescription(row, p, ctx, task ?? null),
    };
  }

  private channelLabel(type: string): string {
    if (type === 'team_group') return '群聊';
    if (type === 'private') return '私聊';
    return type;
  }

  private buildDescription(
    row: Trigger,
    p: Record<string, unknown>,
    ctx: {
      hooks: Map<string, { id: string; wakeText: string }>;
      receipts: Map<string, { id: string; summary: string }>;
      issues: Map<string, { id: string; title: string }>;
      members: Map<
        string,
        {
          id: string;
          alias: string | null;
          agent: { name: string } | null;
          role: { key: string; name: string } | null;
        }
      >;
      sessions: Map<string, { id: string; teamMemberId: string | null }>;
    },
    task: { id: string; title: string } | null,
  ): string {
    const fallback = this.kindLabel(row.kind);
    if (
      row.kind === TRIGGER_KIND.HOOK_FIRE ||
      row.kind === TRIGGER_KIND.HOOK_POLL
    ) {
      const hookId = this.str(p['hookId']);
      const hook = hookId ? ctx.hooks.get(hookId) : undefined;
      if (hook) return this.collapse(hook.wakeText, 120) || fallback;
      if (hookId) return `${fallback} · ${hookId}${DELETED_MARK}`;
      const purpose = this.str(p['purpose']);
      return purpose ? this.collapse(purpose, 120) : fallback;
    }
    if (row.kind === TRIGGER_KIND.RECEIPT_NUDGE) {
      const receiptId = this.str(p['receiptId']);
      const receipt = receiptId ? ctx.receipts.get(receiptId) : undefined;
      if (receipt) return this.collapse(receipt.summary, 100) || fallback;
      if (receiptId) return `${fallback} · ${receiptId}${DELETED_MARK}`;
      return fallback;
    }
    if (row.kind === TRIGGER_KIND.REVIEW_ROUND_TIMEOUT) {
      const issueId = this.str(p['issueId']);
      const round = p['round'];
      const roundText =
        typeof round === 'number' || typeof round === 'string'
          ? ` 第${round}轮`
          : '';
      if (issueId) {
        const issue = ctx.issues.get(issueId);
        return `评审轮次超时 · issue《${issue?.title ?? `${issueId}${DELETED_MARK}`}》${roundText}`.trim();
      }
      return fallback;
    }
    if (row.kind === TRIGGER_KIND.PROGRESSION_PATROL) {
      if (task) return `任务《${task.title}》巡检`;
      const tid = this.str(p['taskId']);
      if (tid) return `任务《${tid}${DELETED_MARK}》巡检`;
      return fallback;
    }
    if (row.kind === TRIGGER_KIND.SESSION_IDLE_SCAN) {
      const sessionId = this.str(p['sessionId']);
      const suffix =
        p['reason'] === 'silent-session' ? '事件静默看门狗' : '空闲扫描';
      if (sessionId) {
        // 会话 → 成员展示（owner join 同镜像：alias，回退 agent 名）；raw id 留括号可追查。
        // 会话/成员缺失 → 既有 `会话 <id>（已删除） <suffix>` 降级，列表永不 500。
        const session = ctx.sessions.get(sessionId);
        const memberId = session?.teamMemberId ?? null;
        const member = memberId ? ctx.members.get(memberId) : undefined;
        if (member) {
          const label = member.alias ?? member.agent?.name ?? memberId;
          return `${label} 的会话${suffix} (${sessionId})`;
        }
        return `会话 ${sessionId}${DELETED_MARK} ${suffix}`;
      }
      const scope = this.str(p['scope']);
      return scope ? `空闲扫描 · ${scope}` : fallback;
    }
    return fallback;
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
