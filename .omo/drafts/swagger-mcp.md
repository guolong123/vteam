# Draft: 基于 Swagger 的默认 MCP 接口 + keta-platform 去 keta 命名

## 元信息
- slug: swagger-mcp
- intent: clear
- review_required: false
- status: **approved**（用户 2026-08-15 确认：命名 vteam+vteam-api、全量 API、默认 deny）
- plan: `.omo/plans/swagger-mcp.md`（已生成）

## 需求
1. 基于现有 Swagger（70 API 路径，/api/v1/docs-json）默认提供一套 MCP 接口，供 agent 调用
2. 现有 MCP 名称去掉 "keta" 字样（keta-platform → 新名；工具名前缀 keta-platform_* 同步）

## 现状（探索结论）
- 已有 platform-mcp（server/src/platform-mcp/）：手写 15 工具（chat_history/doclib/task_context/group_post/read_file/notify_agent/submit_artifact/issue_*/task_transition/question_confirm），Streamable HTTP POST /api/v1/platform-mcp，X-Worker-Token 鉴权（WorkerTokenGuard），zod inputSchema → JSON Schema
- mcp_servers 表：seed 写入内置 `keta-platform`（remote 型 url=PLATFORM_MCP_URL，headers 含 x-worker-token/x-worker-id），worker injectMcp() 拉取注入 opencode.json
- 覆盖逻辑：server McpServersService.findAll 按 worker.capabilities.mcpUrl 覆盖内置 `keta-platform` 地址（x-worker-id）
- 鉴权分布（Swagger 70 路径）：
  - worker 可访问（X-Worker-Token/WorkerOrJwtGuard）：workers register/heartbeat/events、skills GET、tools GET、mcp-servers GET、platform-mcp、auth（Public）、health
  - 其余业务 API（tasks/chat/issues/artifacts/agents/users/roles/models/projects/git-repos）均为用户 JWT + 项目成员
- 外部方案调研（librarian）：
  - MCP 官方无 OpenAPI 适配器（servers 仅 7 参考 server）；协议层已对齐 JSON Schema 2020-12（SEP-2106）
  - 社区方案：evalops/mcp-openapi（TS，活跃）、awslabs openapi-mcp-server（Python 9.6k★）、Pivotal openapi-to-mcp（API_HEADERS 静态 header）——均为独立进程 HTTP 转发型，鉴权无法满足"agent 无用户 JWT 调业务 API"
  - 结论：HTTP 转发型方案不适用（业务 API 需用户 JWT+项目成员）；应采用"内部 service 调用 + worker 上下文校验"（与现有 keta-platform 同构）

## 权限方案（用户新需求：可配置 agent 权限点）
- 复用现有 AgentToolEffect（agent × toolAction → allow/ask/deny，agents 页工具配置区已可编辑）
- Swagger-MCP 每个工具 = 一个 toolAction 权限点（注册进 tools 表 source=mcp，与 keta-platform_* 同构）
- 运行时校验（新增）：tools/call 时解析调用实例 → 所属 agent → 读 AgentToolEffect[toolAction]：
  allow 放行 / deny 403 / ask 转确认流（对齐现有托管/弹窗模式）/ 未配置 = 默认 deny（安全默认，agent 页显式开启）
- 现有 keta-platform 15 工具行为保持不变（不因新增默认策略破坏存量）
- 管理面 API（users/roles 等）因默认 deny，需管理员在 agent 配置显式授权——缓解全量暴露风险

## 关键设计决策（用户已确认）
- D1 工具范围：**全量 API**（70 路径全部映射；权限由 AgentToolEffect 默认 deny 兜底）
- D2 命名：用户要求"更直观的名称"，待批准 brief 确认（推荐现有改名 vteam、新增 vteam-api）
- D3 鉴权：内部 service 调用 + X-Worker-Token + workerId + taskId 归属校验（对齐 keta-platform）+ 工具级 effect 校验（上述权限方案）

## 待探索（如需要）
- seed mcp_servers 结构能否加第二个内置 server（多个内置 remote server 注入 opencode.json）
- tools 表 keta-platform_* 存量数据迁移方式

## 计划骨架（批准后填充）
- 改名任务：constants/seed/service 覆盖逻辑/web 内置判定/worker 注释/文档 + 存量数据迁移（mcp_servers.name、tools.name）
- Swagger-MCP：新增 MCP server（NestJS 内置，/api/v1/<name>/mcp），从 SwaggerDocument 动态生成工具定义，handler 绑定 service + 上下文校验；注册进 mcp_servers（默认启用，worker 自动注入）
