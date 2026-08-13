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

  constructor(private readonly service: PlatformMcpService) {
    this.tools = buildPlatformMcpTools(service);
  }

  @Public()
  @UseGuards(WorkerTokenGuard)
  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: '平台 MCP Streamable HTTP 端点（X-Worker-Token 鉴权，initialize/tools/list/call）',
  })
  handle(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): unknown {
    const workerId = String(req.headers[WORKER_ID_HEADER] ?? '');
    // MCP 通知契约：无 id 请求 → 202 Accepted（passthrough 仅设状态码，响应体仍 Nest 序列化）
    const message = body as { id?: unknown } | null | undefined;
    if (message && typeof message === 'object' && message.id === undefined) {
      res.status(202);
    }
    return this.dispatch(body, workerId);
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
    summary: '平台 MCP 端点仅支持 POST（JSON-RPC over HTTP），GET（SSE 流）返回 405',
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
  private dispatch(body: unknown, workerId: string): unknown {
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
        return this.toolsCall(message.id, message.params, workerId);
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
   * -32602 含 zod message）→ handler 调用（抛错 → -32603）。handler 结果经
   * JSON.stringify 包成 text 内容（与 SDK 工具调用结果契约一致）。
   */
  private async toolsCall(
    id: unknown,
    params: unknown,
    workerId: string,
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
      return this.error(id, ERROR_INVALID_PARAMS, z.prettifyError(parsed.error));
    }

    try {
      const result = await tool.handler({ workerId }, parsed.data);
      return this.result(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      });
    } catch (err) {
      return this.error(id, ERROR_INTERNAL_ERROR, this.toErrorMessage(err));
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

  /** 异常 → 错误 message：Nest HttpException 取响应体 message（业务错误码可读），其余取 Error.message。 */
  private toErrorMessage(err: unknown): string {
    if (err instanceof HttpException) {
      const response = err.getResponse();
      if (
        response &&
        typeof response === 'object' &&
        'message' in response &&
        typeof (response as { message?: unknown }).message === 'string'
      ) {
        return (response as { message: string }).message;
      }
      return err.message;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}
