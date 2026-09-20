import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { WorkerClient } from '../workers/worker.client';
import { PLATFORM_MCP_ERRORS } from './platform-mcp.constants';
import { SkillsService } from '../skills/skills.service';
import { GitReposService } from '../git-repos/git-repos.service';
import { PlatformMcpService } from './platform-mcp.service';
import { buildPlatformMcpTools } from './platform-mcp.tools';
import { IssuesService } from '../issues/issues.service';
import { TasksService } from '../tasks/tasks.service';
import { QuestionsService } from '../questions/questions.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { ExecutionPolicyService } from '../execution-policies/execution-policy.service';
import { MessageReceiptsService } from '../chat/message-receipts.service';
import { HookService } from '../triggers/hook.service';

/**
 * hook_register / hook_cancel 薄封装（trigger-unification todo-12）：
 * owner 服务端取自 resolveExecContext callerId（拒绝客户端传入）；
 * hook_cancel 服务端复核 owner 逐字相等或是执行团队主 Agent（否则 403）。
 */
describe('PlatformMcpService hook_register/hook_cancel', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: { findFirst: jest.Mock };
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
    teamMember: { findFirst: jest.Mock; findUnique: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    hook: { findUnique: jest.Mock };
  };
  let workerDispatcher: { isAgentExecuting: jest.Mock };
  let hooks: { registerHook: jest.Mock; cancelHook: jest.Mock };

  const ctx = { workerId: 'w_0000000001' };
  const taskId = 't_0000000001';
  const owner = 'tmm_owner';
  const other = 'tmm_other';
  const main = 'tmm_main';

  const allowTaskAs = (instanceId: string) => {
    workerDispatcher.isAgentExecuting.mockReturnValue(new Set([instanceId]));
  };

  beforeEach(async () => {
    prisma = {
      session: { findFirst: jest.fn() },
      task: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      teamMember: { findFirst: jest.fn(), findUnique: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      hook: { findUnique: jest.fn() },
    };
    workerDispatcher = { isAgentExecuting: jest.fn().mockReturnValue(null) };
    hooks = { registerHook: jest.fn(), cancelHook: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: { nextId: jest.fn() } },
        { provide: RealtimeService, useValue: { broadcast: jest.fn() } },
        { provide: WorkerClient, useValue: {} },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: ArtifactsService, useValue: {} },
        { provide: IssuesService, useValue: {} },
        { provide: TasksService, useValue: {} },
        { provide: QuestionsService, useValue: {} },
        {
          provide: NotificationDispatcherService,
          useValue: {},
        },
        { provide: ExecutionPolicyService, useValue: {} },
        { provide: SkillsService, useValue: {} },
        { provide: GitReposService, useValue: {} },
        { provide: MessageReceiptsService, useValue: {} },
        { provide: HookService, useValue: hooks },
      ],
    }).compile();

    service = module.get(PlatformMcpService);
  });

  const expectCode = (
    promise: Promise<unknown>,
    ctor:
      | typeof ForbiddenException
      | typeof NotFoundException
      | typeof BadRequestException,
    code: string,
  ) =>
    promise.then(
      () => {
        throw new Error('应当抛出异常');
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ctor);
        const resp = (err as { getResponse(): unknown }).getResponse();
        if (code) expect(resp).toMatchObject({ code });
      },
    );

  describe('hookRegister', () => {
    const registerOk = () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as never);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' } as never);
      prisma.teamMember.findFirst.mockResolvedValue({ id: owner } as never);
      hooks.registerHook.mockResolvedValue({
        id: 'hks_0000000001',
        status: 'pending',
        kind: 'time',
      });
      prisma.hook.findUnique.mockResolvedValue({
        dueAt: new Date('2026-09-18T00:00:00.000Z'),
        expiresAt: new Date('2026-09-19T00:00:00.000Z'),
      } as never);
    };

    it('time + delayMs 注册成功：owner=callerId（服务端派生），scope 取自执行上下文', async () => {
      allowTaskAs(owner);
      registerOk();

      const result = await service.hookRegister(ctx, {
        taskId,
        selfInstanceId: owner,
        kind: 'time',
        wakeText: 'wake me later',
        delayMs: 60_000,
      });

      expect(result.hookId).toBe('hks_0000000001');
      expect(result.status).toBe('pending');
      const input = hooks.registerHook.mock.calls[0][0];
      expect(input.ownerInstanceId).toBe(owner);
      expect(input.scopeType).toBe('task');
      expect(input.scopeId).toBe(taskId);
      expect(input.target.targetInstanceId).toBe(owner);
      expect(input.target.channelId).toBe('c_1');
      expect(input.dueAt).toBeInstanceOf(Date);
      expect(input.expiresAt).toBeInstanceOf(Date);
    });

    it('all_idle 无 dueAt 注册成功：fire 兜底 dueAt=null（唤醒权在 poll）', async () => {
      allowTaskAs(owner);
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as never);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' } as never);
      prisma.teamMember.findFirst.mockResolvedValue({ id: owner } as never);
      hooks.registerHook.mockResolvedValue({
        id: 'hks_0000000002',
        status: 'pending',
        kind: 'all_idle',
      });
      prisma.hook.findUnique.mockResolvedValue({
        dueAt: null,
        expiresAt: new Date('2026-09-19T00:00:00.000Z'),
      } as never);

      const result = await service.hookRegister(ctx, {
        taskId,
        selfInstanceId: owner,
        kind: 'all_idle',
        wakeText: 'wake me when quiet',
      });

      expect(result.hookId).toBe('hks_0000000002');
      expect(hooks.registerHook.mock.calls[0][0].dueAt).toBeNull();
      expect(result.dueAt).toBeNull();
    });

    it('双空上下文 → 400（未知 scope，与其他工具同语义）', async () => {
      await expectCode(
        service.hookRegister(ctx, {
          selfInstanceId: owner,
          kind: 'time',
          wakeText: 'x',
          delayMs: 1000,
        }),
        BadRequestException,
        '',
      );
    });

    it('跨任务冒充 → 403（无会话归属，不触达 registerHook）', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as never);
      prisma.session.findFirst.mockResolvedValue(null);

      await expectCode(
        service.hookRegister(ctx, {
          taskId,
          selfInstanceId: other,
          kind: 'time',
          wakeText: 'x',
          delayMs: 1000,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(hooks.registerHook).not.toHaveBeenCalled();
    });

    it('time 缺 dueAt/delayMs → 400（不落库）', async () => {
      allowTaskAs(owner);

      await expectCode(
        service.hookRegister(ctx, {
          taskId,
          selfInstanceId: owner,
          kind: 'time',
          wakeText: 'x',
        }),
        BadRequestException,
        '',
      );
      expect(hooks.registerHook).not.toHaveBeenCalled();
    });

    it('all_idle 带 dueAt → 400（不落库）', async () => {
      allowTaskAs(owner);

      await expectCode(
        service.hookRegister(ctx, {
          taskId,
          selfInstanceId: owner,
          kind: 'all_idle',
          wakeText: 'x',
          dueAt: new Date(Date.now() + 1000).toISOString(),
        }),
        BadRequestException,
        '',
      );
      expect(hooks.registerHook).not.toHaveBeenCalled();
    });

    it('未知 kind → 400（不落库；schema 层枚举亦拒绝）', async () => {
      allowTaskAs(owner);

      await expectCode(
        service.hookRegister(ctx, {
          taskId,
          selfInstanceId: owner,
          kind: 'event',
          wakeText: 'x',
          delayMs: 1000,
        }),
        BadRequestException,
        '',
      );
      expect(hooks.registerHook).not.toHaveBeenCalled();
    });

    it('HookService 校验失败（dueAt 越过 expiresAt）→ 400 非 500', async () => {
      allowTaskAs(owner);
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as never);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' } as never);
      prisma.teamMember.findFirst.mockResolvedValue({ id: owner } as never);
      hooks.registerHook.mockRejectedValue(
        new Error('time hook 的 dueAt 必须早于 expiresAt'),
      );

      await expectCode(
        service.hookRegister(ctx, {
          taskId,
          selfInstanceId: owner,
          kind: 'time',
          wakeText: 'x',
          dueAt: new Date(Date.now() + 1000).toISOString(),
          expiresInMs: 1,
        }),
        BadRequestException,
        '',
      );
    });
  });

  describe('hookCancel', () => {
    const hookRow = {
      id: 'hks_0000000001',
      ownerInstanceId: owner,
      scopeType: 'task',
      scopeId: taskId,
      status: 'pending',
    };

    it('所有者取消成功（owner 逐字相等）', async () => {
      allowTaskAs(owner);
      prisma.hook.findUnique.mockResolvedValue(hookRow as never);
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as never);
      hooks.cancelHook.mockResolvedValue({
        id: hookRow.id,
        status: 'cancelled',
      });

      const result = await service.hookCancel(ctx, {
        taskId,
        selfInstanceId: owner,
        hookId: hookRow.id,
      });

      expect(result).toEqual({ hookId: hookRow.id, status: 'cancelled' });
      expect(hooks.cancelHook).toHaveBeenCalledWith(hookRow.id);
    });

    it('非所有者非主 Agent → 403（不触达 cancelHook）', async () => {
      allowTaskAs(other);
      prisma.hook.findUnique.mockResolvedValue(hookRow as never);
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as never);
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: main,
      } as never);

      await expectCode(
        service.hookCancel(ctx, {
          taskId,
          selfInstanceId: other,
          hookId: hookRow.id,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(hooks.cancelHook).not.toHaveBeenCalled();
    });

    it('主 Agent 可取消他人 hook（agent 平面 admin 等价）', async () => {
      allowTaskAs(main);
      prisma.hook.findUnique.mockResolvedValue(hookRow as never);
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as never);
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: main,
      } as never);
      hooks.cancelHook.mockResolvedValue({
        id: hookRow.id,
        status: 'cancelled',
      });

      const result = await service.hookCancel(ctx, {
        taskId,
        selfInstanceId: main,
        hookId: hookRow.id,
      });

      expect(result).toEqual({ hookId: hookRow.id, status: 'cancelled' });
    });

    it('hook 不存在 → 404 HOOK_NOT_FOUND', async () => {
      allowTaskAs(owner);
      prisma.hook.findUnique.mockResolvedValue(null);

      await expectCode(
        service.hookCancel(ctx, {
          taskId,
          selfInstanceId: owner,
          hookId: 'hks_missing',
        }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.HOOK_NOT_FOUND,
      );
      expect(hooks.cancelHook).not.toHaveBeenCalled();
    });

    it('跨团队 hook → 403（hook 归属团队 ≠ 执行团队）', async () => {
      allowTaskAs(owner);
      prisma.hook.findUnique.mockResolvedValue({
        ...hookRow,
        scopeType: 'team',
        scopeId: 'tm_other',
      } as never);
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as never);

      await expectCode(
        service.hookCancel(ctx, {
          taskId,
          selfInstanceId: owner,
          hookId: hookRow.id,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(hooks.cancelHook).not.toHaveBeenCalled();
    });

    it('已终态行幂等直返（HookService 状态机，不抛）', async () => {
      allowTaskAs(owner);
      prisma.hook.findUnique.mockResolvedValue({
        ...hookRow,
        status: 'cancelled',
      } as never);
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as never);
      hooks.cancelHook.mockResolvedValue({
        id: hookRow.id,
        status: 'cancelled',
      });

      const result = await service.hookCancel(ctx, {
        taskId,
        selfInstanceId: owner,
        dedupKey: 'hook:task:t_1:owner:123',
      });

      expect(result).toEqual({ hookId: hookRow.id, status: 'cancelled' });
    });
  });

  describe('zod schema 层（skill-schema 透出 + 畸形输入 -32602）', () => {
    const tools = buildPlatformMcpTools(service);
    const hookRegister = tools.find((t) => t.name === 'hook_register')!;
    const hookCancel = tools.find((t) => t.name === 'hook_cancel')!;

    it('hook_register/hook_cancel 在工具清单内', () => {
      expect(hookRegister).toBeDefined();
      expect(hookCancel).toBeDefined();
    });

    it("kind:'event' schema 层直接拒绝（未知 kind 不进 service）", () => {
      const parsed = hookRegister.inputSchema.safeParse({
        taskId,
        selfInstanceId: owner,
        kind: 'event',
        wakeText: 'x',
        delayMs: 1000,
      });
      expect(parsed.success).toBe(false);
    });

    it('双空上下文 parse 通过（服务端会话回填）/ hookId+dedupKey 双空 schema 层直接拒绝', () => {
      expect(
        hookRegister.inputSchema.safeParse({
          selfInstanceId: owner,
          kind: 'time',
          wakeText: 'x',
          delayMs: 1000,
        }).success,
      ).toBe(true);
      expect(
        hookCancel.inputSchema.safeParse({
          taskId,
          selfInstanceId: owner,
        }).success,
      ).toBe(false);
    });

    it('time 缺 dueAt/delayMs、同传 dueAt+delayMs、all_idle 带 dueAt 均拒绝', () => {
      expect(
        hookRegister.inputSchema.safeParse({
          taskId,
          selfInstanceId: owner,
          kind: 'time',
          wakeText: 'x',
        }).success,
      ).toBe(false);
      expect(
        hookRegister.inputSchema.safeParse({
          taskId,
          selfInstanceId: owner,
          kind: 'time',
          wakeText: 'x',
          dueAt: new Date().toISOString(),
          delayMs: 1000,
        }).success,
      ).toBe(false);
      expect(
        hookRegister.inputSchema.safeParse({
          taskId,
          selfInstanceId: owner,
          kind: 'all_idle',
          wakeText: 'x',
          delayMs: 1000,
        }).success,
      ).toBe(false);
    });
  });
});
