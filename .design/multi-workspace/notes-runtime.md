# 【运行时层】多租户（多工作空间）隔离现状分析报告

> 调研员：runtime-isolation｜只读分析（未改动任何被分析的源码；本报告为 lead 指定的交付文件）。
> 范围：`server/src/workers/`、`server/src/platform-mcp/`、`server/src/mcp-servers/`、`server/src/swagger-mcp/`、`worker/src/`、`server/src/realtime/`、`web/hooks/use-sse.ts`、`web/lib/sse-scope.spec.ts`、`server/src/uploads/`、`server/src/artifacts/`、`server/src/git-repos/`、`server/src/models/`、`server/prisma/schema.prisma`、`docs/agent-platform/{34,19,17}*.md`。
> 所有结论均带 `文件:行号` 与代码片段；行号为本次读取时的真实行号。

---

## 0. 全局基线（最硬的一条事实）

```bash
$ grep -rniE 'workspace|tenant|workspace_id|owner_id' server/prisma/schema.prisma
# 0 命中
$ grep -rn --include='*.ts' --exclude='*.spec.ts' -i 'workspaceId|workspace_id|tenantId' \
    server/src worker/src web/lib web/hooks web/app
# 0 命中
```

- `server/prisma/schema.prisma` 共 53 个 model，**没有任何 workspace/tenant 概念**；唯一真实用户维度是 `User`（L42）与 `TeamUserMember.userId`（L237-247，`@@unique([teamId,userId])`）。
- JWT 载荷 `server/src/auth/interfaces/jwt-payload.interface.ts:4-11`：
```ts
export interface JwtPayload {
  sub: string;      // 用户主键 id（唯一的用户信息）
  username: string;
  roleId: string;
  type: string;     // access | refresh
}
```
  **没有 workspaceId / tenantId**。因此运行时所有链路（worker / MCP / SSE）连「当前空间」这个输入都拿不到。

---

## (A) 运行时各组件现状：数据定位方式

### A1 Worker 节点：全局共享池 + 单一共享 token

| 环节 | 定位方式 | 证据 |
|---|---|---|
| 注册 | upsert by `dto.workerId`（全局 `w_` 前缀，无 owner/workspace 列） | `workers.service.ts:402-455`；`schema.prisma:1123-1159`（`Worker` 无归属列）；`docs/agent-platform/34-Worker交互接口协议.md:84` |
| 鉴权 | `X-Worker-Token` 与**部署级单一** `WORKER_TOKEN` 比对 | `worker-token.guard.ts:37-51`；`workers.constants.ts:9-10`（默认 `dev-worker-token`） |
| 心跳 | bcrypt 比对注册时 `tokenHash`，只防「冒充任意 workerId」 | `workers.service.ts:500-540` |
| 调度 | `where: { status: { not: OFFLINE } }` + 剩余容量排序，**全平台所有分派共用一个候选池** | `workers.service.ts:1001-1049` |
| 管理端点 | 任意 `workers.view` 用户可 `GET /workers/register-token` 拿到**共享 token 明文** | `workers.controller.ts:129-139` |
| 双通道守卫 | worker token 路径**不携带任何用户身份** | `worker-or-jwt.guard.ts:39-57` |

```ts
// server/src/workers/workers.service.ts:1003-1004
const candidates = await this.prisma.worker.findMany({
  where: { status: { not: WORKER_STATUS.OFFLINE } },   // ← 无 workspaceId 过滤
```

```ts
// server/src/workers/worker-token.guard.ts:39-42
const token = request.headers[WORKER_TOKEN_HEADER];
const expected = this.config.get<string>('WORKER_TOKEN') ?? DEFAULT_WORKER_TOKEN;
// 全平台同一枚 token；34 篇 §1 L51 明写「**共享 Worker Token**」
```

设计文档佐证：
- `34-Worker交互接口协议.md:51`「Worker → Server：register / heartbeat / events / 资源拉取｜**共享 Worker Token**」；`:53`「资源拉取附加身份 = `x-worker-id: <workerId>`」；`:76`「每次注册无条件回放全部未吊销模型凭据与 git 凭据」。
- `19-worker-agent-任务关系梳理.md:119-124`「**任务/会话不绑定固定 worker**…首次 `@` 时由 `assignWorker()` 从**全部可用 worker** 中选一个」；`:238-239` 结论表同样。

worker 侧身份来源：`worker/src/config.ts:404` `workerId = env.WORKER_ID || \`w_${hostname}\``；`:442` `workDir = env.WORK_DIR || '/data/vteam-worker'`。

### A2 Session：全局唯一键，ID 不含任何空间维度

- 平台会话主键 `s_<零填充序号>`（`session-lifecycle.service.ts:18-22`、`:200`、`:311`）。
- **seat 作用域**：`teamMemberKey = \`${teamId}|${teamMemberId}\``（`:172`），DB `@@unique([teamMemberKey])`（`schema.prisma:447`）。
- **member 全局会话**（`SESSION_SCOPE=member`）：`memberKey = memberId`（`:280`），DB `@unique` `uk_sessions_member`（`schema.prisma:423`）——**一成员一条跨群共享记忆的全局会话**（`:230-233` 注释「一成员一条 team-mode 会话；跨群共享记忆」）。
- `Session` 列（`schema.prisma:400-453`）：`taskId / teamId / agentId / teamMemberId / workerId / instanceRef / memberKey / memberId / seatId / current*`——**无 workspaceId**。
- `bindSessionToWorker` 的幂等键：`(teamId, teamMemberId, workerId, instanceId)`（`session-lifecycle.service.ts:116-133`）——无 workspace。
- opencode 会话 id 由**引擎生成**：`worker.client.ts:416-455`（`POST /sessions` → `{sessionId}`）；`worker/src/driver/v2-driver.ts:589-613`：
```ts
const sessionID = payload.data?.id;   // ses_*，opencode 自己生成，无空间前缀
```
- `session-scope.ts:10-16`：`SESSION_SCOPE` 是**进程级全局环境变量**（`member`/`seat`），不是按用户/空间切换。

### A3 事件回流：只按 workerId + 全局 session 反查定位会话

- 入口 `worker-events.controller.ts`（整文件）：`@Public()` + `WorkerTokenGuard`，`POST /api/v1/worker/events` 恒 202；**只校验共享 token**。
- `worker-event.ingress.ts:469-477`：
```ts
if (!(await this.isWorkerRegistered(dto.workerId))) { throw 404; }  // 唯一身份校验
const dedupKey = dedupKeyOf(dto);                                   // 无 workspace
```
- 去重键 `dedupKeyOf`（`:241-253`）：`worker:<workerId>:<eventId>` 或 `upstream:<aggregateId>:<seq>`——无 workspace。
- `resolvePlatformSessionId`（`:1914-1938`）→ `resolveSessionIdByInstanceRef`（`:1890-1898`）：
```ts
const session = await this.prisma.session.findFirst({
  where: { instanceRef },        // ← 全表全局反查，无 workspace/user 过滤
  select: { id: true },
});
```
- 反查未命中时的兜底 `adoptNewInstanceRef`（`:1946-1979`）：
```ts
const running = await this.prisma.session.findMany({
  where: { workerId, status: SESSION_STATUS.running },   // 该 worker 上「唯一」running 会话
});
if (running.length !== 1) return undefined;               // L1955 注释自承：多会话并发无法可靠定位
// 否则把新 ses_ id 回写到这个会话的 instanceRef（可能属于别的用户）
```
- `message.part.delta` 的流式聚合键 = `` `${channelId}|${agentId ?? ''}` ``（`:827`、`:1049`、`:879-887` `findFirst({channelId, senderType:'agent', status:'processing', senderId: agentId})`）——**不含 workspace/session**；相同 agent 模板在不同空间会命中同一条 processing 行。
- SSE 发射域 `scopeOf`（`:1796-1801`）：`taskId → {type:'task'}` 否则 `{type:'global'}`；`:972-976` delta 发 `{type:'channel', id: channelId}`。

