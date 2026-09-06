import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SESSION_STATUS } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';

/** TaskGroupInstance 主键前缀（15 篇 §2.2：<prefix>_<零填充序号>）。 */
const TASK_GROUP_INSTANCE_ID_PREFIX = 'ti';

const SESSION_ERRORS = {
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
} as const;

/** TaskGroupInstance 对外视图（id/taskId/workerId/instanceId/createdAt/removedAt）。 */
export type TaskGroupInstanceRow = {
  id: string;
  taskId: string;
  workerId: string;
  instanceId: string;
  createdAt: Date;
  removedAt: Date | null;
};

/**
 * 会话生命周期服务（T12，架构决策 D3；TeamMember 维度）：
 * Session.workerId/instanceRef 写入路径 + status=active + TaskGroupInstance 落库。
 * 唯一键保持 uk_sessions_task_agent（taskId, taskAgentId）不动以保存量迁移安全，
 * 上层复用维度改为 teamMemberId（Session.teamMemberId）：同一 TeamMember 跨任务/二次 @
 * 复用同一 opencode sessionId 时，instanceRef 保持不变，TaskGroupInstance 幂等复用不重建。
 *
 * - bindSessionToWorker：分派时把 Session 绑定到 worker（写 workerId + instanceRef + status=active），
 *   同事务写 TaskGroupInstance 行（id=ti_<seq>，instanceId = opencode sessionId）。
 *   幂等：同 (taskId, workerId, instanceId) 已存在则复用（二次 @ 复用同一 opencode 会话，reuse=true 时不重建）。
 * - getInstancesByTask / getInstanceBySession：供 WorkerDispatcher 调度复用与任务页查询。
 */
