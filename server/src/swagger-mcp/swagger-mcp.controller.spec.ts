import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { OpenAPIObject } from '@nestjs/swagger';
import * as request from 'supertest';

// @apidevtools/json-schema-ref-parser 为 ESM（jest CJS transform 无法加载），
// factory 完全替代模块避免 ESM 加载；SwaggerDocsProvider 在测试中为 useValue mock
// （getDocument 返回固定文档），dereference 实际不会被调用。
jest.mock('@apidevtools/json-schema-ref-parser', () => ({
  dereference: jest.fn((doc: unknown) => Promise.resolve(doc)),
}));

import { PrismaService } from '../prisma/prisma.service';
import { WorkerTokenGuard } from '../workers/worker-token.guard';
import { SwaggerMcpAuthService } from './swagger-mcp.auth';
import { SwaggerMcpController } from './swagger-mcp.controller';
import { SwaggerDocsProvider } from './swagger-docs.provider';
import { SwaggerMcpHandler, SwaggerMcpHandlers } from './swagger-mcp.handlers';

/**
 * POST /api/v1/vteam-api/mcp 端点测试（阶段 2 任务 10/12/13）。
 * - X-Worker-Token 鉴权（401/放行，WorkerTokenGuard）。
 * - JSON-RPC 分发：initialize / tools/list / tools/call / 未知 method / 通知 202。
 * - 权限链路：真实 SwaggerMcpAuthService + mock PrismaService——allow 放行 /
 *   deny 拒绝 / 未配置默认 deny / 无 agent 上下文拒绝；ajv 校验失败 -32602。
 * - 注意：WorkerTokenGuard 在 compile 时实例化，必须补 ConfigService mock。
 */
