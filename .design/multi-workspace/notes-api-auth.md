# 【后端 API 与鉴权层】多租户（workspace）隔离现状调研报告

> 范围：`server/src/`、`server/prisma/schema.prisma`、`.design/external-users/CONTRACT.md`、`.design/member-decouple/*`。只读分析，未修改任何文件。所有结论带 `文件:行号` 与代码片段。

---

## (A) 认证与鉴权现状

### A1. 登录方式
- **用户名 + 密码（bcrypt）**，无 OAuth/SSO/多因素。`auth.service.ts:109-144`：`login()` 先 `prisma.user.findUnique({where:{username}, include:{role:true}})`，校验 `enabled` 与 `bcrypt.compare`，再 `signTokens()`。
- `auth.controller.ts` 中 `register` / `login` / `refresh` / `forgot-password` / `reset-password` **全部 `@Public()`**（`:25/:32/:40/:48/:56`）；只有 `GET /auth/profile` 需 JWT（`:64-70`）。
- `register` 默认分配内置 `member` 角色、无项目（`auth.service.ts:54-107`）；`forgot-password` 直接把一次性 `resetToken` 返回给调用方（`:192-219`，内网手动传递，无邮件校验）。
- `main.ts:30` 全局前缀 `/api/v1`；JWT 密钥 `config.get('JWT_SECRET') ?? 'dev-secret'`（`auth.service.ts:251`、`jwt.strategy.ts:18`）。

### A2. JWT payload 字段 —— **无 workspaceId / tenantId**
`auth/interfaces/jwt-payload.interface.ts:4-11`：
```ts
export interface JwtPayload {
  sub: string;      // 用户主键 id（这就是唯一的「用户」信息）
  username: string;
  roleId: string;
  type: string;     // access | refresh
}
```
签发在 `auth.service.ts:257-264`：`{ sub, username, roleId, type }`。**没有 userId 独立字段（sub 即 userId）、没有 workspaceId、没有 tenantId、没有任何空间/归属声明。**

`jwt.strategy.ts:22-32` 的 `validate()` 把结果挂到 `req.user`：
```ts
return { id: payload.sub, username: payload.username,
         roleId: payload.roleId, tokenType: payload.type };
```
即 `AuthenticatedUser = { id, username, roleId, tokenType? }`（`common/decorators/current-user.decorator.ts:8-13`）。`@CurrentUser()`（`:20-27`）只是从 `req.user` 取出该对象，**不查库、不带任何空间上下文**。

### A3. Guard / Decorator 全链
| 组件 | 位置 | 判定内容 |
|---|---|---|
| `JwtAuthGuard`（全局 `APP_GUARD`） | `auth/guards/jwt-auth.guard.ts:17-45`、`auth.module.ts:31` | 仅校验 Bearer access token 有效；`@Public()` 放行。**不判归属** |
| `@Public()` | `auth/decorators/public.decorator.ts` | `SetMetadata(IS_PUBLIC_KEY,true)` |
| `AdminGuard` | `users/admin.guard.ts:29-60` | 用 `req.user.id` 查库 → `hasAdminPermission(role.permissions)` → 是/否放行 |
| `PermissionGuard` + `@RequirePermission('res.action')` | `common/guards/permission.guard.ts:51-121`、`common/decorators/require-permission.decorator.ts` | 仅判角色权限矩阵；`workerToken` 存在时直接 `return true`（`:67-71`） |
| `TeamMembershipGuard` | `common/guards/team-membership.guard.ts:44-79` | 校验 `teamUserMember` 有 `(teamId,userId)` 行；**无 `:id`/`:taskId` 参数时仅要求登录即放行**（`:58-63`） |
| `@CurrentUser()` | `common/decorators/current-user.decorator.ts` | 取 `req.user` |
| `WorkerTokenGuard` / `WorkerOrJwtGuard` | `workers/worker-token.guard.ts:37-52`、`worker-or-jwt.guard.ts:39-57` | X-Worker-Token 与用户 JWT **完全隔离**；worker 请求**无用户上下文** |

