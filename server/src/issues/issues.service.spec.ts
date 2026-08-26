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
  rejectReason: null,
  rejectedAt: null,
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
  task: { title: '测试任务' },
  assigneeAgent: null,
  assigneeUser: null,
  creatorAgent: null,
  creatorUser: { username: 'admin' },
  activities: [],
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
      project: { findUnique: jest.fn() },
      projectMember: { findUnique: jest.fn() },
      taskAgent: { findUnique: jest.fn(), findFirst: jest.fn() },
      issueActivity: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: { findMany: jest.fn() },
      agent: { findMany: jest.fn() },
      // findAll 用数组形式 $transaction([count, findMany])；写路径用回调形式 $transaction(async tx => ...)
      $transaction: jest.fn(async (arg: any) =>
        typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
      ),
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
      await expect(
        service.create('u_admin', base as any),
      ).rejects.toMatchObject({
        response: { code: 'ISSUE_TASK_NOT_FOUND' },
      });
    });

    it('非项目成员 → 403 PERMISSION_PROJECT_NOT_MEMBER', async () => {
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue(null);
      await expect(
        service.create('u_member', base as any),
      ).rejects.toMatchObject({
        response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' },
      });
    });

    it('任务已归档 → 409 ISSUE_TASK_ARCHIVED', async () => {
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'archived',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      await expect(
        service.create('u_admin', base as any),
      ).rejects.toMatchObject({
        response: { code: 'ISSUE_TASK_ARCHIVED' },
      });
    });

    it('指派 Agent 不在任务团队 → 400 ASSIGNEE_NOT_IN_TEAM', async () => {
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.taskAgent.findFirst.mockResolvedValue(null); // 无团队记录
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
      prisma.taskAgent.findFirst.mockResolvedValue({ removedAt: null });
      prisma.issue.create.mockResolvedValue({ id: 'is_0000000001' });
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({
          assigneeAgentId: 'a_developer',
          assigneeAgent: { name: '开发者' },
        }),
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

    it('成功：广播 issue.changed（task scope，is_0000000020 右侧面板实时刷新）', async () => {
      prisma.task.findUnique.mockResolvedValue({
        projectId: 'p_1',
        status: 'pending',
      });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.issue.create.mockResolvedValue({ id: 'is_0000000001' });
      prisma.issue.findUnique.mockResolvedValue(makeRow());

      await service.create('u_admin', base as any);

      expect(realtime.broadcast).toHaveBeenCalledWith(
        'issue.changed',
        expect.objectContaining({
          taskId: 't_0000000001',
          issueId: 'is_0000000001',
          action: 'create',
          status: 'open',
          actorType: 'user',
          actorId: 'u_admin',
        }),
        { type: 'task', id: 't_0000000001' },
      );
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
      prisma.taskAgent.findFirst.mockResolvedValue(null);
      await expect(
        service.createByAgent('a_x', 't_0000000001', base as any),
      ).rejects.toMatchObject({
        response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' },
      });
    });

    it('成功：creatorAgentId=agentId、createdBy=null（Metis B1）', async () => {
      prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
      prisma.taskAgent.findFirst.mockResolvedValue({
        removedAt: null,
        id: 'ta_0000000001',
        agentId: 'a_product',
      });
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

    it('实例 id（ta_ 前缀）：按 task_agents.id 团队校验，creatorAgentId 落真实模板 agent id', async () => {
      prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
      prisma.taskAgent.findFirst.mockResolvedValue({
        removedAt: null,
        id: 'ta_dev_1',
        agentId: 'a_developer',
      });
      prisma.issue.create.mockResolvedValue({ id: 'is_0000000002' });
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({
          createdBy: null,
          creatorAgentId: 'a_developer',
          creatorAgent: { name: '开发者' },
          assigneeInstanceId: 'ta_dev_2',
        }),
      );

      const out = await service.createByAgent('ta_dev_1', 't_0000000001', {
        ...base,
        assigneeInstanceId: 'ta_dev_2',
      } as any);

      // 团队校验按实例 id（task_agents.id），而非 agent_id 列
      expect(prisma.taskAgent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { taskId: 't_0000000001', id: 'ta_dev_1' },
        }),
      );
      // creatorAgentId 落真实模板 agent id（非 selfInstanceId 原文），assigneeInstanceId 精确落库
      expect(prisma.issue.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            createdBy: null,
            creatorAgentId: 'a_developer',
            assigneeInstanceId: 'ta_dev_2',
          }),
        }),
      );
      expect(out).toMatchObject({
        creatorAgentId: 'a_developer',
        creatorAgentName: '开发者',
        assigneeInstanceId: 'ta_dev_2',
      });
    });

    it('实例 id（ta_ 前缀）不在任务团队 → 403，不落库', async () => {
      prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
      prisma.taskAgent.findFirst.mockResolvedValue(null);
      await expect(
        service.createByAgent('ta_not_member', 't_0000000001', base as any),
      ).rejects.toMatchObject({
        response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' },
      });
      expect(prisma.issue.create).not.toHaveBeenCalled();
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
      ).rejects.toMatchObject({
        response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' },
      });
    });

    it('缺少过滤条件（taskId 与 projectId 均无）→ 400 ISSUE_FILTER_REQUIRED', async () => {
      await expect(service.findAll({} as any, 'u_admin')).rejects.toMatchObject(
        { response: { code: 'ISSUE_FILTER_REQUIRED' } },
      );
      expect(prisma.task.findUnique).not.toHaveBeenCalled();
      expect(prisma.issue.count).not.toHaveBeenCalled();
    });

    it('projectId 路径：项目不存在 → 404 PROJECT_NOT_FOUND', async () => {
      prisma.project.findUnique.mockResolvedValue(null);
      await expect(
        service.findAll({ projectId: 'p_x' } as any, 'u_admin'),
      ).rejects.toMatchObject({ response: { code: 'PROJECT_NOT_FOUND' } });
      expect(prisma.projectMember.findUnique).not.toHaveBeenCalled();
    });

    it('projectId 路径：非项目成员 → 403 PERMISSION_PROJECT_NOT_MEMBER', async () => {
      prisma.project.findUnique.mockResolvedValue({ id: 'p_1' });
      prisma.projectMember.findUnique.mockResolvedValue(null);
      await expect(
        service.findAll({ projectId: 'p_1' } as any, 'u_member'),
      ).rejects.toMatchObject({
        response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' },
      });
    });

    it('projectId 路径：按 issue.task.projectId 过滤该项目全部任务 issue', async () => {
      prisma.project.findUnique.mockResolvedValue({ id: 'p_1' });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.issue.count.mockResolvedValue(2);
      prisma.issue.findMany.mockResolvedValue([
        makeRow(),
        makeRow({ id: 'is_0000000002' }),
      ]);

      const out = await service.findAll(
        { projectId: 'p_1', status: 'open', page: 1, pageSize: 20 } as any,
        'u_admin',
      );

      expect(prisma.task.findUnique).not.toHaveBeenCalled();
      expect(prisma.issue.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            task: { projectId: 'p_1' },
            status: 'open',
            deletedAt: null,
          }),
        }),
      );
      expect(prisma.issue.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ task: { projectId: 'p_1' } }),
          skip: 0,
          take: 20,
        }),
      );
      expect(out).toEqual({
        items: [
          expect.objectContaining({
            id: 'is_0000000001',
            taskTitle: '测试任务',
          }),
          expect.objectContaining({
            id: 'is_0000000002',
            taskTitle: '测试任务',
          }),
        ],
        total: 2,
        page: 1,
        pageSize: 20,
      });
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
      await expect(service.findOne('is_x', 'u_admin')).rejects.toMatchObject({
        response: { code: 'ISSUE_NOT_FOUND' },
      });
    });

    it('已软删视为不存在 → 404', async () => {
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({ deletedAt: FIXED_DATE }),
      );
      await expect(service.findOne('is_x', 'u_admin')).rejects.toMatchObject({
        response: { code: 'ISSUE_NOT_FOUND' },
      });
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
      ).rejects.toMatchObject({
        response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' },
      });
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
      prisma.taskAgent.findFirst.mockResolvedValue(null);

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

      expect(prisma.taskAgent.findFirst).not.toHaveBeenCalled();
      expect(prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ assigneeAgentId: null }),
        }),
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
      prisma.issue.update.mockResolvedValue(makeRow({ status: 'in_progress' }));

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
        makeRow({
          status: 'closed',
          resolvedAt: FIXED_DATE,
          closedAt: FIXED_DATE,
        }),
      );
      memberOk();
      prisma.issue.update.mockResolvedValue(
        makeRow({ status: 'open', resolvedAt: null, closedAt: null }),
      );

      await service.transition('is_0000000001', 'u_admin', {
        action: 'reopen',
      });
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

    it('reject：in_progress → rejected（rejectReason 必填 + rejectedAt 置 now，is_0000000013）', async () => {
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({ status: 'in_progress' }),
      );
      memberOk();
      prisma.issue.update.mockResolvedValue(
        makeRow({
          status: 'rejected',
          rejectReason: '测试原因',
          rejectedAt: FIXED_DATE,
        }),
      );

      const out = await service.transition('is_0000000001', 'u_admin', {
        action: 'reject',
        reason: ' 测试原因 ',
      });
      expect(prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'rejected',
            rejectReason: '测试原因', // trim 后
            rejectedAt: expect.any(Date),
          }),
        }),
      );
      expect(out.status).toBe('rejected');
    });

    it('reject 缺原因 → 400 ISSUE_REJECT_REASON_REQUIRED（不落更新）', async () => {
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({ status: 'in_progress' }),
      );
      memberOk();
      await expect(
        service.transition('is_0000000001', 'u_admin', { action: 'reject' }),
      ).rejects.toMatchObject({
        response: { code: 'ISSUE_REJECT_REASON_REQUIRED' },
      });
      expect(prisma.issue.update).not.toHaveBeenCalled();
    });

    it('reopen：rejected → open（清 rejectReason/rejectedAt，is_0000000013）', async () => {
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({
          status: 'rejected',
          rejectReason: '原因',
          rejectedAt: FIXED_DATE,
        }),
      );
      memberOk();
      prisma.issue.update.mockResolvedValue(
        makeRow({ status: 'open', rejectReason: null, rejectedAt: null }),
      );

      await service.transition('is_0000000001', 'u_admin', {
        action: 'reopen',
      });
      expect(prisma.issue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'open',
            rejectReason: null,
            rejectedAt: null,
          }),
        }),
      );
    });

    it('transition 后广播 issue.changed（task scope，is_0000000020）', async () => {
      prisma.issue.findUnique.mockResolvedValue(makeRow({ status: 'open' }));
      memberOk();
      prisma.issue.update.mockResolvedValue(makeRow({ status: 'in_progress' }));

      await service.transition('is_0000000001', 'u_admin', {
        action: 'start',
      });

      expect(realtime.broadcast).toHaveBeenCalledWith(
        'issue.changed',
        expect.objectContaining({
          taskId: 't_0000000001',
          issueId: 'is_0000000001',
          action: 'transition',
          fromStatus: 'open',
          status: 'in_progress',
          actorType: 'user',
          actorId: 'u_admin',
        }),
        { type: 'task', id: 't_0000000001' },
      );
    });

    it('操作记录：transition 落 issue_activities（含操作人 + 拒绝原因 metadata）', async () => {
      prisma.issue.findUnique.mockResolvedValue(
        makeRow({ status: 'in_progress' }),
      );
      memberOk();
      prisma.issue.update.mockResolvedValue(
        makeRow({
          status: 'rejected',
          rejectReason: '原因',
          rejectedAt: FIXED_DATE,
        }),
      );

      await service.transition('is_0000000001', 'u_admin', {
        action: 'reject',
        reason: '原因',
      });

      expect(prisma.issueActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issueId: 'is_0000000001',
            action: 'transition',
            fromStatus: 'in_progress',
            toStatus: 'rejected',
            actorType: 'user',
            actorId: 'u_admin',
            metadata: { reason: '原因' },
          }),
        }),
      );
    });

    it('非法迁移：open 直接 resolve → 409 ISSUE_INVALID_TRANSITION', async () => {
      prisma.issue.findUnique.mockResolvedValue(makeRow({ status: 'open' }));
      memberOk();

      await expect(
        service.transition('is_0000000001', 'u_admin', { action: 'resolve' }),
      ).rejects.toMatchObject({
        response: { code: 'ISSUE_INVALID_TRANSITION' },
      });
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

    it('迁移表覆盖全部 5 个动作且 from≠to（迁移表自洽，is_0000000013 含 rejected 态）', () => {
      const statuses = [
        'open',
        'in_progress',
        'resolved',
        'closed',
        'rejected',
      ];
      for (const [action, t] of Object.entries(ISSUE_TRANSITIONS)) {
        const fromList = Array.isArray(t.from) ? t.from : [t.from];
        expect(fromList.length).toBeGreaterThan(0);
        expect(fromList).not.toContain(t.to);
        expect(statuses).toEqual(expect.arrayContaining(fromList));
        expect(statuses).toContain(t.to);
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
      ).rejects.toMatchObject({
        response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' },
      });
      expect(prisma.issue.update).not.toHaveBeenCalled();
    });
  });

  describe('MCP 专用方法（findAllByAgent/findOneByAgent/updateByAgent/transitionByAgent）', () => {
    const agentTeamOk = () => {
      prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
      prisma.taskAgent.findFirst.mockResolvedValue({ removedAt: null });
    };

    describe('findAllByAgent', () => {
      it('agent 不在任务团队 → 403', async () => {
        prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
        prisma.taskAgent.findFirst.mockResolvedValue(null);
        await expect(
          service.findAllByAgent('a_x', 't_0000000001'),
        ).rejects.toMatchObject({
          response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' },
        });
      });

      it('返回该任务 issue 列表（status 过滤 + 排除软删 + 创建时间倒序）', async () => {
        agentTeamOk();
        prisma.issue.findMany.mockResolvedValue([makeRow()]);

        const out = await service.findAllByAgent(
          'a_developer',
          't_0000000001',
          'open',
        );

        expect(prisma.issue.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              taskId: 't_0000000001',
              status: 'open',
              deletedAt: null,
            }),
            orderBy: { createdAt: 'desc' },
          }),
        );
        expect(out).toEqual([
          expect.objectContaining({
            id: 'is_0000000001',
            taskTitle: '测试任务',
          }),
        ]);
      });

      it('不传 status → 返回全部未删除 issue', async () => {
        agentTeamOk();
        prisma.issue.findMany.mockResolvedValue([makeRow()]);
        await service.findAllByAgent('a_developer', 't_0000000001');
        expect(prisma.issue.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.not.objectContaining({
              status: expect.anything(),
            }),
          }),
        );
      });

      it('实例 id（ta_ 前缀）：团队校验按 task_agents.id 通过', async () => {
        prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
        prisma.taskAgent.findFirst.mockResolvedValue({
          removedAt: null,
          id: 'ta_dev_1',
          agentId: 'a_developer',
        });
        prisma.issue.findMany.mockResolvedValue([makeRow()]);

        const out = await service.findAllByAgent('ta_dev_1', 't_0000000001');

        expect(prisma.taskAgent.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { taskId: 't_0000000001', id: 'ta_dev_1' },
          }),
        );
        expect(out).toEqual([expect.objectContaining({ id: 'is_0000000001' })]);
      });
    });

    describe('findOneByAgent', () => {
      it('issue 不存在 → 404 ISSUE_NOT_FOUND', async () => {
        prisma.issue.findUnique.mockResolvedValue(null);
        await expect(
          service.findOneByAgent('a_developer', 't_0000000001', 'is_x'),
        ).rejects.toMatchObject({ response: { code: 'ISSUE_NOT_FOUND' } });
      });

      it('issue 不属于该 taskId → 404 ISSUE_NOT_FOUND（防跨任务，不触发团队校验）', async () => {
        prisma.issue.findUnique.mockResolvedValue(
          makeRow({ taskId: 't_other' }),
        );
        await expect(
          service.findOneByAgent(
            'a_developer',
            't_0000000001',
            'is_0000000001',
          ),
        ).rejects.toMatchObject({ response: { code: 'ISSUE_NOT_FOUND' } });
        expect(prisma.taskAgent.findFirst).not.toHaveBeenCalled();
      });

      it('agent 不在任务团队 → 403', async () => {
        prisma.issue.findUnique.mockResolvedValue(makeRow());
        prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
        prisma.taskAgent.findFirst.mockResolvedValue(null);
        await expect(
          service.findOneByAgent('a_x', 't_0000000001', 'is_0000000001'),
        ).rejects.toMatchObject({
          response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' },
        });
      });

      it('成功返回详情 DTO', async () => {
        prisma.issue.findUnique.mockResolvedValue(
          makeRow({
            creatorAgentId: 'a_product',
            creatorAgent: { name: '产品' },
          }),
        );
        agentTeamOk();
        const out = await service.findOneByAgent(
          'a_developer',
          't_0000000001',
          'is_0000000001',
        );
        expect(out).toMatchObject({
          id: 'is_0000000001',
          taskId: 't_0000000001',
          creatorAgentName: '产品',
        });
      });
    });

    describe('updateByAgent', () => {
      it('编辑 title/tags 生效（复用 buildUpdateData）', async () => {
        prisma.issue.findUnique.mockResolvedValue(makeRow());
        agentTeamOk();
        prisma.issue.update.mockResolvedValue(
          makeRow({ title: '改名', tags: ['缺陷'] }),
        );

        const out = await service.updateByAgent(
          'a_developer',
          't_0000000001',
          'is_0000000001',
          { title: ' 改名 ', tags: ['缺陷'] } as any,
        );

        expect(prisma.issue.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ title: '改名', tags: ['缺陷'] }),
          }),
        );
        expect(out).toMatchObject({ title: '改名' });
      });

      it('issue 不属于该 taskId → 404（不落更新）', async () => {
        prisma.issue.findUnique.mockResolvedValue(
          makeRow({ taskId: 't_other' }),
        );
        await expect(
          service.updateByAgent(
            'a_developer',
            't_0000000001',
            'is_0000000001',
            {
              title: 'x',
            } as any,
          ),
        ).rejects.toMatchObject({ response: { code: 'ISSUE_NOT_FOUND' } });
        expect(prisma.issue.update).not.toHaveBeenCalled();
      });

      it('agent 不在任务团队 → 403（不落更新）', async () => {
        prisma.issue.findUnique.mockResolvedValue(makeRow());
        prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
        prisma.taskAgent.findFirst.mockResolvedValue(null);
        await expect(
          service.updateByAgent('a_x', 't_0000000001', 'is_0000000001', {
            title: 'x',
          } as any),
        ).rejects.toMatchObject({
          response: { code: 'PERMISSION_PROJECT_NOT_MEMBER' },
        });
        expect(prisma.issue.update).not.toHaveBeenCalled();
      });

      it('assigneeAgentId 变更重新团队校验（不在团队 → 400）', async () => {
        prisma.issue.findUnique.mockResolvedValue(makeRow());
        prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
        // 团队校验（assertAgentTaskMember）通过，assignee 校验（assertAssigneeInTeam）失败
        prisma.taskAgent.findFirst.mockImplementation(async ({ where }: any) =>
          where.agentId === 'a_x' ? null : { removedAt: null },
        );

        await expect(
          service.updateByAgent(
            'a_developer',
            't_0000000001',
            'is_0000000001',
            {
              assigneeAgentId: 'a_x',
            } as any,
          ),
        ).rejects.toMatchObject({ response: { code: 'ASSIGNEE_NOT_IN_TEAM' } });
        expect(prisma.issue.update).not.toHaveBeenCalled();
      });
    });

    describe('transitionByAgent', () => {
      it('start：open → in_progress（复用 applyTransition 状态机核心）', async () => {
        prisma.issue.findUnique.mockResolvedValue(makeRow({ status: 'open' }));
        agentTeamOk();
        prisma.issue.update.mockResolvedValue(
          makeRow({ status: 'in_progress' }),
        );

        const out = await service.transitionByAgent(
          'a_developer',
          't_0000000001',
          'is_0000000001',
          'start',
        );
        expect(out.status).toBe('in_progress');
      });

      it('非法迁移 → 409 ISSUE_INVALID_TRANSITION（不落更新）', async () => {
        prisma.issue.findUnique.mockResolvedValue(makeRow({ status: 'open' }));
        agentTeamOk();
        await expect(
          service.transitionByAgent(
            'a_developer',
            't_0000000001',
            'is_0000000001',
            'resolve',
          ),
        ).rejects.toMatchObject({
          response: { code: 'ISSUE_INVALID_TRANSITION' },
        });
        expect(prisma.issue.update).not.toHaveBeenCalled();
      });

      it('issue 不属于该 taskId → 404（不落更新）', async () => {
        prisma.issue.findUnique.mockResolvedValue(
          makeRow({ taskId: 't_other' }),
        );
        await expect(
          service.transitionByAgent(
            'a_developer',
            't_0000000001',
            'is_0000000001',
            'start',
          ),
        ).rejects.toMatchObject({ response: { code: 'ISSUE_NOT_FOUND' } });
        expect(prisma.issue.update).not.toHaveBeenCalled();
      });

      it('实例 id（ta_ 前缀）：团队校验按 task_agents.id 通过并流转', async () => {
        prisma.issue.findUnique.mockResolvedValue(makeRow({ status: 'open' }));
        prisma.task.findUnique.mockResolvedValue({ status: 'pending' });
        prisma.taskAgent.findFirst.mockResolvedValue({
          removedAt: null,
          id: 'ta_dev_1',
          agentId: 'a_developer',
        });
        prisma.issue.update.mockResolvedValue(
          makeRow({ status: 'in_progress' }),
        );

        const out = await service.transitionByAgent(
          'ta_dev_1',
          't_0000000001',
          'is_0000000001',
          'start',
        );

        expect(prisma.taskAgent.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { taskId: 't_0000000001', id: 'ta_dev_1' },
          }),
        );
        expect(out.status).toBe('in_progress');
      });
    });
  });
});
