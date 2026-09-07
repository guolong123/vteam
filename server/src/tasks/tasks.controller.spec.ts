import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
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
import { UpdateExecutionModeDto } from './dto/update-execution-mode.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

describe('TasksController', () => {
  let controller: TasksController;
  let service: {
    findAll: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    updateTeam: jest.Mock;
    updateExecutionMode: jest.Mock;
    start: jest.Mock;
    markPendingReview: jest.Mock;
    accept: jest.Mock;
    reject: jest.Mock;
    archive: jest.Mock;
  };
  let prisma: {
    teamUserMember: { findUnique: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      create: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      updateTeam: jest.fn(),
      updateExecutionMode: jest.fn(),
      start: jest.fn(),
      markPendingReview: jest.fn(),
      accept: jest.fn(),
      reject: jest.fn(),
      archive: jest.fn(),
    };
    prisma = {
      teamUserMember: { findUnique: jest.fn(), findMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TasksController],
      providers: [
        { provide: TasksService, useValue: service },
        { provide: PrismaService, useValue: prisma },
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

    it('POST tasks/:id/accept 转发到 accept', async () => {
      service.accept.mockResolvedValue({ id: 't_1', status: 'completed' });

      const out = await controller.accept(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        't_1',
      );

      expect(service.accept).toHaveBeenCalledWith('t_1', 'u_admin');
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

    it('POST tasks/:id/archive 转发到 archive', async () => {
      service.archive.mockResolvedValue({ id: 't_1', status: 'archived' });

      const out = await controller.archive(
        { id: 'u_admin', username: 'admin', roleId: 'r_admin' },
        't_1',
      );

      expect(service.archive).toHaveBeenCalledWith('t_1', 'u_admin');
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

    it('PATCH tasks/:id/execution-mode 转发 id + mode 到 updateExecutionMode', async () => {
      service.updateExecutionMode.mockResolvedValue({
        id: 't_1',
        executionMode: 'plan',
      });
      const dto = { mode: 'plan' };

      const out = await controller.updateExecutionMode(
        't_1',
        dto as UpdateExecutionModeDto,
      );

      expect(service.updateExecutionMode).toHaveBeenCalledWith('t_1', 'plan');
      expect(out).toEqual({ id: 't_1', executionMode: 'plan' });
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

    it('CreateTaskDto：executionMode 缺省通过，仅 direct/plan 合法', async () => {
      expect(
        await errorsOf(CreateTaskDto, {
          title: 'x',
          teamId: 'tm_0000000001',
          executionMode: 'plan',
        }),
      ).toHaveLength(0);
      expect(
        await errorsOf(CreateTaskDto, {
          title: 'x',
          teamId: 'tm_0000000001',
          executionMode: 'agile',
        }),
      ).not.toHaveLength(0);
    });

    it('UpdateExecutionModeDto：mode 必填且仅 direct/plan', async () => {
      expect(await errorsOf(UpdateExecutionModeDto, {})).not.toHaveLength(0);
      expect(
        await errorsOf(UpdateExecutionModeDto, { mode: 'plan' }),
      ).toHaveLength(0);
      expect(
        await errorsOf(UpdateExecutionModeDto, { mode: 'agile' }),
      ).not.toHaveLength(0);
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
  });

  describe('权限点守卫（CONF-02 方案②补齐矩阵守卫）', () => {
    const permOf = (handler: (...args: unknown[]) => unknown) =>
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler);

    it('读端点挂 tasks.view（列表/详情）', () => {
      expect(permOf(controller.findAll)).toBe('tasks.view');
      expect(permOf(controller.findOne)).toBe('tasks.view');
    });

    it('创建端点挂 tasks.create', () => {
      expect(permOf(controller.create)).toBe('tasks.create');
    });

    it('编辑类端点挂 tasks.edit（update/team/start/mark-pending-review/archive/execution-mode）', () => {
      expect(permOf(controller.update)).toBe('tasks.edit');
      expect(permOf(controller.updateTeam)).toBe('tasks.edit');
      expect(permOf(controller.updateExecutionMode)).toBe('tasks.edit');
      expect(permOf(controller.start)).toBe('tasks.edit');
      expect(permOf(controller.markPendingReview)).toBe('tasks.edit');
      expect(permOf(controller.archive)).toBe('tasks.edit');
    });

    it('验收类端点挂 tasks.review（accept/reject）', () => {
      expect(permOf(controller.accept)).toBe('tasks.review');
      expect(permOf(controller.reject)).toBe('tasks.review');
    });
  });
});
