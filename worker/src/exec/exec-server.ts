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
import {
  DriverModelRef,
  DriverRequestError,
  Logger,
  ServeMessage,
  V1Driver,
} from '../driver/v1-driver';
import {
  ensureBrowserProfileDir,
  resolveBrowserScopeId,
} from '../browser/browser-tools';
import { trackInstanceEnd, trackInstanceStart } from '../instance-tracker';
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
import { WORKER_EVENT_TYPES } from '../protocol/worker-protocol';
import { collectFileArtifacts } from './artifact-extract';

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
 * ⚠️ 两个位置都要看，原因与 OmO 配置文件同理（见 resources/omo-config.ts）：
 * OmO 把工作区元数据统一收进 `.omo/`，**当前版本实际把 agent 产出的计划写在
 * `.omo/plans/`**；而 `.opencode/plans/` 是 opencode 原生 plan agent 的约定位置
 * （也是 vteam 早期版本约定的位置）。
 *
 * 实测：装了 OmO 后，主 Agent 在计划模式下产出的文件落在 `<taskDir>/.omo/plans/plan.md`，
 * 只读 `.opencode/plans/` 会得到空列表——计划明明写出来了，页面却显示"暂无计划"。
 *
 * 读取时**两个目录都扫**（合并结果，按文件名去重），因此不论 agent 用哪个位置都能展示；
 * 写入（用户上传）统一落 `PLAN_DOCS_DIR`（首个位置）。
 */
export const PLAN_DOCS_DIRS = ['.omo/plans', '.opencode/plans'] as const;
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

