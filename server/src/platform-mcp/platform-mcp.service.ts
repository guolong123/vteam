import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import {
  ACTOR_TYPE,
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
  SESSION_STATUS,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  DispatchExecutionKind,
  WorkerDispatcher,
} from '../chat/worker-dispatcher';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { ARTIFACT_CATEGORIES } from '../artifacts/artifacts.constants';
import { FileStorageService } from '../uploads/uploads.service';
import { WorkerClient } from '../workers/worker.client';
import { IssuesService } from '../issues/issues.service';
import { IssueStatus, IssueTransitionAction } from '../issues/issues.constants';
import {
  TASK_ERRORS,
  TaskTransitionAction,
} from '../common/constants/task.constants';
import { TasksService } from '../tasks/tasks.service';
import { QuestionsService } from '../questions/questions.service';
import { AGENT_QUESTION_STATUS } from '../questions/questions.constants';
import {
  MEMORY_ERRORS,
  MEMORY_LEVELS,
  MemoryLevel,
  MemorySaveStatus,
  MemoryUpdateStatus,
  computeMemoryContentHash,
} from '../memories/memory.constants';
import {
  PLATFORM_MCP_ERRORS,
  validateTsxPrototype,
} from './platform-mcp.constants';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { SkillsService } from '../skills/skills.service';
import { GitReposService, GitRepoView } from '../git-repos/git-repos.service';
import { parseSkillMarkdown } from '../skills/skill-frontmatter.util';
import { ModuleRef } from '@nestjs/core';
import {
  containsTeamWideMention,
  isThrottleExemptKind,
  MentionThrottle,
  MentionThrottleDecision,
} from '../chat/mention-throttle';
import { MessageReceiptsService } from '../chat/message-receipts.service';
import {
  buildMessageReceiptDedupKey,
  MESSAGE_RECEIPT_KINDS,
  MESSAGE_RECEIPT_STATUSES,
} from '../chat/message-receipt.constants';
import { TriggerService } from '../timers/trigger.service';
import {
  TRIGGER_KIND,
  buildTriggerDedupKey,
} from '../common/constants/trigger.constants';
import {
  normalizeReceiptTimeoutMin,
  RECEIPT_NUDGE_KIND,
  ReceiptNudgePayload,
} from '../chat/receipt-nudge.handler';
import {
  REVIEW_TRIPLET_HINT,
  ensureRoleViewFooter,
  parseReviewTriplet,
  type ReviewDispatchTriplet,
} from '../chat/review-dispatch-triplet';
import { REVIEW_ROUND_TIMEOUT_KIND } from '../chat/review-round-timeout.handler';
import {
  buildStalePlanHashHint,
  isStalePlanHash,
  normalizePlanHash,
  selectFrozenPlanHash,
} from '../issues/plan-hash-gate';
import {
  PLAN_LIFECYCLE_ERRORS,
  PlanLifecycleService,
} from '../tasks/plan-lifecycle.service';
import { ExecutionPolicyService } from '../execution-policies/execution-policy.service';
import { REVIEW_ROUND_TIMEOUT_MS } from '../issues/review-round-gate.service';
import { ReviewRoundService } from '../issues/review-round.service';
import { tryParseLedger } from '../issues/review-round-ledger';
import { HookService } from '../triggers/hook.service';
import {
  buildHookDedupKey,
  HOOK_KIND,
  isHookKind,
} from '../triggers/hook.constants';

/**
 * 消息主键前缀：与 ChatService/WorkerDispatcher 共享 IdGeneratorService 的 'm' 计数
 * （15 篇 §2.2：m_<零填充序号>，数值序 == 字典序，兼作历史游标）。
 */
const MESSAGE_ID_PREFIX = 'm';

/**
 * 计划员模板 Agent id（seed.ts 注册，role=plan）：计划起草/修订派发永非
 * “执行”，计划门禁按目标 agentId 豁免（匹配角色身份，不匹配成员别名）。
 */
const PLAN_AGENT_ID = 'a_plan';

/** MCP 工具调用上下文：workerId 来自请求 header `x-worker-id`（controller 解析后闭包注入）。 */
export interface PlatformMcpContext {
  workerId: string;
}

/**
 * team-free-chat 双执行上下文：task 维度（任务会话）或 team 维度（团队会话）。
 * callerId 为调用方身份（task 维度=任务实例 id，team 维度=团队成员 id）。
 */
export type ExecContext =
  | { kind: 'task'; taskId: string; callerId: string }
  | { kind: 'team'; teamId: string; callerId: string };

/** chat_history 返回的消息行（text 从 content Json 提取，对齐计划 1.2 契约）。
 *  附件三字段 + senderInstanceId 透出（无附件时 null，Agent 据此调 read_file 读取）。 */
export interface ChatHistoryItem {
  id: string;
  senderType: string;
  senderId: string | null;
  text: string;
  createdAt: string;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentType?: string | null;
  senderInstanceId?: string | null;
}

/** chat_history 分页页：items 为本页消息（时间正序），truncated 表示还有未取消息或响应被 64KB 硬上限截断。 */
export interface ChatHistoryPage {
  items: ChatHistoryItem[];
  truncated: boolean;
  total: number;
}
/** group_post 附件挂载（message 表附件三字段，UX-10；attachmentType 为小写 ext）。 */
export interface GroupPostAttachment {
  attachmentUrl: string;
  attachmentName: string;
  attachmentType: string;
}

/** read_file 返回结构：source 标识内容来源（归档命中 / worker 拉取）。 */
export interface ReadFileResult {
  content: string;
  fileName: string;
  fileRef: string;
  source: 'archive' | 'worker';
  /** maxBytes 截断标记：true 时 content 仅含文件前 maxBytes 字节。 */
  truncated?: boolean;
}

/**
 * 统一派发返回契约 reason 词汇（plan-review todo 3，对齐 docs 31 §3 / 32 §3.1-§3.2，
 * todo 4 消费 `duplicate`；本 todo 实际产生 ok|throttled，duplicate|plan-gated 预留词汇位）。
 */
export type DispatchReason =
  'ok' | 'duplicate' | 'throttled' | 'plan-gated' | 'review-triplet';

/**
 * notify_agent 统一返回契约（plan-review todo 3）：
 * {triggered, reason, origMessageId?, messageId, issueBound} + 既有 channelId/targetInstanceId。
 * - reason 与 triggered 恒成对：triggered=true → reason='ok'；false → 具体拦因。
 * - issueBound：调用带 issueId 即 true；缺省 false（hint，不硬拦）。
 * - origMessageId 预留给 duplicate 回显原记录（todo 4 填充，本 todo 永不写入）。
 * - review-triplet（todo 8）：kind=review 派发词缺三元组时拒绝触发并回精确 hint。
 * - dispatchAgentMention 内部返回保持 void，triggered 只在本层组装。
 */
export interface NotifyAgentResult {
  messageId: string;
  channelId: string;
  targetInstanceId: string;
  triggered: boolean;
  reason: DispatchReason;
  /** duplicate 拦因回显的原派发消息 id（todo 4 填充）。 */
  origMessageId?: string;
  /** 阻断时的人读提示（如 plan-gated 的“计划未放行”说明）；成功时缺省。 */
  hint?: string;
  /** true=本次派发已绑定 issue；false=未带 issueId（提醒，不硬拦）。 */
  issueBound: boolean;
}

/**
 * git_repos_list 返回的脱敏仓库行（T6 P6 读取补齐）。
 * - 无任何凭证 key 明文（GitRepoView 本身即脱敏：credentialRef 永不进视图）。
 * - repoUrl 视同敏感：调用方仅凭授权可见，服务端永不打进日志（日志仅记条数/id）。
 */
export interface GitRepoListItem {
  id: string;
  /** 敏感：仓库地址，仅授权实例可见，禁止日志输出。 */
  repoUrl: string;
  credentialName: string | null;
  authType: string;
  fingerprint: string;
  /** 调用方自身授权（该行 grantedAgents 中属于调用方模板 Agent 的那条）。 */
  permission: string;
  effect: string;
}

/** read_file 常量：默认读取上限 256KB，上限 1MB（与 tools.ts inputSchema max 对齐）。 */
const READ_FILE_DEFAULT_MAX_BYTES = 256 * 1024;
const READ_FILE_MAX_BYTES = 1024 * 1024;

/** chat_history 分页契约（plan-review todo 10，docs 31 §3.4）：默认 20 条，上限 100 条，响应硬上限 64KB。 */
export const CHAT_HISTORY_DEFAULT_LIMIT = 20;
export const CHAT_HISTORY_MAX_LIMIT = 100;
export const CHAT_HISTORY_MAX_BYTES = 64 * 1024;
/** 超 64KB 单条截断标记（纯标记，不做 LLM 摘要）。 */
const CHAT_HISTORY_TRUNCATED_MARKER =
  '[truncated] 单条消息超出 64KB 上限，已截断正文；请用 beforeId 分页追溯';

/** skill_create 常量：SKILL.md 全文服务端强制上限 100KB（与 skills.controller multipart 上限对齐）。 */
const SKILL_CREATE_MAX_BYTES = 100 * 1024;

/** hook_register 缺省生命周期：expiresInMs 未传时 hook 自注册起 24h 过期（无无限 hook）。 */
const HOOK_DEFAULT_EXPIRES_MS = 24 * 60 * 60 * 1000;

/**
 * 平台 MCP 工具实现（阶段 1）。
 *
 * 7 个工具：chat_history / doclib / task_context / group_post / read_file /
 * notify_agent / submit_artifact。
 *
 * 安全边界（设计文档 §4.2/§6）：每个工具 tools/call 前先做 **归属校验**——
 * 该 worker（x-worker-id）须有该 taskId 的 Session（session.findFirst），
 * 否则 403 `PLATFORM_MCP_FORBIDDEN`（模型不能跨任务读数据）。
 *
 * 依赖：PrismaService（全局 PrismaModule）、RealtimeService + IdGeneratorService
 * （RealtimeModule 导出，'m' 前缀与 chat 域同源）、WorkerClient（WorkersModule 导出，
 * FR-41：group_post fileRef 未命中归档时经其从 worker 工作区拉取文件内容落盘归档）、
 * ArtifactsService（ArtifactsModule 导出，submit_artifact text 类型直接落库归档）。
 */
@Injectable()
export class PlatformMcpService {
  private readonly logger = new Logger(PlatformMcpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
    private readonly workerClient: WorkerClient,
    private readonly workerDispatcher: WorkerDispatcher,
    private readonly artifactsService: ArtifactsService,
    private readonly issuesService: IssuesService,
    private readonly tasksService: TasksService,
    private readonly questionsService: QuestionsService,
    private readonly gitRepos: GitReposService,
    @Optional()
    @Inject(NotificationDispatcherService)
    private readonly outboundDispatcher: NotificationDispatcherService,
    @Optional()
    private readonly moduleRef?: ModuleRef,
    // 生效策略解析（my_profile effectivePermission 唯一事实来源；缺省可空——
    // 单测/旧装配未提供时回退 effectivePermission=null，不阻断其余字段）。
    @Optional()
    @Inject(ExecutionPolicyService)
    private readonly executionPolicyService?: ExecutionPolicyService,
    // 技能沉淀（skill_create）：缺省可空——单测/旧装配未提供时调用抛 503
    // 而非启动期崩溃；生产装配由 PlatformMcpModule 提供。
    @Optional()
    @Inject(SkillsService)
    private readonly skillsService?: SkillsService,
    // 计划门禁（todo4 执行门禁）：缺省可空——单测/旧装配未提供时门禁 fail-open
    // 放行；生产装配经 TasksModule（已 import）提供。
    @Optional()
    @Inject(PlanLifecycleService)
    private readonly planLifecycle?: PlanLifecycleService,
    // 回执计数（todo5 待回执看板口径）：缺省可空——单测/旧装配未提供时计数
    // 回退 {pending:0,total:0}，不阻断其余字段；生产装配经 ChatModule 提供。
    @Optional()
    @Inject(MessageReceiptsService)
    private readonly receipts?: MessageReceiptsService,
    @Optional()
  @Inject(TriggerService)
  private readonly timers?: TriggerService,
    // 评审轮次账本串行写（review-round-open）：缺省可空——单测/旧装配未提供时
    // 开轮跳过 + warn，派发本身不受影响；生产装配经 IssuesModule（已 import）提供。
    @Optional()
    @Inject(ReviewRoundService)
    private readonly rounds?: ReviewRoundService,
    // agent-hook（trigger-unification todo-12）：缺省可空——单测/旧装配未提供时
    // hook_register/hook_cancel 调用抛 503 而非启动期崩溃；生产装配经 ChatModule
    //（已 import 且 export HookService，本模块单向依赖）提供，无新增模块边。
    @Optional()
    @Inject(HookService)
    private readonly hooks?: HookService,
  ) {}

  /**
   * Agent-originated mention 触发硬节流（@ storm 熔断，进程内滑动窗口）。
   * 仅 MCP 路径（groupPost / notifyAgent）咨询；用户路径（chat.service
   * createMessage）永不经过此处。
   */
  private readonly mentionThrottle = new MentionThrottle();

