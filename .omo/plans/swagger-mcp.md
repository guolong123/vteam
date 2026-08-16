# Swagger-MCP（vteam-api）+ keta-platform 改名 vteam 实施计划（可执行）

> 依据：`.omo/drafts/swagger-mcp.md`（用户已确认：命名 vteam + vteam-api、全量 API、权限默认 deny）
> 关联：server/src/platform-mcp/（现有 MCP 实现）、server/prisma/seed.ts、web/app/(main)/skills/page.tsx、
>       server/src/mcp-servers/（覆盖逻辑）、docs-json 70 路径（/api/v1/docs-json）

---

## 执行顺序总览

| # | 阶段 | 验收 |
|---|------|------|
| 1 | keta-platform → vteam 改名（代码 + 存量数据迁移 + 文档） | mcp_servers/tools 表无 keta 字样；worker opencode.json mcp 节为 vteam |
| 2 | 新增 Swagger-MCP（vteam-api）：工具生成 + handler 绑定 + 权限点校验 | MCP initialize/tools/list 返回全量工具；未授权工具调用被默认 deny 拦截 |
| 3 | seed 注册 vteam-api 内置 server + worker 注入验证 | `opencode mcp list` 显示 vteam / vteam-api connected |
| 4 | 权限点配置闭环（tools 表注册 + AgentToolEffect 联动 + agents 页可见） | agents 页可对 vteam-api 工具配 allow/deny，运行时生效 |
| 5 | 三端 tsc + jest + k8s 部署 + 在线实测 | 在线 MCP 调用 + 权限生效 + 存量迁移验证 |

---

## TODOs

- [x] 1. 阶段 1：`platform-mcp.constants.ts` PLATFORM_MCP_SERVER_NAME 'keta-platform'→'vteam'
- [x] 2. 阶段 1：seed.ts 内置 MCP 改名（mcp_servers name、tools 前缀 keta-platform_→vteam_、agent 模板 prompt 文本、注释）
- [x] 3. 阶段 1：server McpServersService.findAll 覆盖判断 name 'keta-platform'→'vteam'
- [x] 4. 阶段 1：web skills/page.tsx BUILTIN_MCP_SERVER_NAME 改 'vteam'（+ 新增 'vteam-api' 内置判定）
- [x] 5. 阶段 1：worker 注释更新（config.ts / injector.ts / registry-client.ts）
- [x] 6. 阶段 1：存量数据迁移（seed 迁移段：mcp_servers 旧行 rename + tools 表前缀替换）
- [x] 7. 阶段 1：测试与文档更新（README 根/worker/server、chart values/README、涉及 'keta-platform' 断言）
- [x] 8. 阶段 2：SwaggerDocument 提供（main.ts createDocument 存模块 provider，含 $ref dereference）
- [x] 9. 阶段 2：swagger-tools.ts 工具生成器（paths×methods → name/description/inputSchema(JSON Schema)/httpRef）
- [x] 10. 阶段 2：swagger-mcp.controller.ts（POST /api/v1/vteam-api/mcp，WorkerTokenGuard，JSON-RPC dispatch 骨架复用 platform-mcp）
- [x] 11. 阶段 2：handler 绑定（工具 → service 方法映射表 70 条，taskId 上下文补全 + assertWorkerTask 归属校验）
- [x] 12. 阶段 2：权限点校验（tools/call 解析实例 → AgentToolEffect[toolAction]：allow 放行 / deny 403 / 未配置默认 deny；ask v1 降级 deny）
- [x] 13. 阶段 2：swagger-mcp.module.ts + app.module 注册
- [x] 14. 阶段 3：seed 注册内置 'vteam-api' MCP server（remote，url=/api/v1/vteam-api/mcp，enabled=true）
- [x] 15. 阶段 4：tools 表注册 vteam-api 工具（source=mcp）+ agents 页工具配置区展示验证
- [x] 16. 阶段 5：单测（swagger-tools/controller 生成与权限）+ 三端 tsc + jest 全量
- [x] 17. 阶段 5：构建部署 k8s（server/web 镜像）+ helm upgrade
- [x] 18. 阶段 5：在线实测（MCP initialize/tools/list/call、权限 deny/allow、存量迁移、opencode mcp list）