### A4. 角色体系（admin / member 两级 + 自定义角色）
- `schema.prisma:42-81`：`User` 只有 `id / username / passwordHash / displayName / email / roleId / enabled / resetToken*`，**无 workspaceId 外键**；`Role` 有 `permissions Json`、`scopes Json`、`isBuiltin`。
- `auth.constants.ts:18-21` 内置角色 `admin` / `member`。seed（`server/prisma/seed.ts:906-951`）：`admin = { all: true }`；`member` 为完整矩阵（agents/members/artifacts/chats/skills/tasks/workers/channels/teams 的 view/create/edit…）。
- **admin 判定口径**（单一事实来源 `users/admin-permission.ts:23-35`）：`permissions.all === true` 或 `permissions.users.manage === true`。`AdminGuard` 直接调用它（`admin.guard.ts:52`）；service 层另有 `isPlatformAdminByUserId()`（`:60-69`）供 skills/tools/memories/stats/usage 复用。
- **`scopes` 字段形同虚设**：`roles.service.ts:13` `DEFAULT_SCOPES = { global:false, projects:[], innerRoles:[] }` 只写库；全仓 grep `scopes` 在业务查询中**从未被用作过滤条件**（`roles.constants.ts` 的 `PERMISSION_RESOURCES` 里还有 `projects` 遗留命名）。

### A5. 数据模型层面根本没有 workspace/tenant
`server/prisma/schema.prisma` 共 **53 个 model**（`User/Role/Team/TeamMember/TeamUserMember/Member/Task/Session/ChatChannel/Message/Artifact/Agent/Skill/Tool/Model/Worker/GitRepo/McpServer/…`），**没有 `Workspace` / `Tenant` 表，任何业务表都没有 `workspaceId`/`tenantId` 列**。全仓 `grep -rni "workspaceid|tenantid|workspace|tenant" server/src --include=*.ts` 仅命中测试里 `/data/workspace/tasks/...` 这类磁盘路径字符串，零命中标识符。`PrismaService`（`prisma/prisma.service.ts`）是裸 `PrismaClient`，**无 `$use` 中间件、无 APP_INTERCEPTOR、无 AsyncLocalStorage/CLS/请求级 context**。

---

## (B) 结论：当前是否有任何「数据归属」层面的过滤

**没有。** 精确地说：

1. **零 workspace / 租户 / 「每个用户只拥有自己的数据」的隔离**：JWT、schema、guard、service 四层均无该概念。
2. `req.user.id` **从未被用于业务实体的查询过滤**。全仓 `where: { userId }` 命中全部是查 `teamUserMember` 表以**推导可见团队 id 集合**（如 `tasks.controller.ts:108-118`、`chat.service.ts:249-259`、`external-users.service.ts:475-487`、`realtime.controller.ts:440-447`、`conversations.service.ts:44`），或查 `user` 表自身（`auth.service.ts:149`）。**没有任何一处 `where: { createdBy: userId }` / `ownerId`**——虽然 `Team.createdBy`、`Task.createdBy`、`Member.createdBy`、`Agent.createdBy`、`Issue.createdBy`、`GitRepo.createdBy` 等列存在（schema `:103/:289/:345/:858/:791/:1061`），但只写入、从不作为过滤条件。
3. 现存的两类「过滤」都**不是归属隔离**：
   - **团队成员可见性**（`team_user_members`）：`tasks.controller.ts:91-146`、`chat.service.ts:223-309`、`issues.service.ts:349-389`、`external-users.service.ts:117-158`、`stats.service.ts:978-998`、`usage.service.ts:116-138`、SSE `realtime.controller.ts:382-447`。语义是「被加进同一团队的用户共享该团队全部数据」，是**共享**而非「私有空间」；且它是**按团队**而非按用户/空间。
   - **admin/member 的 enabled 可见性**：`skills.service.ts:139-163`、`tools.service.ts:75-111` 用 `viewer.id` 只判断「是否 admin」来决定非 admin 强制 `enabled=true`，与「这条数据是谁的」无关。
4. **`AdminGuard` / `PermissionGuard` / `AdminPermission` 确认只做「是否 admin / 是否有权限点」判断，无任何数据归属判断**（`admin.guard.ts:52-59`、`permission.guard.ts:94-120`、`admin-permission.ts:23-35`）。

---

## (C) 具体证据清单（controller 方法 + 行号 + 查询代码片段）

以下都是**全表查询 / 无 userId/workspaceId 过滤**的典型模式（远超 6 个）：

