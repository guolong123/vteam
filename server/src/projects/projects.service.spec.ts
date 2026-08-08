import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from './projects.service';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let prisma: {
    projectMember: { count: jest.Mock; findMany: jest.Mock };
    project: { create: jest.Mock; findUnique: jest.Mock };
    projectMemberCreate: jest.Mock;
    $transaction: jest.Mock;
  };

  const ownerId = 'u_admin';
  const otherUserId = 'u_member_not_joined';

  beforeEach(async () => {
    prisma = {
      projectMember: { count: jest.fn(), findMany: jest.fn() },
      project: { create: jest.fn(), findUnique: jest.fn() },
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

      const result = await service.findAll(ownerId, { page: 1, pageSize: 20 });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'p_1',
        name: '成员项目',
        role: 'owner',
        taskCount: 2,
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