describe('SwaggerMcpController (HTTP)', () => {
  let app: INestApplication;
  let prisma: {
    session: { findFirst: jest.Mock };
    taskAgent: { findUnique: jest.Mock };
    agentToolEffect: { findUnique: jest.Mock };
  };
  let handlerCall: jest.Mock;

  /** mock Swagger 文档：覆盖 path 参数 / requestBody 合并，生成 2 个工具。 */
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'Test API', version: '1.0' },
    paths: {
      '/tasks/{id}': {
        get: {
          operationId: 'getTask',
          summary: '任务详情',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/tasks/{id}/artifacts': {
        post: {
          operationId: 'appendArtifact',
          summary: '提交产出物',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    title: { type: 'string' },
                  },
                  required: ['type', 'title'],
                },
              },
            },
          },
          responses: { '201': { description: 'Created' } },
        },
      },
    },
  };

  const mcpPost = () =>
    request(app.getHttpServer())
      .post('/vteam-api/mcp')
      .set('x-worker-token', 'dev-worker-token');

  beforeEach(async () => {
    prisma = {
      session: { findFirst: jest.fn() },
      taskAgent: { findUnique: jest.fn() },
      agentToolEffect: { findUnique: jest.fn() },
    };
    handlerCall = jest.fn().mockResolvedValue({ id: 't_1' });

    const mockHandlers: SwaggerMcpHandler[] = [
      {
        match: (ref) => ref.method === 'get' && ref.path === '/tasks/{id}',
        taskIdOf: (args) => (typeof args.id === 'string' ? args.id : undefined),
        call: (ctx, args) => handlerCall(ctx, args),
      },
    ];

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SwaggerMcpController],
      providers: [
        {
          provide: SwaggerDocsProvider,
          useValue: { getDocument: () => document },
        },
        {
          provide: SwaggerMcpHandlers,
          useValue: { build: () => mockHandlers },
        },
        SwaggerMcpAuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
        WorkerTokenGuard,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('鉴权（WorkerTokenGuard）', () => {
    it('无 X-Worker-Token → 401 WORKER_TOKEN_INVALID', async () => {
      const res = await request(app.getHttpServer())
        .post('/vteam-api/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(401);
      expect(res.body).toMatchObject({ code: 'WORKER_TOKEN_INVALID' });
    });
  });

  describe('initialize', () => {
    it('→ 200 + protocolVersion/capabilities/serverInfo(name=vteam-api)', async () => {
      const res = await mcpPost()
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
        .expect(200);

      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.id).toBe(1);
      expect(res.body.result.protocolVersion).toBe('2025-03-26');
      expect(res.body.result.capabilities).toMatchObject({
        tools: { listChanged: false },
      });
      expect(res.body.result.serverInfo).toMatchObject({
        name: 'vteam-api',
        version: '1.0.0',
      });
    });
  });

  describe('tools/list', () => {
    it('→ 返回 Swagger 生成工具（inputSchema 为 JSON Schema 直接透传）', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        .expect(200);

      const tools = res.body.result.tools as Array<{
        name: string;
        description: string;
        inputSchema: {
          type: string;
          properties: Record<string, unknown>;
          required: string[];
        };
      }>;
      expect(tools.map((t) => t.name)).toEqual(['gettask', 'appendartifact']);
      expect(tools[0].description).toBe('任务详情');
      expect(tools[0].inputSchema).toMatchObject({
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      });
      // requestBody 字段并入
      expect(tools[1].inputSchema.required).toEqual(['id', 'type', 'title']);
    });
  });

  describe('tools/call 权限链路', () => {
    /** 授权成功前置：worker 有活跃实例 + 实例对应 agent。 */
    const allowContext = () => {
      prisma.session.findFirst.mockResolvedValue({ taskAgentId: 'ta_1' });
      prisma.taskAgent.findUnique.mockResolvedValue({ agentId: 'a_1' });
    };

    it('allow → 放行，handler 收到 workerId + 校验后的 args', async () => {
      allowContext();
      prisma.agentToolEffect.findUnique.mockResolvedValue({ effect: 'allow' });

      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'gettask', arguments: { id: 't_1' } },
        })
        .expect(200);

      expect(prisma.agentToolEffect.findUnique).toHaveBeenCalledWith({
        where: {
          agentId_toolAction: { agentId: 'a_1', toolAction: 'gettask' },
        },
      });
      expect(handlerCall).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        { id: 't_1' },
      );
      const text = res.body.result.content[0].text as string;
      expect(JSON.parse(text)).toEqual({ id: 't_1' });
    });

    it('deny → 200 + error -32603（message 提示未授权）', async () => {
      allowContext();
      prisma.agentToolEffect.findUnique.mockResolvedValue({ effect: 'deny' });

      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'gettask', arguments: { id: 't_1' } },
        })
        .expect(200);

      expect(res.body.error.code).toBe(-32603);
      expect(res.body.error.message).toContain(
        '工具未授权，请在 Agent 配置中开启',
      );
      expect(handlerCall).not.toHaveBeenCalled();
    });

    it('未配置 → 默认 deny（-32603）', async () => {
      allowContext();
      prisma.agentToolEffect.findUnique.mockResolvedValue(null);

      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'gettask', arguments: { id: 't_1' } },
        })
        .expect(200);

      expect(res.body.error.code).toBe(-32603);
      expect(res.body.error.message).toContain('工具未授权');
      expect(handlerCall).not.toHaveBeenCalled();
    });

    it('无 agent 上下文（worker 无活跃会话）→ -32603 拒绝', async () => {
      prisma.session.findFirst.mockResolvedValue(null);

      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'gettask', arguments: { id: 't_1' } },
        })
        .expect(200);

      expect(res.body.error.code).toBe(-32603);
      expect(res.body.error.message).toContain('无法解析调用实例上下文');
      expect(handlerCall).not.toHaveBeenCalled();
    });

    it('taskId 归属校验失败（该 worker 无绑定会话）→ -32603 拒绝', async () => {
      allowContext();
      prisma.agentToolEffect.findUnique.mockResolvedValue({ effect: 'allow' });
      // assertWorkerTask 的 session.findFirst 返回 null（授权已消费第一次调用）
      prisma.session.findFirst
        .mockResolvedValueOnce({ taskAgentId: 'ta_1' })
        .mockResolvedValue(null);

      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'gettask', arguments: { id: 't_other' } },
        })
        .expect(200);

      expect(res.body.error.code).toBe(-32603);
      expect(res.body.error.message).toContain('禁止跨任务访问');
      expect(handlerCall).not.toHaveBeenCalled();
    });

    it('ask → v1 降级 deny（-32603）', async () => {
      allowContext();
      prisma.agentToolEffect.findUnique.mockResolvedValue({ effect: 'ask' });

      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: { name: 'gettask', arguments: { id: 't_1' } },
        })
        .expect(200);

      expect(res.body.error.message).toContain(
        'ask 确认流 v1 未支持，请配置为 allow',
      );
      expect(handlerCall).not.toHaveBeenCalled();
    });
  });

  describe('tools/call 其他', () => {
    it('未知工具 → 200 + error -32602 Unknown tool', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'no_such_tool', arguments: {} },
        })
        .expect(200);

      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('Unknown tool: no_such_tool');
      expect(handlerCall).not.toHaveBeenCalled();
    });

    it('ajv 校验失败（缺必填 path 参数 id）→ 200 + error -32602', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'gettask', arguments: {} },
        })
        .expect(200);

      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('id');
      expect(prisma.agentToolEffect.findUnique).not.toHaveBeenCalled();
    });

    it('无 handler 映射的工具 → 200 + error NOT_IMPLEMENTED', async () => {
      prisma.session.findFirst.mockResolvedValue({ taskAgentId: 'ta_1' });
      prisma.taskAgent.findUnique.mockResolvedValue({ agentId: 'a_1' });
      prisma.agentToolEffect.findUnique.mockResolvedValue({ effect: 'allow' });

      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'appendartifact',
            arguments: { id: 't_1', type: 'text', title: 'x' },
          },
        })
        .expect(200);

      expect(res.body.error.code).toBe(-32603);
      expect(res.body.error.message).toContain('该 API 暂未接入 service 绑定');
    });
  });

  describe('未知 method / 通知', () => {
    it('未知 method → 200 + error -32601 Method not found', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({ jsonrpc: '2.0', id: 12, method: 'no/such/method', params: {} })
        .expect(200);

      expect(res.body.error.code).toBe(-32601);
      expect(res.body.error.message).toBe('Method not found: no/such/method');
    });

    it('无 id（notification）→ 202 Accepted + {accepted:true}', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        .expect(202);

      expect(res.body).toEqual({ accepted: true });
    });
  });
});
