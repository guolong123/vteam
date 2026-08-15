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
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { Public } from '../auth/decorators/public.decorator';
import { WorkerTokenGuard } from '../workers/worker-token.guard';
import { SwaggerMcpAuthService } from './swagger-mcp.auth';
import { SwaggerMcpHandler, SwaggerMcpHandlers } from './swagger-mcp.handlers';
import { SwaggerDocsProvider } from './swagger-docs.provider';
import { generateSwaggerTools, SwaggerMcpTool } from './swagger-tools';

/**
 * x-worker-id header：worker 注入的会话归属标识（与 platform-mcp 一致）。
 * 权限与 taskId 归属校验在 auth service 内完成（worker → 实例 → agent → AgentToolEffect）。
 */
const WORKER_ID_HEADER = 'x-worker-id';

/** MCP 协议版本（与 platform-mcp 对齐）。 */
const MCP_PROTOCOL_VERSION = '2025-03-26';

/** JSON-RPC 错误码（JSON-RPC 2.0 规范）。 */
const ERROR_INVALID_REQUEST = -32600;
const ERROR_METHOD_NOT_FOUND = -32601;
const ERROR_INVALID_PARAMS = -32602;
const ERROR_INTERNAL_ERROR = -32603;

/** Swagger-MCP server 标识（对齐 seed 阶段 3 的 mcp-servers name）。 */
const SWAGGER_MCP_SERVER_NAME = 'vteam-api';
const SWAGGER_MCP_SERVER_VERSION = '1.0.0';

/** 未命中 handler 映射时的业务错误。 */
const ERROR_NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';

/**
 * Swagger-MCP（vteam-api）Streamable HTTP 端点（阶段 2 任务 10）。
 *
 * - `POST /api/v1/vteam-api/mcp`：`@Public()` 跳过全局 JwtAuthGuard，
 *   `@UseGuards(WorkerTokenGuard)` 校验 `X-Worker-Token`，`x-worker-id` 标识
 *   调用方 worker。
 * - 手写 JSON-RPC 分发（对齐 platform-mcp.controller 骨架）：initialize /
 *   tools/list / tools/call / 未知 method / notification（无 id → 202 Accepted）。
 * - 工具定义来自 Swagger 文档（generateSwaggerTools，70+ 路径），inputSchema 为
 *   JSON Schema——tools/call 用 **ajv 预编译**校验（区别于 platform-mcp 的 zod）。
 * - tools/call 链路：工具名校验 → ajv 校验 arguments → 权限点校验（auth.authorize）
 *   → handler 命中（无映射 NOT_IMPLEMENTED）→ taskId 归属校验（含 taskId 的工具）
 *   → service 调用 → 结果 JSON.stringify 包成 text。
 */
@ApiTags('vteam-api')
@Controller('vteam-api/mcp')
export class SwaggerMcpController {
  private readonly handlers: readonly SwaggerMcpHandler[];
  private readonly handlersService: SwaggerMcpHandlers;
  private readonly ajv: Ajv;
  private readonly compiled = new Map<string, ValidateFunction>();
  private toolsCache: readonly SwaggerMcpTool[] | null = null;

  constructor(
    private readonly docs: SwaggerDocsProvider,
    handlers: SwaggerMcpHandlers,
    private readonly auth: SwaggerMcpAuthService,
  ) {
    this.handlersService = handlers;
    this.handlers = handlers.build();
    this.ajv = new Ajv({ strict: false });
    addFormats(this.ajv);
  }

  /** 懒加载工具清单：首次请求时 Swagger 文档已 initialize，生成后缓存。 */
  private tools(): readonly SwaggerMcpTool[] {
    if (this.toolsCache === null) {
      const document = this.docs.getDocument();
      this.toolsCache = document ? generateSwaggerTools(document) : [];
    }
    return this.toolsCache;
  }

