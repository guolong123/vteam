# Worker 交互接口协议

> 本文档整理 vteam 中 **Worker 节点与 Server 控制面**之间的全部交互接口。
> 协议类型：**纯 HTTP REST**（无 WebSocket、无消息队列）。
>
> 代码权威来源：
> - Server 路由：`server/src/workers/workers.controller.ts`、`worker-events.controller.ts`
> - Server 客户端：`server/src/workers/worker.client.ts`
> - Worker 客户端：`worker/src/client/registry-client.ts`、`event-client.ts`、`resources/injector.ts`
> - 协议双写类型：`worker/src/protocol/worker-protocol.ts` ↔ `server/src/workers/dto/*`
> - Worker 执行端点：`worker/src/exec/exec-server.ts`
>
> 全局路由前缀：`/api/v1`（server 侧）。

---

## 0. 交互总览

Worker 与 Server 之间共有 **5 条 HTTP 通道**：

| # | 通道 | 方向 | 模式 | 用途 |
|---|------|------|------|------|
| ① | 注册 / 心跳 | Worker → Server | 主动 POST（10s 周期） | 注册、负载上报、**下行命令捎带** |
| ② | 事件回流 | Worker → Server | 主动 POST（实时推送） | 会话状态、流式增量、任务完成等事件 |
| ③ | 资源拉取 | Worker → Server | Worker 反向 GET（收到 reload 信号后） | 技能 / 工具 / MCP / Agent 策略注入 |
| ④ | 执行端点 | Server → Worker | Server 主动 POST/GET（`execPort`，默认 4198） | 下发执行任务、文件拉取、计划/OmO 配置 |
| ⑤ | serve 代理 | Server → Worker | Server 主动 POST/GET（`capabilities.baseUrl:port`） | opencode serve 会话 API 透传 |

```
 Worker ──①register/heartbeat(10s)──▶ Server     （心跳响应捎带 commands）
 Worker ──②POST /worker/events──────▶ Server     （事件实时回流，恒 202）
 Worker ──③GET /skills /tools ...───▶ Server     （收到 reload-config 后拉取）
 Server ──④POST /execute 等─────────▶ Worker:4198（执行端点，独立 node:http）
 Server ──⑤POST /session 等─────────▶ Worker:serve（opencode serve REST）
```

**下行命令模型（①捎带）**：Server 端资源/配置变更时不直接推送，而是把命令入队
（`enqueueCommand` / `broadcastCommand`），Worker 下一次心跳的**响应体**中携带
`commands[]`，取出即清空（一次有效）。

**资源内容模型（③拉取）**：`reload-config` 只是信号；Worker 收到后由
`ResourceInjector` 反向 GET Server 的资源接口，把内容写入本地
`<workDir>/.opencode/` 与 `opencode.json`。

---

## 1. 鉴权

| 场景 | 鉴权方式 | 头 / 凭据 |
|------|---------|----------|
| Worker → Server：register / heartbeat / events / 资源拉取 | **共享 Worker Token** | `x-worker-token: <WORKER_TOKEN>` |
| 心跳二次校验 | bcrypt 比对注册时落库的 `tokenHash` | 同上（不匹配 → 401 `TOKEN_INVALID`） |
| 资源拉取附加身份 | Worker 身份（Server 据此覆盖内置 MCP 地址） | `x-worker-id: <workerId>` |
| Server → Worker：执行端点（④） | Worker Token | `X-Worker-Token: <WORKER_TOKEN>` |
| Server → Worker：serve 代理（⑤） | Basic Auth（可选） | `Authorization: Basic base64(opencode:<SERVER_PASSWORD>)`；密码为空则不鉴权 |
| 管理端点（列表/详情/重启等） | 用户 JWT + 权限 | `Authorization: Bearer <accessToken>` + `workers.view` / `workers.edit` / `workers.delete` |

常量：

