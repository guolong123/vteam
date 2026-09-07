import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { TASK_STATUS } from '../common/constants/task.constants';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerClient, WorkerEndpointRef } from '../workers/worker.client';
import { CHAT_ERRORS } from './chat.constants';
import { CreateDmChannelDto } from './dto/create-dm-channel.dto';
import { CreateMessageDto, MentionInput } from './dto/create-message.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';
import { MessageDispatcher } from './message-dispatcher';

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
    mainAgentInstanceId?: string | null;
    mainAgentId?: string | null;
  } | null;
  team?: { id: string; name: string } | null;
  teamMember?: {
    id: string;
    agentId: string;
    alias: string | null;
    seq: number;
  } | null;
  agent?: { id: string; name: string; role: string | null } | null;
};

/** 消息行（messages 表；content/mentions 为 Json 列，附件三字段可空）。 */
type MessageRow = {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string | null;
  senderInstanceId?: string | null;
  content: Prisma.JsonValue;
  mentions: Prisma.JsonValue | null;
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
} as const;

const CHANNEL_TASK_SELECT = {
  task: {
    select: {
      id: true,
      title: true,
      status: true,
      teamId: true,
      mainAgentInstanceId: true,
      mainAgentId: true,
    },
  },
  team: { select: { id: true, name: true } },
  teamMember: { select: { id: true, agentId: true, alias: true, seq: true } },
  agent: { select: { id: true, name: true, role: true } },
} as const;

