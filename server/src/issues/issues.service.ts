import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PROJECT_MEMBERSHIP_ERRORS } from '../common/guards/project-membership.guard';
import { resyncIdPrefix } from '../common/id-resync';
import { IdGeneratorService } from '../common/id-generator';
import { TASK_STATUS } from '../common/constants/task.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateIssueDto } from './dto/create-issue.dto';
import { QueryIssuesDto } from './dto/query-issues.dto';
import { TransitionIssueDto } from './dto/transition-issue.dto';
import { UpdateIssueDto } from './dto/update-issue.dto';
import {
  ISSUE_ERRORS,
  ISSUE_STATUS,
  ISSUE_TRANSITIONS,
  IssueTransitionAction,
} from './issues.constants';

/** Issue 域主键前缀（15 篇 §2.2：<prefix>_<零填充序号>）。 */
const ISSUE_ID_PREFIX = 'is';

/** findMany/findUnique 统一 include（task 标题 + 指派/创建者名，agent/user 二选一）。 */
const ISSUE_INCLUDE = {
  task: { select: { title: true } },
  assigneeAgent: { select: { name: true } },
  assigneeUser: { select: { username: true } },
  creatorAgent: { select: { name: true } },
  creatorUser: { select: { username: true } },
} satisfies Prisma.IssueInclude;

type IssueRow = Prisma.IssueGetPayload<{ include: typeof ISSUE_INCLUDE }>;

/**
 * Issue 服务（issue-management plan todo 2）。
 *
 * 权限模型（Metis M2/M3）：controller 不挂 AdminGuard/ProjectMembershipGuard
 * （:id 会被后者误解析为 taskId → 404），全部成员校验在 service 内完成——
 * 经 issue.taskId → task.projectId 查 project_members；MCP 路径（无 userId）
 * 改为校验 Agent 在任务团队（task_agents 未 removed）。
 */
