import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_WORKER_TOKEN } from './workers.constants';

/**
 * WorkerClient 错误码（T8，server→worker 的 HTTP 客户端）。
 * 统一 WORKER_UNAVAILABLE（503 语义）：worker 离线/连接失败/HTTP 非 2xx 均视为
 * 该 worker 当前不可用，供 T10「无可用 worker 报错」catch 后直接读 workerId。
 */
export const WORKER_CLIENT_ERRORS = {
  WORKER_UNAVAILABLE: 'WORKER_UNAVAILABLE',
} as const;

/**
 * worker 离线/请求失败异常（503，携带 workerId）。
 * T10 分派失败路径据此识别是哪个 worker 不可用并 emitError。
 */
export class WorkerUnavailableException extends ServiceUnavailableException {
  readonly workerId: string;

  constructor(workerId: string, detail: string) {
    super({
      code: WORKER_CLIENT_ERRORS.WORKER_UNAVAILABLE,
      message: `worker ${workerId} 不可用：${detail}`,
      workerId,
    });
    this.workerId = workerId;
  }
}

/** opencode serve 默认地址（计划 D2：随机端口，`--port 0` 时未知 → 约定默认 4199）。 */
export const DEFAULT_WORKER_BASE_URL = 'http://localhost:4199';
/**
 * 方案 A：worker 执行端点默认端口（对齐 worker config WORKER_EXEC_PORT=4198）。
 * 执行端点是独立于 serve 的 node:http 端口（POST /execute），server 侧在
 * capabilities.execBaseUrl 缺失时以 serve 基址 origin + ':' + execPort 拼接发现。
 */
export const DEFAULT_EXEC_PORT = 4198;
/** 单次 HTTP 请求超时：prompt_async 为异步 204 快速返回，getMessages 轮询稍慢，15s 兜底防悬挂。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** FR-41：GET /file 文件拉取超时（较大文件/网络慢，15s 兜底防悬挂）。 */
export const DEFAULT_FILE_FETCH_TIMEOUT_MS = 15_000;

/**
 * worker 行最小契约（Prisma Worker 的 id + capabilities Json；T10 传 findUnique 结果）。
 * capabilities 无 baseUrl 列（schema.prisma L365-381），约定从 capabilities Json 读
 * `baseUrl`/`port`，缺失时回退 WORKER_BASE_URL 配置。
 */
export interface WorkerEndpointRef {
  id: string;
  capabilities?: unknown;
}

/** promptAsync 请求体（对齐 opencode serve POST /session/{id}/prompt_async body + directory query）。 */
export interface PromptAsyncOptions {
  /** 模型选择（opencode serve 格式 { providerID, modelID }，对齐计划 D7：defaultModelId 存 provider/model）。 */
  model?: { providerID: string; modelID: string } | null;
  /** opencode agent 名（可选，缺省 serve 默认 agent）。 */
  agent?: string;
  /** 消息 parts（必填，如 [{type:'text', text}]，对齐 /doc parts:array required）。 */
  parts: unknown[];
  /** 工作目录（query 参数，对齐计划 D2：directory 是 prompt_async 的 query 参数）。 */
  directory?: string;
}

/** 模型列表项（T11 替换 STATIC_AVAILABLE_MODELS 的 {id,name} 结构；id=providerID/modelID）。 */
export interface WorkerModel {
  id: string;
  name: string;
  providerID: string;
  modelID: string;
}

/**
 * 方案 A：POST /execute 请求体（对齐 worker exec-server.ts ExecuteRequestPayload）。
 * worker 执行端点收到后立即 202 {accepted:true}（fire-and-forget），异步驱动 serve 并
 * 上送事件（session.updated/message.part.delta/task.completed/agent.status）；回复经
 * server ingress 回流落库，本客户端只保证「已受理」。
 * ⚠️ 字段名与 worker ExecuteRequestPayload.prompt 一一对应（worker 执行端点校验
 * `payload.prompt`，发送 `parts` 会 400「缺少必填字段 prompt」——wave1 对齐修复）。
 */
