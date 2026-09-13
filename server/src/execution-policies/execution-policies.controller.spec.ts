import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PermissionGuard } from '../common/guards/permission.guard';
import { ExecutionPoliciesController } from './execution-policies.controller';
import { ExecutionPolicyService } from './execution-policy.service';

/**
 * ExecutionPoliciesController 单测（Todo 11 证据）：
 * 薄控制器——只断言路由层委托 service + 透传结果/错误语义：
 * - CRUD 委托（findAll/findOne/create/update/remove 参数透传）；
 * - template 写 → 403 POLICY_TEMPLATE_READONLY（service 抛，控制器透传）；
 * - 非法 config → 400 POLICY_CONFIG_INVALID（service 抛，控制器透传）；
 * - 不存在 → 404 POLICY_NOT_FOUND。
 * service 本体逻辑（glob/校验/403/400 判定）由 service 单测覆盖。
 */
describe('ExecutionPoliciesController', () => {
  let controller: ExecutionPoliciesController;
  let service: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  const customRow = {
    id: 'ep_0000000001',
    name: '自定义策略',
    description: null,
    type: 'custom',
    config: {
      permission: { edit: { '*': 'deny' }, task: 'deny' },
      correction: { scopeSummary: 'scope', handoff: {}, denyTemplate: 't' },
    },
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };

  const validConfig = {
    permission: { edit: { '*': 'deny' }, task: 'deny' },
    correction: { scopeSummary: 'scope' },
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
      controllers: [ExecutionPoliciesController],
      providers: [{ provide: ExecutionPolicyService, useValue: service }],
    })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<ExecutionPoliciesController>(
      ExecutionPoliciesController,
    );
  });

  it('GET /execution-policies：query 透传 + 返回 {items,total,page,pageSize}', async () => {
    service.findAll.mockResolvedValue({
      items: [customRow],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    const result = await controller.findAll({ type: 'custom' });
    expect(service.findAll).toHaveBeenCalledWith({ type: 'custom' });
    expect(result.total).toBe(1);
  });

  it('GET /execution-policies/:id：id 透传 + 返回策略行', async () => {
    service.findOne.mockResolvedValue(customRow);
    const result = await controller.findOne('ep_0000000001');
    expect(service.findOne).toHaveBeenCalledWith('ep_0000000001');
    expect(result).toMatchObject({ id: 'ep_0000000001', type: 'custom' });
  });

  it('GET /execution-policies/:id 不存在 → 404 POLICY_NOT_FOUND 透传', async () => {
    service.findOne.mockRejectedValue(
      new NotFoundException({
        code: 'POLICY_NOT_FOUND',
        message: 'ExecutionPolicy ep_missing 不存在',
      }),
    );
    await expect(controller.findOne('ep_missing')).rejects.toMatchObject({
      response: { code: 'POLICY_NOT_FOUND' },
    });
  });

  it('POST /execution-policies：DTO 透传 + 返回创建行', async () => {
    service.create.mockResolvedValue(customRow);
    const dto = { name: '自定义策略', type: 'custom' as const, config: validConfig };
    const result = await controller.create(dto);
    expect(service.create).toHaveBeenCalledWith(dto);
    expect(result).toMatchObject({ type: 'custom' });
  });

  it("POST type='template' → 403 POLICY_TEMPLATE_READONLY 透传", async () => {
    service.create.mockRejectedValue(
      new ForbiddenException({
        code: 'POLICY_TEMPLATE_READONLY',
        message: '模板策略只读（seed 维护），请创建 type=custom 策略',
      }),
    );
    await expect(
      controller.create({
        name: '伪造模板',
        type: 'template' as unknown as 'custom',
        config: validConfig,
      }),
    ).rejects.toMatchObject({
      response: { code: 'POLICY_TEMPLATE_READONLY' },
    });
  });

  it('POST 非法 config → 400 POLICY_CONFIG_INVALID 透传', async () => {
    service.create.mockRejectedValue(
      new BadRequestException({
        code: 'POLICY_CONFIG_INVALID',
        message: 'config 非法：permission/correction 均须为对象',
      }),
    );
    await expect(
      controller.create({
        name: '坏配置',
        type: 'custom',
        config: { permissions: {}, writePaths: [] } as never,
      }),
    ).rejects.toMatchObject({
      response: { code: 'POLICY_CONFIG_INVALID' },
    });
  });

  it('PATCH /execution-policies/:id：custom 更新透传', async () => {
    service.update.mockResolvedValue({ ...customRow, name: '新名' });
    const result = await controller.update('ep_0000000001', { name: '新名' });
    expect(service.update).toHaveBeenCalledWith('ep_0000000001', {
      name: '新名',
    });
    expect(result).toMatchObject({ name: '新名' });
  });

  it('PATCH template 目标 → 403 POLICY_TEMPLATE_READONLY 透传', async () => {
    service.update.mockRejectedValue(
      new ForbiddenException({
        code: 'POLICY_TEMPLATE_READONLY',
        message: '模板策略只读（seed 维护），请克隆为 custom 策略再修改',
      }),
    );
    await expect(
      controller.update('ep_product', { name: '改模板' }),
    ).rejects.toMatchObject({
      response: { code: 'POLICY_TEMPLATE_READONLY' },
    });
  });

  it('PATCH 非法 config → 400 POLICY_CONFIG_INVALID 透传', async () => {
    service.update.mockRejectedValue(
      new BadRequestException({
        code: 'POLICY_CONFIG_INVALID',
        message: 'config 非法：permission/correction 均须为对象',
      }),
    );
    await expect(
      controller.update('ep_0000000001', { config: { permission: 'deny' } as never }),
    ).rejects.toMatchObject({
      response: { code: 'POLICY_CONFIG_INVALID' },
    });
  });

  it('DELETE /execution-policies/:id：custom 删除透传', async () => {
    service.remove.mockResolvedValue(undefined);
    await controller.remove('ep_0000000001');
    expect(service.remove).toHaveBeenCalledWith('ep_0000000001');
  });

  it('DELETE template 目标 → 403 POLICY_TEMPLATE_READONLY 透传', async () => {
    service.remove.mockRejectedValue(
      new ForbiddenException({
        code: 'POLICY_TEMPLATE_READONLY',
        message: '模板策略只读（seed 维护），请克隆为 custom 策略再修改',
      }),
    );
    await expect(controller.remove('ep_product')).rejects.toMatchObject({
      response: { code: 'POLICY_TEMPLATE_READONLY' },
    });
  });
});