### A4 MCP：身份上下文只有 `workerId`，数据全靠 taskId/teamId 定位

- `platform-mcp.controller.ts:39` `WORKER_ID_HEADER = 'x-worker-id'`；`:171` `const workerId = String(req.headers['x-worker-id'] ?? '')`；`:209` `dispatch(body, workerId, signal)`。
- `toolsCall`（`:386-465`）：
```ts
const resolved = await this.service.resolveToolCallerWithContext({ workerId }, input);
await this.toolPermission.assertToolAllowed(resolved.callerId, tool.name);
const result = await tool.handler(
  { workerId, resolvedContext: { taskId?, teamId?, fromFallback } },  // ← 传给 handler 的全部身份
  input, signal);
```
- `PlatformMcpContext`（`platform-mcp.service.ts:383-398`）：
```ts
export interface PlatformMcpContext {
  workerId: string;                       // 唯一身份来源
  resolvedContext?: { taskId?, teamId?, fromFallback: boolean };
}
```
  **没有 userId / workspaceId**。
- MCP 头是 **worker 级静态值**，被该 worker 上所有会话共用：
  - `server/prisma/seed.ts:1545-1567`（vteam MCP server）与 `:1577-1599`（vteam-api）：`headers: {'x-worker-token': '{env:X_WORKER_TOKEN}', 'x-worker-id': '{env:WORKER_ID}'}`；
  - `worker/src/index.ts:162-169`（dsh 引擎 `platformMcpHeaders`）同样 `'x-worker-id': config.workerId`；
  - `worker/src/resources/injector.ts:1229-1245` 拉取资源也用同一对头。
- 唯一的归属校验 `assertWorkerTask`（`platform-mcp.service.ts:8281-8365`）：
```ts
let session = await this.prisma.session.findFirst({
  where: { teamId: authTeamId, workerId: ctx.workerId,
           ...(selfInstanceId !== undefined ? { teamMemberId: selfInstanceId } : {}) },
```
  只校验「该 worker 有该团队的会话」，**无 workspace 维度**；`assertWorkerTeam`（`:8631-8689`）同理。
- **双空上下文回填（最危险的一处，代码自己承认）** `resolveToolCallerWithContext`（`:8442-8451`）/ `resolveSessionFallback`（`:8458-8531`）：
```ts
// :8439-8440 原文注释
// 已知启发式局限：同一 worker 并发多会话时最近会话回填可能误归属
const session = await this.prisma.session.findFirst({
  where: { workerId: ctx.workerId },      // :8485-8488
  orderBy: { createdAt: 'desc' },
  select: sessionSelect,
});
```
  `:8511-8526` 仅在「调用方显式给了 selfInstanceId 且命中的会话属于别的成员」时 fail-closed；**显式双空 + 未传 selfInstanceId 时直接按 worker 最近会话推断 taskId/teamId**，回填进 `input`（controller `:439-440`）。
- 各工具的数据定位（全部只按 taskId / teamId / artifactId）：
  | 工具 | 定位 | 行号 |
  |---|---|---|
  | `chat_history` | `findGroupChannelForTask(exec.taskId)` → `queryHistoryPage(channel.id)`；DM 按 `(teamId, teamMemberId)` 找 private 频道 | `:811-855`、`:866-917` |
  | `doclib` | `artifact.findMany({where:{taskId:args.taskId}})`；`artifact.findFirst({where:{id:args.artifactId, taskId}})` | `:1386-1455` |
  | `task_context` | `task.findUnique({where:{id:args.taskId}})` | `:1463-1489` |
  | `submit_artifact` | `artifactsService.append(args.taskId, {...})` | `:3865-3959` |
  | `read_file` | 归档优先（按 taskId 查 artifactVersion）→ **直读全局 uploads 目录** → worker 文件兜底 | `:3795-3847`、`:9225-9243` |
  | `git_repos_list` | `gitRepos.findAll()` 全表 → 按 `callerAgentId`（全局 Agent 模板）过滤 grant | `:1013-1042` |
  - 工具入参 schema 也无空间维度：`platform-mcp.tools.ts:85-119`（chatHistory）、`:123-135`（doclib）、`:139-141`（`taskContextSchema = z.object({taskId: z.string()})`）、`:160-172`（readFile）、`:246-270`（submitArtifact）。
- `swagger-mcp`：`swagger-mcp.auth.ts:19-23` `SwaggerMcpAuthContext = {workerId, agentId, instanceId}`；`:57-58` `session.findFirst({where:{workerId, status:'running'}})`（无 workspace）；`:92-97` `authorize()` 目前恒抛 403（默认拒绝）；`swagger-mcp.controller.ts:101` 同样只取 `x-worker-id`。
- MCP Server 配置是**全局表 + 每 worker 单份注入**：`mcp-servers.service.ts:171-224` 不带 tenant 过滤地返回 `mcpServer` 表（`schema.prisma:1104-1117` 无 owner 列），仅按 `workerId` 覆盖内置 vteam 的 url（`:199-216`）；`worker/src/resources/injector.ts:650-658, 720-736` 写入 `<workDir>/opencode.json` 的 `mcp.servers`/`agents` 节——**一个 worker 一份配置，所有会话共享**。`34` 篇 §5 L253-259 接口清单同样。

### A5 模型凭据 / git 凭据：全表全量 → 广播到全部 worker → 每 worker 单份文件

**模型凭据**
- `ModelCredential`（`schema.prisma:1018-1034`）：`@@unique([providerID])`，注释 `:1020`「token **全局 provider 粒度**（关键决策①）」；`ProviderTombstone`（`:1043-1048`）主键 `providerID`；`WorkerModelAvailability`（`:1003-1012`）主键 `(workerId, modelId)`；`Model`（`:970-1001`）`@@unique([providerID, modelID])`——**全部无 workspaceId**。
- `models.service.ts:1383-1468` `saveCredentialForProvider`：`findUnique({where:{providerID}})` → 覆盖更新，**任一用户（AdminGuard）改一个 provider 的 token 就是全平台改**（`models.controller.ts:106-121`；`:27-28` GET 成员只读）。
- `models.service.ts:1641-1678` `dispatchCredentialState`：
```ts
const rows = await this.prisma.modelCredential.findMany({   // 全表全量，无 workspace 过滤
  select: { providerID: true, credentialRef: true, revokedAt: true },
});
const providerKeys = active.map(r => ({ providerID: r.providerID, key: decrypt(...) }));
await this.workers.dispatchModelCredentials(providerKeys, targetWorkerIds, ...);
```
- `workers.service.ts:727-752` `dispatchModelCredentials` → 空 target 时 `broadcastCommand`（`:705-714`「查询**全部**在线 worker 逐个入队」）；`:763-811` `replayModelCredentials` 在**每次 register** 用 `modelCredential.findMany()` 全量回放（`:767-769`）。
- worker 侧落点：`worker/src/config.ts:200-255` 隔离域 `<HOME>/.opencode-iso/data/opencode/auth.json`（`：251`）、`config/opencode/opencode.json`（`:250`）；`worker/src/index.ts:872-936` 写 `auth.json` + `opencode.json` 的 `providers.<id>.settings.apiKey`（`worker/src/credentials/model-credential-injector.ts:301-315`）——**一个 worker 进程一份，所有会话/用户共用同一把 key**。

