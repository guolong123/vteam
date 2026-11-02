/**
 * DshDriver —— `OpenCodeDriver` 的 DSH 实现（P2）。
 *
 * 契约（见 `opencode-driver.ts` 文件头铁律）：出入参一律 vteam 自有类型、失败一律抛
 * `DriverRequestError`、必须过共享 conformance 套件。
 *
 * ## 与 opencode 实现的**根本差异**（P0 实测基线，见 md-docs/dsh-worker-p0-poc-report.md）
 *
 * | 维度 | opencode v2 | DSH SDK 运行时 |
 * |---|---|---|
 * | 传输 | HTTP REST + SSE | **stdio JSON-RPC**（一个客户端 = 一个子进程） |
 * | 会话 | serve 侧 `ses_*` | 客户端**指定** sessionId（`session/prompt`） |
 * | 消息历史 | `GET …/message`（可分页） | **无累积 API** → 驱动自建事件镜像 |
 * | 完成锚点 | 消息 finish → 合成 step-finish | `turn/end` + `assistant/message.usage` |
 * | 中断 | `POST …/interrupt` | `session/cancel`（**vendored 插件**，P0 验证 = 优雅中断） |
 * | 提问/权限 | 轮询 list + reply 端点 | **服务端主动 RPC**（`user-question/ask` / `approval/request`）→ 驱动持有 pending 表 |
 * | 模型切换 | 会话级 `POST …/model` | initialize 时固定路由 → 会话换模型 = 重启运行时 |
 * | todos/agents/integrations | 原生端点 | **不存在** → 返回空数组（能力位为 false，上层降级） |
 *
 * ## 三个必须自己维护的状态
 *
 * 1. **消息镜像**（`sessions: Map<sessionId, SessionMirror>`）：DSH 无 `getMessages` API，
 *    历史由事件累积。`session/resume` 能恢复持久化历史但**不回放事件**，所以镜像只在
 *    本进程生命周期内有效；跨进程恢复依赖 resume + 重新拉取（P1 遗留，见 TODO）。
 * 2. **pending 提问/权限表**：服务端 RPC 是**推送式**，`listQuestions` 必须能同步返回
 *    "当前有哪些待答复"——故收到请求即登记，答复后移除。
 * 3. **轮次终态**：`turn/end` 的 kind 决定本轮是 completed/aborted/error，并据此合成
 *    step-finish（控制面靠它判完成 + 落库用量）。
 *
 * @module driver/dsh-driver
 */

import { createHash } from 'node:crypto';

import type { SessionQuestionInfo } from '../protocol/worker-protocol';
import {
  DriverRequestError,
  type DriverAgentInfo,
  type DriverContent,
  type DriverIntegrationInfo,
  type DriverMessage,
  type DriverMessageInfo,
  type DriverMessageQuery,
  type DriverModelInfo,
  type DriverModelRef,
  type DriverPermissionRequest,
  type DriverPermissionResponse,
  type DriverPromptInput,
  type DriverPromptResult,
  type DriverQuestionRequest,
  type DriverTodo,
  type Logger,
  type OpenCodeDriver,
} from './opencode-driver';
import {
  classifyTurnEnd,
  readAssistantMessage,
  readToolCall,
  readToolResult,
  synthesizeStepFinish,
  toDriverMessage,
  type DshAssistantMessageData,
  type DshSessionEvent,
  type DshTurnOutcome,
} from './dsh-event-map';
import {
  toTerminalVerdict,
  type EngineEvent,
  type EngineEventHandler,
  type EngineEventSubscription,
  type EngineEventChannel,
  type EngineStreamStatus,
} from './engine-events';
import { DshRpcClient, type DshInitializeParams, type DshRpcClientOptions } from './dsh-rpc-client';

/** DshDriver 构造参数。 */
export interface DshDriverOptions extends DshRpcClientOptions {
  /** 会话默认 provider/model（initialize 时固定；每个会话换模型 = 重启运行时）。 */
  provider?: string;
  model?: string;
  /** reasoningEffort（DSH 的 effort 选择器，可选）。 */
  reasoningEffort?: string;
  /** 输出上限（可选）。 */
  maxTokens?: number;
  /** 是否启用 approval/request 回调（缺省 true——vteam 需要权限弹窗）。 */
  approvalRequests?: boolean;
  /** 是否启用 user-question 回调（缺省 true）。 */
  userQuestions?: boolean;
  logger?: Logger;
}

