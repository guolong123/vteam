import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
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
 *
 * `httpStatus`：worker 有响应但非 2xx 时携带该状态码（网络失败/超时缺省 undefined）。
 * 调用方据此区分「404 路径不存在，可换候选路径重试」与「worker 真不可用」。
 */
export class WorkerUnavailableException extends ServiceUnavailableException {
  readonly workerId: string;
  readonly httpStatus?: number;

  constructor(workerId: string, detail: string, httpStatus?: number) {
    super({
      code: WORKER_CLIENT_ERRORS.WORKER_UNAVAILABLE,
      message: `worker ${workerId} 不可用：${detail}`,
      workerId,
    });
    this.workerId = workerId;
    this.httpStatus = httpStatus;
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
/** 单次 HTTP 请求超时：已从 15s 调整为 60s，适配长命令/思考执行 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** FR-41：GET /file 文件拉取超时（较大文件/网络慢） */
export const DEFAULT_FILE_FETCH_TIMEOUT_MS = 60_000;

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
 * opencode 原生 agent 项（worker `GET /agents` → serve `GET /agent` 透传）。
 *
 * 形状对齐 worker 侧 DriverAgentInfo（**实测**形状，非 SDK 声明的 Agent 类型）：
 * `native`（非 builtIn）、`permission` 为数组、hidden 标记隐藏系统 agent。
 * vteam 仅做「同步 + 展示 + 切换」，agent 的 prompt/permission 语义完全由 opencode 侧定义。
 */
export interface WorkerAgentInfo {
  /** agent 名（下发 prompt_async 的 agent 字段取值）。 */
  name: string;
  description?: string;
  /** primary=可作为会话主 agent；subagent=仅由主 agent 派生；all=两者皆可。 */
  mode: 'primary' | 'subagent' | 'all';
  /** 是否 opencode 内置（实测字段 native）。 */
  native?: boolean;
  /** 隐藏系统 agent（compaction/summary/title），前端不应展示。 */
  hidden?: boolean;
  /** agent 覆盖的模型（缺省继承全局）。 */
  model?: { providerID: string; modelID: string };
  /** 权限声明（实测数组形状，透传供展示/诊断）。 */
  permission?: unknown;
}

/**
 * opencode todo 执行步骤项（worker `GET /todos` → serve `GET /session/{id}/todo` 透传）。
 * 对齐 SDK `Todo` 类型：content/status/priority/id；
 * status ∈ pending | in_progress | completed | cancelled（计划 Tab checklist 映射依据）。
 * vteam 只读展示，状态由 agent 经 opencode todo 工具推进。
 */
export interface WorkerTodoInfo {
  id?: string;
  content: string;
  status: string;
  priority?: string;
}

/**
 * 计划文档项（worker `GET /plan-files` → 任务目录 `.opencode/plans/*.md` 直读）。
 *
 * vteam 不自维护计划内容：文件即真相（opencode 原生约定目录），本结构只做搬运。
 * 正文随列表一次下发（Modal 打开免二次请求）；超 MAX_PLAN_DOC_BYTES 时截断并标记。
 */
export interface WorkerPlanFileInfo {
  /** 文件名（计划 Tab 行标识 / 上传覆盖键）。 */
  name: string;
  /** 最后修改时间（ISO 字符串）。 */
  updatedAt: string;
  /** 真实字节数（截断时大于 content 长度）。 */
  size: number;
  content: string;
  /** 正文是否被截断（仅展示用，不代表文件损坏）。 */
  truncated: boolean;
}

/**
 * 方案 A：POST /execute 请求体（对齐 worker exec-server.ts ExecuteRequestPayload）。
 * worker 执行端点收到后立即 202 {accepted:true}（fire-and-forget），异步驱动 serve 并
 * 上送事件（session.updated/message.part.delta/task.completed/agent.status）；回复经
 * server ingress 回流落库，本客户端只保证「已受理」。
 * ⚠️ 字段名与 worker ExecuteRequestPayload.prompt 一一对应（worker 执行端点校验
 * `payload.prompt`，发送 `parts` 会 400「缺少必填字段 prompt」——wave1 对齐修复）。
 */
export interface ExecutionConfig {
  permissions: Record<string, 'allow' | 'ask' | 'deny'>;
  writePaths: string[];
}

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
  /** 执行策略配置（服务端 ExecutionPolicy 下发，worker 盲翻成 opencode 配置）。 */
  executionConfig?: ExecutionConfig;
  /**
   * 用户消息图片附件（问题二：图片进执行上下文）。worker 下载到执行目录后以
   * serve file part 形式并入 prompt；相对路径（/uploads/…）由 worker 按自身
   * serverBaseUrl 拼接下载，绝不接受 file:// 本地路径（防路径穿越）。
   */
  attachments?: ExecuteAttachment[];
}

/**
 * 下发给 worker 的单个图片附件引用（轻量引用，不含字节；字节由 worker 按需下载）。
 */
export interface ExecuteAttachment {
  /** /uploads/… 相对路径或 http(s) 绝对 URL。 */
  url: string;
  /** MIME（如 image/png；缺省按扩展名推断）。 */
  mime?: string;
  /** 原文件名（缺省取 url basename）。 */
  filename?: string;
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
  private readonly logger = new Logger(WorkerClient.name);
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
    this.baseUrlFallback = config.get(
      'WORKER_BASE_URL',
      DEFAULT_WORKER_BASE_URL,
    );
    this.serverPassword = config.get('SERVER_PASSWORD', '');
    this.workerToken = config.get('WORKER_TOKEN', DEFAULT_WORKER_TOKEN);
  }

