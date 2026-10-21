/**
 * T10 执行端点（方案 A：worker 主动推）。
 *
 * 独立 HTTP server（node:http 内置，不引依赖），固定端口 WORKER_EXEC_PORT（默认 4198），
 * 监听两个端点：
 * - `POST /execute`：收到执行请求 → 立即 202 {accepted:true}（fire-and-forget）→
 *   异步驱动 serve（createSession → sendMessage → awaitCompletion）→ 事件经 EventSender
 *   按序上送（session.updated running → message.part.delta 流式 → task.completed/idle
 *   或 agent.status error/failed）。trackInstanceStart/End 驱动心跳 load 计数。
 * - `GET /file?path=<绝对路径>`（FR-41）：控制面经 WorkerClient 从 worker 工作区拉取
 *   文件内容（X-Worker-Token 鉴权，只读文件，10MB 上限），group_post fileRef 归档用。
 *
 * 另有 **会话/模型端点组**（T10 / 决策 D3）：`POST /sessions`、`POST /sessions/:id/prompt`、
 * `POST /sessions/:id/abort`、`GET /sessions/:id/messages`、`GET /models`——控制面此前
 * 直连 opencode 的 5 个调用点全部收进 worker（经 OpenCodeDriver 接缝转发），
 * 控制面从此只认 vteam 自有的 wire 形状。五者均带 X-Worker-Token 鉴权。
 *
 * 并发安全：同一 worker 多任务（多 session）并行执行；每个 /execute 独立驱动，按
 * opencode 会话 id（请求 sessionId 或新建）区分，serve 单实例多会话。
 *
 * 事件 payload 对齐 server 契约（worker-event.ingress.ts TaskCompletedPayload/
 * AgentStatusPayload）：sessionId 语义为 opencode 会话 id（ses_ 前缀），server 侧
 * 经 Session.instanceRef 反查映射平台 Session 主键（F2 MINOR 防御）。
 */

import { promises as fsp } from 'fs';
import * as http from 'http';
import * as path from 'path';
import { EventSender } from '../client/event-client';
import {
  CompletionResult,
  CompletionTimeoutError,
  MessageDeltaTracker,
  sendAndAwait,
} from '../driver/prompt-await';
import { ServeEventStream } from '../driver/serve-event-stream';
import {
  RunTerminalGate,
  V2StreamAccumulator,
  assembleAssistantText,
  deriveUpstreamIdentity,
  mapV2Event,
  normalizeV2ContentIdList,
  normalizeV2ContentIds,
  resolveV2SessionId,
} from '../driver/v2-event-map';
import type { V2EventFrame } from '../driver/v2-event-map';
import { isServeFatalLine } from '../runtime/serve-log';
import { ResourceInjector } from '../resources/injector';
import {
  LOCAL_CONFIG_KINDS,
  LocalConfigApplier,
  LocalConfigError,
  LocalConfigKind,
} from './local-config';
import { ConfigReloadOutcome } from '../reload/config-reloader';
import {
  PendingRequestSnapshot,
  detectPendingRequests,
  fetchPendingForms,
  fetchPendingPermissions,
} from '../reload/pending-requests';
import {
  DriverModelRef,
  DriverRequestError,
  Logger,
  DriverMessage,
  DriverContent,
  OpenCodeDriver,
} from '../driver/opencode-driver';
import {
  ensureBrowserProfileDir,
  resolveBrowserScopeId,
} from '../browser/browser-tools';
import {
  trackInstanceEnd,
  trackInstanceRekey,
  trackInstanceStart,
} from '../instance-tracker';
import {
  isOmoBundled,
  readOmoEnabled,
  writeOmoEnabled,
} from '../resources/omo-enabled';
import {
  OMO_AGENT_NAMES,
  readOmoAgents,
  resolveOmoConfigPath,
  writeOmoAgents,
} from '../resources/omo-config';
import { UNKNOWN_MODEL_KEY, WORKER_EVENT_TYPES } from '../protocol/worker-protocol';
import type { UpstreamEventIdentity } from '../protocol/worker-protocol';
import type {
  CreateSessionRequestPayload,
  SecretCommandRequestPayload,
  SecretCommandResponsePayload,
  SensitiveCommandOutput,
  SessionAbortResponsePayload,
  SessionMessagesQuery,
  SessionMessagesResponsePayload,
  SessionPromptRequestPayload,
  SessionPromptResponsePayload,
  WorkerModelInfo,
  WorkerModelRef,
} from '../protocol/worker-protocol';
import { collectFileArtifacts } from './artifact-extract';
import { SensitiveCommandError, runSensitiveCommand } from './sensitive-command';
import type { SensitiveCommandErrorCode } from './sensitive-command';

export interface ExecutionConfig {
  permissions: Record<string, 'allow' | 'ask' | 'deny'>;
  writePaths: string[];
}

/** POST /execute 请求体（server dispatchForTarget 下发形状）。 */
export interface ExecuteRequestPayload {
  /** 平台 Task 主键（t_ 前缀），事件回流透传。 */
  taskId?: string;
  /** Agent id（a_ 前缀），事件回流透传。 */
  agentId?: string;
  /** 消息来源频道 id，事件回流透传（server 据此群聊优先回结论）。 */
  channelId?: string;
  /** opencode 会话 id（ses_ 前缀，复用 serve 会话）；缺省则 createSession 新建。 */
  sessionId?: string;
  /** 提示内容：字符串（转单 text part）或 parts 数组（透传 serve）。 */
  prompt: string | unknown[];
  /** 模型选择（可选，缺省 serve 默认模型）。 */
  model?: DriverModelRef | null;
  /** opencode agent 名（可选，缺省 serve 默认 agent）。 */
  agent?: string;
  /** 工作目录（prompt_async query 参数）。 */
  directory?: string;
  /**
   * 用户消息图片附件引用（问题二：图片进执行上下文）。worker 下载到执行目录后以
   * serve file part 形式并入 prompt。url 仅接受 /uploads/… 相对路径（按
   * serverBaseUrl 拼接）或与 serverBaseUrl 同源的 http(s) 绝对 URL；file://
   * 等本地路径一律拒绝（server 不得指定 worker 本地路径，防路径穿越）。
   */
  attachments?: ExecuteAttachment[];
  /** P7：顶层 system 提示（产出物协议/@机制等，serve 拼入 LLM system message，不进会话记录）。 */
  system?: string;
  /** 执行策略配置（服务端 ExecutionPolicy 下发，worker 盲翻成 opencode 配置，A1 通道①）。 */
  executionConfig?: ExecutionConfig;
  /** 在飞注入标志（双写镜像 server 语义：同 ses 已有运行，仅追加 prompt，不建跟踪/不出终态事件）。 */
  inFlight?: boolean;
}

/**
 * POST /question-reply 请求体（server QuestionsService 下行调 worker 执行端点）。
 * 两种语义按字段区分：
 * - question：{sessionId, requestId, answers: string[][]}——回答；answers=null + reject=true → rejectQuestion
 * - permission：{sessionId, permissionId, response: "once"|"always"|"reject"}——权限确认
 * sessionId 为 opencode 会话 id（ses_ 前缀，server 从平台 Session.instanceRef 反查）。
 */
export interface QuestionReplyRequestPayload {
  sessionId: string;
  requestId?: string;
  answers?: string[][] | null;
  reject?: boolean;
  permissionId?: string;
  response?: 'once' | 'always' | 'reject';
}

/** POST /execute 的单个图片附件引用（轻量引用，不含字节；worker 按需下载落盘）。 */
export interface ExecuteAttachment {
  /** /uploads/… 相对路径或 http(s) 绝对 URL（file:// 等本地路径拒绝）。 */
  url: string;
  /** MIME（如 image/png；缺省按扩展名推断）。 */
  mime?: string;
  /** 原文件名（缺省取 url basename，用于落盘命名与 file part）。 */
  filename?: string;
}

/** FR-41：GET /file 单文件大小上限（10MB，超限 413，对齐 server FILE_SIZE_LIMIT）。 */
export const MAX_FILE_FETCH_BYTES = 10 * 1024 * 1024;

/**
 * 计划文档目录（按顺序探测，先命中者胜）。
 *
 * ⚠️ 三个位置都要看，原因与 OmO 配置文件同理（见 resources/omo-config.ts）：
 * OmO 把工作区元数据统一收进 `.omo/`，**当前版本实际把 agent 产出的计划写在
 * `.omo/plans/`**；而 `.opencode/plans/` 是 opencode 原生 plan agent 的约定位置
 * （也是 vteam 早期版本约定的位置）；`.omo/drafts/` 是 OmO 原生规划工作流的
 * 草稿目录（plan 模式先落草稿），从未被扫描会导致草稿计划不可见。
 *
 * 实测：装了 OmO 后，主 Agent 在计划模式下产出的文件落在 `<taskDir>/.omo/plans/plan.md`，
 * 只读 `.opencode/plans/` 会得到空列表——计划明明写出来了，页面却显示"暂无计划"。
 *
 * 读取时**三个目录都扫**（合并结果，按文件名去重），因此不论 agent 用哪个位置都能展示；
 * 写入（用户上传）统一落 `PLAN_DOCS_DIR`（首个位置）。
 */
export const PLAN_DOCS_DIRS = ['.omo/plans', '.opencode/plans', '.omo/drafts'] as const;
/** 计划文档写入位置（上传落点）：取探测列表首位。 */
export const PLAN_DOCS_DIR = PLAN_DOCS_DIRS[0];
/** 计划文档读取上限（单文件 256KB，超限截断 + truncated 标记，防大文件撑爆列表响应）。 */
export const MAX_PLAN_DOC_BYTES = 256 * 1024;
/** 计划文档上传上限（1MB，与 maxBodyBytes 默认对齐；超限 413）。 */
export const MAX_PLAN_UPLOAD_BYTES = 1024 * 1024;
/**
 * 计划文件名白名单（路径穿越唯一防线）：字母数字开头，仅含字母数字/`_`.`-`，
 * 必须 `.md` 结尾。`basename` 之后仍校验——`a/../b.md` 之类全部拒绝。
 */
export const PLAN_DOC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]*\.md$/;

/**
 * 问题二图片附件下载上限（5MB）。
 * uploads 端允许 10MB，但进执行上下文的图片走模型视觉通道：5MB 覆盖手机截图/
 * 相机直出常规尺寸，超限则跳过该图并在 prompt 内注明（模型如实告知用户重发，
 * 不静默谎称看见）。与 MAX_FILE_FETCH_BYTES（控制面拉取）解耦，互不影响。
 */
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * 待答复项检测的**会话范围上限**（FIFO 淘汰最旧的）。
 *
 * 为什么要界：检测是**逐会话**的（`GET /api/session/{id}/form` 与 `/permission`），
 * 成本 = 2×会话数的本地 HTTP 往返；会话数无界会让一次配置变更越等越久。
 * 取 100：待答复项属于「用户正在交互」的会话（必然是近期的），
 * 100 个会话的检测成本 ≈ 200 次本地往返（亚秒级）。
 */
export const KNOWN_SESSIONS_LIMIT = 100;

/**
 * T14：**终态宽限期** ms（事件路 ↔ 轮询路合流时的等待上限）。
 *
 * 轮询路判定完成（见到 step-finish）后，若事件路还没给出终态，等这么久让它补齐——
 * 目的是让「轮询先到」与「事件先到」两种顺序**得到同一个结论**（事件证据优先）。
 * 与 `prompt-await` 的默认值同口径（500ms）。
 */
const EVENT_GRACE_MS = 500;