@Injectable()
export class IssuesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
  ) {}

  /** 进程启动：按 `is_` 前缀最大序号对齐 id 生成器（重启续号）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.issue, ISSUE_ID_PREFIX, this.idGen);
  }

  /** 用户路径成员校验：任务存在（404）→ 调用者是任务所属项目成员（403）。返回任务状态供归档判定。 */
  private async assertTaskMember(
    taskId: string,
    userId: string,
  ): Promise<{ status: string }> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, status: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: ISSUE_ERRORS.ISSUE_TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: task.projectId, userId } },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException({
        code: PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该项目成员',
      });
    }
    return task;
  }

  /** 项目路径成员校验（GET /issues projectId 过滤用）：项目存在（404）→ 调用者是项目成员（403）。 */
  private async assertProjectMember(projectId: string, userId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundException({
        code: ISSUE_ERRORS.PROJECT_NOT_FOUND,
        message: '项目不存在',
      });
    }
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException({
        code: PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该项目成员',
      });
    }
  }

  /**
   * MCP 归属解析助手（统一实例化）：ref 为任务实例 id（ta_ 前缀）→ 按
   * task_agents.id（实例行）匹配；否则为模板 agent id（a_ 前缀，存量调用兼容）→
   * 按 task_agents.agent_id 匹配。返回实例行（含真实模板 agent id），未命中返回 null。
   * 所有 agent 侧方法（assert/create/findAll/findOne/update/transition）经此前缀分流，
   * 避免散落 startsWith 判断。
   */
  private async resolveAgentInstance(
    taskId: string,
    ref: string,
  ): Promise<{ id: string; agentId: string; removedAt: Date | null } | null> {
    return this.prisma.taskAgent.findFirst({
      where: ref.startsWith('ta_')
        ? { taskId, id: ref }
        : { taskId, agentId: ref },
      select: { id: true, agentId: true, removedAt: true },
    });
  }

  /**
   * MCP 路径成员校验（无 userId，Metis B1）：agentRef（任务实例 id ta_ 前缀或模板
   * agent id，兼容）须是任务团队成员（task_agents 未 removed）。返回任务状态 + 真实
   * 模板 agent id（从实例行解析，供 creatorAgentId 落库）。
   */
  private async assertAgentTaskMember(
    taskId: string,
    agentRef: string,
  ): Promise<{ status: string; agentId: string }> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: ISSUE_ERRORS.ISSUE_TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const ta = await this.resolveAgentInstance(taskId, agentRef);
    if (!ta || ta.removedAt) {
      throw new ForbiddenException({
        code: PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: 'Agent 不是该任务团队成员',
      });
    }
    return { status: task.status, agentId: ta.agentId };
  }

  /**
   * 指派须在任务团队未 removed（400 ASSIGNEE_NOT_IN_TEAM）；null/undefined 跳过。
   * assigneeRef 为实例 id（ta_ 前缀）→ 按 task_agents.id 校验；否则按 agentId 校验
   * （用户路径仍按 Agent 指派，兼容）。前缀分流统一走 resolveAgentInstance。
   */
  private async assertAssigneeInTeam(
    taskId: string,
    assigneeRef?: string | null,
  ): Promise<void> {
    if (!assigneeRef) return;
    const ta = await this.resolveAgentInstance(taskId, assigneeRef);
    if (!ta || ta.removedAt) {
      throw new BadRequestException({
        code: ISSUE_ERRORS.ASSIGNEE_NOT_IN_TEAM,
        message: '指派 Agent 不在任务团队中',
      });
    }
  }

  /** 查 issue（404 若不存在或已软删），返回含关联的完整行。 */
  private async findIssue(id: string): Promise<IssueRow> {
    const issue = await this.prisma.issue.findUnique({
      where: { id },
      include: ISSUE_INCLUDE,
    });
    if (!issue || issue.deletedAt) {
      throw new NotFoundException({
        code: ISSUE_ERRORS.ISSUE_NOT_FOUND,
        message: `Issue ${id} 不存在`,
      });
    }
    return issue;
  }

  /** POST /issues：任务成员建 issue（createdBy=userId）。 */
  async create(userId: string, dto: CreateIssueDto) {
    const task = await this.assertTaskMember(dto.taskId, userId);
    if (task.status === TASK_STATUS.archived) {
      throw new ConflictException({
        code: ISSUE_ERRORS.ISSUE_TASK_ARCHIVED,
        message: '任务已归档，不可创建 issue',
      });
    }
    await this.assertAssigneeInTeam(
      dto.taskId,
      dto.assigneeInstanceId ?? dto.assigneeAgentId,
    );

    const issue = await this.prisma.issue.create({
      data: {
        id: await this.idGen.nextId(ISSUE_ID_PREFIX),
        taskId: dto.taskId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        status: ISSUE_STATUS.open,
        tags: (dto.tags ?? []) as Prisma.InputJsonValue,
        assigneeAgentId: dto.assigneeAgentId ?? null,
        assigneeInstanceId: dto.assigneeInstanceId ?? null,
        assigneeUserId: dto.assigneeUserId ?? null,
        createdBy: userId,
        creatorAgentId: null,
      },
    });
    return this.toIssueDto(
      await this.prisma.issue.findUnique({
        where: { id: issue.id },
        include: ISSUE_INCLUDE,
      }),
    );
  }

  /**
   * MCP 专用创建：无 userId；agentRef 为调用方任务实例 id（ta_ 前缀，platform-mcp
   * 传 selfInstanceId）或模板 agent id（存量兼容）。creatorAgentId 落真实模板 agent id
   * （从实例行解析，非实例 id——外键指向 agents 表），createdBy 留空（Metis B1）。
   */
  async createByAgent(agentRef: string, taskId: string, dto: CreateIssueDto) {
    if (!agentRef) {
      throw new BadRequestException({
        code: ISSUE_ERRORS.ISSUE_CREATOR_REQUIRED,
        message: 'Agent 创建缺少 creatorAgentId',
      });
    }
    const { status, agentId: creatorAgentId } =
      await this.assertAgentTaskMember(taskId, agentRef);
    if (status === TASK_STATUS.archived) {
      throw new ConflictException({
        code: ISSUE_ERRORS.ISSUE_TASK_ARCHIVED,
        message: '任务已归档，不可创建 issue',
      });
    }
    await this.assertAssigneeInTeam(
      taskId,
      dto.assigneeInstanceId ?? dto.assigneeAgentId,
    );

    const issue = await this.prisma.issue.create({
      data: {
        id: await this.idGen.nextId(ISSUE_ID_PREFIX),
        taskId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        status: ISSUE_STATUS.open,
        tags: (dto.tags ?? []) as Prisma.InputJsonValue,
        assigneeAgentId: dto.assigneeAgentId ?? null,
        assigneeInstanceId: dto.assigneeInstanceId ?? null,
        assigneeUserId: dto.assigneeUserId ?? null,
        createdBy: null,
        creatorAgentId,
      },
    });
    return this.toIssueDto(
      await this.prisma.issue.findUnique({
        where: { id: issue.id },
        include: ISSUE_INCLUDE,
      }),
    );
  }

  /** GET /issues：taskId 或 projectId 二选一过滤（均缺 → 400）+ status/assigneeAgentId 筛选 + 分页（不含软删）。 */
  async findAll(query: QueryIssuesDto, userId: string) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    let where: Prisma.IssueWhereInput = { deletedAt: null };
    if (query.taskId) {
      await this.assertTaskMember(query.taskId, userId);
      where.taskId = query.taskId;
    } else if (query.projectId) {
      await this.assertProjectMember(query.projectId, userId);
      where.task = { projectId: query.projectId };
    } else {
      throw new BadRequestException({
        code: ISSUE_ERRORS.ISSUE_FILTER_REQUIRED,
        message: '缺少过滤条件：taskId 或 projectId 至少提供一个',
      });
    }
    where = {
      ...where,
      ...(query.status ? { status: query.status } : {}),
      ...(query.assigneeAgentId
        ? { assigneeAgentId: query.assigneeAgentId }
        : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.issue.count({ where }),
      this.prisma.issue.findMany({
        where,
        include: ISSUE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map((row) => this.toIssueDto(row)),
      total,
      page,
      pageSize,
    };
  }

  /** GET /issues/:id：详情（含 task 标题/指派/创建者名）。 */
  async findOne(id: string, userId: string) {
    const issue = await this.findIssue(id);
    await this.assertTaskMember(issue.taskId, userId);
    return this.toIssueDto(issue);
  }

  /** PATCH /issues/:id：编辑 title/description/tags/assignee（assignee 变更重新团队校验）。 */
  async update(id: string, userId: string, dto: UpdateIssueDto) {
    const issue = await this.findIssue(id);
    await this.assertTaskMember(issue.taskId, userId);
    if (dto.assigneeInstanceId !== undefined) {
      await this.assertAssigneeInTeam(issue.taskId, dto.assigneeInstanceId);
    }
    if (dto.assigneeAgentId !== undefined) {
      await this.assertAssigneeInTeam(issue.taskId, dto.assigneeAgentId);
    }

    const data = this.buildUpdateData(dto);

    const updated = await this.prisma.issue.update({
      where: { id },
      data,
      include: ISSUE_INCLUDE,
    });
    return this.toIssueDto(updated);
  }

  /**
   * POST /issues/:id/transition：状态流转（用户/MCP 共用核心）。
   * 迁移表驱动（from 不匹配 → 409 ISSUE_INVALID_TRANSITION；已处目标态幂等 200）；
   * 时间戳语义：resolve 置 resolvedAt、close 置 closedAt、reopen 清两者、reject 清 resolvedAt。
   */
  async transition(id: string, userId: string, dto: TransitionIssueDto) {
    const issue = await this.findIssue(id);
    await this.assertTaskMember(issue.taskId, userId);
    return this.applyTransition(issue, dto.action as IssueTransitionAction);
  }

  /**
   * 状态流转核心（transition / transitionByAgent 共用）：成员校验已由调用方完成。
   * 幂等（已处目标态直接返回当前 DTO）+ 非法迁移 409 + 时间戳语义。
   */
  private async applyTransition(
    issue: IssueRow,
    action: IssueTransitionAction,
  ) {
    const { from, to } = ISSUE_TRANSITIONS[action];
    if (issue.status === to) {
      return this.toIssueDto(issue);
    }
    if (issue.status !== from) {
      throw new ConflictException({
        code: ISSUE_ERRORS.ISSUE_INVALID_TRANSITION,
        message: 'Issue 状态流转不合法',
        details: {
          action,
          from,
          to,
          current: issue.status,
        },
      });
    }

    const now = new Date();
    const data: Prisma.IssueUncheckedUpdateInput = { status: to };
    if (action === 'resolve') {
      data.resolvedAt = now;
    } else if (action === 'close') {
      data.closedAt = now;
    } else if (action === 'reopen') {
      data.resolvedAt = null;
      data.closedAt = null;
    } else if (action === 'reject') {
      data.resolvedAt = null;
    }

    const updated = await this.prisma.issue.update({
      where: { id: issue.id },
      data,
      include: ISSUE_INCLUDE,
    });
    return this.toIssueDto(updated);
  }

  /** DELETE /issues/:id：软删（deletedAt=now，GET 列表/详情不可见）。 */
  async remove(id: string, userId: string) {
    const issue = await this.findIssue(id);
    await this.assertTaskMember(issue.taskId, userId);
    await this.prisma.issue.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { id, deleted: true };
  }

  // ---------------------------------------------------------------------------
  // MCP 专用方法（platform-mcp issue_* 工具，无 userId，Metis B1/B2）：
  // 归属校验 = agent 须在任务团队（assertAgentTaskMember）+ issue 属于该 taskId。
  // ---------------------------------------------------------------------------

  /**
   * MCP 专用列表：agentRef（实例 id ta_ 或模板 agent id）在任务团队 → 返回该任务
   * 全部 issue 的 DTO 数组
   * （status 可选过滤，不含软删；对齐 findAll 的筛选语义，无分页——MCP 模型直读）。
   */
  async findAllByAgent(
    agentRef: string,
    taskId: string,
    status?: string,
  ) {
    await this.assertAgentTaskMember(taskId, agentRef);
    const where: Prisma.IssueWhereInput = {
      taskId,
      deletedAt: null,
      ...(status ? { status } : {}),
    };
    const rows = await this.prisma.issue.findMany({
      where,
      include: ISSUE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toIssueDto(row));
  }

  /** MCP 专用详情：issue 属于该 taskId（404 否则）→ agentRef 在任务团队（403 否则）。 */
  async findOneByAgent(agentRef: string, taskId: string, issueId: string) {
    const issue = await this.findIssue(issueId);
    this.assertIssueInTask(issue, taskId);
    await this.assertAgentTaskMember(taskId, agentRef);
    return this.toIssueDto(issue);
  }

  /** MCP 专用更新：校验同 findOneByAgent；assigneeInstanceId/assigneeAgentId 变更重新团队校验。 */
  async updateByAgent(
    agentRef: string,
    taskId: string,
    issueId: string,
    dto: UpdateIssueDto,
  ) {
    const issue = await this.findIssue(issueId);
    this.assertIssueInTask(issue, taskId);
    await this.assertAgentTaskMember(taskId, agentRef);
    if (dto.assigneeInstanceId !== undefined) {
      await this.assertAssigneeInTeam(taskId, dto.assigneeInstanceId);
    }
    if (dto.assigneeAgentId !== undefined) {
      await this.assertAssigneeInTeam(taskId, dto.assigneeAgentId);
    }

    const data = this.buildUpdateData(dto);
    const updated = await this.prisma.issue.update({
      where: { id: issueId },
      data,
      include: ISSUE_INCLUDE,
    });
    return this.toIssueDto(updated);
  }

  /** MCP 专用状态流转：校验同 findOneByAgent；核心复用 applyTransition。 */
  async transitionByAgent(
    agentRef: string,
    taskId: string,
    issueId: string,
    action: IssueTransitionAction,
  ) {
    const issue = await this.findIssue(issueId);
    this.assertIssueInTask(issue, taskId);
    await this.assertAgentTaskMember(taskId, agentRef);
    return this.applyTransition(issue, action);
  }

  /** issue 不属于指定任务 → 404（防跨任务越权读取/操作）。 */
  private assertIssueInTask(issue: IssueRow, taskId: string): void {
    if (issue.taskId !== taskId) {
      throw new NotFoundException({
        code: ISSUE_ERRORS.ISSUE_NOT_FOUND,
        message: `Issue ${issue.id} 不属于任务 ${taskId}`,
      });
    }
  }

  /** PATCH 字段组装（update / updateByAgent 共用）：title trim、description 空串归一 null。 */
  private buildUpdateData(dto: UpdateIssueDto): Prisma.IssueUncheckedUpdateInput {
    const data: Prisma.IssueUncheckedUpdateInput = {};
    if (dto.title !== undefined) {
      data.title = dto.title.trim();
    }
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }
    if (dto.tags !== undefined) {
      data.tags = dto.tags as Prisma.InputJsonValue;
    }
    if (dto.assigneeAgentId !== undefined) {
      data.assigneeAgentId = dto.assigneeAgentId;
    }
    if (dto.assigneeInstanceId !== undefined) {
      data.assigneeInstanceId = dto.assigneeInstanceId;
    }
    if (dto.assigneeUserId !== undefined) {
      data.assigneeUserId = dto.assigneeUserId;
    }
    return data;
  }

  /** Issue DTO（含 task 标题 + 指派/创建者名，agent/user 二选一）。 */
  private toIssueDto(row: IssueRow) {
    return {
      id: row.id,
      taskId: row.taskId,
      taskTitle: row.task?.title ?? null,
      title: row.title,
      description: row.description,
      status: row.status,
      tags: this.toTags(row.tags),
      assigneeAgentId: row.assigneeAgentId,
      assigneeAgentName: row.assigneeAgent?.name ?? null,
      assigneeInstanceId: row.assigneeInstanceId,
      assigneeUserId: row.assigneeUserId,
      assigneeUserName: row.assigneeUser?.username ?? null,
      creatorAgentId: row.creatorAgentId,
      creatorAgentName: row.creatorAgent?.name ?? null,
      creatorUserId: row.createdBy,
      creatorUserName: row.creatorUser?.username ?? null,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    };
  }

  /** tags Json 列解析为字符串数组（非字符串元素忽略）。 */
  private toTags(tags: Prisma.JsonValue | null): string[] {
    if (!Array.isArray(tags)) return [];
    return tags.filter((t): t is string => typeof t === 'string');
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