  @Public()
  @UseGuards(WorkerTokenGuard)
  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Swagger-MCP（vteam-api）端点（X-Worker-Token 鉴权，initialize/tools/list/call）',
  })
  handle(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): unknown {
    const workerId = String(req.headers[WORKER_ID_HEADER] ?? '');
    const message = body as { id?: unknown } | null | undefined;
    if (message && typeof message === 'object' && message.id === undefined) {
      res.status(202);
    }
    return this.dispatch(body, workerId);
  }

  /** GET（SSE 流探测）：与 platform-mcp 一致仅支持 POST，返回 405。 */
  @Public()
  @UseGuards(WorkerTokenGuard)
  @Get()
  @HttpCode(405)
  @ApiOperation({
    summary: 'Swagger-MCP 端点仅支持 POST（JSON-RPC over HTTP）',
  })
  methodNotAllowed(): { code: string; message: string } {
    return {
      code: 'METHOD_NOT_ALLOWED',
      message: '仅支持 POST（JSON-RPC over HTTP）',
    };
  }

  private dispatch(body: unknown, workerId: string): unknown {
    const message = body as
      | { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown }
      | null
      | undefined;

    if (!message || typeof message !== 'object') {
      return this.error(undefined, ERROR_INVALID_REQUEST, 'Invalid Request');
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

  private initialize(id: unknown): unknown {
    return this.result(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: SWAGGER_MCP_SERVER_NAME,
        version: SWAGGER_MCP_SERVER_VERSION,
      },
    });
  }

  private toolsList(id: unknown): unknown {
    return this.result(id, {
      tools: this.tools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  }

  /**
   * tools/call：工具名校验 → ajv 校验 arguments → 权限点校验 → handler 命中 →
   * taskId 归属校验 → service 调用。失败一律返回 JSON-RPC error（不抛 HTTP 异常）。
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
    const tool = this.tools().find((t) => t.name === name);
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
    const validation = this.validateArguments(tool, argumentsValue);
    if (validation.ok === false) {
      return this.error(id, ERROR_INVALID_PARAMS, validation.message);
    }
    const args = validation.args;

    try {
      await this.auth.authorize(workerId, tool.name);

      const handler = this.findHandler(tool);
      if (!handler) {
        return this.error(
          id,
          ERROR_INTERNAL_ERROR,
          `${ERROR_NOT_IMPLEMENTED}: 该 API 暂未接入 service 绑定`,
        );
      }

      const taskId = handler.taskIdOf?.(args);
      if (taskId) {
        await this.auth.assertWorkerTask(workerId, taskId);
      }

      const result = await handler.call({ workerId }, args);
      return this.result(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      });
    } catch (err) {
      return this.error(id, ERROR_INTERNAL_ERROR, this.toErrorMessage(err));
    }
  }

  /** ajv 预编译校验（按工具 inputSchema 缓存编译结果）；失败返回 ok:false + ajv message。 */
  private validateArguments(
    tool: SwaggerMcpTool,
    argumentsValue: unknown,
  ):
    | { ok: true; args: Record<string, unknown> }
    | { ok: false; message: string } {
    let validate = this.compiled.get(tool.name);
    if (!validate) {
      validate = this.ajv.compile(tool.inputSchema as object);
      this.compiled.set(tool.name, validate);
    }
    if (!validate(argumentsValue)) {
      return { ok: false, message: this.ajvMessage(validate.errors) };
    }
    return {
      ok: true,
      args:
        (argumentsValue as Record<string, unknown> | null | undefined) ?? {},
    };
  }

  private ajvMessage(errors: ValidateFunction['errors']): string {
    if (!errors || errors.length === 0) return 'arguments 校验失败';
    return errors
      .map(
        (e) =>
          `${e.instancePath || '/'} ${e.message ?? '校验失败'}${
            e.params && 'additionalProperty' in e.params
              ? `: ${String((e.params as { additionalProperty?: unknown }).additionalProperty)}`
              : ''
          }`,
      )
      .join('; ');
  }

  private findHandler(tool: SwaggerMcpTool): SwaggerMcpHandler | undefined {
    return (
      this.handlers.find((h) => h.match(tool.httpRef)) ??
      this.handlersService.autoHandler?.(tool)
    );
  }

  private result(id: unknown, result: unknown): unknown {
    return { jsonrpc: '2.0', id, result };
  }

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
