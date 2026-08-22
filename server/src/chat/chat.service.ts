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
import {
  PROJECT_MEMBERSHIP_ERRORS,
} from '../common/guards/project-membership.guard';
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

/** 频道行（含可选的 task / agent 关联，供 DTO 映射）。 */
type ChannelRow = {
  id: string;
  type: string;
  taskId: string;
  agentId: string | null;
  taskAgentId?: string | null;
  pinned: boolean;
  lastReadAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  task?: {
    id: string;
    title: string;
    status: string;
    projectId: string;
    mainAgentInstanceId?: string | null;
    mainAgentId?: string | null;
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

const TEAM_AGENT_SELECT = {
  id: true,
  agentId: true,
  removedAt: true,
  enabled: true,
} as const;

const CHANNEL_TASK_SELECT = {
  task: {
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      // T8 群聊无 @ 自动路由主实例：随频道访问解析一并取主实例字段，免二次查库
      mainAgentInstanceId: true,
      mainAgentId: true,
    },
  },
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
 * 权限：channel → taskId → projectId → project_members 校验（service 层，
 * 路由参数是 :id 非 :pid，ProjectMembershipGuard 的 :id 反查为任务路由，
 * 故本模块自行解析频道归属，对齐 realtime.controller 的 resolveProjectId 链路）。
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
        this.logger.debug(`agent ${e.agentId} loading(${e.phase}) task=${e.taskId}`),
      )
      .onFinal((e) =>
        this.logger.debug(`agent ${e.agentId} final ${e.messageId} task=${e.taskId}`),
      )
      .onError((e) =>
        this.logger.error(`agent ${e.agentId} reply failed: ${e.error} task=${e.taskId}`),
      );
  }

  /** 进程启动：对齐库内 m_/c_ 前缀最大序号（重启续号，防主键冲突）。 */
  async onModuleInit(): Promise<void> {
    await this.seedPrefix(MESSAGE_ID_PREFIX, this.prisma.message);
    await this.seedPrefix(CHANNEL_ID_PREFIX, this.prisma.chatChannel);
  }

  /**
   * 频道列表：调用者可访问的频道（所属任务的项目 ∈ 调用者已加入项目），
   * type 过滤（task_group/private）。返回 `{items, total}`（09 篇 §3.5）。
   */
  async findAccessibleChannels(userId: string, type?: string) {
    if (type !== undefined && type !== CHANNEL_TYPE.task_group && type !== CHANNEL_TYPE.private) {
      throw new BadRequestException({
        code: CHAT_ERRORS.CHANNEL_TYPE_INVALID,
        message: 'type 仅支持 task_group | private',
      });
    }
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    const projectIds = memberships.map((m) => m.projectId);
    const where: Prisma.ChatChannelWhereInput = {
      task: { projectId: { in: projectIds } },
      // UX-09：已删除会话（deletedAt 非空）从列表隐藏（soft delete）
      deletedAt: null,
      ...(type ? { type } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.chatChannel.count({ where }),
      this.prisma.chatChannel.findMany({
        where,
        include: CHANNEL_TASK_SELECT,
        // UX-09：置顶会话优先，其次按创建时间倒序
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);
    return {
      items: rows.map((row) => this.toChannelDto(row)),
      total,
    };
  }

  /** 频道详情：类型/关联任务 + 成员 Agent（任务团队未 removed 列表）。 */
  async findOne(channelId: string, userId: string) {
    const { channel } = await this.resolveChannelAccess(channelId, userId);
    const teamRows = await this.prisma.taskAgent.findMany({
      where: { taskId: channel.taskId, removedAt: null },
      select: {
        agentId: true,
        agent: { select: { id: true, name: true, role: true } },
      },
    });
    return {
      ...this.toChannelDto(channel),
      agentMembers: teamRows.map((r) => r.agent),
    };
  }

  /**
   * 消息历史游标分页（09 篇 §2.2/§3.5、10 篇 §6）：
   * `WHERE channel_id=? AND id<cursor ORDER BY id DESC LIMIT ?`（命中 idx_messages_channel_id）——
   * 首页（cursor 缺省）取**最新** limit 条；cursor = 上页最早一条 id，下一页取更老；
   * items 返回时反转回 id 升序（时间正序，前端直接渲染）；末页 nextCursor=null（取 limit+1 判断是否还有更多）。
   */
  async findMessages(channelId: string, userId: string, query: QueryMessagesDto) {
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
   * 私聊历史 = opencode serve 会话完整历史（任务 DM 需求：任何时间进入私聊都能看到
   * 最新消息 + 完整历史，含 agent 思考/工具调用过程——平台 messages 表只落 ACK+最终回复）。
   *
   * private 频道且其 Session（taskId+taskAgentId → uk_sessions_task_agent）已绑定
   * worker+instanceRef → 调 worker serve `GET /session/{id}/message` 拉全量消息，
   * 转换为平台消息 DTO 返回 `{items, source:'session'}`（items 时间正序，无游标——
   * 会话历史一次性全量返回，前端游标参数忽略）；未绑定 / worker 不可用 → 回退平台
   * messages 表（`{items, nextCursor, source:'db'}`，复用 findMessages 首页语义）。
   * 群聊（task_group）不支持 → 400 SESSION_HISTORY_NOT_SUPPORTED（群聊保持平台表）。
   */
  async getSessionHistory(channelId: string, userId: string) {
    const { channel } = await this.resolveChannelAccess(channelId, userId);
    if (channel.type !== CHANNEL_TYPE.private) {
      throw new BadRequestException({
        code: CHAT_ERRORS.SESSION_HISTORY_NOT_SUPPORTED,
        message: '仅私聊频道支持会话历史（群聊保持平台消息表）',
      });
    }
    // 回退路径：平台 messages 表首页（游标分页 items 时间正序，与前端 findMessages 契约一致）
    const fallback = async () => ({
      items: (await this.findMessages(channelId, userId, {})).items,
      nextCursor: null,
      source: 'db' as const,
    });
    // 频道未绑定实例（taskAgentId 空）→ 无从定位会话，回退平台表
    if (!channel.taskAgentId) {
      return fallback();
    }
    const session = await this.prisma.session.findFirst({
      where: { taskId: channel.taskId, taskAgentId: channel.taskAgentId },
      select: { instanceRef: true, workerId: true, agentId: true, createdAt: true },
    });
    // 会话未绑定 worker/instanceRef（created 态）→ 回退平台表
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
    const worker: WorkerEndpointRef = { id: workerRow.id, capabilities: workerRow.capabilities };
    try {
      const raw = await this.workerClient.getMessages(worker, session.instanceRef);
      return {
        items: this.convertSessionMessages(raw, channel, session),
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
   *   senderInstanceId=channel.taskAgentId；content.text = 非 synthetic text 聚合；
   *   parts 保留 text/reasoning/tool（前端折叠思考 / 工具调用卡片渲染），
   *   step-start/step-finish/snapshot/patch 等过程 part 忽略。
   * - status：serve 历史消息的 step-finish part 并非总是持久化（实测历史轮次常缺失），
   *   故历史 assistant 消息一律 sent；仅**最后一条** assistant 消息且无 step-finish
   *   标 processing（会话末尾可能仍在流式，前端 SSE 增量同 sender 替换去重）。
   * - id：serve 消息 id（msg_ 前缀）或合成 `ses-<序号>`（稳定，前端 SSE 去重按 id）。
   */
  private convertSessionMessages(
    raw: unknown[],
    channel: { id: string; agentId: string | null; taskAgentId?: string | null },
    session: { agentId: string; createdAt: Date },
  ): Array<Record<string, unknown>> {
    const fallbackCreated = session.createdAt.getTime();
    const sorted = [...raw].sort((a, b) => {
      const ta = (a as { info?: { time?: { created?: number } } })?.info?.time?.created;
      const tb = (b as { info?: { time?: { created?: number } } })?.info?.time?.created;
      return (ta ?? fallbackCreated) - (tb ?? fallbackCreated);
    });
    const converted: Array<{ dto: Record<string, unknown>; hasFinish: boolean }> = [];
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
              (p) => p.type === 'text' || p.type === 'reasoning' || p.type === 'tool',
            );
      // 空消息（无文本且无保留 parts，如仅 step-start 的空壳）→ 跳过
      if (!text && kept.length === 0) continue;
      const hasFinish = parts.some(
        (p) => p.type === 'step-finish' && p.reason === 'stop',
      );
      const createdMs =
        typeof info.time?.created === 'number' ? info.time.created : fallbackCreated;
      converted.push({
        dto: {
          id:
            typeof info.id === 'string' && info.id
              ? info.id
              : `ses-${String(seq).padStart(4, '0')}`,
          channelId: channel.id,
          senderType: role === 'user' ? SENDER_TYPE.user : SENDER_TYPE.agent,
          senderId: role === 'user' ? null : (channel.agentId ?? session.agentId),
          senderInstanceId: role === 'user' ? null : (channel.taskAgentId ?? null),
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
    const last = [...converted].reverse().find((c) => c.dto.senderType === SENDER_TYPE.agent);
    if (last && !last.hasFinish) {
      last.dto.status = MESSAGE_STATUS.processing;
    }
    return converted.map((c) => c.dto);
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
  async getTriggerResults(channelId: string, userId: string, messageId: string) {
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

    const teamRows = await this.prisma.taskAgent.findMany({
      where: { taskId: channel.taskId },
      select: TEAM_AGENT_SELECT,
    });

    // 被 @ Agent 集合：agent 型直取（带 instanceId 精确到实例）；all 型展开为团队未移除全部实例
    const targetRows: { id: string; agentId: string; removedAt: Date | null }[] = [];
    for (const m of mentions) {
      if (m.type === 'agent' && m.agentId) {
        const row = m.instanceId
          ? teamRows.find((r) => r.id === m.instanceId)
          : teamRows.find((r) => r.agentId === m.agentId && !r.removedAt)
            ?? teamRows.find((r) => r.agentId === m.agentId);
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
      const base = await this.buildTrigger(channel.taskId, row);
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

  /** mentions 列（Json）安全解析：非数组 → 空数组；仅保留 type=agent|all 项（存储格式由 createMessage 保证）。 */
  private parseMentions(mentions: Prisma.JsonValue | null): MentionInput[] {
    if (!Array.isArray(mentions)) return [];
    return mentions.filter(
      (m): m is MentionInput =>
        typeof m === 'object' &&
        m !== null &&
        ((m as MentionInput).type === 'agent' || (m as MentionInput).type === 'all'),
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
  async createMessage(channelId: string, userId: string, dto: CreateMessageDto) {
    // 1. 权限校验：频道存在 + 调用者为频道所属项目成员
    const { channel, task } = await this.resolveChannelAccess(channelId, userId);
    // 归档任务频道发消息 → 409（FR-05 归档后仅可查看）
    if (task.status === TASK_STATUS.archived) {
      throw new ConflictException({
        code: CHAT_ERRORS.TASK_ARCHIVED,
        message: '归档任务频道不允许发消息',
      });
    }

    // 2. @ 解析：agentId 须在任务团队内（未 removed → dispatched / 无会话 → no_session；
    //    已 removed → agent_removed；不在团队 → 400）；all 展开为团队全部未移除 Agent
    const { mentionsStored, triggers } = await this.resolveMentions(
      channel.taskId,
      dto.mentions ?? [],
    );

    // 2.5 T8 群聊无 @ 自动路由主实例：频道为 task_group 且用户未 @ 任何人（triggers 空）
    //    → 解析任务主实例并追加 trigger（mainAgentInstanceId 优先，回退 mainAgentId 第一
    //    未移除实例）；主实例已 removed/无主实例 → 不触发。有 @ 消息不叠加（保持 @ 语义）。
    if (channel.type === CHANNEL_TYPE.task_group && triggers.length === 0) {
      const mainTrigger = await this.buildMainAgentTrigger(channel.taskId, task);
      if (mainTrigger) {
        triggers.push(mainTrigger);
      }
    }

    // 3. 落库（用户消息：senderType=user，status=sent，id=m_<序号>；
    //    UX-10：附件三字段可选，客户端已先 POST /uploads 拿到可访问 URL）
    const message = await this.prisma.message.create({
      data: {
        id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
        channelId,
        senderType: SENDER_TYPE.user,
        senderId: userId,
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

    // 4. 广播用户消息到频道订阅者（先落库后转发，08 篇 §7.3）
    await this.realtime.broadcast(
      EVENT_TYPES.CHAT_MESSAGE_NEW,
      { message: this.toMessageDto(message) },
      { type: 'channel', id: channelId },
    );

    // 5. 分派：仅 dispatched 目标下发；6. 上下文注入：Phase 2 mock 模式跳过（Phase 4 注入）。
    //    fire-and-forget：201 同步返回受理（09 篇 §5.1「同步返回分派受理，处理结果走 SSE」），
    //    回复时序（延迟 → loading 两阶段 → 落库 → 广播）由分派器异步完成。
    const targets = triggers.filter((t) => t.status === 'dispatched');
    void this.dispatcher
      .dispatch({
        messageId: message.id,
        channelId,
        taskId: channel.taskId,
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
      message: this.toMessageDto(message),
      triggers,
    };
  }

  /**
   * 创建 private 私聊频道（FR-14，09 篇 §3.5 POST /dm-channels）。
   * T6 实例语义：dto.taskAgentId 存在 → 按 (taskId, taskAgentId) 幂等（uk_channels_task_agent），
   * 同 agent 多实例各自独立频道；缺省回退 (taskId, agentId)（单实例/存量兼容）。
   */
  async createDmChannel(userId: string, dto: CreateDmChannelDto) {
    const task = await this.prisma.task.findUnique({
      where: { id: dto.taskId },
      select: { projectId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: CHAT_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    // 权限：调用者须为任务所属项目成员
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: task.projectId, userId } },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException({
        code: PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该项目成员',
      });
    }
    const agent = await this.prisma.agent.findUnique({
      where: { id: dto.agentId },
      select: { id: true },
    });
    if (!agent) {
      throw new NotFoundException({
        code: CHAT_ERRORS.AGENT_NOT_FOUND,
        message: 'Agent 不存在',
      });
    }
    // T6 实例语义：taskAgentId 缺省回退该 agent 第一实例（存量客户端/单实例任务兼容）
    let taskAgentId = dto.taskAgentId;
    if (!taskAgentId) {
      const fallback = await this.prisma.taskAgent.findFirst({
        where: { taskId: dto.taskId, agentId: dto.agentId, removedAt: null },
        orderBy: { seq: 'asc' },
        select: { id: true },
      });
      taskAgentId = fallback?.id ?? null;
    }
    // 幂等：同任务同实例私聊频道已存在则返回已有频道（T6：同 agent 多实例各自独立）
    const existing = await this.prisma.chatChannel.findFirst({
      where: taskAgentId
        ? { taskId: dto.taskId, taskAgentId }
        : { taskId: dto.taskId, agentId: dto.agentId, taskAgentId: null },
      include: CHANNEL_TASK_SELECT,
    });
    if (existing) {
      // UX-09：已 soft delete 的私聊频道 → 复活（deletedAt 置空，复用原记录，避开唯一键冲突）
      if (existing.deletedAt) {
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
        taskId: dto.taskId,
        agentId: dto.agentId,
        ...(taskAgentId ? { taskAgentId } : {}),
      },
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
  async updateChannelPinned(channelId: string, userId: string, pinned: boolean) {
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
   * 频道访问解析（权限链路：channel → taskId → projectId → project_members）：
   * 频道不存在或已删除 404 CHANNEL_NOT_FOUND；非项目成员 403 PERMISSION_PROJECT_NOT_MEMBER。
   * 返回频道行 + 关联任务（projectId 供权限、status 供归档校验）。
   */
  private async resolveChannelAccess(channelId: string, userId: string): Promise<{
    channel: ChannelRow;
    task: {
      projectId: string;
      status: string;
      mainAgentInstanceId?: string | null;
      mainAgentId?: string | null;
    };
  }> {
    const channel = await this.prisma.chatChannel.findUnique({
      where: { id: channelId },
      include: CHANNEL_TASK_SELECT,
    });
    if (!channel || channel.deletedAt) {
      throw new NotFoundException({
        code: CHAT_ERRORS.CHANNEL_NOT_FOUND,
        message: '频道不存在',
      });
    }
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: channel.task.projectId, userId } },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException({
        code: PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该项目成员',
      });
    }
    return { channel, task: channel.task };
  }

  /**
   * @ 解析（10 篇 §4.1 / 09 篇 §5.1 第 2 步）：
   * - agent 型：agentId 必须在任务虚拟团队内（task_agents）——
   *   未 removed → 按会话有无给 dispatched/no_session；已 removed → agent_removed；
   *   不在团队 → 400 MENTION_AGENT_NOT_IN_TEAM；
   * - all 型：展开为当前团队全部未移除 Agent；
   * - type 非法 → 400 MENTION_TYPE_INVALID。
   * 落库 mentions 保持提交原样（all 语义原样存储），解析结果经 triggers 返回。
   */
  private async resolveMentions(
    taskId: string,
    mentions: MentionInput[],
  ): Promise<{ mentionsStored: MentionInput[]; triggers: TriggerResult[] }> {
    const teamRows = await this.prisma.taskAgent.findMany({
      where: { taskId },
      select: TEAM_AGENT_SELECT,
    });
    const triggers: TriggerResult[] = [];

    for (const mention of mentions) {
      if (mention.type === 'all') {
        for (const row of teamRows) {
          if (!row.removedAt && row.enabled !== false) {
            triggers.push(await this.buildTrigger(taskId, row));
          }
        }
      } else if (mention.type === 'agent') {
        if (!mention.agentId) {
          throw new BadRequestException({
            code: CHAT_ERRORS.MENTION_AGENT_NOT_IN_TEAM,
            message: 'agent mention 缺少 agentId',
          });
        }
        // T6 实例语义：mention 携带 instanceId → 按实例精确解析（同 agent 多实例
        // 各自触发自身会话）；缺省 → 回退该 agent 第一个未移除实例，若该 agent 已无
        // 未移除实例则命中任意状态实例（交 buildTrigger 判 agent_removed，单实例/存量兼容）。
        const row = mention.instanceId
          ? teamRows.find((r) => r.id === mention.instanceId)
          : teamRows.find((r) => r.agentId === mention.agentId && !r.removedAt)
            ?? teamRows.find((r) => r.agentId === mention.agentId);
        if (!row) {
          throw new BadRequestException({
            code: CHAT_ERRORS.MENTION_AGENT_NOT_IN_TEAM,
            message: `Agent ${mention.agentId} 不在任务团队内`,
          });
        }
        if ((row as { enabled?: boolean | null }).enabled === false) {
          throw new BadRequestException({
            code: CHAT_ERRORS.AGENT_DISABLED,
            message: `Agent ${mention.agentId} 已禁用，无法发送消息`,
          });
        }
        triggers.push(await this.buildTrigger(taskId, row));
      } else {
        throw new BadRequestException({
          code: CHAT_ERRORS.MENTION_TYPE_INVALID,
          message: 'mentions 项 type 仅支持 agent | all',
        });
      }
    }

    return { mentionsStored: mentions, triggers };
  }

  /** 单个触发结果：已移除 → agent_removed；禁用 → agent_disabled；未移除查会话。 */
  private async buildTrigger(
    taskId: string,
    row: { id: string; agentId: string; removedAt: Date | null; enabled?: boolean | null },
  ): Promise<TriggerResult> {
    if (row.removedAt) {
      return { agentId: row.agentId, instanceId: row.id, sessionId: null, status: 'agent_removed' };
    }
    if (row.enabled === false) {
      return { agentId: row.agentId, instanceId: row.id, sessionId: null, status: 'agent_disabled' };
    }
    // T6 实例语义：按 taskAgentId 定位会话（同 agent 多实例会话独立，不再按 agentId 撞首条）
    const session = await this.prisma.session.findFirst({
      where: { taskId, taskAgentId: row.id },
      select: { id: true },
    });
    return {
      agentId: row.agentId,
      instanceId: row.id,
      sessionId: session?.id ?? null,
      status: session ? 'dispatched' : 'no_session',
    };
  }

  /**
   * T8 群聊无 @ 自动路由主实例（createMessage 步骤 2.5）：
   * - task.mainAgentInstanceId 优先 → 查该实例行（须在任务团队内）；
   * - 缺省回退 task.mainAgentId → 该 agent 第一个未移除实例（seq 升序）；
   * - 实例不存在 / 已 removed / 任务无主实例配置 → 返回 null（triggers 保持空，不触发）；
   * 命中未移除实例 → 复用 buildTrigger（按 taskAgentId 查会话 → dispatched/no_session）。
   */
  private async buildMainAgentTrigger(
    taskId: string,
    task: { mainAgentInstanceId?: string | null; mainAgentId?: string | null },
  ): Promise<TriggerResult | null> {
    let row: { id: string; agentId: string; removedAt: Date | null } | null = null;
    if (task.mainAgentInstanceId) {
      row = await this.prisma.taskAgent.findFirst({
        where: { id: task.mainAgentInstanceId, taskId },
        select: TEAM_AGENT_SELECT,
      });
    } else if (task.mainAgentId) {
      row = await this.prisma.taskAgent.findFirst({
        where: { taskId, agentId: task.mainAgentId, removedAt: null },
        orderBy: { seq: 'asc' },
        select: TEAM_AGENT_SELECT,
      });
    }
    if (!row || row.removedAt || (row as { enabled?: boolean | null }).enabled === false) {
      return null;
    }
    return this.buildTrigger(taskId, row as { id: string; agentId: string; removedAt: Date | null; enabled?: boolean | null });
  }

  /** 频道 DTO：id/type/taskId/agentId/taskAgentId + 关联 task/agent + pinned/lastReadAt + createdAt（ISO8601）。 */
  private toChannelDto(row: ChannelRow) {
    return {
      id: row.id,
      type: row.type,
      taskId: row.taskId,
      agentId: row.agentId,
      taskAgentId: row.taskAgentId ?? null,
      pinned: row.pinned,
      lastReadAt: row.lastReadAt ? row.lastReadAt.toISOString() : null,
      task: row.task
        ? {
            id: row.task.id,
            title: row.task.title,
            status: row.task.status,
            projectId: row.task.projectId,
          }
        : undefined,
      agent: row.agent ? { id: row.agent.id, name: row.agent.name, role: row.agent.role } : undefined,
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
      findFirst(args: { orderBy: { id: 'desc' }; select: { id: true } }): Promise<{ id: string } | null>;
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