1. **`models.controller.ts:46-48` `findAll()`** → `models.service.ts:144-194`
```ts
const where: Prisma.ModelWhereInput = {
  enabled: ..., providerID: ..., modelID: ..., name: ..., providerType: ...,
  workerAvailabilities: ... };   // 144-160，无用户/空间维度
const [total, rows] = await this.prisma.$transaction([
  this.prisma.model.count({ where }),
  this.prisma.model.findMany({ where, orderBy:..., skip:..., take:... }),  // 182-190
]);
```
2. **`agents.controller.ts:46-48` `findAll()`** → `agents.service.ts:147-168`
```ts
const where = query.type ? { type:{equals:query.type} } : { type:{not:'system'} };
this.prisma.agent.findMany({ where, include: AGENT_INCLUDE, ... });  // 156-162
```
3. **`teams.controller.ts:46-48` `findAll()`** → `teams.service.ts:420-429`
```ts
const where: any = {};
if (query.name?.trim()) where.name = { contains: query.name.trim() };
this.prisma.team.findMany({ where, include:{members:..., userMembers:...} });  // 429-
```
（注意：`create(user.id, dto)` 在 `:38-40` 用 user.id 只作 `createdBy` 写入，`teams.service.ts:233`，不是过滤。）
4. **`members.controller.ts:42-44` `findAll()`** → `members.service.ts:78-101`
```ts
const where: Record<string, unknown> = {};
if (query.status) where.status = ...; if (query.roleId) where.defaultRoleId = ...;
if (query.keyword) where.OR = [...];
this.prisma.member.findMany({ where, include: MEMBER_INCLUDE, ... });  // 94-100
```
5. **`workers.controller.ts:119-121` `findAll()`** → `workers.service.ts:1151-1175`：`$queryRawUnsafe` 直接 `SELECT t.id, t.name, ... FROM workers t`，**裸 SQL 全表**，连 where 都没有。
6. **`mcp-servers.controller.ts:48-51` `findAll()`** → `mcp-servers.service.ts:171-188`
```ts
const where: Prisma.McpServerWhereInput = { type:..., enabled:..., name:... };
this.prisma.mcpServer.findMany({ where, ... });  // 182-187
```
7. **`git-repos.controller.ts:41-43` `findAll()`** → `git-repos.service.ts:88-99`：一次并发拉 4 张全表
```ts
gitRepo.findMany({where:{revokedAt:null}}), gitCredential.findMany({where:{revokedAt:null}}),
gitRepoGrant.findMany({where:{revokedAt:null}}), agent.findMany({select:{id,name}})
```
8. **`notification-channels.controller.ts:130-133` `list()`**：`notificationChannel.findMany({orderBy:{createdAt:'desc'}})` —— 无 where，注释即写「已登录可见」。
9. **`message-channels.controller.ts:85-88` `list()`**：`messageChannel.findMany({orderBy:{createdAt:'desc'}})` —— 同上。
10. **`users.controller.ts:38-48` `findAll()`** → `users.service.ts:50-79`：`where` 只有 `search` 的 username/displayName OR，全量用户列表（虽挂 AdminGuard）。
11. **`roles.controller.ts:30-32`** → `roles.service.ts:20-24`：`role.findMany({orderBy:{createdAt:'asc'}})` 全表。
12. **`skills.controller.ts:78-84` / `tools.controller.ts:54-60`** 是「最像过滤」的陷阱：`viewer?.id` 传给 service 只用于 `isPlatformAdmin(viewer)`（`skills.service.ts:357-374`、`tools.service.ts:224-241`）决定 `where.enabled = true`，**不是 `where.createdBy=viewer.id`**。
13. **IDOR 对照证据**：`artifacts.controller.ts:61-68` `findByTeam()` 有 `await this.assertTeamMember(id, user.id)`，但同文件 `:76-82` `findByTask()`、`:88-94` `findOne()`、`:140-146` `restore()`、`:152-159` `remove()` **无成员/归属校验**，service 直接 `artifact.findMany({where:{taskId}})`（`artifacts.service.ts:532-539`）/ `findUnique({where:{id}})`（`:664`）。
14. **`tasks.controller.ts:91-146` `findAll()` 有 `teamUserMember` 过滤，但 `:166-172` `findOne()`、`:242-248` `update()`、`:272-282` `updateInstance()` 无 user/团队校验** → `tasks.service.ts:666-677` `findOne(id)` = `task.findUnique({where:{id}})`，`update(id,dto)` 只 `findUnique` 后改字段（`:680-695`）。`tasks.service.ts:229-246` 的 `create()` 才校验团队成员。
15. **`realtime.controller.ts:386-388`**：`if (scope.type === 'global') { continue; }` —— global 订阅登录即放行、无团队/空间过滤。
16. **`workers.controller.ts:129-139` `getRegisterToken()`**：只挂 `workers.view`（member 也有），直接返回 `WORKER_TOKEN` 明文。

