import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Trigger } from '@prisma/client';
import {
  TRIGGER_API_ERRORS,
  TRIGGER_SOURCE,
  triggerSourceOf,
  type TriggerSource,
} from '../common/constants/trigger.constants';
import { PrismaService } from '../prisma/prisma.service';
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
}

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
    return {
      items: (rows as Trigger[]).map((row) => this.toItem(row)),
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
      return this.toItem(row);
    }
    const updated = (await this.prisma.trigger.update({
      where: { id },
      data: { status: TRIGGER_STATUS.CANCELLED },
    })) as Trigger;
    return this.toItem(updated);
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
      | { teamId?: unknown; taskId?: unknown }
      | null
      | undefined;
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

  private async isTeamMember(
    teamId: string,
    userId: string,
  ): Promise<boolean> {
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

  /** 行 → 列表项（字段白名单 + source 唯一映射入口）。 */
  private toItem(row: Trigger): TriggerListItem {
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
