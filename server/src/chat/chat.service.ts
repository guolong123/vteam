import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import {
  NON_TERMINAL_TASK_STATUSES,
  TASK_STATUS,
} from '../common/constants/task.constants';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { roleKeyOf } from '../common/agent-role-label';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerClient, WorkerEndpointRef } from '../workers/worker.client';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { isMemberSessionScope } from '../workers/session-scope';
import { CHAT_ERRORS } from './chat.constants';
import { CreateDmChannelDto } from './dto/create-dm-channel.dto';
import { CreateMessageDto, MentionInput } from './dto/create-message.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';
import { MessageDispatcher } from './message-dispatcher';
import {
  legacyAttachmentFields,
  normalizeMessageAttachments,
  toStoredAttachments,
} from './message-attachments';
import {
  concatText,
  isInjectedPromptPart,
  stripInjectedPromptParts,
} from './message-parts';

/** 消息主键前缀（15 篇 §2.2：m_<零填充序号>，数值序 == 字典序，兼作历史游标）。 */
const MESSAGE_ID_PREFIX = 'm';
const CHANNEL_ID_PREFIX = 'c';

/** @ 触发结果（09 篇 §5.1 triggers[]）。T6 实例语义：instanceId 为目标实例 id（同 agent
 * 多实例时区分触发目标，前端按实例收敛 loading）。 */
export interface TriggerResult {
  agentId: string;
  instanceId?: string | null;
  sessionId: string | null;
  status: 'dispatched' | 'no_session' | 'agent_removed' | 'agent_disabled';
}

/**
 * @ 触发结果轮询条目（09 篇 §3.5 GET :id/trigger-results/:messageId）：
 * 在 TriggerResult 基础上补 replyMessageId（该被 @ Agent 于原消息之后的回复消息 id）。
 */
export interface TriggerPollResult {
  agentId: string;
  instanceId?: string | null;
  status: 'dispatched' | 'no_session' | 'agent_removed' | 'agent_disabled';
  replyMessageId?: string;
}

/** 频道行（含可选的 task / team / agent / teamMember 关联，供 DTO 映射）。 */
type ChannelRow = {
  id: string;
  type: string;
  teamId?: string | null;
  teamMemberId?: string | null;
  taskId: string | null;
  agentId: string | null;
  pinned: boolean;
  lastReadAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  task?: {
    id: string;
    title: string;
    status: string;
    teamId?: string | null;
  } | null;
  team?: { id: string; name: string } | null;
  teamMember?: {
    id: string;
    agentId: string;
    alias: string | null;
    seq: number;
    /** 成员绑定角色（`TeamMember.roleId → AgentRole`）；未绑 → null。 */
    role?: { key: string; name: string } | null;
  } | null;
  agent?: { id: string; name: string } | null;
};

/**
 * 消息行（messages 表；content/mentions/attachments 为 Json 列，
 * 附件旧三字段可空 = 首个附件的兼容投影，见 message-attachments.ts）。
 */
type MessageRow = {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string | null;
  senderInstanceId?: string | null;
  content: Prisma.JsonValue;
  mentions: Prisma.JsonValue | null;
  attachments?: Prisma.JsonValue | null;
  attachmentUrl: string | null;
  attachmentName: string | null;
  attachmentType: string | null;
  status: string;
  createdAt: Date;
};

const TEAM_MEMBER_SELECT = {
  id: true,
  agentId: true,
  alias: true,
  seq: true,
  /** P3：成员全局会话键（旧席位未回填时为 null → 回落席位会话）。 */
  memberId: true,
} as const;

const CHANNEL_TASK_SELECT = {
  task: {
    select: {
      id: true,
      title: true,
      status: true,
      teamId: true,
    },
  },
  team: { select: { id: true, name: true } },
  teamMember: {
    select: {
      id: true,
      agentId: true,
      alias: true,
      seq: true,
      role: { select: { key: true, name: true } },
    },
  },
  agent: { select: { id: true, name: true } },
} as const;

