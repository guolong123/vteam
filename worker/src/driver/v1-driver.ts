/**
 * T4 V1Driver：封装 opencode serve v1 REST API（真实 Agent 会话的核心）。
 *
 * 设计要点（对齐计划 D2 Oracle 实测铁律）：
 * 1. **裸 fetch 实现，不用 @opencode-ai/sdk**——SDK path key bug：promptAsync 类型声明
 *    {sessionID} 但运行时模板是 {id}（serve 实测 POST /session 返回 {id}），裸 fetch 规避。
 * 2. **端点**（实测 opencode 1.18.15 --pure，见 learnings T4）：
 *    - POST /session → {id}（非 {sessionID}）
 *    - POST /session/{id}/prompt_async?directory=...，body {model?, agent?, parts}，2xx=成功（实测 204）
 *    - GET /session/{id}/message → Array<{info, parts}>（poll 完成判定用）
 *    - POST /session/{id}/abort
 *    - GET /provider → {all:[{id, key, models:{<modelID>:{name}}}]}（listModels 主数据源）
 *    - GET /api/model → {data:[{id, providerID, name, status}]}（listModels 回退路径）
 *    - GET / 健康检查
 * 3. **鉴权**：Basic Auth username=opencode，密码=config.serverPassword（空=不鉴权）。
 * 4. **请求超时**：AbortController 15s 兜底防悬挂（prompt_async 为异步 204 快速返回）。
 * 5. baseUrl 可变：serve 启动成功后才确定（随机端口），index.ts 在 start() 后注入。
 *
 * 完成判定/轮询不在此文件（见 prompt-await.ts），本类只做 HTTP 契约。
 */

/** 最小日志接口（duck typing 对齐 OpencodeServer.Logger，避免跨模块强耦合）。 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface V1DriverOptions {
  /** serve baseUrl（http://127.0.0.1:<port>）；serve 启动前可留空，start 后 setBaseUrl 注入 */
  baseUrl?: string;
  /** serve 认证密码（OPENCODE_SERVER_PASSWORD，Basic Auth username=opencode）；空=不鉴权 */
  serverPassword?: string;
  /** 单次 HTTP 请求超时 ms；默认 15000 */
  timeoutMs?: number;
  /** 日志输出；默认 console */
  logger?: Logger;
}

/** 模型引用（opencode serve 格式 {providerID, modelID}，对齐计划 D7：defaultModelId 存 provider/model）。 */
export interface DriverModelRef {
  providerID: string;
  modelID: string;
}

/** sendMessage 入参（对齐 POST /session/{id}/prompt_async body + directory query）。 */
export interface SendMessageInput {
  /** 模型选择（可选，缺省 serve 默认模型） */
  model?: DriverModelRef | null;
  /** opencode agent 名（可选，缺省 serve 默认 agent） */
  agent?: string;
  /** 消息 parts（必填，如 [{type:'text', text}]，对齐 /doc parts:array required） */
  parts: unknown[];
  /** 工作目录（query 参数，D2：directory 是 prompt_async 的 query 参数） */
  directory?: string;
  /**
   * P7：顶层 system 字段（opencode prompt_async 契约）——注入系统提示（产出物协议/
   * @机制等），serve 将其拼入 LLM system message（role:system），不混入 user 消息，
   * 不会出现在会话回复/聊天记录中（区别于拼进 parts 文本）。
   */
  system?: string;
}

/** 模型列表项（id=providerID/modelID）。 */
export interface DriverModelInfo {
  id: string;
  name: string;
  providerID: string;
  modelID: string;
  /**
   * serve 模型状态（active/deprecated）；旧版 serve 可能缺失 → 可选，缺失视为可用。
   * 主路径（/provider 凭据认证）统一上报 'active'；/api/model 回退路径沿用
   * serve 返回的 status（CONF-01 过滤依据）。
   */
  status?: string;
}

/** step-finish 的 tokens 字段（实测含 total；SDK 类型声明缺 total，此处补全）。 */
export interface ServeTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/**
 * serve part（宽松结构，便于轮询完成判定 + T6 事件上送透传原始字段）。
 * 实测 types：step-start / text / reasoning / tool / step-finish / snapshot / patch / agent / retry / compaction。
 */