export interface ExecServerOptions {
  /** 监听端口（WORKER_EXEC_PORT）。 */
  port: number;
  /** 驱动 serve 的 V1Driver。 */
  driver: V1Driver;
  /** 事件上送通道（进程内 EventSender 单例）。 */
  sender: EventSender;
  /**
   * FR-41：文件端点鉴权 token（X-Worker-Token === workerToken 才允许 GET /file）。
   * 空 = 拒绝所有文件请求（文件读取更敏感，无 token 配置时宁可不暴露，绝不无鉴权放行）。
   */
  workerToken?: string;
  /**
   * 首字超时 ms（awaitCompletion 首字超时：时限内模型无输出 → abort + 上送 error）；
   * 默认 120000（env WORKER_FIRST_TOKEN_TIMEOUT_MS 可配）。首字出现后无完成超时。
   */
  firstTokenTimeoutMs?: number;
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

/** 将字符串 prompt 归一为 parts 数组（对象数组直接透传）。 */
export function normalizeParts(prompt: string | unknown[]): unknown[] {
  if (typeof prompt === 'string') {
    return [{ type: 'text', text: prompt }];
  }
  return prompt;
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
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export class ExecServer {
  private readonly port: number;
  private readonly driver: V1Driver;
  private readonly sender: EventSender;
  private readonly workerToken: string;
  private readonly firstTokenTimeoutMs: number;
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
  private readonly logger: Logger;
  private server: http.Server | null = null;

  constructor(options: ExecServerOptions) {
    this.port = options.port;
    this.driver = options.driver;
    this.sender = options.sender;
    this.workerToken = options.workerToken ?? '';
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 120_000;
    this.pollMs = options.pollMs ?? 500;
    this.serveErrorReader = options.serveErrorReader;
    this.serveLogReader = options.serveLogReader;
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this.serverBaseUrl = (options.serverBaseUrl ?? '').replace(/\/+$/, '');
    this.browserProfileRoot = options.browserProfileRoot ?? '';
    this.workDir = options.workDir ?? '';
    this.restartServe = options.restartServe;
    this.logger = options.logger ?? console;
  }

  /** 实际监听端口（start 成功后；未启动为 null）。 */
  get boundPort(): number | null {
    return this.server?.address() && typeof this.server.address() === 'object'
      ? (this.server.address() as { port: number }).port
      : null;
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
    void this.runExecution(payload);
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
      // 两个候选目录都扫：OmO 把计划写在 .omo/plans/，原生 plan agent 用 .opencode/plans/。
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

  // ---- 执行链路 ----

  /**
   * fire-and-forget 执行：驱动 serve + 事件按序上送 + trackInstance 计数。
   * 所有错误路径（createSession/sendMessage 失败、awaitCompletion 首字超时/异常）统一
   * 收敛为 error 事件 + session.updated(failed)；绝不向上抛（异步任务无捕获方）。
   */
  private async runExecution(payload: ExecuteRequestPayload): Promise<void> {
    trackInstanceStart();
    let opencodeSessionId = payload.sessionId ?? '';
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

      let result: CompletionResult;
      try {
        result = await this.runSendAndAwait(payload, opencodeSessionId, ctx);
      } catch (err) {
        if (payload.sessionId && this.isSessionNotFound(err)) {
          // 复用会话失效（serve 重启/容器重建后旧会话 404）→ 自动 createSession 新建
          // 会话并重试一次；新建也失败 → 外层 error 收敛。
          this.logger.warn(`[exec] 复用会话 ${opencodeSessionId} 会话不存在（HTTP 404），新建会话重试一次`);
          opencodeSessionId = await this.driver.createSession(payload.model);
          ctx.sessionId = opencodeSessionId;
          result = await this.runSendAndAwait(payload, opencodeSessionId, ctx);
        } else {
          throw err;
        }
      }

      await this.sender.send(WORKER_EVENT_TYPES.SESSION_UPDATED, {
        ...ctx,
        status: 'idle',
      });
      // P2/P3：doc/file 产出物文件内容上送（server 端落盘 uploads 生成可访问 URL）
      const artifacts = await collectFileArtifacts(result.text, payload.directory);
      await this.sender.send(WORKER_EVENT_TYPES.TASK_COMPLETED, {
        ...ctx,
        text: result.text,
        parts: result.parts,
        ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      });
      this.logger.info(
        `[exec] 执行完成 session=${opencodeSessionId} taskId=${payload.taskId ?? '-'} model=${describeModel(payload.model)} text=${result.text.length} chars`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[exec] 执行失败 session=${opencodeSessionId}: ${message}`);
      await this.sender.send(WORKER_EVENT_TYPES.AGENT_STATUS, {
        taskId: payload.taskId,
        agentId: payload.agentId,
        sessionId: opencodeSessionId,
        channelId: payload.channelId,
        status: 'error',
        error: err instanceof CompletionTimeoutError ? `执行失败：${message}` : message,
      });
      await this.sender.send(WORKER_EVENT_TYPES.SESSION_UPDATED, {
        taskId: payload.taskId,
        agentId: payload.agentId,
        sessionId: opencodeSessionId,
        channelId: payload.channelId,
        status: 'failed',
      });
    } finally {
      trackInstanceEnd();
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
  ): Promise<CompletionResult> {
    const tracker = new MessageDeltaTracker();
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
    return sendAndAwait(
      this.driver,
      sessionID,
      {
        model: payload.model ?? null,
        agent: payload.agent,
        parts,
        directory: payload.directory,
        system: payload.system,
      },
      {
        firstTokenTimeoutMs: this.firstTokenTimeoutMs,
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
        onServeError: (text) => !/share subscriber/i.test(text) &&
          (/level=ERROR\b|error\.(error|name|message|code)=/.test(text) &&
          /stream error|AI_APICallError|Rate limit|Free usage|quota|Invalid API key|Unauthorized|429|subscribe/i.test(
            text,
          )),
        onPoll: (messages: ServeMessage[], _elapsedMs: number) => {
          void this.sendDelta(ctx, tracker, messages);
          // question/权限确认旁路检测：serve 侧 pending 时上送事件（不 abort，等用户）
          void detector.detect(ctx, sessionID);
        },
      },
    );
  }

  /** onPoll 钩子：增量上送 message.part.delta（按消息 id 去重，只送新增 parts）。 */
  private async sendDelta(
    ctx: Record<string, string | undefined>,
    tracker: MessageDeltaTracker,
    messages: ServeMessage[],
  ): Promise<void> {
    const fresh = tracker.extractNewParts(messages);
    if (fresh.length === 0) {
      return;
    }
    await this.sender.send(WORKER_EVENT_TYPES.MESSAGE_PART_DELTA, {
      ...ctx,
      parts: fresh,
      status: 'streaming',
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
    private readonly driver: V1Driver,
    private readonly sender: EventSender,
    private readonly logger: Logger,
  ) {}

  async detect(ctx: Record<string, string | undefined>, sessionID: string): Promise<void> {
    if (this.detecting) {
      return;
    }
    this.detecting = true;
    try {
      const questions = await this.driver.listQuestions(sessionID);
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
        });
      }
      const permissions = await this.driver.listPermissions(sessionID);
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
