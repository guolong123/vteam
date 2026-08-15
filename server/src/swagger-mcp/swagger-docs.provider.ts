import { Injectable, Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { dereference } from '@apidevtools/json-schema-ref-parser';

/**
 * Swagger 原始文档 store（模块级）：main.ts 在 `SwaggerModule.createDocument`
 * 后调用 `setSwaggerRawDocument(document)` 写入。dereference 结果同样缓存到
 * 模块级——保证 DI 注入的 `SwaggerDocsProvider` 实例（controller/handler 消费）
 * 与 main.ts 中执行 initialize 的实例共享同一份文档（dereference 全量内联成本
 * 仅启动时一次，避免每实例重复解析）。
 */
let rawDocument: OpenAPIObject | null = null;

/** dereference 后的文档（initialize 成功写入；失败降级为原始文档）。 */
let resolvedDocument: OpenAPIObject | null = null;

/** main.ts 写入原始 OpenAPI 文档（createDocument 结果）。 */
export function setSwaggerRawDocument(document: OpenAPIObject | null): void {
  rawDocument = document;
}

/**
 * SwaggerDocument 提供者（Swagger-MCP / vteam-api，阶段 2 任务 8）。
 *
 * 职责：持有 Swagger OpenAPI 文档（模块级 store，构造无参——DI 可注入），
 * initialize() 时用 `@apidevtools/json-schema-ref-parser` 做一次 $ref
 * dereference 并缓存（v11 默认 clone 输入，不污染 Swagger UI 使用的原始
 * document）。dereference 失败仅 warn 降级为原始文档，不阻断服务启动。
 *
 * 消费方：swagger-tools.ts 的 `generateSwaggerTools`（任务 9）与
 * `swagger-mcp.controller.ts`（任务 10）——dereference 后各 schema 的 $ref
 * 已内联，可直接并入工具 inputSchema。
 */
@Injectable()
export class SwaggerDocsProvider {
  private readonly logger = new Logger(SwaggerDocsProvider.name);

  constructor() {}

  /** 启动时调用一次：$ref dereference + 缓存；失败 warn 降级原始文档，不阻断启动。 */
  async initialize(): Promise<void> {
    if (!rawDocument) {
      this.logger.warn(
        'Swagger 原始文档未设置（setSwaggerRawDocument 未调用），工具生成将为空',
      );
      return;
    }
    try {
      resolvedDocument = (await dereference(rawDocument)) as OpenAPIObject;
      const pathCount = Object.keys(resolvedDocument.paths ?? {}).length;
      this.logger.log(
        `Swagger 文档 $ref dereference 完成（${pathCount} 个路径）`,
      );
    } catch (err) {
      this.logger.warn(
        `Swagger 文档 dereference 失败，降级使用原始文档（不阻断启动）：${this.toMessage(err)}`,
      );
      resolvedDocument = rawDocument;
    }
  }

  /** dereference 后的 OpenAPI 文档（失败时为原始文档）；未 initialize 前为 null。 */
  getDocument(): OpenAPIObject | null {
    return resolvedDocument;
  }

  private toMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