| 名称 | 值 | 位置 |
|------|-----|------|
| `WORKER_TOKEN_HEADER` | `x-worker-token` | server `workers.constants.ts` / worker `registry-client.ts` 双写 |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `10_000`（10s） | server |
| `WORKER_OFFLINE_TIMEOUT_MS` | `30_000`（30s = 3 个心跳周期） | server |
| `DEFAULT_EXEC_PORT` | `4198` | server `worker.client.ts` |
| `TOKEN_CHECK_TTL_MS` | `30_000`（心跳 token 校验缓存） | server `workers.service.ts` |

---

## 2. 通道①：注册与心跳（Worker → Server）

### 2.1 注册 `POST /api/v1/workers/register`

- **鉴权**：`x-worker-token`（`WorkerTokenGuard`，`@Public()` 跳过全局 JWT）
- **语义**：upsert（首次 create，重复注册 update 覆盖版本/能力/负载并刷新心跳）。
  每次注册无条件回放全部未吊销模型凭据与 git 凭据（`replayModelCredentials` / `replayGitCredentials`），
  并把 `capabilities.models` 合并入模型目录（`syncFromWorkerCapabilities`）。
- **重试**：Worker 侧指数退避（1s/2s/4s/8s/16s/30s 封顶，默认最多 8 次）。

**请求体**（`RegisterWorkerDto`）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `workerId` | string | ✅ | 全局唯一 id（`w_` 前缀） |
| `name` | string | ❌ | 显示名 |
| `opencodeVersion` | string | ✅ | opencode 版本 |
| `capabilities` | object | ✅ | 能力声明，见下表 |
| `load` | object | ✅ | `{ instances: number }` |
| `defaultModelId` | string | ❌ | 默认模型 id（`providerID/modelID`） |
| `mcpUrl` | string | ❌ | 内置 vteam MCP 地址覆盖（集群外 worker 用） |

**`capabilities` 字段**（`WorkerCapabilitiesDto`）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `maxInstances` | int | ✅ | 最大并发会话数 |
| `skills` | string[] | ✅ | 启用技能名列表 |
| `tools` | string[] | ✅ | 工具名列表 |
| `models` | string[] | ❌ | serve 可用模型 id（`providerID/modelID`），入库同步用 |
| `executableModels` | string[] | ❌ | `opencode models` CLI 真实可执行模型集 |
| `port` | int | ❌ | serve 实际监听端口 |
| `baseUrl` | string | ❌ | serve 对 server 公布的基址（优先于 `port`） |
| `execPort` | int | ❌ | 执行端点端口（默认 4198） |
| `agentPolicies` | object | ❌ | `{ enabled, names[], generatedAt? }` agent 策略注入结果 |

**响应** `200`：

```json
{
  "workerId": "w_xxx",
  "heartbeatIntervalMs": 10000,
  "serverTime": "2026-09-22T08:00:00.000Z"
}
```

**错误**：`401` token 无效；`400` DTO 校验失败。

---

### 2.2 心跳 `POST /api/v1/workers/:id/heartbeat`

- **鉴权**：`x-worker-token` + 与注册 `tokenHash` 的 bcrypt 二次比对
- **周期**：Worker 侧 10s 一次；Server 侧 30s 无心跳 → 标 `offline`
- **语义**：刷新负载与 `lastHeartbeatAt`；`health=degraded` → 状态 `degraded`（调度降权）；
  `mcpStatus` 写入内存状态；**取出并清空该 worker 的待执行命令队列**；
  离线恢复上线时回放凭据。

**请求体**（`HeartbeatWorkerDto`）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `workerId` | string | ✅ | 与路径 `:id` 一致 |
| `load` | object | ✅ | `{ instances: number }`（异常值钳制到 `maxInstances`） |
| `health` | `'ok' \| 'degraded'` | ✅ | 健康状态 |
| `mcpStatus` | `McpStatusEntry[]` | ❌ | `[{ serverName, status: 'connected'\|'failed'\|'needs_auth' }]` |

**响应** `200`（`HeartbeatResponse`）：

```json
{
  "workerId": "w_xxx",
  "status": "online",
  "lastHeartbeatAt": "2026-09-22T08:00:10.000Z",
  "commands": [
    { "type": "reload-config", "resourceVersion": "2026-09-22T08:00:09.000Z" }
  ]
}
```

