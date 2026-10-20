import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_WORKER_TOKEN } from './workers.constants';
import type {
  CreateSessionRequestPayload,
  CreateSessionResponsePayload,
  SessionAbortResponsePayload,
  SessionMessage,
  SessionMessagesQuery,
  SessionMessagesResponsePayload,
  SessionPromptRequestPayload,
  SessionPromptResponsePayload,
  WorkerDeliveryMode,
  WorkerModelsResponsePayload,
} from './worker-session-protocol';

/**
 * WorkerClient 错误码（T8，server→worker 的 HTTP 客户端；T18 增补会话/限流两码）。
 * 统一 WORKER_UNAVAILABLE（503 语义）：worker 离线/连接失败/HTTP 非 2xx 均视为
 * 该 worker 当前不可用，供 T10「无可用 worker 报错」catch 后直接读 workerId。
 *
 * - SESSION_NOT_FOUND：worker 侧 404 + `code:'SESSION_NOT_FOUND'` ⇒ **会话已失效**
 *   （被驱动端重启/会话被删）⇒ 调用方走「重建会话」路径，而不是把它当「worker 挂了」。
 * - RATE_LIMITED：worker 侧 429 + `code:'RATE_LIMITED'` ⇒ **上游限流** ⇒ 调用方退避重试。
 * - FILE_NOT_FOUND：worker 侧 `GET /file` 的 404 ⇒ **该 worker 工作区没有这个文件**
 *   （worker 好好地回答了「我没有」）。它**不是**「worker 不可用」——两者混同会让
 *   调用方（与 agent）去查节点状态，而不是查引用本身。
 */
export const WORKER_CLIENT_ERRORS = {
  WORKER_UNAVAILABLE: 'WORKER_UNAVAILABLE',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
} as const;

/** 错误码 → 异常 message 前缀（各码的语义不同，不能一律说「不可用」）。 */
const WORKER_ERROR_MESSAGES: Record<string, (workerId: string) => string> = {
  [WORKER_CLIENT_ERRORS.WORKER_UNAVAILABLE]: (workerId) =>
    `worker ${workerId} 不可用：`,
  [WORKER_CLIENT_ERRORS.SESSION_NOT_FOUND]: (workerId) =>
    `worker ${workerId} 会话已失效：`,
  [WORKER_CLIENT_ERRORS.RATE_LIMITED]: (workerId) =>
    `worker ${workerId} 上游限流：`,
  [WORKER_CLIENT_ERRORS.FILE_NOT_FOUND]: (workerId) =>
    `worker ${workerId} 上未找到该文件：`,
};

/**
 * worker 离线/请求失败异常（503，携带 workerId）。
 * T10 分派失败路径据此识别是哪个 worker 不可用并 emitError。
 *
 * `httpStatus`：worker 有响应但非 2xx 时携带该状态码（网络失败/超时缺省 undefined）。
 * 调用方据此区分「404 路径不存在，可换候选路径重试」与「worker 真不可用」。
 *
 * `code`：错误码（WORKER_UNAVAILABLE / SESSION_NOT_FOUND / RATE_LIMITED）——
 * 会话失效与限流**不是**「worker 不可用」，必须能被调用方区分（前者重建会话、后者退避）。
 */
export class WorkerUnavailableException extends ServiceUnavailableException {
  readonly workerId: string;
  readonly httpStatus?: number;
  readonly code: string;