---

## (D) 越权风险清单（非 admin 用户下的泄露 / 篡改 / IDOR）

前提：seed 的 `member` 角色本身就有 `agents/members/artifacts/chats/tasks/workers/teams.view=true` 与大量 create/edit（`seed.ts:921-938`），因此以下接口对**普通 member 即可达**。

**D1 · 全表数据泄露（水平越权读）**
- 任何登录用户可读**全部**模型目录、Provider 聚合、模型凭据状态（`models.controller.ts:42-77/:284-288`）、全部 Agent 配置与 prompt（`agents.controller.ts:42-48/:200-208`）、全部成员库（`members.controller.ts:38-52`）、全部团队及成员名册（`teams.controller.ts:42-59`，`teams.service.ts:448` 还 `include: userMembers`）、全部技能/工具/MCP 服务器/worker 节点（含 `capabilities` 里的执行端点）、全部 Git 仓库与授权关系、全部消息/通知渠道配置（`message-channels`/`notification-channels`）。
- `GET /workers/register-token`（`workers.controller.ts:129-139`）泄露 `WORKER_TOKEN` → 可冒充 worker 注册/拉取全量资源（配合 `WorkerOrJwtGuard` 的 `@Public()` 端点，如 `models/worker-catalog`、`skills/:id/content`、`tools`、`mcp-servers`）。
- `GET /stats/overview` 挂 AdminGuard 例外（`stats.controller.ts:48-49`），但 `GET /stats/teams/:teamId`）只需是团队成员（`stats.service.ts:978-998`）——**被拉进任一团队即可看该团队经营数据**。

**D2 · IDOR 越权读/写（按 :id 无归属校验）**
- `GET/PATCH/DELETE /tasks/:id`、`/tasks/:id/team`、`/tasks/:id/instances/:instanceId`、`/tasks/:id/plan-docs`（`tasks.controller.ts:166-282`）——改/删他人任务、写入他人任务目录。
- `GET /artifacts/:id`、`/artifacts/:id/versions/:version`、`POST /artifacts/:id/restore`、`DELETE /artifacts/:id`、`GET /tasks/:id/artifacts`（`artifacts.controller.ts:76-159`）——读他人产出物全文并篡改/删除。
- `GET/PATCH/DELETE /agents/:id`、`POST /agents/:id/clone`（`agents.controller.ts:134-154/:200-208`）——改/删/克隆他人 Agent（含 template）。
- `PATCH/DELETE /members/:id`、`/members/:id/reset-session`、`/members/:id/clone`（`members.controller.ts:62-84/:94-100/:125-131`）。
- `PATCH/DELETE /teams/:id`、`/teams/:id/members/*`、`/teams/:id/users`、`/teams/:id/reset-sessions`（`teams.controller.ts:61-159`）——**可把自己或他人加进任意团队**（`POST /teams/:id/users`），一旦成为成员就拿到该团队全部任务/群聊/SSE 数据，是横向提权的跳板。
- `GET/PATCH/DELETE /models/:id`、`/mcp-servers/:id`、`/git-repos/:id` 等同理（写操作多挂 AdminGuard，但**读详情无归属**）。
- `questions.controller.ts:48-61` 的 `findAll` 仅在传了 `taskId`/`teamId` 且 `user?.id` 存在时才校验成员，**两者都不传则直接 `findAll({taskId,teamId,status})` 全量返回**（`:60`）。

