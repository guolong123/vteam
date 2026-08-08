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
 *    - GET /api/model → {data:[{id, providerID, name}]}
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
}

/** 模型列表项（对齐 GET /api/model data 项；id=providerID/modelID）。 */
export interface DriverModelInfo {
  id: string;
  name: string;
  providerID: string;
  modelID: string;
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

/** 默认请求超时 ms（计划 D8 宽松验收 15s）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

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
   * 接线点（F2 M4）：T10 会话执行接入后此处成功后调 trackInstanceStart()；
   * abort/完成（task.completed）处调 trackInstanceEnd()，驱动心跳 load 计数。
   */
  async createSession(model?: DriverModelRef | null): Promise<string> {
    const res = await this.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { model: { ...model } } : {}),
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
          parts: input.parts,
        }),
      },
    );
    this.logger.info(`[v1-driver] sendMessage -> ${sessionID} (HTTP ${res.status})`);
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

  /** POST /session/{id}/abort：中止会话（D2：abort 后消息无 step-finish，完成判定不能是"有消息"）。 */
  async abort(sessionID: string): Promise<void> {
    const res = await this.request(`/session/${encodeURIComponent(sessionID)}/abort`, {
      method: 'POST',
    });
    this.logger.warn(`[v1-driver] abort -> ${sessionID} (HTTP ${res.status})`);
  }

  /**
   * GET /api/model：动态模型列表（实测 opencode 1.18.x 端点，返回
   * `{ location, data: [{id, providerID, family, name, cost...}] }`）。
   * id 映射为 providerID/modelID（对齐 D7/T11 的 defaultModelId 格式；
   * F2 MINOR：?? '' 兜底与 server worker.client.ts listModels 统一）。
   */
  async listModels(): Promise<DriverModelInfo[]> {
    const res = await this.request('/api/model');
    const body = (await res.json()) as {
      data?: Array<{ id?: string; providerID?: string; name?: string }>;
    };
    const data = body.data ?? [];
    return data.map((m) => ({
      id: `${m.providerID ?? ''}/${m.id ?? ''}`,
      name: m.name ?? m.id ?? '',
      providerID: m.providerID ?? '',
      modelID: m.id ?? '',
    }));
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
      if (!res.ok) {
        throw new DriverRequestError(`[v1-driver] ${path} HTTP ${res.status}`);
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