/**
 * 群聊模块（09 篇 §3.5 Chat；10 篇 消息/频道/触发机制）。
 *
 * 端点：
 * - GET    /channels?type=           调用者可访问频道列表（task_group + private）
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

  /** 进程启动：对齐库内 m_/c_ 前缀最大序号（重启续号，防主键冲突）。 */
  async onModuleInit(): Promise<void> {
    await this.seedPrefix(MESSAGE_ID_PREFIX, this.prisma.message);
    await this.seedPrefix(CHANNEL_ID_PREFIX, this.prisma.chatChannel);
  }

  async findAccessibleChannels(
    userId: string,
    type?: string,
    teamId?: string,
    taskId?: string,
  ) {
    if (type === CHANNEL_TYPE.task_group) {
      throw new BadRequestException({
        code: CHAT_ERRORS.CHANNEL_TYPE_DEPRECATED,
        message: 'task_group 已废弃，请使用 team_group',
      });
    }
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
          agent: { select: { id: true, name: true, role: true } },
        },
      });
      return {
        ...this.toChannelDto(channel),
        agentMembers: teamRows.map((r: any) => r.agent),
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
        agent: { select: { id: true, name: true, role: true } },
      },
    });
    return {
      ...this.toChannelDto(channel),
      agentMembers: ownerRows.map((r: any) => r.agent),
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
    const where: Prisma.MessageWhereInput = {
      channelId,
      ...(query.cursor ? { id: { lt: query.cursor } } : {}),
    };
    const rows = await this.prisma.message.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      // page 为 id 降序（最新优先），反转回升序供前端时间正序渲染
      items: [...page].reverse().map((row) => this.toMessageDto(row)),
      // 当前页最早一条 id（降序下为 page 末项），供下一页取更老
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * 私聊历史 = 平台 DB 全量为真源 + opencode serve 会话仅作 agent 增补
   * （DM-own-message 修复：用户自己的消息只存在于平台 messages 表——worker 侧
   * 用户文本经 prompt 注入拼进上下文消息，无独立条目，纯 session 源永远缺 own 消息；
   * 且 POST 后立即 refetch 会遇到 worker 未 ingest 窗口。合并后 refetch 恒含 DB 行）。
   *
   * private 频道且其 Session（teamMember 维度按 teamMemberId 查；无成员维度
   * 回退平台表，任务锚定分支已删）已绑定 worker+instanceRef → 调 worker serve
   * `GET /session/{id}/message` 拉会话消息，转换后与 DB 合并返回
   * `{items, source:'session'}`（items 时间正序，无游标——前端游标参数忽略）；
   * 未绑定 / worker 不可用 → 回退平台 messages 表（`{items, nextCursor, source:'db'}`，
   * 复用 findMessages 首页语义）。群聊（task_group）不支持 → 400
   * SESSION_HISTORY_NOT_SUPPORTED（群聊保持平台表）。
   */
  async getSessionHistory(channelId: string, userId: string) {
    const { channel } = await this.resolveChannelAccess(channelId, userId);
    if (channel.type !== CHANNEL_TYPE.private) {
      throw new BadRequestException({
        code: CHAT_ERRORS.SESSION_HISTORY_NOT_SUPPORTED,
        message: '仅私聊频道支持会话历史（群聊保持平台消息表）',
      });
    }
    const fallback = async () => ({
      items: (await this.findMessages(channelId, userId, {})).items,
      nextCursor: null,
      source: 'db' as const,
    });
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
      sessions.find((s) => !!s.instanceRef && !!s.workerId) ?? sessions[0] ?? null;
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
      const raw = await this.workerClient.getMessages(
        worker,
        session.instanceRef,
      );
      const sessionItems = this.convertSessionMessages(raw, channel, session);
      return {
        items: await this.mergeSessionWithPlatform(channelId, sessionItems),
        nextCursor: null,
        source: 'session' as const,
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
      // 保留 parts：user 仅 text；assistant 保留 text/reasoning/tool（过程 part 忽略）
      const kept =
        role === 'user'
          ? parts.filter((p) => p.type === 'text' && !p.synthetic)
          : parts.filter(
              (p) =>
                p.type === 'text' ||
                p.type === 'reasoning' ||
                p.type === 'tool',
            );
      // 空消息（无文本且无保留 parts，如仅 step-start 的空壳）→ 跳过
      if (!text && kept.length === 0) continue;
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
          content: { text, parts: kept },
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
   * - 合并按 createdAt 升序（稳定排序，同刻 DB 优先）。
   */
  private async mergeSessionWithPlatform(
    channelId: string,
    sessionItems: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.message.findMany({
      where: { channelId },
      orderBy: { id: 'desc' },
      take: 500,
    });
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
    const supplement = sessionItems.filter((item) => {
      if (item.senderType !== SENDER_TYPE.agent) return false;
      return typeof item.id !== 'string' || !persisted.has(item.id);
    });
    const merged = [...dbItems, ...supplement];
    merged.sort(
      (a, b) =>
        Date.parse(a.createdAt as string) - Date.parse(b.createdAt as string),
    );
    return merged;
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
      mainAgentInstanceId?: string | null;
      mainAgentId?: string | null;
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
              mainAgentInstanceId: true,
              mainAgentId: true,
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
    if (task.status === TASK_STATUS.archived) {
      throw new ConflictException({
        code: CHAT_ERRORS.TASK_ARCHIVED,
        message: '归档任务频道不允许发消息',
      });
    }

    const isTeamPrivate =
      channel.type === CHANNEL_TYPE.private && !!channel.teamId;
    // 团队私聊为团队维度（teamId + teamMemberId），不按任务分区：不继承
    // resolveChannelAccess 为无任务团队频道合成的 currentTask 上下文（否则私聊
    // 误走 task-mode 分派：任务快照会话 + 回复落群聊，DM processing 悬空）。
    // dtoTaskId 亦忽略（私聊无任务分区语义；DM 页从不发送 taskId）。
    const effectiveTaskId: string | null = isTeamPrivate
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
    const isTaskGroup = channel.type === CHANNEL_TYPE.task_group;
    if ((isTeamGroup || isTaskGroup) && triggers.length === 0) {
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

    // 零任务团队 @-mention 补会话（mention-target-fix）：resolveMentions 在无 taskId
    // 时只能降级 no_session（无 task 会话可查），此处对 tmm_ 目标经分派器即建即得
    // 团队会话，翻 dispatched + 回填 sessionId，使下方 targets 过滤 + dispatch()
    // 拾取。B2 无 @ 主触发不动；task-mode（effectiveTaskId 非空）不进本分支；
    // 单成员失败仅日志并保留 no_session，不阻塞其他目标（FR-21 同形）。
    if (!effectiveTaskId && channel.teamId && triggers.length > 0) {
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
    if (
      isTeamPrivate &&
      triggers.length === 0 &&
      channel.teamMemberId
    ) {
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
        ).buildTeamMemberTrigger(channel.teamId as string, channel.teamMemberId);
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
        ...(dto.attachmentUrl
          ? {
              attachmentUrl: dto.attachmentUrl,
              attachmentName: dto.attachmentName ?? null,
              attachmentType: dto.attachmentType ?? null,
            }
          : {}),
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

    // 群触发 DM 镜像（dm-mirror）：team_group/task_group（同一 createMessage
    // 主路径，task_group 共享码道故一并覆盖）来源的用户消息，为每个回答该消息
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
      (isTeamGroup || isTaskGroup) &&
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
      } else if (
        !(dto.mentions ?? []).some((m) => m.type === 'all')
      ) {
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

    // FIFO 排队拦截：team_group 频道下，queued 或非队首任务不应触发模型 dispatch
    // 最小修复：消息仍落库可见，但不触发 dispatcher；前端依 triggers 空提示“排队中”
    let shouldDispatch = true;
    let queueHint: { position: number; currentTaskId: string | null } | null =
      null;
    if (channel.teamId && effectiveTaskId && (isTeamGroup || isTaskGroup)) {
      // 优先用 task.status 判定 queued；其次校验队首一致性（防 pending 双头脏数据）
      if (task.status === TASK_STATUS.queued) {
        shouldDispatch = false;
        try {
          const q = await (this.prisma as any).teamQueue.findUnique({
            where: { taskId: effectiveTaskId },
            select: { position: true },
          });
          const team = await (this.prisma as any).team.findUnique({
            where: { id: channel.teamId },
            select: { currentTaskId: true },
          });
          queueHint = {
            position: q?.position ?? -1,
            currentTaskId: team?.currentTaskId ?? null,
          };
        } catch {}
      } else if ((task as any).teamId) {
        try {
          const team = await (this.prisma as any).team.findUnique({
            where: { id: (task as any).teamId },
            select: { currentTaskId: true },
          });
          if (team?.currentTaskId && team.currentTaskId !== effectiveTaskId) {
            const inQueue = await (this.prisma as any).teamQueue.findUnique({
              where: { taskId: effectiveTaskId },
              select: { position: true },
            });
            if (inQueue) {
              shouldDispatch = false;
              queueHint = {
                position: inQueue.position,
                currentTaskId: team.currentTaskId,
              };
            }
          }
        } catch {}
      }
      if (!shouldDispatch) {
        // 将 dispatched 改为排队提示，避免前端 loading 悬空
        for (const t of triggers) {
          if ((t as any).status === 'dispatched')
            (t as any).status = 'queued' as any;
        }
        // 可选系统提示（不落库，仅日志；如需落库可插入 system 消息）
        this.logger.log(
          `team_group queued 拦截: task=${effectiveTaskId} position=${queueHint?.position} current=${queueHint?.currentTaskId}`,
        );
      }
    }

    if (shouldDispatch) {
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
    } else if (queueHint) {
      // 排队提示系统消息（taskId 分区，team_group 内可见）
      try {
        const hintText =
          queueHint.position > 0
            ? `任务排队中（位置 ${queueHint.position}），队首 ${queueHint.currentTaskId?.slice(0, 8)}… 执行中，完成前暂不触发模型。消息已保存，晋升后可重试。`
            : `任务排队中，暂不触发模型。消息已保存。`;
        const hint = await this.prisma.message.create({
          data: {
            id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
            channelId,
            taskId: effectiveTaskId!,
            senderType: SENDER_TYPE.system,
            senderId: null,
            content: { text: hintText, parts: [] } as Prisma.InputJsonValue,
            mentions: [] as Prisma.InputJsonValue,
            status: MESSAGE_STATUS.sent,
          },
        });
        await this.realtime.broadcast(
          EVENT_TYPES.CHAT_MESSAGE_NEW,
          { message: this.toMessageDto(hint as any) },
          { type: 'channel', id: channelId },
        );
        if (channel.teamId) {
          await this.realtime.broadcast(
            EVENT_TYPES.CHAT_MESSAGE_NEW,
            { message: this.toMessageDto(hint as any) },
            { type: 'team', id: channel.teamId } as any,
          );
        }
      } catch {}
    }

    return {
      message: this.toMessageDto(message as any),
      triggers,
    };
  }

  async createDmChannel(userId: string, dto: CreateDmChannelDto) {
    const teamId = (dto as any).teamId as string | undefined;
    const teamMemberIdInput = (dto as any).teamMemberId as string | undefined;
    const agentIdInput = (dto as any).agentId as string | undefined;
    const legacyTaskId = (dto as any).taskId as string | undefined;
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
            orderBy: { seq: 'asc' },
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
        select: { id: true, agentId: true, teamId: true },
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
        orderBy: { seq: 'asc' },
        select: { id: true, agentId: true },
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
    const existing = await this.prisma.chatChannel.findFirst({
      where: { teamId, teamMemberId: teamMember.id } as any,
      include: CHANNEL_TASK_SELECT,
    });
    if (existing) {
      if ((existing as any).deletedAt) {
        const revived = await this.prisma.chatChannel.update({
          where: { id: existing.id },
          data: { deletedAt: null },
          include: CHANNEL_TASK_SELECT,
        });
        return this.toChannelDto(revived);
      }
      return this.toChannelDto(existing);
    }
    const channel = await this.prisma.chatChannel.create({
      data: {
        id: await this.idGen.nextId(CHANNEL_ID_PREFIX),
        type: CHANNEL_TYPE.private,
        teamId,
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
   * 群 @ 触发 DM 镜像：为单个已 dispatched 显式目标落一条触发用户消息的逐字拷贝。
   * content/mentions 按落库行原样复制（含 parts 推理/工具/文本，前端渲染与群侧一致）；
   * 附件三字段随行透传；senderType=user + 同 senderId；taskId 置空（DM 无任务分区）。
   */
  private async mirrorGroupMentionToDm(
    teamId: string,
    target: TriggerResult,
    sourceMessage: MessageRow,
    senderId: string | null,
  ): Promise<void> {
    let teamMemberId: string | null =
      target.instanceId?.startsWith('tmm_') ? target.instanceId : null;
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
    const mirror = await this.prisma.message.create({
      data: {
        id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
        channelId: privateChannelId,
        senderType: SENDER_TYPE.user,
        senderId,
        content: sourceMessage.content as Prisma.InputJsonValue,
        mentions: (sourceMessage.mentions ??
          []) as Prisma.InputJsonValue,
        status: MESSAGE_STATUS.sent,
        ...(sourceMessage.attachmentUrl
          ? {
              attachmentUrl: sourceMessage.attachmentUrl,
              attachmentName: sourceMessage.attachmentName ?? null,
              attachmentType: sourceMessage.attachmentType ?? null,
            }
          : {}),
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
      mainAgentInstanceId?: string | null;
      mainAgentId?: string | null;
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
            mainAgentInstanceId: true,
            mainAgentId: true,
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
              mainAgentInstanceId: true,
              mainAgentId: true,
            },
          });
        }
        if (!task) {
          task = await (this.prisma as any).task.findFirst({
            where: { teamId },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              status: true,
              teamId: true,
              mainAgentInstanceId: true,
              mainAgentId: true,
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
    const legacyTask = (row as any).task;
    if (!legacyTask) {
      throw new NotFoundException({
        code: CHAT_ERRORS.CHANNEL_NOT_FOUND,
        message: '频道不存在',
      });
    }
    // 旧 task_group 频道：任务有 teamId 归属时走团队成员校验，
    // 无归属时 fail closed（project_members 表已拆除，无回退链）。
    const legacyTeamId =
      (legacyTask.teamId as string | null | undefined) ?? null;
    if (!legacyTeamId) {
      throw new ForbiddenException({
        code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该团队成员',
      });
    }
    const teamMember = await (this.prisma as any).teamUserMember.findUnique({
      where: {
        teamId_userId: { teamId: legacyTeamId, userId },
      },
      select: { id: true },
    });
    if (!teamMember) {
      throw new ForbiddenException({
        code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该团队成员',
      });
    }
    return { channel: row, task: legacyTask };
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
          orderBy: { seq: 'asc' },
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
      },
    );
  }

  private toChannelDto(row: ChannelRow) {
    return {
      id: row.id,
      type: row.type,
      teamId: (row as any).teamId ?? null,
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
      agent: row.agent
        ? { id: row.agent.id, name: row.agent.name, role: row.agent.role }
        : undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 消息 DTO（09 篇 §2.4）：content/mentions 透传 Json；createdAt ISO8601；附件三字段透出（可空）。 */
  private toMessageDto(row: MessageRow) {
    return {
      id: row.id,
      channelId: row.channelId,
      senderType: row.senderType,
      senderId: row.senderId,
      senderInstanceId: row.senderInstanceId ?? null,
      content: row.content,
      mentions: row.mentions ?? [],
      attachmentUrl: row.attachmentUrl,
      attachmentName: row.attachmentName,
      attachmentType: row.attachmentType,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private normalizeLimit(limit?: number): number {
    const l = Number(limit ?? 50);
    if (!Number.isFinite(l)) return 50;
    return Math.min(Math.max(Math.floor(l), 1), 100);
  }

  private async seedPrefix(
    prefix: string,
    model: {
      findFirst(args: {
        orderBy: { id: 'desc' };
        select: { id: true };
      }): Promise<{ id: string } | null>;
    },
  ): Promise<void> {
    const last = await model.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (last) {
      const seq = parseInt(last.id.slice(prefix.length + 1), 10);
      if (Number.isFinite(seq)) {
        this.idGen.seed(prefix, seq);
      }
    }
  }
}