export interface ExecuteOptions {
  /** 提示内容：字符串（worker 归一为单 text part）或 parts 数组（透传 serve）。 */
  prompt: string | unknown[];
  /** 模型选择（opencode serve 格式 { providerID, modelID }）。 */
  model?: { providerID: string; modelID: string } | null;
  /** opencode agent 名（可选，缺省 serve 默认 agent）。 */
  agent?: string;
  /** 工作目录。 */
  directory?: string;
  /** P7：顶层 system 提示（产出物协议/@机制等，worker 透传 serve 拼入 LLM system message）。 */
  system?: string;
  /** 平台 Task 主键（t_ 前缀），事件回流透传。 */
  taskId?: string;
  /** Agent id（a_ 前缀），事件回流透传。 */
  agentId?: string;
  /** 消息来源频道 id，事件回流透传（server 据此群聊优先回结论）。 */
  channelId?: string;
  /** opencode 会话 id（ses_ 前缀，复用 serve 会话）；缺省则 worker 执行端点新建。 */
  sessionId?: string;
}

/**
 * WorkerClient（T8）：server→worker 的裸 fetch HTTP 客户端。
 *
 * - **不用 @opencode-ai/sdk**：SDK path key bug（声明 {sessionID} 实际 {id}）只影响 SDK，
 *   server 侧裸 fetch 规避（计划 D2 铁律）。
 * - **端点**（实测 opencode 1.18.15 serve，见 learnings）：POST /session、POST
 *   /session/{id}/prompt_async?directory=、POST /session/{id}/abort、GET /session/{id}/message、
 *   GET /api/model（模型列表）、GET / 健康检查。
 * - **鉴权**：serve Basic Auth（username=opencode，password=worker 侧 OPENCODE_SERVER_PASSWORD）；
 *   server 侧经 SERVER_PASSWORD 配置读取该密码，为空=不鉴权。
 * - **baseUrl**：Worker 表无 baseUrl 列，从 capabilities Json 读 `baseUrl`/`port`，否则回退
 *   WORKER_BASE_URL（默认 http://localhost:4199）。
 * - **错误**：fetch 网络错误/超时/HTTP 非 2xx → WorkerUnavailableException（503，带 workerId）。
 */
@Injectable()
export class WorkerClient {
  /** baseUrl 回退值（env WORKER_BASE_URL，默认 http://localhost:4199）；公开字段便于测试覆盖。 */
  public baseUrlFallback: string;
  /** serve Basic Auth 密码（env SERVER_PASSWORD，默认空=不鉴权）；公开字段便于测试覆盖。 */
  public serverPassword: string;
  /**
   * FR-41：exec 文件端点鉴权 token（env WORKER_TOKEN，默认 dev-worker-token），
   * 经 X-Worker-Token header 下发，与 worker 端 X_WORKER_TOKEN（compose 同一值）对齐。
   */
  public workerToken: string;

  constructor(config: ConfigService) {
    this.baseUrlFallback = config.get('WORKER_BASE_URL', DEFAULT_WORKER_BASE_URL);
    this.serverPassword = config.get('SERVER_PASSWORD', '');
    this.workerToken = config.get('WORKER_TOKEN', DEFAULT_WORKER_TOKEN);
  }

  /**
   * POST /session：创建 opencode 会话。
   * serve 实际返回 `{ id: "ses_..." }`（SDK 声明 {sessionID} 是错的），此处映射为
   * `{ sessionID }` 契约，T10/T12 存 instanceRef 直接用。
   * ⚠️ serve 契约（实测 opencode 1.18.15）：POST /session **拒收 model 字段**
   * （带 model → 400，空 body → 200）——模型选择经 promptAsync 的 opts.model 指定。
   * 签名保留 `model?` 参数仅为兼容调用方（worker-dispatcher.dispatchForTarget 传参），
   * 请求体恒为 {}。
   */
  async createSession(
    worker: WorkerEndpointRef,
    model?: { providerID: string; modelID: string } | null,
  ): Promise<{ sessionID: string }> {
    const res = await this.request(worker, '/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // serve 1.18.15 拒收 model → 空 body（模型经 promptAsync 的 opts.model 指定）
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new WorkerUnavailableException(worker.id, `createSession HTTP ${res.status}`);
    }
    const body = (await res.json()) as { id?: string; sessionID?: string };
    const sessionID = body.id ?? body.sessionID;
    if (!sessionID) {
      throw new WorkerUnavailableException(
        worker.id,
        `createSession 响应缺少 session id：${JSON.stringify(body)}`,
      );
    }
    return { sessionID };
  }

