# 平台 MCP Server 实施计划（可执行）

> 依据：`.omo/plans/platform-mcp-server-design.md`（v2，已评审确认）
> 决策：①按需注入（移除自动注入，系统提示词说明，模型自行决定）②用已有库 `@modelcontextprotocol/sdk`
> 关联：docs 12/10/19 篇；完成后设计文档落位 docs/agent-platform/21-平台MCP-Server设计方案.md

---

## 执行顺序总览

| # | 阶段 | 验收 |
|---|------|------|
| 1 | server 平台 MCP 端点（SDK + 4 工具 + 归属校验） | 单测通过 + curl 调 MCP 端点返回工具列表 |
| 2 | seed keta-platform MCP 记录 + worker 注入验证 | `opencode mcp list` 显示 keta-platform connected |
| 3 | 移除自动注入 + 提示词改写（任务 ID/MCP 工具引导） | 单测断言 prompt 不再含 doclib/群聊历史块 |
| 4 | 端到端实测（需模型凭据） | 群聊 @ → agent 自主调工具 → group_post 结论 |
| 5 | 设计文档落位 docs/agent-platform/21- | 文件存在 |

---

## TODOs

- [x] 1. 阶段 1：server 平台 MCP 端点（`@modelcontextprotocol/sdk` + 4 工具 + 归属校验 + 单测）
- [x] 2. 阶段 2：seed keta-platform MCP 记录 + worker 注入验证（`opencode mcp list` connected）
- [x] 3. 阶段 3：移除自动注入 + 提示词改写（任务 ID/MCP 工具引导，prompt 不再含 doclib/群聊历史块）
- [~] 4. 阶段 4：端到端实测（群聊 @ → agent 自主调工具 → group_post 结论；需模型凭据）
- [x] 5. 阶段 5：设计文档落位 docs/agent-platform/21-平台MCP-Server设计方案.md

## Final Verification Wave

- [x] F1. 评审：platform-mcp 模块实现与设计一致（4 工具/归属校验/SDK 接入），单测覆盖正常+403 路径
- [x] F2. 评审：自动注入移除正确（dispatch prompt 不含 doclib/群聊历史，提示词含任务 ID 与工具引导）
- [x] F3. 评审：MCP 注入链路验证（seed 记录 → opencode mcp list connected；env 引用或回退注入器特判）
- [x] F4. 评审：端到端行为（模型可自主调工具回上下文、group_post 发群聊；无凭据时记录阻塞并给出前置条件）

---

## 阶段 1：server 平台 MCP 端点

### 1.1 依赖
`server/package.json` 新增 `@modelcontextprotocol/sdk`（npm install @modelcontextprotocol/sdk，版本取最新稳定；评审记录版本）。

### 1.2 新模块 `server/src/platform-mcp/`

**`platform-mcp.module.ts`**
```ts
@Module({
  controllers: [PlatformMcpController],
  providers: [PlatformMcpService],
})
export class PlatformMcpModule {}
```
（PrismaService/RealtimeService 为全局模块，直接注入；`app.module.ts` imports 注册该模块）

**`platform-mcp.controller.ts`**
- `POST /api/v1/platform-mcp`，`@Public()`（跳过全局 JwtAuthGuard）+ `@UseGuards(WorkerTokenGuard)`
- 用 SDK：`McpServer` + `StreamableHTTPServerTransport`；每个请求 body → transport 处理，返回 SSE/JSON
- 归属：从 headers 读 `x-worker-id`（worker 注入），请求上下文传给 tools/call 做归属校验
- ⚠️ NestJS 接入：controller 方法签名用 `@Req() req` / `@Res() res`（原生 req/res），调用
  `transport.handleRequest(req, res, parsedBody)`；每个请求新建 transport（streamable-http 无状态端）

**`platform-mcp.service.ts`**（4 工具实现 + 归属校验）

统一校验（tools/call 前）：
```ts
// 归属校验：该 worker 是否有该 taskId 的 Session（防跨任务）
const workerId = req.headers['x-worker-id'];
const session = await prisma.session.findFirst({ where: { taskId, workerId }, select: { id: true } });
if (!session) throw 403 PLATFORM_MCP_FORBIDDEN;
```

