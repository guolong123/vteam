/**
 * T10 执行端点（方案 A：worker 主动推）。
 *
 * 独立 HTTP server（node:http 内置，不引依赖），固定端口 WORKER_EXEC_PORT（默认 4198），
 * 仅监听 `POST /execute`。收到执行请求 → 立即 202 {accepted:true}（fire-and-forget）→
 * 异步驱动 serve（createSession → sendMessage → awaitCompletion）→ 事件经 EventSender
 * 按序上送（session.updated running → message.part.delta 流式 → task.completed/idle
 * 或 agent.status error/failed）。trackInstanceStart/End 驱动心跳 load 计数。
 *
 * 并发安全：同一 worker 多任务（多 session）并行执行；每个 /execute 独立驱动，按
 * opencode 会话 id（请求 sessionId 或新建）区分，serve 单实例多会话。
 *
 * 事件 payload 对齐 server 契约（worker-event.ingress.ts TaskCompletedPayload/
 * AgentStatusPayload）：sessionId 语义为 opencode 会话 id（ses_ 前缀），server 侧
 * 经 Session.instanceRef 反查映射平台 Session 主键（F2 MINOR 防御）。
 */

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
}

export interface ExecServerOptions {
  /** 监听端口（WORKER_EXEC_PORT）。 */
  port: number;
  /** 驱动 serve 的 V1Driver。 */
  driver: V1Driver;
  /** 事件上送通道（进程内 EventSender 单例）。 */
  sender: EventSender;
  /**
   * 首字超时 ms（awaitCompletion 首字超时：时限内模型无输出 → abort + 上送 error）；
   * 默认 120000（env WORKER_FIRST_TOKEN_TIMEOUT_MS 可配）。首字出现后无完成超时。
   */
  firstTokenTimeoutMs?: number;
  /** 完成判定轮询间隔 ms（透传 awaitCompletion；缺省其默认 500）。 */
  pollMs?: number;
  /** 请求体大小上限 bytes；默认 1MB。 */
  maxBodyBytes?: number;
  /** 日志输出；默认 console。 */
  logger?: Logger;
}

/** 请求体解析失败（非 JSON / 缺字段）。 */
export class ExecuteRequestError extends Error {}

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
  private readonly firstTokenTimeoutMs: number;
  private readonly pollMs: number;
  private readonly maxBodyBytes: number;
  private readonly logger: Logger;
  private server: http.Server | null = null;

  constructor(options: ExecServerOptions) {
    this.port = options.port;
    this.driver = options.driver;
    this.sender = options.sender;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 120_000;
    this.pollMs = options.pollMs ?? 500;
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
    if (url.pathname !== '/execute') {
      sendJson(res, 404, { error: `未支持的路径: ${url.pathname}` });
      return;
    }
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

      let result: CompletionResult;
      try {
        result = await this.runSendAndAwait(payload, opencodeSessionId, ctx);
      } catch (err) {
        if (this.isSessionNotFound(err) && payload.sessionId) {
          // 复用会话失效（serve 重启/容器重建后旧 ses_ 会话丢失，prompt_async 404）：
          // 自动 createSession 新建会话并重试一次；新建也失败 → 外层 error 收敛。
          this.logger.warn(
            `[exec] 复用会话 ${opencodeSessionId} 不存在（HTTP 404），新建会话重试一次`,
          );
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
      await this.sender.send(WORKER_EVENT_TYPES.TASK_COMPLETED, {
        ...ctx,
        text: result.text,
        parts: result.parts,
        ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
      });
      this.logger.info(
        `[exec] 执行完成 session=${opencodeSessionId} taskId=${payload.taskId ?? '-'} text=${result.text.length} chars`,
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

  /** sendAndAwait 封装：sendMessage → awaitCompletion（onPoll 增量上送 delta）。 */
  private async runSendAndAwait(
    payload: ExecuteRequestPayload,
    sessionID: string,
    ctx: Record<string, string | undefined>,
  ): Promise<CompletionResult> {
    const tracker = new MessageDeltaTracker();
    return sendAndAwait(
      this.driver,
      sessionID,
      {
        model: payload.model ?? null,
        agent: payload.agent,
        parts: normalizeParts(payload.prompt),
        directory: payload.directory,
      },
      {
        firstTokenTimeoutMs: this.firstTokenTimeoutMs,
        pollMs: this.pollMs,
        onPoll: (messages: ServeMessage[], _elapsedMs: number) => {
          void this.sendDelta(ctx, tracker, messages);
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