## Final Verification Wave

- [x] F1. 评审：改名完整（代码/迁移/文档无 keta 残留；mcp_servers 与 tools 表无旧名行）
- [x] F2. 评审：vteam-api 工具生成正确（70 路径全映射、参数合并、$ref 解析、命名规则稳定）
- [x] F3. 评审：权限点闭环（默认 deny 拦截未授权、allow 放行、agents 页可配、管理面 API 默认不可达）
- [x] F4. 评审：存量 keta-platform 15 工具行为不变（默认 allow 保持，vteam 改名后连接正常）
- [x] F5. 在线端到端：agent 经 vteam-api 调业务 API（授权后）+ 未授权被拦截；worker opencode.json 含 vteam/vteam-api 两节

---

## 阶段 1：keta-platform → vteam 改名

### 1.1 代码改名（精确文件）
- `server/src/platform-mcp/platform-mcp.constants.ts:40`：`PLATFORM_MCP_SERVER_NAME = 'vteam'`（initialize 响应 serverInfo.name 同步）
- `server/prisma/seed.ts`：
  - :393/:405 `where: { name: 'keta-platform' }` / `name: 'keta-platform'` → `'vteam'`（id `ms_keta_platform` → `ms_vteam`，注意 upsert 主键 id 不变则 update 分支兼容）
  - :421+ 内置 4 工具：`name: 'keta-platform_chat_history'` 等 → `'vteam_chat_history'`（action 不变）；后续 ketaPlatformTools 数组内全部前缀替换
  - 模板 agent prompt 文本中 5 处 "keta-platform"（:148/:181/:213/:245/:278）→ "vteam"（提示词语义不变）
  - 注释（:130/:385/:416）同步
- `server/src/mcp-servers/mcp-servers.service.ts`：findAll 覆盖判断 `s.name === 'keta-platform'` → `'vteam'`
- `web/app/(main)/skills/page.tsx:209`：`BUILTIN_MCP_SERVER_NAME = "keta-platform"` → `"vteam"`；并扩展为内置集合 `['vteam', 'vteam-api']`（isBuiltinMcpServer 改为 includes）
- worker 注释：`worker/src/config.ts:39`、`worker/src/resources/injector.ts:226`、`worker/src/client/registry-client.ts:57` 中 "keta-platform" → "vteam"

### 1.2 存量数据迁移（seed 幂等迁移段）
在 seed 的 MCP 段之前插入迁移逻辑（仅当旧名存在时执行）：
- `prisma.mcpServer.findUnique({ where: { name: 'keta-platform' } })` 存在且 'vteam' 不存在 → `update name='vteam'`（保留 id/url/headers/enabled；url 仍用 PLATFORM_MCP_URL 覆盖）
- `prisma.tool.findMany({ where: { name: { startsWith: 'keta-platform_' } } })` → 逐条 `update name = name.replace('keta-platform_', 'vteam_')`（action 不变）
- 迁移失败不阻断 seed（warn + 继续）；执行后日志打印迁移条数
- ⚠️ 唯一约束：mcp_servers.name 唯一——先查 'vteam' 是否已存在，避免 rename 撞唯一（存在则仅删除/停用旧行）

### 1.3 测试与文档
- 涉及 'keta-platform' 断言的 spec：`platform-mcp.controller.spec.ts`（serverInfo name）、`mcp-servers.controller.spec.ts`（如有）→ 改 'vteam'
- README（根/worker/server）、chart/vteam/values.yaml、chart/vteam/README.md、learnings.md 中 "keta-platform" → "vteam"（文档可留一句历史说明，非必须）