`commands` 无命令时不携带。命令结构见 §3。

**错误**：`404 WORKER_NOT_FOUND`（未注册）；`401 TOKEN_INVALID`（token 不匹配）。

---

## 3. 下行命令（心跳响应捎带）

**入队时机**：Server 端资源变更（skills/tools/mcp/策略）、凭据下发、管理员远程重启/下线时
调用 `enqueueCommand(workerId, cmd)` 或 `broadcastCommand(cmd)`（广播给全部非 offline worker）。

**消费语义**：命令一次有效——心跳取出即从队列删除；离线期间入队的命令在恢复心跳时照常下发。

### 3.1 `WorkerCommand` 结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `WorkerCommandType` | 命令类型（见下表） |
| `resourceVersion` | string | 资源版本号（ISO 时间戳或语义串） |
| `payload` | object? | 仅 `model-credentials` / `git-credentials` 携带 |

### 3.2 命令类型（`WORKER_COMMAND_TYPES`）

| type | 触发场景 | Worker 执行动作 | 是否重启 serve |
|------|---------|----------------|----------------|
| `reload-config` | skills / tools / mcp-servers / 执行策略变更 | `ResourceInjector.injectAll()` 重拉注入 | ✅ |
| `model-credentials` | 模型凭据保存、注册回放、凭据吊销 | 写 `auth.json` + 合并 `opencode.json` provider 段 | ✅ |
| `git-credentials` | 仓库凭证保存/吊销 | 幂等写 `~/.keta-git-creds.json`（600 权限） | ❌（git 工具每次执行读文件） |
| `restart` | 管理员 `POST /workers/:id/restart` | `RestartCoordinator` 重启 serve（无活跃会话立即，有则挂起） | ✅ |
| `shutdown` | 管理员 `POST /workers/:id/shutdown` | 优雅退出（停心跳 + flush 事件 + stop serve + exit） | 进程退出 |

### 3.3 `model-credentials` 负载（`ModelCredentialsPayload`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `providerKeys` | `{ providerID, key }[]` | 明文 API key（仅经下行命令传输，不落日志） |
| `providerConfigs` | `Record<string, { baseUrl, models }>`? | `opencode.json` provider 段全量状态；`undefined`=不触碰，`{}`=清空 |
| `targetWorkerIds` | `string[]`? | 定向元数据（空=全量） |

### 3.4 `git-credentials` 负载（`GitCredentialsPayload`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `credentials` | `GitCredentialEntry[]` | `{ repoUrl, authType: 'ssh_key'\|'https_token', key, fingerprint, permission? }` |
| `targetWorkerIds` | `string[]`? | 空=全量；`credentials: []` = 清下发 |

---

## 4. 通道②：事件回流（Worker → Server）

### `POST /api/v1/worker/events`

- **鉴权**：`x-worker-token`（`WorkerTokenGuard`）
- **响应**：恒 `202 Accepted`（无 body）——事件回流尽力而为，单事件失败不影响 worker 重试语义
- **去重**：Server 按 `(workerId, eventId)` 内存去重（at-least-once 边界）
- **重试**：Worker 侧指数退避重试（默认 3 次，500ms/1s/2s），最终失败**丢弃不抛**
- **workerId 校验**：未注册的 `workerId` → `404 WORKER_NOT_FOUND`（防伪造注入）

**请求体**（`WorkerEventDto` / `WorkerEventPayload`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `workerId` | string | `w_` 前缀 |
| `eventId` | string | `evw_<bootId>_<seq>`（bootId 区分进程重启，seq 进程内单调递增） |
| `type` | `WorkerEventType` | 事件类型（见下表） |
| `payload` | object | 语义随 type 变化 |
| `seq` | int | 与 eventId 同步单调递增（≥0） |

### 4.1 事件类型（`WORKER_EVENT_TYPES`）