  /**
   * chat_history：任务群聊历史消息（按需拉取，替代自动注入的群聊历史）。
   * 分页返回 {items, truncated, total}：无游标取最近 limit 条（默认 20），
   * beforeId 倒序翻页，sinceId 正序续拉；响应超 64KB 按条截断并标记。
   */
  async chatHistory(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      teamId?: string;
      /** DM 对端成员 id（tmm_ 前缀）：传即进 DM 模式，按 (团队, 该成员) 定位私聊频道。 */
      teamMemberId?: string;
      /** 调用方实例 id：DM 模式必填（实例级归属绑定），群聊模式可选。 */
      selfInstanceId?: string;
      sinceId?: string;
      /** 倒序游标：仅返回 id 小于该值的消息（倒序翻页；与 sinceId 同传时 beforeId 决定倒序）。 */
      beforeId?: string;
      limit?: number;
    },
  ): Promise<ChatHistoryPage> {
    if (args.teamMemberId && !args.selfInstanceId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: '私聊历史需声明调用方身份（selfInstanceId），禁止匿名访问',
      });
    }
    const exec = await this.resolveExecContext(ctx, args);
    if (args.teamMemberId) {
      return this.chatHistoryDm(exec, ctx, args.teamMemberId, {
        sinceId: args.sinceId,
        beforeId: args.beforeId,
        limit: args.limit,
      });
    }
    const channel =
      exec.kind === 'task'
        ? await this.findTaskGroupChannel(exec.taskId)
        : await this.findTeamGroupChannel(exec.teamId);
    if (!channel) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
        message: '任务群聊频道不存在',
      });
    }
    return this.queryHistoryPage(channel.id, {
      sinceId: args.sinceId,
      beforeId: args.beforeId,
      limit: args.limit,
    });
  }

  /**
   * chat_history DM 模式（T6 D6：同团队 DM + 审计，不做全量 DM 开放）。
   * 按 (执行团队, peerMemberId) 定位 private 频道，三门：
   * caller-is-endpoint（callerId === channel.teamMemberId）+ 同 teamId +
   * worker-team 会话绑定（assertWorkerTeam，经 resolveExecContext 按
   * selfInstanceId 实例级绑定，对齐 memoryUpdate/gitReposList 落库先例；
   * DM 模式 selfInstanceId 必填，缺失 403）。
   * 任一不满足 → 403；频道不存在 → 404。每次访问写审计日志（仅 id，不记内容）。
   */
  private async chatHistoryDm(
    exec: ExecContext,
    ctx: PlatformMcpContext,
    peerMemberId: string,
    opts: { sinceId?: string; beforeId?: string; limit?: number },
  ): Promise<ChatHistoryPage> {
    const execTeamId =
      exec.kind === 'team' ? exec.teamId : await this.teamIdOfTask(exec.taskId);
    if (!execTeamId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: '私聊历史需要团队上下文，禁止跨团队访问',
      });
    }
    await this.assertWorkerTeam(ctx, execTeamId);
    const channel = await this.prisma.chatChannel.findFirst({
      where: {
        teamMemberId: peerMemberId,
        type: CHANNEL_TYPE.private,
        deletedAt: null,
      },
    });
    if (!channel) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
        message: '私聊频道不存在',
      });
    }
    if ((channel as { teamId?: string | null }).teamId !== execTeamId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: '仅同团队私聊可读，禁止跨团队访问',
      });
    }
    if (
      (channel as { teamMemberId?: string | null }).teamMemberId !==
      exec.callerId
    ) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: '仅私聊端点可读该私聊历史',
      });
    }
    this.logger.log(
      `[mcp] chat_history DM 访问 team=${execTeamId} channel=${channel.id} caller=${exec.callerId}`,
    );
    return this.queryHistoryPage(channel.id, {
      sinceId: opts.sinceId,
      beforeId: opts.beforeId,
      limit: opts.limit,
    });
  }

  private async queryHistoryPage(
    channelId: string,
    opts: { sinceId?: string; beforeId?: string; limit?: number },
  ): Promise<ChatHistoryPage> {
    const limit = this.normalizeLimit(opts.limit);
    const backward = !!opts.beforeId || !opts.sinceId;
    const idFilter: { gt?: string; lt?: string } = {};
    if (opts.sinceId) idFilter.gt = opts.sinceId;
    if (opts.beforeId) idFilter.lt = opts.beforeId;
    const rows = await this.prisma.message.findMany({
      where: {
        channelId,
        ...(Object.keys(idFilter).length > 0 ? { id: idFilter } : {}),
      },
      orderBy: { id: backward ? 'desc' : 'asc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const window = hasMore ? rows.slice(0, limit) : rows;
    const items = (backward ? [...window].reverse() : window).map((row) =>
      this.toChatHistoryItem(row),
    );
    const total = await this.prisma.message.count({ where: { channelId } });
    const page: ChatHistoryPage = { items, truncated: hasMore, total };
    this.enforceHistoryMaxBytes(page);
    return page;
  }

  private enforceHistoryMaxBytes(page: ChatHistoryPage): void {
    const size = () => Buffer.byteLength(JSON.stringify(page), 'utf8');
    while (page.items.length > 1 && size() > CHAT_HISTORY_MAX_BYTES) {
      page.items.shift();
      page.truncated = true;
    }
    if (page.items.length === 1 && size() > CHAT_HISTORY_MAX_BYTES) {
      const only = page.items[0];
      const marker = CHAT_HISTORY_TRUNCATED_MARKER;
      const fixed = Buffer.byteLength(
        JSON.stringify({ ...only, text: '' }),
        'utf8',
      );
      const envelope =
        Buffer.byteLength(JSON.stringify({ ...page, items: [] }), 'utf8') - 2;
      let budget =
        CHAT_HISTORY_MAX_BYTES -
        fixed -
        envelope -
        Buffer.byteLength(marker, 'utf8');
      budget = Math.max(0, budget);
      let head = only.text.slice(0, budget);
      let guard = 8;
      while (
        head.length > 0 &&
        guard-- > 0 &&
        Buffer.byteLength(
          JSON.stringify({
            ...page,
            items: [{ ...only, text: head + marker }],
          }),
          'utf8',
        ) > CHAT_HISTORY_MAX_BYTES
      ) {
        const cur = Buffer.byteLength(
          JSON.stringify({
            ...page,
            items: [{ ...only, text: head + marker }],
          }),
          'utf8',
        );
        const excess = cur - CHAT_HISTORY_MAX_BYTES;
        const headBytes = Math.max(1, Buffer.byteLength(head, 'utf8'));
        const drop = Math.min(
          head.length,
          Math.max(1, Math.ceil((excess * head.length) / headBytes)),
        );
        head = head.slice(0, head.length - drop);
      }
      page.items = [{ ...only, text: head + marker }];
      page.truncated = true;
    }
  }

  /**
   * git_repos_list：调用方被授权仓库只读清单（T6 P6 读取补齐）。
   * task_create 式双上下文 + selfInstanceId：resolveExecContext 解析执行上下文
   * （归属冒充先行 403）；授权按模板 Agent 过滤——GitRepoGrant 以模板 agentId
   * 键控，调用方实例 id 先经 TeamMember 解析为模板 agentId（解析不到时回退
   * callerId 本身，兼容 session.agentId 形态）。
   * 仅返回调用方持有未吊销授权的行（findAll 本身只含未吊销行）；行脱敏：
   * 无凭证 key 明文（视图天然不含 credentialRef），repoUrl 视同敏感（不记日志）。
   * 已知局限：worker 凭证下发是 worker 级共享（同 worker 多实例 key 明文共存，
   * 见 WorkersService.dispatchGitCredentials），本工具只做实例级读控制，
   * 非执行隔离——真隔离需下发期按实例过滤或 git 执行层强制 permission。
   */
  async gitReposList(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      teamId?: string;
      selfInstanceId: string;
    },
  ): Promise<{ repos: GitRepoListItem[] }> {
    const exec = await this.resolveExecContext(ctx, args);
    const callerAgentId = await this.resolveCallerAgentId(exec.callerId);
    const views: GitRepoView[] = await this.gitRepos.findAll();
    const repos: GitRepoListItem[] = [];
    for (const view of views) {
      const grant = view.grantedAgents.find((g) => g.agentId === callerAgentId);
      if (!grant) continue;
      repos.push({
        id: view.id,
        repoUrl: view.repoUrl,
        credentialName: view.credentialName,
        authType: view.authType,
        fingerprint: view.fingerprint,
        permission: grant.permission,
        effect: grant.effect,
      });
    }
    this.logger.log(
      `[mcp] git_repos_list caller=${exec.callerId} repos=${repos.length}`,
    );
    return { repos };
  }

  /**
   * 调用方实例 → 模板 Agent：授权表以模板 agentId 键控，实例 id 需经成员行换算。
   */
  private async resolveCallerAgentId(callerId: string): Promise<string> {
    const member = await this.prisma.teamMember.findUnique({
      where: { id: callerId },
      select: { agentId: true },
    });
    return member?.agentId ?? callerId;
  }

  /**
   * hook_register：agent 注册"稍后唤醒我"（trigger-unification todo-12）。
   * task_create 式双上下文 + selfInstanceId：resolveExecContext 解析执行上下文
   * （未知 scope 400、跨任务/跨团队冒充 403）；ownerInstanceId 服务端取自
   * exec.callerId（拒绝客户端传入，防冒充）；channelId 服务端按执行上下文解析
   * 为任务/团队群聊频道（拒绝客户端指定任意频道）；target 目标实例缺省为调用
   * 方自身，显式传时必须落在执行团队内（否则 403）。
   * kind/time 语义校验失败（HookService loud throw）统一转 400，不泄漏 500。
   */
  async hookRegister(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      teamId?: string;
      selfInstanceId: string;
      kind: string;
      wakeText: string;
      targetInstanceId?: string;
      dueAt?: string;
      delayMs?: number;
      expiresInMs?: number;
      graceMs?: number;
      dedupKey?: string;
    },
  ): Promise<{
    hookId: string;
    status: string;
    kind: string;
    dueAt: string | null;
    expiresAt: string;
  }> {
    const exec = await this.resolveExecContext(ctx, args);
    const hooks = this.requireHookService();
    const ownerInstanceId = exec.callerId;
    const scopeType = exec.kind;
    const scopeId = exec.kind === 'task' ? exec.taskId : exec.teamId;
    if (!isHookKind(args.kind)) {
      throw new BadRequestException(
        `未知 hook kind ${args.kind}（v1 白名单：${Object.values(HOOK_KIND).join(',')}）`,
      );
    }
    const now = new Date();
    let dueAt: Date | null = null;
    if (args.kind === HOOK_KIND.TIME) {
      dueAt = this.parseHookDue(args.dueAt, args.delayMs, now);
    } else if (args.dueAt !== undefined || args.delayMs !== undefined) {
      throw new BadRequestException(
        'all_idle hook 不接受 dueAt/delayMs（静默由全局 poll 评估）',
      );
    }
    const expiresInMs = args.expiresInMs ?? HOOK_DEFAULT_EXPIRES_MS;
    if (!Number.isFinite(expiresInMs) || expiresInMs <= 0) {
      throw new BadRequestException('expiresInMs 须为正数（毫秒）');
    }
    const expiresAt = new Date(now.getTime() + Math.floor(expiresInMs));
    if (dueAt && dueAt.getTime() >= expiresAt.getTime()) {
      throw new BadRequestException(
        'time hook 的 dueAt 必须早于 expiresAt（否则到期即过期，永不唤醒）',
      );
    }
    const execTeamId =
      exec.kind === 'team' ? exec.teamId : await this.teamIdOfTask(exec.taskId);
    if (!execTeamId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: '该任务无团队归属，无法注册 hook',
      });
    }
    const channel =
      exec.kind === 'team'
        ? await this.findTeamGroupChannel(exec.teamId)
        : await this.findTaskGroupChannel(exec.taskId);
    if (!channel) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
        message: '任务群聊频道不存在，无法注册 hook',
      });
    }
    const targetInstanceId = args.targetInstanceId ?? ownerInstanceId;
    const targetMember = await this.prisma.teamMember.findFirst({
      where: { id: targetInstanceId, teamId: execTeamId },
      select: { id: true },
    });
    if (!targetMember) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `目标实例 ${targetInstanceId} 不在当前团队，禁止跨团队注册`,
      });
    }
    const dedupKey =
      args.dedupKey ??
      buildHookDedupKey(scopeType, `${scopeId}:${ownerInstanceId}:${now.getTime()}`);
    let hook: { id: string; status: string; kind: string };
    try {
      const created = await hooks.registerHook({
        scopeType,
        scopeId,
        ownerInstanceId,
        kind: args.kind,
        wakeText: args.wakeText,
        target: {
          taskId: exec.kind === 'task' ? exec.taskId : null,
          teamId: execTeamId,
          channelId: channel.id,
          targetInstanceId,
        },
        dueAt,
        graceMs: args.graceMs ?? null,
        expiresAt,
        dedupKey,
      });
      hook = created as unknown as {
        id: string;
        status: string;
        kind: string;
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err),
      );
    }
    const row = (await this.prisma.hook.findUnique({
      where: { id: hook.id },
      select: { dueAt: true, expiresAt: true },
    })) as unknown as { dueAt: Date | null; expiresAt: Date } | null;
    this.logger.log(
      `[mcp] hook_register caller=${ownerInstanceId} kind=${hook.kind} hook=${hook.id}`,
    );
    return {
      hookId: hook.id,
      status: hook.status,
      kind: hook.kind,
      dueAt: row?.dueAt ? new Date(row.dueAt).toISOString() : null,
      expiresAt:
        row?.expiresAt != null
          ? new Date(row.expiresAt).toISOString()
          : expiresAt.toISOString(),
    };
  }

  /**
   * hook_cancel：按 hookId 或 dedupKey 取消（trigger-unification todo-12）。
   * 服务端复核：hook 归属团队必须等于执行团队（跨团队 403）；调用方须为 hook
   * 所有者（ownerInstanceId === callerId 逐字相等）或是执行团队的主 Agent
   *（team.mainAgentMemberId，agent 平面的 admin 等价——MCP 无用户 JWT，
   * 不能按 REST 那样查用户角色）。已终态行幂等直返（HookService 状态机）。
   */
  async hookCancel(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      teamId?: string;
      selfInstanceId: string;
      hookId?: string;
      dedupKey?: string;
    },
  ): Promise<{ hookId: string; status: string }> {
    const exec = await this.resolveExecContext(ctx, args);
    const hooks = this.requireHookService();
    const key = args.hookId ?? args.dedupKey;
    if (!key) {
      throw new BadRequestException('hookId 与 dedupKey 至少传一个');
    }
    let hook = (await this.prisma.hook.findUnique({
      where: { id: key },
    })) as unknown as {
      id: string;
      ownerInstanceId: string;
      scopeType: string;
      scopeId: string;
      status: string;
    } | null;
    if (!hook) {
      hook = (await this.prisma.hook.findUnique({
        where: { dedupKey: key },
      })) as unknown as {
        id: string;
        ownerInstanceId: string;
        scopeType: string;
        scopeId: string;
        status: string;
      } | null;
    }
    if (!hook) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.HOOK_NOT_FOUND,
        message: `hook ${key} 不存在`,
      });
    }
    const execTeamId =
      exec.kind === 'team' ? exec.teamId : await this.teamIdOfTask(exec.taskId);
    const hookTeamId = await this.resolveHookTeamId({
      scopeType: hook.scopeType,
      scopeId: hook.scopeId,
      ownerInstanceId: hook.ownerInstanceId,
    });
    if (!hookTeamId || !execTeamId || hookTeamId !== execTeamId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: 'hook 不属于当前团队，禁止跨团队取消',
      });
    }
    if (hook.ownerInstanceId !== exec.callerId) {
      const team = await this.prisma.team.findUnique({
        where: { id: hookTeamId },
        select: { mainAgentMemberId: true },
      });
      if (
        (team as { mainAgentMemberId?: string | null } | null)
          ?.mainAgentMemberId !== exec.callerId
      ) {
        throw new ForbiddenException({
          code: PLATFORM_MCP_ERRORS.FORBIDDEN,
          message: '仅 hook 所有者或主 Agent 可取消',
        });
      }
    }
    const cancelled = (await hooks.cancelHook(hook.id)) as unknown as {
      id: string;
      status: string;
    };
    this.logger.log(
      `[mcp] hook_cancel caller=${exec.callerId} hook=${cancelled.id} status=${cancelled.status}`,
    );
    return { hookId: cancelled.id, status: cancelled.status };
  }

  private requireHookService(): HookService {
    if (!this.hooks) {
      throw new ServiceUnavailableException(
        'hook 服务未装配（HookService 缺失），请联系管理员',
      );
    }
    return this.hooks;
  }

  private parseHookDue(
    dueAt: string | undefined,
    delayMs: number | undefined,
    now: Date,
  ): Date {
    if (dueAt !== undefined && delayMs !== undefined) {
      throw new BadRequestException('dueAt 与 delayMs 二选一，不可同传');
    }
    if (dueAt !== undefined) {
      const parsed = new Date(dueAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('dueAt 非法（须为 ISO 时间字符串）');
      }
      return parsed;
    }
    if (delayMs !== undefined) {
      if (!Number.isFinite(delayMs) || delayMs <= 0) {
        throw new BadRequestException('delayMs 须为正数（毫秒）');
      }
      return new Date(now.getTime() + Math.floor(delayMs));
    }
    throw new BadRequestException(
      'time hook 必须带 dueAt 或 delayMs（到期唤醒时刻）',
    );
  }

  private async resolveHookTeamId(hook: {
    scopeType: string;
    scopeId: string;
    ownerInstanceId: string;
  }): Promise<string | null> {
    if (hook.scopeType === 'team') return hook.scopeId;
    if (hook.scopeType === 'task') {
      try {
        return await this.teamIdOfTask(hook.scopeId);
      } catch {
        return null;
      }
    }
    const member = await this.prisma.teamMember.findUnique({
      where: { id: hook.ownerInstanceId },
      select: { teamId: true },
    });
    return (
      (member as { teamId?: string | null } | null)?.teamId ?? null
    );
  }

  /**
   * doclib：任务产出物文档库。
   * - 无 artifactId → 产出物清单 `{artifacts: [{id, type, title, category, currentVersion, updatedAt}]}`（category 为空即未分类）
   * - 有 artifactId → 指定版本全文（缺省 currentVersion），顶层附 `category`；doc/file（filePath 非空）
   *   附 `fileUrl`（contentRef 归一化，FILE-02）。
   */
  async doclib(
    ctx: PlatformMcpContext,
    args: { taskId: string; artifactId?: string; version?: number },
  ): Promise<unknown> {
    await this.assertWorkerTask(ctx, args.taskId);

    if (!args.artifactId) {
      const artifacts = await this.prisma.artifact.findMany({
        where: { taskId: args.taskId },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          type: true,
          title: true,
          category: true,
          currentVersion: true,
          updatedAt: true,
        },
      });
      return {
        artifacts: artifacts.map((a) => ({
          id: a.id,
          type: a.type,
          title: a.title,
          category: a.category ?? null,
          currentVersion: a.currentVersion,
          updatedAt: a.updatedAt.toISOString(),
        })),
      };
    }

    const artifact = await this.prisma.artifact.findFirst({
      where: { id: args.artifactId, taskId: args.taskId },
      select: {
        id: true,
        type: true,
        title: true,
        category: true,
        currentVersion: true,
        updatedAt: true,
      },
    });
    if (!artifact) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.ARTIFACT_NOT_FOUND,
        message: '产出物不存在或不属于该任务',
      });
    }
    const versionNumber = args.version ?? artifact.currentVersion;
    const version = await this.prisma.artifactVersion.findUnique({
      where: {
        artifactId_version: { artifactId: artifact.id, version: versionNumber },
      },
    });
    if (!version) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.VERSION_NOT_FOUND,
        message: `产出物版本 v${versionNumber} 不存在`,
      });
    }
    return {
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      category: artifact.category ?? null,
      currentVersion: artifact.currentVersion,
      updatedAt: artifact.updatedAt.toISOString(),
      version: this.toArtifactVersionDto(version),
    };
  }

  /**
   * task_context：任务概览（title/description/status/mainAgentId/backgroundDocs）
   * + 群聊频道 id + 团队 agentMembers（团队成员列表，实例形状
   * {id: 成员 id, alias, agentId, name, role, main}，main 按 team.mainAgentMemberId 判定）。
   */
  async taskContext(ctx: PlatformMcpContext, args: { taskId: string }) {
    await this.assertWorkerTask(ctx, args.taskId);
    const task = await this.prisma.task.findUnique({
      where: { id: args.taskId },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        mainAgentId: true,
        mainAgentInstanceId: true,
        backgroundDocs: true,
        teamId: true,
      },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const ctxTeamId = (task as { teamId?: string | null }).teamId ?? null;
    const ctxTeam = ctxTeamId
      ? await this.prisma.team.findUnique({
          where: { id: ctxTeamId },
          select: { mainAgentMemberId: true },
        })
      : null;
    const ctxMainId =
      (ctxTeam as { mainAgentMemberId?: string | null } | null)
        ?.mainAgentMemberId ?? null;
    const [channel, agentRows] = await Promise.all([
      this.findTaskGroupChannel(args.taskId),
      ctxTeamId
        ? this.prisma.teamMember.findMany({
            where: { teamId: ctxTeamId },
            orderBy: [{ agentId: 'asc' }, { seq: 'asc' }],
            select: {
              id: true,
              alias: true,
              seq: true,
              agentId: true,
              agent: { select: { id: true, name: true, role: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    // todo5 待回执看板口径（31 篇 §3.4）：n/N 计数，仅计数不做分析页。
    const pendingReceipts = await this.pendingReceiptCounts(args.taskId);
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      mainAgentId: task.mainAgentId,
      mainAgentInstanceId: task.mainAgentInstanceId,
      backgroundDocs: task.backgroundDocs ?? [],
      channelId: channel?.id ?? null,
      pendingReceipts,
      agentMembers: agentRows.map((r) => ({
        id: r.id,
        alias: r.alias,
        agentId: r.agentId,
        name: r.agent.name,
        role: r.agent.role,
        main: r.id === ctxMainId,
      })),
    };
  }

  /**
   * 待回执 n/N 计数（todo5，31 篇 §3.4）：receipts 未装配时回退零值，
   * 查询失败 warn 后回退零值——计数缺席不阻断 task_context/team_view 主体。
   */
  private async pendingReceiptCounts(
    taskId: string,
  ): Promise<{ pending: number; total: number }> {
    if (!this.receipts) {
      return { pending: 0, total: 0 };
    }
    try {
      return await this.receipts.countPending({ taskId });
    } catch (err) {
      this.logger.warn(
        `[mcp] pendingReceipts 查询失败 task=${taskId}（回退零值）：${err instanceof Error ? err.message : String(err)}`,
      );
      return { pending: 0, total: 0 };
    }
  }

  /**
   * group_post：向任务群聊发布消息（triggerless：仅落库+广播，无 triggered 字段；
   * 其 @ 提及触发走内部 dispatchAgentMention fire-and-forget，不向调用方返回触发状态。
   * 需要触发状态的定向派发请用 notify_agent（统一返回契约见 NotifyAgentResult）。
   * - senderType=agent、senderId=发送者 agent id（从 selfInstanceId 实例行解析，角色渲染）、
   *   senderInstanceId=selfInstanceId（精确归属）双写（assertWorkerTask 校验 selfInstanceId
   *   为活跃执行实例后精确落库）。
   * - fileRef 可选：命中该 taskId 已归档产出物（artifactVersion.filePath 非空，
   *   contentRef 归一化相等）→ 挂附件三字段（attachmentUrl/attachmentName/attachmentType）。
   * - 先落库后广播（08 篇 §7.3）：`realtime.broadcast(CHAT_MESSAGE_NEW, {message}, {channel})`。
   */
  async groupPost(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      teamId?: string;
      selfInstanceId: string;
      content: string;
      fileRef?: string;
    },
  ): Promise<{
    messageId: string;
    channelId: string;
    attachment: GroupPostAttachment | null;
  }> {
    const exec = await this.resolveExecContext(ctx, args);
    const isTeam = exec.kind === 'team';
    // 任务维度 taskId 透传；团队维度无任务（Message.taskId 可空，落库 taskId: null）。
    const effTaskId: string | null = isTeam ? null : exec.taskId;
    const channel = isTeam
      ? await this.ensureTeamGroupChannelByTeam(exec.teamId)
      : await this.ensureTeamGroupChannel(effTaskId as string);
    const instanceId = exec.callerId;
    // fileRef 归档命中仅任务维度可用（按 taskId 查已归档产出物）；团队维度无归档可命中。
    const attachment =
      args.fileRef && !isTeam
        ? await this.resolveAttachment(ctx, effTaskId as string, args.fileRef)
        : undefined;
    const { mentions } = isTeam
      ? await this.parseTeamPostMentions(exec.teamId, args.content)
      : await this.parseGroupPostMentions(effTaskId as string, args.content);

    const message = await this.prisma.message.create({
      data: {
        id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
        channelId: channel.id,
        taskId: effTaskId,
        senderType: SENDER_TYPE.agent,
        senderId: isTeam
          ? await this.resolveTeamSenderAgentId(exec.teamId, instanceId)
          : await this.resolveSenderAgentId(effTaskId as string, instanceId),
        senderInstanceId: instanceId,
        content: { text: args.content, parts: [] } as Prisma.InputJsonValue,
        mentions: (mentions ?? null) as Prisma.InputJsonValue | null,
        status: MESSAGE_STATUS.sent,
        ...(attachment ?? {}),
      } as any,
    });

    await this.realtime.broadcast(
      EVENT_TYPES.CHAT_MESSAGE_NEW,
      { message: this.toMessageDto(message) },
      { type: 'channel', id: channel.id },
    );

    // group_post 为「通知/留痕」语义：@ 提及只落库（mentions 列）+ 频道广播，永不自动唤醒。
    // 2026-09-16 移除多 @ 自动触发：派发携带原文，平台无法理解「请开发修复、测试待命」，
    // 待命者照样被唤醒开工（实测一条 @3 人消息重发 10+ 次、测试-1 被唤醒 45 次）。
    // 需唤醒某人请显式调 vteam_notify_agent（可逐个/按依赖顺序）——勿恢复此自动触发。

    return {
      messageId: message.id,
      channelId: channel.id,
      attachment: attachment ?? null,
    };
  }

  /**
   * is_0000000015：解析 group_post content 中被 @ 的团队实例（按实例别名/agent 名称
   * 前缀匹配 `@<名称>`），返回 mentions（落库形状，对齐 notify_agent）与被提及实例 id。
   * 无 @ 命中 → { mentions: null, mentionedInstances: [] }（不触发分派）。
   */
  private async parseGroupPostMentions(
    taskId: string,
    content: string,
  ): Promise<{
    mentions: Array<{
      type: 'agent';
      instanceId: string;
      agentId: string;
      name: string;
    }> | null;
    mentionedInstances: string[];
  }> {
    if (!content || !content.includes('@')) {
      return { mentions: null, mentionedInstances: [] };
    }
    const mentionTeamId = await this.teamIdOfTask(taskId);
    const teamRows = mentionTeamId
      ? await this.prisma.teamMember.findMany({
          where: { teamId: mentionTeamId },
          select: {
            id: true,
            agentId: true,
            alias: true,
            agent: { select: { name: true } },
          },
        })
      : [];
    const mentionedInstances: string[] = [];
    const mentions: Array<{
      type: 'agent';
      instanceId: string;
      agentId: string;
      name: string;
    }> = [];
    for (const row of teamRows) {
      const name = row.alias ?? row.agent.name;
      if (!name) continue;
      const atName = `@${name}`;
      const boundaryAfter = content.length;
      const idx = content.indexOf(atName);
      const hit =
        idx >= 0 &&
        (idx + atName.length >= boundaryAfter ||
          /[\s,，。；;:：!！?？]/.test(content[idx + atName.length] ?? ''));
      if (!hit) continue;
      if (!mentionedInstances.includes(row.id)) {
        mentionedInstances.push(row.id);
        mentions.push({
          type: 'agent',
          instanceId: row.id,
          agentId: row.agentId,
          name,
        });
      }
    }
    if (content.includes('@all')) {
      (mentions as unknown as Array<{ type: string }>).push({
        type: 'all',
      } as unknown as {
        type: 'agent';
        instanceId: string;
        agentId: string;
        name: string;
      });
    }
    try {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      if (task?.teamId) {
        const members = await this.prisma.teamUserMember.findMany({
          where: { teamId: task.teamId },
          select: {
            user: { select: { id: true, username: true, displayName: true } },
          },
        });
        const hasDynamic = ['@user', '@me', '@当前用户', '@here', '@用户'].some(
          (t) => content.includes(t),
        );
        if (hasDynamic) {
          for (const m of members) {
            if (
              !(
                mentions as unknown as Array<{ type: string; userId: string }>
              ).some((x) => x.userId === m.user.id)
            ) {
              (
                mentions as unknown as Array<{ type: string; userId: string }>
              ).push({ type: 'user', userId: m.user.id });
            }
          }
        } else {
          for (const m of members) {
            const names = [m.user.username, m.user.displayName].filter(
              Boolean,
            ) as string[];
            for (const n of names) {
              const atN = `@${n}`;
              const idx = content.indexOf(atN);
              const hit =
                idx >= 0 &&
                (idx + atN.length >= content.length ||
                  /[\s,，。；;:：!！?？]/.test(
                    content[idx + atN.length] ?? '',
                  ));
              if (hit) {
                (
                  mentions as unknown as Array<{ type: string; userId: string }>
                ).push({ type: 'user', userId: m.user.id });
                break;
              }
            }
          }
        }
      }
    } catch {}
    return {
      mentions:
        mentions.length > 0
          ? (mentions as unknown as Array<{
              type: 'agent';
              instanceId: string;
              agentId: string;
              name: string;
            }>)
          : null,
      mentionedInstances,
    };
  }

  /**
   * FR-13：notify_agent——向任务内的另一个实例定向发送消息并触发其执行（agent 互 @）。
   * 触发语义：目标按 targetInstanceId（@开发者-2 必须命中开发者-2 实例，不再取
   * 同 agent 首个实例）。
   * 显示语义（对齐 group_post 普通消息）：消息是**发送者**的发言（@目标）——落库
   * senderId=发送者 agent id（从 selfInstanceId 实例行解析，兼容 agent id 直传）、
   * senderInstanceId=selfInstanceId；mentions 含目标实例（instanceId+agentId+name）
   * 仅表示 @ 归属，目标实例被 dispatchAgentMention 触发。
   * 1. 归属校验（selfInstanceId 与 session.teamMemberId 一致）+ 定位任务群聊频道（对齐 groupPost）。
   * 2. 落库一条 agent 消息（sender=发送者、@目标）→ 广播 chat.message.new（先落库后广播）。
   * 3. 调 WorkerDispatcher.dispatchAgentMention 触发目标实例的 dispatch 全链路
   *    （assignWorker → createSession/bind → execute → 回复经 task.completed 回流群聊）。
   *    任务维度传 taskId；团队维度（无任务）传 teamId 直走团队路径（会话即建即得）。
   *    统一返回契约（plan-review todo 3，见 NotifyAgentResult）：
   *    {triggered, reason: ok|duplicate|throttled|plan-gated, origMessageId?,
   *    messageId, issueBound}（+既有 channelId/targetInstanceId）——
   *    成功 triggered=true+reason=ok；被节流 triggered=false+reason=throttled
   *    （内部 pair_limit|task_budget 在此收敛，不再透出）；issueId 缺省 →
   *    issueBound=false（hint，不硬拦），透传时 issueBound=true 并经 dispatchAgentMention
   *    带给执行链路（todo 4 消费 issue 锁/去重）。
   * 目标实例无会话 → dispatchAgentMention 抛错 → 工具调用返回错误（模型可见）。
   */
  async notifyAgent(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      teamId?: string;
      selfInstanceId: string;
      targetInstanceId: string;
      content: string;
      /** 可选 issue 绑定（派活归属 issue；缺省不硬拦，返回 issueBound:false 提醒）。 */
      issueId?: string;
      /**
       * 派发 kind（todo5 节流豁免；todo4 门禁复用同一参数）：
       * wake/round-notify 为内部派发，免 pair/task 节流预算（预算只约束外部派发）；
       * 缺省按外部派发计预算。todo4 门禁：仅 'execution'（缺省）走计划门禁，
       * review/nudge/wake（及 round-notify/未知取值，按内部豁免）不经门禁。
       */
      kind?: string;
      /** 强行绕过门禁（须同时给非空 forceReason 留审计行，否则仍被拦）。 */
      force?: boolean;
      /** force 绕过的审计原因（落回执行 forceReason 列）。 */
      forceReason?: string;
      /**
       * 调用方携带的计划哈希（实际值，planVersion.hash sha1-8 口径；todo 3 执行认哈希）。
       * 与冻结哈希不一致即 plan-gated 拦截；缺省 → 哈希门禁未武装（原门禁语义不变）。
       */
      planHash?: string;
      /** 回执超时分钟数（缺省 10，范围 1-1440；仅 execution 派发记账并排平台自动催办）。 */
      receiptTimeoutMin?: number;
    },
  ): Promise<NotifyAgentResult> {
    const exec = await this.resolveExecContext(ctx, args);
    const isTeam = exec.kind === 'team';
    const effTaskId: string | null = isTeam ? null : exec.taskId;
    const channel = isTeam
      ? await this.findTeamGroupChannel(exec.teamId)
      : await this.findTaskGroupChannel(effTaskId as string);
    if (!channel) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
        message: '任务群聊频道不存在',
      });
    }
    // 目标实例行（agentId/alias/name）——@ 目标、消息 sender/mentions 归属依据。
    // 双维度统一查团队成员表（TeamMember）：任务维度经任务归属团队界定。
    const notifyTeamId = isTeam
      ? exec.teamId
      : await this.teamIdOfTask(effTaskId as string);
    const targetInstance = notifyTeamId
      ? await this.prisma.teamMember.findFirst({
          where: {
            id: args.targetInstanceId,
            teamId: notifyTeamId,
          },
          select: {
            agentId: true,
            alias: true,
            agent: { select: { id: true, name: true } },
          },
        })
      : null;
    if (!targetInstance) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: `目标实例 ${args.targetInstanceId} 不存在或不在任务团队`,
      });
    }
    const targetAgentId = targetInstance.agentId;
    const targetName =
      targetInstance.alias ?? targetInstance.agent.name ?? targetAgentId;
    const senderAgentId = isTeam
      ? await this.resolveTeamSenderAgentId(exec.teamId, exec.callerId)
      : await this.resolveSenderAgentId(
          effTaskId as string,
          args.selfInstanceId,
        );
    const senderMember = notifyTeamId
      ? await this.prisma.teamMember.findFirst({
          where: { id: args.selfInstanceId, teamId: notifyTeamId },
          select: { alias: true, agent: { select: { name: true } } },
        })
      : null;
    const senderName =
      senderMember?.alias ?? senderMember?.agent?.name ?? args.selfInstanceId;
    const text = `@${targetName} ${args.content}`;
    const message = await this.prisma.message.create({
      data: {
        id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
        channelId: channel.id,
        senderType: SENDER_TYPE.agent,
        senderId: senderAgentId,
        senderInstanceId: args.selfInstanceId,
        content: { text, parts: [] } as Prisma.InputJsonValue,
        mentions: [
          {
            type: 'agent',
            instanceId: args.targetInstanceId,
            agentId: targetAgentId,
            name: targetName,
          },
        ] as Prisma.InputJsonValue,
        status: MESSAGE_STATUS.sent,
      },
    });

    await this.realtime.broadcast(
      EVENT_TYPES.CHAT_MESSAGE_NEW,
      { message: this.toMessageDto(message) },
      { type: 'channel', id: channel.id },
    );

    // 双维度触发：任务维度按 taskId 触发执行；团队维度（无任务）按 teamId 经
    // 团队路径触发（ensureTeamSession 即建即得，会话缺失即建，不静默跳过）。
    // @ storm 熔断（仅 agent-originated）：滑动窗口节流——被拦仅 warn，
    // 不阻断发布（消息已落库广播），返回 triggered:false + reason。notify_agent
    // 为单显式目标，内容含 @all 也不展开 fan-out（仅触发 targetInstanceId）。
    // 团队维度节流键取 team:<teamId> 命名空间（与 t_ 任务键永不碰撞）。
    // todo5 豁免：内部 wake/round-notify 不咨询不记账（pair/task 预算只约束外部派发）。
    const throttleKey = isTeam ? `team:${exec.teamId}` : (effTaskId as string);
    const throttleExempt = isThrottleExemptKind(args.kind);
    const decision: MentionThrottleDecision = throttleExempt
      ? { allow: true }
      : this.mentionThrottle.shouldDispatch({
          taskId: throttleKey,
          fromInstanceId: args.selfInstanceId,
          toInstanceId: args.targetInstanceId,
          now: Date.now(),
        });
    if (!decision.allow) {
      this.logger.warn(
        `[mcp] notify_agent 触发被节流 task=${throttleKey} from=${args.selfInstanceId} to=${args.targetInstanceId} reason=${decision.reason}（消息已发布）`,
      );
      return {
        messageId: message.id,
        channelId: channel.id,
        targetInstanceId: args.targetInstanceId,
        triggered: false,
        reason: 'throttled',
        issueBound: !!args.issueId,
      };
    }
    const kind: DispatchExecutionKind =
      !args.kind || args.kind === 'execution'
        ? 'execution'
        : args.kind === 'review'
          ? 'review'
          : args.kind === 'nudge'
            ? 'nudge'
            : 'wake';
    const forceReason =
      args.force === true &&
      typeof args.forceReason === 'string' &&
      args.forceReason.trim()
        ? args.forceReason.trim()
        : null;
    if (args.issueId) {
      const issueGate = await this.checkIssueDispatchAllowed(
        args.issueId,
        args.targetInstanceId,
      );
      if (!issueGate.allowed && !forceReason) {
        this.logger.warn(
          `[mcp] notify_agent issue 锁拦截 issue=${args.issueId} to=${args.targetInstanceId}（消息已发布）`,
        );
        return {
          messageId: message.id,
          channelId: channel.id,
          targetInstanceId: args.targetInstanceId,
          triggered: false,
          reason: 'duplicate',
          ...(issueGate.origMessageId
            ? { origMessageId: issueGate.origMessageId }
            : {}),
          issueBound: true,
        };
      }
    }
    if (
      kind === 'execution' &&
      !isTeam &&
      effTaskId &&
      targetAgentId !== PLAN_AGENT_ID
    ) {
      const planGate = await this.checkPlanExecutionAllowed(effTaskId);
      const callerHash = normalizePlanHash(args.planHash);
      let staleHash: { expected: string; actual: string } | null = null;
      if (callerHash) {
        const expected = await this.resolveFrozenPlanHash(effTaskId);
        if (isStalePlanHash(expected, callerHash)) {
          staleHash = { expected: expected as string, actual: callerHash };
        }
      }
      if (!planGate.allowed || staleHash) {
        if (!forceReason) {
          const stale = staleHash;
          this.logger.warn(
            stale
              ? `[mcp] notify_agent 哈希门禁拦截 task=${effTaskId} expected=${stale.expected} actual=${stale.actual}（消息已发布）`
              : `[mcp] notify_agent 计划门禁拦截 task=${effTaskId} status=${planGate.status}（消息已发布）`,
          );
          return {
            messageId: message.id,
            channelId: channel.id,
            targetInstanceId: args.targetInstanceId,
            triggered: false,
            reason: 'plan-gated',
            hint: stale
              ? buildStalePlanHashHint(stale.expected, stale.actual)
              : `计划未放行：当前计划状态为 ${planGate.status}（需 executing，请确认开始执行后再派发；force=true + 原因可绕过并留审计）`,
            issueBound: !!args.issueId,
          };
        }
        await this.writeForceAuditReceipt({
          messageId: message.id,
          taskId: effTaskId,
          teamId: notifyTeamId,
          fromInstanceId: args.selfInstanceId,
          toInstanceId: args.targetInstanceId,
          content: args.content,
          issueId: args.issueId ?? null,
          forceReason,
        });
      }
    }
    // 评审三元组门（todo 8，docs 33 §3.2：唯一 choke 点选 notifyAgent——
    // dispatchAgentMention 返回 void 无法回精确 hint，且内部 wake/round-notify
    // 走 kind=wake 永不命中本门；worker-dispatcher 层不加第二道检查）。
    // kind=review 派发词须携带 round + planVersion(+hash) + expected 名单，
    // 缺三元组 → 拒绝触发并回精确 hint（修订不开始）；消息已落库广播不断言回滚。
    if (kind === 'review') {
      const triplet = parseReviewTriplet(args.content);
      if (!triplet.ok) {
        this.logger.warn(
          `[mcp] notify_agent 评审三元组缺失 to=${args.targetInstanceId} missing=${triplet.missing?.join(',')}（消息已发布）`,
        );
        return {
          messageId: message.id,
          channelId: channel.id,
          targetInstanceId: args.targetInstanceId,
          triggered: false,
          reason: 'review-triplet',
          hint: REVIEW_TRIPLET_HINT,
          issueBound: !!args.issueId,
        };
      }
      if (triplet.triplet) {
        try {
          await this.openReviewRound(triplet.triplet, {
            taskId: effTaskId,
            teamId: notifyTeamId,
            issueId: args.issueId,
            callerInstanceId: args.selfInstanceId,
          });
        } catch (err) {
          this.logger.warn(
            `[mcp] review-round 开轮失败（不阻断派发） to=${args.targetInstanceId}：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    // 放行派发嵌入视角边界（todo 8，docs 33 §3.5；非 review 原样透传）。
    const dispatchText = kind === 'review' ? ensureRoleViewFooter(text) : text;
    if (isTeam) {
      await this.workerDispatcher.dispatchAgentMention({
        teamId: exec.teamId,
        channelId: channel.id,
        text: dispatchText,
        targetInstanceId: args.targetInstanceId,
        ...(args.issueId ? { issueId: args.issueId } : {}),
        kind,
      });
    } else {
      await this.workerDispatcher.dispatchAgentMention({
        taskId: effTaskId as string,
        channelId: channel.id,
        text: dispatchText,
        targetInstanceId: args.targetInstanceId,
        ...(args.issueId ? { issueId: args.issueId } : {}),
        kind,
      });
    }
    if (kind === 'execution') {
      await this.scheduleReceiptNudge({
        messageId: message.id,
        channelId: channel.id,
        taskId: effTaskId,
        teamId: notifyTeamId,
        fromInstanceId: args.selfInstanceId,
        toInstanceId: args.targetInstanceId,
        assigneeName: targetName,
        fromName: senderName,
        content: args.content,
        issueId: args.issueId ?? null,
        receiptTimeoutMin: args.receiptTimeoutMin,
      });
    }

    return {
      messageId: message.id,
      channelId: channel.id,
      targetInstanceId: args.targetInstanceId,
      triggered: true,
      reason: 'ok',
      issueBound: !!args.issueId,
    };
  }

  /**
   * issue 状态锁（todo4 精确语义，对照 issues.constants 五态机）：
   * open 可派；在途同人（in_progress + 同 assigneeInstanceId）拦并回显原派发消息；
   * 换人放行；终态（resolved/closed/rejected）视为新一轮放行。
   * 读错/未知 issue → fail-open 放行 + warn。
   */
  private async checkIssueDispatchAllowed(
    issueId: string,
    targetInstanceId: string,
  ): Promise<{ allowed: boolean; origMessageId?: string }> {
    try {
      const issue = await this.prisma.issue.findUnique({
        where: { id: issueId },
        select: { status: true, assigneeInstanceId: true },
      });
      if (
        !issue ||
        issue.status !== 'in_progress' ||
        !issue.assigneeInstanceId ||
        issue.assigneeInstanceId !== targetInstanceId
      ) {
        return { allowed: true };
      }
      let origMessageId: string | undefined;
      try {
        const prior = await this.prisma.messageReceipt.findFirst({
          where: { issueId },
          orderBy: { createdAt: 'desc' },
          select: { messageId: true },
        });
        origMessageId = prior?.messageId ?? undefined;
      } catch {
        origMessageId = undefined;
      }
      return {
        allowed: false,
        ...(origMessageId ? { origMessageId } : {}),
      };
    } catch (err) {
      this.logger.warn(
        `[mcp] issue 锁读取失败 issue=${issueId}，fail-open 放行：${err instanceof Error ? err.message : String(err)}`,
      );
      return { allowed: true };
    }
  }

  /**
   * 计划执行门禁读端（todo4 第一道防线；第二道在 dispatchAgentMention 内）。
   * 仅 plans.status=executing 放行；无行则兜底建行后再门禁；读错/建行失败/
   * 未装配即 fail-open + warn（永不转 fail-closed）。计划表读写只经计划生命周期服务。
   */
  private async checkPlanExecutionAllowed(
    taskId: string,
  ): Promise<{ allowed: boolean; status: string | null }> {
    try {
      if (!this.planLifecycle) {
        return { allowed: true, status: null };
      }
      let status = await this.planLifecycle.getStatus(taskId);
      if (status === null) {
        try {
          const ensured = await this.planLifecycle.autoEnsureRow(taskId);
          status = ensured?.status ?? null;
        } catch (err) {
          this.logger.warn(
            `[mcp] plans 兜底建行失败 task=${taskId}，fail-open 放行：${err instanceof Error ? err.message : String(err)}`,
          );
          return { allowed: true, status: null };
        }
      }
      if (status === null || status === 'executing') {
        return { allowed: true, status };
      }
      return { allowed: false, status };
    } catch (err) {
      this.logger.warn(
        `[mcp] plans 门禁读取失败 task=${taskId}，fail-open 放行：${err instanceof Error ? err.message : String(err)}`,
      );
      return { allowed: true, status: null };
    }
  }

  private async resolveFrozenPlanHash(taskId: string): Promise<string | null> {
    try {
      const rows = await this.prisma.issue.findMany({
        where: { taskId },
        select: { description: true },
      });
      return selectFrozenPlanHash(
        (Array.isArray(rows) ? rows : []).map(
          (row: { description?: string | null }) => row?.description ?? null,
        ),
      );
    } catch (err) {
      this.logger.warn(
        `[mcp] 冻结哈希读取失败 task=${taskId}，哈希门禁未武装：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * force 绕过审计行（todo4）：门禁被 force+原因绕过时记账（kind=dispatch，
   * forceReason 落库）。wake/round-notify 保留位永不写入——豁免路径不经过本方法。
   * 写失败仅 warn，不阻断已放行的派发。
   */
  private async writeForceAuditReceipt(input: {
    messageId: string;
    taskId: string | null;
    teamId: string | null;
    fromInstanceId: string;
    toInstanceId: string;
    content: string;
    issueId: string | null;
    forceReason: string;
  }): Promise<void> {
    try {
      if (!input.teamId) {
        this.logger.warn(
          `[mcp] force 审计行缺团队归属 message=${input.messageId}，跳过记账`,
        );
        return;
      }
      await this.prisma.messageReceipt.create({
        data: {
          id: await this.idGen.nextId('mr'),
          messageId: input.messageId,
          fromInstanceId: input.fromInstanceId,
          toInstanceId: input.toInstanceId,
          taskId: input.taskId,
          teamId: input.teamId,
          summary: input.content.slice(0, 100),
          status: MESSAGE_RECEIPT_STATUSES.pending,
          dedupKey: buildMessageReceiptDedupKey({
            fromInstanceId: input.fromInstanceId,
            toInstanceId: input.toInstanceId,
            issueId: input.issueId,
            content: input.content,
          }),
          issueId: input.issueId,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          kind: MESSAGE_RECEIPT_KINDS.dispatch,
          forceReason: input.forceReason,
        },
      });
    } catch (err) {
      this.logger.warn(
        `[mcp] force 审计行落库失败 message=${input.messageId}（不阻断派发）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async openReviewRound(
    triplet: ReviewDispatchTriplet,
    opts: {
      taskId: string | null;
      teamId: string | null;
      issueId?: string;
      callerInstanceId: string;
    },
  ): Promise<void> {
    let hostIssueId: string | null = opts.issueId ?? null;
    if (!hostIssueId && opts.taskId) {
      hostIssueId = await this.findReviewRoundHost(opts.taskId);
    }
    if (!hostIssueId) {
      if (!opts.taskId) {
        this.logger.warn(
          `[mcp] review-round 开轮跳过（团队维度无 issueId 且无 taskId，无法定位宿主）`,
        );
        return;
      }
      try {
        const created = await this.issuesService.createByAgent(
          opts.callerInstanceId,
          opts.taskId,
          {
            taskId: opts.taskId,
            title: `计划评审 R${triplet.round} ${triplet.planVersion}`,
          },
        );
        hostIssueId =
          ((created as unknown as { id?: unknown } | null)?.id as string) ??
          null;
      } catch (err) {
        this.logger.warn(
          `[mcp] review-round 宿主 issue 创建失败 task=${opts.taskId}（不阻断派发）：${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      if (!hostIssueId) {
        this.logger.warn(
          `[mcp] review-round 宿主 issue 创建返回缺 id task=${opts.taskId}（不阻断派发）`,
        );
        return;
      }
    }
    if (!this.rounds) {
      this.logger.warn(
        `[mcp] review-round 开轮跳过 issue=${hostIssueId}（ReviewRoundService 未装配，不阻断派发）`,
      );
      return;
    }
    let existing: ReturnType<typeof tryParseLedger> = null;
    try {
      const host = await this.prisma.issue.findUnique({
        where: { id: hostIssueId },
        select: { description: true },
      });
      existing = tryParseLedger(
        (host as unknown as { description?: string | null } | null)
          ?.description ?? null,
      );
    } catch (err) {
      this.logger.warn(
        `[mcp] review-round 账本读取失败 issue=${hostIssueId}（fail-closed 跳过开轮，不覆盖终态，不阻断派发）：${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (existing) {
      const terminal =
        existing.status === 'complete' || existing.status === 'stale';
      if (terminal && triplet.round <= existing.round) {
        this.logger.warn(
          `[mcp] review-round 重派跳过 issue=${hostIssueId} R${triplet.round}（终态 ${existing.status} R${existing.round} 不回退 collecting，不阻断派发）`,
        );
        return;
      }
      if (triplet.round < existing.round) {
        this.logger.warn(
          `[mcp] review-round 旧轮重派跳过 issue=${hostIssueId} R${triplet.round}（当前 R${existing.round}，不覆盖 expected/timeout，不阻断派发）`,
        );
        return;
      }
    }
    const timeoutAt = new Date(Date.now() + REVIEW_ROUND_TIMEOUT_MS);
    try {
      await this.rounds.applyRoundUpdate(hostIssueId, {
        round: triplet.round,
        planVersion: {
          version: triplet.planVersion,
          hash: triplet.planHash,
        },
        expected: [...triplet.expected],
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
        status: 'collecting',
        timeoutAt: timeoutAt.toISOString(),
      });
    } catch (err) {
      this.logger.warn(
        `[mcp] review-round 账本写入失败 issue=${hostIssueId}（不阻断派发）：${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    await this.scheduleReviewRoundTimeout({
      issueId: hostIssueId,
      taskId: opts.taskId,
      teamId: opts.teamId,
      round: triplet.round,
      timeoutAt,
    });
  }

  private async findReviewRoundHost(taskId: string): Promise<string | null> {
    try {
      const rows = (await this.prisma.issue.findMany({
        where: { taskId },
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: { id: true, description: true },
      })) as unknown as Array<{ id: string; description?: string | null }>;
      for (const row of rows ?? []) {
        if (tryParseLedger(row?.description ?? null)) return row.id;
      }
      return null;
    } catch (err) {
      this.logger.warn(
        `[mcp] review-round 宿主查找失败 task=${taskId}（走创建兜底）：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async scheduleReviewRoundTimeout(input: {
    issueId: string;
    taskId: string | null;
    teamId: string | null;
    round: number;
    timeoutAt: Date;
  }): Promise<void> {
    try {
      if (!this.timers) {
        this.logger.warn(
          `[mcp] review-round 超时 timer 跳过 issue=${input.issueId} R${input.round}（TimerService 未装配，不阻断派发）`,
        );
        return;
      }
      await this.timers.schedule(
        REVIEW_ROUND_TIMEOUT_KIND,
        input.timeoutAt,
        {
          issueId: input.issueId,
          taskId: input.taskId,
          teamId: input.teamId,
          round: input.round,
        },
        buildTriggerDedupKey(
          TRIGGER_KIND.REVIEW_ROUND_TIMEOUT,
          input.issueId,
          input.round,
        ),
      );
    } catch (err) {
      this.logger.warn(
        `[mcp] review-round 超时 timer 排期失败 issue=${input.issueId}（不阻断派发）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async scheduleReceiptNudge(input: {
    messageId: string;
    channelId: string;
    taskId: string | null;
    teamId: string | null;
    fromInstanceId: string;
    toInstanceId: string;
    assigneeName: string;
    fromName?: string | null;
    content: string;
    issueId: string | null;
    receiptTimeoutMin?: number;
  }): Promise<void> {
    try {
      if (!input.teamId) {
        this.logger.warn(
          `[mcp] receipt-nudge 缺团队归属 message=${input.messageId}，跳过记账`,
        );
        return;
      }
      const timeoutMin = normalizeReceiptTimeoutMin(input.receiptTimeoutMin);
      const dedupKey = buildMessageReceiptDedupKey({
        fromInstanceId: input.fromInstanceId,
        toInstanceId: input.toInstanceId,
        issueId: input.issueId,
        content: input.content,
      });
      let receiptId: string;
      let fireAt: Date;
      try {
        const created = (await this.prisma.messageReceipt.create({
          data: {
            id: await this.idGen.nextId('mr'),
            messageId: input.messageId,
            fromInstanceId: input.fromInstanceId,
            toInstanceId: input.toInstanceId,
            taskId: input.taskId,
            teamId: input.teamId,
            summary: input.content.slice(0, 100),
            status: MESSAGE_RECEIPT_STATUSES.pending,
            dedupKey,
            issueId: input.issueId,
            expiresAt: new Date(Date.now() + timeoutMin * 60 * 1000),
            kind: MESSAGE_RECEIPT_KINDS.dispatch,
          },
        })) as unknown as { id: string; expiresAt: Date };
        receiptId = created.id;
        fireAt = new Date(created.expiresAt);
      } catch (err) {
        if ((err as { code?: string })?.code !== 'P2002') {
          throw err;
        }
        // 仅 dedupKey 唯一冲突是「同内容重派」的预期幂等路径；
        // 主键（PRIMARY）冲突是 id 生成器失配的信号，必须上抛而非静默吞掉，
        // 否则催办会无声消失（见 2026-09-16 mr_ 前缀缺 resync 事故）。
        // MySQL 下 Prisma 的 meta.target 为字符串（约束名），PG 为数组——两者兼容。
        const target = (err as { meta?: { target?: unknown } }).meta?.target;
        const targetList = Array.isArray(target) ? target : [target];
        const isDedupConflict = targetList.some(
          (t) => typeof t === 'string' && t.includes('dedup_key'),
        );
        if (!isDedupConflict) {
          throw err;
        }
        const existing = (await this.prisma.messageReceipt.findFirst({
          where: { dedupKey },
        })) as unknown as {
          id: string;
          status?: string;
          expiresAt: Date;
        } | null;
        if (!existing || existing.status !== MESSAGE_RECEIPT_STATUSES.pending) {
          this.logger.warn(
            `[mcp] receipt-nudge 记账去重命中非 pending 行 message=${input.messageId}，跳过排期`,
          );
          return;
        }
        receiptId = existing.id;
        fireAt = new Date(existing.expiresAt);
      }
      if (!this.timers) {
        this.logger.warn(
          `[mcp] receipt-nudge TimerService 未装配 receipt=${receiptId}（记账已落库，自动催办缺席）`,
        );
        return;
      }
      const payload: ReceiptNudgePayload = {
        receiptId,
        teamId: input.teamId,
        taskId: input.taskId,
        channelId: input.channelId,
        messageId: input.messageId,
        fromInstanceId: input.fromInstanceId,
        toInstanceId: input.toInstanceId,
        assigneeName: input.assigneeName,
        fromName: input.fromName ?? null,
      };
      await this.timers.schedule(
        RECEIPT_NUDGE_KIND,
        fireAt,
        payload,
        buildTriggerDedupKey(TRIGGER_KIND.RECEIPT_NUDGE, input.teamId, receiptId),
      );
    } catch (err) {
      this.logger.warn(
        `[mcp] receipt-nudge 排期失败 message=${input.messageId}（不阻断派发）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * read_file：读取任务产出物文件内容（agent B 读 agent A 传递的文件，可跨 worker）。
   * 1. **归档优先**：查该 taskId 已归档产出物（artifactVersion.filePath 非空），filePath
   *    归一化与 fileRef 归一化相等即命中（filePath 保存 agent 经 group_post 直发时的
   *    原始 fileRef）→ 用 contentRef 从 uploads 目录读内容（无跨 worker 网络开销）。
   * 2. **server 上传目录直读**（is_0000000018）：fileRef 为 `/uploads/*` 控制面落盘文件
   *    但未在任务归档命中（如任务 backgroundDocs 经 POST /uploads 上传、未归档为产出物）——
   *    直接从 server uploads 目录读取。修复「任务级背景文档 read_file 404」：此前落入
   *    worker 拉取兜底，worker 文件系统不存在 server 侧 /uploads 路径 → 404。
   * 3. **worker 拉取兜底**：非 /uploads 引用 → 从调用方 worker（ctx.workerId）工作区拉取
   *    （跨 worker 场景由归档层覆盖——agent B 读的是 agent A 已归档的文件）。
   * maxBytes 截断（默认 256KB，zod 已限 1MB 上限）；utf8 解码失败（二进制）→ base64 前缀。
   */
  async readFile(
    ctx: PlatformMcpContext,
    args: { taskId: string; fileRef: string; maxBytes?: number },
  ): Promise<ReadFileResult> {
    await this.assertWorkerTask(ctx, args.taskId);
    const maxBytes = this.normalizeMaxBytes(args.maxBytes);
    if (args.fileRef.startsWith('art_')) {
      const artifactId = args.fileRef.split('@')[0].split('/')[0].split('?')[0];
      const direct = await this.prisma.artifactVersion.findFirst({
        where: { artifactId, artifact: { taskId: args.taskId } },
        orderBy: { version: 'desc' },
        select: { contentRef: true },
      });
      if (direct)
        return this.readFromArchive(direct.contentRef, args.fileRef, maxBytes);
      const art = await this.prisma.artifact.findUnique({
        where: { id: artifactId },
        select: { taskId: true },
      });
      if (art?.taskId === args.taskId) {
        const v2 = await this.prisma.artifactVersion.findFirst({
          where: { artifactId },
          orderBy: { version: 'desc' },
          select: { contentRef: true },
        });
        if (v2)
          return this.readFromArchive(v2.contentRef, args.fileRef, maxBytes);
      }
    }
    const target = FileStorageService.normalizeFileRef(args.fileRef);
    const versions = await this.prisma.artifactVersion.findMany({
      where: { artifact: { taskId: args.taskId }, filePath: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { contentRef: true, filePath: true },
    });
    const hit = versions.find(
      (v) =>
        v.filePath !== null &&
        FileStorageService.normalizeFileRef(v.filePath) === target,
    );
    if (hit) {
      return this.readFromArchive(hit.contentRef, args.fileRef, maxBytes);
    }
    // is_0000000018：调用方显式传 `/uploads/*` 控制面落盘文件（如任务 backgroundDocs，
    // 经 POST /uploads 上传、未归档为产出物）→ server 上传目录直读，不再落入 worker
    // 拉取（worker 文件系统无 server 侧 /uploads 路径 → 404）。仅对**原始 fileRef** 为
    // /uploads 前缀生效；worker 原始路径（/tmp/opencode/*）归一化后虽也是 /uploads/*，
    // 但文件在 worker 工作区，仍走 worker 拉取兜底。
    if (args.fileRef.startsWith('/uploads/')) {
      return this.readFromArchive(target, args.fileRef, maxBytes);
    }
    return this.fetchFromWorker(ctx, args.fileRef, maxBytes);
  }

  /**
   * submit_artifact：agent 直接提交产出物（替代 <artifact> 标签声明）。
   * - selfInstanceId：工具必填调用方实例 id，assertWorkerTask 校验为活跃执行实例
   *   （防跨实例伪造产出物归属）。
   * - text：直接调 ArtifactsService.append 落库（幂等去重/版本 append/验收锁定语义复用）。
   * - doc/file：复用 FR-41 拉取归档——从调用方 worker（ctx.workerId）工作区拉取文件 →
   *   落盘 uploads → archiveFetchedFile 归档（type=file、filePath=fileRef 原文、
   *   contentRef=落盘 URL、title 取工具入参）。拉取失败（worker 不存在 404 /
   *   fetchFile 非 2xx 的 WorkerUnavailableException 503）原样上抛——read_file 语义，
   *   提交失败必须让调用方（模型）知道。
   * 参数校验失败（text 缺 content / doc/file 缺 fileRef）→ 400 `ARTIFACT_INVALID`。
   */
  async submitArtifact(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      type: 'text' | 'doc' | 'file';
      title: string;
      content?: string;
      fileRef?: string;
      category?: string;
    },
  ): Promise<{
    artifactId: string;
    version: number;
    status: 'created' | 'appended' | 'duplicate';
  }> {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);

    if (
      args.category !== undefined &&
      !(ARTIFACT_CATEGORIES as readonly string[]).includes(args.category)
    ) {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.ARTIFACT_INVALID,
        message:
          'category 须为需求/设计/实现/测试用例/测试报告/运维/其他其一，不传为未分类',
      });
    }

    if (args.type === 'text') {
      if (!args.content) {
        throw new BadRequestException({
          code: PLATFORM_MCP_ERRORS.ARTIFACT_INVALID,
          message: 'type=text 时 content 必填',
        });
      }
      const result = await this.artifactsService.append(args.taskId, {
        taskId: args.taskId,
        type: 'text',
        title: args.title,
        content: args.content,
        ...(args.category !== undefined ? { category: args.category } : {}),
      });
      return this.toSubmitResult(result);
    }

    if (!args.fileRef) {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.ARTIFACT_INVALID,
        message: 'type=doc/file 时 fileRef 必填',
      });
    }
    return this.submitFileArtifact(
      ctx,
      args.taskId,
      args.title,
      args.fileRef,
      args.category,
    );
  }

  /**
   * issue_create：在任务内创建 issue（创建者=调用方实例，creatorAgentId 落库）。
   * 三参数归属校验（selfInstanceId 必填防冒充）→ IssuesService.createByAgent。
   * assigneeInstanceId：指派到具体任务实例（落库 issue.assigneeInstanceId）。
   */
  async issueCreate(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      title: string;
      description?: string;
      tags?: string[];
      assigneeInstanceId?: string;
    },
  ) {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);
    return this.issuesService.createByAgent(args.selfInstanceId, args.taskId, {
      taskId: args.taskId,
      title: args.title,
      description: args.description,
      tags: args.tags,
      assigneeInstanceId: args.assigneeInstanceId,
    });
  }

  /**
   * issue_list：任务内 issue 列表（status 可选过滤，无分页）。
   * 三参数归属校验 → IssuesService.findAllByAgent（agent 团队校验 + 返回 DTO 数组）。
   */
  async issueList(
    ctx: PlatformMcpContext,
    args: { taskId: string; selfInstanceId: string; status?: IssueStatus },
  ) {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);
    return this.issuesService.findAllByAgent(
      args.selfInstanceId,
      args.taskId,
      args.status,
    );
  }

  /**
   * issue_get：单 issue 详情。
   * 三参数归属校验 → IssuesService.findOneByAgent（issue 归属 taskId 404 + agent 团队校验）。
   */
  async issueGet(
    ctx: PlatformMcpContext,
    args: { taskId: string; selfInstanceId: string; issueId: string },
  ) {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);
    return this.issuesService.findOneByAgent(
      args.selfInstanceId,
      args.taskId,
      args.issueId,
    );
  }

  /** issue_update：部分更新 title/description/tags。三参数归属校验 → IssuesService.updateByAgent。 */
  async issueUpdate(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      issueId: string;
      title?: string;
      description?: string;
      tags?: string[];
    },
  ) {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);
    return this.issuesService.updateByAgent(
      args.selfInstanceId,
      args.taskId,
      args.issueId,
      {
        title: args.title,
        description: args.description,
        tags: args.tags,
      },
    );
  }

  /** issue_transition：状态流转（reject 时 reason 必填，透传服务层校验）。三参数归属校验 → IssuesService.transitionByAgent。 */
  async issueTransition(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      issueId: string;
      action: IssueTransitionAction;
      reason?: string;
    },
  ) {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);
    return this.issuesService.transitionByAgent(
      args.selfInstanceId,
      args.taskId,
      args.issueId,
      args.action,
      args.reason,
    );
  }

  async taskTransition(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      action: TaskTransitionAction;
      reason?: string;
    },
  ) {
    if (args.action === 'accept' || args.action === 'archive') {
      throw new ForbiddenException({
        code: TASK_ERRORS.TASK_AGENT_COMPLETION_FORBIDDEN,
        message:
          '仅人类用户可在管理界面验收完成/归档任务，Agent 不可调用 accept/archive；请向用户报告任务已就绪、等待人工验收，不要重复调用',
      });
    }
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);
    // 注：已删除旧自造 plan 域的 start 门禁（executionMode 列恒 direct）。
    // 新计划模式（task.planMode）不拦截 start：计划评审通过后的执行确认走
    // opencode question/permission → QuestionModal 由用户明确批准（见 P4）。
    return this.tasksService.transitionByAgent(
      args.taskId,
      args.selfInstanceId,
      args.action,
      args.reason ? { reason: args.reason } : undefined,
    );
  }

  /** question_confirm：托管模式下主 Agent 确认成员请求（仅主实例可调，复用 task_transition 权限模式）。 */
  async questionConfirm(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      requestId: string;
      kind: 'question' | 'permission';
      answers?: string[][] | null;
      response?: 'once' | 'always' | 'reject';
    },
  ) {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);
    return this.questionsService.confirmByAgent({
      taskId: args.taskId,
      instanceId: args.selfInstanceId,
      requestId: args.requestId,
      kind: args.kind,
      answers: args.answers,
      response: args.response,
    });
  }

  /**
   * 团队主成员解析（task_create / skill_create 团队维度门共用，唯一回退点）：
   * team.mainAgentMemberId 显式绑定优先返回；为 NULL 时回退首位成员（seq 升序，
   * 对齐 chat.service buildMainAgentTrigger / worker-dispatcher resolveTeamMainMember；
   * TeamMember 无软删字段，过滤域恒为 { teamId }）。空名册或查询失败 → null
   * （调用方保持今日 403，失败永不放行）。
   */
  private async resolveTeamMainMemberId(
    teamId: string,
    explicitMainId: string | null,
  ): Promise<string | null> {
    if (explicitMainId) return explicitMainId;
    try {
      const first = await (this.prisma as any).teamMember.findFirst({
        where: { teamId },
        orderBy: { seq: 'asc' },
        select: { id: true },
      });
      return (first as { id: string } | null)?.id ?? null;
    } catch (err) {
      this.logger.warn(
        `resolveTeamMainMemberId 回退查询失败 teamId=${teamId}：${(err as Error)?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * task_create：团队会话无任务时由主 Agent 建任务（team-free-chat todo-4；
   * remove-project-dimension Todo 7 去 pid：团队即归属，无项目防提权门）。
   * 上下文解析：taskId 优先走任务维度（门 = task.mainAgentInstanceId === 调用方，
   * 该字段为 NULL（存量任务）时回退所属团队主成员判定；对齐 task_transition
   * 的 isMain 语义；建任务目标团队取该任务所属团队）；无 taskId
   * 走团队维度（门 = session 团队成员 === 团队主成员 id，
   * 主 id 经 resolveTeamMainMemberId 解析：显式绑定优先，否则首位成员回退）。
   * 成功路径经 TasksService.createByAgent（attribution createdBy = 团队用户成员
   * owner 回填；永不直调 create，其按调用方 userId 的团队成员校验会 403 agent）。
   */
  async taskCreate(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      teamId?: string;
      selfInstanceId: string;
      title: string;
      description?: string;
      priority?: string;
    },
  ): Promise<unknown> {
    const exec = await this.resolveExecContext(ctx, args);
    let teamId: string;
    if (exec.kind === 'task') {
      const task = await this.prisma.task.findUnique({
        where: { id: exec.taskId },
        select: { id: true, teamId: true, mainAgentInstanceId: true },
      });
      if (!task) {
        throw new NotFoundException({
          code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
          message: '任务不存在',
        });
      }
      if (task.mainAgentInstanceId != null) {
        if (task.mainAgentInstanceId !== exec.callerId) {
          throw new ForbiddenException({
            code: PLATFORM_MCP_ERRORS.FORBIDDEN,
            message: `仅主 Agent（${task.mainAgentInstanceId}）可创建任务；请知会主 Agent 调用 task_create`,
          });
        }
      } else {
        // 兼容：存量任务 mainAgentInstanceId 为空（Todo 6 迁移置空）→ 回退到
        // 所属团队主成员判定（团队显式绑定优先，否则首位成员；查不到 → 未设置）。
        if (!task.teamId) {
          throw new BadRequestException(
            '当前任务未绑定团队，无法解析建任务目标团队',
          );
        }
        const gateTeam = await this.prisma.team.findUnique({
          where: { id: task.teamId },
          select: { mainAgentMemberId: true },
        });
        const taskDimMainId = await this.resolveTeamMainMemberId(
          task.teamId,
          gateTeam?.mainAgentMemberId ?? null,
        );
        if (taskDimMainId !== exec.callerId) {
          throw new ForbiddenException({
            code: PLATFORM_MCP_ERRORS.FORBIDDEN,
            message: `仅主 Agent（${taskDimMainId ?? '未设置'}）可创建任务；请知会主 Agent 调用 task_create`,
          });
        }
      }
      if (!task.teamId) {
        throw new BadRequestException(
          '当前任务未绑定团队，无法解析建任务目标团队',
        );
      }
      teamId = task.teamId;
    } else {
      const team = await this.prisma.team.findUnique({
        where: { id: exec.teamId },
        select: { id: true, mainAgentMemberId: true },
      });
      if (!team) {
        throw new NotFoundException('团队不存在');
      }
      const taskGateMainId = await this.resolveTeamMainMemberId(
        team.id,
        team.mainAgentMemberId ?? null,
      );
      if (taskGateMainId !== exec.callerId) {
        throw new ForbiddenException({
          code: PLATFORM_MCP_ERRORS.FORBIDDEN,
          message: `仅主 Agent（${taskGateMainId ?? '未设置'}）可创建任务；请知会主 Agent 调用 task_create`,
        });
      }
      teamId = team.id;
    }
    return this.tasksService.createByAgent(exec.callerId, {
      title: args.title,
      description: args.description,
      priority: args.priority,
      teamId,
    });
  }

  /**
   * skill_create：主 Agent 沉淀新 SKILL.md（learning-mode P2）。
   * 双上下文主门（对齐 task_create）：任务维度门 = task.mainAgentInstanceId
   * === 调用方（该字段为 NULL 时回退所属团队主成员判定），否则 403；团队维度门 = 调用方 === 团队主成员 id
   * （经 resolveTeamMainMemberId 解析：显式绑定优先，否则首位成员回退），
   * 否则 403。归属冒充（selfInstanceId 非会话成员）由 resolveExecContext
   * 经 assertWorkerTask/Team 先行 403。
   * 内容门：全文超 100KB → 400；parseSkillMarkdown 先行（frontmatter
   * 非法 → 400 SKILL_FRONTMATTER_INVALID）；file 适配由 MCP 输入合成
   * （originalname `<name>.md` + utf8 byte length + text/markdown）。
   * 落库复用 SkillsService.create（事务 + v1 历史，enabled 固定 false
   * 默认停用，name 重复 409 由其抛出）。
   */
  async skillCreate(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      teamId?: string;
      selfInstanceId: string;
      name: string;
      description?: string;
      content: string;
    },
  ): Promise<unknown> {
    const exec = await this.resolveExecContext(ctx, args);
    if (exec.kind === 'task') {
      const task = await this.prisma.task.findUnique({
        where: { id: exec.taskId },
        select: { id: true, teamId: true, mainAgentInstanceId: true },
      });
      if (!task) {
        throw new NotFoundException({
          code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
          message: '任务不存在',
        });
      }
      if (task.mainAgentInstanceId != null) {
        if (task.mainAgentInstanceId !== exec.callerId) {
          throw new ForbiddenException({
            code: PLATFORM_MCP_ERRORS.FORBIDDEN,
            message: `仅主 Agent（${task.mainAgentInstanceId}）可沉淀技能；请知会主 Agent 调用 skill_create`,
          });
        }
      } else {
        // 兼容：存量任务 mainAgentInstanceId 为空（Todo 6 迁移置空）→ 回退到
        // 所属团队主成员判定（团队显式绑定优先，否则首位成员；查不到 → 未设置）。
        if (!task.teamId) {
          throw new ForbiddenException({
            code: PLATFORM_MCP_ERRORS.FORBIDDEN,
            message:
              '仅主 Agent（未设置）可沉淀技能；请知会主 Agent 调用 skill_create',
          });
        }
        const skillGateTeam = await this.prisma.team.findUnique({
          where: { id: task.teamId },
          select: { mainAgentMemberId: true },
        });
        const taskDimSkillMainId = await this.resolveTeamMainMemberId(
          task.teamId,
          skillGateTeam?.mainAgentMemberId ?? null,
        );
        if (taskDimSkillMainId !== exec.callerId) {
          throw new ForbiddenException({
            code: PLATFORM_MCP_ERRORS.FORBIDDEN,
            message: `仅主 Agent（${taskDimSkillMainId ?? '未设置'}）可沉淀技能；请知会主 Agent 调用 skill_create`,
          });
        }
      }
    } else {
      const team = await this.prisma.team.findUnique({
        where: { id: exec.teamId },
        select: { id: true, mainAgentMemberId: true },
      });
      if (!team) {
        throw new NotFoundException('团队不存在');
      }
      const skillGateMainId = await this.resolveTeamMainMemberId(
        team.id,
        team.mainAgentMemberId ?? null,
      );
      if (skillGateMainId !== exec.callerId) {
        throw new ForbiddenException({
          code: PLATFORM_MCP_ERRORS.FORBIDDEN,
          message: `仅主 Agent（${skillGateMainId ?? '未设置'}）可沉淀技能；请知会主 Agent 调用 skill_create`,
        });
      }
    }
    const skills = this.skillsService;
    if (!skills) {
      throw new ServiceUnavailableException('技能服务未就绪，无法沉淀技能');
    }
    const byteLen = Buffer.byteLength(args.content, 'utf8');
    if (byteLen > SKILL_CREATE_MAX_BYTES) {
      throw new BadRequestException(
        `SKILL.md 全文超过 100KB 上限（实际 ${byteLen} 字节），请精简后重试`,
      );
    }
    const { frontmatter, content } = parseSkillMarkdown(args.content);
    return skills.create({
      frontmatter,
      content,
      file: {
        originalname: `${args.name}.md`,
        size: byteLen,
        mimetype: 'text/markdown',
        buffer: Buffer.from(args.content, 'utf8'),
      },
    });
  }

  /**
   * 精确去重探针（T4 记忆演进，mirror submit_artifact duplicate 语义）。
   * 同 level + 同归属（team 级按 teamId，global 级 teamId=null）+ 同 contentHash
   * 的未删除行即命中 → 调用方直接返 duplicate，不新增行。check-then-insert
   * 竞态接受（不建唯一键）；相似文本合并只做 prompt 提示，不阻塞。
   */
  private async findDuplicateMemory(
    level: MemoryLevel,
    teamId: string | null,
    contentHash: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.memory.findFirst({
      where: { deletedAt: null, level, teamId, contentHash },
      select: { id: true },
    });
  }

  /**
   * memory_save 团队维度：仅 team/global（session-unification Todo 9：任务级记忆
   * 已删除，level=task → 400 MEMORY_LEVEL_INVALID）；
   * project 级已下线（400 指引改用 team）；team 级直接落 teamId；
   * global 级仅团队主 Agent 可写（成员 === team.mainAgentMemberId，否则 403）。
   * 落库 taskId 置空（团队记忆无任务归属），createdBy = 团队成员 id。
   * T4：先按 contentHash 精确去重，命中即返 {status:'duplicate'} 不落库。
   */
  private async memorySaveForTeam(
    teamId: string,
    memberId: string,
    args: {
      selfInstanceId: string;
      level: MemoryLevel;
      content: string;
      description?: string;
      tags?: string[];
    },
  ): Promise<{
    memoryId: string;
    level: MemoryLevel;
    status: MemorySaveStatus;
  }> {
    if ((args.level as string) === 'project') {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.MEMORY_INVALID,
        message: 'project 级记忆已下线，请改用 level=team（团队级记忆）',
      });
    }
    if (
      args.level !== MEMORY_LEVELS.team &&
      args.level !== MEMORY_LEVELS.global
    ) {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.MEMORY_LEVEL_INVALID,
        message:
          '任务级记忆已删除，请改用 level=team（团队级记忆）或 level=global（全局记忆）',
      });
    }
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true, mainAgentMemberId: true },
    });
    if (!team) {
      throw new NotFoundException('团队不存在');
    }
    if (
      args.level === MEMORY_LEVELS.global &&
      team.mainAgentMemberId !== memberId
    ) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: '仅主 Agent 可写入全局记忆，禁止普通成员写 global 级',
      });
    }
    const description = (
      args.description?.trim() || args.content.slice(0, 120)
    ).slice(0, 255);
    const contentHash = computeMemoryContentHash(args.content);
    const duplicate = await this.findDuplicateMemory(
      args.level,
      args.level === MEMORY_LEVELS.team ? teamId : null,
      contentHash,
    );
    if (duplicate) {
      return { memoryId: duplicate.id, level: args.level, status: 'duplicate' };
    }
    const tm = await this.prisma.teamMember.findFirst({
      where: { id: memberId, teamId },
      select: { agentId: true, alias: true },
    });
    const sess = await this.prisma.session.findFirst({
      where: { teamId, teamMemberId: memberId },
      select: { id: true },
    });
    const channel = await this.findTeamGroupChannel(teamId);
    const memory = await this.prisma.memory.create({
      data: {
        id: await this.idGen.nextId('me'),
        level: args.level,
        taskId: null,
        teamId: args.level === MEMORY_LEVELS.team ? teamId : null,
        content: args.content,
        contentHash,
        description,
        tags: (args.tags ?? null) as Prisma.InputJsonValue | null,
        createdBy: memberId,
        sourceAgentId: tm?.agentId ?? null,
        sourceInstanceId: memberId,
        sourceType: 'agent',
        sessionId: sess?.id ?? null,
        sessionTitle: team.name ?? tm?.alias ?? null,
        channelId: channel?.id ?? null,
      } as any,
    });
    return { memoryId: memory.id, level: args.level, status: 'created' };
  }

  /**
   * memory_save：写入平台记忆（memory-management Todo 2；团队级见 Todo 5；
   * session-unification Todo 9 起仅 team/global，level=task → 400 MEMORY_LEVEL_INVALID）。
   * - 三参数归属校验（selfInstanceId 必填防冒充，对齐落库类工具 groupPost/submitArtifact）。
   * - 级别校验（Metis M3/M4 + Todo 9）：
   *   - team：teamId 从 task 行反查（**不接收 teamId 入参**，防跨团队写入——
   *     写 team 级 = 写当前任务所属团队的记忆；任务无团队归属 → 400）；
   *   - project：已下线（400 指引改用 team，防绕过 schema 直调 service）；
   *   - global：**仅主 Agent 可写**（task.mainAgentInstanceId === selfInstanceId，
   *     否则 403 PLATFORM_MCP_FORBIDDEN，防全局污染）。
   * - 落库 memories（me_ 前缀 IdGenerator 生成；createdBy=selfInstanceId 精确归属；
   *   tags 为 Json 列，无标签传 null）。
   * - T4 精确去重：同 level + 同归属 + 同 contentHash（sha256 归一化 content）的
   *   未删除行已存在 → 返回 {memoryId, level, status:'duplicate'}，不新增行
   *   （mirror submit_artifact duplicate 语义；相似文本合并只做 prompt 提示）。
   * 返回 {memoryId, level, status}。
   */
  async memorySave(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      teamId?: string;
      selfInstanceId: string;
      level: MemoryLevel;
      content: string;
      description?: string;
      tags?: string[];
    },
  ): Promise<{
    memoryId: string;
    level: MemoryLevel;
    status: MemorySaveStatus;
  }> {
    const exec = await this.resolveExecContext(ctx, args);
    // 团队维度：task 级记忆必须有任务锚点（干净 400 指引传 taskId）；
    // team/global 级走团队分支（team.mainAgentMemberId 仅约束 global）。
    if (exec.kind === 'team') {
      return this.memorySaveForTeam(exec.teamId, exec.callerId, args);
    }
    // project 级已下线（zod schema 已拒绝，此处防绕过 schema 直调 service）。
    if ((args.level as string) === 'project') {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.MEMORY_INVALID,
        message: 'project 级记忆已下线，请改用 level=team（团队级记忆）',
      });
    }
    const taskId = exec.taskId;

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { teamId: true, mainAgentInstanceId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }

    // 级别校验（显式分支 + 兜底 400，纵深防御）：session-unification Todo 9 起
    // 任务级记忆已删除，level=task → 400 MEMORY_LEVEL_INVALID；
    // team 级从 task 反查 teamId（不接收入参，防跨团队写入）；global 级仅主 Agent 可写（防全局污染，Metis M3）。
    // 非法 level 不再落入 global 分支（zod schema 已保证合法，此处防绕过 schema 直调 service）。
    const memoryTaskId: string | null = null;
    let memoryTeamId: string | null = null;
    if (args.level === MEMORY_LEVELS.team) {
      memoryTeamId = (task as { teamId?: string | null }).teamId ?? null;
      if (!memoryTeamId) {
        throw new BadRequestException(
          'team 级记忆需要团队上下文（当前任务无团队归属）',
        );
      }
    } else if (args.level === MEMORY_LEVELS.global) {
      const globalTeamId = (task as { teamId?: string | null }).teamId ?? null;
      const globalTeam = globalTeamId
        ? await this.prisma.team.findUnique({
            where: { id: globalTeamId },
            select: { mainAgentMemberId: true },
          })
        : null;
      const globalMainId =
        (globalTeam as { mainAgentMemberId?: string | null } | null)
          ?.mainAgentMemberId ?? null;
      if (!globalMainId || globalMainId !== args.selfInstanceId) {
        throw new ForbiddenException({
          code: PLATFORM_MCP_ERRORS.FORBIDDEN,
          message: '仅主 Agent 可写入全局记忆，禁止普通成员写 global 级',
        });
      }
    } else {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.MEMORY_LEVEL_INVALID,
        message:
          '任务级记忆已删除，请改用 level=team（团队级记忆）或 level=global（全局记忆）',
      });
    }

    const description = (
      args.description?.trim() || args.content.slice(0, 120)
    ).slice(0, 255);
    const contentHash = computeMemoryContentHash(args.content);
    const duplicate = await this.findDuplicateMemory(
      args.level,
      memoryTeamId,
      contentHash,
    );
    if (duplicate) {
      return { memoryId: duplicate.id, level: args.level, status: 'duplicate' };
    }
    let sourceAgentId: string | null = null;
    let sessionId: string | null = null;
    let sessionTitle: string | null = null;
    let channelId: string | null = null;
    try {
      const member = await this.prisma.teamMember.findUnique({
        where: { id: args.selfInstanceId },
        select: { agentId: true, alias: true, teamId: true },
      });
      if (member) sourceAgentId = member.agentId;
      const sess = await this.prisma.session.findFirst({
        where: { teamMemberId: args.selfInstanceId },
        select: { id: true },
      });
      if (sess) sessionId = sess.id;
      const taskRow = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { title: true },
      });
      if (taskRow) sessionTitle = taskRow.title;
      const memberTeamId =
        (member as { teamId?: string | null } | null)?.teamId ?? null;
      const ch = memberTeamId
        ? await this.prisma.chatChannel.findFirst({
            where: {
              teamId: memberTeamId,
              type: CHANNEL_TYPE.team_group,
              deletedAt: null,
            },
            select: { id: true },
          })
        : null;
      if (ch) channelId = ch.id;
      if (!sessionTitle && member?.alias) sessionTitle = member.alias;
    } catch {}
    const memory = await this.prisma.memory.create({
      data: {
        id: await this.idGen.nextId('me'),
        level: args.level,
        taskId: memoryTaskId,
        teamId: memoryTeamId,
        content: args.content,
        contentHash,
        description,
        tags: (args.tags ?? null) as Prisma.InputJsonValue | null,
        createdBy: args.selfInstanceId,
        sourceAgentId,
        sourceInstanceId: args.selfInstanceId,
        sourceType: 'agent',
        sessionId,
        sessionTitle,
        channelId,
      } as any,
    });
    return { memoryId: memory.id, level: args.level, status: 'created' };
  }

  /**
   * memory_update：按 id 更新平台记忆（T4 记忆演进，content/description/tags 部分更新）。
   * 1. 双上下文归属校验（resolveExecContext：worker 会话 + selfInstanceId 防冒充，
   *    复用 assertWorkerTask/Team）。
   * 2. 先读行：不存在/已软删 → 404 MEMORY_NOT_FOUND。
   * 3. 团队所有权：team 级行要求行 teamId === 执行团队（task 维度取任务所属团队），
   *    否则 403；global 级行仅执行团队主 Agent 可改（mirror save 的主门），否则 403；
   *    存量 task 级行要求同任务，否则 403。
   * 4. 全空 → 400；content 传空字串/空白 → 400（防空内容覆盖有效记忆）；
   *    content 更新同步重算 contentHash。
   * 返回 {memoryId, level, status:'updated'}。
   */
  async memoryUpdate(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      teamId?: string;
      selfInstanceId: string;
      memoryId: string;
      content?: string;
      description?: string;
      tags?: string[];
    },
  ): Promise<{
    memoryId: string;
    level: string;
    status: MemoryUpdateStatus;
  }> {
    const exec = await this.resolveExecContext(ctx, args);
    const row = await this.prisma.memory.findUnique({
      where: { id: args.memoryId },
    });
    if (!row || row.deletedAt) {
      throw new NotFoundException({
        code: MEMORY_ERRORS.MEMORY_NOT_FOUND,
        message: '记忆条目不存在',
      });
    }
    let execTeamId: string | null = null;
    if (exec.kind === 'team') {
      execTeamId = exec.teamId;
    } else {
      const task = await this.prisma.task.findUnique({
        where: { id: exec.taskId },
        select: { teamId: true },
      });
      if (!task) {
        throw new NotFoundException({
          code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
          message: '任务不存在',
        });
      }
      execTeamId = task.teamId ?? null;
    }
    if (row.level === MEMORY_LEVELS.team) {
      if (!execTeamId || row.teamId !== execTeamId) {
        throw new ForbiddenException({
          code: PLATFORM_MCP_ERRORS.FORBIDDEN,
          message: '仅归属团队可更新该记忆，禁止跨团队更新',
        });
      }
    } else if (row.level === MEMORY_LEVELS.global) {
      const mainTeam = execTeamId
        ? await this.prisma.team.findUnique({
            where: { id: execTeamId },
            select: { mainAgentMemberId: true },
          })
        : null;
      if (!mainTeam || mainTeam.mainAgentMemberId !== exec.callerId) {
        throw new ForbiddenException({
          code: PLATFORM_MCP_ERRORS.FORBIDDEN,
          message: '仅主 Agent 可更新全局记忆，禁止普通成员改 global 级',
        });
      }
    } else if (exec.kind !== 'task' || row.taskId !== exec.taskId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: '仅归属任务可更新该记忆，禁止跨任务更新',
      });
    }
    if (
      args.content === undefined &&
      args.description === undefined &&
      args.tags === undefined
    ) {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.MEMORY_INVALID,
        message: '至少提供 content/description/tags 之一',
      });
    }
    if (args.content !== undefined && args.content.trim().length === 0) {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.MEMORY_INVALID,
        message: 'content 不得为空（空白字符视为未提供有效内容）',
      });
    }
    const data: Prisma.MemoryUpdateInput = {};
    if (args.content !== undefined) {
      data.content = args.content;
      data.contentHash = computeMemoryContentHash(args.content);
    }
    if (args.description !== undefined) {
      data.description = (
        args.description.trim() || (args.content ?? row.content).slice(0, 120)
      ).slice(0, 255);
    }
    if (args.tags !== undefined) {
      data.tags = args.tags as Prisma.InputJsonValue;
    }
    const updated = await this.prisma.memory.update({
      where: { id: row.id },
      data,
    });
    return { memoryId: updated.id, level: updated.level, status: 'updated' };
  }

  /**
   * memory_search：检索平台记忆（按需检索，替代自动注入；只读，无 selfInstanceId）。
   * 1. 归属校验（无 selfInstanceId，仅校验 worker 有该任务会话）。
   * 2. 解析 task 行 teamId（任务不存在 → 404；project 级已下线 → 400；
   *    session-unification Todo 9 起仅 team/global 可见，level=task → 400
   *    MEMORY_LEVEL_INVALID，task 分支已删除）。
   * 3. `memory.findMany({where: {deletedAt: null, OR: [team级(teamId)/global]}})`——
   *    **软删过滤必须**（Metis M7）；可选 level 入参收窄到单级。
   * 4. query → content contains（prisma 层过滤）；tags → 取回后内存过滤
   *    （tags 为 Json 列，prisma 无 contains 支持）。
   * 5. limit 截断（默认 20，max 50），createdAt desc 排序。
   * 返回 [{id, level, content, tags, createdBy, createdAt}]。
   */
  async memorySearch(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      teamId?: string;
      query?: string;
      level?: MemoryLevel;
      tags?: string[];
      sourceInstanceId?: string;
      sourceAgentId?: string;
      sessionId?: string;
      limit?: number;
    },
  ): Promise<
    Array<{
      id: string;
      level: string;
      content: string;
      description: string | null;
      tags: Prisma.JsonValue | null;
      createdBy: string;
      createdAt: string;
      sourceAgentId: string | null;
      sourceInstanceId: string | null;
      sourceType: string | null;
      sessionId: string | null;
      sessionTitle: string | null;
      channelId: string | null;
    }>
  > {
    const exec = await this.resolveExecContext(ctx, args);

    // project 级已下线（zod schema 已拒绝，此处防绕过 schema 直调 service）。
    if ((args.level as string) === 'project') {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.MEMORY_INVALID,
        message: 'project 级记忆已下线，请改用 level=team（团队级记忆）',
      });
    }

    // session-unification Todo 9：任务级记忆已删除，level=task 一律 400
    // MEMORY_LEVEL_INVALID（双上下文，任务查找之前拦截）。
    if ((args.level as string) === 'task') {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.MEMORY_LEVEL_INVALID,
        message:
          '任务级记忆已删除，请改用 level=team（团队级记忆）或 level=global（全局记忆）',
      });
    }

    // 可见范围：所属团队的 team 级（task 无团队归属则不匹配）+ global 级；
    // level 入参收窄到单级。
    const whereOr: Prisma.MemoryWhereInput[] = [];
    if (exec.kind === 'team') {
      if (args.level === undefined || args.level === MEMORY_LEVELS.team) {
        whereOr.push({ level: MEMORY_LEVELS.team, teamId: exec.teamId });
      }
      if (args.level === undefined || args.level === MEMORY_LEVELS.global) {
        whereOr.push({ level: MEMORY_LEVELS.global });
      }
    } else {
      const task = await this.prisma.task.findUnique({
        where: { id: exec.taskId },
        select: { teamId: true },
      });
      if (!task) {
        throw new NotFoundException({
          code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
          message: '任务不存在',
        });
      }
      const taskTeamId = (task as { teamId?: string | null }).teamId ?? null;
      if (args.level === undefined || args.level === MEMORY_LEVELS.team) {
        if (taskTeamId) {
          whereOr.push({
            level: MEMORY_LEVELS.team,
            teamId: taskTeamId,
          });
        }
      }
      if (args.level === undefined || args.level === MEMORY_LEVELS.global) {
        whereOr.push({ level: MEMORY_LEVELS.global });
      }
    }
    if (whereOr.length === 0) {
      // 如 level=team 但任务无团队归属 → 无可见范围，返回空
      return [];
    }

    const tokens = args.query
      ? args.query.trim().split(/\s+/).filter(Boolean)
      : [];
    const tokenFilters: Prisma.MemoryWhereInput[] = tokens.map((t) => ({
      OR: [{ content: { contains: t } }, { description: { contains: t } }],
    }));
    const sourceFilters: Prisma.MemoryWhereInput[] = [];
    if (args.sourceInstanceId)
      sourceFilters.push({ sourceInstanceId: args.sourceInstanceId });
    if (args.sourceAgentId)
      sourceFilters.push({ sourceAgentId: args.sourceAgentId });
    if (args.sessionId) sourceFilters.push({ sessionId: args.sessionId });
    const andBlocks: Prisma.MemoryWhereInput[] = [
      { OR: whereOr },
      ...tokenFilters,
      ...sourceFilters,
    ];
    const where: Prisma.MemoryWhereInput =
      tokenFilters.length > 0 || sourceFilters.length > 0
        ? { deletedAt: null, AND: andBlocks }
        : { deletedAt: null, OR: whereOr };
    const rows = await this.prisma.memory.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    const limit = this.normalizeMemoryLimit(args.limit);
    return this.filterMemoryByTags(rows as any, args.tags)
      .slice(0, limit)
      .map((row: any) => ({
        id: row.id,
        level: row.level,
        content: row.content,
        description: row.description ?? null,
        tags: row.tags,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        sourceAgentId: row.sourceAgentId ?? null,
        sourceInstanceId: row.sourceInstanceId ?? null,
        sourceType: row.sourceType ?? null,
        sessionId: row.sessionId ?? null,
        sessionTitle: row.sessionTitle ?? null,
        channelId: row.channelId ?? null,
      }));
  }

  /**
   * team_view：任务团队实时视图（只读，vteam-team-collaboration Todo 3）。
   * 与 task_context 的差异增量：会话实时状态（sessionStatus/sessionId，复用 toTaskDto
   * instances 构造逻辑）+ 全量角色视图。
   * 1. 归属校验（无 selfInstanceId，仅校验 worker 有该任务会话——对齐 memorySearch 只读先例）。
   * 2. task 行校验存在（404）。
   * 3. 并行查：task_agents（未 removed，含 agent 关联 + 各自 sessions）。
   * 4. members：{id, agentId, alias, role, seq, main, sessionStatus, sessionId}。
   */
  async teamView(
    ctx: PlatformMcpContext,
    args: { taskId: string },
  ): Promise<{
    taskId: string;
    pendingReceipts: { pending: number; total: number };
    members: Array<{
      id: string;
      agentId: string;
      alias: string | null;
      role: string | null;
      seq: number;
      main: boolean;
      sessionStatus: string | null;
      sessionId: string | null;
    }>;
  }> {
    await this.assertWorkerTask(ctx, args.taskId);
    const task = await this.prisma.task.findUnique({
      where: { id: args.taskId },
      select: { id: true, teamId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const viewTeamId = (task as { teamId?: string | null }).teamId ?? null;
    const viewTeam = viewTeamId
      ? await this.prisma.team.findUnique({
          where: { id: viewTeamId },
          select: { mainAgentMemberId: true },
        })
      : null;
    const viewMainId =
      (viewTeam as { mainAgentMemberId?: string | null } | null)
        ?.mainAgentMemberId ?? null;
    const [agentRows] = await Promise.all([
      viewTeamId
        ? this.prisma.teamMember.findMany({
            where: { teamId: viewTeamId },
            orderBy: [{ agentId: 'asc' }, { seq: 'asc' }],
            select: {
              id: true,
              agentId: true,
              alias: true,
              seq: true,
              agent: { select: { role: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    const viewSessions =
      agentRows.length > 0
        ? await this.prisma.session.findMany({
            where: {
              teamMemberId: { in: agentRows.map((r) => r.id) },
              status: { not: SESSION_STATUS.archived },
            },
            select: { id: true, status: true, teamMemberId: true },
          })
        : [];
    const viewSessionByMember = new Map(
      (viewSessions ?? []).map((x: any) => [x.teamMemberId, x]),
    );
    return {
      taskId: task.id,
      // todo5 待回执看板口径（31 篇 §3.4）：n/N 计数，仅计数不做分析页。
      pendingReceipts: await this.pendingReceiptCounts(task.id),
      members: agentRows.map((r) => {
        const vs = viewSessionByMember.get(r.id) as
          { id: string; status: string } | undefined;
        return {
          id: r.id,
          agentId: r.agentId,
          alias: r.alias,
          role: r.agent.role,
          seq: r.seq,
          main: r.id === viewMainId,
          sessionStatus: vs?.status ?? null,
          sessionId: vs?.id ?? null,
        };
      }),
    };
  }

  /**
   * my_profile：自身 Agent 配置视图（只读，vteam-team-collaboration Todo 3）。
   * 返回生效权限 effectivePermission（唯一事实来源，经绑定 ExecutionPolicy 解析，
   * 与 live enforcement 同源）+ 任务实例别名/序号/工作目录/默认模型；
   * prompt 仅返回前 500 字符摘要（promptTruncated 标记），不暴露完整提示词。
   * 1. 归属校验（selfInstanceId 必填，返回活跃成员 id）。
   * 2. 团队成员（含 agent 关联）查自身配置；缺失或不在任务团队 → 404。
   */
  async myProfile(
    ctx: PlatformMcpContext,
    args: { taskId: string; selfInstanceId: string },
  ): Promise<{
    taskId: string;
    instanceId: string;
    agentId: string;
    name: string;
    role: string | null;
    alias: string | null;
    seq: number;
    workDir: string | null;
    defaultModelId: string | null;
    /**
     * 生效权限（唯一事实来源）：经 ExecutionPolicyService.resolveByAgent 按
     * agent 绑定策略解析（层① opencode 原生 permission + 层② guard correction），
     * 与 live enforcement 同源。未绑定/策略缺失时为 null（调用方回退提示词边界）。
     */
    effectivePermission: {
      policyId: string;
      policyName: string;
      agentName: string;
      permission: Record<string, unknown>;
      correction: Record<string, unknown>;
    } | null;
    /** 调用方 opencode agent 名（`vteam-<role>`，无 role 回退 `vteam-plan`）。 */
    agentName: string;
    promptSummary: string;
    promptTruncated: boolean;
  }> {
    const instanceId = await this.assertWorkerTask(
      ctx,
      args.taskId,
      args.selfInstanceId,
    );
    const profileTeamId = await this.teamIdOfTask(args.taskId);
    const member = await this.prisma.teamMember.findFirst({
      where: { id: instanceId },
      select: {
        id: true,
        teamId: true,
        agentId: true,
        alias: true,
        seq: true,
        workDir: true,
        agent: {
          select: {
            id: true,
            name: true,
            role: true,
            prompt: true,
            defaultModelId: true,
            policyId: true,
          },
        },
      },
    });
    if (!member || (profileTeamId && member.teamId !== profileTeamId)) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: `实例 ${instanceId} 不在任务团队中`,
      });
    }
    const profile = member;
    const prompt = profile.agent.prompt;
    const truncated = prompt.length > 500;
    const agentRole = profile.agent.role as string | null;
    const agentPolicyId =
      (profile.agent as { policyId?: string | null }).policyId ?? null;
    let effectivePermission: {
      policyId: string;
      policyName: string;
      agentName: string;
      permission: Record<string, unknown>;
      correction: Record<string, unknown>;
    } | null = null;
    try {
      effectivePermission =
        (await this.executionPolicyService?.resolveByAgent({
          policyId: agentPolicyId,
          role: agentRole,
        })) ?? null;
    } catch {
      effectivePermission = null;
    }
    return {
      taskId: args.taskId,
      instanceId: profile.id,
      agentId: profile.agent.id,
      name: profile.agent.name,
      role: profile.agent.role,
      alias: profile.alias,
      seq: profile.seq,
      workDir: profile.workDir,
      defaultModelId: profile.agent.defaultModelId,
      effectivePermission,
      agentName: agentRole ? `vteam-${agentRole}` : 'vteam-plan',
      promptSummary: truncated ? prompt.slice(0, 500) : prompt,
      promptTruncated: truncated,
    };
  }

  /**
   * 任务团队归属门：任务存在（404 否则）+ 所属团队主成员 id（tmm_，主成员门比较依据）。
   * 任务无团队/团队无主成员 → 对应 null（调用方按 403 处理）。
   * 供 team_add_member 等「仅主 Agent 可调」工具复用。
   */
  private async findTaskTeamGate(taskId: string): Promise<{
    teamId: string | null;
    mainMemberId: string | null;
  }> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { teamId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    if (!task.teamId) {
      return { teamId: null, mainMemberId: null };
    }
    const team = await this.prisma.team.findUnique({
      where: { id: task.teamId },
      select: { mainAgentMemberId: true },
    });
    return {
      teamId: task.teamId,
      mainMemberId: team?.mainAgentMemberId ?? null,
    };
  }

  /**
   * team_add_member：主 Agent 申请增员（L2 自治确认门，vteam-team-collaboration Todo 8）。
   * 归属校验 → 仅主成员（team.mainAgentMemberId===selfInstanceId，否则 403）→ 幂等
   * （已加入 400 / pending 重复申请 409）→ createForPlatform 创建平台确认请求
   * （question=「是否确认」，options=['确认','拒绝']，content.source='platform'）。
   * 用户确认后 onResolved 钩子执行 handleTeamAddResolved（校验 + updateTeam + 审计）。
   */
  async teamAddMember(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      agentId: string;
      alias?: string;
      workDir?: string;
    },
  ): Promise<{
    requestId: string;
    taskId: string;
    agentId: string;
    alias: string;
  }> {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);

    const { teamId: addTeamId, mainMemberId: addMainId } =
      await this.findTaskTeamGate(args.taskId);
    if (!addMainId || addMainId !== args.selfInstanceId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `仅主 Agent（${addMainId ?? '未设置'}）可申请增员；请知会主 Agent 调用 team_add_member`,
      });
    }

    const agentRow = await this.prisma.agent.findUnique({
      where: { id: args.agentId },
      select: { id: true, name: true, role: true },
    });
    if (!agentRow) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: `Agent ${args.agentId} 不存在`,
      });
    }

    const existing = addTeamId
      ? await this.prisma.teamMember.findFirst({
          where: { teamId: addTeamId, agentId: args.agentId },
          select: { id: true },
        })
      : null;
    if (existing) {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.AGENT_ALREADY_IN_TEAM,
        message: `Agent ${agentRow.name} 已在任务团队中，无需重复申请`,
      });
    }

    const pendingRows = await this.prisma.agentQuestion.findMany({
      where: { taskId: args.taskId, status: AGENT_QUESTION_STATUS.PENDING },
      select: { requestId: true, content: true },
    });
    const dupPending = pendingRows.some((r) => {
      const content = (r.content ?? {}) as {
        source?: string;
        action?: string;
        agentId?: string;
      };
      return (
        content.source === 'platform' &&
        content.action === 'team_add_member' &&
        content.agentId === args.agentId
      );
    });
    if (dupPending) {
      throw new ConflictException({
        code: PLATFORM_MCP_ERRORS.PENDING_APPLICATION,
        message: `Agent ${agentRow.name} 已有待确认的增员申请，请等待确认结果`,
      });
    }

    const explicitAlias = args.alias?.trim() || null;
    const alias = explicitAlias ?? agentRow.name;
    const aliasText = alias !== agentRow.name ? `（别名 ${alias}）` : '';
    const question = aliasText
      ? `主 Agent 申请将 ${agentRow.name}${aliasText}加入团队，是否确认？`
      : `主 Agent 申请将 ${agentRow.name} 加入团队，是否确认？`;
    const created = await this.questionsService.createForPlatform(
      args.taskId,
      {
        question,
        header: '团队增员确认',
        options: ['确认', '拒绝'],
      },
      {
        agentId: args.agentId,
        onResolved: async (resolved) => {
          await this.handleTeamAddResolved({
            taskId: args.taskId,
            agentId: args.agentId,
            alias: explicitAlias ?? undefined,
            workDir: args.workDir,
            answers: resolved.answers,
            actor: resolved.actor,
          });
        },
      },
    );
    this.logger.log(
      `[team-add] 主 Agent 申请增员 task=${args.taskId} agent=${args.agentId} requestId=${created.requestId}`,
    );
    return {
      requestId: created.requestId,
      taskId: args.taskId,
      agentId: args.agentId,
      alias,
    };
  }

  /**
   * plan_mode：切换任务计划模式开关（仅主 Agent 可调）。
   * enabled=true → 主 Agent 先出计划文档（写到工作目录 .opencode/plans/ 下），其他成员只评审
   * 不起草；enabled=false → 直接执行。agentName 可选：同步指定主 Agent 的执行 agent
   * （显式名；空串=回跟随默认；不传=保持当前）。agent 名不做存在性强校验（弱校验告警，
   * 执行期由 opencode 报错并经 agent.status error 回流，对齐 teams.updateMember 口径）。
   */
  async planMode(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      enabled: boolean;
      agentName?: string;
    },
  ): Promise<{
    taskId: string;
    planMode: boolean;
    agentName: string | null;
  }> {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);

    const { mainMemberId } = await this.findTaskTeamGate(args.taskId);
    if (!mainMemberId || mainMemberId !== args.selfInstanceId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `仅主 Agent（${mainMemberId ?? '未设置'}）可切换计划模式；请知会主 Agent 调用 plan_mode`,
      });
    }

    let agentName: string | null | undefined;
    if (args.agentName !== undefined) {
      // 空串 → null（回跟随默认）；非空 → 原值透传（弱校验：存在性由执行期裁决）
      agentName = args.agentName?.trim() || null;
      await this.prisma.teamMember.update({
        where: { id: mainMemberId },
        data: { opencodeAgentName: agentName },
      });
    } else {
      const row = await this.prisma.teamMember.findUnique({
        where: { id: mainMemberId },
        select: { opencodeAgentName: true },
      });
      agentName = row?.opencodeAgentName ?? null;
    }

    const updated = await this.prisma.task.update({
      where: { id: args.taskId },
      data: { planMode: args.enabled },
    });
    this.logger.log(
      `[plan-mode] 主 Agent 切换计划模式 task=${args.taskId} planMode=${updated.planMode} agent=${agentName ?? '(保持)'}`,
    );
    return {
      taskId: args.taskId,
      planMode: updated.planMode,
      agentName: agentName ?? null,
    };
  }

  /**
   * plan_complete：标记计划执行完成（executing→completed，仅主 Agent 可调）。
   * 归属校验 → 仅主成员（team.mainAgentMemberId===selfInstanceId，否则 403）→
   * PlanLifecycleService.completePlan（仅 executing 可完工，已 completed 幂等返回）。
   */
  async planComplete(
    ctx: PlatformMcpContext,
    args: { taskId: string; selfInstanceId: string },
  ): Promise<{ taskId: string; status: string; idempotent: boolean }> {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);

    if (!this.planLifecycle) {
      throw new ServiceUnavailableException({
        code: PLAN_LIFECYCLE_ERRORS.PLAN_COMPLETE_UNAVAILABLE,
        message: '计划服务未装配，暂不可标记完工',
      });
    }

    const { mainMemberId } = await this.findTaskTeamGate(args.taskId);
    if (!mainMemberId || mainMemberId !== args.selfInstanceId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `仅主 Agent（${mainMemberId ?? '未设置'}）可标记计划完工；请知会主 Agent 调用 plan_complete`,
      });
    }

    const result = await this.planLifecycle.completePlan(args.taskId, {
      userId: args.selfInstanceId,
      userName: null,
      instanceId: args.selfInstanceId,
    });
    this.logger.log(
      `[plan-complete] 主 Agent 标记计划完工 task=${args.taskId} status=${result.plan.status} idempotent=${result.idempotent}`,
    );
    return {
      taskId: args.taskId,
      status: result.plan.status,
      idempotent: result.idempotent,
    };
  }

  /**
   * wecom_reply：回复企业微信用户（仅当消息来自企微时使用）。
   * - 解析当前任务（taskId/selfInstanceId 可选，未传则从 worker 会话自动解析）→ 校验归属
   * - 查找任务所属团队绑定的 wecom_aibot 渠道 → 通过 WecomAibotAdapter 发送到企微（@发送者，群聊时@）
   * - 同时镜像到任务群聊（@发送者 前缀），确保两端可见
   * - 成功/失败均返回 isError:false 的 content 文本，不中断 agent 会话
   */
  async wecomReply(
    ctx: PlatformMcpContext,
    args: {
      taskId?: string;
      selfInstanceId?: string;
      msgtype?: string;
      text?: string;
      atUser?: boolean;
      card?: unknown;
      media?: string;
      mediaId?: string;
      filename?: string;
      articles?: Array<{
        title: string;
        description?: string;
        url?: string;
        picurl?: string;
      }>;
      mpnews?: unknown;
    },
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    messageId?: string;
    channelId?: string | null;
    wecomSent?: boolean;
  }> {
    const msgtypeRaw = (args.msgtype ?? 'text').trim().toLowerCase();
    const msgtype = [
      'text',
      'markdown',
      'template_card',
      'image',
      'mpnews',
    ].includes(msgtypeRaw)
      ? msgtypeRaw
      : 'text';
    const rawText = args.text?.trim() ?? '';
    const atUser = args.atUser ?? true;
    if ((msgtype === 'text' || msgtype === 'markdown') && !rawText) {
      return {
        content: [{ type: 'text', text: '发送失败: text 不能为空' }],
        isError: false,
      };
    }
    if (rawText.length > 4000) {
      return {
        content: [{ type: 'text', text: '发送失败: text 长度超过 4000 字符' }],
        isError: false,
      };
    }
    if (msgtype === 'template_card' && !args.card) {
      return {
        content: [
          { type: 'text', text: '发送失败: template_card 需要 card 参数' },
        ],
        isError: false,
      };
    }
    if (msgtype === 'image' && !args.media && !args.mediaId) {
      return {
        content: [
          {
            type: 'text',
            text: '发送失败: image 需要 media(文件路径) 或 mediaId 参数',
          },
        ],
        isError: false,
      };
    }
    if (msgtype === 'mpnews') {
      const rawArticles =
        (args.articles as unknown) ?? (args.mpnews as unknown);
      let articles: Array<{
        title: string;
        description?: string;
        url?: string;
        picurl?: string;
      }> = [];
      if (Array.isArray(rawArticles)) {
        articles = rawArticles as any;
      } else if (
        rawArticles &&
        typeof rawArticles === 'object' &&
        Array.isArray((rawArticles as any).articles)
      ) {
        articles = (rawArticles as any).articles as any;
      } else if (typeof rawArticles === 'string') {
        try {
          const parsed = JSON.parse((rawArticles as string).trim());
          if (Array.isArray(parsed)) articles = parsed as any;
          else if (parsed && Array.isArray(parsed.articles))
            articles = parsed.articles as any;
        } catch {}
      }
      if (!articles || articles.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: '发送失败: mpnews 需要 articles(≥1 篇) 或 mpnews 参数',
            },
          ],
          isError: false,
        };
      }
    }

    let taskId: string | null = args.taskId?.trim() || null;
    let selfInstanceId: string | null = args.selfInstanceId?.trim() || null;
    if (!taskId || !selfInstanceId) {
      try {
        const sess = await (this.prisma as any).session.findFirst({
          where: { workerId: ctx.workerId },
          orderBy: { createdAt: 'desc' },
          select: { taskId: true, teamMemberId: true, agentId: true },
        });
        if (sess) {
          if (!taskId) taskId = sess.taskId ?? null;
          if (!selfInstanceId)
            selfInstanceId = sess.teamMemberId ?? sess.agentId ?? null;
        }
      } catch {}
    }
    if (!taskId) {
      return {
        content: [
          {
            type: 'text',
            text: '发送失败: 无法解析当前任务上下文（请传 taskId）',
          },
        ],
        isError: false,
      };
    }
    if (!selfInstanceId) {
      return {
        content: [
          {
            type: 'text',
            text: '发送失败: 无法解析实例身份（请传 selfInstanceId）',
          },
        ],
        isError: false,
      };
    }
    let instanceId: string;
    try {
      instanceId = await this.assertWorkerTask(ctx, taskId, selfInstanceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `发送失败: ${msg}` }],
        isError: false,
      };
    }

    let wecomChannelId: string | null = null;
    try {
      // 渠道绑定已迁移到团队：从 task 找到 team，再查团队绑定的 wecom 渠道
      const task = await (this.prisma as any).task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      const teamId = task?.teamId ?? null;
      if (teamId) {
        const bindings = await (this.prisma as any).teamMessageChannel.findMany(
          {
            where: { teamId },
            select: { messageChannelId: true },
          },
        );
        for (const b of bindings as Array<{ messageChannelId: string }>) {
          try {
            const ch = await (this.prisma as any).messageChannel.findUnique({
              where: { id: b.messageChannelId },
              select: { id: true, type: true },
            });
            if (ch && ch.type === 'wecom_aibot') {
              wecomChannelId = ch.id;
              break;
            }
          } catch {}
        }
      }
    } catch {}
    if (!wecomChannelId) {
      return {
        content: [
          { type: 'text', text: '发送失败: 当前团队未绑定企业微信渠道' },
        ],
        isError: false,
      };
    }

    let adapter: any | undefined;
    try {
      const WecomAibotAdapterRef = (
        await import('../message-channels/adapters/wecom-aibot.adapter')
      ).WecomAibotAdapter;
      adapter = this.moduleRef?.get(WecomAibotAdapterRef, {
        strict: false,
      }) as unknown;
    } catch {}
    if (!adapter) {
      try {
        const g = globalThis as unknown as Record<string, unknown>;
        adapter = (g as any)['__wecomAdapter'] as unknown;
      } catch {}
    }
    if (!adapter || typeof adapter.sendNewMessage !== 'function') {
      return {
        content: [{ type: 'text', text: '发送失败: WeCom 适配器未就绪' }],
        isError: false,
      };
    }

    let fromName: string | null = null;
    let chattype: string | null = null;
    try {
      const pending = (adapter as any).getPendingOperatorForTask?.(taskId);
      if (pending) {
        fromName = pending.fromUserName ?? pending.fromUserId ?? null;
        chattype = pending.chattype ?? null;
      } else {
        const groupCh = await this.prisma.chatChannel.findFirst({
          where: { taskId, type: CHANNEL_TYPE.task_group },
          select: { id: true },
        });
        if (groupCh) {
          const ext = await (this.prisma as any).message.findFirst({
            where: { channelId: groupCh.id, senderType: SENDER_TYPE.external },
            orderBy: { createdAt: 'desc' },
            select: { id: true, content: true },
          });
          if (ext) {
            const streamInfo =
              (adapter as any).getStream?.(ext.id) ??
              (adapter as any).getPendingUser?.(ext.id);
            if (streamInfo) {
              fromName =
                streamInfo.fromUserName ?? streamInfo.fromUserId ?? null;
              chattype = streamInfo.chattype ?? null;
            } else {
              const contentText = (ext.content as any)?.text ?? '';
              const m = /\[WeCom:([^\]]+)\]/.exec(String(contentText));
              if (m) fromName = m[1].trim();
            }
          }
        }
      }
    } catch {}

    let wecomText = rawText;
    let mirrorText = rawText;
    if (fromName && atUser) {
      if (chattype === 'group') {
        wecomText = `@${fromName} ${rawText}`;
      }
      mirrorText = `@${fromName} ${rawText}`;
    } else if (fromName) {
      mirrorText = `@${fromName} ${rawText}`;
    }

    let wecomSent = false;
    let resolvedCard: unknown = args.card ?? null;
    let mirrorContent: any = null;
    let sendError: string | null = null;
    try {
      if (msgtype === 'text' || msgtype === 'markdown') {
        if (typeof (adapter as any).finishStream === 'function') {
          const groupCh = await this.prisma.chatChannel.findFirst({
            where: { taskId, type: CHANNEL_TYPE.task_group },
            select: { id: true },
          });
          if (groupCh) {
            const ext = await (this.prisma as any).message.findFirst({
              where: {
                channelId: groupCh.id,
                senderType: SENDER_TYPE.external,
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });
            if (ext) {
              try {
                wecomSent = await (adapter as any).finishStream(
                  ext.id,
                  wecomText,
                );
                if (wecomSent) {
                  this.logger.log(
                    `wecom_reply finishStream ok taskId=${taskId} internalMessageId=${ext.id} stream replaced`,
                  );
                } else {
                  this.logger.log(
                    `wecom_reply finishStream miss taskId=${taskId} internalMessageId=${ext.id} fallback to sendNewMessage`,
                  );
                }
              } catch (e) {
                this.logger.warn(
                  `wecom_reply finishStream error taskId=${taskId}: ${(e as Error).message}`,
                );
              }
            }
          }
        }
        if (
          !wecomSent &&
          typeof (adapter as any).sendNewMessage === 'function'
        ) {
          wecomSent = await (adapter as any).sendNewMessage(
            wecomChannelId,
            wecomText,
          );
        }
        if (
          !wecomSent &&
          typeof (adapter as any).sendFallbackMessage === 'function'
        ) {
          wecomSent = await (adapter as any).sendFallbackMessage(
            wecomChannelId,
            wecomText,
          );
        }
        mirrorContent = { text: mirrorText, msgtype, parts: [] };
      } else if (msgtype === 'template_card') {
        let cardObj: any;
        try {
          if (typeof resolvedCard === 'string') {
            const s = (resolvedCard as string).trim();
            cardObj = s ? JSON.parse(s) : null;
          } else {
            cardObj = resolvedCard as any;
          }
        } catch (e) {
          sendError = `card JSON 解析失败: ${(e as Error).message}`;
          this.logger.warn(
            `wecom_reply template_card JSON parse failed taskId=${taskId} err=${(e as Error).message} raw=${String(resolvedCard).slice(0, 800)}`,
          );
          throw new Error(sendError);
        }
        if (
          cardObj &&
          typeof cardObj === 'object' &&
          !cardObj.card_type &&
          cardObj.template_card &&
          typeof cardObj.template_card === 'object'
        ) {
          this.logger.log(
            `wecom_reply template_card unwrap template_card wrapper taskId=${taskId}`,
          );
          cardObj = cardObj.template_card;
        }
        if (
          cardObj &&
          typeof cardObj === 'object' &&
          !cardObj.card_type &&
          cardObj.card &&
          typeof cardObj.card === 'object' &&
          cardObj.card.card_type
        ) {
          this.logger.log(
            `wecom_reply template_card unwrap card wrapper taskId=${taskId}`,
          );
          cardObj = cardObj.card;
        }
        if (!cardObj || typeof cardObj !== 'object') {
          sendError = 'card 必须为 JSON 对象';
          throw new Error(sendError);
        }
        const validCardTypes = [
          'text_notice',
          'button_interaction',
          'vote_interaction',
          'news_notice',
          'multiple_interaction',
        ];
        if (!cardObj.card_type || typeof cardObj.card_type !== 'string') {
          sendError =
            'card.card_type 必填（如 text_notice / button_interaction / vote_interaction / news_notice）';
          this.logger.warn(
            `wecom_reply template_card missing card_type taskId=${taskId} card=${JSON.stringify(cardObj).slice(0, 1200)}`,
          );
          throw new Error(sendError);
        }
        if (!validCardTypes.includes(cardObj.card_type)) {
          this.logger.warn(
            `wecom_reply template_card unknown card_type=${cardObj.card_type} taskId=${taskId}`,
          );
        }
        // Only card_type + main_title are required; icon_url/pic_url/image_url/card_image etc are all optional (no image required to send card)
        if (!cardObj.main_title || typeof cardObj.main_title !== 'object') {
          // Graceful: if main_title missing but we have rawText fallback, inject minimal main_title; else require it
          if (rawText) {
            cardObj.main_title = {
              title: rawText.slice(0, 64),
              desc: rawText.slice(0, 512),
            };
            this.logger.log(
              `wecom_reply template_card auto-filled main_title from text taskId=${taskId} card_type=${cardObj.card_type}`,
            );
          } else if (
            [
              'text_notice',
              'news_notice',
              'button_interaction',
              'vote_interaction',
              'multiple_interaction',
            ].includes(cardObj.card_type)
          ) {
            sendError =
              'card.main_title 必填（card_type 已提供但 main_title 缺失，image/pic_url 等均为可选）';
            this.logger.warn(
              `wecom_reply template_card missing main_title taskId=${taskId} card_type=${cardObj.card_type} card=${JSON.stringify(cardObj).slice(0, 800)}`,
            );
            throw new Error(sendError);
          }
        }
        // Auto-fill task_id (WeCom requires unique per vote; same value reused causes 42014 taskid has existed)
        // Generate unique per card send: base_sanitized + _<timestamp>_<random>, keep <64 and [\w\-@] charset
        const genUniqueTaskId = (base: string): string => {
          const sanitized =
            base.replace(/[^a-zA-Z0-9_\-@]/g, '_') || 't_default';
          const suffix = `_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const maxBase = 64 - suffix.length;
          return `${sanitized.slice(0, Math.max(1, maxBase))}${suffix}`.slice(
            0,
            64,
          );
        };
        if (!cardObj.task_id) {
          cardObj.task_id = genUniqueTaskId(taskId);
        } else {
          // Provided task_id must also be unique per send; sanitize and ensure uniqueness to avoid 42014
          const provided = String(cardObj.task_id).trim();
          const sanitizedProvided =
            provided.replace(/[^a-zA-Z0-9_\-@]/g, '_').slice(0, 64) ||
            genUniqueTaskId(taskId);
          // If provided equals base sanitized (reused t_0000000014), make it unique
          const baseSanitized = taskId.replace(/[^a-zA-Z0-9_\-@]/g, '_');
          if (
            sanitizedProvided === baseSanitized ||
            sanitizedProvided === taskId
          ) {
            cardObj.task_id = genUniqueTaskId(taskId);
          } else {
            // Ensure length <64 and unique suffix to avoid collision when same LLM value reused
            const suffix = `_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const needsSuffix = cardObj.task_id === sanitizedProvided; // reused literal
            // Append short suffix if provided looks like repeated reuse (defensive); keep total <64
            if (needsSuffix && sanitizedProvided.length <= 48) {
              cardObj.task_id = `${sanitizedProvided}${suffix}`.slice(0, 64);
            } else {
              cardObj.task_id = sanitizedProvided.slice(0, 64);
              // If still collision risk and provided not unique enough, ensure randomness for vote_interaction
              if (
                cardObj.card_type === 'vote_interaction' &&
                sanitizedProvided.length < 60
              ) {
                cardObj.task_id =
                  `${sanitizedProvided.slice(0, 64 - suffix.length)}${suffix}`.slice(
                    0,
                    64,
                  );
              }
            }
          }
        }
        // Per-type normalization per WeCom spec:
        // - text_notice / news_notice: card_action REQUIRED, type MUST be 1 or 2 (42045 if type 0 / missing). Auto-fill type=1 with placeholder URL.
        // - button_interaction / vote_interaction / multiple_interaction: card_action OPTIONAL; do NOT auto-add type 0 (working question cards have none). Only validate if present.
        // - button_list type=1 without url -> 42028 Missing Url; auto-fill placeholder URL.
        const PLACEHOLDER_URL = 'https://work.weixin.qq.com';
        const noticeTypes = new Set(['text_notice', 'news_notice']);
        const interactiveTypes = new Set([
          'button_interaction',
          'vote_interaction',
          'multiple_interaction',
        ]);
        if ('card_style' in cardObj) {
          delete cardObj.card_style;
          this.logger.log(
            `wecom_reply template_card stripped invalid card_style taskId=${taskId}`,
          );
        }
        if (!cardObj.source || typeof cardObj.source !== 'object') {
          cardObj.source = { desc: 'vteam', desc_color: 0 };
          this.logger.log(
            `wecom_reply template_card auto-filled source taskId=${taskId} card_type=${cardObj.card_type}`,
          );
        } else {
          const sc: any = cardObj.source;
          if (
            typeof sc.desc_color !== 'undefined' &&
            ![0, 1, 2, 3].includes(sc.desc_color)
          ) {
            sc.desc_color = 0;
          }
        }
        // Per-type card_action handling
        if (noticeTypes.has(cardObj.card_type)) {
          const ca: any = cardObj.card_action;
          const hasValidType1 =
            ca &&
            typeof ca === 'object' &&
            ca.type === 1 &&
            typeof ca.url === 'string' &&
            ca.url.trim();
          const hasValidType2 =
            ca &&
            typeof ca === 'object' &&
            ca.type === 2 &&
            typeof ca.appid === 'string' &&
            ca.appid.trim();
          if (!hasValidType1 && !hasValidType2) {
            // Fix 42045: type 0 or missing is invalid for text_notice/news_notice; must be 1 or 2
            if (ca && typeof ca === 'object' && ca.type === 2 && !ca.appid) {
              // Attempts type 2 but missing appid -> fallback to type 1
            }
            cardObj.card_action = { type: 1, url: PLACEHOLDER_URL };
            this.logger.log(
              `wecom_reply template_card auto-filled card_action type=1 url=${PLACEHOLDER_URL} for ${cardObj.card_type} taskId=${taskId} (42045 fix)`,
            );
          } else {
            // Valid type exists but ensure required field present
            if (ca.type === 1 && (!ca.url || !String(ca.url).trim())) {
              ca.url = PLACEHOLDER_URL;
              this.logger.log(
                `wecom_reply template_card patched card_action url placeholder taskId=${taskId}`,
              );
            }
          }
        } else if (interactiveTypes.has(cardObj.card_type)) {
          // For interactive, card_action optional; remove invalid ones instead of adding type 0
          if (cardObj.card_action && typeof cardObj.card_action === 'object') {
            const ca: any = cardObj.card_action;
            if (![0, 1, 2].includes(ca.type)) {
              delete cardObj.card_action;
              this.logger.log(
                `wecom_reply template_card stripped invalid card_action type=${ca.type} for interactive ${cardObj.card_type} taskId=${taskId}`,
              );
            } else if (ca.type === 1 && (!ca.url || !String(ca.url).trim())) {
              // Instead of downgrading to type 0, auto-fill url to avoid 42028-like handling? For card_action fallback to delete
              // Prefer delete to avoid accidental 42045; but type 1 without url would be invalid anywhere, so patch
              ca.url = PLACEHOLDER_URL;
              this.logger.log(
                `wecom_reply template_card patched interactive card_action url placeholder taskId=${taskId}`,
              );
            } else if (
              ca.type === 2 &&
              (!ca.appid || !String(ca.appid).trim())
            ) {
              delete cardObj.card_action;
              this.logger.log(
                `wecom_reply template_card stripped invalid card_action appid missing for interactive ${cardObj.card_type} taskId=${taskId}`,
              );
            }
          }
          // Do NOT auto-add card_action if missing — working button_interaction cards have none
        } else {
          // Unknown type: keep generic fallback but ensure not 42045; prefer delete invalid
          if (
            !cardObj.card_action ||
            typeof cardObj.card_action !== 'object' ||
            typeof (cardObj.card_action as any).type === 'undefined'
          ) {
            // Leave absent rather than forcing type 0 which may be invalid for notice-like unknown
          } else {
            const ca: any = cardObj.card_action;
            if (![0, 1, 2].includes(ca.type)) delete cardObj.card_action;
            else if (ca.type === 1 && !ca.url) ca.url = PLACEHOLDER_URL;
            else if (ca.type === 2 && !ca.appid) delete cardObj.card_action;
          }
        }
        // button_list per-item fix: type 1 without url -> 42028 Missing Url
        if (Array.isArray(cardObj.button_list)) {
          let patched = 0;
          for (let i = 0; i < cardObj.button_list.length; i++) {
            const btn: any = cardObj.button_list[i];
            if (!btn || typeof btn !== 'object') continue;
            // Ensure key exists (required for callback routing)
            if (!btn.key || typeof btn.key !== 'string' || !btn.key.trim()) {
              btn.key = `btn_${i}_${Date.now()}`.slice(0, 1024);
              patched++;
            }
            // Ensure style valid (1-4)
            if (
              typeof btn.style !== 'undefined' &&
              ![1, 2, 3, 4].includes(btn.style)
            ) {
              btn.style = 1;
              patched++;
            }
            // Fix 42028: type 1 requires url
            if (btn.type === 1 && (!btn.url || !String(btn.url).trim())) {
              btn.url = PLACEHOLDER_URL;
              patched++;
              this.logger.log(
                `wecom_reply template_card patched button_list[${i}] missing url -> placeholder taskId=${taskId}`,
              );
            }
            // If type is present but not 0/1/2, normalize to absent (key-based button)
            if (
              typeof btn.type !== 'undefined' &&
              ![0, 1, 2].includes(btn.type)
            ) {
              delete btn.type;
              if (btn.url) delete btn.url;
              if (btn.appid) delete btn.appid;
              patched++;
            }
            // If button has type but also missing required field for non-key semantics, fallback to key-based
            if (btn.type === 2 && (!btn.appid || !String(btn.appid).trim())) {
              delete btn.type;
              delete btn.appid;
              if (btn.pagepath) delete btn.pagepath;
              patched++;
            }
            // For pure key-based interactive buttons (SDK spec), strip url/type if url was dummy but type inconsistent
            // Keep type/url only when explicitly intended; otherwise ensure key-based button passes validation
            // If button has no type, ensure no stray url causes confusion (strip if not type 1)
            if (typeof btn.type === 'undefined' && btn.url && !btn.key) {
              // Keep url only if type 1 was intended; since type missing, url is stray — keep but log
            }
          }
          if (patched)
            this.logger.log(
              `wecom_reply template_card patched ${patched} button_list items taskId=${taskId} card_type=${cardObj.card_type}`,
            );
        }
        // jump_list and horizontal_content_list similar per-item url fixes (type 1 needs url, type 2 needs appid)
        for (const listKey of [
          'jump_list',
          'horizontal_content_list',
        ] as const) {
          if (Array.isArray((cardObj as any)[listKey])) {
            for (const item of (cardObj as any)[listKey] as any[]) {
              if (!item || typeof item !== 'object') continue;
              if (item.type === 1 && (!item.url || !String(item.url).trim())) {
                item.url = PLACEHOLDER_URL;
                this.logger.log(
                  `wecom_reply template_card patched ${listKey} type1 missing url -> placeholder taskId=${taskId}`,
                );
              }
              if (
                item.type === 2 &&
                (!item.appid || !String(item.appid).trim())
              ) {
                // fallback to url jump
                item.type = 1;
                item.url = PLACEHOLDER_URL;
                delete item.appid;
                this.logger.log(
                  `wecom_reply template_card patched ${listKey} type2 missing appid -> fallback type1 taskId=${taskId}`,
                );
              }
            }
          }
        }
        // quote_area type 1 needs url
        if (cardObj.quote_area && typeof cardObj.quote_area === 'object') {
          const qa: any = cardObj.quote_area;
          if (qa.type === 1 && (!qa.url || !String(qa.url).trim())) {
            qa.url = PLACEHOLDER_URL;
            this.logger.log(
              `wecom_reply template_card patched quote_area missing url taskId=${taskId}`,
            );
          }
          if (qa.type === 2 && (!qa.appid || !String(qa.appid).trim())) {
            qa.type = 0;
            delete qa.appid;
            this.logger.log(
              `wecom_reply template_card patched quote_area type2 missing appid -> type0 taskId=${taskId}`,
            );
          }
        }
        if (cardObj.card_type === 'news_notice') {
          const ci: any = cardObj.card_image;
          if (
            !ci ||
            typeof ci !== 'object' ||
            !ci.url ||
            !String(ci.url).trim()
          ) {
            cardObj.card_image = { url: PLACEHOLDER_URL };
            this.logger.log(
              `wecom_reply template_card auto-filled card_image placeholder for news_notice taskId=${taskId} (42044 fix)`,
            );
          } else if (
            typeof ci.url === 'string' &&
            !/^https?:\/\//.test(ci.url.trim())
          ) {
            ci.url = PLACEHOLDER_URL;
            this.logger.log(
              `wecom_reply template_card patched card_image url placeholder for news_notice taskId=${taskId}`,
            );
          }
          if (
            !cardObj.image_text_area ||
            typeof cardObj.image_text_area !== 'object'
          ) {
            const t =
              (cardObj.main_title as any)?.title ??
              rawText?.slice(0, 64) ??
              '图文消息';
            const d =
              (cardObj.main_title as any)?.desc ?? rawText?.slice(0, 512) ?? '';
            cardObj.image_text_area = {
              type: 1,
              title: String(t).slice(0, 64),
              desc: String(d).slice(0, 512),
              url: PLACEHOLDER_URL,
              image_url: PLACEHOLDER_URL,
            };
            this.logger.log(
              `wecom_reply template_card auto-filled image_text_area for news_notice taskId=${taskId}`,
            );
          }
        }
        if (cardObj.card_type === 'vote_interaction') {
          const cb: any = cardObj.checkbox;
          let optionList: any[] | null = null;
          if (
            cb &&
            typeof cb === 'object' &&
            Array.isArray(cb.option_list) &&
            cb.option_list.length > 0
          ) {
            optionList = cb.option_list;
          }
          if (!optionList || optionList.length === 0) {
            const rawList: any =
              (cardObj as any).vote_list ??
              (cardObj as any).option_list ??
              (cardObj as any).options ??
              (cardObj as any).select_list?.option_list ??
              (cardObj as any).select_list;
            if (Array.isArray(rawList) && rawList.length > 0)
              optionList = rawList;
            else if (
              rawList &&
              typeof rawList === 'object' &&
              Array.isArray((rawList as any).option_list)
            )
              optionList = (rawList as any).option_list;
          }
          if (optionList && optionList.length > 0) {
            const seen = new Set<string>();
            const questionKeyRaw =
              cb?.question_key ??
              (cardObj as any).vote_title ??
              (cardObj as any).question_key ??
              cardObj.main_title?.title ??
              String(taskId).slice(0, 32);
            const questionKey =
              String(questionKeyRaw).slice(0, 1024) ||
              String(taskId).slice(0, 1024);
            const titleRaw =
              (cardObj as any).vote_title ??
              cb?.title ??
              cardObj.main_title?.title ??
              '';
            const mapped = optionList
              .slice(0, 20)
              .map((o: any, idx: number) => {
                if (typeof o === 'string') {
                  const text = o.trim().slice(0, 17) || `选项${idx + 1}`;
                  let id = `${questionKey}:${text}`.slice(0, 128);
                  if (seen.has(id)) id = `${id}_${idx}`.slice(0, 128);
                  seen.add(id);
                  return { id, text };
                }
                const textRaw =
                  o.text ?? o.label ?? o.title ?? o.name ?? String(o.id ?? '');
                const text =
                  String(textRaw).trim().slice(0, 17) || `选项${idx + 1}`;
                let id =
                  String(o.id ?? o.key ?? `${questionKey}:${text}`).slice(
                    0,
                    128,
                  ) || `${questionKey}:${text}`.slice(0, 128);
                if (seen.has(id)) id = `${id}_${idx}`.slice(0, 128);
                seen.add(id);
                const item: any = { id, text };
                if (typeof o.is_checked === 'boolean')
                  item.is_checked = o.is_checked;
                return item;
              });
            while (mapped.length < 2) {
              const idx = mapped.length;
              const text = `选项${idx + 1}`;
              const id = `${questionKey}:${text}_${idx}`.slice(0, 128);
              if (!seen.has(id)) {
                seen.add(id);
                mapped.push({ id, text });
              } else mapped.push({ id: `${id}x`, text });
            }
            cardObj.checkbox = {
              question_key: questionKey,
              title: String(titleRaw).slice(0, 64) || undefined,
              option_list: mapped,
              mode: typeof cb?.mode === 'number' ? cb.mode : 0,
              disable: typeof cb?.disable === 'boolean' ? cb.disable : false,
            };
            if (!cardObj.checkbox.title) delete cardObj.checkbox.title;
            if (
              typeof cardObj.checkbox.disable === 'undefined' ||
              cardObj.checkbox.disable === false
            )
              delete cardObj.checkbox.disable;
            if ('vote_list' in cardObj) delete (cardObj as any).vote_list;
            if ('vote_title' in cardObj) delete (cardObj as any).vote_title;
            if (
              'select_list' in cardObj &&
              (cardObj as any).select_list?.option_list
            )
              delete (cardObj as any).select_list;
            if (
              !cardObj.submit_button ||
              typeof cardObj.submit_button !== 'object'
            ) {
              cardObj.submit_button = {
                text: '提交',
                key: `${questionKey}:submit`.slice(0, 1024),
              };
            } else {
              if (!(cardObj.submit_button as any).key)
                (cardObj.submit_button as any).key =
                  `${questionKey}:submit`.slice(0, 1024);
              if (!(cardObj.submit_button as any).text)
                (cardObj.submit_button as any).text = '提交';
            }
            this.logger.log(
              `wecom_reply template_card normalized vote_interaction taskId=${taskId} question_key=${questionKey} options=${mapped.length} (42037 fix)`,
            );
          } else if (
            !cb ||
            !Array.isArray(cb.option_list) ||
            cb.option_list.length < 2
          ) {
            const questionKey = String(
              (cardObj as any).vote_title ??
                cardObj.main_title?.title ??
                String(taskId).slice(0, 32),
            ).slice(0, 1024);
            const mapped = [
              { id: `${questionKey}:选项1`.slice(0, 128), text: '选项1' },
              { id: `${questionKey}:选项2`.slice(0, 128), text: '选项2' },
            ];
            cardObj.checkbox = {
              question_key: questionKey,
              option_list: mapped,
              mode: 0,
            };
            cardObj.submit_button = {
              text: '提交',
              key: `${questionKey}:submit`.slice(0, 1024),
            };
            if ('vote_list' in cardObj) delete (cardObj as any).vote_list;
            if ('vote_title' in cardObj) delete (cardObj as any).vote_title;
            this.logger.log(
              `wecom_reply template_card fabricated vote_interaction options taskId=${taskId} (42037 fix)`,
            );
          }
        }
        // Ensure at least one content field exists for empty interactive cards; sub_title_text is optional but helps rendering
        if (
          !cardObj.sub_title_text &&
          !cardObj.quote_area &&
          !cardObj.horizontal_content_list &&
          !cardObj.jump_list &&
          !cardObj.button_list &&
          !cardObj.checkbox &&
          !cardObj.select_list &&
          !cardObj.card_image &&
          !cardObj.image_text_area &&
          !cardObj.vertical_content_list
        ) {
          // For pure text_notice with only main_title, fill sub_title_text from main_title.desc or rawText to avoid empty card rejection
          const fallbackDesc =
            (cardObj.main_title as any)?.desc ??
            rawText?.slice(0, 512) ??
            '详情请查看';
          if (fallbackDesc)
            cardObj.sub_title_text = String(fallbackDesc).slice(0, 512);
        }
        // Log normalized card for debugging (slice to avoid oversized)
        this.logger.log(
          `wecom_reply template_card normalized taskId=${taskId} card_type=${cardObj.card_type} task_id=${cardObj.task_id} card=${JSON.stringify(cardObj).slice(0, 2000)}`,
        );
        resolvedCard = cardObj;
        let internalId: string | null = null;
        try {
          const groupCh = await this.prisma.chatChannel.findFirst({
            where: { taskId, type: CHANNEL_TYPE.task_group },
            select: { id: true },
          });
          if (groupCh) {
            const ext = await (this.prisma as any).message.findFirst({
              where: {
                channelId: groupCh.id,
                senderType: SENDER_TYPE.external,
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });
            if (ext) internalId = ext.id;
          }
        } catch {}
        // Prefer passive reply (carries replyStream context + req_id) for chattype single/group both work via frameHeaders; fallback to active sendMessage
        try {
          if (
            internalId &&
            typeof (adapter as any).replyTemplateCard === 'function'
          ) {
            this.logger.log(
              `wecom_reply trying replyTemplateCard internalId=${internalId} chattype=${chattype ?? 'unknown'} taskId=${taskId}`,
            );
            wecomSent = await (adapter as any).replyTemplateCard(
              internalId,
              cardObj,
            );
            if (!wecomSent)
              this.logger.warn(
                `wecom_reply replyTemplateCard returned false internalId=${internalId} fallback to sendTemplateCard`,
              );
          }
        } catch (e) {
          this.logger.warn(
            `wecom_reply replyTemplateCard threw taskId=${taskId} card=${JSON.stringify(cardObj).slice(0, 800)} err=${(e as Error).message} stack=${(e as Error).stack?.slice(0, 600) ?? ''}`,
          );
        }
        if (
          !wecomSent &&
          typeof (adapter as any).sendTemplateCard === 'function'
        ) {
          try {
            this.logger.log(
              `wecom_reply trying sendTemplateCard channel=${wecomChannelId} chatId hint resolved via adapter taskId=${taskId}`,
            );
            wecomSent = await (adapter as any).sendTemplateCard(
              wecomChannelId,
              cardObj,
            );
          } catch (e) {
            this.logger.warn(
              `wecom_reply sendTemplateCard threw taskId=${taskId} card=${JSON.stringify(cardObj).slice(0, 800)} err=${(e as Error).message}`,
            );
          }
        }
        if (!wecomSent) {
          this.logger.warn(
            `wecom_reply template_card both methods failed taskId=${taskId} card_type=${cardObj.card_type} internalId=${internalId ?? 'null'} channel=${wecomChannelId} card=${JSON.stringify(cardObj).slice(0, 2000)}`,
          );
        }
        mirrorContent = {
          text:
            mirrorText ||
            (cardObj?.main_title?.title ??
              cardObj?.main_title?.desc ??
              '[template_card]'),
          msgtype,
          card: cardObj,
          parts: [],
        };
      } else if (msgtype === 'mpnews') {
        let articles: Array<{
          title: string;
          description?: string;
          url?: string;
          picurl?: string;
          digest?: string;
          content?: string;
          thumb_media_id?: string;
          author?: string;
          content_source_url?: string;
        }> = [];
        const raw = (args.articles as unknown) ?? (args.mpnews as unknown);
        if (Array.isArray(raw)) {
          articles = raw as any;
        } else if (
          raw &&
          typeof raw === 'object' &&
          Array.isArray((raw as any).articles)
        ) {
          articles = (raw as any).articles as any;
        } else if (typeof raw === 'string') {
          try {
            const parsed = JSON.parse((raw as string).trim());
            if (Array.isArray(parsed)) articles = parsed as any;
            else if (parsed && Array.isArray(parsed.articles))
              articles = parsed.articles as any;
          } catch {}
        }
        if (!articles || articles.length === 0) {
          sendError = 'mpnews 需要 articles(≥1 篇) 或 mpnews 参数';
          throw new Error(sendError);
        }
        const sanitizedTaskId = (() => {
          const s = taskId.replace(/[^a-zA-Z0-9_\-@]/g, '_') || 't_default';
          const suffix = `_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          return `${s.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`.slice(
            0,
            64,
          );
        })();
        const normalized = articles.slice(0, 8).map((a) => {
          const title =
            String(a.title ?? '')
              .trim()
              .slice(0, 64) || '标题';
          const descRaw = (
            a.description ??
            (a as any).digest ??
            a.content ??
            ''
          )
            .toString()
            .trim();
          const desc = descRaw ? descRaw.slice(0, 512) : undefined;
          const url =
            (a.url ?? (a as any).content_source_url ?? '').toString().trim() ||
            undefined;
          const picurl = (a.picurl ?? '').toString().trim() || undefined;
          const item: Record<string, unknown> = { title };
          if (desc) item.desc = desc;
          if (url) item.url = url;
          if (picurl) item.picurl = picurl;
          return item;
        });
        const first = normalized[0] as Record<string, unknown>;
        const cardObj: Record<string, unknown> = {
          card_type: 'news_notice',
          main_title: {
            title: String(first.title ?? '图文消息').slice(0, 64),
            desc:
              (first.desc as string | undefined)?.slice(0, 512) ??
              rawText.slice(0, 512) ??
              String(first.title),
          },
          task_id: sanitizedTaskId,
        };
        if (first.picurl) {
          (cardObj as Record<string, unknown>).card_image = {
            url: first.picurl as string,
          };
        }
        if (normalized.length === 1) {
          const imgTxt: Record<string, unknown> = {
            type: 1,
            title: first.title as string,
          };
          if (first.desc) imgTxt.desc = first.desc as string;
          if (first.url) imgTxt.url = first.url as string;
          if (first.picurl) imgTxt.image_url = first.picurl as string;
          (cardObj as Record<string, unknown>).image_text_area = imgTxt;
        } else {
          const list = normalized.map((a) => {
            const r: Record<string, unknown> = {
              title: a.title as unknown as string,
            };
            if (a.desc) r.desc = a.desc as unknown as string;
            if (a.url) r.url = a.url as unknown as string;
            if (a.picurl) r.image_url = a.picurl as unknown as string;
            return r;
          });
          (cardObj as Record<string, unknown>).news_info = { list };
          if (first.picurl)
            (cardObj as Record<string, unknown>).card_image = {
              url: first.picurl as string,
            };
        }
        if (rawText)
          (cardObj as Record<string, unknown>).quote_area = {
            type: 0,
            title: rawText.slice(0, 512),
          };
        // 42045 fix for news_notice: card_action type must be 1 or 2, add source as well
        if (!(cardObj as any).source)
          (cardObj as any).source = { desc: 'vteam', desc_color: 0 };
        if (!(cardObj as any).card_action)
          (cardObj as any).card_action = {
            type: 1,
            url: 'https://work.weixin.qq.com',
          };
        else {
          const ca: any = (cardObj as any).card_action;
          if (ca.type === 1 && !ca.url) ca.url = 'https://work.weixin.qq.com';
          if (ca.type !== 1 && ca.type !== 2) {
            ca.type = 1;
            ca.url = 'https://work.weixin.qq.com';
          }
        }
        this.logger.log(
          `wecom_reply mpnews normalized taskId=${taskId} articles=${normalized.length} hasPic=${normalized.some((a) => !!a.picurl)} card=${JSON.stringify(cardObj).slice(0, 2000)}`,
        );
        resolvedCard = cardObj;
        let internalId: string | null = null;
        try {
          const groupCh = await this.prisma.chatChannel.findFirst({
            where: { taskId, type: CHANNEL_TYPE.task_group },
            select: { id: true },
          });
          if (groupCh) {
            const ext = await (this.prisma as any).message.findFirst({
              where: {
                channelId: groupCh.id,
                senderType: SENDER_TYPE.external,
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });
            if (ext) internalId = ext.id;
          }
        } catch {}
        try {
          if (
            internalId &&
            typeof (adapter as any).replyTemplateCard === 'function'
          ) {
            this.logger.log(
              `wecom_reply mpnews trying replyTemplateCard internalId=${internalId} taskId=${taskId}`,
            );
            wecomSent = await (adapter as any).replyTemplateCard(
              internalId,
              cardObj,
            );
            if (!wecomSent)
              this.logger.warn(
                `wecom_reply mpnews replyTemplateCard returned false internalId=${internalId} fallback to sendTemplateCard`,
              );
          }
        } catch (e) {
          this.logger.warn(
            `wecom_reply mpnews replyTemplateCard threw taskId=${taskId} err=${(e as Error).message}`,
          );
        }
        if (
          !wecomSent &&
          typeof (adapter as any).sendTemplateCard === 'function'
        ) {
          try {
            this.logger.log(
              `wecom_reply mpnews trying sendTemplateCard channel=${wecomChannelId} taskId=${taskId}`,
            );
            wecomSent = await (adapter as any).sendTemplateCard(
              wecomChannelId,
              cardObj,
            );
          } catch (e) {
            this.logger.warn(
              `wecom_reply mpnews sendTemplateCard threw taskId=${taskId} err=${(e as Error).message}`,
            );
          }
        }
        if (!wecomSent) {
          this.logger.warn(
            `wecom_reply mpnews both methods failed taskId=${taskId} internalId=${internalId ?? 'null'} channel=${wecomChannelId}`,
          );
        }
        mirrorContent = {
          text: mirrorText || (first.title as string) || '[mpnews]',
          msgtype: 'mpnews',
          card: cardObj,
          articles: normalized,
          parts: [],
        };
      } else if (msgtype === 'image') {
        let mediaIdToSend: string | null = args.mediaId?.trim() || null;
        const resolvedFilename = (args.filename?.trim() ||
          (args.media
            ? args.media.split(/[\\/]/).pop() || 'image.png'
            : 'image.png')) as string;
        if (!mediaIdToSend) {
          const mediaRef = (args.media ?? '').trim();
          if (!mediaRef) {
            sendError = 'image 需要 media(文件路径) 或 mediaId 参数';
            throw new Error(sendError);
          }
          let buffer: Buffer | null = null;
          // Try artifactId / archive path first, then /uploads direct, then worker fetch
          try {
            if (mediaRef.startsWith('art_')) {
              const artifactId = mediaRef
                .split('@')[0]
                .split('/')[0]
                .split('?')[0];
              const direct = await (
                this.prisma as any
              ).artifactVersion.findFirst({
                where: { artifactId, artifact: { taskId } },
                orderBy: { version: 'desc' },
                select: { contentRef: true },
              });
              if (direct?.contentRef) {
                buffer = await FileStorageService.readUploadedFile(
                  direct.contentRef,
                );
              }
            }
            if (!buffer) {
              const target = FileStorageService.normalizeFileRef(mediaRef);
              const versions = await (
                this.prisma as any
              ).artifactVersion.findMany({
                where: { artifact: { taskId }, filePath: { not: null } },
                orderBy: { createdAt: 'desc' },
                select: { contentRef: true, filePath: true },
              });
              const hit = (
                versions as Array<{
                  contentRef: string;
                  filePath: string | null;
                }>
              ).find(
                (v) =>
                  v.filePath !== null &&
                  FileStorageService.normalizeFileRef(v.filePath) === target,
              );
              if (hit) {
                buffer = await FileStorageService.readUploadedFile(
                  hit.contentRef,
                );
              } else if (mediaRef.startsWith('/uploads/')) {
                buffer = await FileStorageService.readUploadedFile(target);
              }
            }
            if (!buffer) {
              const workerRow = await this.prisma.worker.findUnique({
                where: { id: ctx.workerId },
                select: { capabilities: true },
              });
              if (!workerRow) {
                sendError = '执行该任务的 worker 不存在，无法拉取文件';
                throw new Error(sendError);
              }
              buffer = await this.workerClient.fetchFile(
                {
                  id: ctx.workerId,
                  capabilities: workerRow.capabilities as any,
                },
                mediaRef,
              );
            }
          } catch (e) {
            if (!sendError) sendError = (e as Error).message ?? String(e);
            this.logger.warn(
              `wecom_reply image fetch failed media=${mediaRef} taskId=${taskId} err=${sendError}`,
            );
            throw new Error(sendError);
          }
          if (!buffer) {
            sendError = '图片文件读取失败';
            throw new Error(sendError);
          }
          if (typeof (adapter as any).uploadMediaBuffer !== 'function') {
            sendError = 'WeCom 适配器不支持图片上传';
            throw new Error(sendError);
          }
          mediaIdToSend = await (adapter as any).uploadMediaBuffer(
            buffer,
            'image',
            resolvedFilename,
          );
          if (!mediaIdToSend) {
            sendError = '图片上传失败（uploadMedia 返回空）';
            throw new Error(sendError);
          }
        }
        // Send via passive reply first, fallback to active
        let internalId: string | null = null;
        try {
          const groupCh = await this.prisma.chatChannel.findFirst({
            where: { taskId, type: CHANNEL_TYPE.task_group },
            select: { id: true },
          });
          if (groupCh) {
            const ext = await (this.prisma as any).message.findFirst({
              where: {
                channelId: groupCh.id,
                senderType: SENDER_TYPE.external,
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });
            if (ext) internalId = ext.id;
          }
        } catch {}
        if (internalId && typeof (adapter as any).replyMedia === 'function') {
          wecomSent = await (adapter as any).replyMedia(
            internalId,
            'image',
            mediaIdToSend,
          );
          if (!wecomSent)
            this.logger.warn(
              `wecom_reply replyMedia returned false internalId=${internalId} fallback to sendMediaMessage`,
            );
        }
        if (
          !wecomSent &&
          typeof (adapter as any).sendMediaMessage === 'function'
        ) {
          wecomSent = await (adapter as any).sendMediaMessage(
            wecomChannelId,
            'image',
            mediaIdToSend,
          );
        }
        if (!wecomSent) {
          sendError = '图片发送失败（replyMedia/sendMediaMessage 均失败）';
          this.logger.warn(
            `wecom_reply image both methods failed taskId=${taskId} mediaId=${mediaIdToSend} internalId=${internalId ?? 'null'} channel=${wecomChannelId}`,
          );
          throw new Error(sendError);
        }
        mirrorContent = {
          text: mirrorText || rawText || `[image] ${resolvedFilename}`,
          msgtype: 'image',
          mediaId: mediaIdToSend,
          filename: resolvedFilename,
          parts: [],
        };
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (!sendError) sendError = msg;
      this.logger.warn(
        `wecom_reply send failed taskId=${taskId} msgtype=${msgtype} err=${msg} stack=${(e as Error).stack?.slice(0, 800) ?? ''} card=${JSON.stringify(resolvedCard ?? args.card).slice(0, 1200)}`,
      );
      if (!mirrorContent) {
        mirrorContent = {
          text: mirrorText || rawText || `[${msgtype}]`,
          msgtype,
          card: resolvedCard,
          error: sendError,
          parts: [],
        };
      }
    }
    if (!wecomSent) {
      const detail = sendError ? ` 详情: ${sendError.slice(0, 400)}` : '';
      const cardPreview = resolvedCard
        ? ` card=${JSON.stringify(resolvedCard).slice(0, 600)}`
        : '';
      this.logger.warn(
        `wecom_reply wecom send failed taskId=${taskId} channel=${wecomChannelId} msgtype=${msgtype}${detail}${cardPreview}`,
      );
      if (!mirrorContent) {
        mirrorContent = {
          text: mirrorText || rawText || `[${msgtype}]`,
          msgtype,
          card: resolvedCard,
          error: sendError,
          articles: args.articles,
          parts: [],
        };
      } else if (sendError && !(mirrorContent as any).error) {
        (mirrorContent as any).error = sendError;
      }
    }
    if (!mirrorContent) {
      mirrorContent = { text: mirrorText, msgtype, parts: [] };
    }
    try {
      (adapter as any).consumePendingOperatorForTask?.(taskId);
    } catch {}

    let mirrorMessageId: string | null = null;
    let groupChannelId: string | null = null;
    try {
      const groupCh = await this.prisma.chatChannel.findFirst({
        where: { taskId, type: CHANNEL_TYPE.task_group },
        select: { id: true },
      });
      if (groupCh) {
        groupChannelId = groupCh.id;
        const senderAgentId = await this.resolveSenderAgentId(
          taskId,
          instanceId,
        );
        // Lookup placeholder in task_group to UPDATE instead of CREATE (fix duplicate: placeholder + new mirror -> only one).
        let placeholder: { id: string } | null = null;
        try {
          placeholder = await (this.prisma as any).message.findFirst({
            where: {
              channelId: groupCh.id,
              senderType: { in: [SENDER_TYPE.agent, SENDER_TYPE.system] },
              status: MESSAGE_STATUS.processing,
            },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          });
        } catch {}
        if (!placeholder) {
          try {
            const ext = await (this.prisma as any).message.findFirst({
              where: {
                channelId: groupCh.id,
                senderType: SENDER_TYPE.external,
              },
              orderBy: { createdAt: 'desc' },
              select: { createdAt: true },
            });
            if (ext?.createdAt) {
              placeholder = await (this.prisma as any).message.findFirst({
                where: {
                  channelId: groupCh.id,
                  senderType: { in: [SENDER_TYPE.agent, SENDER_TYPE.system] },
                  createdAt: { gt: ext.createdAt },
                },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
              });
            } else {
              placeholder = await (this.prisma as any).message.findFirst({
                where: {
                  channelId: groupCh.id,
                  senderType: { in: [SENDER_TYPE.agent, SENDER_TYPE.system] },
                },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
              });
            }
          } catch {}
        }
        if (placeholder) {
          const updated = await (this.prisma as any).message.update({
            where: { id: placeholder.id },
            data: {
              content: mirrorContent as any,
              status: MESSAGE_STATUS.sent,
              senderId: senderAgentId,
              senderInstanceId: instanceId,
            },
          });
          mirrorMessageId = updated.id;
          await this.realtime.broadcast(
            EVENT_TYPES.CHAT_MESSAGE_NEW,
            { message: this.toMessageDto(updated as any) },
            { type: 'channel', id: groupCh.id },
          );
          this.logger.log(
            `wecom_reply placeholder updated taskId=${taskId} placeholderId=${placeholder.id} -> mirrorTextLen=${(mirrorContent.text ?? '').length} msgtype=${msgtype}`,
          );
        } else {
          const msg = await (this.prisma as any).message.create({
            data: {
              id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
              channelId: groupCh.id,
              senderType: SENDER_TYPE.agent,
              senderId: senderAgentId,
              senderInstanceId: instanceId,
              content: mirrorContent as any,
              mentions: null,
              status: MESSAGE_STATUS.sent,
            },
          });
          mirrorMessageId = msg.id;
          await this.realtime.broadcast(
            EVENT_TYPES.CHAT_MESSAGE_NEW,
            { message: this.toMessageDto(msg as any) },
            { type: 'channel', id: groupCh.id },
          );
        }
      }
    } catch (e) {
      this.logger.warn(`wecom_reply mirror failed: ${(e as Error).message}`);
    }

    if (wecomSent && mirrorMessageId) {
      return {
        content: [
          {
            type: 'text',
            text: `已回复企微用户${fromName ? ` @${fromName}` : ''} 并同步到任务群聊。重要：回复已完成，请直接结束本轮，不要再输出任何总结或重复回复（不要生成 final answer）。`,
          },
        ],
        isError: false,
        messageId: mirrorMessageId,
        channelId: groupChannelId,
        wecomSent: true,
      };
    } else if (wecomSent) {
      return {
        content: [
          {
            type: 'text',
            text: `已发送到企微${fromName ? ` @${fromName}` : ''}（群聊同步失败）。重要：回复已完成，请直接结束本轮，不要再输出任何总结或重复回复。`,
          },
        ],
        isError: false,
        wecomSent: true,
      };
    }
    const failDetail = sendError ? ` 失败原因: ${sendError.slice(0, 400)}` : '';
    return {
      content: [
        {
          type: 'text',
          text: `已同步到任务群聊（企微发送失败，请检查 WeCom 通道绑定与在线状态）。${failDetail}重要：回复已同步，请直接结束本轮，不要再输出重复回复。`.trim(),
        },
      ],
      isError: false,
      messageId: mirrorMessageId ?? undefined,
      channelId: groupChannelId,
      wecomSent: false,
    };
  }

  /**
   * channel_send：向当前团队绑定的通知渠道发送文本（webhook / wecom_group_robot）。
   * - 入参仅 target(id/name, nc_ 前缀) + text(≤4000)，taskId 从 worker 会话上下文解析（当前任务边界）。
   * - text 越界 → 返回结构化错误文本（不抛断会话）。
   * - outboundDispatcher.sendToChannelByIdOrName 按任务所属团队查询 NotificationChannel (nc_) + TeamNotificationChannel 绑定；
   *   失败返回错误文本 isError:false，避免 abort agent session。
   */
  async channelSend(
    ctx: PlatformMcpContext,
    args: { target: string; text: string },
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const target = args.target?.trim() ?? '';
    const text = args.text ?? '';
    if (!target) {
      return {
        content: [{ type: 'text', text: '发送失败: target 不能为空' }],
        isError: false,
      };
    }
    if (text.length > 4000) {
      return {
        content: [{ type: 'text', text: '发送失败: text 长度超过 4000 字符' }],
        isError: false,
      };
    }
    if (!text) {
      return {
        content: [{ type: 'text', text: '发送失败: text 不能为空' }],
        isError: false,
      };
    }
    if (!this.outboundDispatcher) {
      return {
        content: [{ type: 'text', text: '发送失败: 出站分发器未就绪' }],
        isError: false,
      };
    }
    let taskId: string | null = null;
    try {
      const session = await (this.prisma as any).session.findFirst({
        where: { workerId: ctx.workerId },
        orderBy: { createdAt: 'desc' },
        select: { taskId: true },
      });
      taskId = session?.taskId ?? null;
    } catch {}
    if (!taskId) {
      return {
        content: [{ type: 'text', text: '发送失败: 无法解析当前任务上下文' }],
        isError: false,
      };
    }
    try {
      await this.assertWorkerTask(ctx, taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `发送失败: ${msg}` }],
        isError: false,
      };
    }
    try {
      await this.outboundDispatcher.sendToChannelByIdOrName(
        taskId,
        target,
        text,
      );
      const preview = text.slice(0, 100);
      return {
        content: [{ type: 'text', text: `已发送至渠道 ${target}: ${preview}` }],
        isError: false,
      };
    } catch (err: unknown) {
      let msg: string;
      if (err instanceof Error) {
        msg = err.message;
      } else if (
        err &&
        typeof err === 'object' &&
        'getResponse' in (err as Record<string, unknown>)
      ) {
        try {
          const resp = (
            err as { getResponse(): unknown }
          ).getResponse() as unknown;
          if (
            resp &&
            typeof resp === 'object' &&
            'message' in (resp as Record<string, unknown>)
          ) {
            msg = String((resp as { message: string }).message);
          } else if (typeof resp === 'string') {
            msg = resp;
          } else {
            msg = String(resp);
          }
        } catch {
          msg = String(err);
        }
      } else {
        msg = String(err);
      }
      return {
        content: [{ type: 'text', text: `发送失败: ${msg}` }],
        isError: false,
      };
    }
  }

  /**
   * team_add_member 确认回调执行：确认（answers 首项=「确认」）→ updateTeam + team_add 审计；
   * 拒绝 → 不执行；确认回调时任务已终态（非 pending/in_progress）→ updateTeam 409，显式记录并忽略。
   */
  private async handleTeamAddResolved(args: {
    taskId: string;
    agentId: string;
    alias?: string;
    workDir?: string;
    answers: string[][] | null;
    actor: { type: string; id: string };
  }): Promise<void> {
    const confirmed = args.answers?.[0]?.[0] === '确认';
    if (!confirmed) {
      this.logger.log(
        `[team-add] 增员被拒绝，不执行：task=${args.taskId} agent=${args.agentId}`,
      );
      return;
    }
    try {
      await this.tasksService.updateTeam(
        args.taskId,
        {
          addInstances: [
            {
              agentId: args.agentId,
              ...(args.alias ? { alias: args.alias } : {}),
              ...(args.workDir ? { workDir: args.workDir } : {}),
            },
          ],
        },
        args.actor.type === ACTOR_TYPE.user ? args.actor.id : undefined,
        {
          actorType: args.actor.type,
          actorId: args.actor.id,
          confirmedBy:
            args.actor.type === ACTOR_TYPE.user ? '用户' : '主 Agent',
        },
      );
      this.logger.log(
        `[team-add] 增员确认执行：task=${args.taskId} agent=${args.agentId} 已加入团队（actorType=${args.actor.type}）`,
      );
    } catch (err) {
      if (err instanceof ConflictException) {
        this.logger.warn(
          `[team-add] 确认回调时任务已终态，增员忽略：task=${args.taskId} agent=${args.agentId}（${(err as Error).message}）`,
        );
        return;
      }
      throw err;
    }
  }

  /** submit_artifact doc/file 路径：worker 拉取（read_file 抛错语义）→ 落盘 uploads → 归档。 */
  private async submitFileArtifact(
    ctx: PlatformMcpContext,
    taskId: string,
    title: string,
    fileRef: string,
    category?: string,
  ): Promise<{
    artifactId: string;
    version: number;
    status: 'created' | 'appended' | 'duplicate';
  }> {
    const workerRow = await this.prisma.worker.findUnique({
      where: { id: ctx.workerId },
      select: { capabilities: true },
    });
    if (!workerRow) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.FILE_NOT_FOUND,
        message: '执行该任务的 worker 不存在，无法拉取文件',
      });
    }
    const buffer = await this.workerClient.fetchFile(
      { id: ctx.workerId, capabilities: workerRow.capabilities },
      fileRef,
    );

    if (/\.tsx$/i.test(fileRef)) {
      const issues = validateTsxPrototype(buffer.toString('utf8'));
      if (issues.length > 0) {
        throw new BadRequestException({
          code: PLATFORM_MCP_ERRORS.ARTIFACT_INVALID,
          message: `TSX 原型预检失败（请根据以下提示修复后重新提交）：\n${issues.map((i) => `- ${i}`).join('\n')}`,
        });
      }
    }

    const name = fileRef.split(/[\\/]/).pop() || 'artifact';
    const stored = await FileStorageService.saveBufferFile(buffer, name);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    return this.artifactsService.archiveFile(
      taskId,
      {
        fileRef,
        storedUrl: stored.url,
        storedName: stored.name,
        sha256,
        title,
      },
      category,
    );
  }

  /** submit_artifact text 结果归一：append 返回 → {artifactId, version, status}。 */
  private toSubmitResult(result: { status: string; artifact?: unknown }): {
    artifactId: string;
    version: number;
    status: 'created' | 'appended' | 'duplicate';
  } {
    const artifact = (result.artifact ?? {}) as {
      id?: string;
      currentVersion?: number;
    };
    const version = artifact.currentVersion ?? 1;
    const status =
      result.status === 'duplicate'
        ? ('duplicate' as const)
        : version === 1
          ? ('created' as const)
          : ('appended' as const);
    return { artifactId: artifact.id ?? '', version, status };
  }

  /** 任务归属团队 id（任务维度实例读统一经团队成员表；任务不存在 → 404，无归属 → null）。 */
  private async teamIdOfTask(taskId: string): Promise<string | null> {
    const row = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { teamId: true },
    });
    if (row === null) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    return (row as { teamId?: string | null } | null)?.teamId ?? null;
  }

  /**
   * 归属校验（tools/call 前置，设计文档 §4.2）：该 worker 是否有任务归属团队的团队会话。
   * - 无 Session → 403 `PLATFORM_MCP_FORBIDDEN`；缺 workerId → 403 `PLATFORM_MCP_MISSING_WORKER_ID`。
   * - selfInstanceId（落库类工具必填）：必须是该团队会话绑定的成员（session.teamMemberId，
   *   单成员单会话唯一身份）→ 不一致 403 `PLATFORM_MCP_FORBIDDEN`
   *   （防伪造/跨实例冒充：调用方必须声明自己的成员 id）。
   * - 多成员任务（团队下多成员会话并存）：selfInstanceId 提供时按成员精确匹配 session。
   *   无匹配 → 403 禁止跨任务访问（安全不降级）。
   * 返回成员 id（senderInstanceId 落库用；senderId=agent id 由 resolveSenderAgentId 解析）。
   */
  private async assertWorkerTask(
    ctx: PlatformMcpContext,
    taskId: string,
    selfInstanceId?: string,
  ): Promise<string> {
    // delivery-family 工具 taskId 必填：缺失时给干净 400（非 500），指引模型补任务上下文。
    if (!taskId) {
      throw new BadRequestException('该工具需要任务上下文');
    }
    if (!ctx.workerId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.MISSING_WORKER_ID,
        message: '缺少 x-worker-id header',
      });
    }
    // 防冒充（is_0000000028 修复）：落库类工具（selfInstanceId 必填）须为「该 worker 当前
    // 执行该任务」的实例——dispatcher 在 execute 下发时按实例登记、completed/error/超时注销。
    // 内存活跃集合（activeExecutions）为**增强校验**，但可能因并发/首字超时/空闲判死的
    // 竞态与真实会话状态不一致（间歇性误拒合法成员）。故以 **DB session 为权威**：
    // - 该 worker+task 存在绑定 selfInstanceId 的会话 → 合法，放行（无论内存集合是否命中）；
    // - 内存集合命中 → 直接放行（快路径，免 DB 查询）；
    // - 内存集合未命中且 DB 无绑定会话 → 拒绝（真冒充）。
    // 语义：注册表校验防止「旧会话实例冒充当值执行者」的漏洞，DB 会话绑定兜底防内存陈旧。
    if (selfInstanceId !== undefined) {
      const active = this.workerDispatcher.isAgentExecuting(
        ctx.workerId,
        taskId,
      );
      if (active !== null && active.has(selfInstanceId)) {
        return selfInstanceId;
      }
    }
    const authTeamId = await this.teamIdOfTask(taskId);
    if (!authTeamId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: '该 worker 无此任务会话，禁止跨任务访问',
      });
    }
    const session = await this.prisma.session.findFirst({
      where: {
        teamId: authTeamId,
        workerId: ctx.workerId,
        ...(selfInstanceId !== undefined
          ? { teamMemberId: selfInstanceId }
          : {}),
      },
      select: { id: true, agentId: true, teamMemberId: true },
    });
    if (!session) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message:
          selfInstanceId !== undefined
            ? `selfInstanceId（${selfInstanceId}）不在该 worker 当前执行任务（${taskId}）的活跃成员集合中，且该 worker 无绑定团队会话，禁止冒充`
            : '该 worker 无此任务会话，禁止跨任务访问',
      });
    }
    const instanceId = session.teamMemberId ?? session.agentId;
    if (selfInstanceId !== undefined && instanceId !== selfInstanceId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `selfInstanceId 与执行该任务的实例（${instanceId}）不一致，禁止冒充`,
      });
    }
    return instanceId;
  }

  /**
   * team-free-chat 双上下文解析（5 个 team-free 工具 + task_create 共用）。
   * taskId 优先走任务维度（任务归属团队的团队会话归属）；无 taskId 时 teamId
   * 走团队维度（teamId/teamMemberId 会话归属）；双空 → 干净 400；两个维度之间无回退，
   * 归属不匹配 → 403。
   */
  private async resolveExecContext(
    ctx: PlatformMcpContext,
    args: { taskId?: string; teamId?: string; selfInstanceId?: string },
  ): Promise<ExecContext> {
    if (typeof args.taskId === 'string' && args.taskId.startsWith('tm_')) {
      throw new BadRequestException(
        '团队会话请传 teamId，不要传 taskId（taskId 是任务 ID，t_ 前缀）',
      );
    }
    if (args.taskId) {
      const instanceId = await this.assertWorkerTask(
        ctx,
        args.taskId,
        args.selfInstanceId,
      );
      return { kind: 'task', taskId: args.taskId, callerId: instanceId };
    }
    if (args.teamId) {
      const { memberId } = await this.assertWorkerTeam(
        ctx,
        args.teamId,
        args.selfInstanceId,
      );
      return { kind: 'team', teamId: args.teamId, callerId: memberId };
    }
    throw new BadRequestException('该工具需要任务上下文');
  }

  /**
   * 团队维度归属校验（team-free-chat）：该 worker 是否有该 teamId 的团队会话。
   * 团队模式 selfInstanceId 即团队成员 id（session.teamMemberId）；无会话或成员
   * 不一致 → 403（与 assertWorkerTask 同风格，维度内精确匹配，维度间无回退）。
   */
  private async assertWorkerTeam(
    ctx: PlatformMcpContext,
    teamId: string,
    selfInstanceId?: string,
  ): Promise<{ memberId: string; sessionId: string }> {
    if (!ctx.workerId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.MISSING_WORKER_ID,
        message: '缺少 x-worker-id header',
      });
    }
    const session = await this.prisma.session.findFirst({
      where: {
        teamId,
        workerId: ctx.workerId,
        ...(selfInstanceId !== undefined
          ? { teamMemberId: selfInstanceId }
          : {}),
      },
      select: { id: true, teamMemberId: true },
    });
    if (!session) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message:
          selfInstanceId !== undefined
            ? `selfInstanceId（${selfInstanceId}）不是该团队（${teamId}）的会话成员，禁止冒充`
            : '该 worker 无此团队会话，禁止跨团队访问',
      });
    }
    const memberId = session.teamMemberId;
    if (!memberId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: '该团队会话未绑定团队成员，禁止访问',
      });
    }
    if (selfInstanceId !== undefined && memberId !== selfInstanceId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `selfInstanceId 与该团队会话成员（${memberId}）不一致，禁止冒充`,
      });
    }
    return { memberId, sessionId: session.id };
  }

  /**
   * 落库 senderId（agent id，角色渲染）解析：从团队成员行取模板 agent id。
   * 成员行缺失（回退，instanceId 本身可能是 agent id）→ 原样返回。
   */
  private async resolveSenderAgentId(
    _taskId: string,
    instanceId: string,
  ): Promise<string> {
    const member = await this.prisma.teamMember.findUnique({
      where: { id: instanceId },
      select: { agentId: true },
    });
    return member?.agentId ?? instanceId;
  }

  private async findTaskGroupChannel(
    taskId: string,
  ): Promise<{ id: string } | null> {
    try {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      const teamId = (task as any)?.teamId ?? null;
      if (teamId) {
        const ch = await this.prisma.chatChannel.findFirst({
          where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
          select: { id: true },
        });
        if (ch) return ch;
      }
    } catch {}
    return this.prisma.chatChannel.findFirst({
      where: { taskId, type: CHANNEL_TYPE.task_group },
      select: { id: true },
    });
  }

  /** 团队维度群聊频道（一团队一群 team_group；团队会话无任务锚点，不回退任务维度）。 */
  private async findTeamGroupChannel(
    teamId: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.chatChannel.findFirst({
      where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
      select: { id: true },
    });
  }

  /** 团队维度建群兜底（存在即用，P2002 竞态重查；team_group_key 为生成列，禁止显式写入）。 */
  private async ensureTeamGroupChannelByTeam(
    teamId: string,
  ): Promise<{ id: string }> {
    const found = await this.findTeamGroupChannel(teamId);
    if (found) return found;
    try {
      const created = await this.prisma.chatChannel.create({
        data: {
          id: await this.idGen.nextId('c'),
          type: CHANNEL_TYPE.team_group,
          teamId,
          taskId: null,
        } as any,
        select: { id: true },
      });
      return created;
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') {
        const raced = await this.findTeamGroupChannel(teamId);
        if (raced) return raced;
      }
      throw err;
    }
  }

  /** 团队维度 senderId 解析：从团队成员行取模板 agent id；成员行缺失 → 原样返回。 */
  private async resolveTeamSenderAgentId(
    teamId: string,
    memberId: string,
  ): Promise<string> {
    const m = await this.prisma.teamMember.findFirst({
      where: { id: memberId, teamId },
      select: { agentId: true },
    });
    return m?.agentId ?? memberId;
  }

  /**
   * 团队维度 @ 解析（对齐 parseGroupPostMentions 的实例别名前缀匹配，匹配源为团队成员）。
   * 用户 @ 展开保持任务域（需任务所属项目成员），团队维度仅做实例 @ 落库。
   */
  private async parseTeamPostMentions(
    teamId: string,
    content: string,
  ): Promise<{
    mentions: Array<{
      type: 'agent';
      instanceId: string;
      agentId: string;
      name: string;
    }> | null;
    mentionedInstances: string[];
  }> {
    if (!content || !content.includes('@')) {
      return { mentions: null, mentionedInstances: [] };
    }
    const teamRows = await this.prisma.teamMember.findMany({
      where: { teamId },
      select: {
        id: true,
        agentId: true,
        alias: true,
        agent: { select: { name: true } },
      },
    });
    const mentionedInstances: string[] = [];
    const mentions: Array<{
      type: 'agent';
      instanceId: string;
      agentId: string;
      name: string;
    }> = [];
    for (const row of teamRows) {
      const name = row.alias ?? row.agent.name;
      if (!name) continue;
      const atName = `@${name}`;
      const idx = content.indexOf(atName);
      const hit =
        idx >= 0 &&
        (idx + atName.length >= content.length ||
          /[\s,，。；;:：!！?？]/.test(content[idx + atName.length] ?? ''));
      if (!hit) continue;
      if (!mentionedInstances.includes(row.id)) {
        mentionedInstances.push(row.id);
        mentions.push({
          type: 'agent',
          instanceId: row.id,
          agentId: row.agentId,
          name,
        });
      }
    }
    if (content.includes('@all')) {
      (mentions as unknown as Array<{ type: string }>).push({
        type: 'all',
      } as unknown as {
        type: 'agent';
        instanceId: string;
        agentId: string;
        name: string;
      });
    }
    return {
      mentions: mentions.length > 0 ? mentions : null,
      mentionedInstances,
    };
  }

  private async ensureTeamGroupChannel(
    taskId: string,
  ): Promise<{ id: string }> {
    const found = await this.findTaskGroupChannel(taskId);
    if (found) return found;
    try {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      const teamId: string | null = (task as any)?.teamId ?? null;
      if (teamId) {
        const existing = await this.prisma.chatChannel.findFirst({
          where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
          select: { id: true },
        });
        if (existing) return existing;
        try {
          const created = await this.prisma.chatChannel.create({
            data: {
              id: await this.idGen.nextId('c'),
              type: CHANNEL_TYPE.team_group,
              teamId,
              taskId: null,
            } as any,
            select: { id: true },
          });
          return created;
        } catch (err: any) {
          if (err?.code === 'P2002') {
            const raced = await this.prisma.chatChannel.findFirst({
              where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
              select: { id: true },
            });
            if (raced) return raced;
          }
          throw err;
        }
      }
    } catch {}
    throw new NotFoundException({
      code: PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
      message: '任务群聊频道不存在',
    });
  }

  private normalizeLimit(limit?: number): number {
    const l = Number(limit ?? CHAT_HISTORY_DEFAULT_LIMIT);
    if (!Number.isFinite(l)) return CHAT_HISTORY_DEFAULT_LIMIT;
    return Math.min(Math.max(Math.floor(l), 1), CHAT_HISTORY_MAX_LIMIT);
  }

  /** memory_search limit 归一：缺省 20，收敛 1~50（与 memorySearchSchema 对齐）。 */
  private normalizeMemoryLimit(limit?: number): number {
    const l = Number(limit ?? 20);
    if (!Number.isFinite(l)) return 20;
    return Math.min(Math.max(Math.floor(l), 1), 50);
  }

  /** memory_search tags 内存过滤（Json 列无 prisma contains 支持）：须包含全部查询标签。 */
  private filterMemoryByTags<T extends { tags: Prisma.JsonValue | null }>(
    rows: T[],
    tags?: string[],
  ): T[] {
    if (!tags || tags.length === 0) return rows;
    return rows.filter((row) => {
      const rowTags = Array.isArray(row.tags) ? (row.tags as string[]) : [];
      return tags.every((t) => rowTags.includes(t));
    });
  }

  private toChatHistoryItem(row: {
    id: string;
    senderType: string;
    senderId: string | null;
    senderInstanceId: string | null;
    content: Prisma.JsonValue;
    attachmentUrl: string | null;
    attachmentName: string | null;
    attachmentType: string | null;
    createdAt: Date;
  }): ChatHistoryItem {
    const content = (row.content ?? {}) as { text?: unknown };
    return {
      id: row.id,
      senderType: row.senderType,
      senderId: row.senderId,
      text: typeof content.text === 'string' ? content.text : '',
      attachmentUrl: row.attachmentUrl ?? null,
      attachmentName: row.attachmentName ?? null,
      attachmentType: row.attachmentType ?? null,
      senderInstanceId: row.senderInstanceId ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** ArtifactVersion 工具视图：doc/file（filePath 非空）附 fileUrl/fileName/fileExt（FILE-02）。 */
  private toArtifactVersionDto(v: {
    id: string;
    artifactId: string;
    version: number;
    contentRef: string;
    filePath: string | null;
    sha256: string | null;
    acceptedFlag: boolean;
    authorAgentId: string | null;
    changeNote: string | null;
    createdAt: Date;
  }) {
    const dto = {
      id: v.id,
      artifactId: v.artifactId,
      version: v.version,
      contentRef: v.contentRef,
      filePath: v.filePath,
      sha256: v.sha256,
      acceptedFlag: v.acceptedFlag,
      authorAgentId: v.authorAgentId,
      changeNote: v.changeNote,
      createdAt: v.createdAt.toISOString(),
    };
    if (v.filePath) {
      const fileUrl = FileStorageService.normalizeFileRef(v.contentRef);
      const meta = FileStorageService.describeFileRef(fileUrl);
      return { ...dto, fileUrl, fileName: meta.name, fileExt: meta.ext };
    }
    return dto;
  }

  /** 消息 DTO（对齐 ChatService.toMessageDto）：content/mentions 透传 Json；createdAt ISO8601。 */
  private toMessageDto(row: {
    id: string;
    channelId: string;
    senderType: string;
    senderId: string | null;
    senderInstanceId: string | null;
    content: Prisma.JsonValue;
    mentions: Prisma.JsonValue | null;
    attachmentUrl: string | null;
    attachmentName: string | null;
    attachmentType: string | null;
    status: string;
    createdAt: Date;
  }) {
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

  /**
   * group_post fileRef → 附件三字段（复用 worker-dispatcher 的归档映射逻辑，计划 1.3）：
   * 1. **先查归档表**（行为不变）：查该 taskId 已归档产出物版本（filePath 非空），
   *    contentRef 归一化（normalizeFileRef）与 fileRef 归一化后相等即命中 →
   *    挂 attachmentUrl（归一化 fileUrl）+ 派生 name/ext。
   * 2. **未命中 → FR-41 从 worker 拉取归档**：控制面经 WorkerClient.fetchFile 从 worker
   *    工作区拉取文件内容（MCP group_post 直发时 agent 只传 worker 容器路径，文件内容
   *    从未上送 server）→ 落盘 uploads 生成可访问 URL → 尽力写 artifactVersion 归档 →
   *    挂附件三字段。拉取失败（404/网络/超时/worker 不存在）→ undefined（不带附件
   *    不报错，不阻断 group_post 主流程），记 warn 日志。
   */
  private async resolveAttachment(
    ctx: PlatformMcpContext,
    taskId: string,
    fileRef: string,
  ): Promise<GroupPostAttachment | undefined> {
    const target = FileStorageService.normalizeFileRef(fileRef);
    const versions = await this.prisma.artifactVersion.findMany({
      where: { artifact: { taskId }, filePath: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { contentRef: true },
    });
    const hit = versions.find(
      (v) => FileStorageService.normalizeFileRef(v.contentRef) === target,
    );
    if (hit) {
      const url = FileStorageService.normalizeFileRef(hit.contentRef);
      const meta = FileStorageService.describeFileRef(url);
      return {
        attachmentUrl: url,
        attachmentName: meta.name,
        attachmentType: meta.ext,
      };
    }
    return this.fetchAndArchiveAttachment(ctx, taskId, fileRef);
  }

  /**
   * FR-41：归档未命中 → 从 worker 工作区拉取文件内容 → 落盘 uploads → 归档。
   * 任一环节失败（worker 不存在/fetchFile 抛错/落盘失败）→ undefined + warn 日志，
   * 绝不向上抛（不阻断 group_post 落库主流程）。归档写 DB 失败仅 warn（附件照常挂载）。
   */
  private async fetchAndArchiveAttachment(
    ctx: PlatformMcpContext,
    taskId: string,
    fileRef: string,
  ): Promise<GroupPostAttachment | undefined> {
    if (!ctx.workerId) {
      return undefined;
    }
    try {
      const workerRow = await this.prisma.worker.findUnique({
        where: { id: ctx.workerId },
        select: { capabilities: true },
      });
      if (!workerRow) {
        this.logger.warn(
          `group_post fileRef 拉取：worker ${ctx.workerId} 不存在（不带附件）: ${fileRef}`,
        );
        return undefined;
      }
      const buffer = await this.workerClient.fetchFile(
        { id: ctx.workerId, capabilities: workerRow.capabilities },
        fileRef,
      );
      const name = fileRef.split(/[\\/]/).pop() || 'attachment';
      const stored = await FileStorageService.saveBufferFile(buffer, name);
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      await this.artifactsService
        .archiveFile(taskId, {
          fileRef,
          storedUrl: stored.url,
          storedName: stored.name,
          sha256,
        })
        .catch((err) => {
          this.logger.warn(
            `group_post fileRef 归档写入失败（附件仍挂载）: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      this.logger.log(
        `group_post fileRef 已从 worker 拉取并归档: ${fileRef} -> ${stored.url}`,
      );
      return {
        attachmentUrl: stored.url,
        attachmentName: stored.name,
        attachmentType: stored.ext,
      };
    } catch (err) {
      this.logger.warn(
        `group_post fileRef 从 worker 拉取失败（不带附件）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /** read_file 归档路径：从 uploads 读 contentRef 落盘文件；读失败 → 404 业务错误。 */
  private async readFromArchive(
    contentRef: string,
    fileRef: string,
    maxBytes: number,
  ): Promise<ReadFileResult> {
    let buffer: Buffer;
    try {
      buffer = await FileStorageService.readUploadedFile(contentRef);
    } catch (err) {
      this.logger.warn(
        `read_file 归档读取失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.FILE_NOT_FOUND,
        message: '文件已从归档中移除或不可读',
      });
    }
    return this.toReadFileResult(buffer, fileRef, 'archive', maxBytes);
  }

  /**
   * read_file worker 兜底路径：从调用方 worker（ctx.workerId，MCP header 归属标识）
   * 工作区拉取。worker 不存在 → 404；fetchFile 非 2xx/网络错误抛出的
   * WorkerUnavailableException（503）原样上抛（模型可见错误信息，区别于 group_post
   * 的降级不带附件——read_file 语义是读取失败必须让调用方知道）。
   */
  private async fetchFromWorker(
    ctx: PlatformMcpContext,
    fileRef: string,
    maxBytes: number,
  ): Promise<ReadFileResult> {
    const workerRow = await this.prisma.worker.findUnique({
      where: { id: ctx.workerId },
      select: { capabilities: true },
    });
    if (!workerRow) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.FILE_NOT_FOUND,
        message: '执行该任务的 worker 不存在，无法拉取文件',
      });
    }
    const buffer = await this.workerClient.fetchFile(
      { id: ctx.workerId, capabilities: workerRow.capabilities },
      fileRef,
    );
    return this.toReadFileResult(buffer, fileRef, 'worker', maxBytes);
  }

  /** Buffer → ReadFileResult：maxBytes 截断 + fileName 取 fileRef basename + utf8/base64 解码。 */
  private toReadFileResult(
    buffer: Buffer,
    fileRef: string,
    source: 'archive' | 'worker',
    maxBytes: number,
  ): ReadFileResult {
    const truncated = buffer.length > maxBytes;
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
    return {
      content: this.decodeContent(slice),
      fileName: fileRef.split(/[\\/]/).pop() || fileRef,
      fileRef,
      source,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /** utf8 解码；含非法字节（出现 U+FFFD 替换字符）→ 判为二进制，回退 base64 前缀标记。 */
  private decodeContent(buffer: Buffer): string {
    const decoded = buffer.toString('utf8');
    if (decoded.includes('\uFFFD')) {
      return `base64:${buffer.toString('base64')}`;
    }
    return decoded;
  }

  /** maxBytes 归一：缺省/非法 → 256KB；收敛上限 1MB（与 tools.ts inputSchema 对齐）。 */
  private normalizeMaxBytes(maxBytes?: number): number {
    const mb = Number(maxBytes ?? READ_FILE_DEFAULT_MAX_BYTES);
    if (!Number.isFinite(mb) || mb <= 0) {
      return READ_FILE_DEFAULT_MAX_BYTES;
    }
    return Math.min(Math.floor(mb), READ_FILE_MAX_BYTES);
  }
}
