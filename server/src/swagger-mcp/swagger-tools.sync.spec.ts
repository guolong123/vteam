import type { OpenAPIObject } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';

// @apidevtools/json-schema-ref-parser 为 ESM（jest CJS transform 无法加载），
// factory 完全替代模块避免 ESM 加载；sync 测试中 SwaggerDocsProvider 为 useValue
// mock（getDocument 返回固定文档），dereference 实际不会被调用。
jest.mock('@apidevtools/json-schema-ref-parser', () => ({
  dereference: jest.fn((doc: unknown) => Promise.resolve(doc)),
}));

import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { SwaggerDocsProvider } from './swagger-docs.provider';
import { SwaggerToolSyncService } from './swagger-tools.sync';

/** mini Swagger 文档：4 个 path×method 工具（operationId + 缺 operationId 各覆盖）。 */
const document: OpenAPIObject = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0' },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: '用户列表',
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'createUser',
        summary: '创建用户',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        summary: '用户详情',
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
    '/docs': {
      get: { operationId: 'swaggerUi', summary: 'Swagger UI', responses: {} },
    },
  },
};

describe('SwaggerToolSyncService', () => {
  let service: SwaggerToolSyncService;
  let docs: { getDocument: jest.Mock };
  let idGen: { nextId: jest.Mock };
  let prisma: { tool: { upsert: jest.Mock } };

  beforeEach(async () => {
    docs = { getDocument: jest.fn().mockReturnValue(document) };
    idGen = {
      nextId: jest
        .fn()
        .mockResolvedValueOnce('tl_0000000001')
        .mockResolvedValueOnce('tl_0000000002')
        .mockResolvedValueOnce('tl_0000000003'),
    };
    prisma = { tool: { upsert: jest.fn().mockResolvedValue({}) } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SwaggerToolSyncService,
        { provide: SwaggerDocsProvider, useValue: docs },
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
      ],
    }).compile();

    service = module.get<SwaggerToolSyncService>(SwaggerToolSyncService);
  });

  it('Swagger 文档生成 3 个工具（/docs 被排除），全部 upsert 进 tools 表', async () => {
    const synced = await service.syncToToolsTable();

    expect(synced).toBe(3);
    expect(prisma.tool.upsert).toHaveBeenCalledTimes(3);
    const names = prisma.tool.upsert.mock.calls.map(
      (call) => call[0].where.action,
    );
    expect(names).toEqual(['listusers', 'createuser', 'getuser']);
  });

  it('upsert 字段：name/action=工具名、source=mcp、execution=mcp、mcpServer=vteam-api、enabled=true', async () => {
    await service.syncToToolsTable();

    const call = prisma.tool.upsert.mock.calls.find(
      (c) => c[0].where.action === 'listusers',
    )![0];
    expect(call.where).toEqual({ action: 'listusers' });
    expect(call.update.name).toBe('listusers');
    expect(call.update.source).toBe('mcp');
    expect(call.update.execution).toBe('mcp');
    expect(call.update.mcpServer).toBe('vteam-api');
    expect(call.update.enabled).toBe(true);
    expect(call.create.name).toBe('listusers');
    expect(call.create.action).toBe('listusers');
  });

  it('schema 字段存 inputSchema，且并入 description（Tool 表无独立描述列）', async () => {
    await service.syncToToolsTable();

    const createUser = prisma.tool.upsert.mock.calls.find(
      (c) => c[0].where.action === 'createuser',
    )![0];
    expect(createUser.update.schema).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      description: '创建用户',
    });
    expect(createUser.create.schema).toEqual(createUser.update.schema);
  });

  it('create 分支 id 用 IdGeneratorService（前缀 tl）逐条生成', async () => {
    await service.syncToToolsTable();

    expect(idGen.nextId).toHaveBeenCalledTimes(3);
    expect(idGen.nextId).toHaveBeenCalledWith('tl');
    const createIds = prisma.tool.upsert.mock.calls.map(
      (c) => c[0].create.id,
    );
    expect(createIds).toEqual([
      'tl_0000000001',
      'tl_0000000002',
      'tl_0000000003',
    ]);
  });

  it('幂等：upsert by action（@unique），重复执行不新增行', async () => {
    await service.syncToToolsTable();
    prisma.tool.upsert.mockClear();
    idGen.nextId.mockClear();

    await service.syncToToolsTable();

    // 第二次执行仍走 upsert（where=action），不因已存在而跳过
    expect(prisma.tool.upsert).toHaveBeenCalledTimes(3);
    expect(idGen.nextId).toHaveBeenCalledTimes(3);
  });

  it('文档未就绪（getDocument 返回 null）→ warn 跳过，返回 0', async () => {
    docs.getDocument.mockReturnValue(null);

    const synced = await service.syncToToolsTable();

    expect(synced).toBe(0);
    expect(prisma.tool.upsert).not.toHaveBeenCalled();
  });

  it('单条 upsert 失败 → warn 并继续其余工具，不影响整体同步', async () => {
    prisma.tool.upsert
      .mockRejectedValueOnce(new Error('unique constraint'))
      .mockResolvedValue({});

    const synced = await service.syncToToolsTable();

    expect(synced).toBe(2);
    expect(prisma.tool.upsert).toHaveBeenCalledTimes(3);
  });
});
