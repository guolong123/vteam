# Worker 接口文档

worker（opencode 执行节点）对外/对控制面的**全部 HTTP 接口**速查。按「谁调用谁」组织，并标注 SDK 对应封装。

权威协议（同一份内容，两种位置）：`protocol/34-Worker交互接口协议.md`（发布包内）／
`docs/agent-platform/34-Worker交互接口协议.md`（仓库内）。

```
            A. 执行端点（:4198）                 B. 控制面契约
外部/SDK ──────────────────────▶ worker ──────────────────────▶ 控制面(server / SDK EventsServer)
          POST /execute 等                   注册 / 心跳 / 事件回流 / 资源拉取
```

| 组 | 方向 | 端口 | 启动模式 | SDK 封装 |
|----|------|------|----------|----------|
| **A. 执行端点** | 外部/SDK → worker | `WORKER_EXEC_PORT`（默认 4198） | 两种模式都有 | `WorkerClient`（经 `WorkerDirect.client`） |
| **A′. 本地配置下推** | 外部 → worker | 同上 | **仅独立模式** | ❌ 暂未封装（用 curl） |
| **B. 控制面契约** | worker → 控制面 | 控制面端口（如 13999） | **仅注册模式** | `EventsServer` 已实现全部端点 |

---

## 1. 鉴权

- header：`X-Worker-Token: <WORKER_TOKEN>`
- 三方必须一致：worker `X_WORKER_TOKEN` = SDK `WorkerClient(token=...)` = 控制面 token
- **唯一例外**：`POST /execute` 无鉴权（协议 fire-and-forget）；其余端点缺/错 token → `401`

---

## 2. A. 执行端点（默认 `4198`）

独立 `node:http` 服务，路径全小写。**注册模式与独立模式都提供**。

| 方法 | 路径 | 鉴权 | 成功码 | 用途 |
|------|------|------|--------|------|
| POST | `/execute` | 无 | `202` | 下发执行任务（fire-and-forget） |
| GET | `/file?path=<绝对路径>` | ✅ | `200` | 读取文件（二进制安全，返回原始内容） |
| POST | `/question-reply` | ✅ | `200` | 回复模型 question / 权限确认 |
| GET | `/agents?directory=` | ✅ | `200` | 列出 opencode agent（失败降级 `[]`） |
| GET | `/todos?sessionId=&directory=` | ✅ | `200` | 会话 todo 步骤（失败降级 `[]`） |
| GET | `/plan-files?directory=` | ✅ | `200` | 计划文件列表（失败降级 `[]`） |
| POST | `/plan-file` | ✅ | `200` | 写入计划文件（`*.md`，防路径穿越） |
| GET | `/omo-config` | ✅ | `200` | 读 OmO 配置（agent→模型 / 开关） |
| POST | `/omo-config` | ✅ | `200` | 写 OmO 配置（**会触发 serve 重启**） |
| GET | `/omo-agent-prompt?name=` | ✅ | `200` | 单个 agent 的系统提示词全文 |

`directory` 缺省时回落到 `WORK_DIR`（serve cwd），保证列出的集合与实际执行一致。

### 2.1 `POST /execute`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | `string \| unknown[]` | ✅ | 提示内容（字符串归一为单 text part） |
| `model` | `{providerID, modelID}` | ❌ | 模型选择；缺省用 serve 默认 |
| `agent` | string | ❌ | opencode agent 名 |
| `directory` | string | ❌ | 工作目录（worker 确保存在） |
| `system` | string | ❌ | 顶层 system 提示 |
| `taskId` / `agentId` / `channelId` | string | ❌ | 业务透传（事件回流原样带回） |
| `sessionId` | string | ❌ | 复用 serve 会话（`ses_`）；缺省新建 |
| `executionConfig` | `{permissions, writePaths}` | ❌ | 权限矩阵与可写路径 |
| `attachments` | `{url, mime?, filename?}[]` | ❌ | 图片附件引用（worker 按需下载） |

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"prompt":"ping","taskId":"t-1","directory":"/data/t-1"}' \
  http://<worker>:4198/execute
# → 202 {"accepted":true}
```

⚠️ 结果**不经响应返回**：只回 202，结果走 B 组的事件回流（`task.completed`）。
独立模式无控制面 → 拿不到结果，只能提交/查询。

### 2.2 读写示例

```bash
# 读文件
curl -H 'X-Worker-Token: <token>' \
  'http://<worker>:4198/file?path=/data/t-1/.omo/plans/demo-plan.md'

# 写计划文件
curl -X POST -H 'X-Worker-Token: <token>' -H 'Content-Type: application/json' \
  -d '{"name":"demo-plan.md","content":"# Plan\n","directory":"/data/t-1"}' \
  http://<worker>:4198/plan-file