## 阶段 2：Swagger-MCP（vteam-api）

### 2.1 SwaggerDocument 提供
- `main.ts`：`SwaggerModule.createDocument(app, config)` 结果保存（模块级 provider `SWAGGER_DOCUMENT` 或 SwaggerDocsProvider 注入），供 swagger-tools 生成工具
- `$ref` dereference：新增依赖 `@apidevtools/json-schema-ref-parser`（dereference 完整文档，处理循环引用/坏引用，与外部调研结论一致）；dereference 结果缓存（启动时一次）

### 2.2 工具生成器 `server/src/swagger-mcp/swagger-tools.ts`
- 输入：dereference 后的 SwaggerDocument
- 遍历 `paths`（70 路径）→ 每 path × 每 method（get/post/put/patch/delete）→ 1 个工具
- 工具定义结构（对齐 PlatformMcpTool 形态）：
  ```ts
  interface SwaggerMcpTool {
    name: string;            // operationId 或 `${method}_${pathKey}`；非法字符 → _ ；须 /^[a-z0-9_]+$/ 否则 sanitize
    description: string;     // operation.summary || operation.description || `${method.toUpperCase()} ${path}`
    inputSchema: object;     // JSON Schema（dereference 后内联）
    httpRef: { method: string; path: string };  // 供 handler 绑定
  }
  ```
- 参数合并 → inputSchema（JSON Schema object）：
  - path 参数：必填，type 来自 schema（缺省 string）
  - query 参数：可选，default 保留
  - requestBody（content['application/json']）：其 schema 的 properties 并入
  - header 参数（如 x-worker-token 等）：不暴露给模型（自动注入）
- 排除：`/docs-json`、`/docs`（Swagger UI 自身端点不暴露）

### 2.3 Controller `server/src/swagger-mcp/swagger-mcp.controller.ts`
- `POST /api/v1/vteam-api/mcp`：`@Public()` + `@UseGuards(WorkerTokenGuard)`，从 headers 读 `x-worker-id`
- JSON-RPC dispatch（复制 platform-mcp.controller 的 result/error/initialize/tools/list/tools/call 骨架，inputSchema 校验用 ajv——新增依赖 `ajv` + `ajv-formats`，工具生成时预编译 schema；不用 zod）
- tools/list：返回全部工具（含 inputSchema JSON Schema）；规模 70+，不强制分页（listChanged=false）

