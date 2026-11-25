import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SESSION_STATUS } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import {
  isWorkerSessionInvalid,
  WorkerClient,
  WorkerEndpointRef,
} from './worker.client';
import {
  GLOBAL_SESSION_ERRORS,
  SESSION_TURN_STATUS,
} from './global-session.constants';

/** TaskGroupInstance 主键前缀（15 篇 §2.2：<prefix>_<零填充序号>）。 */
const TASK_GROUP_INSTANCE_ID_PREFIX = 'ti';

/** Session 主键前缀（15 篇 §2.2：<prefix>_<零填充序号>）。 */
const SESSION_ID_PREFIX = 's';

/** 首次 bind 的 instanceRef 占位（真实 opencode 会话尚未创建）。 */
const PENDING_INSTANCE_REF = 'pending';

/** 会话健康探测超时（ms）：探测只是「决定要不要重建」，不能拖住用户的那条消息。 */
const ENGINE_PROBE_TIMEOUT_MS = 5_000;

/** 给 Promise 加超时（超时 reject，调用方按 unknown 处理）。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`engine probe timeout after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 「引擎会话已坏」的失败计数阈值（只对**不体现 404** 的引擎生效，当前是 DSH）。
 *
 * 为什么需要：opencode 的 serve 重启/会话被删会明确回 404，探活即可判定；而 DSH 的
 * 坏会话（sessionController service unavailable / 会话文件损坏）仍然会正常响应
 * `GET /sessions/:id/messages`，探活看不出问题 ⇒ 只能靠「同一 instanceRef 连续 N 轮
 * 都失败」兜底。N=3 是经验值：偶发两次上游抖动不该丢掉 agent 的连续上下文。
 */
export const SESSION_REBUILD_FAILURE_THRESHOLD = 3;

/**
 * 引擎会话健康探测结果：
 * - `alive`   —— 引擎侧会话还在（可继续投递，等价用户说「继续」）；
 * - `gone`    —— 引擎侧会话确实不存在（HTTP 404，只能重建）；
 * - `unknown` —— 探测不了（worker 不可达/超时/报错）⇒ **按 alive 处理**（见 decideRevive）。
 */
export type EngineSessionProbe = 'alive' | 'gone' | 'unknown';

/** failed 会话的处置：`keep` = 保留引擎会话绑定继续用；`rebuild` = 清绑定新建。 */
export type ReviveAction = 'keep' | 'rebuild';

