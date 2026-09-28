import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '../auth/decorators/public.decorator';
import { WorkerTokenGuard } from '../workers/worker-token.guard';
import {
  PLATFORM_MCP_SERVER_NAME,
  PLATFORM_MCP_SERVER_VERSION,
} from './platform-mcp.constants';
import { PlatformMcpService } from './platform-mcp.service';
import { PlatformToolPermissionService } from './platform-tool-permission.service';
import {
  buildPlatformMcpTools,
  zodObjectToJsonSchema,
  type PlatformMcpTool,
} from './platform-mcp.tools';

/**
 * x-worker-id header：worker 注入的会话归属标识。MCP 调用本身不携带「当前任务」，
 * server 无法从 opencode 会话感知归属，故由 controller 读取该 header 并透传给
 * 每个工具 handler，service.assertWorkerTask 内做 worker↔task Session 归属校验。
 */
const WORKER_ID_HEADER = 'x-worker-id';

/** MCP 协议版本（2025-03-26：tools.listChanged/call 由协议级处理，本 server 实现 v1）。 */
const MCP_PROTOCOL_VERSION = '2025-03-26';

/**
 * 阻塞 tools/call 心跳间隔（≤60s）。opencode 1.18.32 对零字节挂起的
 * tools/call 在约 240s（60s 扫描相位）客户端 abort；30s 间隔保证任意扫描
 * 窗口内都有字节到达，重置其空闲判定。
 */
const MCP_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * 仅对声明接受 text/event-stream 的客户端发心跳。opencode MCP 客户端
 * `Accept: application/json, text/event-stream` 走 SSE 帧；curl 的默认
 * 通配 Accept 不含 event-stream，永不接管响应，最终正文保持纯 JSON。
 */
function acceptsEventStream(req: Request): boolean {
  return String(req.headers.accept ?? '')
    .split(',')
    .some((part) => part.split(';')[0].trim() === 'text/event-stream');
}

/** JSON-RPC 通知无 id：心跳接管后的错误帧仍需回填请求 id。 */
function messageId(body: unknown): unknown {
  const msg = body as { id?: unknown } | null | undefined;
  return msg && typeof msg === 'object' ? msg.id : undefined;
}

/** JSON-RPC 错误码（JSON-RPC 2.0 规范）。 */
const ERROR_METHOD_NOT_FOUND = -32601;
const ERROR_INVALID_PARAMS = -32602;
const ERROR_INTERNAL_ERROR = -32603;

/**
 * 平台 MCP Streamable HTTP 端点（阶段 1）。
 *
 * - `POST /api/v1/platform-mcp`：`@Public()` 跳过全局 JwtAuthGuard（APP_GUARD），
 *   `@UseGuards(WorkerTokenGuard)` 校验 `X-Worker-Token`（与用户 JWT 隔离，D1）。
 * - 手写 JSON-RPC 四方法分发（计划 9 回退：SDK `StreamableHTTPServerTransport`
 *   Hono getRequestListener 与 NestJS 集成实测 400）——不经 SDK transport，
 *   仅用 zod schema 校验 + PlatformMcpService 方法：initialize / tools/list /
 *   tools/call / 未知 method。带 id 请求 → 200 + result/error；通知（无 id，
 *   如 notifications/initialized）→ 响应体 `{accepted:true}`（202 Accepted 语义）。
 * - 工具定义见 platform-mcp.tools.ts：inputSchema 为 zod schema（tools/list
 *   派生成 JSON Schema，tools/call 用 safeParse 校验），handler 透传 workerId。
 */
@ApiTags('platform-mcp')
@Controller('platform-mcp')
export class PlatformMcpController {
  private readonly tools: readonly PlatformMcpTool[];

  constructor(
    private readonly service: PlatformMcpService,
    private readonly toolPermission: PlatformToolPermissionService,
  ) {
    this.tools = buildPlatformMcpTools(service);
  }