### 2.4 handler 绑定 `server/src/swagger-mcp/swagger-mcp.handlers.ts`
- 显式映射表：`Record<toolName, (ctx, args) => Promise<unknown>>`，70 条，逐 API 绑定到对应 service 方法：
  - tasks/* → TasksService、chat/* → ChatService、issues/* → IssuesService、artifacts/* → ArtifactsService、
    agents GET → AgentsService、projects GET → ProjectsService、workers GET → WorkersService、
    models/skills/tools/mcp-servers GET → 对应 service、users/roles → UsersService/RolesService 等
  - 参数透传：args 与 service 方法签名对齐（DTO 字段同名）；必需上下文字段（taskId 等）来自 args
- 归属校验：工具含 taskId 参数 → 复用 `PlatformMcpService.assertWorkerTask`（或独立实现：workerId + taskId → 该 worker 有绑定会话；无 taskId 的管理面工具仅 token 校验——由权限点默认 deny 兜底）
- handler 抛错 → MCP error -32603（message 取 HttpException 业务消息，复用 toErrorMessage 逻辑）

### 2.5 权限点校验 `server/src/swagger-mcp/swagger-mcp.auth.ts`
- tools/call 时：workerId（x-worker-id）→ 查该 worker 当前执行实例（session.taskAgentId）→ 所属 Agent
  - 解析失败（worker 无活跃会话）→ 无 agent 上下文 → **拒绝**（-32603 FORBIDDEN，防匿名调用）
- 读 `AgentToolEffect`（agentId + toolAction=toolName）：
  - effect=allow → 放行
  - effect=deny / 未配置 → 拒绝（MCP error，code FORBIDDEN，message 提示"工具未授权，请在 Agent 配置中开启"）
  - effect=ask → **v1 降级为 deny**（错误提示"ask 确认流 v1 未支持，请配置为 allow"）；不阻塞后续迭代
- 默认策略：未配置 = deny（安全默认；现有 keta-platform 15 工具不在此校验范围，行为不变）

### 2.6 模块与注册
- `server/src/swagger-mcp/swagger-mcp.module.ts` + `app.module.ts` imports
- seed：新增内置 `vteam-api` MCP server（type=remote，url=`/api/v1/vteam-api/mcp` 拼 server 基址——与 vteam 同源 PLATFORM_MCP_URL 前缀，headers `x-worker-token`/`x-worker-id` env 引用，enabled=true）

## 阶段 4：权限点配置闭环

- tools 表：vteam-api 生成的工具注册为 source=mcp 行（与 keta-platform 工具同构；action=toolName）——使 agents 页工具配置区可见可配
  - ⚠️ 70 工具全量注册 tools 表会膨胀列表：决策——**注册全部**（agent 配置粒度最细），agents 页按 mcpServer 过滤分组展示
- agents 页（web/app/(main)/agents/page.tsx 工具配置区）：已支持 MCP 工具 allow/ask/deny（复用 AgentToolEffect），验证 vteam-api 工具出现并可保存
- 权限运行时链路：MCP tools/call → agent 上下文 → AgentToolEffect 校验（2.5）

## 阶段 5：验证

- 单测：
  - `swagger-tools.spec.ts`：工具生成（路径数、命名 sanitize、参数合并、$ref 内联、排除 docs 端点）
  - `swagger-mcp.controller.spec.ts`：initialize/tools/list/tools/call + 权限（allow 放行/deny 拒绝/未配置默认 deny/无 agent 上下文拒绝）
  - 改名相关 spec 断言更新
- 三端 tsc（server/web/worker）+ jest 全量
- k8s：构建 server/web 镜像（tag vteam-k8s-vteam-api）→ helm upgrade → 在线实测：
  1. `curl -X POST /api/v1/vteam-api/mcp`（X-Worker-Token）initialize → tools/list 返回全量工具
  2. 未授权工具 tools/call → FORBIDDEN（默认 deny）
  3. agents 页对某工具配 allow → 该工具 tools/call 成功
  4. 存量迁移：mcp_servers 无 'keta-platform' 行、tools 表无 keta-platform_ 前缀；worker opencode.json mcp 节含 vteam + vteam-api
  5. `opencode mcp list`（worker 内）显示 vteam/vteam-api connected

## 依赖矩阵

- 任务 1-7（改名）独立，先做
- 任务 8-14（vteam-api）依赖 1-4（命名/内置判定一致）
- 任务 15（tools 注册 + agents 页）依赖 8-14
- 任务 16-18（验证）依赖全部

## Commit 分组（一个需求一个 commit，后续小改 --amend）

- C1 `feat(mcp): keta-platform 改名 vteam（含存量迁移与文档）`：任务 1-7
- C2 `feat(mcp): 新增 Swagger 全量 MCP server（vteam-api）与 agent 权限点`：任务 8-15
- C3 `test(mcp): vteam-api 生成/权限单测 + 改名断言更新`：任务 16（可与 C2 合并为 amend）

## Must-NOT-Have

- 不改 worker 核心协议与代码（worker 重启/reload-config 即生效，无需发版 worker）
- 不改现有 keta-platform 15 工具行为（vteam 改名后默认 allow 保持）
- 不引入独立进程 MCP server（全部内置 server）
- ask 确认流 v1 不做（降级 deny），托管模式确认对接留后续
- 不暴露 Swagger UI 端点（/docs、/docs-json）为工具