  /**
   * POST /session/{id}/prompt_async?directory=...：下发提示（异步，立即 204 返回）。
   * 204 视为成功；部分版本返回 200，统一按 2xx 接受。
   */
  async promptAsync(
    worker: WorkerEndpointRef,
    sessionID: string,
    opts: PromptAsyncOptions,
  ): Promise<void> {
    const query = new URLSearchParams();
    if (opts.directory) {
      query.set('directory', opts.directory);
    }
    const qs = query.toString();
    const res = await this.request(
      worker,
      `/session/${encodeURIComponent(sessionID)}/prompt_async${qs ? `?${qs}` : ''}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(opts.model ? { model: { ...opts.model } } : {}),
          ...(opts.agent ? { agent: opts.agent } : {}),
          parts: opts.parts,
        }),
      },
    );
    if (!res.ok) {
      throw new WorkerUnavailableException(worker.id, `prompt_async HTTP ${res.status}`);
    }
  }

  /**
   * 方案 A：POST /execute（worker 独立执行端点，fire-and-forget，202 accepted 即成功）。
   * - URL：capabilities.execBaseUrl（完整执行端点基址）→ 否则 serve 基址 origin + ':' +
   *   capabilities.execPort（缺省 DEFAULT_EXEC_PORT=4198）拼接——执行端点与 serve 是
   *   不同端口（worker 独立 node:http 监听），不能复用 serve baseUrl 直连；
   * - body：完整 ExecuteOptions（prompt/model/agent/directory/taskId/agentId/channelId/
   *   sessionId），事件回流经 ingress 落库，server 不再自持轮询。
   */
  async execute(worker: WorkerEndpointRef, opts: ExecuteOptions): Promise<void> {
    const res = await this.requestExec(worker, '/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(opts.model ? { model: { ...opts.model } } : {}),
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
        ...(opts.channelId ? { channelId: opts.channelId } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.directory ? { directory: opts.directory } : {}),
        ...(opts.system ? { system: opts.system } : {}),
        // 对齐 worker ExecuteRequestPayload.prompt（worker 执行端点校验该字段）
        prompt: opts.prompt,
      }),
    });
    if (!res.ok) {
      throw new WorkerUnavailableException(worker.id, `execute HTTP ${res.status}`);
    }
  }

  /**
   * FR-41：GET /file?path=<绝对路径>——从 worker 工作区拉取文件内容（二进制安全）。
   * 走 exec 端点（resolveExecBaseUrl），带 X-Worker-Token 鉴权（worker 端校验）。
   * 网络错误/超时 → WorkerUnavailableException（requestToUrl 归一）；HTTP 非 2xx
   * （401/404/413/400）→ WorkerUnavailableException（fetchFile 内判断，调用方降级）。
   */
  async fetchFile(worker: WorkerEndpointRef, filePath: string): Promise<Buffer> {
    const res = await this.requestExec(
      worker,
      `/file?path=${encodeURIComponent(filePath)}`,
      {
        method: 'GET',
        headers: { 'X-Worker-Token': this.workerToken },
      },
      DEFAULT_FILE_FETCH_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new WorkerUnavailableException(worker.id, `file fetch HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * POST /question-reply（worker 执行端点）：转发用户对模型 question 的回答。
   * - answers=null + reject=true → worker 调 serve rejectQuestion（用户拒绝）；
   * - 带 X-Worker-Token 鉴权（与 /file 一致，涉及 serve 会话状态写入不放行）。
   * sessionId 语义 = opencode 会话 id（ses_ 前缀，调用方从平台 Session.instanceRef 取）。
   */
  async questionReply(
    worker: WorkerEndpointRef,
    opts: { sessionId: string; requestId: string; answers: string[][] | null },
  ): Promise<void> {
    const res = await this.requestExec(worker, '/question-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Token': this.workerToken },
      body: JSON.stringify(
        opts.answers === null
          ? { sessionId: opts.sessionId, requestId: opts.requestId, answers: null, reject: true }
          : { sessionId: opts.sessionId, requestId: opts.requestId, answers: opts.answers },
      ),
    });
    if (!res.ok) {
      throw new WorkerUnavailableException(worker.id, `question reply HTTP ${res.status}`);
    }
  }

