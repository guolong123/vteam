<!-- 详细设计：在 req-4.13 之上细化到数据库表结构与实现设计，可直接指导编码 -->

# 4.13 任务级 Agent 对话（Agent Chat）— 详细设计

## 1. 模块范围

本模块在 4.7 运行时集成之上提供任务级交互能力：用户与 agent 的**注入式多轮对话**（FR-1011/1012）、**WaitingForUserInput 挂起恢复**（FR-1013）、**动作协议驱动推进**（FR-1014）、**任务级产物库**（FR-1015）、**已完成 agent 持续对话**（FR-1016）与对话 guardrail（FR-1017）。

实现上聊天消息走独立表 `task_chat_messages`（高频、需幂等注入队列），产物复用 `artifacts` 表（只加 `node_id` 列，ADR-005/016 存储模型），文件产物落 `ARTIFACT_STORE_DIR` 磁盘（DB 只存 ref）。需求基线 req-4.13（FR-1011~1017）。本文档给出表结构 DDL、WaitingForUserInput 状态机、API 契约、executor 注入与动作解析、产物存储与远端收集、SSE 代理的实现设计。

## 2. 数据库结构设计

### 2.1 表清单

| 表名 | 用途 | 类型 |
|---|---|---|
| `task_chat_messages` | 用户-Agent 聊天消息（流式注入队列 + 历史持久化） | 新表 |
| `artifacts` | 任务级产物库（agent 自动发布，`node_id` 关联产出节点） | 现有表 + 1 列 |
| （文件系统）`ARTIFACT_STORE_DIR` | file 产物二进制/大文件存储（DB 只存 ref） | 磁盘目录 |

### 2.2 表结构

**`task_chat_messages`**（`src/store/schema.ts`，migration `drizzle/0008_lonely_patch.sql`）：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK default random | |
| task_id | uuid | not null, FK → tasks.id | 关联任务 |
| node_id | text | not null | 产出节点（agent 对话节点） |
| role | text | not null | user / assistant / system |
| content | text | not null | 消息内容（纯文本） |
| is_pending | boolean | not null default true | 待注入队列标记（SSE 流式已消费 → false） |
| idempotency_key | text | unique（可空多 NULL 不冲突） | 幂等键（流式重连/重试去重） |
| created_at | timestamptz | not null default now() | |

索引：`(task_id, created_at)`（历史按任务拉取）、`(task_id, is_pending)`（待注入队列扫描）。

**`artifacts`**（现有表增量，仅加 1 列 + 1 索引）：

| 字段 | 变更 | 说明 |
|---|---|---|
| node_id | **新增**（text，可空） | 产出节点（agent 对话节点；手工归档产物无节点） |
| — | 索引 `(task_id, node_id)` | 按任务 + 产出节点查产物 |

其余列不变（id/namespace/name/type/task_id/content/schema_ref/issue_ref/pr_ref/version/created_by/created_at/updated_at；唯一约束 `(namespace, name, version)`）。

### 2.3 产物存储格式（ADR-016 refine）

`artifacts.content` jsonb 结构 `ArtifactContent = { format, body?, ref? }`：

| format | body | ref | 说明 |
|---|---|---|---|
| `markdown` | string（必填） | — | 文档/结论类，内联文本 |
| `json` | object（必填） | — | 结构化数据，内联对象 |
| `file` | — | string（必填） | **归档相对路径**（`{ARTIFACT_STORE_DIR}/{namespace}/{taskId}/{name}-v{version}.{ext}`），文件不落 DB |

type 枚举（ARTIFACT_TYPE）：`requirement/design/testcase/testreport/code/diagram`。agent 文本发布缺省 `design`（`publishAgentArtifact`），文件发布固定 `code`（`collectFileViaOpencode`）。

### 2.4 文件存储目录配置

- 环境变量 `ARTIFACT_STORE_DIR`（缺省 `/data/orchestra-artifacts`；`artifactStoreDir()`，mkdir -p 幂等）。
- 目录结构：`{ARTIFACT_STORE_DIR}/{namespace}/{taskId}/{name}-v{version}.{ext}`。
- 写入方式：tmp + rename **原子写**（失败清理 tmp），路径 join 带 POSIX 规范（`path.posix.join`）。

## 3. 状态机：WaitingForUserInput（FR-1013）