| type | payload 关键字段 | Server 处理 |
|------|-----------------|-------------|
| `worker.heartbeat` | — | **忽略**（心跳走独立端点 §2.2） |
| `instance.created` | — | 仅日志确认（实例已由 bindSession 落库） |
| `session.updated` | `{ sessionId, status, taskId?, agentId? }` | 更新 Session.status + SSE 广播 |
| `message.part.delta` | 流式增量 | 累积落库 processing 消息 + SSE 广播 |
| `agent.status` | `{ sessionId, status, phase?, error?, taskId?, agentId? }` | emit `agent.loading` / `agent.error` |
| `task.completed` | 任务完成结果 | 落库 + 广播 + emitFinal |
| `git.op` | `{ agent, repo_url, action, exit }` | 审计入 `task_events` |
| `session.question` | `{ sessionId, requestId, questions[], taskId?, agentId? }` | `AgentQuestion` 落库 + 弹窗 |
| `session.permission` | `{ sessionId, permissionId, type, pattern?, title, taskId?, agentId? }` | `AgentQuestion` 落库 + 弹窗 |

> `sessionId` 语义：Worker 上送 opencode 会话 id（`ses_` 前缀），Server 经
> `instanceRef` 反查平台 Session 主键（`s_` 前缀）。

---

## 5. 通道③：资源拉取（Worker → Server）

**触发**：Worker 收到 `reload-config` 命令（或注册后）→ `ResourceInjector.injectAll()`。

**鉴权**：`x-worker-token` + `x-worker-id`（`getJson` 统一注入）。

**分页**：列表接口 `pageSize=100` 循环拉至 `total`（`fetchAll`）。

### 5.1 接口清单

| 资源 | 接口 | 写入 Worker 本地位置 |
|------|------|---------------------|
| 技能列表 | `GET /api/v1/skills?enabled=true&page=&pageSize=` | — |
| 技能正文 | `GET /api/v1/skills/:id/content` → `{ content }` | `<workDir>/.opencode/skills/<name>/SKILL.md` |
| 工具列表 | `GET /api/v1/tools?enabled=true&page=&pageSize=` | `<workDir>/.opencode/tools/<action>.ts`（`execution=mcp` 跳过） |
| MCP 服务器 | `GET /api/v1/mcp-servers?enabled=true&page=&pageSize=` | `<workDir>/opencode.json` 的 `mcp` 节 |
| Agent 策略 | `GET /api/v1/agent-policies` → `{ agents: [...] }` | `<workDir>/opencode.json` 的 `agent` 节 |

**注入规则**：

- 单写者：`opencode.json` 的 `mcp` + `plugin` + `agent` 三节在同一次 read-modify-write 合并
- manifest 比对清理（`.opencode-worker-inject.json`）：上次注入本次停用的条目移除；用户手写条目保留
- `agent-policies` 拉取失败 → 中性化（不阻断 skills/tools/mcp 注入）

---

## 6. 通道④：Server → Worker 执行端点（`execPort`，默认 4198）

独立 `node:http` 监听（与 serve 端口解耦），路径全小写。鉴权：`X-Worker-Token`（写路径）。

| 方法 | 路径 | 鉴权 | 成功码 | 用途 |
|------|------|------|--------|------|
| POST | `/execute` | 无（fire-and-forget） | `202` | **下发执行任务**（方案 A） |
| GET | `/file?path=<abs>` | `X-Worker-Token` | `200` | 拉取工作区文件（二进制安全） |
| POST | `/question-reply` | `X-Worker-Token` | `2xx` | 转发模型 question / 权限确认回复 |
| GET | `/agents?directory=` | `X-Worker-Token` | `200` | 列出 opencode 原生 agent（失败降级 `[]`） |
| GET | `/todos?sessionId=&directory=` | `X-Worker-Token` | `200` | 会话 todo 步骤（降级 `[]`） |
| GET | `/plan-files?directory=` | `X-Worker-Token` | `200` | `.opencode/plans/*.md` 列表（降级 `[]`） |
| POST | `/plan-file` | `X-Worker-Token` | `200` | 写入计划文件（写路径，失败抛错） |
| GET | `/omo-config` | `X-Worker-Token` | `200` | 读 OmO agent→模型配置（降级 `degraded:true`） |
| POST | `/omo-config` | `X-Worker-Token` | `200` | 写 OmO 配置（写路径，失败抛错） |
| GET | `/omo-agent-prompt?name=` | `X-Worker-Token` | `200` | 单 agent 系统提示词全文 |