const SESSION_ERRORS = {
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  TEAM_MEMBER_NOT_FOUND: 'TEAM_MEMBER_NOT_FOUND',
  TEAM_SESSION_MISSING_DIMENSION: 'TEAM_SESSION_MISSING_DIMENSION',
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
 * 会话生命周期服务（T12，架构决策 D3；Todo10 team-only）：
 * Session.workerId/instanceRef 写入路径 + status=active + TaskGroupInstance 落库。
 * 只认团队行（Session.teamId/teamMemberId）：同一 TeamMember 二次 @
 * 复用同一 opencode sessionId 时，instanceRef 保持不变，TaskGroupInstance 幂等复用不重建。
 * 任务仅归因：taskId 只随 session 行透传返回，不参与任何实例键。
 *
 * - bindSessionToWorker：分派时把 Session 绑定到 worker（写 workerId + instanceRef + status=active），
 *   同事务写 TaskGroupInstance 行（id=ti_<seq>，instanceId = opencode sessionId）。
 *   幂等：同 (teamId, teamMemberId, workerId, instanceId) 已存在则复用（二次 @ 复用同一 opencode 会话，reuse=true 时不重建）。
 * - getInstancesByTeamMember / getInstanceBySession：供 WorkerDispatcher 调度复用与任务页查询。
 */
@Injectable()
export class SessionLifecycleService implements OnModuleInit {
  private readonly logger = new Logger(SessionLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    /**
     * 会话健康探测用（`GET /sessions/:id/messages`）。@Optional：存量单测零 provider
     * 构造仍可编译——缺席时探活一律返回 `unknown`，处置按 keep（内存优先），
     * 与「失败不再清 instanceRef」的目标一致。
     */
    @Optional()
    private readonly workerClient?: WorkerClient,
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
   * 绑定 Session → worker（WorkerDispatcher 首次分派调用，Todo10 team-only）。
   *
   * 事务内：查 Session（不存在 → 404）→ 团队维度校验（缺 teamId/teamMemberId →
   * 400 TEAM_SESSION_MISSING_DIMENSION）→ 幂等 upsert TaskGroupInstance →
   * 更新 Session.workerId + instanceRef + status=active。
   * 幂等：同 (teamId, teamMemberId, workerId, instanceId) 已有行则复用不重建
   * （二次 @ 复用同一 opencode 会话，reuseSession=true 时保留 TaskGroupInstance）。
   * 任务仅归因：taskId 只随 session 行透传返回，不参与实例键。
   */
  async bindSessionToWorker(
    sessionId: string,
    workerId: string,
    instanceId: string,
    /**
     * P3 成员全局会话：绑定时的归属维度（本轮 turn 的 team/seat）。
     * 不传 = 读 Session 行上的旧维度（存量行为逐字节不变）。
     * 全局会话的 team_member_id 是「最近席位」，跨群派发必须显式传本轮维度，
     * 否则 TaskGroupInstance 会归因到上一个群。
     */
    dims?: { teamId: string; teamMemberId: string },
  ) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { id: true, taskId: true, teamId: true, teamMemberId: true },
      });
      if (!session) {
        throw new NotFoundException({
          code: SESSION_ERRORS.SESSION_NOT_FOUND,
          message: `会话 ${sessionId} 不存在`,
        });
      }
      // team-only：只认团队行，无团队维度即错（成员全局会话用本轮 dims 覆盖）
      if (!dims && (!session.teamId || !session.teamMemberId)) {
        throw new BadRequestException({
          code: SESSION_ERRORS.TEAM_SESSION_MISSING_DIMENSION,
          message: `会话 ${sessionId} 缺少团队维度（teamId/teamMemberId），无法绑定 worker`,
        });
      }
      const teamId = dims?.teamId ?? session.teamId;
      const teamMemberId = dims?.teamMemberId ?? session.teamMemberId;
      const existing = await tx.taskGroupInstance.findFirst({
        where: { teamId, teamMemberId, workerId, instanceId },
        select: { id: true },
      });
      const instanceRowId =
        existing?.id ??
        (
          await tx.taskGroupInstance.create({
            data: {
              id: await this.idGen.nextId(TASK_GROUP_INSTANCE_ID_PREFIX),
              taskId: null,
              teamId,
              teamMemberId,
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
   * 处置一条 `status=failed` 的会话（**事务外**，可能含网络探测）。
   *
   * 这是「失败后不丢上下文」的唯一出口：
   * - `keep`    —— 保留 workerId/instanceRef，只把 status 复位（下一条消息仍打进
   *                同一个引擎会话，等价用户说「继续」）；
   * - `rebuild` —— 软移除旧实例行 + 清绑定 + status=created（下一轮 createSession 新建）。
   *
   * 幂等：并发两路同时进来时，第二次读到 status 已不是 failed 就直接返回。
   */
  async reviveFailedSession(
    sessionId: string,
    dims?: { teamId?: string | null; teamMemberId?: string | null },
  ): Promise<{
    revived: boolean;
    action: ReviveAction | null;
    reason?: string;
  }> {
    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        teamId: true,
        teamMemberId: true,
        workerId: true,
        instanceRef: true,
        consecutiveFailures: true,
      },
    });
    if (!row || row.status !== SESSION_STATUS.failed) {
      return { revived: false, action: null };
    }
    const decision = await this.decideRevive({
      workerId: row.workerId,
      instanceRef: row.instanceRef,
      consecutiveFailures: row.consecutiveFailures,
    });
    const teamId = dims?.teamId ?? row.teamId;
    const teamMemberId = dims?.teamMemberId ?? row.teamMemberId;
    if (decision.action === 'keep') {
      // 保留绑定：只把「上一轮失败」这个状态复位，绑定与计数一律不动。
      await this.prisma.session.updateMany({
        where: { id: sessionId, status: SESSION_STATUS.failed },
        data: { status: SESSION_STATUS.idle, busyState: 'idle' },
      });
      this.logger.log(
        `[session-revive] 会话 ${sessionId} 判失败但引擎会话保留（${decision.reason}）` +
          ` instanceRef=${row.instanceRef ?? '-'} 连续失败=${row.consecutiveFailures}`,
      );
      return { revived: true, action: 'keep', reason: decision.reason };
    }
    // rebuild：旧引擎会话已不可用 —— 软移除实例行、清绑定、计数归零。
    if (row.workerId && row.instanceRef) {
      await this.prisma.taskGroupInstance.updateMany({
        where: {
          teamId: teamId ?? undefined,
          teamMemberId: teamMemberId ?? undefined,
          workerId: row.workerId,
          instanceId: row.instanceRef,
          removedAt: null,
        },
        data: { removedAt: new Date() },
      });
    }
    await this.prisma.session.updateMany({
      where: { id: sessionId, status: SESSION_STATUS.failed },
      data: {
        workerId: null,
        instanceRef: null,
        status: SESSION_STATUS.created,
        busyState: 'idle',
        consecutiveFailures: 0,
      },
    });
    this.logger.warn(
      `[session-revive] 会话 ${sessionId} 重建引擎会话（${decision.reason}）` +
        ` 旧实例=${row.instanceRef ?? '-'} 连续失败=${row.consecutiveFailures}`,
    );
    return { revived: true, action: 'rebuild', reason: decision.reason };
  }

  /**
   * 探测引擎侧会话是否还活着（`GET /sessions/:id/messages`）。
   *
   * 判定口径（**只认 404 为「没了」**）：
   * - 200 → `alive`；
   * - 404 + SESSION_NOT_FOUND → `gone`（serve 重启/会话被删，只能重建）；
   * - 其余（worker 不可达、超时、5xx、未注入 client）→ `unknown`。
   *
   * 为什么 5xx/网络错误不算 gone：那说明我们**没能力判断**，此时清掉 instanceRef
   * 等于凭一次抖动丢掉 agent 的连续上下文——宁可保留，让下一轮自己再判。
   */
  async probeEngineSession(
    workerId: string | null,
    instanceRef: string | null,
    opts: { timeoutMs?: number } = {},
  ): Promise<EngineSessionProbe> {
    if (!workerId || !instanceRef || !this.workerClient) {
      return 'unknown';
    }
    if (instanceRef === PENDING_INSTANCE_REF) {
      // 占位引用：从没建过真实会话，不是「坏」，只是待建。
      return 'unknown';
    }
    try {
      const workerRow = await this.prisma.worker.findUnique({
        where: { id: workerId },
        select: { id: true, capabilities: true },
      });
      if (!workerRow) {
        return 'unknown';
      }
      const ref: WorkerEndpointRef = {
        id: workerRow.id,
        capabilities: workerRow.capabilities as Record<string, unknown>,
      };
      await withTimeout(
        this.workerClient.getMessages(ref, instanceRef, { limit: 1 }),
        opts.timeoutMs ?? ENGINE_PROBE_TIMEOUT_MS,
      );
      return 'alive';
    } catch (err) {
      if (isWorkerSessionInvalid(err)) {
        return 'gone';
      }
      this.logger.warn(
        `引擎会话健康探测失败 worker=${workerId} session=${instanceRef}（按未知处理，保留绑定）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'unknown';
    }
  }

  /**
   * 决定 `status=failed` 会话该「保留引擎会话继续」还是「清绑定重建」。
   *
   * 用户口径（2026-11-25 线上事故 s_0000000018 之后确认）：
   * **失败 ≠ 会话已坏**。复活的预期是「往同一个会话再发一条消息（像人说『继续』）」，
   * 而不是换一个新会话——换会话等于把 agent 的连续上下文清零。
   *
   * 判定顺序：
   * 1. 探活 `gone`（HTTP 404）→ `rebuild`：会话在引擎侧确实没了，保留绑定只会一直 404；
   * 2. 探活 `alive` → `keep`：会话健康，直接继续（**这是绝大多数失败**）；
   * 3. 探活 `unknown`（worker 不可达/未注入 client）→ `keep`：没证据说明会话坏了，
   *    不做破坏性操作（下一轮探活/失败计数会再判）；
   * 4. DSH 等「坏会话不体现 404」的引擎：`consecutiveFailures >= 阈值` → `rebuild`。
   */
  async decideRevive(input: {
    workerId: string | null;
    instanceRef: string | null;
    consecutiveFailures?: number | null;
  }): Promise<{
    action: ReviveAction;
    probe: EngineSessionProbe;
    reason: string;
  }> {
    const failures = input.consecutiveFailures ?? 0;
    const probe = await this.probeEngineSession(
      input.workerId,
      input.instanceRef,
    );
    if (probe === 'gone') {
      return {
        action: 'rebuild',
        probe,
        reason: '引擎会话不存在（HTTP 404），只能新建',
      };
    }
    if (failures >= SESSION_REBUILD_FAILURE_THRESHOLD) {
      return {
        action: 'rebuild',
        probe,
        reason: `同一引擎会话连续失败 ${failures} 次（≥${SESSION_REBUILD_FAILURE_THRESHOLD}），判定会话已坏`,
      };
    }
    return {
      action: 'keep',
      probe,
      reason:
        probe === 'alive'
          ? '引擎会话仍健康，保留绑定继续（不新建会话）'
          : '探测不可用（按未知处理），保留绑定继续（不做破坏性操作）',
    };
  }

  /**
   * 团队会话确保存在（team-free-chat 无任务直聊）：
   * 按 uk_sessions_team_member 键（team_member_key = teamId|teamMemberId，仅 task_id 为空行参与）
   * 查找，命中则复用，未命中则创建 `{teamId 必填，taskId 置空}` 行。
   * 与 bindSessionToWorker 同事务风格；bind 仅绑定既有行（缺失 404），创建走本方法。
   */
  async ensureTeamSession(teamId: string, teamMemberId: string) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const member = await tx.teamMember.findUnique({
        where: { id: teamMemberId },
        select: { id: true, teamId: true, agentId: true },
      });
      if (!member || member.teamId !== teamId) {
        throw new NotFoundException({
          code: SESSION_ERRORS.TEAM_MEMBER_NOT_FOUND,
          message: `团队成员 ${teamMemberId} 不在团队 ${teamId} 内`,
        });
      }
      const teamMemberKey = `${teamId}|${teamMemberId}`;
      const existing = await tx.session.findUnique({
        where: { teamMemberKey },
        select: {
          id: true,
          teamId: true,
          teamMemberId: true,
          agentId: true,
          workerId: true,
          instanceRef: true,
          status: true,
        },
      });
      if (existing) {
        // failed 会话的处置已上移到 reviveFailedSession（事务外先探活再决定），
        // 这里命中 failed 只可能是并发窗口（另一条分派刚判败）——按普通复用返回，
        // 由下一次分派走同一套探活判定（绝不在事务内做网络探测）。
        return { ...existing, reused: true };
      }
      const select = {
        id: true,
        teamId: true,
        teamMemberId: true,
        agentId: true,
        workerId: true,
        instanceRef: true,
        status: true,
      };
      try {
        const created = await tx.session.create({
          data: {
            id: await this.idGen.nextId(SESSION_ID_PREFIX),
            teamId,
            teamMemberId,
            agentId: member.agentId,
            taskId: null,
            status: SESSION_STATUS.created,
          },
          select,
        });
        return { ...created, reused: false };
      } catch (err) {
        // 并发竞态：两分派同时 findUnique 未命中后同键 create → P2002，重读复用胜者行
        if ((err as { code?: string })?.code === 'P2002') {
          this.logger.warn(
            `ensureTeamSession 并发竞态 teamMemberKey=${teamMemberKey}，重读复用`,
          );
          const raced = await tx.session.findUnique({
            where: { teamMemberKey },
            select,
          });
          if (raced) {
            return { ...raced, reused: true };
          }
        }
        throw err;
      }
    });
  }

  /**
   * 全局会话确保存在（37 篇 P3）：按成员维度（member_key = member_id，仅 team-mode 行）
   * 查找命中则复用；未命中则创建一条 team-mode 会话，并把当前上下文（最近席位/团队/
   * 频道/任务）写入 current_* 便捷列。**current_* 仅供展示/兼容，鉴权/落库以
   * session_turns 冻结的轮次为准**。
   *
   * 本方法只建/取会话，不执行轮次；轮次入队/认领/收口见 SessionTurnsService。
   */
  async ensureMemberSession(
    memberId: string,
    context: {
      seatId?: string | null;
      teamId?: string | null;
      taskId?: string | null;
      channelId?: string | null;
    } = {},
  ) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const member = await tx.member.findUnique({
        where: { id: memberId },
        select: { id: true, name: true, status: true, agentId: true },
      });
      if (!member) {
        throw new NotFoundException({
          code: GLOBAL_SESSION_ERRORS.MEMBER_NOT_FOUND,
          message: `成员 ${memberId} 不存在`,
        });
      }
      if (member.status !== 'active') {
        throw new BadRequestException({
          code: GLOBAL_SESSION_ERRORS.MEMBER_DISABLED,
          message: `成员 ${member.name} 已停用`,
        });
      }

      const select = {
        id: true,
        memberId: true,
        memberKey: true,
        seatId: true,
        currentTeamId: true,
        currentTaskId: true,
        currentChannelId: true,
        agentId: true,
        workerId: true,
        instanceRef: true,
        status: true,
        busyState: true,
        turnSeq: true,
      } as const;

      const memberKey = memberId;
      const existing = await tx.session.findUnique({
        where: { memberKey },
        select,
      });
      if (existing) {
        // failed 会话的处置见 reviveFailedSession（事务外探活后决定是否重建）。
        // 上下文只在调用方显式给出时更新（不覆盖未提供的维度）。
        const data: Record<string, unknown> = {};
        if (context.seatId !== undefined) data.seatId = context.seatId;
        if (context.teamId !== undefined) {
          data.currentTeamId = context.teamId;
          data.teamId = context.teamId;
        }
        if (context.taskId !== undefined) data.currentTaskId = context.taskId;
        if (context.channelId !== undefined) {
          data.currentChannelId = context.channelId;
        }
        if (Object.keys(data).length > 0) {
          const updated = await tx.session.update({
            where: { id: existing.id },
            data: data as never,
            select,
          });
          return { ...updated, reused: true };
        }
        return { ...existing, reused: true };
      }

      try {
        const created = await tx.session.create({
          data: {
            id: await this.idGen.nextId(SESSION_ID_PREFIX),
            memberId,
            memberKey,
            seatId: context.seatId ?? null,
            currentTeamId: context.teamId ?? null,
            currentTaskId: context.taskId ?? null,
            currentChannelId: context.channelId ?? null,
            // 旧列语义降级为「最近上下文」：team-only 视图仍能读到 teamId/teamMemberId。
            teamId: context.teamId ?? null,
            teamMemberId: context.seatId ?? null,
            taskId: null,
            agentId: member.agentId,
            status: SESSION_STATUS.created,
          },
          select,
        });
        return { ...created, reused: false };
      } catch (err) {
        // 并发竞态：两个入口同时 findUnique 未命中后 create 同 memberKey → P2002
        if ((err as { code?: string })?.code === 'P2002') {
          this.logger.warn(
            `ensureMemberSession 并发竞态 memberKey=${memberKey}，重读复用`,
          );
          const raced = await tx.session.findUnique({
            where: { memberKey },
            select,
          });
          if (raced) return { ...raced, reused: true };
        }
        throw err;
      }
    });
  }

  /** 读取成员全局会话（不存在返回 null；只读，不创建）。 */
  async findMemberSession(memberId: string) {
    return this.prisma.session.findUnique({
      where: { memberKey: memberId },
      select: {
        id: true,
        memberId: true,
        seatId: true,
        currentTeamId: true,
        currentTaskId: true,
        currentChannelId: true,
        agentId: true,
        workerId: true,
        instanceRef: true,
        status: true,
        busyState: true,
        busySince: true,
        turnSeq: true,
        lastTurnOutcome: true,
      },
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
        select: {
          id: true,
          taskId: true,
          teamId: true,
          teamMemberId: true,
          workerId: true,
          instanceRef: true,
        },
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
            teamId: session.teamId,
            teamMemberId: session.teamMemberId,
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
        teamId: true,
        teamMemberId: true,
        agentId: true,
        workerId: true,
        instanceRef: true,
      },
    });
    if (!sessions || sessions.length === 0) return 0;
    // soft-remove 先于 delete（MUST DO），团队键定位实例行
    for (const s of sessions as Array<{
      teamId: string;
      teamMemberId: string;
      workerId: string | null;
      instanceRef: string | null;
    }>) {
      if (s.workerId && s.instanceRef) {
        await (tx as any).taskGroupInstance.updateMany({
          where: {
            teamId: s.teamId,
            teamMemberId: s.teamMemberId,
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
      teamId: string;
      teamMemberId: string | null;
      agentId: string;
    }>) {
      await (tx as any).session.create({
        data: {
          id: await this.idGen.nextId('s'),
          teamId: s.teamId,
          teamMemberId: s.teamMemberId,
          agentId: s.agentId,
          taskId: null,
          status: SESSION_STATUS.created,
        },
      });
    }
    return sessions.length;
  }

  /**
   * 成员级全局会话重置（37 篇 §3.6.6 / P3）。
   *
   * 语义：丢弃该成员当前引擎会话（跨群共享的记忆上下文），下一轮重新开引擎会话；
   * **不删除消息/记忆**，也不影响其他成员。任务完成不再自动重置，重置只由用户
   * 显式触发（成员卡/成员库）或运维操作。
   *
   * 步骤（单事务）：
   *  1) 找 member_key=memberId 的全局会话；无则 reset=0；
   *  2) 软移除该成员所有席位的 TaskGroupInstance（引擎实例可能来自多个群）；
   *  3) 未完成轮次置 cancelled（保留审计，不用删除）；
   *  4) 删旧会话行 → 以同一 member_key/member_id 建新 team-mode 会话（回收序号靠 idGen）。
   */
  async resetMemberSession(memberId: string, opts: { reason?: string } = {}) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const session = await tx.session.findUnique({
        where: { memberKey: memberId },
        select: {
          id: true,
          memberId: true,
          agentId: true,
          seatId: true,
          currentTeamId: true,
          currentTaskId: true,
          currentChannelId: true,
        },
      });
      if (!session) {
        return { reset: 0, sessionId: null as string | null };
      }
      const member = await tx.member.findUnique({
        where: { id: memberId },
        select: { id: true, name: true, status: true, agentId: true },
      });
      if (!member) {
        throw new NotFoundException({
          code: GLOBAL_SESSION_ERRORS.MEMBER_NOT_FOUND,
          message: `成员 ${memberId} 不存在`,
        });
      }

      const seats = await tx.teamMember.findMany({
        where: { memberId },
        select: { id: true, teamId: true },
      });
      for (const seat of seats) {
        await (tx as any).taskGroupInstance.updateMany({
          where: {
            teamId: seat.teamId,
            teamMemberId: seat.id,
            removedAt: null,
          },
          data: { removedAt: new Date() },
        });
      }

      await (tx as any).sessionTurn.updateMany({
        where: {
          sessionId: session.id,
          status: {
            in: [SESSION_TURN_STATUS.pending, SESSION_TURN_STATUS.running],
          },
        },
        data: {
          status: SESSION_TURN_STATUS.cancelled,
          runningKey: null,
          endedAt: new Date(),
          error: opts.reason ?? 'member_session_reset',
        },
      });

      await tx.session.delete({ where: { id: session.id } });
      const created = await tx.session.create({
        data: {
          id: await this.idGen.nextId(SESSION_ID_PREFIX),
          memberId,
          memberKey: memberId,
          seatId: session.seatId,
          currentTeamId: session.currentTeamId,
          currentTaskId: session.currentTaskId,
          currentChannelId: session.currentChannelId,
          teamId: session.currentTeamId,
          teamMemberId: session.seatId,
          taskId: null,
          agentId: member.agentId,
          status: SESSION_STATUS.created,
        },
        select: { id: true },
      });
      this.logger.log(
        `成员全局会话已重置 member=${memberId} 旧会话=${session.id} 新会话=${created.id}`,
      );
      return { reset: 1, sessionId: created.id };
    });
  }

  /**
   * **成员配置变更（模型/首选 worker）后重置其全部会话绑定**（vteam 修：模型设置无效）。
   *
   * 为什么需要：成员改模型只更新 member 行，已绑定会话的 workerId/instanceRef
   * 不变；下回合分派直接复用旧会话 → 每回合 ensureModelFor 对旧会话
   * selectModel（DSH 侧常报 sessionController service unavailable）→ 回退重启
   * 运行时 → 首字超时，用户实测「改了模型也不生效、必须停会话再发」。
   *
   * 这里**只清绑定**（workerId/instanceRef + status=created + 软移除实例行），
   * 不删会话行、不动消息/记忆 → 下回合分派 createSession 新建干净引擎会话，
   * 新模型在 createSession 阶段即生效。覆盖两种 scope：
   *  - member-scope：memberKey = memberId 的全局会话；
   *  - team-scope： 该成员所有席位（teamMemberId）对应的会话。
   * 幂等：无绑定时 updateMany 命中 0 行，不报错。永不抛异常（fail-open）。
   */
  async resetSessionBindingsByMember(
    memberId: string,
    reason: string | { reason?: string } = 'member_config_changed',
  ) {
    const reasonText =
      typeof reason === 'string'
        ? reason
        : (reason.reason ?? 'member_config_changed');
    try {
      return await this.prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const seats = await tx.teamMember.findMany({
            where: { memberId },
            select: { id: true },
          });
          const seatIds = seats.map((s) => s.id);
          // team-scope 会话（teamMemberId in 席位）+ member-scope 全局会话（memberKey）
          const or: Array<Record<string, unknown>> = [];
          if (seatIds.length > 0) or.push({ teamMemberId: { in: seatIds } });
          or.push({ memberKey: memberId });
          const sessions = await tx.session.findMany({
            where: { OR: or },
            select: {
              id: true,
              teamId: true,
              teamMemberId: true,
              workerId: true,
              instanceRef: true,
            },
          });
          for (const s of sessions) {
            if (s.workerId && s.instanceRef) {
              await tx.taskGroupInstance.updateMany({
                where: {
                  teamId: s.teamId,
                  teamMemberId: s.teamMemberId,
                  workerId: s.workerId,
                  instanceId: s.instanceRef,
                  removedAt: null,
                },
                data: { removedAt: new Date() },
              });
            }
          }
          const result = await tx.session.updateMany({
            where: { OR: or },
            data: {
              workerId: null,
              instanceRef: null,
              status: SESSION_STATUS.created,
              busyState: 'idle',
            },
          });
          this.logger.log(
            `成员配置变更重置会话绑定 member=${memberId} reason=${reasonText} 会话数=${sessions.length} 命中=${result.count}`,
          );
          return { reset: result.count };
        },
      );
    } catch (err) {
      // fail-open：绑定重置失败不阻断配置更新（最坏沿用旧会话，下轮 ensure 兜底）
      this.logger.warn(
        `成员配置变更重置会话绑定失败 member=${memberId}：${(err as Error)?.message ?? err}`,
      );
      return { reset: 0 };
    }
  }

  /** 兼容：单团队批量重置（事务外入口，供 TeamsService 手动调用事务包装前置）。 */
  async resetTeamSessions(teamId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      return this.resetTeamSessionsInTx(
        tx as unknown as Prisma.TransactionClient,
        teamId,
      );
    });
  }

  /** 查询成员的全部 opencode 会话实例（未移除，createdAt 倒序；供任务页/调度）。 */
  async getInstancesByTeamMember(
    teamId: string,
    teamMemberId: string,
  ): Promise<TaskGroupInstanceRow[]> {
    return this.prisma.taskGroupInstance.findMany({
      where: { teamId, teamMemberId, removedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 查询会话绑定的 opencode 实例（供 T10 判断二次 @ 是否复用已有实例）。
   * 会话未绑定 worker/instanceRef（created 态）或无团队维度 → null；实例行已移除 → null。
   */
  async getInstanceBySession(
    sessionId: string,
  ): Promise<TaskGroupInstanceRow | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        teamId: true,
        teamMemberId: true,
        workerId: true,
        instanceRef: true,
      },
    });
    if (
      !session ||
      !session.teamId ||
      !session.teamMemberId ||
      !session.workerId ||
      !session.instanceRef
    ) {
      return null;
    }
    return this.prisma.taskGroupInstance.findFirst({
      where: {
        teamId: session.teamId,
        teamMemberId: session.teamMemberId,
        workerId: session.workerId,
        instanceId: session.instanceRef,
        removedAt: null,
      },
    });
  }
}
