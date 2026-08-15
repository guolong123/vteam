import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Swagger 工具生成器（Swagger-MCP / vteam-api，阶段 2 任务 9）。
 *
 * 输入：SwaggerDocsProvider 提供的 dereference 后 OpenAPI 文档。
 * 输出：SwaggerMcpTool[] —— 每个 path × method（get/post/put/patch/delete）生成
 * 1 个工具；inputSchema 为纯 JSON Schema（合并 path 必填参数 + query 可选参数
 * [default 保留] + requestBody properties；header 参数不暴露）；httpRef 供后续
 * handler 绑定（任务 11）。Swagger UI 自身端点（/docs、/docs-json）不暴露。
 *
 * SwaggerMcpTool 是本模块契约接口（controller tools/list 直接返回 inputSchema，
 * handler 按 httpRef 绑定），保持稳定。
 */

/** Swagger 生成的 MCP 工具（契约接口，供 controller/handler 消费）。 */
export interface SwaggerMcpTool {
  name: string;
  description: string;
  inputSchema: object;
  httpRef: { method: string; path: string };
}

/**
 * OpenAPI 3.0 子类型（本模块所需最小结构）。
 * @nestjs/swagger 主入口仅导出 OpenAPIObject（PathItemObject 等不 re-export），
 * 此处按 OpenAPI 3.0 规范定义与运行时数据一致的本地类型。
 */
export interface SwaggerParameterObject {
  name: string;
  in: string;
  required?: boolean;
  schema?: {
    type?: string;
    default?: unknown;
    description?: string;
    enum?: unknown[];
  };
}

export interface SwaggerOperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: SwaggerParameterObject[];
  requestBody?: { content?: Record<string, { schema?: object }> };
}

export interface SwaggerPathItemObject {
  parameters?: SwaggerParameterObject[];
  get?: SwaggerOperationObject;
  post?: SwaggerOperationObject;
  put?: SwaggerOperationObject;
  patch?: SwaggerOperationObject;
  delete?: SwaggerOperationObject;
}

/** Swagger UI 自身端点（/docs、/docs-json）不暴露为工具。 */
const EXCLUDED_PATHS = new Set(['/docs', '/docs-json']);

/** 支持的 HTTP 方法（按 OpenAPI 常见顺序，与 plans 契约一致）。 */
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

/** 遍历 document.paths × method，生成工具数组（跳过 /docs、/docs-json 与空操作）。 */
export function generateSwaggerTools(
  document: OpenAPIObject,
): SwaggerMcpTool[] {
  const tools: SwaggerMcpTool[] = [];
  const paths = document.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (EXCLUDED_PATHS.has(path)) continue;
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const operation = (pathItem as SwaggerPathItemObject)[method];
      if (!operation || typeof operation !== 'object') continue;
      tools.push(
        buildTool(path, pathItem as SwaggerPathItemObject, method, operation),
      );
    }
  }
  return tools;
}

function buildTool(
  path: string,
  pathItem: SwaggerPathItemObject,
  method: HttpMethod,
  operation: SwaggerOperationObject,
): SwaggerMcpTool {
  return {
    name: resolveToolName(path, method, operation),
    description:
      operation.summary ||
      operation.description ||
      `${method.toUpperCase()} ${path}`,
    inputSchema: buildInputSchema(pathItem, operation),
    httpRef: { method, path },
  };
}

/**
 * 工具名：operationId 存在时 sanitize（转小写，非 /^[a-z0-9_]+$/ 字符 → _）；
 * 缺失或 sanitize 后为空 → `${method}_${pathKey}`。
 */
function resolveToolName(
  path: string,
  method: HttpMethod,
  operation: SwaggerOperationObject,
): string {
  if (
    typeof operation.operationId === 'string' &&
    operation.operationId.trim() !== ''
  ) {
    const sanitized = operation.operationId
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_');
    if (sanitized !== '') return sanitized;
  }
  return `${method}_${toPathKey(path)}`;
}

/** `/users/{id}` → `users_id`（去 /{} 转 _、合并连续下划线、去首尾下划线）。 */
function toPathKey(path: string): string {
  return path
    .replace(/[\/{}]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * inputSchema（JSON Schema object）合并规则：
 * - path 级 + operation 级 parameters：path 参数必填（入 required）；query 参数可选，
 *   schema 的 default/description/enum 保留；header 参数不暴露（网关自动注入）；
 *   参数 type 缺省 string。
 * - requestBody：content['application/json'] 的 schema properties 并入（dereference
 *   后已内联），其 required 并入 required。
 */
function buildInputSchema(
  pathItem: SwaggerPathItemObject,
  operation: SwaggerOperationObject,
): object {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const parameters: SwaggerParameterObject[] = [
    ...(pathItem.parameters ?? []),
    ...(operation.parameters ?? []),
  ];
  for (const param of parameters) {
    if (
      !param ||
      typeof param !== 'object' ||
      typeof param.name !== 'string' ||
      typeof param.in !== 'string'
    ) {
      continue;
    }
    if (param.in === 'header') continue;
    properties[param.name] = paramSchemaToProperty(param);
    if (param.in === 'path') {
      required.push(param.name);
    }
  }

  const requestBody = operation.requestBody as
    { content?: Record<string, { schema?: object }> } | undefined;
  const jsonContent = requestBody?.content?.['application/json'];
  const bodySchema = jsonContent?.schema as
    { properties?: Record<string, unknown>; required?: string[] } | undefined;
  if (bodySchema?.properties) {
    Object.assign(properties, bodySchema.properties);
  }
  if (bodySchema?.required) {
    required.push(...bodySchema.required);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
  };
}

/** 参数 schema → JSON Schema 属性（type 缺省 string；default/description/enum 保留）。 */
function paramSchemaToProperty(param: SwaggerParameterObject): object {
  const schema = param.schema as
    | {
        type?: string;
        default?: unknown;
        description?: string;
        enum?: unknown[];
      }
    | undefined;
  return {
    type: schema?.type ?? 'string',
    ...(schema?.description !== undefined
      ? { description: schema.description }
      : {}),
    ...(schema?.default !== undefined ? { default: schema.default } : {}),
    ...(schema?.enum !== undefined ? { enum: schema.enum } : {}),
  };
}