### 6.1 `POST /execute` 请求体（`ExecuteOptions`）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | `string \| unknown[]` | ✅ | 提示内容（字符串归一为单 text part） |
| `model` | `{ providerID, modelID }` | ❌ | 模型选择 |
| `agent` | string | ❌ | opencode agent 名 |
| `directory` | string | ❌ | 工作目录 |
| `system` | string | ❌ | 顶层 system 提示 |
| `taskId` | string | ❌ | 平台 Task 主键（`t_`），事件回流透传 |
| `agentId` | string | ❌ | Agent id（`a_`），事件回流透传 |
| `channelId` | string | ❌ | 消息来源频道 id |
| `sessionId` | string | ❌ | 复用 serve 会话（`ses_`）；缺省则新建 |
| `executionConfig` | `{ permissions, writePaths }` | ❌ | 执行策略（权限矩阵） |
| `attachments` | `{ url, mime?, filename? }[]` | ❌ | 图片附件引用（Worker 按需下载） |

**URL 解析**：`capabilities.execBaseUrl` → 否则 serve 基址 origin + `capabilities.execPort`（默认 4198）。

**执行流程**：Worker 驱动 serve 执行，事件经通道②回流；Server 不再自持轮询。
首字超时（默认 300s）abort；空闲判死由 `instance-tracker` 负责。

### 6.2 `POST /question-reply` 请求体

模型 question 回复：

```json
{ "sessionId": "ses_...", "requestId": "que_...", "answers": [["选项A"]] }
// 拒绝：
{ "sessionId": "ses_...", "requestId": "que_...", "answers": null, "reject": true }
```

权限确认回复：

```json
{ "sessionId": "ses_...", "permissionId": "per_...", "response": "once|always|reject" }
```

---

## 7. 通道⑤：Server → Worker serve 代理（`capabilities.baseUrl:port`）

opencode serve 原生 REST API 透传（Basic Auth 可选）。由 `WorkerClient.request()` 统一拼装。

| 方法 | 路径 | 用途 | 失败语义 |
|------|------|------|---------|
| GET | `/` | 健康检查（2xx=在线） | 返回 false，不抛 |
| POST | `/session` | 创建会话 → `{ id: "ses_..." }`（拒收 model 字段） | 抛 `WorkerUnavailableException` |
| POST | `/session/:id/prompt_async?directory=` | 下发提示（异步，204/200 即成功） | 抛 |
| POST | `/session/:id/abort` | 中止会话 | 抛 |
| GET | `/session/:id/message` | 拉取消息列表 | 抛 |
| GET | `/api/model` | 动态模型列表（失败降级 `capabilities.models`） | 降级 |
| GET | `/provider` | Provider 全量（Worker 内部 `listModels` 用） | 降级 `/api/model` |
| GET | `/agent` | opencode agent 列表（Worker 内部 `listAgents` 用） | 抛 |

> **注**：`/session`、`/session/:id/*`、`/api/model` 是 **Server 直连 serve** 的路径；
> `/agents`、`/todos`、`/plan-files` 等带目录语义的列表走的是**执行端点④**（路径同名但端口不同）。

---

## 8. 管理端点（用户 JWT，非 Worker 调用）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/v1/workers` | `workers.view` | Worker 列表 |
| GET | `/api/v1/workers/register-token` | `workers.view` | 取注册 token（安装向导生成 curl 用） |
| GET | `/api/v1/workers/:id` | `workers.view` | Worker 详情（含 `mcpStatus`，剔除 `capabilities.models`） |
| PATCH | `/api/v1/workers/:id` | `workers.edit` | 配置/清除默认模型（`{ defaultModelId: string \| null }`） |
| POST | `/api/v1/workers/:id/restart` | `workers.edit` | 远程重启（经心跳命令 `restart` 下发） |
| POST | `/api/v1/workers/:id/shutdown` | `workers.edit` | 远程下线（立即标 offline + 命令 `shutdown`） |
| DELETE | `/api/v1/workers/:id` | `workers.delete` | 删除（仅 offline 可删，否则 409） |

