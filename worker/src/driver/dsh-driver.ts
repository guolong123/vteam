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
  type DriverTokenUsage,
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
  /**
   * 系统提示词是否已在本会话发送过（**只发一次**）。
   *
   * 为什么必须只在首次发送：DSH 会话是**持久化**的，多轮复用同一会话。若每轮都把整份
   * system 前缀再拼进用户消息——① 对话框里每轮出现同一大段文本（用户可见噪音）；
   * ② 每轮重复消耗 token（vteam 的 system 含完整岗位职责/协作协议，上千 token）；
   * ③ 破坏 KV cache 前缀稳定性。
   * system 在同一会话内稳定（角色不变），故首轮注入即可。
   * 会话 resume 后 mirror 从空开始 → 会重发一次（可接受：resume 不回放事件，
   * 且此时模型上下文里确实没有本轮 system）。
   */
  systemSent?: boolean;
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
  /**
   * 当前进行中 turn 的聚合消息（**一次 turn = 一条 vteam 消息**）。
   *
   * 为什么需要聚合：DSH 的一轮任务会产出**多个** assistant/message（每个 step 一条，
   * 实测一轮 5 条不同 messageID）。若逐条塞进 mirror，exec-server 会把整轮内容
   * 归并到**同一条** vteam 消息里（控制面按"一次执行 = 一条 agent 消息"聚合），
   * 结果是多轮内容挤在一条消息、part 顺序混乱、前端渲染成一大坨碎块。
   * 正确做法：turn 内累积 parts，turn/end 时一次性定稿成一条消息。
   */
  pendingTurn?: {
    /** 聚合后的 part 列表（按到达顺序）。 */
    parts: DriverContent[];
    /** 本轮最后一条 assistant 消息 id（step-finish 的 id 前缀）。 */
    lastMessageID?: string;
    /** 本轮 usage（取最后一个非空值；DSH 的 usage 是逐 step 的）。 */
    usage?: DriverTokenUsage;
    providerID?: string;
    modelID?: string;
  };
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

  /**
   * `session/steer` 可用性缓存（P5）：undefined = 未探测，true/false = 已确定。
   * 见 pickPromptMethod（避免每轮多一次试探往返）。
   */
  private steerSupported: boolean | undefined;

  /** 模型路由切换互斥标记（切换 = 关运行时，避免并发切换把运行时关两次）。 */
  private switching = false;

  /**
   * 已**实际应用**的 persona（用于幂等判断，避免每轮都重启运行时）。
   *
   * 与 `options.env.DSH_SYSTEM_PROMPT` 的区别：后者是"期望值"（构造时可能已有初值），
   * 本字段只在切换**成功**后更新。不区分这两者会导致：
   * 有初值时第一轮误判"已切换"→ 跳过重启 → persona 实际没生效。
   */
  private appliedPersona: string | undefined;

  /**
   * 会话别名：上层持有的旧 id → 实际在用的 DSH 会话 id。
   *
   * 为什么需要：DSH 会话可能因 write handle 锁冲突而不可 resume（实测重启运行时后），
   * 此时驱动新建会话 id 继续，但 exec-server 仍以旧 id 调用（getMessages/abort 等）。
   * 别名表把旧 id 的调用解析到新 id，避免上层"会话失效"误判 + 重建循环。
   */
  private readonly sessionAliases = new Map<string, string>();

  /**
   * P6：是否启用 **agent-preset 模式**（roster 已注入时由 worker 置 true）。
   *
   * 启用后：不再用 `switchPersona`（避免每轮/每次换角色都重启运行时）。
   * 角色身份由 `session/create` 时绑定的 preset 承载（真实提示词仍经 persona 通道
   * 注入到该 preset 的 prefix，见 `switchPersona` 的注释——两者不冲突，
   * 但 preset 模式下切换成本从"重启"降为"仅首次创建时设置"）。
   *
   * ⚠️ 实际行为差异：preset 模式下 `input.system` 仍会进 persona env（
   * 否则丢失 server 下发的完整角色提示词），但**只在会话首次创建时**设置一次
   * （同一运行时的不同会话可各自持有不同 persona —— 这是 preset 的核心收益）。
   */
  private presetMode = false;

  /**
   * 已通过 preset 绑定 persona 的会话（这些会话不再走进程级 `switchPersona`）。
   *
   * 为什么需要区分：preset 是**会话级**（每个会话自己的 persona prefix），
   * 进程级 switchPersona 是**全局**的（会重启运行时影响所有会话）。
   * 混合使用会互相踩踏：已有 preset 的会话被进程级 persona 覆盖后，
   * 该会话的角色提示词就丢了。
   */
  private readonly presetBoundSessions = new Set<string>();

  /** createSession 时指定的 preset 身份（供 sendMessage 首次绑定时复用）。 */
  private readonly pendingPresetIds = new Map<string, string>();

  /**
   * preset 注册/绑定的**串行队列**。
   *
   * 为什么必须串行（实测踩坑）：多个会话并发绑定 preset 时，每个绑定都会触发
   * `agentPresets.select()` → `recompose()`（把 agent 挂到新的 plugin scope）。
   * 并发 recompose 会互相踩踏共享的 host context 状态 ⇒ **provider/model 被
   * 重置为内置默认 `deepseek-official`** ⇒ 报 no API key。
   * 实测：并发 4 个角色时只有 1 个路由正确，其余 3 个全部丢失 model。
   * 串行化后每个绑定独立完成，互不干扰。
   */
  private presetChain: Promise<unknown> = Promise.resolve();

  /** 启用/停用 preset 模式（worker 注入 roster 后调用）。 */
  setPresetMode(enabled: boolean): void {
    this.presetMode = enabled;
  }

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
  async createSession(
    model?: DriverModelRef | null,
    agentPreset?: string,
  ): Promise<string> {
    const seed = `${Date.now()}-${Math.random()}`;
    const sessionId = `dsh-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
    this.sessions.set(sessionId, this.newMirror(sessionId));

    // P5：UI 配置的模型**必须生效**（用户要求"界面配置的内容能下发到 worker"）。
    //
    // DSH 的 provider/model 在 initialize 握手时固定（协议无 per-session 选择）。
    // 故策略：目标模型与当前路由不一致 ⇒ **重启运行时**并用新路由握手。
    // 代价：重启约 1s（P0 实测 initialize 952ms），且需等当前无在途回合；
    // 收益：Agent/成员页配的模型立刻生效，与 opencode 模式行为对齐。
    //
    // ⚠️ 已有会话在重启后会按需 `session/resume` 恢复（历史在 DSH 侧持久化，
    // 不回放事件），故重启不会丢对话。
    if (model != null) {
      const target = `${model.providerID}/${model.modelID}`;
      const current =
        `${this.options.provider ?? ''}/${this.options.model ?? ''}`;
      if (target !== current) {
        await this.switchRoute(model.providerID, model.modelID);
      }
    }

    // P6：绑定 Agent preset（= vteam 的 Agent 身份）。
    //
    // 为什么在 createSession 而不是 sendMessage：DSH 的 `agentPresets.select()`
    // 要求会话**尚未开始首个 turn**（`agent-preset/locked`）。session/prompt 会隐式
    // 建会话并立刻开 turn，那时已经晚了 ⇒ 必须"先建会话 + 立刻选 preset"。
    //
    // 这取代了早期的"进程级 persona + 重启运行时"方案：
    // - 多角色**共享同一运行时**（一个进程承载 PM/开发/测试，省 ~2/3 内存）
    // - 切换**零重启**
    if (agentPreset !== undefined && agentPreset !== '') {
      // 记录身份，**不在此处绑定**：此时拿不到 system（角色提示词在 execute 时才构建）。
      // 真正绑定发生在 sendMessage 首次拿到 system 时（那里才有时机与内容）。
      this.pendingPresetIds.set(sessionId, agentPreset);
      try {
        const result = (await this.client.request('session/create', {
          sessionId,
          agentPreset,
        })) as { agentPreset?: string | null } | undefined;
        this.logger.info(
          `[dsh-driver] 会话 ${sessionId} 绑定 preset=${agentPreset}（registry 返回 ${String(result?.agentPreset)}）`,
        );
      } catch (err) {
        this.logger.warn(
          `[dsh-driver] preset 绑定失败（退回默认 persona）：${(err as Error).message}`,
        );
      }
    }
    return sessionId;
  }

  /**
   * 切换模型路由（重启运行时并以新路由握手）。
   *
   * 为什么必须重启：DSH 的 `initialize` 携带 provider/model 且服务端会校验该路由
   * （P0 实测 `no adapter registered for provider "..."` 即此校验），协议里**没有**
   * per-session 或 per-prompt 的模型选择方法。所以"换模型"在 DSH 上等价于"换运行时"。
   *
   * 幂等：目标与当前一致时直接返回。
   */
  private async switchRoute(providerID: string, modelID: string): Promise<void> {
    if (this.switching === true) return;
    this.switching = true;
    try {
      this.logger.info(
        `[dsh-driver] 模型路由切换：${this.options.provider}/${this.options.model} → ${providerID}/${modelID}（重启运行时）`,
      );
      // ① 先停掉所有活跃回合并等它们收口：DSH 的会话有 **write handle 独占锁**
      //    （实测并发写会报 `session "..." is already owned by an active write handle`）。
      //    直接 close 运行时会让锁悬着 → 新运行时 resume 会撞锁。
      for (const sessionId of [...this.sessions.keys()]) {
        try {
          await this.client.request('session/cancel', { sessionId }, 10_000);
        } catch {
          // 会话不存在/无在途回合 → 正常
        }
      }
      // 给引擎一点时间释放 write handle（cancel 是异步收口）
      await new Promise((r) => setTimeout(r, 500));
      // ② 记录新路由（后续 ensureStarted 用它握手）
      this.options.provider = providerID;
      this.options.model = modelID;
      // ③ 关掉旧运行时（close 会重置于 initialized）
      await this.client.close();
      // ④ 清空会话镜像但**保留会话 id**（历史在 DSH 侧持久化，resume 可恢复）
      for (const mirror of this.sessions.values()) {
        mirror.messages = [];
        mirror.assistantByMessage.clear();
        mirror.toolParts.clear();
        mirror.pendingTurn = undefined;
        // system 已注入过（历史里在）→ 不重复
        mirror.systemSent = true;
      }
    } finally {
      this.switching = false;
    }
  }


  /**
   * 该会话在**本运行时内**是否已活跃（决定能否用 steer 而非 prompt）。
   *
   * 判据（任一为真即可）：
   * - 有未定稿的 pendingTurn（本轮已在跑）；
   * - mirror 里已有消息（本轮之前跑过）；
   * - `session/prompt` 至少成功过一次（mirror.live 标记）。
   *
   * 为什么不用"会话在 DSH 侧是否存在"：那需要一次额外探测（session/resume 有副作用），
   * 而首轮本来就该走 prompt（它会自动建会话）。
   */
  private sessionIsLive(sessionID: string): boolean {
    const resolved = this.sessionAliases.get(sessionID) ?? sessionID;
    const mirror = this.sessions.get(resolved);
    if (mirror === undefined) return false;
    return mirror.messages.length > 0 || mirror.pendingTurn !== undefined;
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

    // **系统提示词走 persona 通道**（不是拼进用户消息）。
    //
    // 修正此前的错误做法：早期把 input.system 拼成用户消息前缀，导致
    // ① 用户消息里出现整坨系统提示（对话记录被污染）、② 每轮重复消耗 token、
    // ③ 破坏 KV cache 前缀稳定。
    //
    // 正确机制（源码核实）：DSH 的 `dsh-system-prompt` 支持 `personaPrefix`
    // （`packages/core/system-prompt/src/index.ts:437-446` 的 Config schema），
    // 值经 patch 的 `!!js process.env.DSH_SYSTEM_PROMPT` + spawn env 注入。
    // `sdk-minimal` profile 已用同一惯例（cordis.patch.yml:113-118）。
    //
    // 故：把 input.system 交给 `switchPersona`（进程级，切换时重启运行时），
    // **contentBlocks 保持纯净**（只有真正的用户内容）。
    const withSystem = blocks;

    // ══ 系统提示词：**运行时注册 preset**（P6 关键修复）══════════════════
    //
    // 此前的问题（用户实测发现）：patch 里没有 system-prompt 配置，env 也没传到
    // 子进程 ⇒ DSH 用的是它**自己的默认提示词**（Agent Teams / MCP resources /
    // present 工具…），vteam 的角色提示词完全丢失。
    //
    // 根因：DSH 的 system prompt 是 **profile 级**（patch + spawn env），而 env 是
    // 进程级 ⇒ 无法按会话区分。vteam 每个会话的角色不同，必须用**会话级**机制。
    //
    // 正确机制（源码核实）：`agentPresets.register({id, plugins})` 是**运行时 API**，
    // plugins 里的 `dsh-persona.prefix` 就是该 preset 的 system 提示词。
    // ⇒ 在**首次拿到 system 时**注册 preset 并绑定到本会话。
    //
    // 时机：必须在会话首个 turn 之前（`agent-preset/locked`）。sendMessage 在
    // session/prompt 之前执行，且此时会话已由 createSession 建好但尚未跑 turn ⇒ 满足。
    if (
      typeof input.system === 'string' &&
      input.system.trim() !== '' &&
      !this.presetBoundSessions.has(sessionID)
    ) {
      await this.ensureStarted();
      // preset id：优先用 createSession 指定的身份；否则用派发时的 agent 名；
      // 兜底用会话 id（保证唯一，避免与其它会话的 preset 冲突）
      const presetId =
        this.pendingPresetIds.get(sessionID) ??
        (typeof input.agent === 'string' && input.agent !== '' ? input.agent : `sess-${sessionID}`);
      const plugins: Array<Record<string, unknown>> = [
        {
          id: 'persona',
          name: '@deepseek-ai/dsh-persona',
          config: { prefix: input.system },
        },
        { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
        { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
      ];
      // ⚠️ **必须显式声明模型路由**（实测踩坑）：
      // preset 会创建独立的 plugin 子树，其 `agent-default-model` 若缺席则回落到
      // DSH 内置默认 `deepseek-official`（而 vteam 用的是 opencode-go 网关）
      // ⇒ 报 `llm-deepseek: no API key for provider route "deepseek-official"`。
      // 故把运行时 initialize 时确定的路由写进 preset。
      if (this.options.provider !== undefined && this.options.model !== undefined) {
        plugins.push({
          id: 'agent-default-model',
          name: '@deepseek-ai/dsh-agent-default-model',
          config: {
            provider: this.options.provider,
            model: this.options.model,
          },
        });
      }
      // 串行化（见 presetChain 说明）：并发 recompose 会踩踏 model 路由
      const task = this.presetChain.then(async () => {
        return (await this.client.request('session/create', {
          sessionId: sessionID,
          agentPreset: presetId,
          agentPresetPlugins: plugins,
          agentPresetName: presetId,
        })) as { agentPreset?: string | null } | undefined;
      });
      this.presetChain = task.catch(() => undefined);
      try {
        const result = await task;
        this.presetBoundSessions.add(sessionID);
        this.logger.info(
          `[dsh-driver] 会话 ${sessionID} 已绑定 preset=${presetId}` +
            `（persona 长度 ${input.system.length} 字，registry 返回 ${String(result?.agentPreset)}）`,
        );
      } catch (err) {
        // 绑定失败不阻断：退回"无系统提示"（至少能回复），但明确告警
        // （静默会让 agent 失去角色认知而用户毫不知情——本次实测就是这样）
        this.logger.error(
          `[dsh-driver] preset 绑定失败（本轮**无角色提示词**）：${(err as Error).message}`,
        );
      }
    }
    mirror.systemSent = true;

    // 清掉上一轮终态（本轮重新计）
    mirror.lastOutcome = undefined;
    const waitTurnEnd = this.waitForTurnEnd(sessionID);

    // steer：优先 vendored 方法（P5），不存在则回退 queue（不阻断）。
    //
    // ⚠️ **首轮必须走 session/prompt**：DSH 的 `session/prompt` 对未知 sessionId 会
    // **自动创建会话**，而 vendored 的 `session/steer` 要求会话已存在（否则
    // `session not found`）。故仅在「会话已在本运行时内活跃」时才用 steer
    // （= pendingTurn 存在 或 本轮之前已收到过事件）。
    const canSteer = this.sessionIsLive(sessionID);
    const method =
      input.delivery === 'steer' && canSteer
        ? await this.pickPromptMethod(true)
        : 'session/prompt';
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
        `[dsh-driver] 会话 ${sessionID} 已存在于 DSH 侧 → 尝试 resume 后继续本轮`,
      );
      // resume 可能失败：会话被**旧的 write handle 占用**（重启运行时后锁可能悬着，
      // 实测报 `is already owned by an active write handle`）。
      // 这种情况不能死循环重试：改为**新建会话 id**（放弃旧会话的 DSH 侧上下文），
      // 保证本轮能跑通。代价：该会话的 DSH 历史不再续接（vteam 侧历史仍在）。
      try {
        await this.client.request('session/resume', { sessionId: sessionID }, 60_000);
        this.ensureMirror(sessionID).systemSent = true;
        receipt = (await this.client.request(method, promptParams)) as
          | { messageId?: unknown }
          | undefined;
      } catch (resumeErr) {
        const resumeMessage = (resumeErr as Error).message;
        this.logger.warn(
          `[dsh-driver] resume 失败（${resumeMessage}）→ 放弃旧会话上下文，用新会话继续本轮`,
        );
        // 用带时间戳的新 id（旧 id 在 DSH 侧被锁，无法复用）
        const freshId = `${sessionID}-r${Date.now().toString(36)}`;
        this.sessions.delete(sessionID);
        const freshMirror = this.ensureMirror(freshId);
        // 新会话 = 空上下文 ⇒ **必须重新注入 system**（旧 withSystem 的 systemSent
        // 已置 true，但那属于旧会话；新会话若不带 system，agent 会失去全部角色/协作
        // 提示词，表现为"能回复但完全不懂 vteam 规则"）。
        freshMirror.systemSent = false;
        const freshBlocks =
          typeof input.system === 'string' && input.system.trim() !== ''
            ? (this.buildContentBlocks(input) as Array<Record<string, unknown>>).map((b, i) =>
                i === 0 && b.type === 'text'
                  ? { ...b, text: `${String(input.system)}\n\n${String(b.text ?? '')}` }
                  : b,
              )
            : this.buildContentBlocks(input);
        freshMirror.systemSent = true;
        receipt = (await this.client.request(method, {
          sessionId: freshId,
          contentBlocks: freshBlocks,
        })) as { messageId?: unknown } | undefined;
        // 把旧 id 的后续映射到新 id（上层仍用旧 id 调用 getMessages/abort）
        this.sessionAliases.set(sessionID, freshId);
        this.logger.info(
          `[dsh-driver] 会话别名：${sessionID} → ${freshId}（旧会话锁冲突已绕开，system 已重注入）`,
        );
      }
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
    // 别名解析：旧 id 可能已被新 id 取代（见 sessionAliases）
    const resolved = this.sessionAliases.get(sessionID) ?? sessionID;
    let mirror = this.sessions.get(resolved);
    if (mirror === undefined) {
      // ⚠️ 镜像缺失**不等于**会话失效（实测踩到的坑）：
      // DSH 的会话是**持久化**的（`$DSH_HOME/sessions/...`），worker 重启只会丢掉本进程的
      // 事件镜像，会话本身仍在。若这里直接抛 404，exec-server 会判定"会话失效" →
      // unbind + 重建 → 对**已存在**的 DSH 会话发 prompt → `session already exists` 死循环。
      //
      // 正确做法：先尝试 `session/resume` 恢复（DSH 支持持久化会话恢复，但不回放事件），
      // 再返回空镜像（历史经 resume 进入后续模型请求，前端只能看到新消息——P1 遗留）。
      try {
        // ⚠️ 时序：getMessages 可能在运行时未启动时被调用（exec-server 的轮询路）。
        // 此时 resume 会报"运行时未启动" ⇒ 误判为会话不存在 ⇒ 上层判定会话失效并重建。
        // 修复：先确保运行时启动，再 resume。
        if (!this.client.isRunning) await this.ensureStarted();
        await this.client.request('session/resume', { sessionId: sessionID }, 30_000);
        mirror = this.ensureMirror(sessionID);
        // resume 恢复了历史 ⇒ 历史首轮已含 system 前缀 ⇒ 后续不再重复拼接
        mirror.systemSent = true;
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
    const resolved = this.sessionAliases.get(sessionID) ?? sessionID;
    if (!this.sessions.has(resolved)) return;
    try {
      await this.client.request(
        'session/cancel',
        { sessionId: resolved },
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
  /**
   * 切换系统提示词（persona）。
   *
   * DSH 的 persona 是 **profile patch + spawn env** 两段式：patch 里写
   * `!!js process.env.DSH_SYSTEM_PROMPT ?? '<fallback>'`，真值由 env 注入。
   * ⇒ 换 persona 必须**重启运行时**（env 是进程级）。
   *
   * 与 `switchRoute`（换模型）共用同一套"先 cancel 释放锁 → close → 重开"的流程，
   * 因为它们都是"重启以改变进程级配置"。
   *
   * 幂等：目标与当前一致时直接返回。
   */
  async switchPersona(prefix: string, suffix?: string): Promise<boolean> {
    // 用**已应用**的 persona 判断（appliedPersona 在切换成功后才更新），
    // 避免读 options.env 的初始值导致"每次都以为没切换过"（每次重启运行时）。
    const current = this.appliedPersona ?? this.options.env?.DSH_SYSTEM_PROMPT ?? '';
    if (current === prefix) {
      return false;
    }
    if (this.switching) return false;
    this.switching = true;
    try {
      this.logger.info(
        `[dsh-driver] persona 切换（重启运行时）：${prefix.slice(0, 40)}…（长度 ${prefix.length}）`,
      );
      // 释放会话锁 + 关运行时（与 switchRoute 同一套）
      for (const sessionId of [...this.sessions.keys()]) {
        try {
          await this.client.request('session/cancel', { sessionId }, 10_000);
        } catch {
          // 会话不存在/无在途回合 → 正常
        }
      }
      await new Promise((r) => setTimeout(r, 300));
      this.options.env = {
        ...(this.options.env ?? {}),
        DSH_SYSTEM_PROMPT: prefix,
        ...(suffix === undefined ? {} : { DSH_SYSTEM_PROMPT_SUFFIX: suffix }),
      };
      this.appliedPersona = prefix;
      await this.client.close();
      // 清镜像（新 persona = 新上下文；systemSent 需重置以便重新注入）
      for (const mirror of this.sessions.values()) {
        mirror.messages = [];
        mirror.assistantByMessage.clear();
        mirror.toolParts.clear();
        mirror.pendingTurn = undefined;
        mirror.systemSent = false;
      }
      return true;
    } finally {
      this.switching = false;
    }
  }

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
        // 聚合到本轮（**不**立即入镜：一次 turn = 一条 vteam 消息，turn/end 时定稿）
        const turn = (mirror.pendingTurn ??= { parts: [] });
        turn.lastMessageID = assistant.messageID;
        if (assistant.usage !== undefined) turn.usage = assistant.usage;
        if (assistant.providerID !== undefined) turn.providerID = assistant.providerID;
        if (assistant.modelID !== undefined) turn.modelID = assistant.modelID;
        if (assistant.reasoning.length > 0) {
          turn.parts.push({
            id: `${assistant.messageID}:reasoning`,
            messageID: assistant.messageID,
            type: 'reasoning',
            text: assistant.reasoning,
          });
        }
        if (assistant.text.length > 0) {
          turn.parts.push({
            id: `${assistant.messageID}:text`,
            messageID: assistant.messageID,
            type: 'text',
            text: assistant.text,
          });
        }
        return;
      }
      case 'turn/end': {
        const outcome = classifyTurnEnd(event.data as never);
        mirror.lastOutcome = outcome;
        // 本轮定稿：聚合 parts + 合成 step-finish → **一条** vteam 消息入镜
        const turn = mirror.pendingTurn;
        if (turn !== undefined && turn.parts.length > 0) {
          const messageID = turn.lastMessageID ?? mirror.lastMessageID ?? `turn-${Date.now()}`;
          turn.parts.push(synthesizeStepFinish(messageID, outcome, turn.usage));
          const info: DriverMessageInfo = {
            id: messageID,
            role: 'assistant',
            time: { completed: Date.now() },
          };
          if (turn.providerID !== undefined) info.providerID = turn.providerID;
          if (turn.modelID !== undefined) info.modelID = turn.modelID;
          mirror.messages.push({ info, parts: turn.parts });
        }
        mirror.pendingTurn = undefined;
        if (turn !== undefined && turn.lastMessageID !== undefined) {
          mirror.lastMessageID = turn.lastMessageID;
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

  /**
   * 选择下发方法：steer 优先 vendored `session/steer`。
   *
   * **探测结果缓存**（P5）：早期实现每轮都发一次 `{probe:true}` 试探请求
   * （不存在会抛 unknown method），那会给每轮 steer 加一次往返。
   * 现在首次探测一次并缓存，vendored 未安装时永久回退（不再每轮试探）。
   */
  private async pickPromptMethod(wantSteer: boolean): Promise<string> {
    if (!wantSteer) return 'session/prompt';
    if (this.steerSupported === false) return 'session/prompt';
    if (this.steerSupported === true) return 'session/steer';
    try {
      // 探测：vendored 版本会走到「session not found」（说明**方法存在**），
      // 未 vendor 则抛 unknown method。用不存在的 id 探测 = 无副作用。
      await this.client.request('session/steer', { sessionId: '__probe__', contentBlocks: [] }, 5_000);
      this.steerSupported = true;
      this.logger.info('[dsh-driver] session/steer 可用（vendored SDK server）');
      return 'session/steer';
    } catch (err) {
      const message = (err as Error).message;
      // 三种结果必须区分（否则会把「方法存在但没会话」误判成「未 vendor」）：
      // ① unknown method → vendored 未安装（预期内降级，缓存 false）
      // ② session not found → **方法存在**（探测用假 id 的正常响应，缓存 true）
      // ③ 其它（运行时未启动等）→ 本次降级但**不缓存**（下次重试）
      if (/unknown DeepSeek Harness SDK runtime method|unknown.*session\/steer/i.test(message)) {
        this.steerSupported = false;
        this.logger.warn('[dsh-driver] session/steer 不可用（vendored SDK server 未安装）→ 回退 session/prompt');
      } else if (/session not found/i.test(message)) {
        this.steerSupported = true;
        this.logger.info('[dsh-driver] session/steer 可用（探测用假 id 得到 session not found）');
        return 'session/steer';
      } else {
        this.logger.warn(`[dsh-driver] session/steer 探测异常（本次回退，不缓存结论）：${message}`);
      }
      return 'session/prompt';
    }
  }
}

/** 空实现占位：`DriverMessageInfo` 辅助（保持导出面与既有实现一致）。 */
export type { DriverMessageInfo };
