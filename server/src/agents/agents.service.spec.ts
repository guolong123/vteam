import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AGENT_ERRORS } from '../common/constants/agent.constants';
import { IdGeneratorService } from '../common/id-generator';
import { ModelsService } from '../models/models.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient } from '../workers/worker.client';
import { WorkersService } from '../workers/workers.service';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

describe('AgentsService', () => {
  let service: AgentsService;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let workersService: { assignWorker: jest.Mock };
  let workerClient: { listModels: jest.Mock };
  let modelsService: { listCatalogModels: jest.Mock };
  let prisma: {
    agent: {
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    agentSkill: { create: jest.Mock; deleteMany: jest.Mock };
    agentToolEffect: { create: jest.Mock; deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };

  const templateRows = [
    {
      id: 'a_product',
      name: '产品经理',
      role: 'product',
      type: 'template',
      prompt: 'prompt1',
      baseAgentId: null,
      defaultModelId: null,
      ackMessage: '收到，正在处理…',
      permissionScope: null,
      createdBy: 'u_admin',
      createdAt: new Date('2026-08-07T00:00:00Z'),
      updatedAt: new Date('2026-08-07T00:00:00Z'),
      skills: [{ skillId: 's_skill1' }],
      toolEffects: [{ toolAction: 'read', effect: '允许读取' }],
    },
    {
      id: 'a_architect',
      name: '架构师',
      role: 'architect',
      type: 'template',
      prompt: 'prompt2',
      baseAgentId: null,
      defaultModelId: null,
      ackMessage: null,
      permissionScope: null,
      createdBy: 'u_admin',
      createdAt: new Date('2026-08-07T00:00:01Z'),
      updatedAt: new Date('2026-08-07T00:00:01Z'),
      skills: [],
      toolEffects: [],
    },
    {
      id: 'a_developer',
      name: '开发者',
      role: 'developer',
      type: 'template',
      prompt: 'prompt3',
      baseAgentId: null,
      defaultModelId: null,
      ackMessage: null,
      permissionScope: null,
      createdBy: 'u_admin',
      createdAt: new Date('2026-08-07T00:00:02Z'),
      updatedAt: new Date('2026-08-07T00:00:02Z'),
      skills: [],
      toolEffects: [],
    },
    {
      id: 'a_tester',
      name: '测试',
      role: 'tester',
      type: 'template',
      prompt: 'prompt4',
      baseAgentId: null,
      defaultModelId: null,
      ackMessage: null,
      permissionScope: null,
      createdBy: 'u_admin',
      createdAt: new Date('2026-08-07T00:00:03Z'),
      updatedAt: new Date('2026-08-07T00:00:03Z'),
      skills: [],
      toolEffects: [],
    },
  ];

  /** custom 可写 Agent（基于模板行改 type，含关联字段）。 */
  const customRow = {
    ...templateRows[0],
    id: 'a_0000000005',
    type: 'custom',
    baseAgentId: null,
    name: '数据分析师',
    role: 'analyst',
    prompt: 'prompt-custom',
    defaultModelId: 'opencode-go/deepseek-v4-flash',
    ackMessage: '收到确认',
    permissionScope: { projects: ['p1'], write: false },
  };

  let seq = 0;

  beforeEach(async () => {
    seq = 0;
    idGen = {
      nextId: jest.fn(
        async (prefix: string) =>
          `${prefix}_${String(++seq).padStart(10, '0')}`,
      ),
      seed: jest.fn(),
    };
    workersService = { assignWorker: jest.fn() };
    workerClient = { listModels: jest.fn() };
    // C3：available-models 目录优先——默认空目录走 pull 兜底（兼容既有测试语义），
    // 目录优先路径由专门的用例显式 mock 非空目录。
    modelsService = { listCatalogModels: jest.fn().mockResolvedValue([]) };
    modelsService = { listCatalogModels: jest.fn() };
    prisma = {
      agent: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      agentSkill: { create: jest.fn(), deleteMany: jest.fn() },
      agentToolEffect: { create: jest.fn(), deleteMany: jest.fn() },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: WorkersService, useValue: workersService },
        { provide: WorkerClient, useValue: workerClient },
        { provide: ModelsService, useValue: modelsService },
      ],
    }).compile();

    service = module.get<AgentsService>(AgentsService);
  });

  describe('findAll（列表：type 过滤 + 分页 + 扩展字段）', () => {
    it('无参返回全部 Agent，含扩展字段（skillIds/toolEffects/baseAgentId/permissionScope/defaultModelId）', async () => {
      prisma.$transaction.mockResolvedValue([templateRows.length, templateRows]);

      const result = await service.findAll();

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result.total).toBe(4);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.items).toHaveLength(4);
      expect(result.items[0]).toMatchObject({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        type: 'template',
        prompt: 'prompt1',
        baseAgentId: null,
        defaultModelId: null,
        ackMessage: '收到，正在处理…',
        permissionScope: null,
        skillIds: ['s_skill1'],
        toolEffects: [{ toolAction: 'read', effect: '允许读取' }],
      });
      // role 与前端 task-create 的 data-role 对齐
      const roles = result.items.map((i) => i.role);
      expect(roles).toEqual(['product', 'architect', 'developer', 'tester']);
      // 扩展字段契约：扁平数组 + 关联映射
      expect(Object.keys(result.items[0]).sort()).toEqual(
        [
          'id',
          'name',
          'role',
          'type',
          'prompt',
          'baseAgentId',
          'defaultModelId',
          'ackMessage',
          'permissionScope',
          'skillIds',
          'toolEffects',
          'workerId',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
    });

    it('无 type 时不过滤（where.type 为 undefined），skip/take 按缺省分页', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll();

      expect(prisma.agent.count).toHaveBeenCalledWith({
        where: { type: undefined },
      });
      expect(prisma.agent.findMany).toHaveBeenCalledWith({
        where: { type: undefined },
        include: { skills: true, toolEffects: true },
        orderBy: { createdAt: 'asc' },
        skip: 0,
        take: 20,
      });
    });

    it('type=template 过滤 + 自定义分页（page=2, pageSize=10）', async () => {
      prisma.$transaction.mockResolvedValue([4, templateRows]);

      await service.findAll({ type: 'template', page: 2, pageSize: 10 });

      expect(prisma.agent.count).toHaveBeenCalledWith({
        where: { type: { equals: 'template' } },
      });
      expect(prisma.agent.findMany).toHaveBeenCalledWith({
        where: { type: { equals: 'template' } },
        include: { skills: true, toolEffects: true },
        orderBy: { createdAt: 'asc' },
        skip: 10,
        take: 10,
      });
    });

    it('pageSize 超上限 100 时收敛为 100', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ pageSize: 999 });

      expect(prisma.agent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });
  });

  describe('findOne（详情）', () => {
    it('返回完整关联（skills + toolEffects + 基本字段）', async () => {
      prisma.agent.findUnique.mockResolvedValue(templateRows[0]);

      const result = await service.findOne('a_product');

      expect(prisma.agent.findUnique).toHaveBeenCalledWith({
        where: { id: 'a_product' },
        include: { skills: true, toolEffects: true },
      });
      expect(result).toMatchObject({
        id: 'a_product',
        name: '产品经理',
        type: 'template',
        skillIds: ['s_skill1'],
        toolEffects: [{ toolAction: 'read', effect: '允许读取' }],
      });
    });

    it('Agent 不存在 → 404 AGENT_NOT_FOUND', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);

      await expect(service.findOne('a_nonexistent')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.findOne('a_nonexistent')).rejects.toMatchObject({
        response: { code: AGENT_ERRORS.AGENT_NOT_FOUND },
      });
    });
  });

  describe('create（POST /agents，custom 三表事务）', () => {
    it('custom 创建：Agent + agent_skills + agent_tool_effects 同事务写入', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockResolvedValue(customRow);

      const dto: CreateAgentDto = {
        name: ' 数据分析师 ',
        type: 'custom',
        role: 'analyst',
        prompt: 'prompt-custom',
        skillIds: ['s_skill1', 's_skill2'],
        toolEffects: [{ toolAction: 'read', effect: 'allow' }],
        permissionScope: { projects: ['p1'], write: false },
        defaultModelId: 'opencode-go/deepseek-v4-flash',
        ackMessage: '收到确认',
      };

      const result = await service.create('u_admin', dto);

      // Agent 行：type=custom、baseAgentId=null、createdBy=当前用户、name trim
      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: expect.any(String),
            name: '数据分析师',
            type: 'custom',
            role: 'analyst',
            prompt: 'prompt-custom',
            baseAgentId: null,
            defaultModelId: 'opencode-go/deepseek-v4-flash',
            ackMessage: '收到确认',
            permissionScope: { projects: ['p1'], write: false },
            createdBy: 'u_admin',
          }),
        }),
      );
      // 批量关联
      expect(prisma.agentSkill.create).toHaveBeenCalledTimes(2);
      expect(prisma.agentSkill.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ agentId: 'a_0000000005', skillId: 's_skill1' }),
        }),
      );
      expect(prisma.agentToolEffect.create).toHaveBeenCalledTimes(1);
      expect(prisma.agentToolEffect.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agentId: 'a_0000000005',
            toolAction: 'read',
            effect: 'allow',
          }),
        }),
      );
      // 返回 toAgentDto 格式
      expect(result).toMatchObject({
        id: 'a_0000000005',
        type: 'custom',
        baseAgentId: null,
        skillIds: ['s_skill1', 's_skill2'],
        toolEffects: [{ toolAction: 'read', effect: 'allow' }],
        defaultModelId: 'opencode-go/deepseek-v4-flash',
        ackMessage: '收到确认',
      });
    });

    it('skillIds 去重后写入（agent_skills @@unique 防冲突）', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockResolvedValue(customRow);

      await service.create('u_admin', {
        name: '数据分析师',
        type: 'custom',
        skillIds: ['s1', 's1', 's2'],
      });

      expect(prisma.agentSkill.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('clone（POST /agents/:id/clone，深拷贝）', () => {
    it('克隆源：type=clone + baseAgentId 血缘 + 复制三表关联，源不被触碰', async () => {
      prisma.agent.findUnique.mockResolvedValue(templateRows[0]); // a_product 带 1 skill + 1 toolEffect
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockResolvedValue({
        ...templateRows[0],
        id: 'a_0000000005',
        name: '产品经理副本',
        type: 'clone',
        baseAgentId: 'a_product',
        createdBy: 'u_admin',
      });

      const result = await service.clone('u_admin', 'a_product', {});

      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: expect.any(String),
            name: '产品经理副本',
            type: 'clone',
            baseAgentId: 'a_product',
            role: 'product',
            prompt: 'prompt1',
            ackMessage: '收到，正在处理…',
            createdBy: 'u_admin',
          }),
        }),
      );
      // 关联深拷贝：1 skill + 1 toolEffect
      expect(prisma.agentSkill.create).toHaveBeenCalledTimes(1);
      expect(prisma.agentSkill.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agentId: 'a_0000000005',
            skillId: 's_skill1',
          }),
        }),
      );
      expect(prisma.agentToolEffect.create).toHaveBeenCalledTimes(1);
      // 克隆体返回带血缘与复制关联
      expect(result).toMatchObject({
        id: 'a_0000000005',
        name: '产品经理副本',
        type: 'clone',
        baseAgentId: 'a_product',
        ackMessage: '收到，正在处理…',
        skillIds: ['s_skill1'],
        toolEffects: [{ toolAction: 'read', effect: '允许读取' }],
      });
      // 源未被改写：无 update/delete 调用
      expect(prisma.agent.update).not.toHaveBeenCalled();
      expect(prisma.agent.delete).not.toHaveBeenCalled();
    });

    it('clone 显式 name 优先于「源名副本」', async () => {
      prisma.agent.findUnique.mockResolvedValue(templateRows[0]);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockResolvedValue({
        ...templateRows[0],
        id: 'a_0000000005',
        name: '自定义副本名',
        type: 'clone',
        baseAgentId: 'a_product',
      });

      await service.clone('u_admin', 'a_product', { name: ' 自定义副本名 ' });

      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: '自定义副本名' }),
        }),
      );
    });

    it('克隆源不存在 → 404 AGENT_NOT_FOUND', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);

      await expect(service.clone('u_admin', 'a_nonexistent', {})).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.clone('u_admin', 'a_nonexistent', {})).rejects.toMatchObject(
        { response: { code: AGENT_ERRORS.AGENT_NOT_FOUND } },
      );
    });
  });

  describe('update（PATCH /agents/:id）', () => {
    it('is_0000000030：type=template 可修改设置字段（prompt），不再 403', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(templateRows[0]) // 存在性
        .mockResolvedValueOnce({ ...templateRows[0], prompt: '新提示词' });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue({ ...templateRows[0], prompt: '新提示词' });
      prisma.agent.findUnique.mockResolvedValue({ ...templateRows[0], prompt: '新提示词' });

      const result = await service.update('a_product', { prompt: '新提示词' });

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ prompt: '新提示词' }),
        }),
      );
      expect(result).toBeDefined();
    });

    it('is_0000000030：type=template 可修改 defaultModelId（不再仅单字段放行）', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(templateRows[0])
        .mockResolvedValueOnce({ ...templateRows[0], defaultModelId: 'opencode-go/deepseek-v4-flash' });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue({ ...templateRows[0], defaultModelId: 'opencode-go/deepseek-v4-flash' });
      prisma.agent.findUnique.mockResolvedValue({ ...templateRows[0], defaultModelId: 'opencode-go/deepseek-v4-flash' });

      const result = await service.update('a_product', {
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            defaultModelId: 'opencode-go/deepseek-v4-flash',
          }),
        }),
      );
      expect(result).toBeDefined();
    });

    it('is_0000000030：type=template 可修改多字段（prompt+defaultModelId+ackMessage）', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(templateRows[0])
        .mockResolvedValueOnce({
          ...templateRows[0],
          prompt: 'x',
          defaultModelId: 'opencode-go/deepseek-v4-flash',
          ackMessage: '收到',
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue({ ...templateRows[0], prompt: 'x' });
      prisma.agent.findUnique.mockResolvedValue({ ...templateRows[0], prompt: 'x' });

      const result = await service.update('a_product', {
        ackMessage: '收到',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
        prompt: 'x',
      });

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ prompt: 'x' }),
        }),
      );
      expect(result).toBeDefined();
    });

    it('is_0000000030：type=template 可修改 skillIds/toolEffects（重建关联）', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(templateRows[0])
        .mockResolvedValueOnce(templateRows[0]);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(templateRows[0]);
      prisma.agent.findUnique.mockResolvedValue(templateRows[0]);

      const result = await service.update('a_product', {
        skillIds: ['skill_1'],
        toolEffects: [{ toolAction: 'bash', effect: 'allow' }],
      });

      expect(prisma.agent.update).toHaveBeenCalled();
      expect(prisma.agentSkill.deleteMany).toHaveBeenCalled();
      expect(prisma.agentToolEffect.deleteMany).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('is_0000000030：agent 不存在 → 404（template 放开后仍校验存在性）', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.update('a_ghost', { prompt: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('custom 更新：标量字段 + skillIds/toolEffects 显式传入时重建关联', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow) // 存在性/只读检查
        .mockResolvedValueOnce({
          // 事务内完整行
          ...customRow,
          name: '新数据分析师',
          prompt: 'new-prompt',
          defaultModelId: 'deepseek-v4-pro',
          skills: [{ skillId: 's_new' }],
          toolEffects: [{ toolAction: 'bash', effect: 'ask' }],
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      const dto: UpdateAgentDto = {
        name: '新数据分析师',
        prompt: 'new-prompt',
        defaultModelId: 'deepseek-v4-pro',
        ackMessage: '收到确认v2',
        skillIds: ['s_new'],
        toolEffects: [{ toolAction: 'bash', effect: 'ask' }],
      };

      const result = await service.update('a_0000000005', dto);

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: '新数据分析师',
            prompt: 'new-prompt',
            defaultModelId: 'deepseek-v4-pro',
            ackMessage: '收到确认v2',
          }),
        }),
      );
      // 重建关联：先清空再写入
      expect(prisma.agentSkill.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'a_0000000005' },
      });
      expect(prisma.agentToolEffect.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'a_0000000005' },
      });
      expect(prisma.agentSkill.create).toHaveBeenCalledTimes(1);
      expect(prisma.agentToolEffect.create).toHaveBeenCalledTimes(1);
      // 返回更新后完整 DTO
      expect(result).toMatchObject({
        id: 'a_0000000005',
        name: '新数据分析师',
        prompt: 'new-prompt',
        skillIds: ['s_new'],
        toolEffects: [{ toolAction: 'bash', effect: 'ask' }],
      });
    });

    it('custom 更新不传 skillIds/toolEffects 时不重建关联', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow)
        .mockResolvedValueOnce({
          ...customRow,
          name: '仅改名',
          skills: [{ skillId: 's_skill1' }],
          toolEffects: [{ toolAction: 'read', effect: '允许读取' }],
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      await service.update('a_0000000005', { name: '仅改名' });

      expect(prisma.agentSkill.deleteMany).not.toHaveBeenCalled();
      expect(prisma.agentToolEffect.deleteMany).not.toHaveBeenCalled();
      expect(prisma.agentSkill.create).not.toHaveBeenCalled();
      expect(prisma.agentToolEffect.create).not.toHaveBeenCalled();
    });

    it('仅传 toolEffects 时只重建 toolEffects，skills 关联保留（不被清空）', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow)
        .mockResolvedValueOnce({
          ...customRow,
          prompt: 'new-prompt',
          skills: [{ skillId: 's_skill1' }], // 原 skills 保留
          toolEffects: [{ toolAction: 'bash', effect: 'ask' }],
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      const result = await service.update('a_0000000005', {
        prompt: 'new-prompt',
        toolEffects: [{ toolAction: 'bash', effect: 'ask' }],
      });

      // skills 关联表零触碰
      expect(prisma.agentSkill.deleteMany).not.toHaveBeenCalled();
      expect(prisma.agentSkill.create).not.toHaveBeenCalled();
      // toolEffects 表清空后重建
      expect(prisma.agentToolEffect.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'a_0000000005' },
      });
      expect(prisma.agentToolEffect.create).toHaveBeenCalledTimes(1);
      // 返回 DTO：skillIds 保留原值
      expect(result).toMatchObject({
        prompt: 'new-prompt',
        skillIds: ['s_skill1'],
        toolEffects: [{ toolAction: 'bash', effect: 'ask' }],
      });
    });

    it('仅传 skillIds 时只重建 skills，toolEffects 保留（不被清空）', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow)
        .mockResolvedValueOnce({
          ...customRow,
          prompt: 'new-prompt',
          skills: [{ skillId: 's_new' }],
          toolEffects: [{ toolAction: 'read', effect: '允许读取' }], // 原 toolEffects 保留
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      const result = await service.update('a_0000000005', {
        prompt: 'new-prompt',
        skillIds: ['s_new'],
      });

      // toolEffects 关联表零触碰
      expect(prisma.agentToolEffect.deleteMany).not.toHaveBeenCalled();
      expect(prisma.agentToolEffect.create).not.toHaveBeenCalled();
      // skills 表清空后重建
      expect(prisma.agentSkill.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'a_0000000005' },
      });
      expect(prisma.agentSkill.create).toHaveBeenCalledTimes(1);
      // 返回 DTO：toolEffects 保留原值
      expect(result).toMatchObject({
        prompt: 'new-prompt',
        skillIds: ['s_new'],
        toolEffects: [{ toolAction: 'read', effect: '允许读取' }],
      });
    });

    it('skillIds/toolEffects 都传时两表各自清空后重建', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow)
        .mockResolvedValueOnce({
          ...customRow,
          prompt: 'new-prompt',
          skills: [{ skillId: 's_new' }],
          toolEffects: [{ toolAction: 'bash', effect: 'ask' }],
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      const result = await service.update('a_0000000005', {
        prompt: 'new-prompt',
        skillIds: ['s_new'],
        toolEffects: [{ toolAction: 'bash', effect: 'ask' }],
      });

      expect(prisma.agentSkill.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'a_0000000005' },
      });
      expect(prisma.agentToolEffect.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'a_0000000005' },
      });
      expect(prisma.agentSkill.create).toHaveBeenCalledTimes(1);
      expect(prisma.agentToolEffect.create).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        skillIds: ['s_new'],
        toolEffects: [{ toolAction: 'bash', effect: 'ask' }],
      });
    });

    it('Agent 不存在 → 404 AGENT_NOT_FOUND', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);

      await expect(service.update('a_nonexistent', { prompt: 'x' })).rejects.toMatchObject(
        { response: { code: AGENT_ERRORS.AGENT_NOT_FOUND } },
      );
    });
  });

  describe('remove（DELETE /agents/:id）', () => {
    it('type=template → 403 PERMISSION_AGENT_READONLY', async () => {
      prisma.agent.findUnique.mockResolvedValue(templateRows[0]);

      await expect(service.remove('a_product')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.remove('a_product')).rejects.toMatchObject({
        response: { code: AGENT_ERRORS.AGENT_READONLY },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('custom：事务内删 agent_skills + agent_tool_effects + agent 本体', async () => {
      prisma.agent.findUnique.mockResolvedValue(customRow);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));

      await service.remove('a_0000000005');

      expect(prisma.agentSkill.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'a_0000000005' },
      });
      expect(prisma.agentToolEffect.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'a_0000000005' },
      });
      expect(prisma.agent.delete).toHaveBeenCalledWith({
        where: { id: 'a_0000000005' },
      });
    });
  });

  describe('getAvailableModels（GET /agents/:id/available-models，C3 目录优先三路径）', () => {
    /** WorkerClient.listModels 返回形状（含 providerID/modelID，对外只映射 {id, name}）。 */
    const liveModels = [
      {
        id: 'opencode-go/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        providerID: 'opencode-go',
        modelID: 'deepseek-v4-flash',
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        providerID: '',
        modelID: 'deepseek-v4-pro',
      },
    ];

    it('目录非空（enabled=true）→ 直接返回目录，不触发 assignWorker/listModels（无在线 worker 也可查）', async () => {
      modelsService.listCatalogModels.mockResolvedValue([
        { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      ]);

      const result = await service.getAvailableModels('a_product');

      expect(workersService.assignWorker).not.toHaveBeenCalled();
      expect(workerClient.listModels).not.toHaveBeenCalled();
      expect(result).toEqual([
        { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      ]);
    });

    it('目录空 + worker 在线：pull 兜底 → listModels 返回动态列表（纯数组契约）', async () => {
      modelsService.listCatalogModels.mockResolvedValue([]);
      workersService.assignWorker.mockResolvedValue('w_1');
      workerClient.listModels.mockResolvedValue(liveModels);

      const result = await service.getAvailableModels('a_product');

      expect(workersService.assignWorker).toHaveBeenCalledWith();
      expect(workerClient.listModels).toHaveBeenCalledWith({ id: 'w_1' });
      expect(result).toEqual([
        { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ]);
    });

    it('目录空 + 无可用 worker → 降级 STATIC_AVAILABLE_MODELS + source=fallback', async () => {
      modelsService.listCatalogModels.mockResolvedValue([]);
      workersService.assignWorker.mockResolvedValue(null);

      const result = (await service.getAvailableModels('a_product')) as {
        models: readonly { id: string }[];
        source: string;
      };

      expect(workerClient.listModels).not.toHaveBeenCalled();
      expect(result).toMatchObject({ source: 'fallback' });
      // fallback 用 D7 新格式模型 id（provider/model），非旧 gpt-4o
      expect(result.models.map((m) => m.id)).toContain(
        'opencode-go/deepseek-v4-flash',
      );
      expect(result.models.map((m) => m.id)).not.toContain('gpt-4o');
    });

    it('目录空 + listModels 异常 → 降级 STATIC_AVAILABLE_MODELS + source=fallback', async () => {
      modelsService.listCatalogModels.mockResolvedValue([]);
      workersService.assignWorker.mockResolvedValue('w_1');
      workerClient.listModels.mockRejectedValue(new Error('worker 离线'));

      const result = (await service.getAvailableModels('a_product')) as {
        models: readonly { id: string }[];
        source: string;
      };

      expect(result).toMatchObject({ source: 'fallback' });
      expect(result.models.length).toBeGreaterThan(0);
    });

    it('目录空 + listModels 返回空列表 → 降级 STATIC_AVAILABLE_MODELS + source=fallback', async () => {
      modelsService.listCatalogModels.mockResolvedValue([]);
      workersService.assignWorker.mockResolvedValue('w_1');
      workerClient.listModels.mockResolvedValue([]);

      const result = (await service.getAvailableModels('a_product')) as {
        models: readonly { id: string }[];
        source: string;
      };

      expect(result).toMatchObject({ source: 'fallback' });
      expect(result.models.length).toBeGreaterThan(0);
    });
  });
});
