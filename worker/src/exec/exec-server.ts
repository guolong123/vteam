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
import { trackInstanceEnd, trackInstanceStart } from '../instance-tracker';
import { WORKER_EVENT_TYPES } from '../protocol/worker-protocol';
import { collectFileArtifacts } from './artifact-extract';

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
  /** P7：顶层 system 提示（产出物协议/@机制等，serve 拼入 LLM system message，不进会话记录）。 */
  system?: string;
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

/** FR-41：GET /file 单文件大小上限（10MB，超限 413，对齐 server FILE_SIZE_LIMIT）。 */
export const MAX_FILE_FETCH_BYTES = 10 * 1024 * 1024;

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
   * 接线注入）。awaitCompletion 每轮轮询调用，serve 对 Rate limit/Free usage 等 APIError
   * 只写 stderr（`message="stream error" ... error.error="AI_APICallError: ..."`）不透传
   * message.info.error——匹配关键词时提前 abort + 抛错（错误文本透传前端），不再空等首字超时。
   * 缺省 = 不检测 serve 日志（保持原行为）。
   */
  serveErrorReader?: () => string[];
  /** 请求体大小上限 bytes；默认 1MB。 */
  maxBodyBytes?: number;
  /** 日志输出；默认 console。 */
  logger?: Logger;
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

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new ExecuteRequestError(`请求体超过 ${maxBytes} bytes 上限`));
        req.destroy();
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
  private readonly serveErrorReader: (() => string[]) | undefined;
  private readonly maxBodyBytes: number;
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
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
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
    sendJson(res, 404, { error: `未支持的路径: ${url.pathname}` });
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
      // server 侧 mkdir 无效——目录由 worker 执行端点确保存在，持久卷挂载 /data/worker）。
      if (payload.directory) {
        await fsp.mkdir(payload.directory, { recursive: true });
      }
      if (!opencodeSessionId) {
        opencodeSessionId = await this.driver.createSession(payload.model);
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
    return sendAndAwait(
      this.driver,
      sessionID,
      {
        model: payload.model ?? null,
        agent: payload.agent,
        parts: normalizeParts(payload.prompt),
        directory: payload.directory,
        system: payload.system,
      },
      {
        firstTokenTimeoutMs: this.firstTokenTimeoutMs,
        pollMs: this.pollMs,
        serveErrorReader: this.serveErrorReader,
        // T17：serve 日志模型错误检测——匹配模型 API 错误关键词（Rate limit/Free usage 等
        // 只写 serve stderr 不透传 message.info.error）；true=提前失败（abort + 抛错，
        // 错误文本经 CompletionTimeoutError 透传 agent.status error 事件）
        onServeError: (text) =>
          /stream error|AI_APICallError|Rate limit|Free usage|quota|Invalid API key|Unauthorized|429|subscribe/i.test(
            text,
          ),
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
