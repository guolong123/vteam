import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdGeneratorService } from '../common/id-generator';
import { TENANT_WORKSPACE_ID } from '../common/tenant/tenant.constants';
import { WORKSPACE_ROLE } from './workspaces.constants';
import { WorkspacesService } from './workspaces.service';

jest.mock('../users/admin-permission', () => ({
  isPlatformAdminByUserId: jest.fn(
    async (_prisma: unknown, userId: string) => userId === 'u_admin',
  ),
}));

const now = new Date('2026-11-12T10:00:00.000Z');

interface State {
  users: Record<
    string,
    { id: string; displayName: string; lastWorkspaceId: string | null }
  >;
  workspaces: Record<string, any>;
  members: {
    workspaceId: string;
    userId: string;
    role: string;
    joinedAt: Date;
  }[];
}

function createMocks() {
  const state: State = {
    users: {
      u_admin: {
        id: 'u_admin',
        displayName: '管理员',
        lastWorkspaceId: 'ws_a',
      },
      u_a: { id: 'u_a', displayName: 'A', lastWorkspaceId: 'ws_a' },
      u_b: { id: 'u_b', displayName: 'B', lastWorkspaceId: null },
    },
    workspaces: {
      [TENANT_WORKSPACE_ID.SYSTEM]: {
        id: TENANT_WORKSPACE_ID.SYSTEM,
        name: '平台空间',
        isSystem: true,
        status: 'active',
        ownerUserId: null,
        createdAt: now,
      },
      ws_a: {
        id: 'ws_a',
        name: 'A 的空间',
        isSystem: false,
        status: 'active',
        ownerUserId: 'u_a',
        createdAt: now,
      },
    },
    members: [
      {
        workspaceId: 'ws_a',
        userId: 'u_a',
        role: WORKSPACE_ROLE.OWNER,
        joinedAt: now,
      },
    ],
  };

  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        const u = state.users[where.id];
        return u ? { ...u } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        state.users[where.id] = { ...state.users[where.id], ...data };
        return state.users[where.id];
      }),
    },
    workspace: {
      findUnique: jest.fn(
        async ({ where }: any) => state.workspaces[where.id] ?? null,
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        const rows = Object.values(state.workspaces).filter((w: any) => {
          if (where?.isSystem !== undefined && w.isSystem !== where.isSystem)
            return false;
          if (where?.status !== undefined && w.status !== where.status)
            return false;
          if (
            where?.ownerUserId !== undefined &&
            w.ownerUserId !== where.ownerUserId
          )
            return false;
          if (where?.name !== undefined && w.name !== where.name) return false;
          return true;
        });
        return rows[0] ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, createdAt: now };
        state.workspaces[data.id] = row;
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        state.workspaces[where.id] = { ...state.workspaces[where.id], ...data };
        return state.workspaces[where.id];
      }),
      findMany: jest.fn(async () =>
        Object.values(state.workspaces).map((w: any) => ({
          ...w,
          _count: {
            members: state.members.filter((m) => m.workspaceId === w.id).length,
          },
        })),
      ),
    },
    workspaceMember: {
      findUnique: jest.fn(async ({ where }: any) => {
        const { workspaceId, userId } = where.workspaceId_userId;
        return (
          state.members.find(
            (m) => m.workspaceId === workspaceId && m.userId === userId,
          ) ?? null
        );
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const rows = state.members
          .filter((m) => m.userId === where.userId)
          .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
        return rows[0] ?? null;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        state.members
          .filter((m) => m.userId === where.userId)
          .map((m) => ({
            role: m.role,
            workspace: state.workspaces[m.workspaceId],
          })),
      ),
      create: jest.fn(async ({ data }: any) => {
        state.members.push({ ...data, joinedAt: now });
        return { ...data, joinedAt: now };
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = state.members.length;
        state.members = state.members.filter(
          (m) =>
            !(m.workspaceId === where.workspaceId && m.userId === where.userId),
        );
        return { count: before - state.members.length };
      }),
    },
    // 资源迁移（M2-4）相关 delegate / 审计表
    workspaceRelocation: {
      create: jest.fn(async ({ data }: any) => data),
      findMany: jest.fn(async () => []),
    },
    agent: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    teamMember: { findFirst: jest.fn().mockResolvedValue(null) },
    session: { findFirst: jest.fn().mockResolvedValue(null) },
    member: { findFirst: jest.fn().mockResolvedValue(null) },
    model: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
    },
    team: { findFirst: jest.fn().mockResolvedValue(null) },
    worker: { findFirst: jest.fn().mockResolvedValue(null) },
    taskGroupInstance: { findFirst: jest.fn().mockResolvedValue(null) },
    gitRepoGrant: { findFirst: jest.fn().mockResolvedValue(null) },
    gitRepo: { findFirst: jest.fn().mockResolvedValue(null) },
    agentSkill: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: any) => fn(mockTx)),
  } as unknown as PrismaService;

  // $transaction 回调里用的是 tx（同形 mock，但 create 直接作用到 prisma mock 上）
  const mockTx = {
    workspace: (prisma as any).workspace,
    workspaceMember: (prisma as any).workspaceMember,
    user: (prisma as any).user,
  };

  const idGen = {
    nextId: jest.fn(async (prefix: string) => `${prefix}_0000000009`),
  } as unknown as IdGeneratorService;

  return { prisma, idGen, state };
}

