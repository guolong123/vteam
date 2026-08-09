import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TASK_STATUS } from '../common/constants/task.constants';
import { CreateProjectDto } from './dto/create-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';

/**
 * 项目服务（FR-25 项目生命周期 - 基础版）。
 *
 * 本版仅实现：
 *   - 列表：返回调用者所属项目（经 project_members 关联，owner 也是 member），分页。
 *   - 创建：创建者写 owner_id，并在 project_members 落 owner 记录。
 *
 * 项目内任务 / 成员管理完整流程、归档逻辑属 Phase 2，不在本文件实现。
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 返回调用者所属的项目列表（成员仅见已加入项目，owner 也是 member，FR-25）。
   * 分页对齐 09 篇 §2：page 从 1 起，pageSize 默认 20。
   * 卡片统计（MOCK-04 真实数据）：taskCount 任务总数；completedTaskCount 已完成数
   * （completed + archived，归档是已完成终态）；agentMembers 项目下任务团队（未移除）
   * Agent 去重列表（附角色供头像渲染）。统计各一次查询（groupBy / findMany），无 N+1。
   */
  async findAll(userId: string, query: QueryProjectsDto) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);

    // 成员可见性：仅返回该用户已加入（project_members 有记录）的项目
    const where = {
      userId,
      ...(query.status ? { project: { status: query.status as string } } : {}),
    };

    const [total, memberRows] = await this.prisma.$transaction([
      this.prisma.projectMember.count({ where }),
      this.prisma.projectMember.findMany({
        where,
        include: {
          project: {
            // 项目卡片任务数（FR-25）：_count 关联统计 tasks 表
            include: { _count: { select: { tasks: true } } },
          },
        },
        orderBy: { project: { createdAt: 'desc' } },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const projectIds = memberRows.map((row) => row.project.id);

    // 已完成数：按项目聚合 completed + archived 任务（一次 groupBy，命中 idx_tasks_project_status）
    const completedGroups =
      projectIds.length === 0
        ? []
        : await this.prisma.task.groupBy({
            by: ['projectId'],
            where: {
              projectId: { in: projectIds },
              status: { in: [TASK_STATUS.completed, TASK_STATUS.archived] },
            },
            _count: { _all: true },
          });
    const completedCountByProject = new Map(
      completedGroups.map((g) => [g.projectId, g._count._all]),
    );

    // Agent 成员：项目下所有任务团队（未移除）Agent 行，内存按项目去重（同 Agent 多任务只算一次）
    const agentRows =
      projectIds.length === 0
        ? []
        : await this.prisma.taskAgent.findMany({
            where: {
              task: { projectId: { in: projectIds } },
              removedAt: null,
            },
            select: {
              task: { select: { projectId: true } },
              agentId: true,
              agent: { select: { id: true, name: true, role: true } },
            },
          });
    const agentsByProject = new Map<
      string,
      { agentId: string; name: string | null; role: string | null }[]
    >();
    for (const row of agentRows) {
      const list = agentsByProject.get(row.task.projectId) ?? [];
      if (!list.some((a) => a.agentId === row.agentId)) {
        list.push({
          agentId: row.agentId,
          name: row.agent.name,
          role: row.agent.role,
        });
        agentsByProject.set(row.task.projectId, list);
      }
    }

    const items = memberRows.map((row) => ({
      id: row.project.id,
      name: row.project.name,
      description: row.project.description,
      ownerId: row.project.ownerId,
      status: row.project.status,
      role: row.role,
      taskCount: row.project._count.tasks,
      completedTaskCount: completedCountByProject.get(row.project.id) ?? 0,
      agentMembers: agentsByProject.get(row.project.id) ?? [],
      createdAt: row.project.createdAt,
      updatedAt: row.project.updatedAt,
    }));

    return { items, total, page, pageSize };
  }

  /**
   * 创建项目：创建者即 owner（FR-25）。
   * 同一事务内写 projects + project_members（owner 记录，role=owner）。
   */
  async create(userId: string, dto: CreateProjectDto) {
    if (!dto.name || dto.name.trim().length === 0) {
      throw new BadRequestException('项目名称不能为空');
    }

    // 事务：项目 + owner 成员记录，保证原子性
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          id: this.nextId(),
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          ownerId: userId,
          status: 'active',
        },
      });

      await tx.projectMember.create({
        data: {
          id: this.nextId('pm'),
          projectId: project.id,
          userId,
          role: 'owner',
        },
      });

      return project;
    });
  }

  /** 校验项目存在（供后续扩展使用，本版未用于对外端点）。 */
  async assertExists(id: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) {
      throw new NotFoundException('项目不存在');
    }
    return project;
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

  /** 简单自增主键：域前缀 + 时间戳 + 随机后缀（对齐 15 篇 §2.2 主键策略）。 */
  private nextId(prefix = 'p'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