**D3 · 实时通道**
- SSE `?scope=global`（缺省）**登录即订阅全局事件、无过滤**（`realtime.controller.ts:331-333/:386-388`）；`?since=` 历史补拉 `getEventsSince(since, parsedScopes, null)`（`realtime.controller.ts:237-241`）对 global 无团队过滤。
- `scope=all` 虽有 `resolveVisibleTeamIds`（`:130-132/:440-447`）+ `realtime.service.ts` 的 `teamFilter`（`:563-580`），但仍是**团队共享**语义，且 `global` 类事件（`teamId=null`）在 `scope=all` 下被 `teamFilter` 一律不放行，语义不一致。
- worker token 通道（`WorkerOrJwtGuard`）**无用户上下文**，`PermissionGuard` 直接 `return true`（`permission.guard.ts:67-71`），跨空间读取无门。

**D4 · 认证层自身**
- `@Public()` 的 `register` 可自助注册 member 账号（`auth.controller.ts:25-30`），`forgot-password`/`reset-password` 返回一次性 token（`:48-62`），多用户场景下是账号枚举/接管面。

---

## (E) 改造建议：最小改动方案

### E1. 先补数据模型与上下文（必须，无法绕过）
1. 新增 `Workspace` 表 + `User.workspaceId`（或 `WorkspaceMember` 关联表，支持一人多空间）；**所有业务表加 `workspaceId` 列**（ Team/Member/Agent/Task/Session/ChatChannel/Message/Artifact/Issue/Skill/Tool/Model/Worker/McpServer/GitRepo/NotificationChannel/MessageChannel/RealtimeEvent/ModelUsage …）。全部走 expand-contract 迁移 + 历史数据回填到「admin 的默认 workspace」。
2. **JWT payload 增加 `workspaceId`**（`jwt-payload.interface.ts`、`auth.service.ts:257-264` 的 `signTokens`）；`jwt.strategy.ts:22-32` 的 `validate()` 把 `workspaceId` 挂进 `req.user`；扩展两处 `AuthenticatedUser`（`auth/interfaces/`、`common/decorators/current-user.decorator.ts:8-13`）。
3. 新增请求级上下文：`AsyncLocalStorage<{ workspaceId, userId }>`（或 Nest `APP_INTERCEPTOR` + `ClsModule`），由全局 interceptor 在 `JwtAuthGuard` 之后写入；新增装饰器 **`@CurrentWorkspace()`** 与 **`@WorkspaceId()`** 参数装饰器，**`@Public()` 与 worker 通道显式豁免/标注**。当前 `PrismaService` 无任何中间件（`prisma.service.ts`），这是唯一可低成本「全局注入」的落点。
4. 新增 **`WorkspaceGuard`**（全局，排在 JwtAuthGuard 之后）：校验 `req.user.workspaceId` 存在、workspace 未归档、用户属于该 workspace；对 `@Public()` 端点与 worker token 通道按白名单放行。

### E2. Prisma 中间件自动过滤（兜底，覆盖绝大多数列表）
在 `PrismaService` 用 `$extends`/`$use` 注册 query 中间件：对**带 workspaceId 的模型**自动
- `findMany/findFirst/count/groupBy/aggregate` → 合并 `where: { workspaceId: ctx.workspaceId }`（用 AND 保留原有 where，勿覆盖）；
- `create/createMany/upsert` → 自动写入 `workspaceId`（DTO 传入的一律忽略/校验一致，防伪造）；
- `update/delete/updateMany/deleteMany` → 把 `where` 叠加 workspaceId（防止按主键跨空间改删）；
- 白名单：`User/Role/Workspace` 自身、迁移/seed、worker 注册链路。
注意：`$queryRawUnsafe`（`workers.service.ts:1153`）、`groupBy`（`usage.service.ts:124`）、`message.groupBy`（external-users）**中间件覆盖不到**，必须手工补 `workspaceId` 条件。