**git 凭据**
- `GitCredential`（`schema.prisma:1052-1067`）`name @unique` 全局唯一；`GitRepo`（`:1069-1080`）`repoUrl @unique`；`GitRepoGrant`（`:1082-1098`）`@@unique([agentId, repoId])` 按**全局 Agent 模板**授权——全无 workspace/owner 列。
- `git-credentials.service.ts:50-56` `findAll()` 无过滤；`git-credentials.controller.ts:27-31` GET 成员只读；`git-repos.controller.ts:39-43` GET 成员只读。
- `workers.service.ts:824-861` `dispatchGitCredentials`（目标 = 全部在线 worker）；`resolveAuthorizedRepoUrls`（`:884-909`）`gitRepoGrant.findMany({where:{revokedAt:null}})` **全表**；`buildGitCredentialsPayload`（`:916-956`）`gitRepo.findMany({where:{revokedAt:null}})` **全表**，解密所有 `credentialRef` 打包。
- worker 侧：`worker/src/git/git-credential-injector.ts:21`
```ts
export const GIT_CREDS_FILE = path.join(os.homedir(), '.keta-git-creds.json'); // 单文件
```
  `:63-78` `buildGitCredsFile` 把**所有仓库**的明文 key 按 repoUrl 排序写进这一个文件（600 权限）；`34` 篇 §6.3 L362-363 自承「这些端点写入**明文凭据**…必须 X-Worker-Token；暴露到非可信网络等于开放配置写入口」。
- 设计文档：`17-仓库权限与凭证机制.md:101-102,109,118-119,127` 曾设计 `owner_type / owner_id / project_id / subject_type=project`，**落地 schema 完全未采纳**；`:445` 开放问题③「多仓库并发凭证作用域隔离…ssh-agent 按 worker 装载多仓库 key…出现跨仓库串用风险时改为按任务/会话隔离」——明确承认现状是 worker 级共享。

### A6 文件 / 工作目录 / 文档库：单一全局根，无空间分区

- `server/src/tasks/work-dir.util.ts:28` `DEFAULT_TASK_WORK_DIR = '/data/vteam-worker'`；`:34-36`：
```ts
export function taskDirOf(root: string, taskId: string): string {
  return `${root}/tasks/${taskId}`;          // ← 无 workspace 段
}
```
- `server/src/chat/worker-dispatcher.ts:6336-6377`：`ensureTaskWorkDir = <根>/tasks/<taskId>`、`:6352` `ensureTeamWorkDir = path.join(root,'teams',teamId)`、`resolveAgentWorkDir` 二选一；`:3480` `directory: teamWorkDir` 传给 `workerClient.execute`；`:1913-1918` 根来自 env `WORK_DIR`。
- `worker/src/exec/exec-server.ts:2340-2354`：`fsp.mkdir(payload.directory)` + 写 `<directory>/.execution-config.json`；`:2615-2623` 附件下载到 `<directory>/attachments/`；`:2598`「**全部附件**都下载到 `<directory>/attachments/`」。`directory` 直接采信 server 下发值，**无空间前缀、无归属校验**。
- worker 全局 workDir：`worker/src/index.ts:1732-1737`（资源注入）、`:2297`（exec-server 回落目录）、`:2291`（browserProfileRoot）；`worker/src/config.ts:442`。
- **uploads 单一全局目录**：`server/src/uploads/uploads.constants.ts:39-48`
```ts
export const DEFAULT_UPLOAD_DIR = 'uploads';
export function resolveUploadDir(): string {
  return join(process.cwd(), process.env.UPLOAD_DIR ?? DEFAULT_UPLOAD_DIR);  // 无 workspace
}
```
  `uploads.service.ts:65-81` 磁盘名 `<uuid>__<原始名>`（`:106-115`），**不按用户分目录**；`uploads.controller.ts:39-40`「全局 JwtAuthGuard 兜底…**登录用户即可上传**」，`:81-100` 带任意 `taskId` 即归档到该任务（`:105-120` 无归属校验）。
- **静态 `/uploads/*` 不经 JWT**：`server/src/main.ts:44-74` `app.useStaticAssets(resolveUploadDir(), {prefix:'/uploads/'})`（Nest 静态资源在全局 guard 链之外），仅有 `Content-Disposition / nosniff / CSP sandbox`；`web/middleware.ts` 只做同源代理。任何拿到 URL/文件名的人都能读。
- `read_file` 归档直读 `uploads.service.ts:293-305`：`fsp.readFile(join(resolveUploadDir(), base))`——只取 basename，**无 workspace 路径**；`normalizeFileRef`（`:268-278`）把任意 worker 原始路径归一化成 `/uploads/<basename>`。
- worker `GET /file`（`worker/src/exec/exec-server.ts:1365-1415`）：`fsp.stat(filePath)` / `fsp.readFile(filePath)` 接受**任意绝对路径**，只校验 `X-Worker-Token`（`:1374-1379`），**不限定在 workDir 内**；`workers.controller.ts:159-229` `GET /workers/file` 会遍历所有 worker 逐个试读该路径。
- 产出物 REST 缺成员校验：`artifacts.controller.ts:76-82` `GET /tasks/:id/artifacts`、`:88-94` `GET /artifacts/:id`、`:101-110` 版本、`:118-131` POST、`:152-159` DELETE 只有 `PermissionGuard('artifacts.*')`；`assertTeamMember`（`:162-186`）**只挂在 `GET /teams/:id/artifacts`**（`:57-66`）。同理 `tasks.controller.ts:166-172` `GET /tasks/:id` 无成员校验（对比 `:91-131` 列表接口有 `teamUserMember` 过滤）。
- 唯一按会话做了隔离的是浏览器 profile：`worker/src/browser/browser-tools.ts` 按 opencode `ses_` id 派生 scope（`browser-profiles/<scope>/`），但依赖的是全局唯一的引擎会话 id，不是空间维度。

### A7 SSE：scope 只有 task/channel/team/global，前端恒 `scope=all`

- `realtime.service.ts:18-23`：
```ts
export type RealtimeScopeType = 'task' | 'channel' | 'team' | 'global';
export interface RealtimeScope { type: RealtimeScopeType; id?: string; }   // 无 workspace/user
```
- `RealtimeEvent`（`:30-44`）字段 `scopeType / scopeId / teamId`，DB `RealtimeEvent`（`schema.prisma:1183-1194`）同——**无 workspaceId**。
- `scopeMatches`（`:540-548`）只比 `type` + `scopeId`；`subscribe`（`:360-384`）、`getEventsSince`（`:398-445`）按 scope 数组 OR 过滤。
- **已有的用户级门（团队维度，不是空间维度）**：`realtime.controller.ts:382-404` `assertScopeAccess` 对 `task/channel/team` 查 `teamUserMember` 成员关系；`:387-389`「`global` 无过滤（**登录即可**）」；`:439-447` `resolveVisibleTeamIds(userId)` 为 `scope=all` 推导可见团队集；`realtime.service.ts:565-580` `toTeamFilter` 按 `event.teamId` 过滤。
- 入口 `:123-132`：`authenticate(token)` 只返回 `userId`，订阅 scope 列表里没有任何空间 key。
- **前端恒 `scope=all`**：`web/hooks/use-sse.ts:142` `new URLSearchParams({ token, scope: "all" })`；`:27-45` 连接池 key = `` `${token}|all` ``（按 token 分池，非按空间）；`:63-121` `matchesScope` 是**纯前端展示过滤**（按 payload.taskId / channelId / teamId）；`:87` `task:` 域下 `session.updated` **无条件放行**；`:98-105` `team:` 域下 `chat.message.new` 恒 `return true`。`web/lib/sse-scope.spec.ts:77-80` 把「scope 缺省 / all 放行一切」钉成契约；`:59-63` 承认 `session.updated` 载荷「**无法判定归属**」。
- `web/hooks/use-realtime.ts:340` 同样 `scope: "all"`（共享连接）。

