import { ForbiddenException, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { IdGeneratorService } from '../common/id-generator';
import { GitReposService } from '../git-repos/git-repos.service';
import { IssuesService } from '../issues/issues.service';
import { PrismaService } from '../prisma/prisma.service';
import { QuestionsService } from '../questions/questions.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from '../tasks/tasks.service';
import { WorkerClient } from '../workers/worker.client';
import { WorkerTokenGuard } from '../workers/worker-token.guard';
import { PLATFORM_MCP_ERRORS } from './platform-mcp.constants';
import { PlatformMcpController } from './platform-mcp.controller';
import { PlatformMcpService } from './platform-mcp.service';
import { PlatformToolPermissionService } from './platform-tool-permission.service';

/**
 * 工具权限门（2026-09-21 role-owned capability model）可证伪测试。
 *
 * 三层：
 * ① 判定单元（真实 PlatformToolPermissionService + 假 prisma 成员行）：能力点显式 false
 *    ⇒ 403；能力点缺失 ⇒ 放行（**default-allow 证明**）；未知工具 ⇒ 403（unknown 面
 *    fail-closed）；未绑角色 / 成员不可解析 ⇒ 403；翻转 roles.capabilities 一格即翻转判定。
 * ② 归属解析（真实 PlatformMcpService.resolveToolCallerId）：task/team 维度复用
 *    resolveExecContext 且错误码不变；无任何身份入参 → 最近会话解析；解析不到
 *    → 403 TOOL_NOT_PERMITTED（channel_send 决策）。
 * ③ HTTP 集成（真实 controller + 真实权限门）：拒绝 → JSON-RPC -32003 且带稳定码；
 *    放行 → handler 执行；tools/list 全量不受影响（调用时拦截）。
 */
describe('platform tool permission gate (capability model)', () => {
  const memberRow = (role: {
    id?: string;
    key?: string;
    capabilities?: Record<string, boolean> | null;
  }) => ({
    role: {
      id: role.id ?? 'ar_developer',
      key: role.key ?? 'developer',
      capabilities: role.capabilities ?? {},
    },
  });

  function build(input: { member: unknown }) {
    const prisma = {
      teamMember: { findUnique: jest.fn().mockResolvedValue(input.member) },
    };
    const service = new PlatformToolPermissionService(
      prisma as unknown as PrismaService,
    );
    return { service, prisma };
  }

  async function expectDenied(
    promise: Promise<unknown>,
    key: string,
  ): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
    await promise.catch((err: ForbiddenException) => {
      expect(err.getResponse()).toMatchObject({
        code: PLATFORM_MCP_ERRORS.TOOL_NOT_PERMITTED,
      });
      expect((err.getResponse() as { message: string }).message).toContain(key);
    });
  }

  describe('① 判定单元（能力点驱动，default-allow + fail-closed）', () => {
    it('能力点显式 true → 放行', async () => {
      const { service } = build({
        member: memberRow({ capabilities: { 'doc.read': true } }),
      });
      await expect(
        service.assertToolAllowed('tmm_dev', 'doclib'),
      ).resolves.toBe(undefined);
    });

    it('能力点缺失 → 放行（default-allow 的唯一证明）', async () => {
      const { service } = build({
        member: memberRow({ capabilities: { 'task.create': false } }),
      });
      await expect(
        service.assertToolAllowed('tmm_dev', 'doclib'),
      ).resolves.toBe(undefined);
    });

    it('capabilities 为 NULL → 等同空矩阵 → 全放行（default-allow）', async () => {
      const { service } = build({
        member: memberRow({ capabilities: null }),
      });
      await expect(
        service.assertToolAllowed('tmm_dev', 'task_transition'),
      ).resolves.toBeUndefined();
    });

    it('能力点显式 false → 403 + PLATFORM_MCP_TOOL_NOT_PERMITTED', async () => {
      const { service } = build({
        member: memberRow({ capabilities: { 'doc.read': false } }),
      });
      await expectDenied(
        service.assertToolAllowed('tmm_dev', 'doclib'),
        'vteam_doclib',
      );
    });

    it('多工具能力点：组内任一工具共享同一判定（hook.manage=false → 注册与取消唤醒均拒）', async () => {
      const { service } = build({
        member: memberRow({ capabilities: { 'hook.manage': false } }),
      });
      for (const tool of ['hook_register', 'hook_cancel']) {
        await expectDenied(
          service.assertToolAllowed('tmm_dev', tool),
          `vteam_${tool}`,
        );
      }
    });

    it('拆分后的单工具点互不影响（issue.create=false 只拒创建，list/get 不受牵连）', async () => {
      const { service } = build({
        member: memberRow({ capabilities: { 'issue.create': false } }),
      });
      await expectDenied(
        service.assertToolAllowed('tmm_dev', 'issue_create'),
        'vteam_issue_create',
      );
      await expect(
        service.assertToolAllowed('tmm_dev', 'issue_list'),
      ).resolves.toBeUndefined();
      await expect(
        service.assertToolAllowed('tmm_dev', 'issue_get'),
      ).resolves.toBeUndefined();
    });

    it('未知/已下线工具（映射不到能力点）→ 403（unknown 面 fail-closed）', async () => {
      const { service } = build({
        member: memberRow({ capabilities: {} }),
      });
      await expectDenied(
        service.assertToolAllowed('tmm_dev', 'plan_mode'),
        'vteam_plan_mode',
      );
    });

    it('判定由岗位能力矩阵驱动：同角色翻转一格，决定随之翻转（非角色名硬编码）', async () => {
      const prisma = {
        teamMember: { findUnique: jest.fn() },
      };
      const service = new PlatformToolPermissionService(
        prisma as unknown as PrismaService,
      );

      prisma.teamMember.findUnique.mockResolvedValue(
        memberRow({ capabilities: { 'doc.read': true } }),
      );
      await expect(
        service.assertToolAllowed('tmm_dev', 'doclib'),
      ).resolves.toBeUndefined();

      prisma.teamMember.findUnique.mockResolvedValue(
        memberRow({ capabilities: { 'doc.read': false } }),
      );
      await expectDenied(
        service.assertToolAllowed('tmm_dev', 'doclib'),
        'vteam_doclib',
      );

      // 负对照：同一岗位、同一矩阵内缺失的工具（default-allow）仍放行——
      // 翻转证明不曾放宽判定方向（另见未知工具拒绝）。
      prisma.teamMember.findUnique.mockResolvedValue(
        memberRow({ capabilities: { 'doc.read': false } }),
      );
      await expect(
        service.assertToolAllowed('tmm_dev', 'plan_complete'),
      ).resolves.toBeUndefined();
    });

    it('select 只读 role.{id,key,capabilities}——绝不读 Agent（角色权威，执行者不参与）', async () => {
      const { service, prisma } = build({
        member: memberRow({ capabilities: {} }),
      });
      await service.assertToolAllowed('tmm_dev', 'doclib');
      expect(prisma.teamMember.findUnique).toHaveBeenCalledWith({
        where: { id: 'tmm_dev' },
        select: {
          role: { select: { id: true, key: true, capabilities: true } },
        },
      });
    });

    it('未绑角色（roleId NULL）→ 403（无岗位即无授权）', async () => {
      const { service } = build({ member: { role: null } });
      await expectDenied(
        service.assertToolAllowed('tmm_dev', 'doclib'),
        'vteam_doclib',
      );
    });

    it('成员不可解析 → 403 稳定码（fail-closed）', async () => {
      const { service } = build({ member: null });
      await expectDenied(
        service.assertToolAllowed('tmm_ghost', 'doclib'),
        'vteam_doclib',
      );
    });
  });

  describe('② 归属解析（PlatformMcpService.resolveToolCallerId，复用既有校验）', () => {
    const workerId = 'w_0001';
    const ctx = { workerId };
    const taskId = 't_0000000001';
    let prisma: Record<string, any>;
    let service: PlatformMcpService;

    const buildService = async () => {
      prisma = {
        session: { findFirst: jest.fn() },
        task: { findUnique: jest.fn() },
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PlatformMcpService,
          { provide: PrismaService, useValue: prisma },
          { provide: IdGeneratorService, useValue: { nextId: jest.fn() } },
          { provide: RealtimeService, useValue: { broadcast: jest.fn() } },
          { provide: WorkerClient, useValue: { fetchFile: jest.fn() } },
          {
            provide: WorkerDispatcher,
            useValue: {
              dispatchAgentMention: jest.fn(),
              isAgentExecuting: jest.fn().mockReturnValue(null),
            },
          },
          { provide: ArtifactsService, useValue: { append: jest.fn() } },
          {
            provide: IssuesService,
            useValue: { createByAgent: jest.fn(), findAllByAgent: jest.fn() },
          },
          { provide: TasksService, useValue: { createByAgent: jest.fn() } },
          { provide: QuestionsService, useValue: { createByAgent: jest.fn() } },
          { provide: GitReposService, useValue: { findAll: jest.fn() } },
        ],
      }).compile();
      service = module.get(PlatformMcpService);
    };

    beforeEach(buildService);

    it('task 维度：复用 resolveExecContext → 返回会话成员 id（归属校验通过）', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.session.findFirst.mockResolvedValue({
        id: 's_1',
        agentId: 'a_dev',
        teamMemberId: 'tmm_dev',
      });

      await expect(
        service.resolveToolCallerId(ctx, {
          taskId,
          selfInstanceId: 'tmm_dev',
        }),
      ).resolves.toBe('tmm_dev');
    });

    it('task 维度跨任务（无会话）→ 既有 403 PLATFORM_MCP_FORBIDDEN 原样保留', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.session.findFirst.mockResolvedValue(null);

      await service
        .resolveToolCallerId(ctx, { taskId, selfInstanceId: 'tmm_dev' })
        .then(
          () => {
            throw new Error('应当抛出异常');
          },
          (err: ForbiddenException) => {
            expect(err).toBeInstanceOf(ForbiddenException);
            expect(err.getResponse()).toMatchObject({
              code: PLATFORM_MCP_ERRORS.FORBIDDEN,
            });
          },
        );
    });

    it('team 维度：复用 assertWorkerTeam → 返回团队成员 id', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_team',
        teamMemberId: 'tmm_dev',
      });

      await expect(
        service.resolveToolCallerId(ctx, {
          teamId: 'tm_1',
          selfInstanceId: 'tmm_dev',
        }),
      ).resolves.toBe('tmm_dev');
    });

    it('无身份入参（channel_send）→ 最近会话解析出成员 id', async () => {
      prisma.session.findFirst
        .mockResolvedValueOnce({
          taskId,
          teamId: 'tm_1',
          teamMemberId: 'tmm_dev',
          agentId: 'a_dev',
        })
        .mockResolvedValue({
          id: 's_1',
          agentId: 'a_dev',
          teamMemberId: 'tmm_dev',
        });
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });

      await expect(service.resolveToolCallerId(ctx, {})).resolves.toBe(
        'tmm_dev',
      );
    });

    it('无身份入参且最近会话无 task/team/成员 → 403 PLATFORM_MCP_TOOL_NOT_PERMITTED（fail-closed）', async () => {
      prisma.session.findFirst.mockResolvedValue({
        taskId: null,
        teamId: null,
        teamMemberId: null,
        agentId: null,
      });

      await service.resolveToolCallerId(ctx, {}).then(
        () => {
          throw new Error('应当抛出异常');
        },
        (err: ForbiddenException) => {
          expect(err).toBeInstanceOf(ForbiddenException);
          expect(err.getResponse()).toMatchObject({
            code: PLATFORM_MCP_ERRORS.TOOL_NOT_PERMITTED,
          });
        },
      );
    });

    it('无身份入参且该 worker 完全没有会话 → 403 PLATFORM_MCP_TOOL_NOT_PERMITTED', async () => {
      prisma.session.findFirst.mockResolvedValue(null);

      await service.resolveToolCallerId(ctx, {}).then(
        () => {
          throw new Error('应当抛出异常');
        },
        (err: ForbiddenException) => {
          expect((err.getResponse() as { code: string }).code).toBe(
            PLATFORM_MCP_ERRORS.TOOL_NOT_PERMITTED,
          );
        },
      );
    });
  });

  describe('③ HTTP 集成（真实 controller + 真实权限门）', () => {
    let app: INestApplication;
    let service: {
      resolveToolCallerId: jest.Mock;
      resolveToolCallerWithContext: jest.Mock;
      groupPost: jest.Mock;
      doclib: jest.Mock;
    };
    let memberPrisma: Record<string, any>;

    const mcpPost = () =>
      request(app.getHttpServer())
        .post('/platform-mcp')
        .set('x-worker-token', 'dev-worker-token')
        .set('x-worker-id', 'w_0001');

    const toolsCall = (
      name: string,
      args: Record<string, unknown>,
    ): request.Test =>
      mcpPost().send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      });

    beforeEach(async () => {
      service = {
        resolveToolCallerId: jest.fn().mockResolvedValue('tmm_dev'),
        resolveToolCallerWithContext: jest
          .fn()
          .mockImplementation(
            async (
              _ctx: unknown,
              args: { taskId?: string; teamId?: string },
            ) => ({
              callerId: 'tmm_dev',
              ...(args.taskId ? { taskId: args.taskId } : {}),
              ...(args.teamId ? { teamId: args.teamId } : {}),
            }),
          ),
        groupPost: jest
          .fn()
          .mockResolvedValue({ messageId: 'm_1', attachment: null }),
        doclib: jest.fn().mockResolvedValue({ artifacts: [] }),
      };
      memberPrisma = { teamMember: { findUnique: jest.fn() } };
      const gate = new PlatformToolPermissionService(
        memberPrisma as unknown as PrismaService,
      );

      const moduleFixture: TestingModule = await Test.createTestingModule({
        controllers: [PlatformMcpController],
        providers: [
          { provide: PlatformMcpService, useValue: service },
          { provide: PlatformToolPermissionService, useValue: gate },
          {
            provide: ConfigService,
            useValue: { get: jest.fn(() => undefined) },
          },
          WorkerTokenGuard,
        ],
      }).compile();

      app = moduleFixture.createNestApplication();
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it('allow 能力点 → JSON-RPC 200 + handler 执行', async () => {
      memberPrisma.teamMember.findUnique.mockResolvedValue({
        role: {
          id: 'ar_developer',
          key: 'developer',
          capabilities: { 'chat.post': true },
        },
      });

      const res = await toolsCall('group_post', {
        taskId: 't_1',
        selfInstanceId: 'tmm_dev',
        content: '结论',
      }).expect(200);

      expect(res.body.result.content[0].text).toBeDefined();
      expect(service.groupPost).toHaveBeenCalled();
    });

    it('能力点缺失（default-allow）→ 放行 + handler 执行', async () => {
      memberPrisma.teamMember.findUnique.mockResolvedValue({
        role: {
          id: 'ar_developer',
          key: 'developer',
          capabilities: { 'doc.read': true },
        },
      });

      const res = await toolsCall('group_post', {
        taskId: 't_1',
        selfInstanceId: 'tmm_dev',
        content: '结论',
      }).expect(200);

      expect(res.body.result.content[0].text).toBeDefined();
      expect(service.groupPost).toHaveBeenCalled();
    });

    it('能力点显式 false → JSON-RPC error -32003 + 稳定码，handler 不执行', async () => {
      memberPrisma.teamMember.findUnique.mockResolvedValue({
        role: {
          id: 'ar_developer',
          key: 'developer',
          capabilities: { 'chat.post': false },
        },
      });

      const res = await toolsCall('group_post', {
        taskId: 't_1',
        selfInstanceId: 'tmm_dev',
        content: '结论',
      }).expect(200);

      expect(res.body.error.code).toBe(-32003);
      expect(res.body.error.message).toContain(
        PLATFORM_MCP_ERRORS.TOOL_NOT_PERMITTED,
      );
      expect(service.groupPost).not.toHaveBeenCalled();
    });

    it('身份不可解析（resolveToolCallerWithContext 抛 403）→ error 带稳定码，handler 不执行', async () => {
      service.resolveToolCallerWithContext.mockRejectedValue(
        new ForbiddenException({
          code: PLATFORM_MCP_ERRORS.TOOL_NOT_PERMITTED,
          message: '无法解析调用方身份',
        }),
      );

      const res = await toolsCall('group_post', {
        taskId: 't_1',
        selfInstanceId: 'tmm_dev',
        content: '结论',
      }).expect(200);

      expect(res.body.error.code).toBe(-32003);
      expect(res.body.error.message).toContain(
        PLATFORM_MCP_ERRORS.TOOL_NOT_PERMITTED,
      );
      expect(memberPrisma.teamMember.findUnique).not.toHaveBeenCalled();
      expect(service.groupPost).not.toHaveBeenCalled();
    });

    it('tools/list 全量不受权限影响（31 个工具，调用时才拦截）', async () => {
      const res = await mcpPost()
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        .expect(200);

      expect((res.body.result.tools as unknown[]).length).toBe(31);
      expect(
        (res.body.result.tools as Array<{ name: string }>).map((t) => t.name),
      ).toContain('task_transition');
    });

    it('既有归属 403（PLATFORM_MCP_FORBIDDEN）码不变：权限门在 handler 抛错时原样透出', async () => {
      memberPrisma.teamMember.findUnique.mockResolvedValue({
        role: {
          id: 'ar_developer',
          key: 'developer',
          capabilities: { 'chat.post': true },
        },
      });
      service.groupPost.mockRejectedValue(
        new ForbiddenException({
          code: PLATFORM_MCP_ERRORS.FORBIDDEN,
          message: '该 worker 无此任务会话，禁止跨任务访问',
        }),
      );

      const res = await toolsCall('group_post', {
        taskId: 't_1',
        selfInstanceId: 'tmm_dev',
        content: '结论',
      }).expect(200);

      expect(res.body.error.code).toBe(-32003);
      expect(res.body.error.message).toContain(PLATFORM_MCP_ERRORS.FORBIDDEN);
      expect(res.body.error.message).not.toContain(
        PLATFORM_MCP_ERRORS.TOOL_NOT_PERMITTED,
      );
    });
  });
});