  /**
   * POST /session：创建 opencode 会话。
   * serve 实际返回 `{ id: "ses_..." }`（SDK 声明 {sessionID} 是错的），此处映射为
   * `{ sessionID }` 契约，T10/T12 存 instanceRef 直接用。
   * ⚠️ serve 契约（实测 opencode 1.18.15）：POST /session **拒收 model 字段**
   * （带 model → 400，空 body → 200）——模型选择经 promptAsync 的 opts.model 指定。
   * 签名保留 `model?` 参数仅为兼容历史调用方，请求体恒为 {}。
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
      throw new WorkerUnavailableException(
        worker.id,
        `createSession HTTP ${res.status}`,
      );
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
      throw new WorkerUnavailableException(
        worker.id,
        `prompt_async HTTP ${res.status}`,
      );
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
  async execute(
    worker: WorkerEndpointRef,
    opts: ExecuteOptions,
  ): Promise<void> {
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
        ...(opts.executionConfig
          ? { executionConfig: opts.executionConfig }
          : {}),
        ...(opts.attachments ? { attachments: opts.attachments } : {}),
        prompt: opts.prompt,
      }),
    });
    if (!res.ok) {
      throw new WorkerUnavailableException(
        worker.id,
        `execute HTTP ${res.status}`,
      );
    }
  }

  /**
   * FR-41：GET /file?path=<绝对路径>——从 worker 工作区拉取文件内容（二进制安全）。
   * 走 exec 端点（resolveExecBaseUrl），带 X-Worker-Token 鉴权（worker 端校验）。
   * 网络错误/超时 → WorkerUnavailableException（requestToUrl 归一）；HTTP 非 2xx
   * （401/404/413/400）→ WorkerUnavailableException（fetchFile 内判断，调用方降级）。
   */
  async fetchFile(
    worker: WorkerEndpointRef,
    filePath: string,
  ): Promise<Buffer> {
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
      throw new WorkerUnavailableException(
        worker.id,
        `file fetch HTTP ${res.status}`,
        res.status,
      );
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
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Token': this.workerToken,
      },
      body: JSON.stringify(
        opts.answers === null
          ? {
              sessionId: opts.sessionId,
              requestId: opts.requestId,
              answers: null,
              reject: true,
            }
          : {
              sessionId: opts.sessionId,
              requestId: opts.requestId,
              answers: opts.answers,
            },
      ),
    });
    if (!res.ok) {
      throw new WorkerUnavailableException(
        worker.id,
        `question reply HTTP ${res.status}`,
      );
    }
  }

  /**
   * POST /question-reply（worker 执行端点）：转发用户对工具权限确认的回复。
   * response ∈ once|always|reject（对齐 serve replyPermission 契约）；带 X-Worker-Token。
   */
  async permissionReply(
    worker: WorkerEndpointRef,
    opts: {
      sessionId: string;
      permissionId: string;
      response: 'once' | 'always' | 'reject';
    },
  ): Promise<void> {
    const res = await this.requestExec(worker, '/question-reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Token': this.workerToken,
      },
      body: JSON.stringify({
        sessionId: opts.sessionId,
        permissionId: opts.permissionId,
        response: opts.response,
      }),
    });
    if (!res.ok) {
      throw new WorkerUnavailableException(
        worker.id,
        `permission reply HTTP ${res.status}`,
      );
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
    } catch (err) {
      // 网络失败/旧版无 /api/model/空数据 → 降级 capabilities 声明（T11 动态化前占位）。
      // 可观测性：记录 worker id + resolveBaseUrl 实际解析出的 URL，并在消息中区分
      // 「worker 不可达/请求失败」与「worker 可达但返回空模型列表」。
      const baseUrl = this.resolveBaseUrl(worker);
      const reason = this.describeError(err);
      const unreachable = reason !== 'empty model data';
      this.logger.warn(
        `listModels: worker ${worker.id}（${baseUrl}）` +
          `${unreachable ? '不可达/请求失败' : '可达但返回空模型列表'}` +
          `（${reason}），降级 capabilities 声明`,
      );
      return this.modelsFromCapabilities(worker);
    }
  }

  /**
   * GET /agents（worker 执行端点）：列出该目录可见的 opencode 原生 agent。
   *
   * 用于 vteam 页面展示与切换 opencode agent。`directory` 必须与执行期 prompt_async 的
   * directory 同值（serve 按 directory 发现 opencode.json 的 agent 节，per-directory 隔离）。
   *
   * 降级策略**对齐 listModels**：列表类端点失败不阻断页面——网络错/worker 离线/旧版无该
   * 端点/空结果一律返回 `[]`，由调用方以 degraded 标记提示前端。故本方法不抛
   * WorkerUnavailableException（与 execute/abort 等写路径的失败语义相反）。
   */
  async listAgents(
    worker: WorkerEndpointRef,
    directory?: string,
  ): Promise<WorkerAgentInfo[]> {
    try {
      const qs = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      const res = await this.requestExec(worker, `/agents${qs}`, {
        method: 'GET',
        headers: { 'X-Worker-Token': this.workerToken },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        agents?: WorkerAgentInfo[];
      };
      return Array.isArray(body.agents) ? body.agents : [];
    } catch (err) {
      this.logger.warn(
        `listAgents: worker ${worker.id}（${this.resolveExecBaseUrl(worker)}）` +
          `不可达/请求失败（${this.describeError(err)}），降级返回 []（空≠worker 真无 agent）`,
      );
      return [];
    }
  }

  /**
   * GET /todos（worker 执行端点）：读取 opencode 会话的 todo 执行步骤。
   *
   * 用于计划 Tab 步骤区展示。sessionId 必填（opencode ses_ 会话 id）；
   * directory 可选（与执行期 prompt_async 同值，serve 按目录定位会话上下文）。
   *
   * 降级策略**对齐 listAgents**：列表类端点失败不阻断页面——网络错/worker 离线/
   * 会话不存在/旧版无该端点/空结果一律返回 `[]`。
   */
  async listTodos(
    worker: WorkerEndpointRef,
    sessionId: string,
    directory?: string,
  ): Promise<WorkerTodoInfo[]> {
    try {
      const params = new URLSearchParams({ sessionId });
      if (directory) {
        params.set('directory', directory);
      }
      const res = await this.requestExec(
        worker,
        `/todos?${params.toString()}`,
        {
          method: 'GET',
          headers: { 'X-Worker-Token': this.workerToken },
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        todos?: WorkerTodoInfo[];
      };
      return Array.isArray(body.todos) ? body.todos : [];
    } catch (err) {
      this.logger.warn(
        `listTodos: worker ${worker.id}（${this.resolveExecBaseUrl(worker)}）` +
          `不可达/请求失败（${this.describeError(err)} sessionId=${sessionId}），降级返回 []（空≠会话真无 todo）`,
      );
      return [];
    }
  }

  /**
   * GET /plan-files（worker 执行端点）：读取任务目录 `.opencode/plans/*.md` 计划文档。
   *
   * 计划 Tab 唯一数据源：vteam 不落库、不解析、不生成计划，文件由 opencode agent 写
   * （或用户上传），本方法只把 worker 的结果搬给前端。
   *
   * 降级策略**对齐 listAgents**：目录不存在/worker 离线/旧版无该端点一律返回 `[]`，
   * 由调用方以 degraded 标记提示前端（"没有计划"与"读不到"在 UI 上要能区分）。
   */
  async listPlanFiles(
    worker: WorkerEndpointRef,
    directory?: string,
  ): Promise<WorkerPlanFileInfo[]> {
    try {
      const qs = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      const res = await this.requestExec(worker, `/plan-files${qs}`, {
        method: 'GET',
        headers: { 'X-Worker-Token': this.workerToken },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { files?: WorkerPlanFileInfo[] };
      return Array.isArray(body.files) ? body.files : [];
    } catch (err) {
      this.logger.warn(
        `listPlanFiles: worker ${worker.id}（${this.resolveExecBaseUrl(worker)}）` +
          `不可达/请求失败（${this.describeError(err)}），降级返回 []（空≠目录真无计划）`,
      );
      return [];
    }
  }

  /**
   * POST /plan-file（worker 执行端点）：把计划文件写进任务目录 `.opencode/plans/`。
   *
   * "上传计划文件"入口的落点——写完后 agent 侧同目录可读、计划 Tab 下轮询可见。
   * 与 listPlanFiles 相反，这是写路径：失败必须抛出（用户需要知道上传没成功），
   * 故不吞异常，交由 controller 映射为 HTTP 错误。
   */
  async writePlanFile(
    worker: WorkerEndpointRef,
    input: { directory: string; name: string; content: string },
  ): Promise<{ name: string; updatedAt: string }> {
    const res = await this.requestExec(worker, '/plan-file', {
      method: 'POST',
      headers: {
        'X-Worker-Token': this.workerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    const raw = await res.text();
    if (!res.ok) {
      let detail = raw;
      try {
        detail = (JSON.parse(raw) as { error?: string }).error ?? raw;
      } catch {
        /* 非 JSON 响应体：保留原文 */
      }
      throw new WorkerUnavailableException(
        worker.id,
        `plan-file HTTP ${res.status}: ${detail}`,
      );
    }
    const body = JSON.parse(raw || '{}') as {
      name?: string;
      updatedAt?: string;
    };
    return {
      name: body.name ?? input.name,
      updatedAt: body.updatedAt ?? new Date().toISOString(),
    };
  }

  /**
   * GET /omo-config（worker 执行端点）：读取 OmO 的 agent→模型配置。
   *
   * 数据源是 `<workDir>/.opencode/oh-my-openagent.jsonc`（OmO 按 cwd 读取的项目级配置），
   * vteam 不落库——配置文件即真相。
   *
   * 降级策略对齐 listPlanFiles：worker 离线/旧版无该端点 → 返回空结构 + `degraded:true`，
   * 由调用方提示"暂不可用"（与"尚未配置任何覆盖"区分）。
   */
  async getOmoConfig(worker: WorkerEndpointRef): Promise<{
    agents: Record<string, string>;
    available: string[];
    /** 实际生效的配置文件（相对 workDir）；用于前端提示"改的是哪份"。 */
    configPath?: string;
    configKind?: 'new' | 'legacy' | 'none';
    /** 用户开关：是否加载 OmO 插件。 */
    enabled?: boolean;
    /** 本镜像是否内置 OmO（false → 前端不展示该区块）。 */
    bundled?: boolean;
    /** 已注册到 serve 的 agent 基底名（未含者当前模型下不会激活）。 */
    registered?: string[];
    /** agent 元数据（描述/mode/native）；缺失=该 agent 未注册。 */
    runtime?: Record<
      string,
      { description?: string; mode?: string; native?: boolean }
    >;
    degraded: boolean;
  }> {
    try {
      const res = await this.requestExec(worker, '/omo-config', {
        method: 'GET',
        headers: { 'X-Worker-Token': this.workerToken },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        agents?: unknown;
        available?: unknown;
        configPath?: unknown;
        configKind?: unknown;
        enabled?: unknown;
        bundled?: unknown;
        registered?: unknown;
        runtime?: unknown;
      };
      return {
        agents:
          body.agents && typeof body.agents === 'object'
            ? (body.agents as Record<string, string>)
            : {},
        available: Array.isArray(body.available)
          ? (body.available as string[])
          : [],
        configPath:
          typeof body.configPath === 'string' ? body.configPath : undefined,
        configKind:
          body.configKind === 'new' ||
          body.configKind === 'legacy' ||
          body.configKind === 'none'
            ? body.configKind
            : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        bundled: typeof body.bundled === 'boolean' ? body.bundled : undefined,
        registered: Array.isArray(body.registered)
          ? (body.registered as string[])
          : undefined,
        runtime:
          body.runtime && typeof body.runtime === 'object'
            ? (body.runtime as Record<
                string,
                { description?: string; mode?: string; native?: boolean }
              >)
            : undefined,
        degraded: false,
      };
    } catch (err) {
      this.logger.warn(
        `getOmoConfig: worker ${worker.id}（${this.resolveExecBaseUrl(worker)}）` +
          `不可达/请求失败（${this.describeError(err)}），降级返回 degraded:true（空≠尚未配置覆盖）`,
      );
      return { agents: {}, available: [], degraded: true };
    }
  }

  /**
   * POST /omo-config（worker 执行端点）：写入 OmO 的 agent→模型配置（增量合并）。
   *
   * 写路径：失败必须抛出（用户需要明确成败反馈），不静默降级。
   */
  async setOmoConfig(
    worker: WorkerEndpointRef,
    agents: Record<string, string>,
    enabled?: boolean,
  ): Promise<{
    written: string;
    agents: Record<string, string>;
    configPath?: string;
    configKind?: 'new' | 'legacy' | 'none';
    enabled?: boolean;
    bundled?: boolean;
    /** 写盘后的 serve 重启结果：executed=已重启（新会话即生效）/ pending=挂起（有活跃会话）/ skipped=未重启。 */
    restart?: 'executed' | 'pending' | 'skipped';
  }> {
    const res = await this.requestExec(worker, '/omo-config', {
      method: 'POST',
      headers: {
        'X-Worker-Token': this.workerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        enabled === undefined ? { agents } : { agents, enabled },
      ),
    });
    const raw = await res.text();
    if (!res.ok) {
      let detail = raw;
      try {
        detail = (JSON.parse(raw) as { error?: string }).error ?? raw;
      } catch {
        /* 非 JSON 响应体：保留原文 */
      }
      // 4xx = 请求本身不合法（如"镜像未内置 OmO，无法开启"、agents 值类型错），
      // 原样透传为 400，不要包成 503——《worker 不可用》会误导用户去查节点状态。
      // 5xx = worker 侧故障，才是真正的不可用。
      if (res.status >= 400 && res.status < 500) {
        throw new BadRequestException(detail);
      }
      throw new WorkerUnavailableException(
        worker.id,
        `omo-config HTTP ${res.status}: ${detail}`,
      );
    }
    const body = JSON.parse(raw || '{}') as {
      written?: string;
      agents?: Record<string, string>;
      configPath?: string;
      configKind?: 'new' | 'legacy' | 'none';
      enabled?: boolean;
      bundled?: boolean;
      restart?: 'executed' | 'pending' | 'skipped';
    };
    return {
      written: body.written ?? '',
      agents: body.agents ?? {},
      configPath: body.configPath,
      configKind: body.configKind,
      enabled: body.enabled,
      bundled: body.bundled,
      restart: body.restart,
    };
  }

  /**
   * GET /omo-agent-prompt（worker 执行端点）：取单个 agent 的系统提示词全文。
   *
   * 按需拉取而非随列表下发：全部 agent 的 prompt 合计约 106KB（单个最大 33KB），
   * 列表接口只带描述，用户点"查看提示词"时才请求本端点。
   *
   * 写失败语义：agent 未注册（当前模型下不激活）→ worker 返回 404，此处抛 BadRequest
   * （是"该 agent 不存在"，不是"worker 不可用"）；5xx 才归为 worker 不可用。
   */
  async getOmoAgentPrompt(
    worker: WorkerEndpointRef,
    name: string,
  ): Promise<{
    name: string;
    description: string;
    mode?: string;
    prompt: string;
    empty: boolean;
  }> {
    const res = await this.requestExec(
      worker,
      `/omo-agent-prompt?name=${encodeURIComponent(name)}`,
      { method: 'GET', headers: { 'X-Worker-Token': this.workerToken } },
    );
    const raw = await res.text();
    if (!res.ok) {
      let detail = raw;
      try {
        detail = (JSON.parse(raw) as { error?: string }).error ?? raw;
      } catch {
        /* 保留原文 */
      }
      if (res.status >= 400 && res.status < 500) {
        throw new BadRequestException(detail);
      }
      throw new WorkerUnavailableException(
        worker.id,
        `omo-agent-prompt HTTP ${res.status}: ${detail}`,
      );
    }
    const body = JSON.parse(raw || '{}') as {
      name?: string;
      description?: string;
      mode?: string;
      prompt?: string;
      empty?: boolean;
    };
    return {
      name: body.name ?? name,
      description: body.description ?? '',
      mode: body.mode,
      prompt: body.prompt ?? '',
      empty: body.empty ?? !body.prompt,
    };
  }

  /** POST /session/{id}/abort：中止会话（计划 D2：abort 后无 step-finish，轮询判定需配套）。 */
  async abort(worker: WorkerEndpointRef, sessionID: string): Promise<void> {
    const res = await this.request(
      worker,
      `/session/${encodeURIComponent(sessionID)}/abort`,
      {
        method: 'POST',
      },
    );
    if (!res.ok) {
      throw new WorkerUnavailableException(
        worker.id,
        `abort HTTP ${res.status}`,
      );
    }
  }

  /**
   * GET /session/{id}/message：拉取会话消息列表（T10 轮询用，500ms 间隔直到含
   * step-finish(reason=stop) 的 assistant 消息）。
   */
  async getMessages(
    worker: WorkerEndpointRef,
    sessionID: string,
  ): Promise<unknown[]> {
    const res = await this.request(
      worker,
      `/session/${encodeURIComponent(sessionID)}/message`,
    );
    if (!res.ok) {
      throw new WorkerUnavailableException(
        worker.id,
        `getMessages HTTP ${res.status}`,
      );
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
    return this.requestToUrl(
      this.resolveBaseUrl(worker),
      worker.id,
      path,
      init,
      timeoutMs,
    );
  }

  /** 执行端点请求入口（方案 A：与 serve 不同端口，独立解析执行端点基址）。 */
  private async requestExec(
    worker: WorkerEndpointRef,
    path: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    return this.requestToUrl(
      this.resolveExecBaseUrl(worker),
      worker.id,
      path,
      init,
      timeoutMs,
    );
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
      return (
        models as Array<{ id?: string; name?: string; providerID?: string }>
      ).map((m): WorkerModel => ({
        id: m.id ?? m.name ?? '',
        name: m.name ?? m.id ?? '',
        providerID: m.providerID ?? '',
        modelID: m.id ?? '',
      }));
    }
    if (models && typeof models === 'object') {
      return Object.entries(models as Record<string, unknown>).map(
        ([key, val]): WorkerModel => {
          const name =
            val && typeof val === 'object' && (val as { name?: string }).name
              ? (val as { name: string }).name
              : key;
          return { id: key, name, providerID: '', modelID: key };
        },
      );
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