  constructor(
    workerId: string,
    detail: string,
    httpStatus?: number,
    code: string = WORKER_CLIENT_ERRORS.WORKER_UNAVAILABLE,
  ) {
    const prefix =
      WORKER_ERROR_MESSAGES[code]?.(workerId) ?? `worker ${workerId} 不可用：`;
    super({ code, message: `${prefix}${detail}`, workerId });
    this.workerId = workerId;
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/**
 * 判断一个异常是不是「会话已失效」（worker 侧 404 + code:SESSION_NOT_FOUND）。
 *
 * 调用方据此走**会话重建**路径（解绑 → 下一轮分派新建会话），而不是把会话失效
 * 当成「worker 离线」空转到超时。
 */
export function isWorkerSessionInvalid(err: unknown): boolean {
  return (
    err instanceof WorkerUnavailableException &&
    err.code === WORKER_CLIENT_ERRORS.SESSION_NOT_FOUND
  );
}

/**
 * 判断一个异常是不是「上游限流」（worker 侧 429 + code:RATE_LIMITED）。
 *
 * 限流是**可重试**的瞬时状态（退避后重试即可），与「worker 不可用」不同。
 */
export function isWorkerRateLimited(err: unknown): boolean {
  return (
    err instanceof WorkerUnavailableException &&
    err.code === WORKER_CLIENT_ERRORS.RATE_LIMITED
  );
}

/**
 * worker 侧「文件不存在」（`GET /file` 的 404）。
 *
 * 与「worker 不可用」严格分开：worker 好好地回答了「这个文件我没有」，
 * 把它说成「worker 不可用」会让调用方（与 agent）去查节点状态，而不是查引用本身
 * （缺陷 1 的错误语义冲突：id 不存在 ⇒ 报「worker 不可用」）。
 *
 * ⚠️ 仍继承 WorkerUnavailableException：调用方（platform-mcp 的多候选路径回退）
 * 按 `instanceof WorkerUnavailableException && httpStatus === 404` 判定「换下一个候选
 * 路径」——继承关系不能断，否则相对路径只试第一个候选。
 * 但 HTTP 状态覆写为 404 ⇒ 上层（MCP 协议层）把它映射成「找不到」而不是「内部错误」。
 */
export class WorkerFileNotFoundException extends WorkerUnavailableException {
  constructor(workerId: string, detail: string) {
    super(workerId, detail, 404, WORKER_CLIENT_ERRORS.FILE_NOT_FOUND);
  }

  override getStatus(): number {
    return 404;
  }
}

/**
 * worker 执行端点默认端口（对齐 worker config WORKER_EXEC_PORT=4198）。
 * 执行端点是独立于 opencode serve 的 node:http 端口（POST /execute 等），server 侧在
 * capabilities.execBaseUrl 缺失时以「worker 对外公布的主机」+ ':' + execPort 拼接发现。
 */
export const DEFAULT_EXEC_PORT = 4198;
/**
 * worker 对外公布主机缺省时的回退基址（env WORKER_BASE_URL，默认 http://localhost:4199）。
 *
 * ⚠️ T18：控制面**只**用它推导 worker 执行端点的**主机**（端口恒取 capabilities.execPort），
 * 不再拿它去连 opencode serve（决策 D3：控制面彻底不直连 opencode）。
 */
export const DEFAULT_WORKER_BASE_URL = 'http://localhost:4199';
/** 单次 HTTP 请求超时：已从 15s 调整为 60s，适配长命令/思考执行 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** FR-41：GET /file 文件拉取超时（较大文件/网络慢） */
export const DEFAULT_FILE_FETCH_TIMEOUT_MS = 60_000;
/** 敏感命令缺省执行超时（对齐 worker SensitiveCommandInput.timeoutMs 缺省值 60000）。 */
export const DEFAULT_SECRET_COMMAND_TIMEOUT_MS = 60_000;
/** 敏感命令执行超时硬上限（对齐 worker MAX_COMMAND_TIMEOUT_MS，超限由 worker 截断）。 */
export const MAX_SECRET_COMMAND_TIMEOUT_MS = 600_000;
/**
 * secret-command HTTP 请求超时余量：请求超时 = 命令超时 + 该余量。
 * 必须覆盖 worker 同步执行 + 脱敏收尾的回包时间；请求超时绝不回落
 * DEFAULT_REQUEST_TIMEOUT_MS（60s），否则 60s+ 的命令会被客户端提前掐断。
 */
export const SECRET_COMMAND_REQUEST_TIMEOUT_SLACK_MS = 5_000;

/**
 * worker 行最小契约（Prisma Worker 的 id + capabilities Json；T10 传 findUnique 结果）。
 *
 * capabilities 无 baseUrl 列（schema.prisma L365-381）：执行端点基址按
 * `execBaseUrl` → `execPort` + worker 公布主机 → `WORKER_BASE_URL` 回退解析。
 */
export interface WorkerEndpointRef {
  id: string;
  capabilities?: unknown;
}

/**
 * 会话提示下发入参（worker `POST /sessions/:id/prompt` 的请求体 + 一个便捷标志）。
 *
 * ⚠️ T18：请求体形状由**worker 侧**定义（`SessionPromptRequestPayload`），控制面只负责
 * 把它组装出来——**不再**自行拼 opencode 的 `{model?, agent?, parts}`（那是控制面与
 * worker 各拼一份 prompt body 的分叉根源）。
 */
export interface SessionPromptOptions {
  /** 提示内容：字符串（worker 归一为单条文本内容单元）或内容单元数组。 */
  prompt: string | unknown[];
  /** 模型选择（vteam 口径 `{providerID, modelID}`）。 */
  model?: { providerID: string; modelID: string } | null;
  /** agent 名（可选，缺省用被驱动端默认 agent）。 */
  agent?: string;
  /** 会话工作目录（可选）。 */
  directory?: string;
  /** 顶层系统提示（产出物协议/@机制等；可选）。 */
  system?: string;
  /**
   * 投递策略（可选）。**默认显式取 `steer`**——不依赖被驱动端的默认值
   * （默认值一变，行为就静默漂移）。
   */
  delivery?: WorkerDeliveryMode;
  /**
   * 在飞注入标志（同会话已有运行 → 插队注入当前轮）。
   * ⇒ 强制 `delivery:'steer'`（插队语义），忽略本字段以外的分叉。
   */
  inFlight?: boolean;
}

/** 模型列表项（worker `GET /models` 的返回项；id=providerID/modelID）。 */
export interface WorkerModel {
  id: string;
  name: string;
  providerID: string;
  modelID: string;
  /** 可用状态（worker 侧回报；缺失视为可用）。 */
  status?: string;
}

/**
 * opencode 原生 agent 项（worker `GET /agents` → serve `GET /agent` 透传）。
 *
 * 形状对齐 worker 侧 DriverAgentInfo（**实测**形状，非 SDK 声明的 Agent 类型）：
 * `native`（非 builtIn）、`permission` 为数组、hidden 标记隐藏系统 agent。
 * vteam 仅做「同步 + 展示 + 切换」，agent 的 prompt/permission 语义完全由 opencode 侧定义。
 */
export interface WorkerAgentInfo {
  /** agent 名（下发提示时的 agent 字段取值）。 */
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
 * opencode todo 执行步骤项（worker `GET /todos` → 驱动端的会话步骤接口 透传）。
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
  /** 在飞注入标志（同 ses 已有运行：worker 侧仅追加 prompt，不建跟踪/不出终态事件）。 */
  inFlight?: boolean;
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
 * POST /secret-command 请求体（双写自 worker/src/protocol/worker-protocol.ts
 * SecretCommandRequestPayload；不跨包 import：server tsc 会把 common root 抬到仓库根，
 * 破坏 dist 布局，双写一致性由 worker/src/protocol/contract.spec.ts 钉住）。
 *
 * `secrets` 明文只经此请求体进入 worker，不落日志、不进异常 message。
 */
export interface SecretCommandRequest {
  /** 幂等键：同 requestId + 同归属 worker 回放既有结果；不同归属 409。 */
  requestId: string;
  /** 命令模板（含 `{{NAME}}` 占位符，精确替换在 worker 侧完成）。 */
  commandTemplate: string;
  /** 变量名 → 明文值（绝不进日志/异常 message）。 */
  secrets: Record<string, string>;
  /** 相对 worker workDir 的执行目录（缺省 = workDir 根）。 */
  cwd?: string;
  /** 命令执行超时 ms（缺省 60000，worker 侧上限 600000）。 */
  timeoutMs?: number;
  /** 平台 Task 主键（t_ 前缀，幂等归属判定）。 */
  taskId?: string;
  /** opencode 会话 id（ses_ 前缀，幂等归属判定）。 */
  sessionId?: string;
}

/**
 * POST /secret-command 响应（双写自 worker SecretCommandResponsePayload）：
 * 脱敏 + 每流 32KB 截断之后的唯一对外出口，不含渲染命令/argv/cwd/secret。
 */
export interface SecretCommandResult {
  /** 回显幂等键，便于调用方配对。 */
  requestId: string;
  /** succeeded=exit 0；failed=非 0 或启动失败；timeout=超时后进程组被杀。 */
  status: 'succeeded' | 'failed' | 'timeout';
  /** 进程退出码（信号杀死/启动失败为 null）。 */
  exitCode: number | null;
  /** 端到端耗时 ms。 */
  durationMs: number;
  /** 脱敏 + 截断后的标准输出。 */
  stdout: string;
  /** 脱敏 + 截断后的标准错误。 */
  stderr: string;
  /** stdout 是否被截断。 */
  stdoutTruncated: boolean;
  /** stderr 是否被截断。 */
  stderrTruncated: boolean;
  /** 基础设施级失败原因（已脱敏；仅 spawn/启动失败等场景携带）。 */
  error?: string;
}

/**
 * WorkerClient（T8）：server→worker 的裸 fetch HTTP 客户端。
 *
 * - **不用 @opencode-ai/sdk**：SDK path key bug（声明 {sessionID} 实际 {id}）只影响 SDK，
 *   server 侧裸 fetch 规避（计划 D2 铁律）。
 * - **端点**（T18 收口）：控制面**只**调 worker 的执行端点——建会话 `POST /sessions`、
 *   下发提示 `POST /sessions/:id/prompt`、中断 `POST /sessions/:id/abort`、
 *   读消息 `GET /sessions/:id/messages`、模型目录 `GET /models`，外加既有的
 *   `POST /execute` / `GET /file` / `GET /agents` / `GET /todos` / 计划与 OmO 配置端点。
 *   ⚠️ **不再直连 opencode**（决策 D3）：控制面不持有任何 opencode 的 wire 形状
 *   （opencode 的会话创建 / 提示下发 / 中断 / 模型目录端点，一律不认识）。
 * - **鉴权**：执行端点统一带 `X-Worker-Token`（env WORKER_TOKEN，默认 dev-worker-token），
 *   与 worker 端 X_WORKER_TOKEN（compose 同一值）对齐。
 *   ⚠️ opencode serve 的 Basic Auth（`SERVER_PASSWORD`）已删除——控制面不再连 serve。
 * - **baseUrl**：执行端点基址按 `capabilities.execBaseUrl` → `capabilities.execPort`
 *   + worker 公布主机 → `WORKER_BASE_URL` 回退解析；**serve 端口不再被使用**。
 * - **错误**：fetch 网络错误/超时/HTTP 非 2xx → WorkerUnavailableException（503，带 workerId）；
 *   404 + `SESSION_NOT_FOUND`（会话失效）与 429 + `RATE_LIMITED`（限流）保留各自语义。
 */
@Injectable()
export class WorkerClient {
  private readonly logger = new Logger(WorkerClient.name);
  /** worker 公布主机缺省时的回退基址（env WORKER_BASE_URL）；公开字段便于测试覆盖。 */
  public baseUrlFallback: string;
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
    this.workerToken = config.get('WORKER_TOKEN', DEFAULT_WORKER_TOKEN);
  }

  /**
   * POST /sessions：创建被驱动端会话（**经 worker 执行端点**；T18：控制面不再直连 opencode）。
   *
   * - 请求体：`{model?}`（缺省用被驱动端默认模型）。
   * - 响应体：`{sessionId}`（vteam 协议拼写）——**归一后对外只暴露 `sessionId`**：
   *   opencode 时代的 `{id}` / `{sessionID}` 两种拼写都在 worker 侧收敛掉了，
   *   控制面若再混用两种拼写，迟早读错字段（读不到 = 会话 id 丢失 = 全链路崩）。
   */
  async createSession(
    worker: WorkerEndpointRef,
    model?: { providerID: string; modelID: string } | null,
  ): Promise<{ sessionId: string }> {
    const body: CreateSessionRequestPayload = model
      ? { model: { ...model } }
      : {};
    const res = await this.requestExec(worker, '/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Token': this.workerToken,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await this.failFromResponse(worker, res, 'createSession');
    }
    const parsed = (await res.json()) as Partial<CreateSessionResponsePayload>;
    const sessionId = parsed.sessionId;
    if (!sessionId) {
      throw new WorkerUnavailableException(
        worker.id,
        `createSession 响应缺少 sessionId：${JSON.stringify(parsed)}`,
      );
    }
    return { sessionId };
  }

  /**
   * POST /sessions/:id/prompt：向会话下发一条提示（**经 worker 执行端点**）。
   *
   * ⚠️ **语义**：本端点是「**持久化入队**」，**不是**「同步执行」——响应只表示
   * 「已被收件箱收下」，**不代表 agent 已答复**。终态只能看事件或再读消息端点。
   *
   * - 请求体（vteam 形状）：`{prompt, model?, agent?, directory?, system?, delivery?}`；
   * - `delivery` **显式**给出：在飞注入（`inFlight`）= `steer`（插队打断当前轮）；
   *   常规下发同样显式 `steer`（v2 的默认投递策略本就是 steer，但**不依赖默认**——
   *   默认值一变行为就静默漂移）；
   * - 响应体：回带**收件条目 id**（`messageId`）与**实际生效**的投递策略。
   */
  async promptSession(
    worker: WorkerEndpointRef,
    sessionId: string,
    opts: SessionPromptOptions,
  ): Promise<SessionPromptResponsePayload> {
    const delivery: WorkerDeliveryMode = opts.inFlight
      ? 'steer'
      : (opts.delivery ?? 'steer');
    const body: SessionPromptRequestPayload = {
      prompt: opts.prompt,
      ...(opts.model ? { model: { ...opts.model } } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.directory ? { directory: opts.directory } : {}),
      ...(opts.system ? { system: opts.system } : {}),
      delivery,
    };
    const res = await this.requestExec(
      worker,
      `/sessions/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Token': this.workerToken,
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      await this.failFromResponse(worker, res, 'promptSession');
    }
    const parsed = (await res.json()) as Partial<SessionPromptResponsePayload>;
    return {
      sessionId: parsed.sessionId ?? sessionId,
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
      ...(parsed.delivery ? { delivery: parsed.delivery } : {}),
      admitted: parsed.admitted === true,
    };
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
        ...(opts.inFlight ? { inFlight: true } : {}),
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
   * （401/413/400）→ WorkerUnavailableException（fetchFile 内判断，调用方降级）。
   *
   * ⚠️ **404 单独成类**（`WorkerFileNotFoundException`）：worker 说「这个文件我没有」
   * 与「worker 不可用」是两件事——前者是引用/产出物不存在（404），后者是节点故障
   * （503）。混同成「worker 不可用」会让调用方与 agent 去查节点状态（缺陷 1）。
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
      if (res.status === 404) {
        throw new WorkerFileNotFoundException(
          worker.id,
          `${filePath}（${await this.readErrorDetail(res)}）`,
        );
      }
      throw new WorkerUnavailableException(
        worker.id,
        `file fetch HTTP ${res.status}`,
        res.status,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** 非 2xx 响应体的可读细节（JSON {error} 优先；非 JSON 保留原文；读失败不抛错）。 */
  private async readErrorDetail(res: Response): Promise<string> {
    let raw = '';
    try {
      raw = await res.text();
    } catch {
      return 'HTTP 404';
    }
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      return parsed.error || raw || 'HTTP 404';
    } catch {
      return raw || 'HTTP 404';
    }
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
   * POST /secret-command（worker 执行端点，X-Worker-Token 保护）：同步执行敏感命令。
   *
   * - 超时显式注入：请求超时 = 命令超时 + SECRET_COMMAND_REQUEST_TIMEOUT_SLACK_MS（5s），
   *   恒 > DEFAULT_REQUEST_TIMEOUT_MS（60s）——敏感命令最长可到 300s+，绝不能被默认 60s 掐断。
   * - 失败归一：非 2xx / 网络失败 / 超时 / 非 JSON 响应一律 WorkerUnavailableException，
   *   `httpStatus` 保留 worker 侧原码（400 模板非法、409 幂等冲突、5xx 故障）。
   * - 不泄露：请求体含明文 secrets，本方法全程不写日志；异常 detail 只带状态码，
   *   不回显响应体，更不回显请求体。
   */
  async runSecretCommand(
    worker: WorkerEndpointRef,
    opts: SecretCommandRequest,
  ): Promise<SecretCommandResult> {
    const commandTimeoutMs = this.resolveSecretCommandTimeout(opts.timeoutMs);
    const requestTimeoutMs =
      commandTimeoutMs + SECRET_COMMAND_REQUEST_TIMEOUT_SLACK_MS;
    const res = await this.requestExec(
      worker,
      '/secret-command',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Token': this.workerToken,
        },
        body: JSON.stringify({
          requestId: opts.requestId,
          commandTemplate: opts.commandTemplate,
          secrets: opts.secrets,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          timeoutMs: commandTimeoutMs,
          ...(opts.taskId ? { taskId: opts.taskId } : {}),
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        }),
      },
      requestTimeoutMs,
    );
    if (!res.ok) {
      throw new WorkerUnavailableException(
        worker.id,
        `secret-command HTTP ${res.status}`,
        res.status,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new WorkerUnavailableException(
        worker.id,
        'secret-command 响应非合法 JSON',
        res.status,
      );
    }
    const result = body as Partial<SecretCommandResult> | null;
    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      typeof result.status !== 'string'
    ) {
      throw new WorkerUnavailableException(
        worker.id,
        'secret-command 响应缺少 status 字段',
        res.status,
      );
    }
    return result as SecretCommandResult;
  }

  /**
   * 命令超时归一：对齐 worker normalizeTimeout（缺省 60000，上限 600000），
   * 请求超时据此计算——先归一再算请求超时，客户端与 worker 的超时预算才一致。
   */
  private resolveSecretCommandTimeout(timeoutMs?: number): number {
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      return DEFAULT_SECRET_COMMAND_TIMEOUT_MS;
    }
    return Math.min(timeoutMs, MAX_SECRET_COMMAND_TIMEOUT_MS);
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
   * GET /models：模型目录（**经 worker 执行端点**；vteam 自有形状）。
   *
   * ⚠️ 控制面**不再**知道被驱动端的模型列表包装（v2 是 `{location,data}`、v1 是 `{data}`）
   * ——worker 在驱动接缝处归一成 `{models: WorkerModelInfo[]}`（决策 D3）。
   *
   * 降级策略：网络错/worker 离线/旧版无该端点/空结果 → 回退 capabilities 声明的模型
   * （列表类端点失败不阻断页面）。
   */
  async listModels(worker: WorkerEndpointRef): Promise<WorkerModel[]> {
    try {
      const res = await this.requestExec(worker, '/models', {
        method: 'GET',
        headers: { 'X-Worker-Token': this.workerToken },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as Partial<WorkerModelsResponsePayload>;
      const models = Array.isArray(body.models) ? body.models : [];
      if (models.length === 0) {
        throw new Error('empty model data');
      }
      return models.map((m) => ({
        id: m.id ?? `${m.providerID ?? ''}/${m.modelID ?? ''}`,
        name: m.name ?? m.modelID ?? '',
        providerID: m.providerID ?? '',
        modelID: m.modelID ?? '',
        ...(m.status !== undefined ? { status: m.status } : {}),
      }));
    } catch (err) {
      // 网络失败/旧版无该端点/空数据 → 降级 capabilities 声明（T11 动态化前占位）。
      // 可观测性：记录 worker id + 解析出的执行端点 URL，并在消息中区分
      // 「worker 不可达/请求失败」与「worker 可达但返回空模型列表」。
      const baseUrl = this.resolveExecBaseUrl(worker);
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
   * 用于 vteam 页面展示与切换 opencode agent。`directory` 必须与执行期下发提示时的
   * directory 同值（serve 按 directory 发现 opencode.json 的 agent 节，per-directory 隔离）。
   *
   * 降级策略**对齐 listModels**：列表类端点失败不阻断页面——网络错/worker 离线/旧版无该
   * 端点/空结果一律返回 `[]`，由调用方以 degraded 标记提示前端。故本方法不抛
   * WorkerUnavailableException（与 execute/中断 等写路径的失败语义相反）。
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
   * directory 可选（与执行期下发提示时同值，驱动端按目录定位会话上下文）。
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

  /**
   * POST /sessions/:id/abort：中断会话当前这一轮（**经 worker 执行端点**）。
   *
   * 幂等：对未知/已结束的会话，worker 一律回 200（`interrupted:false`）——
   * 「没什么可中断的」不是错误。
   */
  async abort(
    worker: WorkerEndpointRef,
    sessionId: string,
  ): Promise<SessionAbortResponsePayload> {
    const res = await this.requestExec(
      worker,
      `/sessions/${encodeURIComponent(sessionId)}/abort`,
      {
        method: 'POST',
        headers: { 'X-Worker-Token': this.workerToken },
      },
    );
    if (!res.ok) {
      await this.failFromResponse(worker, res, 'abort');
    }
    const parsed = (await this.readJsonSafe(
      res,
    )) as Partial<SessionAbortResponsePayload>;
    return {
      sessionId: parsed.sessionId ?? sessionId,
      interrupted: parsed.interrupted === true,
    };
  }

  /**
   * GET /sessions/:id/messages：读会话消息（**经 worker 执行端点**；可分页）。
   *
   * 返回 vteam 渲染模型形状的消息数组（`{info, parts}`），不是被驱动端的原始包装。
   */
  async getMessages(
    worker: WorkerEndpointRef,
    sessionId: string,
    query?: SessionMessagesQuery,
  ): Promise<SessionMessage[]> {
    const params = new URLSearchParams();
    if (query?.limit !== undefined) {
      params.set('limit', String(query.limit));
    }
    if (query?.order) {
      params.set('order', query.order);
    }
    if (query?.cursor) {
      params.set('cursor', query.cursor);
    }
    const qs = params.toString();
    const res = await this.requestExec(
      worker,
      `/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`,
      {
        method: 'GET',
        headers: { 'X-Worker-Token': this.workerToken },
      },
    );
    if (!res.ok) {
      await this.failFromResponse(worker, res, 'getMessages');
    }
    const body = (await res.json()) as Partial<SessionMessagesResponsePayload>;
    return Array.isArray(body.messages) ? body.messages : [];
  }

  /**
   * worker 执行端点健康检查（GET /models：200 → 在线）。
   *
   * ⚠️ T18：**不再**探活 opencode serve 的 `GET /`——v2 的该端点不鉴权也回 200
   * （body 是 web SPA 的 HTML），拿它当健康检查会**因错误的原因通过**。
   * 改为探活 worker 自己的执行端点（带 token，顺带验证鉴权配置）。
   */
  async isHealthy(worker: WorkerEndpointRef): Promise<boolean> {
    try {
      const res = await this.requestExec(worker, '/models', {
        method: 'GET',
        headers: { 'X-Worker-Token': this.workerToken },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * 非 2xx 响应 → 归一成异常（保留 worker 侧错误码与状态码）。
   *
   * - 404 且 body 带 `code:'SESSION_NOT_FOUND'` → **会话失效**（调用方重建会话）；
   * - 429 且 body 带 `code:'RATE_LIMITED'` → **上游限流**（调用方退避重试）；
   * - 其余（含「旧版 worker 没有该端点」的 404）→ worker 不可用（503）。
   *
   * ⚠️ 必须看 body 的 `code` 才能区分：执行端点的「路径不存在」也是 404，
   * 把它误判成「会话失效」会让控制面反复重建会话（重建也失败 → 无限循环）。
   */
  private async failFromResponse(
    worker: WorkerEndpointRef,
    res: Response,
    label: string,
  ): Promise<never> {
    const raw = await res.text();
    let detail = raw;
    let code: string = WORKER_CLIENT_ERRORS.WORKER_UNAVAILABLE;
    try {
      const parsed = JSON.parse(raw) as { error?: string; code?: string };
      detail = parsed.error ?? raw;
      if (res.status === 404 && parsed.code === 'SESSION_NOT_FOUND') {
        code = WORKER_CLIENT_ERRORS.SESSION_NOT_FOUND;
      } else if (res.status === 429 && parsed.code === 'RATE_LIMITED') {
        code = WORKER_CLIENT_ERRORS.RATE_LIMITED;
      }
    } catch {
      /* 非 JSON 响应体：保留原文 */
    }
    throw new WorkerUnavailableException(
      worker.id,
      `${label} HTTP ${res.status}: ${detail}`,
      res.status,
      code,
    );
  }

  /** 读 JSON 响应体（非 JSON 时返回空对象，不抛错——调用方按缺省字段兜底）。 */
  private async readJsonSafe(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  /** 执行端点请求入口（worker 执行端点与 opencode serve 是不同端口，独立解析基址）。 */
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

  /** 核心请求：指定 baseUrl + 超时控制 + 错误归一（503 带 workerId）。 */
  private async requestToUrl(
    baseUrl: string,
    workerId: string,
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      throw new WorkerUnavailableException(
        workerId,
        this.describeError(err, timeoutMs),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 执行端点基址解析（T18：控制面只连 worker 执行端点，不再连 opencode serve）。
   *
   * - `capabilities.execBaseUrl`（完整基址，如 `http://worker:4198`）优先；
   * - 否则 `capabilities.execPort` + **worker 对外公布的主机**；
   * - 都没有 → `WORKER_BASE_URL` 回退基址的主机 + 缺省执行端口。
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
    return `${this.resolveAdvertiseOrigin(worker)}:${execPort}`;
  }

  /**
   * worker 对外公布的**主机**（protocol://host，不含端口）。
   *
   * 来源：`capabilities.baseUrl` 的 origin（worker 上报 `${WORKER_ADVERTISE_HOST}:${serve 端口}`，
   * 此处**只取主机部分**——serve 端口不再被使用：控制面不与 opencode serve 通信，
   * 决策 D3 要求它只认 worker 自己的执行端点）；缺省 → `WORKER_BASE_URL` 回退基址。
   */
  private resolveAdvertiseOrigin(worker: WorkerEndpointRef): string {
    const caps = (worker.capabilities ?? {}) as Record<string, unknown>;
    const raw =
      typeof caps.baseUrl === 'string' && caps.baseUrl
        ? caps.baseUrl
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

  /**
   * 错误信息归一（超时/网络/HTTP 消息，避免泄露过多内部细节）。
   * `timeoutMs` 供超时文案报出生效的请求超时（secret-command 等显式超时路径不误导为默认 60s）。
   */
  private describeError(
    err: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): string {
    // fetch abort 在 Node 18+ 抛 DOMException（非 Error 实例），按 name 识别 AbortError
    const name =
      typeof err === 'object' && err !== null && 'name' in err
        ? (err as { name?: string }).name
        : undefined;
    if (name === 'AbortError') {
      return `请求超时（>${timeoutMs}ms）`;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}
