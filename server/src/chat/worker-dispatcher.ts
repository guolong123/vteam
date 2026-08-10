import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { validateArtifactDeclaration } from '../artifacts/artifacts.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WORKER_STATUS } from '../workers/workers.constants';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { WorkerClient, WorkerEndpointRef, WorkerUnavailableException } from '../workers/worker.client';
import { AgentStatusPayload, TaskCompletedPayload, WorkerEventIngress } from '../workers/worker-event.ingress';
import { AssignmentRequirement, WorkersService } from '../workers/workers.service';
import { DispatchRequest, DispatchResult, MessageDispatcher } from './message-dispatcher';

/** 消息主键前缀：与 ChatService 共享 IdGeneratorService 的 'm' 计数（重启续号同源）。 */
const MESSAGE_ID_PREFIX = 'm';

/** 首次 bind 的 instanceRef 占位（opencode 会话尚未创建；第二次 bind 写入真实 sessionId）。 */
export const PENDING_INSTANCE_REF = 'pending';

/** C7：baseAgentId 链向上遍历的最大深度（防御异常链/环导致的无限查询）。 */
const MAX_BASE_AGENT_CHAIN_DEPTH = 20;

/** 单文档正文截断上限（12 篇 §8.1：默认 32KB/文档，超出以摘要替代——本版直接截断）。 */
export const DEFAULT_DOCLIB_MAX_BYTES = 32 * 1024;
/** doclib 块整体大小上限（多产出物防御：正常场景 32KB/文档 × 少量文档远低于此）。 */
export const DEFAULT_DOCLIB_TOTAL_BYTES = 128 * 1024;
/** 群聊历史上下文注入上限（对齐 doclib 单文档 32KB 语义：按条截断 + 总量截断，防超长 prompt）。 */
export const DEFAULT_CHAT_HISTORY_MAX_BYTES = 32 * 1024;

/**
 * 分派后等待回流的默认超时（D8 总超时；F3 MINOR-3：架构师 5 轮 tool 调用实测 72s > 60s，
 * 复杂任务多轮工具调用易超时 → 默认放宽至 120s，env DISPATCH_TIMEOUT_MS 可配）。
 * 配置项默认值（实例字段 dispatchTimeoutMs 从 ConfigService 读取，缺省回落本值）。
 */
export const DISPATCH_TIMEOUT_MS = 120_000;

/** F3 MINOR-3：任务工作目录根（env WORK_DIR，默认 /tmp/keta-worker-tasks）。
 *  任务级独立工作目录 = <根>/tasks/<taskId>（server 侧 mkdir -p 保证存在），
 *  作为 prompt_async 的 directory 传入——防模型在仓库根真实写文件污染（F4 零污染关键）。 */
export const DEFAULT_TASK_WORK_DIR = '/tmp/keta-worker-tasks';

/** 自持轮询间隔 ms（F2 C1：对齐 worker 侧 prompt-await.ts pollMs=500，计划 D8）。 */
export const POLL_INTERVAL_MS = 500;

/** opencode serve GET /session/{id}/message 消息最小形状（判定/聚合只取所需字段）。 */
interface PollMessageShape {
  info?: { role?: string; id?: string };
  parts?: Array<{
    type?: string;
    reason?: string;
    text?: string;
    synthetic?: boolean;
    tokens?: unknown;
    cost?: number;
    time?: { start?: number };
    /** step-finish(reason=error) 携带的模型错误详情（OBS-009：无凭据/401 时 serve 产出）。 */
    error?: { name?: string; message?: string };
  }>;
}

/** OBS-009：模型调用失败时的兜底错误文案（serve 未携带具体错误信息时使用）。 */
export const MODEL_FAILURE_FALLBACK_MESSAGE = '模型调用失败（serve 返回 error）';

/**
 * F2 C1：step-finish(reason=stop) 完成判定（移植 worker prompt-await.ts findFinish）。
 * 只认 assistant 消息（user 消息带 step-finish 不算）+ reason===stop。
 */
export function findFinish(messages: unknown[]): PollMessageShape['parts'][number] | undefined {
  for (const raw of messages) {
    const m = raw as PollMessageShape;
    if (m.info?.role !== 'assistant') {
      continue;
    }
    for (const p of m.parts ?? []) {
      if (p.type === 'step-finish' && p.reason === 'stop') {
        return p;
      }
    }
  }
  return undefined;
}

/**
 * OBS-009 快速失败检测：模型调用失败（无凭据/401 等）时 serve 产出
 * step-finish(reason=error)（或 error part）——findFinish 只认 reason=stop，
 * 该形状此前被轮询忽略 → 静默等 120s 超时。本函数遍历 assistant 消息命中即返回
 * 错误文案（error.message 优先，回退 part.text，再回退兜底文案）；无错误 → undefined。
 */
export function findError(messages: unknown[]): string | undefined {
  for (const raw of messages) {
    const m = raw as PollMessageShape;
    if (m.info?.role !== 'assistant') {
      continue;
    }
    for (const p of m.parts ?? []) {
      if (p.type === 'step-finish' && p.reason === 'error') {
        return p.error?.message || p.text || MODEL_FAILURE_FALLBACK_MESSAGE;
      }
      if (p.type === 'error') {
        return p.error?.message || p.text || MODEL_FAILURE_FALLBACK_MESSAGE;
      }
    }
  }
  return undefined;
}

/**
 * F2 C1：文本聚合（移植 worker prompt-await.ts aggregateText）：assistant 消息 +
 * type=text 且非 synthetic（工具调用占位排除）+ 按 part.time.start 升序串接。
 */
export function aggregateText(messages: unknown[]): string {
  const texts = (messages as PollMessageShape[])
    .filter((m) => m.info?.role === 'assistant')
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === 'text' && !p.synthetic)
    .sort((a, b) => (a.time?.start ?? 0) - (b.time?.start ?? 0));
  return texts.map((p) => p.text ?? '').join('');
}

/** XML 实体反转义（F3 MAJOR-2：产出物声明标签正文/属性解析）。 */
export function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * F3 MAJOR-2：从 agent 回复文本提取产出物声明（12 篇 §3.1 声明形状，兼容 §8.2 注入格式）：
 * ① `<artifact type title>正文</artifact>` 标签（§8.2 格式对称复用，text 类型取正文为 content）；
 * ② 内嵌 JSON 声明对象 `{type, title, content, fileRef}`（§3.1）；
 * ③ `[artifact]...[/artifact]` 包裹的 JSON 声明。
 * 每个候选经 validateArtifactDeclaration 过滤——非法/格式不符直接丢弃（不误报）；
 * 回复无声明 → 返回空数组（正常，不触发归档）。
 */
