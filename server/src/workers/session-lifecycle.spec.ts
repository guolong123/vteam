import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SESSION_STATUS } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { SessionLifecycleService } from './session-lifecycle.service';

describe('SessionLifecycleService', () => {
  let service: SessionLifecycleService;
  let prisma: {
    session: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    taskGroupInstance: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let idGen: { nextId: jest.Mock; seed: jest.Mock };

  /** TaskGroupInstance 行（findFirst/findMany 返回值）。 */
  const instanceRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'ti_0000000001',
    taskId: 't_0000000001',
    workerId: 'w_0000000001',
    instanceId: 'ses_0000000001',
    createdAt: new Date('2026-08-08T00:00:00Z'),
    removedAt: null,
    ...overrides,
  });

  /** bind 事务的 tx mock：session.findUnique + taskGroupInstance + session.update。 */
  const mockBindTx = (options: {
    session: { id: string; taskId: string } | null;
    existingInstance: { id: string } | null;
  }) => {
    const txModels = {
      session: {
        findUnique: jest.fn().mockResolvedValue(options.session),
        update: jest.fn().mockResolvedValue({}),
      },
      taskGroupInstance: {
        findFirst: jest.fn().mockResolvedValue(options.existingInstance),
        create: jest
          .fn()
          .mockResolvedValue(instanceRow({ id: 'ti_0000000001' })),
      },
    };
    prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));
    return txModels;
  };

  beforeEach(async () => {
    prisma = {
      session: { findUnique: jest.fn(), update: jest.fn() },
      taskGroupInstance: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    idGen = {
      nextId: jest.fn().mockResolvedValue('ti_0000000001'),
      seed: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionLifecycleService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
      ],
    }).compile();

    service = module.get<SessionLifecycleService>(SessionLifecycleService);
  });

  describe('onModuleInit（ti 续号，重启防主键冲突）', () => {
    it('重启对齐 TaskGroupInstance 最大序号 → seed(ti, seq)', async () => {
      prisma.taskGroupInstance.findMany.mockResolvedValue([
        { id: 'ti_0000000004' },
      ]);

      await service.onModuleInit();

      expect(prisma.taskGroupInstance.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'ti_' } },
        select: { id: true },
      });
      expect(idGen.seed).toHaveBeenCalledWith('ti', 4);
    });

    it('混入命名 id（非 ti_<数字>）时只统计数字序号（不 seed 到命名 id）', async () => {
      prisma.taskGroupInstance.findMany.mockResolvedValue([
        { id: 'ti_0000000001' },
        { id: 'ti_builtin_x' },
        { id: 'ti_0000000003' },
      ]);

      await service.onModuleInit();

      expect(idGen.seed).toHaveBeenCalledWith('ti', 3);
    });

    it('库空（无 ti 行）→ 不 seed', async () => {
      prisma.taskGroupInstance.findMany.mockResolvedValue([]);

      await service.onModuleInit();

      expect(idGen.seed).not.toHaveBeenCalled();
    });

    it('id 非法（非 ti_<数字> 形状）→ 不 seed', async () => {
      prisma.taskGroupInstance.findMany.mockResolvedValue([
        { id: 'ti_builtin_x' },
      ]);

      await service.onModuleInit();

      expect(idGen.seed).not.toHaveBeenCalled();
    });
  });

  describe('bindSessionToWorker', () => {
    it('首次 bind：Session 行写 workerId + instanceRef + status=active，TaskGroupInstance 落库（taskId 取 session）', async () => {
      const tx = mockBindTx({
        session: { id: 's_0000000001', taskId: 't_0000000001' },
        existingInstance: null,
      });

      const result = await service.bindSessionToWorker(
        's_0000000001',
        'w_0000000001',
        'ses_0000000001',
      );

      expect(tx.session.update).toHaveBeenCalledWith({
        where: { id: 's_0000000001' },
        data: {
          workerId: 'w_0000000001',
          instanceRef: 'ses_0000000001',
          status: SESSION_STATUS.active,
        },
      });
      expect(tx.taskGroupInstance.create).toHaveBeenCalledWith({
        data: {
          id: 'ti_0000000001',
          taskId: 't_0000000001',
          workerId: 'w_0000000001',
          instanceId: 'ses_0000000001',
        },
      });
      expect(result).toEqual({
        sessionId: 's_0000000001',
        taskId: 't_0000000001',
        workerId: 'w_0000000001',
        instanceId: 'ses_0000000001',
        instanceRowId: 'ti_0000000001',
      });
    });

    it('重复 bind 幂等：同 (taskId, workerId, instanceId) 已有实例行 → 复用不重复 create，Session 行照常更新', async () => {
      const tx = mockBindTx({
        session: { id: 's_0000000001', taskId: 't_0000000001' },
        existingInstance: { id: 'ti_0000000001' },
      });

      const result = await service.bindSessionToWorker(
        's_0000000001',
        'w_0000000001',
        'ses_0000000001',
      );

      expect(tx.taskGroupInstance.create).not.toHaveBeenCalled();
      expect(tx.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: SESSION_STATUS.active }),
        }),
      );
      expect(result.instanceRowId).toBe('ti_0000000001');
    });

    it('session 不存在 → 404 SESSION_NOT_FOUND，不写 Session 也不写实例行', async () => {
      const tx = mockBindTx({ session: null, existingInstance: null });

      await expect(
        service.bindSessionToWorker('s_unknown', 'w_1', 'ses_1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.session.update).not.toHaveBeenCalled();
      expect(tx.taskGroupInstance.create).not.toHaveBeenCalled();
    });
  });

  describe('unbindSession（F2 M5 分派失败回滚绑定）', () => {
    /** unbind 事务的 tx mock：session.findUnique + taskGroupInstance.updateMany + session.update。 */
    const mockUnbindTx = (options: {
      session: {
        id: string;
        taskId: string;
        workerId: string | null;
        instanceRef: string | null;
      } | null;
    }) => {
      const txModels = {
        session: {
          findUnique: jest.fn().mockResolvedValue(options.session),
          update: jest.fn().mockResolvedValue({}),
        },
        taskGroupInstance: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));
      return txModels;
    };

    it('清 workerId/instanceRef + status=created，实例行软移除（removedAt=now）', async () => {
      const tx = mockUnbindTx({
        session: {
          id: 's_0000000001',
          taskId: 't_0000000001',
          workerId: 'w_0000000001',
          instanceRef: 'ses_0000000001',
        },
      });

      const result = await service.unbindSession('s_0000000001');

      expect(tx.taskGroupInstance.updateMany).toHaveBeenCalledWith({
        where: {
          taskId: 't_0000000001',
          workerId: 'w_0000000001',
          instanceId: 'ses_0000000001',
          removedAt: null,
        },
        data: { removedAt: expect.any(Date) },
      });
      expect(tx.session.update).toHaveBeenCalledWith({
        where: { id: 's_0000000001' },
        data: {
          workerId: null,
          instanceRef: null,
          status: SESSION_STATUS.created,
        },
      });
      expect(result).toEqual({ sessionId: 's_0000000001', unbound: true });
    });

    it('未绑定（workerId/instanceRef 空）幂等：不触碰实例行，仅回写 created 态', async () => {
      const tx = mockUnbindTx({
        session: {
          id: 's_0000000001',
          taskId: 't_0000000001',
          workerId: null,
          instanceRef: null,
        },
      });

      await service.unbindSession('s_0000000001');

      expect(tx.taskGroupInstance.updateMany).not.toHaveBeenCalled();
      expect(tx.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: SESSION_STATUS.created }),
        }),
      );
    });

    it('session 不存在 → 404 SESSION_NOT_FOUND', async () => {
      const tx = mockUnbindTx({ session: null });

      await expect(service.unbindSession('s_unknown')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.session.update).not.toHaveBeenCalled();
    });
  });

  describe('getInstancesByTask', () => {
    it('返回任务全部未移除实例，createdAt 倒序', async () => {
      prisma.taskGroupInstance.findMany.mockResolvedValue([instanceRow()]);

      const rows = await service.getInstancesByTask('t_0000000001');

      expect(prisma.taskGroupInstance.findMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001', removedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ instanceId: 'ses_0000000001' });
    });
  });

  describe('getInstanceBySession', () => {
    it('会话已绑定（workerId + instanceRef）→ 按 (taskId, workerId, instanceId) 查实例行', async () => {
      prisma.session.findUnique.mockResolvedValue({
        taskId: 't_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0000000001',
      });
      prisma.taskGroupInstance.findFirst.mockResolvedValue(instanceRow());

      const row = await service.getInstanceBySession('s_0000000001');

      expect(prisma.taskGroupInstance.findFirst).toHaveBeenCalledWith({
        where: {
          taskId: 't_0000000001',
          workerId: 'w_0000000001',
          instanceId: 'ses_0000000001',
          removedAt: null,
        },
      });
      expect(row).toMatchObject({ id: 'ti_0000000001' });
    });

    it('会话未绑定（created 态，workerId/instanceRef 空）→ null，不查实例行', async () => {
      prisma.session.findUnique.mockResolvedValue({
        taskId: 't_0000000001',
        workerId: null,
        instanceRef: null,
      });

      const row = await service.getInstanceBySession('s_0000000001');

      expect(row).toBeNull();
      expect(prisma.taskGroupInstance.findFirst).not.toHaveBeenCalled();
    });

    it('会话不存在 → null', async () => {
      prisma.session.findUnique.mockResolvedValue(null);

      const row = await service.getInstanceBySession('s_unknown');

      expect(row).toBeNull();
    });
  });

  describe('ensureTeamSession（team-mode 无任务会话即建即得）', () => {
    /** ensure 事务的 tx mock：teamMember.findUnique + session.findUnique/create。 */
    const mockEnsureTx = (options: {
      member: { id: string; teamId: string; agentId: string } | null;
      existing: Record<string, unknown> | null;
    }) => {
      const txModels = {
        teamMember: {
          findUnique: jest.fn().mockResolvedValue(options.member),
        },
        session: {
          findUnique: jest.fn().mockResolvedValue(options.existing),
          create: jest.fn().mockImplementation(async (args: any) => ({
            ...args.data,
            workerId: null,
            instanceRef: null,
          })),
        },
        taskGroupInstance: {
          findFirst: jest.fn(),
          create: jest.fn(),
        },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));
      return txModels;
    };

    it('未建过 → create 行（team_id 必填，task_id/task_agent_id 置空），reused=false', async () => {
      const tx = mockEnsureTx({
        member: { id: 'tmm_0000000001', teamId: 'tm_0000000001', agentId: 'a_product' },
        existing: null,
      });
      idGen.nextId.mockResolvedValue('s_0000000001');

      const result = await service.ensureTeamSession(
        'tm_0000000001',
        'tmm_0000000001',
      );

      expect(tx.session.findUnique).toHaveBeenCalledWith({
        where: { teamMemberKey: 'tm_0000000001|tmm_0000000001' },
        select: expect.anything(),
      });
      expect(tx.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: 's_0000000001',
            teamId: 'tm_0000000001',
            teamMemberId: 'tmm_0000000001',
            agentId: 'a_product',
            taskId: null,
            taskAgentId: null,
            status: SESSION_STATUS.created,
          }),
        }),
      );
      expect(result).toMatchObject({ id: 's_0000000001', reused: false });
    });

    it('已建过 → 复用既有行（不 create），reused=true', async () => {
      const existing = {
        id: 's_0000000001',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
        agentId: 'a_product',
        workerId: null,
        instanceRef: null,
        status: SESSION_STATUS.created,
      };
      const tx = mockEnsureTx({
        member: { id: 'tmm_0000000001', teamId: 'tm_0000000001', agentId: 'a_product' },
        existing,
      });

      const result = await service.ensureTeamSession(
        'tm_0000000001',
        'tmm_0000000001',
      );

      expect(tx.session.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: 's_0000000001', reused: true });
    });

    it('并发竞态：create 报 P2002 → 重读命中胜者行，reused=true', async () => {
      const raced = {
        id: 's_0000000002',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
        agentId: 'a_product',
        workerId: null,
        instanceRef: null,
        status: SESSION_STATUS.created,
      };
      const tx = mockEnsureTx({
        member: { id: 'tmm_0000000001', teamId: 'tm_0000000001', agentId: 'a_product' },
        existing: null,
      });
      const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      (tx.session.create as jest.Mock).mockRejectedValueOnce(p2002);
      (tx.session.findUnique as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(raced);
      idGen.nextId.mockResolvedValue('s_0000000001');

      const result = await service.ensureTeamSession(
        'tm_0000000001',
        'tmm_0000000001',
      );

      expect(tx.session.findUnique).toHaveBeenCalledTimes(2);
      expect(tx.session.findUnique).toHaveBeenLastCalledWith({
        where: { teamMemberKey: 'tm_0000000001|tmm_0000000001' },
        select: expect.anything(),
      });
      expect(result).toMatchObject({ id: 's_0000000002', reused: true });
    });

    it('成员不存在 → 404，不查会话不建行', async () => {
      const tx = mockEnsureTx({ member: null, existing: null });

      await expect(
        service.ensureTeamSession('tm_0000000001', 'tmm_unknown'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.session.findUnique).not.toHaveBeenCalled();
      expect(tx.session.create).not.toHaveBeenCalled();
    });

    it('成员不属该团队 → 404，不建行', async () => {
      const tx = mockEnsureTx({
        member: { id: 'tmm_0000000001', teamId: 'tm_other', agentId: 'a_product' },
        existing: null,
      });

      await expect(
        service.ensureTeamSession('tm_0000000001', 'tmm_0000000001'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.session.create).not.toHaveBeenCalled();
    });
  });

  describe('bindSessionToWorker team-mode（task_id 空 → 团队维度实例行）', () => {
    /** team bind 事务的 tx mock：session.findUnique + taskGroupInstance + session.update。 */
    const mockTeamBindTx = (options: {
      session: {
        id: string;
        taskId: string | null;
        teamId: string | null;
        teamMemberId: string | null;
      } | null;
      existingInstance: { id: string } | null;
    }) => {
      const txModels = {
        session: {
          findUnique: jest.fn().mockResolvedValue(options.session),
          update: jest.fn().mockResolvedValue({}),
        },
        taskGroupInstance: {
          findFirst: jest.fn().mockResolvedValue(options.existingInstance),
          create: jest
            .fn()
            .mockResolvedValue(instanceRow({ id: 'ti_0000000002' })),
        },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));
      return txModels;
    };

    it('team 会话：按 (teamId, teamMemberId, workerId, instanceId) 幂等，create 带 team 维度且 taskId 置空', async () => {
      const tx = mockTeamBindTx({
        session: {
          id: 's_0000000001',
          taskId: null,
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
        },
        existingInstance: null,
      });

      const result = await service.bindSessionToWorker(
        's_0000000001',
        'w_0000000001',
        'ses_0000000001',
      );

      expect(tx.taskGroupInstance.findFirst).toHaveBeenCalledWith({
        where: {
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
          workerId: 'w_0000000001',
          instanceId: 'ses_0000000001',
        },
        select: { id: true },
      });
      expect(tx.taskGroupInstance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: null,
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
          workerId: 'w_0000000001',
          instanceId: 'ses_0000000001',
        }),
      });
      expect(result).toMatchObject({
        sessionId: 's_0000000001',
        taskId: null,
        instanceRowId: 'ti_0000000002',
      });
    });

    it('team 会话二次 bind → 复用实例行不 create，Session 照常更新', async () => {
      const tx = mockTeamBindTx({
        session: {
          id: 's_0000000001',
          taskId: null,
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
        },
        existingInstance: { id: 'ti_0000000002' },
      });

      const result = await service.bindSessionToWorker(
        's_0000000001',
        'w_0000000001',
        'ses_0000000001',
      );

      expect(tx.taskGroupInstance.create).not.toHaveBeenCalled();
      expect(tx.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: SESSION_STATUS.active }),
        }),
      );
      expect(result.instanceRowId).toBe('ti_0000000002');
    });

    it('task_id 与团队维度双空 → 400，不写 Session 也不写实例行', async () => {
      const tx = mockTeamBindTx({
        session: { id: 's_0000000001', taskId: null, teamId: null, teamMemberId: null },
        existingInstance: null,
      });

      await expect(
        service.bindSessionToWorker('s_0000000001', 'w_1', 'ses_1'),
      ).rejects.toThrow();
      expect(tx.session.update).not.toHaveBeenCalled();
      expect(tx.taskGroupInstance.create).not.toHaveBeenCalled();
    });
  });

  describe('resetTeamSessionsInTx（Todo7 记忆开关）', () => {
    it('批量 reset：soft-remove 先于 delete，再 delete+create 新 s_ 行，Memory 不删', async () => {
      const tx: any = {
        teamMember: { findMany: jest.fn().mockResolvedValue([{ id: 'tmm_0000000001' }, { id: 'tmm_0000000002' }]) },
        session: {
          findMany: jest.fn().mockResolvedValue([
            { id: 's_0000000001', taskId: 't_0000000001', taskAgentId: 'ta_0000000001', agentId: 'a_product', teamMemberId: 'tmm_0000000001', workerId: 'w_1', instanceRef: 'ses_1' },
            { id: 's_0000000002', taskId: 't_0000000001', taskAgentId: 'ta_0000000002', agentId: 'a_developer', teamMemberId: 'tmm_0000000002', workerId: null, instanceRef: null },
          ]),
          deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
          create: jest.fn().mockResolvedValue({}),
        },
        taskGroupInstance: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      idGen.nextId.mockResolvedValue('s_0000000099');

      const count = await service.resetTeamSessionsInTx(tx as any, 'tm_0000000001');

      expect(tx.taskGroupInstance.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.taskGroupInstance.updateMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001', workerId: 'w_1', instanceId: 'ses_1', removedAt: null },
        data: { removedAt: expect.any(Date) },
      });
      const deleteOrder = tx.session.deleteMany.mock.invocationCallOrder[0];
      const createOrder = tx.session.create.mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(createOrder);
      expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s_0000000001', 's_0000000002'] } } });
      expect(tx.session.create).toHaveBeenCalledTimes(2);
      expect(count).toBe(2);
    });

    it('团队无成员或无会话 → 0，不报错', async () => {
      const txEmpty: any = {
        teamMember: { findMany: jest.fn().mockResolvedValue([]) },
        session: { findMany: jest.fn(), deleteMany: jest.fn(), create: jest.fn() },
        taskGroupInstance: { updateMany: jest.fn() },
      };
      expect(await service.resetTeamSessionsInTx(txEmpty as any, 'tm_0000000001')).toBe(0);
      const txNoSess: any = {
        teamMember: { findMany: jest.fn().mockResolvedValue([{ id: 'tmm_1' }]) },
        session: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn(), create: jest.fn() },
        taskGroupInstance: { updateMany: jest.fn() },
      };
      expect(await service.resetTeamSessionsInTx(txNoSess as any, 'tm_0000000001')).toBe(0);
    });
  });
});