export interface ExecServerOptions {
  /** 监听端口（WORKER_EXEC_PORT）。 */
  port: number;
  /** 驱动 serve 的 OpenCodeDriver。 */
  driver: OpenCodeDriver;
  /** 事件上送通道（进程内 EventSender 单例）。 */
  sender: EventSender;
  /**
   * FR-41：文件端点鉴权 token（X-Worker-Token === workerToken 才允许 GET /file）。
   * 空 = 拒绝所有文件请求（文件读取更敏感，无 token 配置时宁可不暴露，绝不无鉴权放行）。
   */
  workerToken?: string;
  /**
   * 首字超时 ms（awaitCompletion 首字超时：时限内模型无输出 → abort + 上送 error）；
   * 缺省 0=禁用首字超时（env WORKER_FIRST_TOKEN_TIMEOUT_MS 可 opt-in）。
   * 首字出现后无完成超时。
   */
  firstTokenTimeoutMs?: number;
  /**
   * 执行总时长上限 ms（透传 awaitCompletion；opt-in，默认 0 = 禁用）。首字出现后到期限
   * 仍无完成（step-finish）→ abort + 抛「执行总时长超限」；<=0/缺省保持既有
   * 「首字后无完成超时」契约。env WORKER_TOTAL_TIMEOUT_MS 可配。
   */
  totalTimeoutMs?: number;
  /** 完成判定轮询间隔 ms（透传 awaitCompletion；缺省其默认 500）。 */
  pollMs?: number;
  /**
   * T17：serve 最近模型错误日志行读取器（数据源 OpencodeServer.recentErrors()，index.ts
   * 接线注入）。awaitCompletion 每轮轮询调用（参数 = 会话 id，剔除其它会话历史错误），
   * serve 对 Rate limit/Free usage 等 APIError 不透传 message.info.error——匹配关键词时
   * 提前 abort + 抛错（错误文本透传前端），不再空等首字超时。缺省 = 不检测（保持原行为）。
   */
  serveErrorReader?: (sessionID: string) => string[];
  /**
   * 原始 serve 日志尾部读取器（数据源 OpencodeServer.recentLogTail()）。模型错误不可提取时
   * 把原始行附进失败原因，保证失败始终携带证据。缺省 = 不附证据（保持原行为）。
   */
  serveLogReader?: (sessionID: string) => string[];
  /** 请求体大小上限 bytes；默认 1MB。 */
  maxBodyBytes?: number;
  /**
   * 控制面基址（config.serverUrl，如 http://server:3000）：附件相对路径
   * （/uploads/…）按此拼接下载。缺省则只接受绝对 URL 的附件。
   */
  serverBaseUrl?: string;
  /** 日志输出；默认 console。 */
  logger?: Logger;
  /**
   * Browser profile root（worker workDir，如 /data/vteam-worker）：runExecution
   * 按 opencode 会话 id 预建 browser-profiles/<scope>/（per-agent 隔离落点，
   * 见 browser-tools.ts）。缺省 = 不预建（shim 运行时仍会自建；单测默认关闭，
   * 避免触碰真实文件系统）。
   */
  browserProfileRoot?: string;
  /**
   * opencode serve 工作目录（worker workDir，如 /data/vteam-worker）。
   * GET /agents 未显式传 directory 时的回落值——必须与 serve 的 cwd 一致，
   * 否则列出的 agent 集合与实际执行时不符（serve 按 directory 发现 opencode.json）。
   * 缺省 = 不回落（返回 400 要求调用方显式传 directory）。
   */
  workDir?: string;
  /**
   * git 凭证文件的**插件可见 HOME**（= opencode 隔离配置域的 HOME；index.ts 注入）。
   *
   * 为什么需要：git 工具族是 opencode 插件，跑在 serve 子进程里，而隔离配置域把子进程的
   * HOME 重定向到隔离域 ⇒ 凭证必须落到那里，插件才读得到。
   * 缺省 = 不传（只写 worker 自己 HOME；仅老调用方/单测会走到）。
   */
  gitCredsHome?: string;
  /**
   * OmO 配置保存后重启 serve 使新配置生效（index.ts 注入 RestartCoordinator.requestRestart）。
   *
   * 为什么必须重启：opencode 在 serve **启动时**读取 OmO 配置，改文件不热生效——不重启则
   * 新会话仍用旧模型（实测确认）。这里复用 RestartCoordinator 而非直接 restart，因为后者
   * 会先判断有无活跃会话：无 → 立即重启；有 → 挂起等归零，**不会中断进行中的会话**。
   *
   * 返回值透传给前端：'executed'（已重启，下个会话即生效）/ 'pending'（有活跃会话，
   * 已挂起等归零）。缺省不注入 = 保存后不重启（配置留待下次自然重启生效）。
   */
  restartServe?: (reason: string) => Promise<'executed' | 'pending'>;
  /**
   * 配置热重载执行器（**不重启 serve 进程**；index.ts 注入 ConfigReloader.reload）。
   *
   * 与 `restartServe` 的分工：
   * - `restartServe` = **真重启**（二进制升级 / 运维重启 / 崩溃恢复）；
   * - `reloadServe`  = **热重载**（配置类变更：skills/tools/MCP/agent 策略/模型凭据）。
   *
   * 返回值：热重载结局（'reloaded' 已生效 / 'deferred' 有待答复项故延后，改走文件监听
   * 路径 / 'failed' 调用失败 / 'unverified' 重载成功但效果未确认 ⇒ 调用方回退真重启）。
   * 缺省不注入 = /config/reload 返回 503（与 /config/restart 同款契约）。
   */
  reloadServe?: (reason: string) => Promise<ConfigReloadOutcome>;
  /**
   * 独立模式（WORKER_STANDALONE）：挂载 POST /config/* 本地配置下推端点。
   * 缺省 false = 不挂载（注册模式的配置一律走控制面下发，避免双事实源）。
   */
  standalone?: boolean;
  /**
   * 资源注入器（独立模式本地配置下推用）。standalone=true 时必须提供，
   * 否则 /config/* 返回 503。
   */
  resourceInjector?: ResourceInjector;
}

/** 请求体解析失败（非 JSON / 缺字段）。 */
export class ExecuteRequestError extends Error {}

/** model 可读描述（providerID/modelID；缺省 → 标记 serve 默认模型，供日志排障确认实际模型）。 */
function describeModel(model: DriverModelRef | null | undefined): string {
  if (!model) {
    return '(default)';
  }
  return `${model.providerID}/${model.modelID}`;
}

/** 用量口径模型标识（`providerID/modelID` 原样组合；缺失/空 → UNKNOWN_MODEL_KEY 哨兵串）。 */
function usageModelKey(model: DriverModelRef | null | undefined): string {
  if (!model?.providerID || !model.modelID) {
    return UNKNOWN_MODEL_KEY;
  }
  return `${model.providerID}/${model.modelID}`;
}

/**
 * task.completed 的 model 取值链（**唯一**出口，格式统一走 usageModelKey，禁止旁路拼接）：
 *
 * 1. `configured`（payload.model = 显式下发的模型，来源 agent/worker 的 default_model_id）
 *    —— 配置即事实，优先级最高；显式配置了但 serve 回报不同模型时以配置为准（防 serve
 *    会话中途被换模型的统计漂移）。
 * 2. `reported`（serve 回报的实际模型 = CompletionResult.model，来自 assistant 消息
 *    info.providerID/modelID）—— 零配置环境（default_model_id 为空 → 下发 body 不带
 *    model）的唯一真相来源：serve 用自己的默认模型，不回报就永远落 unknown。
 * 3. 两级都缺 → UNKNOWN_MODEL_KEY 哨兵串（下游无需判空）。
 */
export function resolveUsageModelKey(
  configured: DriverModelRef | null | undefined,
  reported: DriverModelRef | null | undefined,
): string {
  const fromConfig = usageModelKey(configured);
  return fromConfig !== UNKNOWN_MODEL_KEY ? fromConfig : usageModelKey(reported);
}

/** 将字符串 prompt 归一为 parts 数组（对象数组直接透传）。 */
export function normalizeParts(prompt: string | unknown[]): unknown[] {
  if (typeof prompt === 'string') {
    return [{ type: 'text', text: prompt }];
  }
  return prompt;
}

/**
 * 会话类端点的路径段解析（`/sessions/:id/<action>`）。
 *
 * 为什么需要它：本文件的路由分发是「pathname 精确串比较」，而会话类端点带一个
 * **路径参数**（会话 id）。段数必须**精确**匹配——`/sessions/abc`（少一段）与
 * `/sessions/abc/prompt/extra`（多一段）都**不算命中**，杜绝错路由静默命中
 * （例如把 `/sessions/abc` 当成 `/sessions/:id/messages` 去拉消息）。
 *
 * - 两段都做 URL 解码（会话 id 可能含需转义的字符，如 `%2F`）。
 * - 解码失败（非法转义序列）或段为空 → 视为不匹配（上层回 404）。
 */
export function parseSessionActionPath(
  pathname: string,
): { id: string; action: string } | null {
  const segments = pathname.split('/');
  // 前导 '/' 会切出一个空串 → 合法形态是 ['', 'sessions', ':id', '<action>']（长度 4）
  if (segments.length !== 4) {
    return null;
  }
  if (segments[0] !== '' || segments[1] !== 'sessions') {
    return null;
  }
  const id = decodePathSegment(segments[2]);
  const action = decodePathSegment(segments[3]);
  if (!id || !action) {
    return null;
  }
  return { id, action };
}

/** 单个路径段的 URL 解码；空段或非法转义序列 → null。 */
function decodePathSegment(segment: string): string | null {
  if (!segment) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * 解析请求体里的模型引用。
 *
 * 返回 `undefined` = 字段缺席；`null` = 显式 null；对象 = 合法引用。
 * 形状非法时返回 `invalid`（调用方回 400，不静默丢弃调用方的意图）。
 */
function parseModelRef(value: unknown): WorkerModelRef | null | undefined | 'invalid' {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'invalid';
  }
  const ref = value as { providerID?: unknown; modelID?: unknown };
  if (typeof ref.providerID !== 'string' || typeof ref.modelID !== 'string') {
    return 'invalid';
  }
  if (!ref.providerID || !ref.modelID) {
    return 'invalid';
  }
  return { providerID: ref.providerID, modelID: ref.modelID };
}

/**
 * 读取驱动 abort 回执里的「是否真的打断了一轮」标志。
 *
 * 驱动契约里 `abort` 只保证「**不抛错**」（对未知/已结束会话是幂等空操作），
 * 回执是否带中断细节由各实现自定（v1 无此概念 → 无回执细节）。故这里做**宽松读取**：
 * 带 `interrupted` 就采信，没带就按 false（= 没有打断任何一轮的证据）。
 */
function readInterruptedFlag(result: unknown): boolean {
  if (result && typeof result === 'object' && 'interrupted' in result) {
    return (result as { interrupted?: unknown }).interrupted === true;
  }
  return false;
}

/**
 * 解析消息端点的分页 query（limit / order / cursor）。
 *
 * 非法参数返回 null（调用方回 400）——不静默丢弃：调用方传了个错的 limit 却拿到
 * 全量结果，会误判「消息只有这么几条」。
 */
function parseMessagesQuery(url: URL): SessionMessagesQuery | null {
  const query: SessionMessagesQuery = {};
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null && rawLimit !== '') {
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit <= 0) {
      return null;
    }
    query.limit = limit;
  }
  const rawOrder = url.searchParams.get('order');
  if (rawOrder !== null && rawOrder !== '') {
    if (rawOrder !== 'asc' && rawOrder !== 'desc') {
      return null;
    }
    query.order = rawOrder;
  }
  const rawCursor = url.searchParams.get('cursor');
  if (rawCursor !== null && rawCursor !== '') {
    query.cursor = rawCursor;
  }
  return query;
}

/**
 * 请求体超限后丢弃剩余字节（自身也有上限，防止恶意无限流），使本次响应能被对端读完。
 * 与 readBody 的"超限即 reject 但不 destroy"配合：错误码要送得出去。
 */
