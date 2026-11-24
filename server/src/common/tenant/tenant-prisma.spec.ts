import { ForbiddenException } from '@nestjs/common';
import { TENANT_ERRORS, TENANT_WORKSPACE_ID } from './tenant.constants';
import {
  getTenantContext,
  runWithTenant,
  type TenantContext,
} from './tenant-context';
import { applyTenantScope, guardUniqueReadResult } from './tenant-prisma';

const REQ: TenantContext = {
  workspaceId: 'ws_a',
  userId: 'u_a',
  mode: 'request',
};

const call = (
  model: string,
  operation: string,
  args: Record<string, unknown> = {},
  ctx: TenantContext | undefined = REQ,
) => applyTenantScope({ model, operation, args }, ctx).args;

describe('applyTenantScope（租户注入纯函数）', () => {
  describe('读过滤', () => {
    it('平台资源：读时 workspaceId IN (当前空间, ws_system)', () => {
      const args = call('Agent', 'findMany', { where: { type: 'template' } });
      expect(args.where).toEqual({
        type: 'template',
        workspaceId: { in: ['ws_a', TENANT_WORKSPACE_ID.SYSTEM] },
      });
    });

    it('用户态资源：读时严格 workspaceId = 当前空间（不回落系统空间）', () => {
      const args = call('Team', 'findMany', {
        where: { name: { contains: 'x' } },
      });
      expect(args.where).toEqual({
        name: { contains: 'x' },
        workspaceId: 'ws_a',
      });
    });

    it('findUnique 不注入（唯一键 where 只能由 tenantUniqueWhere 显式构造）', () => {
      const args = call('Task', 'findUnique', { where: { id: 't_1' } });
      expect(args.where).toEqual({ id: 't_1' });
    });

    it('count / aggregate / groupBy 同样注入', () => {
      for (const op of ['count', 'aggregate', 'groupBy']) {
        expect(call('Session', op, { where: {} }).where).toEqual({
          workspaceId: 'ws_a',
        });
      }
    });

    it('调用方伪造 where.workspaceId 会被覆盖为当前空间', () => {
      const args = call('Task', 'findMany', {
        where: { workspaceId: 'ws_victim' },
      });
      expect((args.where as Record<string, unknown>).workspaceId).toBe('ws_a');
    });

    it('系统本体 / 未登记模型（子表）不注入', () => {
      expect(
        call('User', 'findMany', { where: { username: 'x' } }).where,
      ).toEqual({
        username: 'x',
      });
      expect(call('TeamMember', 'findMany', { where: {} }).where).toEqual({});
      expect(call('UnknownModel', 'findMany', { where: {} }).where).toEqual({});
    });
  });

  describe('写归属', () => {
    it('create 强制写入当前空间，并覆盖调用方传入的 workspaceId', () => {
      const args = call('Team', 'create', {
        data: { name: 't', workspaceId: 'ws_victim' },
      });
      expect(args.data).toEqual({ name: 't', workspaceId: 'ws_a' });
    });

    it('createMany 对每一行写入当前空间', () => {
      const args = call('Agent', 'createMany', {
        data: [{ name: 'a' }, { name: 'b', workspaceId: 'ws_victim' }],
      });
      expect(args.data).toEqual([
        { name: 'a', workspaceId: 'ws_a' },
        { name: 'b', workspaceId: 'ws_a' },
      ]);
    });

    it('updateMany / deleteMany 在 where 叠加当前空间', () => {
      for (const op of ['updateMany', 'deleteMany']) {
        const args = call('Team', op, {
          where: { id: 'tm_1' },
          data: { name: 'x' },
        });
        expect(args.where).toEqual({ id: 'tm_1', workspaceId: 'ws_a' });
      }
    });

    it('update / delete 不注入（唯一键 where 由 tenantUniqueWhere 负责）', () => {
      for (const op of ['update', 'delete']) {
        const args = call('Team', op, {
          where: { id: 'tm_1' },
          data: { name: 'x' },
        });
        expect(args.where).toEqual({ id: 'tm_1' });
      }
    });

    it('upsert 的 where 与 create 都写当前空间', () => {
      const args = call('ModelCredential', 'upsert', {
        where: { providerID: 'openai' },
        create: { providerID: 'openai' },
        update: {},
      });
      expect(args.where).toEqual({ providerID: 'openai', workspaceId: 'ws_a' });
      expect(args.create).toEqual({
        providerID: 'openai',
        workspaceId: 'ws_a',
      });
    });

    it('创建平台资源时写当前空间（不是系统空间）', () => {
      const args = call('Agent', 'create', { data: { name: 'my-agent' } });
      expect(args.data).toEqual({ name: 'my-agent', workspaceId: 'ws_a' });
    });
  });

  describe('写保护', () => {
    it('跨空间只读态（readOnly）下写操作抛 403', () => {
      expect(() =>
        call(
          'Team',
          'update',
          { where: { id: 'tm_1' } },
          {
            ...REQ,
            readOnly: true,
            isPlatformAdmin: true,
          },
        ),
      ).toThrow(ForbiddenException);
      try {
        call(
          'Team',
          'update',
          { where: { id: 'tm_1' } },
          {
            ...REQ,
            readOnly: true,
            isPlatformAdmin: true,
          },
        );
      } catch (e) {
        expect((e as ForbiddenException).getResponse()).toMatchObject({
          code: TENANT_ERRORS.CROSS_WORKSPACE_WRITE_FORBIDDEN,
        });
      }
    });

    it('普通用户写系统空间抛 403', () => {
      expect(() =>
        call(
          'Agent',
          'create',
          { data: {} },
          {
            workspaceId: TENANT_WORKSPACE_ID.SYSTEM,
            mode: 'request',
            isPlatformAdmin: false,
          },
        ),
      ).toThrow(ForbiddenException);
    });

    it('平台管理员可在系统空间维护平台资源', () => {
      const args = call(
        'Agent',
        'updateMany',
        { where: { id: 'a_1' } },
        {
          workspaceId: TENANT_WORKSPACE_ID.SYSTEM,
          mode: 'request',
          isPlatformAdmin: true,
        },
      );
      expect(args.where).toEqual({ id: 'a_1', workspaceId: 'ws_system' });
    });

    it('跨空间只读态下读操作照常（过滤到目标空间）', () => {
      const args = call(
        'Team',
        'findMany',
        {},
        {
          workspaceId: 'ws_other',
          mode: 'request',
          readOnly: true,
          isPlatformAdmin: true,
        },
      );
      expect(args.where).toEqual({ workspaceId: 'ws_other' });
    });
  });

  describe('模式与上下文', () => {
    it('无上下文（内部流程未包裹）时原样返回', () => {
      const params = {
        model: 'Team',
        operation: 'findMany',
        args: { where: {} },
      };
      expect(applyTenantScope(params, undefined)).toBe(params);
    });

    it('system 模式显式关闭注入', () => {
      const args = call(
        'Team',
        'findMany',
        { where: {} },
        {
          workspaceId: TENANT_WORKSPACE_ID.SYSTEM,
          mode: 'system',
        },
      );
      expect(args.where).toEqual({});
    });

    it('seed 模式：平台资源写系统空间、用户态写默认空间', () => {
      const seedCtx: TenantContext = {
        workspaceId: TENANT_WORKSPACE_ID.DEFAULT,
        mode: 'seed',
      };
      expect(call('AgentRole', 'create', { data: {} }, seedCtx).data).toEqual({
        workspaceId: TENANT_WORKSPACE_ID.SYSTEM,
      });
      expect(call('Team', 'create', { data: {} }, seedCtx).data).toEqual({
        workspaceId: TENANT_WORKSPACE_ID.DEFAULT,
      });
    });

    it('runWithTenant 内的调用能取到上下文（ALS 生效）', () => {
      const seen = runWithTenant(
        { workspaceId: 'ws_als', mode: 'request' },
        () =>
          applyTenantScope(
            { model: 'Team', operation: 'findMany', args: { where: {} } },
            getTenantContext(),
          ),
      );
      expect(seen.args.where).toEqual({ workspaceId: 'ws_als' });
    });
  });

  describe('guardUniqueReadResult（findUnique 结果兜底校验）', () => {
    const ctx: TenantContext = { workspaceId: 'ws_a', mode: 'request' };

    it('用户态模型：他空间行 → null（按不存在处理）', () => {
      const row = { id: 'a_1', workspaceId: 'ws_b' };
      expect(guardUniqueReadResult('Agent', 'findUnique', row, ctx)).toBeNull();
    });

    it('用户态模型：本空间行 → 原样返回', () => {
      const row = { id: 'a_1', workspaceId: 'ws_a' };
      expect(guardUniqueReadResult('Agent', 'findUnique', row, ctx)).toBe(row);
    });

    it('平台模型：当前空间或系统空间都放行，其它空间 → null', () => {
      const sys = { id: 'a_tpl', workspaceId: 'ws_system' };
      const mine = { id: 'a_2', workspaceId: 'ws_a' };
      const other = { id: 'a_3', workspaceId: 'ws_b' };
      expect(guardUniqueReadResult('Agent', 'findUnique', sys, ctx)).toBe(sys);
      expect(guardUniqueReadResult('Agent', 'findUnique', mine, ctx)).toBe(
        mine,
      );
      expect(
        guardUniqueReadResult('Agent', 'findUnique', other, ctx),
      ).toBeNull();
    });

    it('system 模式 / 无上下文 / 非 findUnique 操作不校验', () => {
      const other = { id: 'a_3', workspaceId: 'ws_b' };
      expect(
        guardUniqueReadResult('Agent', 'findUnique', other, {
          workspaceId: 'ws_system',
          mode: 'system',
        }),
      ).toBe(other);
      expect(
        guardUniqueReadResult('Agent', 'findUnique', other, undefined),
      ).toBe(other);
      expect(guardUniqueReadResult('Agent', 'findFirst', other, ctx)).toBe(
        other,
      );
    });

    it('无关模型（User/子表）与空结果不处理', () => {
      expect(
        guardUniqueReadResult('User', 'findUnique', { id: 'u_1' }, ctx),
      ).toEqual({ id: 'u_1' });
      expect(guardUniqueReadResult('Team', 'findUnique', null, ctx)).toBeNull();
    });
  });
});
