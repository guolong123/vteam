# 平台 MCP Server 设计方案（群聊上下文/文档库按需拉取）

> 状态：设计评审（v2，已采纳决策：按需注入 + 用已有库）
> 关联：12 篇（产出物协议）、10 篇（群聊机制）、19 篇（worker-agent-任务关系）
> 目标：群聊上下文与文档库从「自动注入」演进为「MCP 工具按需拉取」，由模型自主决策（系统提示词说明），复用已有库与现有注入链。

---

## 1. 背景与问题

### 1.1 现状（自动注入）

`worker-dispatcher.ts` dispatch 时强制拼进 prompt 前缀：

```
<doclib>…产出物文档库（32KB 截断）…</doclib>
[群聊历史消息]
用户: xxx
Agent: xxx（32KB 截断）
<本条消息>
```

- `buildChatHistoryContext()`：频道全部 sent 历史，按条 + 总量截断（各 32KB）
- `buildDoclibContext()`：任务产出物文档库全文（32KB/文档，128KB 总量）

### 1.2 局限

| 问题 | 说明 |
|------|------|
| token 浪费 | 每次 @ 触发注入 64KB 上限上下文，对话越长浪费越大 |
| 无法按需深入 | 模型只能看到截断前缀，无法拉取指定消息/文档细节 |
| 与自主决策哲学不符 | 上下文被动喂给模型，不是 agent 主动查询 |
| 扩展性差 | 新增信息源（项目/外部搜索）都要改 prompt 注入逻辑 |

### 1.3 目标（已定）

- 群聊历史/文档库/任务信息通过 **MCP 工具**由模型自主按需拉取
- **移除自动注入**（doclib/群聊历史不再拼进 prompt）；**系统提示词说明**「需要上下文时调用 MCP 工具」
- 唯一保留的注入项：**当前消息**（模型必须知道被 @ 的内容）
- 复用现有 worker MCP 注入链路（mcp-servers 表 → injector → opencode.json）
- 为后续外部信息源扩展预留统一通道

---

## 2. 架构总览

```
┌────────────┐  MCP (streamable-http)  ┌──────────────────────┐
│ opencode   │ ──────────────────────→ │ server:3000          │
│ serve      │   JSON-RPC over HTTP    │ /api/v1/platform-mcp  │
│ (worker 内)│ ←────────────────────── │ (NestJS MCP 端点)     │
└────────────┘   tools/call 响应        └──────────┬───────────┘
                                                   │ Prisma
                                            ┌──────▼──────┐
                                            │ chat/artifacts│
                                            │ tasks/…      │
                                            └──────────────┘
```

- **remote MCP**（opencode 1.18 原生支持）：worker `opencode.json` 配
  `{ mcp: { "keta-platform": { type: "remote", url: "http://server:3000/api/v1/platform-mcp", headers: { "x-worker-token": "<token>" } } } }`
- worker 侧**零新增代码**——复用 `ResourceInjector.injectMcp()`（从 `GET /mcp-servers?enabled=true` 拉取注入）

## 3. 注册方式（复用现有注入链）

**seed 一条内置 MCP 记录**（`mcp-servers` 表，`McpServerService.create`）：

```
name: keta-platform
type: remote
url: http://server:3000/api/v1/platform-mcp
headers: { x-worker-token: "{env:X_WORKER_TOKEN}" }   ← 环境变量引用，worker 各自 token
enabled: true
```

`injector.injectMcp()` 自动拉取 → `buildMcpEntry(remote)` → 写 `opencode.json` 的 `mcp` 节 → serve 读取。

> **决策（已定）**：token 注入首选 opencode env 引用 `{env:X_WORKER_TOKEN}`（worker 侧 env 已有该变量，零改 worker）。
> 实施时先用 `opencode mcp` 实测验证 1.18 的 env 引用支持；若不支持 → 回退方案：`buildMcpEntry` 对 `keta-platform` 特判附加 `x-worker-token`（worker 注入器小改，可单测）。

## 4. Server 端 MCP 端点

### 4.1 协议（已定：用已有库）

新模块 `server/src/platform-mcp/`，暴露 `POST /api/v1/platform-mcp`：

- **传输**：MCP Streamable HTTP（opencode 1.18 remote 客户端兼容）
- **实现**：用 `@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport`（官方已有库，不重复实现协议细节）
  - `McpServer` + `registerTool` 注册 4 个工具
  - NestJS controller 接收 POST → transport.handleMessage → 返回 SSE/JSON 响应
- **JSON-RPC 方法**：`initialize` / `notifications/initialized` / `tools/list` / `tools/call`（SDK 内置）

### 4.2 鉴权