@Injectable()
export class SessionLifecycleService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /**
   * 进程启动对齐 TaskGroupInstance 域前缀序号（重启续号）。
   * 只统计 ti_<数字> 行的最大序号；原 findFirst orderBy id desc 若遇命名 id 会 parseInt NaN
   * → seed 失败 → 解绑重绑定创建新实例行时与软删旧行主键冲突（Unique constraint PRIMARY）。
   */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(
      this.prisma.taskGroupInstance,
      TASK_GROUP_INSTANCE_ID_PREFIX,
      this.idGen,
    );
  }

  /**
   * 绑定 Session → worker（WorkerDispatcher 首次分派调用，TeamMember 维度）。
   *
   * 事务内：查 Session（不存在 → 404）→ 幂等 upsert TaskGroupInstance →
   * 更新 Session.workerId + instanceRef + status=active。
   * 幂等：同 (taskId, workerId, instanceId) 已有行则复用不重建（二次 @ 复用同一 opencode sessionId，
   * reuseSession=true 时保留 TaskGroupInstance，Do NOT 每任务重建）。唯一键保持 uk_sessions_task_agent，
   * 上层按 teamMemberId 维度复用（兼容回退 taskAgentId 快照关联）。
   */
  async bindSessionToWorker(
    sessionId: string,
    workerId: string,
    instanceId: string,
  ) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { id: true, taskId: true },
      });
      if (!session) {
        throw new NotFoundException({
          code: SESSION_ERRORS.SESSION_NOT_FOUND,
          message: `会话 ${sessionId} 不存在`,
        });
      }
      // 幂等：同 (taskId, workerId, instanceId) 已有实例行则复用（二次 @ 复用同一 opencode 会话）
      const existing = await tx.taskGroupInstance.findFirst({
        where: { taskId: session.taskId, workerId, instanceId },
        select: { id: true },
      });
      const instanceRowId =
        existing?.id ??
        (
          await tx.taskGroupInstance.create({
            data: {
              id: await this.idGen.nextId(TASK_GROUP_INSTANCE_ID_PREFIX),
              taskId: session.taskId,
              workerId,
              instanceId,
            },
          })
        ).id;

      await tx.session.update({
        where: { id: sessionId },
        data: {
          workerId,
          instanceRef: instanceId,
          status: SESSION_STATUS.active,
        },
      });

      return {
        sessionId,
        taskId: session.taskId,
        workerId,
        instanceId,
        instanceRowId,
      };
    });
  }

  /**
   * 解绑 Session → worker（F2 M5：分派失败回滚绑定，防 Session 绑坏 worker 永不重分配）。
   *
   * 事务内：查 Session（不存在 → 404 SESSION_NOT_FOUND）→ 实例行软移除（removedAt=now，
   * workerId+instanceRef 已写时）→ 清 Session.workerId/instanceRef + status=created。
   * 幂等：重复调用不报错（updateMany 命中 0 行 + session.update 重复写同值）。
   */
  async unbindSession(sessionId: string) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { id: true, taskId: true, workerId: true, instanceRef: true },
      });
      if (!session) {
        throw new NotFoundException({
          code: SESSION_ERRORS.SESSION_NOT_FOUND,
          message: `会话 ${sessionId} 不存在`,
        });
      }
      if (session.workerId && session.instanceRef) {
        await tx.taskGroupInstance.updateMany({
          where: {
            taskId: session.taskId,
            workerId: session.workerId,
            instanceId: session.instanceRef,
            removedAt: null,
          },
          data: { removedAt: new Date() },
        });
      }
      await tx.session.update({
        where: { id: sessionId },
        data: {
          workerId: null,
          instanceRef: null,
          status: SESSION_STATUS.created,
        },
      });
      return { sessionId, unbound: true };
    });
  }

  /**
   * 批量重置团队会话（Todo7 记忆开关）：
   * 对该团队所有 TeamMember 对应的 Session 行批量执行 resetInstanceSession 语义：
   * soft-remove TaskGroupInstance 先于 delete，再 delete 旧 Session 并 create 新 s_ 行（created，workerId/instanceRef 清空）。
   * 在调用方事务内执行（accept/archive 同事务或手动 reset 事务），Memory 表不动。
   * 返回重置的会话数。
   */
  async resetTeamSessionsInTx(
    tx: Prisma.TransactionClient,
    teamId: string,
  ): Promise<number> {
    const members = await (tx as any).teamMember.findMany({
      where: { teamId },
      select: { id: true },
    });
    if (!members || members.length === 0) return 0;
    const memberIds = members.map((m: { id: string }) => m.id);
    const sessions = await (tx as any).session.findMany({
      where: { teamMemberId: { in: memberIds } },
      select: {
        id: true,
        taskId: true,
        taskAgentId: true,
        agentId: true,
        teamMemberId: true,
        workerId: true,
        instanceRef: true,
      },
    });
    if (!sessions || sessions.length === 0) return 0;
    // soft-remove 先于 delete（MUST DO）
    for (const s of sessions as Array<{
      taskId: string;
      workerId: string | null;
      instanceRef: string | null;
    }>) {
      if (s.workerId && s.instanceRef) {
        await (tx as any).taskGroupInstance.updateMany({
          where: {
            taskId: s.taskId,
            workerId: s.workerId,
            instanceId: s.instanceRef,
            removedAt: null,
          },
          data: { removedAt: new Date() },
        });
      }
    }
    const ids = (sessions as Array<{ id: string }>).map((s) => s.id);
    await (tx as any).session.deleteMany({ where: { id: { in: ids } } });
    for (const s of sessions as Array<{
      taskId: string;
      taskAgentId: string;
      agentId: string;
      teamMemberId: string | null;
    }>) {
      await (tx as any).session.create({
        data: {
          id: await this.idGen.nextId('s'),
          taskId: s.taskId,
          taskAgentId: s.taskAgentId,
          agentId: s.agentId,
          teamMemberId: s.teamMemberId,
          status: SESSION_STATUS.created,
        },
      });
    }
    return sessions.length;
  }

  /** 兼容：单团队批量重置（事务外入口，供 TeamsService 手动调用事务包装前置）。 */
  async resetTeamSessions(teamId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      return this.resetTeamSessionsInTx(tx as unknown as Prisma.TransactionClient, teamId);
    });
  }

  /** 查询任务的全部 opencode 会话实例（未移除，createdAt 倒序；供任务页/调度）。 */
  async getInstancesByTask(taskId: string): Promise<TaskGroupInstanceRow[]> {
    return this.prisma.taskGroupInstance.findMany({
      where: { taskId, removedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 查询会话绑定的 opencode 实例（供 T10 判断二次 @ 是否复用已有实例）。
   * 会话未绑定 worker/instanceRef（created 态）→ null；实例行已移除 → null。
   */
  async getInstanceBySession(
    sessionId: string,
  ): Promise<TaskGroupInstanceRow | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { taskId: true, workerId: true, instanceRef: true },
    });
    if (!session || !session.workerId || !session.instanceRef) {
      return null;
    }
    return this.prisma.taskGroupInstance.findFirst({
      where: {
        taskId: session.taskId,
        workerId: session.workerId,
        instanceId: session.instanceRef,
        removedAt: null,
      },
    });
  }
}