### A8 设计文档中的相关描述

- `34-Worker交互接口协议.md`：`:51` 共享 Worker Token；`:53` `x-worker-id`；`:76` 注册无条件回放全部凭据；`:208-212` 事件回流仅 `x-worker-token` + workerId 校验；`:230-239` 事件类型表与 `sessionId` 语义（worker 上送 `ses_`，server 经 `instanceRef` 反查）；`:247` 资源拉取 `x-worker-token + x-worker-id`；`:295` `/execute` 请求体含 `directory`；`:362-363` 明文凭据端点安全警告。
- `19-worker-agent-任务关系梳理.md`：`:37-40` `Session.workerId + instanceRef` 是唯一接线点；`:119-124` 不绑定固定 worker；`:128-129` 二次 @ 复用同一 opencode 会话；`:229`「worker 多实例隔离未实现」；`:237-239` 结论表。
- `17-仓库权限与凭证机制.md`：`:101-102,109` 早期 `owner_type/owner_id/project` 设计（未落地）；`:129-136` 凭证与授权分离；`:145-150` 安全基线（AES-256-GCM、明文零接触、临时 key 600）；`:445` 开放问题③ 承认 worker 级多仓库凭证共享的串用风险。

### A9 现状中「有」的缓解措施（不是 workspace 隔离，但值得保留）

| 措施 | 位置 |
|---|---|
| 心跳 bcrypt `tokenHash` 二次比对，防共享 token 冒充已注册 workerId | `workers.service.ts:511-540` |
| 事件入口拒绝未注册 workerId | `worker-event.ingress.ts:469-477, 1881-1887` |
| MCP `selfInstanceId` 防冒充 + 岗位能力点矩阵（default-allow） | `platform-mcp.service.ts:8281-8365`；`platform-tool-permission.service.ts:48-91` |
| SSE 按 `teamUserMember` 校验 task/channel/team scope、`scope=all` 按可见团队过滤 | `realtime.controller.ts:382-404, 439-447` |
| 凭据 AES-256-GCM 加密落库、响应脱敏、auth.json 600 + 退出清理 | `models.service.ts:1436-1462`；`worker/src/credentials/model-credential-injector.ts` |
| uploads 文件名 UUID + basename 清洗 + nosniff/CSP | `uploads.service.ts:106-115`；`main.ts:44-74` |
| browser profile 按 `ses_` 会话隔离 | `worker/src/browser/browser-tools.ts` |

**这些全部是「团队/实例/worker」粒度，不是「工作空间」粒度**；团队本身是全局实体（`teams.name @unique`，`29-团队化改造需求说明.md`），因此团队粒度在多用户下不等于空间隔离。

---

## (B) 结论：哪些运行时标识缺少 workspace 维度

| # | 运行时标识 | 现状形态 | 缺什么 | 关键证据 |
|---|---|---|---|---|
| 1 | **平台 Session id** | `s_<seq>`；`teamMemberKey=teamId\|teamMemberId`；`memberKey=memberId`（`@unique` 全局） | workspaceId；唯一键应成 `(workspaceId, memberId)` | `session-lifecycle.service.ts:18-22,172,280`；`schema.prisma:400-453` |
| 2 | **opencode 会话 id / instanceRef** | 引擎生成 `ses_*`；`Session.instanceRef` 全局 `findFirst` 反查 | session→workspace 映射；反查须带 workspace 条件 | `v2-driver.ts:589-613`；`worker-event.ingress.ts:1890-1898` |
| 3 | **TaskGroupInstance 键** | `(teamId, teamMemberId, workerId, instanceId)` | workspaceId | `session-lifecycle.service.ts:116-133` |
| 4 | **事件去重 key** | `worker:<workerId>:<eventId>` / `upstream:<agg>:<seq>` | workspace 前缀 | `worker-event.ingress.ts:241-253` |
| 5 | **事件→会话定位** | 只验 `workerId` 已注册；全局 `findFirst({instanceRef})`；「该 worker 唯一 running 会话」adopt | 事件 payload 带 workspaceId + (workerId,workspaceId) 绑定校验 | `worker-event.ingress.ts:469-477,1914-1979` |
| 6 | **SSE scope key** | `task:<id>` / `channel:<id>` / `team:<id>` / `global`；DB `scopeType/scopeId` | `workspace:<id>` 维度；DB `workspaceId` 列；`global` 需收敛为空间内全局 | `realtime.service.ts:18-23,540-548`；`schema.prisma:1183-1194` |
| 7 | **前端 SSE 订阅** | URL 恒 `scope=all`；池 key `${token}|all`；过滤纯前端 | 连接级 workspace 绑定 | `web/hooks/use-sse.ts:142,281,63-121` |
| 8 | **workdir / directory** | `<WORK_DIR>/tasks/<taskId>`、`<WORK_DIR>/teams/<teamId>` | `workspaces/<workspaceId>/` 分段 | `work-dir.util.ts:28-36`；`worker-dispatcher.ts:6336-6377` |
| 9 | **uploads 目录 / 静态 URL** | 单一 `uploads/`；`/uploads/<name>` 无鉴权 | 按空间分目录 + 鉴权/签名 URL | `uploads.constants.ts:39-48`；`main.ts:44-74` |
| 10 | **worker 文件端点** | `GET /file?path=<任意绝对路径>` | realpath 限定在 workspace 目录内 | `worker/src/exec/exec-server.ts:1365-1415` |
| 11 | **WORKER_TOKEN / x-worker-id** | 全平台一枚共享 token；身份只有 `workerId` | per-worker/per-workspace 凭据；MCP 请求带 workspace 票据 | `worker-token.guard.ts:37-51`；`platform-mcp.controller.ts:39,171` |
| 12 | **MCP context** | `PlatformMcpContext = {workerId}`；入参 `taskId/teamId/selfInstanceId` | `workspaceId` + `userId`；删除「worker 最近会话回填」 | `platform-mcp.service.ts:383-398,8439-8440,8485-8488` |
| 13 | **MCP 数据查询** | `artifact.findMany({taskId})`、`task.findUnique({id})`、`chatHistory(channel.id)` | 所有 `where` 增加 `workspaceId` + 归属校验 | `platform-mcp.service.ts:1386-1489,3795-3847` |
| 14 | **MCP Server / skills / tools / agent-policies** | 全局表 → 每 worker 单份 `opencode.json` | workspaceId 列 + 按空间下发/分目录注入 | `mcp-servers.service.ts:171-224`；`schema.prisma:1104-1117` |
| 15 | **ModelCredential / ProviderTombstone / WorkerModelAvailability / Model** | `providerID` 全局唯一；`(workerId,modelId)` | workspaceId；唯一键改 `(workspaceId, providerID)` | `schema.prisma:970-1048`；`models.service.ts:1383-1468,1641-1678` |
| 16 | **GitCredential / GitRepo / GitRepoGrant** | `name`/`repoUrl` 全局唯一；grant 按全局 `agentId` | workspaceId；`@@unique([workspaceId, repoUrl])` | `schema.prisma:1052-1098`；`git-credentials.service.ts:50-56` |
| 17 | **Worker 节点** | 全局池 `status != offline`；无 owner 列 | `Worker.workspaceId` + assignWorker 过滤 | `workers.service.ts:1001-1049`；`schema.prisma:1123-1159` |
| 18 | **凭据下发范围** | `broadcastCommand` → 全部在线 worker；全表 `findMany` 回放 | 按 workspace 定向 | `workers.service.ts:705-714,763-811,824-861` |

