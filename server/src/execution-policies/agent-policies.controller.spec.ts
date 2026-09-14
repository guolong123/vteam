import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import {
  ROLE_BOUNDARIES,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerOrJwtGuard } from '../workers/worker-or-jwt.guard';
import { AgentPoliciesController } from './agent-policies.controller';
import { ExecutionPolicyService } from './execution-policy.service';

/**
 * GET /agent-policies 单测（Todo 12 证据）：
 * - happy：worker token（X-Worker-Token，走 WorkerOrJwtGuard worker 通道）
 *   → 200，6 个 agent 定义（vteam-plan + 5 vteam-<role>），`guard.roles` key 与
 *   `agents[].name` 完全一致，所有 MCP 键带 `vteam_` 前缀，无 `write` 键；
 * - 未鉴权（无 token，用户 JWT 通道被 stub 为 401）→ 401；
 * - 错误 token → 401。
 */
describe('AgentPoliciesController (GET /agent-policies)', () => {
  const WORKER_TOKEN = 'spec-worker-token';
  let app: INestApplication;
  let moduleRef: TestingModule;

  const agentNames: VteamAgentName[] = [
    'vteam-plan',
    'vteam-product',
    'vteam-architect',
    'vteam-developer',
    'vteam-tester',
    'vteam-project_manager',
  ];

  const REQUIRED_BASH_DENY = [
    '>',
    '>>',
    'tee',
    'cp',
    'mv',
    'sed -i',
    'truncate',
    'dd',
    'ln',
    'python -c',
    'node -e',
    'perl -i',
    'git apply',
    'patch',
    'git push',
    'rm',
  ];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [AgentPoliciesController],
      providers: [
        ExecutionPolicyService,
        WorkerOrJwtGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'WORKER_TOKEN' ? WORKER_TOKEN : undefined,
          },
        },
        // buildAgentPolicies 为 DB 驱动（agent/executionPolicy.findMany 占位空数组
        // 即无自定义 agent 的纯内置输出）；onModuleInit 的 resync 仅需
        // executionPolicy.findMany 占位
        {
          provide: PrismaService,
          useValue: {
            agent: { findMany: jest.fn().mockResolvedValue([]) },
            executionPolicy: { findMany: jest.fn().mockResolvedValue([]) },
          },
        },
        { provide: IdGeneratorService, useValue: { seed: jest.fn() } },
      ],
    }).compile();

    // 用户 JWT 通道（无 token 时委托 passport 'jwt'）：测试环境无 AuthModule
    // 注册策略，stub 为 401，使“未鉴权 → 401”可断言；worker token 分支不经过它。
    const guard = moduleRef.get<WorkerOrJwtGuard>(WorkerOrJwtGuard);
    (guard as unknown as { jwtGuard: { canActivate: jest.Mock } }).jwtGuard = {
      canActivate: jest.fn().mockRejectedValue(
        new UnauthorizedException({
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        }),
      ),
    };

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('worker token → 200：6 个 agent 定义 + guard.roles key 完全一致', async () => {
    const res = await request(app.getHttpServer())
      .get('/agent-policies')
      .set('x-worker-token', WORKER_TOKEN)
      .expect(200);

    const { agents, guard } = res.body as {
      agents: Array<{
        name: string;
        description: string;
        mode: string;
        permission: Record<string, unknown>;
      }>;
      guard: {
        enabled: boolean;
        roles: Record<
          string,
          {
            permission: Record<string, unknown>;
            tools: Record<string, string>;
            bashDeny: string[];
            correction: Record<string, unknown>;
          }
        >;
      };
    };

    expect(agents).toHaveLength(6);
    expect(agents.map((a) => a.name).sort()).toEqual([...agentNames].sort());
    for (const agent of agents) {
      expect(agent.mode).toBe(agent.name === 'vteam-plan' ? 'all' : 'primary');
      expect(typeof agent.description).toBe('string');
      expect(agent.description.length).toBeGreaterThan(0);
    }

    expect(guard.enabled).toBe(true);
    expect(Object.keys(guard.roles).sort()).toEqual(
      agents.map((a) => a.name).sort(),
    );
  });

  it('agent permission：无 write 键，task deny，非原生键一律 vteam_ 前缀', async () => {
    const res = await request(app.getHttpServer() as never)
      .get('/agent-policies')
      .set('x-worker-token', WORKER_TOKEN)
      .expect(200);

    const { agents } = res.body as {
      agents: Array<{ name: string; permission: Record<string, unknown> }>;
    };
    for (const agent of agents) {
      const permission = agent.permission;
      expect(permission).not.toHaveProperty('write');
      expect(permission.task).toBe(
        agent.name === 'vteam-plan' ? 'allow' : 'deny',
      );
      expect(permission.edit).toMatchObject({ '*': 'deny' });
      expect(permission.read).toMatchObject({ '*': 'allow' });
      for (const key of Object.keys(permission)) {
        if (!['edit', 'read', 'bash', 'task'].includes(key)) {
          expect(key.startsWith('vteam_')).toBe(true);
        }
      }
    }
  });

  it('guard roles：tools == toolAllows，bashDeny 含硬化清单，correction 完整', async () => {
    const res = await request(app.getHttpServer() as never)
      .get('/agent-policies')
      .set('x-worker-token', WORKER_TOKEN)
      .expect(200);

    const { guard } = res.body as {
      guard: {
        roles: Record<
          VteamAgentName,
          {
            permission: Record<string, unknown>;
            tools: Record<string, string>;
            bashDeny: string[];
            correction: {
              scopeSummary: string;
              handoff: Record<string, string>;
              denyTemplate: string;
            };
          }
        >;
      };
    };
    for (const name of agentNames) {
      const role = guard.roles[name];
      expect(role.tools).toEqual(ROLE_BOUNDARIES[name].toolAllows);
      for (const pattern of REQUIRED_BASH_DENY) {
        expect(role.bashDeny).toContain(pattern);
      }
      expect(role.correction.scopeSummary).toBe(
        ROLE_BOUNDARIES[name].scopeSummary,
      );
      expect(role.correction.handoff).toEqual(
        ROLE_BOUNDARIES[name].handoffTo,
      );
      expect(typeof role.correction.denyTemplate).toBe('string');
      expect(role.permission).not.toHaveProperty('write');
      expect(role.permission.task).toBe(name === 'vteam-plan' ? 'allow' : 'deny');
    }
  });

  it('未鉴权（无 token）→ 401', async () => {
    await request(app.getHttpServer()).get('/agent-policies').expect(401);
  });

  it('错误 token → 401', async () => {
    await request(app.getHttpServer())
      .get('/agent-policies')
      .set('x-worker-token', 'wrong-token')
      .expect(401);
  });
});