工具定义（SDK `registerTool`，name/description/inputSchema）：

| 工具 | inputSchema | 实现 |
|------|-------------|------|
| `chat_history` | `{taskId: string, sinceId?: string, limit?: number}` | 查 `chatChannel(taskId, task_group)` → `message.findMany({channelId, orderBy createdAt asc, ...(sinceId? since 过滤), take limit??50})` → 返回 `[{id, senderType, senderId, text, createdAt}]` |
| `doclib` | `{taskId: string, artifactId?: string, version?: number}` | 无 artifactId → `artifact.findMany({taskId})` 清单（id/type/title/currentVersion）；有 → `artifactVersion` 指定版本全文（contentRef/filePath/fileUrl） |
| `task_context` | `{taskId: string}` | `task.findUnique`（id/title/description/status/mainAgentId/backgroundDocs）+ 团队 agentMembers |
| `group_post` | `{taskId: string, content: string, fileRef?: string}` | 写群聊消息（见 1.3） |

### 1.3 group_post 工具实现
- 查 `chatChannel(taskId, task_group)` → `message.create({channelId, senderType: agent, senderId: null（工具调用无归属 agent？）, content:{text: content}, status: sent})`
  - ⚠️ senderId：MCP 调用来自 opencode 会话，无法精确对应 agent。决定：`senderId` 置 null，senderType=agent（前端按 senderType 渲染）；或从 x-worker-id + taskId 反查该任务的 agent？不精确（一 worker 多 agent）。**决定：senderType=agent, senderId=null**（群聊显示为 Agent 消息，不归属具体角色）
- `realtime.broadcast(CHAT_MESSAGE_NEW, {message}, {type:'channel', id: group.id})`
- fileRef 支持：若 fileRef 命中已归档产出物（复用 worker-dispatcher 的归档映射逻辑——简化为查 artifactVersion filePath）→ 挂 attachmentUrl

### 1.4 单测
`platform-mcp.service.spec.ts`：4 工具（正常 + 归属 403 + doclib 清单/全文 + group_post 落库广播）
`platform-mcp.controller.spec.ts`：worker-token 鉴权、非法 token 401、tools/list 返回 4 工具

### 1.5 验收
- `npm run test` 通过
- curl 验证（部署后）：
  ```
  curl -X POST http://server:3000/api/v1/platform-mcp -H "x-worker-token: <token>" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
  ```

---

## 阶段 2：seed keta-platform MCP 记录

### 2.1 `server/prisma/seed.ts`
在 seed 主体追加（upsert，name 唯一）：
```ts
await prisma.mcpServer.upsert({
  where: { name: 'keta-platform' },
  update: { type: 'remote', url: 'http://server:3000/api/v1/platform-mcp',
            headers: { 'x-worker-token': '{env:X_WORKER_TOKEN}', 'x-worker-id': '{env:WORKER_ID}' },
            enabled: true },
  create: { id: 'ms_keta_platform', name: 'keta-platform', type: 'remote',
            url: 'http://server:3000/api/v1/platform-mcp',
            headers: { 'x-worker-token': '{env:X_WORKER_TOKEN}', 'x-worker-id': '{env:WORKER_ID}' },
            enabled: true },
});
```
（id 前缀对齐 ms_；seed 用 prisma 直写不依赖 IdGenerator）

### 2.2 注入验证
- 部署 server（seed 随 init 重跑）+ worker 重启（或 MCP 变更广播 reload-config 触发重拉）
- worker 容器执行 `opencode mcp list` → 期望 `keta-platform connected`
- 若 `{env:...}` 不生效（headers 字面量）→ **回退**：改 `worker/src/resources/injector.ts` `buildMcpEntry` 对 `keta-platform` 特判附加
  `headers['x-worker-token']=workerToken` + `headers['x-worker-id']=config.workerId`（injector 需注入 workerId——从 options 或环境读取）