### 3.1 转移表（dld-4.5 §3.5 唯一事实源增量，`src/controllers/task.ts` TRANSITIONS）

```ts
Pending:  ['Running', 'Paused', 'Cancelled', 'Expired'],
Running:  ['Pending', 'Paused', 'WaitingApproval', 'WaitingForUserInput', 'Succeeded', 'Failed', 'Cancelled'],
WaitingForUserInput: ['Pending', 'Cancelled', 'Expired'],
// 终态：Succeeded/Failed/Cancelled/Expired（TERMINAL_TASK_PHASES，无出边）
```

### 3.2 挂起（suspendForUserInput，executor）

`【需要用户输入】` 动作 → `suspendForUserInput(ctx, question)`：

1. 问题文本写 chat 表：`role=assistant, node_id=当前节点`（前端可见）。
2. resume_context 快照：复用审批式 `buildResumeContext`（恢复锚点 = 当前 agent 节点 + sessionId/workdir）。
3. CAS 转移 `Running → WaitingForUserInput`，patch：`currentNode=node.id, outputs=state.outputs, workerId=null, workerLeaseExpiresAt=null`——**释放租约**（并发已改如 Cancelled → ConflictError 幂等忽略，仍按挂起语义退出）。
4. 写 trace：`chat.suspend`（step ok，含 question 前 300 字符 + resumeContext）。

### 3.3 恢复（resumeFromUserInput，`src/approver/resume.ts`）

```ts
export async function resumeFromUserInput(deps, taskId): Promise<boolean> {
  const task = await getTaskById(deps.db, taskId);
  if (task.phase !== 'WaitingForUserInput') return false;   // 幂等忽略（并发已改/终态）
  await requeueTask(deps, task, {}, ['WaitingForUserInput']); // Pending + 重新入队（带 phase 条件）
  return true;
}
```

- 调用点：`POST /messages` handler 在 `task.phase === 'WaitingForUserInput'` 时于写入后调用。
- **恢复续聊**（executor T10）：任务复用已有 sessionId 且本节点已挂起 ask 过（`countChatMessagesByRole(assistant)>0`）→ 首轮只注入 pending 用户消息（`buildUserTurnPrompt`），**不重发完整任务 prompt**；无 pending 用户消息 → 回退完整 prompt 正常执行。
- **不重跑**：恢复全程不推进节点、不重发任务输入；恢复锚点 = currentNode + sessionId/workdir。

## 4. API 契约

### 4.1 端点总览

| 方法 | 路径 | 认证/授权 | 说明 |
|---|---|---|---|
| POST | `/api/v1/tasks/{name}/messages` | Bearer + `exec task/*`（写关 system 回退） | 发送用户消息（FR-1011） |
| GET | `/api/v1/tasks/{name}/messages` | Bearer + `read task/*`（system 回退开） | 消息历史（created_at ASC，不消费 pending） |
| GET | `/api/v1/tasks/{name}/messages/stream` | Bearer + `read task/*`（system 回退开） | SSE 流式代理（FR-1012） |
| GET | `/api/v1/tasks/{name}/artifacts?nodeId=` | Bearer + `read task/*` | 任务关联产物（按节点过滤） |
| GET | `/api/v1/artifacts/{namespace}/{name}/download?version=` | Bearer + `read artifact/{namespace}` | file 产物下载（仅 file 类型） |

### 4.2 POST/GET /messages

- **MESSAGE_BODY**（zod）：`{ content: string(1..2000), nodeId?: string(1..255), idempotencyKey?: string(1..255) }`；`nodeId` 缺省 `'user-input'`。
- **响应**（MESSAGE_RESPONSE）：`{ id, taskId, nodeId, role, content, isPending, idempotencyKey, createdAt }`，201（幂等命中同样 201）。
- **错误**：404 任务不存在；**409 WaitingApproval 拒绝**（审批独立通道）；400 轮数超限/校验失败。
- **状态语义**（写前校验，见 req-4.13 §1.1）：Running/WaitingForUserInput 注入；Pending/Paused 排队；终态 forArtifact 写入 + 触发 `runTerminalChat`（`nodeId !== 'user-input'` 才触发）；WaitingApproval 409。
- **终态轮数预检**：`assertChatTurnLimit`（POST 写入前）——超限 400 拒绝、消息不落库。
- 审计 `chat` action，**不记 content 明文**。

