import { TRIGGER_KIND } from '../common/constants/trigger.constants';
import { PrismaService } from '../prisma/prisma.service';
import { TRIGGER_STATUS } from './trigger.service';
import { TriggersService } from './triggers.service';

function makePrisma() {
  return {
    $transaction: jest.fn(
      async ([total, rows]: [Promise<unknown>, Promise<unknown>]) => [
        await total,
        await rows,
      ],
    ),
    trigger: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    teamUserMember: { findUnique: jest.fn() },
    teamMember: { findUnique: jest.fn(), findMany: jest.fn() },
    task: { findUnique: jest.fn() },
  };
}

type PrismaMock = ReturnType<typeof makePrisma>;

const ADMIN = { id: 'u_admin' };
const MEMBER = { id: 'u_member' };

function adminUser() {
  return { id: 'u_admin', enabled: true, role: { permissions: { all: true } } };
}

function memberUser() {
  return { id: 'u_member', enabled: true, role: { permissions: {} } };
}

function triggerRow(over: Record<string, unknown> = {}) {
  return {
    id: 'tmr_0000000001',
    kind: TRIGGER_KIND.RECEIPT_NUDGE,
    status: TRIGGER_STATUS.FIRED,
    fireAt: new Date('2026-09-16T00:00:00.000Z'),
    dueAt: new Date('2026-09-16T00:00:00.000Z'),
    scopeType: null,
    scopeId: null,
    ownerInstanceId: null,
    intervalMs: null,
    nextFireAt: null,
    guardKey: null,
    fireCount: 1,
    maxFires: null,
    expiresAt: null,
    skipReason: null,
    busyRetries: 0,
    payload: { teamId: 'tm_1', taskId: null },
    dedupKey: 'receipt_nudge:tm_1:mr_1',
    attempts: 1,
    lastError: null,
    createdAt: new Date('2026-09-16T00:00:01.000Z'),
    updatedAt: new Date('2026-09-16T00:00:02.000Z'),
    ...over,
  };
}

function makeService(prisma?: PrismaMock) {
  const p = prisma ?? makePrisma();
  const svc = new TriggersService(p as unknown as PrismaService);
  return { svc, prisma: p };
}