---

## (C) 具体证据清单（文件 + 行号 + 代码片段）

> 按组件分组，逐条可直接复核。

**C1 无 workspace 基线**
1. `server/prisma/schema.prisma` 全文 `grep -niE 'workspace|tenant'` → 0；53 model 中仅 `TeamUserMember.userId`（L237-247）带用户维度。
2. `server/src/auth/interfaces/jwt-payload.interface.ts:4-11`：`{sub, username, roleId, type}`，无 workspaceId。
3. `docs/agent-platform/01-背景与目标.md:63`「不做多租户 SaaS（第一版）」；`29-团队化改造需求说明.md:124`「首版团队为全平台可见，不做按项目隔离」；`server/prisma/seed.ts:894`「项目维度已拆除」。

**C2 Worker 共享 / 共享 token**
4. `server/src/workers/workers.constants.ts:9-10`：`DEFAULT_WORKER_TOKEN = 'dev-worker-token'`。
5. `server/src/workers/worker-token.guard.ts:37-51`：`expected = config.get('WORKER_TOKEN') ?? DEFAULT_WORKER_TOKEN`，单一值 timingSafeEqual。
6. `server/src/workers/workers.controller.ts:93-99`（register `@Public()+WorkerTokenGuard`）、`:101-112`（heartbeat）、`:129-139`（`getRegisterToken()` 返回共享 token 给任何 `workers.view` 用户）。
7. `server/src/workers/workers.service.ts:402-455`：`prisma.worker.upsert({where:{id:dto.workerId}, ...})`，无 workspace 列；`:1001-1004` `findMany({where:{status:{not:OFFLINE}}})`；`:705-714` `broadcastCommand` 查全部在线 worker。
8. `server/src/workers/worker-or-jwt.guard.ts:43-54`：worker token 分支 `request.workerToken = token.trim(); return true;`（无用户身份）。
9. `server/prisma/schema.prisma:1123-1159`：`model Worker` 无 owner/workspace。
10. `docs/agent-platform/34-Worker交互接口协议.md:51`「**共享 Worker Token**」；`:53` `x-worker-id`；`:76` 每次注册无条件回放全部凭据。
11. `docs/agent-platform/19-worker-agent-任务关系梳理.md:119-124`「不绑定固定 worker…从全部可用 worker 中选一个」；`:237-239` 结论表。

**C3 Session / 事件定位**
12. `server/src/workers/session-lifecycle.service.ts:18-22`：`SESSION_ID_PREFIX = 's'`；`:172` `` const teamMemberKey = `${teamId}|${teamMemberId}` ``；`:280` `const memberKey = memberId`。
13. `server/prisma/schema.prisma:400-453`：`model Session` 列清单；`:423` `memberKey @unique`；`:447` `@@unique([teamMemberKey])`。
14. `server/src/workers/session-lifecycle.service.ts:116-133`：`taskGroupInstance.findFirst({where:{teamId, teamMemberId, workerId, instanceId}})`。
15. `server/src/workers/session-scope.ts:10-16`：`getSessionScope()` 读全局 `process.env.SESSION_SCOPE`。
16. `worker/src/driver/v2-driver.ts:589-613`：`const sessionID = payload.data?.id;`（引擎生成）。
17. `server/src/workers/worker-events.controller.ts`（整文件）：`@Public() @UseGuards(WorkerTokenGuard) @Post('events') @HttpCode(202)`。
18. `server/src/workers/worker-event.ingress.ts:469-477`：`isWorkerRegistered(dto.workerId)`；`:241-253` `dedupKeyOf`；`:1890-1898` `session.findFirst({where:{instanceRef}})`；`:1950-1956` `findMany({where:{workerId, status:'running'}})` + `if (running.length !== 1) return undefined;`；`:827` `` streamKey = `${channelId}|${agentId ?? ''}` ``；`:1796-1801` `scopeOf`。
19. `docs/agent-platform/34-Worker交互接口协议.md:238-239`「`sessionId` 语义：Worker 上送 opencode 会话 id（`ses_` 前缀），Server 经 `instanceRef` 反查平台 Session 主键（`s_` 前缀）」。

**C4 MCP context**
20. `server/src/platform-mcp/platform-mcp.service.ts:383-398`：`PlatformMcpContext`（全文见 A4）。
21. `server/src/platform-mcp/platform-mcp.controller.ts:39,171,209,435-457`：`x-worker-id` → `dispatch` → `resolveToolCallerWithContext({workerId}, input)` → handler ctx。
22. `server/prisma/seed.ts:1545-1567`（`:1550-1553` headers `{env:X_WORKER_TOKEN}` / `{env:WORKER_ID}`）、`:1577-1599`（vteam-api 同形）；`worker/src/index.ts:162-169`；`worker/src/resources/injector.ts:1229-1245`。
23. `server/src/platform-mcp/platform-mcp.service.ts:8439-8440`「**已知启发式局限：同一 worker 并发多会话时最近会话回填可能误归属**」；`:8485-8488` `findFirst({where:{workerId:ctx.workerId}, orderBy:{createdAt:'desc'}})`；`:8511-8526`「该 worker 最近会话属于成员 X…与调用方不一致」的 fail-closed 兜底。
24. `server/src/platform-mcp/platform-mcp.service.ts:8320-8329`：`assertWorkerTask` 的 `session.findFirst({where:{teamId, workerId, ...}})`。
25. 工具定位：`platform-mcp.service.ts:811-855`（chat_history）、`:1386-1455`（doclib，`artifact.findMany({where:{taskId:args.taskId}})` L1393）、`:1463-1489`（task_context，`task.findUnique({where:{id:args.taskId}})` L1465）、`:3865-3959`（submit_artifact）、`:3795-3847`（read_file）、`:9225-9243`（readFromArchive）、`:1013-1042`（git_repos_list）。
26. `server/src/platform-mcp/platform-mcp.tools.ts:85-174,246-270`：所有 zod schema 只有 taskId/teamId/selfInstanceId/fileRef，无 workspaceId。
27. `server/src/swagger-mcp/swagger-mcp.auth.ts:19-23,57-58,92-97`：`SwaggerMcpAuthContext`、`findFirst({where:{workerId,status:'running'}})`、恒 403。
28. `server/src/mcp-servers/mcp-servers.service.ts:171-224`（全局 findAll）；`server/prisma/schema.prisma:1104-1117`（`McpServer` 无 owner）；`worker/src/resources/injector.ts:650-658,720-736`（单份 opencode.json）。
29. `server/src/platform-mcp/platform-tool-permission.service.ts:34-35`「**有意不做安全边界**：`vteam-api` / `swagger-mcp` 两个 MCP server 不接受本门约束」。

**C5 凭据 / 模型 / git**
30. `server/prisma/schema.prisma:1018-1034`（`:1020` 「token 全局 provider 粒度（关键决策①）」、`:1032` `@@unique([providerID])`）、`:1043-1048`（ProviderTombstone）、`:1003-1012`（WorkerModelAvailability）、`:970-1001`（Model）。
31. `server/src/models/models.service.ts:1439-1462`（`findUnique({where:{providerID}})` → update/create）、`:1641-1672`（`modelCredential.findMany()` 全量 + `dispatchModelCredentials`）；`server/src/models/models.controller.ts:106-121`（AdminGuard，无空间）。
32. `server/src/workers/workers.service.ts:727-752`（`broadcastCommand`）、`:763-811`（`replayModelCredentials` 全表）、`:824-861`（git 全量下发）、`:884-909` / `:916-956`（`gitRepoGrant`/`gitRepo` 全表 findMany）。
33. `worker/src/config.ts:200-255`（`:250-253` 隔离域单份 auth.json / opencode.json / opencode.db）；`worker/src/index.ts:872-936`（写 auth.json + provider settings）；`worker/src/credentials/model-credential-injector.ts:301-315`（`settings.apiKey`）。
34. `server/prisma/schema.prisma:1052-1098`（Git 三表无 owner）；`server/src/git-repos/git-credentials.service.ts:50-56`（findAll 无过滤）；`git-credentials.controller.ts:27-31` / `git-repos.controller.ts:39-43`（GET 成员只读）。
35. `worker/src/git/git-credential-injector.ts:21` `GIT_CREDS_FILE = $HOME/.keta-git-creds.json`；`:63-78` 全量 entries 写单文件。
36. `docs/agent-platform/17-仓库权限与凭证机制.md:101-102,109,118-119,127`（未落地的 owner/project 设计）、`:445`（开放问题③）。