**`POST /:id/restart` 响应**：

```json
{ "workerId": "w_xxx", "command": "restart", "queued": true }
```

**`POST /:id/shutdown` 响应**：

```json
{ "workerId": "w_xxx", "command": "shutdown", "queued": true, "status": "offline" }
```

---

## 9. 错误码

| code | HTTP | 场景 |
|------|------|------|
| `WORKER_NOT_FOUND` | 404 | Worker 未注册 / 不存在 |
| `TOKEN_INVALID` | 401 | 心跳 token 与注册 `tokenHash` 不匹配 |
| `WORKER_ONLINE_NOT_REMOVABLE` | 409 | 删除 online/degraded 状态的 worker |
| `MODEL_NOT_FOUND` | 400 | PATCH 默认模型不存在于目录或已停用 |
| `AUTH_UNAUTHORIZED` | 401 | 管理端点 JWT 无效 |
| （权限码） | 403 | 缺少 `workers.view` / `workers.edit` / `workers.delete` |

---

## 10. 关键时序

### 10.1 Worker 启动注册

```
Worker                              Server
  │  POST /workers/register           │
  │  (capabilities + load + mcpUrl)   │
  ├──────────────────────────────────▶│ upsert worker 行
  │                                   │ sync models 入库
  │                                   │ replay model/git 凭据 → 入队
  │◀──────────────────────────────────┤ { workerId, heartbeatIntervalMs, serverTime }
  │                                   │
  │  GET /skills /tools /mcp-servers  │ （初始注入，或等 reload-config）
  ├──────────────────────────────────▶│
  │◀──────────────────────────────────┤ 资源内容
  │  写 .opencode/ + opencode.json    │
```

### 10.2 资源变更下发

```
Admin/API ──▶ Server 落库 ──▶ broadcastCommand(reload-config)
                                    │
Worker ──POST heartbeat──▶ Server   │
Worker ◀──heartbeat 响应 commands──┘
Worker ──GET /skills /tools ...──▶ Server   （拉内容）
Worker 写本地文件 → 重启 serve 生效
```

### 10.3 任务执行

```
Server ──POST worker:4198 /execute──▶ Worker   （202 立即返回）
Worker 驱动 serve 执行
Worker ──POST /worker/events──▶ Server        （agent.status / message.part.delta / task.completed…）
Server ──SSE──▶ Web 前端
```

---

## 11. 环境变量对照

| Server 侧 | Worker 侧 | 说明 |
|-----------|----------|------|
| `WORKER_TOKEN` | `X_WORKER_TOKEN` | 共享鉴权 token（必须一致） |
| `WORKER_BASE_URL` | — | serve 基址回退（默认 `http://localhost:4199`） |
| `SERVER_PASSWORD` | `OPENCODE_SERVER_PASSWORD` | serve Basic Auth 密码 |
| — | `SERVER_URL` | Server 基址（compose 内 `http://server:3000`） |
| — | `WORKER_ID` / `WORKER_NAME` | Worker 身份 |
| — | `WORKER_EXEC_PORT` | 执行端点端口（默认 4198） |
| — | `WORKER_ADVERTISE_HOST` | 对外公布 serve 基址主机 |
| — | `WORKER_MCP_URL` | 内置 vteam MCP 地址覆盖 |
| — | `WORKER_DEFAULT_MODEL` | 默认模型 id |
| — | `WORKER_MAX_INSTANCES` | 最大并发（默认 5） |
| — | `HEARTBEAT_INTERVAL_MS` | 心跳间隔（默认 10000） |
| — | `WORKER_FIRST_TOKEN_TIMEOUT_MS` | 首字超时（默认 300000） |
