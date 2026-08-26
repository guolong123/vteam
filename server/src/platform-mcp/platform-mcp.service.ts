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
import { createHash } from 'crypto';
import {
  ACTOR_TYPE,
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { FileStorageService } from '../uploads/uploads.service';
import { WorkerClient } from '../workers/worker.client';
import { IssuesService } from '../issues/issues.service';
import { IssueStatus, IssueTransitionAction } from '../issues/issues.constants';
import { TaskTransitionAction } from '../common/constants/task.constants';
import { TasksService } from '../tasks/tasks.service';
import { QuestionsService } from '../questions/questions.service';
import { AGENT_QUESTION_STATUS } from '../questions/questions.constants';
import { PlansService } from '../plans/plans.service';
import { MEMORY_LEVELS, MemoryLevel } from '../memories/memory.constants';
import {
  PLAN_ERRORS,
  PLAN_STATUS,
  PLAN_TASK_STATUS,
} from '../plans/plan.constants';
import {
  PLATFORM_MCP_ERRORS,
  validateTsxPrototype,
} from './platform-mcp.constants';
import { validatePlanTaskQuality } from './plan-quality.guard';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { ModuleRef } from '@nestjs/core';

/**
 * Plan 主键前缀（与 plans.service.ts 对齐：pl_/pt_ 前缀零填充序号）。
 */
const PLAN_ID_PREFIX = 'pl';
const PLAN_TASK_ID_PREFIX = 'pt';

/** plan_submit 覆盖重提只允许从终态（rejected/completed）进入；活动态重复提交 → 409。 */
const PLAN_ACTIVE_STATUSES = [
  PLAN_STATUS.draft,
  PLAN_STATUS.reviewing,
  PLAN_STATUS.approved,
  PLAN_STATUS.executing,
] as const;

/**
 * 消息主键前缀：与 ChatService/WorkerDispatcher 共享 IdGeneratorService 的 'm' 计数
 * （15 篇 §2.2：m_<零填充序号>，数值序 == 字典序，兼作历史游标）。
 */
const MESSAGE_ID_PREFIX = 'm';

/** MCP 工具调用上下文：workerId 来自请求 header `x-worker-id`（controller 解析后闭包注入）。 */
export interface PlatformMcpContext {
  workerId: string;
}

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

/** read_file 常量：默认读取上限 256KB，上限 1MB（与 tools.ts inputSchema max 对齐）。 */
const READ_FILE_DEFAULT_MAX_BYTES = 256 * 1024;
const READ_FILE_MAX_BYTES = 1024 * 1024;

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
    private readonly plansService: PlansService,
    @Optional()
    @Inject(NotificationDispatcherService)
    private readonly outboundDispatcher: NotificationDispatcherService,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * chat_history：任务群聊历史消息（按需拉取，替代自动注入的群聊历史）。
   * `chatChannel(taskId, task_group)` → `message.findMany({channelId, id>sinceId,
   * orderBy id asc, take limit??50})` → `[{id, senderType, senderId, text, createdAt}]`。
   */
  async chatHistory(
    ctx: PlatformMcpContext,
    args: { taskId: string; sinceId?: string; limit?: number },
  ): Promise<ChatHistoryItem[]> {
    await this.assertWorkerTask(ctx, args.taskId);
    const channel = await this.findTaskGroupChannel(args.taskId);
    if (!channel) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
        message: '任务群聊频道不存在',
      });
    }
    const limit = this.normalizeLimit(args.limit);
    const rows = await this.prisma.message.findMany({
      where: {
        channelId: channel.id,
        ...(args.sinceId ? { id: { gt: args.sinceId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => this.toChatHistoryItem(row));
  }

  /**
   * doclib：任务产出物文档库。
   * - 无 artifactId → 产出物清单 `{artifacts: [{id, type, title, currentVersion, updatedAt}]}`
   * - 有 artifactId → 指定版本全文（缺省 currentVersion）；doc/file（filePath 非空）
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
          currentVersion: true,
          updatedAt: true,
        },
      });
      return {
        artifacts: artifacts.map((a) => ({
          id: a.id,
          type: a.type,
          title: a.title,
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
      currentVersion: artifact.currentVersion,
      updatedAt: artifact.updatedAt.toISOString(),
      version: this.toArtifactVersionDto(version),
    };
  }

  /**
   * task_context：任务概览（title/description/status/mainAgentId/backgroundDocs）
   * + 群聊频道 id + 团队 agentMembers（未 removed 实例列表，实例形状
   * {id: 实例 id, alias, agentId, name, role, main}，main 按 mainAgentInstanceId 判定）。
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
      },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const [channel, agentRows] = await Promise.all([
      this.findTaskGroupChannel(args.taskId),
      this.prisma.taskAgent.findMany({
        where: { taskId: args.taskId, removedAt: null },
        orderBy: { joinedAt: 'asc' },
        select: {
          id: true,
          alias: true,
          seq: true,
          agentId: true,
          agent: { select: { id: true, name: true, role: true } },
        },
      }),
    ]);
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      mainAgentId: task.mainAgentId,
      mainAgentInstanceId: task.mainAgentInstanceId,
      backgroundDocs: task.backgroundDocs ?? [],
      channelId: channel?.id ?? null,
      agentMembers: agentRows.map((r) => ({
        id: r.id,
        alias: r.alias,
        agentId: r.agentId,
        name: r.agent.name,
        role: r.agent.role,
        main: r.id === task.mainAgentInstanceId,
      })),
    };
  }

  /**
   * group_post：向任务群聊发布消息。
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
      taskId: string;
      selfInstanceId: string;
      content: string;
      fileRef?: string;
    },
  ): Promise<{
    messageId: string;
    channelId: string;
    attachment: GroupPostAttachment | null;
  }> {
    const instanceId = await this.assertWorkerTask(
      ctx,
      args.taskId,
      args.selfInstanceId,
    );
    const channel = await this.findTaskGroupChannel(args.taskId);
    if (!channel) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
        message: '任务群聊频道不存在',
      });
    }
    const attachment = args.fileRef
      ? await this.resolveAttachment(ctx, args.taskId, args.fileRef)
      : undefined;
    // is_0000000015 修复：解析 content 中 @<别名/名称> 的定向提及（agent 互 @ 用），
    // 落库 mentions（对齐 notify_agent 形状）并分派到被 @ 实例——修复「群聊 @ 主 Agent
    // 无反应」。未 @ 任何人 → mentions 保持 null、不触发分派（普通群聊发布）。
    const { mentions, mentionedInstances } = await this.parseGroupPostMentions(
      args.taskId,
      args.content,
    );

    const message = await this.prisma.message.create({
      data: {
        id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
        channelId: channel.id,
        senderType: SENDER_TYPE.agent,
        senderId: await this.resolveSenderAgentId(args.taskId, instanceId),
        senderInstanceId: instanceId,
        content: { text: args.content, parts: [] } as Prisma.InputJsonValue,
        mentions: (mentions ?? null) as Prisma.InputJsonValue | null,
        status: MESSAGE_STATUS.sent,
        ...(attachment ?? {}),
      },
    });

    await this.realtime.broadcast(
      EVENT_TYPES.CHAT_MESSAGE_NEW,
      { message: this.toMessageDto(message) },
      { type: 'channel', id: channel.id },
    );

    // is_0000000015：@ 提及 → 定向分派每个被 @ 实例（含主 Agent），失败不阻断发布
    for (const target of mentionedInstances) {
      await this.workerDispatcher
        .dispatchAgentMention({
          taskId: args.taskId,
          channelId: channel.id,
          text: args.content,
          targetInstanceId: target,
        })
        .catch((err: unknown) =>
          this.logger.error(
            `[mcp] group_post 提及分派失败 instance=${target}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

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
    const teamRows = await this.prisma.taskAgent.findMany({
      where: { taskId, removedAt: null },
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
        select: { projectId: true },
      });
      if (task?.projectId) {
        const members = await this.prisma.projectMember.findMany({
          where: { projectId: task.projectId },
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
   * 1. 归属校验（selfInstanceId 与 session.taskAgentId 一致）+ 定位任务群聊频道（对齐 groupPost）。
   * 2. 落库一条 agent 消息（sender=发送者、@目标）→ 广播 chat.message.new（先落库后广播）。
   * 3. 调 WorkerDispatcher.dispatchAgentMention 触发目标实例的 dispatch 全链路
   *    （assignWorker → createSession/bind → execute → 回复经 task.completed 回流群聊）。
   * 目标实例无会话 → dispatchAgentMention 抛错 → 工具调用返回错误（模型可见）。
   */
  async notifyAgent(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      targetInstanceId: string;
      content: string;
    },
  ): Promise<{
    messageId: string;
    channelId: string;
    targetInstanceId: string;
  }> {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);
    const channel = await this.findTaskGroupChannel(args.taskId);
    if (!channel) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
        message: '任务群聊频道不存在',
      });
    }
    // 目标实例行（agentId/alias/name）——@ 目标、消息 sender/mentions 归属依据
    const targetInstance = await this.prisma.taskAgent.findFirst({
      where: {
        id: args.targetInstanceId,
        taskId: args.taskId,
        removedAt: null,
      },
      select: {
        agentId: true,
        alias: true,
        agent: { select: { id: true, name: true } },
      },
    });
    if (!targetInstance) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: `目标实例 ${args.targetInstanceId} 不存在或不在任务团队`,
      });
    }
    const targetAgentId = targetInstance.agentId;
    const targetName =
      targetInstance.alias ?? targetInstance.agent.name ?? targetAgentId;
    const senderAgentId = await this.resolveSenderAgentId(
      args.taskId,
      args.selfInstanceId,
    );
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

    await this.workerDispatcher.dispatchAgentMention({
      taskId: args.taskId,
      channelId: channel.id,
      text,
      targetInstanceId: args.targetInstanceId,
    });

    return {
      messageId: message.id,
      channelId: channel.id,
      targetInstanceId: args.targetInstanceId,
    };
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
    },
  ): Promise<{
    artifactId: string;
    version: number;
    status: 'created' | 'appended' | 'duplicate';
  }> {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);

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
      });
      return this.toSubmitResult(result);
    }

    if (!args.fileRef) {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.ARTIFACT_INVALID,
        message: 'type=doc/file 时 fileRef 必填',
      });
    }
    return this.submitFileArtifact(ctx, args.taskId, args.title, args.fileRef);
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
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);
    if (args.action === 'start') {
      const t = await this.prisma.task.findUnique({
        where: { id: args.taskId },
        select: { executionMode: true },
      });
      if (t?.executionMode === 'plan') {
        throw new ForbiddenException({
          code: PLATFORM_MCP_ERRORS.FORBIDDEN,
          message:
            '计划模式下需由用户在任务管理界面手动启动任务，Agent 不可自动 start；评审通过后请等待用户点击“开始任务”',
        });
      }
    }
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
   * memory_save：写入平台记忆（memory-management Todo 2）。
   * - 三参数归属校验（selfInstanceId 必填防冒充，对齐落库类工具 groupPost/submitArtifact）。
   * - 级别校验（Metis M3/M4）：
   *   - task：taskId=当前任务、projectId 取 task 行冗余存；
   *   - project：projectId 从 task 行反查（**不接收 projectId 入参**，防跨项目写入——
   *     写 project 级 = 写当前任务所属项目的记忆）；
   *   - global：**仅主 Agent 可写**（task.mainAgentInstanceId === selfInstanceId，
   *     否则 403 PLATFORM_MCP_FORBIDDEN，防全局污染）。
   * - 落库 memories（me_ 前缀 IdGenerator 生成；createdBy=selfInstanceId 精确归属；
   *   tags 为 Json 列，无标签传 null）。
   * 返回 {memoryId, level}。
   */
  async memorySave(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      level: MemoryLevel;
      content: string;
      description?: string;
      tags?: string[];
    },
  ): Promise<{ memoryId: string; level: MemoryLevel }> {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);

    const task = await this.prisma.task.findUnique({
      where: { id: args.taskId },
      select: { projectId: true, mainAgentInstanceId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }

    // 级别校验（显式三分支 + 兜底 400，纵深防御）：task 级冗余存 projectId；
    // project 级从 task 反查（不接收入参）；global 级仅主 Agent 可写（防全局污染，Metis M3）。
    // 非法 level 不再落入 global 分支（zod schema 已保证合法，此处防绕过 schema 直调 service）。
    let memoryTaskId: string | null = null;
    let memoryProjectId: string | null = null;
    if (args.level === MEMORY_LEVELS.task) {
      memoryTaskId = args.taskId;
      memoryProjectId = task.projectId;
    } else if (args.level === MEMORY_LEVELS.project) {
      memoryProjectId = task.projectId;
    } else if (args.level === MEMORY_LEVELS.global) {
      if (task.mainAgentInstanceId !== args.selfInstanceId) {
        throw new ForbiddenException({
          code: PLATFORM_MCP_ERRORS.FORBIDDEN,
          message: '仅主 Agent 可写入全局记忆，禁止普通成员写 global 级',
        });
      }
    } else {
      throw new BadRequestException({
        code: PLATFORM_MCP_ERRORS.MEMORY_INVALID,
        message: `非法记忆级别：${String(args.level)}`,
      });
    }

    const description = (
      args.description?.trim() || args.content.slice(0, 120)
    ).slice(0, 255);
    let sourceAgentId: string | null = null;
    let sessionId: string | null = null;
    let sessionTitle: string | null = null;
    let channelId: string | null = null;
    try {
      const ta = await this.prisma.taskAgent.findUnique({
        where: { id: args.selfInstanceId },
        select: { agentId: true, alias: true, taskId: true },
      });
      if (ta) sourceAgentId = ta.agentId;
      const sess = await this.prisma.session.findFirst({
        where: { taskAgentId: args.selfInstanceId },
        select: { id: true },
      });
      if (sess) sessionId = sess.id;
      const taskRow = await this.prisma.task.findUnique({
        where: { id: args.taskId },
        select: { title: true },
      });
      if (taskRow) sessionTitle = taskRow.title;
      const ch = await this.prisma.chatChannel.findFirst({
        where: { taskId: args.taskId, taskAgentId: args.selfInstanceId },
        select: { id: true },
      });
      if (ch) channelId = ch.id;
      if (!sessionTitle && ta?.alias) sessionTitle = ta.alias;
    } catch {}
    const memory = await this.prisma.memory.create({
      data: {
        id: await this.idGen.nextId('me'),
        level: args.level,
        taskId: memoryTaskId,
        projectId: memoryProjectId,
        content: args.content,
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
    return { memoryId: memory.id, level: args.level };
  }

  /**
   * memory_search：检索平台记忆（按需检索，替代自动注入；只读，无 selfInstanceId）。
   * 1. 归属校验（无 selfInstanceId，仅校验 worker 有该任务会话）。
   * 2. 解析 task 行 projectId（任务不存在 → 404）。
   * 3. `memory.findMany({where: {deletedAt: null, OR: [task级(taskId)/project级(projectId)/global]}})`——
   *    **软删过滤必须**（Metis M7）；可选 level 入参收窄到单级。
   * 4. query → content contains（prisma 层过滤）；tags → 取回后内存过滤
   *    （tags 为 Json 列，prisma 无 contains 支持）。
   * 5. limit 截断（默认 20，max 50），createdAt desc 排序。
   * 返回 [{id, level, content, tags, createdBy, createdAt}]。
   */
  async memorySearch(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
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
    await this.assertWorkerTask(ctx, args.taskId);

    const task = await this.prisma.task.findUnique({
      where: { id: args.taskId },
      select: { projectId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }

    // 可见范围：当前任务的 task 级 + 所属项目的 project 级（task 无项目归属则不匹配）
    // + global 级；level 入参收窄到单级。
    const whereOr: Prisma.MemoryWhereInput[] = [];
    if (args.level === undefined || args.level === MEMORY_LEVELS.task) {
      whereOr.push({ level: MEMORY_LEVELS.task, taskId: args.taskId });
    }
    if (args.level === undefined || args.level === MEMORY_LEVELS.project) {
      if (task.projectId) {
        whereOr.push({
          level: MEMORY_LEVELS.project,
          projectId: task.projectId,
        });
      }
    }
    if (args.level === undefined || args.level === MEMORY_LEVELS.global) {
      whereOr.push({ level: MEMORY_LEVELS.global });
    }
    if (whereOr.length === 0) {
      // 如 level=project 但任务无项目归属 → 无可见范围，返回空
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
   * plan_submit：主 Agent 提交执行计划（vteam-team-collaboration Todo 2）。
   * 严格顺序：归属校验 → 主实例校验（对齐 task_transition 语义）→ 未终态查重
   * （活动态 409；rejected/completed 覆盖重提）→ 结构校验（tasks what 非空，
   * zod 已保证）→ assignee 校验（指派实例须在任务团队未移除，对齐 issue_create
   * 指派语义）→ $transaction（plan.upsert + 批量 planTask 重建，seq 递增；
   * 覆盖重提时 reviewerInstanceId=null 防幽灵评审者）→ 群聊系统消息。
   */
  async planSubmit(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      title: string;
      summary?: string;
      scopeIn?: string;
      scopeOut?: string;
      tasks: Array<{
        title: string;
        what: string;
        mustNot?: string;
        references?: string;
        acceptance?: string;
        qa?: string;
        commit?: string;
        assigneeInstanceId?: string;
      }>;
    },
  ): Promise<{
    planId: string;
    status: string;
    taskCount: number;
    qualityWarnings?: string[];
  }> {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);

    const task = await this.prisma.task.findUnique({
      where: { id: args.taskId },
      select: { mainAgentInstanceId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    if (task.mainAgentInstanceId !== args.selfInstanceId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `仅主 Agent（${task.mainAgentInstanceId ?? '未设置'}）可提交执行计划；请知会主 Agent 调用 plan_submit`,
      });
    }

    const existing = await this.prisma.plan.findUnique({
      where: { taskId: args.taskId },
      select: { id: true, status: true, rejectCount: true },
    });
    if (
      existing &&
      (PLAN_ACTIVE_STATUSES as readonly string[]).includes(existing.status)
    ) {
      throw new ConflictException({
        code: PLAN_ERRORS.PLAN_INVALID_STATUS,
        message: `执行计划处于 ${existing.status} 状态（评审中/已批准/实施中），不可重复提交`,
      });
    }
    if (
      existing &&
      (existing as { rejectCount?: number }).rejectCount !== undefined &&
      (existing.rejectCount as number) >= 3
    ) {
      throw new ConflictException({
        code: PLAN_ERRORS.PLAN_REVIEW_ROUNDS_EXCEEDED,
        message: `执行计划已驳回 ${existing.rejectCount} 次，请向用户同步分歧点并请求人工裁决后再提交`,
      });
    }

    const taskCount = args.tasks.length;
    for (const t of args.tasks) {
      if (!t.what || !t.what.trim()) {
        throw new BadRequestException({
          code: PLAN_ERRORS.PLAN_STRUCTURE_INVALID,
          message: '计划子任务 what 不能为空',
        });
      }
    }

    const qualityErrors: string[] = [];
    const qualityWarnings: string[] = [];
    for (const t of args.tasks) {
      const result = validatePlanTaskQuality({
        title: t.title,
        what: t.what,
        references: t.references,
        acceptance: t.acceptance ?? '',
        qa: t.qa ?? '',
      });
      qualityErrors.push(...result.errors);
      qualityWarnings.push(...result.warnings);
    }
    if (qualityErrors.length > 0) {
      throw new BadRequestException({
        code: PLAN_ERRORS.PLAN_STRUCTURE_INVALID,
        message: `计划质量预检未通过（${qualityErrors.length} 项），请修正后重新提交：${qualityErrors.join('；')}`,
      });
    }

    const assigneeIds = args.tasks
      .map((t) => t.assigneeInstanceId)
      .filter((id): id is string => !!id);
    if (assigneeIds.length > 0) {
      const uniqueIds = [...new Set(assigneeIds)];
      const teamRows = await this.prisma.taskAgent.findMany({
        where: { taskId: args.taskId, id: { in: uniqueIds }, removedAt: null },
        select: { id: true },
      });
      const validIds = new Set(teamRows.map((r) => r.id));
      const invalidIds = uniqueIds.filter((id) => !validIds.has(id));
      if (invalidIds.length > 0) {
        throw new BadRequestException({
          code: PLAN_ERRORS.PLAN_STRUCTURE_INVALID,
          message: `指派 Agent 不在任务团队中：${invalidIds.join('、')}`,
        });
      }
    }

    const channel = await this.findTaskGroupChannel(args.taskId);
    const sysText = '主 Agent 提交执行计划，请评审';
    const plan = await this.prisma.$transaction(async (tx) => {
      const upserted = await tx.plan.upsert({
        where: { taskId: args.taskId },
        update: {
          title: args.title,
          summary: args.summary ?? null,
          scopeIn: args.scopeIn ?? null,
          scopeOut: args.scopeOut ?? null,
          status: PLAN_STATUS.reviewing,
          reviewerInstanceId: null,
        },
        create: {
          id: await this.idGen.nextId(PLAN_ID_PREFIX),
          taskId: args.taskId,
          title: args.title,
          summary: args.summary ?? null,
          scopeIn: args.scopeIn ?? null,
          scopeOut: args.scopeOut ?? null,
          status: PLAN_STATUS.reviewing,
          createdBy: args.selfInstanceId,
          reviewerInstanceId: null,
        },
      });
      if (existing) {
        await tx.planTask.deleteMany({ where: { planId: upserted.id } });
      }
      for (let i = 0; i < args.tasks.length; i++) {
        const t = args.tasks[i];
        await tx.planTask.create({
          data: {
            id: await this.idGen.nextId(PLAN_TASK_ID_PREFIX),
            planId: upserted.id,
            seq: i + 1,
            title: t.title,
            content: {
              what: t.what,
              mustNot: t.mustNot ?? null,
              references: t.references ?? null,
              acceptance: t.acceptance ?? null,
              qa: t.qa ?? null,
              commit: t.commit ?? null,
            } as Prisma.InputJsonValue,
            assigneeInstanceId: t.assigneeInstanceId ?? null,
            status: PLAN_TASK_STATUS.pending,
          },
        });
      }
      if (channel) {
        await tx.message.create({
          data: {
            id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
            channelId: channel.id,
            senderType: SENDER_TYPE.system,
            senderId: null,
            content: { text: sysText, parts: [] } as Prisma.InputJsonValue,
            mentions: null,
            status: MESSAGE_STATUS.sent,
          },
        });
      }
      return upserted;
    });

    if (channel) {
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: { text: sysText, channelId: channel.id } },
        { type: 'channel', id: channel.id },
      );
    }
    return {
      planId: plan.id,
      status: plan.status,
      taskCount,
      ...(qualityWarnings.length > 0 ? { qualityWarnings } : {}),
    };
  }

  /**
   * plan_review：评审执行计划（vteam-team-collaboration Todo 2）。
   * 权限（Oracle B1）：主 Agent 或 plan.reviewerInstanceId（可能为 null——
   * null 时仅主实例可调）；仅 reviewing 可评审（否则 400 PLAN_INVALID_STATUS）；
   * approved/rejected（rejected 附 reason 必填，zod refine + 服务层二次校验）；
   * 评审完成后 reviewerInstanceId 置 null（R4 防幽灵评审者）→ 群聊系统消息
   * （驳回文案引导修改重提或切换 direct 模式，Oracle M5）。
   */
  async planReview(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      planId?: string;
      verdict: 'approved' | 'rejected';
      reason?: string;
    },
  ): Promise<{ planId: string; status: string }> {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);

    const task = await this.prisma.task.findUnique({
      where: { id: args.taskId },
      select: { mainAgentInstanceId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }

    const plan = args.planId
      ? await this.prisma.plan.findFirst({
          where: { id: args.planId, taskId: args.taskId },
          select: { id: true, status: true, reviewerInstanceId: true },
        })
      : await this.prisma.plan.findUnique({
          where: { taskId: args.taskId },
          select: { id: true, status: true, reviewerInstanceId: true },
        });
    if (!plan) {
      throw new NotFoundException({
        code: PLAN_ERRORS.PLAN_NOT_FOUND,
        message: '执行计划不存在',
      });
    }

    const isMain = task.mainAgentInstanceId === args.selfInstanceId;
    const isReviewer = plan.reviewerInstanceId === args.selfInstanceId;
    if (!isMain && !isReviewer) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `仅主 Agent 或该计划的评审者可评审执行计划；请知会主 Agent 调用 plan_review`,
      });
    }

    if (plan.status !== PLAN_STATUS.reviewing) {
      throw new BadRequestException({
        code: PLAN_ERRORS.PLAN_INVALID_STATUS,
        message: `执行计划当前状态（${plan.status}）不可评审，仅 reviewing 可评审`,
      });
    }

    if (args.verdict === 'rejected' && !(args.reason ?? '').trim()) {
      throw new BadRequestException({
        code: PLAN_ERRORS.PLAN_STRUCTURE_INVALID,
        message: '评审驳回必须填写 reason',
      });
    }

    const approved = args.verdict === 'approved';
    const sysText = approved
      ? '执行计划已通过评审，请等待用户手动启动任务后再实施'
      : `执行计划被驳回：${args.reason}（可修改后重提或切换 direct 模式）`;
    const channel = await this.findTaskGroupChannel(args.taskId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const p = await tx.plan.update({
        where: { id: plan.id },
        data: approved
          ? { status: PLAN_STATUS.approved, reviewerInstanceId: null }
          : {
              status: PLAN_STATUS.rejected,
              reviewerInstanceId: null,
              rejectCount: { increment: 1 },
            },
      });
      if (channel) {
        await tx.message.create({
          data: {
            id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
            channelId: channel.id,
            senderType: SENDER_TYPE.system,
            senderId: null,
            content: { text: sysText, parts: [] } as Prisma.InputJsonValue,
            mentions: null,
            status: MESSAGE_STATUS.sent,
          },
        });
      }
      return p;
    });

    if (channel) {
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: { text: sysText, channelId: channel.id } },
        { type: 'channel', id: channel.id },
      );
    }
    return { planId: updated.id, status: updated.status };
  }

  /**
   * plan_task_transition：流转计划子任务状态（vteam-team-collaboration Todo 2）。
   * 归属校验 → planTask 属于该任务 + 调用实例为该子任务 assigneeInstanceId 或主
   * 实例（否则 403）→ 更新 status → 若全部子任务均达终态（done/blocked/skipped）
   * 且无 pending/in_progress → 群聊系统消息「执行计划任务已全部完成，可提交验收」。
   */
  async planTaskTransition(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      planTaskId: string;
      status: 'in_progress' | 'done' | 'blocked' | 'skipped';
    },
  ): Promise<{ planTaskId: string; status: string }> {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);

    const task = await this.prisma.task.findUnique({
      where: { id: args.taskId },
      select: { mainAgentInstanceId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }

    const planTask = await this.prisma.planTask.findUnique({
      where: { id: args.planTaskId },
      select: {
        id: true,
        planId: true,
        assigneeInstanceId: true,
        status: true,
        plan: { select: { taskId: true } },
      },
    });
    if (!planTask || planTask.plan.taskId !== args.taskId) {
      throw new NotFoundException({
        code: PLAN_ERRORS.PLAN_NOT_FOUND,
        message: '计划子任务不存在或不属于该任务',
      });
    }

    const isAssignee = planTask.assigneeInstanceId === args.selfInstanceId;
    const isMain = task.mainAgentInstanceId === args.selfInstanceId;
    if (!isAssignee && !isMain) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `仅该子任务的指派实例（${planTask.assigneeInstanceId ?? '未指派'}）或主 Agent 可流转；未指派任务请@主Agent指派或让主Agent调用plan_assign_reviewer/直接操作`,
      });
    }

    const updated = await this.prisma.planTask.update({
      where: { id: args.planTaskId },
      data: { status: args.status },
    });

    const siblings = await this.prisma.planTask.findMany({
      where: { planId: planTask.planId },
      select: { status: true },
    });
    const FINAL_STATES = new Set<string>([
      PLAN_TASK_STATUS.done,
      PLAN_TASK_STATUS.blocked,
      PLAN_TASK_STATUS.skipped,
    ]);
    if (
      siblings.length > 0 &&
      siblings.every((t) => FINAL_STATES.has(t.status))
    ) {
      const channel = await this.findTaskGroupChannel(args.taskId);
      if (channel) {
        const sysText = '执行计划任务已全部完成，可提交验收';
        await this.prisma.message.create({
          data: {
            id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
            channelId: channel.id,
            senderType: SENDER_TYPE.system,
            senderId: null,
            content: { text: sysText, parts: [] } as Prisma.InputJsonValue,
            mentions: null,
            status: MESSAGE_STATUS.sent,
          },
        });
        await this.realtime.broadcast(
          EVENT_TYPES.CHAT_MESSAGE_NEW,
          { message: { text: sysText, channelId: channel.id } },
          { type: 'channel', id: channel.id },
        );
      }
    }

    return { planTaskId: updated.id, status: updated.status };
  }

  /**
   * team_view：任务团队实时视图（只读，vteam-team-collaboration Todo 3）。
   * 与 task_context 的差异增量（Metis MINOR-3）：会话实时状态（sessionStatus/sessionId，
   * 复用 toTaskDto instances 构造逻辑）+ 计划子任务分配概览（planSummary）+ 全量角色视图。
   * 1. 归属校验（无 selfInstanceId，仅校验 worker 有该任务会话——对齐 memorySearch 只读先例）。
   * 2. task 行校验存在（404）。
   * 3. 并行查：task_agents（未 removed，含 agent 关联 + 各自 sessions）与 plan_tasks
   *    （经 plan relation 反查该任务子任务，status 概览）。
   * 4. members：{id, agentId, alias, role, seq, main, sessionStatus, sessionId}；
   *    planSummary：{total, done, pending}——done 为终态子任务数（done/blocked/skipped，
   *    对齐 planTaskTransition 全终态判定），pending 为未完成数（pending/in_progress）。
   */
  async teamView(
    ctx: PlatformMcpContext,
    args: { taskId: string },
  ): Promise<{
    taskId: string;
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
    planSummary: { total: number; done: number; pending: number };
  }> {
    await this.assertWorkerTask(ctx, args.taskId);
    const task = await this.prisma.task.findUnique({
      where: { id: args.taskId },
      select: { id: true, mainAgentInstanceId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const [agentRows, planTaskRows] = await Promise.all([
      this.prisma.taskAgent.findMany({
        where: { taskId: args.taskId, removedAt: null },
        orderBy: { joinedAt: 'asc' },
        select: {
          id: true,
          agentId: true,
          alias: true,
          seq: true,
          agent: { select: { role: true } },
          sessions: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, status: true },
          },
        },
      }),
      this.prisma.planTask.findMany({
        where: { plan: { taskId: args.taskId } },
        select: { status: true },
      }),
    ]);
    const FINAL_PLAN_TASK_STATUSES = new Set<string>([
      PLAN_TASK_STATUS.done,
      PLAN_TASK_STATUS.blocked,
      PLAN_TASK_STATUS.skipped,
    ]);
    const done = planTaskRows.filter((r) =>
      FINAL_PLAN_TASK_STATUSES.has(r.status),
    ).length;
    return {
      taskId: task.id,
      members: agentRows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        alias: r.alias,
        role: r.agent.role,
        seq: r.seq,
        main: r.id === task.mainAgentInstanceId,
        sessionStatus: r.sessions?.[0]?.status ?? null,
        sessionId: r.sessions?.[0]?.id ?? null,
      })),
      planSummary: {
        total: planTaskRows.length,
        done,
        pending: planTaskRows.length - done,
      },
    };
  }

  /**
   * my_profile：自身 Agent 配置视图（只读，vteam-team-collaboration Todo 3）。
   * 增量价值（Oracle m2）：权限/工具效应视角——permissionScope/toolEffects/defaultModelId
   * 不在 task_context/task 详情中出现；prompt 仅返回前 500 字符摘要（promptTruncated 标记），
   * 不暴露完整提示词敏感信息。
   * 1. 归属校验（selfInstanceId 必填，返回活跃实例 id）。
   * 2. taskAgent（未 removed，含 agent 关联）查自身配置；缺失 → 404。
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
    permissionScope: Prisma.JsonValue | null;
    toolEffects: Array<{ toolAction: string; effect: string }>;
    promptSummary: string;
    promptTruncated: boolean;
  }> {
    const instanceId = await this.assertWorkerTask(
      ctx,
      args.taskId,
      args.selfInstanceId,
    );
    const taskAgent = await this.prisma.taskAgent.findFirst({
      where: { id: instanceId, taskId: args.taskId, removedAt: null },
      select: {
        id: true,
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
            permissionScope: true,
            toolEffects: { select: { toolAction: true, effect: true } },
          },
        },
      },
    });
    if (!taskAgent) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: `实例 ${instanceId} 不在任务团队中`,
      });
    }
    const prompt = taskAgent.agent.prompt;
    const truncated = prompt.length > 500;
    return {
      taskId: args.taskId,
      instanceId: taskAgent.id,
      agentId: taskAgent.agent.id,
      name: taskAgent.agent.name,
      role: taskAgent.agent.role,
      alias: taskAgent.alias,
      seq: taskAgent.seq,
      workDir: taskAgent.workDir,
      defaultModelId: taskAgent.agent.defaultModelId,
      permissionScope: taskAgent.agent.permissionScope,
      toolEffects: taskAgent.agent.toolEffects.map((t) => ({
        toolAction: t.toolAction,
        effect: t.effect,
      })),
      promptSummary: truncated ? prompt.slice(0, 500) : prompt,
      promptTruncated: truncated,
    };
  }

  /**
   * plan_get：读取任务执行计划（只读，评审者读计划通道——Metis MAJOR-4 闭环，
   * vteam-team-collaboration Todo 5）。无 selfInstanceId，仅校验 worker 有该任务
   * 会话（对齐 team_view/memorySearch 只读先例）。返回计划头（含 reviewerInstanceId）
   * + 子任务清单全文（content 六要素 + 指派概览），供评审者评审前通读计划。
   */
  async planGet(
    ctx: PlatformMcpContext,
    args: { taskId: string; planId?: string },
  ): Promise<{
    id: string;
    taskId: string;
    title: string;
    summary: string | null;
    scopeIn: string | null;
    scopeOut: string | null;
    status: string;
    createdBy: string;
    reviewerInstanceId: string | null;
    createdAt: string;
    updatedAt: string;
    tasks: Array<{
      id: string;
      seq: number;
      title: string;
      content: Prisma.JsonValue;
      assigneeInstanceId: string | null;
      assigneeAlias: string | null;
      assigneeName: string | null;
      status: string;
    }>;
  }> {
    await this.assertWorkerTask(ctx, args.taskId);
    const task = await this.prisma.task.findUnique({
      where: { id: args.taskId },
      select: { id: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const plan = args.planId
      ? await this.prisma.plan.findFirst({
          where: { id: args.planId, taskId: args.taskId },
        })
      : await this.prisma.plan.findUnique({
          where: { taskId: args.taskId },
        });
    if (!plan) {
      throw new NotFoundException({
        code: PLAN_ERRORS.PLAN_NOT_FOUND,
        message: '执行计划不存在',
      });
    }
    const tasks = await this.prisma.planTask.findMany({
      where: { planId: plan.id },
      orderBy: { seq: 'asc' },
    });
    const ids = [
      ...new Set(
        tasks
          .map((t) => t.assigneeInstanceId)
          .filter((id): id is string => !!id),
      ),
    ];
    let assigneeMap = new Map<string, { alias: string | null; name: string }>();
    if (ids.length > 0) {
      const agents = await this.prisma.taskAgent.findMany({
        where: { id: { in: ids }, taskId: args.taskId },
        select: { id: true, alias: true, agent: { select: { name: true } } },
      });
      assigneeMap = new Map(
        agents.map((a) => [a.id, { alias: a.alias, name: a.agent.name }]),
      );
    }
    return {
      id: plan.id,
      taskId: plan.taskId,
      title: plan.title,
      summary: plan.summary,
      scopeIn: plan.scopeIn,
      scopeOut: plan.scopeOut,
      status: plan.status,
      createdBy: plan.createdBy,
      reviewerInstanceId: plan.reviewerInstanceId,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
      tasks: tasks.map((t) => {
        const overview = assigneeMap.get(t.assigneeInstanceId ?? '');
        return {
          id: t.id,
          seq: t.seq,
          title: t.title,
          content: t.content,
          assigneeInstanceId: t.assigneeInstanceId,
          assigneeAlias: overview?.alias ?? null,
          assigneeName: overview?.name ?? null,
          status: t.status,
        };
      }),
    };
  }

  /**
   * plan_assign_reviewer：指派执行计划评审者（Oracle R3 独立工具，
   * vteam-team-collaboration Todo 5）。归属校验 → 任务存在（404）→ 仅主实例可调
   * （mainAgentInstanceId === selfInstanceId，否则 403）→ 按 taskId 解析当前计划
   * （404 PLAN_NOT_FOUND）→ 复用 PlansService.assignReviewer 落库 reviewerInstanceId
   * + 群聊系统消息「已指派 <alias> 评审执行计划」——评审指派通道。
   */
  async planAssignReviewer(
    ctx: PlatformMcpContext,
    args: {
      taskId: string;
      selfInstanceId: string;
      reviewerInstanceId: string;
    },
  ): Promise<{
    planId: string;
    taskId: string;
    reviewerInstanceId: string;
    reviewerAlias: string;
  }> {
    await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);
    const task = await this.prisma.task.findUnique({
      where: { id: args.taskId },
      select: { mainAgentInstanceId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    if (task.mainAgentInstanceId !== args.selfInstanceId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `仅主 Agent（${task.mainAgentInstanceId ?? '未设置'}）可指派评审者；请知会主 Agent 调用 plan_assign_reviewer`,
      });
    }
    const plan = await this.prisma.plan.findUnique({
      where: { taskId: args.taskId },
      select: { id: true },
    });
    if (!plan) {
      throw new NotFoundException({
        code: PLAN_ERRORS.PLAN_NOT_FOUND,
        message: '执行计划不存在',
      });
    }
    return this.plansService.assignReviewer(plan.id, args.reviewerInstanceId);
  }

  /**
   * team_add_member：主 Agent 申请增员（L2 自治确认门，vteam-team-collaboration Todo 8）。
   * 归属校验 → 仅主实例（mainAgentInstanceId===selfInstanceId，否则 403）→ 幂等
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

    const task = await this.prisma.task.findUnique({
      where: { id: args.taskId },
      select: { mainAgentInstanceId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    if (task.mainAgentInstanceId !== args.selfInstanceId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `仅主 Agent（${task.mainAgentInstanceId ?? '未设置'}）可申请增员；请知会主 Agent 调用 team_add_member`,
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

    const existing = await this.prisma.taskAgent.findFirst({
      where: { taskId: args.taskId, agentId: args.agentId, removedAt: null },
      select: { id: true },
    });
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
   * wecom_reply：回复企业微信用户（仅当消息来自企微时使用）。
   * - 解析当前任务（taskId/selfInstanceId 可选，未传则从 worker 会话自动解析）→ 校验归属
   * - 查找该任务绑定的 wecom_aibot 渠道 → 通过 WecomAibotAdapter 发送到企微（@发送者，群聊时@）
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
      articles?: Array<{ title: string; description?: string; url?: string; picurl?: string }>;
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
    const msgtype = ['text', 'markdown', 'template_card', 'image', 'mpnews'].includes(msgtypeRaw)
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
        content: [{ type: 'text', text: '发送失败: template_card 需要 card 参数' }],
        isError: false,
      };
    }
    if (msgtype === 'image' && !args.media && !args.mediaId) {
      return {
        content: [{ type: 'text', text: '发送失败: image 需要 media(文件路径) 或 mediaId 参数' }],
        isError: false,
      };
    }
    if (msgtype === 'mpnews') {
      const rawArticles = (args.articles as unknown) ?? (args.mpnews as unknown);
      let articles: Array<{ title: string; description?: string; url?: string; picurl?: string }> = [];
      if (Array.isArray(rawArticles)) {
        articles = rawArticles as any;
      } else if (rawArticles && typeof rawArticles === 'object' && Array.isArray((rawArticles as any).articles)) {
        articles = (rawArticles as any).articles as any;
      } else if (typeof rawArticles === 'string') {
        try {
          const parsed = JSON.parse((rawArticles as string).trim());
          if (Array.isArray(parsed)) articles = parsed as any;
          else if (parsed && Array.isArray(parsed.articles)) articles = parsed.articles as any;
        } catch {}
      }
      if (!articles || articles.length === 0) {
        return {
          content: [{ type: 'text', text: '发送失败: mpnews 需要 articles(≥1 篇) 或 mpnews 参数' }],
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
          select: { taskId: true, taskAgentId: true, agentId: true },
        });
        if (sess) {
          if (!taskId) taskId = sess.taskId ?? null;
          if (!selfInstanceId) selfInstanceId = sess.taskAgentId ?? sess.agentId ?? null;
        }
      } catch {}
    }
    if (!taskId) {
      return {
        content: [{ type: 'text', text: '发送失败: 无法解析当前任务上下文（请传 taskId）' }],
        isError: false,
      };
    }
    if (!selfInstanceId) {
      return {
        content: [{ type: 'text', text: '发送失败: 无法解析实例身份（请传 selfInstanceId）' }],
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
      const bindings = await (this.prisma as any).taskMessageChannel.findMany({
        where: { taskId },
        select: { messageChannelId: true },
      });
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
    } catch {}
    if (!wecomChannelId) {
      return {
        content: [{ type: 'text', text: '发送失败: 当前任务未绑定企业微信渠道' }],
        isError: false,
      };
    }

    let adapter: any | undefined;
    try {
      const WecomAibotAdapterRef = (await import('../message-channels/adapters/wecom-aibot.adapter')).WecomAibotAdapter;
      adapter = this.moduleRef?.get(WecomAibotAdapterRef, { strict: false }) as unknown;
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
              (adapter as any).getStream?.(ext.id) ?? (adapter as any).getPendingUser?.(ext.id);
            if (streamInfo) {
              fromName = streamInfo.fromUserName ?? streamInfo.fromUserId ?? null;
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
              where: { channelId: groupCh.id, senderType: SENDER_TYPE.external },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });
            if (ext) {
              try {
                wecomSent = await (adapter as any).finishStream(ext.id, wecomText);
                if (wecomSent) {
                  this.logger.log(`wecom_reply finishStream ok taskId=${taskId} internalMessageId=${ext.id} stream replaced`);
                } else {
                  this.logger.log(`wecom_reply finishStream miss taskId=${taskId} internalMessageId=${ext.id} fallback to sendNewMessage`);
                }
              } catch (e) {
                this.logger.warn(`wecom_reply finishStream error taskId=${taskId}: ${(e as Error).message}`);
              }
            }
          }
        }
        if (!wecomSent && typeof (adapter as any).sendNewMessage === 'function') {
          wecomSent = await (adapter as any).sendNewMessage(wecomChannelId, wecomText);
        }
        if (!wecomSent && typeof (adapter as any).sendFallbackMessage === 'function') {
          wecomSent = await (adapter as any).sendFallbackMessage(wecomChannelId, wecomText);
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
          this.logger.warn(`wecom_reply template_card JSON parse failed taskId=${taskId} err=${(e as Error).message} raw=${String(resolvedCard).slice(0, 800)}`);
          throw new Error(sendError);
        }
        if (cardObj && typeof cardObj === 'object' && !cardObj.card_type && cardObj.template_card && typeof cardObj.template_card === 'object') {
          this.logger.log(`wecom_reply template_card unwrap template_card wrapper taskId=${taskId}`);
          cardObj = cardObj.template_card;
        }
        if (cardObj && typeof cardObj === 'object' && !cardObj.card_type && cardObj.card && typeof cardObj.card === 'object' && cardObj.card.card_type) {
          this.logger.log(`wecom_reply template_card unwrap card wrapper taskId=${taskId}`);
          cardObj = cardObj.card;
        }
        if (!cardObj || typeof cardObj !== 'object') {
          sendError = 'card 必须为 JSON 对象';
          throw new Error(sendError);
        }
        const validCardTypes = ['text_notice', 'button_interaction', 'vote_interaction', 'news_notice', 'multiple_interaction'];
        if (!cardObj.card_type || typeof cardObj.card_type !== 'string') {
          sendError = 'card.card_type 必填（如 text_notice / button_interaction / vote_interaction / news_notice）';
          this.logger.warn(`wecom_reply template_card missing card_type taskId=${taskId} card=${JSON.stringify(cardObj).slice(0, 1200)}`);
          throw new Error(sendError);
        }
        if (!validCardTypes.includes(cardObj.card_type)) {
          this.logger.warn(`wecom_reply template_card unknown card_type=${cardObj.card_type} taskId=${taskId}`);
        }
        // Only card_type + main_title are required; icon_url/pic_url/image_url/card_image etc are all optional (no image required to send card)
        if (!cardObj.main_title || typeof cardObj.main_title !== 'object') {
          // Graceful: if main_title missing but we have rawText fallback, inject minimal main_title; else require it
          if (rawText) {
            cardObj.main_title = { title: rawText.slice(0, 64), desc: rawText.slice(0, 512) };
            this.logger.log(`wecom_reply template_card auto-filled main_title from text taskId=${taskId} card_type=${cardObj.card_type}`);
          } else if (['text_notice', 'news_notice', 'button_interaction', 'vote_interaction', 'multiple_interaction'].includes(cardObj.card_type)) {
            sendError = 'card.main_title 必填（card_type 已提供但 main_title 缺失，image/pic_url 等均为可选）';
            this.logger.warn(`wecom_reply template_card missing main_title taskId=${taskId} card_type=${cardObj.card_type} card=${JSON.stringify(cardObj).slice(0, 800)}`);
            throw new Error(sendError);
          }
        }
        // Auto-fill task_id (WeCom requires unique per vote; same value reused causes 42014 taskid has existed)
        // Generate unique per card send: base_sanitized + _<timestamp>_<random>, keep <64 and [\w\-@] charset
        const genUniqueTaskId = (base: string): string => {
          const sanitized = base.replace(/[^a-zA-Z0-9_\-@]/g, '_') || 't_default';
          const suffix = `_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const maxBase = 64 - suffix.length;
          return `${sanitized.slice(0, Math.max(1, maxBase))}${suffix}`.slice(0, 64);
        };
        if (!cardObj.task_id) {
          cardObj.task_id = genUniqueTaskId(taskId);
        } else {
          // Provided task_id must also be unique per send; sanitize and ensure uniqueness to avoid 42014
          const provided = String(cardObj.task_id).trim();
          const sanitizedProvided = provided.replace(/[^a-zA-Z0-9_\-@]/g, '_').slice(0, 64) || genUniqueTaskId(taskId);
          // If provided equals base sanitized (reused t_0000000014), make it unique
          const baseSanitized = taskId.replace(/[^a-zA-Z0-9_\-@]/g, '_');
          if (sanitizedProvided === baseSanitized || sanitizedProvided === taskId) {
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
              if (cardObj.card_type === 'vote_interaction' && sanitizedProvided.length < 60) {
                cardObj.task_id = `${sanitizedProvided.slice(0, 64 - suffix.length)}${suffix}`.slice(0, 64);
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
        const interactiveTypes = new Set(['button_interaction', 'vote_interaction', 'multiple_interaction']);
        if ('card_style' in cardObj) {
          delete cardObj.card_style;
          this.logger.log(`wecom_reply template_card stripped invalid card_style taskId=${taskId}`);
        }
        if (!cardObj.source || typeof cardObj.source !== 'object') {
          cardObj.source = { desc: 'vteam', desc_color: 0 };
          this.logger.log(`wecom_reply template_card auto-filled source taskId=${taskId} card_type=${cardObj.card_type}`);
        } else {
          const sc: any = cardObj.source;
          if (typeof sc.desc_color !== 'undefined' && ![0, 1, 2, 3].includes(sc.desc_color)) {
            sc.desc_color = 0;
          }
        }
        // Per-type card_action handling
        if (noticeTypes.has(cardObj.card_type)) {
          const ca: any = cardObj.card_action;
          const hasValidType1 = ca && typeof ca === 'object' && ca.type === 1 && typeof ca.url === 'string' && ca.url.trim();
          const hasValidType2 = ca && typeof ca === 'object' && ca.type === 2 && typeof ca.appid === 'string' && ca.appid.trim();
          if (!hasValidType1 && !hasValidType2) {
            // Fix 42045: type 0 or missing is invalid for text_notice/news_notice; must be 1 or 2
            if (ca && typeof ca === 'object' && ca.type === 2 && !ca.appid) {
              // Attempts type 2 but missing appid -> fallback to type 1
            }
            cardObj.card_action = { type: 1, url: PLACEHOLDER_URL };
            this.logger.log(`wecom_reply template_card auto-filled card_action type=1 url=${PLACEHOLDER_URL} for ${cardObj.card_type} taskId=${taskId} (42045 fix)`);
          } else {
            // Valid type exists but ensure required field present
            if (ca.type === 1 && (!ca.url || !String(ca.url).trim())) {
              ca.url = PLACEHOLDER_URL;
              this.logger.log(`wecom_reply template_card patched card_action url placeholder taskId=${taskId}`);
            }
          }
        } else if (interactiveTypes.has(cardObj.card_type)) {
          // For interactive, card_action optional; remove invalid ones instead of adding type 0
          if (cardObj.card_action && typeof cardObj.card_action === 'object') {
            const ca: any = cardObj.card_action;
            if (![0, 1, 2].includes(ca.type)) {
              delete cardObj.card_action;
              this.logger.log(`wecom_reply template_card stripped invalid card_action type=${ca.type} for interactive ${cardObj.card_type} taskId=${taskId}`);
            } else if (ca.type === 1 && (!ca.url || !String(ca.url).trim())) {
              // Instead of downgrading to type 0, auto-fill url to avoid 42028-like handling? For card_action fallback to delete
              // Prefer delete to avoid accidental 42045; but type 1 without url would be invalid anywhere, so patch
              ca.url = PLACEHOLDER_URL;
              this.logger.log(`wecom_reply template_card patched interactive card_action url placeholder taskId=${taskId}`);
            } else if (ca.type === 2 && (!ca.appid || !String(ca.appid).trim())) {
              delete cardObj.card_action;
              this.logger.log(`wecom_reply template_card stripped invalid card_action appid missing for interactive ${cardObj.card_type} taskId=${taskId}`);
            }
          }
          // Do NOT auto-add card_action if missing — working button_interaction cards have none
        } else {
          // Unknown type: keep generic fallback but ensure not 42045; prefer delete invalid
          if (!cardObj.card_action || typeof cardObj.card_action !== 'object' || typeof (cardObj.card_action as any).type === 'undefined') {
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
            if (typeof btn.style !== 'undefined' && ![1, 2, 3, 4].includes(btn.style)) {
              btn.style = 1;
              patched++;
            }
            // Fix 42028: type 1 requires url
            if (btn.type === 1 && (!btn.url || !String(btn.url).trim())) {
              btn.url = PLACEHOLDER_URL;
              patched++;
              this.logger.log(`wecom_reply template_card patched button_list[${i}] missing url -> placeholder taskId=${taskId}`);
            }
            // If type is present but not 0/1/2, normalize to absent (key-based button)
            if (typeof btn.type !== 'undefined' && ![0, 1, 2].includes(btn.type)) {
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
          if (patched) this.logger.log(`wecom_reply template_card patched ${patched} button_list items taskId=${taskId} card_type=${cardObj.card_type}`);
        }
        // jump_list and horizontal_content_list similar per-item url fixes (type 1 needs url, type 2 needs appid)
        for (const listKey of ['jump_list', 'horizontal_content_list'] as const) {
          if (Array.isArray((cardObj as any)[listKey])) {
            for (const item of (cardObj as any)[listKey] as any[]) {
              if (!item || typeof item !== 'object') continue;
              if (item.type === 1 && (!item.url || !String(item.url).trim())) {
                item.url = PLACEHOLDER_URL;
                this.logger.log(`wecom_reply template_card patched ${listKey} type1 missing url -> placeholder taskId=${taskId}`);
              }
              if (item.type === 2 && (!item.appid || !String(item.appid).trim())) {
                // fallback to url jump
                item.type = 1;
                item.url = PLACEHOLDER_URL;
                delete item.appid;
                this.logger.log(`wecom_reply template_card patched ${listKey} type2 missing appid -> fallback type1 taskId=${taskId}`);
              }
            }
          }
        }
        // quote_area type 1 needs url
        if (cardObj.quote_area && typeof cardObj.quote_area === 'object') {
          const qa: any = cardObj.quote_area;
          if (qa.type === 1 && (!qa.url || !String(qa.url).trim())) {
            qa.url = PLACEHOLDER_URL;
            this.logger.log(`wecom_reply template_card patched quote_area missing url taskId=${taskId}`);
          }
          if (qa.type === 2 && (!qa.appid || !String(qa.appid).trim())) {
            qa.type = 0;
            delete qa.appid;
            this.logger.log(`wecom_reply template_card patched quote_area type2 missing appid -> type0 taskId=${taskId}`);
          }
        }
        if (cardObj.card_type === 'news_notice') {
          const ci: any = cardObj.card_image;
          if (!ci || typeof ci !== 'object' || !ci.url || !String(ci.url).trim()) {
            cardObj.card_image = { url: PLACEHOLDER_URL };
            this.logger.log(`wecom_reply template_card auto-filled card_image placeholder for news_notice taskId=${taskId} (42044 fix)`);
          } else if (typeof ci.url === 'string' && !/^https?:\/\//.test(ci.url.trim())) {
            ci.url = PLACEHOLDER_URL;
            this.logger.log(`wecom_reply template_card patched card_image url placeholder for news_notice taskId=${taskId}`);
          }
          if (!cardObj.image_text_area || typeof cardObj.image_text_area !== 'object') {
            const t = (cardObj.main_title as any)?.title ?? rawText?.slice(0, 64) ?? '图文消息';
            const d = (cardObj.main_title as any)?.desc ?? rawText?.slice(0, 512) ?? '';
            cardObj.image_text_area = { type: 1, title: String(t).slice(0, 64), desc: String(d).slice(0, 512), url: PLACEHOLDER_URL, image_url: PLACEHOLDER_URL };
            this.logger.log(`wecom_reply template_card auto-filled image_text_area for news_notice taskId=${taskId}`);
          }
        }
        if (cardObj.card_type === 'vote_interaction') {
          const cb: any = cardObj.checkbox;
          let optionList: any[] | null = null;
          if (cb && typeof cb === 'object' && Array.isArray(cb.option_list) && cb.option_list.length > 0) {
            optionList = cb.option_list;
          }
          if (!optionList || optionList.length === 0) {
            const rawList: any =
              (cardObj as any).vote_list ?? (cardObj as any).option_list ?? (cardObj as any).options ?? (cardObj as any).select_list?.option_list ?? (cardObj as any).select_list;
            if (Array.isArray(rawList) && rawList.length > 0) optionList = rawList;
            else if (rawList && typeof rawList === 'object' && Array.isArray((rawList as any).option_list)) optionList = (rawList as any).option_list;
          }
          if (optionList && optionList.length > 0) {
            const seen = new Set<string>();
            const questionKeyRaw = cb?.question_key ?? (cardObj as any).vote_title ?? (cardObj as any).question_key ?? cardObj.main_title?.title ?? String(taskId).slice(0, 32);
            const questionKey = String(questionKeyRaw).slice(0, 1024) || String(taskId).slice(0, 1024);
            const titleRaw = (cardObj as any).vote_title ?? cb?.title ?? cardObj.main_title?.title ?? '';
            const mapped = optionList.slice(0, 20).map((o: any, idx: number) => {
              if (typeof o === 'string') {
                const text = o.trim().slice(0, 17) || `选项${idx + 1}`;
                let id = `${questionKey}:${text}`.slice(0, 128);
                if (seen.has(id)) id = `${id}_${idx}`.slice(0, 128);
                seen.add(id);
                return { id, text };
              }
              const textRaw = o.text ?? o.label ?? o.title ?? o.name ?? String(o.id ?? '');
              const text = String(textRaw).trim().slice(0, 17) || `选项${idx + 1}`;
              let id = String(o.id ?? o.key ?? `${questionKey}:${text}`).slice(0, 128) || `${questionKey}:${text}`.slice(0, 128);
              if (seen.has(id)) id = `${id}_${idx}`.slice(0, 128);
              seen.add(id);
              const item: any = { id, text };
              if (typeof o.is_checked === 'boolean') item.is_checked = o.is_checked;
              return item;
            });
            while (mapped.length < 2) {
              const idx = mapped.length;
              const text = `选项${idx + 1}`;
              const id = `${questionKey}:${text}_${idx}`.slice(0, 128);
              if (!seen.has(id)) { seen.add(id); mapped.push({ id, text }); }
              else mapped.push({ id: `${id}x`, text });
            }
            cardObj.checkbox = { question_key: questionKey, title: String(titleRaw).slice(0, 64) || undefined, option_list: mapped, mode: typeof cb?.mode === 'number' ? cb.mode : 0, disable: typeof cb?.disable === 'boolean' ? cb.disable : false };
            if (!cardObj.checkbox.title) delete cardObj.checkbox.title;
            if (typeof cardObj.checkbox.disable === 'undefined' || cardObj.checkbox.disable === false) delete cardObj.checkbox.disable;
            if ('vote_list' in cardObj) delete (cardObj as any).vote_list;
            if ('vote_title' in cardObj) delete (cardObj as any).vote_title;
            if ('select_list' in cardObj && (cardObj as any).select_list?.option_list) delete (cardObj as any).select_list;
            if (!cardObj.submit_button || typeof cardObj.submit_button !== 'object') {
              cardObj.submit_button = { text: '提交', key: `${questionKey}:submit`.slice(0, 1024) };
            } else {
              if (!(cardObj.submit_button as any).key) (cardObj.submit_button as any).key = `${questionKey}:submit`.slice(0, 1024);
              if (!(cardObj.submit_button as any).text) (cardObj.submit_button as any).text = '提交';
            }
            this.logger.log(`wecom_reply template_card normalized vote_interaction taskId=${taskId} question_key=${questionKey} options=${mapped.length} (42037 fix)`);
          } else if (!cb || !Array.isArray(cb.option_list) || cb.option_list.length < 2) {
            const questionKey = String((cardObj as any).vote_title ?? cardObj.main_title?.title ?? String(taskId).slice(0, 32)).slice(0, 1024);
            const mapped = [{ id: `${questionKey}:选项1`.slice(0, 128), text: '选项1' }, { id: `${questionKey}:选项2`.slice(0, 128), text: '选项2' }];
            cardObj.checkbox = { question_key: questionKey, option_list: mapped, mode: 0 };
            cardObj.submit_button = { text: '提交', key: `${questionKey}:submit`.slice(0, 1024) };
            if ('vote_list' in cardObj) delete (cardObj as any).vote_list;
            if ('vote_title' in cardObj) delete (cardObj as any).vote_title;
            this.logger.log(`wecom_reply template_card fabricated vote_interaction options taskId=${taskId} (42037 fix)`);
          }
        }
        // Ensure at least one content field exists for empty interactive cards; sub_title_text is optional but helps rendering
        if (!cardObj.sub_title_text && !cardObj.quote_area && !cardObj.horizontal_content_list && !cardObj.jump_list && !cardObj.button_list && !cardObj.checkbox && !cardObj.select_list && !cardObj.card_image && !cardObj.image_text_area && !cardObj.vertical_content_list) {
          // For pure text_notice with only main_title, fill sub_title_text from main_title.desc or rawText to avoid empty card rejection
          const fallbackDesc = (cardObj.main_title as any)?.desc ?? rawText?.slice(0, 512) ?? '详情请查看';
          if (fallbackDesc) cardObj.sub_title_text = String(fallbackDesc).slice(0, 512);
        }
        // Log normalized card for debugging (slice to avoid oversized)
        this.logger.log(`wecom_reply template_card normalized taskId=${taskId} card_type=${cardObj.card_type} task_id=${cardObj.task_id} card=${JSON.stringify(cardObj).slice(0, 2000)}`);
        resolvedCard = cardObj;
        let internalId: string | null = null;
        try {
          const groupCh = await this.prisma.chatChannel.findFirst({ where: { taskId, type: CHANNEL_TYPE.task_group }, select: { id: true } });
          if (groupCh) {
            const ext = await (this.prisma as any).message.findFirst({ where: { channelId: groupCh.id, senderType: SENDER_TYPE.external }, orderBy: { createdAt: 'desc' }, select: { id: true } });
            if (ext) internalId = ext.id;
          }
        } catch {}
        // Prefer passive reply (carries replyStream context + req_id) for chattype single/group both work via frameHeaders; fallback to active sendMessage
        try {
          if (internalId && typeof (adapter as any).replyTemplateCard === 'function') {
            this.logger.log(`wecom_reply trying replyTemplateCard internalId=${internalId} chattype=${chattype ?? 'unknown'} taskId=${taskId}`);
            wecomSent = await (adapter as any).replyTemplateCard(internalId, cardObj);
            if (!wecomSent) this.logger.warn(`wecom_reply replyTemplateCard returned false internalId=${internalId} fallback to sendTemplateCard`);
          }
        } catch (e) {
          this.logger.warn(`wecom_reply replyTemplateCard threw taskId=${taskId} card=${JSON.stringify(cardObj).slice(0, 800)} err=${(e as Error).message} stack=${(e as Error).stack?.slice(0, 600) ?? ''}`);
        }
        if (!wecomSent && typeof (adapter as any).sendTemplateCard === 'function') {
          try {
            this.logger.log(`wecom_reply trying sendTemplateCard channel=${wecomChannelId} chatId hint resolved via adapter taskId=${taskId}`);
            wecomSent = await (adapter as any).sendTemplateCard(wecomChannelId, cardObj);
          } catch (e) {
            this.logger.warn(`wecom_reply sendTemplateCard threw taskId=${taskId} card=${JSON.stringify(cardObj).slice(0, 800)} err=${(e as Error).message}`);
          }
        }
        if (!wecomSent) {
          this.logger.warn(`wecom_reply template_card both methods failed taskId=${taskId} card_type=${cardObj.card_type} internalId=${internalId ?? 'null'} channel=${wecomChannelId} card=${JSON.stringify(cardObj).slice(0, 2000)}`);
        }
        mirrorContent = { text: mirrorText || (cardObj?.main_title?.title ?? cardObj?.main_title?.desc ?? '[template_card]'), msgtype, card: cardObj, parts: [] };
      } else if (msgtype === 'mpnews') {
        let articles: Array<{ title: string; description?: string; url?: string; picurl?: string; digest?: string; content?: string; thumb_media_id?: string; author?: string; content_source_url?: string }> = [];
        const raw = (args.articles as unknown) ?? (args.mpnews as unknown);
        if (Array.isArray(raw)) {
          articles = raw as any;
        } else if (raw && typeof raw === 'object' && Array.isArray((raw as any).articles)) {
          articles = (raw as any).articles as any;
        } else if (typeof raw === 'string') {
          try {
            const parsed = JSON.parse((raw as string).trim());
            if (Array.isArray(parsed)) articles = parsed as any;
            else if (parsed && Array.isArray(parsed.articles)) articles = parsed.articles as any;
          } catch {}
        }
        if (!articles || articles.length === 0) {
          sendError = 'mpnews 需要 articles(≥1 篇) 或 mpnews 参数';
          throw new Error(sendError);
        }
        const sanitizedTaskId = (() => {
          const s = taskId.replace(/[^a-zA-Z0-9_\-@]/g, '_') || 't_default';
          const suffix = `_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          return `${s.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`.slice(0, 64);
        })();
        const normalized = articles.slice(0, 8).map((a) => {
          const title = String(a.title ?? '').trim().slice(0, 64) || '标题';
          const descRaw = (a.description ?? (a as any).digest ?? a.content ?? '').toString().trim();
          const desc = descRaw ? descRaw.slice(0, 512) : undefined;
          const url = (a.url ?? (a as any).content_source_url ?? '').toString().trim() || undefined;
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
          main_title: { title: String(first.title ?? '图文消息').slice(0, 64), desc: (first.desc as string | undefined)?.slice(0, 512) ?? rawText.slice(0, 512) ?? String(first.title) },
          task_id: sanitizedTaskId,
        };
        if (first.picurl) {
          (cardObj as Record<string, unknown>).card_image = { url: first.picurl as string };
        }
        if (normalized.length === 1) {
          const imgTxt: Record<string, unknown> = { type: 1, title: first.title as string };
          if (first.desc) imgTxt.desc = first.desc as string;
          if (first.url) imgTxt.url = first.url as string;
          if (first.picurl) imgTxt.image_url = first.picurl as string;
          (cardObj as Record<string, unknown>).image_text_area = imgTxt;
        } else {
          const list = normalized.map((a) => {
            const r: Record<string, unknown> = { title: a.title as unknown as string };
            if (a.desc) r.desc = a.desc as unknown as string;
            if (a.url) r.url = a.url as unknown as string;
            if (a.picurl) r.image_url = a.picurl as unknown as string;
            return r;
          });
          (cardObj as Record<string, unknown>).news_info = { list };
          if (first.picurl) (cardObj as Record<string, unknown>).card_image = { url: first.picurl as string };
        }
        if (rawText) (cardObj as Record<string, unknown>).quote_area = { type: 0, title: rawText.slice(0, 512) };
        // 42045 fix for news_notice: card_action type must be 1 or 2, add source as well
        if (!(cardObj as any).source) (cardObj as any).source = { desc: 'vteam', desc_color: 0 };
        if (!(cardObj as any).card_action) (cardObj as any).card_action = { type: 1, url: 'https://work.weixin.qq.com' };
        else {
          const ca: any = (cardObj as any).card_action;
          if (ca.type === 1 && !ca.url) ca.url = 'https://work.weixin.qq.com';
          if (ca.type !== 1 && ca.type !== 2) { ca.type = 1; ca.url = 'https://work.weixin.qq.com'; }
        }
        this.logger.log(`wecom_reply mpnews normalized taskId=${taskId} articles=${normalized.length} hasPic=${normalized.some((a) => !!a.picurl)} card=${JSON.stringify(cardObj).slice(0, 2000)}`);
        resolvedCard = cardObj;
        let internalId: string | null = null;
        try {
          const groupCh = await this.prisma.chatChannel.findFirst({ where: { taskId, type: CHANNEL_TYPE.task_group }, select: { id: true } });
          if (groupCh) {
            const ext = await (this.prisma as any).message.findFirst({ where: { channelId: groupCh.id, senderType: SENDER_TYPE.external }, orderBy: { createdAt: 'desc' }, select: { id: true } });
            if (ext) internalId = ext.id;
          }
        } catch {}
        try {
          if (internalId && typeof (adapter as any).replyTemplateCard === 'function') {
            this.logger.log(`wecom_reply mpnews trying replyTemplateCard internalId=${internalId} taskId=${taskId}`);
            wecomSent = await (adapter as any).replyTemplateCard(internalId, cardObj);
            if (!wecomSent) this.logger.warn(`wecom_reply mpnews replyTemplateCard returned false internalId=${internalId} fallback to sendTemplateCard`);
          }
        } catch (e) {
          this.logger.warn(`wecom_reply mpnews replyTemplateCard threw taskId=${taskId} err=${(e as Error).message}`);
        }
        if (!wecomSent && typeof (adapter as any).sendTemplateCard === 'function') {
          try {
            this.logger.log(`wecom_reply mpnews trying sendTemplateCard channel=${wecomChannelId} taskId=${taskId}`);
            wecomSent = await (adapter as any).sendTemplateCard(wecomChannelId, cardObj);
          } catch (e) {
            this.logger.warn(`wecom_reply mpnews sendTemplateCard threw taskId=${taskId} err=${(e as Error).message}`);
          }
        }
        if (!wecomSent) {
          this.logger.warn(`wecom_reply mpnews both methods failed taskId=${taskId} internalId=${internalId ?? 'null'} channel=${wecomChannelId}`);
        }
        mirrorContent = { text: mirrorText || (first.title as string) || '[mpnews]', msgtype: 'mpnews', card: cardObj, articles: normalized, parts: [] };
      } else if (msgtype === 'image') {
        let mediaIdToSend: string | null = args.mediaId?.trim() || null;
        let resolvedFilename = (args.filename?.trim() || (args.media ? args.media.split(/[\\/]/).pop() || 'image.png' : 'image.png')) as string;
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
              const artifactId = mediaRef.split('@')[0].split('/')[0].split('?')[0];
              const direct = await (this.prisma as any).artifactVersion.findFirst({
                where: { artifactId, artifact: { taskId } },
                orderBy: { version: 'desc' },
                select: { contentRef: true },
              });
              if (direct?.contentRef) {
                buffer = await FileStorageService.readUploadedFile(direct.contentRef);
              }
            }
            if (!buffer) {
              const target = FileStorageService.normalizeFileRef(mediaRef);
              const versions = await (this.prisma as any).artifactVersion.findMany({
                where: { artifact: { taskId }, filePath: { not: null } },
                orderBy: { createdAt: 'desc' },
                select: { contentRef: true, filePath: true },
              });
              const hit = (versions as Array<{ contentRef: string; filePath: string | null }>).find(
                (v) => v.filePath !== null && FileStorageService.normalizeFileRef(v.filePath) === target,
              );
              if (hit) {
                buffer = await FileStorageService.readUploadedFile(hit.contentRef);
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
                { id: ctx.workerId, capabilities: workerRow.capabilities as any },
                mediaRef,
              );
            }
          } catch (e) {
            if (!sendError) sendError = (e as Error).message ?? String(e);
            this.logger.warn(`wecom_reply image fetch failed media=${mediaRef} taskId=${taskId} err=${sendError}`);
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
          mediaIdToSend = await (adapter as any).uploadMediaBuffer(buffer, 'image', resolvedFilename);
          if (!mediaIdToSend) {
            sendError = '图片上传失败（uploadMedia 返回空）';
            throw new Error(sendError);
          }
        }
        // Send via passive reply first, fallback to active
        let internalId: string | null = null;
        try {
          const groupCh = await this.prisma.chatChannel.findFirst({ where: { taskId, type: CHANNEL_TYPE.task_group }, select: { id: true } });
          if (groupCh) {
            const ext = await (this.prisma as any).message.findFirst({ where: { channelId: groupCh.id, senderType: SENDER_TYPE.external }, orderBy: { createdAt: 'desc' }, select: { id: true } });
            if (ext) internalId = ext.id;
          }
        } catch {}
        if (internalId && typeof (adapter as any).replyMedia === 'function') {
          wecomSent = await (adapter as any).replyMedia(internalId, 'image', mediaIdToSend);
          if (!wecomSent) this.logger.warn(`wecom_reply replyMedia returned false internalId=${internalId} fallback to sendMediaMessage`);
        }
        if (!wecomSent && typeof (adapter as any).sendMediaMessage === 'function') {
          wecomSent = await (adapter as any).sendMediaMessage(wecomChannelId, 'image', mediaIdToSend);
        }
        if (!wecomSent) {
          sendError = '图片发送失败（replyMedia/sendMediaMessage 均失败）';
          this.logger.warn(`wecom_reply image both methods failed taskId=${taskId} mediaId=${mediaIdToSend} internalId=${internalId ?? 'null'} channel=${wecomChannelId}`);
          throw new Error(sendError);
        }
        mirrorContent = { text: mirrorText || rawText || `[image] ${resolvedFilename}`, msgtype: 'image', mediaId: mediaIdToSend, filename: resolvedFilename, parts: [] };
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (!sendError) sendError = msg;
      this.logger.warn(`wecom_reply send failed taskId=${taskId} msgtype=${msgtype} err=${msg} stack=${(e as Error).stack?.slice(0, 800) ?? ''} card=${JSON.stringify(resolvedCard ?? args.card).slice(0, 1200)}`);
      if (!mirrorContent) {
        mirrorContent = { text: mirrorText || rawText || `[${msgtype}]`, msgtype, card: resolvedCard, error: sendError, parts: [] };
      }
    }
    if (!wecomSent) {
      const detail = sendError ? ` 详情: ${sendError.slice(0, 400)}` : '';
      const cardPreview = resolvedCard ? ` card=${JSON.stringify(resolvedCard).slice(0, 600)}` : '';
      this.logger.warn(`wecom_reply wecom send failed taskId=${taskId} channel=${wecomChannelId} msgtype=${msgtype}${detail}${cardPreview}`);
      if (!mirrorContent) {
        mirrorContent = { text: mirrorText || rawText || `[${msgtype}]`, msgtype, card: resolvedCard, error: sendError, articles: args.articles, parts: [] };
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
        const senderAgentId = await this.resolveSenderAgentId(taskId, instanceId);
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
              where: { channelId: groupCh.id, senderType: SENDER_TYPE.external },
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
          this.logger.log(`wecom_reply placeholder updated taskId=${taskId} placeholderId=${placeholder.id} -> mirrorTextLen=${(mirrorContent.text ?? '').length} msgtype=${msgtype}`);
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
        content: [{ type: 'text', text: `已回复企微用户${fromName ? ` @${fromName}` : ''} 并同步到任务群聊。重要：回复已完成，请直接结束本轮，不要再输出任何总结或重复回复（不要生成 final answer）。` }],
        isError: false,
        messageId: mirrorMessageId,
        channelId: groupChannelId,
        wecomSent: true,
      };
    } else if (wecomSent) {
      return {
        content: [{ type: 'text', text: `已发送到企微${fromName ? ` @${fromName}` : ''}（群聊同步失败）。重要：回复已完成，请直接结束本轮，不要再输出任何总结或重复回复。` }],
        isError: false,
        wecomSent: true,
      };
    }
    const failDetail = sendError ? ` 失败原因: ${sendError.slice(0, 400)}` : '';
    return {
      content: [{ type: 'text', text: `已同步到任务群聊（企微发送失败，请检查 WeCom 通道绑定与在线状态）。${failDetail}重要：回复已同步，请直接结束本轮，不要再输出重复回复。`.trim() }],
      isError: false,
      messageId: mirrorMessageId ?? undefined,
      channelId: groupChannelId,
      wecomSent: false,
    };
  }

  /**
    * channel_send：向当前任务绑定的通知渠道发送文本（webhook / wecom_group_robot）。
     * - 入参仅 target(id/name, nc_ 前缀) + text(≤4000)，taskId 从 worker 会话上下文解析（当前任务边界）。
     * - text 越界 → 返回结构化错误文本（不抛断会话）。
     * - outboundDispatcher.sendToChannelByIdOrName 查询 NotificationChannel (nc_) + TaskNotificationChannel 绑定；
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
    return this.artifactsService.archiveFile(taskId, {
      fileRef,
      storedUrl: stored.url,
      storedName: stored.name,
      sha256,
      title,
    });
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

  /**
   * 归属校验（tools/call 前置，设计文档 §4.2）：该 worker 是否有该 taskId 的 Session。
   * - 无 Session → 403 `PLATFORM_MCP_FORBIDDEN`；缺 workerId → 403 `PLATFORM_MCP_MISSING_WORKER_ID`。
   * - selfInstanceId（落库类工具必填）：必须是该任务会话绑定的实例（session.taskAgentId，
   *   存量会话 taskAgentId 为 NULL 时无法匹配 ta_ 前缀实例 → 403，不构成冒充放行）→
   *   不一致 403 `PLATFORM_MCP_FORBIDDEN`（防伪造/跨实例冒充：调用方必须声明自己的实例 id）。
   * - 多实例任务（taskId 下多个实例会话并存）：selfInstanceId 提供时按实例精确匹配 session
   *   （原泛查首条会误命中外实例 → 合法成员被误判"禁止冒充"，且 task_transition 非主实例
   *   无法落到"仅主 Agent"403）。无匹配 → 403 禁止跨任务访问（安全不降级）。
   * 返回实例 id（senderInstanceId 落库用；senderId=agent id 由 resolveSenderAgentId 解析）。
   */
  private async assertWorkerTask(
    ctx: PlatformMcpContext,
    taskId: string,
    selfInstanceId?: string,
  ): Promise<string> {
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
    const session = await this.prisma.session.findFirst({
      where: {
        taskId,
        workerId: ctx.workerId,
        ...(selfInstanceId !== undefined
          ? { taskAgentId: selfInstanceId }
          : {}),
      },
      select: { id: true, agentId: true, taskAgentId: true },
    });
    if (!session) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message:
          selfInstanceId !== undefined
            ? `selfInstanceId（${selfInstanceId}）不在该 worker 当前执行任务（${taskId}）的活跃实例集合中，且该 worker 无绑定会话，禁止冒充`
            : '该 worker 无此任务会话，禁止跨任务访问',
      });
    }
    const instanceId = session.taskAgentId ?? session.agentId;
    if (selfInstanceId !== undefined && instanceId !== selfInstanceId) {
      throw new ForbiddenException({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        message: `selfInstanceId 与执行该任务的实例（${instanceId}）不一致，禁止冒充`,
      });
    }
    return instanceId;
  }

  /**
   * 落库 senderId（agent id，角色渲染）解析：从实例行取模板 agent id。
   * 实例行缺失（存量/回退，instanceId 本身可能是 agent id）→ 原样返回。
   */
  private async resolveSenderAgentId(
    taskId: string,
    instanceId: string,
  ): Promise<string> {
    const ta = await this.prisma.taskAgent.findFirst({
      where: { id: instanceId, taskId },
      select: { agentId: true },
    });
    return ta?.agentId ?? instanceId;
  }

  /** 任务群聊频道（task_group 型 ChatChannel）。 */
  private findTaskGroupChannel(taskId: string) {
    return this.prisma.chatChannel.findFirst({
      where: { taskId, type: CHANNEL_TYPE.task_group },
      select: { id: true },
    });
  }

  private normalizeLimit(limit?: number): number {
    const l = Number(limit ?? 50);
    if (!Number.isFinite(l)) return 50;
    return Math.min(Math.max(Math.floor(l), 1), 100);
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