**C6 文件 / workdir**
37. `server/src/tasks/work-dir.util.ts:28` `DEFAULT_TASK_WORK_DIR = '/data/vteam-worker'`；`:34-36` `taskDirOf`。
38. `server/src/chat/worker-dispatcher.ts:6336-6377`（ensureTaskWorkDir / ensureTeamWorkDir / resolveAgentWorkDir）、`:3480` `directory: teamWorkDir`、`:1913-1918` WORK_DIR 根。
39. `worker/src/exec/exec-server.ts:2340-2354`（mkdir + `.execution-config.json`）、`:2615-2623`（`attachments/`）、`:1365-1415`（`GET /file` 任意绝对路径，仅 X-Worker-Token）。
40. `server/src/uploads/uploads.constants.ts:39-48`（单一 `resolveUploadDir()`）；`uploads.service.ts:65-81,106-115,268-278,293-305`（UUID 文件名、normalizeFileRef、readFromArchive 只看 basename）；`uploads.controller.ts:39-40,81-120`（登录即上传、任意 taskId 归档）；`server/src/main.ts:44-74`（静态 `/uploads/*` 无 JWT）；`web/middleware.ts`（只代理）。
41. `server/src/artifacts/artifacts.controller.ts:76-82,88-94,101-110,118-131,152-159`（只有权限点）vs `:57-66,162-186`（仅 teams 端点有 `assertTeamMember`）；`server/src/tasks/tasks.controller.ts:166-172`（`GET /tasks/:id` 无成员校验）vs `:91-131`（列表有 teamUserMember 过滤）。
42. `server/src/workers/workers.controller.ts:159-229`（`GET /workers/file?path=` 遍历所有 worker 试读任意绝对路径，只校验图片扩展名 + `workers.view`）。

**C7 SSE**
43. `server/src/realtime/realtime.service.ts:18-23`（RealtimeScopeType）、`:30-44`（RealtimeEvent 字段）、`:540-548`（scopeMatches）、`:565-580`（toTeamFilter）、`:360-384`（subscribe）、`:398-445`（getEventsSince）。
44. `server/prisma/schema.prisma:1183-1194`（`RealtimeEvent` 无 workspaceId）。
45. `server/src/realtime/realtime.controller.ts:123-132`（authenticate 返回 userId）、`:382-404`（assertScopeAccess，`global` 直接 continue）、`:439-447`（resolveVisibleTeamIds）。
46. `web/hooks/use-sse.ts:142`（`scope: "all"`）、`:281`（`key = ${token}|all`）、`:63-121`（matchesScope 前端过滤，`:87` session.updated 无条件放行、`:98-105` team: chat.message.new 恒 true）；`web/lib/sse-scope.spec.ts:59-63,77-80`；`web/hooks/use-realtime.ts:340`。

---

## (D) 多用户同时运行时的串数据 / 越权 / 文件覆盖风险清单（按严重度排序）

### P0（可直接跨空间读/写他人数据）

| # | 风险 | 触发条件 | 链路与证据 |
|---|---|---|---|
| D1 | **MCP「双空上下文回填」把调用归属到别人的任务/团队** | 两个用户的会话跑在**同一个 worker**，工具调用未显式传 taskId/teamId 且未传 selfInstanceId | `platform-mcp.controller.ts:434-440` 回填 → `resolveSessionFallback` `findFirst({where:{workerId}, orderBy:{createdAt:'desc'}})`（`:8485-8488`）→ `chat_history` / `doclib` / `task_context` / `submit_artifact` / `read_file` 全部按推断出的 taskId 操作。代码 `:8439-8440` 明确承认「可能误归属」。由于团队/task 是全局实体、MCP 无 workspace 过滤，`assertWorkerTask` 只校验 worker+team session 绑定（`:8320-8329`），**不会拦截**。后果：A 的 agent 读到 B 的群聊历史、产出物、任务上下文，甚至把产出物提交进 B 的任务。 |
| D2 | **事件回流串会话 / 串消息** | 共享 worker 上两个空间同时有 running 会话 | ingress 只验 workerId 已注册（`:469-477`）；`resolveSessionIdByInstanceRef` 全局 `findFirst`（`:1890-1898`）；反查未命中时 `adoptNewInstanceRef` 把新 `ses_` 回写到「该 worker 唯一 running 会话」（`:1950-1978`）——多空间并发时要么拒绝服务要么**错绑到他人会话**；`message.part.delta` 聚合键 `` `${channelId}|${agentId}` ``（`:827`）与 `findFirst({channelId, senderId:agentId, status:'processing'})`（`:879-887`）在相同 agent 模板下会把 A 的流式增量追加到 B 的 processing 消息，`session.updated`/`agent.status` 也据此改错会话状态。 |
| D3 | **模型/Git 凭据全平台共享，一个用户的操作影响所有人** | 任一 AdminGuard 用户保存/吊销凭据，或任一 worker 注册/恢复上线 | `ModelCredential @@unique([providerID])`（schema `:1032`）→ 改 `providerID=x` 的 token 覆盖全平台；`dispatchCredentialState` 全表解密 + `broadcastCommand` 下发**全部在线 worker**（`models.service.ts:1641-1672`、`workers.service.ts:705-714`）；每次 register 全表回放（`:763-811`）。Git：`resolveAuthorizedRepoUrls`/`buildGitCredentialsPayload` 全表 findMany（`:884-956`）→ 所有用户仓库的**明文 key 写进同一个** `.keta-git-creds.json`（`git-credential-injector.ts:21,63-78`）；`git_repos_list` 只按全局 `agentId` 过滤（`:1013-1042`）→ 同模板 Agent 可读到他人仓库授权。一个用户吊销凭据 = 全平台该 provider 失效。 |
| D4 | **uploads 单一全局目录 + 静态无鉴权 + 任意 taskId 归档** | 任何登录用户 | `POST /uploads` 带任意 `taskId` 即 `artifactsService.archiveFile(taskId, ...)`（`uploads.controller.ts:92-98,105-120`，**无归属校验**）→ 往他人任务文档库写文件；`GET /uploads/*` 走 `useStaticAssets`（`main.ts:44-74`）不经 JWT，知道文件名即可读；`read_file` 直读（`:3843-3844`）与 `readFromArchive`（`uploads.service.ts:301-305`）只按 basename 定位；文件名 `<uuid>__<原始名>` 全局唯一但**无空间命名空间**，同名归一棵树。 |
| D5 | **worker `GET /file` 任意绝对路径读取** | 持有共享 WORKER_TOKEN 的进程 / `GET /workers/file` 的任意 `workers.view` 用户 | `exec-server.ts:1380-1406` `fsp.stat(filePath)`/`fsp.readFile(filePath)` 无 realpath 限定；`workers.controller.ts:159-229` 遍历所有 worker 试读（仅限制图片扩展名），可读到别的空间任务目录里的图片；`34` 篇 `:362-363` 自承该通道写明文凭据需网络隔离。 |

