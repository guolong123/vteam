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
});
