import { ForbiddenException, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { IdGeneratorService } from '../common/id-generator';
import { ExecutionPolicyService } from '../execution-policies/execution-policy.service';
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
 * 工具权限门（opencode-native-permissions-and-fixes todo 3）可证伪测试。
 *
 * 三层：
 * ① 判定单元（真实 PlatformToolPermissionService + 真实 ExecutionPolicyService，
 *    后者喂真实 policy 行形状）：allow / ask 放行；显式 deny；未列入；矩阵可变更
 *    （同一 agent 改一条 `tools` 值即翻转判定 → 证明判定来自 allowlist，不是
 *    agent 名或角色名硬编码）；resolveByAgent 返回 null / 抛错 / 成员不可解析
 *    → 403 稳定码（fail-closed）。
 * ② 归属解析（真实 PlatformMcpService.resolveToolCallerId）：task/team 维度复用
 *    resolveExecContext 且错误码不变；无任何身份入参 → 最近会话解析；解析不到
 *    → 403 TOOL_NOT_PERMITTED（channel_send 决策）。
 * ③ HTTP 集成（真实 controller + 真实权限门）：拒绝 → JSON-RPC -32003 且带稳定码；
 *    放行 → handler 执行；tools/list 全量不受影响（调用时拦截）。
 */
describe('platform tool permission gate (todo 3)', () => {
  const memberRow = (agent: {
    id?: string;
    name?: string;
    agentKey?: string | null;
    policyId?: string | null;
  }) => ({
    agent: {
      id: agent.id ?? 'a_developer',
      name: agent.name ?? '开发者',
      agentKey: agent.agentKey ?? 'developer',
      policyId: agent.policyId ?? 'ep_developer',
    },
  });

  const policyRow = (tools: Record<string, string> | undefined) => ({
    id: 'ep_developer',
    name: '开发者策略',
    config: {
      permission: { edit: { '*': 'deny' }, read: { '*': 'allow' }, bash: 'allow' },
      correction: { scopeSummary: '开发者边界' },
      ...(tools === undefined ? {} : { tools }),
    },
  });

  /** 真实 ExecutionPolicyService（DB 行胜出） + 假 prisma 行。 */
  function realPolicyService(
    policy: unknown,
    alternatePrisma?: { executionPolicy: { findUnique: jest.Mock } } | Record<string, any>,
  ) {
    return new ExecutionPolicyService(
      (alternatePrisma ?? {
        executionPolicy: {
          findUnique: jest.fn().mockResolvedValue(policy),
          findMany: jest
            .fn()
            .mockResolvedValue(policy === null ? [] : [policy]),
        },
      }) as never,
      {} as never,
      { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
    );
  }

  function build(input: {
    member: unknown;
    policy?: unknown;
    policyService?: ExecutionPolicyService;
  }) {
    const prisma = {
      teamMember: { findUnique: jest.fn().mockResolvedValue(input.member) },
    };
    const policyService = input.policyService ?? realPolicyService(input.policy);
    const service = new PlatformToolPermissionService(
      prisma as unknown as PrismaService,
      policyService,
    );
    return { service, prisma, policyService };
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

  describe('① 判定单元（allowlist 驱动，fail-closed）', () => {
    it('矩阵 allow → 放行', async () => {
      const { service } = build({
        member: memberRow({}),
        policy: policyRow({ vteam_doclib: 'allow' }),
      });
      await expect(service.assertToolAllowed('tmm_dev', 'doclib')).resolves.toBe(
        undefined,
      );
    });

    it('矩阵 ask → 放行（与 worker guard 三态语义一致）', async () => {
      const { service } = build({
        member: memberRow({}),
        policy: policyRow({ vteam_doclib: 'ask' }),
      });
      await expect(service.assertToolAllowed('tmm_dev', 'doclib')).resolves.toBe(
        undefined,
      );
    });

    it('矩阵显式 deny → 403 + PLATFORM_MCP_TOOL_NOT_PERMITTED', async () => {
      const { service } = build({
        member: memberRow({}),
        policy: policyRow({ vteam_doclib: 'deny' }),
      });
      await expectDenied(
        service.assertToolAllowed('tmm_dev', 'doclib'),
        'vteam_doclib',
      );
    });

    it('矩阵未列入（not listed == deny）→ 403 + 稳定码', async () => {
      const { service } = build({
        member: memberRow({}),
        policy: policyRow({ vteam_doclib: 'allow' }),
      });
      await expectDenied(
        service.assertToolAllowed('tmm_dev', 'task_transition'),
        'vteam_task_transition',
      );
    });

    it('判定由 allowlist 驱动：同 agent 翻转一条值，决定随之翻转（非 agent 名硬编码）', async () => {
      const prisma = {
        teamMember: {
          findUnique: jest.fn().mockResolvedValue(memberRow({})),
        },
        executionPolicy: {
          findUnique: jest.fn(),
        },
      };
      const policy = realPolicyService(null, prisma);
      const service = new PlatformToolPermissionService(
        prisma as unknown as PrismaService,
        policy,
      );

      prisma.executionPolicy.findUnique.mockResolvedValue(
        policyRow({ vteam_doclib: 'allow' }),
      );
      await expect(
        service.assertToolAllowed('tmm_dev', 'doclib'),
      ).resolves.toBeUndefined();

      prisma.executionPolicy.findUnique.mockResolvedValue(
        policyRow({ vteam_doclib: 'deny' }),
      );
      await expectDenied(
        service.assertToolAllowed('tmm_dev', 'doclib'),
        'vteam_doclib',
      );

      prisma.executionPolicy.findUnique.mockResolvedValue(
        policyRow({ vteam_doclib: 'deny', vteam_task_transition: 'allow' }),
      );
      await expect(
        service.assertToolAllowed('tmm_dev', 'task_transition'),
      ).resolves.toBeUndefined();

      // 负对照：同一 agent、同一策略行内未列入的工具仍拒绝（翻转证明不曾放宽判定）。
      await expectDenied(
        service.assertToolAllowed('tmm_dev', 'plan_complete'),
        'vteam_plan_complete',
      );
    });

    it('resolveByAgent 入参取自成员的 Agent（policyId/agentKey），不读 roleId', async () => {
      const { service, policyService } = build({
        member: memberRow({
          agentKey: 'developer',
          policyId: 'ep_developer',
        }),
        policy: policyRow({ vteam_doclib: 'allow' }),
      });
      const spy = jest.spyOn(policyService, 'resolveByAgent');

      await service.assertToolAllowed('tmm_dev', 'doclib');

      expect(spy).toHaveBeenCalledWith({
        policyId: 'ep_developer',
        agentKey: 'developer',
      });
    });

    it('成员不可解析 → 403 稳定码（fail-closed）', async () => {
      const { service } = build({ member: null });
      await expectDenied(
        service.assertToolAllowed('tmm_ghost', 'doclib'),
        'vteam_doclib',
      );
    });

    it('策略不可解析（resolveByAgent → null）→ 403 稳定码', async () => {
      const { service } = build({
        member: memberRow({ agentKey: 'custom-x', policyId: 'ep_custom' }),
        policy: null,
      });
      await expectDenied(
        service.assertToolAllowed('tmm_dev', 'doclib'),
        'vteam_doclib',
      );
    });

    it('策略解析抛错 → 403 稳定码（绝不落到放行）', async () => {
      const { service } = build({
        member: memberRow({}),
        policyService: {
          resolveByAgent: jest
            .fn()
            .mockRejectedValue(new Error('db down')),
        } as unknown as ExecutionPolicyService,
      });
      await expectDenied(
        service.assertToolAllowed('tmm_dev', 'doclib'),
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
          {
            provide: ExecutionPolicyService,
            useValue: { resolveByAgent: jest.fn() },
          },
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
      prisma.session.findFirst.mockResolvedValue({
        taskId,
        teamId: 'tm_1',
        teamMemberId: 'tmm_dev',
        agentId: 'a_dev',
      });
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
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
    let policyPrisma: Record<string, any>;
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
        resolveToolCallerWithContext: jest.fn().mockImplementation(
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
      policyPrisma = { executionPolicy: { findUnique: jest.fn() } };
      const policyService = realPolicyService(null, policyPrisma);
      const gate = new PlatformToolPermissionService(
        memberPrisma as unknown as PrismaService,
        policyService,
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

    it('allow 工具 → JSON-RPC 200 + handler 执行', async () => {
      memberPrisma.teamMember.findUnique.mockResolvedValue({
        agent: {
          id: 'a_dev',
          name: '开发者',
          agentKey: 'developer',
          policyId: 'ep_developer',
        },
      });
      policyPrisma.executionPolicy.findUnique.mockResolvedValue(
        policyRow({ vteam_group_post: 'allow' }),
      );

      const res = await toolsCall('group_post', {
        taskId: 't_1',
        selfInstanceId: 'tmm_dev',
        content: '结论',
      }).expect(200);

      expect(res.body.result.content[0].text).toBeDefined();
      expect(service.groupPost).toHaveBeenCalled();
    });

    it('deny 工具 → JSON-RPC error -32003 + 稳定码 PLATFORM_MCP_TOOL_NOT_PERMITTED，handler 不执行', async () => {
      memberPrisma.teamMember.findUnique.mockResolvedValue({
        agent: {
          id: 'a_dev',
          name: '开发者',
          agentKey: 'developer',
          policyId: 'ep_developer',
        },
      });
      policyPrisma.executionPolicy.findUnique.mockResolvedValue(
        policyRow({ vteam_group_post: 'deny' }),
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
      expect(service.groupPost).not.toHaveBeenCalled();
    });

    it('未列入矩阵 → 403 + 稳定码（not listed == deny）', async () => {
      memberPrisma.teamMember.findUnique.mockResolvedValue({
        agent: {
          id: 'a_dev',
          name: '开发者',
          agentKey: 'developer',
          policyId: 'ep_developer',
        },
      });
      policyPrisma.executionPolicy.findUnique.mockResolvedValue(
        policyRow({ vteam_doclib: 'allow' }),
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

    it('tools/list 全量不受权限影响（28 个工具，调用时才拦截）', async () => {
      const res = await mcpPost()
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        .expect(200);

      expect((res.body.result.tools as unknown[]).length).toBe(28);
      expect(
        (res.body.result.tools as Array<{ name: string }>).map((t) => t.name),
      ).toContain('task_transition');
    });

    it('既有归属 403（PLATFORM_MCP_FORBIDDEN）码不变：权限门在 handler 抛错时原样透出', async () => {
      memberPrisma.teamMember.findUnique.mockResolvedValue({
        agent: {
          id: 'a_dev',
          name: '开发者',
          agentKey: 'developer',
          policyId: 'ep_developer',
        },
      });
      policyPrisma.executionPolicy.findUnique.mockResolvedValue(
        policyRow({ vteam_group_post: 'allow' }),
      );
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