### P1（可跨空间观测 / 覆盖 / 复用上下文）

| # | 风险 | 链路与证据 |
|---|---|---|
| D6 | **SSE 跨空间帧下发**：`global` scope 登录即可订阅（`realtime.controller.ts:387-389`），前端 URL 恒 `scope=all`（`use-sse.ts:142`），`visibleTeamIds` 只按 `teamUserMember` 团队维度过滤、团队本身全局可见 → 等于无空间隔离；前端 `matchesScope` 只是 UI 过滤且 `task:` 下 `session.updated` 无条件放行（`:87`）、`team:` 下 `chat.message.new` 恒 true（`:98-105`），`sse-scope.spec.ts:59-63` 承认 `session.updated` 载荷「无法判定归属」。跨空间的会话状态、agent 状态帧会进到别的用户的浏览器（连接池仅按 token 分池，`use-sse.ts:281`）。 |
| D7 | **一成员一条全局会话跨群/跨空间复用记忆**：`memberKey = memberId @unique`（`schema.prisma:423`、`session-lifecycle.service.ts:280`），`SESSION_SCOPE=member` 时「跨群共享记忆」（`:230-233`）；成员是全局模板实例，A 空间的会话上下文会被 B 空间同成员复用；`ensureMemberSession` 的 `current*` 是本轮上下文、鉴权靠 `session_turns` 冻结（`schema.prisma:455-485`），但没有任何 workspace 条件。 |
| D8 | **工作目录无空间分区导致同名覆盖**：`<root>/tasks/<taskId>` / `<root>/teams/<teamId>`（`work-dir.util.ts:34-36`、`worker-dispatcher.ts:6336-6377`）在共享持久卷上；team-free-chat 团队目录被该团队所有用户共享；`.execution-config.json`（`exec-server.ts:2349-2353`）、`.opencode/plans/*.md`、`attachments/`（`:2615-2623`）同名互相覆盖；`normalizeFileRef` 把 worker 原始路径压成 `/uploads/<basename>`（`uploads.service.ts:268-278`），不同空间的同名产出物在归档层冲突。 |
| D9 | **产出物/任务 REST 缺成员校验**：`GET /tasks/:id`（`tasks.controller.ts:166-172`）、`GET /tasks/:id/artifacts`、`GET/POST/DELETE /artifacts/*`（`artifacts.controller.ts:76-159`）只有 `PermissionGuard` 权限点、无 `assertTeamMember`；持 `artifacts.view` 的用户按 id 即可读/写他人产出物（对比 `:162-186` 仅 teams 端点有校验）。 |
| D10 | **全局共享 WORKER_TOKEN + 全局 worker 池**：`isWorkerRegistered` 只查 Worker 表存在（`:1881-1887`），register/events 无 per-worker 密钥（heartbeat 才有 bcrypt 二次比对）；`GET /workers/register-token` 把共享 token 发给任何 `workers.view` 用户（`workers.controller.ts:129-139`）。任何拿到 token 的进程可注册 worker、上报事件、冒充任意 workerId；`assignWorker` 会把所有用户的任务派到同一批节点（`workers.service.ts:1001-1049`），是 D1/D2/D3 的放大条件。 |

### P2（配置/命名空间冲突，多用户下必然暴露）

| # | 风险 | 链路与证据 |
|---|---|---|
| D11 | **MCP Server / skills / tools / agent-policies 全局配置**：`mcpServer` 表无 owner（`schema.prisma:1104-1117`）、`findAll` 无过滤（`mcp-servers.service.ts:171-224`），注入到每个 worker **单份** `opencode.json`（`injector.ts:650-658,720-736`）；一个用户改 MCP 服务器/技能影响所有空间的所有会话。 |
| D12 | **ProviderTombstone / WorkerModelAvailability / Model 目录全局**：删 provider 全局生效（`models.service.ts:641-692`）；`@@unique([providerID,modelID])` 与 `teams.name @unique` 全局唯一，多空间无法各自配置同名 provider/团队。 |
| D13 | **ID 命名空间全局**：`s_<seq>`、`memberKey=memberId`、`teamMemberKey=teamId|teamMemberId`、`dedupKey=worker:<workerId>:<eventId>`、`scopeKey=task:<id>` 都没有空间前缀；后续分库/合并/迁移必然冲突；`17` 篇 `:445` 已把「多仓库并发凭证作用域隔离」列为未解决开放问题。 |
| D14 | **Swagger-MCP / vteam-api 同层旁路**：`platform-tool-permission.service.ts:34-35` 明确「有意不做安全边界」；`swagger-mcp.auth.ts:57-58` 同样按 `workerId` + `status:'running'` 全局取会话；当前恒 403（`:92-97`），一旦放开即是无空间维度的管理面 API 通道。 |

---

## (E) 改造建议

### E0 前置：把 workspaceId 变成运行时一等公民
1. 新增 `Workspace` 实体；`User` 增加默认 workspace 归属/成员关系；`team / task / session / message / artifact / worker / model / modelCredential / providerTombstone / workerModelAvailability / mcpServer / gitCredential / gitRepo / gitRepoGrant / realtimeEvent` 全部加 `workspaceId` 列，唯一键改为 `(workspaceId, ...)` 复合。
2. JWT 载荷增加 `workspaceId`（`jwt-payload.interface.ts`），所有 REST 入口统一从 `@CurrentUser()` 取 `workspaceId` 作为**强制过滤条件**（不能只靠前端传参）。`29` 篇「团队全局唯一」需改为「空间内唯一」。
3. 参考 `notes-data-model.md` / `notes-api-auth.md` 的最小列集，避免重复设计。

### E1 会话 / 事件 key 加空间前缀
- Session id 保持 `s_<seq>` 但列加 `workspaceId`；`memberKey` 唯一键改 `(workspaceId, memberId)`、`teamMemberKey` 改 `(workspaceId, teamId, teamMemberId)`；`TaskGroupInstance` 加 `workspaceId`。
- 平台侧维护 `(workspaceId, instanceRef) → Session` 唯一映射；`resolvePlatformSessionId / resolveSessionIdByInstanceRef / adoptNewInstanceRef` 所有 `findFirst/findMany` **强制带 `workspaceId`**；删除「该 worker 唯一 running 会话」启发式，改为事件 payload 必须携带 `workspaceId + platformSessionId`，ingress 先校验 `(workerId, workspaceId)` 绑定关系。
- 事件 `dedupKeyOf` 加 `ws:<workspaceId>:` 前缀；`message.part.delta` 的 streamKey 改为 `` `${workspaceId}|${channelId}|${agentId}|${sessionId}` ``；`scopeOf` 产出带空间的 scope。
- opencode 会话 id 仍由引擎生成，但**不得作为跨空间定位依据**；reply/abort/question 等所有 `sessionId` 反查都走 (workspaceId, instanceRef)。

