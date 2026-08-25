import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
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
import {
  IssueStatus,
  IssueTransitionAction,
} from '../issues/issues.constants';
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
import { PLATFORM_MCP_ERRORS, validateTsxPrototype } from './platform-mcp.constants';
import { validatePlanTaskQuality } from './plan-quality.guard';

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
  ): Promise<{ messageId: string; channelId: string; attachment: GroupPostAttachment | null }> {
    const instanceId = await this.assertWorkerTask(ctx, args.taskId, args.selfInstanceId);
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
    mentions: Array<{ type: 'agent'; instanceId: string; agentId: string; name: string }> | null;
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
      const hit = idx >= 0 && (idx + atName.length >= boundaryAfter || /[\s,，。；;:：!！?？]/.test(content[idx + atName.length] ?? ''));
      if (!hit) continue;
      if (!mentionedInstances.includes(row.id)) {
        mentionedInstances.push(row.id);
        mentions.push({ type: 'agent', instanceId: row.id, agentId: row.agentId, name });
      }
    }
    if (content.includes('@all')) {
      (mentions as unknown as Array<{ type: string }>).push({ type: 'all' } as unknown as { type: 'agent'; instanceId: string; agentId: string; name: string });
    }
    try {
      const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
      if (task?.projectId) {
        const members = await this.prisma.projectMember.findMany({
          where: { projectId: task.projectId },
          select: { user: { select: { id: true, username: true, displayName: true } } },
        });
        const hasDynamic = ['@user', '@me', '@当前用户', '@here', '@用户'].some((t) => content.includes(t));
        if (hasDynamic) {
          for (const m of members) {
            if (!(mentions as unknown as Array<{ type: string; userId: string }>).some((x) => x.userId === m.user.id)) {
              (mentions as unknown as Array<{ type: string; userId: string }>).push({ type: 'user', userId: m.user.id });
            }
          }
        } else {
          for (const m of members) {
            const names = [m.user.username, m.user.displayName].filter(Boolean) as string[];
            for (const n of names) {
              const atN = `@${n}`;
              const idx = content.indexOf(atN);
              const hit = idx >= 0 && (idx + atN.length >= content.length || /[\s,，。；;:：!！?？]/.test(content[idx + atN.length] ?? ''));
              if (hit) {
                (mentions as unknown as Array<{ type: string; userId: string }>).push({ type: 'user', userId: m.user.id });
                break;
              }
            }
          }
        }
      }
    } catch {}
    return {
      mentions: mentions.length > 0 ? (mentions as unknown as Array<{ type: 'agent'; instanceId: string; agentId: string; name: string }>) : null,
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
  ): Promise<{ messageId: string; channelId: string; targetInstanceId: string }> {
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
      where: { id: args.targetInstanceId, taskId: args.taskId, removedAt: null },
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
    const targetName = targetInstance.alias ?? targetInstance.agent.name ?? targetAgentId;
    const senderAgentId = await this.resolveSenderAgentId(args.taskId, args.selfInstanceId);
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
      if (direct) return this.readFromArchive(direct.contentRef, args.fileRef, maxBytes);
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
        if (v2) return this.readFromArchive(v2.contentRef, args.fileRef, maxBytes);
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
          message: '计划模式下需由用户在任务管理界面手动启动任务，Agent 不可自动 start；评审通过后请等待用户点击“开始任务”',
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

    const description = (args.description?.trim() || args.content.slice(0, 120)).slice(0, 255);
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
        whereOr.push({ level: MEMORY_LEVELS.project, projectId: task.projectId });
      }
    }
    if (args.level === undefined || args.level === MEMORY_LEVELS.global) {
      whereOr.push({ level: MEMORY_LEVELS.global });
    }
    if (whereOr.length === 0) {
      // 如 level=project 但任务无项目归属 → 无可见范围，返回空
      return [];
    }

    const tokens = args.query ? args.query.trim().split(/\s+/).filter(Boolean) : [];
    const tokenFilters: Prisma.MemoryWhereInput[] = tokens.map((t) => ({
      OR: [{ content: { contains: t } }, { description: { contains: t } }],
    }));
    const sourceFilters: Prisma.MemoryWhereInput[] = [];
    if (args.sourceInstanceId) sourceFilters.push({ sourceInstanceId: args.sourceInstanceId });
    if (args.sourceAgentId) sourceFilters.push({ sourceAgentId: args.sourceAgentId });
    if (args.sessionId) sourceFilters.push({ sessionId: args.sessionId });
    const andBlocks: Prisma.MemoryWhereInput[] = [{ OR: whereOr }, ...tokenFilters, ...sourceFilters];
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
    if (existing && (existing as { rejectCount?: number }).rejectCount !== undefined && (existing.rejectCount as number) >= 3) {
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
          : { status: PLAN_STATUS.rejected, reviewerInstanceId: null, rejectCount: { increment: 1 } },
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
  ): Promise<{ requestId: string; taskId: string; agentId: string; alias: string }> {
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
          confirmedBy: args.actor.type === ACTOR_TYPE.user ? '用户' : '主 Agent',
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
  private toSubmitResult(result: {
    status: string;
    artifact?: unknown;
  }): {
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
        ...(selfInstanceId !== undefined ? { taskAgentId: selfInstanceId } : {}),
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
      this.logger.log(`group_post fileRef 已从 worker 拉取并归档: ${fileRef} -> ${stored.url}`);
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