export interface ServePart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type: string;
  text?: string;
  /** step-finish 专用：reason=stop 是完整回复的判定条件（D2 铁律） */
  reason?: string;
  cost?: number;
  tokens?: ServeTokens;
  /** text part 的 {start,end} 毫秒时间戳（多段拼接排序依据）；部分 part 为 null */
  time?: { start?: number; end?: number; created?: number } | null;
  /** true=合成文本（工具调用占位，非模型真实输出），聚合时排除 */
  synthetic?: boolean;
  [key: string]: unknown;
}

/** GET /session/{id}/message 的元素（实测 Array<{info, parts}>）。 */
export interface ServeMessage {
  info: {
    id: string;
    role: 'user' | 'assistant';
    time?: { created?: number; completed?: number };
    error?: unknown;
    [key: string]: unknown;
  };
  parts: ServePart[];
}

/** GET /api/session/{id}/question data 元素（serve v2，QuestionV2Request）。 */
export interface ServeQuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
  tool?: { messageID: string; callID: string };
}

/** GET /permission 元素（serve v1 全局端点，PermissionV1Request）——兼容 v2 PermissionV2Request 字段。 */
export interface ServePermissionRequest {
  id: string;
  sessionID: string;
  /** v2 字段名（/api/session/{id}/permission）：action 名。 */
  action?: string;
  /** v2 字段名：资源模式数组。 */
  resources?: string[];
  /** v1 字段名（/permission）：action 名（如 external_directory/bash）。 */
  permission?: string;
  /** v1 字段名（/permission）：资源模式数组（如 ["/etc/*"]）。 */
  patterns?: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: unknown;
}

/** 默认请求超时 ms（计划 D8 宽松验收 15s）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** 请求失败（网络错/超时/HTTP 非 2xx），带 status 便于区分。 */
export class DriverRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DriverRequestError';
    this.status = status;
  }
}

