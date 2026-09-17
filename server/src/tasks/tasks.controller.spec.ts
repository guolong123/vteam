import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { REQUIRE_PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import {
  TEAM_MEMBERSHIP_ERRORS,
  TeamMembershipGuard,
} from '../common/guards/team-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import { RejectTaskDto } from './dto/reject-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UploadPlanDocDto } from './dto/upload-plan-doc.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { PlanLifecycleService } from './plan-lifecycle.service';
import { PlanStepsService } from './plan-steps.service';
import { PlanDocsService } from './plan-docs.service';

describe('TasksController', () => {
  let controller: TasksController;
  let service: {
    findAll: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    updateTeam: jest.Mock;
    start: jest.Mock;
    markPendingReview: jest.Mock;
    accept: jest.Mock;
    reject: jest.Mock;
    archive: jest.Mock;
  };
  let prisma: {
    teamUserMember: { findUnique: jest.Mock; findMany: jest.Mock };
  };
  let planLifecycle: {
    confirmPlan: jest.Mock;
    completePlan: jest.Mock;
    getPlan: jest.Mock;
  };
  let planDocs: { listPlanDocs: jest.Mock; writePlanDoc: jest.Mock };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      create: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      updateTeam: jest.fn(),
      start: jest.fn(),
      markPendingReview: jest.fn(),
      accept: jest.fn(),
      reject: jest.fn(),
      archive: jest.fn(),
    };
    prisma = {
      teamUserMember: { findUnique: jest.fn(), findMany: jest.fn() },
    };
    planLifecycle = {
      confirmPlan: jest.fn(),
      completePlan: jest.fn(),
      getPlan: jest.fn(),
    };
    planDocs = { listPlanDocs: jest.fn(), writePlanDoc: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TasksController],
      providers: [
        { provide: TasksService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        { provide: PlanStepsService, useValue: { listPlanSteps: jest.fn() } },
        {
          provide: PlanDocsService,
          useValue: planDocs,
        },
        { provide: PlanLifecycleService, useValue: planLifecycle },
        TeamMembershipGuard,
      ],
    })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TasksController>(TasksController);
  });

  describe('路由形状（去 pid：POST /tasks + GET /tasks?teamId=）', () => {
    const pathOf = (handler: (...args: never[]) => unknown) =>
      Reflect.getMetadata(PATH_METADATA, handler);
    const methodOf = (handler: (...args: never[]) => unknown) =>
      Reflect.getMetadata(METHOD_METADATA, handler);

    it('GET /tasks（findAll）无 pid 路由', () => {
      expect(pathOf(controller.findAll)).toBe('tasks');
      expect(methodOf(controller.findAll)).toBe(0); // RequestMethod.GET
    });

    it('POST /tasks（create）无 pid 路由', () => {
      expect(pathOf(controller.create)).toBe('tasks');
      expect(methodOf(controller.create)).toBe(1); // RequestMethod.POST
    });

    it('全控制器无 pid 残留路由（sweep 断言）', () => {
      const names = Object.getOwnPropertyNames(
        TasksController.prototype,
      ).filter((n) => n !== 'constructor');
      for (const name of names) {
        const p = pathOf(
          (controller as unknown as Record<string, () => unknown>)[name] as (
            ...args: never[]
          ) => unknown,
        );
        expect(String(p ?? '')).not.toContain('projects');
        expect(String(p ?? '')).not.toContain(':pid');
      }
    });

    it('Todo11：旧 POST tasks/:id/instances/:instanceId/reset-session 已删除（404）', () => {
      expect(
        (TasksController.prototype as any).resetInstanceSession,
      ).toBeUndefined();
      const names = Object.getOwnPropertyNames(
        TasksController.prototype,
      ).filter((n) => n !== 'constructor');
      for (const name of names) {
        const p = pathOf(
          (TasksController.prototype as any)[name] as (
            ...args: never[]
          ) => unknown,
        );
        expect(String(p ?? '')).not.toContain('reset-session');
      }
    });
  });

  describe('端点路由转发', () => {
    it('GET tasks?teamId= 成员转发 teamId + query 到 findAll', async () => {
      const result = { items: [], total: 0, page: 1, pageSize: 20 };
      service.findAll.mockResolvedValue(result);
      prisma.teamUserMember.findUnique.mockResolvedValue({
        teamId: 'tm_1',
        userId: 'u_admin',
      });

      const out = await controller.findAll(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        { status: 'pending', page: 1, pageSize: 20 },
        'tm_1',
      );

      expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 'tm_1', userId: 'u_admin' } },
      });
      expect(service.findAll).toHaveBeenCalledWith({
        status: 'pending',
        page: 1,
        pageSize: 20,
        teamId: 'tm_1',
      });
      expect(out).toEqual(result);
    });

    it('GET tasks?teamId= 非成员抛 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      const err = await controller
        .findAll(
          { id: 'u_out', username: 'outsider', roleId: 'r_member' },
          { status: 'pending' },
          'tm_1',
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { status: number }).status).toBe(403);
      expect((err as { getResponse: () => unknown }).getResponse()).toEqual({
        code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该团队成员',
      });
      expect(service.findAll).not.toHaveBeenCalled();
    });

    it('GET tasks 无 teamId 按可见团队聚合分页（createdAt desc）', async () => {
      prisma.teamUserMember.findMany.mockResolvedValue([
        { teamId: 'tm_1' },
        { teamId: 'tm_2' },
      ]);
      service.findAll.mockImplementation(async (q: { teamId?: string }) => ({
        items:
          q.teamId === 'tm_1'
            ? [{ id: 't_old', createdAt: '2026-09-02T00:00:00.000Z' }]
            : [{ id: 't_new', createdAt: '2026-09-03T00:00:00.000Z' }],
        total: 1,
        page: 1,
        pageSize: 100,
      }));

      const out = (await controller.findAll(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        { page: 1, pageSize: 20 },
        undefined,
      )) as {
        items: { id: string }[];
        total: number;
        page: number;
        pageSize: number;
      };

      expect(service.findAll).toHaveBeenCalledTimes(2);
      expect(out.total).toBe(2);
      expect(out.items.map((i) => i.id)).toEqual(['t_new', 't_old']);
      expect(out.page).toBe(1);
      expect(out.pageSize).toBe(20);
    });

    it('GET tasks 无 teamId 且用户无任何团队返回空页（不查 service）', async () => {
      prisma.teamUserMember.findMany.mockResolvedValue([]);

      const out = await controller.findAll(
        { id: 'u_lonely', username: 'lonely', roleId: 'r_member' },
        { page: 1, pageSize: 20 },
        undefined,
      );

      expect(out).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
      expect(service.findAll).not.toHaveBeenCalled();
    });

    it('POST tasks 以 req.user.id 调用 create(userId, dto)', async () => {
      const task = { id: 't_1' };
      service.create.mockResolvedValue(task);
      const dto = {
        title: '任务',
        teamId: 'tm_0000000001',
      };

      const out = await controller.create(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        dto as CreateTaskDto,
      );

      expect(service.create).toHaveBeenCalledWith('u_admin', dto);
      expect(out).toEqual(task);
    });

    it('GET tasks/:id 转发 id 到 findOne', async () => {
      service.findOne.mockResolvedValue({ id: 't_1' });

      const out = await controller.findOne('t_1');

      expect(service.findOne).toHaveBeenCalledWith('t_1');
      expect(out).toEqual({ id: 't_1' });
    });

    it('GET tasks/:id/plan-steps 转发 id 到 planStepsService（计划 Tab 步骤区）', async () => {
      const planSteps = {
        listPlanSteps: jest
          .fn()
          .mockResolvedValue({ steps: [], workerId: null, degraded: true }),
      };
      (controller as any).planStepsService = planSteps;

      const out = await controller.listPlanSteps('t_1');

      expect(planSteps.listPlanSteps).toHaveBeenCalledWith('t_1');
      expect(out).toEqual({ steps: [], workerId: null, degraded: true });
    });

    it('GET tasks/:id/plan-docs 转发 id 到 planDocsService（计划 Tab 列表区）', async () => {
      const planDocs = {
        listPlanDocs: jest.fn().mockResolvedValue({
          files: [],
          workerId: null,
          directory: '/data/vteam-worker/tasks/t_1',
          degraded: true,
        }),
      };
      (controller as any).planDocsService = planDocs;

      const out = await controller.listPlanDocs('t_1');

      expect(planDocs.listPlanDocs).toHaveBeenCalledWith('t_1');
      expect(out.degraded).toBe(true);
    });

    it('POST tasks/:id/plan-docs 只把 name/content 透传（directory 由服务端定位，不由前端指定）', async () => {
      const planDocs = {
        writePlanDoc: jest.fn().mockResolvedValue({
          name: 'up.md',
          updatedAt: 'x',
          directory: '/d',
        }),
      };
      (controller as any).planDocsService = planDocs;

      const out = await controller.uploadPlanDoc('t_1', {
        name: 'up.md',
        content: '# 正文',
      } as UploadPlanDocDto);

      expect(planDocs.writePlanDoc).toHaveBeenCalledWith('t_1', {
        name: 'up.md',
        content: '# 正文',
      });
      expect(out.name).toBe('up.md');
    });

    it('POST tasks/:id/plan-docs 定位不到 worker → 503（不是 500，用户需能区分"暂不可用"与"服务端故障"）', async () => {
      const planDocs = {
        writePlanDoc: jest
          .fn()
          .mockRejectedValue(
            new Error(
              '未定位到可用的 worker（团队无主 Agent / 无会话 / worker 离线）',
            ),
          ),
      };
      (controller as any).planDocsService = planDocs;

      await expect(
        controller.uploadPlanDoc('t_1', {
          name: 'a.md',
          content: 'x',
        } as UploadPlanDocDto),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('POST tasks/:id/plan-docs 其他错误原样抛出（如 worker 侧 400 不伪装成 503）', async () => {
      const planDocs = {
        writePlanDoc: jest
          .fn()
          .mockRejectedValue(new Error('plan-file HTTP 400: name 非法')),
      };
      (controller as any).planDocsService = planDocs;

      await expect(
        controller.uploadPlanDoc('t_1', {
          name: 'a.md',
          content: 'x',
        } as UploadPlanDocDto),
      ).rejects.toThrow(/name 非法/);
    });

    it('PATCH tasks/:id 转发 id + dto 到 update', async () => {
      service.update.mockResolvedValue({ id: 't_1', title: '改名' });
      const dto = { title: '改名' };

      const out = await controller.update('t_1', dto as UpdateTaskDto);

      expect(service.update).toHaveBeenCalledWith('t_1', dto);
      expect(out).toEqual({ id: 't_1', title: '改名' });
    });

    it('POST tasks/:id/start 以 req.user.id 转发到 start', async () => {
      service.start.mockResolvedValue({ id: 't_1', status: 'in_progress' });

      const out = await controller.start(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        't_1',
      );

      expect(service.start).toHaveBeenCalledWith('t_1', 'u_admin');
      expect(out).toEqual({ id: 't_1', status: 'in_progress' });
    });

    it('POST tasks/:id/mark-pending-review 转发到 markPendingReview', async () => {
      service.markPendingReview.mockResolvedValue({
        id: 't_1',
        status: 'pending_review',
      });

      const out = await controller.markPendingReview(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        't_1',
      );

      expect(service.markPendingReview).toHaveBeenCalledWith('t_1', 'u_admin');
      expect(out).toEqual({ id: 't_1', status: 'pending_review' });
    });

    it('POST tasks/:id/accept 转发到 accept（缺省 body → force=false）', async () => {
      service.accept.mockResolvedValue({ id: 't_1', status: 'completed' });

      const out = await controller.accept(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        't_1',
      );

      expect(service.accept).toHaveBeenCalledWith('t_1', 'u_admin', {
        force: false,
        forceReason: undefined,
      });
      expect(out).toEqual({ id: 't_1', status: 'completed' });
    });

    it('POST tasks/:id/accept 透传 force + reason 到 accept', async () => {
      service.accept.mockResolvedValue({ id: 't_1', status: 'completed' });

      const out = await controller.accept(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        't_1',
        { force: true, reason: '已线下确认' },
      );

      expect(service.accept).toHaveBeenCalledWith('t_1', 'u_admin', {
        force: true,
        forceReason: '已线下确认',
      });
      expect(out).toEqual({ id: 't_1', status: 'completed' });
    });

    it('POST tasks/:id/reject 转发 id + dto 到 reject', async () => {
      service.reject.mockResolvedValue({ id: 't_1', status: 'in_progress' });
      const dto = { reason: '缺结论' };

      const out = await controller.reject(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        't_1',
        dto as RejectTaskDto,
      );

      expect(service.reject).toHaveBeenCalledWith('t_1', 'u_admin', dto);
      expect(out).toEqual({ id: 't_1', status: 'in_progress' });
    });

    it('POST tasks/:id/archive 转发到 archive（缺省 body → force=false）', async () => {
      service.archive.mockResolvedValue({ id: 't_1', status: 'archived' });

      const out = await controller.archive(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        't_1',
      );

      expect(service.archive).toHaveBeenCalledWith('t_1', 'u_admin', {
        force: false,
        forceReason: undefined,
      });
      expect(out).toEqual({ id: 't_1', status: 'archived' });
    });

    it('POST tasks/:id/archive 透传 force 到 archive', async () => {
      service.archive.mockResolvedValue({ id: 't_1', status: 'archived' });

      const out = await controller.archive(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        't_1',
        { force: true },
      );

      expect(service.archive).toHaveBeenCalledWith('t_1', 'u_admin', {
        force: true,
        forceReason: undefined,
      });
      expect(out).toEqual({ id: 't_1', status: 'archived' });
    });

    it('POST tasks/:id/team 以 req.user.id 转发 id + dto 到 updateTeam', async () => {
      service.updateTeam.mockResolvedValue({
        id: 't_1',
        teamAgentIds: ['a_1'],
      });
      const dto = {
        addInstances: [{ agentId: 'a_2' }],
        removeInstanceIds: ['tmm_1'],
      };

      const out = await controller.updateTeam(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        't_1',
        dto as UpdateTeamDto,
      );

      expect(service.updateTeam).toHaveBeenCalledWith('t_1', dto, 'u_admin');
      expect(out).toEqual({ id: 't_1', teamAgentIds: ['a_1'] });
    });
  });

  describe('DTO 校验（class-validator）', () => {
    const errorsOf = async (cls: new () => object, obj: object) =>
      validate(plainToInstance(cls, obj));

    it('CreateTaskDto：title 必填、priority 枚举、teamId 必填', async () => {
      expect(await errorsOf(CreateTaskDto, {})).not.toHaveLength(0);
      expect(
        await errorsOf(CreateTaskDto, {
          title: 'x',
          priority: 'urgent',
          teamId: 'tm_0000000001',
        }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(CreateTaskDto, {
          title: 'x',
        }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(CreateTaskDto, {
          title: 'x',
          teamId: 123,
        }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(CreateTaskDto, {
          title: 'x',
          priority: 'high',
          teamId: 'tm_0000000001',
          backgroundDocs: [{ name: 'd' }],
        }),
      ).toHaveLength(0);
    });

    it('QueryTasksDto：status 须为五态之一，page/pageSize 正整数', async () => {
      expect(
        await errorsOf(QueryTasksDto, { status: 'doing' }),
      ).not.toHaveLength(0);
      expect(await errorsOf(QueryTasksDto, { page: 0 })).not.toHaveLength(0);
      expect(
        await errorsOf(QueryTasksDto, {
          status: 'pending_review',
          page: 2,
          pageSize: 50,
        }),
      ).toHaveLength(0);
    });

    it('UpdateTaskDto：priority 枚举，title/description 可选，主实例/主 Agent 兼容', async () => {
      expect(
        await errorsOf(UpdateTaskDto, { priority: 'urgent' }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(UpdateTaskDto, {
          title: 'x',
          description: 'd',
          priority: 'low',
          mainAgentInstanceId: 'tmm_1',
          mainAgentId: 'a_1',
        }),
      ).toHaveLength(0);
    });

    it('RejectTaskDto：reason 可选字符串', async () => {
      expect(await errorsOf(RejectTaskDto, {})).toHaveLength(0);
      expect(
        await errorsOf(RejectTaskDto, { reason: '缺性能测试结论' }),
      ).toHaveLength(0);
      expect(await errorsOf(RejectTaskDto, { reason: 42 })).not.toHaveLength(0);
    });

    it('UpdateTeamDto：addInstances/removeInstanceIds 可选实例形状', async () => {
      expect(await errorsOf(UpdateTeamDto, {})).toHaveLength(0);
      expect(
        await errorsOf(UpdateTeamDto, {
          addInstances: [{ agentId: 'a_1', alias: '开发者-2' }],
          removeInstanceIds: ['tmm_1', 'tmm_2'],
        }),
      ).toHaveLength(0);
      expect(
        await errorsOf(UpdateTeamDto, { addInstances: 'a_1' }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(UpdateTeamDto, {
          removeInstanceIds: [42],
        }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(UpdateTeamDto, {
          addInstances: [{ alias: '缺 agentId' }],
        }),
      ).not.toHaveLength(0);
    });

    it('UploadPlanDocDto：合法 .md 通过（与 worker PLAN_DOC_NAME_RE 对齐）', async () => {
      expect(
        await errorsOf(UploadPlanDocDto, {
          name: 'plan-v1.2.md',
          content: '# 正文',
        }),
      ).toHaveLength(0);
      expect(
        await errorsOf(UploadPlanDocDto, { name: 'a.md', content: 'x' }),
      ).toHaveLength(0);
    });

    it('UploadPlanDocDto：非法 name（穿越/子目录/非 .md/点开头/空格/空串）一律拒绝', async () => {
      for (const name of [
        '../evil.md',
        'a/b.md',
        '/tmp/evil.md',
        'a.txt',
        'noext',
        '.hidden.md',
        '-bad.md',
        'a b.md',
        '',
      ]) {
        expect(
          await errorsOf(UploadPlanDocDto, { name, content: '# x' }),
        ).not.toHaveLength(0);
      }
    });

    it('UploadPlanDocDto：content 缺省/非字符串/空串 → 拒绝（不允许落空文件）', async () => {
      expect(
        await errorsOf(UploadPlanDocDto, { name: 'a.md' }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(UploadPlanDocDto, { name: 'a.md', content: 123 }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(UploadPlanDocDto, { name: 'a.md', content: '' }),
      ).not.toHaveLength(0);
    });
  });

  describe('权限点守卫（CONF-02 方案②补齐矩阵守卫）', () => {
    const permOf = (handler: (...args: unknown[]) => unknown) =>
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler);

    it('读端点挂 tasks.view（列表/详情/计划步骤/计划文档）', () => {
      expect(permOf(controller.findAll)).toBe('tasks.view');
      expect(permOf(controller.findOne)).toBe('tasks.view');
      expect(permOf(controller.listPlanSteps)).toBe('tasks.view');
      expect(permOf(controller.listPlanDocs)).toBe('tasks.view');
    });

    it('创建端点挂 tasks.create', () => {
      expect(permOf(controller.create)).toBe('tasks.create');
    });

    it('编辑类端点挂 tasks.edit（update/team/start/mark-pending-review/archive/上传计划文档）', () => {
      expect(permOf(controller.update)).toBe('tasks.edit');
      expect(permOf(controller.updateTeam)).toBe('tasks.edit');
      expect(permOf(controller.start)).toBe('tasks.edit');
      expect(permOf(controller.markPendingReview)).toBe('tasks.edit');
      expect(permOf(controller.archive)).toBe('tasks.edit');
      // 上传计划文档会改变 agent 的执行输入，与任务编辑同级
      expect(permOf(controller.uploadPlanDoc)).toBe('tasks.edit');
    });

    it('验收类端点挂 tasks.review（accept/reject）', () => {
      expect(permOf(controller.accept)).toBe('tasks.review');
      expect(permOf(controller.reject)).toBe('tasks.review');
    });

    it('todo11：确认门挂 tasks.edit（任一成员可点，不限主）/完工挂 tasks.review/状态读挂 tasks.view', () => {
      expect(permOf(controller.confirmPlan)).toBe('tasks.edit');
      expect(permOf(controller.completePlan)).toBe('tasks.review');
      expect(permOf(controller.getPlan)).toBe('tasks.view');
    });
  });

  describe('todo11 用户确认门路由（POST confirm / PATCH complete / GET plan）', () => {
    const user = { id: 'u_1', username: '成员甲', roleId: 'r_member' };

    it('POST tasks/:id/plan/confirm 转发确认人+动作+原因', async () => {
      const result = { plan: { status: 'executing' }, idempotent: false };
      planLifecycle.confirmPlan.mockResolvedValue(result);

      const out = await controller.confirmPlan(user, 't_1', {
        action: 'reject',
        reason: '范围过大',
      });

      expect(planLifecycle.confirmPlan).toHaveBeenCalledWith('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        action: 'reject',
        reason: '范围过大',
      });
      expect(out).toEqual(result);
    });

    it('POST tasks/:id/plan/confirm 缺省动作为 confirm', async () => {
      planLifecycle.confirmPlan.mockResolvedValue({ idempotent: false });

      await controller.confirmPlan(user, 't_1', {});

      expect(planLifecycle.confirmPlan).toHaveBeenCalledWith('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        action: 'confirm',
        reason: null,
      });
    });

    it('POST tasks/:id/plan/confirm 转发定稿动作 finalize', async () => {
      const result = { plan: { status: 'approved' }, idempotent: false };
      planLifecycle.confirmPlan.mockResolvedValue(result);

      const out = await controller.confirmPlan(user, 't_1', {
        action: 'finalize',
      });

      expect(planLifecycle.confirmPlan).toHaveBeenCalledWith('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        action: 'finalize',
        reason: null,
      });
      expect(out).toEqual(result);
    });

    it('PATCH tasks/:id/plan/complete 转发主实例（缺省用户 PM 路径）', async () => {
      planLifecycle.completePlan.mockResolvedValue({ idempotent: false });

      await controller.completePlan(user, 't_1', { instanceId: 'tmm_main' });
      expect(planLifecycle.completePlan).toHaveBeenCalledWith('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        instanceId: 'tmm_main',
      });

      await controller.completePlan(user, 't_1', {});
      expect(planLifecycle.completePlan).toHaveBeenCalledWith('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        instanceId: null,
      });
    });

    it('GET tasks/:id/plan 状态读DB：文件存在时以DB为准并附展示告警', async () => {
      planLifecycle.getPlan.mockResolvedValue({
        id: 'pl_1',
        taskId: 't_1',
        status: 'executing',
      });
      planDocs.listPlanDocs.mockResolvedValue({
        files: [{ name: 'plan.md' }],
        workerId: 'w_1',
        directory: '.opencode/plans',
        degraded: false,
      });

      const out = (await controller.getPlan('t_1')) as {
        status: string;
        source: string;
        warning?: string;
        fileDocs: { displayOnly: boolean; count: number };
      };

      expect(out.status).toBe('executing');
      expect(out.source).toBe('db');
      expect(out.fileDocs).toMatchObject({ displayOnly: true, count: 1 });
      expect(out.warning).toContain('仅展示');
    });

    it('GET tasks/:id/plan 无文件时无告警；文档降级不阻断状态读取', async () => {
      planLifecycle.getPlan.mockResolvedValue({
        id: 'pl_1',
        taskId: 't_1',
        status: 'draft',
      });
      planDocs.listPlanDocs.mockResolvedValue({
        files: [],
        workerId: null,
        directory: '',
        degraded: true,
      });

      const out = (await controller.getPlan('t_1')) as {
        status: string;
        warning?: string;
      };
      expect(out.status).toBe('draft');
      expect(out.warning).toBeUndefined();

      planDocs.listPlanDocs.mockRejectedValue(new Error('worker down'));
      const degraded = (await controller.getPlan('t_1')) as {
        status: string;
      };
      expect(degraded.status).toBe('draft');
    });
  });
});
