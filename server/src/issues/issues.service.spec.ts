import { IssuesService } from './issues.service';
import { ISSUE_TRANSITIONS } from './issues.constants';

const FIXED_DATE = new Date('2026-08-13T00:00:00.000Z');

/** 构造带 include 结构的 issue 行（toIssueDto 输入形状）。 */
const makeRow = (over: Record<string, any> = {}) => ({
  id: 'is_0000000001',
  taskId: 't_0000000001',
  title: '测试 issue',
  description: null,
  status: 'open',
  tags: ['需求'],
  assigneeAgentId: null,
  assigneeUserId: null,
  createdBy: 'u_admin',
  creatorAgentId: null,
  deletedAt: null,
  resolvedAt: null,
  closedAt: null,
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
  task: { title: '测试任务' },
  assigneeAgent: null,
  assigneeUser: null,
  creatorAgent: null,
  creatorUser: { username: 'admin' },
  ...over,
});

describe('IssuesService', () => {
  let prisma: Record<string, any>;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let service: IssuesService;

  const createService = () => {
    prisma = {
      issue: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      task: { findUnique: jest.fn() },
      projectMember: { findUnique: jest.fn() },
      taskAgent: { findUnique: jest.fn() },
      // findAll 用数组形式 $transaction([count, findMany])
      $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
    };
    idGen = {
      nextId: jest.fn(async (prefix: string) => `${prefix}_0000000001`),
      seed: jest.fn(),
    };
    realtime = { broadcast: jest.fn() };
    service = new IssuesService(prisma as any, idGen as any, realtime as any);
  };

  beforeEach(() => {
    createService();
  });

  describe('onModuleInit', () => {
    it('对齐 is_ 前缀 id 生成器（重启续号）', async () => {
      prisma.issue.findMany.mockResolvedValue([{ id: 'is_0000000003' }]);
      await service.onModuleInit();
      expect(idGen.seed).toHaveBeenCalledWith('is', 3);
    });
  });

  describe('create（用户路径）', () => {
    const base = { taskId: 't_0000000001', title: '测试 issue' };

    it('任务不存在 → 404 ISSUE_TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);
      await expect(service.create('u_admin', base as any)).rejects.toMatchObject(
        {
          response: { code: 'ISSUE_TASK_NOT_FOUND' },
        },
      );
    });

    it('非项目成员 → 403 PERMISSION_PROJECT_NOT_MEMBER', async () => {
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue(null);
      await expect(service.create('u_member', base as any)).rejects.toMatchObject(
        {
          response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' },
        },
      );
    });

    it('任务已归档 → 409 ISSUE_TASK_ARCHIVED', async () => {
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'archived',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      await expect(service.create('u_admin', base as any)).rejects.toMatchObject(
        {
          response: { code: 'ISSUE_TASK_ARCHIVED' },
        },
      );
    });

    it('指派 Agent 不在任务团队 → 400 ASSIGNEE_NOT_IN_TEAM', async () => {
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.taskAgent.findUnique.mockResolvedValue(null); // 无团队记录
      await expect(
        service.create('u_admin', { ...base, assigneeAgentId: 'a_x' } as any),
      ).rejects.toMatchObject({ response: { code: 'ASSIGNEE_NOT_IN_TEAM' } });
    });

    it('成功：status=open + tags 落库 + createdBy=userId', async () => {
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.taskAgent.findUnique.mockResolvedValue({ removedAt: null });
      prisma.issue.create.mockResolvedValue({ id: 'is_0000000001' });
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({ assigneeAgentId: 'a_developer', assigneeAgent: { name: '开发者' } }),
      );

      const out = await service.create('u_admin', {
        ...base,
        title: '  测试 issue  ',
        tags: ['需求'],
        assigneeAgentId: 'a_developer',
      } as any);

      expect(prisma.issue.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            taskId: 't_0000000001',
            title: '测试 issue', // trim 后
            status: 'open',
            tags: ['需求'],
            createdBy: 'u_admin',
            creatorAgentId: null,
            assigneeAgentId: 'a_developer',
          }),
        }),
      );
      expect(out).toMatchObject({
        id: 'is_0000000001',
        taskId: 't_0000000001',
        taskTitle: '测试任务',
        title: '测试 issue',
        status: 'open',
        tags: ['需求'],
        assigneeAgentId: 'a_developer',
        assigneeAgentName: '开发者',
        creatorUserId: 'u_admin',
        creatorUserName: 'admin',
      });
    });
  });

  describe('createByAgent（MCP 专用）', () => {
    const base = { taskId: 't_0000000001', title: '需求 issue' };

    it('agentId 缺失 → 400 ISSUE_CREATOR_REQUIRED', async () => {
      await expect(
        service.createByAgent('', 't_0000000001', base as any),
      ).rejects.toMatchObject({ response: { code: 'ISSUE_CREATOR_REQUIRED' } });
    });

    it('agent 不在任务团队 → 403（非 project_members 校验）', async () => {
      prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
      prisma.taskAgent.findUnique.mockResolvedValue(null);
      await expect(
        service.createByAgent('a_x', 't_0000000001', base as any),
      ).rejects.toMatchObject({ response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' } });
    });

    it('成功：creatorAgentId=agentId、createdBy=null（Metis B1）', async () => {
      prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
      prisma.taskAgent.findUnique.mockResolvedValue({ removedAt: null });
      prisma.issue.create.mockResolvedValue({ id: 'is_0000000001' });
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({
          createdBy: null,
          creatorAgentId: 'a_product',
          creatorAgent: { name: '产品经理' },
        }),
      );

      const out = await service.createByAgent(
        'a_product',
        't_0000000001',
        base as any,
      );

      expect(prisma.issue.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            createdBy: null,
            creatorAgentId: 'a_product',
          }),
        }),
      );
      expect(out).toMatchObject({
        creatorAgentId: 'a_product',
        creatorAgentName: '产品经理',
        creatorUserId: null,
      });
    });
  });

  describe('findAll', () => {
    it('非成员 → 403', async () => {
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue(null);
      await expect(
        service.findAll({ taskId: 't_1' } as any, 'u_member'),
      ).rejects.toMatchObject({ response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' } });
    });

    it('按 taskId/status/assigneeAgentId 过滤 + 分页 + 排除软删', async () => {
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.issue.count.mockResolvedValue(1);
      prisma.issue.findMany.mockResolvedValue([makeRow()]);

      const out = await service.findAll(
        {
          taskId: 't_0000000001',
          status: 'open',
          assigneeAgentId: 'a_developer',
          page: 1,
          pageSize: 20,
        } as any,
        'u_admin',
      );

      expect(prisma.issue.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            taskId: 't_0000000001',
            status: 'open',
            assigneeAgentId: 'a_developer',
            deletedAt: null,
          }),
        }),
      );
      expect(prisma.issue.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
          skip: 0,
          take: 20,
        }),
      );
      expect(out).toEqual({
        items: [
          expect.objectContaining({
            id: 'is_0000000001',
            taskTitle: '测试任务',
            status: 'open',
            tags: ['需求'],
          }),
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });
  });

  describe('findOne', () => {
    it('不存在 → 404 ISSUE_NOT_FOUND', async () => {
      prisma.issue.findUnique.mockResolvedValue(null);
      await expect(
        service.findOne('is_x', 'u_admin'),
      ).rejects.toMatchObject({ response: { code: 'ISSUE_NOT_FOUND' } });
    });

    it('已软删视为不存在 → 404', async () => {
      prisma.issue.findUnique.mockResolvedValue(makeRow({ deletedAt: FIXED_DATE }));
      await expect(
        service.findOne('is_x', 'u_admin'),
      ).rejects.toMatchObject({ response: { code: 'ISSUE_NOT_FOUND' } });
    });

    it('非任务成员 → 403', async () => {
      prisma.issue.findUnique.mockResolvedValue(makeRow());
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue(null);
      await expect(
        service.findOne('is_0000000001', 'u_member'),
      ).rejects.toMatchObject({ response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' } });
    });

    it('成功返回详情 DTO', async () => {
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({
          assigneeUserId: 'u_admin',
          assigneeUser: { username: 'admin' },
        }),
      );
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });

      const out = await service.findOne('is_0000000001', 'u_admin');
      expect(out).toMatchObject({
        id: 'is_0000000001',
        taskTitle: '测试任务',
        assigneeUserId: 'u_admin',
        assigneeUserName: 'admin',
      });
    });
  });

  describe('update', () => {
    it('编辑 title/tags 生效', async () => {
      prisma.issue.findUnique.mockResolvedValue(makeRow());
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.issue.update.mockResolvedValue(
        makeRow({ title: '改名', tags: ['缺陷'] }),
      );

      const out = await service.update('is_0000000001', 'u_admin', {
        title: ' 改名 ',
        tags: ['缺陷'],
      } as any);

      expect(prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: '改名',
            tags: ['缺陷'],
          }),
        }),
      );
      expect(out).toMatchObject({ title: '改名', tags: ['缺陷'] });
    });

    it('assigneeAgentId 变更重新团队校验（不在团队 → 400）', async () => {
      prisma.issue.findUnique.mockResolvedValue(makeRow());
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.taskAgent.findUnique.mockResolvedValue(null);

      await expect(
        service.update('is_0000000001', 'u_admin', {
          assigneeAgentId: 'a_x',
        } as any),
      ).rejects.toMatchObject({ response: { code: 'ASSIGNEE_NOT_IN_TEAM' } });
      expect(prisma.issue.update).not.toHaveBeenCalled();
    });

    it('assigneeAgentId=null 清除指派（跳过团队校验）', async () => {
      prisma.issue.findUnique.mockResolvedValue(makeRow());
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.issue.update.mockResolvedValue(makeRow({ assigneeAgentId: null }));

      await service.update('is_0000000001', 'u_admin', {
        assigneeAgentId: null,
      } as any);

      expect(prisma.taskAgent.findUnique).not.toHaveBeenCalled();
      expect(prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ assigneeAgentId: null }) }),
      );
    });
  });

  describe('transition（状态机全迁移）', () => {
    const memberOk = () => {
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
    };

    it('start：open → in_progress', async () => {
      prisma.issue.findUnique.mockResolvedValue(makeRow({ status: 'open' }));
      memberOk();
      prisma.issue.update.mockResolvedValue(
        makeRow({ status: 'in_progress' }),
      );

      const out = await service.transition('is_0000000001', 'u_admin', {
        action: 'start',
      });
      expect(out.status).toBe('in_progress');
    });

    it('resolve：in_progress → resolved（resolvedAt 置 now）', async () => {
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({ status: 'in_progress' }),
      );
      memberOk();
      prisma.issue.update.mockResolvedValue(
        makeRow({ status: 'resolved', resolvedAt: FIXED_DATE }),
      );

      const out = await service.transition('is_0000000001', 'u_admin', {
        action: 'resolve',
      });
      expect(prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'resolved',
            resolvedAt: expect.any(Date),
          }),
        }),
      );
      expect(out.status).toBe('resolved');
    });

    it('close：resolved → closed（closedAt 置 now）', async () => {
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({ status: 'resolved' }),
      );
      memberOk();
      prisma.issue.update.mockResolvedValue(
        makeRow({ status: 'closed', closedAt: FIXED_DATE }),
      );

      await service.transition('is_0000000001', 'u_admin', { action: 'close' });
      expect(prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'closed',
            closedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('reopen：closed → open（resolvedAt/closedAt 清空）', async () => {
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({ status: 'closed', resolvedAt: FIXED_DATE, closedAt: FIXED_DATE }),
      );
      memberOk();
      prisma.issue.update.mockResolvedValue(
        makeRow({ status: 'open', resolvedAt: null, closedAt: null }),
      );

      await service.transition('is_0000000001', 'u_admin', { action: 'reopen' });
      expect(prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'open',
            resolvedAt: null,
            closedAt: null,
          }),
        }),
      );
    });

    it('reject：in_progress → open（resolvedAt 清空）', async () => {
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({ status: 'in_progress', resolvedAt: FIXED_DATE }),
      );
      memberOk();
      prisma.issue.update.mockResolvedValue(
        makeRow({ status: 'open', resolvedAt: null }),
      );

      await service.transition('is_0000000001', 'u_admin', { action: 'reject' });
      expect(prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'open',
            resolvedAt: null,
          }),
        }),
      );
    });

    it('非法迁移：open 直接 resolve → 409 ISSUE_INVALID_TRANSITION', async () => {
      prisma.issue.findUnique.mockResolvedValue(makeRow({ status: 'open' }));
      memberOk();

      await expect(
        service.transition('is_0000000001', 'u_admin', { action: 'resolve' }),
      ).rejects.toMatchObject({ response: { code: 'ISSUE_INVALID_TRANSITION' } });
      expect(prisma.issue.update).not.toHaveBeenCalled();
    });

    it('已处目标态幂等：resolved 调 resolve → 200 返回当前，不更新', async () => {
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({ status: 'resolved', resolvedAt: FIXED_DATE }),
      );
      memberOk();

      const out = await service.transition('is_0000000001', 'u_admin', {
        action: 'resolve',
      });
      expect(out.status).toBe('resolved');
      expect(prisma.issue.update).not.toHaveBeenCalled();
    });

    it('迁移表覆盖全部 5 个动作且 from≠to（迁移表自洽）', () => {
      for (const [action, t] of Object.entries(ISSUE_TRANSITIONS)) {
        expect(t.from).not.toBe(t.to);
        expect(['open', 'in_progress', 'resolved', 'closed']).toContain(
          t.from,
        );
        expect(['open', 'in_progress', 'resolved', 'closed']).toContain(t.to);
      }
    });
  });

  describe('remove（软删）', () => {
    it('置 deletedAt=now，返回 {id, deleted: true}', async () => {
      prisma.issue.findUnique.mockResolvedValue(makeRow());
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.issue.update.mockResolvedValue({ id: 'is_0000000001' });

      const out = await service.remove('is_0000000001', 'u_admin');
      expect(prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(out).toEqual({ id: 'is_0000000001', deleted: true });
    });

    it('非成员 → 403 不落软删', async () => {
      prisma.issue.findUnique.mockResolvedValue(makeRow());
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue(null);

      await expect(
        service.remove('is_0000000001', 'u_member'),
      ).rejects.toMatchObject({ response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' } });
      expect(prisma.issue.update).not.toHaveBeenCalled();
    });
  });
});
