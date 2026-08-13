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

  /**
   * MCP 路径成员校验（无 userId，Metis B1）：agent 须是任务团队成员
   * （task_agents 含 agentId 且未 removed）。返回任务状态供归档判定。
   */
  private async assertAgentTaskMember(
    taskId: string,
    agentId: string,
  ): Promise<{ status: string }> {
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
    const ta = await this.prisma.taskAgent.findUnique({
      where: { taskId_agentId: { taskId, agentId } },
      select: { removedAt: true },
    });
    if (!ta || ta.removedAt) {
      throw new ForbiddenException({
        code: PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: 'Agent 不是该任务团队成员',
      });
    }
    return task;
  }

  /** 指派 Agent 须在任务团队未 removed（400 ASSIGNEE_NOT_IN_TEAM）；null 跳过。 */
  private async assertAssigneeInTeam(
    taskId: string,
    assigneeAgentId: string | null | undefined,
  ): Promise<void> {
    if (!assigneeAgentId) return;
    const ta = await this.prisma.taskAgent.findUnique({
      where: { taskId_agentId: { taskId, agentId: assigneeAgentId } },
      select: { removedAt: true },
    });
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
    await this.assertAssigneeInTeam(dto.taskId, dto.assigneeAgentId);

    const issue = await this.prisma.issue.create({
      data: {
        id: await this.idGen.nextId(ISSUE_ID_PREFIX),
        taskId: dto.taskId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        status: ISSUE_STATUS.open,
        tags: (dto.tags ?? []) as Prisma.InputJsonValue,
        assigneeAgentId: dto.assigneeAgentId ?? null,
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

  /** MCP 专用创建：无 userId，creatorAgentId=agentId（createdBy 留空，Metis B1）。 */
  async createByAgent(agentId: string, taskId: string, dto: CreateIssueDto) {
    if (!agentId) {
      throw new BadRequestException({
        code: ISSUE_ERRORS.ISSUE_CREATOR_REQUIRED,
        message: 'Agent 创建缺少 creatorAgentId',
      });
    }
    const task = await this.assertAgentTaskMember(taskId, agentId);
    if (task.status === TASK_STATUS.archived) {
      throw new ConflictException({
        code: ISSUE_ERRORS.ISSUE_TASK_ARCHIVED,
        message: '任务已归档，不可创建 issue',
      });
    }
    await this.assertAssigneeInTeam(taskId, dto.assigneeAgentId);

    const issue = await this.prisma.issue.create({
      data: {
        id: await this.idGen.nextId(ISSUE_ID_PREFIX),
        taskId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        status: ISSUE_STATUS.open,
        tags: (dto.tags ?? []) as Prisma.InputJsonValue,
        assigneeAgentId: dto.assigneeAgentId ?? null,
        assigneeUserId: dto.assigneeUserId ?? null,
        createdBy: null,
        creatorAgentId: agentId,
      },
    });
    return this.toIssueDto(
      await this.prisma.issue.findUnique({
        where: { id: issue.id },
        include: ISSUE_INCLUDE,
      }),
    );
  }

  /** GET /issues：按任务过滤 + status/assigneeAgentId 筛选 + 分页（不含软删）。 */
  async findAll(query: QueryIssuesDto, userId: string) {
    await this.assertTaskMember(query.taskId, userId);
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where: Prisma.IssueWhereInput = {
      taskId: query.taskId,
      deletedAt: null,
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
    if (dto.assigneeAgentId !== undefined) {
      await this.assertAssigneeInTeam(issue.taskId, dto.assigneeAgentId);
    }

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
    if (dto.assigneeUserId !== undefined) {
      data.assigneeUserId = dto.assigneeUserId;
    }

    const updated = await this.prisma.issue.update({
      where: { id },
      data,
      include: ISSUE_INCLUDE,
    });
    return this.toIssueDto(updated);
  }

  /**
   * POST /issues/:id/transition：状态流转。
   * 迁移表驱动（from 不匹配 → 409 ISSUE_INVALID_TRANSITION；已处目标态幂等 200）；
   * 时间戳语义：resolve 置 resolvedAt、close 置 closedAt、reopen 清两者、reject 清 resolvedAt。
   */
  async transition(id: string, userId: string, dto: TransitionIssueDto) {
    const issue = await this.findIssue(id);
    await this.assertTaskMember(issue.taskId, userId);

    const { from, to } = ISSUE_TRANSITIONS[dto.action];
    if (issue.status === to) {
      return this.toIssueDto(issue);
    }
    if (issue.status !== from) {
      throw new ConflictException({
        code: ISSUE_ERRORS.ISSUE_INVALID_TRANSITION,
        message: 'Issue 状态流转不合法',
        details: {
          action: dto.action,
          from,
          to,
          current: issue.status,
        },
      });
    }

    const now = new Date();
    const data: Prisma.IssueUncheckedUpdateInput = { status: to };
    if (dto.action === 'resolve') {
      data.resolvedAt = now;
    } else if (dto.action === 'close') {
      data.closedAt = now;
    } else if (dto.action === 'reopen') {
      data.resolvedAt = null;
      data.closedAt = null;
    } else if (dto.action === 'reject') {
      data.resolvedAt = null;
    }

    const updated = await this.prisma.issue.update({
      where: { id },
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