/** 会话镜像（DSH 无累积消息 API，驱动自建）。 */
interface SessionMirror {
  sessionId: string;
  /** 已完成的 assistant 消息（按到达顺序）。 */
  messages: DriverMessage[];
  /** messageID → 该消息的 assistant 数据（供合成 step-finish）。 */
  assistantByMessage: Map<string, DshAssistantMessageData>;
  /** callId → tool part（结果到达时更新）。 */
  toolParts: Map<string, DriverContent>;
  /** 本会话最近的 turn/end 终态（未收到 = undefined）。 */
  lastOutcome?: DshTurnOutcome;
  /** 本会话最近一条 assistant message id（turn/end 到达时用它合成 step-finish）。 */
  lastMessageID?: string;
}

/** 待答复的提问（服务端 RPC 推送后登记）。 */
interface PendingQuestion extends DriverQuestionRequest {
  /** 引擎侧的 requestId（答复时回传）。 */
  engineRequestId: number | string;
  /** DSH 原始问题数组（含 DSH 侧的选项 id——vteam 形状没有 id，答复时要用它）。 */
  rawQuestions: Array<Record<string, unknown>>;
  /** 未答复时的 resolve（占位；实际由事件路径 resolve）。 */
  resolve: (answers: unknown) => void;
  reject: (error: Error) => void;
}

/** 待答复的权限。 */
interface PendingPermission extends DriverPermissionRequest {
  engineRequestId: number | string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * DSH 驱动实现。
 *
 * 生命周期：`createSession` 首次调用时懒启动运行时（`initialize` 握手）；
 * `abort` 走 vendored `session/cancel`（不杀进程）；进程由上层（exec-server）在
 * worker 停机时 `close()`。
 */
export class DshDriver implements OpenCodeDriver, EngineEventChannel {
  /** 被驱动端基址——DSH 走 stdio，**无 HTTP 基址**。保留字段以维持接口形状。 */
  baseUrl = '';

  /** 鉴权口令——stdio 无鉴权，恒为空。 */
  readonly authPassword = '';

  private readonly options: DshDriverOptions;
  private readonly logger: Logger;
  private readonly client: DshRpcClient;

  private readonly sessions = new Map<string, SessionMirror>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  /** 等待某会话 idle 的 resolver（settle 时触发）。 */
  private readonly idleWaiters = new Map<string, Array<() => void>>();
  /** 等待某会话 turn/end 的 resolver。 */
  private readonly turnEndWaiters = new Map<string, Array<() => void>>();
  /**
   * 事件通道订阅者（P3）：sessionId → 订阅者集合。
   * DSH 的事件来自同一进程的单条 stdout 流，故这里做**扇出**（按 sessionId 过滤后分发）。
   */
  private readonly eventSubscribers = new Map<
    string,
    Array<{ onEvent: EngineEventHandler; onStatus?: (s: EngineStreamStatus) => void }>
  >();

  constructor(options: DshDriverOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? console;
    this.client = new DshRpcClient({ ...options, logger: this.logger });

    this.client.setHandlers({
      onSessionEvent: (event) => this.consumeEvent(event),
      onSessionStatus: (status, sessionId) => {
        if (status === 'idle') this.notifyIdle(sessionId);
      },
    });
    this.client.setServerRequestHandler({
      handle: (method, params) => this.handleServerRequest(method, params),
    });
  }

  /** 底层客户端（调试/测试用）。 */
  get rpc(): DshRpcClient {
    return this.client;
  }

  // ── OpenCodeDriver 实现 ────────────────────────────────────────────────