/**
 * 群聊模块（09 篇 §3.5 Chat；10 篇 消息/频道/触发机制）。
 *
 * 端点：
 * - GET    /channels?type=           调用者可访问频道列表（team_group + private）
 * - GET    /channels/:id             频道信息（类型/关联任务/成员 Agent）
 * - GET    /channels/:id/messages    历史游标分页（09 篇 §2.2/§6）
 * - POST   /channels/:id/messages    发消息 8 步流程（09 篇 §5.1）
 * - POST   /dm-channels              创建 private 私聊频道（FR-14）
 * - DELETE /channels/:id             删除会话（UX-09 soft delete：deletedAt 置当前时间）
 * - PATCH  /channels/:id             置顶/取消置顶（UX-09 {pinned: boolean}）
 * - PATCH  /channels/:id/read        标记已读（UX-09 lastReadAt=now，channel 级简化）
 *
 * 权限：channel → taskId → teamId → teamUserMember 校验（service 层，
 * 路由参数是 :id（频道 id），团队归属需经频道反查任务/团队，
 * 故本模块自行解析频道归属，对齐 realtime 的团队可见性链路）。
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
    private readonly workerClient: WorkerClient,
    @Inject(MessageDispatcher)
    private readonly dispatcher: MessageDispatcher,
    /** P3：SESSION_SCOPE=member 时触发解析走成员全局会话；缺省（旧/单测）走席位会话。 */
    @Optional()
    private readonly sessionLifecycle?: SessionLifecycleService,
  ) {
    // 接通分派回调（计划 §5.1：onLoading/onFinal/onError）——仅日志，行为不变：
    // loading 广播 / 回复落库 + 广播均由分派器内部完成，此处不重复广播（否则改变
    // 现有 8 步流程时序）。Phase 4 WorkerDispatcher 同一回调契约零改动替换。
    this.dispatcher
      .onLoading((e) =>
        this.logger.debug(
          `agent ${e.agentId} loading(${e.phase}) task=${e.taskId}`,
        ),
      )
      .onFinal((e) =>
        this.logger.debug(
          `agent ${e.agentId} final ${e.messageId} task=${e.taskId}`,
        ),
      )
      .onError((e) =>
        this.logger.error(
          `agent ${e.agentId} reply failed: ${e.error} task=${e.taskId}`,
        ),
      );
  }

  /** 进程启动：按库内 m_/c_ 前缀纯数字序号最大值对齐（resyncIdPrefix 跳过非数字 id，防主键冲突）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.message, MESSAGE_ID_PREFIX, this.idGen);
    await resyncIdPrefix(
      this.prisma.chatChannel,
      CHANNEL_ID_PREFIX,
      this.idGen,
    );
  }

  async findAccessibleChannels(
    userId: string,
    type?: string,
    teamId?: string,
    taskId?: string,
  ) {
    if (
      type !== undefined &&
      type !== CHANNEL_TYPE.team_group &&
      type !== CHANNEL_TYPE.private
    ) {
      throw new BadRequestException({
        code: CHAT_ERRORS.CHANNEL_TYPE_INVALID,
        message: 'type 仅支持 team_group | private',
      });
    }
    let resolvedTeamId: string | undefined = teamId;
    if (!resolvedTeamId && taskId) {
      const task = await (this.prisma as any).task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      if (task?.teamId) resolvedTeamId = task.teamId;
    }
    // 调用者团队：channel → taskId → teamId → teamUserMember ——
    // 频道列表按调用者 team_user_members 的 teamIds 过滤（非成员无可见频道）。
    const memberships = await (this.prisma as any).teamUserMember.findMany({
      where: { userId },
      select: { teamId: true },
    });
    const callerTeamIds = [
      ...new Set(
        ((memberships ?? []) as Array<{ teamId?: string | null }>).map(
          (m) => m.teamId,
        ),
      ),
    ].filter((id): id is string => !!id);
    if (resolvedTeamId) {
      const team = await (this.prisma as any).team.findUnique({
        where: { id: resolvedTeamId },
        select: { id: true },
      });
      if (!team) {
        throw new NotFoundException({
          code: CHAT_ERRORS.TEAM_NOT_FOUND,
          message: '团队不存在',
        });
      }
      // 团队成员门（“团队是中心”）：调用者是该团队 team_user_members 成员时，
      // 团队归属即足够授权——直接列出频道；team_group 缺失时幂等补建
      // （seed 旁路建团队的缺口）。非成员返回空集（不泄漏频道存在性；
      // 发消息侧由 resolveChannelAccess 以 403 PERMISSION_TEAM_NOT_MEMBER 拒绝）。
      if (!callerTeamIds.includes(resolvedTeamId)) {
        return { items: [], total: 0 };
      }
      if (!type || type === CHANNEL_TYPE.team_group) {
        await this.ensureTeamChannel(resolvedTeamId);
      }
      const where: Prisma.ChatChannelWhereInput = {
        teamId: resolvedTeamId,
        deletedAt: null,
        ...(type ? { type } : {}),
      };
      const [total, rows] = await this.prisma.$transaction([
        this.prisma.chatChannel.count({ where }),
        this.prisma.chatChannel.findMany({
          where,
          include: CHANNEL_TASK_SELECT,
          orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        }),
      ]);
      return { items: rows.map((row) => this.toChannelDto(row)), total };
    }
    const where: Prisma.ChatChannelWhereInput = {
      deletedAt: null,
      ...(type ? { type } : {}),
      ...(callerTeamIds.length > 0
        ? { teamId: { in: callerTeamIds } }
        : ({ id: { in: [] } } as any)),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.chatChannel.count({ where }),
      this.prisma.chatChannel.findMany({
        where,
        include: CHANNEL_TASK_SELECT,
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);
    return { items: rows.map((row) => this.toChannelDto(row)), total };
  }

  async ensureTeamChannel(teamId: string): Promise<ChannelRow> {
    const existing = await this.prisma.chatChannel.findFirst({
      where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
      include: CHANNEL_TASK_SELECT,
    });
    if (existing) {
      return existing as unknown as ChannelRow;
    }
    try {
      const created = await this.prisma.chatChannel.create({
        data: {
          id: await this.idGen.nextId(CHANNEL_ID_PREFIX),
          type: CHANNEL_TYPE.team_group,
          teamId,
          taskId: null,
        } as any,
        include: CHANNEL_TASK_SELECT,
      });
      return created as unknown as ChannelRow;
    } catch (err: any) {
      // 竞态下唯一键冲突（team_group 单例）→ 回退查已存在
      if (err?.code === 'P2002') {
        const raced = await this.prisma.chatChannel.findFirst({
          where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
          include: CHANNEL_TASK_SELECT,
        });
        if (raced) return raced as unknown as ChannelRow;
      }
      throw err;
    }
  }

  async findOne(channelId: string, userId: string) {
    const { channel } = await this.resolveChannelAccess(channelId, userId);
    if (channel.teamId) {
      const teamRows = await (this.prisma as any).teamMember.findMany({
        where: { teamId: channel.teamId },
        select: {
          agentId: true,
          agent: { select: { id: true, name: true } },
          role: { select: { key: true, name: true } },
        },
      });
      return {
        ...this.toChannelDto(channel),
        agentMembers: teamRows.map((r: any) => this.toChannelAgentDto(r)),
      };
    }
    // 存量任务频道（无 teamId）：经任务归属团队解析成员；无归属 → 空成员（任务实例快照表已删除）。
    const ownerTask = channel.taskId
      ? await this.prisma.task.findUnique({
          where: { id: channel.taskId },
          select: { teamId: true },
        })
      : null;
    const ownerTeamId = (ownerTask as { teamId?: string | null } | null)
      ?.teamId;
    if (!ownerTeamId) {
      return { ...this.toChannelDto(channel), agentMembers: [] };
    }
    const ownerRows = await (this.prisma as any).teamMember.findMany({
      where: { teamId: ownerTeamId },
      select: {
        agentId: true,
        agent: { select: { id: true, name: true } },
        role: { select: { key: true, name: true } },
      },
    });
    return {
      ...this.toChannelDto(channel),
      agentMembers: ownerRows.map((r: any) => this.toChannelAgentDto(r)),
    };
  }

  /**
   * 消息历史游标分页（09 篇 §2.2/§3.5、10 篇 §6）：
   * `WHERE channel_id=? AND id<cursor ORDER BY id DESC LIMIT ?`（命中 idx_messages_channel_id）——
   * 首页（cursor 缺省）取**最新** limit 条；cursor = 上页最早一条 id，下一页取更老；
   * items 返回时反转回 id 升序（时间正序，前端直接渲染）；末页 nextCursor=null（取 limit+1 判断是否还有更多）。
   */
  async findMessages(
    channelId: string,
    userId: string,
    query: QueryMessagesDto,
  ) {
    await this.resolveChannelAccess(channelId, userId);
    const limit = this.normalizeLimit(query.limit);
    const pageIds = await this.findMessagePageIds({
      channelId,
      beforeId: query.cursor,
      take: limit + 1,
      limit,
    });
    const rows = await this.loadMessageRowsInIdOrder(pageIds.ids);
    return {
      // ids 为 id 降序（最新优先），反转回升序供前端时间正序渲染
      items: [...rows].reverse().map((row) => this.toMessageDto(row)),
      // 当前页最早一条 id（降序下为末项），供下一页取更老
      nextCursor: pageIds.hasMore ? pageIds.ids[pageIds.ids.length - 1] : null,
    };
  }

  /**
   * 分页取一页**消息 id**（id 降序）。
   *
   * 为什么两段式（2026-11-06 实测修复）：
   * `messages` 表带 `content` JSON 列，单行可达数百 KB（工具输出全量落库）。直接
   * `findMany({ where, orderBy: { id: 'desc' }, take })` 会让 MySQL 把**整行（含大 JSON）**
   * 带进排序缓冲区 —— 大消息频道直接报 `1038 Out of sort memory`（k8s 实测私聊频道
   * c_0000000035，MySQL sort_buffer=8M，/messages 与 /session-history 双双 500）。
   * 先只查 id（行极小，排序廉价），再按主键 in 取整行 ⇒ 不再有大行排序。
   */
  private async findMessagePageIds(opts: {
    channelId: string;
    beforeId?: string;
    take: number;
    limit: number;
  }): Promise<{ ids: string[]; hasMore: boolean }> {
    const idRows = await this.prisma.message.findMany({
      where: {
        channelId: opts.channelId,
        ...(opts.beforeId ? { id: { lt: opts.beforeId } } : {}),
      },
      orderBy: { id: 'desc' },
      take: opts.take,
      select: { id: true },
    });
    const hasMore = idRows.length > opts.limit;
    const ids = (hasMore ? idRows.slice(0, opts.limit) : idRows).map(
      (row) => row.id,
    );
    return { ids, hasMore };
  }

  /** 按给定 id 顺序取整行（主键 in 查询，无排序；缺失的行跳过）。 */
  private async loadMessageRowsInIdOrder(ids: string[]): Promise<MessageRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.message.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(rows.map((row) => [row.id, row as MessageRow]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is MessageRow => row !== undefined);
  }

  /**
   * 私聊历史 = 平台 DB 全量为真源 + opencode serve 会话仅作 agent 增补
   * （DM-own-message 修复：用户自己的消息只存在于平台 messages 表——worker 侧
   * 用户文本经 prompt 注入拼进上下文消息，无独立条目，纯 session 源永远缺 own 消息；
   * 且 POST 后立即 refetch 会遇到 worker 未 ingest 窗口。合并后 refetch 恒含 DB 行）。
   *
   * private 频道且其 Session（teamMember 维度按 teamMemberId 查；无成员维度
   * 回退平台表，任务锚定分支已删）已绑定 worker+instanceRef → 调 worker serve
   * worker `GET /sessions/:id/messages` 拉会话消息，转换后与 DB 合并返回
   * `{items, source:'session'}`（items 时间正序，无游标——前端游标参数忽略）；
   * 未绑定 / worker 不可用 → 回退平台 messages 表（`{items, nextCursor, source:'db'}`，
   * 复用 findMessages 首页语义）。群聊（team_group）不支持 → 400
   * SESSION_HISTORY_NOT_SUPPORTED（群聊保持平台表）。
   */
  async getSessionHistory(
    channelId: string,
    userId: string,
    query: QueryMessagesDto = {},
  ) {
    const { channel } = await this.resolveChannelAccess(channelId, userId);
    if (channel.type !== CHANNEL_TYPE.private) {
      throw new BadRequestException({
        code: CHAT_ERRORS.SESSION_HISTORY_NOT_SUPPORTED,
        message: '仅私聊频道支持会话历史（群聊保持平台消息表）',
      });
    }
    const limit = this.normalizeLimit(query.limit);
    const beforeId = query.cursor;
    const fallback = async () => {
      const page = await this.findMessages(channelId, userId, {
        limit,
        ...(beforeId ? { cursor: beforeId } : {}),
      });
      return { ...page, source: 'db' as const };
    };
    let session: {
      instanceRef: string | null;
      workerId: string | null;
      agentId: string;
      createdAt: Date;
    } | null = null;
    // team-only：私聊会话按 teamMemberId 定位团队会话（单成员单会话）；
    // 无成员维度（存量任务锚定频道）→ 平台表回退，任务锚定分支已删。
    const teamMemberId = (channel as any).teamMemberId as string | null;
    if (!teamMemberId) {
      return fallback();
    }
    const sessions = await this.prisma.session.findMany({
      where: { teamMemberId },
      orderBy: { updatedAt: 'desc' },
      select: {
        instanceRef: true,
        workerId: true,
        agentId: true,
        createdAt: true,
      },
    });
    session =
      sessions.find((s) => !!s.instanceRef && !!s.workerId) ??
      sessions[0] ??
      null;
    if (!session?.instanceRef || !session.workerId) {
      return fallback();
    }
    const workerRow = await this.prisma.worker.findUnique({
      where: { id: session.workerId },
      select: { id: true, capabilities: true },
    });
    if (!workerRow) {
      return fallback();
    }
    const worker: WorkerEndpointRef = {
      id: workerRow.id,
      capabilities: workerRow.capabilities,
    };
    try {
      /**
       * ⚠️ 分页（性能关键路径，2026-11-06 实测）：此前这里**不带 limit**，
       * 每次都把整个 serve 会话历史拉回来 —— 实测单频道 4224 条 / 15.6MB / 22.4s，
       * 加上 DB 500 行合并后返回前端 14.6MB/31.9s，切一次私聊就卡半分钟。
       * serve 的 `GET /sessions/:id/message?limit=&order=desc` 实测 48 条/415KB/258ms
       * ⇒ 只取「最近窗口」即可（补取的量按 limit 的 4 倍留余量，避免合并后被截断）。
       * 翻更老页（beforeId 非空）**完全不碰 worker**：历史真源是平台 messages 表。
       */
      let sessionItems: Array<Record<string, unknown>> = [];
      if (!beforeId) {
        const raw = await this.workerClient.getMessages(
          worker,
          session.instanceRef,
          { limit: Math.min(limit * 2, 200), order: 'desc' },
        );
        sessionItems = this.convertSessionMessages(raw, channel, session);
      }
      return {
        ...(await this.mergeSessionWithPlatform(channelId, sessionItems, {
          limit,
          beforeId,
        })),
        source:
          sessionItems.length > 0 ? ('session' as const) : ('db' as const),
      };
    } catch (err) {
      // worker 不可达/serve 异常 → 回退平台表（历史主数据源降级，不发错误阻塞读历史）
      this.logger.warn(
        `[session-history] worker 拉取失败回退平台表 channel=${channelId}: ${this.describeError(err)}`,
      );
      return fallback();
    }
  }

  /**
   * serve 会话消息 → 平台消息 DTO（对齐 toMessageDto 形状，前端复用 MsgParts 渲染）：
   * - 排序：按 serve info.time.created 升序（缺失 → 会话创建时间，保持原序稳定）。
   * - user 消息：senderType=user、senderId=null；content.text = 非 synthetic text parts 聚合；
   *   parts 仅保留 text（prompt 注入的 synthetic 内容剔除，不渲染）。
   * - assistant 消息：senderType=agent、senderId=频道模板 agent id（回退 Session.agentId）、
   *   senderInstanceId=频道 teamMemberId；content.text = 非 synthetic text 聚合；
   *   parts 保留 text/reasoning/tool（前端折叠思考 / 工具调用卡片渲染），
   *   step-start/step-finish/snapshot/patch 等过程 part 忽略。
   * - status：serve 历史消息的 step-finish part 并非总是持久化（实测历史轮次常缺失），
   *   故历史 assistant 消息一律 sent；仅**最后一条** assistant 消息且无 step-finish
   *   标 processing（会话末尾可能仍在流式，前端 SSE 增量同 sender 替换去重）。
   * - id：serve 消息 id（msg_ 前缀）或合成 `ses-<序号>`（稳定，前端 SSE 去重按 id）。
   */
  private convertSessionMessages(
    raw: unknown[],
    channel: {
      id: string;
      agentId: string | null;
      teamMemberId?: string | null;
    },
    session: { agentId: string; createdAt: Date },
  ): Array<Record<string, unknown>> {
    const fallbackCreated = session.createdAt.getTime();
    const sorted = [...raw].sort((a, b) => {
      const ta = (a as { info?: { time?: { created?: number } } })?.info?.time
        ?.created;
      const tb = (b as { info?: { time?: { created?: number } } })?.info?.time
        ?.created;
      return (ta ?? fallbackCreated) - (tb ?? fallbackCreated);
    });
    const converted: Array<{
      dto: Record<string, unknown>;
      hasFinish: boolean;
    }> = [];
    let seq = 0;
    for (const entry of sorted) {
      const m = entry as {
        info?: { id?: string; role?: string; time?: { created?: number } };
        parts?: unknown[];
      };
      const info = m?.info;
      if (!info) continue;
      const role = info.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const parts = Array.isArray(m.parts)
        ? (m.parts as Array<Record<string, unknown>>).filter(
            (p) => p !== null && typeof p === 'object',
          )
        : [];
      // 文本聚合：type=text 且非 synthetic（工具调用占位/注入上下文排除）
      const text = parts
        .filter((p) => p.type === 'text' && !p.synthetic)
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('');
      // 保留 parts：user 仅 text；assistant 保留 text/reasoning/thinking/tool。
      // serve 若干内部过程 part 一律过滤（step-start/step-finish/snapshot/patch
      // 等），不透传给前端轮询——它们被前端渲染为「未知片段」诊断行，噪声大于价值。
      // 误分类的诊断行仅记录在平台日志侧，不影响消息落库。
      const kept =
        role === 'user'
          ? parts.filter((p) => p.type === 'text' && !p.synthetic)
          : parts.filter(
              (p) =>
                p.type === 'text' ||
                p.type === 'reasoning' ||
                p.type === 'thinking' ||
                p.type === 'tool',
            );
      // 空消息（无文本且无保留 parts，如仅 step-start 的空壳）→ 跳过
      if (!text && kept.length === 0) continue;
      // 大字段截断（列表页性能关键）：tool 输出/思考单条可达数百 KB，
      // 实测某私聊 50 条就有 7.6MB ⇒ 切页要几秒。列表只保留每个字段前 16KB
      // （超出追加可见截断标记），完整内容后续可按需拉取。
      const cappedKept = ChatService.capPartPayloads(kept);
      const hasFinish = parts.some(
        (p) => p.type === 'step-finish' && p.reason === 'stop',
      );
      const createdMs =
        typeof info.time?.created === 'number'
          ? info.time.created
          : fallbackCreated;
      converted.push({
        dto: {
          id:
            typeof info.id === 'string' && info.id
              ? info.id
              : `ses-${String(seq).padStart(4, '0')}`,
          channelId: channel.id,
          senderType: role === 'user' ? SENDER_TYPE.user : SENDER_TYPE.agent,
          senderId:
            role === 'user' ? null : (channel.agentId ?? session.agentId),
          senderInstanceId:
            role === 'user' ? null : ((channel as any).teamMemberId ?? null),
          content: { text, parts: cappedKept },
          mentions: [],
          status: MESSAGE_STATUS.sent,
          createdAt: new Date(createdMs).toISOString(),
        },
        hasFinish,
      });
      seq += 1;
    }
    // 会话末尾可能仍在流式：最后一条 assistant 无 step-finish → processing（其余历史一律 sent）
    const last = [...converted]
      .reverse()
      .find((c) => c.dto.senderType === SENDER_TYPE.agent);
    if (last && !last.hasFinish) {
      last.dto.status = MESSAGE_STATUS.processing;
    }
    return converted.map((c) => c.dto);
  }

  /**
   * DM 历史合并（DB 为真源 + worker 会话仅 agent 增补）：
   * - DB 该频道全量消息（user/system/agent，最新 500，按 id 升序）全部保留。
   * - session user 项为 prompt 注入伪影（上下文前缀 + 用户文本拼接）一律排除，
   *   DB user 行为准，避免同一文本重复展示。
   * - session agent 项仅当未被 DB 引用时保留：DB agent 行 content.parts[].messageID
   *   == worker info.id 即已落库（含 reasoning/tool parts），DB 行为准；无引用
   *   （流式中/未落库，含无 info.id 的 ses- 合成项）则作为增补保留过程渲染。
   * - 去重加固：DB 存在 processing 聚合行（单行累积整轮流式内容，status=processing）
   *   时，取其最早 createdAt（聚合行 createdAt 冻结于轮次首次 delta，恒定不变）为界，
   *   会话中 createdAt >= 该时刻的 agent 增补项均已吸收进聚合行，直接丢弃；
   *   无 processing 行时增补逻辑原样不动。
   * - 排序：先按 createdAt 升序（稳定排序，同刻 DB 优先），再二次稳定分区：
   *   status=processing 行一律钉到列表末尾（保持彼此相对 createdAt 顺序），
   *   非 processing 行顺序不变。流式聚合行 createdAt 冻结在轮次起点，若不后置
   *   会被后续落库消息压在下方，出现「流式块卡在列表中部、新消息堆在下面」。
   */
  private async mergeSessionWithPlatform(
    channelId: string,
    sessionItems: Array<Record<string, unknown>>,
    page: { limit: number; beforeId?: string } = { limit: 500 },
  ): Promise<{
    items: Array<Record<string, unknown>>;
    nextCursor: string | null;
  }> {
    // DB 分页：游标即消息主键 id（数值序==字典序，与 findMessages 同口径）。
    // 多取一条用于判断 hasMore；首页额外留一倍余量（session 增补项会插入时间线，
    // 可能把窗口内最新的几条 DB 行挤出 limit 之外）。
    const take = page.beforeId ? page.limit + 1 : page.limit * 2 + 1;
    // 两段式取行（见 findMessagePageIds 注释：直接 orderBy 大行会 OOM sort memory）
    const pageIds = await this.findMessagePageIds({
      channelId,
      beforeId: page.beforeId,
      take,
      // hasMore 语义由调用处按「本页装下的 DB 行数」重算，这里取满 take 即可
      limit: take,
    });
    const rows = await this.loadMessageRowsInIdOrder(pageIds.ids);
    const dbItems = [...rows]
      .reverse()
      .map((row) => this.toMessageDto(row as any));
    const persisted = new Set<string>();
    for (const item of dbItems) {
      const parts = (item.content as { parts?: unknown })?.parts;
      if (!Array.isArray(parts)) continue;
      for (const p of parts) {
        const mid = (p as { messageID?: unknown })?.messageID;
        if (typeof mid === 'string' && mid) persisted.add(mid);
      }
    }
    // DB 侧 processing 聚合行（流式轮次的单行累积表示）的最早 createdAt：
    // 该时刻之后 serve 会话产生的 agent 增量都已落进聚合行，重复保留即双渲染
    const processingRows = dbItems.filter(
      (item) => item.status === MESSAGE_STATUS.processing,
    );
    const firstProcessingAt =
      processingRows.length > 0
        ? Math.min(
            ...processingRows.map((item) =>
              Date.parse(item.createdAt as string),
            ),
          )
        : null;
    const supplement = sessionItems.filter((item) => {
      if (item.senderType !== SENDER_TYPE.agent) return false;
      if (typeof item.id === 'string' && persisted.has(item.id)) return false;
      if (firstProcessingAt !== null) {
        const createdAt = Date.parse(item.createdAt as string);
        if (!Number.isNaN(createdAt) && createdAt >= firstProcessingAt) {
          return false;
        }
      }
      return true;
    });
    const merged = [...dbItems, ...supplement];
    merged.sort(
      (a, b) =>
        Date.parse(a.createdAt as string) - Date.parse(b.createdAt as string),
    );
    // 只保留窗口内**最新** limit 条（增补项可能把页尾挤出窗口）。
    const windowed = merged.slice(-page.limit);
    // ⚠️ 截断必须作用在**合并后的最终项**上：本页绝大多数是 DB 行（toMessageDto 直出，
    // 不过 convertSessionMessages），只截 session 增补项对体积毫无作用（实测仍 7.6MB/页）。
    for (const item of windowed) {
      const content = item.content as
        { parts?: unknown; text?: unknown } | undefined;
      if (content && Array.isArray(content.parts)) {
        content.parts = ChatService.capPartPayloads(
          content.parts as Array<Record<string, unknown>>,
        );
      }
    }
    // nextCursor = 本页最早的一条 **DB 行** id：前端「加载更多」走平台表分页
    // （历史真源 = messages 表）；session 增补项无平台 id，不能作为游标。
    const dbIds = new Set(rows.map((row) => row.id));
    const oldestDbInPage = windowed.find((item) =>
      dbIds.has(item.id as string),
    );
    // hasMore：还有**没进本页**的 DB 行（rows 按 id 降序取，本页只装下其中最新的一批）。
    // 不能用 `rows.length >= take`：DB 总行数不足 take 但仍多于 limit 时会误判末页，
    // 用户就再也点不出更早的历史了。
    const dbRowsInPage = windowed.filter((item) =>
      dbIds.has(item.id as string),
    ).length;
    const hasMore = rows.length > dbRowsInPage;
    // **取消"processing 钉到末尾"**（实测是错的）：
    //
    // 原实现把进行中的流式聚合行一律后置，理由是"前端轮询要能看到最新流式块"。
    // 但它与真实对话顺序冲突：用户在 agent 生成过程中又发了一条消息时，
    // 会出现「用户的第 2 条消息排在进行中的回复**上方**」——随后回复完成、状态变化，
    // 又变成「所有回复堆在下方、用户消息在上方」，正是用户截图里看到的现象。
    //
    // 正确做法：严格按 createdAt 升序（保持对话真实时间线）。前端已有
    // loading/streaming 指示器标识"进行中"，不需要靠列表位置来强调。
    return {
      items: windowed,
      nextCursor:
        hasMore && oldestDbInPage ? (oldestDbInPage.id as string) : null,
    };
  }

  /**
   * 列表接口的 part 大字段截断：只保留每个字符串字段前 `MAX_PART_FIELD_CHARS` 字符。
   *
   * 为什么必须截断：`content.parts` 里 tool 的 input/output、reasoning 的 text 是**全量**
   * 落库的，单条可达 300KB+（实测单频道 50 条 = 7.6MB）。私聊列表一次性把这些塞给浏览器，
   * 既慢又占内存。列表页只需要「能看出这步干了什么」，完整内容可以按需拉。
   * 截断标记写进文本本身（`…（已截断）`），前端无需改渲染即可让用户看到"这里被截了"。
   */
  /** 单个字符串字段上限（字符）。前端工具卡本身也只展示前 2000 字符（TOOL_IO_MAX_CHARS），
   *  列表页没必要为看不到的内容付流量。 */
  private static readonly MAX_PART_STRING_CHARS = 2 * 1024;
  /** 数组型载荷（如 tool 的 `state.content` 结果块）最多保留多少项。 */
  private static readonly MAX_PART_ARRAY_ITEMS = 20;
  /** 递归深度上限（防异常深对象）。 */
  private static readonly MAX_PART_DEPTH = 4;
  private static readonly PART_TRUNCATED_SUFFIX = '…（内容过长，已截断）';

  /**
   * 递归截断 part 载荷（字符串/数组/对象）。
   *
   * 为什么是**递归**而不是只截顶层字段：实测超大 part 的真实载荷在
   * `part.state.content` —— 一个**数组**（tool 结果块），单条可达 1.1MB；
   * 只截 `text`/`output` 这类顶层字符串完全没效果（截断后仍 7.6MB/页）。
   * 前端工具卡只展示前 2000 字符，所以列表页按 2KB/字符串 + 20 项/数组封顶即可，
   * 既不影响可读性判断，也把单页体积压到百 KB 量级。
   */
  private static capValue(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
      return value.length <= ChatService.MAX_PART_STRING_CHARS
        ? value
        : value.slice(0, ChatService.MAX_PART_STRING_CHARS) +
            ChatService.PART_TRUNCATED_SUFFIX;
    }
    if (Array.isArray(value)) {
      const kept = value
        .slice(0, ChatService.MAX_PART_ARRAY_ITEMS)
        .map((item) => ChatService.capValue(item, depth + 1));
      if (value.length > ChatService.MAX_PART_ARRAY_ITEMS) {
        kept.push(
          `…（共 ${value.length} 项，仅展示前 ${ChatService.MAX_PART_ARRAY_ITEMS} 项）`,
        );
      }
      return kept;
    }
    if (
      value &&
      typeof value === 'object' &&
      depth < ChatService.MAX_PART_DEPTH
    ) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>,
      )) {
        out[key] = ChatService.capValue(item, depth + 1);
      }
      return out;
    }
    return value;
  }

  private static capPartPayloads(
    parts: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    return parts.map(
      (part) => ChatService.capValue(part) as Record<string, unknown>,
    );
  }

  /** 错误信息归一（worker 拉取失败时用于日志）。 */
  private describeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  /**
   * @ 触发结果轮询（09 篇 §3.5 GET :id/trigger-results/:messageId，前端 SSE 兜底）：
   * 查原用户消息的 mentions，对每个被 @ Agent 返回 dispatch 状态 + 回复消息 id。
   * 状态推导与 createMessage 的 resolveMentions 同源（removedAt/session 判定）；
   * 实现选「直接查 messages 表推导」而非进程内内存映射：多实例部署下
   * 其它实例分派的回复无法进内存映射，DB 推导无跨实例一致性问题且零状态管理。
   * 404 MESSAGE_NOT_FOUND（消息不存在或非本频道）；400 MESSAGE_NOT_USER（非用户消息）。
   */
  /**
   * 中止频道中**正在运行**的 agent 回合（P5 用户主动停止）。
   *
   * 语义（对齐 GUI 停止按钮 / DSH 的 session/cancel）：
   * - 只中止当前这一轮，**不丢弃会话**（下一条消息可以继续同一会话）；
   * - worker 侧 `POST /sessions/:id/abort` → 驱动 `abort()` → DSH `session/cancel`
   *   → `agent.cancel({kind:'user'},{keepInbox:true})`（部分输出保留、排队消息不丢）；
   * - 幂等：没有运行中的会话时返回 `{aborted:false}` 而不是报错（用户可能连点）。
   *
   * ⚠️ 为什么不中止 runScope 之外的会话：一个频道可能绑定多个成员实例（群聊），
   * 本端点按 `teamMemberId`/`agentId` 维度**只停目标成员**；缺省则停该频道下
   * 所有 running 会话（群聊「全员停止」语义）。
   */
  async abortRunningSession(
    channelId: string,
    userId: string,
    target?: { teamMemberId?: string; agentId?: string },
  ): Promise<{ aborted: boolean; sessions: string[] }> {
    const { channel } = await this.resolveChannelAccess(channelId, userId);

    // ⚠️ `Session` **没有 channelId 列**（schema.prisma:317-342）——
    // 会话按 (teamId, teamMemberId) 归属团队/成员，频道只是入口。
    // 私聊频道：取该频道对应的 teamMemberId；群聊频道：取整团队。
    // 用 channelId 会触发 Prisma 校验错误 `Unknown argument channelId` ⇒ 500。
    const where: {
      status: string;
      teamId?: string;
      teamMemberId?: string;
      agentId?: string;
    } = { status: 'running' };
    if (channel.teamId) where.teamId = channel.teamId;
    // 私聊：频道天然绑定一个成员；群聊：可由 target 指定
    const scopedMemberId =
      channel.teamMemberId ?? target?.teamMemberId ?? undefined;
    if (scopedMemberId !== undefined && scopedMemberId !== '') {
      where.teamMemberId = scopedMemberId;
    }
    if (target?.agentId !== undefined && target.agentId !== '') {
      where.agentId = target.agentId;
    }
    // 兜底：若两者都无（异常频道），按 agentId 收敛，避免全表扫描
    if (
      where.teamId === undefined &&
      where.teamMemberId === undefined &&
      where.agentId === undefined
    ) {
      return { aborted: false, sessions: [] };
    }

    const running = await this.prisma.session.findMany({
      where,
      select: { id: true, workerId: true, instanceRef: true },
    });
    if (running.length === 0) {
      return { aborted: false, sessions: [] };
    }

    const stopped: string[] = [];
    for (const row of running) {
      if (row.workerId === null || row.instanceRef === null) continue;
      const worker = await this.prisma.worker.findUnique({
        where: { id: row.workerId },
        select: { id: true, capabilities: true },
      });
      if (worker === null) continue;
      try {
        await this.workerClient.abort(
          {
            id: worker.id,
            capabilities: worker.capabilities as Record<string, unknown>,
          },
          row.instanceRef,
        );
        stopped.push(row.id);
      } catch (err) {
        // 中止失败不改变"用户已点击停止"的事实：记日志并继续（会话随后由
        // 空闲判死/会话重建路径收口），**不**把错误抛给前端（否则用户看到报错但
        // 实际可能已停）。
        this.logger.warn(
          `[chat] abort 会话 ${row.id}（worker=${worker.id}）失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { aborted: stopped.length > 0, sessions: stopped };
  }

  async getTriggerResults(
    channelId: string,
    userId: string,
    messageId: string,
  ) {
    const { channel } = await this.resolveChannelAccess(channelId, userId);
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
    });
    if (!message || message.channelId !== channelId) {
      throw new NotFoundException({
        code: CHAT_ERRORS.MESSAGE_NOT_FOUND,
        message: '消息不存在',
      });
    }
    if (message.senderType !== SENDER_TYPE.user) {
      throw new BadRequestException({
        code: CHAT_ERRORS.MESSAGE_NOT_USER,
        message: '仅用户消息有 @ 触发结果',
      });
    }
    const mentions = this.parseMentions(message.mentions);
    if (mentions.length === 0) {
      return { triggers: [] };
    }

    // 团队维度解析 teamMember（team-only：任务仅作数据透传，不参与会话定位；
    // 存量任务频道经任务归属 teamId 反查团队，频道本身无 team 归属时无法定位 → 空触发）。
    const directTeamId =
      channel.teamId ?? (channel as any).task?.teamId ?? null;
    let resolvedTeamId: string | null = directTeamId;
    if (!resolvedTeamId && channel.taskId) {
      const ownerTask = await (this.prisma as any).task.findUnique({
        where: { id: channel.taskId },
        select: { teamId: true },
      });
      resolvedTeamId = (ownerTask as any)?.teamId ?? null;
    }
    if (!resolvedTeamId) {
      return { triggers: [] };
    }
    const members = await (this.prisma as any).teamMember.findMany({
      where: { teamId: resolvedTeamId },
      select: TEAM_MEMBER_SELECT,
    });
    // TeamMember 无 removedAt 列（schema 已核）：恒为有效；防御性透传以镜像 buildTrigger 语义。
    const teamRows: { id: string; agentId: string; removedAt: Date | null }[] =
      (members ?? []).map((m: any) => ({
        id: m.id,
        agentId: m.agentId,
        removedAt: (m.removedAt ?? null) as Date | null,
      }));

    // 被 @ Agent 集合：agent 型直取（带 instanceId 精确到实例）；all 型展开为团队未移除全部实例
    const targetRows: {
      id: string;
      agentId: string;
      removedAt: Date | null;
    }[] = [];
    for (const m of mentions) {
      if (m.type === 'agent' && m.agentId) {
        const row = m.instanceId
          ? teamRows.find((r) => r.id === m.instanceId)
          : (teamRows.find((r) => r.agentId === m.agentId && !r.removedAt) ??
            teamRows.find((r) => r.agentId === m.agentId));
        if (row) targetRows.push(row);
      } else if (m.type === 'all') {
        for (const row of teamRows) {
          if (!row.removedAt) targetRows.push(row);
        }
      }
    }

    const triggers: TriggerPollResult[] = [];
    for (const row of targetRows) {
      const agentId = row.agentId;
      const instanceId = row.id;
      const base = await this.buildTrigger(resolvedTeamId, row);
      // 回复：该实例（agentId+instanceId 定位）于原消息之后的回复消息（senderType=agent，id 升序取最早一条）
      const reply = await this.prisma.message.findFirst({
        where: {
          channelId,
          senderType: SENDER_TYPE.agent,
          senderId: agentId,
          createdAt: { gt: message.createdAt },
          ...(instanceId
            ? {
                OR: [
                  { senderInstanceId: instanceId },
                  { senderInstanceId: null },
                ],
              }
            : {}),
        },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      triggers.push({
        agentId,
        instanceId,
        status: base.status,
        ...(reply ? { replyMessageId: reply.id } : {}),
      });
    }
    return { triggers };
  }

  private parseMentions(mentions: Prisma.JsonValue | null): MentionInput[] {
    if (!Array.isArray(mentions)) return [];
    return mentions.filter(
      (m): m is MentionInput =>
        typeof m === 'object' &&
        m !== null &&
        ((m as MentionInput).type === 'agent' ||
          (m as MentionInput).type === 'all' ||
          (m as MentionInput).type === 'user'),
    );
  }

  /**
   * 发消息 8 步流程（09 篇 §5.1）：
   * 1 权限校验 → 2 @ 解析 → 3 落库 → 4 广播 chat.message.new（频道）
   * → 5 分派（MessageDispatcher，Phase 4 WorkerDispatcher 异步回流）
   * → 6 上下文注入（Phase 2 mock 跳过）。
   * Loading（thinking→operating）与异步收敛（mock 回复落库 + 广播）由分派器内部完成
   * （09 篇 §5.1：@ 触发同步返回受理，处理结果走 SSE；Phase 4 替换 WorkerDispatcher 零改动）。
   * 响应 201 + `{message, triggers[]}`。
   */
  async createMessage(
    channelId: string,
    userId: string,
    dto: CreateMessageDto,
    actor?: { senderType: string; senderId: string | null },
  ) {
    const senderType = actor?.senderType ?? SENDER_TYPE.user;
    const senderId = actor?.senderId !== undefined ? actor.senderId : userId;
    const dtoTaskId = (dto as any).taskId as string | undefined;

    let channel: ChannelRow;
    let task: {
      id?: string;
      status: string;
      teamId?: string | null;
    };
    if (senderType === SENDER_TYPE.external) {
      const row = await this.prisma.chatChannel.findUnique({
        where: { id: channelId },
        include: CHANNEL_TASK_SELECT,
      });
      if (!row || (row as any).deletedAt) {
        throw new NotFoundException({
          code: CHAT_ERRORS.CHANNEL_NOT_FOUND,
          message: '频道不存在',
        });
      }
      channel = row as unknown as ChannelRow;
      const ch: any = row as any;
      if (ch.teamId) {
        task = ch.task ?? { status: 'pending', teamId: ch.teamId };
        if (dtoTaskId) {
          const t = await (this.prisma as any).task.findUnique({
            where: { id: dtoTaskId },
            select: {
              id: true,
              status: true,
              teamId: true,
            },
          });
          if (t) task = t;
        }
      } else {
        task = ch.task;
      }
    } else {
      const resolved = await this.resolveChannelAccess(
        channelId,
        userId,
        dtoTaskId ?? null,
      );
      channel = resolved.channel;
      task = resolved.task;
    }
    // F-B team-mode degrade：团队频道（team_group/团队私聊）的 resolved/fallback
    // 任务为 archived（或无可用任务）时，不再 409 拒绝 —— 团队直聊是独立于
    // 任务队列的核心能力，降级为无任务上下文继续。legacy 非团队频道保持 409；
    // 非成员 403 / 缺团队 404 在 resolveChannelAccess 内不变。
    let archivedDegraded = false;
    if (task.status === TASK_STATUS.archived) {
      const degradeTeamId =
        (channel as any).teamId ?? (task as any)?.teamId ?? null;
      if (degradeTeamId && (channel as any).teamId) {
        task = { status: 'pending', teamId: degradeTeamId } as any;
        archivedDegraded = true;
        this.logger.log(
          `team-mode archived degrade: channel=${channelId} team=${degradeTeamId} → team direct chat`,
        );
      } else {
        throw new ConflictException({
          code: CHAT_ERRORS.TASK_ARCHIVED,
          message: '归档任务频道不允许发消息',
        });
      }
    }

    const isTeamPrivate =
      channel.type === CHANNEL_TYPE.private && !!channel.teamId;
    // 团队私聊为团队维度（teamId + teamMemberId），不按任务分区：不继承
    // resolveChannelAccess 为无任务团队频道合成的 currentTask 上下文（否则私聊
    // 误走 task-mode 分派：任务快照会话 + 回复落群聊，DM processing 悬空）。
    // dtoTaskId 亦忽略（私聊无任务分区语义；DM 页从不发送 taskId）。
    // F-B 降级时同样置空（归档任务 id 不再分区/分派）。
    const effectiveTaskId: string | null = archivedDegraded
      ? null
      : isTeamPrivate
        ? null
        : (dtoTaskId ?? (task as any).id ?? (channel as any).taskId ?? null);

    const resolveKey = channel.teamId
      ? { teamId: channel.teamId, taskId: effectiveTaskId }
      : { taskId: effectiveTaskId ?? (channel as any).taskId };

    const { mentionsStored, triggers } = await this.resolveMentions(
      resolveKey as any,
      dto.mentions ?? [],
    );

    const isTeamGroup = channel.type === CHANNEL_TYPE.team_group;
    if (isTeamGroup && triggers.length === 0) {
      const triggerTaskId = effectiveTaskId ?? (channel as any).taskId;
      // team-only 主回退：任务上下文经团队主成员门（mainAgentMemberId→首位）定位团队会话；
      // 零任务团队直聊沿用分派器即建即得路径（语义不变）。
      const mainTeamId = channel.teamId ?? (task as any)?.teamId ?? null;
      if (triggerTaskId && mainTeamId) {
        const mainTrigger = await this.buildMainAgentTrigger(mainTeamId);
        if (mainTrigger) triggers.push(mainTrigger);
      } else if (!triggerTaskId && isTeamGroup && channel.teamId) {
        // 零任务团队直聊：无 @ 时默认触发主 Agent（团队门；会话即建即得，会话 id 直接回填）
        try {
          const teamMain = await (
            this.dispatcher as unknown as {
              buildTeamMainTrigger(teamId: string): Promise<{
                agentId: string;
                instanceId: string;
                sessionId: string;
              } | null>;
            }
          ).buildTeamMainTrigger(channel.teamId);
          if (teamMain) {
            triggers.push({
              agentId: teamMain.agentId,
              instanceId: teamMain.instanceId,
              sessionId: teamMain.sessionId,
              status: 'dispatched',
            });
          }
        } catch (err) {
          this.logger.error(
            `team-mode 主触发失败 team=${channel.teamId} channel=${channelId}: ${(err as Error)?.message ?? err}`,
            (err as Error)?.stack,
          );
        }
      }
    }

    // F-A task-mode @-mention 补会话：buildTrigger 无团队会话时只给 no_session，
    // 冷启动（有 current task 但尚无 team session）此前直接静默丢弃。本分支对
    // tmm_ 目标经分派器即建即得团队会话翻 dispatched，与零任务路径同形；单成员
    // 失败仅日志保留 no_session（FR-21 同形）。queued 拦截在后，不受影响。
    if (channel.teamId && triggers.length > 0) {
      for (const t of triggers) {
        if (t.status !== 'no_session') continue;
        const memberId = t.instanceId ?? null;
        if (!memberId || !memberId.startsWith('tmm_')) continue;
        try {
          const ensured = await (
            this.dispatcher as unknown as {
              buildTeamMemberTrigger(
                teamId: string,
                teamMemberId: string,
              ): Promise<{
                agentId: string;
                instanceId: string;
                sessionId: string;
              } | null>;
            }
          ).buildTeamMemberTrigger(channel.teamId, memberId);
          if (ensured?.sessionId) {
            t.agentId = ensured.agentId;
            t.instanceId = ensured.instanceId;
            t.sessionId = ensured.sessionId;
            t.status = 'dispatched';
          }
        } catch (err) {
          this.logger.error(
            `team-mode @-mention 会话确保失败 team=${channel.teamId} member=${memberId} channel=${channelId}: ${(err as Error)?.message ?? err}`,
            (err as Error)?.stack,
          );
        }
      }
    }

    // 团队私聊无 @ 回退：私聊即与该成员对话，无 mentions 时直接触发
    // DM 对端成员（团队会话即建即得，会话 id 直接回填）。无此分支则
    // triggers 为空 → dispatch 空 targets → worker 永不执行（DM 无流式、无回复）。
    if (isTeamPrivate && triggers.length === 0 && channel.teamMemberId) {
      try {
        const peer = await (
          this.dispatcher as unknown as {
            buildTeamMemberTrigger(
              teamId: string,
              teamMemberId: string,
            ): Promise<{
              agentId: string;
              instanceId: string;
              sessionId: string;
            } | null>;
          }
        ).buildTeamMemberTrigger(
          channel.teamId as string,
          channel.teamMemberId,
        );
        if (peer) {
          triggers.push({
            agentId: peer.agentId,
            instanceId: peer.instanceId,
            sessionId: peer.sessionId,
            status: 'dispatched',
          });
        }
      } catch (err) {
        this.logger.error(
          `team 私聊触发失败 team=${channel.teamId} member=${channel.teamMemberId} channel=${channelId}: ${(err as Error)?.message ?? err}`,
          (err as Error)?.stack,
        );
      }
    }

    if (channel.teamId && effectiveTaskId) {
      const last = await this.prisma.message.findFirst({
        where: { channelId },
        orderBy: { createdAt: 'desc' },
        select: { taskId: true },
      });
      const lastTaskId = (last as any)?.taskId ?? null;
      if (lastTaskId && lastTaskId !== effectiveTaskId) {
        const taskTitle = await (this.prisma as any).task.findUnique({
          where: { id: effectiveTaskId },
          select: { title: true },
        });
        const sepText = taskTitle
          ? `--- Task ${taskTitle.title} started ---`
          : `--- Task ${effectiveTaskId} started ---`;
        const sep = await this.prisma.message.create({
          data: {
            id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
            channelId,
            taskId: effectiveTaskId,
            senderType: SENDER_TYPE.system,
            senderId: null,
            content: { text: sepText, parts: [] } as Prisma.InputJsonValue,
            mentions: [] as Prisma.InputJsonValue,
            status: MESSAGE_STATUS.sent,
          },
        });
        await this.realtime.broadcast(
          EVENT_TYPES.CHAT_MESSAGE_NEW,
          { message: this.toMessageDto(sep as any) },
          { type: 'channel', id: channelId },
        );
        if (channel.teamId) {
          await this.realtime.broadcast(
            EVENT_TYPES.CHAT_MESSAGE_NEW,
            { message: this.toMessageDto(sep as any) },
            { type: 'team', id: channel.teamId } as any,
          );
        }
      }
    }

    // 附件归一化（多附件）：新数组优先、旧三字段回退单元素、非法条目丢弃、按 url 去重、
    // 截断到 MAX_MESSAGE_ATTACHMENTS（全部逻辑收敛在 message-attachments helper）。
    // 注：请求 DTO 是 class 实例（无 JsonValue 索引签名），helper 只按对象字段读取，收窄即可。
    const attachments = normalizeMessageAttachments({
      attachments: dto.attachments as unknown as Prisma.JsonValue | undefined,
      attachmentUrl: dto.attachmentUrl,
      attachmentName: dto.attachmentName,
      attachmentType: dto.attachmentType,
    });
    // 双写：新列存完整数组；旧三字段存首个附件（旧前端/旧 MCP 读路径兼容）。
    const storedAttachments = toStoredAttachments(attachments);
    const message = await this.prisma.message.create({
      data: {
        id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
        channelId,
        ...(effectiveTaskId ? { taskId: effectiveTaskId } : {}),
        senderType,
        senderId,
        content: { text: dto.text, parts: [] } as Prisma.InputJsonValue,
        mentions: mentionsStored as Prisma.InputJsonValue,
        status: MESSAGE_STATUS.sent,
        ...(dto.externalChatId ? { externalChatId: dto.externalChatId } : {}),
        ...(storedAttachments ? { attachments: storedAttachments } : {}),
        ...legacyAttachmentFields(attachments),
      },
    });

    await this.realtime.broadcast(
      EVENT_TYPES.CHAT_MESSAGE_NEW,
      { message: this.toMessageDto(message as any) },
      { type: 'channel', id: channelId },
    );
    if (channel.teamId) {
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: this.toMessageDto(message as any) },
        { type: 'team', id: channel.teamId } as any,
      );
    }

    // 群触发 DM 镜像（dm-mirror）：team_group（同一 createMessage 主路径）
    // 来源的用户消息，为每个回答该消息
    // 的 agent 在其私聊频道落一条触发消息的逐字拷贝，使 DM 呈现完整 Q&A 上下文
    // （前端按 content parts 原样渲染）。
    // - 显式 @agent：与 trigger 按 agentId 1:1 配对消费。
    // - 无 @ 主回退（buildMainAgentTrigger/零任务 teamMain）：DM 即该 agent 的
    //   会话，无人点名时主 Agent 回答一切群消息，其实名 DM 同样需要该问句上文，
    //   故同规则镜像（verbatim + taskId 空 + 双 scope 广播 + 单目标 try/catch）。
    // - @all 展开的全员 triggers 不镜像（一次 @all 污染全员 DM 得不偿失；
    //   各 DM 的后续问答仍经私聊直发覆盖）。
    // - DM 来源（isTeamPrivate）、triggers 为空、非用户发送均不镜像。
    // - 幂等：本块处于单次 createMessage 主路径（dispatch 重试/fan-out 不进此
    //   函数），每目标恰好一次。
    // - DM 无任务分区语义：镜像 taskId 置空（与私聊直发一致，历史跨任务保留）。
    if (
      isTeamGroup &&
      senderType === SENDER_TYPE.user &&
      channel.teamId &&
      triggers.length > 0
    ) {
      const consumed = new Set<number>();
      const mirrorTargets: TriggerResult[] = [];
      const hasExplicitAgentMention = (dto.mentions ?? []).some(
        (m) => m.type === 'agent' && !!(m as { agentId?: string }).agentId,
      );
      if (hasExplicitAgentMention) {
        for (const m of dto.mentions ?? []) {
          if (m.type !== 'agent') continue;
          const mentionAgentId = (m as { agentId?: string }).agentId;
          if (!mentionAgentId) continue;
          let idx = -1;
          const wantedInstance = (m as { instanceId?: string }).instanceId;
          if (wantedInstance) {
            idx = triggers.findIndex(
              (t, i) =>
                !consumed.has(i) &&
                t.status === 'dispatched' &&
                t.instanceId === wantedInstance,
            );
          }
          if (idx < 0) {
            idx = triggers.findIndex(
              (t, i) =>
                !consumed.has(i) &&
                t.status === 'dispatched' &&
                t.agentId === mentionAgentId,
            );
          }
          if (idx >= 0) {
            consumed.add(idx);
            mirrorTargets.push(triggers[idx]);
          }
        }
      } else if (!(dto.mentions ?? []).some((m) => m.type === 'all')) {
        for (const t of triggers) {
          if (t.status === 'dispatched') mirrorTargets.push(t);
        }
      }
      for (const t of mirrorTargets) {
        try {
          await this.mirrorGroupMentionToDm(
            channel.teamId,
            t,
            message as any,
            senderId,
          );
        } catch (err) {
          this.logger.error(
            `dm-mirror 失败 team=${channel.teamId} agent=${t.agentId} channel=${channelId}: ${(err as Error)?.message ?? err}`,
            (err as Error)?.stack,
          );
        }
      }
    }

    // 主 agent 门禁：团队存在未完成任务 → 用户消息照常 fan-out（含 @ 子 agent）；
    // 团队没有任何任务、或名下任务全部终态（completed/archived）→ 关门：仅主成员目标放行，
    // 其余移除并系统提示，逼所有活走「建任务→流转到进行中→派发」正路（门禁需求）。
    // 团队私聊同理（对端非主即拦）。
    // 被拦目标移出 dispatch（不改其余 triggers），消息本身仍保存；mainMemberId 缺失则
    // fail-open（避免未配置主 agent 的团队被砖）并记 warn。
    if (
      senderType === SENDER_TYPE.user &&
      channel.teamId &&
      (isTeamGroup || isTeamPrivate)
    ) {
      try {
        const gate = await this.checkMainAgentGate(channel.teamId);
        if (gate && !gate.open && gate.mainMemberId) {
          const kept: typeof triggers = [];
          const droppedNames: string[] = [];
          const members = (await (this.prisma as any).teamMember.findMany({
            where: { teamId: channel.teamId },
            select: { id: true, alias: true },
          })) as Array<{ id: string; alias: string | null }>;
          const nameOf = (instanceId: string | null | undefined) =>
            members.find((m) => m.id === instanceId)?.alias ??
            instanceId ??
            '?';
          for (const t of triggers) {
            if (
              (t as any).status === 'dispatched' &&
              (t as any).instanceId !== gate.mainMemberId
            ) {
              droppedNames.push(nameOf((t as any).instanceId));
              continue;
            }
            kept.push(t);
          }
          if (droppedNames.length > 0) {
            triggers.length = 0;
            triggers.push(...kept);
            const mainName = nameOf(gate.mainMemberId);
            const hintText =
              `当前没有未完成的任务，只能与主 agent（${mainName}）沟通。` +
              `已跳过对 ${[...new Set(droppedNames)].join('、')} 的派发——` +
              `请先让主 agent 创建任务并流转到进行中，再派活给子 agent。`;
            try {
              const hint = await this.prisma.message.create({
                data: {
                  id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
                  channelId,
                  taskId: effectiveTaskId ?? null,
                  senderType: SENDER_TYPE.system,
                  senderId: null,
                  content: {
                    text: hintText,
                    parts: [],
                  } as Prisma.InputJsonValue,
                  mentions: [] as Prisma.InputJsonValue,
                  status: MESSAGE_STATUS.sent,
                } as any,
              });
              await this.realtime.broadcast(
                EVENT_TYPES.CHAT_MESSAGE_NEW,
                { message: this.toMessageDto(hint as any) },
                { type: 'channel', id: channelId },
              );
              await this.realtime.broadcast(
                EVENT_TYPES.CHAT_MESSAGE_NEW,
                { message: this.toMessageDto(hint as any) },
                { type: 'team', id: channel.teamId } as any,
              );
            } catch {}
            this.logger.log(
              `team 主 agent 门禁拦截 team=${channel.teamId} 跳过=${droppedNames.join(',')}`,
            );
          }
        } else if (gate && !gate.open && !gate.mainMemberId) {
          this.logger.warn(
            `team 主 agent 门禁：团队 ${channel.teamId} 未配置主 agent，fail-open 放行`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `team 主 agent 门禁检查失败 team=${channel.teamId}（fail-open 放行）: ${(err as Error)?.message ?? err}`,
        );
      }
    }

    // 排队拦截已随 FIFO 队列退役（parallel-tasks）：team_group 消息直接落库并派发。
    const targets = triggers.filter((t) => t.status === 'dispatched');
    // 团队私聊恒走 team-mode（taskId 置空 + teamId 透传）：task-mode 会话/
    // 快照与群聊优先的终态落库均不适用于 DM 对端直聊。
    const dispatchTaskId = isTeamPrivate
      ? ''
      : (effectiveTaskId ?? (channel as any).taskId ?? (task as any).id ?? '');
    void this.dispatcher
      .dispatch({
        messageId: message.id,
        channelId,
        taskId: dispatchTaskId,
        ...(channel.teamId ? { teamId: channel.teamId } : {}),
        ...(dispatchTaskId ? { taskContext: { taskId: dispatchTaskId } } : {}),
        text: dto.text,
        targets: targets.map((t) => ({
          agentId: t.agentId,
          instanceId: t.instanceId,
          sessionId: t.sessionId,
        })),
      })
      .catch((err: Error) =>
        this.logger.error(`dispatch failed: ${err.message}`, err.stack),
      );

    return {
      message: this.toMessageDto(message as any),
      triggers,
    };
  }

  async createDmChannel(userId: string, dto: CreateDmChannelDto) {
    let teamId = (dto as any).teamId as string | undefined;
    const memberIdInput = (dto as any).memberId as string | undefined;
    let teamMemberIdInput = (dto as any).teamMemberId as string | undefined;
    const agentIdInput = (dto as any).agentId as string | undefined;
    const legacyTaskId = (dto as any).taskId as string | undefined;

    // 新形状（成员维度）：解析成员 → 其席位（可选指定 context teamId）→ 复用/创建私聊频道。
    // 私聊频道仍是「团队 × 成员」一条（P4 合并前的过渡），member_id 同步落库。
    let resolvedMemberId: string | null = null;
    if (memberIdInput) {
      const member = await (this.prisma as any).member.findUnique({
        where: { id: memberIdInput },
        select: { id: true, name: true, status: true },
      });
      if (!member) {
        throw new NotFoundException({
          code: CHAT_ERRORS.MEMBER_NOT_FOUND,
          message: `成员 ${memberIdInput} 不存在`,
        });
      }
      if (member.status !== 'active') {
        throw new BadRequestException({
          code: CHAT_ERRORS.MEMBER_DISABLED,
          message: `成员 ${member.name} 已停用`,
        });
      }
      const seats: Array<{ id: string; agentId: string; teamId: string }> =
        await (this.prisma as any).teamMember.findMany({
          where: { memberId: member.id },
          select: { id: true, agentId: true, teamId: true },
          orderBy: { createdAt: 'asc' },
        });
      if (!seats || seats.length === 0) {
        throw new BadRequestException({
          code: CHAT_ERRORS.MEMBER_NOT_IN_ANY_TEAM,
          message: '成员尚未加入任何群聊，无法创建私聊',
        });
      }
      const seat = teamId ? seats.find((s) => s.teamId === teamId) : seats[0];
      if (!seat) {
        throw new BadRequestException({
          code: CHAT_ERRORS.MEMBER_NOT_IN_TEAM,
          message: '成员不属于指定团队',
        });
      }
      teamId = seat.teamId;
      teamMemberIdInput = seat.id;
      resolvedMemberId = member.id;
    }
    if (legacyTaskId && !teamId) {
      const legacyTask = await this.prisma.task.findUnique({
        where: { id: legacyTaskId },
        select: { teamId: true },
      });
      if (!legacyTask) {
        throw new NotFoundException({
          code: CHAT_ERRORS.TASK_NOT_FOUND,
          message: '任务不存在',
        });
      }
      if (!legacyTask.teamId) {
        throw new BadRequestException({
          code: CHAT_ERRORS.TEAM_NOT_FOUND,
          message: '任务未绑定团队，无法创建私聊',
        });
      }
      const legacyTeamMember = agentIdInput
        ? await (this.prisma as any).teamMember.findFirst({
            where: { teamId: legacyTask.teamId, agentId: agentIdInput },
            orderBy: [{ seq: 'asc' }, { id: 'asc' }],
          })
        : null;
      if (!legacyTeamMember && agentIdInput) {
        throw new BadRequestException({
          code: CHAT_ERRORS.MENTION_AGENT_NOT_IN_TEAM,
          message: `Agent ${agentIdInput} 不在团队内`,
        });
      }
      const teamMemberIdLegacy = legacyTeamMember?.id ?? null;
      if (teamMemberIdLegacy) {
        const existingLegacy = await this.prisma.chatChannel.findFirst({
          where: {
            teamId: legacyTask.teamId,
            teamMemberId: teamMemberIdLegacy,
          } as any,
          include: CHANNEL_TASK_SELECT,
        });
        if (existingLegacy) {
          if ((existingLegacy as any).deletedAt) {
            const revived = await this.prisma.chatChannel.update({
              where: { id: existingLegacy.id },
              data: { deletedAt: null },
              include: CHANNEL_TASK_SELECT,
            });
            return this.toChannelDto(revived);
          }
          return this.toChannelDto(existingLegacy);
        }
      }
    }
    if (!teamId) {
      throw new BadRequestException({
        code: CHAT_ERRORS.TEAM_NOT_FOUND,
        message: 'teamId 必填',
      });
    }
    const team = await (this.prisma as any).team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) {
      throw new NotFoundException({
        code: CHAT_ERRORS.TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    let teamMember: { id: string; agentId: string } | null = null;
    if (teamMemberIdInput) {
      teamMember = await (this.prisma as any).teamMember.findUnique({
        where: { id: teamMemberIdInput },
        select: { id: true, agentId: true, teamId: true, memberId: true },
      });
      if (!teamMember) {
        throw new NotFoundException({
          code: CHAT_ERRORS.TEAM_NOT_FOUND,
          message: '团队成员不存在',
        });
      }
      if ((teamMember as any).teamId !== teamId) {
        throw new BadRequestException({
          code: CHAT_ERRORS.MENTION_AGENT_NOT_IN_TEAM,
          message: '团队成员不属于该团队',
        });
      }
    } else if (agentIdInput) {
      const agent = await this.prisma.agent.findUnique({
        where: { id: agentIdInput },
        select: { id: true },
      });
      if (!agent) {
        throw new NotFoundException({
          code: CHAT_ERRORS.AGENT_NOT_FOUND,
          message: 'Agent 不存在',
        });
      }
      teamMember = await (this.prisma as any).teamMember.findFirst({
        where: { teamId, agentId: agentIdInput },
        orderBy: [{ seq: 'asc' }, { id: 'asc' }],
        select: { id: true, agentId: true, memberId: true },
      });
      if (!teamMember) {
        throw new BadRequestException({
          code: CHAT_ERRORS.MENTION_AGENT_NOT_IN_TEAM,
          message: `Agent ${agentIdInput} 不在团队内`,
        });
      }
    } else {
      throw new BadRequestException({
        code: CHAT_ERRORS.MENTION_AGENT_NOT_IN_TEAM,
        message: 'teamMemberId 或 agentId 必填',
      });
    }
    const memberId = resolvedMemberId ?? (teamMember as any).memberId ?? null;
    // P4：成员维度优先复用「该成员已有的 private 频道」（全局一个 DM），
    // 不再要求 (teamId, teamMemberId) 完全一致；旧形状（teamId+teamMemberId）
    // 只要席位已挂 member_id 也走成员复用，避免同一成员在不同群各建一条私聊频道。
    const existing = memberId
      ? await this.prisma.chatChannel.findFirst({
          where: {
            memberId,
            type: CHANNEL_TYPE.private,
          } as any,
          orderBy: { createdAt: 'asc' },
          include: CHANNEL_TASK_SELECT,
        })
      : await this.prisma.chatChannel.findFirst({
          where: { teamId, teamMemberId: teamMember.id } as any,
          include: CHANNEL_TASK_SELECT,
        });
    if (existing) {
      const needRevive = !!(existing as any).deletedAt;
      const needMember = !!(memberId && !(existing as any).memberId);
      if (needRevive || needMember) {
        const updated = await this.prisma.chatChannel.update({
          where: { id: existing.id },
          data: {
            ...(needRevive ? { deletedAt: null } : {}),
            ...(needMember ? { memberId } : {}),
          } as any,
          include: CHANNEL_TASK_SELECT,
        });
        return this.toChannelDto(updated);
      }
      return this.toChannelDto(existing);
    }
    const channel = await this.prisma.chatChannel.create({
      data: {
        id: await this.idGen.nextId(CHANNEL_ID_PREFIX),
        type: CHANNEL_TYPE.private,
        teamId,
        memberId,
        teamMemberId: teamMember.id,
        agentId: teamMember.agentId,
        taskId: null,
      } as any,
      include: CHANNEL_TASK_SELECT,
    });
    return this.toChannelDto(channel);
  }

  /**
   * 删除会话（UX-09 soft delete）：deletedAt 置当前时间，频道从列表隐藏、不可再访问。
   * 权限经 resolveChannelAccess（已删除频道 → 404）；重复删除同频道 → 404（幂等）。
   */
  async removeChannel(channelId: string, userId: string) {
    await this.resolveChannelAccess(channelId, userId);
    const updated = await this.prisma.chatChannel.update({
      where: { id: channelId },
      data: { deletedAt: new Date() },
      select: { id: true, deletedAt: true },
    });
    return {
      id: updated.id,
      deletedAt: updated.deletedAt.toISOString(),
    };
  }

  /**
   * 置顶/取消置顶（UX-09 PATCH /channels/:id {pinned}）：
   * pinned=true 置顶（列表排序优先），false 取消；返回更新后频道 DTO。
   */
  async updateChannelPinned(
    channelId: string,
    userId: string,
    pinned: boolean,
  ) {
    await this.resolveChannelAccess(channelId, userId);
    const updated = await this.prisma.chatChannel.update({
      where: { id: channelId },
      data: { pinned },
      include: CHANNEL_TASK_SELECT,
    });
    return this.toChannelDto(updated);
  }

  /**
   * 标记已读（UX-09 PATCH /channels/:id/read）：lastReadAt 置当前时间。
   * channel 级简化（非用户粒度——共享群聊的用户级已读需 MessageRead 关联表，评估后本期不做）。
   */
  async markChannelRead(channelId: string, userId: string) {
    await this.resolveChannelAccess(channelId, userId);
    const updated = await this.prisma.chatChannel.update({
      where: { id: channelId },
      data: { lastReadAt: new Date() },
      select: { id: true, lastReadAt: true },
    });
    return {
      id: updated.id,
      lastReadAt: updated.lastReadAt.toISOString(),
    };
  }

  /**
   * P4：成员跨群私聊消息聚合读（不移动历史消息）。
   * 成员的 private 频道可能来自多个群（历史数据），这里按 memberId 聚合后统一分页；
   * 可见性沿用会话聚合口径（调用者与成员至少共享一个团队）。
   */
  async findMemberMessages(
    memberId: string,
    userId: string,
    query: QueryMessagesDto,
  ) {
    await this.assertMemberChatVisible(memberId, userId);
    const channels = await this.prisma.chatChannel.findMany({
      where: { memberId, type: CHANNEL_TYPE.private } as any,
      select: { id: true },
    });
    if (channels.length === 0) {
      return { items: [], nextCursor: null as string | null };
    }
    const limit = this.normalizeLimit(query.limit);
    const idRows = await this.prisma.message.findMany({
      where: {
        channelId: { in: channels.map((c) => c.id) },
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: { id: true },
    });
    const hasMore = idRows.length > limit;
    const ids = idRows.slice(0, limit).map((r) => r.id);
    const rows = await this.loadMessageRowsInIdOrder(ids);
    return {
      items: [...rows].reverse().map((row) => this.toMessageDto(row)),
      nextCursor: hasMore ? ids[ids.length - 1] : null,
    };
  }

  /** P4：成员私聊已读 —— 一次把该成员所有 private 频道置为已读。 */
  async markMemberRead(memberId: string, userId: string) {
    await this.assertMemberChatVisible(memberId, userId);
    const now = new Date();
    const updated = await this.prisma.chatChannel.updateMany({
      where: { memberId, type: CHANNEL_TYPE.private } as any,
      data: { lastReadAt: now },
    });
    return { memberId, updated: updated.count, lastReadAt: now.toISOString() };
  }

  /** 成员私聊可见性：成员存在 + 调用者与其至少共享一个团队（对齐 conversations 口径）。 */
  private async assertMemberChatVisible(memberId: string, userId: string) {
    const member = await this.prisma.member.findUnique({
      where: { id: memberId },
      select: { id: true },
    });
    if (!member) {
      throw new NotFoundException({
        code: CHAT_ERRORS.MEMBER_NOT_FOUND,
        message: `成员 ${memberId} 不存在`,
      });
    }
    const seats = await this.prisma.teamMember.findMany({
      where: { memberId },
      select: { teamId: true },
    });
    const teamIds = [...new Set(seats.map((s) => s.teamId))];
    const visible =
      teamIds.length > 0
        ? await this.prisma.teamUserMember.findFirst({
            where: { userId, teamId: { in: teamIds } },
            select: { id: true },
          })
        : null;
    if (!visible) {
      throw new ForbiddenException({
        code: CHAT_ERRORS.TEAM_FORBIDDEN,
        message: '无权访问该成员的私聊',
      });
    }
  }

  /**
   * 群 @ 触发 DM 镜像：为单个已 dispatched 显式目标落一条触发用户消息的逐字拷贝。
   * content/mentions 按落库行原样复制（含 parts 推理/工具/文本，前端渲染与群侧一致）；
   * 附件随行透传：新列数组 + 旧三字段（= 首个附件）双写（源行可能是旧三字段历史行，
   * 故统一经 normalizeMessageAttachments 归一化后再写）；senderType=user + 同 senderId；
   * taskId 置空（DM 无任务分区）。
   */
  private async mirrorGroupMentionToDm(
    teamId: string,
    target: TriggerResult,
    sourceMessage: MessageRow,
    senderId: string | null,
  ): Promise<void> {
    let teamMemberId: string | null = target.instanceId?.startsWith('tmm_')
      ? target.instanceId
      : null;
    let agentId: string = target.agentId;
    if (!teamMemberId) {
      const member = await (this.prisma as any).teamMember.findFirst({
        where: { teamId, agentId: target.agentId },
        select: { id: true, agentId: true },
      });
      if (!member) return;
      teamMemberId = member.id;
      agentId = member.agentId;
    }
    const privateChannelId = await this.ensureMirrorPrivateChannel(
      teamId,
      teamMemberId,
      agentId,
    );
    if (!privateChannelId) return;
    // 附件归一化：源行新列优先、旧三字段回退单元素（历史行兼容），镜像行双写。
    const attachments = normalizeMessageAttachments(sourceMessage);
    const storedAttachments = toStoredAttachments(attachments);
    const mirror = await this.prisma.message.create({
      data: {
        id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
        channelId: privateChannelId,
        senderType: SENDER_TYPE.user,
        senderId,
        content: sourceMessage.content as Prisma.InputJsonValue,
        mentions: (sourceMessage.mentions ?? []) as Prisma.InputJsonValue,
        status: MESSAGE_STATUS.sent,
        ...(storedAttachments ? { attachments: storedAttachments } : {}),
        ...legacyAttachmentFields(attachments),
      },
    });
    await this.realtime.broadcast(
      EVENT_TYPES.CHAT_MESSAGE_NEW,
      { message: this.toMessageDto(mirror as any) },
      { type: 'channel', id: privateChannelId },
    );
    await this.realtime.broadcast(
      EVENT_TYPES.CHAT_MESSAGE_NEW,
      { message: this.toMessageDto(mirror as any) },
      { type: 'team', id: teamId } as any,
    );
  }

  /**
   * 镜像用私聊频道确保：复用 POST /dm-channels 的 teamId+teamMemberId 幂等语义
   * （已存在复用、soft-delete 复活、缺失创建），无鉴权分支（调用方已过群授权）。
   */
  private async ensureMirrorPrivateChannel(
    teamId: string,
    teamMemberId: string,
    agentId: string,
  ): Promise<string | null> {
    const existing = await this.prisma.chatChannel.findFirst({
      where: { teamId, teamMemberId } as any,
    });
    if (existing) {
      if ((existing as any).deletedAt) {
        const revived = await this.prisma.chatChannel.update({
          where: { id: existing.id },
          data: { deletedAt: null },
        });
        return (revived as any)?.id ?? null;
      }
      return existing.id;
    }
    const created = await this.prisma.chatChannel.create({
      data: {
        id: await this.idGen.nextId(CHANNEL_ID_PREFIX),
        type: CHANNEL_TYPE.private,
        teamId,
        teamMemberId,
        agentId,
        taskId: null,
      } as any,
    });
    return (created as any)?.id ?? null;
  }

  private async resolveChannelAccess(
    channelId: string,
    userId: string,
    taskIdHint?: string | null,
  ): Promise<{
    channel: ChannelRow;
    task: {
      id?: string;
      status: string;
      teamId?: string | null;
    };
  }> {
    const channel = await this.prisma.chatChannel.findUnique({
      where: { id: channelId },
      include: CHANNEL_TASK_SELECT,
    });
    if (!channel || (channel as any).deletedAt) {
      throw new NotFoundException({
        code: CHAT_ERRORS.CHANNEL_NOT_FOUND,
        message: '频道不存在',
      });
    }
    const row = channel as unknown as ChannelRow;
    if (row.teamId) {
      const team = await (this.prisma as any).team.findUnique({
        where: { id: row.teamId },
        select: { id: true },
      });
      if (!team) {
        throw new NotFoundException({
          code: CHAT_ERRORS.TEAM_NOT_FOUND,
          message: '团队不存在',
        });
      }
      let task: any = null;
      if (taskIdHint) {
        task = await (this.prisma as any).task.findUnique({
          where: { id: taskIdHint },
          select: {
            id: true,
            status: true,
            teamId: true,
          },
        });
      } else if (row.taskId) {
        task = (row as any).task ?? null;
      } else if ((row as any).task) {
        task = (row as any).task;
      } else {
        const teamId = row.teamId;
        const curTeam = await (this.prisma as any).team.findUnique({
          where: { id: teamId },
          select: { currentTaskId: true },
        });
        if (curTeam?.currentTaskId) {
          task = await (this.prisma as any).task.findUnique({
            where: { id: curTeam.currentTaskId },
            select: {
              id: true,
              status: true,
              teamId: true,
            },
          });
        }
        if (!task) {
          // F-B：fallback 跳过 archived，最新为归档时不再用归档任务占位；
          // 无可用任务则走下方团队直聊合成上下文（createMessage 同步降级）。
          task = await (this.prisma as any).task.findFirst({
            where: { teamId, status: { not: TASK_STATUS.archived } },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              status: true,
              teamId: true,
            },
          });
        }
      }
      if (task) {
        // channel → taskId → teamId → teamUserMember：任务归属团队即授权域。
        // 无 teamId 归属的任务上下文 fail closed（project 维度已拆除，无回退链）。
        const taskTeamId = (task.teamId as string | null | undefined) ?? null;
        if (!taskTeamId) {
          throw new ForbiddenException({
            code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
            message: '您不是该团队成员',
          });
        }
        const member = await (this.prisma as any).teamUserMember.findUnique({
          where: {
            teamId_userId: { teamId: taskTeamId, userId },
          },
          select: { id: true },
        });
        if (!member) {
          throw new ForbiddenException({
            code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
            message: '您不是该团队成员',
          });
        }
        return { channel: row, task };
      }
      // 团队频道无任务上下文：调用者须为 team_user_members 成员，否则 403
      // （PERMISSION_TEAM_NOT_MEMBER；禁止放行到“登录即可聊”）。
      const teamMember = await (this.prisma as any).teamUserMember.findUnique({
        where: {
          teamId_userId: { teamId: row.teamId, userId },
        },
        select: { id: true },
      });
      if (!teamMember) {
        throw new ForbiddenException({
          code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
          message: '您不是该团队成员',
        });
      }
      return {
        channel: row,
        task: {
          status: 'pending',
          teamId: row.teamId,
        } as any,
      };
    }
    throw new NotFoundException({
      code: CHAT_ERRORS.CHANNEL_NOT_FOUND,
      message: '频道不存在',
    });
  }

  /**
   * 主 agent 门禁判定：团队存在**未完成**的任务（任一非终态：queued/pending/in_progress/
   * blocked/pending_review）→ 开门（open=true），fan-out 随便派；
   * 团队没有任何任务、或名下任务全是终态（completed/archived）→ 关门（open=false），
   * 仅 mainMemberId 目标可派。mainMemberId 缺失 → 返回
   * open=false + mainMemberId=null（调用方 fail-open）。异常 → null（调用方 fail-open）。
   *
   * 注：此处「未完成」取宽口径 NON_TERMINAL_TASK_STATUSES（有没有活没干完），
   * 与 teams.service.ts 删团队校验用的窄口径「执行中的任务」（in_progress+pending_review）是两个概念。
   */
  private async checkMainAgentGate(
    teamId: string,
  ): Promise<{ open: boolean; mainMemberId: string | null } | null> {
    try {
      const team = await (this.prisma as any).team.findUnique({
        where: { id: teamId },
        select: { mainAgentMemberId: true },
      });
      if (!team) return null;
      const mainMemberId = (team as any).mainAgentMemberId ?? null;
      // 存在任一非终态任务即视为「有未完成的任务」→ 开门（不再看 currentTaskId）。
      const unfinishedTask = await (this.prisma as any).task.findFirst({
        where: { teamId, status: { in: [...NON_TERMINAL_TASK_STATUSES] } },
        select: { id: true },
      });
      return { open: !!unfinishedTask, mainMemberId };
    } catch {
      return null;
    }
  }

  private async resolveMentions(
    key: string | { teamId?: string | null; taskId?: string | null },
    mentions: MentionInput[],
  ): Promise<{ mentionsStored: MentionInput[]; triggers: TriggerResult[] }> {
    let teamId: string | null = null;
    let taskId: string | null = null;
    if (typeof key === 'string') {
      taskId = key;
    } else {
      teamId = key.teamId ?? null;
      taskId = key.taskId ?? null;
    }
    // team-only：触发经团队成员定位团队会话；无 teamId 时经任务归属反查团队
    // （任务只作归属数据，不再读任务实例快照）；无归属 → 空触发。
    if (!teamId && taskId) {
      const ownerTask = await (this.prisma as any).task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      teamId = (ownerTask as any)?.teamId ?? null;
    }
    if (!teamId) return { mentionsStored: mentions, triggers: [] };
    const members = await (this.prisma as any).teamMember.findMany({
      where: { teamId },
      select: TEAM_MEMBER_SELECT,
    });
    const triggers: TriggerResult[] = [];
    for (const mention of mentions) {
      if (mention.type === 'all') {
        for (const memberRow of members ?? []) {
          if ((memberRow as any).removedAt) continue;
          if ((memberRow as any).enabled === false) continue;
          triggers.push(await this.buildTrigger(teamId, memberRow as any));
        }
      } else if (mention.type === 'agent') {
        if (!mention.agentId) {
          throw new BadRequestException({
            code: CHAT_ERRORS.MENTION_AGENT_NOT_IN_TEAM,
            message: 'agent mention 缺少 agentId',
          });
        }
        // 任务分区下前端携带的是成员 id（tmm_）：未命中成员 id 时
        // 按 agentId 回退匹配（同 agent 在团队内即有效）。
        const memberRow =
          (mention.instanceId
            ? (members ?? []).find((r: any) => r.id === mention.instanceId)
            : undefined) ??
          (members ?? []).find((r: any) => r.agentId === mention.agentId);
        if (!memberRow) {
          throw new BadRequestException({
            code: CHAT_ERRORS.MENTION_AGENT_NOT_IN_TEAM,
            message: `Agent ${mention.agentId} 不在团队内`,
          });
        }
        if ((memberRow as any).enabled === false) {
          throw new BadRequestException({
            code: CHAT_ERRORS.AGENT_DISABLED,
            message: `Agent ${mention.agentId} 已禁用，无法发送消息`,
          });
        }
        triggers.push(await this.buildTrigger(teamId, memberRow as any));
      } else if (mention.type === 'user') {
        if (!(mention as { userId?: string }).userId) {
          throw new BadRequestException({
            code: CHAT_ERRORS.MENTION_TYPE_INVALID,
            message: 'user mention 缺少 userId',
          });
        }
      } else {
        throw new BadRequestException({
          code: CHAT_ERRORS.MENTION_TYPE_INVALID,
          message: 'mentions 项 type 仅支持 agent | all | user',
        });
      }
    }
    return { mentionsStored: mentions, triggers };
  }

  /** 单个触发结果：已移除 → agent_removed；禁用 → agent_disabled；未移除查团队会话。 */
  private async buildTrigger(
    teamId: string,
    row: {
      id: string;
      agentId: string;
      removedAt: Date | null;
      enabled?: boolean | null;
      /** 平台成员 id（P3 成员全局会话键；null = 旧席位未回填）。 */
      memberId?: string | null;
    },
  ): Promise<TriggerResult> {
    if (row.removedAt) {
      return {
        agentId: row.agentId,
        instanceId: row.id,
        sessionId: null,
        status: 'agent_removed',
      };
    }
    if (row.enabled === false) {
      return {
        agentId: row.agentId,
        instanceId: row.id,
        sessionId: null,
        status: 'agent_disabled',
      };
    }
    // P3（SESSION_SCOPE=member）：优先成员全局会话 —— 一个成员跨群只有一个 session；
    // 平台成员不存在/未回填时回落旧席位会话，保证开关可渐进开启。
    if (isMemberSessionScope() && row.memberId && this.sessionLifecycle) {
      try {
        const ensured = await this.sessionLifecycle.ensureMemberSession(
          row.memberId,
          { seatId: row.id, teamId },
        );
        return {
          agentId: row.agentId,
          instanceId: row.id,
          sessionId: ensured.id,
          status: 'dispatched',
        };
      } catch (err) {
        this.logger.warn(
          `member-session 解析失败 team=${teamId} seat=${row.id} member=${row.memberId}，回落席位会话: ${(err as Error)?.message ?? err}`,
        );
      }
    }
    // 团队直查：按 (teamId, teamMemberId) 定位团队会话（单成员单会话，
    // 同 agent 多实例会话独立，不再按 agentId 撞首条；任务锚定分支已删）。
    const session = await this.prisma.session.findFirst({
      where: { teamId, teamMemberId: row.id },
      select: { id: true },
    });
    return {
      agentId: row.agentId,
      instanceId: row.id,
      sessionId: session?.id ?? null,
      status: session ? 'dispatched' : 'no_session',
    };
  }

  /** 团队主触发：team.mainAgentMemberId 优先，否则首位成员；无成员 → null。 */
  private async buildMainAgentTrigger(
    teamId: string,
  ): Promise<TriggerResult | null> {
    const t = await (this.prisma as any).team.findUnique({
      where: { id: teamId },
      select: { mainAgentMemberId: true },
    });
    const mainId = (t as any)?.mainAgentMemberId ?? null;
    const row = mainId
      ? await (this.prisma as any).teamMember.findFirst({
          where: { id: mainId, teamId },
          select: TEAM_MEMBER_SELECT,
        })
      : await (this.prisma as any).teamMember.findFirst({
          where: { teamId },
          orderBy: [{ seq: 'asc' }, { id: 'asc' }],
          select: TEAM_MEMBER_SELECT,
        });
    if (!row || (row as any).removedAt || (row as any).enabled === false)
      return null;
    return this.buildTrigger(
      teamId,
      row as {
        id: string;
        agentId: string;
        removedAt: Date | null;
        enabled?: boolean | null;
        memberId?: string | null;
      },
    );
  }

  private toChannelDto(row: ChannelRow) {
    return {
      id: row.id,
      type: row.type,
      teamId: (row as any).teamId ?? null,
      memberId: (row as any).memberId ?? null,
      teamMemberId: (row as any).teamMemberId ?? null,
      taskId: row.taskId,
      agentId: row.agentId,
      pinned: row.pinned,
      lastReadAt: row.lastReadAt ? row.lastReadAt.toISOString() : null,
      task: row.task
        ? {
            id: row.task.id,
            title: row.task.title,
            status: row.task.status,
          }
        : undefined,
      team: (row as any).team
        ? { id: (row as any).team.id, name: (row as any).team.name }
        : undefined,
      // D1（agent-role-decommission todo 5）：`role` 字段名保留，值为频道成员绑定角色的
      // 机器键 `AgentRole.key`；频道无成员绑定 → null。
      agent: row.agent
        ? {
            id: row.agent.id,
            name: row.agent.name,
            role: roleKeyOf((row as any).teamMember),
          }
        : undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** agentMembers 元素：`{id,name,role}`，`role` = 绑定角色的机器键（`AgentRole.key`）。 */
  private toChannelAgentDto(member: {
    agent: { id: string; name: string } | null;
    role?: { key: string; name: string } | null;
  }) {
    if (!member.agent) {
      return null;
    }
    return { ...member.agent, role: roleKeyOf(member) };
  }

  /**
   * 消息 DTO（09 篇 §2.4）：content/mentions 透传 Json；createdAt ISO8601。
   * 附件输出为新数组 `attachments`（新列优先、旧三字段回退单元素）+ 旧三字段
   * （= 首个附件的兼容投影，旧前端仍可直接读）。
   */
  private toMessageDto(row: MessageRow) {
    const attachments = normalizeMessageAttachments(row);
    const legacy = legacyAttachmentFields(attachments);
    return {
      id: row.id,
      channelId: row.channelId,
      senderType: row.senderType,
      senderId: row.senderId,
      senderInstanceId: row.senderInstanceId ?? null,
      content: this.sanitizeInjectedAgentContent(row.senderType, row.content),
      mentions: row.mentions ?? [],
      attachments,
      attachmentUrl: legacy.attachmentUrl ?? null,
      attachmentName: legacy.attachmentName ?? null,
      attachmentType: legacy.attachmentType ?? null,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * 读取期注入提示清洗（无需数据迁移即可修复历史脏数据）：**agent 行** content.parts
   * 里的「注入提示」part（worker 误把服务端拼好的整段用户提示当流式增量回送并落库）
   * 在 DTO 层剔除，并按剩余非 synthetic text part 重算 content.text——
   * 否则正文仍含整段注入块。仅 agent 行：user 行的注入块是服务端**有意**存储的
   * 组装消息展示（见 worker-dispatcher 组装消息回写注释），清洗即为回归。
   */
  private sanitizeInjectedAgentContent(
    senderType: string,
    content: unknown,
  ): unknown {
    if (senderType !== SENDER_TYPE.agent) return content;
    if (content === null || typeof content !== 'object') return content;
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return content;
    const hasInjected = parts.some(
      (p) =>
        p !== null &&
        typeof p === 'object' &&
        isInjectedPromptPart(p as Record<string, unknown>),
    );
    if (!hasInjected) return content;
    const kept = stripInjectedPromptParts(parts);
    return {
      ...(content as Record<string, unknown>),
      text: concatText(kept),
      parts: kept,
    };
  }

  private normalizeLimit(limit?: number): number {
    const l = Number(limit ?? 50);
    if (!Number.isFinite(l)) return 50;
    return Math.min(Math.max(Math.floor(l), 1), 100);
  }
}