### E3. 必须「显式校验归属」的接口（中间件覆盖不到的）
- 所有按 `:id` 的详情/改删：新增 **`OwnershipGuard`** 或在 service 首行 `assertWorkspace(id, workspaceId)`——尤其 `tasks.service.ts:666/680`、`artifacts.service.ts:664/701`、`agents.service.ts:174/336/384`、`members.service.ts`、`teams.service.ts`、`models/mcp-servers/git-repos` 的 findOne。
- `POST /teams/:id/users`、`/teams/:id/members`（`teams.controller.ts:85-136`）：加人即授权，必须校验目标 userId 同 workspace。
- 文件/非 DB 通道：`uploads`（静态 `/uploads/*`）、`artifacts` 的 `contentRef/filePath`、worker 透传端点（`agents/omo-config`、`tasks/:id/plan-docs`、`workers/file` 预览、`workers/worker-catalog`）——这些绕过 Prisma，需按 workspace 隔离目录 + 显式校验。
- `platform-mcp` / `swagger-mcp` / 入站 webhook（`message-inbound`）通道：无 `req.user`，需在 worker 执行上下文 `resolveExecContext` 里携带 workspaceId 并校验（契约 §6 的 `assertWorkerTask/assertWorkerTeam` 是现成挂点）。
- SSE：`RealtimeEvent` 加 workspaceId；`realtime.controller.ts:386-388` 的 **global scope 也要按 workspaceId 过滤**（历史补拉 `getEventsSince` 同步）；`resolveVisibleTeamIds`（`:440-447`）叠加 workspaceId。
- worker token：给 `WORKER_TOKEN` 绑定 workspaceId（或明确定义为平台级共享资源并豁免），`WorkerOrJwtGuard` 校验后把 workspaceId 写入请求上下文。

### E4. 权限模型与「团队」的关系（决策点，需产品确认）
现存 `team_user_members` 是「团队内共享」语义，与「每用户独立 workspace」正交。两种走法：
- **推荐（改动小）**：workspace 作为最外层硬边界（中间件强制），team_user_members 保留为 workspace **内部**的细粒度可见性；`AdminGuard`/`PermissionGuard` 语义不变，只在最前面加 WorkspaceGuard。member 的 `teams.edit` 加人能力要限制为同 workspace 用户。
- 若要求「连团队都私有」，则需把 `Team.createdBy`/`workspaceId` 纳入所有 team 相关查询，并把 `assertTeamMember` 系列（`chat/issues/stats/usage/external-users/artifacts`）统一改为 `workspaceId + teamId` 双条件。

### E5. 与已有设计的关系（针对任务 5 的结论）
- **`.design/external-users/CONTRACT.md`** 解决的是「企微/webhook 外部发送者沉淀为 ExternalUser 目录 + 只读消息回看」，可见性口径是 `teamUserMember → team_group 频道 → messages.external_user_id`（§2.1 :80-82，`external-users.service.ts:475-514`）。它**与 workspace 隔离无关**，但提供了可复用的「先算可见 teamIds 再过滤」模式；多租户后该口径须再加一层 workspaceId（否则跨空间外部用户仍会通过共享团队泄露）。契约 §0 :15 明确「不改动 auth/权限矩阵资源」，即它刻意绕开了鉴权层改造。
- **`.design/member-decouple/*`** 是「成员 × 群聊 M:N 解耦」（`notes-backend.md` 结论：`TeamMember` 拆执行身份/群归属/配置作用域），`notes-session-global.md:3` 明确「**一个成员全局只有一条 Session，跨群共享同一 sessionId，不做会话隔离**」——这与「每用户独立 workspace、会话隔离」**方向相反**，落地 workspace 时必须重新审视会话/记忆（`memories.service.ts` 的 team/role/global 可见范围）与 `ModelUsage` 记账维度。
- 两份设计里出现的「隔离」均指**群聊/任务上下文隔离**（`notes-docs.md:72`：「不建议改成纯 member_id，会把 A 群上下文串进 B 群，违背隔离边界」），**不是租户隔离**，不能复用为 workspace 方案。

---

## 一句话总结
当前是**「单库 + 全局 JWT 认证 + 角色权限矩阵 + 部分团队共享可见性」**，JWT 只有 `sub/username/roleId/type`，schema 无 workspace/tenant，`AdminGuard`/`PermissionGuard`/`@RequirePermission` 全部只判「是不是 admin / 有没有权限点」，**没有任何接口用 `req.user.id` 做「只属于自己的数据」过滤**（`createdBy` 只写不滤）。因此多用户上线即全量互见 + 大面积 IDOR。最小可行路径是：**JWT 加 workspaceId → 全局 WorkspaceGuard + AsyncLocalStorage 上下文 + `@CurrentWorkspace()` → Prisma query 中间件自动注入 workspaceId → 对 `:id`/文件/SSE/worker 通道补显式归属校验**。

（本报告全部基于实际文件内容，未修改任何文件。）
