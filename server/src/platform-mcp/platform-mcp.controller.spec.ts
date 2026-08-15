import {
  ForbiddenException,
  INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { WorkerTokenGuard } from '../workers/worker-token.guard';
import { PlatformMcpController } from './platform-mcp.controller';
import { PlatformMcpService } from './platform-mcp.service';

/**
 * POST /api/v1/platform-mcp 端点测试（阶段 1，经 HTTP 层验证）。
 * - X-Worker-Token 鉴权（401/放行，WorkerTokenGuard，与用户 JWT 隔离）。
 * - 手写 JSON-RPC 四方法分发（计划 9 回退）：initialize / tools/list /
 *   tools/call / 未知 method；工具 handler 转发到 service 且 x-worker-id
 *   从 header 解析透传。
 * - 注意：WorkerTokenGuard 在 compile 时实例化，必须补 ConfigService mock
 *   （对齐 worker-events.controller.spec.ts 既有踩坑）。
 */
describe('PlatformMcpController (HTTP)', () => {
  let app: INestApplication;
  let service: {
    chatHistory: jest.Mock;
    doclib: jest.Mock;
    taskContext: jest.Mock;
    groupPost: jest.Mock;
    readFile: jest.Mock;
    notifyAgent: jest.Mock;
    submitArtifact: jest.Mock;
  };

  /** 手写 JSON-RPC 端点：无需 Accept 头，直接 POST JSON 即可。 */
  const mcpPost = () =>
    request(app.getHttpServer())
      .post('/platform-mcp')
      .set('x-worker-token', 'dev-worker-token');

  const mcpPostWithoutToken = () =>
    request(app.getHttpServer())
      .post('/platform-mcp')
      .set('x-worker-id', 'w_0001');

  beforeEach(async () => {
    service = {
      chatHistory: jest.fn().mockResolvedValue([]),
      doclib: jest.fn().mockResolvedValue({ artifacts: [] }),
      taskContext: jest.fn().mockResolvedValue({}),
      groupPost: jest.fn().mockResolvedValue({ messageId: 'm_1', attachment: null }),
      readFile: jest.fn().mockResolvedValue({
        content: 'x',
        fileName: 'x.txt',
        fileRef: '/uploads/x.txt',
        source: 'archive',
      }),
      notifyAgent: jest.fn().mockResolvedValue({
        messageId: 'm_1',
        channelId: 'c_1',
        targetInstanceId: 'ta_tester',
      }),
      submitArtifact: jest.fn().mockResolvedValue({
        artifactId: 'a_1',
        version: 1,
        status: 'created',
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PlatformMcpController],
      providers: [
        { provide: PlatformMcpService, useValue: service },
        // guard 依赖 WORKER_TOKEN env；mock 返回 undefined → 落到默认 dev-worker-token
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
      const res = await mcpPostWithoutToken()
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(401);
      expect(res.body).toMatchObject({ code: 'WORKER_TOKEN_INVALID' });
    });

    it('非法 token → 401 WORKER_TOKEN_INVALID', async () => {
      const res = await request(app.getHttpServer())
        .post('/platform-mcp')
        .set('x-worker-token', 'wrong-token')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(401);
      expect(res.body).toMatchObject({ code: 'WORKER_TOKEN_INVALID' });
    });
  });

  describe('GET（SSE 流探测）', () => {
    it('带合法 token → 405 METHOD_NOT_ALLOWED（MCP 仅支持 POST 请求-响应）', async () => {
      const res = await request(app.getHttpServer())
        .get('/platform-mcp')
        .set('x-worker-token', 'dev-worker-token')
        .expect(405);

      expect(res.body).toMatchObject({
        code: 'METHOD_NOT_ALLOWED',
        message: '仅支持 POST（JSON-RPC over HTTP）',
      });
    });

    it('无 token → 401（guard 先拦，未走到 405 handler）', async () => {
      const res = await request(app.getHttpServer())
        .get('/platform-mcp')
        .expect(401);
      expect(res.body).toMatchObject({ code: 'WORKER_TOKEN_INVALID' });
    });
  });

  describe('initialize', () => {
    it('→ 200 + protocolVersion/capabilities/serverInfo', async () => {
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
        name: 'vteam',
        version: '1.0.0',
      });
    });
  });

  describe('tools/list', () => {
    it('→ 返回 14 个工具（含 notify_agent/submit_artifact + 5 个 issue_* + task_transition + question_confirm）且 inputSchema 为 JSON Schema', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        .expect(200);

      const tools = res.body.result.tools as Array<{
        name: string;
        description: string;
        inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
      }>;
      const names = tools.map((t) => t.name);
      expect(names).toEqual([
        'chat_history',
        'doclib',
        'task_context',
        'group_post',
        'read_file',
        'notify_agent',
        'submit_artifact',
        'issue_create',
        'issue_list',
        'issue_get',
        'issue_update',
        'issue_transition',
        'task_transition',
        'question_confirm',
      ]);

      for (const tool of tools) {
        expect(tool.description).toEqual(expect.any(String));
        expect(tool.inputSchema).toMatchObject({
          type: 'object',
          properties: expect.objectContaining({ taskId: { type: 'string' } }),
        });
      }
      // 必填字段派生：chat_history 仅 taskId 必填，sinceId/limit 可选
      const chatHistory = tools.find((t) => t.name === 'chat_history')!;
      expect(chatHistory.inputSchema.required).toEqual(['taskId']);
      expect(chatHistory.inputSchema.properties.limit).toEqual({ type: 'number' });
      // group_post：taskId/selfInstanceId/content 必填，fileRef 可选
      const groupPost = tools.find((t) => t.name === 'group_post')!;
      expect(groupPost.inputSchema.required).toEqual(['taskId', 'selfInstanceId', 'content']);
      expect(groupPost.inputSchema.properties.selfInstanceId).toEqual({ type: 'string' });
      // notify_agent：taskId/selfInstanceId/targetInstanceId/content 全必填
      const notifyAgent = tools.find((t) => t.name === 'notify_agent')!;
      expect(notifyAgent.inputSchema.required).toEqual([
        'taskId',
        'selfInstanceId',
        'targetInstanceId',
        'content',
      ]);
      // submit_artifact：taskId/selfInstanceId/type/title 必填，content/fileRef 可选；type 枚举归为 string
      const submitArtifact = tools.find((t) => t.name === 'submit_artifact')!;
      expect(submitArtifact.inputSchema.required).toEqual([
        'taskId',
        'selfInstanceId',
        'type',
        'title',
      ]);
      expect(submitArtifact.inputSchema.properties.type).toEqual({ type: 'string' });
      // issue_create：taskId/selfInstanceId/title 必填，description/tags/assigneeInstanceId 可选；tags 数组归为 array
      const issueCreate = tools.find((t) => t.name === 'issue_create')!;
      expect(issueCreate.inputSchema.required).toEqual(['taskId', 'selfInstanceId', 'title']);
      expect(issueCreate.inputSchema.properties.tags).toEqual({ type: 'array' });
      expect(issueCreate.inputSchema.properties.description).toEqual({ type: 'string' });
      expect(issueCreate.inputSchema.properties.assigneeInstanceId).toEqual({
        type: 'string',
      });
      // issue_transition：taskId/selfInstanceId/issueId/action 全必填；action 枚举归为 string
      const issueTransition = tools.find((t) => t.name === 'issue_transition')!;
      expect(issueTransition.inputSchema.required).toEqual([
        'taskId',
        'selfInstanceId',
        'issueId',
        'action',
      ]);
      expect(issueTransition.inputSchema.properties.action).toEqual({ type: 'string' });
    });
  });

  describe('tools/call', () => {
    it('chat_history → service.chatHistory 携带 header 解析的 workerId + taskId', async () => {
      service.chatHistory.mockResolvedValue([
        {
          id: 'm_0000000001',
          senderType: 'user',
          senderId: 'u_1',
          text: '你好',
          createdAt: '2026-08-07T00:00:00.000Z',
        },
      ]);

      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'chat_history',
            arguments: { taskId: 't_0000000001' },
          },
        })
        .expect(200);

      expect(service.chatHistory).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        { taskId: 't_0000000001' },
      );
      // handler 把结果 JSON.stringify 后作为 text 内容返回
      const text = res.body.result.content[0].text as string;
      expect(JSON.parse(text)).toEqual([
        {
          id: 'm_0000000001',
          senderType: 'user',
          senderId: 'u_1',
          text: '你好',
          createdAt: '2026-08-07T00:00:00.000Z',
        },
      ]);
    });

    it('chat_history sinceId/limit → 透传到 service', async () => {
      await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'chat_history',
            arguments: { taskId: 't_1', sinceId: 'm_10', limit: 20 },
          },
        })
        .expect(200);

      expect(service.chatHistory).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        { taskId: 't_1', sinceId: 'm_10', limit: 20 },
      );
    });

    it('group_post → service.groupPost 收到 content/fileRef/selfInstanceId', async () => {
      await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'group_post',
            arguments: {
              taskId: 't_1',
              content: '结论',
              fileRef: '/uploads/a.pdf',
              selfInstanceId: 'ta_tester',
            },
          },
        })
        .expect(200);

      expect(service.groupPost).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        {
          taskId: 't_1',
          content: '结论',
          fileRef: '/uploads/a.pdf',
          selfInstanceId: 'ta_tester',
        },
      );
    });

    it('read_file → service.readFile 收到 taskId/fileRef/maxBytes', async () => {
      await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'read_file',
            arguments: { taskId: 't_1', fileRef: '/uploads/a.pdf', maxBytes: 1024 },
          },
        })
        .expect(200);

      expect(service.readFile).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        { taskId: 't_1', fileRef: '/uploads/a.pdf', maxBytes: 1024 },
      );
    });

    it('notify_agent → service.notifyAgent 收到 taskId/selfInstanceId/targetInstanceId/content', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: {
            name: 'notify_agent',
            arguments: {
              taskId: 't_1',
              targetInstanceId: 'ta_tester',
              content: '请查看',
              selfInstanceId: 'ta_product',
            },
          },
        })
        .expect(200);

      expect(service.notifyAgent).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        {
          taskId: 't_1',
          targetInstanceId: 'ta_tester',
          content: '请查看',
          selfInstanceId: 'ta_product',
        },
      );
      const text = res.body.result.content[0].text as string;
      expect(JSON.parse(text)).toEqual({
        messageId: 'm_1',
        channelId: 'c_1',
        targetInstanceId: 'ta_tester',
      });
    });

    it('submit_artifact → service.submitArtifact 收到 taskId/selfInstanceId/type/title/content', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'submit_artifact',
            arguments: {
              taskId: 't_1',
              type: 'text',
              title: '实现说明',
              content: '已完成',
              selfInstanceId: 'ta_tester',
            },
          },
        })
        .expect(200);

      expect(service.submitArtifact).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        {
          taskId: 't_1',
          type: 'text',
          title: '实现说明',
          content: '已完成',
          selfInstanceId: 'ta_tester',
        },
      );
      const text = res.body.result.content[0].text as string;
      expect(JSON.parse(text)).toEqual({
        artifactId: 'a_1',
        version: 1,
        status: 'created',
      });
    });

    it('未知工具 → 200 + error -32602 Unknown tool（不触达 service）', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'no_such_tool', arguments: {} },
        })
        .expect(200);

      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('Unknown tool: no_such_tool');
      expect(service.chatHistory).not.toHaveBeenCalled();
    });

    it('zod 校验失败（缺必填 taskId）→ 200 + error -32602（含 zod message）', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: { name: 'chat_history', arguments: {} },
        })
        .expect(200);

      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toEqual(expect.any(String));
      expect(res.body.error.message).toContain('taskId');
      expect(service.chatHistory).not.toHaveBeenCalled();
    });

    it('service 抛错（归属校验 403）→ 200 + error（含业务 message）', async () => {
      service.chatHistory.mockRejectedValue(
        new ForbiddenException({
          code: 'PLATFORM_MCP_FORBIDDEN',
          message: '该 worker 无此任务会话，禁止跨任务访问',
        }),
      );

      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: {
            name: 'chat_history',
            arguments: { taskId: 't_other' },
          },
        })
        .expect(200);

      expect(res.body.error.code).toBe(-32603);
      expect(res.body.error.message).toContain('禁止跨任务访问');
    });
  });

  describe('未知 method / 通知', () => {
    it('未知 method → 200 + error -32601 Method not found', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({ jsonrpc: '2.0', id: 10, method: 'no/such/method', params: {} })
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
      expect(service.chatHistory).not.toHaveBeenCalled();
    });
  });
});
