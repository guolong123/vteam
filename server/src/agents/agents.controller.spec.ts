import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { CloneAgentDto } from './dto/clone-agent.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import { QueryAgentsDto } from './dto/query-agents.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

describe('AgentsController', () => {
  let controller: AgentsController;
  let service: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    clone: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    getAvailableModels: jest.Mock;
    listOpencodeAgents: jest.Mock;
    getOmoConfig: jest.Mock;
    setOmoConfig: jest.Mock;
    getOmoAgentPrompt: jest.Mock;
  };

  const user = { id: 'u_admin', username: 'admin', roleId: 'r_admin' };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      clone: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      getAvailableModels: jest.fn(),
      listOpencodeAgents: jest.fn(),
      getOmoConfig: jest.fn(),
      setOmoConfig: jest.fn(),
      getOmoAgentPrompt: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [
        { provide: AgentsService, useValue: service },
        // 方法级 @UseGuards(PermissionGuard) 会在 compile 时实例化 guard，
        // PermissionGuard 依赖全局 PrismaService，提供 mock 占位
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
        },
      ],
    }).compile();

    controller = module.get<AgentsController>(AgentsController);
  });

  it('GET /agents 透传查询参数（{items, total, page, pageSize}）', async () => {
    const items = [
      {
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        type: 'template',
        prompt: 'p',
        baseAgentId: null,
        defaultModelId: null,
        policyId: 'ep_product',
        skillIds: [],
        effectivePermission: null,
      },
    ];
    service.findAll.mockResolvedValue({
      items,
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const query: QueryAgentsDto = { type: 'template', page: 1, pageSize: 20 };
    const result = await controller.findAll(query);

    expect(service.findAll).toHaveBeenCalledWith(query);
    expect(result).toMatchObject({ items, total: 1, page: 1, pageSize: 20 });
  });

  it('GET /agents/:id 转发 findOne 返回详情', async () => {
    const detail = { id: 'a_product', name: '产品经理' };
    service.findOne.mockResolvedValue(detail);

    const result = await controller.findOne('a_product');

    expect(service.findOne).toHaveBeenCalledWith('a_product');
    expect(result).toMatchObject(detail);
  });

  it('POST /agents 以 req.user.id 转发 create', async () => {
    const dto: CreateAgentDto = {
      name: '数据分析师',
      type: 'custom',
      agentKey: 'data-analyst',
    };
    service.create.mockResolvedValue({
      id: 'a_0000000005',
      name: '数据分析师',
    });

    const result = await controller.create(user as never, dto);

    expect(service.create).toHaveBeenCalledWith('u_admin', dto);
    expect(result).toMatchObject({ id: 'a_0000000005' });
  });

  it('POST /agents/:id/clone 以 req.user.id 转发 clone', async () => {
    const dto: CloneAgentDto = { name: '副本', agentKey: 'copy-agent' };
    service.clone.mockResolvedValue({
      id: 'a_0000000005',
      name: '副本',
      type: 'clone',
      baseAgentId: 'a_product',
    });

    const result = await controller.clone(user as never, 'a_product', dto);

    expect(service.clone).toHaveBeenCalledWith('u_admin', 'a_product', dto);
    expect(result).toMatchObject({ type: 'clone', baseAgentId: 'a_product' });
  });

  it('PATCH /agents/:id 转发 update', async () => {
    const dto: UpdateAgentDto = { prompt: 'new' };
    service.update.mockResolvedValue({ id: 'a_0000000005', prompt: 'new' });

    const result = await controller.update('a_0000000005', dto);

    expect(service.update).toHaveBeenCalledWith('a_0000000005', dto);
    expect(result).toMatchObject({ prompt: 'new' });
  });

  it('DELETE /agents/:id 转发 remove', async () => {
    service.remove.mockResolvedValue(undefined);

    await controller.remove('a_0000000005');

    expect(service.remove).toHaveBeenCalledWith('a_0000000005');
  });

  it('GET /agents/:id/available-models 转发 getAvailableModels', async () => {
    service.getAvailableModels.mockResolvedValue([
      { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ]);

    const result = await controller.getAvailableModels('a_product');

    expect(service.getAvailableModels).toHaveBeenCalledWith('a_product');
    expect(result).toHaveLength(1);
  });

  it('GET /agents/opencode 转发 listOpencodeAgents（workerId/directory 透传）', async () => {
    service.listOpencodeAgents.mockResolvedValue({
      agents: [{ name: 'plan', mode: 'primary', native: true }],
      workerId: 'w_1',
      degraded: false,
    });

    const result = await controller.listOpencodeAgents(
      'w_1',
      '/data/vteam-worker/tasks/t_1',
    );

    expect(service.listOpencodeAgents).toHaveBeenCalledWith({
      workerId: 'w_1',
      directory: '/data/vteam-worker/tasks/t_1',
    });
    expect(result.agents[0].name).toBe('plan');
  });

  it('GET /agents/opencode 无参数 → service 收到 undefined（由 service 选 worker）', async () => {
    service.listOpencodeAgents.mockResolvedValue({
      agents: [],
      workerId: null,
      degraded: true,
    });

    await controller.listOpencodeAgents(undefined, undefined);

    expect(service.listOpencodeAgents).toHaveBeenCalledWith({
      workerId: undefined,
      directory: undefined,
    });
  });

  /**
   * 路由顺序回归（关键）：`GET /agents/opencode` 必须早于 `GET /agents/:id` 声明，
   * 否则 Nest 按声明顺序匹配会把 "opencode" 当作 :id 吞掉（落到 findOne → 404）。
   * 直接断言装饰器元数据里的路由声明顺序，防止后续重构把静态路由挪到 :id 之后。
   */
  it('路由顺序：opencode 静态路由声明早于 :id 通配路由', () => {
    const path = require('path');
    const src = require('fs').readFileSync(
      path.join(__dirname, 'agents.controller.ts'),
      'utf8',
    );
    // 用行首锚定（^\s*@Get(...)）避免匹配到注释里提到的路由文本
    const opencodeIdx = src.search(/^\s*@Get\('opencode'\)/m);
    const idIdx = src.search(/^\s*@Get\(':id'\)/m);
    expect(opencodeIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeGreaterThan(-1);
    expect(opencodeIdx).toBeLessThan(idIdx);
  });

  it('路由顺序：omo-config 的 GET/PATCH 均早于对应 :id（回归：PATCH 曾被 :id 吞成 404）', () => {
    const path = require('path');
    const src = require('fs').readFileSync(
      path.join(__dirname, 'agents.controller.ts'),
      'utf8',
    );
    const getOmo = src.search(/^\s*@Get\('omo-config'\)/m);
    const getById = src.search(/^\s*@Get\(':id'\)/m);
    expect(getOmo).toBeGreaterThan(-1);
    expect(getOmo).toBeLessThan(getById);

    // PATCH 同样必须在前：@Patch(':id') 更早时 PATCH /agents/omo-config 会被当作
    // id="omo-config" 落到 update() → 404 AGENT_NOT_FOUND（实测踩坑）
    const patchOmo = src.search(/^\s*@Patch\('omo-config'\)/m);
    const patchById = src.search(/^\s*@Patch\(':id'\)/m);
    expect(patchOmo).toBeGreaterThan(-1);
    expect(patchById).toBeGreaterThan(-1);
    expect(patchOmo).toBeLessThan(patchById);

    // omo-agent-prompt 同样必须早于 :id（否则被当作 id=omo-agent-prompt → 404）
    const promptOmo = src.search(/^\s*@Get\('omo-agent-prompt'\)/m);
    expect(promptOmo).toBeGreaterThan(-1);
    expect(promptOmo).toBeLessThan(getById);
  });

  it('GET /agents/omo-agent-prompt 透传 name + workerId', async () => {
    service.getOmoAgentPrompt.mockResolvedValue({
      name: 'Prometheus - Plan Builder',
      description: 'Plan agent',
      prompt: 'You are Prometheus…',
      empty: false,
    });

    const result = await controller.getOmoAgentPrompt('prometheus', 'w_1');

    expect(service.getOmoAgentPrompt).toHaveBeenCalledWith('prometheus', {
      workerId: 'w_1',
    });
    expect(result.prompt).toContain('Prometheus');
  });

  it('GET /agents/omo-config 转发 workerId 到 service', async () => {
    service.getOmoConfig.mockResolvedValue({
      agents: { sisyphus: 'opencode/big-pickle' },
      available: ['sisyphus'],
      workerId: 'w_1',
      degraded: false,
    });

    const result = await controller.getOmoConfig('w_1');

    expect(service.getOmoConfig).toHaveBeenCalledWith({ workerId: 'w_1' });
    expect(result.agents).toEqual({ sisyphus: 'opencode/big-pickle' });
  });

  it('PATCH /agents/omo-config 只把 agents 透传（workerId 走 query）', async () => {
    service.setOmoConfig.mockResolvedValue({
      written: '/p',
      agents: { sisyphus: 'a/b' },
      workerId: 'w_1',
    });

    const result = await controller.setOmoConfig(
      { agents: { sisyphus: 'a/b' } } as never,
      'w_1',
    );

    expect(service.setOmoConfig).toHaveBeenCalledWith(
      { sisyphus: 'a/b' },
      { workerId: 'w_1' },
    );
    expect(result.workerId).toBe('w_1');
  });

  describe('DTO 校验（class-validator，QA ISSUE-009 空名）', () => {
    const errorsOf = async (cls: new () => object, obj: object) =>
      validate(plainToInstance(cls, obj));

    /**
     * 全局 ValidationPipe 形状（src/main.ts：whitelist:true）：
     * 未声明字段被**静默剥离**。todo 4 的缺陷防线——若前端仍投 `role`，
     * DTO 已无该字段 → 到不了 service → 每个新 agent 静默落骨架。
     */
    const whitelistPipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    });

    it('CreateAgentDto：agentRoleId 是已知字段，经 whitelist 管道保留', async () => {
      const out = (await whitelistPipe.transform(
        {
          name: '开发者',
          type: 'custom',
          agentKey: 'dev-agent',
          agentRoleId: 'ar_developer',
        },
        { type: 'body', metatype: CreateAgentDto },
      )) as CreateAgentDto;

      expect(out.agentRoleId).toBe('ar_developer');
    });

    it('CreateAgentDto：陈旧 `role` 字段被 whitelist 管道静默剥离（能力不得经旧列传递）', async () => {
      const out = (await whitelistPipe.transform(
        {
          name: '开发者',
          type: 'custom',
          agentKey: 'dev-agent',
          agentRoleId: 'ar_developer',
          role: 'developer',
        },
        { type: 'body', metatype: CreateAgentDto },
      )) as CreateAgentDto & { role?: string };

      expect(out.role).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(out, 'role')).toBe(false);
      expect(out.agentRoleId).toBe('ar_developer');
    });

    it('CloneAgentDto：agentRoleId 保留；陈旧 role 剥离', async () => {
      const out = (await whitelistPipe.transform(
        {
          agentKey: 'copy-agent',
          agentRoleId: 'ar_developer',
          role: 'developer',
        },
        { type: 'body', metatype: CloneAgentDto },
      )) as CloneAgentDto & { role?: string };

      expect(out.agentRoleId).toBe('ar_developer');
      expect(out.role).toBeUndefined();
    });

    it('UpdateAgentDto：陈旧 role 剥离（改名/改标签不得经 DTO 夹带能力字段）', async () => {
      const out = (await whitelistPipe.transform(
        { name: '仅改名', role: 'developer', policyId: 'ep_developer' },
        { type: 'body', metatype: UpdateAgentDto },
      )) as UpdateAgentDto & { role?: string };

      expect(out.role).toBeUndefined();
      expect(out.policyId).toBe('ep_developer');
    });

    it('CreateAgentDto：name 空串 → 校验失败（@IsNotEmpty，空名 400 非 201）', async () => {
      expect(
        await errorsOf(CreateAgentDto, { name: '', type: 'custom' }),
      ).not.toHaveLength(0);
    });

    it('CreateAgentDto：name 缺失 → 校验失败', async () => {
      expect(
        await errorsOf(CreateAgentDto, { type: 'custom' }),
      ).not.toHaveLength(0);
    });

    it('CreateAgentDto：合法 name + agentKey → 校验通过', async () => {
      expect(
        await errorsOf(CreateAgentDto, {
          name: '数据分析师',
          type: 'custom',
          agentKey: 'data-analyst',
        }),
      ).toHaveLength(0);
    });

    it('CreateAgentDto：缺失 agentKey → 校验失败（custom 必填 key）', async () => {
      expect(
        await errorsOf(CreateAgentDto, { name: '数据分析师', type: 'custom' }),
      ).not.toHaveLength(0);
    });

    it('CreateAgentDto：非法 agentKey → 校验失败（大小写/符号越界）', async () => {
      expect(
        await errorsOf(CreateAgentDto, {
          name: '数据分析师',
          type: 'custom',
          agentKey: 'Invalid_Key!',
        }),
      ).not.toHaveLength(0);
    });

    it('CreateAgentDto：`vteam-` 前缀 agentKey → 校验失败（防 `vteam-vteam-x`）', async () => {
      expect(
        await errorsOf(CreateAgentDto, {
          name: '数据分析师',
          type: 'custom',
          agentKey: 'vteam-demo',
        }),
      ).not.toHaveLength(0);
    });

    it('UpdateAgentDto：显式传空串 name → 校验失败（@IsNotEmpty）', async () => {
      expect(await errorsOf(UpdateAgentDto, { name: '' })).not.toHaveLength(0);
    });

    it('UpdateAgentDto：不传 name → 校验通过（@IsOptional 保持可选）', async () => {
      expect(await errorsOf(UpdateAgentDto, { prompt: 'x' })).toHaveLength(0);
    });

    it('CloneAgentDto：显式传空串 name → 校验失败（@IsNotEmpty）', async () => {
      expect(await errorsOf(CloneAgentDto, { name: '' })).not.toHaveLength(0);
    });

    it('CloneAgentDto：不传 name 但传合法 agentKey → 校验通过（缺省源名称+副本）', async () => {
      expect(
        await errorsOf(CloneAgentDto, { agentKey: 'copy-agent' }),
      ).toHaveLength(0);
    });

    it('CloneAgentDto：缺失 agentKey → 校验失败（克隆须分配新 key）', async () => {
      expect(await errorsOf(CloneAgentDto, {})).not.toHaveLength(0);
    });

    it('UpdateAgentDto：合法 agentKey → 校验通过（显式传入时更新）', async () => {
      expect(
        await errorsOf(UpdateAgentDto, { agentKey: 'new-key' }),
      ).toHaveLength(0);
    });

    it('UpdateAgentDto：非法 agentKey → 校验失败', async () => {
      expect(
        await errorsOf(UpdateAgentDto, { agentKey: 'vteam-demo' }),
      ).not.toHaveLength(0);
    });
  });
});