### E2 MCP context 注入 workspaceId
- 把静态 `x-worker-id` 升级为**按会话签发的会话票据**（`x-workspace-id` + `x-session-ticket`），由 worker 在 `execute` 时按 session 注入 per-session MCP headers，或 MCP 请求携带 opencode `sessionID` 由 server 反查 workspaceId；服务端校验票据签名/有效期与 `(workerId, workspaceId)` 绑定。
- `PlatformMcpContext` 增加 `workspaceId`、`userId`、`sessionId`；`controller.toolsCall` 把 `workspaceId` 一并注入 `resolvedContext`。
- **删除 `resolveSessionFallback` 的「worker 最近会话」启发式**（`platform-mcp.service.ts:8439-8440,8485-8488`），双空上下文一律 fail-closed 要求显式票据；`assertWorkerTask` / `assertWorkerTeam` / `resolveExecContext` / `adoptOrphanedSession` 所有 `session.findFirst` 增加 `workspaceId`。
- 所有按 id 的查询改为 `where: { id, workspaceId }` 并校验归属：`chat_history`（频道）、`doclib`（artifact/artifactVersion）、`task_context`（task/team）、`submit_artifact`、`read_file`、`git_repos_list`；工具 zod schema 增加可选 `workspaceId`（仅服务端信任票据中的值，不接受模型自传）。
- `PlatformToolPermissionService` / `SwaggerMcpAuthService` 的 `callerId` 解析同样加 workspace 条件；`swagger-mcp` 若放开默认拒绝，必须同时补齐空间校验。

### E3 SSE / 事件 key 加空间维度
- `RealtimeScopeType` 扩 `workspace`；或把所有 key 统一加前缀 `ws:<workspaceId>:task:<id>` / `ws:<workspaceId>:channel:<id>` / `ws:<workspaceId>:team:<id>` / `ws:<workspaceId>:global`。
- `RealtimeEvent` 与 `realtime_events` 表加 `workspaceId` 列；`emit()` 时从资源归属解析 workspaceId 并打标；`scopeMatches` / `buildScopeWhereList` / `toTeamFilter` 全部 AND 上 `workspaceId === 当前 JWT 的 workspaceId`。
- `assertScopeAccess`：`global` 不再是「登录即可」，改为 `ws:<id>:global` 且必须校验调用者属于该空间；`resolveVisibleTeamIds` 改为「该空间内」的团队成员集。
- 前端 `use-sse.ts`：`scope=all` 改为 `scope=ws:<workspaceId>:all`（或后端按 token 强制注入，前端不可信）；连接池 key 改为 `` `${token}|${workspaceId}|all` ``；切换空间必须重建连接并清空 `lastId`；`matchesScope` 中 `session.updated` 无条件放行（`:87`）与 `team:` chat.message.new 恒 true（`:98-105`）改为按 payload 的 workspaceId 校验。

### E4 工作目录 / 文件按空间分区
- `taskDirOf(root, workspaceId, taskId)` → `<WORK_DIR>/workspaces/<workspaceId>/tasks/<taskId>`；`ensureTeamWorkDir` → `.../teams/<teamId>`；`plan-docs.service.ts`、`workerFileCandidates`、`resolveAgentWorkDir` 统一用同一函数。
- `resolveUploadDir(workspaceId)` → `uploads/<workspaceId>/`；静态服务按空间前缀挂载，并加 JWT/成员校验或签名 URL（不能继续 `useStaticAssets` 裸暴露）；`readUploadedFile` / `readFromArchive` / `normalizeFileRef` 增加 workspace 参数并校验 `base` 不含穿越；产出物 `contentRef/filePath` 存带空间前缀的 URL。
- worker `GET /file`：`fs.realpath(filePath)` 后必须落在 `workspaces/<workspaceId>/` 内（对比 `sensitive-command.ts:72-73` 已有同类「cwd 唯一合法根」实现可复用）；`GET /workers/file` 遍历时按目标空间过滤 worker。
- `POST /uploads` 的 `taskId` 必须校验 `(taskId, workspaceId)` 归属；`GET /tasks/:id`、`/artifacts/*` 补齐 `assertTeamMember` 等价的空间成员校验。

### E5 Worker 归属或共享策略（二选一，建议 A 起步）
- **方案 A（严格隔离，推荐）**：`Worker` 加 `workspaceId` + 每 worker 独立注册密钥（或 token 绑定 workspaceId / mTLS）；`assignWorker` 过滤 `where:{status:{not:OFFLINE}, workspaceId}`；`broadcastCommand` / `dispatchModelCredentials` / `dispatchGitCredentials` / `replayXxx` 只广播同空间 worker；`GET /workers/register-token` 按空间授权；`19` 篇「首次任意可用 worker」改为「空间内任意可用 worker」。
- **方案 B（共享池 + 强隔离）**：保留共享 worker，但每会话强制携带 `workspaceId + sessionTicket`；MCP/事件/文件/凭据全部按 workspace 过滤；worker 侧按 workspace 起多份隔离域（多 `XDG_DATA_HOME` / 多 opencode serve 实例 / 多 auth.json），Git creds 按 workspace 分文件或按请求签发短时临时凭证（`17` 篇 §5.1 的临时凭证思路）；浏览器 profile 的 scope 派生加 workspace 前缀。
- 两种方案都必须：**`WORKER_TOKEN` 改为 per-worker 密钥**，`isWorkerRegistered` 升级为 `(workerId, workspaceId, tokenHash)` 绑定校验，事件 payload 强制带 workspaceId。

### E6 凭据 / 模型 / MCP 配置按空间隔离
- `ModelCredential`：`@@unique([workspaceId, providerID])`；`ProviderTombstone` 主键 `(workspaceId, providerID)`；`WorkerModelAvailability` / `Model` 的 `@@unique([providerID,modelID])` 加 workspaceId；`dispatchCredentialState` / `replayModelCredentials` / `saveCredentialForProvider` 全部按 workspace 过滤并只下发到该空间 worker（或该空间的隔离域）。
- `GitCredential` / `GitRepo`：`@unique` 改 `(workspaceId, name)` / `(workspaceId, repoUrl)`；`GitRepoGrant` 改 `(workspaceId, agentId, repoId)`；`resolveAuthorizedRepoUrls` / `buildGitCredentialsPayload` / `gitRepos.findAll` / `gitCredentials.findAll` 按空间过滤；worker 侧 `.keta-git-creds.json` 按 workspace 分片或改按会话临时凭证。
- `McpServer`（及 skills / tools / agent-policies）加 `workspaceId`，`mcp-servers.findAll(query, workerId, workspaceId)` 按空间过滤；worker 注入时按 workspace 分目录/分配置，避免单份 `opencode.json` 混装。

### E7 落地顺序与验证
1. **P0 止血**：JWT 加 workspaceId + 所有 REST/MCP/ingress 查询的强制 `workspaceId` 兜底过滤；停用 `resolveSessionFallback` 启发式；`ingress` 事件强制带 workspaceId；uploads/`/file` 加归属与路径校验。
2. **P0 身份**：会话票据替代静态 `x-worker-id`；事件 key 与 session 反查加空间；`dedupKey` 加前缀。
3. **P1 资源**：凭据/worker/MCP 配置按空间隔离；workdir/uploads 分区；worker 归属（方案 A）。
4. **P2 通道**：SSE scope/DB 列/前端过滤；ID 命名空间统一。
5. **验证**：复用 `.design/multi-workspace/notes-empirical-probe.md` 的双账号实测方法，扩展为「双 workspace × 共享 worker」矩阵：跨空间 MCP `chat_history/doclib/task_context/submit_artifact`、事件回流串会话、凭据互影响、uploads 越权读、SSE 跨空间帧、同名文件覆盖；每条都要有 fail-closed 断言。

---

## 附：与其它分报告的衔接
- `notes-data-model.md`：workspaceId 列集 / 复合唯一键的最小改造集（本报告的 E0/E1/E6 依赖它）。
- `notes-api-auth.md`：JWT claim、Guard、越权 REST 清单（本报告 D9 与之重叠，建议合并整改）。
- `notes-empirical-probe.md`：已实测「两个用户看到完全相同的全局数据（teams/tasks/models/workers）」——正是本报告 A1「全局 worker 池 + 全局模型目录」的运行态证据。
- `notes-frontend-test.md`：前端无 currentWorkspace store（与本报告 A7「scope=all 恒全量订阅」互为因果）。
