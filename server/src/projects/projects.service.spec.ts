import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from './projects.service';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let prisma: {
    projectMember: { count: jest.Mock; findMany: jest.Mock };
    project: { create: jest.Mock; findUnique: jest.Mock };
    task: { create: jest.Mock; findUnique: jest.Mock; groupBy: jest.Mock };
    taskAgent: { findMany: jest.Mock };
    projectMemberCreate: jest.Mock;
    $transaction: jest.Mock;
  };

  const ownerId = 'u_admin';
  const otherUserId = 'u_member_not_joined';

  beforeEach(async () => {
    prisma = {
      projectMember: { count: jest.fn(), findMany: jest.fn() },
      project: { create: jest.fn(), findUnique: jest.fn() },
      task: { create: jest.fn(), findUnique: jest.fn(), groupBy: jest.fn() },
      taskAgent: { findMany: jest.fn() },
      projectMemberCreate: jest.fn(),
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  describe('findAll（成员可见性）', () => {
    it('仅返回调用者已加入的项目（经 project_members 关联）', async () => {
      const memberRows = [
        {
          role: 'owner',
          project: {
            id: 'p_1',
            name: '成员项目',
            description: 'desc',
            ownerId,
            status: 'active',
            _count: { tasks: 2 },
            createdAt: new Date('2026-08-06T00:00:00Z'),
            updatedAt: new Date('2026-08-06T00:00:00Z'),
          },
        },
      ];
      prisma.$transaction.mockResolvedValue([1, memberRows]);
      prisma.task.groupBy.mockResolvedValue([
        { projectId: 'p_1', _count: { _all: 1 } },
      ]);
      prisma.taskAgent.findMany.mockResolvedValue([
        {
          task: { projectId: 'p_1' },
          agentId: 'a_product',
          agent: { id: 'a_product', name: '产品经理', role: 'product' },
        },
        {
          task: { projectId: 'p_1' },
          agentId: 'a_developer',
          agent: { id: 'a_developer', name: '开发者', role: 'developer' },
        },
        // 同 Agent 在多个任务（历史任务）只算一次
        {
          task: { projectId: 'p_1' },
          agentId: 'a_product',
          agent: { id: 'a_product', name: '产品经理', role: 'product' },
        },
      ]);

      const result = await service.findAll(ownerId, { page: 1, pageSize: 20 });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'p_1',
        name: '成员项目',
        role: 'owner',
        taskCount: 2,
        completedTaskCount: 1,
      });
      // agentMembers 去重：a_product 出现 2 次只保留 1 个，附角色供头像渲染
      expect(result.items[0].agentMembers).toEqual([
        { agentId: 'a_product', name: '产品经理', role: 'product' },
        { agentId: 'a_developer', name: '开发者', role: 'developer' },
      ]);
      expect(prisma.task.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['projectId'],
          where: {
            projectId: { in: ['p_1'] },
            status: { in: ['completed', 'archived'] },
          },
        }),
      );
    });

    it('无成员任务/无 Agent 成员时统计回落 0 与空数组', async () => {
      const memberRows = [
        {
          role: 'member',
          project: {
            id: 'p_2',
            name: '空项目',
            description: null,
            ownerId,
            status: 'active',
            _count: { tasks: 0 },
            createdAt: new Date('2026-08-06T00:00:00Z'),
            updatedAt: new Date('2026-08-06T00:00:00Z'),
          },
        },
      ];
      prisma.$transaction.mockResolvedValue([1, memberRows]);
      prisma.task.groupBy.mockResolvedValue([]);
      prisma.taskAgent.findMany.mockResolvedValue([]);

      const result = await service.findAll(ownerId, { page: 1, pageSize: 20 });

      expect(result.items[0]).toMatchObject({
        id: 'p_2',
        taskCount: 0,
        completedTaskCount: 0,
        agentMembers: [],
      });
    });

    it('未加入项目的用户看不到任何项目（成员可见性）', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      const result = await service.findAll(otherUserId, {
        page: 1,
        pageSize: 20,
      });

      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
      // 无项目时不发统计查询
      expect(prisma.task.groupBy).not.toHaveBeenCalled();
      expect(prisma.taskAgent.findMany).not.toHaveBeenCalled();
    });
  });

  describe('create（owner 写入）', () => {
    it('创建项目并写入 project_members owner 记录', async () => {
      const createdProject = {
        id: 'p_new',
        name: '新项目',
        description: null,
        ownerId,
        status: 'active',
      };
      prisma.$transaction.mockImplementation(
        async (fn: (tx: any) => Promise<any>) =>
          fn({
            project: { create: jest.fn().mockResolvedValue(createdProject) },
            projectMember: { create: jest.fn().mockResolvedValue(true) },
          }),
      );

      const result = await service.create(ownerId, { name: '新项目' });

      expect(result).toMatchObject({ id: 'p_new', ownerId, status: 'active' });
      // 事务内 projectMember.create 被调用（owner 落库）
      const txCb = prisma.$transaction.mock.calls[0][0];
      expect(typeof txCb).toBe('function');
    });

    it('名称为空时抛 BadRequestException', async () => {
      await expect(service.create(ownerId, { name: ' ' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