### 4.3 GET /artifacts?nodeId

响应：`{ taskId, namespace, name, items: ArtifactView[] }`；`?nodeId=` 过滤（空则全量）。ArtifactView 含 `id/namespace/name/type/taskId/nodeId/content/schemaRef/issueRef/prRef/version/createdBy/createdAt/updatedAt`。

### 4.4 GET /messages/stream（SSE 事件映射）

**订阅**：`client.event.subscribe({}, { query: { directory: task.workdir, sessionID: task.sessionId }, signal })`（SDK 参数表无 sessionID → 经 options.query 透传）。任务无 sessionId/workdir → 400（`ValidationError`）。**必须带 directory**（仅 sessionID 收不到事件，PoC 验证）。

**首行握手**：`data: {"type":"connected"}`。

**事件映射**（`mapSseEvent` + `mapPartEvent`，复用 `executor/events/parser.ts normalizeEvent`）：

| opencode 事件 | 前端 SSE 事件 | 载荷 |
|---|---|---|
| —（握手） | `connected` | `{}` |
| message.part.updated / delta（part.type=text） | `text` | `{text, delta?}` |
| message.part.updated（part.type=reasoning） | `reasoning` | `{text}` |
| message.part.updated（part.type=tool） | `tool` | `{tool, state, callID}` |
| message.part.updated（part.type=file） | `file` | `{filename, url}`（只转 filename/url，不泄漏绝对路径） |
| message.part.updated（part.type=subtask/agent） | `delegation` | `{agent}` |
| message.part.updated（part.type=step-start/finish） | `step` | `{state: 'start'\|'finish'}` |
| message.updated（info.finish='error'） | `error` | `{message}` |
| message.updated | `message` | `{role}` |
| session.idle | `idle` | `{}` |
| message.error / session.error | `error` | `{message}` |
| permission.asked / updated / replied | **不转发**（null） | 审批走 ToolApproval 独立通道 |
| snapshot/patch/retry/compaction / server.* 连接事件 | **不转发**（null） | 前端无需 |

**生命周期**：`stream.onAbort → controller.abort()`（客户端断开即释放底层订阅）；流自然结束也 abort；订阅失败/转发异常 → `error` 事件（不抛裸异常）。

### 4.5 download 端点（安全）

`resolveArtifactFilePath`：ref 必须相对路径（拒绝 `startsWith('/')` 与 Windows 盘符）、无 `..` 段、join `ARTIFACT_STORE_DIR` 后前缀校验（逃逸根目录 → 400）。仅 `format='file'` 可下载（markdown/json → 400）；磁盘文件缺失 → 404；响应 `Content-Disposition: attachment` + `application/octet-stream` 流。

## 5. executor 实现

### 5.1 模块目录结构

| 文件 | 职责 |
|---|---|
| `src/store/task-chat.ts` | task_chat_messages 读写 + CAS claim（插入/历史/轮数计数/pending 队列） |
| `src/executor/actions.ts` | 动作协议解析（纯函数，零依赖） |
| `src/executor/chat-guard.ts` | guardrail（轮数/长度/token 策略） |
| `src/executor/artifact-publish.ts` | 产物发布/摘要/远端文件收集 |
| `src/executor/index.ts` | 消息感知注入 + 动作处理 + runTerminalChat + buildPrompt |
| `src/approver/resume.ts` | resumeFromUserInput（WaitingForUserInput 恢复） |
| `src/api/routes/tasks.ts` / `messages-stream.ts` | REST + SSE 端点 |

### 5.2 输出协议（buildPrompt，chatEnabled 注入）

```text
--- 输出协议 ---
你是可与用户多轮沟通的 Agent。回合结束前按下述协议输出动作标记（可附在正常输出之后，格式须严格一致）：
1. 简单任务已完成：输出【任务完成】标记。
2. 需要用户澄清或补充信息：输出【需要用户输入】<问题描述> 并结束当前回合，等待用户回复。
3. 需要人工审批：输出 JSON 动作块 {"action":"request_approval","approvers":{...},"reason":"..."}。
4. 需要产出资源：输出 JSON 动作块 {"action":"publish_artifact","name":"...","type":"text","content":"..."}
   （文件类：{"action":"publish_artifact","name":"...","type":"file","fileRef":"<worktree 内相对路径>"}）。
```