### 2.3 验收
- `opencode mcp list` 显示 keta-platform connected（worker 日志/心跳上报三态）

---

## 阶段 3：移除自动注入 + 提示词改写

### 3.1 `server/src/chat/worker-dispatcher.ts`
- `dispatchForTarget` 第 4 步：**删除** `buildDoclibContext` / `buildChatHistoryContext` 调用与注入
  - prompt 构造改为：`GLOBAL_SYSTEM_INSTRUCTIONS` + 动态「任务上下文指令」+ `GROUP_TRIGGER_INSTRUCTION`（群聊触发时）+ `request.text`
  - `buildDoclibContext`/`buildChatHistoryContext` 方法保留（不删，避免破坏既有测试/后续回退；不再被 dispatch 调用）
- 新增动态任务上下文指令（含 taskId + MCP 工具引导），如：
  ```
  【任务上下文】你的当前任务 ID：<taskId>。需要群聊历史/文档库/任务信息时，
  调用 keta-platform 的 chat_history / doclib / task_context 工具（传 taskId）。
  需要向群聊发布消息时调用 group_post 工具，或使用 <group_post> 声明。
  ```
- `GLOBAL_SYSTEM_INSTRUCTIONS` 移除「群聊通知/产出物声明」中与自动注入相关的描述（保留声明协议说明，模型仍可用声明方式）；产出物声明保留（归档仍走声明）

### 3.2 测试更新
- `worker-dispatcher.spec.ts`：prompt 构造断言更新——
  - 原「群聊历史注入」相关用例：改为断言 prompt **不含** `[群聊历史消息]`/`<doclib>`、含任务 ID 指令
  - `buildDoclibContext`/`buildChatHistoryContext` 单测保留（方法仍在）
  - 新增：prompt 含「任务 ID：<taskId>」+ MCP 工具引导

### 3.3 验收
- server 全部单测通过
- 断言 dispatch 的 execute prompt 不含 doclib/群聊历史块

---

## 阶段 4：端到端实测（需模型凭据）

前置：模型 provider 配置 API key（当前 configured: false，需用户在模型管理页配置，或提供 opencode 登录态）

验证链路：
1. 群聊 @ agent → 观察模型是否自主调用 `chat_history`/`task_context`（worker 日志）
2. agent 结论 → `group_post` 工具或声明 → 群聊收到回复
3. 对比：prompt 不再含大段上下文（token 下降）

验收：
- worker 日志出现 MCP tools/call 记录
- 群聊收到 agent 结论
- 若模型未自主调工具（行为偏差）→ 记录优化项（提示词引导强化），不阻塞交付

---

## 阶段 5：文档落位

复制 `.omo/plans/platform-mcp-server-design.md` → `docs/agent-platform/21-平台MCP-Server设计方案.md`
（保持与实施内容一致：按需注入 + SDK + 工具集 + 安全边界）

---

## 涉及文件清单

| 文件 | 动作 |
|------|------|
| server/package.json | + @modelcontextprotocol/sdk |
| server/src/app.module.ts | 注册 PlatformMcpModule |
| server/src/platform-mcp/（新 4 文件） | module/controller/service/spec |
| server/prisma/seed.ts | + keta-platform MCP 记录 |
| server/src/chat/worker-dispatcher.ts | 移除自动注入 + 动态任务上下文指令 |
| server/src/chat/worker-dispatcher.spec.ts | prompt 断言更新 |
| worker/src/resources/injector.ts | 仅回退路径（env 引用失败时） |
| docs/agent-platform/21- | 设计文档落位 |

## 风险与回退

- `{env:...}` 引用不生效 → 注入器特判（阶段 2.2 回退）
- 模型不调工具 → 提示词强化（阶段 4 记录，不阻塞）
- SDK 与 NestJS 的 req/res 适配复杂 → 备选：controller 用 `@Res({passthrough:false})` 原生响应；
  或简化实现（手写 initialize/tools/list/tools/call 四方法 JSON-RPC，不经 SDK transport，仅依赖 SDK 类型）——评估后选简单路径