export class V1Driver {
  private baseUrlValue: string;
  private readonly serverPassword: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: V1DriverOptions = {}) {
    this.baseUrlValue = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.serverPassword = options.serverPassword ?? '';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger ?? console;
  }

  /** 当前 serve baseUrl（空=尚未注入，T6 前 serve 未就绪）。 */
  get baseUrl(): string {
    return this.baseUrlValue;
  }

  /** serve 启动成功后注入实际 baseUrl（随机端口场景 index.ts 在 start() 后调用）。 */
  set baseUrl(url: string) {
    this.baseUrlValue = url.replace(/\/+$/, '');
    this.logger.info(`[v1-driver] baseUrl 更新: ${this.baseUrlValue}`);
  }

  /**
   * POST /session：创建 opencode 会话。
   * serve 实测返回 `{ id: "ses_..." }`（SDK 声明 {sessionID} 是错的根源），
   * 此处返回 sessionID 字符串供 T12 存 instanceRef 直接用。
   * ⚠️ serve 契约（实测 opencode 1.18.15）：POST /session **拒收 model 字段**
   * （带 model → 400，空 body → 200）——模型选择在 sendMessage（prompt_async）的
   * input.model 时指定（该端点接受 model）。此处签名保留 `model?` 参数仅为兼容
   * 调用方（server 侧 WorkerClient.createSession 同构），body 恒为 {}。
   * 接线点（F2 M4）：T10 会话执行接入后此处成功后调 trackInstanceStart()；
   * abort/完成（task.completed）处调 trackInstanceEnd()，驱动心跳 load 计数。
   */
  async createSession(model?: DriverModelRef | null): Promise<string> {
    const res = await this.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // serve 1.18.15 拒收 model → 空 body（模型经 sendMessage 的 input.model 指定）
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { id?: string; sessionID?: string };
    const sessionID = body.id ?? body.sessionID;
    if (!sessionID) {
      throw new DriverRequestError(`createSession 响应缺少 session id: ${JSON.stringify(body)}`);
    }
    this.logger.info(`[v1-driver] createSession -> ${sessionID}`);
    return sessionID;
  }

  /**
   * POST /session/{id}/prompt_async?directory=...：下发提示（异步，实测 204 快速返回）。
   * directory 是 query 参数（D2 铁律）；body {model, agent, parts}，2xx=成功。
   */
  async sendMessage(sessionID: string, input: SendMessageInput): Promise<void> {
    const query = new URLSearchParams();
    if (input.directory) {
      query.set('directory', input.directory);
    }
    const qs = query.toString();
    const res = await this.request(
      `/session/${encodeURIComponent(sessionID)}/prompt_async${qs ? `?${qs}` : ''}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(input.model ? { model: { ...input.model } } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.system ? { system: input.system } : {}),
          parts: input.parts,
        }),
      },
    );
    const modelLabel = input.model
      ? `${input.model.providerID}/${input.model.modelID}`
      : '(default)';
    this.logger.info(
      `[v1-driver] sendMessage -> ${sessionID} model=${modelLabel} (HTTP ${res.status})`,
    );
  }

  /**
   * GET /session/{id}/message：拉取会话消息列表（awaitCompletion 轮询用）。
   * 实测返回 Array<{info, parts}>；兼容 {data: [...]} 包裹。
   */
  async getMessages(sessionID: string): Promise<ServeMessage[]> {
    const res = await this.request(`/session/${encodeURIComponent(sessionID)}/message`);
    const body = (await res.json()) as ServeMessage[] | { data?: ServeMessage[] };
    return Array.isArray(body) ? body : (body.data ?? []);
  }

  /**
   * GET /question：列出该会话 pending 的 question 请求（serve v1 全局端点，实测有效）。
   *
   * ⚠️ 关键实证（opencode 1.18.16）：模型提问（AskInput/question 工具）走 **v1 Question
   * 通道**，pending 列表在全局 `GET /question`（返回数组，元素含 `sessionID`，requestId 为
   * `que_` 前缀，`tool:{messageID, callID}` 关联 tool part）。**v2 `GET /api/session/{id}/question`
   * 是独立 QuestionRequest 通道，实测始终返回 `{"data":[]}`**（即使会话存在 running 的
   * question part），若用它做检测 question 永不触发（线上 Bug1 根因）。此处按 sessionID 过滤
   * v1 全局列表，只返回当前会话的 pending question。
   */
  async listQuestions(sessionID: string): Promise<ServeQuestionRequest[]> {
    const res = await this.request(`/question`);
    const body = (await res.json()) as ServeQuestionRequest[] | { data?: ServeQuestionRequest[] };
    const all = Array.isArray(body) ? body : (body.data ?? []);
    return all.filter((q) => q.sessionID === sessionID);
  }

  /**
   * POST /question/{requestID}/reply：回答 question 请求（serve v1 端点，实测生效）。
   * body `{answers: Array<Array<string>>}`——answers 顺序对应 questions，每项为选中 label 数组；
   * 2xx=成功（实测 200，返回 true）。requestID 为 serve 下发的 id（que_ 前缀）。
   * ⚠️ v2 `POST /api/session/{id}/question/{requestID}/reply` 实测返回 404
   * （QuestionNotFoundError，v2 通道不含 v1 question），故必须走 v1 端点。
   */
  async replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<void> {
    const res = await this.request(`/question/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    this.logger.info(`[v1-driver] replyQuestion -> ${sessionID}/${requestID} (HTTP ${res.status})`);
  }

  /**
   * POST /question/{requestID}/reject：拒绝 question 请求（serve v1 端点，实测存在）。
   * 用户点「拒绝」时调用（serve 将 part 置为 status=error + "The user dismissed this
   * question"，deferred 结束）。requestID 不存在时返回 404 QuestionNotFoundError。
   */
  async rejectQuestion(sessionID: string, requestID: string): Promise<void> {
    const res = await this.request(`/question/${encodeURIComponent(requestID)}/reject`, {
      method: 'POST',
    });
    this.logger.info(`[v1-driver] rejectQuestion -> ${sessionID}/${requestID} (HTTP ${res.status})`);
  }

  /**
   * GET /permission：列出该会话 pending 的权限请求（serve v1 全局端点，实测有效）。
   *
   * ⚠️ 关键实证（opencode 1.18.16）：工具权限确认（bash/read 读外部目录等）走 **v1
   * Permission 通道**，pending 列表在全局 `GET /permission`（返回数组，元素含
   * `sessionID`，id 为 `per_` 前缀，`permission` 为 action 名，`patterns` 为资源模式，
   * `tool:{messageID, callID}` 关联 tool part）。**v2 `GET /api/session/{id}/permission`
   * 是独立 PermissionV2Request 通道，实测始终返回 `{"data":[]}`**（即使会话存在 running
   * 的 permission part），若用它做检测权限永不触发（线上 Bug2 根因，与 Bug1 question
   * 对称）。此处按 sessionID 过滤 v1 全局列表，只返回当前会话的 pending 权限，并把
   * v1 字段 `permission`/`patterns` 归一为 `action`/`resources`（detector 消费统一字段）。
   */
  async listPermissions(sessionID: string): Promise<ServePermissionRequest[]> {
    const res = await this.request(`/permission`);
    const body = (await res.json()) as ServePermissionRequest[] | { data?: ServePermissionRequest[] };
    const all = Array.isArray(body) ? body : (body.data ?? []);
    return all
      .filter((p) => p.sessionID === sessionID)
      .map((p) => ({
        id: p.id,
        sessionID: p.sessionID,
        action: p.action ?? p.permission ?? '',
        resources: p.resources ?? p.patterns ?? [],
        save: p.save,
        metadata: p.metadata,
        source: p.source,
      }));
  }

  /**
   * POST /permission/{requestID}/reply：回复权限确认（serve v1 全局端点，实测有效）。
   * body `{reply: "once"|"always"|"reject"}`；2xx=成功（实测 200，返回 `true`）。
   * ⚠️ v2 端点 `/api/session/{id}/permission/{requestID}/reply` 实测返回 404
   * （PermissionNotFoundError——v1 通道的权限请求 v2 端点不识别，与 Bug2 listPermissions
   * 对称），v1 端点 `/session/{id}/permissions/{permissionID}` 同样 404，故必须走 v1 全局
   * 端点 `/permission/{requestID}/reply`。permissionID 须为 serve 下发 id（per_ 前缀）。
   */
  async replyPermission(
    sessionID: string,
    permissionID: string,
    response: 'once' | 'always' | 'reject',
  ): Promise<void> {
    const res = await this.request(
      `/permission/${encodeURIComponent(permissionID)}/reply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: response }),
      },
    );
    this.logger.info(`[v1-driver] replyPermission -> ${sessionID}/${permissionID}=${response} (HTTP ${res.status})`);
  }

  /** POST /session/{id}/abort：中止会话（D2：abort 后消息无 step-finish，完成判定不能是"有消息"）。 */
  async abort(sessionID: string): Promise<void> {
    const res = await this.request(`/session/${encodeURIComponent(sessionID)}/abort`, {
      method: 'POST',
    });
    this.logger.warn(`[v1-driver] abort -> ${sessionID} (HTTP ${res.status})`);
  }

  /**
   * GET /provider：以"provider 有 key（凭据）+ opencode 免费内置"为上报依据。
   * 替代 /api/model active 过滤——serve 的 /api/model 只把 7 个免费 opencode 模型标
   * active，opencode-go 等有凭据 provider 的 18 个模型不在 active 列表（即使凭据已
   * 注入），导致 worker availability 漏报、assignWorker 模型过滤命中不了。
   * 实测 /provider 返回 `{all: [{id, name, source, env, key, options, models: {...}}]}`：
   * - provider.key 非空（已配凭据）→ 其 models 全部可用（凭据认证=可用）
   * - provider.id === 'opencode' 且无 key（免费内置）→ models 可用（免费模型）
   * - 其他无 key 的 provider（anthropic/openai 等未配凭据）→ 不收集（无凭据不可用）
   * 统一输出 status='active'（上报即视为可用）；/provider 失败（网络错/旧版 serve
   * 404）→ 回退 /api/model 逻辑（status===active 过滤，兼容旧版 serve，不阻断上报）。
   */
  async listModels(): Promise<DriverModelInfo[]> {
    try {
      const res = await this.request('/provider');
      if (!res.ok) {
        throw new DriverRequestError(`[v1-driver] /provider HTTP ${res.status}`, res.status);
      }
      const body = (await res.json()) as {
        all?: Array<{
          id?: string;
          key?: string;
          models?: Record<string, { name?: string }>;
        }>;
      };
      const models: DriverModelInfo[] = [];
      for (const provider of body.all ?? []) {
        const hasKey = typeof provider.key === 'string' && provider.key.length > 0;
        if (!hasKey && provider.id !== 'opencode') {
          continue;
        }
        const providerID = provider.id ?? '';
        for (const [modelID, model] of Object.entries(provider.models ?? {})) {
          models.push({
            id: `${providerID}/${modelID}`,
            name: (model && model.name) || modelID,
            providerID,
            modelID,
            status: 'active',
          });
        }
      }
      return models;
    } catch {
      return this.listModelsFromApiModel();
    }
  }

  /** /api/model 回退路径：映射 id=providerID/modelID + status===active（缺失视为可用）过滤。 */
  private async listModelsFromApiModel(): Promise<DriverModelInfo[]> {
    const res = await this.request('/api/model');
    const body = (await res.json()) as {
      data?: Array<{ id?: string; providerID?: string; name?: string; status?: string }>;
    };
    const data = body.data ?? [];
    return data
      .map((m) => ({
        id: `${m.providerID ?? ''}/${m.id ?? ''}`,
        name: m.name ?? m.id ?? '',
        providerID: m.providerID ?? '',
        modelID: m.id ?? '',
        status: m.status,
      }))
      .filter((m) => m.status === undefined || m.status === 'active');
  }

  /** GET /：健康检查（2xx → 在线；网络错/非 2xx → false，不抛异常）。 */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.request('/', { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 统一请求入口：拼 baseUrl、注入 Basic Auth、AbortController 超时、错误归类。 */
  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs: number = this.timeoutMs,
  ): Promise<Response> {
    if (!this.baseUrlValue) {
      throw new DriverRequestError(
        '[v1-driver] baseUrl 未设置：serve 尚未就绪（OpencodeServer.start() 完成后注入）',
      );
    }
    const headers = new Headers(init.headers);
    const auth = this.buildAuthHeader();
    if (auth) {
      headers.set('Authorization', auth);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrlValue}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      // 统一 2xx 校验（D2：prompt_async 204/200 均算成功）
      // status 必须透传：exec-server 的 isSessionNotFound 依赖 err.status === 404
      // 判定会话失效（serve 重启后旧 ses_ 会话不存在）并自动重建会话（45e0fdf）。
      if (!res.ok) {
        throw new DriverRequestError(`[v1-driver] ${path} HTTP ${res.status}`, res.status);
      }
      return res;
    } catch (err) {
      throw err instanceof DriverRequestError
        ? err
        : new DriverRequestError(this.describeError(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Basic Auth 头：password 为空（默认）→ 不鉴权；否则 `Basic base64(opencode:<password>)`。 */
  private buildAuthHeader(): string | undefined {
    if (!this.serverPassword) {
      return undefined;
    }
    return `Basic ${Buffer.from(`opencode:${this.serverPassword}`, 'utf8').toString('base64')}`;
  }

  /** 错误信息归一（超时/网络/HTTP 消息，Node 18+ fetch abort 抛 DOMException 非 Error 实例）。 */
  private describeError(err: unknown): string {
    const name =
      typeof err === 'object' && err !== null && 'name' in err
        ? (err as { name?: string }).name
        : undefined;
    if (name === 'AbortError') {
      return `[v1-driver] 请求超时（>${this.timeoutMs}ms）`;
    }
    if (err instanceof Error) {
      return `[v1-driver] ${err.message}`;
    }
    return `[v1-driver] ${String(err)}`;
  }
}
