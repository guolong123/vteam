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
  type DshTurnEndReason,
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

  /**
   * 流式累积文本（partId → 截至目前的完整文本）。
   *
   * DSH 的 `assistant/live-chunk` 是 token 级**增量**（text-delta 只带新增片段），
   * 而 exec-server 的增量准入是**单调全文**语义（拒绝同 part.id 文本变短）。
   * 故在此累积成全文再上送，复用既有准入逻辑（与 v2 SSE 口径一致）。
   *
   * ⚠️ **键必须带 sessionId 前缀**：本驱动服务**多个会话**（共享运行时模式，
   * 见 `engine/dsh/runtime.ts` 的 perSessionRuntime 说明），而 DSH 的
   * `turn`/`step`/`index` 都是**会话内**计数。键只用 `${turn}:${step}:${index}`
   * 会让不同会话撞车 —— A 会话的文本被拼进 B 会话的增量里。生命周期见
   * `clearLiveTexts`（turn/end 时按会话清理，避免 resume 后拼接陈旧文本）。
   */
  private readonly liveTexts = new Map<string, string>();

  /**
   * 每个会话当前生效的流式通道（`plugin` = durable plugin record，
   * `frame` = vendored `assistant/stream-frame`）。
   *
   * 为什么要记：vendor 脚本同时挂了 agent-loop 的 `live.push` hook 与 server 侧的
   * `agent/assistant-stream` 订阅，**同一个 chunk 会经两条通道各到一次**。
   * 两条都累积会让正文/思考翻倍（实测：思考行显示两遍相同文字）。
   * 故按会话做互斥，先到的那条通道生效，另一条丢弃。turn 结束时随 liveTexts 一起清。
   */
  private readonly liveChunkChannel = new Map<string, 'plugin' | 'frame'>();

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
    this.client = new DshRpcClient({
      ...options,
      // env 用**函数**形式：每次 spawn 时求值 ⇒ switchPersona 改完 options.env
      // 后，下一次重启（close + ensureStarted）能读到新 persona（实测踩坑：
      // 对象形式在构造时快照，导致 persona 永远不生效）。
      env: () => {
        const raw = this.options.env;
        if (raw === undefined) return {};
        return typeof raw === 'function' ? raw() : raw;
      },
      logger: this.logger,
    });

    this.client.setHandlers({
      // 信封 sessionId 一并透传：它才是事件的可靠归属来源（见 consumeEvent 说明）
      onSessionEvent: (event, sessionId) => this.consumeEvent(event, sessionId),
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
    agentSystem?: string,
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

    // ══ 角色身份（persona）══════════════════════════════════════════════
    //
    // **实测唯一可靠通道**：进程级 env `DSH_SYSTEM_PROMPT`
    // + patch 里 `system-prompt.personaPrefix: !!js process.env.DSH_SYSTEM_PROMPT`。
    //
    // 已排除的方案（附证据）：
    // ① 拼进用户消息前缀 —— 污染对话记录、每轮重复消耗 token（用户最初截图发现）
    // ② preset 内 `dsh-persona` 行 —— README 明确要求 **agent scope**，而
    //    `registry.register()` 建的是普通 scope ⇒ 挂载失败被静默记录，
    //    system 里仍是 DSH 默认提示词（实测 4351 字无角色内容）
    // ③ `meta.agentPreset` —— 只写会话事件、不激活 composition
    //    （packages/core/session/src/index.ts:1201）
    //
    // 因为 env 是进程级，**换角色需重启运行时**。多角色并发由上层
    // `DshRolePool` 保证：每个角色一个独立运行时进程（见 dsh-role-pool.ts）。
    // 即：本类实例 = 一个角色的运行时；跨角色并发不在这里处理。
    if (agentSystem !== undefined && agentSystem.trim() !== '') {
      await this.switchPersona(agentSystem);
    }
    if (agentPreset !== undefined && agentPreset !== '') {
      this.logger.info(
        `[dsh-driver] 会话 ${sessionId} 角色=${agentPreset}` +
          `（persona ${agentSystem === undefined ? 0 : agentSystem.length} 字进进程 env）`,
      );
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
    // 系统提示词：**每个角色运行时只注入一次**（进程级 env）。
    //
    // 为什么在 sendMessage 兜底：server 侧的 `buildSystemInstructions` 在 execute 时
    // 才构建（createSession 更早），故 createSession 拿到的 agentSystem 可能是空的。
    // 本驱动实例 = 一个角色的运行时 ⇒ 首次拿到 system 时切换 persona 并重启，
    // **persona 在本驱动建会话时已确定，这里绝不再切换**。
    //
    // 实测踩坑：sendMessage 里 switchPersona → close+重启运行时 → exec-server
    // 本轮开始前订阅的事件通道随即失效 ⇒ turn/end 收不到 ⇒ sendAndAwait 卡死
    // ⇒ 消息永久 processing、会话永久 running（用户截图"永久工作中"的根因）。
    // 且建会话 system（4534 字）与 execute system（5519 字）长度不同但语义完整，
    // 按"内容不同就切"会每轮都重启。故取建会话那份，本轮不动。
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
    // **镜像已存在 ⇒ 直接返回**（绝不 resume）。
    //
    // 本驱动亲手创建过该会话时镜像必然存在；此时对"尚未跑过 turn"或"正在跑 turn"
    // 的会话调 `session/resume` 会**挂住** ⇒ `awaitCompletion` 的轮询循环永久阻塞
    // ⇒ 即使 `turn/end` 已到达也无法退出 ⇒ 消息永久 processing、会话永久 running
    // （实测：turn/start=5 turn/end=5 但前端「工作中」永不消失）。
    if (mirror !== undefined) {
      return [...mirror.messages];
    }
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

  /**
   * 流式 part 的稳定 id。
   *
   * **必须含 sessionId**：本驱动服务多个会话，而 DSH 的 `turn`/`step`/`index`
   * 都是**会话内**计数 —— 不含 session 时不同会话会撞车（`liveTexts` 串扰）。
   *
   * 与终态 part id（`${messageID}:text`）不同是**刻意**的：终态由服务端
   * 「整体覆写同一 processing 行的 content」收敛（`worker-dispatcher.ts`
   * 的 task.completed 分支），不依赖两者 id 一致；反过来让流式 id 在
   * 多轮/多会话下唯一才是正确性所在。
   */
  private livePartId(sessionId: string, turn: unknown, step: unknown, index: number): string {
    return `${sessionId}:${String(turn)}:${String(step)}:${String(index)}`;
  }

  /**
   * 流式 chunk → 累积全文 part（三条增量事件共用）。
   *
   * 只有 text-delta / reasoning-delta 产生 part；tool-call/usage/finish 由
   * `assistant/message` 定稿统一处理。
   *
   * 为什么发**全文快照**而不是增量：exec-server 的 `tracker.admitSsePart` 是
   * "单调全文"准入 —— 同 part.id 拒绝文本变短。发纯增量（长度始终很小）会被
   * 判为"回退"而丢弃 ⇒ 前端无流式。
   */
  private accumulateChunkPart(
    sessionId: string,
    turn: unknown,
    step: unknown,
    chunk: Record<string, unknown>,
  ): EngineEvent[] {
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return [];
    const index = typeof chunk.index === 'number' ? chunk.index : 0;
    const text = typeof chunk.text === 'string' ? chunk.text : '';
    if (text === '') return [];
    const partId = this.livePartId(sessionId, turn, step, index);
    const accumulated = (this.liveTexts.get(partId) ?? '') + text;
    this.liveTexts.set(partId, accumulated);
    return [
      {
        kind: 'parts',
        parts: [
          {
            id: partId,
            type: chunk.type === 'text-delta' ? 'text' : 'reasoning',
            text: accumulated,
          } as unknown as DriverContent,
        ],
      },
    ];
  }

  /**
   * 清理指定会话的流式累积（turn 结束时调用）。
   *
   * 为什么需要：`liveTexts` 是 driver 级、生命周期与进程相同。DSH 会话是**持久化**
   * 的，worker 重启后 `session/resume` 会让 turn 计数从 1 重新开始 —— 若不清，
   * 新一轮的增量会拼在上一轮的陈旧文本后面（前端表现为正文突然多出一大段旧内容）。
   * 只删本会话前缀，避免误清其它并发会话的累积。
   */
  private clearLiveTexts(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.liveTexts.keys()) {
      if (key.startsWith(prefix)) this.liveTexts.delete(key);
    }
    // 通道互斥标记同理按会话清：新一轮重新竞争，避免上一轮的通道选择残留
    // （例如上一轮 hook 生效、这一轮 hook 失效只剩 stream-frame 时不会一直丢帧）。
    this.liveChunkChannel.delete(sessionId);
  }

  /** DSH 事件 → 零到多条 vteam 语义事件。 */
  private mapToEngineEvents(sessionId: string, event: DshSessionEvent): EngineEvent[] {
    // 上游身份：DSH 的 durable 事件带 seq（P2 的镜像同源）
    const identity = {
      ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
      durable: event.type !== 'assistant/attempt',
    };

    switch (event.type) {
      // ══ 流式 chunk（P7-b，vendored agent-loop hook）═══════════════════════
      //
      // vendored 的 `dsh-agent-loop` 在 `live.push(chunk)`（每个 token）处
      // `appendPluginRecord(session, 'plugin:vteam/stream-chunk', {turn, step, chunk})` ⇒
      // SDK server 的 `session/event` 订阅立刻转发 ⇒ 客户端拿到 token 级增量。
      //
      // 为什么不在 SDK server 订阅 `agent/assistant-stream`：该事件绑定在 agent
      // loopCtx 的 scope 上，server ctx 订阅零触发（实测）。
      case 'plugin:vteam/stream-chunk': {
        const data = event.data as
          | { turn?: unknown; step?: unknown; chunk?: Record<string, unknown> }
          | undefined;
        const chunk = data?.chunk;
        if (chunk === undefined) return [];
        this.liveChunkChannel.set(sessionId, 'plugin');
        return this.accumulateChunkPart(sessionId, data?.turn, data?.step, chunk);
      }
      // ══ 流式帧（P7，vendored 通道）══════════════════════════════════════
      //
      // vendored SDK server 订阅 DSH 内部的 `agent/assistant-stream`（token 级帧，
      // 见 packages/core/agent-loop/src/agent.ts:487-496），并以
      // `assistant/stream-frame` 经 session.event 实时通知。
      // 注意：上游 SDK 协议**没有**这条通道（`assistant/live-chunk` 只存在于
      // DSH Web GUI 客户端内部），故必须 vendor。
      //
      // ⚠️ **与上面的 `plugin:vteam/stream-chunk` 是同一批 chunk 的两条通道**：
      // vendor 脚本同时挂了「agent-loop 的 live.push hook」和「server 侧订阅
      // agent/assistant-stream」，所以每个 chunk 会到两次。若两条都累积，
      // 正文/思考会**翻倍重复**（实测表现：思考行显示两遍同样的文字）。
      // 故按会话做通道互斥：一旦本会话收到过 plugin record，就忽略 stream-frame。
      case 'assistant/stream-frame': {
        if (this.liveChunkChannel.get(sessionId) === 'plugin') return [];
        const frame = (event.data as { frame?: Record<string, unknown> } | undefined)?.frame;
        if (frame === undefined || frame.type !== 'chunk') return [];
        const chunk = frame.chunk as Record<string, unknown> | undefined;
        if (chunk === undefined) return [];
        this.liveChunkChannel.set(sessionId, 'frame');
        return this.accumulateChunkPart(sessionId, frame.turn, frame.step, chunk);
      }
      // ══ 流式增量（P7）══════════════════════════════════════════════════
      //
      // DSH 的 `assistant/live-chunk` 携带 token 级 `StreamChunk`
      // （packages/llm/llm/src/types.ts:496）。此前 vteam 只消费整段
      // `assistant/message` ⇒ **没有流式输出**（整块出现）。
      //
      // 映射 text-delta / reasoning-delta → `EngineEvent.parts`（exec-server 串行
      // 上送 message.part.delta，前端 onMessagePartDelta 消费）。
      // 聚合口径对齐 DSH 的 assistant.ts updateChunk（blocks[index] 累加）。
      case 'assistant/live-chunk': {
        const data = event.data as
          | { chunk?: Record<string, unknown>; turn?: unknown; step?: unknown }
          | undefined;
        const chunk = data?.chunk;
        if (chunk === undefined) return [];
        return this.accumulateChunkPart(sessionId, data?.turn, data?.step, chunk);
      }

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
        // ⚠️ **必须传 `data.reason`，不是 `data`**：DSH 的 turn/end 结构是
        // `{ turn, reason: { kind: 'completed'|'aborted'|'error' } }`
        // （实测 event: {"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}）。
        // 传整个 data 会让 classifyTurnEnd 读 `data.kind`（undefined）⇒ 一律判 error
        // ⇒ 合成的 step-finish reason=error ⇒ awaitCompletion 的 findFinish（只认 stop）
        // 永远不命中 ⇒ 无限轮询 ⇒ 消息永久 processing、会话永久 running。
        const outcome = classifyTurnEnd(
          (event.data as { reason?: DshTurnEndReason } | undefined)?.reason,
        );
        // 本轮已结束 → 释放本会话的流式累积。下一轮的 turn/step/index 会从新值
        // 开始，但 DSH 会话 resume 后计数可能回退，不清就会把上一轮的陈旧文本
        // 拼进新一轮增量（见 clearLiveTexts 说明）。
        this.clearLiveTexts(sessionId);
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
    const envMap =
      typeof this.options.env === 'function'
        ? this.options.env()
        : this.options.env;
    const current = this.appliedPersona ?? envMap?.DSH_SYSTEM_PROMPT ?? '';
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
      const existingEnv =
        typeof this.options.env === 'function' ? this.options.env() : (this.options.env ?? {});
      this.options.env = {
        ...existingEnv,
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

  /**
   * 消费一条 DSH 事件 → 更新镜像与 pending 表。
   *
   * @param envelopeSessionId - `session.event` 通知**信封**上的 sessionId。
   *   必须优先于启发式反推：`event.data` 里没有 sessionId，而一个驱动会服务多个
   *   会话（池代理的 `__default__` 角色尤其容易同时挂多个）。早先只靠启发式，
   *   多会话时必然判成「无归属」并丢弃 —— 流式 chunk 被丢 ⇒ 首字超时误报。
   */
  private consumeEvent(event: DshSessionEvent, envelopeSessionId?: string): void {
    const sessionId = this.sessionIdOf(event, envelopeSessionId);
    if (sessionId === '') {
      this.logger.warn('[dsh-driver] 事件无归属，丢弃 type=' + String(event.type));
      return;
    }
    if (event.type === 'turn/end' || event.type === 'assistant/message') {
      this.logger.info('[dsh-driver] consume ' + event.type + ' session=' + sessionId);
    }
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
        // ⚠️ **必须传 `data.reason`，不是 `data`**：DSH 的 turn/end 结构是
        // `{ turn, reason: { kind: 'completed'|'aborted'|'error' } }`
        // （实测 event: {"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}）。
        // 传整个 data 会让 classifyTurnEnd 读 `data.kind`（undefined）⇒ 一律判 error
        // ⇒ 合成的 step-finish reason=error ⇒ awaitCompletion 的 findFinish（只认 stop）
        // 永远不命中 ⇒ 无限轮询 ⇒ 消息永久 processing、会话永久 running。
        const outcome = classifyTurnEnd(
          (event.data as { reason?: DshTurnEndReason } | undefined)?.reason,
        );
        mirror.lastOutcome = outcome;
        // 本轮定稿：聚合 parts + 合成 step-finish → **一条** vteam 消息入镜
        const turn = mirror.pendingTurn;
        this.logger.info('[dsh-driver] turn/end 定稿: pendingTurn=' + (turn === undefined ? 'undefined' : 'parts=' + turn.parts.length) + ' mirror.messages=' + mirror.messages.length);
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
          this.logger.info('[dsh-driver] 定稿入镜: messages=' + mirror.messages.length + ' parts=' + turn.parts.length + ' hasStepFinish=' + turn.parts.some((p) => p.type === 'step-finish'));
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

  /** 公开入口：确保某会话的镜像存在（供池代理自愈登记时使用）。 */
  ensureMirrorFor(sessionId: string): void {
    this.ensureMirror(sessionId);
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
  private sessionIdOf(event: DshSessionEvent, envelopeSessionId?: string): string {
    // ⓪ 信封上的 sessionId 是最可靠的来源（`session.event` 由 server 按会话归属发出）。
    //    放在最前：`event.data` 里的 sessionId 只部分事件有，启发式在多会话时必然失效。
    if (typeof envelopeSessionId === 'string' && envelopeSessionId !== '') {
      return envelopeSessionId;
    }
    const data = event.data as Record<string, unknown> | undefined;
    if (typeof data?.sessionId === 'string' && data.sessionId !== '') return data.sessionId;
    // 事件层没有 sessionId 时兜底（池代理下同一角色多会话共用本实例，不能用 size===1 判断）：
    // ① 本驱动只有 1 个会话
    if (this.sessions.size === 1) return [...this.sessions.keys()][0] as string;
    // ② 恰好一个会话有在途 turn（pendingTurn）—— 流式增量都归属它
    const busy = [...this.sessions.entries()].filter(([, m]) => m.pendingTurn !== undefined);
    if (busy.length === 1) return busy[0][0];
    // ③ 恰好一个会话在等 turn 结束（流式期间的强信号）
    const waiting = [...this.turnEndWaiters.entries()].filter(([, list]) => list.length > 0);
    if (waiting.length === 1) return waiting[0][0];
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