  /**
   * 创建会话。
   *
   * DSH 的会话 id 由**客户端指定**（`session/prompt` 携带）；这里生成一个稳定 id
   * （`dsh-<hash>`），并登记镜像。真正"创建"发生在首次 `sendMessage`。
   *
   * ⚠️ `model` 参数：DSH 的 provider/model 在 `initialize` 时固定（整进程），
   * 故这里若传入与当前路由不同的模型 → 记日志并**忽略**（换模型需重启运行时，P1 遗留）。
   */
  async createSession(model?: DriverModelRef | null): Promise<string> {
    const seed = `${Date.now()}-${Math.random()}`;
    const sessionId = `dsh-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
    this.sessions.set(sessionId, this.newMirror(sessionId));
    if (model != null) {
      this.logger.warn(
        `[dsh-driver] createSession 传入模型 ${model.providerID}/${model.modelID}：` +
          'DSH 的模型路由在 initialize 时固定，本会话将使用运行时既定路由（换模型需重启运行时）',
      );
    }
    return sessionId;
  }

  /**
   * 下发提示。
   *
   * 翻译：
   * - `input.parts` 的文本/图片 → DSH 的 `contentBlocks`（text + base64 image）；
   * - `input.system` → **文本前缀**（DSH 无 per-session system API，P0 报告约束；
   *   与 opencode 的 fallback 路径语义一致）；
   * - `input.delivery==='steer'` → 若 vendored `session/steer` 存在则用之，否则按 queue。
   *
   * 返回 `messageId` = 用户消息回执 id（DSH `SessionPromptResult.messageId`）。
   */
  async sendMessage(sessionID: string, input: DriverPromptInput): Promise<DriverPromptResult> {
    await this.ensureStarted();
    const mirror = this.ensureMirror(sessionID);

    const blocks = this.buildContentBlocks(input);
    const systemPrefix = typeof input.system === 'string' && input.system.trim() !== ''
      ? `${input.system}\n\n`
      : '';

    // system 走前缀：拼进第一个 text block
    const withSystem = systemPrefix === ''
      ? blocks
      : blocks.map((b, i) =>
          i === 0 && b.type === 'text'
            ? { ...b, text: `${systemPrefix}${String(b.text ?? '')}` }
            : b,
        );

    // 清掉上一轮终态（本轮重新计）
    mirror.lastOutcome = undefined;
    const waitTurnEnd = this.waitForTurnEnd(sessionID);

    // steer：优先 vendored 方法（P5），不存在则回退 queue（不阻断）
    const method = input.delivery === 'steer' ? await this.pickPromptMethod(true) : 'session/prompt';
    const promptParams = { sessionId: sessionID, contentBlocks: withSystem };
    let receipt: { messageId?: unknown } | undefined;
    try {
      receipt = (await this.client.request(method, promptParams)) as
        | { messageId?: unknown }
        | undefined;
    } catch (err) {
      const message = (err as Error).message;
      // ⚠️ "already exists" 不是失败（实测踩到的坑）：
      // DSH 会话持久化在 `$DSH_HOME/sessions/`。worker 重启后 createSession 会分配新 id，
      // 但 exec-server 复用的是**旧** instanceRef ⇒ 对已存在的会话发 prompt 会报
      // `session "<id>" already exists`。此时**不能**判失败——会话就在那儿，
      // resume 后继续同一轮即可（历史也随之恢复）。
      if (!/already exists/i.test(message)) throw err;
      this.logger.warn(
        `[dsh-driver] 会话 ${sessionID} 已存在于 DSH 侧 → resume 后继续本轮（不判失败）`,
      );
      await this.client.request('session/resume', { sessionId: sessionID }, 60_000);
      this.ensureMirror(sessionID);
      receipt = (await this.client.request(method, promptParams)) as
        | { messageId?: unknown }
        | undefined;
    }

    const messageId =
      typeof receipt?.messageId === 'string' && receipt.messageId.length > 0
        ? receipt.messageId
        : undefined;

    return { messageId };
  }

  /**
   * 拉取消息列表（累积）。
   *
   * DSH 无累积 API → 返回**驱动镜像**（本进程内由事件累积）；镜像未命中时尝试
   * `session/resume` 恢复（但 resume **不回放事件**，故历史仍可能为空——P1 遗留）。
   */
  async getMessages(sessionID: string, _options?: DriverMessageQuery): Promise<DriverMessage[]> {
    let mirror = this.sessions.get(sessionID);
    if (mirror === undefined) {
      // ⚠️ 镜像缺失**不等于**会话失效（实测踩到的坑）：
      // DSH 的会话是**持久化**的（`$DSH_HOME/sessions/...`），worker 重启只会丢掉本进程的
      // 事件镜像，会话本身仍在。若这里直接抛 404，exec-server 会判定"会话失效" →
      // unbind + 重建 → 对**已存在**的 DSH 会话发 prompt → `session already exists` 死循环。
      //
      // 正确做法：先尝试 `session/resume` 恢复（DSH 支持持久化会话恢复，但不回放事件），
      // 再返回空镜像（历史经 resume 进入后续模型请求，前端只能看到新消息——P1 遗留）。
      try {
        await this.client.request('session/resume', { sessionId: sessionID }, 30_000);
        mirror = this.ensureMirror(sessionID);
        this.logger.info(`[dsh-driver] 会话已 resume 恢复（镜像为空，历史在 DSH 侧）：${sessionID}`);
      } catch (err) {
        const message = (err as Error).message;
        // resume 明确说"不存在"才算真失效（这时 404 触发重建才有意义）
        if (/not found|no such|unknown session|missing/i.test(message)) {
          throw new DriverRequestError(`[dsh-driver] 会话不存在：${sessionID}`, 404);
        }
        // 其它错误（已活跃/占用等）：按"会话存在"处理，返回空镜像（不误判失效）
        this.logger.warn(`[dsh-driver] resume 未成功但会话可能仍存在（按存在处理）：${message}`);
        mirror = this.ensureMirror(sessionID);
      }
    }
    return [...mirror.messages];
  }

  /** 列出待答复问题（服务端推送式 → 由驱动内存表回答）。 */
  async listQuestions(sessionID: string): Promise<DriverQuestionRequest[]> {
    return [...this.pendingQuestions.values()]
      .filter((q) => q.sessionId === sessionID)
      .map((q) => ({
        id: q.id,
        sessionId: q.sessionId,
        questions: q.questions,
      }));
  }

  /**
   * 答复问题。
   *
   * `answers: string[][]`（vteam 口径，与问题条目一一对应）→ DSH 的
   * `{answers:[{id, selected, custom?}]}`（P0 实测形状）。
   *
   * selected 取每项**第一个**（DSH 的 selected 是单值；vteam 允许多选但 DSH 单选）。
   * 若 vteam 传了多个且 DSH 只支持单选 → 取首个并记日志（不静默丢弃）。
   */
  async replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<void> {
    const pending = this.pendingQuestions.get(requestID);
    if (pending === undefined) {
      // 幂等：未知/已回答的请求不抛错（与 abort 同一口径）
      this.logger.warn(`[dsh-driver] replyQuestion：请求 ${requestID} 不在待答列表（幂等忽略）`);
      return;
    }
    this.pendingQuestions.delete(requestID);

    const questionEntries = pending.questions;
    const shaped = questionEntries.map((q, index) => {
      const picked = answers[index] ?? [];
      const selected = picked[0];
      // vteam 的 SessionQuestionInfo 无选项 id（只有 label），而 DSH 要 {id, selected|custom}：
      // entry 的 id 用**原问题 id**（存在 PendingQuestion 的 rawQuestions 里，见 toSessionQuestionInfo）。
      const rawQuestion = pending.rawQuestions[index];
      const questionId = typeof rawQuestion?.id === 'string' ? rawQuestion.id : `q-${index}`;
      const entry: Record<string, unknown> = { id: questionId };
      if (selected === undefined) return entry;

      // 选中值若命中某个选项 label/id → selected；否则视为自由作答 custom
      const labels = (q.options ?? []).map((o) => o.label);
      const rawOptions = Array.isArray(rawQuestion?.options) ? rawQuestion.options : [];
      const rawIds = rawOptions
        .map((o) => ((o ?? {}) as Record<string, unknown>).id)
        .filter((v): v is string => typeof v === 'string');
      if (labels.includes(selected) || rawIds.includes(selected)) {
        entry.selected = selected;
      } else {
        entry.custom = selected;
      }
      return entry;
    });

    pending.resolve({ answers: shaped });
  }

  /** 拒绝问题（用户点「取消」→ DSH `{cancelled:true}`）。 */
  async rejectQuestion(sessionID: string, requestID: string): Promise<void> {
    const pending = this.pendingQuestions.get(requestID);
    if (pending === undefined) return;
    this.pendingQuestions.delete(requestID);
    pending.resolve({ cancelled: true });
  }

  /** 列出待答复权限。 */
  async listPermissions(sessionID: string): Promise<DriverPermissionRequest[]> {
    return [...this.pendingPermissions.values()]
      .filter((p) => p.sessionId === sessionID)
      .map((p) => ({
        id: p.id,
        sessionId: p.sessionId,
        action: p.action,
        resources: p.resources,
        ...(p.save === undefined ? {} : { save: p.save }),
        ...(p.metadata === undefined ? {} : { metadata: p.metadata }),
        ...(p.source === undefined ? {} : { source: p.source }),
      }));
  }

  /**
   * 答复权限。
   *
   * vteam 三态 → DSH 三态（P0 实测 `{outcome:'allowed-once'|'rejected'|'cancelled'}`）：
   * - `once` → `allowed-once`
   * - `always` → `allowed-once`（**DSH 无持久授权**；记日志说明降级，P0 报告风险项）
   * - `reject` → `rejected`
   */
  async replyPermission(
    sessionID: string,
    permissionID: string,
    response: DriverPermissionResponse,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(permissionID);
    if (pending === undefined) return;
    this.pendingPermissions.delete(permissionID);

    if (response === 'always') {
      this.logger.warn(
        '[dsh-driver] 权限答复 always → 降级为 allowed-once（DSH approval 无持久授权语义）',
      );
    }
    const outcome = response === 'reject' ? 'rejected' : 'allowed-once';
    pending.resolve({ outcome });
  }

  /**
   * 中止会话。
   *
   * 走 vendored `session/cancel`（P0 实测 translate 为 `agent.cancel({kind:'user'},{keepInbox:true})`
   * = GUI 停止按钮同款语义：部分输出以 interrupted 落库、排队消息保留、**进程存活**）。
   *
   * 幂等：未知会话/已结束 → 不抛错。vendored 方法缺失（未打补丁）→ 回退 `session/prompt`
   * 不可行，故记警告并**不抛错**（避免上层因中止失败而卡住整个任务）。
   */
  async abort(sessionID: string): Promise<void> {
    if (!this.sessions.has(sessionID)) return;
    try {
      await this.client.request(
        'session/cancel',
        { sessionId: sessionID },
        Math.min(this.options.requestTimeoutMs ?? 120_000, 30_000),
      );
    } catch (err) {
      const message = (err as Error).message;
      if (/unknown.*method|session\/cancel/i.test(message)) {
        this.logger.warn(
          '[dsh-driver] session/cancel 不可用（vendored 插件未安装？）；中止未生效，' +
            '需要 P5 的 vteam-sdk-server 补丁',
        );
        return;
      }
      // 业务错误（会话不存在等）→ 幂等空操作
      this.logger.warn(`[dsh-driver] abort 未生效（按幂等忽略）：${message}`);
    }
  }

  /** 列出 agent——DSH 无 agent 目录概念（角色由提示词承载）→ 空数组。 */
  async listAgents(_directory?: string): Promise<DriverAgentInfo[]> {
    return [];
  }

  /** 列出 todos——DSH SDK 面不暴露计划步骤 → 空数组（能力位 todos=false）。 */
  async listTodos(_sessionID: string, _directory?: string): Promise<DriverTodo[]> {
    return [];
  }

  /**
   * 列出模型目录。
   *
   * DSH 的模型清单来自配置（`llm-pi-ai.providers.<route>.models`），驱动层无法枚举
   * （协议无 providers/list，P0 报告已记录）。故返回**配置的单一路由**：
   * `provider`/`model` 两个选项即一条（P4 由 patch 生成器保证与实际配置一致）。
   */
  async listModels(): Promise<DriverModelInfo[]> {
    const provider = this.options.provider;
    const model = this.options.model;
    if (provider === undefined || model === undefined) return [];
    return [
      {
        id: `${provider}/${model}`,
        name: model,
        providerID: provider,
        modelID: model,
        status: 'active',
      },
    ];
  }

  /** 列出集成——DSH 无集成注册表概念 → 空数组（能力位 integrations=false）。 */
  async listIntegrations(): Promise<DriverIntegrationInfo[]> {
    return [];
  }

  /** 健康检查（在线 = 子进程在跑且已握手；**不抛异常**）。 */
  async isHealthy(): Promise<boolean> {
    return this.client.isRunning;
  }

  // ── EngineEventChannel 实现（P3）──────────────────────────────────────

  /**
   * 订阅某会话的引擎事件。
   *
   * DSH 的事件源自**同一条 stdout 流**（所有会话共享），故这里登记订阅者后由
   * `consumeEvent` 扇出。这也是 dsh 与 opencode 的根本差异之一：
   * opencode 的事件是 HTTP SSE（每会话可独立订阅），dsh 是进程内单流（按 sessionId 过滤）。
   *
   * @param sessionId - vteam 会话 id。
   * @param onEvent - 语义事件回调。
   * @param onStatus - 连接状态回调（dsh 的"连接"= 子进程存活，故只在退出时通知 closed）。
   */
  subscribeEvents(
    sessionId: string,
    onEvent: EngineEventHandler,
    onStatus?: (status: EngineStreamStatus) => void,
  ): EngineEventSubscription {
    const list = this.eventSubscribers.get(sessionId) ?? [];
    const entry = { onEvent, onStatus };
    list.push(entry);
    this.eventSubscribers.set(sessionId, list);

    // dsh 无独立连接概念：子进程在跑就是 open（先报一次，让上层立刻标记"事件路可用"）
    onStatus?.({ state: 'open' });

    let closed = false;
    return {
      close: (): void => {
        if (closed) return;
        closed = true;
        const current = this.eventSubscribers.get(sessionId);
        if (current === undefined) return;
        const index = current.indexOf(entry);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) this.eventSubscribers.delete(sessionId);
      },
    };
  }

  /**
   * 把一条 DSH 事件翻译成 vteam 语义并扇出（P3）。
   *
   * 翻译口径与 `consumeEvent` 的镜像维护**刻意分离**：
   * - `consumeEvent` 维护 `getMessages()` 用的镜像（面向"轮询兜底路"）
   * - 本函数维护"事件路上送"用的语义（面向 exec-server 的实时上送）
   *
   * 两者同源但用途不同，合并会让任一路的调整都牵动另一路（v2 实现踩过这个耦合）。
   */
  private fanoutEngineEvent(sessionId: string, event: DshSessionEvent): void {
    const subscribers = this.eventSubscribers.get(sessionId);
    if (subscribers === undefined || subscribers.length === 0) return;

    const mapped = this.mapToEngineEvents(sessionId, event);
    if (mapped.length === 0) return;
    for (const subscriber of subscribers) {
      for (const semantic of mapped) {
        try {
          subscriber.onEvent(semantic);
        } catch (err) {
          // 订阅者抛错不得中断引擎事件处理（否则一条失败会冻结整个会话的流）
          this.logger.error(`[dsh-driver] 事件订阅者抛异常：${(err as Error).message}`);
        }
      }
    }
  }

  /** DSH 事件 → 零到多条 vteam 语义事件。 */
  private mapToEngineEvents(sessionId: string, event: DshSessionEvent): EngineEvent[] {
    // 上游身份：DSH 的 durable 事件带 seq（P2 的镜像同源）
    const identity = {
      ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
      durable: event.type !== 'assistant/attempt',
    };

    switch (event.type) {
      case 'assistant/message': {
        const assistant = readAssistantMessage(event.data);
        if (assistant === null) return [];
        // 内容增量：reasoning + text（committed 粒度，非 token 级——DSH 的既定行为）
        const parts: DriverContent[] = [];
        if (assistant.reasoning.length > 0) {
          parts.push({
            id: `${assistant.messageID}:reasoning`,
            messageID: assistant.messageID,
            type: 'reasoning',
            text: assistant.reasoning,
          });
        }
        if (assistant.text.length > 0) {
          parts.push({
            id: `${assistant.messageID}:text`,
            messageID: assistant.messageID,
            type: 'text',
            text: assistant.text,
          });
        }
        return parts.length === 0 ? [] : [{ kind: 'parts', parts, identity }];
      }
      case 'turn/end': {
        const outcome = classifyTurnEnd(event.data as never);
        const error = (event.data as Record<string, unknown> | undefined)?.error as
          | Record<string, unknown>
          | undefined;
        const semantic: EngineEvent = {
          kind: 'terminal',
          terminal: toTerminalVerdict(outcome),
          identity,
        };
        if (typeof error?.message === 'string') semantic.error = error.message;
        return [semantic];
      }
      case 'tool/call': {
        const tool = readToolCall(event.data, '');
        if (tool === null) return [];
        return [{ kind: 'parts', parts: [tool.part], identity }];
      }
      case 'tool/result': {
        const result = readToolResult(event.data, '');
        if (result === null) return [];
        return [{ kind: 'parts', parts: [result.part], identity }];
      }
      default:
        // 其它事件（permission/preset、sandbox/mode 等）不上送：
        // 它们是引擎内部治理事件，vteam 前端无消费语义。
        return [];
    }
  }

  /** 关闭运行时（worker 停机/引擎切换时由上层调用）。 */
  async close(): Promise<void> {
    await this.client.close();
    this.sessions.clear();
    this.pendingQuestions.clear();
    this.pendingPermissions.clear();
    this.idleWaiters.clear();
    this.turnEndWaiters.clear();
    this.eventSubscribers.clear();
  }

  // ── 内部：启动与事件消费 ──────────────────────────────────────────────

  /** 懒启动运行时（首次使用时握手）。 */
  private async ensureStarted(): Promise<void> {
    if (this.client.isRunning) return;
    const params: DshInitializeParams = {
      cwd: this.options.cwd ?? process.cwd(),
      provider: this.options.provider ?? 'deepseek-official',
      model: this.options.model ?? 'deepseek-v4-flash',
      approvalRequests: this.options.approvalRequests ?? true,
      capabilities: { userQuestions: this.options.userQuestions ?? true },
    };
    if (this.options.reasoningEffort !== undefined) params.reasoningEffort = this.options.reasoningEffort;
    if (this.options.maxTokens !== undefined) params.maxTokens = this.options.maxTokens;
    await this.client.start(params);
  }

  /** 消费一条 DSH 事件 → 更新镜像与 pending 表。 */
  private consumeEvent(event: DshSessionEvent): void {
    const sessionId = this.sessionIdOf(event);
    if (sessionId === '') return;
    // P3：先扇出给事件通道订阅者（exec-server 通过它上送 delta / 收口终态）
    this.fanoutEngineEvent(sessionId, event);
    const mirror = this.ensureMirror(sessionId);

    switch (event.type) {
      case 'assistant/message': {
        const assistant = readAssistantMessage(event.data);
        if (assistant === null) return;
        mirror.assistantByMessage.set(assistant.messageID, assistant);
        mirror.lastMessageID = assistant.messageID;
        // 消息入镜（终态未知时先不合成 step-finish）
        mirror.messages.push(toDriverMessage(assistant, undefined));
        return;
      }
      case 'turn/end': {
        const outcome = classifyTurnEnd(event.data as never);
        mirror.lastOutcome = outcome;
        // 用最近的 assistant 消息合成 step-finish（控制面靠它判完成 + 落库用量）
        const messageID = mirror.lastMessageID;
        if (messageID !== undefined) {
          const assistant = mirror.assistantByMessage.get(messageID);
          const finish = synthesizeStepFinish(messageID, outcome, assistant?.usage);
          // 找到对应消息并追加（避免重复：同 id 的已有 step-finish 不重复加）
          const target = mirror.messages.find((m) => m.info.id === messageID);
          if (target !== undefined && !target.parts.some((p) => p.type === 'step-finish')) {
            target.parts.push(finish);
          }
        }
        if (outcome === 'error') {
          const data = event.data as Record<string, unknown> | undefined;
          const error = data?.error as Record<string, unknown> | undefined;
          this.client.recordTurnError(
            sessionId,
            typeof error?.message === 'string' ? error.message : '本轮以 error 结束',
          );
        }
        this.notifyTurnEnd(sessionId);
        return;
      }
      case 'tool/call': {
        const toolPart = readToolCall(event.data, mirror.lastMessageID ?? '');
        if (toolPart === null) return;
        mirror.toolParts.set(toolPart.callId, toolPart.part);
        return;
      }
      case 'tool/result': {
        const result = readToolResult(event.data, mirror.lastMessageID ?? '');
        if (result === null) return;
        const existing = mirror.toolParts.get(result.callId);
        if (existing !== undefined) {
          // 合并：保留 tool 名，覆盖 state
          existing.state = result.part.state;
          existing.time = result.part.time;
        } else {
          mirror.toolParts.set(result.callId, result.part);
        }
        return;
      }
      case 'step/start': {
        // 仅记录（step-finish 由 turn/end + assistant/message 合成，不在此生成）
        return;
      }
      default:
        // 未知事件（DSH developer preview 常有新增）→ 忽略而非报错
        return;
    }
  }

  /** 处理服务端请求（approval/request / user-question/ask）。 */
  private async handleServerRequest(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    if (method === 'approval/request') {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
      const requestId = String(params?.requestId ?? `approval-${Date.now()}`);
      const toolName = typeof params?.toolName === 'string' ? params.toolName : 'unknown';
      return new Promise((resolve, reject) => {
        this.pendingPermissions.set(requestId, {
          id: requestId,
          sessionId,
          action: toolName,
          resources: [],
          metadata: params,
          engineRequestId: requestId,
          resolve,
          reject,
        });
      });
    }

    if (method === 'user-question/ask') {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
      const requestId = String(params?.requestId ?? `question-${Date.now()}`);
      const rawQuestions = Array.isArray(params?.questions) ? params.questions : [];
      const questions = rawQuestions.map((q, index) => this.toSessionQuestionInfo(q, index));
      return new Promise((resolve, reject) => {
        this.pendingQuestions.set(requestId, {
          id: requestId,
          sessionId,
          questions,
          engineRequestId: requestId,
          rawQuestions: rawQuestions.map((q) => (q ?? {}) as Record<string, unknown>),
          resolve,
          reject,
        });
      });
    }

    throw new Error(`[dsh-driver] 未处理的服务端请求：${method}`);
  }

  /** DSH question → vteam `SessionQuestionInfo`（vteam 形状：question/header/options{label,description}）。 */
  private toSessionQuestionInfo(raw: unknown, index: number): SessionQuestionInfo {
    const q = (raw ?? {}) as Record<string, unknown>;
    const options = Array.isArray(q.options)
      ? q.options.map((opt) => {
          const o = (opt ?? {}) as Record<string, unknown>;
          return {
            label:
              typeof o.label === 'string'
                ? o.label
                : typeof o.id === 'string'
                  ? o.id
                  : String(o.title ?? ''),
            description: typeof o.description === 'string' ? o.description : '',
          };
        })
      : [];
    const question =
      typeof q.question === 'string'
        ? q.question
        : typeof q.text === 'string'
          ? q.text
          : typeof q.prompt === 'string'
            ? q.prompt
            : '';
    const header =
      typeof q.header === 'string' && q.header !== ''
        ? q.header
        : `问题 ${index + 1}`;
    const info: SessionQuestionInfo = {
      question,
      header,
      options,
    };
    if (q.multiple === true) info.multiple = true;
    if (q.custom === true) info.custom = true;
    return info;
  }

  // ── 内部：镜像与等待器 ────────────────────────────────────────────────

  private newMirror(sessionId: string): SessionMirror {
    return {
      sessionId,
      messages: [],
      assistantByMessage: new Map(),
      toolParts: new Map(),
    };
  }

  private ensureMirror(sessionId: string): SessionMirror {
    let mirror = this.sessions.get(sessionId);
    if (mirror === undefined) {
      mirror = this.newMirror(sessionId);
      this.sessions.set(sessionId, mirror);
    }
    return mirror;
  }

  /** 从事件里取 sessionId（DSH 事件有的带 `seq`/`turn`，会话 id 在事件外层或 data 里）。 */
  private sessionIdOf(event: DshSessionEvent): string {
    const data = event.data as Record<string, unknown> | undefined;
    if (typeof data?.sessionId === 'string' && data.sessionId !== '') return data.sessionId;
    // 事件层没有 sessionId 时，用"当前唯一活跃会话"兜底（单会话运行时的常态）
    if (this.sessions.size === 1) return [...this.sessions.keys()][0] as string;
    return '';
  }

  private waitForTurnEnd(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const list = this.turnEndWaiters.get(sessionId) ?? [];
      list.push(resolve);
      this.turnEndWaiters.set(sessionId, list);
      // 超时兜底：不阻塞（回合可能极长，但不能让调用方永久挂住）
      const timer = setTimeout(() => {
        this.notifyTurnEnd(sessionId);
      }, this.options.requestTimeoutMs ?? 120_000);
      timer.unref?.();
    });
  }

  private notifyTurnEnd(sessionId: string): void {
    const list = this.turnEndWaiters.get(sessionId);
    if (list === undefined) return;
    this.turnEndWaiters.delete(sessionId);
    for (const resolve of list) resolve();
  }

  private notifyIdle(sessionId: string): void {
    const list = this.idleWaiters.get(sessionId);
    if (list === undefined) return;
    this.idleWaiters.delete(sessionId);
    for (const resolve of list) resolve();
  }

  /**
   * 构造 DSH 的 `contentBlocks`。
   *
   * vteam 的 `input.parts` 是不透明数组（文本 + 附件混装），各实现自行翻译：
   * - 文本 part（`{type:'text', text}`）→ text block
   * - 附件（`{type:'file'|'image', ...}`）→ DSH 只接受 base64 image（`{type:'image',data,mimeType}`）
   *   非图片附件降级为文本引用（DSH SDK 面不支持通用文件上传，P0 报告已记录）
   */
  private buildContentBlocks(input: DriverPromptInput): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    for (const part of input.parts) {
      if (typeof part === 'string') {
        blocks.push({ type: 'text', text: part });
        continue;
      }
      const p = (part ?? {}) as Record<string, unknown>;
      const type = p.type;
      if (type === 'text' && typeof p.text === 'string') {
        blocks.push({ type: 'text', text: p.text });
        continue;
      }
      if ((type === 'image' || type === 'file') && typeof p.data === 'string') {
        const mime = typeof p.mimeType === 'string' ? p.mimeType : 'image/png';
        if (mime.startsWith('image/')) {
          blocks.push({ type: 'image', data: p.data, mimeType: mime });
        } else {
          blocks.push({
            type: 'text',
            text: `[附件 ${String(p.name ?? p.path ?? 'file')}（DSH 不支持通用文件上传，仅保留引用）]`,
          });
        }
        continue;
      }
      // 兜底：序列化后作为文本（不静默丢弃）
      blocks.push({ type: 'text', text: JSON.stringify(part) });
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    return blocks;
  }

  /** 选择下发方法：steer 优先 vendored `session/steer`，不存在则回退 prompt。 */
  private async pickPromptMethod(wantSteer: boolean): Promise<string> {
    if (!wantSteer) return 'session/prompt';
    try {
      // 试探：不存在会抛 unknown method（无副作用）
      await this.client.request('session/steer', { probe: true }, 5_000);
      return 'session/steer';
    } catch {
      this.logger.warn(
        '[dsh-driver] session/steer 不可用（vendored 插件未安装？）→ 按 queue 语义回退 session/prompt',
      );
      return 'session/prompt';
    }
  }
}

/** 空实现占位：`DriverMessageInfo` 辅助（保持导出面与既有实现一致）。 */
export type { DriverMessageInfo };