  @Public()
  @UseGuards(WorkerTokenGuard)
  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      '平台 MCP Streamable HTTP 端点（X-Worker-Token 鉴权，initialize/tools/list/call）',
  })
  async handle(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    const workerId = String(req.headers[WORKER_ID_HEADER] ?? '');
    // MCP 客户端断开探测：响应未写完就关闭（客户端超时/断连）→ abort 工具 handler
    // 的 ctx.signal。阻塞式工具（secret_command）凭此在执行前取消 pending 问题，
    // 防止「客户端已放弃等待、命令仍被执行」的幽灵执行。
    const disconnect = new AbortController();
    const onDisconnect = (): void => {
      if (!res.writableEnded) {
        disconnect.abort();
      }
    };
    res.on('close', onDisconnect);
    req.on('aborted', onDisconnect);
    // MCP 通知契约：无 id 请求 → 202 Accepted（正文仍由本方法写出）
    const message = body as { id?: unknown } | null | undefined;
    const isNotification =
      !!message && typeof message === 'object' && message.id === undefined;
    if (isNotification) {
      res.status(202);
    }

    let out: unknown;
    let heartbeated = false;
    try {
      out = this.dispatch(body, workerId, disconnect.signal);
      if (out instanceof Promise) {
        // 只有阻塞式 tools/call 会走到这里：handler 挂起期间按 ≤60s 在响应上写
        // SSE 注释心跳，避免 opencode 客户端把零字节长连接当作空闲超时 abort。
        const held = await this.awaitWithHeartbeat(
          out,
          res,
          acceptsEventStream(req),
        );
        out = held.body;
        heartbeated = held.heartbeated;
      }
    } catch (err) {
      if (res.headersSent) {
        // 心跳已接管响应：错误必须以 JSON-RPC SSE 帧收尾，客户端仍可解析。
        this.endWithJsonRpcFrame(
          res,
          this.error(
            messageId(body),
            ERROR_INTERNAL_ERROR,
            this.toErrorMessage(err),
          ),
        );
        return;
      }
      throw err;
    }

    if (heartbeated) {
      this.endWithJsonRpcFrame(res, out);
      return;
    }
    // 未触发心跳的请求保持原语义：整体 JSON-RPC 正文（curl / Accept:* 客户端可直接 JSON.parse）
    res.json(out);
  }

  /**
   * 阻塞 tools/call 等待器：handler pending 期间，若客户端声明接受
   * text/event-stream（opencode MCP 客户端为 `application/json, text/event-stream`，
   * curl 默认通配 Accept 不含该类型），每 ≤ MCP_HEARTBEAT_INTERVAL_MS 在响应上
   * 写一条 SSE 注释帧。首次心跳才切换响应头，因此快速返回的请求（含非阻塞
   * 流量）完全不受影响；未声明 event-stream 的客户端永不写心跳，正文仍是纯 JSON。
   */
  private async awaitWithHeartbeat(
    pending: Promise<unknown>,
    res: Response,
    enabled: boolean,
  ): Promise<{ body: unknown; heartbeated: boolean }> {
    if (!enabled) {
      return { body: await pending, heartbeated: false };
    }
    let heartbeated = false;
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      if (!heartbeated) {
        heartbeated = true;
        res.status(200);
        res.setHeader('content-type', 'text/event-stream; charset=utf-8');
        res.setHeader('cache-control', 'no-cache, no-transform');
        res.setHeader('connection', 'keep-alive');
        res.setHeader('x-accel-buffering', 'no');
      }
      res.write(`: vteam-mcp-heartbeat ${Date.now()}\n\n`);
    }, MCP_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    const stop = (): void => clearInterval(timer);
    res.on('close', stop);
    try {
      return { body: await pending, heartbeated };
    } finally {
      stop();
      res.off('close', stop);
    }
  }

  /** 心跳接管后的收尾：JSON-RPC 结果以单条 SSE data 帧写出并结束流。 */
  private endWithJsonRpcFrame(res: Response, payload: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.end();
    } catch {
      // 客户端已断开：忽略（断开语义由 AbortSignal 路径处理）
    }
  }

  /**
   * MCP Streamable HTTP 仅实现 POST 请求-响应模式：GET（opencode 等客户端的
   * SSE 流探测，accept: text/event-stream）不支持，返回 405 Method Not Allowed。
   * 客户端收到 405 后自动回退 POST JSON-RPC 模式（与先前 404 的回退行为一致，
   * 但语义正确，避免 404 探测噪音）。
   */
  @Public()
  @UseGuards(WorkerTokenGuard)
  @Get()
  @HttpCode(405)
  @ApiOperation({
    summary:
      '平台 MCP 端点仅支持 POST（JSON-RPC over HTTP），GET（SSE 流）返回 405',
  })
  methodNotAllowed(): { code: string; message: string } {
    return {
      code: 'METHOD_NOT_ALLOWED',
      message: '仅支持 POST（JSON-RPC over HTTP）',
    };
  }

  /**
   * JSON-RPC 分发入口（幂等、纯函数式，无副作用）。
   * - 缺 id → notification → 202 Accepted 语义（响应体 {accepted:true}）
   * - 其余按 method 走 initialize / tools/list / tools/call / 未知 method
   */
  private dispatch(
    body: unknown,
    workerId: string,
    signal: AbortSignal,
  ): unknown {
    const message = body as
      | { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown }
      | null
      | undefined;

    if (!message || typeof message !== 'object') {
      return this.error(undefined, -32600, 'Invalid Request');
    }
    if (message.id === undefined) {
      return { accepted: true };
    }

    switch (message.method) {
      case 'initialize':
        return this.initialize(message.id);
      case 'tools/list':
        return this.toolsList(message.id);
      case 'tools/call':
        return this.toolsCall(message.id, message.params, workerId, signal);
      default:
        return this.error(
          message.id,
          ERROR_METHOD_NOT_FOUND,
          `Method not found: ${String(message.method)}`,
        );
    }
  }

  /** initialize：返回协议版本 + 能力声明 + server 标识（对齐 SDK 默认 capabilities）。 */
  private initialize(id: unknown): unknown {
    return this.result(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: PLATFORM_MCP_SERVER_NAME,
        version: PLATFORM_MCP_SERVER_VERSION,
      },
    });
  }

  /** tools/list：返回工具清单（inputSchema 由 zod shape 派生为 JSON Schema）。 */
  private toolsList(id: unknown): unknown {
    return this.result(id, {
      tools: this.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodObjectToJsonSchema(tool.inputSchema),
      })),
    });
  }

  /**
   * tools/call：校验工具名（未知 → -32602）→ zod.safeParse(arguments)（失败 →
   * -32602 含 zod message）→ 双空上下文回填（task-11：taskId/teamId 双空时按
   * worker 最近会话合并 ids，权限门与 handler 均见回填后参数）→ 权限门
   * （-32003）→ handler 调用。handler 结果经 JSON.stringify 包成 text 内容
   * （与 SDK 工具调用结果契约一致）。
   */
  private async toolsCall(
    id: unknown,
    params: unknown,
    workerId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const name =
      params && typeof params === 'object'
        ? (params as { name?: unknown }).name
        : undefined;
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      return this.error(
        id,
        ERROR_INVALID_PARAMS,
        `Unknown tool: ${String(name)}`,
      );
    }

    const argumentsValue =
      params && typeof params === 'object'
        ? (params as { arguments?: unknown }).arguments
        : undefined;
    const parsed = tool.inputSchema.safeParse(argumentsValue);
    if (!parsed.success) {
      return this.error(
        id,
        ERROR_INVALID_PARAMS,
        z.prettifyError(parsed.error),
      );
    }

    try {
      const input = parsed.data as {
        taskId?: string;
        teamId?: string;
        selfInstanceId?: string;
      };
      const resolved = await this.service.resolveToolCallerWithContext(
        { workerId },
        input,
      );
      if (!input.taskId && resolved.taskId) input.taskId = resolved.taskId;
      if (!input.teamId && resolved.teamId) input.teamId = resolved.teamId;
      await this.toolPermission.assertToolAllowed(resolved.callerId, tool.name);
      const result = await tool.handler({ workerId }, input, signal);
      return this.result(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      });
    } catch (err) {
      const code = this.toErrorCode(err);
      return this.error(id, code, this.toErrorMessage(err));
    }
  }

  /** JSON-RPC 成功响应。 */
  private result(id: unknown, result: unknown): unknown {
    return { jsonrpc: '2.0', id, result };
  }

  /** JSON-RPC 错误响应（统一 {jsonrpc, id, error:{code, message}}）。 */
  private error(id: unknown, code: number, message: string): unknown {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  private toErrorCode(err: unknown): number {
    if (err instanceof HttpException) {
      const status = err.getStatus();
      if (status === 400) return ERROR_INVALID_PARAMS;
      if (status === 403) return -32003;
      if (status === 404) return -32004;
      if (status === 409) return -32009;
    }
    return ERROR_INTERNAL_ERROR;
  }

  private toErrorMessage(err: unknown): string {
    if (err instanceof HttpException) {
      const response = err.getResponse();
      const status = err.getStatus();
      const prefix =
        status === 403
          ? '[403]'
          : status === 409
            ? '[409]'
            : status === 400
              ? '[400]'
              : '';
      let msg: string;
      if (
        response &&
        typeof response === 'object' &&
        'message' in response &&
        typeof (response as { message?: unknown }).message === 'string'
      ) {
        msg = (response as { message: string }).message;
      } else {
        msg = err.message;
      }
      const code =
        response && typeof response === 'object' && 'code' in response
          ? ` ${(response as { code?: string }).code}`
          : '';
      return `${prefix}${code} ${msg}`.trim();
    }
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}