describe('TriggersService（GET 列表 + DELETE 取消，mocked Prisma，无 DB）', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('findAll（分页信封 + 过滤透传）', () => {
    it('admin：回 {items,total,page,pageSize}，项含 source + 白名单字段', async () => {
      const { svc, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(adminUser());
      prisma.trigger.count.mockResolvedValue(19);
      prisma.trigger.findMany.mockResolvedValue([triggerRow()]);

      const out = await svc.findAll(
        { status: 'fired', page: 1, pageSize: 5 },
        ADMIN,
      );

      expect(out.total).toBe(19);
      expect(out.page).toBe(1);
      expect(out.pageSize).toBe(5);
      expect(out.items).toHaveLength(1);
      expect(out.items[0]).toEqual({
        id: 'tmr_0000000001',
        kind: 'receipt_nudge',
        status: 'fired',
        dueAt: new Date('2026-09-16T00:00:00.000Z'),
        nextFireAt: null,
        scopeType: null,
        scopeId: null,
        ownerInstanceId: null,
        fireCount: 1,
        skipReason: null,
        lastError: null,
        attempts: 1,
        createdAt: new Date('2026-09-16T00:00:01.000Z'),
        source: 'system',
      });
      // payload/dedupKey 等执行细节不外泄
      expect(out.items[0]).not.toHaveProperty('payload');
      expect(out.items[0]).not.toHaveProperty('dedupKey');
      expect(prisma.trigger.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 5 }),
      );
    });

    it('分页归一：page 0→1，pageSize 999→100（tools/memories 同口径）', async () => {
      const { svc, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(adminUser());
      prisma.trigger.count.mockResolvedValue(0);
      prisma.trigger.findMany.mockResolvedValue([]);

      const out = await svc.findAll(
        { page: 0 as never, pageSize: 999 as never },
        ADMIN,
      );

      expect(out.page).toBe(1);
      expect(out.pageSize).toBe(100);
      expect(prisma.trigger.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });

    it('admin teamId+taskId 双过滤走独立 AND 子句（同 key 不覆盖）', async () => {
      const { svc, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(adminUser());
      prisma.trigger.count.mockResolvedValue(0);
      prisma.trigger.findMany.mockResolvedValue([]);

      await svc.findAll({ teamId: 'tm_1', taskId: 't_1' }, ADMIN);

      expect(prisma.trigger.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [
              { payload: { path: '$.taskId', equals: 't_1' } },
              { payload: { path: '$.teamId', equals: 'tm_1' } },
            ],
          }),
        }),
      );
    });

    it.each([
      ['receipt_nudge', 'system'],
      ['review_round_timeout', 'system'],
      ['progression_patrol', 'system'],
      ['session_idle_scan', 'system'],
      ['hook_fire', 'agent'],
      ['hook_poll', 'agent'],
    ])('source 映射：kind=%s → %s（六 kind 全覆盖）', async (kind, source) => {
      const { svc, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(adminUser());
      prisma.trigger.count.mockResolvedValue(1);
      prisma.trigger.findMany.mockResolvedValue([triggerRow({ kind })]);

      const out = await svc.findAll({}, ADMIN);

      expect(out.items[0].source).toBe(source);
      expect(out.items[0].kind).toBe(kind);
    });

    it('成员缺 teamId → 403 TRIGGER_TEAM_SCOPE_REQUIRED（全局列表 admin-scoped）', async () => {
      const { svc, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(memberUser());

      await expect(svc.findAll({}, MEMBER)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({
          code: 'TRIGGER_TEAM_SCOPE_REQUIRED',
        }),
      });
      expect(prisma.trigger.count).not.toHaveBeenCalled();
      expect(prisma.trigger.findMany).not.toHaveBeenCalled();
    });

    it('成员查非所属团队 → 空集（不泄漏存在性，不 403）', async () => {
      const { svc, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(memberUser());
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      const out = await svc.findAll({ teamId: 'tm_other' }, MEMBER);

      expect(out).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
      expect(prisma.trigger.count).not.toHaveBeenCalled();
    });

    it('成员查所属团队 → 行带团队归属 OR 约束（scope/payload.teamId/owner 域）', async () => {
      const { svc, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(memberUser());
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.teamMember.findMany.mockResolvedValue([
        { id: 'tmm_1' },
        { id: 'tmm_2' },
      ]);
      prisma.trigger.count.mockResolvedValue(1);
      prisma.trigger.findMany.mockResolvedValue([
        triggerRow({ payload: { teamId: 'tm_1' } }),
      ]);

      const out = await svc.findAll(
        { teamId: 'tm_1', status: 'pending' },
        MEMBER,
      );

      expect(out.total).toBe(1);
      expect(prisma.trigger.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { equals: 'pending' },
            OR: [
              { scopeType: 'team', scopeId: 'tm_1' },
              { payload: { path: '$.teamId', equals: 'tm_1' } },
              { ownerInstanceId: { in: ['tmm_1', 'tmm_2'] } },
            ],
          }),
        }),
      );
    });
  });

  describe('cancelForUser（取消 + 授权）', () => {
    it('未知 id → 404 TRIGGER_NOT_FOUND', async () => {
      const { svc, prisma } = makeService();
      prisma.trigger.findUnique.mockResolvedValue(null);

      await expect(
        svc.cancelForUser('does_not_exist', ADMIN),
      ).rejects.toMatchObject({
        status: 404,
        response: expect.objectContaining({ code: 'TRIGGER_NOT_FOUND' }),
      });
      expect(prisma.trigger.update).not.toHaveBeenCalled();
    });

    it('成员取消系统项 → 403 TRIGGER_SYSTEM_READONLY（团队 Tab 只读）', async () => {
      const { svc, prisma } = makeService();
      prisma.trigger.findUnique.mockResolvedValue(
        triggerRow({ status: 'pending' }),
      );
      prisma.user.findUnique.mockResolvedValue(memberUser());

      await expect(
        svc.cancelForUser('tmr_0000000001', MEMBER),
      ).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({
          code: 'TRIGGER_SYSTEM_READONLY',
        }),
      });
      expect(prisma.trigger.update).not.toHaveBeenCalled();
    });

    it('成员取消跨团队 agent 项 → 403 TRIGGER_FORBIDDEN', async () => {
      const { svc, prisma } = makeService();
      prisma.trigger.findUnique.mockResolvedValue(
        triggerRow({
          kind: 'hook_fire',
          status: 'pending',
          ownerInstanceId: 'tmm_other',
          payload: {},
        }),
      );
      prisma.user.findUnique.mockResolvedValue(memberUser());
      prisma.teamMember.findUnique.mockResolvedValue({ teamId: 'tm_other' });
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      await expect(
        svc.cancelForUser('tmr_0000000001', MEMBER),
      ).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ code: 'TRIGGER_FORBIDDEN' }),
      });
      expect(prisma.trigger.update).not.toHaveBeenCalled();
    });

    it('成员取消本团队 agent 项 → 200 置 cancelled（含 source=agent）', async () => {
      const { svc, prisma } = makeService();
      prisma.trigger.findUnique.mockResolvedValue(
        triggerRow({
          kind: 'hook_poll',
          status: 'pending',
          ownerInstanceId: 'tmm_1',
          payload: {},
        }),
      );
      prisma.user.findUnique.mockResolvedValue(memberUser());
      prisma.teamMember.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.trigger.update.mockResolvedValue(
        triggerRow({
          kind: 'hook_poll',
          status: 'cancelled',
          ownerInstanceId: 'tmm_1',
          payload: {},
        }),
      );

      const out = await svc.cancelForUser('tmr_0000000001', MEMBER);

      expect(prisma.trigger.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: { status: 'cancelled' },
      });
      expect(out).toMatchObject({
        id: 'tmr_0000000001',
        status: 'cancelled',
        source: 'agent',
      });
    });

    it('admin 取消系统项 → 200 置 cancelled', async () => {
      const { svc, prisma } = makeService();
      prisma.trigger.findUnique.mockResolvedValue(
        triggerRow({ status: 'pending' }),
      );
      prisma.user.findUnique.mockResolvedValue(adminUser());
      prisma.trigger.update.mockResolvedValue(
        triggerRow({ status: 'cancelled' }),
      );

      const out = await svc.cancelForUser('tmr_0000000001', ADMIN);

      expect(out.status).toBe('cancelled');
      expect(out.source).toBe('system');
    });

    it.each(['cancelled', 'fired'])(
      '幂等：已 %s 行直返当前态（不 update，不 500/409）',
      async (status) => {
        const { svc, prisma } = makeService();
        prisma.trigger.findUnique.mockResolvedValue(triggerRow({ status }));
        prisma.user.findUnique.mockResolvedValue(adminUser());

        const out = await svc.cancelForUser('tmr_0000000001', ADMIN);

        expect(out.status).toBe(status);
        expect(prisma.trigger.update).not.toHaveBeenCalled();
      },
    );
  });
});
