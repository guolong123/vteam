import { Test, TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH } from '../common/constants/agent-role.constants';
import { PermissionGuard } from '../common/guards/permission.guard';
import { REQUIRE_PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { AgentRolesController } from './agent-roles.controller';
import { AgentRolesService } from './agent-roles.service';
import { CreateAgentRoleDto } from './dto/create-agent-role.dto';
import { QueryAgentRolesDto } from './dto/query-agent-roles.dto';
import { UpdateAgentRoleDto } from './dto/update-agent-role.dto';

describe('AgentRolesController', () => {
  let controller: AgentRolesController;
  let service: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  const now = new Date('2026-09-19T00:00:00Z');
  const builtinRow = {
    id: 'ar_product',
    key: 'product',
    name: '产品经理',
    description: null,
    type: 'builtin',
    defaultAgentId: 'a_product',
    rolePrompt: '你是产品经理。',
    sortOrder: 1,
    createdAt: now,
    updatedAt: now,
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentRolesController],
      providers: [{ provide: AgentRolesService, useValue: service }],
    })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AgentRolesController>(AgentRolesController);
  });

  it('GET /agent-roles 透传查询参数（{items,total,page,pageSize}）', async () => {
    service.findAll.mockResolvedValue({
      items: [builtinRow],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const query: QueryAgentRolesDto = { type: 'builtin', page: 1, pageSize: 20 };
    const result = await controller.findAll(query);

    expect(service.findAll).toHaveBeenCalledWith(query);
    expect(result).toMatchObject({ items: [builtinRow], total: 1 });
  });

  it('GET /agent-roles/:id 转发 findOne 返回详情', async () => {
    service.findOne.mockResolvedValue(builtinRow);

    const result = await controller.findOne('ar_product');

    expect(service.findOne).toHaveBeenCalledWith('ar_product');
    expect(result).toMatchObject({ id: 'ar_product', defaultAgentId: 'a_product' });
  });

  it('POST /agent-roles 转发 create', async () => {
    const dto: CreateAgentRoleDto = {
      name: '数据分析师',
      key: 'data-analyst',
      type: 'custom',
    };
    service.create.mockResolvedValue({ id: 'ar_0000000001', ...dto });

    const result = await controller.create(dto);

    expect(service.create).toHaveBeenCalledWith(dto);
    expect(result).toMatchObject({ id: 'ar_0000000001' });
  });

  it('PATCH /agent-roles/:id 转发 update', async () => {
    const dto: UpdateAgentRoleDto = { rolePrompt: '新指令' };
    service.update.mockResolvedValue({ id: 'ar_product', rolePrompt: '新指令' });

    const result = await controller.update('ar_product', dto);

    expect(service.update).toHaveBeenCalledWith('ar_product', dto);
    expect(result).toMatchObject({ rolePrompt: '新指令' });
  });

  it('DELETE /agent-roles/:id 转发 remove（内置 403 由 service 抛、控制器透传）', async () => {
    service.remove.mockResolvedValue(undefined);

    await controller.remove('ar_product');

    expect(service.remove).toHaveBeenCalledWith('ar_product');
  });

  describe('权限点复用（不新造）', () => {
    it('读取（GET / + GET /:id）挂 agents.view', () => {
      expect(
        Reflect.getMetadata(REQUIRE_PERMISSION_KEY, controller.findAll),
      ).toBe('agents.view');
      expect(
        Reflect.getMetadata(REQUIRE_PERMISSION_KEY, controller.findOne),
      ).toBe('agents.view');
    });

    it('创建挂 agents.create，更新挂 agents.edit，删除挂 agents.delete', () => {
      expect(
        Reflect.getMetadata(REQUIRE_PERMISSION_KEY, controller.create),
      ).toBe('agents.create');
      expect(
        Reflect.getMetadata(REQUIRE_PERMISSION_KEY, controller.update),
      ).toBe('agents.edit');
      expect(
        Reflect.getMetadata(REQUIRE_PERMISSION_KEY, controller.remove),
      ).toBe('agents.delete');
    });
  });

  describe('DTO 校验（class-validator）', () => {
    const errorsOf = async (cls: new () => object, obj: object) =>
      validate(plainToInstance(cls, obj));

    it('CreateAgentRoleDto：name 空串 → 校验失败', async () => {
      expect(
        await errorsOf(CreateAgentRoleDto, {
          name: '',
          key: 'data-analyst',
          type: 'custom',
        }),
      ).not.toHaveLength(0);
    });

    it('CreateAgentRoleDto：非法 key → 校验失败（大小写/符号越界）', async () => {
      expect(
        await errorsOf(CreateAgentRoleDto, {
          name: '数据分析师',
          key: 'Invalid_Key!',
          type: 'custom',
        }),
      ).not.toHaveLength(0);
    });

    it('CreateAgentRoleDto：合法 name/key/type=custom → 校验通过', async () => {
      expect(
        await errorsOf(CreateAgentRoleDto, {
          name: '数据分析师',
          key: 'data-analyst',
          type: 'custom',
          defaultAgentId: 'a_developer',
          rolePrompt: '你是数据分析师。',
        }),
      ).toHaveLength(0);
    });

    it('CreateAgentRoleDto：type=builtin → 校验失败（POST 仅 custom）', async () => {
      expect(
        await errorsOf(CreateAgentRoleDto, {
          name: '伪内置',
          key: 'fake-builtin',
          type: 'builtin',
        }),
      ).not.toHaveLength(0);
    });

    it('UpdateAgentRoleDto：不传字段 → 校验通过（全可选）', async () => {
      expect(await errorsOf(UpdateAgentRoleDto, {})).toHaveLength(0);
    });

    it('UpdateAgentRoleDto：rolePrompt 可编辑文本 → 校验通过', async () => {
      expect(
        await errorsOf(UpdateAgentRoleDto, { rolePrompt: '新的岗位说明' }),
      ).toHaveLength(0);
    });

    it('UpdateAgentRoleDto：显式空串 name → 校验失败（@IsNotEmpty）', async () => {
      expect(await errorsOf(UpdateAgentRoleDto, { name: '' })).not.toHaveLength(
        0,
      );
    });

    it('UpdateAgentRoleDto：defaultAgentId=null → 校验通过（显式清除）', async () => {
      expect(
        await errorsOf(UpdateAgentRoleDto, { defaultAgentId: null }),
      ).toHaveLength(0);
    });

    it('CreateAgentRoleDto：policyId 可选（字符串/null 均通过；存在性校验在 service 层）', async () => {
      expect(
        await errorsOf(CreateAgentRoleDto, {
          name: '数据分析师',
          key: 'data-analyst',
          type: 'custom',
          policyId: 'ep_developer',
        }),
      ).toHaveLength(0);
      expect(
        await errorsOf(UpdateAgentRoleDto, { policyId: null }),
      ).toHaveLength(0);
    });

    it('CreateAgentRoleDto：外部引擎名（含空格/大写）→ 校验通过', async () => {
      expect(
        await errorsOf(CreateAgentRoleDto, {
          name: '计划构建者',
          key: 'plan-builder',
          type: 'custom',
          defaultOpencodeAgentName: 'Prometheus - Plan Builder',
        }),
      ).toHaveLength(0);
    });

    it('UpdateAgentRoleDto：外部引擎名与 null 均可（显式清除）', async () => {
      expect(
        await errorsOf(UpdateAgentRoleDto, {
          defaultOpencodeAgentName: 'Prometheus - Plan Builder',
        }),
      ).toHaveLength(0);
      expect(
        await errorsOf(UpdateAgentRoleDto, { defaultOpencodeAgentName: null }),
      ).toHaveLength(0);
    });

    it('外部引擎名超长（>128）→ 校验失败；恰为 128 → 通过', async () => {
      const max = AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH;
      expect(
        await errorsOf(CreateAgentRoleDto, {
          name: '超长名',
          key: 'too-long',
          type: 'custom',
          defaultOpencodeAgentName: 'x'.repeat(max + 1),
        }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(CreateAgentRoleDto, {
          name: '上限名',
          key: 'at-limit',
          type: 'custom',
          defaultOpencodeAgentName: 'x'.repeat(max),
        }),
      ).toHaveLength(0);
    });

    it('两槽位同时给 → DTO 层不拦截（互斥是 service 层 400，DTO 无跨字段 @ValidateIf）', async () => {
      expect(
        await errorsOf(CreateAgentRoleDto, {
          name: '冲突角色',
          key: 'conflict-role',
          type: 'custom',
          defaultAgentId: 'a_developer',
          defaultOpencodeAgentName: 'Prometheus - Plan Builder',
        }),
      ).toHaveLength(0);
    });
  });
});