function drainRequest(req: http.IncomingMessage, maxDrainBytes = 64 * 1024 * 1024): Promise<void> {
  return new Promise((resolve) => {
    let drained = 0;
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', done);
      req.removeListener('error', done);
      resolve();
    };
    const onData = (chunk: Buffer): void => {
      drained += chunk.length;
      if (drained > maxDrainBytes) {
        req.destroy();
        done();
      }
    };
    req.on('data', onData);
    req.on('end', done);
    req.on('error', done);
    if (req.readableEnded) {
      done();
    }
  });
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!exceeded) {
          exceeded = true;
          // 不 destroy：413 响应仍需送达（否则对端只看到 socket hang up）。
          // 其余字节交给调用方的 drainRequest 丢弃，这里不再累积内存。
          reject(new ExecuteRequestError(`请求体超过 ${maxBytes} bytes 上限`));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: object,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * `SensitiveCommandError.code` → 固定 400 文案。
 *
 * 按 code 查表而不是透传 `err.message`：即使模块未来在 message 里带了动态片段，
 * 路由也不会把它（或渲染命令/secret）回给调用方或写进日志。
 */
const SECRET_COMMAND_REJECTIONS: Record<SensitiveCommandErrorCode, string> = {
  invalid_input: '请求体必须是对象且包含 commandTemplate 与 secrets',
  invalid_workdir: 'worker 工作目录未配置或无法解析',
  invalid_template: 'commandTemplate 非法或超过大小上限',
  invalid_secrets: 'secrets 必须是字符串值对象',
  invalid_cwd: 'cwd 必须是工作目录内的相对路径',
  invalid_timeout: 'timeoutMs 必须是正有限数',
};

/** `/secret-command` 单次请求的最终回包（错误与成功共用同一暂存形状，供幂等回放）。 */
interface SecretCommandResult {
  status: number;
  body: SecretCommandResponsePayload | { error: string; code?: SensitiveCommandErrorCode };
}

/** 幂等表条目：归属判定字段 + 执行结果（在途时也可被回放方 await）。 */
interface SecretCommandRecord {
  taskId: string;
  sessionId: string;
  settled: boolean;
  result: Promise<SecretCommandResult>;
}

/**
 * 幂等表上限：只淘汰已落定的旧记录（在途记录永不淘汰），防止长生命周期 worker
 * 无界增长。淘汰掉的 requestId 理论上可重新执行，但重复提交的时间窗远小于容量。
 */
const SECRET_COMMAND_CACHE_MAX = 256;

/**
 * 把模块输出收敛为对外响应体：显式挑拣字段（不 spread 原对象），
 * 保证渲染命令/argv/cwd/secrets 无论模块返回什么形状都出不了 worker。
 */
function toSecretCommandResponse(
  requestId: string,
  output: SensitiveCommandOutput,
): SecretCommandResponsePayload {
  const payload: SecretCommandResponsePayload = {
    requestId,
    status: output.status,
    exitCode: output.exitCode,
    durationMs: output.durationMs,
    stdout: output.stdout,
    stderr: output.stderr,
    stdoutTruncated: output.stdoutTruncated,
    stderrTruncated: output.stderrTruncated,
  };
  if (output.error !== undefined) {
    payload.error = output.error;
  }
  return payload;
}

export class ExecServer {
  private readonly port: number;
  private readonly driver: OpenCodeDriver;
  private readonly sender: EventSender;
  private readonly workerToken: string;
  private readonly firstTokenTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly pollMs: number;
  private readonly serveErrorReader: ((sessionID: string) => string[]) | undefined;
  private readonly serveLogReader: ((sessionID: string) => string[]) | undefined;
  private readonly maxBodyBytes: number;
  private readonly serverBaseUrl: string;
  private readonly browserProfileRoot: string;
  /** GET /agents 的 directory 回落值（worker workDir；缺省空串 = 不回落）。 */
  private readonly workDir: string;
  /** OmO 配置保存后的 serve 重启回调（缺省 undefined = 不重启）。 */
  private readonly restartServe?: (reason: string) => Promise<'executed' | 'pending'>;
  /** 配置热重载回调（缺省 undefined = /config/reload 返回 503）。 */
  private readonly reloadServe?: (reason: string) => Promise<ConfigReloadOutcome>;
  /** 独立模式：挂载 POST /config/* 本地配置下推（注册模式不挂载，避免双事实源）。 */
  private readonly standalone: boolean;
  /** 本地配置下推执行器（standalone=true 且注入 resourceInjector 时可用）。 */
  private readonly localConfig?: LocalConfigApplier;
  private readonly logger: Logger;
  /** `POST /secret-command` 幂等表：requestId → 归属 + 执行结果（同 requestId 绝不二次执行）。 */
  private readonly secretCommands = new Map<string, SecretCommandRecord>();
  /**
   * 本 worker 接触过的 opencode 会话 id（新建 + 复用）——待答复项检测的会话范围。
   *
   * 为什么必须**逐会话**查：`POST /api/location/reload` 会取消**所有 location** 的
   * pending 项（实测 v2.0.28），而全局端点 `GET /api/form` 是**按 location 作用域**的
   * （会话 move 到任务目录后查不到）⇒ 用全局端点当闸门会漏判 ⇒ 静默销毁用户正在
   * 作答的问题。逐会话查与 location 无关。
   *
   * ⚠️ **有界**：只保留最近 {@link KNOWN_SESSIONS_LIMIT} 个会话（FIFO 淘汰）——
   * 待答复项属于「用户正在交互」的会话（必然是近期的），而逐会话检测的成本是
   * 2×会话数的本地 HTTP 往返，无界会让一次配置变更越等越久。
   */
  private readonly knownSessions = new Set<string>();
  private server: http.Server | null = null;

  constructor(options: ExecServerOptions) {
    this.port = options.port;
    this.driver = options.driver;
    this.sender = options.sender;
    this.workerToken = options.workerToken ?? '';
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 0;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 0;
    this.pollMs = options.pollMs ?? 500;
    this.serveErrorReader = options.serveErrorReader;
    this.serveLogReader = options.serveLogReader;
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this.serverBaseUrl = (options.serverBaseUrl ?? '').replace(/\/+$/, '');
    this.browserProfileRoot = options.browserProfileRoot ?? '';
    this.workDir = options.workDir ?? '';
    this.restartServe = options.restartServe;
    this.reloadServe = options.reloadServe;
    this.logger = options.logger ?? console;
    this.standalone = options.standalone ?? false;
    this.localConfig =
      this.standalone && options.resourceInjector
        ? new LocalConfigApplier({
            injector: options.resourceInjector,
            logger: this.logger,
            gitCredsHome: options.gitCredsHome,
          })
        : undefined;
  }

  /** 实际监听端口（start 成功后；未启动为 null）。 */
  get boundPort(): number | null {
    return this.server?.address() && typeof this.server.address() === 'object'
      ? (this.server.address() as { port: number }).port
      : null;
  }

  /** 记住一个 opencode 会话（待答复项检测的会话范围；FIFO 有界）。 */
  private rememberSession(sessionID: string): void {
    const id = typeof sessionID === 'string' ? sessionID.trim() : '';
    if (id === '') {
      return;
    }
    this.knownSessions.delete(id);
    this.knownSessions.add(id);
    while (this.knownSessions.size > KNOWN_SESSIONS_LIMIT) {
      const oldest = this.knownSessions.values().next();
      if (oldest.done) {
        break;
      }
      this.knownSessions.delete(oldest.value);
    }
  }

  /**
   * 检测当前是否存在**待答复的表单/权限**（逐会话查；location 无关）。
   *
   * 供配置热重载的安全闸门使用：`POST /api/location/reload` 会取消 pending 项，
   * ⇒ 有 pending 时**不得**重载。检测失败（结论不完整）时返回 `incomplete: true`
   * ⇒ 调用方走保守分支（不重载）。
   */
  async detectPendingRequests(): Promise<PendingRequestSnapshot> {
    return detectPendingRequests(this.driver, this.knownSessions);
  }

  /** 是否已监听。 */
  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** 启动监听。端口占用/绑定失败抛错（调用方决定降级或退出）。 */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err: unknown) => {
          this.logger.error(`[exec] 请求处理异常: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) {
            sendJson(res, 500, { error: 'internal error' });
          }
        });
      });
      server.once('error', (err: Error) => {
        this.server = null;
        reject(err);
      });
      server.listen(this.port, '0.0.0.0', () => {
        this.server = server;
        const address = server.address();
        const bound =
          typeof address === 'object' && address !== null ? address.port : this.port;
        this.logger.info(`[exec] 执行端点就绪: POST http://0.0.0.0:${bound}/execute`);
        if (this.workerToken) {
          this.logger.info(`[exec] 文件端点就绪: GET http://0.0.0.0:${bound}/file?path=<绝对路径>（X-Worker-Token 鉴权）`);
        } else {
          this.logger.warn(`[exec] 文件端点未启用: 未配置 workerToken，GET /file 一律 401`);
        }
        resolve(bound);
      });
    });
  }

  /** 停止监听（在途执行不中断，事件继续上送）。 */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server;
      this.server = null;
      if (!server || !server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  // ---- 请求处理 ----

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/execute') {
      await this.handleExecute(req, res);
      return;
    }
    if (url.pathname === '/file') {
      await this.handleFileFetch(req, res, url);
      return;
    }
    if (url.pathname === '/question-reply') {
      await this.handleQuestionReply(req, res);
      return;
    }
    if (url.pathname === '/secret-command') {
      await this.handleSecretCommand(req, res);
      return;
    }
    if (url.pathname === '/agents') {
      await this.handleAgentsList(req, res, url);
      return;
    }
    if (url.pathname === '/todos') {
      await this.handleTodosList(req, res, url);
      return;
    }
    if (url.pathname === '/plan-files') {
      await this.handlePlanFilesList(req, res, url);
      return;
    }
    if (url.pathname === '/plan-file') {
      await this.handlePlanFileWrite(req, res);
      return;
    }
    if (url.pathname === '/omo-config') {
      await this.handleOmoConfig(req, res);
      return;
    }
    if (url.pathname === '/omo-agent-prompt') {
      await this.handleOmoAgentPrompt(req, res, url);
      return;
    }
    // ── 会话/模型端点（T10 / 决策 D3）────────────────────────────────────
    // 这一组是「控制面彻底不直连 opencode」的承载面：控制面此前直连 opencode 的
    // 5 个调用点（建会话/下发提示/读消息/中断/取模型）全部收进 worker，经
    // OpenCodeDriver 接缝转发——控制面从此只认 vteam 自有的 wire 形状。
    if (url.pathname === '/sessions') {
      await this.handleSessionCreate(req, res);
      return;
    }
    const sessionRoute = parseSessionActionPath(url.pathname);
    if (sessionRoute) {
      await this.handleSessionAction(req, res, sessionRoute, url);
      return;
    }
    if (url.pathname === '/models') {
      await this.handleModelsList(req, res);
      return;
    }
    if (url.pathname.startsWith('/config/')) {
      await this.handleConfigRoute(req, res, url.pathname.slice('/config/'.length));
      return;
    }
    sendJson(res, 404, { error: `未支持的路径: ${url.pathname}` });
  }

  /**
   * GET/POST /omo-config——OmO 的 agent→模型配置读写。
   *
   * 配置落点 `<workDir>/.opencode/oh-my-openagent.jsonc`（OmO 按 cwd 读取的项目级配置）。
   * vteam 只做搬运与增量合并，不校验模型是否真的可用（那是用户在配置页里选的），
   * 也不碰 OmO 的其他配置项（顶层其他键原样保留）。
   *
   * - GET  → {agents: {name: model}, available: [...可配 agent 名]}
   * - POST {agents: {name: model}} → 增量合并；空串删除覆盖；返回 {written, agents}
   * - 鉴权：X-Worker-Token（写操作，与 /file 同级敏感）
   * - 未配置 workDir → 400（不猜目录）
   */
  private async handleOmoConfig(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { error: `仅支持 GET/POST，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      this.logger.warn('[exec] omo-config -> 拒绝（X-Worker-Token 无效） (HTTP 401)');
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    if (!this.workDir) {
      sendJson(res, 400, { error: '未配置 workDir，无法定位 OmO 配置' });
      return;
    }
    if (req.method === 'GET') {
      // 运行时 agent 元数据（描述/mode/是否已注册）：供配置页展示每个 agent 是干什么的。
      // 数据源是 serve `GET /agent`——与执行期同一份事实；拿不到（serve 未就绪）则留空，
      // 前端降级为只显示 agent 名（不阻断配置）。
      let runtime: Record<string, { description?: string; mode?: string; native?: boolean }> = {};
      try {
        const list = await this.driver.listAgents(this.workDir);
        for (const a of list) {
          // serve 的 name 是展示名（"Prometheus - Plan Builder"），配置键是基底名（prometheus）
          const key = (a.name.split(' - ')[0] ?? a.name).trim().toLowerCase();
          runtime[key] = {
            description: a.description,
            mode: a.mode,
            native: a.native,
          };
        }
      } catch {
        runtime = {};
      }
      sendJson(res, 200, {
        agents: readOmoAgents(this.workDir),
        available: OMO_AGENT_NAMES,
        /** 已注册到 serve 的 agent 基底名（未包含者在当前模型下不会被激活，如 hephaestus 需 GPT 系模型）。 */
        registered: Object.keys(runtime),
        /** agent 元数据：描述/mode/native（缺失=该 agent 当前未注册）。 */
        runtime,
        // 实际生效的配置文件（OmO 优先 .omo/omo.jsonc，其次旧的 .opencode/…）：
        // 透出给前端展示，避免"改了却不生效"时无从判断
        configPath: resolveOmoConfigPath(this.workDir).relPath,
        configKind: resolveOmoConfigPath(this.workDir).kind,
        // 开关：enabled=用户选择；bundled=本镜像是否内置 OmO（false 时前端不展示该区块）
        enabled: readOmoEnabled(this.workDir),
        bundled: isOmoBundled(),
      });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, this.maxBodyBytes);
    } catch (err) {
      await drainRequest(req);
      sendJson(res, 413, { error: err instanceof Error ? err.message : '请求体过大' });
      return;
    }
    let body: { agents?: unknown; enabled?: unknown };
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      sendJson(res, 400, { error: '请求体必须是合法 JSON' });
      return;
    }

    // ── 开关变更（可选，与 agents 互不依赖）──────────────────────────────
    // 只在"本镜像内置了 OmO"时允许开启——没内置的镜像开启毫无意义（插件不存在），
    // 直接 400 明确告知，而不是静默写入一个永远不生效的 true。
    const hasEnabled = typeof body.enabled === 'boolean';
    if (body.enabled !== undefined && !hasEnabled) {
      sendJson(res, 400, { error: 'enabled 必须是布尔值' });
      return;
    }
    if (body.enabled === true && !isOmoBundled()) {
      sendJson(res, 400, {
        error: '本 worker 镜像未内置 OmO，无法开启（请使用内置 OmO 的镜像）',
      });
      return;
    }
    if (!hasEnabled && body.agents === undefined) {
      sendJson(res, 400, { error: 'agents 或 enabled 至少提供一个' });
      return;
    }

    let patch: Record<string, string> = {};
    if (body.agents !== undefined) {
      const input = body.agents;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        sendJson(res, 400, { error: 'agents 必须是对象：{agent名: 模型}' });
        return;
      }
      for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          sendJson(res, 400, { error: `agents.${name} 必须是字符串（模型名，空串=清除覆盖）` });
          return;
        }
        patch[name] = value;
      }
    }

    try {
      // 开关先落盘（serve 重启时读它决定是否 --pure）
      if (hasEnabled) {
        const enabledFile = writeOmoEnabled(this.workDir, body.enabled as boolean);
        this.logger.info(
          `[exec] omo 开关 -> ${body.enabled ? 'on' : 'off'} (${enabledFile})`,
        );
      }
      const written =
        body.agents !== undefined
          ? writeOmoAgents(this.workDir, patch)
          : resolveOmoConfigPath(this.workDir).absPath;
      if (body.agents !== undefined) {
        this.logger.info(
          `[exec] omo-config 已更新: ${Object.keys(patch).length} 项 (${written})`,
        );
      }
      // 写盘后重启 serve 使新配置生效：opencode 只在**启动时**读 OmO 配置，不重启则
      // 新会话仍用旧模型（实测确认）。复用 RestartCoordinator：无活跃会话才立即重启，
      // 有则挂起等归零——所以这一步不会打断正在跑的 agent。
      const restartReason = hasEnabled
        ? `omo 开关（${body.enabled ? '启用' : '停用'}）`
        : 'omo-config（agent 模型配置更新）';
      const restart = this.restartServe
        ? await this.restartServe(restartReason).catch(
            (err: unknown) => {
              // 重启失败不上抛：配置已落盘，下次自然重启即生效，不该让保存动作整体失败
              this.logger.warn(
                `[exec] omo-config 保存后重启失败（配置已落盘）: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
              return 'skipped' as const;
            },
          )
        : 'skipped';
      sendJson(res, 200, {
        written,
        agents: readOmoAgents(this.workDir),
        configPath: resolveOmoConfigPath(this.workDir).relPath,
        configKind: resolveOmoConfigPath(this.workDir).kind,
        enabled: readOmoEnabled(this.workDir),
        bundled: isOmoBundled(),
        restart,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[exec] omo-config 写入失败: ${message} (HTTP 502)`);
      sendJson(res, 502, { error: message });
    }
  }

  /**
   * GET /omo-agent-prompt?name=<agent>——取单个 agent 的系统提示词全文。
   *
   * 为什么单独成端点：全部 agent 的 prompt 合计约 106KB（Sisyphus 单个就 33KB），
   * 塞进 `/omo-config` 会让配置页每次加载都背上 100KB+。故列表只带描述（几百字节），
   * prompt 按需单独拉取（用户点"查看提示词"时才请求）。
   *
   * - 鉴权：X-Worker-Token
   * - name 支持 OmO 配置键（prometheus）或 serve 展示名（"Prometheus - Plan Builder"）
   * - 该 agent 未注册（当前模型下不激活，如 hephaestus）→ 404 + 明确原因
   */
  private async handleOmoAgentPrompt(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: `仅支持 GET，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    const raw = (url.searchParams.get('name') ?? '').trim();
    if (!raw) {
      sendJson(res, 400, { error: '缺少 query 参数 name' });
      return;
    }
    const want = raw.split(' - ')[0].trim().toLowerCase();
    try {
      const list = await this.driver.listAgents(this.workDir);
      const hit = list.find(
        (a) => (a.name.split(' - ')[0] ?? a.name).trim().toLowerCase() === want,
      );
      if (!hit) {
        sendJson(res, 404, {
          error: `agent "${raw}" 当前未注册到 opencode（可能未激活或名称不匹配）`,
        });
        return;
      }
      const prompt = (hit as { prompt?: string }).prompt ?? '';
      sendJson(res, 200, {
        name: hit.name,
        description: hit.description ?? '',
        mode: hit.mode,
        prompt,
        /** prompt 是否为空（opencode 原生 agent 可能无自定义 prompt）。 */
        empty: prompt.length === 0,
      });
      this.logger.info(
        `[exec] omo-agent-prompt -> ${hit.name} (${prompt.length} chars)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[exec] omo-agent-prompt 失败: ${message} (HTTP 502)`);
      sendJson(res, 502, { error: message });
    }
  }

  /**
   * /config/<kind>、/config/restart 与 /config/reload（仅独立模式）：本地配置下推。
   * 注册模式返回 404 + 引导（配置一律经控制面下发，避免双事实源）。
   */
  private async handleConfigRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    kind: string,
  ): Promise<void> {
    if (!this.standalone) {
      sendJson(res, 404, {
        error:
          '本地配置下推仅在独立模式可用（WORKER_STANDALONE=true）；注册模式请经控制面下发',
      });
      return;
    }
    if (kind === 'restart') {
      await this.handleConfigRestart(req, res);
      return;
    }
    if (kind === 'reload') {
      await this.handleConfigReload(req, res);
      return;
    }
    if (!(LOCAL_CONFIG_KINDS as readonly string[]).includes(kind)) {
      sendJson(res, 404, { error: `未知配置类别 /config/${kind}` });
      return;
    }
    await this.handleLocalConfig(req, res, kind as LocalConfigKind);
  }

  private async handleLocalConfig(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    kind: LocalConfigKind,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: `仅支持 POST，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    if (!this.localConfig) {
      sendJson(res, 503, { error: '本地配置下推未启用（需独立模式 + 资源注入器）' });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, this.maxBodyBytes);
    } catch (err) {
      await drainRequest(req);
      sendJson(res, 413, { error: err instanceof Error ? err.message : '请求体过大' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      sendJson(res, 400, { error: '请求体必须是合法 JSON' });
      return;
    }
    try {
      const result = this.localConfig.apply(kind, body);
      sendJson(res, 200, { ...result });
    } catch (err) {
      if (err instanceof LocalConfigError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[exec] /config/${kind} 写入失败: ${message} (HTTP 502)`);
      sendJson(res, 502, { error: message });
    }
  }

  /** POST /config/restart：触发 serve 重启使已下推配置生效（复用 RestartCoordinator）。 */
  private async handleConfigRestart(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: `仅支持 POST，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    await drainRequest(req);
    if (!this.restartServe) {
      sendJson(res, 503, { error: '重启回调未注入，无法重启' });
      return;
    }
    try {
      const restart = await this.restartServe('exec /config/restart（本地配置下推）');
      sendJson(res, 200, { restart });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[exec] /config/restart 失败: ${message} (HTTP 502)`);
      sendJson(res, 502, { error: message });
    }
  }

  /**
   * POST /config/reload：触发 serve **热重载**使已下推配置生效（**不重启 serve 进程**）。
   *
   * 与 `/config/restart` 的分工：配置类变更走本端点（无端口漂移、无会话排空、
   * 无 serve 不可用窗口）；`/config/restart` 保留给真正需要换进程的场景。
   *
   * 响应体 `{ reload: 'reloaded' | 'deferred' | 'failed' | 'unverified' }`：
   * - `deferred` = 有待答复的表单/权限，热重载被跳过（改走文件监听路径）；
   * - `failed` / `unverified` = 热重载没成功（调用方可回退到真重启）。
   */
  private async handleConfigReload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: `仅支持 POST，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    await drainRequest(req);
    if (!this.reloadServe) {
      sendJson(res, 503, { error: '热重载回调未注入，无法热重载' });
      return;
    }
    try {
      const reload = await this.reloadServe('exec /config/reload（本地配置下推）');
      sendJson(res, 200, { reload });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[exec] /config/reload 失败: ${message} (HTTP 502)`);
      sendJson(res, 502, { error: message });
    }
  }

  /** POST /execute：校验 prompt → 202 {accepted:true} → fire-and-forget 驱动 serve。 */
  private async handleExecute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: `仅支持 POST，收到 ${req.method}` });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, this.maxBodyBytes);
    } catch (err) {
      sendJson(res, 413, { error: err instanceof Error ? err.message : '请求体过大' });
      return;
    }
    let payload: ExecuteRequestPayload;
    try {
      payload = JSON.parse(raw || '{}') as ExecuteRequestPayload;
    } catch {
      sendJson(res, 400, { error: '请求体必须是合法 JSON' });
      return;
    }
    if (payload.prompt === undefined || payload.prompt === null) {
      sendJson(res, 400, { error: '缺少必填字段 prompt' });
      return;
    }
    sendJson(res, 202, { accepted: true });
    // 在飞直送分流（in-flight inject）：注入路径完全位于 runExecution 之外——
    // 不做 trackInstanceStart/End 计数、不出 task.completed / AGENT_STATUS /
    // instance 生命周期事件（归属由原在飞执行统一收口，其完成回调在最后一个
    // step-finish 后出终态，server 端一次注销收口）。
    if (payload.inFlight && payload.sessionId) {
      void this.runInFlightPrompt(payload);
      return;
    }
    void this.runExecution(payload);
  }

  /**
   * 在飞注入（轻路径）：把新消息以追加 user prompt 直送正在运行的 opencode 会话。
   * opencode 1.x 运行循环每 step 重读消息库，本 user 消息将于下一 step 边界被消化，
   * 完成事件由原在飞执行统一收口——本路径不复用 runExecution：不建 load 跟踪、
   * 不做 baselineIds 快照、不做 completion 轮询/首字等待、不建 delta tracker
   * （流式输出由原执行的 SSE/poll 覆盖）。parts 组装复用常规路径的
   * prepareAttachmentParts（图片附件照常落盘并入 file part）；sendMessage 仅
   * fire-and-forget，失败仅 logger.warn 不重试、不上送事件、绝不上抛（异步任务无捕获方）。
   */
  private async runInFlightPrompt(payload: ExecuteRequestPayload): Promise<void> {
    const sessionId = payload.sessionId ?? '';
    this.rememberSession(sessionId);
    try {
      const { fileParts, notes } = await this.prepareAttachmentParts(payload);
      const parts: unknown[] = [
        ...normalizeParts(payload.prompt),
        ...fileParts,
        ...(notes.length > 0 ? [{ type: 'text', text: notes.join('\n') }] : []),
      ];
      await this.driver.sendMessage(sessionId, {
        model: payload.model ?? null,
        agent: payload.agent,
        parts,
        directory: payload.directory,
        system: payload.system,
        // T18/D7：在飞注入 = **插队**（steer）——打断当前轮、按新指令重跑。
        // 显式给出，不依赖驱动端的默认投递策略（默认值一变行为就静默漂移）。
        delivery: 'steer',
      });
      this.logger.info(`[exec] 在飞注入 -> ${sessionId} parts=${parts.length}`);
    } catch (err) {
      this.logger.warn(
        `[exec] 在飞注入失败 session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * FR-41：GET /file?path=<绝对路径>——控制面经 WorkerClient 从 worker 工作区拉取文件内容。
   * - 鉴权必做：X-Worker-Token === workerToken（缺失/不匹配/未配置 token → 401），
   *   文件读取比 /execute 更敏感（execute 无鉴权契约保持不变，本端点独立把关）。
   * - 只允许读取文件：stat 非文件（目录）→ 400；超过 10MB → 413；读失败 → 404。
   * - 成功 → 200 原始文件内容（application/octet-stream，二进制安全）。
   */
  private async handleFileFetch(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: `仅支持 GET，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      this.logger.warn(`[exec] file fetch -> 拒绝（X-Worker-Token 无效） (HTTP 401)`);
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    const filePath = url.searchParams.get('path') ?? '';
    if (!filePath.trim()) {
      this.logger.warn(`[exec] file fetch -> 缺少 path 参数 (HTTP 400)`);
      sendJson(res, 400, { error: '缺少必填 query 参数 path' });
      return;
    }
    let stat: { size: number; isFile(): boolean };
    try {
      stat = await fsp.stat(filePath);
    } catch {
      this.logger.warn(`[exec] file fetch -> ${filePath} (HTTP 404)`);
      sendJson(res, 404, { error: `文件不存在: ${filePath}` });
      return;
    }
    if (!stat.isFile()) {
      this.logger.warn(`[exec] file fetch -> ${filePath}（非文件） (HTTP 400)`);
      sendJson(res, 400, { error: `path 不是文件（目录不可读取）: ${filePath}` });
      return;
    }
    if (stat.size > MAX_FILE_FETCH_BYTES) {
      this.logger.warn(`[exec] file fetch -> ${filePath} (HTTP 413)`);
      sendJson(res, 413, { error: `文件超过 ${MAX_FILE_FETCH_BYTES} bytes 上限` });
      return;
    }
    let content: Buffer;
    try {
      content = await fsp.readFile(filePath);
    } catch {
      this.logger.warn(`[exec] file fetch -> ${filePath} (HTTP 404)`);
      sendJson(res, 404, { error: `文件读取失败: ${filePath}` });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(content);
    this.logger.info(`[exec] file fetch -> ${filePath} (HTTP 200)`);
  }

  /**
   * GET /agents?directory=<工作目录>——列出该目录可见的 opencode 原生 agent。
   *
   * 控制面（WorkerClient.listAgents）经本端点拉取，用于 vteam 页面展示与切换。
   * - 鉴权：X-Worker-Token === workerToken（与 GET /file 同规格——未配置 token 一律 401）。
   * - directory 可选；缺省回落 workDir（与执行期 serve cwd 一致，避免列出集合与实际不符）。
   *   实测 serve 按 directory 发现 opencode.json 的 agent 节，per-directory 隔离，
   *   故调用方应传与执行期 prompt_async 相同的 directory。
   * - driver 失败（serve 未就绪/网络错/旧版无该端点）→ 502 {error}，不抛未捕获异常。
   */
  private async handleAgentsList(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: `仅支持 GET，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      this.logger.warn(`[exec] agents list -> 拒绝（X-Worker-Token 无效） (HTTP 401)`);
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    const directory = (url.searchParams.get('directory') ?? '').trim() || this.workDir;
    if (!directory) {
      this.logger.warn('[exec] agents list -> 缺少 directory 且未配置 workDir (HTTP 400)');
      sendJson(res, 400, { error: '缺少 query 参数 directory（且 worker 未配置 workDir 回落）' });
      return;
    }
    try {
      const agents = await this.driver.listAgents(directory);
      sendJson(res, 200, { agents });
      this.logger.info(`[exec] agents list -> ${agents.length} 个 (directory=${directory})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[exec] agents list 失败: ${message} (HTTP 502)`);
      sendJson(res, 502, { error: message });
    }
  }

  /**
   * GET /todos?sessionId=<ses_>&directory=<工作目录>——读取 opencode 会话的 todo 执行步骤。
   *
   * 控制面（WorkerClient.listTodos）经本端点拉取，用于计划 Tab 步骤区展示。
   * - 鉴权：X-Worker-Token === workerToken（与 GET /agents 同规格）。
   * - sessionId 必填（opencode ses_ 会话 id，缺失 → 400）；directory 可选透传 serve。
   * - driver 失败（会话不存在/serve 未就绪/旧版无该端点）→ 502 {error}，不抛未捕获异常。
   * - agent 未用 todo 工具 → 200 {todos: []}（正常情况，非错误）。
   */
  private async handleTodosList(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: `仅支持 GET，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      this.logger.warn(`[exec] todos list -> 拒绝（X-Worker-Token 无效） (HTTP 401)`);
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    const sessionId = (url.searchParams.get('sessionId') ?? '').trim();
    if (!sessionId) {
      this.logger.warn('[exec] todos list -> 缺少 sessionId (HTTP 400)');
      sendJson(res, 400, { error: '缺少必填 query 参数 sessionId' });
      return;
    }
    const directory = (url.searchParams.get('directory') ?? '').trim() || undefined;
    try {
      const todos = await this.driver.listTodos(sessionId, directory);
      sendJson(res, 200, { todos });
      this.logger.info(`[exec] todos list -> ${todos.length} 个 (session=${sessionId})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[exec] todos list 失败: ${message} (HTTP 502)`);
      sendJson(res, 502, { error: message });
    }
  }

  /**
   * GET /plan-files?directory=——列出任务目录 `.opencode/plans/*.md`（正文内联）。
   *
   * 计划 Tab 唯一数据源：vteam 不自维护计划，文件即真相（opencode 原生约定，
   * plan agent 唯一可写目录）。正文一次下发（Modal 免二次请求），单文件超
   * MAX_PLAN_DOC_BYTES 截断 + truncated 标记。
   * - 鉴权：X-Worker-Token（同 /agents 规格）。
   * - directory 缺省回落 workDir；目录不存在 → 200 {files: []}（agent 还没写过是常态）。
   * - 只收小写 .md 普通文件（子目录/隐藏文件/其他扩展名忽略）；读失败单文件跳过不整单失败。
   */
  private async handlePlanFilesList(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: `仅支持 GET，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      this.logger.warn(`[exec] plan-files list -> 拒绝（X-Worker-Token 无效） (HTTP 401)`);
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    const directory = (url.searchParams.get('directory') ?? '').trim() || this.workDir;
    if (!directory) {
      this.logger.warn('[exec] plan-files list -> 缺少 directory 且未配置 workDir (HTTP 400)');
      sendJson(res, 400, { error: '缺少 query 参数 directory（且 worker 未配置 workDir 回落）' });
      return;
    }
    try {
      // 三个候选目录都扫：OmO 把计划写在 .omo/plans/，原生 plan agent 用 .opencode/plans/，
      // OmO 原生规划工作流的草稿落 .omo/drafts/。
      // 同名文件以**先命中的目录**为准（PLAN_DOCS_DIRS 顺序即优先级）。
      const seen = new Set<string>();
      const files: Array<{
        name: string;
        updatedAt: string;
        size: number;
        content: string;
        truncated: boolean;
      }> = [];
      for (const rel of PLAN_DOCS_DIRS) {
        const plansDir = path.join(directory, rel);
        let entries: string[];
        try {
          entries = await fsp.readdir(plansDir);
        } catch {
          // 该目录不存在 = 该位置还没写过计划（常态），继续看下一个
          continue;
        }
        for (const name of entries.sort()) {
          if (!name.endsWith('.md') || name.startsWith('.') || seen.has(name)) {
            continue;
          }
          const full = path.join(plansDir, name);
          try {
            const stat = await fsp.stat(full);
            if (!stat.isFile()) {
              continue;
            }
            const buf = await fsp.readFile(full);
            const truncated = buf.length > MAX_PLAN_DOC_BYTES;
            files.push({
              name,
              updatedAt: stat.mtime.toISOString(),
              size: stat.size,
              content: buf.subarray(0, MAX_PLAN_DOC_BYTES).toString('utf8'),
              truncated,
            });
            seen.add(name);
          } catch {
            // 单文件失败跳过（被删/权限），不整单失败
            continue;
          }
        }
      }
      sendJson(res, 200, { files });
      this.logger.info(
        `[exec] plan-files list -> ${files.length} 个 (directory=${directory}, dirs=${PLAN_DOCS_DIRS.join(',')})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[exec] plan-files list 失败: ${message} (HTTP 502)`);
      sendJson(res, 502, { error: message });
    }
  }

  /**
   * POST /plan-file {directory, name, content}——把计划文件直传进任务目录。
   *
   * Web"上传计划文件"入口的落点：文件进 `<directory>/.omo/plans/`（`PLAN_DOCS_DIR`，
   * 即 agent 实际读写计划的位置）后，agent 侧立即可读，计划 Tab 下轮询出现。
   * vteam 只做文件同步，不解析内容、不改 agent 行为。
   * - 鉴权：X-Worker-Token（写操作，与 /file 同级敏感）。
   * - 路径穿越防线：name 经 basename + PLAN_DOC_NAME_RE 白名单（`a/../b.md` 类全部 400）。
   * - content 必须为字符串且 ≤ MAX_PLAN_UPLOAD_BYTES，否则 400/413；覆盖写允许。
   */
  private async handlePlanFileWrite(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: `仅支持 POST，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      this.logger.warn(`[exec] plan-file write -> 拒绝（X-Worker-Token 无效） (HTTP 401)`);
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, this.maxBodyBytes);
    } catch (err) {
      // 超限：先把手上的请求体读完再回 413。若在 data 事件里立刻 destroy，
      // 客户端还没发完 → 收到 socket hang up 而不是 413（回归：content 超限用例）。
      await drainRequest(req);
      sendJson(res, 413, { error: err instanceof Error ? err.message : '请求体过大' });
      return;
    }
    let body: { directory?: unknown; name?: unknown; content?: unknown };
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      sendJson(res, 400, { error: '请求体必须是合法 JSON' });
      return;
    }
    const directory = (typeof body.directory === 'string' ? body.directory : '').trim() || this.workDir;
    if (!directory) {
      sendJson(res, 400, { error: '缺少 directory（且 worker 未配置 workDir 回落）' });
      return;
    }
    const rawName = (typeof body.name === 'string' ? body.name : '').trim();
    const safeName = path.basename(rawName);
    // basename 会静默把 `../evil.md` 收敛成 `evil.md`——那样"穿越"虽被化解，但调用方
    // 以为写进了上级目录，实际落点不同。这里显式拒绝任何非纯文件名（含路径分隔符/..），
    // 再把白名单正则作为第二道防线（字符集 + .md 后缀）。
    if (rawName !== safeName || rawName === '.' || rawName === '..') {
      this.logger.warn('[exec] plan-file write -> name 含路径分隔符 (HTTP 400)');
      sendJson(res, 400, { error: 'name 非法：必须是纯文件名，不允许路径分隔符或 ..' });
      return;
    }
    if (!PLAN_DOC_NAME_RE.test(safeName)) {
      this.logger.warn('[exec] plan-file write -> 非法文件名 (HTTP 400)');
      sendJson(res, 400, { error: 'name 非法：仅允许字母数字开头、含字母数字/下划线/点/连字符的 .md 文件名' });
      return;
    }
    if (typeof body.content !== 'string') {
      sendJson(res, 400, { error: 'content 必填（字符串）' });
      return;
    }
    if (Buffer.byteLength(body.content, 'utf8') > MAX_PLAN_UPLOAD_BYTES) {
      sendJson(res, 413, { error: `content 超过 ${MAX_PLAN_UPLOAD_BYTES} bytes 上限` });
      return;
    }
    try {
      const plansDir = path.join(directory, PLAN_DOCS_DIR);
      await fsp.mkdir(plansDir, { recursive: true });
      const full = path.join(plansDir, safeName);
      await fsp.writeFile(full, body.content, 'utf8');
      const stat = await fsp.stat(full);
      sendJson(res, 200, { name: safeName, updatedAt: stat.mtime.toISOString() });
      this.logger.info(`[exec] plan-file write -> ${safeName} (directory=${directory})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[exec] plan-file write 失败: ${message} (HTTP 502)`);
      sendJson(res, 502, { error: message });
    }
  }

  /**
   * POST /question-reply：server 下行转发用户对 question/权限确认的回复到 serve。
   * - 鉴权：X-Worker-Token === workerToken（与 GET /file 一致——涉及 serve 会话状态写入，
   *   不能无鉴权放行；未配置 token 一律 401）。
   * - question：{sessionId, requestId, answers} → driver.replyQuestion；answers=null+reject → rejectQuestion
   * - permission：{sessionId, permissionId, response} → driver.replyPermission
   * - 成功后清除去重记录（同一 request 后续若被 serve 重新置 pending 可再次上送）。
   */
  private async handleQuestionReply(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: `仅支持 POST，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      this.logger.warn(`[exec] question-reply -> 拒绝（X-Worker-Token 无效） (HTTP 401)`);
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, this.maxBodyBytes);
    } catch (err) {
      sendJson(res, 413, { error: err instanceof Error ? err.message : '请求体过大' });
      return;
    }
    let payload: QuestionReplyRequestPayload;
    try {
      payload = JSON.parse(raw || '{}') as QuestionReplyRequestPayload;
    } catch {
      sendJson(res, 400, { error: '请求体必须是合法 JSON' });
      return;
    }
    if (typeof payload.sessionId !== 'string' || payload.sessionId === '') {
      sendJson(res, 400, { error: '缺少必填字段 sessionId' });
      return;
    }
    try {
      if (payload.permissionId) {
        const response = payload.response;
        if (response !== 'once' && response !== 'always' && response !== 'reject') {
          sendJson(res, 400, { error: 'permission 回复需 response ∈ once|always|reject' });
          return;
        }
        await this.driver.replyPermission(payload.sessionId, payload.permissionId, response);
        sendJson(res, 200, { ok: true, kind: 'permission' });
        return;
      }
      if (typeof payload.requestId !== 'string' || payload.requestId === '') {
        sendJson(res, 400, { error: '缺少必填字段 requestId 或 permissionId' });
        return;
      }
      if (payload.reject || payload.answers === null) {
        await this.driver.rejectQuestion(payload.sessionId, payload.requestId);
        sendJson(res, 200, { ok: true, kind: 'question', rejected: true });
        return;
      }
      if (!Array.isArray(payload.answers)) {
        sendJson(res, 400, { error: 'question 回复需 answers: string[][] 或 reject: true' });
        return;
      }
      await this.driver.replyQuestion(payload.sessionId, payload.requestId, payload.answers);
      sendJson(res, 200, { ok: true, kind: 'question' });
    } catch (err) {
      // 404 = serve 已无该 requestId/permissionId（僵尸 pending / 会话失效）→ 透传 404 带
      // code=QUESTION_EXPIRED，server 据此终态落库 + 广播收敛（否则 DB 恒 pending → 前端
      // 无限弹窗 + reply 恒 503 死循环，permission-503 根因）。
      if (err instanceof DriverRequestError && err.status === 404) {
        this.logger.warn(
          `[exec] question-reply 转发失败（requestId 已失效）: ${err.message} (HTTP 404)`,
        );
        sendJson(res, 404, {
          error: err.message,
          code: 'QUESTION_EXPIRED',
        });
        return;
      }
      this.logger.warn(
        `[exec] question-reply 转发失败: ${err instanceof Error ? err.message : String(err)} (HTTP 400)`,
      );
      sendJson(res, 400, {
        error: err instanceof Error ? err.message : 'question-reply 转发失败',
      });
    }
  }

  // ---- 会话/模型端点（T10 / 决策 D3：控制面不再直连 opencode）----

  /**
   * POST /sessions——创建被驱动端会话。
   *
   * 控制面此前直连 opencode 的建会话端点（server/src/workers/worker.client.ts），
   * 本端点把它收进 worker：控制面只调 worker，**不再知道 opencode 的会话 wire 形状**。
   * - 鉴权：X-Worker-Token === workerToken（与 /file 同规格；未配置 token 一律 401）。
   * - 请求体：{model?: {providerID, modelID}}（可为空；缺省用被驱动端默认模型）。
   * - 驱动失败按 status 映射（404 → 404 会话失效；其余 → 502），绝不吞成 200。
   */
  private async handleSessionCreate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: `仅支持 POST，收到 ${req.method}` });
      return;
    }
    if (!this.checkWorkerToken(req, res, 'session create')) {
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, this.maxBodyBytes);
    } catch (err) {
      await drainRequest(req);
      sendJson(res, 413, { error: err instanceof Error ? err.message : '请求体过大' });
      return;
    }
    let body: CreateSessionRequestPayload;
    try {
      body = JSON.parse(raw || '{}') as CreateSessionRequestPayload;
    } catch {
      sendJson(res, 400, { error: '请求体必须是合法 JSON' });
      return;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
      return;
    }
    const model = parseModelRef(body.model);
    if (model === 'invalid') {
      sendJson(res, 400, { error: 'model 必须是 {providerID, modelID} 对象' });
      return;
    }
    try {
      const sessionId = await this.driver.createSession(model);
      this.rememberSession(sessionId);
      sendJson(res, 200, { sessionId });
      this.logger.info(`[exec] session create -> ${sessionId}`);
    } catch (err) {
      this.sendDriverError(res, err, 'session create');
    }
  }

  /**
   * POST /sessions/:id/prompt——向会话下发一条提示。
   *
   * ⚠️ **语义**：本端点是「**持久化入队**」，**不是**「同步执行」——响应只表示
   * 「已被收件箱收下」，**不代表 agent 已答复**。终态只能看事件或再读消息端点。
   * - 鉴权：X-Worker-Token（与 /file 同规格）。
   * - `delivery`（steer|queue）**原样透传**给驱动（投递策略是 vteam 侧语义，
   *   被驱动端不支持时由驱动自行忽略）。
   * - 响应回带驱动回执的**收件条目 id**（被驱动端无回执概念时缺席，不编造）。
   */
  private async handleSessionPrompt(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: `仅支持 POST，收到 ${req.method}` });
      return;
    }
    if (!this.checkWorkerToken(req, res, 'session prompt')) {
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, this.maxBodyBytes);
    } catch (err) {
      await drainRequest(req);
      sendJson(res, 413, { error: err instanceof Error ? err.message : '请求体过大' });
      return;
    }
    let payload: SessionPromptRequestPayload;
    try {
      payload = JSON.parse(raw || '{}') as SessionPromptRequestPayload;
    } catch {
      sendJson(res, 400, { error: '请求体必须是合法 JSON' });
      return;
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
      return;
    }
    if (payload.prompt === undefined || payload.prompt === null) {
      sendJson(res, 400, { error: '缺少必填字段 prompt' });
      return;
    }
    if (typeof payload.prompt !== 'string' && !Array.isArray(payload.prompt)) {
      sendJson(res, 400, { error: 'prompt 必须是字符串或内容单元数组' });
      return;
    }
    const delivery = payload.delivery;
    if (delivery !== undefined && delivery !== 'steer' && delivery !== 'queue') {
      sendJson(res, 400, { error: 'delivery 必须是 steer|queue' });
      return;
    }
    const model = parseModelRef(payload.model);
    if (model === 'invalid') {
      sendJson(res, 400, { error: 'model 必须是 {providerID, modelID} 对象' });
      return;
    }
    try {
      const result = await this.driver.sendMessage(sessionId, {
        model: model ?? null,
        agent: payload.agent,
        parts: normalizeParts(payload.prompt),
        directory: payload.directory,
        system: payload.system,
        delivery,
      });
      const body: SessionPromptResponsePayload = { sessionId, admitted: true };
      if (result?.messageId) {
        body.messageId = result.messageId;
      }
      // 投递策略以**驱动回执**为准（被驱动端可能调整过）；驱动不回报时退回请求值。
      const effectiveDelivery = result?.delivery ?? delivery;
      if (effectiveDelivery) {
        body.delivery = effectiveDelivery;
      }
      sendJson(res, 200, body);
      this.logger.info(
        `[exec] session prompt -> 已入队 (session=${sessionId}, delivery=${effectiveDelivery ?? 'default'}, messageId=${body.messageId ?? '-'})`,
      );
    } catch (err) {
      this.sendDriverError(res, err, 'session prompt');
    }
  }

  /**
   * POST /sessions/:id/abort——中断会话当前这一轮。
   *
   * **幂等**：对未知/已结束的会话调用一律**成功**（驱动契约保证 abort 不抛错；
   * 万一驱动回 404 也按「没什么可中断的」收敛为成功），绝不因会话不在而报错。
   * - 鉴权：X-Worker-Token（与 /file 同规格）。
   * - 无请求体。
   */
  private async handleSessionAbort(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: `仅支持 POST，收到 ${req.method}` });
      return;
    }
    if (!this.checkWorkerToken(req, res, 'session abort')) {
      return;
    }
    await drainRequest(req);
    try {
      const result: unknown = await this.driver.abort(sessionId);
      const body: SessionAbortResponsePayload = {
        sessionId,
        interrupted: readInterruptedFlag(result),
      };
      sendJson(res, 200, body);
      this.logger.info(
        `[exec] session abort -> ${body.interrupted ? '已中断在飞轮次' : '无在飞轮次'} (session=${sessionId})`,
      );
    } catch (err) {
      if (err instanceof DriverRequestError && err.status === 404) {
        this.logger.info(
          `[exec] session abort -> 会话不存在/已结束，幂等成功 (session=${sessionId})`,
        );
        sendJson(res, 200, { sessionId, interrupted: false });
        return;
      }
      this.sendDriverError(res, err, 'session abort');
    }
  }

  /**
   * GET /sessions/:id/messages——读会话消息（可分页）。
   *
   * - 鉴权：X-Worker-Token（与 /file 同规格）。
   * - 分页 query：limit / order / cursor，**原样透传**给驱动（被驱动端不支持
   *   分页时由驱动自行忽略）。
   * - 返回 vteam 渲染模型形状的消息数组（不是被驱动端的原始包装）。
   */
  private async handleSessionMessages(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string,
    url: URL,
  ): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: `仅支持 GET，收到 ${req.method}` });
      return;
    }
    if (!this.checkWorkerToken(req, res, 'session messages')) {
      return;
    }
    const query = parseMessagesQuery(url);
    if (query === null) {
      sendJson(res, 400, {
        error: '分页参数非法：limit 必须是正整数，order 必须是 asc|desc',
      });
      return;
    }
    try {
      const messages = await this.fetchSessionMessages(sessionId, query);
      const body: SessionMessagesResponsePayload = { sessionId, messages };
      sendJson(res, 200, body);
      this.logger.info(
        `[exec] session messages -> ${messages.length} 条 (session=${sessionId})`,
      );
    } catch (err) {
      this.sendDriverError(res, err, 'session messages');
    }
  }

  /**
   * GET /models——模型目录（vteam 自有形状）。
   *
   * ⚠️ 刻意**不返回**被驱动端的原始包装（v2 是 `{location, data}`）——那是被驱动端的
   * wire 形状，控制面不该知道它（决策 D3）。这里返回 vteam 自己的模型条目数组。
   * - 鉴权：X-Worker-Token（与 /file 同规格）。
   */
  private async handleModelsList(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: `仅支持 GET，收到 ${req.method}` });
      return;
    }
    if (!this.checkWorkerToken(req, res, 'models list')) {
      return;
    }
    try {
      const models: WorkerModelInfo[] = await this.driver.listModels();
      sendJson(res, 200, { models });
      this.logger.info(`[exec] models list -> ${models.length} 个`);
    } catch (err) {
      this.sendDriverError(res, err, 'models list');
    }
  }

  /** 会话类端点的动作分发（path 段已解析出 id + action）。 */
  private async handleSessionAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: { id: string; action: string },
    url: URL,
  ): Promise<void> {
    if (route.action === 'prompt') {
      await this.handleSessionPrompt(req, res, route.id);
      return;
    }
    if (route.action === 'abort') {
      await this.handleSessionAbort(req, res, route.id);
      return;
    }
    if (route.action === 'messages') {
      await this.handleSessionMessages(req, res, route.id, url);
      return;
    }
    sendJson(res, 404, { error: `未支持的路径: /sessions/:id/${route.action}` });
  }

  /**
   * 拉取会话消息（**可选分页**透传）。
   *
   * 分页是被驱动端 v2 才有的能力（上游消息端点是游标分页），v1 驱动忽略该参数——
   * 故分页入参对驱动是可选的，缺省即「取全部」。
   */
  private async fetchSessionMessages(
    sessionId: string,
    query: SessionMessagesQuery,
  ): Promise<DriverMessage[]> {
    return this.driver.getMessages(sessionId, query);
  }

  /**
   * X-Worker-Token 校验（会话/模型端点共用；与 /file 同规格）。
   *
   * 未配置 workerToken → 一律 401（**fail closed**：宁可拒绝，也不裸奔）。
   */
  private checkWorkerToken(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    label: string,
  ): boolean {
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      this.logger.warn(`[exec] ${label} -> 拒绝（X-Worker-Token 无效） (HTTP 401)`);
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return false;
    }
    return true;
  }

  /**
   * 驱动失败 → HTTP 响应（会话/模型端点共用）。
   *
   * | 驱动 status | HTTP | body |
   * |---|---|---|
   * | 404 | 404 | {error, code:'SESSION_NOT_FOUND'} |
   * | 429 | 429 | {error, code:'RATE_LIMITED'} |
   * | 401 / 403 | 502 | {error, code:'UPSTREAM_UNAUTHORIZED'} |
   * | 其它 / 无 | 502 | {error} |
   *
   * 为什么 404 原样透传：控制面据此判定「会话已失效」并走重建路径（与 exec-server
   * 内部的 isSessionNotFound 同口径）。为什么 401 不透传成 401：那是**被驱动端**拒了
   * worker 的凭据（worker↔被驱动端的配置问题），透传成 401 会让控制面误判成
   * 「自己的 worker token 不对」。
   */
  private sendDriverError(
    res: http.ServerResponse,
    err: unknown,
    label: string,
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof DriverRequestError && err.status === 404) {
      this.logger.warn(`[exec] ${label} 失败（会话失效）: ${message} (HTTP 404)`);
      sendJson(res, 404, { error: message, code: 'SESSION_NOT_FOUND' });
      return;
    }
    if (err instanceof DriverRequestError && err.status === 429) {
      this.logger.warn(`[exec] ${label} 失败（上游限流）: ${message} (HTTP 429)`);
      sendJson(res, 429, { error: message, code: 'RATE_LIMITED' });
      return;
    }
    if (
      err instanceof DriverRequestError &&
      (err.status === 401 || err.status === 403)
    ) {
      this.logger.warn(`[exec] ${label} 失败（被驱动端鉴权失败）: ${message} (HTTP 502)`);
      sendJson(res, 502, { error: message, code: 'UPSTREAM_UNAUTHORIZED' });
      return;
    }
    this.logger.warn(`[exec] ${label} 失败: ${message} (HTTP 502)`);
    sendJson(res, 502, { error: message });
  }

  // ---- 执行链路 ----

  /**
   * POST /secret-command：token 保护的敏感命令同步执行端点（sensitive-command-tool todo 4）。
   *
   * - 鉴权/方法/体积分支：非 POST 405；缺/错 X-Worker-Token 或未配置 token 401；
   *   超 maxBodyBytes 413（先排空再回包）；坏 JSON 400。
   * - 执行：同步 `runSensitiveCommand({workDir, signal})`；`SensitiveCommandError`
   *   按 code 映射固定 400 文案（不透传 err.message）。命令自身成功/失败/超时以
   *   200 结构化结果表达。响应只含 SensitiveCommandOutput 派生字段 + requestId，
   *   不含渲染命令/argv/cwd/secrets；访问日志只记状态与 code，不记请求体。
   * - 幂等：条目在任何 await 之前登记 → 重复/并发提交共用同一 promise，绝不二次执行；
   *   同 requestId 同归属回放既有结果，不同归属 409。
   */
  private async handleSecretCommand(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: `仅支持 POST，收到 ${req.method}` });
      return;
    }
    const token = req.headers['x-worker-token'];
    if (!this.workerToken || typeof token !== 'string' || token !== this.workerToken) {
      this.logger.warn('[exec] secret-command -> 拒绝（X-Worker-Token 无效） (HTTP 401)');
      sendJson(res, 401, { error: 'X-Worker-Token 无效' });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, this.maxBodyBytes);
    } catch (err) {
      await drainRequest(req);
      this.logger.warn('[exec] secret-command -> 请求体超限 (HTTP 413)');
      sendJson(res, 413, { error: err instanceof Error ? err.message : '请求体过大' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw || '{}');
    } catch {
      this.logger.warn('[exec] secret-command -> 请求体非法 JSON (HTTP 400)');
      sendJson(res, 400, { error: '请求体必须是合法 JSON' });
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.logger.warn('[exec] secret-command -> 请求体非对象 (HTTP 400)');
      sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
      return;
    }
    const payload = parsed as SecretCommandRequestPayload;
    if (typeof payload.requestId !== 'string' || payload.requestId === '') {
      this.logger.warn('[exec] secret-command -> 缺少 requestId (HTTP 400)');
      sendJson(res, 400, { error: '缺少必填字段 requestId' });
      return;
    }
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : '';
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const existing = this.secretCommands.get(payload.requestId);
    if (existing !== undefined) {
      if (existing.taskId !== taskId || existing.sessionId !== sessionId) {
        this.logger.warn('[exec] secret-command -> requestId 归属冲突 (HTTP 409)');
        sendJson(res, 409, { error: 'requestId 已被其他归属使用' });
        return;
      }
      const replay = await existing.result;
      sendJson(res, replay.status, replay.body);
      return;
    }

    const controller = new AbortController();
    // 客户端提前断开 → 中止执行（模块对进程组 SIGKILL），不留孤儿长命令。
    const onClientGone = (): void => {
      if (!res.writableEnded) {
        controller.abort();
      }
    };
    res.on('close', onClientGone);
    try {
      const record: SecretCommandRecord = {
        taskId,
        sessionId,
        settled: false,
        result: this.executeSecretCommand(payload, controller.signal),
      };
      this.secretCommands.set(payload.requestId, record);
      this.evictSecretCommandCache();
      void record.result.then(
        () => {
          record.settled = true;
        },
        () => {
          record.settled = true;
        },
      );
      const outcome = await record.result;
      this.logger.info(`[exec] secret-command -> 完成 (HTTP ${outcome.status})`);
      sendJson(res, outcome.status, outcome.body);
    } finally {
      res.removeListener('close', onClientGone);
    }
  }

  /** 淘汰最旧的已落定幂等记录，把表长限制在 SECRET_COMMAND_CACHE_MAX（在途记录不淘汰）。 */
  private evictSecretCommandCache(): void {
    while (this.secretCommands.size > SECRET_COMMAND_CACHE_MAX) {
      let evicted = false;
      for (const [key, record] of this.secretCommands) {
        if (record.settled) {
          this.secretCommands.delete(key);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        return;
      }
    }
  }

  /** 执行单次敏感命令并归一为 HTTP 结果；永不 reject（意外错误也走固定文案 500）。 */
  private async executeSecretCommand(
    payload: SecretCommandRequestPayload,
    signal: AbortSignal,
  ): Promise<SecretCommandResult> {
    try {
      const output = await runSensitiveCommand(
        {
          commandTemplate: payload.commandTemplate,
          secrets: payload.secrets,
          cwd: payload.cwd,
          timeoutMs: payload.timeoutMs,
        },
        { workDir: this.workDir, signal },
      );
      return { status: 200, body: toSecretCommandResponse(payload.requestId, output) };
    } catch (err) {
      if (err instanceof SensitiveCommandError) {
        this.logger.warn(`[exec] secret-command -> 拒绝（${err.code}） (HTTP 400)`);
        return {
          status: 400,
          body: {
            error: SECRET_COMMAND_REJECTIONS[err.code] ?? SECRET_COMMAND_REJECTIONS.invalid_input,
            code: err.code,
          },
        };
      }
      // 意外错误的 message 可能携带动态片段：响应与日志都只用固定文案。
      this.logger.warn('[exec] secret-command 执行异常 (HTTP 500)');
      return { status: 500, body: { error: 'internal error' } };
    }
  }

  /**
   * fire-and-forget 执行：驱动 serve + 事件按序上送 + trackInstance 计数。
   * 所有错误路径（createSession/sendMessage 失败、awaitCompletion 首字超时/异常）统一
   * 收敛为 error 事件 + session.updated(failed)；绝不向上抛（异步任务无捕获方）。
   */
  private async runExecution(payload: ExecuteRequestPayload): Promise<void> {
    // metric：load.instances = 去重活跃会话数，必须有稳定的会话键。执行开始时优先用
    // 请求 sessionId；无请求会话（新建）用临时 anon 键先入账，createSession 成功后再
    // 重键到真实 opencode 会话 id（见下方 trackInstanceRekey），finally 用最终键 end。
    let sessionKey =
      payload.sessionId || `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    trackInstanceStart(sessionKey);
    let opencodeSessionId = payload.sessionId ?? '';
    // 终态闸门：事件路（durable 的 session.execution.*）与轮询路（消息终态）**共用**
    // 这一个判定出口——两条路都到得了时，只允许发一次终态事件。声明在 try 之外，
    // 失败分支（catch）也要读它。
    let gate = new RunTerminalGate();
    // 终态是否已开始上送（成功路径发出 session.updated(idle) 之前置位）：失败兜底
    // 「补发 task.completed」只在**终态还没发过**时允许——否则一轮会出现两条 idle。
    let terminalEmitted = false;
    try {
      // is_0000000010：worker 侧兜底创建目录（server 与 worker 可能不共享文件系统，
      // server 侧 mkdir 无效——目录由 worker 执行端点确保存在，持久卷挂载 /data/vteam-worker）。
      if (payload.directory) {
        await fsp.mkdir(payload.directory, { recursive: true });
      }
      if (payload.executionConfig) {
        this.logger.info(
          `[exec] executionConfig received permissions=${Object.keys(payload.executionConfig.permissions).length} writePaths=${payload.executionConfig.writePaths.length}`,
        );
        if (payload.directory) {
          try {
            const cfg = JSON.stringify({ executionConfig: payload.executionConfig }, null, 2);
            await fsp.writeFile(`${payload.directory}/.execution-config.json`, cfg, 'utf8');
          } catch {}
        }
      }
      if (!opencodeSessionId) {
        opencodeSessionId = await this.driver.createSession(payload.model);
        // metric：临时 anon 键迁移到真实 opencode 会话 id，保证 finally 能用同一键 end。
        trackInstanceRekey(sessionKey, opencodeSessionId);
        sessionKey = opencodeSessionId;
      }
      // Per-agent browser isolation (option A)：按 opencode 会话预建 profile
      // 落点 browser-profiles/<scope>/（scope 派生规则见 browser-tools.ts
      // resolveBrowserScopeId；shim 运行时以 ToolContext.sessionID 取同一 scope，
      // 此处预建只为早失败可观测——best-effort，失败不阻断执行）。
      if (this.browserProfileRoot) {
        ensureBrowserProfileDir(
          this.browserProfileRoot,
          resolveBrowserScopeId({
            sessionId: opencodeSessionId,
            directory: payload.directory,
            agent: payload.agent,
          }),
        );
      }
      const ctx: Record<string, string | undefined> = {
        taskId: payload.taskId,
        agentId: payload.agentId,
        channelId: payload.channelId,
        sessionId: opencodeSessionId,
        // 用量口径模型标识：随 ctx 扩散进事件体（server usage 落库按 task.completed 的
        // model 归集）。此处只是**完成前**能知道的显式配置口径（流式事件用），必填 string；
        // task.completed 会用 resolveUsageModelKey 覆盖为零配置环境的 serve 实际模型。
        model: usageModelKey(payload.model),
      };
      await this.sender.send(WORKER_EVENT_TYPES.SESSION_UPDATED, {
        ...ctx,
        status: 'running',
      });
      // 成功路径主动上报 loading（对齐失败路径 agent.status 形状）——模型长思考/长工具调用
      // 时 60s 内可能无 delta（首字未产出），server 端 dispatch 后若无任何事件回流会误判
      // 「agent 无响应」。本事件经 ingress handleAgentStatus → sessionActivityCallbacks →
      // dispatcher handleSessionActivity → clearPendingWatchdogBySession：立即清除首字
      // watchdog + 刷新空闲计时，防止首字延迟造成的误报。phase=thinking 对齐前端 loading
      // 展示（dispatch 侧 loading 两阶段：thinking→operating）。
      await this.sender.send(WORKER_EVENT_TYPES.AGENT_STATUS, {
        taskId: payload.taskId,
        agentId: payload.agentId,
        sessionId: opencodeSessionId,
        channelId: payload.channelId,
        status: 'loading',
        phase: 'thinking',
      });

      // 终态闸门：事件路（durable 的 session.execution.*）与轮询路（消息终态）**共用**
      // 这一个判定出口——两条路都到得了时，只允许发一次终态事件。
      let result: CompletionResult;
      try {
        result = await this.runSendAndAwait(payload, opencodeSessionId, ctx, gate);
      } catch (err) {
        if (payload.sessionId && this.isSessionNotFound(err)) {
          // 复用会话失效（serve 重启/容器重建后旧会话 404）→ 自动 createSession 新建
          // 会话并重试一次；新建也失败 → 外层 error 收敛。
          this.logger.warn(`[exec] 复用会话 ${opencodeSessionId} 会话不存在（HTTP 404），新建会话重试一次`);
          opencodeSessionId = await this.driver.createSession(payload.model);
          // metric：旧键迁移到新建的真实 opencode 会话 id（仍保持 1 个去重活跃会话）。
          trackInstanceRekey(sessionKey, opencodeSessionId);
          sessionKey = opencodeSessionId;
          ctx.sessionId = opencodeSessionId;
          // 新会话 = 新的一轮：终态闸门重置（旧会话的事件证据不带过来）
          gate = new RunTerminalGate();
          result = await this.runSendAndAwait(payload, opencodeSessionId, ctx, gate);
        } else {
          throw err;
        }
      }

      // 终态判定（唯一出口）：事件证据优先于轮询证据。
      const verdict = gate.settle() ?? { verdict: 'succeeded' as const };
      if (verdict.verdict !== 'succeeded') {
        // durable 事件判定本轮失败/中断 → 不发 task.completed，改发错误状态
        this.logger.warn(
          `[exec] 事件路判定本轮${verdict.verdict === 'interrupted' ? '被中断' : '失败'}（session=${opencodeSessionId}）：${verdict.error ?? '-'}`,
        );
        await this.sender.send(WORKER_EVENT_TYPES.AGENT_STATUS, {
          ...ctx,
          status: 'error',
          error: verdict.error ?? '执行失败',
        });
        await this.sender.send(WORKER_EVENT_TYPES.SESSION_UPDATED, {
          ...ctx,
          status: 'failed',
        });
        return;
      }

      terminalEmitted = true;
      await this.sender.send(WORKER_EVENT_TYPES.SESSION_UPDATED, {
        ...ctx,
        status: 'idle',
      });
      // P2/P3：doc/file 产出物文件内容上送（server 端落盘 uploads 生成可访问 URL）
      const artifacts = await collectFileArtifacts(result.text, payload.directory);
      // 用量口径模型：覆盖 ctx.model（仅显式配置口径）——零配置环境改用 serve 回报的
      // 实际模型（取值链见 resolveUsageModelKey）。放在 ...ctx 之后，避免被 ctx 覆盖。
      const modelKey = resolveUsageModelKey(payload.model, result.model);
      await this.sender.send(WORKER_EVENT_TYPES.TASK_COMPLETED, {
        ...ctx,
        model: modelKey,
        text: result.text,
        // part id 与事件路/轮询路统一（server 侧按 id 合并）
        parts: normalizeV2ContentIdList(result.parts ?? []),
        ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      });
      this.logger.info(
        `[exec] 执行完成 session=${opencodeSessionId} taskId=${payload.taskId ?? '-'} model=${modelKey} (config=${describeModel(payload.model)} serve=${describeModel(result.model)}) text=${result.text.length} chars`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[exec] 执行失败 session=${opencodeSessionId}: ${message}`);
      // 终态判定（唯一出口）：**先问后记**——闸门的 peek() 返回「事件证据 ?? 轮询证据」，
      // 先把自己的失败证据记进去，闸门就再也分不出「事件路还没说话」与「事件路说了成功」
      // （宽限期内迟到的失败会被吞掉：失败被当成成功）。故：先读判定，再记自己的证据。
      // 读到的判定若说成功（事件证据说本轮成功、轮询路超时/失败），以终态证据为准 →
      // 补发 task.completed（正文取一次消息快照）。
      const gateVerdict = gate.peek();
      gate.notePolling({ verdict: 'failed', error: message });
      if (gateVerdict?.verdict === 'succeeded' && !terminalEmitted) {
        this.logger.warn(
          `[exec] 执行失败但终态证据判定成功，按终态证据补发 task.completed（session=${opencodeSessionId}）: ${message}`,
        );
        const messages = await this.safeGetMessages(opencodeSessionId);
        await this.sender.send(WORKER_EVENT_TYPES.TASK_COMPLETED, {
          taskId: payload.taskId,
          agentId: payload.agentId,
          sessionId: opencodeSessionId,
          channelId: payload.channelId,
          model: resolveUsageModelKey(payload.model, undefined),
          text: assembleAssistantText(messages),
          parts: normalizeV2ContentIdList(
            messages
              .filter((m) => m.info?.role === 'assistant')
              .flatMap((m) => m.parts ?? []),
          ),
        });
        await this.sender.send(WORKER_EVENT_TYPES.SESSION_UPDATED, {
          taskId: payload.taskId,
          agentId: payload.agentId,
          sessionId: opencodeSessionId,
          channelId: payload.channelId,
          status: 'idle',
        });
        return;
      }
      await this.sender.send(WORKER_EVENT_TYPES.AGENT_STATUS, {
        taskId: payload.taskId,
        agentId: payload.agentId,
        sessionId: opencodeSessionId,
        channelId: payload.channelId,
        status: 'error',
        // 失败文案：终态证据里带上游错误详情就用它（事件证据更全：带 HTTP 码/响应体），
        // 没有才用异常文案（超时等本地判定）。
        error:
          (gateVerdict?.verdict === 'failed' ? gateVerdict.error : undefined) ??
          (err instanceof CompletionTimeoutError ? `执行失败：${message}` : message),
      });
      await this.sender.send(WORKER_EVENT_TYPES.SESSION_UPDATED, {
        taskId: payload.taskId,
        agentId: payload.agentId,
        sessionId: opencodeSessionId,
        channelId: payload.channelId,
        status: 'failed',
      });
    } finally {
      trackInstanceEnd(sessionKey);
    }
  }

  /** 读会话消息快照（失败不抛：返回空列表）——终态兜底补发正文时用。 */
  private async safeGetMessages(sessionID: string): Promise<DriverMessage[]> {
    try {
      return await this.driver.getMessages(sessionID);
    } catch (err) {
      this.logger.warn(
        `[exec] 读取会话消息快照失败（session=${sessionID}）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /** 会话失效判定：DriverRequestError 且 HTTP 404（serve 重启后旧 ses_ 会话不存在）。 */
  private isSessionNotFound(err: unknown): boolean {
    return err instanceof DriverRequestError && err.status === 404;
  }

  /**
   * 附件图片落盘 + file parts 组装（问题二：用户发的图进执行上下文）。
   * 成功 → serve 可读的本地 file part（实测 file:// URL 形状）；失败/超限/非法
   * → notes 文本（并入 prompt 尾部，模型如实告知用户，不静默谎称看见）。
   * 安全：只接受 /uploads/ 相对路径（按 serverBaseUrl 拼接）或与 serverBaseUrl
   * 同源的 http(s) URL；file:// 等本地路径、异源 URL 一律拒绝并记 warn。
   */
  private async prepareAttachmentParts(
    payload: ExecuteRequestPayload,
  ): Promise<{ fileParts: unknown[]; notes: string[] }> {
    const fileParts: unknown[] = [];
    const notes: string[] = [];
    const list = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (list.length === 0) return { fileParts, notes };
    const directory = payload.directory?.trim();
    if (!directory) {
      notes.push('（附件图片未能送达：缺少执行目录，请如实告知用户重新发送）');
      return { fileParts, notes };
    }
    const baseOrigin = this.serverBaseUrl ? this.originOf(this.serverBaseUrl) : null;
    let index = 0;
    for (const att of list) {
      index += 1;
      const label = att?.filename?.trim() || `图片${index}`;
      const target = this.resolveAttachmentUrl(att?.url);
      if (!target) {
        this.logger.warn(`[exec] 附件跳过（非法引用）: ${att?.url ?? '-'}`);
        notes.push(`（附件图片 ${label} 未能送达：引用非法，请如实告知用户重新发送）`);
        continue;
      }
      if (baseOrigin && this.originOf(target) !== baseOrigin) {
        this.logger.warn(`[exec] 附件跳过（异源 URL）: ${target}`);
        notes.push(`（附件图片 ${label} 未能送达：来源不可信，请如实告知用户重新发送）`);
        continue;
      }
      const mime = this.inferImageMime(att?.mime, target);
      if (!mime) {
        this.logger.warn(`[exec] 附件跳过（非图片类型）: ${target}`);
        continue;
      }
      try {
        const buf = await this.downloadAttachment(target);
        if (buf === null) {
          notes.push(`（附件图片 ${label} 未能送达：超过 ${MAX_IMAGE_ATTACHMENT_BYTES} bytes 上限，请如实告知用户压缩后重发）`);
          continue;
        }
        const safeName = this.sanitizeAttachmentName(att?.filename, mime, index);
        const destDir = path.join(directory, 'attachments');
        await fsp.mkdir(destDir, { recursive: true });
        const dest = path.join(destDir, safeName);
        await fsp.writeFile(dest, buf);
        fileParts.push({ type: 'file', mime, filename: safeName, url: `file://${dest}` });
        this.logger.info(`[exec] 附件落盘 ${dest} (${buf.length} bytes)`);
      } catch (err) {
        this.logger.warn(
          `[exec] 附件下载失败 ${target}: ${err instanceof Error ? err.message : String(err)}`,
        );
        notes.push(`（附件图片 ${label} 未能送达：下载失败，请如实告知用户重新发送）`);
      }
    }
    return { fileParts, notes };
  }

  /** 附件引用归一为可下载的 http(s) URL；非法（file:// 等/异形）返回 null。 */
  private resolveAttachmentUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const ref = raw.trim();
    if (!ref || ref.startsWith('file:') || ref.startsWith('data:')) return null;
    if (ref.startsWith('/uploads/')) {
      if (!this.serverBaseUrl) return null;
      return `${this.serverBaseUrl}${ref}`;
    }
    if (/^https?:\/\//i.test(ref)) return ref;
    return null;
  }

  private originOf(url: string): string | null {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  private inferImageMime(mime: unknown, url: string): string | null {
    if (typeof mime === 'string' && mime.toLowerCase().startsWith('image/')) {
      return mime.toLowerCase();
    }
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    return null;
  }

  private sanitizeAttachmentName(name: unknown, mime: string, index: number): string {
    const fallbackExt = mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : 'jpg';
    const raw = typeof name === 'string' && name.trim() ? path.basename(name.trim()) : `image-${index}.${fallbackExt}`;
    const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || `image-${index}.${fallbackExt}`;
    return safe.includes('.') ? safe : `${safe}.${fallbackExt}`;
  }

  /** 下载附件（上限 MAX_IMAGE_ATTACHMENT_BYTES，超限返回 null；60s 超时抛错）。 */
  private async downloadAttachment(url: string): Promise<Buffer | null> {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_ATTACHMENT_BYTES) return null;
    return buf;
  }

  /** sendAndAwait 封装：sendMessage → awaitCompletion（onPoll 增量上送 delta + pending 检测）。 */
  private async runSendAndAwait(
    payload: ExecuteRequestPayload,
    sessionID: string,
    ctx: Record<string, string | undefined>,
    gate: RunTerminalGate,
  ): Promise<CompletionResult> {
    const tracker = new MessageDeltaTracker();
    this.rememberSession(sessionID);
    // 每次任务独立 pending 检测器（去重集 + 防重入按任务隔离，任务结束即释放——
    // 实例级标志会跨任务残留 true，导致后续任务检测全部跳过）。
    const detector = new PendingQuestionDetector(this.driver, this.sender, this.logger);
    // 问题二：附件图片先落盘再以 file part 并入（失败注记同样进 prompt，模型如实告知）。
    const { fileParts, notes } = await this.prepareAttachmentParts(payload);
    const parts: unknown[] = [
      ...normalizeParts(payload.prompt),
      ...fileParts,
      ...(notes.length > 0 ? [{ type: 'text', text: notes.join('\n') }] : []),
    ];
    // delta 上送串行链（按任务隔离）：onPoll 每 pollMs 触发一次，sendDelta 含网络投递，
    // 直接并发 fire 会让同一任务的快照乱序/并发抵达 server（eventId seq 也随之乱序）。
    // 提取增量（extractNewParts）仍在 onPoll 内**同步**完成，保证去重时序与现状一致；
    // 只有「上送」排进串行链。发送失败仅记日志，不阻断链与主流程。
    let deltaChain: Promise<void> = Promise.resolve();
    const enqueueDelta = (messages: DriverMessage[]): number => {
      const fresh = tracker.extractNewParts(messages);
      if (fresh.length === 0) {
        return 0;
      }
      deltaChain = deltaChain
        .then(() => this.sendDelta(ctx, fresh))
        .catch((err: unknown) => {
          this.logger.warn(`message.part.delta 上送失败（不影响主流程）: ${String(err)}`);
        });
      return fresh.length;
    };
    // SSE 实时路（serve GET /api/event 订阅）：part 事件零阈值、零轮询延迟直接上送，
    // 并经 tracker.admitSsePart 单调准入（推进才发、更新共享基准）——轮询快照对同一
    // part 的比较以该基准为底线，旧/更短快照被压制，双路不会互相回覆盖。全局总线
    // 事件按 sessionID 过滤后才入链（其它会话的事件直接丢弃）。
    const enqueueParts = (freshParts: DriverContent[], upstream?: UpstreamEventIdentity): void => {
      // 单调准入：SSE 重连/晚于轮询建立时，增量合成的 part 文本可能**短于**轮询路
      // 已上送的全文——admitSsePart 对同 part.id 拒绝回退快照且不降低基准（见 tracker）。
      const admitted = freshParts.filter((p) => tracker.admitSsePart(p, 'delta'));
      if (admitted.length === 0) {
        return;
      }
      deltaChain = deltaChain
        .then(() => this.sendDelta(ctx, admitted, upstream))
        .catch((err: unknown) => {
          this.logger.warn(`message.part.delta（SSE）上送失败（不影响主流程）: ${String(err)}`);
        });
    };
    // SSE 路开关：默认开（VTEAM_SSE_FORWARD=0/false 关，退回纯轮询兜底路）。
    const sseEnabled = !/^(0|false|no)$/i.test(process.env.VTEAM_SSE_FORWARD ?? '');
    // 事件路可用性（T14 终态协调）：驱动有 baseUrl ⇒ 走 v2 事件总线（`/api/event`）。
    // T18：v1 驱动已删除 ⇒ 不再有「没有事件总线」的驱动实现；判据只剩「驱动是否已注入
    // baseUrl」（未注入 = serve 尚未就绪或注入的是无事件路的自定义实现）。
    const eventPathAvailable = sseEnabled && Boolean(this.driver.baseUrl);
    // 流式内容累积器（把 v2 的增量事件累积成「当前全文」part）：断线重连时**必须清空**
    // ——v2 /api/event 是 volatile 实时总线（不重放历史帧），续用旧缓冲会拼出一段
    // 从未存在过的正文。
    const accumulator = new V2StreamAccumulator();
    let sseStream: ServeEventStream | null = null;
    if (sseEnabled && this.driver.baseUrl) {
      sseStream = new ServeEventStream({
        baseUrl: this.driver.baseUrl,
        serverPassword: this.driver.authPassword,
        logger: this.logger,
        onEvent: (frame) => {
          this.handleV2Event(frame, sessionID, ctx, accumulator, gate, enqueueParts, detector);
        },
        onMalformed: (info) => {
          this.logger.warn(
            `[sse-forward] 事件帧解析失败（累计 ${info.count} 次，该帧丢弃、不中断流）: ${info.reason}`,
          );
        },
        onOpen: () => {
          // 连接成活（首帧 server.connected 或心跳）。**刻意不 reset 去重基准**：
          // /api/event 不重放历史帧，若清空基准，重连后的首个增量（仅含连接后的片段）
          // 会被当成新快照上送并覆盖轮询已发全文 → 渲染回退。保留基准后，
          // admitSsePart 的单调准入会丢弃这些更短/非推进的片段；轮询路持续以全量
          // 快照兜底，不丢内容。
          this.logger.info(`[sse-forward] serve /api/event 已订阅（session=${sessionID}）`);
        },
        onClose: (reason, info) => {
          // v2 /api/event 是 **volatile 契约**：慢消费者会 overflow 断流、断线期间的事件
          // 会丢。⇒ 与「serve 进程退出」是**两类不同的故障**，日志必须能分辨：
          // - 一帧都没收到就断 = serve 不可达（进程退出/重启）；
          // - 收到过帧再断 = 事件流中断（慢消费者 overflow 或对端断开）。
          const kind =
            info.frames === 0
              ? 'serve 不可达（进程退出/重启）'
              : '事件流中断（volatile 契约：慢消费者 overflow / 对端断开）';
          this.logger.warn(
            `[sse-forward] serve /api/event 断开（${reason}，本连接收到 ${info.frames} 帧）：${kind}；` +
              '将退避重连，重连后从驱动轮询重同步状态',
          );
        },
        onReconnect: async (info) => {
          // ① 清空增量缓冲：/api/event 不重放历史帧，跨连接续用旧缓冲会拼出从未存在过的正文
          accumulator.clear();
          this.logger.warn(
            `[sse-forward] 事件流重连（第 ${info.attempt} 次）：已清空增量缓冲，开始状态重同步`,
          );
          // ② 状态重同步：断线期间的事件已丢（volatile 契约）→ 从驱动拉权威快照重建。
          //    权威状态只能靠轮询恢复（消息快照），不信任流。
          try {
            const messages = normalizeV2ContentIds(await this.driver.getMessages(sessionID));
            const resent = enqueueDelta(messages);
            this.logger.info(
              `[sse-forward] 重连后状态重同步完成（session=${sessionID}，补发 ${resent} 个 part）`,
            );
          } catch (err) {
            this.logger.warn(
              `[sse-forward] 重连后状态重同步失败（轮询兜底路继续跑）: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      });
      sseStream.start();
    }
    try {
      const result = await sendAndAwait(
        this.driver,
        sessionID,
        {
          model: payload.model ?? null,
          agent: payload.agent,
          parts,
          directory: payload.directory,
          system: payload.system,
          // T18/D7：常规下发的投递策略**显式**取 steer（v2 的默认投递策略本就是 steer，
          // 但不依赖默认——默认值一变，行为就静默漂移）。
          delivery: 'steer',
        },
        {
          firstTokenTimeoutMs: this.firstTokenTimeoutMs,
          totalTimeoutMs: this.totalTimeoutMs,
          pollMs: this.pollMs,
          serveErrorReader: this.serveErrorReader,
          serveLogReader: this.serveLogReader,
          // T17：serve 日志模型错误检测——匹配模型 API 错误关键词 + 结构化错误门（Rate limit/
          // Free usage 等不透传 message.info.error）；true=提前失败（abort + 抛错，
          // 错误文本经 CompletionTimeoutError 透传 agent.status error 事件）。结构化门
          // （level=ERROR / error.* 字段）杜绝正常 INFO 行误触发提前 abort。
          // T17-subagent：share subscriber 行是子 agent 域失败（主循环存活可自恢复），
          // 永不触发 abort——只认顶层致命（prompt_async failed / process error /
          // 本会话 stream error）。线上实测 08:18：一行子域 Model-not-found 秒杀
          // PM+architect 两个健康主 agent（step=6，group_post 在途）。
          // 含模型下架（ProviderModelNotFoundError / Model not found）：顶层命中即快速失败
          // （重试同一模型必然继续失败，空等首字超时无意义）；子域形态由 isServeFatalLine 排除。
          onServeError: (text) => isServeFatalLine(text),
          onPoll: (messages: DriverMessage[], _elapsedMs: number) => {
            // 内容 id 归一：让**轮询路**与**事件路**产出同一个 part id（否则 server 侧按
            // id 合并时同一段正文会存成两个 part）。
            enqueueDelta(normalizeV2ContentIds(messages));
            // question/权限确认旁路检测：serve 侧 pending 时上送事件（不 abort，等用户）
            void detector.detect(ctx, sessionID);
          },
          // T14：把**本轮的终态闸门**交给语义层当事件信号——轮询路与事件路从此合流到
          // 同一个判定出口：① 轮询路判定前先问闸门（事件证据优先：事件路已判失败/中断时，
          // 轮询路不得宣告成功）；② 轮询路判定完成后把自己的证据记进闸门（一次性收口
          // settle() 仍由本层做，语义层不消耗它）。
          // ⚠️ 顺序不可颠倒：闸门的 peek() 返回「事件证据 ?? 轮询证据」，**先问后记**才能
          // 分清「事件路还没说话」与「事件路说了成功」——反了会把宽限期内迟到的失败吞掉
          // （失败被当成成功）。语义层内部已按「先问后记」实现（见 prompt-await）。
          // v1 回退路径（无事件路）⇒ 整块不传：轮询路不等待宽限期，行为零变化。
          ...(eventPathAvailable
            ? {
                eventSignal: gate,
                eventGraceMs: EVENT_GRACE_MS,
                logger: this.logger,
              }
            : {}),
        },
      );
      // 终态事件（session.updated idle / task.completed）由调用方在 runSendAndAwait 返回后
      // 上送——先排空 delta 链，保证所有流式快照严格早于终态事件抵达 server。
      await deltaChain;
      return result;
    } finally {
      // **失败路径也必须关流**：否则 SSE 客户端会对着已死/已弃用的 serve 无限退避重连
      // （挂住定时器 = 挂住进程）。
      sseStream?.close();
      accumulator.clear();
    }
  }

  /**
   * v2 事件 → vteam 事件的桥接（映射表见 `v2-event-map.ts`）。
   *
   * 三步：① 按会话过滤（/api/event 是全局总线）→ ② 查映射表 → ③ 上送（附上游身份）。
   *
   * 终态事件（`session.execution.*`）**不在这里发送**——交给 `RunTerminalGate` 统一
   * 收口，否则事件路与消息轮询路会各发一次完成事件。
   */
  private handleV2Event(
    frame: V2EventFrame,
    sessionID: string,
    ctx: Record<string, string | undefined>,
    accumulator: V2StreamAccumulator,
    gate: RunTerminalGate,
    enqueueParts: (parts: DriverContent[], upstream?: UpstreamEventIdentity) => void,
    detector: PendingQuestionDetector,
  ): void {
    // ① 全局总线过滤：只处理本任务会话的事件（无会话 id 的帧无法归属 → 丢弃）
    const frameSession = resolveV2SessionId(frame);
    if (frameSession === '' || frameSession !== sessionID) {
      return;
    }
    // ② 映射（表驱动；未映射的事件 = 「已知未支持」清单里的条目，丢弃即可）
    const outcomes = mapV2Event(frame, { sessionId: sessionID, accumulator });
    if (outcomes.length === 0) {
      return;
    }
    const identity = deriveUpstreamIdentity(frame);
    for (const outcome of outcomes) {
      if (outcome.kind === 'trigger') {
        // ephemeral 触发器：只触发一次拉取（拉到的请求由 detector 上送，带自己的上游身份）
        void detector.detect(ctx, sessionID);
        continue;
      }
      if (outcome.terminal !== undefined) {
        // 终态：交终态闸门（不直接发送）
        gate.noteEvent(
          {
            verdict: outcome.terminal,
            ...(typeof outcome.payload.error === 'string' ? { error: outcome.payload.error } : {}),
          },
          identity,
        );
        continue;
      }
      // ③ 上送（附上游身份 → server 可跨 worker 重启去重）
      if (outcome.type === WORKER_EVENT_TYPES.MESSAGE_PART_DELTA) {
        // 流式增量走串行链（与轮询路同一条链，保证顺序）
        const parts = outcome.payload.parts;
        enqueueParts(
          Array.isArray(parts) ? (parts as DriverContent[]) : [],
          identity,
        );
        continue;
      }
      void this.sender.send(outcome.type, {
        ...ctx,
        ...outcome.payload,
        upstream: identity,
      });
    }
  }

  /** onPoll 钩子的上送段：把已提取的增量 parts 作为 message.part.delta 事件发出
   *  （payload 形状不变：{ ...ctx, parts, status:'streaming' }）。
   *
   *  `upstream` 只在**事件路**有值（v2 事件的上游身份 → server 可跨 worker 重启去重）；
   *  轮询路的消息快照不是上游事件 → 不带身份。 */
  private async sendDelta(
    ctx: Record<string, string | undefined>,
    parts: DriverContent[],
    upstream?: UpstreamEventIdentity,
  ): Promise<void> {
    await this.sender.send(WORKER_EVENT_TYPES.MESSAGE_PART_DELTA, {
      ...ctx,
      parts,
      status: 'streaming',
      ...(upstream !== undefined ? { upstream } : {}),
    });
  }
}

/**
 * PendingQuestionDetector：单任务实例的 question/权限 pending 轮询检测器。
 *
 * 挂载在 awaitCompletion 的 onPoll（每 pollMs 一次）上作为旁路：serve 侧出现 pending
 * question/权限请求时上送 SESSION_QUESTION/SESSION_PERMISSION 事件（不 abort，serve 继续
 * 等用户回复）。设计要点：
 * - **按任务隔离**：runSendAndAwait 每次新建实例——去重集与防重入标志随任务生命周期，
 *   任务结束即释放。曾用 ExecServer 实例级标志，detect 中途任务结束会残留 true，
 *   导致后续任务检测全部跳过（E2E 实测根因）。
 * - 去重：同一 requestId/permissionId 只上送一次（每轮 poll 都调用，避免重复上报）。
 * - 检测失败吞错记日志（旁路不阻断 step-finish 主流程）。
 */
class PendingQuestionDetector {
  /** 已上送去重集：`q:${requestId}` 或 `p:${permissionId}`。 */
  private readonly reported = new Set<string>();
  /** 检测中标志：防同任务内并发 poll 重叠检测（listQuestions/listPermissions 均为网络请求）。 */
  private detecting = false;

  constructor(
    private readonly driver: OpenCodeDriver,
    private readonly sender: EventSender,
    private readonly logger: Logger,
  ) {}

  async detect(ctx: Record<string, string | undefined>, sessionID: string): Promise<void> {
    if (this.detecting) {
      return;
    }
    this.detecting = true;
    try {
      const questions = await fetchPendingForms(this.driver, sessionID);
      for (const q of questions) {
        const key = `q:${q.id}`;
        if (this.reported.has(key)) {
          continue;
        }
        this.reported.add(key);
        await this.sender.send(WORKER_EVENT_TYPES.SESSION_QUESTION, {
          ...ctx,
          sessionId: sessionID,
          requestId: q.id,
          questions: q.questions,
          // 上游身份：拉取派生的事件没有自己的事件帧 → 用**上游对象 id**
          // （表单 id）作去重标识（一次触发可能拉出多个表单，用触发事件 id 会折叠成一条）
          upstream: { eventId: q.id },
        });
      }
      const permissions = await fetchPendingPermissions(this.driver, sessionID);
      for (const p of permissions) {
        const key = `p:${p.id}`;
        if (this.reported.has(key)) {
          continue;
        }
        this.reported.add(key);
        const resources = p.resources ?? [];
        await this.sender.send(WORKER_EVENT_TYPES.SESSION_PERMISSION, {
          ...ctx,
          sessionId: sessionID,
          permissionId: p.id,
          type: p.action,
          pattern: resources.length === 1 ? resources[0] : resources,
          title: p.action,
          upstream: { eventId: p.id },
        });
      }
    } catch (err) {
      this.logger.warn(
        `[exec] question/permission 检测失败（旁路跳过）: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.detecting = false;
    }
  }
}
