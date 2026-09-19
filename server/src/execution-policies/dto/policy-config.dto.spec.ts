import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ExecutionPoliciesController } from '../execution-policies.controller';
import { ExecutionPolicyService } from '../execution-policy.service';
import { UpdateExecutionPolicyDto } from './update-execution-policy.dto';

/**
 * PolicyConfigDto.bashDeny 往返测试（agent-native-permission-editor todo 2）。
 *
 * 背景：`main.ts` 的全局 `ValidationPipe({ whitelist: true })` 只保留 DTO 已声明的键。
 * `policy-config.dto.ts` 此前只声明 `permission`/`correction`/`tools`，故任何
 * `config.bashDeny` 都会被静默剥离；而 `resolveBashDeny`（service）与 `guardForAgent`
 * 仍会读取它——策略编辑器 PATCH 整份 config 时会静默丢字段（潜在数据损坏）。
 *
 * 本 spec 复用生产同款全局 pipe（whitelist/transform/forbidNonWhitelisted 三开关逐一对齐
 * main.ts），经真实 `ExecutionPoliciesController` + 真实 `ExecutionPolicyService`（内存
 * prisma 替身）走「PATCH → 落库 → GET 回读」全链路，断言 `bashDeny` 数组存活、非字符串
 * 元素被 400 拒绝。
 */
describe('PolicyConfigDto.bashDeny 往返（全局 whitelist pipe）', () => {
  /** 与 main.ts:55-61 逐字对齐的全局 DTO 校验管道。 */
  const globalPipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: false,
  });

  type PolicyRow = {
    id: string;
    name: string;
    description: string | null;
    type: string;
    config: unknown;
    createdAt: Date;
    updatedAt: Date;
  };

  function row(overrides: Partial<PolicyRow> = {}): PolicyRow {
    return {
      id: 'ep_product',
      name: '产品经理',
      description: null,
      type: 'template',
      config: {
        permission: { edit: { '*': 'deny' }, task: 'deny' },
        correction: { scopeSummary: 'scope' },
      },
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      ...overrides,
    };
  }

  function store(initial: PolicyRow[]) {
    const rows = [...initial];
    const findUnique = jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
    );
    const update = jest.fn(
      ({ where, data }: { where: { id: string }; data: Partial<PolicyRow> }) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx < 0) throw new Error(`missing ${where.id}`);
        rows[idx] = { ...rows[idx], ...data };
        return Promise.resolve(rows[idx]);
      },
    );
    const create = jest.fn(({ data }: { data: PolicyRow }) => {
      rows.push(data);
      return Promise.resolve(data);
    });
    const del = jest.fn(({ where }: { where: { id: string } }) => {
      const idx = rows.findIndex((r) => r.id === where.id);
      const [removed] = rows.splice(idx, 1);
      return Promise.resolve(removed);
    });
    return { rows, findUnique, update, create, delete: del };
  }

  function serviceWith(prisma: {
    executionPolicy: {
      findUnique: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
      delete: jest.Mock;
    };
  }) {
    const idGen = { nextId: jest.fn().mockResolvedValue('ep_0000000042') };
    return new ExecutionPolicyService(prisma as never, idGen as never);
  }

  /** 经生产同款全局 pipe 后调用控制器 PATCH（等价 HTTP 入站校验 → 路由委托）。 */
  async function patch(
    controller: ExecutionPoliciesController,
    id: string,
    body: Record<string, unknown>,
  ) {
    const dto: UpdateExecutionPolicyDto = await globalPipe.transform(body, {
      type: 'body',
      metatype: UpdateExecutionPolicyDto,
    });
    return controller.update(id, dto);
  }

  it("PATCH config.bashDeny=['rm -rf /'] → 落库并经 GET 回读存活", async () => {
    const prisma = store([row()]);
    const service = serviceWith({ executionPolicy: prisma });
    const controller = new ExecutionPoliciesController(service);

    const body = {
      config: {
        permission: { edit: { '*': 'deny' }, task: 'deny' },
        correction: { scopeSummary: 'scope' },
        bashDeny: ['rm -rf /'],
      },
    };

    const patched = await patch(controller, 'ep_product', body);

    // 落库对象必须真实携带键（不是 undefined），且数组原样保留。
    const storedConfig = prisma.rows[0].config as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(storedConfig, 'bashDeny')).toBe(
      true,
    );
    expect(storedConfig.bashDeny).toEqual(['rm -rf /']);
    expect((patched.config as Record<string, unknown>).bashDeny).toEqual([
      'rm -rf /',
    ]);

    // 模拟编辑器保存后重新拉取详情：整份 config 往返不丢 bashDeny。
    const reread = await controller.findOne('ep_product');
    const rereadConfig = reread.config as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(rereadConfig, 'bashDeny')).toBe(
      true,
    );
    expect(rereadConfig.bashDeny).toEqual(['rm -rf /']);
    // 控制项：permission/correction 也存活，证明 pipe 属真实应用而非整体直通。
    expect(rereadConfig.permission).toEqual({
      edit: { '*': 'deny' },
      task: 'deny',
    });
    expect(rereadConfig.correction).toEqual({ scopeSummary: 'scope' });
  });

  it('PATCH config.bashDeny=[123]（非字符串元素）→ 400 拒绝且不落库', async () => {
    const prisma = store([row()]);
    const service = serviceWith({ executionPolicy: prisma });
    const controller = new ExecutionPoliciesController(service);
    const before = prisma.rows[0].config;

    await expect(
      patch(controller, 'ep_product', {
        config: {
          permission: { edit: { '*': 'deny' }, task: 'deny' },
          correction: { scopeSummary: 'scope' },
          bashDeny: [123],
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.update).not.toHaveBeenCalled();
    expect(prisma.rows[0].config).toBe(before);
  });

  it('PATCH 不含 bashDeny → 仍可保存（字段可选，不强制注入）', async () => {
    const prisma = store([row()]);
    const service = serviceWith({ executionPolicy: prisma });
    const controller = new ExecutionPoliciesController(service);

    const patched = await patch(controller, 'ep_product', {
      config: {
        permission: { edit: { '*': 'deny' }, task: 'deny' },
        correction: { scopeSummary: 'scope' },
      },
    });

    const storedConfig = prisma.rows[0].config as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(storedConfig, 'bashDeny')).toBe(
      false,
    );
    expect((patched.config as Record<string, unknown>).bashDeny).toBeUndefined();
  });
});