export function extractArtifacts(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const push = (decl: Record<string, unknown>): void => {
    // 同一声明可能被多种格式命中（如 [artifact] 包裹的 JSON 也被 JSON 正则捕获）→ 去重
    const key = JSON.stringify(decl);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(decl);
    }
  };
  // ① <artifact type="..." title="...">正文</artifact>（§8.2）
  const tagRe = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/g;
  for (const m of text.matchAll(tagRe)) {
    const attrs = new Map<string, string>();
    for (const attr of m[1].matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) {
      attrs.set(attr[1], decodeXml(attr[2]));
    }
    const type = attrs.get('type');
    const title = attrs.get('title');
    if (type && title) {
      const decl: Record<string, unknown> = {
        type,
        title,
        content: decodeXml(m[2].trim()),
      };
      if (validateArtifactDeclaration(decl).valid) {
        push(decl);
      }
    }
  }
  // ② 内嵌 JSON 声明对象（type 限三态枚举，避免误匹配普通文本）
  const jsonRe = /(?<![\w])\{[\s\S]*?"type"\s*:\s*"(?:text|doc|file)"[\s\S]*?\}/g;
  for (const m of text.matchAll(jsonRe)) {
    try {
      const parsed = JSON.parse(m[0]) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && validateArtifactDeclaration(parsed).valid) {
        push(parsed);
      }
    } catch {
      // 非合法 JSON：丢弃，不误报
    }
  }
  // ③ [artifact]...[/artifact] 包裹的 JSON 声明
  const bracketRe = /\[artifact\]([\s\S]*?)\[\/artifact\]/g;
  for (const m of text.matchAll(bracketRe)) {
    try {
      const parsed = JSON.parse(m[1].trim()) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && validateArtifactDeclaration(parsed).valid) {
        push(parsed);
      }
    } catch {
      // 同上：丢弃
    }
  }
  return out;
}

/** 待回流会话（watchdog 超时用）：key = `${taskId}:${agentId}`。 */
interface PendingDispatch {
  taskId: string;
  agentId: string;
  timer: ReturnType<typeof setTimeout>;
}

/** 消息行（messages 表；content/mentions 为 Json 列），对齐 chat.service 的 MessageRow 契约。 */
type MessageRow = {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string | null;
  content: Prisma.JsonValue;
  mentions: Prisma.JsonValue | null;
  status: string;
  createdAt: Date;
};

/**
 * 按 UTF-8 字节数截断文本（32KB 语义按字节计）：内容已不超限原样返回；
 * 否则二分查找最长不超限前缀（避免切裂多字节字符）。
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

/** XML 文本转义（doclib 注入块内 artifact 属性/正文，防特殊字符破坏结构）。 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Phase 4 真实分派器（18 篇 §8.3，替换 MockDispatcher 的核心，M4 主链路心脏）：
 * dispatch → 定位/分配 worker（T12 bindSessionToWorker）→ doclib 上下文注入（12 篇 §8）
 * → WorkerClient 下发（T8 createSession/promptAsync）→ 回流处理（D5：落库 + broadcast
 * chat.message.new + emitFinal 归本类）。
 *
 * 与 MockDispatcher 的关键差异：
 * - **回复不在此处生成**：dispatch 返回 `{replies: []}`，真实回复经 worker task.completed
 *   回流（09 篇 §4.3）→ handleTaskCompleted 落库 + 广播 + emitFinal（D5 防双写）；
 * - **无 worker 报错不降级**（D3）：assignWorker 无可用 → emitError + 广播 agent.error；
 *   mock 降级仅 WORKER_MOCK_FALLBACK 开关（本类不实现，MockDispatcher 代码保留不动）；
 * - **loading 广播对齐 MockDispatcher**（:158-162）：dispatch 成功后 thinking → operating 两阶段；
 * - **T9 接线**：构造时向 WorkerEventIngress 注册 onTaskCompleted / onAgentStatus 回调。
 *   task.completed 回调做落库+广播+emitFinal；agent.status 回调仅做 emitLoading/emitError
 *   本地通知（SSE 的 agent.loading/agent.error emit 由 T9 ingress 完成，此处不重复广播防双写）。
 */
