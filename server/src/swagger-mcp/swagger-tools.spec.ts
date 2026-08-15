import type { OpenAPIObject } from '@nestjs/swagger';
import { generateSwaggerTools } from './swagger-tools';

describe('generateSwaggerTools', () => {
  /** mock SwaggerDocument：覆盖 operationId 存在/缺失/非法、requestBody、path/query/header 参数、/docs 排除。 */
  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: 'Test API', version: '1.0' },
    paths: {
      '/users': {
        get: {
          operationId: 'listUsers',
          summary: '用户列表',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 10 },
            },
            {
              name: 'x-worker-token',
              in: 'header',
              schema: { type: 'string' },
              description: 'worker 鉴权（自动注入）',
            },
          ],
          responses: { '200': { description: 'OK' } },
        },
        post: {
          operationId: 'createUser',
          summary: '创建用户',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    age: { type: 'integer' },
                  },
                  required: ['name'],
                },
              },
            },
          },
          responses: { '201': { description: 'Created' } },
        },
      },
      '/users/{id}': {
        // 缺 operationId + 无 summary/description → name=get_users_id、description=GET /users/{id}
        get: {
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            // 无 schema 的 query 参数 → type 缺省 string
            { name: 'verbose', in: 'query' },
          ],
          responses: { '200': { description: 'OK' } },
        },
        put: {
          operationId: 'update-User!ID',
          summary: '更新用户',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/docs': {
        get: { operationId: 'swaggerUi', summary: 'Swagger UI', responses: {} },
      },
      '/docs-json': {
        get: {
          operationId: 'swaggerJson',
          summary: 'Swagger JSON',
          responses: {},
        },
      },
    },
  };

  it('生成 path×method 工具（4 个：/docs 与 /docs-json 被排除）', () => {
    const tools = generateSwaggerTools(document);
    expect(tools.map((t) => t.name)).toEqual([
      'listusers',
      'createuser',
      'get_users_id',
      'update_user_id',
    ]);
    expect(tools).toHaveLength(4);
  });

  it('operationId 命名：存在时 sanitize 为 /^[a-z0-9_]+$/（小写化，非法字符 → _：update-User!ID → update_user_id）', () => {
    const tools = generateSwaggerTools(document);
    const update = tools.find((t) => t.httpRef.method === 'put');
    expect(update?.name).toBe('update_user_id');
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('缺 operationId：回退 ${method}_${pathKey}（/users/{id} → get_users_id）', () => {
    const tools = generateSwaggerTools(document);
    const getById = tools.find(
      (t) => t.httpRef.method === 'get' && t.httpRef.path === '/users/{id}',
    );
    expect(getById?.name).toBe('get_users_id');
  });

  it('description：summary 优先；缺失回退 `${method.toUpperCase()} ${path}`', () => {
    const tools = generateSwaggerTools(document);
    const list = tools.find(
      (t) => t.httpRef.path === '/users' && t.httpRef.method === 'get',
    );
    const getById = tools.find((t) => t.name === 'get_users_id');
    expect(list?.description).toBe('用户列表');
    expect(getById?.description).toBe('GET /users/{id}');
  });

  it('inputSchema：query 参数可选且 default 保留；header 参数不暴露', () => {
    const tools = generateSwaggerTools(document);
    const list = tools.find(
      (t) => t.httpRef.path === '/users' && t.httpRef.method === 'get',
    );
    const schema = list?.inputSchema as {
      type: string;
      properties: Record<string, { type: string; default?: number }>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties.limit).toEqual({ type: 'integer', default: 10 });
    expect(schema.properties['x-worker-token']).toBeUndefined();
    expect(schema.required).toBeUndefined(); // 无 path 参数、body required → 不输出 required
  });

  it('inputSchema：path 参数必填入 required；无 schema 参数 type 缺省 string', () => {
    const tools = generateSwaggerTools(document);
    const getById = tools.find((t) => t.name === 'get_users_id');
    const schema = getById?.inputSchema as {
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(schema.required).toEqual(['id']);
    expect(schema.properties.id).toEqual({ type: 'string' });
    expect(schema.properties.verbose).toEqual({ type: 'string' });
  });

  it('inputSchema：requestBody（application/json）schema properties 并入，required 并入', () => {
    const tools = generateSwaggerTools(document);
    const create = tools.find(
      (t) => t.httpRef.path === '/users' && t.httpRef.method === 'post',
    );
    const schema = create?.inputSchema as {
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(schema.properties.name).toEqual({ type: 'string' });
    expect(schema.properties.age).toEqual({ type: 'integer' });
    expect(schema.required).toEqual(['name']);
  });

  it('httpRef：记录 method 与 path（handler 绑定用）', () => {
    const tools = generateSwaggerTools(document);
    expect(tools[0].httpRef).toEqual({ method: 'get', path: '/users' });
    expect(tools[2].httpRef).toEqual({ method: 'get', path: '/users/{id}' });
  });
});