  /**
   * POST /question-reply（worker 执行端点）：转发用户对工具权限确认的回复。
   * response ∈ once|always|reject（对齐 serve replyPermission 契约）；带 X-Worker-Token。
   */
  async permissionReply(
    worker: WorkerEndpointRef,
    opts: { sessionId: string; permissionId: string; response: 'once' | 'always' | 'reject' },
  ): Promise<void> {
    const res = await this.requestExec(worker, '/question-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Token': this.workerToken },
      body: JSON.stringify({
        sessionId: opts.sessionId,
        permissionId: opts.permissionId,
        response: opts.response,
      }),
    });
    if (!res.ok) {
      throw new WorkerUnavailableException(worker.id, `permission reply HTTP ${res.status}`);
    }
  }

  /**
   * GET /api/model：动态模型列表（实测 opencode 1.18.x 端点，返回
   * `{ location, data: [{id, providerID, family, name, ...}] }`）。
   * 旧版 serve 无该端点（404）→ 回退 capabilities.models（T11 之前由 worker 上报）或空数组。
   */
  async listModels(worker: WorkerEndpointRef): Promise<WorkerModel[]> {
    try {
      const res = await this.request(worker, '/api/model');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        data?: Array<{ id?: string; providerID?: string; name?: string }>;
      };
      const data = body.data ?? [];
      if (data.length === 0) {
        throw new Error('empty model data');
      }
      // F2 MINOR：id 拼接与 worker 侧 v1-driver.ts listModels 统一（?? '' 兜底缺省字段）
      return data.map((m) => ({
        id: `${m.providerID ?? ''}/${m.id ?? ''}`,
        name: m.name ?? m.id ?? '',
        providerID: m.providerID ?? '',
        modelID: m.id ?? '',
      }));
    } catch {
      // 网络失败/旧版无 /api/model/空数据 → 降级 capabilities 声明（T11 动态化前占位）。
      return this.modelsFromCapabilities(worker);
    }
  }

  /** POST /session/{id}/abort：中止会话（计划 D2：abort 后无 step-finish，轮询判定需配套）。 */
  async abort(worker: WorkerEndpointRef, sessionID: string): Promise<void> {
    const res = await this.request(worker, `/session/${encodeURIComponent(sessionID)}/abort`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw new WorkerUnavailableException(worker.id, `abort HTTP ${res.status}`);
    }
  }

  /**
   * GET /session/{id}/message：拉取会话消息列表（T10 轮询用，500ms 间隔直到含
   * step-finish(reason=stop) 的 assistant 消息）。
   */
  async getMessages(worker: WorkerEndpointRef, sessionID: string): Promise<unknown[]> {
    const res = await this.request(worker, `/session/${encodeURIComponent(sessionID)}/message`);
    if (!res.ok) {
      throw new WorkerUnavailableException(worker.id, `getMessages HTTP ${res.status}`);
    }
    const body = (await res.json()) as unknown[] | { data?: unknown[] };
    if (Array.isArray(body)) {
      return body;
    }
    return body.data ?? [];
  }

  /** GET /：健康检查（200 → 在线；非 200/fetch 抛错 → 离线，不抛异常）。 */
  async isHealthy(worker: WorkerEndpointRef): Promise<boolean> {
    try {
      const res = await this.request(worker, '/');
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 统一请求入口：拼 serve baseUrl、注入 Basic Auth、超时控制、错误归类。 */
  private async request(
    worker: WorkerEndpointRef,
    path: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    return this.requestToUrl(this.resolveBaseUrl(worker), worker.id, path, init, timeoutMs);
  }

  /** 执行端点请求入口（方案 A：与 serve 不同端口，独立解析执行端点基址）。 */
  private async requestExec(
    worker: WorkerEndpointRef,
    path: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    return this.requestToUrl(this.resolveExecBaseUrl(worker), worker.id, path, init, timeoutMs);
  }

  /** 核心请求：指定 baseUrl + 注入 Basic Auth + 超时控制 + 错误归一（503 带 workerId）。 */
  private async requestToUrl(
    baseUrl: string,
    workerId: string,
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const auth = this.buildAuthHeader();
    if (auth) {
      headers.set('Authorization', auth);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      throw new WorkerUnavailableException(workerId, this.describeError(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** baseUrl 解析：capabilities.baseUrl → capabilities.port → WORKER_BASE_URL 回退。 */
  private resolveBaseUrl(worker: WorkerEndpointRef): string {
    const caps = (worker.capabilities ?? {}) as Record<string, unknown>;
    if (typeof caps.baseUrl === 'string' && caps.baseUrl) {
      return caps.baseUrl;
    }
    if (typeof caps.port === 'number') {
      return `http://localhost:${caps.port}`;
    }
    return this.baseUrlFallback;
  }

  /**
   * 执行端点基址解析（方案 A）：capabilities.execBaseUrl（完整基址，如
   * `http://worker:4198`）优先 → 否则 serve 基址 origin + ':' + capabilities.execPort
   * （缺省 DEFAULT_EXEC_PORT=4198）拼接。执行端点与 serve 是不同端口（worker 独立
   * node:http 监听），不能复用 serve baseUrl 直连。
   */
  private resolveExecBaseUrl(worker: WorkerEndpointRef): string {
    const caps = (worker.capabilities ?? {}) as Record<string, unknown>;
    if (typeof caps.execBaseUrl === 'string' && caps.execBaseUrl) {
      return caps.execBaseUrl.replace(/\/+$/, '');
    }
    const execPort =
      typeof caps.execPort === 'number' && caps.execPort > 0
        ? caps.execPort
        : DEFAULT_EXEC_PORT;
    return `${this.resolveServeOrigin(worker)}:${execPort}`;
  }

  /** serve 基址 origin（protocol://host，不含端口）：baseUrl → capabilities.port → 回退。 */
  private resolveServeOrigin(worker: WorkerEndpointRef): string {
    const caps = (worker.capabilities ?? {}) as Record<string, unknown>;
    const raw =
      typeof caps.baseUrl === 'string' && caps.baseUrl
        ? caps.baseUrl
        : typeof caps.port === 'number'
          ? `http://localhost:${caps.port}`
          : this.baseUrlFallback;
    try {
      const url = new URL(raw);
      if (url.hostname) {
        return `${url.protocol}//${url.hostname}`;
      }
    } catch {
      // 落入下方裸 host 分支
    }
    const noScheme = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    const host = noScheme.split('/')[0].split(':')[0];
    return `http://${host}`;
  }

  /** Basic Auth 头：password 为空（默认）→ 不鉴权；否则 `Basic base64(opencode:<password>)`。 */
  private buildAuthHeader(): string | undefined {
    if (!this.serverPassword) {
      return undefined;
    }
    return `Basic ${Buffer.from(`opencode:${this.serverPassword}`, 'utf8').toString('base64')}`;
  }

  /** capabilities.models 降级解析：数组 → 逐项；对象（modelId→{name}）→ 键列表。 */
  private modelsFromCapabilities(worker: WorkerEndpointRef): WorkerModel[] {
    const caps = (worker.capabilities ?? {}) as Record<string, unknown>;
    const models = caps.models;
    if (Array.isArray(models)) {
      return (models as Array<{ id?: string; name?: string; providerID?: string }>).map(
        (m): WorkerModel => ({
          id: m.id ?? m.name ?? '',
          name: m.name ?? m.id ?? '',
          providerID: m.providerID ?? '',
          modelID: m.id ?? '',
        }),
      );
    }
    if (models && typeof models === 'object') {
      return Object.entries(models as Record<string, unknown>).map(([key, val]): WorkerModel => {
        const name =
          val && typeof val === 'object' && (val as { name?: string }).name
            ? (val as { name: string }).name
            : key;
        return { id: key, name, providerID: '', modelID: key };
      });
    }
    return [];
  }

  /** 错误信息归一（超时/网络/HTTP 消息，避免泄露过多内部细节）。 */
  private describeError(err: unknown): string {
    // fetch abort 在 Node 18+ 抛 DOMException（非 Error 实例），按 name 识别 AbortError
    const name =
      typeof err === 'object' && err !== null && 'name' in err
        ? (err as { name?: string }).name
        : undefined;
    if (name === 'AbortError') {
      return `请求超时（>${DEFAULT_REQUEST_TIMEOUT_MS}ms）`;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}
