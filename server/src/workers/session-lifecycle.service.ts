import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SESSION_STATUS } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
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
 * 会话生命周期服务（T12，架构决策 D3）：
 * Session.workerId/instanceRef 写入路径 + status=active + TaskGroupInstance 落库。
 *
 * - bindSessionToWorker：分派时把 Session 绑定到 worker（写 workerId + instanceRef + status=active），
 *   同事务写 TaskGroupInstance 行（id=ti_<seq>，instanceId = opencode sessionId）。
 *   幂等：同 (taskId, workerId, instanceId) 的实例行已存在则复用而非报错，
 *   对齐「二次 @ 复用同一 opencode 会话」（plan D3）。
 * - getInstancesByTask / getInstanceBySession：供 T10 WorkerDispatcher 调度复用与任务页查询。
 */
@Injectable()
export class SessionLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /**
   * 绑定 Session → worker（T10 WorkerDispatcher 首次分派调用）。
   *
   * 事务内：查 Session（不存在 → 404 SESSION_NOT_FOUND）→ 幂等 upsert TaskGroupInstance →
   * 更新 Session.workerId + instanceRef + status=active。
   * 幂等语义：同 session 重复 bind 不报错（二次 @ 复用同一 opencode 会话时 workerId/instanceRef 更新，
   * TaskGroupInstance 实例行复用已有行）。
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