同时注入"任务产出资源"清单（`- {name} ({type}, v{version}): {summary}`，≤300 字符/资源，`buildArtifactSummary`）。**只注入摘要，不注入完整会话**（MUST NOT）。

### 5.3 动作协议解析（actions.ts，T9）

- **标记常量**：`COMPLETE_MARKER = '【任务完成】'`、`ASK_MARKER = '【需要用户输入】'`。
- **提取**：正则 `"action"\s*:\s*"(publish_artifact|request_approval)"` 定位 JSON 块 → 大括号配对扫描（跳过字符串与转义）→ JSON.parse 校验（失败忽略）；标记检测在**剔除 JSON 块后**进行（防 JSON 数据内字样误判）。
- **终态互斥**：`request_approval > 【任务完成】 > 【需要用户输入】`；publish 恒全量返回。
- **publish 校验**：name 必填、type 仅 text/file；text → content、file → fileRef。
- **输出**：`AgentAction = {type:'complete'} | {type:'ask', question} | {type:'publish', artifact} | {type:'approval', approvers, reason?}`；无动作 → `[]`（调用方按完成处理）。

### 5.4 消息感知注入（runSessionAndWaitIdle，T8）

`runSessionAndWaitIdle` 循环中：**当前回合 idle 后**（`session.idle` 事件）且 `chatEnabled`：

1. `claimPendingMessages(db, taskId)`：CAS 条件 UPDATE（`WHERE task_id=? AND is_pending=true`）置 false 并 RETURNING——并发恰好一个 claim 拿到；claim 之后到达的消息保持 pending，**不自动注入下游节点**。
2. 过滤 `role='user'` 按 createdAt 排序；无 user 消息 → 原单轮行为（break，零变化）。
3. **轮数检查点**（消费后断言，T13）：`assertChatTurnLimit` 超限 → 写 `chat.turn-limit` trace（含 turns/max/rejected）→ **break（拒绝注入、正常推进节点）**——绝不让任务因对话超限而失败/复活。
4. `buildUserTurnPrompt(userMsgs)` 构造注入 prompt → `markMessagesDelivered`（幂等确认投递）→ 写 `chat.inject` trace → 继续订阅等待新回合（注入回合与主回合共用同一 SSE 窗口 token 管道）。

### 5.5 动作处理（handleAgentActions / publishAgentArtifact，T9）

| 动作 | 处理 |
|---|---|
| publish | `publishAgentArtifact`：file → `collectFileViaOpencode`（见 §6.2）；text → `publishArtifactFromAgent`（content 可 JSON.parse → `{format:'json', body}`，否则 `{format:'markdown', body}`；type 缺省 `design`） |
| ask | `suspendForUserInput`（§3.2）→ 返回 'ask' |
| approval | `suspendForApproval`：`createTaskApproval`（approvers 经 `normalizeApprovers`，缺省 `{mode:'role', value:'approver'}`）+ CAS `Running → WaitingApproval`（patch `blockedOn:{approvalRef:node.id}` + 释放租约） |

### 5.6 已完成 agent 持续对话（runTerminalChat，T13）

```ts
export interface TerminalChatResult { injected: number; published: number; actions: AgentAction[] }
```

前置校验：终态 phase（TERMINAL_TASK_PHASES）+ `task.outputs[nodeId]` 已执行 + flow 可解析 + 节点为 agent 且 `agentSpec.chatEnabled === true` + sessionId 可用。任一不满足 → ValidationError（端点层 catch 静默跳过）。

执行流：
1. `claimPendingMessages(db, taskId, nodeId)`（**按 node_id 路由**，跨节点不串注入）→ 无 user 消息 → 幂等空结果。
2. `assertChatTurnLimit`（消费后断言，executor 侧防御）。
3. `buildTerminalChatPrompt`：buildPrompt 基础（输出协议 + 全局资源摘要）+ 终态说明（`任务已结束（phase=...），本次对话仅更新节点产出，不重新执行任务`）+ 本节点资源清单 + 用户消息。
4. 复用 `runSessionAndWaitIdle` 跑单回合 → 动作处理：publish → `publishAgentArtifact`（version++，历史保留）；complete/ask → 仅写 trace（`chat.terminal`，note=终态对话不推进节点）。
5. **绝不调用 step/transition/persistNodeProgress**——phase 与 outputs 零变化，任务不复活。