# → {"name":"demo-plan.md","updatedAt":"..."}
```

---

## 3. A′. 本地配置下推（`/config/*`，仅独立模式）

**仅 `WORKER_STANDALONE=true` 挂载**；注册模式访问 → `404` + 引导（配置一律走 B 组，避免双事实源）。

- **语义：声明式替换**——每类资源本次请求即完整集合（传空数组 = 清空该类受管项）
- **不自动重启**：响应 `restart: "required"`（需再调 `/config/restart`）或 `"not-required"`（git 凭据写盘即生效）

| 方法 | 路径 | 请求体 | 落点 |
|------|------|--------|------|
| POST | `/config/skills` | `{skills:[{name,content}]}` | `<WORK_DIR>/.opencode/skills/<name>/SKILL.md` |
| POST | `/config/tools` | `{tools:[{action,execution,name?,schema?}]}` | `<WORK_DIR>/.opencode/tools/<action>.ts` |
| POST | `/config/mcp-servers` | `{mcpServers:[{name,type,url?\|command?}]}` | `<WORK_DIR>/opencode.json` 的 `mcp` 节 |
| POST | `/config/agent-policies` | `{agents:[{name,description,mode,permission}]}` | `<WORK_DIR>/opencode.json` 的 `agent` 节 |
| POST | `/config/model-credentials` | `{providerKeys:[{providerID,key}],providerConfigs?}` | `$HOME/.local/share/opencode/auth.json` + `$HOME/.config/opencode/opencode.json` provider 段 |
| POST | `/config/git-credentials` | `{credentials:[{repoUrl,key,authType?,fingerprint?,permission?}]}` | `$HOME/.keta-git-creds.json`（600） |
| POST | `/config/restart` | 无 | 触发 serve 重启（复用 RestartCoordinator） |

响应示例：`{"written":{"skills":["my-skill"]},"restart":"required"}`

校验（非法 → `400`）：技能名仅字母数字开头（`[A-Za-z0-9][A-Za-z0-9_.-]*`，防路径穿越）；工具需
`execution` + schema `x-execution`；agent 需 `description`、`mode ∈ {primary, all}`、`permission` 禁 `write` 键；
mcp `type ∈ {local, remote}`。

`POST /config/restart` 响应：`{"restart":"executed"}`（无活跃会话，已重启）/ `"pending"`（有活跃会话，挂起等归零，不打断任务）。

```bash
W=http://<worker>:4198; T='X-Worker-Token: <token>'; J='Content-Type: application/json'
curl -X POST -H "$T" -H "$J" -d '{"skills":[{"name":"my-skill","content":"# My Skill\n"}]}' $W/config/skills
curl -X POST -H "$T" $W/config/restart
# 查询：读回 SKILL.md / 受管清单
curl -H "$T" "$W/file?path=/data/vteam-worker/.opencode/skills/my-skill/SKILL.md"
curl -H "$T" "$W/file?path=/data/vteam-worker/.opencode-worker-inject.json"
```

> 受管清单（`.opencode-worker-inject.json`）记录 `skills/tools/mcpServers/agentNames` —— 一眼确认已下推了什么。
> ⚠️ 这些端点写明文凭据，必须 token 鉴权；执行端点绑 `0.0.0.0`，请网络隔离或仅内网可达。

---

## 4. B. 控制面契约（仅注册模式；SDK `EventsServer` 已实现）

独立模式（`WORKER_STANDALONE=true`）跳过以下全部。

### 4.1 通道① 注册 / 心跳

| 方法 | 路径 | 请求体要点 | 响应 |
|------|------|-----------|------|
| POST | `/api/v1/workers/register` | `{workerId, name, opencodeVersion, capabilities, load, defaultModelId?, mcpUrl?}` | `{workerId, heartbeatIntervalMs, serverTime}` |
| POST | `/api/v1/workers/:id/heartbeat` | `{workerId, load, health, mcpStatus?}` | `{workerId, status, lastHeartbeatAt, commands?}` |

`capabilities` 关键字段：`port` / `baseUrl` / `execPort` / `maxInstances` / `skills` / `tools` / `models` /
`executableModels` / `agentPolicies`。注册失败按 1s/2s/4s…封顶 30s 重试，耗尽则 worker 退出（独立模式无此步）。

### 4.2 下行命令（心跳响应 `commands[]` 捎带）

| `type` | 载荷 | worker 行为 |
|--------|------|-------------|
| `reload-config` | — | 重拉全部资源并重注入；无活跃会话时重启 serve |
| `model-credentials` | `{providerKeys:[{providerID,key}], providerConfigs?:{pid:{baseUrl,models}}}` | 写 `auth.json` + `opencode.json` provider 段 → 重启 serve |
| `git-credentials` | `{credentials:[{repoUrl,authType,key,fingerprint,permission?}]}` | 写 `.keta-git-creds.json`（不重启） |
| `restart` / `shutdown` | — | 重启 serve / 优雅退出 |

### 4.3 通道② 事件回流

| 方法 | 路径 | 请求体 | 响应 |
|------|------|--------|------|
| POST | `/api/v1/worker/events` | `{workerId, eventId, type, payload, seq}` | `202`（空） |

事件类型含 `task.completed`、`session.updated`、`message.part.delta`、`session.question` 等；
`eventId = evw_<bootId>_<seq>`（bootId 区分重启，server 按 `(workerId, eventId)` 去重）。

### 4.4 通道③ 资源拉取（worker → 控制面 GET）

| 路径 | 说明 |
|------|------|
| `GET /api/v1/skills?enabled=true` | 技能列表，分页 `{items,total,page,pageSize}` |
| `GET /api/v1/skills/:id/content` | SKILL.md 全文 `{content}` |
| `GET /api/v1/tools?enabled=true` | 自定义工具列表 |
| `GET /api/v1/mcp-servers?enabled=true` | MCP 服务器列表 |
| `GET /api/v1/agent-policies` | agent 策略 `{agents:[...]}` |

worker 在启动与 `reload-config` 时拉取；SDK 侧用 `WorkerService.set_resources(...)` 提供实现。

---

## 5. 启动模式差异

| 接口组 | 注册模式 | 独立模式（`WORKER_STANDALONE=true`） |
|--------|----------|-------------------------------------|
| A 执行端点（含 `/execute`、`/file`、`/omo-*`） | ✅ | ✅ |
| A′ `/config/*` 本地配置下推 | ❌ `404` + 引导 | ✅ |
| B 注册 / 心跳 / 事件回流 / 资源拉取 | ✅ | ❌ 全部跳过 |

独立模式跳过控制面资源注入/注册/心跳，因此**没有**反向通道可接收配置——配置改由 A′ 主动下推。

---

## 6. 环境变量（常用）

| 变量 | 默认 | 说明 |
|------|------|------|
| `X_WORKER_TOKEN` | 必填 | 共享 token（A/A′/B 全部鉴权） |
| `SERVER_URL` | `http://localhost:3000` | 控制面基址（独立模式忽略） |
| `WORKER_STANDALONE` | `false` | `true` = 独立模式（跳过注册/心跳/资源拉取，挂载 `/config/*`） |
| `WORKER_EXEC_PORT` | `4198` | 执行端点端口 |
| `OPENCODE_SERVE_PORT` / `_HOSTNAME` | `0`（随机）/ `127.0.0.1` | serve 端口与绑定（容器/跨机需 `0.0.0.0`） |
| `WORKER_ADVERTISE_HOST` | 自动探测内网 IP | 上报给控制面的 serve 基址 |
| `WORK_DIR` | `/data/vteam-worker` | serve cwd + 资源注入落点 |
| `WORKER_MAX_INSTANCES` | `5` | 并发会话上限 |
| `WORKER_FIRST_TOKEN_TIMEOUT_MS` | `300000` | 首字超时 |

---

## 7. 状态码约定

| 码 | 场景 |
|----|------|
| `202` | `/execute`、`/worker/events` 受理（fire-and-forget） |
| `200` | 查询/写入成功 |
| `400` | 请求体非法 / 校验失败（`/config/*` 附明确原因） |
| `401` | `X-Worker-Token` 缺失或不匹配 |
| `404` | 路径/文件不存在；`/config/*` 在注册模式下 |
| `405` | 方法不支持 |
| `413` | 请求体超限（默认 1MB） |
| `502` | worker 侧下游失败（serve 异常等） |

---

## 8. 与 SDK 的对应关系

| 接口 | SDK |
|------|-----|
| A 组全部 | `WorkerClient`（`execute` / `get_file` / `question_reply` / `list_agents` / `list_todos` / `list_plan_files` / `write_plan_file` / `get_omo_config` / `set_omo_config` / `get_omo_agent_prompt`） |
| A 组（无控制面） | `WorkerDirect`（`health` / `execute` + 经 `.client` 透传） |
| B 组 | `EventsServer`（register/heartbeat/events/资源端点） + `WorkerService` 的 `set_resources` / `reload_config` / `push_model_credentials` / `push_git_credentials` / `restart` / `shutdown` |
| A′ 组 | **暂未封装**，直接用 curl（或参照本文件自行封装） |
