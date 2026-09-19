import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ExecutionPolicyService } from './execution-policy.service';

/**
 * ExecutionPolicyService 本体单测（F2 FINDING-5）。
 *
 * 控制器 spec 把 `service.update` mock 掉，因此 PATCH 内置策略的「放开」只在路由层
 * 空转；本 spec 用真实的 `ExecutionPolicyService` + 内存 prisma 替身，直接覆盖
 * `update()` 对 `type='template'` 的行为变更（成功且落库），并确认 `create()` /
 * `remove()` 仍拒绝 template。
 */
describe('ExecutionPolicyService（真实 service，FINDING-5）', () => {
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
        tools: { vteam_group_post: 'allow' },
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
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<PolicyRow>;
      }) => {
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

  function serviceWith(
    prisma: {
      executionPolicy: {
        findUnique: jest.Mock;
        update: jest.Mock;
        create: jest.Mock;
        delete: jest.Mock;
      };
    },
    workersService: {
      broadcastCommand: jest.Mock;
    } = { broadcastCommand: jest.fn().mockResolvedValue(0) },
  ) {
    const idGen = { nextId: jest.fn().mockResolvedValue('ep_0000000042') };
    return new ExecutionPolicyService(
      prisma as never,
      idGen as never,
      workersService as never,
    );
  }

  describe('update()：template 可直接编辑（PATCH 放开）', () => {
    it('template 行 PATCH config → 成功且新 config 落库', async () => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });

      const nextConfig = {
        permission: { edit: { '*': 'deny' }, task: 'deny' },
        correction: { scopeSummary: 'scope' },
        tools: {
          vteam_group_post: 'deny' as const,
          vteam_memory_search: 'ask' as const,
        },
      };
      const updated = await service.update('ep_product', {
        config: nextConfig,
      });

      expect(updated.type).toBe('template');
      expect(updated.config).toEqual(nextConfig);
      expect(prisma.update).toHaveBeenCalledTimes(1);
      expect(prisma.findUnique).toHaveBeenCalledWith({
        where: { id: 'ep_product' },
      });
    });

    it('template 行 PATCH 非 config 字段 → 成功', async () => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });

      const updated = await service.update('ep_product', {
        name: '产品经理-新',
      });
      expect(updated.name).toBe('产品经理-新');
      expect(updated.type).toBe('template');
    });

    it('不存在的 id → 404 POLICY_NOT_FOUND', async () => {
      const prisma = store([]);
      const service = serviceWith({ executionPolicy: prisma });
      await expect(
        service.update('ep_missing', { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create() / remove()：template 仍然拒绝（红线未松动）', () => {
    it('create(type=template) → 403 POLICY_TEMPLATE_READONLY', async () => {
      const prisma = store([]);
      const service = serviceWith({ executionPolicy: prisma });
      await expect(
        service.create({
          name: '伪造模板',
          type: 'template' as unknown as 'custom',
          config: {
            permission: { task: 'deny' },
            correction: { scopeSummary: 's' },
          },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.create).not.toHaveBeenCalled();
    });

    it('create(type=custom) → 成功且 id 取 idGen', async () => {
      const prisma = store([]);
      const service = serviceWith({ executionPolicy: prisma });
      const created = await service.create({
        name: '自定义',
        type: 'custom',
        config: {
          permission: { task: 'deny' },
          correction: { scopeSummary: 's' },
        },
      });
      expect(created.id).toBe('ep_0000000042');
      expect(created.type).toBe('custom');
    });

    it('remove(template) → 403 POLICY_TEMPLATE_READONLY，行保留', async () => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });
      await expect(service.remove('ep_product')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.delete).not.toHaveBeenCalled();
      expect(prisma.rows).toHaveLength(1);
    });

    it('remove(custom) → 成功删除', async () => {
      const prisma = store([row({ id: 'ep_0000000001', type: 'custom' })]);
      const service = serviceWith({ executionPolicy: prisma });
      await service.remove('ep_0000000001');
      expect(prisma.delete).toHaveBeenCalledTimes(1);
      expect(prisma.rows).toHaveLength(0);
    });
  });

  describe('assertValidConfig 写路径校验（create/update 共用）', () => {
    it('config.permission 非对象 → 400 POLICY_CONFIG_INVALID', async () => {
      const prisma = store([]);
      const service = serviceWith({ executionPolicy: prisma });
      await expect(
        service.create({
          name: 'bad',
          type: 'custom',
          config: { permission: 'deny', correction: {} } as never,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('PATCH template 携带 permission.write → 剥离后落库（不写 write，仍 200）', async () => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });

      const updated = await service.update('ep_product', {
        config: {
          permission: {
            write: { '*': 'allow' },
            edit: { '*': 'deny' },
            task: 'deny',
          },
          correction: { scopeSummary: 'scope' },
        },
      });

      expect(updated.config).toEqual({
        permission: { edit: { '*': 'deny' }, task: 'deny' },
        correction: { scopeSummary: 'scope' },
      });
      const storedConfig = prisma.rows[0].config as {
        permission: Record<string, unknown>;
      };
      expect(storedConfig.permission).not.toHaveProperty('write');
    });
  });

  describe('assertValidConfig 原生 permission 形状校验（todo 1）', () => {
    /** 写路径最小合法 config（permission 按需覆盖，correction 恒合法）。 */
    function configWith(permission: Record<string, unknown>): {
      permission: Record<string, unknown>;
      correction: Record<string, unknown>;
    } {
      return { permission, correction: { scopeSummary: 'scope' } };
    }

    it("edit 缺 '*' → 注入 catch-all 且保留原 allow glob（写入落库）", async () => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });

      const updated = await service.update('ep_product', {
        config: configWith({
          edit: { '**tasks/*/docs/**': 'allow' },
          read: { '*': 'allow' },
          bash: 'allow',
        }),
      });

      expect(updated.config).toEqual({
        permission: {
          edit: { '*': 'deny', '**tasks/*/docs/**': 'allow' },
          read: { '*': 'allow' },
          bash: 'allow',
        },
        correction: { scopeSummary: 'scope' },
      });
      const stored = prisma.rows[0].config as {
        permission: { edit: Record<string, string> };
      };
      expect(Object.keys(stored.permission.edit)).toEqual([
        '*',
        '**tasks/*/docs/**',
      ]);
    });

    it("edit 整个缺失 → 注入 edit: { '*': 'deny' } 落库", async () => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });

      const updated = await service.update('ep_product', {
        config: configWith({ bash: 'deny' }),
      });

      expect(updated.config).toEqual({
        permission: { edit: { '*': 'deny' }, bash: 'deny' },
        correction: { scopeSummary: 'scope' },
      });
    });

    it("read 存在但无 '*' → 原样落库（绝不注入，read 默认 allow）", async () => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });

      const updated = await service.update('ep_product', {
        config: configWith({
          edit: { '*': 'deny' },
          read: { 'src/**': 'allow' },
        }),
      });

      const stored = prisma.rows[0].config as {
        permission: { read: Record<string, string> };
      };
      expect(stored.permission.read).toEqual({ 'src/**': 'allow' });
      expect(updated.config).toMatchObject({
        permission: { read: { 'src/**': 'allow' } },
      });
    });

    it("read = { '*': 'allow' } → 原样落库（无注入）", async () => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });

      await service.update('ep_product', {
        config: configWith({
          edit: { '*': 'deny' },
          read: { '*': 'allow' },
        }),
      });

      const stored = prisma.rows[0].config as {
        permission: { read: Record<string, string> };
      };
      expect(stored.permission.read).toEqual({ '*': 'allow' });
    });

    it("'ask' 被接受并原样保留（edit 与 read 都不拒绝 ask）", async () => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });

      const updated = await service.update('ep_product', {
        config: configWith({
          edit: { '*': 'ask', 'src/**': 'allow' },
          read: { '*': 'ask' },
        }),
      });

      expect(updated.config).toEqual({
        permission: {
          edit: { '*': 'ask', 'src/**': 'allow' },
          read: { '*': 'ask' },
        },
        correction: { scopeSummary: 'scope' },
      });
    });

    it.each([
      ['空串 glob', { edit: { '': 'allow' } }],
      ['非三态值', { edit: { x: 'maybe' } }],
      ['非对象 edit', { edit: 'deny' }],
      ['非对象 read', { read: 'allow' }],
      ['超长 glob（>256）', { edit: { '*': 'deny', x: 'a'.repeat(257) } }],
      ['bash 非法值', { bash: 'sometimes', edit: { '*': 'deny' } }],
    ])('拒绝 %s → 400 POLICY_CONFIG_INVALID 且不落库', async (_label, permission) => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });
      const before = prisma.rows[0].config;

      await expect(
        service.update('ep_product', { config: configWith(permission) }),
      ).rejects.toMatchObject({
        response: { code: 'POLICY_CONFIG_INVALID' },
      });

      expect(prisma.update).not.toHaveBeenCalled();
      expect(prisma.rows[0].config).toBe(before);
    });

    it('拒绝 65 条规则（>64 上限）→ 400 且不落库', async () => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });
      const before = prisma.rows[0].config;
      const many = Object.fromEntries(
        Array.from({ length: 65 }, (_unused, i) => [`glob${i}`, 'allow']),
      );

      await expect(
        service.update('ep_product', {
          config: configWith({ edit: many }),
        }),
      ).rejects.toMatchObject({
        response: { code: 'POLICY_CONFIG_INVALID' },
      });

      expect(prisma.update).not.toHaveBeenCalled();
      expect(prisma.rows[0].config).toBe(before);
    });

    it('拒绝非字符串键（symbol 键）→ 400 且不落库', async () => {
      const prisma = store([row()]);
      const service = serviceWith({ executionPolicy: prisma });
      const before = prisma.rows[0].config;
      const edit: Record<PropertyKey, unknown> = { '*': 'deny' };
      edit[Symbol('bad')] = 'allow';

      await expect(
        service.update('ep_product', {
          config: configWith({ edit }),
        }),
      ).rejects.toMatchObject({
        response: { code: 'POLICY_CONFIG_INVALID' },
      });

      expect(prisma.update).not.toHaveBeenCalled();
      expect(prisma.rows[0].config).toBe(before);
    });

    it('create 路径同样注入 catch-all（edit 缺失）', async () => {
      const prisma = store([]);
      const service = serviceWith({ executionPolicy: prisma });

      const created = await service.create({
        name: '自定义',
        type: 'custom',
        config: configWith({ read: { '*': 'allow' } }),
      });

      expect(created.config).toEqual({
        permission: { edit: { '*': 'deny' }, read: { '*': 'allow' } },
        correction: { scopeSummary: 'scope' },
      });
    });
  });

  describe('update() 广播 reload-config（todo 9）', () => {
    it('A. 写入成功后恰好广播一次 reload-config', async () => {
      const prisma = store([row()]);
      const broadcastCommand = jest.fn().mockResolvedValue(3);
      const service = serviceWith({ executionPolicy: prisma }, {
        broadcastCommand,
      });

      await service.update('ep_product', { name: '产品经理-新' });

      expect(broadcastCommand).toHaveBeenCalledTimes(1);
      expect(broadcastCommand).toHaveBeenCalledWith({
        type: 'reload-config',
        resourceVersion: expect.any(String),
      });
    });

    it('B. 广播 reject 不影响写入：update 仍 resolve 并返回更新行', async () => {
      const prisma = store([row()]);
      const broadcastCommand = jest
        .fn()
        .mockRejectedValue(new Error('no online worker'));
      const service = serviceWith({ executionPolicy: prisma }, {
        broadcastCommand,
      });

      const updated = await service.update('ep_product', {
        name: '产品经理-新',
      });

      expect(updated.name).toBe('产品经理-新');
      expect(prisma.update).toHaveBeenCalledTimes(1);
    });

    it('C. create() 不广播（作用域栅栏）', async () => {
      const prisma = store([]);
      const broadcastCommand = jest.fn().mockResolvedValue(1);
      const service = serviceWith({ executionPolicy: prisma }, {
        broadcastCommand,
      });

      await service.create({
        name: '自定义',
        type: 'custom',
        config: {
          permission: { task: 'deny' },
          correction: { scopeSummary: 's' },
        },
      });

      expect(broadcastCommand).not.toHaveBeenCalled();
    });
  });
});