## 6. 产物存储与远端收集

### 6.1 文本/JSON 产物发布（publishArtifactFromAgent）

- type 限定 `ARTIFACT_TYPE`（非法 → ValidationError）；content 经 `validateArtifactContent` 校验（缺省 schemaRef）。
- 版本 = `nextArtifactVersion`（`(namespace, name)` 共享序列）；写入含 `taskId + nodeId`（与手工归档 `archiveArtifact` 的差异）。

### 6.2 文件产物远端收集（collectFileViaOpencode）

agent 文件产物经 opencode File API（`client.file.read({ query: { path } })`，`GET /file/content`）从**远端执行节点**读取字节归档——不依赖本地共享挂载：

1. **fileRef 安全校验**（硬性边界）：相对路径（拒绝 `/` 开头与盘符）、无 `..` 段、`resolve` 在 workdir 内（前缀检查）、symlink 不逃逸（`realpath` 复核，本地文件不存在 → 跳过交由远端读决定）→ 否则 ValidationError。
2. 远端读（兼容 SDK fields 包装 `{data:{content}}` 与裸 `{type, content}`）；非文本 → null → ValidationError。
3. size ≤ `ARTIFACT_FILE_MAX_BYTES`（50MB）；超限拒绝。
4. 写 `{ARTIFACT_STORE_DIR}/{namespace}/{taskId}/{name}-v{version}.{ext}`（tmp+rename 原子写）。
5. `content = { format:'file', ref: 相对存储根路径 }` → `publishArtifactFromAgent`（type 固定 `code`）。

**失败语义**：worktree 不存在 / 远端读失败 / 超限 → ValidationError（提示改用文本产物）。终态续聊 worktree 已删 → file 发布拒绝。

## 7. guardrail（chat-guard.ts，FR-1017）

| 项 | 配置/常量 | 检查点 |
|---|---|---|
| 轮数上限 | `CHAT_MAX_TURNS`（env，缺省 5） | POST 写前（终态）+ executor 注入时（消费后断言）；计数 = 已消费（is_pending=false）user 消息数 |
| 消息长度 | `MAX_MESSAGE_LENGTH = 2000` | 端点 zod + `assertMessageLength`（复用层） |
| token 成本 | 注入回合与主回合共用 executor SSE 窗口 token 管道 | `aggregateTokens → trace 表 → 终态 aggregateCost 物化 cost_daily`（无新增统计系统） |
| 注入幂等 | `claimPendingMessages`（CAS）+ `markMessagesDelivered`（幂等） | 流式重连/重试去重（idempotency_key unique 兜底） |

## 8. 安全要点

- **消息审计脱敏**：audit_logs 不落消息明文。
- **SSE 不泄漏路径**：file 只转 filename/url；workdir 绝对路径不出现。
- **permission 不混流**：permission.asked/updated/replied 不转发（ToolApproval 独立通道），聊天无审批侧信道。
- **路径校验双向**：发布侧（fileRef 进 worktree）与下载侧（ref 进存储根目录）对称拒绝绝对路径/`..`/逃逸。
- **fail-closed 授权**：全部端点挂 authMiddleware + dynamicAuthorize；messages 写用 `exec task/*`（无 system 回退），读与 stream 开 system 回退（platform-admin 托管已完成任务）。

## 9. 验证清单

- [x] vitest：task-chat store（insert/claim CAS/幂等）、actions 解析（四动作 + 互斥）、chat-guard（轮数/长度）、artifact-publish（路径校验/symlink/50MB）、状态机全链路（CAS + 租约释放 + 恢复）
- [x] messages.test.ts：端点状态码 + 幂等 + WaitingApproval 409 + 终态触发
- [x] messages-stream.test.ts：SSE 事件映射（含不转发类型）
- [x] chat-e2e.test.ts：16 场景（注入/挂起/恢复/终态对话）
- [x] `npm run build && npm run lint`（web）+ `tsc -b`（prototype-viewer）EXIT 0
- [ ] （部署后）浏览器实测：SSE 首行 connected + delta 打字机 + 资源列表下载
