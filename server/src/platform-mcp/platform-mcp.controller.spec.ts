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
    teamView: jest.Mock;
    myProfile: jest.Mock;
    planGet: jest.Mock;
    planAssignReviewer: jest.Mock;
    teamAddMember: jest.Mock;
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
      teamView: jest.fn().mockResolvedValue({
        taskId: 't_1',
        members: [],
        planSummary: { total: 0, done: 0, pending: 0 },
      }),
      myProfile: jest.fn().mockResolvedValue({
        taskId: 't_1',
        instanceId: 'ta_sender',
        agentId: 'a_sender',
        name: '开发者',
        role: 'developer',
        alias: null,
        seq: 1,
        workDir: null,
        defaultModelId: null,
        permissionScope: null,
        toolEffects: [],
        promptSummary: 'x',
        promptTruncated: false,
      }),
      planGet: jest.fn().mockResolvedValue({
        id: 'pl_1',
        taskId: 't_1',
        title: '实施消缺',
        summary: null,
        scopeIn: null,
        scopeOut: null,
        status: 'reviewing',
        createdBy: 'ta_main',
        reviewerInstanceId: null,
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
        tasks: [],
      }),
      planAssignReviewer: jest.fn().mockResolvedValue({
        planId: 'pl_1',
        taskId: 't_1',
        reviewerInstanceId: 'ta_reviewer',
        reviewerAlias: '开发者-1',
      }),
      teamAddMember: jest.fn().mockResolvedValue({
        requestId: 'que_platform_0000000001',
        taskId: 't_1',
        agentId: 'a_developer',
        alias: '开发者-1',
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
    it('→ 返回 24 个工具（含 notify_agent/submit_artifact + 5 个 issue_* + task_transition + question_confirm + memory_save/memory_search + plan_submit/plan_review/plan_task_transition + team_view/my_profile + plan_get/plan_assign_reviewer + team_add_member）且 inputSchema 为 JSON Schema', async () => {
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
        'memory_save',
        'memory_search',
        'plan_submit',
        'plan_review',
        'plan_task_transition',
        'team_view',
        'my_profile',
        'plan_get',
        'plan_assign_reviewer',
        'team_add_member',
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
      // memory_save：taskId/selfInstanceId/level/content 必填，tags 可选；level 枚举归为 string
      const memorySave = tools.find((t) => t.name === 'memory_save')!;
      expect(memorySave.inputSchema.required).toEqual([
        'taskId',
        'selfInstanceId',
        'level',
        'content',
      ]);
      expect(memorySave.inputSchema.properties.level).toEqual({ type: 'string' });
      expect(memorySave.inputSchema.properties.tags).toEqual({ type: 'array' });
      // memory_search：仅 taskId 必填，query/level/tags/limit 可选
      const memorySearch = tools.find((t) => t.name === 'memory_search')!;
      expect(memorySearch.inputSchema.required).toEqual(['taskId']);
      expect(memorySearch.inputSchema.properties.limit).toEqual({ type: 'number' });
      // plan_submit：taskId/selfInstanceId/title/tasks 必填，summary/scopeIn/scopeOut 可选；tasks 数组归为 array
      const planSubmit = tools.find((t) => t.name === 'plan_submit')!;
      expect(planSubmit.inputSchema.required).toEqual([
        'taskId',
        'selfInstanceId',
        'title',
        'tasks',
      ]);
      expect(planSubmit.inputSchema.properties.tasks).toEqual({ type: 'array' });
      expect(planSubmit.inputSchema.properties.summary).toEqual({ type: 'string' });
      // plan_review：taskId/selfInstanceId/verdict 必填，planId/reason 可选（refine 解包后 shape 不变）
      const planReview = tools.find((t) => t.name === 'plan_review')!;
      expect(planReview.inputSchema.required).toEqual([
        'taskId',
        'selfInstanceId',
        'verdict',
      ]);
      expect(planReview.inputSchema.properties.verdict).toEqual({ type: 'string' });
      expect(planReview.inputSchema.properties.reason).toEqual({ type: 'string' });
      // plan_task_transition：taskId/selfInstanceId/planTaskId/status 全必填；status 枚举归为 string
      const planTaskTransition = tools.find(
        (t) => t.name === 'plan_task_transition',
      )!;
      expect(planTaskTransition.inputSchema.required).toEqual([
        'taskId',
        'selfInstanceId',
        'planTaskId',
        'status',
      ]);
      expect(planTaskTransition.inputSchema.properties.status).toEqual({
        type: 'string',
      });
      // team_view：仅 taskId 必填（只读，无 selfInstanceId）
      const teamView = tools.find((t) => t.name === 'team_view')!;
      expect(teamView.inputSchema.required).toEqual(['taskId']);
      // my_profile：taskId/selfInstanceId 全必填
      const myProfile = tools.find((t) => t.name === 'my_profile')!;
      expect(myProfile.inputSchema.required).toEqual([
        'taskId',
        'selfInstanceId',
      ]);
      expect(myProfile.inputSchema.properties.selfInstanceId).toEqual({
        type: 'string',
      });
      // plan_get：仅 taskId 必填（只读，无 selfInstanceId），planId 可选
      const planGet = tools.find((t) => t.name === 'plan_get')!;
      expect(planGet.inputSchema.required).toEqual(['taskId']);
      expect(planGet.inputSchema.properties.planId).toEqual({ type: 'string' });
      // plan_assign_reviewer：taskId/selfInstanceId/reviewerInstanceId 全必填
      const planAssignReviewer = tools.find(
        (t) => t.name === 'plan_assign_reviewer',
      )!;
      expect(planAssignReviewer.inputSchema.required).toEqual([
        'taskId',
        'selfInstanceId',
        'reviewerInstanceId',
      ]);
      expect(planAssignReviewer.inputSchema.properties.reviewerInstanceId).toEqual({
        type: 'string',
      });
      // team_add_member：taskId/selfInstanceId/agentId 必填，alias/workDir 可选
      const teamAddMember = tools.find((t) => t.name === 'team_add_member')!;
      expect(teamAddMember.inputSchema.required).toEqual([
        'taskId',
        'selfInstanceId',
        'agentId',
      ]);
      expect(teamAddMember.inputSchema.properties.alias).toEqual({
        type: 'string',
      });
      expect(teamAddMember.inputSchema.properties.workDir).toEqual({
        type: 'string',
      });
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

    it('team_view → service.teamView 收到 workerId + taskId（只读，无 selfInstanceId）', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/call',
          params: { name: 'team_view', arguments: { taskId: 't_1' } },
        })
        .expect(200);

      expect(service.teamView).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        { taskId: 't_1' },
      );
      const text = res.body.result.content[0].text as string;
      expect(JSON.parse(text)).toEqual({
        taskId: 't_1',
        members: [],
        planSummary: { total: 0, done: 0, pending: 0 },
      });
    });

    it('my_profile → service.myProfile 收到 taskId/selfInstanceId', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 13,
          method: 'tools/call',
          params: {
            name: 'my_profile',
            arguments: { taskId: 't_1', selfInstanceId: 'ta_sender' },
          },
        })
        .expect(200);

      expect(service.myProfile).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        { taskId: 't_1', selfInstanceId: 'ta_sender' },
      );
      const text = res.body.result.content[0].text as string;
      expect(JSON.parse(text)).toMatchObject({
        taskId: 't_1',
        instanceId: 'ta_sender',
        promptTruncated: false,
      });
    });

    it('plan_get → service.planGet 收到 taskId/planId（只读，无 selfInstanceId）', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 14,
          method: 'tools/call',
          params: {
            name: 'plan_get',
            arguments: { taskId: 't_1', planId: 'pl_1' },
          },
        })
        .expect(200);

      expect(service.planGet).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        { taskId: 't_1', planId: 'pl_1' },
      );
      const text = res.body.result.content[0].text as string;
      expect(JSON.parse(text)).toMatchObject({
        id: 'pl_1',
        taskId: 't_1',
        status: 'reviewing',
        tasks: [],
      });
    });

    it('plan_assign_reviewer → service.planAssignReviewer 收到 taskId/selfInstanceId/reviewerInstanceId', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 15,
          method: 'tools/call',
          params: {
            name: 'plan_assign_reviewer',
            arguments: {
              taskId: 't_1',
              selfInstanceId: 'ta_main',
              reviewerInstanceId: 'ta_reviewer',
            },
          },
        })
        .expect(200);

      expect(service.planAssignReviewer).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        {
          taskId: 't_1',
          selfInstanceId: 'ta_main',
          reviewerInstanceId: 'ta_reviewer',
        },
      );
      const text = res.body.result.content[0].text as string;
      expect(JSON.parse(text)).toEqual({
        planId: 'pl_1',
        taskId: 't_1',
        reviewerInstanceId: 'ta_reviewer',
        reviewerAlias: '开发者-1',
      });
    });

    it('team_add_member → service.teamAddMember 收到 taskId/selfInstanceId/agentId/alias/workDir', async () => {
      const res = await mcpPost()
        .set('x-worker-id', 'w_0001')
        .send({
          jsonrpc: '2.0',
          id: 16,
          method: 'tools/call',
          params: {
            name: 'team_add_member',
            arguments: {
              taskId: 't_1',
              selfInstanceId: 'ta_main',
              agentId: 'a_developer',
              alias: '开发者-2',
              workDir: '/data/worker/dev2',
            },
          },
        })
        .expect(200);

      expect(service.teamAddMember).toHaveBeenCalledWith(
        { workerId: 'w_0001' },
        {
          taskId: 't_1',
          selfInstanceId: 'ta_main',
          agentId: 'a_developer',
          alias: '开发者-2',
          workDir: '/data/worker/dev2',
        },
      );
      const text = res.body.result.content[0].text as string;
      expect(JSON.parse(text)).toEqual({
        requestId: 'que_platform_0000000001',
        taskId: 't_1',
        agentId: 'a_developer',
        alias: '开发者-1',
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