@Injectable()
export class WorkerDispatcher extends MessageDispatcher implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerDispatcher.name);

  /** doclib 注入上限（12 篇 §8.3 可配；公开字段便于测试覆盖）。 */
  public doclibMaxBytes: number;
  public doclibTotalBytes: number;
  /** 群聊历史注入上限（对齐 doclib 32KB 语义；公开字段便于测试覆盖）。 */
  public chatHistoryMaxBytes: number;

  /** 待回流 watchdog：`${taskId}:${agentId}` → 定时器（默认 120s 超时 emitError）。 */
  private readonly pending = new Map<string, PendingDispatch>();

  /** F2 C1 幂等：已落库回流的会话（自持轮询与 ingress task.completed 双通道防重）。
   *  F3 MAJOR-1：新一轮 dispatch 会清除目标会话标记（跨轮回流允许），仍防同轮双写。 */
  private readonly completedSessions = new Set<string>();
  /** F2 MINOR：watchdog/轮询已超时的会话（迟到回流跳过落库，防用户同时见错误+消息）。 */
  private readonly failedSessions = new Set<string>();

  /** F3 MINOR-3：回流超时 ms（env DISPATCH_TIMEOUT_MS，缺省 DISPATCH_TIMEOUT_MS=120s）。 */
  public dispatchTimeoutMs: number;
  /** F3 MINOR-3：任务工作目录根（env WORK_DIR，缺省 /tmp/keta-worker-tasks）。 */
  public taskWorkDirRoot: string;
  /** F3 MAJOR-1：增量 poll 游标（sessionId → 已消费到的最新消息 id），复用会话跨轮续接。 */
  private readonly pollCursors = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
    private readonly workersService: WorkersService,
    private readonly workerClient: WorkerClient,
    private readonly sessionLifecycle: SessionLifecycleService,
    private readonly artifactsService: ArtifactsService,
    config: ConfigService,
    ingress: WorkerEventIngress,
  ) {
    super();
    const maxBytes = config.get<number>('DOCLIB_MAX_BYTES');
    this.doclibMaxBytes =
      typeof maxBytes === 'number' && maxBytes > 0
        ? maxBytes
        : DEFAULT_DOCLIB_MAX_BYTES;
    const totalBytes = config.get<number>('DOCLIB_TOTAL_BYTES');
    this.doclibTotalBytes =
      typeof totalBytes === 'number' && totalBytes > 0
        ? totalBytes
        : DEFAULT_DOCLIB_TOTAL_BYTES;
    const historyBytes = config.get<number>('CHAT_HISTORY_MAX_BYTES');
    this.chatHistoryMaxBytes =
      typeof historyBytes === 'number' && historyBytes > 0
        ? historyBytes
        : DEFAULT_CHAT_HISTORY_MAX_BYTES;
    // F3 MINOR-3：回流超时可配（DISPATCH_TIMEOUT_MS），缺省 120s（复杂任务多轮 tool 调用）
    const timeoutMs = config.get<number>('DISPATCH_TIMEOUT_MS');
    this.dispatchTimeoutMs =
      typeof timeoutMs === 'number' && timeoutMs > 0
        ? timeoutMs
        : DISPATCH_TIMEOUT_MS;
    // F3 MINOR-3：任务工作目录根（WORK_DIR），任务目录 = <根>/tasks/<taskId>
    const workDir = config.get<string>('WORK_DIR');
    this.taskWorkDirRoot =
      typeof workDir === 'string' && workDir.trim() ? workDir.trim() : DEFAULT_TASK_WORK_DIR;

    // T9 接线：注册回流回调（D5——落库+广播 chat.message.new+emitFinal 归本类回流处理器，
    // 防双写；agent.status 仅本地回调通知，SSE emit 由 ingress 完成）
    ingress.onTaskCompleted((payload) => {
      void this.handleTaskCompleted(payload).catch((err: unknown) =>
        this.logger.error(`task.completed 回流处理失败: ${this.describeError(err)}`),
      );
    });
    ingress.onAgentStatus((payload) => {
      void this.handleAgentStatus(payload);
    });
  }

  onModuleDestroy(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
    }
    this.pending.clear();
  }

  // ------------------------------------------------------------------
  // MessageDispatcher 抽象实现
  // ------------------------------------------------------------------

  /**
   * 下发分派（fire-and-forget，ChatService 不 await 结果）：
   * 对每个 target 串行：定位/分配 worker → doclib 注入 → loading 两阶段 →
   * createSession/bind 真实 instanceRef → promptAsync。
   * 返回 `{replies: []}`——真实回复经 task.completed 回流（D5），不在此生成。
   * 单目标失败 emitError + 广播 agent.error，不阻塞其他目标（FR-21）。
   */
  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    for (const target of request.targets) {
      try {
        await this.dispatchForTarget(request, target);
      } catch (err) {
        const message = this.describeError(err);
        this.logger.error(
          `agent ${target.agentId} dispatch failed: ${message}`,
          (err as Error).stack,
        );
        this.emitError({
          taskId: request.taskId,
          agentId: target.agentId,
          error: message,
        });
        await this.broadcastAgentError({
          taskId: request.taskId,
          agentId: target.agentId,
          sessionId: target.sessionId,
          level: 'message',
          errorType: 'dispatch_failed',
          message,
        });
      }
    }
    return { replies: [] };
  }

  /**
   * 单目标分派时序（对齐 MockDispatcher replyFor :151-211）：
   * 1 查 Session → 已绑 worker 复用；未绑 assignWorker（无可用 → 报错不降级 D3）+
   *   首次 bind（instanceRef 占位 pending）→ 2 查 Worker 行（capabilities）→
   *   3 Agent.defaultModelId → {providerID, modelID} → 4 doclib 上下文注入拼 prompt →
   *   5 loading(thinking) → 6 createSession（未创建时）→ bind 更新真实 instanceRef →
   *   7 execute（方案 A：调 worker 执行端点 POST /execute，202 即成功，不启动自持轮询）→
   *   8 loading(operating) + 回流超时 watchdog。
   */
  private async dispatchForTarget(
    request: DispatchRequest,
    target: { agentId: string; sessionId: string | null },
  ): Promise<void> {
    const { taskId } = request;
    if (!target.sessionId) {
      throw new Error('会话缺失：目标无 sessionId，无法分派');
    }

    // 1. 定位 Session：已绑 workerId/instanceRef → 复用同一 opencode 会话（D3 二次 @ 复用）
    const session = await this.prisma.session.findUnique({
      where: { id: target.sessionId },
      select: { id: true, workerId: true, instanceRef: true },
    });
    if (!session) {
      throw new Error(`会话 ${target.sessionId} 不存在`);
    }

    // F2 M5（MAJOR）：残留 pending 绑定视为未绑定（上次分派在 createSession 前中断的
    // 兜底回滚），重新分配 worker——防绑坏 worker 后永不重分配。
    const hasStalePending = session.instanceRef === PENDING_INSTANCE_REF;
    let workerId = session.workerId;
    let opencodeSessionId =
      !hasStalePending &&
      session.instanceRef &&
      session.instanceRef !== PENDING_INSTANCE_REF
        ? session.instanceRef
        : null;

    // C7：模型解析优先级链（阶段 1，Agent→模板）。解析结果非空 → 作为 assignWorker 的
    // modelId 过滤条件；为空（Agent/模板均未配模型）→ 跳过模型过滤（回归现状），
    // 等 worker 选定后再用 worker.defaultModelId 兜底（阶段 2）。
    const agentModelId = await this.resolveAgentModelId(target.agentId);
    const assignmentReq: AssignmentRequirement = agentModelId
      ? { modelId: agentModelId }
      : {};

    if (!workerId || hasStalePending) {
      // 未绑定：调度分配 worker（D3 无可用 → 抛错，调用方报错不降级 mock）
      workerId = await this.workersService.assignWorker(assignmentReq);
      if (!workerId) {
        throw new Error('无可用 worker：请先启动 worker 节点（mock 降级需 WORKER_MOCK_FALLBACK）');
      }
      // 首次绑定（T12）：占位 instanceRef，opencode 会话创建后第二次 bind 写入真实 id
      await this.sessionLifecycle.bindSessionToWorker(
        target.sessionId,
        workerId,
        PENDING_INSTANCE_REF,
      );
    }

    // 2. Worker 行（capabilities 供 WorkerClient 解析 baseUrl/port；defaultModelId 供 C7
    // 模型解析阶段 2 兜底；顺带校验复用 worker 在线性）。
    // 修复验收 e2e 缺陷：复用已绑定 worker 不校验在线 → offline worker 被复用 → fetch failed 首字超时。
    // offline（心跳超时标记）或行缺失 → 解绑 + 重新分配；未绑定分支 assignWorker 已过滤 offline，
    // 此检查只命中"复用已绑定"场景（复用语义保留：在线 worker 直接复用，见单测回归用例）。
    let workerRow = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: { id: true, status: true, capabilities: true, defaultModelId: true },
    });
    if (!workerRow || workerRow.status === WORKER_STATUS.OFFLINE) {
      const staleWorkerId = workerId;
      this.logger.warn(
        `agent ${target.agentId} 绑定的 worker ${staleWorkerId} 不可用` +
          `${workerRow ? '（offline）' : '（不存在）'}，解绑并重新分配 worker`,
      );
      await this.sessionLifecycle.unbindSession(target.sessionId);
      workerId = await this.workersService.assignWorker(assignmentReq);
      if (!workerId) {
        throw new Error('无可用 worker：请先启动 worker 节点（mock 降级需 WORKER_MOCK_FALLBACK）');
      }
      workerRow = await this.prisma.worker.findUnique({
        where: { id: workerId },
        select: { id: true, status: true, capabilities: true, defaultModelId: true },
      });
      if (!workerRow) {
        throw new Error(`worker ${workerId} 不存在`);
      }
      opencodeSessionId = null;
      await this.sessionLifecycle.bindSessionToWorker(
        target.sessionId,
        workerId,
        PENDING_INSTANCE_REF,
      );
    }
    const worker: WorkerEndpointRef = {
      id: workerId,
      capabilities: workerRow.capabilities,
    };

    // 3. C7 模型解析（阶段 2）：最终模型 = Agent/模板解析结果 ?? 执行 worker 默认模型 ?? null。
    // `provider/model` → {providerID, modelID}；null 不指定模型（serve 默认）。
    const model = this.toModelSelection(agentModelId ?? workerRow.defaultModelId ?? null);

    // 4. 上下文注入（doclib 产出物 12 篇 §8 + 来源频道群聊历史，均注入 prompt 前：
    // doclib 在前、历史在后、当前消息最后；两段皆为空 → prompt 保持 request.text 现状）
    const doclib = await this.buildDoclibContext(taskId);
    const history = await this.buildChatHistoryContext(request.channelId, request.messageId);
    const promptBlocks: string[] = [];
    if (doclib) {
      promptBlocks.push(doclib);
    }
    if (history) {
      promptBlocks.push(history);
    }
    promptBlocks.push(request.text);
    const prompt = promptBlocks.join('\n\n');

    // 5. loading(thinking)（对齐 MockDispatcher :158-162）
    await this.realtime.broadcast(
      EVENT_TYPES.AGENT_LOADING,
      { taskId, agentId: target.agentId, sessionId: target.sessionId, phase: 'thinking' },
      { type: 'task', id: taskId },
    );
    this.emitLoading({
      taskId,
      agentId: target.agentId,
      sessionId: target.sessionId,
      phase: 'thinking',
    });

    // 6. 创建 opencode 会话（未创建/占位时）→ 第二次 bind 写入真实 instanceRef
    if (!opencodeSessionId) {
      try {
        const created = await this.workerClient.createSession(worker, model);
        opencodeSessionId = created.sessionID;
        await this.sessionLifecycle.bindSessionToWorker(
          target.sessionId,
          workerId,
          opencodeSessionId,
        );
      } catch (err) {
        // F2 M5（MAJOR）：分派失败回滚绑定——Session 恢复 created + workerId/instanceRef
        // 清空 + TaskGroupInstance 软移除，下次 @ 重新分配 worker（防绑坏 worker 永不重分配）。
        await this.sessionLifecycle
          .unbindSession(target.sessionId)
          .catch((rbErr: unknown) =>
            this.logger.error(`回滚绑定失败: ${this.describeError(rbErr)}`),
          );
        throw err;
      }
    }

    // 7. 下发执行（方案 A：fire-and-forget 调 worker 执行端点 POST /execute，202 accepted
    // 即成功——worker 异步驱动 serve 并上送事件；回复经 ingress task.completed 回流
    // （handleTaskCompleted 落库+广播+emitFinal），server 不再自持轮询。
    // 自持轮询 pollForCompletion 方案 A 后不再调用（代码保留作兜底/测试，见方法注释）。
    // F3 MINOR-3：工作目录隔离——directory 指向任务级独立工作目录
    // （<WORK_DIR>/tasks/<taskId>，mkdir -p 保证存在），防模型在仓库根写文件污染（F4）。
    const taskWorkDir = await this.ensureTaskWorkDir(taskId);
    await this.workerClient.execute(worker, {
      parts: [{ type: 'text', text: prompt }],
      model,
      directory: taskWorkDir,
      taskId,
      agentId: target.agentId,
      channelId: request.channelId,
      sessionId: opencodeSessionId,
    });

    // F3 MAJOR-1：新一轮 dispatch 重置该会话的幂等/失败标记——复用同一 sessionId 时，
    // 上一轮已落库（completedSessions）或超时（failedSessions）的标记会阻塞本轮回复
    // 回流（静默失败，F3 QA 实测）。重置后本轮回复可重新落库；completedSessions 仍
    // 防同一轮 ingress 双通道双写（方案 A 后唯一回流通道，防护不破坏）。
    this.completedSessions.delete(target.sessionId);
    this.failedSessions.delete(target.sessionId);

    // 8. loading(operating)（工具执行阶段，FR-20）→ 回流超时 watchdog
    await this.realtime.broadcast(
      EVENT_TYPES.AGENT_LOADING,
      { taskId, agentId: target.agentId, sessionId: target.sessionId, phase: 'operating' },
      { type: 'task', id: taskId },
    );
    this.emitLoading({
      taskId,
      agentId: target.agentId,
      sessionId: target.sessionId,
      phase: 'operating',
    });
    this.startPendingWatchdog(taskId, target.agentId, target.sessionId);
  }

  // ------------------------------------------------------------------
  // 回流处理（D5：落库 + 广播 + emitFinal 归本类，防双写）
  // ------------------------------------------------------------------

  /**
   * task.completed 回流处理（T9 ingress onTaskCompleted 回调触发；单测直接调用断言）：
   * 1 定位发件 Agent（payload.agentId 缺失 → sessionId 反查）→ 2 定位频道（私聊 →
   * 群聊回退）→ 3 落库 message（senderType=agent）→ 4 广播 chat.message.new + emitFinal
   * → 5 产出物归档（artifacts 声明 → ArtifactsService.append，12 篇 §5）。
   */
  async handleTaskCompleted(payload: TaskCompletedPayload): Promise<void> {
    const { taskId, sessionId, channelId } = payload;
    if (!taskId) {
      this.logger.error(`task.completed 缺少 taskId，无法处理：${JSON.stringify(payload)}`);
      return;
    }
    // F2 C1（CRITICAL）：双通道幂等——自持轮询与 ingress task.completed 可能同时到达，
    // 同 sessionId 已落库则跳过；failedSessions 命中（watchdog/轮询已超时）→ 迟到回流
    // 跳过落库仅记日志（防用户同时见错误+消息，MINOR）。
    if (sessionId) {
      if (this.completedSessions.has(sessionId)) {
        this.logger.debug(`session ${sessionId} 已落库，跳过重复回流`);
        return;
      }
      if (this.failedSessions.has(sessionId)) {
        this.logger.warn(`session ${sessionId} 已超时失败，迟到回流跳过落库`);
        return;
      }
    }
    let agentId = payload.agentId;
    if (!agentId && sessionId) {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { agentId: true },
      });
      agentId = session?.agentId;
    }
    if (!agentId) {
      this.logger.error(
        `task.completed 缺少 agentId/sessionId，无法定位发件人：${JSON.stringify(payload)}`,
      );
      return;
    }
    this.clearPendingWatchdog(taskId, agentId);
    const text = payload.text ?? '';

    // 2~4. 落库 + 广播 + emitFinal（频道缺失时跳过落库，产出物仍归档）
    const channel = await this.resolveChannel(taskId, agentId, channelId);
    if (channel) {
      try {
        // 终态化（任务 3 定稿）：delta 流式期间创建的 processing 消息 → 更新为 sent +
        // 内容最终化，避免双消息（收到确认 + 流式内容两处落库）；无 processing 消息
        // （无 delta 直接完成）→ 走现有 create 落库路径保持兼容。
        const finalContent = {
          text,
          parts: Array.isArray(payload.parts) ? payload.parts : [],
        } as Prisma.InputJsonValue;
        const processingRow = await this.prisma.message.findFirst({
          where: {
            channelId: channel.id,
            senderType: SENDER_TYPE.agent,
            senderId: agentId,
            status: MESSAGE_STATUS.processing,
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        const message = processingRow
          ? await this.prisma.message.update({
              where: { id: processingRow.id },
              data: { content: finalContent, status: MESSAGE_STATUS.sent },
            })
          : await this.prisma.message.create({
              data: {
                id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
                channelId: channel.id,
                senderType: SENDER_TYPE.agent,
                senderId: agentId,
                content: finalContent,
                mentions: null,
                status: MESSAGE_STATUS.sent,
              },
            });
        if (processingRow) {
          this.logger.log(
            `agent ${agentId} 流式消息终态化 message=${processingRow.id} → sent`,
          );
        }
        // F2 C1：落库成功即标记已完成（ingress/轮询双通道后续到达直接跳过，防重复落库）
        if (sessionId) {
          this.completedSessions.add(sessionId);
        }
        await this.realtime.broadcast(
          EVENT_TYPES.CHAT_MESSAGE_NEW,
          { message: this.toMessageDto(message) },
          { type: 'channel', id: channel.id },
        );
        this.emitFinal({
          taskId,
          agentId,
          messageId: message.id,
          text,
        });
      } catch (err) {
        this.logger.error(
          `agent ${agentId} 回复落库失败: ${this.describeError(err)}`,
          (err as Error).stack,
        );
        this.emitError({
          taskId,
          agentId,
          error: `回复落库失败: ${this.describeError(err)}`,
        });
      }
    } else {
      this.logger.error(
        `task.completed 无法定位频道（taskId=${taskId} agentId=${agentId}），跳过回复落库`,
      );
      this.emitError({
        taskId,
        agentId,
        error: '回复回流失败：无法定位目标频道',
      });
    }

    // 5. 产出物归档（声明非法时 onArtifactSubmitted 返回 invalid 不抛错，12 篇 §3.1）
    for (const raw of Array.isArray(payload.artifacts) ? payload.artifacts : []) {
      const art = (raw ?? {}) as Record<string, unknown>;
      try {
        const result = await this.artifactsService.onArtifactSubmitted({
          taskId,
          type: String(art.type ?? ''),
          title: String(art.title ?? ''),
          content: String(art.content ?? ''),
          ...(art.fileRef !== undefined ? { fileRef: String(art.fileRef) } : {}),
        });
        if (result.status === 'invalid') {
          this.logger.warn(
            `agent ${agentId} 产出物声明非法（${result.reason}）：${JSON.stringify(art)}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `agent ${agentId} 产出物归档失败: ${this.describeError(err)}`,
          (err as Error).stack,
        );
      }
    }
  }

  /**
   * agent.status 回流处理（T9 ingress onAgentStatus 回调触发）：
   * 仅做 emitLoading/emitError 本地回调通知（对齐 MessageDispatcher 订阅契约，供
   * ChatService onLoading/onError 日志）；SSE 的 agent.loading/agent.error emit 已由
   * T9 ingress 完成（worker-event.ingress.ts handleAgentStatus），此处不重复广播防双写。
   */
  async handleAgentStatus(payload: AgentStatusPayload): Promise<void> {
    const { taskId, agentId, sessionId } = payload;
    if (!taskId || !agentId) {
      return;
    }
    const isError =
      payload.status === 'error' ||
      (typeof payload.error === 'string' && payload.error.length > 0);
    if (isError) {
      this.emitError({
        taskId,
        agentId,
        error: payload.error ?? 'agent 处理失败',
      });
    } else {
      this.emitLoading({
        taskId,
        agentId,
        sessionId: sessionId ?? null,
        phase: payload.phase === 'thinking' ? 'thinking' : 'operating',
      });
    }
  }

  // ------------------------------------------------------------------
  // 私有工具
  // ------------------------------------------------------------------

  /**
   * F2 C1（CRITICAL）+ F3 MAJOR-1（增量检测）：自持轮询完成判定——promptAsync 后 server
   * 侧每 500ms 拉取 GET /session/{id}/message，**只检测本轮 dispatch 之后新增的消息**中
   * 是否出现 step-finish(reason=stop)（pollCursors 记录已消费到的最新消息 id，复用会话
   * 时不误命中上一次会话的 step-finish）→ handlePolledCompletion 落库+广播+emitFinal。
   * 默认超时（dispatchTimeoutMs）→ failedSessions 标记防迟到回流；emitError 由 watchdog
   * 统一触发（避免双 emitError）。
   * ⚠️ 方案 A：dispatch 主链路已切换为调 worker 执行端点 POST /execute + ingress 事件回流，
   * **dispatch 不再调用本方法**。本方法保留仅作兜底/测试路径（单测直接调用验证轮询语义）。
   */
  private async pollForCompletion(params: {
    worker: WorkerEndpointRef;
    opencodeSessionId: string;
    taskId: string;
    agentId: string;
    sessionId: string;
    /**
     * F4 消息来源频道（DispatchRequest.channelId 透传）：轮询回流时作为
     * preferredChannelId 交 resolveChannel 群聊优先（用户实际触发的路径）。
     */
    channelId?: string;
    startedAt?: number;
    /**
     * F3 MAJOR-1 残留修复：promptAsync 前基线 cursor（dispatch 前置取定，此时 serve
     * 尚未创建本次 assistant 占位消息，不会落在占位上）。null=无历史（首次会话，
     * messagesAfter(null) 返回全部）；undefined=未提供（前置取基线失败）→ 回退既有
     * 游标或兜底首轮自取。
     */
    baselineCursor?: string | null;
  }): Promise<void> {
    const deadline = Date.now() + this.dispatchTimeoutMs;
    // F3 MAJOR-1：增量 poll 游标——上次已消费到的最新消息 id；复用会话第二次 dispatch
    // 时从上次已消费位置继续。F3 残留修复：优先使用 dispatch 在 promptAsync 前取的
    // 基线（绝对正确，无占位污染）；未提供才回退 pollCursors 既有游标（跨轮续接）。
    let cursor: string | null | undefined;
    if (params.baselineCursor !== undefined) {
      cursor = params.baselineCursor;
      if (cursor !== null) {
        this.pollCursors.set(params.sessionId, cursor);
      }
    } else {
      cursor = this.pollCursors.get(params.sessionId);
    }
    let initialized = cursor !== undefined;
    let firstTextAt: number | null = null;
    while (Date.now() < deadline) {
      let messages: unknown[];
      try {
        messages = await this.workerClient.getMessages(
          params.worker,
          params.opencodeSessionId,
        );
      } catch (err) {
        // getMessages 失败（worker 暂时不可达）：超时窗口内继续重试
        this.logger.warn(
          `agent ${params.agentId} 轮询 getMessages 失败: ${this.describeError(err)}`,
        );
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const lastId = this.lastMessageId(messages);
      if (!initialized) {
        // F3 MAJOR-1 残留修复：兜底首轮基线（前置基线失败/无既有游标场景）——用
        // baselineId 跳过空 assistant 占位（promptAsync 后 serve 创建的本次回复占位，
        // parts=[]），基线落在本次 user prompt 消息（或更早）上，防 messagesAfter
        // 永空（m_37 超时根因）；不检测本轮。
        cursor = this.baselineId(messages);
        this.pollCursors.set(params.sessionId, cursor);
        initialized = true;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const fresh = this.messagesAfter(messages, cursor ?? null);
      // F3 MINOR-3：记录首字出现时间（新消息中第一个非 synthetic text part），
      // QA 报告首字延迟依据；不优化模型响应速度（受模型/网络影响）
      if (firstTextAt === null && this.hasTextPart(fresh)) {
        firstTextAt = Date.now();
        const delta =
          params.startedAt !== undefined ? firstTextAt - params.startedAt : null;
        this.logger.log(
          `agent ${params.agentId} 首字出现${delta !== null ? `（dispatch 后 ${delta}ms）` : ''}`,
        );
      }
      // OBS-009：step-finish(reason=error)/error part → 模型调用失败，立即 emitError +
      // agent.error 广播快速返回（不再静默等到 dispatchTimeoutMs 超时才报错）。标记
      // failedSessions 复用现有逻辑——迟到回流（ingress/轮询）跳过落库防双写。
      const pollError = findError(fresh);
      if (pollError !== undefined) {
        this.pollCursors.set(params.sessionId, lastId ?? cursor);
        this.clearPendingWatchdog(params.taskId, params.agentId);
        this.failedSessions.add(params.sessionId);
        const message = `agent 处理失败：${pollError}`;
        this.logger.error(`agent ${params.agentId} ${message}`);
        this.emitError({ taskId: params.taskId, agentId: params.agentId, error: message });
        void this.broadcastAgentError({
          taskId: params.taskId,
          agentId: params.agentId,
          level: 'retry',
          errorType: 'model_error',
          message,
        });
        return;
      }
      if (findFinish(fresh)) {
        this.pollCursors.set(params.sessionId, lastId ?? cursor);
        this.clearPendingWatchdog(params.taskId, params.agentId);
        await this.handlePolledCompletion(params, fresh);
        return;
      }
      if (lastId !== null && lastId !== cursor) {
        this.pollCursors.set(params.sessionId, lastId);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    // 超时：标记失败防迟到回流（emitError 由 watchdog 同步触发，不重复 emit）
    this.failedSessions.add(params.sessionId);
    this.logger.error(
      `agent ${params.agentId} 自持轮询超时（${this.dispatchTimeoutMs / 1000}s 未出现 step-finish）`,
    );
  }

  /** F2 C1：轮询完成 → handleTaskCompleted（幂等检查：failedSessions/completedSessions）。
   *  F3 MAJOR-2：从回复文本提取产出物声明（12 篇 §3.1/§8.2）——原 poll 路径不携带
   *  artifacts 字段，归档循环拿到空数组（M4「产出物自动归档」不可用）；无声明 → 空数组。 */
  private async handlePolledCompletion(
    params: { taskId: string; agentId: string; sessionId: string; channelId?: string },
    messages: unknown[],
  ): Promise<void> {
    if (this.failedSessions.has(params.sessionId)) {
      this.logger.warn(`session ${params.sessionId} 已超时失败，迟到的轮询回流跳过落库`);
      return;
    }
    if (this.completedSessions.has(params.sessionId)) {
      this.logger.debug(`session ${params.sessionId} 已由 ingress 回流落库，跳过轮询回流`);
      return;
    }
    const finish = findFinish(messages);
    const text = aggregateText(messages);
    await this.handleTaskCompleted({
      taskId: params.taskId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      // F4 回流频道透传：消息来源频道随 payload 交 handleTaskCompleted → resolveChannel
      channelId: params.channelId,
      text,
      parts: (messages as PollMessageShape[]).flatMap((m) => m.parts ?? []),
      tokens: finish?.tokens,
      cost: finish?.cost,
      // F3 MAJOR-2：回复含产出物声明 → 提取后经 handleTaskCompleted 走 onArtifactSubmitted
      artifacts: extractArtifacts(text),
    });
  }

  /** doclib 上下文组装（12 篇 §8.2 注入格式）：产出物清单 + 各文档最新版本正文。 */
  private async buildDoclibContext(taskId: string): Promise<string> {
    const artifacts = await this.prisma.artifact.findMany({
      where: { taskId },
      select: {
        id: true,
        type: true,
        title: true,
        currentVersion: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (artifacts.length === 0) {
      return '';
    }

    // 各产出物 current_version 正文 + 作者（authorAgentId 在版本行，12 篇 §8.3：历史版本不进上下文）
    const versions = await this.prisma.artifactVersion.findMany({
      where: {
        OR: artifacts.map((a) => ({ artifactId: a.id, version: a.currentVersion })),
      },
      select: { artifactId: true, contentRef: true, authorAgentId: true },
    });
    const versionByArtifact = new Map(versions.map((v) => [v.artifactId, v]));

    const blocks = artifacts.map((a) => {
      const v = versionByArtifact.get(a.id);
      const content = truncateUtf8(v?.contentRef ?? '', this.doclibMaxBytes);
      return (
        `<artifact type="${escapeXml(a.type)}" title="${escapeXml(a.title)}"` +
        ` version="v${a.currentVersion}" author="${escapeXml(v?.authorAgentId ?? 'unknown')}"` +
        ` updated="${a.updatedAt ? a.updatedAt.toISOString().slice(0, 10) : ''}">` +
        `${escapeXml(content)}</artifact>`
      );
    });

    // 总大小防御上限（正常场景不触发；超出时整体截断，可能切裂结尾标签）
    const full = `<doclib>\n${blocks.join('\n')}\n</doclib>`;
    if (Buffer.byteLength(full, 'utf8') <= this.doclibTotalBytes) {
      return full;
    }
    const truncated = truncateUtf8(full, this.doclibTotalBytes);
    // F2 MINOR：截断可能切裂 `</doclib>` 结尾标签 → 去掉残缺片段补完整闭合标签
    if (!truncated.endsWith('</doclib>')) {
      const cut = truncated.lastIndexOf('</doclib');
      const head = cut >= 0 ? truncated.slice(0, cut) : truncated;
      return `${head.trimEnd()}\n</doclib>`;
    }
    return truncated;
  }

  /**
   * 群聊历史上下文组装（新需求：@agent 触发时带上来源频道 sent 历史，含未 @agent 的消息）：
   * ① 查询 channelId 频道 status=sent 历史（排除当前触发消息，避免重复），时间升序；
   * ② 每条取 content.text（用户=正文；agent=已排除 reasoning 的结论性文本），标注发言者；
   * ③ 按条累加 + 总量截断（对齐 doclib 32KB 语义，防超长 prompt）；空历史 → 空串（不注入）。
   */
  private async buildChatHistoryContext(
    channelId: string,
    excludeMessageId: string,
  ): Promise<string> {
    const messages = await this.prisma.message.findMany({
      where: {
        channelId,
        status: MESSAGE_STATUS.sent,
        NOT: { id: excludeMessageId },
      },
      select: { id: true, senderType: true, content: true },
      orderBy: { createdAt: 'asc' },
    });
    if (messages.length === 0) {
      return '';
    }
    const lines: string[] = [];
    let totalBytes = 0;
    for (const m of messages) {
      // 防御：查询 where 已排除触发消息，此处按 id 再滤一次（测试/mock 场景下 NOT 不生效）
      if (m.id === excludeMessageId) {
        continue;
      }
      const text = this.extractHistoryMessageText(m.content);
      if (!text) {
        continue;
      }
      const line = `${this.historySpeakerLabel(m.senderType)}: ${text}`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (totalBytes + lineBytes > this.chatHistoryMaxBytes) {
        // 超总量：首条即超限 → 单条截断注入保前缀；否则停止追加保留已有前缀
        if (lines.length === 0) {
          lines.push(truncateUtf8(line, this.chatHistoryMaxBytes));
        }
        break;
      }
      lines.push(line);
      totalBytes += lineBytes;
    }
    if (lines.length === 0) {
      return '';
    }
    return `[群聊历史消息]\n${lines.join('\n')}`;
  }

  /** 从消息 content（Prisma Json）提取结论性文本：非对象/缺 text/非字符串 → undefined（跳过不抛错）。 */
  private extractHistoryMessageText(content: Prisma.JsonValue): string | undefined {
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return undefined;
    }
    const text = (content as Record<string, unknown>).text;
    return typeof text === 'string' && text.trim() ? text : undefined;
  }

  /** 历史消息发言者标注：用户 → 用户，agent → Agent，其他（system 等）→ 系统。 */
  private historySpeakerLabel(senderType: string): string {
    if (senderType === SENDER_TYPE.user) {
      return '用户';
    }
    if (senderType === SENDER_TYPE.agent) {
      return 'Agent';
    }
    return '系统';
  }

  /**
   * 定位回流目标频道：preferredChannelId（消息来源频道，如群聊）存在且 taskId 匹配 →
   * 优先采用（用户在群聊频道 @agent 时回复回流群聊而非 DM）；否则回退私聊频道
   * （taskId+agentId 唯一）→ 群聊频道（taskId）。
   */
  private async resolveChannel(taskId: string, agentId: string, preferredChannelId?: string) {
    if (preferredChannelId) {
      const preferred = await this.prisma.chatChannel.findUnique({
        where: { id: preferredChannelId },
        select: { id: true, taskId: true },
      });
      if (preferred?.taskId === taskId) {
        return preferred;
      }
    }
    const dm = await this.prisma.chatChannel.findUnique({
      where: { taskId_agentId: { taskId, agentId } },
      select: { id: true },
    });
    if (dm) {
      return dm;
    }
    return this.prisma.chatChannel.findFirst({
      where: { taskId, type: CHANNEL_TYPE.task_group },
      select: { id: true },
    });
  }

  /**
   * C7：模型解析优先级链（阶段 1，Agent→模板）：Agent.defaultModelId 显式非空直接用；
   * 否则沿 baseAgentId 链向上取最近非空 defaultModelId（模板默认；链可多层 clone of clone，
   * 取自 type=template 祖先或任意非空 defaultModelId 祖先，seed 已预置模板模型）。
   * 全链无配置 → null（不指定模型，由 worker 默认/serve 默认兜底）。
   */
  private async resolveAgentModelId(agentId: string): Promise<string | null> {
    let currentId: string | null = agentId;
    for (let depth = 0; currentId && depth < MAX_BASE_AGENT_CHAIN_DEPTH; depth++) {
      const row = await this.prisma.agent.findUnique({
        where: { id: currentId },
        select: { id: true, defaultModelId: true, baseAgentId: true, type: true },
      });
      if (!row) {
        return null;
      }
      if (row.defaultModelId) {
        return row.defaultModelId;
      }
      if (!row.baseAgentId || row.type === 'template') {
        return null;
      }
      currentId = row.baseAgentId;
    }
    return null;
  }

  /** Agent.defaultModelId（`provider/model`）→ opencode serve 模型选择；缺省/非法 → null。 */
  private toModelSelection(
    defaultModelId: string | null | undefined,
  ): { providerID: string; modelID: string } | null {
    if (!defaultModelId) {
      return null;
    }
    const slash = defaultModelId.lastIndexOf('/');
    if (slash <= 0 || slash === defaultModelId.length - 1) {
      return null;
    }
    return {
      providerID: defaultModelId.slice(0, slash),
      modelID: defaultModelId.slice(slash + 1),
    };
  }

  /** 回流 watchdog：超时（默认 120s）无回流 → emitError + 广播 agent.error（D8 总超时）。 */
  private startPendingWatchdog(taskId: string, agentId: string, sessionId: string): void {
    // OBS-009：poll 已快速失败（step-finish error/error part，failedSessions 已标记）时
    // 跳过注册——poll 首轮可能在 watchdog 注册前失败（dispatch 尾部竞态），此时无 timer 可清。
    if (this.failedSessions.has(sessionId)) {
      return;
    }
    const key = `${taskId}:${agentId}`;
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      // F2 MINOR：超时标记失败会话——迟到的回流（ingress/轮询）跳过落库仅记日志
      this.failedSessions.add(sessionId);
      const error = `worker 处理超时（${this.dispatchTimeoutMs / 1000}s 未回流），请稍后重试或检查 worker 状态`;
      this.logger.error(`agent ${agentId} ${error}`);
      this.emitError({ taskId, agentId, error });
      void this.broadcastAgentError({
        taskId,
        agentId,
        level: 'retry',
        errorType: 'dispatch_timeout',
        message: error,
      });
    }, this.dispatchTimeoutMs);
    timer.unref?.();
    this.pending.set(key, { taskId, agentId, timer });
  }

  // ------------------------------------------------------------------
  // F3 辅助（增量 poll / 工作目录）
  // ------------------------------------------------------------------

  /** F3 MAJOR-1：消息列表中 cursor（消息 id）之后的子集；cursor 为空 → 全量；
   *  cursor 不在列表（游标丢失/会话重建异常）→ 全量（正常流程不出现，防漏检）。 */
  private messagesAfter(messages: unknown[], cursor: string | null): unknown[] {
    if (!cursor) {
      return messages;
    }
    const idx = (messages as PollMessageShape[]).findIndex(
      (m) => m.info?.id === cursor,
    );
    if (idx < 0) {
      return messages;
    }
    return messages.slice(idx + 1);
  }

  /** F3 MAJOR-1：消息列表最后一条带 id 的消息 id（增量 poll 游标记录用）；无 id → null。 */
  private lastMessageId(messages: unknown[]): string | null {
    const list = messages as PollMessageShape[];
    for (let i = list.length - 1; i >= 0; i--) {
      const id = list[i].info?.id;
      if (id) {
        return id;
      }
    }
    return null;
  }

  /**
   * F3 MAJOR-1 残留修复：兜底基线消息 id——最后一条**非空 assistant 占位**消息 id。
   * promptAsync 后 serve 为本次回复创建 assistant 占位消息（parts=[]，未填充）；若基线
   * 取到它 → messagesAfter(cursor) 永空 → 永不命中 step-finish（m_37 超时根因）。兜底
   * 路径（前置基线失败后首轮自取）跳过占位，基线落在本次 user prompt（或更早）上；
   * 无消息/全为占位 → null（messagesAfter(null) 返回全部）。
   */
  private baselineId(messages: unknown[]): string | null {
    const list = messages as PollMessageShape[];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const id = m.info?.id;
      if (!id) {
        continue;
      }
      if (m.info?.role === 'assistant' && (m.parts ?? []).length === 0) {
        continue;
      }
      return id;
    }
    return null;
  }

  /** F3 MINOR-3：消息列表是否含 assistant 非 synthetic text part（首字出现判定）。 */
  private hasTextPart(messages: unknown[]): boolean {
    return (messages as PollMessageShape[]).some(
      (m) =>
        m.info?.role === 'assistant' &&
        (m.parts ?? []).some((p) => p.type === 'text' && !p.synthetic),
    );
  }

  /** F3 MINOR-3：任务级工作目录（<根>/tasks/<taskId>），mkdir -p 保证存在后返回。 */
  private async ensureTaskWorkDir(taskId: string): Promise<string> {
    const dir = path.join(this.taskWorkDirRoot, 'tasks', taskId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private clearPendingWatchdog(taskId: string, agentId: string): void {
    const existing = this.pending.get(`${taskId}:${agentId}`);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(`${taskId}:${agentId}`);
    }
  }

  /** 广播 agent.error（FR-21，scope=task）；广播异常吞掉不阻断主流程。 */
  private async broadcastAgentError(event: {
    taskId: string;
    agentId: string;
    sessionId?: string | null;
    level?: 'tool' | 'message' | 'retry';
    errorType?: string;
    retryInfo?: unknown;
    message?: string;
  }): Promise<void> {
    try {
      await this.realtime.broadcast(
        EVENT_TYPES.AGENT_ERROR,
        {
          taskId: event.taskId,
          agentId: event.agentId,
          sessionId: event.sessionId ?? null,
          level: event.level ?? 'message',
          errorType: event.errorType ?? 'dispatch_failed',
          ...(event.retryInfo !== undefined ? { retryInfo: event.retryInfo } : {}),
          ...(event.message !== undefined ? { message: event.message } : {}),
        },
        { type: 'task', id: event.taskId },
      );
    } catch (err) {
      this.logger.error(`agent.error 广播失败: ${this.describeError(err)}`);
    }
  }

  /** 错误归一：WorkerUnavailableException 已带 workerId，直接透传 message。 */
  private describeError(err: unknown): string {
    if (err instanceof WorkerUnavailableException) {
      return err.message;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }

  /** 消息 DTO（09 篇 §2.4）：content/mentions 透传 Json；createdAt ISO8601（对齐 ChatService）。 */
  private toMessageDto(row: MessageRow) {
    return {
      id: row.id,
      channelId: row.channelId,
      senderType: row.senderType,
      senderId: row.senderId,
      content: row.content,
      mentions: row.mentions ?? [],
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** F2 C1：延迟（unref 防阻塞进程退出；fake timers 下可被 advanceTimersByTimeAsync 推进）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
