import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AGENT_ERRORS,
  buildEditPermission,
  buildReadPermission,
  ROLE_BASH_DENY_PATTERNS,
  ROLE_BOUNDARIES,
  ROLE_POLICY_DENY_TEMPLATE,
} from '../common/constants/agent.constants';
import { IdGeneratorService } from '../common/id-generator';
import { ExecutionPolicyService } from '../execution-policies/execution-policy.service';
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
  let workerClient: {
    listModels: jest.Mock;
    listAgents: jest.Mock;
    getOmoConfig: jest.Mock;
    setOmoConfig: jest.Mock;
    getOmoAgentPrompt: jest.Mock;
  };
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
    executionPolicy: { findUnique: jest.Mock; create: jest.Mock };
    worker: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let executionPolicyService: { resolveManyByAgents: jest.Mock };

  const templateRows = [
    {
      id: 'a_product',
      name: '产品经理',
      role: 'product',
      type: 'template',
      prompt: 'prompt1',
      baseAgentId: null,
      defaultModelId: null,
      persona: 'innovative',
      workerId: null,
      policyId: 'ep_product',
      createdBy: 'u_admin',
      createdAt: new Date('2026-08-07T00:00:00Z'),
      updatedAt: new Date('2026-08-07T00:00:00Z'),
      skills: [{ skillId: 's_skill1' }],
    },
    {
      id: 'a_architect',
      name: '架构师',
      role: 'architect',
      type: 'template',
      prompt: 'prompt2',
      baseAgentId: null,
      defaultModelId: null,
      persona: 'steady',
      workerId: null,
      policyId: 'ep_architect',
      createdBy: 'u_admin',
      createdAt: new Date('2026-08-07T00:00:01Z'),
      updatedAt: new Date('2026-08-07T00:00:01Z'),
      skills: [],
    },
    {
      id: 'a_developer',
      name: '开发者',
      role: 'developer',
      type: 'template',
      prompt: 'prompt3',
      baseAgentId: null,
      defaultModelId: null,
      persona: 'conservative',
      workerId: null,
      policyId: 'ep_developer',
      createdBy: 'u_admin',
      createdAt: new Date('2026-08-07T00:00:02Z'),
      updatedAt: new Date('2026-08-07T00:00:02Z'),
      skills: [],
    },
    {
      id: 'a_tester',
      name: '测试',
      role: 'tester',
      type: 'template',
      prompt: 'prompt4',
      baseAgentId: null,
      defaultModelId: null,
      persona: 'strict',
      workerId: null,
      policyId: 'ep_tester',
      createdBy: 'u_admin',
      createdAt: new Date('2026-08-07T00:00:03Z'),
      updatedAt: new Date('2026-08-07T00:00:03Z'),
      skills: [],
    },
  ];

  const customRow = {
    ...templateRows[0],
    id: 'a_0000000005',
    type: 'custom',
    baseAgentId: null,
    name: '数据分析师',
    role: 'analyst',
    prompt: 'prompt-custom',
    defaultModelId: 'opencode-go/deepseek-v4-flash',
    persona: null,
    workerId: null,
    policyId: null,
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
    workerClient = {
      listModels: jest.fn(),
      listAgents: jest.fn(),
      getOmoConfig: jest.fn(),
      setOmoConfig: jest.fn(),
      getOmoAgentPrompt: jest.fn(),
    };
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
      // 策略装配（clone/create 恒建 custom 策略）：默认库内无模板行，
      // role 命中内置边界时走 ROLE_BOUNDARIES 派生回退；create 回显 data 行。
      executionPolicy: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(
            async ({ data }: { data: Record<string, unknown> }) => ({
              ...data,
              createdAt: new Date('2026-09-14T00:00:00Z'),
              updatedAt: new Date('2026-09-14T00:00:00Z'),
            }),
          ),
      },
      // listOpencodeAgents / getAvailableModels 需读 worker.capabilities 解析 exec 基址
      worker: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    };
    executionPolicyService = {
      resolveManyByAgents: jest.fn(
        async (agents: { policyId?: string | null; role?: string | null }[]) =>
          agents.map((a) => {
            const key = a.policyId ?? (a.role ? `ep_${a.role}` : null);
            if (
              !key ||
              ![
                'ep_product',
                'ep_project_manager',
                'ep_architect',
                'ep_developer',
                'ep_tester',
              ].includes(key)
            ) {
              return null;
            }
            const agentName = a.role ? `vteam-${a.role}` : 'vteam-plan';
            const boundary = (
              ROLE_BOUNDARIES as Record<
                string,
                { toolAllows?: Record<string, 'allow' | 'ask'> }
              >
            )[agentName];
            return {
              policyId: key,
              policyName: `${key}-name`,
              agentName,
              permission: { edit: 'allow' },
              tools: { ...(boundary?.toolAllows ?? {}) },
              bashDeny: [...ROLE_BASH_DENY_PATTERNS],
              correction: { scopeSummary: 'test' },
            };
          }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: WorkersService, useValue: workersService },
        { provide: WorkerClient, useValue: workerClient },
        { provide: ModelsService, useValue: modelsService },
        { provide: ExecutionPolicyService, useValue: executionPolicyService },
      ],
    }).compile();

    service = module.get<AgentsService>(AgentsService);
  });

  describe('findAll（列表：type 过滤 + 分页 + 扩展字段）', () => {
    it('无参返回全部 Agent，含扩展字段（skillIds/policyId/effectivePermission/baseAgentId/defaultModelId）', async () => {
      prisma.$transaction.mockResolvedValue([
        templateRows.length,
        templateRows,
      ]);

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
        policyId: 'ep_product',
        skillIds: ['s_skill1'],
        effectivePermission: {
          policyId: 'ep_product',
          agentName: 'vteam-product',
        },
      });
      // role 与前端 task-create 的 data-role 对齐
      const roles = result.items.map((i) => i.role);
      expect(roles).toEqual(['product', 'architect', 'developer', 'tester']);
      // 扩展字段契约：扁平数组 + 策略绑定 + 生效权限
      expect(Object.keys(result.items[0]).sort()).toEqual(
        [
          'id',
          'name',
          'role',
          'agentKey',
          'type',
          'prompt',
          'baseAgentId',
          'defaultModelId',
          'persona',
          'policyId',
          'skillIds',
          'effectivePermission',
          'workerId',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
    });

    it('effectivePermission 与各行 policyId 一一对应（批量单次解析，无 N+1）', async () => {
      prisma.$transaction.mockResolvedValue([
        templateRows.length,
        templateRows,
      ]);

      const result = await service.findAll();

      expect(executionPolicyService.resolveManyByAgents).toHaveBeenCalledTimes(
        1,
      );
      expect(executionPolicyService.resolveManyByAgents).toHaveBeenCalledWith([
        { policyId: 'ep_product', role: 'product' },
        { policyId: 'ep_architect', role: 'architect' },
        { policyId: 'ep_developer', role: 'developer' },
        { policyId: 'ep_tester', role: 'tester' },
      ]);
      expect(result.items.map((i) => i.effectivePermission?.policyId)).toEqual([
        'ep_product',
        'ep_architect',
        'ep_developer',
        'ep_tester',
      ]);
    });

    it('未绑定策略的行 → effectivePermission=null', async () => {
      prisma.$transaction.mockResolvedValue([1, [customRow]]);

      const result = await service.findAll();

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ policyId: null });
      expect(result.items[0].effectivePermission).toBeNull();
    });

    it('无 type 时不过滤（where.type 为 undefined），skip/take 按缺省分页', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll();

      expect(prisma.agent.count).toHaveBeenCalledWith({
        where: { type: undefined },
      });
      expect(prisma.agent.findMany).toHaveBeenCalledWith({
        where: { type: undefined },
        include: { skills: true },
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
        include: { skills: true },
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
    it('返回完整关联（skills + 基本字段 + policyId + effectivePermission）', async () => {
      prisma.agent.findUnique.mockResolvedValue(templateRows[0]);

      const result = await service.findOne('a_product');

      expect(prisma.agent.findUnique).toHaveBeenCalledWith({
        where: { id: 'a_product' },
        include: { skills: true },
      });
      expect(result).toMatchObject({
        id: 'a_product',
        name: '产品经理',
        type: 'template',
        skillIds: ['s_skill1'],
        policyId: 'ep_product',
        effectivePermission: {
          policyId: 'ep_product',
          policyName: 'ep_product-name',
          agentName: 'vteam-product',
        },
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

  describe('create（POST /agents，custom 二表事务）', () => {
    it('custom 创建：Agent + agent_skills 同事务写入', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockResolvedValue({
        ...customRow,
        agentKey: 'data-analyst',
      });

      const dto: CreateAgentDto = {
        name: ' 数据分析师 ',
        type: 'custom',
        agentKey: 'data-analyst',
        role: 'analyst',
        prompt: 'prompt-custom',
        skillIds: ['s_skill1', 's_skill2'],
        defaultModelId: 'opencode-go/deepseek-v4-flash',
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
            agentKey: 'data-analyst',
            prompt: 'prompt-custom',
            baseAgentId: null,
            defaultModelId: 'opencode-go/deepseek-v4-flash',
            createdBy: 'u_admin',
          }),
        }),
      );
      // 批量关联
      expect(prisma.agentSkill.create).toHaveBeenCalledTimes(2);
      expect(prisma.agentSkill.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agentId: 'a_0000000005',
            skillId: 's_skill1',
          }),
        }),
      );
      // 返回 toAgentDto 格式（未绑定策略 → effectivePermission=null）
      expect(result).toMatchObject({
        id: 'a_0000000005',
        type: 'custom',
        agentKey: 'data-analyst',
        baseAgentId: null,
        skillIds: ['s_skill1', 's_skill2'],
        defaultModelId: 'opencode-go/deepseek-v4-flash',
        effectivePermission: null,
      });
    });

    it('skillIds 去重后写入（agent_skills @@unique 防冲突）', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockResolvedValue(customRow);

      await service.create('u_admin', {
        name: '数据分析师',
        type: 'custom',
        agentKey: 'dedup-agent',
        skillIds: ['s1', 's1', 's2'],
      });

      expect(prisma.agentSkill.create).toHaveBeenCalledTimes(2);
    });

    it('persona 落库：DTO 传 persona 时写入 agents.persona，不改写 prompt（运行时拼接）', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockResolvedValue({
        ...customRow,
        persona: 'strict',
      });

      await service.create('u_admin', {
        name: '数据分析师',
        type: 'custom',
        agentKey: 'persona-agent',
        prompt: 'prompt-custom',
        persona: 'strict',
      });

      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            persona: 'strict',
            prompt: 'prompt-custom', // prompt 原样，性格段不写入 prompt
          }),
        }),
      );
    });

    it('create 不传 persona：落库 persona=null（缺省无性格，向后兼容）', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockResolvedValue(customRow);

      await service.create('u_admin', {
        name: '数据分析师',
        type: 'custom',
        agentKey: 'plain-agent',
      });

      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ persona: null }),
        }),
      );
    });
  });

  describe('clone（POST /agents/:id/clone，深拷贝）', () => {
    it('克隆源：type=clone + baseAgentId 血缘 + 复制 skills 关联，源不被触碰', async () => {
      prisma.agent.findUnique.mockResolvedValue(templateRows[0]); // a_product 带 1 skill
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          createdAt: new Date('2026-09-14T00:00:00Z'),
          updatedAt: new Date('2026-09-14T00:00:00Z'),
        }),
      );

      const result = await service.clone('u_admin', 'a_product', {
        agentKey: 'product-copy',
      });

      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: expect.any(String),
            name: '产品经理副本',
            type: 'clone',
            baseAgentId: 'a_product',
            role: 'product',
            agentKey: 'product-copy',
            prompt: 'prompt1',
            createdBy: 'u_admin',
          }),
        }),
      );
      // 克隆恒装配新 custom 策略（库内无 ep_product 行 → ROLE_BOUNDARIES 派生回退），不继承模板绑定
      const policyId = prisma.executionPolicy.create.mock.calls[0][0].data.id;
      expect(prisma.executionPolicy.create).toHaveBeenCalledTimes(1);
      expect(prisma.executionPolicy.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: '产品经理副本 策略',
            type: 'custom',
          }),
        }),
      );
      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ policyId }),
        }),
      );
      expect(policyId).not.toBe('ep_product');
      // 关联深拷贝：1 skill（clone.id 为事务内第二个序号 a_0000000002，首个被策略装配占用）
      expect(prisma.agentSkill.create).toHaveBeenCalledTimes(1);
      expect(prisma.agentSkill.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agentId: 'a_0000000002',
            skillId: 's_skill1',
          }),
        }),
      );
      // 克隆体返回带血缘与复制关联（绑定新 custom 策略，未知 key → effectivePermission=null 由装配单测覆盖 tools 非空）
      expect(result).toMatchObject({
        id: 'a_0000000002',
        name: '产品经理副本',
        type: 'clone',
        agentKey: 'product-copy',
        baseAgentId: 'a_product',
        skillIds: ['s_skill1'],
        policyId: 'ep_0000000001',
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
        agentKey: 'named-copy',
        baseAgentId: 'a_product',
      });

      await service.clone('u_admin', 'a_product', {
        name: ' 自定义副本名 ',
        agentKey: 'named-copy',
      });

      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: '自定义副本名' }),
        }),
      );
    });

    it('克隆源不存在 → 404 AGENT_NOT_FOUND', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);

      await expect(
        service.clone('u_admin', 'a_nonexistent', {
          agentKey: 'ghost-copy',
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.clone('u_admin', 'a_nonexistent', {
          agentKey: 'ghost-copy',
        }),
      ).rejects.toMatchObject({
        response: { code: AGENT_ERRORS.AGENT_NOT_FOUND },
      });
    });
  });

  describe('update（PATCH /agents/:id）', () => {
    it('is_0000000030：type=template 可修改设置字段（prompt），不再 403', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(templateRows[0]) // 存在性
        .mockResolvedValueOnce({ ...templateRows[0], prompt: '新提示词' });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue({
        ...templateRows[0],
        prompt: '新提示词',
      });
      prisma.agent.findUnique.mockResolvedValue({
        ...templateRows[0],
        prompt: '新提示词',
      });

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
        .mockResolvedValueOnce({
          ...templateRows[0],
          defaultModelId: 'opencode-go/deepseek-v4-flash',
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue({
        ...templateRows[0],
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      prisma.agent.findUnique.mockResolvedValue({
        ...templateRows[0],
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });

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

    it('is_0000000030：type=template 可修改多字段（prompt+defaultModelId）', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(templateRows[0])
        .mockResolvedValueOnce({
          ...templateRows[0],
          prompt: 'x',
          defaultModelId: 'opencode-go/deepseek-v4-flash',
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue({
        ...templateRows[0],
        prompt: 'x',
      });
      prisma.agent.findUnique.mockResolvedValue({
        ...templateRows[0],
        prompt: 'x',
      });

      const result = await service.update('a_product', {
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

    it('is_0000000030：type=template 可修改 skillIds（重建关联）', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(templateRows[0])
        .mockResolvedValueOnce(templateRows[0]);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(templateRows[0]);
      prisma.agent.findUnique.mockResolvedValue(templateRows[0]);

      const result = await service.update('a_product', {
        skillIds: ['skill_1'],
      });

      expect(prisma.agent.update).toHaveBeenCalled();
      expect(prisma.agentSkill.deleteMany).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('is_0000000030：agent 不存在 → 404（template 放开后仍校验存在性）', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.update('a_ghost', { prompt: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('custom 更新：标量字段 + skillIds 显式传入时重建关联', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow) // 存在性/只读检查
        .mockResolvedValueOnce({
          // 事务内完整行
          ...customRow,
          name: '新数据分析师',
          prompt: 'new-prompt',
          defaultModelId: 'deepseek-v4-pro',
          skills: [{ skillId: 's_new' }],
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      const dto: UpdateAgentDto = {
        name: '新数据分析师',
        prompt: 'new-prompt',
        defaultModelId: 'deepseek-v4-pro',
        skillIds: ['s_new'],
      };

      const result = await service.update('a_0000000005', dto);

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: '新数据分析师',
            prompt: 'new-prompt',
            defaultModelId: 'deepseek-v4-pro',
          }),
        }),
      );
      // 重建关联：先清空再写入
      expect(prisma.agentSkill.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'a_0000000005' },
      });
      expect(prisma.agentSkill.create).toHaveBeenCalledTimes(1);
      // 返回更新后完整 DTO
      expect(result).toMatchObject({
        id: 'a_0000000005',
        name: '新数据分析师',
        prompt: 'new-prompt',
        skillIds: ['s_new'],
      });
    });

    it('custom 更新不传 skillIds 时不重建关联', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow)
        .mockResolvedValueOnce({
          ...customRow,
          name: '仅改名',
          skills: [{ skillId: 's_skill1' }],
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      await service.update('a_0000000005', { name: '仅改名' });

      expect(prisma.agentSkill.deleteMany).not.toHaveBeenCalled();
      expect(prisma.agentSkill.create).not.toHaveBeenCalled();
    });

    it('skillIds 传空数组 → 清空关联（显式传入即重建）', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow)
        .mockResolvedValueOnce({
          ...customRow,
          skills: [],
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      const result = await service.update('a_0000000005', { skillIds: [] });

      expect(prisma.agentSkill.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'a_0000000005' },
      });
      expect(prisma.agentSkill.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ skillIds: [] });
    });

    it('skillIds 显式传入时清空后重建并返回新关联', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow)
        .mockResolvedValueOnce({
          ...customRow,
          prompt: 'new-prompt',
          skills: [{ skillId: 's_new' }],
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      const result = await service.update('a_0000000005', {
        prompt: 'new-prompt',
        skillIds: ['s_new'],
      });

      // skills 表清空后重建
      expect(prisma.agentSkill.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'a_0000000005' },
      });
      expect(prisma.agentSkill.create).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        prompt: 'new-prompt',
        skillIds: ['s_new'],
      });
    });

    it('Agent 不存在 → 404 AGENT_NOT_FOUND', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);

      await expect(
        service.update('a_nonexistent', { prompt: 'x' }),
      ).rejects.toMatchObject({
        response: { code: AGENT_ERRORS.AGENT_NOT_FOUND },
      });
    });

    it('persona 更新：传 persona 写入 agents.persona，null 清除性格（不触碰 prompt）', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));

      // 第一次 update：设置性格
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow)
        .mockResolvedValueOnce({ ...customRow, persona: 'innovative' });
      prisma.agent.update.mockResolvedValue({
        ...customRow,
        persona: 'innovative',
      });

      await service.update('a_0000000005', { persona: 'innovative' });

      expect(prisma.agent.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ persona: 'innovative' }),
        }),
      );

      // 第二次 update：persona=null → 清除性格（UpdateAgentDto 允许 null 表示清空）
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow)
        .mockResolvedValueOnce({ ...customRow, persona: null });
      prisma.agent.update.mockResolvedValue({ ...customRow, persona: null });

      await service.update('a_0000000005', { persona: null });

      expect(prisma.agent.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ persona: null }),
        }),
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

    it('custom：事务内删 agent_skills + agent 本体', async () => {
      prisma.agent.findUnique.mockResolvedValue(customRow);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));

      await service.remove('a_0000000005');

      expect(prisma.agentSkill.deleteMany).toHaveBeenCalledWith({
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
      expect(result.models).toEqual([]);
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
      expect(result.models).toEqual([]);
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
      expect(result.models).toEqual([]);
    });
  });

  describe('getOmoConfig / setOmoConfig（OmO agent→模型配置）', () => {
    it('getOmoConfig 成功：透传 agents/available，带 capabilities 调 worker', async () => {
      workersService.assignWorker.mockResolvedValue('w_1');
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: { execBaseUrl: 'http://worker:4198' },
      });
      workerClient.getOmoConfig.mockResolvedValue({
        agents: { sisyphus: 'opencode/big-pickle' },
        available: ['sisyphus', 'prometheus', 'atlas'],
        degraded: false,
      });

      const result = await service.getOmoConfig({});

      // ⚠️ 同 listOpencodeAgents：必须带 capabilities，否则 baseUrl 回退 localhost
      expect(workerClient.getOmoConfig).toHaveBeenCalledWith({
        id: 'w_1',
        capabilities: { execBaseUrl: 'http://worker:4198' },
      });
      expect(result).toEqual({
        agents: { sisyphus: 'opencode/big-pickle' },
        available: ['sisyphus', 'prometheus', 'atlas'],
        workerId: 'w_1',
        degraded: false,
      });
    });

    it('getOmoConfig：无在线 worker → degraded=true（不抛错）', async () => {
      workersService.assignWorker.mockResolvedValue(null);
      const result = await service.getOmoConfig({});
      expect(result).toEqual({
        agents: {},
        available: [],
        workerId: null,
        degraded: true,
      });
    });

    it('getOmoConfig：worker 抛错 → degraded=true（列表端点不阻断页面）', async () => {
      workersService.assignWorker.mockResolvedValue('w_1');
      workerClient.getOmoConfig.mockRejectedValue(new Error('down'));
      const result = await service.getOmoConfig({});
      expect(result.degraded).toBe(true);
    });

    it('setOmoConfig 成功：透传 agents 并回传 written/workerId', async () => {
      workersService.assignWorker.mockResolvedValue('w_1');
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: { execBaseUrl: 'http://worker:4198' },
      });
      workerClient.setOmoConfig.mockResolvedValue({
        written: '/data/vteam-worker/.omo/omo.jsonc',
        agents: { sisyphus: 'opencode/big-pickle' },
      });

      const result = await service.setOmoConfig({
        sisyphus: 'opencode/big-pickle',
      });

      // 第三参 enabled 不传时为 undefined（表示不改动开关）
      expect(workerClient.setOmoConfig).toHaveBeenCalledWith(
        { id: 'w_1', capabilities: { execBaseUrl: 'http://worker:4198' } },
        { sisyphus: 'opencode/big-pickle' },
        undefined,
      );
      expect(result.workerId).toBe('w_1');
      expect(result.agents).toEqual({ sisyphus: 'opencode/big-pickle' });
    });

    it('setOmoConfig：无可用 worker → 抛 503（写路径不静默降级）', async () => {
      workersService.assignWorker.mockResolvedValue(null);
      await expect(service.setOmoConfig({ a: 'b/c' })).rejects.toThrow(
        /未定位到可用的 worker/,
      );
    });

    it('setOmoConfig：worker 行不存在 → 抛 503', async () => {
      workersService.assignWorker.mockResolvedValue('w_gone');
      prisma.worker.findUnique.mockResolvedValue(null);
      await expect(service.setOmoConfig({ a: 'b/c' })).rejects.toThrow(
        /指定的 worker 不存在/,
      );
    });
  });

  describe('getOmoAgentPrompt（按需拉单个 agent 提示词）', () => {
    it('成功：带 capabilities 调 worker，透传 prompt', async () => {
      workersService.assignWorker.mockResolvedValue('w_1');
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: { execBaseUrl: 'http://worker:4198' },
      });
      workerClient.getOmoAgentPrompt.mockResolvedValue({
        name: 'Prometheus - Plan Builder',
        description: 'Plan agent',
        prompt: 'You are Prometheus',
        empty: false,
      });

      const out = await service.getOmoAgentPrompt('prometheus');

      expect(workerClient.getOmoAgentPrompt).toHaveBeenCalledWith(
        { id: 'w_1', capabilities: { execBaseUrl: 'http://worker:4198' } },
        'prometheus',
      );
      expect(out.prompt).toBe('You are Prometheus');
    });

    it('无可用 worker → 抛 503（写/取路径不静默降级）', async () => {
      workersService.assignWorker.mockResolvedValue(null);
      await expect(service.getOmoAgentPrompt('oracle')).rejects.toThrow(
        /未定位到可用的 worker/,
      );
    });

    it('worker 行不存在 → 抛 503', async () => {
      workersService.assignWorker.mockResolvedValue('w_gone');
      prisma.worker.findUnique.mockResolvedValue(null);
      await expect(service.getOmoAgentPrompt('oracle')).rejects.toThrow(
        /指定的 worker 不存在/,
      );
    });
  });

  describe('listOpencodeAgents（GET /agents/opencode：opencode 原生 agent 清单）', () => {
    it('成功：透传 agents + degraded=false + 实际 workerId', async () => {
      workersService.assignWorker.mockResolvedValue('w_1');
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: { execBaseUrl: 'http://worker:4198' },
      });
      const agents = [
        { name: 'build', mode: 'primary', native: true },
        { name: 'plan', mode: 'primary', native: true },
      ];
      workerClient.listAgents.mockResolvedValue(agents);

      const result = await service.listOpencodeAgents({});

      // ⚠️ 回归断言（本地部署实测踩坑）：必须把 worker 行（含 capabilities）传给
      // listAgents —— exec 端点 baseUrl 由 capabilities 解析；只传 { id } 会回退
      // WORKER_BASE_URL（localhost:4199），跨容器部署必然连不上且被 catch 静默吞成
      // degraded=true（症状隐蔽）。此处锁定必须带 capabilities。
      expect(workerClient.listAgents).toHaveBeenCalledWith(
        { id: 'w_1', capabilities: { execBaseUrl: 'http://worker:4198' } },
        undefined,
      );
      expect(result).toEqual({
        agents,
        workerId: 'w_1',
        degraded: false,
      });
    });

    it('workerId + directory 显式传入 → 直接用该 worker 并透传 directory', async () => {
      workerClient.listAgents.mockResolvedValue([
        { name: 'plan', mode: 'primary' },
      ]);

      await service.listOpencodeAgents({
        workerId: 'w_explicit',
        directory: '/data/vteam-worker/tasks/t_1',
      });

      expect(workersService.assignWorker).not.toHaveBeenCalled();
      expect(workerClient.listAgents).toHaveBeenCalledWith(
        { id: 'w_explicit' },
        '/data/vteam-worker/tasks/t_1',
      );
    });

    it('无在线 worker → {agents: [], workerId: null, degraded: true}（不抛错）', async () => {
      workersService.assignWorker.mockResolvedValue(null);

      const result = await service.listOpencodeAgents({});

      expect(result).toEqual({ agents: [], workerId: null, degraded: true });
    });

    it('worker 返回空清单（旧版无 /agent 或降级）→ degraded=true', async () => {
      workersService.assignWorker.mockResolvedValue('w_1');
      workerClient.listAgents.mockResolvedValue([]);

      const result = await service.listOpencodeAgents({});

      expect(result).toEqual({ agents: [], workerId: 'w_1', degraded: true });
    });

    it('listAgents 抛错 → degraded=true（列表端点不阻断页面）', async () => {
      workersService.assignWorker.mockResolvedValue('w_1');
      workerClient.listAgents.mockRejectedValue(new Error('worker down'));

      const result = await service.listOpencodeAgents({});

      expect(result).toEqual({ agents: [], workerId: null, degraded: true });
    });

    it('assignWorker 抛错 → degraded=true（不冒泡到 HTTP 层）', async () => {
      workersService.assignWorker.mockRejectedValue(new Error('db down'));

      const result = await service.listOpencodeAgents({});

      expect(result.degraded).toBe(true);
      expect(result.agents).toEqual([]);
    });
  });

  describe('policyId 绑定（Todo 11：create/clone/update 持久化 + toAgentDto 返回）', () => {
    it('create：DTO 传 policyId → 落库 policyId，toAgentDto 返回', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockResolvedValue({
        ...customRow,
        policyId: 'ep_developer',
      });

      const dto: CreateAgentDto = {
        name: '策略分析师',
        type: 'custom',
        agentKey: 'policy-analyst',
        role: 'analyst',
        prompt: 'prompt-custom',
        policyId: 'ep_developer',
      };

      const result = await service.create('u_admin', dto);

      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ policyId: 'ep_developer' }),
        }),
      );
      expect(result).toMatchObject({ policyId: 'ep_developer' });
      // 显式绑定不建策略
      expect(prisma.executionPolicy.create).not.toHaveBeenCalled();
      expect(prisma.executionPolicy.findUnique).not.toHaveBeenCalled();
    });

    it('create：不传 policyId + 未知 role → 装配 deny-by-default 骨架 custom 策略并绑定', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          createdAt: new Date('2026-09-14T00:00:00Z'),
          updatedAt: new Date('2026-09-14T00:00:00Z'),
        }),
      );

      const result = await service.create('u_admin', {
        name: '无策略分析师',
        type: 'custom',
        agentKey: 'nopolicy-analyst',
      });

      expect(prisma.executionPolicy.create).toHaveBeenCalledTimes(1);
      const policyData = prisma.executionPolicy.create.mock.calls[0][0].data;
      expect(policyData).toMatchObject({
        name: '无策略分析师 策略',
        type: 'custom',
        description: null,
      });
      expect(policyData.config.permission).toEqual({
        edit: { '*': 'deny' },
        read: { '*': 'allow' },
        bash: 'deny',
        task: 'deny',
      });
      expect(policyData.config.tools).toEqual({});
      expect(policyData.config.correction.denyTemplate).toContain(
        'vteam_notify_agent',
      );
      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ policyId: policyData.id }),
        }),
      );
      expect(result).toMatchObject({ policyId: policyData.id });
    });

    it('clone：恒建新 custom 策略，不继承源 policyId（模板/自定义源均不共享可写策略）', async () => {
      const source = { ...templateRows[0], policyId: 'ep_product' };
      prisma.agent.findUnique.mockResolvedValue(source);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.executionPolicy.findUnique.mockResolvedValue({
        id: 'ep_product',
        name: '产品经理',
        description: '需求分析与原型设计',
        type: 'template',
        config: {
          permission: { edit: { '*': 'deny' } },
          correction: { scopeSummary: '需求' },
          tools: { vteam_group_post: 'allow' },
        },
      });
      prisma.agent.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          createdAt: new Date('2026-09-14T00:00:00Z'),
          updatedAt: new Date('2026-09-14T00:00:00Z'),
        }),
      );

      const result = await service.clone('u_admin', 'a_product', {
        agentKey: 'policy-copy',
      });

      const policyData = prisma.executionPolicy.create.mock.calls[0][0].data;
      expect(policyData.type).toBe('custom');
      expect(policyData.id).not.toBe('ep_product');
      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ policyId: policyData.id }),
        }),
      );
      expect(result).toMatchObject({ policyId: policyData.id });
    });

    it('update：DTO 传 policyId → 更新落库，toAgentDto 返回（custom 经 PATCH 改 policyId 生效）', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce(customRow)
        .mockResolvedValueOnce({
          ...customRow,
          policyId: 'ep_developer',
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      const dto: UpdateAgentDto = { policyId: 'ep_developer' };
      const result = await service.update('a_0000000005', dto);

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ policyId: 'ep_developer' }),
        }),
      );
      expect(result).toMatchObject({ policyId: 'ep_developer' });
    });

    it('update：不传 policyId → 不触碰原绑定', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce({ ...customRow, policyId: 'ep_developer' })
        .mockResolvedValueOnce({
          ...customRow,
          policyId: 'ep_developer',
          name: '仅改名',
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      const result = await service.update('a_0000000005', { name: '仅改名' });

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ policyId: expect.anything() }),
        }),
      );
      expect(result).toMatchObject({
        name: '仅改名',
        policyId: 'ep_developer',
      });
    });

    it('toAgentDto：findOne 返回 policyId（详情含策略绑定）', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        ...templateRows[0],
        policyId: 'ep_product',
      });

      const result = await service.findOne('a_product');

      expect(result).toMatchObject({ id: 'a_product', policyId: 'ep_product' });
    });

    it('toAgentDto：findOne 返回 effectivePermission（与 policyId 对应，未绑定 → null）', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        ...templateRows[0],
        policyId: 'ep_product',
      });

      const bound = await service.findOne('a_product');

      expect(bound.effectivePermission).toMatchObject({
        policyId: 'ep_product',
        policyName: 'ep_product-name',
        agentName: 'vteam-product',
        permission: { edit: 'allow' },
        correction: { scopeSummary: 'test' },
      });
      expect(bound.effectivePermission).toMatchObject({
        tools: ROLE_BOUNDARIES['vteam-product'].toolAllows,
      });
      expect(bound.effectivePermission?.bashDeny).toEqual([
        ...ROLE_BASH_DENY_PATTERNS,
      ]);
      expect(
        (bound.effectivePermission?.tools as Record<string, string>)[
          'vteam_group_post'
        ],
      ).toBe('allow');

      prisma.agent.findUnique.mockResolvedValue(customRow);

      const unbound = await service.findOne('a_0000000005');

      expect(unbound).toMatchObject({ policyId: null });
      expect(unbound.effectivePermission).toBeNull();
    });
  });

  describe('agentKey（custom/clone 必填 key + 分层 effectivePermission）', () => {
    it('create：有效 agentKey 原样持久化并经 toAgentDto 返回', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockResolvedValue({
        ...customRow,
        agentKey: 'data-analyst',
      });

      const result = await service.create('u_admin', {
        name: '数据分析师',
        type: 'custom',
        agentKey: 'data-analyst',
        role: 'analyst',
      });

      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ agentKey: 'data-analyst' }),
        }),
      );
      expect(result).toMatchObject({ agentKey: 'data-analyst' });
    });

    it('create：非法 agentKey → 400 AGENT_KEY_INVALID（不落库）', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));

      await expect(
        service.create('u_admin', {
          name: '数据分析师',
          type: 'custom',
          agentKey: 'Invalid_Key!',
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create('u_admin', {
          name: '数据分析师',
          type: 'custom',
          agentKey: 'Invalid_Key!',
        }),
      ).rejects.toMatchObject({
        response: { code: 'AGENT_KEY_INVALID' },
      });
      expect(prisma.agent.create).not.toHaveBeenCalled();
    });

    it('create：`vteam-` 前缀 agentKey → 400（防 `vteam-vteam-x`）', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));

      await expect(
        service.create('u_admin', {
          name: '数据分析师',
          type: 'custom',
          agentKey: 'vteam-demo',
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create('u_admin', {
          name: '数据分析师',
          type: 'custom',
          agentKey: 'vteam-demo',
        }),
      ).rejects.toMatchObject({
        response: { code: 'AGENT_KEY_INVALID' },
      });
      expect(prisma.agent.create).not.toHaveBeenCalled();
    });

    it('create：重复 agentKey → 409 AGENT_KEY_CONFLICT（非原生 Prisma 错误）', async () => {
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`agent_key`)',
          { code: 'P2002', clientVersion: 'test' },
        ),
      );

      await expect(
        service.create('u_admin', {
          name: '数据分析师',
          type: 'custom',
          agentKey: 'data-analyst',
        }),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.create('u_admin', {
          name: '数据分析师',
          type: 'custom',
          agentKey: 'data-analyst',
        }),
      ).rejects.toMatchObject({
        response: { code: 'AGENT_KEY_CONFLICT' },
      });
    });

    it('clone：使用新 agentKey（不复制源 key）；冲突 → 409', async () => {
      const source = { ...templateRows[0], agentKey: 'product' };
      prisma.agent.findUnique.mockResolvedValue(source);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.create.mockResolvedValue({
        ...source,
        id: 'a_0000000005',
        name: '产品经理副本',
        type: 'clone',
        agentKey: 'product-copy',
        baseAgentId: 'a_product',
      });

      const result = await service.clone('u_admin', 'a_product', {
        agentKey: 'product-copy',
      });

      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ agentKey: 'product-copy' }),
        }),
      );
      expect(result).toMatchObject({ agentKey: 'product-copy' });

      prisma.agent.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`agent_key`)',
          { code: 'P2002', clientVersion: 'test' },
        ),
      );

      await expect(
        service.clone('u_admin', 'a_product', {
          agentKey: 'product-copy',
        }),
      ).rejects.toMatchObject({
        response: { code: 'AGENT_KEY_CONFLICT' },
      });
    });

    it('update：显式传入 agentKey 时更新落库；不传不触碰', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce({ ...customRow, agentKey: 'old-key' })
        .mockResolvedValueOnce({
          ...customRow,
          agentKey: 'new-key',
          skills: [{ skillId: 's_skill1' }],
        });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.agent.update.mockResolvedValue(customRow);

      const result = await service.update('a_0000000005', {
        agentKey: 'new-key',
      });

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ agentKey: 'new-key' }),
        }),
      );
      expect(result).toMatchObject({ agentKey: 'new-key' });
    });

    it('toAgentDto：返回 agentKey，自定义 agent 按 key 解析 agentName 与三态 tools', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        ...customRow,
        agentKey: 'demo-agent',
        role: 'analyst',
        policyId: 'ep_demo',
        skills: [],
      });
      executionPolicyService.resolveManyByAgents.mockResolvedValueOnce([
        {
          policyId: 'ep_demo',
          policyName: 'demo 策略',
          agentName: 'vteam-demo-agent',
          permission: { edit: 'allow' },
          tools: {
            vteam_group_post: 'allow',
            vteam_read_file: 'ask',
            git_push: 'deny',
          },
          bashDeny: [...ROLE_BASH_DENY_PATTERNS],
          correction: { scopeSummary: 'demo' },
        },
      ]);

      const result = await service.findOne('a_0000000005');

      expect(executionPolicyService.resolveManyByAgents).toHaveBeenCalledWith([
        { policyId: 'ep_demo', role: 'analyst', agentKey: 'demo-agent' },
      ]);
      expect(result).toMatchObject({ agentKey: 'demo-agent' });
      expect(result.effectivePermission).toMatchObject({
        agentName: 'vteam-demo-agent',
        tools: {
          vteam_group_post: 'allow',
          vteam_read_file: 'ask',
          git_push: 'deny',
        },
      });
    });
  });

  describe('策略装配（clone/create 恒建可编辑 custom 策略）', () => {
    const stamp = {
      createdAt: new Date('2026-09-14T00:00:00Z'),
      updatedAt: new Date('2026-09-14T00:00:00Z'),
    };

    function echoAgentCreate() {
      prisma.agent.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          ...stamp,
        }),
      );
    }

    function realPolicyService(rows: unknown[]) {
      return new ExecutionPolicyService(
        {
          executionPolicy: { findMany: jest.fn().mockResolvedValue(rows) },
        } as never,
        {} as never,
      );
    }

    /**
     * ep_<role> 出厂 config：复算 seed.ts:906-920 的同一构造式，值源 `ROLE_BOUNDARIES`
     * （src 单一事实来源；seed.ts 顶部镜像经 `src/prisma/seed.spec.ts` 逐项断言同步）。
     * 测试据此派生期望值而非抄写字面量——实现/seed 若漂移，本测试随源一起变，
     * 不会退化成实现输出的镜像。
     */
    function seedRolePolicyConfig(agentName: keyof typeof ROLE_BOUNDARIES) {
      const boundary = ROLE_BOUNDARIES[agentName];
      return {
        permission: {
          edit: buildEditPermission(boundary.writeGlobs),
          read: buildReadPermission(),
          bash: boundary.bashEffect,
          // 与 seed.ts:900-905 一致：仅 vteam-plan 放行 task。
          task: agentName === 'vteam-plan' ? 'allow' : 'deny',
          ...Object.fromEntries(
            boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
          ),
        },
        correction: {
          scopeSummary: boundary.scopeSummary,
          handoff: { ...boundary.handoffTo },
          denyTemplate: ROLE_POLICY_DENY_TEMPLATE,
        },
        tools: { ...boundary.toolAllows },
      };
    }

    it('create role=developer 命中库内 ep_developer：装配策略的 permission/tools 逐字段等于该 config（角色继承真实生效，非骨架）', async () => {
      const epDeveloperConfig = seedRolePolicyConfig('vteam-developer');
      expect(Object.keys(epDeveloperConfig.tools).length).toBeGreaterThan(0);
      prisma.executionPolicy.findUnique.mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          where.id === 'ep_developer'
            ? {
                id: 'ep_developer',
                name: '开发者',
                description: ROLE_BOUNDARIES['vteam-developer'].scopeSummary,
                type: 'template',
                config: epDeveloperConfig,
                ...stamp,
              }
            : null,
      );
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      echoAgentCreate();

      await service.create('u_admin', {
        name: '外包开发者',
        type: 'custom',
        agentKey: 'role-inherit-dev',
        role: 'developer',
      });

      expect(prisma.executionPolicy.findUnique).toHaveBeenCalledWith({
        where: { id: 'ep_developer' },
      });
      const policyData = prisma.executionPolicy.create.mock.calls[0][0].data;
      expect(policyData.config.permission).toEqual(epDeveloperConfig.permission);
      expect(policyData.config.tools).toEqual(epDeveloperConfig.tools);
      expect(policyData.config.tools).toEqual(
        ROLE_BOUNDARIES['vteam-developer'].toolAllows,
      );
      expect(policyData.config.tools).not.toEqual({});
      expect(policyData.config.permission.bash).toBe('allow');
      expect(policyData.type).toBe('custom');
      expect(policyData.id).not.toBe('ep_developer');
    });

    it('create 无 role：不查模板行、绑定 deny 骨架（角色继承的阴性对照，保证上例非偶然通过）', async () => {
      prisma.executionPolicy.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      echoAgentCreate();

      await service.create('u_admin', {
        name: '无角色分析师',
        type: 'custom',
        agentKey: 'role-less-analyst',
      });

      expect(prisma.executionPolicy.findUnique).not.toHaveBeenCalled();
      const policyData = prisma.executionPolicy.create.mock.calls[0][0].data;
      expect(policyData.config.permission).toEqual({
        edit: { '*': 'deny' },
        read: { '*': 'allow' },
        bash: 'deny',
        task: 'deny',
      });
      expect(policyData.config.tools).toEqual({});
      expect(policyData.type).toBe('custom');
    });

    it('clone 模板策略 agent：新 custom 策略 id 不同、tools 非空、真实 resolve 透出非空 tools', async () => {
      const templatePolicyRow = {
        id: 'ep_product',
        name: '产品经理',
        description: '需求分析与原型设计',
        type: 'template',
        config: {
          permission: {
            edit: { '*': 'deny' },
            read: { '*': 'allow' },
            bash: 'deny',
            task: 'deny',
          },
          correction: { scopeSummary: '需求分析与原型设计', handoff: {} },
          tools: { vteam_group_post: 'allow', vteam_task_context: 'allow' },
        },
        ...stamp,
      };
      prisma.agent.findUnique.mockResolvedValue({
        ...templateRows[0],
        agentKey: 'product',
      });
      prisma.executionPolicy.findUnique.mockResolvedValue(templatePolicyRow);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      echoAgentCreate();

      const result = await service.clone('u_admin', 'a_product', {
        agentKey: 'qa-clone-1',
      });

      const policyData = prisma.executionPolicy.create.mock.calls[0][0].data;
      expect(policyData.id).not.toBe('ep_product');
      expect(policyData.type).toBe('custom');
      expect(policyData.name).toBe('产品经理副本 策略');
      expect(policyData.description).toBe('需求分析与原型设计');
      expect(policyData.config.tools).toEqual({
        vteam_group_post: 'allow',
        vteam_task_context: 'allow',
      });
      expect(policyData.config).not.toBe(templatePolicyRow.config);
      expect(result).toMatchObject({ policyId: policyData.id });

      const [resolved] = await realPolicyService([
        { ...templatePolicyRow, id: policyData.id, type: 'custom' },
      ]).resolveManyByAgents([
        { policyId: policyData.id, agentKey: 'qa-clone-1' },
      ]);
      expect(resolved?.agentName).toBe('vteam-qa-clone-1');
      expect(resolved?.tools).toEqual({
        vteam_group_post: 'allow',
        vteam_task_context: 'allow',
      });
    });

    it('clone 自定义策略 agent：新策略与源相互独立（改一不影响另一）', async () => {
      const sourceConfig = {
        permission: { edit: { '*': 'deny' } },
        correction: { scopeSummary: 'custom' },
        tools: { vteam_group_post: 'allow' },
      };
      prisma.agent.findUnique.mockResolvedValue({
        ...customRow,
        id: 'a_0000000007',
        agentKey: 'qa-demo',
        role: null,
        policyId: 'ep_0000000007',
      });
      prisma.executionPolicy.findUnique.mockResolvedValue({
        id: 'ep_0000000007',
        name: 'QA Demo 策略',
        description: null,
        type: 'custom',
        config: sourceConfig,
        ...stamp,
      });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      echoAgentCreate();

      const result = await service.clone('u_admin', 'a_0000000007', {
        agentKey: 'qa-demo-copy',
      });

      const policyData = prisma.executionPolicy.create.mock.calls[0][0].data;
      expect(policyData.id).not.toBe('ep_0000000007');
      expect(policyData.type).toBe('custom');
      expect(policyData.config).toEqual(sourceConfig);
      expect(policyData.config).not.toBe(sourceConfig);
      expect(policyData.config.tools).not.toBe(sourceConfig.tools);
      (policyData.config.tools as Record<string, string>).vteam_group_post =
        'deny';
      (policyData.config.tools as Record<string, string>).vteam_extra = 'allow';
      expect(sourceConfig.tools).toEqual({ vteam_group_post: 'allow' });
      expect(result).toMatchObject({ policyId: policyData.id });
    });

    it('create 有 role 无 policyId：深拷贝模板策略为新 custom 策略并绑定', async () => {
      prisma.executionPolicy.findUnique.mockResolvedValue({
        id: 'ep_developer',
        name: '开发者',
        description: '编码与实现说明',
        type: 'template',
        config: {
          permission: { edit: { '*': 'deny' } },
          correction: { scopeSummary: '编码' },
          tools: { ...ROLE_BOUNDARIES['vteam-developer'].toolAllows },
        },
        ...stamp,
      });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      echoAgentCreate();

      const result = await service.create('u_admin', {
        name: '外包开发者',
        type: 'custom',
        agentKey: 'outsourced-dev',
        role: 'developer',
      });

      expect(prisma.executionPolicy.findUnique).toHaveBeenCalledWith({
        where: { id: 'ep_developer' },
      });
      const policyData = prisma.executionPolicy.create.mock.calls[0][0].data;
      expect(policyData.type).toBe('custom');
      expect(policyData.id).not.toBe('ep_developer');
      expect(policyData.name).toBe('外包开发者 策略');
      expect(policyData.config.tools).toEqual(
        ROLE_BOUNDARIES['vteam-developer'].toolAllows,
      );
      expect(result).toMatchObject({ policyId: policyData.id });
    });

    it('create 有内置 role + 库内无 ep_<role> 行：回退常量派生（tools 非空）、策略 id 为自有 custom id', async () => {
      prisma.executionPolicy.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      echoAgentCreate();

      const result = await service.create('u_admin', {
        name: '外包开发者',
        type: 'custom',
        agentKey: 'outsourced-dev-fallback',
        role: 'developer',
      });

      const policyData = prisma.executionPolicy.create.mock.calls[0][0].data;
      expect(policyData.type).toBe('custom');
      expect(policyData.id).not.toBe('ep_developer');
      expect(policyData.config.tools).toEqual(
        ROLE_BOUNDARIES['vteam-developer'].toolAllows,
      );
      expect(Object.keys(policyData.config.tools).length).toBeGreaterThan(0);
      expect(policyData.description).toBe(
        ROLE_BOUNDARIES['vteam-developer'].scopeSummary,
      );
      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ policyId: policyData.id }),
        }),
      );
      expect(result).toMatchObject({ policyId: policyData.id });
    });
  });
});