describe('WorkspacesService', () => {
  let prisma: PrismaService;
  let state: State;
  let service: WorkspacesService;

  beforeEach(() => {
    const mocks = createMocks();
    prisma = mocks.prisma;
    state = mocks.state;
    service = new WorkspacesService(prisma, mocks.idGen);
  });

  describe('listForUser', () => {
    it('返回成员空间 + 隐式可读的系统空间，系统空间置顶', async () => {
      const list = await service.listForUser('u_a');
      expect(list.map((w) => w.id)).toEqual([
        TENANT_WORKSPACE_ID.SYSTEM,
        'ws_a',
      ]);
      expect(list[0].role).toBe(WORKSPACE_ROLE.MEMBER);
      expect(list[1].role).toBe(WORKSPACE_ROLE.OWNER);
    });
  });

  describe('resolveRequestWorkspace（当前空间解析）', () => {
    it('JWT wid 可访问时直接采用', async () => {
      const r = await service.resolveRequestWorkspace({
        id: 'u_a',
        workspaceId: 'ws_a',
      });
      expect(r).toEqual({
        workspaceId: 'ws_a',
        readOnly: false,
        isPlatformAdmin: false,
      });
    });

    it('平台管理员用 x-workspace-id 看其它空间 → readOnly', async () => {
      const r = await service.resolveRequestWorkspace(
        { id: 'u_admin' },
        'ws_a',
      );
      expect(r.readOnly).toBe(true);
      expect(r.workspaceId).toBe('ws_a');
      expect(r.isPlatformAdmin).toBe(true);
    });

    it('平台管理员用 x-workspace-id 指向系统空间 → 可写', async () => {
      const r = await service.resolveRequestWorkspace(
        { id: 'u_admin' },
        TENANT_WORKSPACE_ID.SYSTEM,
      );
      expect(r).toEqual({
        workspaceId: TENANT_WORKSPACE_ID.SYSTEM,
        readOnly: false,
        isPlatformAdmin: true,
      });
    });

    it('普通用户用 x-workspace-id 访问非成员空间 → 403', async () => {
      await expect(
        service.resolveRequestWorkspace({ id: 'u_b' }, 'ws_a'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('普通用户 x-workspace-id 指向自有空间 → 可写', async () => {
      const r = await service.resolveRequestWorkspace({ id: 'u_a' }, 'ws_a');
      expect(r).toEqual({
        workspaceId: 'ws_a',
        readOnly: false,
        isPlatformAdmin: false,
      });
    });

    it('空间不存在 → 404', async () => {
      await expect(
        service.resolveRequestWorkspace({ id: 'u_a' }, 'ws_missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('JWT wid 失效时回退 lastWorkspaceId', async () => {
      const r = await service.resolveRequestWorkspace({
        id: 'u_a',
        workspaceId: 'ws_removed',
      });
      expect(r.workspaceId).toBe('ws_a');
    });
  });

  describe('resolveOrCreateDefault（登录默认空间自愈）', () => {
    it('lastWorkspaceId 可访问 → 直接返回', async () => {
      await expect(service.resolveOrCreateDefault('u_a')).resolves.toBe('ws_a');
    });

    it('无成员关系 → 自动创建个人空间', async () => {
      const id = await service.resolveOrCreateDefault('u_b');
      expect(id).toBe('ws_0000000009');
      expect(state.workspaces['ws_0000000009']).toMatchObject({
        name: 'B 的空间',
        ownerUserId: 'u_b',
      });
      expect(state.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workspaceId: 'ws_0000000009',
            userId: 'u_b',
            role: WORKSPACE_ROLE.OWNER,
          }),
        ]),
      );
    });
  });

  describe('成员管理', () => {
    it('owner 可邀请成员', async () => {
      const created = await service.addMember('u_a', 'ws_a', 'u_b');
      expect(created).toMatchObject({
        workspaceId: 'ws_a',
        userId: 'u_b',
        role: WORKSPACE_ROLE.MEMBER,
      });
    });

    it('重复邀请 → 409', async () => {
      await expect(
        service.addMember('u_a', 'ws_a', 'u_a'),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('非 owner/admin 邀请 → 403', async () => {
      await service.addMember('u_a', 'ws_a', 'u_b');
      await expect(
        service.addMember('u_b', 'ws_a', 'u_a'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('owner 不能被移除', async () => {
      await expect(
        service.removeMember('u_a', 'ws_a', 'u_a'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('可移除普通成员', async () => {
      await service.addMember('u_a', 'ws_a', 'u_b');
      await expect(service.removeMember('u_a', 'ws_a', 'u_b')).resolves.toEqual(
        {
          removed: true,
          userId: 'u_b',
        },
      );
    });
  });

  describe('资源空间迁移（M2-4）', () => {
    const agentRow = {
      id: 'a_0000000001',
      agentKey: 'my-agent',
      workspaceId: 'ws_a',
    };
    const relocDto = (over: Record<string, unknown> = {}) =>
      ({
        resourceType: 'agent',
        resourceId: 'a_0000000001',
        targetWorkspaceId: 'ws_b',
        reason: 'shared team use',
        ...over,
      }) as any;

    beforeEach(() => {
      (prisma as any).agent.findUnique.mockResolvedValue(agentRow);
      (prisma as any).agent.updateMany.mockResolvedValue({ count: 1 });
      (prisma as any).workspace.findUnique.mockImplementation(
        async ({ where }: any) => {
          if (where.id === 'ws_b') {
            return { id: 'ws_b', status: 'active' };
          }
          if (where.id === 'ws_target_active') {
            return { id: 'ws_target_active', status: 'active' };
          }
          return state.workspaces[where.id] ?? null;
        },
      );
    });

    it('不支持的类型 → 400 RELOCATE_UNSUPPORTED', async () => {
      await expect(
        service.relocate('u_admin', relocDto({ resourceType: 'team' })),
      ).rejects.toMatchObject({
        response: { code: 'WORKSPACE_RELOCATE_UNSUPPORTED' },
      });
    });

    it('目标空间不存在/归档 → 404 RELOCATE_TARGET_NOT_FOUND', async () => {
      await expect(
        service.relocate(
          'u_admin',
          relocDto({ targetWorkspaceId: 'ws_missing' }),
        ),
      ).rejects.toMatchObject({
        response: { code: 'WORKSPACE_RELOCATE_TARGET_NOT_FOUND' },
      });
    });

    it('资源不存在 → 404 RELOCATE_NOT_FOUND', async () => {
      (prisma as any).agent.findUnique.mockResolvedValue(null);
      await expect(
        service.relocate('u_admin', relocDto()),
      ).rejects.toMatchObject({
        response: { code: 'WORKSPACE_RELOCATE_NOT_FOUND' },
      });
    });

    it('目标空间与当前空间相同 → moved=false（幂等，不写审计）', async () => {
      const r = await service.relocate(
        'u_admin',
        relocDto({ targetWorkspaceId: 'ws_a' }),
      );
      expect(r.moved).toBe(false);
      expect((prisma as any).workspaceRelocation.create).not.toHaveBeenCalled();
    });

    it('目标空间唯一键冲突 → 409 RELOCATE_CONFLICT（不落库）', async () => {
      (prisma as any).agent.findUnique
        .mockResolvedValueOnce(agentRow) // 原资源
        .mockResolvedValueOnce({ id: 'a_conflict' }); // 目标空间同名 agentKey
      await expect(
        service.relocate('u_admin', relocDto()),
      ).rejects.toMatchObject({
        response: { code: 'WORKSPACE_RELOCATE_CONFLICT' },
      });
      expect((prisma as any).agent.updateMany).not.toHaveBeenCalled();
    });

    it('原空间仍有引用（团队成员席位）→ 409 RELOCATE_IN_USE', async () => {
      (prisma as any).teamMember.findFirst.mockResolvedValue({ id: 'tmm_1' });
      await expect(
        service.relocate('u_admin', relocDto()),
      ).rejects.toMatchObject({
        response: { code: 'WORKSPACE_RELOCATE_IN_USE' },
      });
      expect((prisma as any).agent.updateMany).not.toHaveBeenCalled();
    });

    it('成功迁移：显式 from 条件更新 + 写审计', async () => {
      const r = await service.relocate('u_admin', relocDto());
      expect(r).toMatchObject({
        moved: true,
        resourceType: 'agent',
        resourceId: 'a_0000000001',
        fromWorkspaceId: 'ws_a',
        toWorkspaceId: 'ws_b',
      });
      expect((prisma as any).agent.updateMany).toHaveBeenCalledWith({
        where: { id: 'a_0000000001', workspaceId: 'ws_a' },
        data: { workspaceId: 'ws_b' },
      });
      expect((prisma as any).workspaceRelocation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resourceType: 'agent',
          resourceId: 'a_0000000001',
          fromWorkspaceId: 'ws_a',
          toWorkspaceId: 'ws_b',
          actorUserId: 'u_admin',
        }),
      });
    });

    it('并发变更（updateMany count=0）→ 409 RELOCATE_CONCURRENT', async () => {
      (prisma as any).agent.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.relocate('u_admin', relocDto()),
      ).rejects.toMatchObject({
        response: { code: 'WORKSPACE_RELOCATE_CONCURRENT' },
      });
    });

    it('迁移到系统空间（发布共享）同样可用', async () => {
      (prisma as any).workspace.findUnique.mockImplementation(
        async ({ where }: any) =>
          where.id === 'ws_system'
            ? { id: 'ws_system', status: 'active' }
            : null,
      );
      const r = await service.relocate(
        'u_admin',
        relocDto({ targetWorkspaceId: 'ws_system' }),
      );
      expect(r.moved).toBe(true);
      expect(r.toWorkspaceId).toBe('ws_system');
    });
  });

  describe('issueWorkerJoinToken（空间 worker 加入码）', () => {
    it('owner 可签发：返回明文一次、DB 只存 SHA-256', async () => {
      const res = await service.issueWorkerJoinToken('u_a', 'ws_a');
      expect(res.workspaceId).toBe('ws_a');
      expect(res.joinToken).toMatch(/^wst_[0-9a-f]{48}$/);
      expect(state.workspaces.ws_a.workerJoinTokenHash).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(state.workspaces.ws_a.workerJoinTokenHash).not.toContain(
        res.joinToken,
      );
    });

    it('非 manager 签发 → 403', async () => {
      await expect(
        service.issueWorkerJoinToken('u_b', 'ws_a'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('系统空间仅平台管理员可签发', async () => {
      await expect(
        service.issueWorkerJoinToken('u_a', TENANT_WORKSPACE_ID.SYSTEM),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const res = await service.issueWorkerJoinToken(
        'u_admin',
        TENANT_WORKSPACE_ID.SYSTEM,
      );
      expect(res.workspaceId).toBe(TENANT_WORKSPACE_ID.SYSTEM);
    });
  });

  describe('listAll（管理员全部空间）', () => {
    it('返回全部空间（含系统空间）与成员数', async () => {
      const rows = await service.listAll();
      expect(rows.map((r) => r.id).sort()).toEqual(
        [TENANT_WORKSPACE_ID.SYSTEM, 'ws_a'].sort(),
      );
      const wsA = rows.find((r) => r.id === 'ws_a');
      expect(wsA?.memberCount).toBe(1);
    });
  });
});
