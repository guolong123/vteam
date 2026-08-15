import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import {
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
import { PLATFORM_MCP_ERRORS } from './platform-mcp.constants';

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

    const message = await this.prisma.message.create({
      data: {
        id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
        channelId: channel.id,
        senderType: SENDER_TYPE.agent,
        senderId: await this.resolveSenderAgentId(args.taskId, instanceId),
        senderInstanceId: instanceId,
        content: { text: args.content, parts: [] } as Prisma.InputJsonValue,
        mentions: null,
        status: MESSAGE_STATUS.sent,
        ...(attachment ?? {}),
      },
    });

    await this.realtime.broadcast(
      EVENT_TYPES.CHAT_MESSAGE_NEW,
      { message: this.toMessageDto(message) },
      { type: 'channel', id: channel.id },
    );

    return {
      messageId: message.id,
      channelId: channel.id,
      attachment: attachment ?? null,
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
   * 2. **worker 拉取兜底**：归档未命中 → 从调用方 worker（ctx.workerId）工作区拉取
   *    （跨 worker 场景由归档层覆盖——agent B 读的是 agent A 已归档的文件）。
   * maxBytes 截断（默认 256KB，zod 已限 1MB 上限）；utf8 解码失败（二进制）→ base64 前缀。
   */
  async readFile(
    ctx: PlatformMcpContext,
    args: { taskId: string; fileRef: string; maxBytes?: number },
  ): Promise<ReadFileResult> {
    await this.assertWorkerTask(ctx, args.taskId);
    const maxBytes = this.normalizeMaxBytes(args.maxBytes);

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

  /** task_transition：流转任务状态（仅主 Agent 可调用）。三参数归属校验 → TasksService.transitionByAgent。 */
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
    return this.tasksService.transitionByAgent(
      args.taskId,
      args.selfInstanceId,
      args.action,
      args.reason ? { reason: args.reason } : undefined,
    );
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
    // 防冒充优先：落库类工具（selfInstanceId 必填）必须声明"当前正在执行"的实例——
    // dispatcher 在 execute 下发时按实例登记、completed/error 注销。多会话任务（taskId 下
    // 多个实例会话并存）下 findFirst 定位歧义曾导致冒充放行（误把旧会话实例判为执行者），
    // 注册表精确校验可根治。无注册记录（非 dispatch 驱动）→ 回退 findFirst。
    if (selfInstanceId !== undefined) {
      const active = this.workerDispatcher.isAgentExecuting(
        ctx.workerId,
        taskId,
      );
      if (active !== null) {
        if (!active.has(selfInstanceId)) {
          throw new ForbiddenException({
            code: PLATFORM_MCP_ERRORS.FORBIDDEN,
            message: `selfInstanceId（${selfInstanceId}）不在该 worker 当前执行任务（${taskId}）的活跃实例集合中，禁止冒充`,
          });
        }
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
        message: '该 worker 无此任务会话，禁止跨任务访问',
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
