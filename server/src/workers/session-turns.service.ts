import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import {
  GLOBAL_SESSION_ERRORS,
  SESSION_BUSY_STATE,
  SESSION_TURN_OUTCOME,
  SESSION_TURN_SOURCE,
  SESSION_TURN_STATUS,
  type SessionTurnSource,
  type SessionTurnStatus,
} from './global-session.constants';

/** session_turns 主键前缀（st_）。 */
const SESSION_TURN_ID_PREFIX = 'st';

export interface EnqueueTurnInput {
  sessionId: string;
  memberId: string;
  seatId?: string | null;
  teamId?: string | null;
  channelId?: string | null;
  taskId?: string | null;
  messageId?: string | null;
  source?: SessionTurnSource;
}

/**
 * 会话轮次台账（37 篇 §3.6.2/§3.6.3）。
 *
 * 产品已明确「不做排队/流控」：本服务**只做执行台账与互斥兜底**，不设优先级、
 * 队列深度、公平性，也不向用户暴露排队位次。
 * - enqueue：消息到达即落一条 pending（不拒绝）
 * - claimNext：取最早 pending 置 running；running_key 唯一索引保证每会话至多一轮在飞
 * - finish：收口本轮并清 busy_state（异常轮不会卡死后续消息）
 */
@Injectable()
export class SessionTurnsService {
  private readonly logger = new Logger(SessionTurnsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(
      this.prisma.sessionTurn,
      SESSION_TURN_ID_PREFIX,
      this.idGen,
    );
  }

  /** 入队一轮（pending）。同一消息重复入队由调用方用 messageId 幂等，本层不查重。 */
  async enqueue(input: EnqueueTurnInput) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const session = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { id: true, memberId: true },
      });
      if (!session) {
        throw new NotFoundException({
          code: GLOBAL_SESSION_ERRORS.SESSION_NOT_FOUND,
          message: `会话 ${input.sessionId} 不存在`,
        });
      }
      if (session.memberId && session.memberId !== input.memberId) {
        throw new BadRequestException({
          code: GLOBAL_SESSION_ERRORS.SESSION_TURN_MEMBER_MISMATCH,
          message: '轮次成员与会话归属成员不一致',
        });
      }
      const bumped = await tx.session.update({
        where: { id: input.sessionId },
        data: { turnSeq: { increment: 1 } },
        select: { turnSeq: true },
      });
      return tx.sessionTurn.create({
        data: {
          id: await this.idGen.nextId(SESSION_TURN_ID_PREFIX),
          sessionId: input.sessionId,
          seq: bumped.turnSeq,
          memberId: input.memberId,
          seatId: input.seatId ?? null,
          teamId: input.teamId ?? null,
          channelId: input.channelId ?? null,
          taskId: input.taskId ?? null,
          messageId: input.messageId ?? null,
          source: input.source ?? SESSION_TURN_SOURCE.userMention,
          status: SESSION_TURN_STATUS.pending,
        },
      });
    });
  }

  /**
   * 认领最早一轮 pending → running。
   * 返回 null 表示当前没有待执行轮次或已有在飞轮次（调用方等 finish 后再次 claim）。
   */
  async claimNext(sessionId: string) {
    try {
      return await this.prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const running = await tx.sessionTurn.findFirst({
            where: {
              sessionId,
              status: SESSION_TURN_STATUS.running,
            },
            select: { id: true },
          });
          if (running) return null;

          const pending = await tx.sessionTurn.findFirst({
            where: { sessionId, status: SESSION_TURN_STATUS.pending },
            orderBy: { seq: 'asc' },
            select: { id: true },
          });
          if (!pending) return null;

          const claimed = await tx.sessionTurn.updateMany({
            where: { id: pending.id, status: SESSION_TURN_STATUS.pending },
            data: {
              status: SESSION_TURN_STATUS.running,
              runningKey: sessionId,
              startedAt: new Date(),
            },
          });
          if (claimed.count === 0) return null;

          await tx.session.update({
            where: { id: sessionId },
            data: {
              busyState: SESSION_BUSY_STATE.running,
              busySince: new Date(),
            },
          });
          return tx.sessionTurn.findUnique({ where: { id: pending.id } });
        },
      );
    } catch (err) {
      // running_key 唯一索引竞态：另一并发认领先占了在飞槽位 → 本轮空转，下一轮再认领。
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.warn(
          `claimNext 并发竞态 session=${sessionId}，跳过本次认领`,
        );
        return null;
      }
      throw err;
    }
  }

  /**
   * 收口一轮：done/failed/cancelled/expired；清 running_key 与 busy_state。
   * 异常/超时也必须调用，否则该成员后续消息无法继续执行（不是产品限流，是台账一致性）。
   */
  async finish(
    turnId: string,
    status: Extract<
      SessionTurnStatus,
      'done' | 'failed' | 'cancelled' | 'expired'
    >,
    opts: { error?: string | null; engineMessageId?: string | null } = {},
  ) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const turn = await tx.sessionTurn.findUnique({
        where: { id: turnId },
        select: { id: true, sessionId: true, status: true },
      });
      if (!turn) {
        throw new NotFoundException({
          code: GLOBAL_SESSION_ERRORS.SESSION_TURN_NOT_FOUND,
          message: `轮次 ${turnId} 不存在`,
        });
      }
      await tx.sessionTurn.update({
        where: { id: turnId },
        data: {
          status,
          runningKey: null,
          endedAt: new Date(),
          error: opts.error ?? null,
          engineMessageId: opts.engineMessageId ?? null,
        },
      });
      const outcome =
        status === SESSION_TURN_STATUS.done
          ? SESSION_TURN_OUTCOME.ok
          : status === SESSION_TURN_STATUS.failed
            ? SESSION_TURN_OUTCOME.error
            : status === SESSION_TURN_STATUS.expired
              ? SESSION_TURN_OUTCOME.timeout
              : SESSION_TURN_OUTCOME.cancelled;
      await tx.session.update({
        where: { id: turn.sessionId },
        data: {
          busyState: SESSION_BUSY_STATE.idle,
          busySince: null,
          lastTurnOutcome: outcome,
        },
      });
      return { turnId, sessionId: turn.sessionId, status, outcome };
    });
  }

  /** 待执行轮次（信息展示/运维排障用，不对外暴露位次）。 */
  async listPending(sessionId: string) {
    return this.prisma.sessionTurn.findMany({
      where: { sessionId, status: SESSION_TURN_STATUS.pending },
      orderBy: { seq: 'asc' },
      select: {
        id: true,
        seq: true,
        teamId: true,
        channelId: true,
        source: true,
        enqueuedAt: true,
      },
    });
  }
}