- **入口**：`X-Worker-Token` header（复用 `WorkerTokenGuard`）——仅已注册 worker 可调
- **归属校验**：tools/call 时校验「该 worker 是否有该 taskId 的 Session」——模型不能跨任务读数据
  （`session.findFirst({ where: { taskId, workerId } })`；无 Session → 403）

### 4.3 上下文归属（taskId 从哪来）

MCP 调用本身不携带「当前任务」——opencode 会话对 server 不透明。方案（已定）：

- **工具参数显式传 taskId**：`GLOBAL_SYSTEM_INSTRUCTIONS` 注入「你的任务 ID：<taskId>」与工具用法，
  模型调用时传入 taskId
- server 校验 worker↔task 归属后放行

## 5. 工具集（v1）

| 工具 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `chat_history` | taskId, sinceId?, limit? | 群聊消息列表（sender/text/time，分页） | 替代自动注入的群聊历史 |
| `doclib` | taskId, artifactId?, version? | 产出物清单 / 指定文档全文 | 替代自动注入的 doclib |
| `task_context` | taskId | 任务标题/状态/团队/背景文档 | 轻量任务概览 |
| `group_post` | taskId, content, fileRef? | 发送确认 | 主动发群聊（替代 group_post 声明） |

**扩展位**（后续）：`project_context`、`search_docs(taskId, keyword)`、外部信息源（web/代码库/其他 MCP 聚合）。

## 6. 安全边界

| 风险 | 缓解 |
|------|------|
| 模型越权读其他任务 | worker↔task Session 校验（4.2） |
| 工具被滥用（刷 group_post） | 限流（可选）：按 worker+task 窗口 |
| MCP 端点被非 worker 调用 | WorkerTokenGuard |
| 文档库内容泄露 | doclib 仅返回该 taskId 产出物 |

## 7. 迁移策略（已定：直接按需）

**一步到位（不做渐进）**：
- 新增平台 MCP + 4 工具（SDK 实现）
- **移除自动注入**：`buildDoclibContext` / `buildChatHistoryContext` 不再拼进 prompt
- `GLOBAL_SYSTEM_INSTRUCTIONS` 改为说明：
  - 「你的任务 ID：<taskId>」
  - 「需要群聊历史/文档库/任务信息时，调用 keta-platform 的 chat_history/doclib/task_context 工具」
  - 「需要向群聊发消息时调用 group_post 工具（或使用 <group_post> 声明）」
- **唯一保留注入**：当前消息（request.text）

> 兜底考虑：模型不用工具时上下文缺失 → 提示词明确引导 + 模型行为实测；
> 若实测模型频繁漏调，再评估回退注入「最近 N 条摘要」（记录为后续优化项，不在本方案默认范围）。

## 8. 实现阶段拆分

| 阶段 | 内容 | 验证 |
|------|------|------|
| 1 | server 平台 MCP 端点（SDK + StreamableHTTP）+ 4 工具 + 归属校验 | 单测 + curl 直接调 MCP 端点 |
| 2 | seed keta-platform MCP 记录 + worker 注入验证（env 引用） | `opencode mcp list` 显示 connected |
| 3 | 移除自动注入 + GLOBAL_SYSTEM_INSTRUCTIONS 改写（任务 ID/工具引导） | 单测（prompt 构造断言） |
| 4 | 实测：群聊 @ agent → agent 自主调 chat_history/doclib → 结论 group_post | 端到端（需模型凭据） |
| 5 | 设计文档落位 docs/agent-platform/21-平台MCP-Server设计方案.md | 文件存在 |

## 9. 风险与决策点（已定 + 待实施确认）

| 决策点 | 决策 |
|--------|------|
| MCP 传输实现 | **用已有库** `@modelcontextprotocol/sdk`（不重复实现） |
| 迁移策略 | **直接按需**：移除自动注入，系统提示词说明，模型自行决定 |
| token 注入 | env 引用 `{env:X_WORKER_TOKEN}`（实测验证，失败回退注入器特判） |
| 工具归属 | 参数传 taskId + worker Session 校验 |
| group_post | 工具优先、声明兜底（两通道保留兼容） |
| 依赖 | server 新增 `@modelcontextprotocol/sdk`（npm，评审确认版本） |

## 10. 涉及模块

- `server/src/platform-mcp/`（新）：MCP 端点（SDK + StreamableHTTP）+ 工具实现 + 归属校验
- `server/src/mcp-servers/`：seed keta-platform 记录
- `server/src/chat/worker-dispatcher.ts`：GLOBAL_SYSTEM_INSTRUCTIONS 改写 + 移除 buildDoclibContext/buildChatHistoryContext 注入
- `server/package.json`：新增 @modelcontextprotocol/sdk
- `worker/src/resources/injector.ts`：验证 env 引用（不可用则小改）
- docs：设计文档落位 docs/agent-platform/21-
