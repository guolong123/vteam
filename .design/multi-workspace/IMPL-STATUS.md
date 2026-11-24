# 多工作空间隔离 · 实施状态（M1 完成）

> 分支 `feature/multi-workspace`（worktree：`.worktrees/multi-workspace`）
> 更新日期：2026-11-12

## 提交历史

```
0d8fe350 feat(workspace): 租户上下文与 Prisma 自动注入（M1 骨架）
403f0108 fix(security): 补资源归属校验与 MCP 回填 fail-closed（M0）
579a21bf feat(workspace): 多工作空间 schema 与 expand 迁移
```

> 说明：M1 的 auth/guard/workspaces 部分在后续提交中补入（见 `git log`）。

## 已交付能力

### 1. 数据层（迁移 `20261112120000_workspaces_expand`）

- 新表 `workspaces`（含 `is_system`）与 `workspace_members`（空间内角色 owner/admin/member）。
- 32 张资源表增加 `workspace_id`（NOT NULL DEFAULT `'ws_default'`）+ 关系 + 索引；唯一键改为 `(workspaceId, ...)` 复合键（团队名、成员名、Agent key、Skill/Tool/MCP 名、模型/provider、凭据、git 仓库、外部用户等）。
- `User.last_workspace_id`：记录最近使用的空间。
- expand 式迁移：建表 → 基础空间 → 加列 → 回填（平台行 → `ws_system`，存量 → `ws_default`）→ 索引 → 外键；**已在真实库克隆上验证**（0 空值、模板/内置资源归系统空间、漂移仅剩历史遗留项）。
- `dedupKey` / `memberKey` 保持全局唯一（值本身含全局唯一 id，跨空间不会撞），避免无谓改动。

### 2. 租户注入（`server/src/common/tenant/`）

- `tenant.constants.ts`：固定引导 id `ws_system` / `ws_default`、错误码、请求头 `x-workspace-id`。
- `tenant-models.ts`：模型策略注册表
  - `platform`：Agent / AgentRole / Skill / Tool / ExecutionPolicy / Model / McpServer → 读 `workspaceId IN (当前, ws_system)`
  - `private`：其余用户态模型 → 读 `workspaceId = 当前`
  - `none`：User / Role / Workspace / WorkspaceMember 及子表（TeamMember、SessionTurn、ArtifactVersion、绑定表…）
- `tenant-context.ts`：AsyncLocalStorage 上下文（`request` / `system` / `seed` 模式）。
- `tenant-prisma.ts`：纯函数注入实现（读过滤 / create 强制归属 / updateMany·deleteMany 叠加条件 / 跨空间只读拒写 / 系统空间写保护）。
- `tenant-unique.ts`：`tenantUniqueWhere(model, fields)` —— 复合唯一键 where 构造器（`findUnique` / `update` / `delete` / `upsert` 必须用它）。
- `tenant-context.interceptor.ts`：请求级 ALS 包裹。
- `PrismaService`：用 Prisma 6 `$extends` 的 `$allOperations` 接入（`$use` 在 6.19 已移除）。

> ⚠️ 已知边界：`findUnique` / `update` / `delete` 不做自动注入（唯一键 where 不允许追加非唯一字段），调用方必须用 `tenantUniqueWhere`；未登记模型与子表不注入。raw SQL / 文件 / SSE / MCP 通道不在本中间件覆盖范围（M2 处理）。

### 3. 认证与空间上下文

- JWT 增加 `wid`（当前空间）；`JwtStrategy` 回填 `req.user.workspaceId`。
- 登录 / 刷新 / profile 返回 `currentWorkspaceId` + `workspaces[]`（含系统空间，`isSystem=true`）。
- **`POST /auth/workspace`**：切换当前空间（校验成员关系 → 更新 `lastWorkspaceId` → 重签 access/refresh token）。
- 注册时自动创建个人空间（失败不阻断，首次登录自愈补建）。
- `WorkspaceGuard`（全局 APP_GUARD）：解析当前空间写入 `req.tenant`；平台管理员可用 `x-workspace-id` 跨空间**只读**；普通用户仅能访问自有空间，越权 403。
- `TenantContextInterceptor`（全局 APP_INTERCEPTOR）：把 `req.tenant` 写入 ALS。
- `@CurrentWorkspace()` 参数装饰器。

### 4. 空间管理 API（`/api/v1/workspaces`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workspaces` | 我的空间列表（系统空间置顶、`isSystem` 标记） |
| POST | `/workspaces` | 创建空间（调用者为 owner） |
| GET | `/workspaces/:id/members` | 成员列表（需可访问） |
| POST | `/workspaces/:id/members` | 邀请成员（owner/admin；owner 不可通过邀请产生） |
| DELETE | `/workspaces/:id/members/:userId` | 移除成员（owner/admin；owner 受保护；系统空间不可改） |

## 验证

```bash
cd server
npx tsc --noEmit -p tsconfig.json                  # 0 错误
npx jest --runInBand                               # 220 suites / 5018 passed（1 skipped）
```

运行时冒烟（临时 server + 已迁移/seed 的测试库）：

- 登录返回 `currentWorkspaceId=ws_default`，JWT 含 `wid`，`workspaces` 含 `ws_system` + `ws_default`。
- 默认空间 `GET /teams` = 1（示例团队）；`GET /agents` = 7（系统空间模板，验证 platform 读语义）。
- 切到 `ws_system`：`GET /teams` = 0、`GET /agents` = 7、`GET /skills` = 8。
- 管理员用 `x-workspace-id` 读他人空间 → 200；写 → 403 `TENANT_CROSS_WORKSPACE_WRITE_FORBIDDEN`。
- 普通用户用 `x-workspace-id` 访问非成员空间 → 403 `WORKSPACE_FORBIDDEN`。
- 邀请成员后，被邀请者用该空间 header 可读且能看到该空间团队；默认空间看不到其它空间的团队（隔离成立）。

迁移与 seed 在真实库克隆上验证：`migrate deploy` 通过、seed 两次运行均成功（幂等）、平台资源在 `ws_system`、团队/成员在 `ws_default`。

## M2-1 已实现（worker 归属 + 凭据下发收敛）

- **worker 注册携带空间**：`RegisterWorkerDto.workspaceId`（worker 侧 env `WORKSPACE_ID` 上报）。首次注册缺省落默认空间；**空间归属不可通过注册变更**（不一致 → 409 `WORKER_WORKSPACE_MISMATCH`，跨空间迁移留给管理员迁移端点）。
- **注册/心跳在 worker 空间上下文内执行**（`runWithTenant`）：后续模型合并、凭据回放、配置回放、心跳写入的数据库读写都被租户中间件收敛到该空间。
- **事件回流在 worker 空间上下文内执行**：`handleEvent` 先解析 `worker.workspaceId`（老数据回退默认空间）→ 包裹 `dispatchEventByType`，会话/消息/事件读写按空间过滤。
- **下发面收敛**（仅在有租户上下文时生效；启动期/定时任务保持历史全量语义）：
  - `broadcastCommand`：只查本空间在线 worker；
  - `assignWorker`：候选池 = 本空间 + 系统空间共享节点；
  - `dispatchModelCredentials`：定向 `targetWorkerIds` 先按空间过滤，拒绝发往他空间节点；
  - 注册/心跳内的凭据回放读 `ModelCredential` 时自动按 worker 空间过滤（不再全表）。
- worker 侧：`WORKSPACE_ID` env → 注册 payload；`worker/.env.example` 补说明。

> ⚠️ 仍存在的已知风险（下一轮处理）：`WORKER_TOKEN` 仍是全平台共享 token，持有者可注册到任意空间并上报任意 `workspaceId`；需要 per-worker 密钥或注册空间白名单。`assignWorker` 目前允许用户空间任务落到系统共享节点，但共享节点只能使用系统凭据的派发校验尚未强制（需结合模型/凭据归属判断）。

## M2-2 已实现（MCP 上下文 + SSE 空间隔离）

- **MCP 工具调用注入空间**：`PlatformMcpController` 用 `x-worker-id` 解析 worker 归属空间，把整个 `dispatch`（initialize/tools/list/tools/call）包在该空间租户上下文内——工具 handler 内的 Prisma 读写（`assertWorkerTask/Team`、`chat_history`、`doclib`、`task_context`、`submit_artifact` 等）自动收敛到该空间；未携带/未注册 workerId 回落默认空间（保持旧行为可用）。
- **SSE 事件带空间**：`RealtimeEvent` 增加 `workspaceId` 内存字段并在落库时写入（emit 时取租户上下文，无上下文回落默认空间）；`subscribe(..., workspaceId)` 只下发连接所属空间的事件；`getEventsSince(..., workspaceId)` 在 SQL 条件里加 `workspaceId`。
- **SSE 连接绑定空间**：`GET /events` 的 `authenticate` 从 JWT `wid` 解析连接空间（缺省默认空间），实时帧与断线补拉都按该空间过滤。
- 新增测试：emit 归属/默认回退、订阅过滤（他空间事件丢弃）、补拉 where 带空间、MCP handler 内 ALS 可见空间、未注册 worker 回落默认空间。

## M2-4 已实现（资源空间迁移 + 审计）

- **审计表** `workspace_relocations`（资源类型/ID、源空间、目标空间、原因、操作人、时间）+ 迁移 `20261112130000_workspace_relocations`；只存 id 串软关联，不建外键。
- **迁移端点**（仅平台管理员，controller 挂 `AdminGuard`）：
  - `POST /workspaces/relocations`：`{resourceType, resourceId, targetWorkspaceId, reason?}`
  - `GET /workspaces/relocations?limit=`：审计列表（最近优先）
- **资源白名单**（`RELOCATABLE_RESOURCES`）：Agent / 岗位角色 / 技能 / 工具 / 执行策略 / 模型目录条目 / 模型凭据 / MCP Server / Git 仓库 / Git 凭据 / Worker。**团队、任务、会话、成员、消息、产出物等业务数据不可迁移**（返回 400）。
- **迁移语义**：目标 `ws_system` = 发布为平台共享；从系统空间移出 = 回收共享。全程在 system 模式执行（显式校验 from/target，不做自动空间过滤），`updateMany({where:{id, workspaceId: from}})` 防并发/防跨空间误改。
- **校验**：
  - 目标空间存在且 active（否则 404）；
  - 资源存在（404）；同空间幂等返回 moved=false；
  - **唯一键冲突预检**（Agent.agentKey / Skill.name / Tool.action / Model(providerID,modelID) / ModelCredential(providerID) / McpServer.name / GitRepo.repoUrl / GitCredential.name / AgentRole.key）→ 409，不自动改名；
  - **跨空间引用检查**：Agent（席位/成员/会话）、岗位角色（席位/成员默认岗位）、技能（Agent 绑定）、执行策略（Agent 绑定）、模型（Agent/团队/成员/Worker 默认模型）、模型凭据（他空间同 provider 目录行）、Worker（会话/任务实例/团队·成员首选）、Git 仓库（授权）、Git 凭据（仓库引用）→ 仍被其它空间引用时 409 并列出引用类型；
  - 并发变更（updateMany count=0）→ 409。
- 冒烟验证（真实服务 + 迁移后测试库）：创建自定义 Agent → 迁移到 `ws_system`（moved=true + 审计行）→ 从系统空间回收到默认空间成功 → 普通成员调用返回 403 `FORBIDDEN_ADMIN`。
- 新增 9 个迁移单测。

## M2-3 已实现（上传文件按空间分区）

- **落盘分区**：新上传/归档文件写 `<UPLOAD_DIR>/workspaces/<workspaceId>/`（workspace 段经安全清洗，非法字符替换、空值回落 default）；multer destination 从 `req.tenant` 取空间，`saveTextFile`/`saveBufferFile` 从租户上下文取空间。
- **URL 带空间段**：返回 `/uploads/workspaces/<ws>/<file>`；静态挂载点不变，存量 `/uploads/<file>` 继续可访问（迁移期兼容）。
- **读取收口**：`readUploadedFile` 解析 `/uploads/...` 相对路径并限制在根目录内（防穿越）；**跨空间读**（请求空间 ≠ 路径空间）→ 403 `UPLOAD_WORKSPACE_MISMATCH`；存量无空间段文件仍可读。
- `normalizeFileRef` 在上下文内把 worker 裸路径映射到本空间 URL；`describeFileRef` 按空间路径取文件大小。
- 新增 7 个分区单测（目录清洗、URL/相对路径、上下文落盘、跨空间 403、本空间/存量可读、裸路径映射）。

## M2-5 已实现（工作目录空间化 + worker 文件路径加固）— **M2 完成**

- **工作目录空间化**（`work-dir.util.ts`）：默认空间（`ws_default`）或未指定 → 保持历史布局 `<WORK_DIR>/tasks|teams/<id>`（存量任务目录零迁移、零回归）；**非默认空间** → `<WORK_DIR>/workspaces/<ws>/tasks|teams/<id>`。workspace 段经安全清洗（防穿越）。
- `worker-dispatcher.resolveAgentWorkDir`：按任务/团队的 `workspaceId`（权威归属）解析目录；`plan-docs`/`plan-archive` 改用 `resolveTaskDirectory`（查任务空间；DB 异常回落旧布局，保持列表 degraded 语义）。
- **worker `GET /file` 加固**：`realpath` 解析后只允许读取 `workDir` 与 `os.tmpdir()` 之内的文件，越界 → 403（阻断用绝对路径读取 worker 上任意文件）；读取使用 realpath 结果，防符号链接绕过。
- 测试：work-dir 4 例 + plan-docs 空间解析 + worker `/file` 根内 200 / 越界 403；server **222 suites / 5049 passed**、worker **48 suites / 1436 passed**，两侧 tsc 0 错误。

## M3-1 已实现（前端空间核心：状态 / 切换器 / 空间管理页）

- **authStore**：`User` 增加 `currentWorkspaceId` / `workspaces[]`；新增 `switchWorkspace(workspaceId)`（POST /auth/workspace → 换 token + user 并重排主动续期）。
- **顶栏切换器** `WorkspaceSwitcher`：列出可切换空间（系统空间不作为可切换项，仅显示「平台资源只读」提示）；单空间时只显示当前空间名；切换后 AppShell 执行 `queryClient.clear()` + `router.refresh()`。
- **旧登录态自愈**：持久化 user 缺空间字段时，水合后拉一次 `/auth/profile` 补全。
- **SSE 连接池 key 加入空间**（`${token}|${workspaceId}|all`）：切换空间（token 重签 + wid 变化）必须重建连接，避免按旧空间过滤事件。
- **导航**：新增「工作空间」入口（`/workspaces`，所有登录用户可见），顶栏标题/面包屑/命令面板路径同步。
- **工作空间管理页**（`app/(main)/workspaces/page.tsx`）：我的空间列表（当前标记/角色/平台空间只读）、切换、创建空间；成员管理（owner/admin 可邀请/移除，owner 受保护）；平台管理员可见「资源空间迁移」表单（发布共享到 `ws_system` / 回收）+ 最近迁移审计。
- 验证：`npx tsc --noEmit` 0 错误；`eslint` 0 错误 0 警告；`next build` 通过（新增 `/workspaces` 静态页）。

## M3-2 已实现（跨空间只读视图 + 多账号 E2E）— **M3 完成**

- **管理员跨空间只读**：`api.ts` 支持临时 `X-Workspace-Id` 覆盖（`setWorkspaceOverride`），authStore 增加 `viewWorkspace` 状态（登录/切换空间/登出自动清除）；AppShell 顶部黄色横幅「正在以管理员身份查看『X』（只读）· 写操作会被拒绝」+ 退出按钮；工作空间页每个他人空间提供「管理员只读查看」入口。
- 后端补充：`WorkspacesService.assertAccessibleOrAdminRead`（平台管理员可只读查看他人空间成员列表；写操作仍拒绝），`listMembers` 使用该口径。
- **多账号 E2E（API 级，Playwright request）**：`web/e2e/workspace-isolation.api.spec.ts` + `playwright.api.config.ts`
  - 两空间团队互不可见；普通用户伪造 `X-Workspace-Id` → 403；管理员跨空间可读、写 → 403；管理员只读查看他人空间成员；邀请后可见性变化；Agent 迁移到 `ws_system` 后其它空间可见 + 审计可查；非管理员迁移 → 403。
  - 结果：**1 passed**（连接本地测试后端 `13100`，库已迁移+seed）。
- **多账号 UI E2E（真实浏览器）**：`web/e2e/workspace-ui.spec.ts` + `playwright.workspace-ui.config.ts`
  - 管理员：空间切换器可见（多空间）、工作空间页/迁移面板可见、跨空间只读横幅出现/退出正常、顶栏切换空间后当前空间值变化；
  - 普通成员：工作空间页可用、看不到管理员迁移面板；
  - 结果：**3 passed**（chromium/chrome，web dev 3011 代理后端 13100）。

## 最终验证汇总

| 项目 | 结果 |
|---|---|
| server `tsc --noEmit` | 0 错误 |
| server `jest --runInBand` | **222 suites / 5049 passed**（1 skipped） |
| worker `tsc` / `jest` | 0 错误 / **48 suites / 1436 passed** |
| web `tsc --noEmit` | 0 错误 |
| web `eslint`（改动文件） | 0 错误 0 警告 |
| web `next build` | 通过（含 `/workspaces`） |
| 迁移（真实库克隆） | `migrate deploy` 通过，seed 幂等；0 空值 |
| API 级多账号 E2E | 1 passed |
| 浏览器 UI E2E | 3 passed |

## 本地 Docker Compose 启动测试（2026-11-12）

独立测试栈（不影响主栈 `vteam-compose-*`）：项目名 `vteam-ws`、独立容器名/端口/卷（覆盖文件 `docker-compose.ws-test.yml`）。

```bash
cp .env.ws-test.local.example .env.ws-test.local   # 或手写 MYSQL_ROOT_PASSWORD / MODEL_CREDENTIAL_KEY 等
BUILDX_CONFIG=$PWD/.buildx-ws   docker compose -p vteam-ws --env-file .env.ws-test.local \
    -f docker-compose.yml -f docker-compose.ws-test.yml up -d --build
```

- 端口：web `13201`、API `13200`、worker `14200/14900`（主栈 13000/13001/14000/14848 不动）。
- 说明：受文件沙箱限制，`BUILDX_CONFIG` 必须指向工作区内目录（默认 `~/.docker/buildx` 不可写）。
- 首次构建期间曾因构建资源竞争导致 MySQL 在历史迁移 `20261009010000_memory_refcount` 处崩溃一次（自动重启但 Prisma 留下失败记录）。`down -v` 清空后重跑一次成功；**迁移与 seed 本身没有问题**。
- 验证结果（全新库）：
  - `31 migrations` 全部应用（含 `20261112120000_workspaces_expand`、`20261112130000_workspace_relocations`），seed 成功；
  - `workspaces=2`（ws_system/ws_default）；模板 Agent 8 行在 `ws_system`、示例团队在 `ws_default`、skills 8 / tools 37 在系统空间；`workspace_relocations` 表存在；
  - 4 容器 healthy；worker 以 `w_ws_test` 注册 online 且 `workspace_id=ws_default`（注入 8 skills / 1 MCP server）；
  - API 冒烟：登录返回 `currentWorkspaceId` + 空间列表、默认空间 teams=1/agents=7/skills=8、切系统空间 teams=0/agents=7、上传文件落盘 `/app/uploads/workspaces/<ws>/` 且 URL 带空间段可访问；
  - **对 compose 栈运行：API 多账号 E2E 1 passed；浏览器 UI E2E 3 passed**。

## 隔离测试套件（2026-11-12）

- 新增 `web/e2e/workspace-api-helpers.ts` + `web/e2e/workspace-isolation.resources.api.spec.ts`：16 个隔离矩阵用例（空间/列表/按 id 越权/成员库/Worker/平台资源/上传/邀请移除/迁移权限与审计）。
- 用例设计文档：`.design/multi-workspace/test-cases.md`（WS/RES/FILE/CRED/RUN/SHARE/UI 分组，标注自动化位置与已知边界）。
- 对 compose 测试栈执行：API **17 passed**（含基础链路 1）、浏览器 UI **3 passed**；server 全量 **222 suites / 5056 passed**。
- 本轮测试暴露并修复 3 个缺口：worker 列表原生 SQL 未按空间过滤、`findUnique` 按 id 跨空间读（新增返回值兜底）、成员会话状态查询用了已废弃的复合键（500）。

## 用户视角功能验收（2026-11-12，真实浏览器）

- 新增 `web/e2e/workspace-functional.ui.spec.ts` + `playwright.functional.config.ts`：真实登录/建空间/切空间/建团队/邀请/只读/迁移/登出，以及普通成员隔离与切换，共 2 条路径，**全通过**。
- 报告：`.design/multi-workspace/test-report-ui.md`；逐步截图 15 张：`.design/multi-workspace/shots/functional/`。
- 走查修复 8 个用户可感知问题，关键 3 个：
  1. 管理员新增「全部空间」区块 + `GET /workspaces/all`（最新优先），可对任一空间发起只读查看；
  2. 只读横幅移到顶栏下方整宽显示（原布局被挤乱）；只读视图持久化，刷新后请求头不丢；
  3. 创建空间后自动切换并展开置顶 + 右下角浮层提示；当前空间概览/角色中文化。
- 回归：server 222 suites / 5056 passed、web tsc/eslint/build OK、API 17 passed、UI 3 passed。

## 真实页面 CRUD 验收（2026-11-13）

- 新增 `e2e/workspace-crud.ui.spec.ts`（10 条）：角色、技能、消息/通知渠道、MCP Server、
  Git 凭证+仓库、成员、Agent、Provider、Agent 岗位、团队，均通过页面操作完成「新建/编辑/删除」。
- 每轮新建独立空间；截图 `.design/multi-workspace/shots/crud-ui/`。
- **UI 测试发现真实问题**：MCP 保存后自动同步失败（不可达地址）会让技能/工具页整页变成
  「加载技能/工具列表失败」，需手动重试。修复：`loadError` 在已有缓存数据时不再盖住列表，
  仅首次加载无数据时才显示整页错误。
- 结果：页面 CRUD 10 passed、原 UI 3 passed、功能验收 8 passed、API 44 passed、server 5091 passed。
- 报告：`test-report-crud-ui.md`。

## 平台资源 CRUD 全面体检（2026-11-13）

- 新增 API 用例：`workspace-crud.platform.api.spec.ts`（10 条）+ `workspace-crud.workspace.api.spec.ts`（8 条），
  每个资源在独立新空间走「创建 → 读取 → 修改 → 删除/清理」。
- 覆盖：角色、岗位、Agent、执行策略、Provider/模型、技能、工具、MCP Server、Worker、上传、
  工作空间/成员、用户、团队/成员、Git 凭证/仓库、消息/通知渠道、任务、问题、私聊会话、记忆读取边界。
- 结果：API 全量 **44 passed**、功能验收 8 passed、UI 3 passed、server 全量 5091 passed；
  报告见 `test-report-crud.md`。
- 本轮真实缺陷：创建 Git 仓库 500（复合唯一键）已修复并回归（GIT-REPO-01）。
- 设计性限制（技能/工具无物理删除、任务无 DELETE、记忆仅 Agent 写入、用户无 DELETE、
  工作空间无改名/删除、Worker 在线不可删）已在报告列明。

## 修复：创建 Git 仓库 500（复合唯一键回归，2026-11-13）

- 现象：仓库管理点「创建并授权」→ `POST /api/v1/git-repos` 500 `Internal server error`。
- 根因：`GitReposService.create` 仍用 `gitRepo.findUnique({ where: { repoUrl } })` 查重，
  多工作空间后唯一键是 `(workspaceId, repoUrl)`，Prisma 直接拒绝（PrismaClientValidationError）。
- 修复：改用 `tenantUniqueWhere('GitRepo', { repoUrl })` 复合键（与凭证创建同口径）。
- 回归：新增 API `GIT-REPO-01`（新空间建凭证+建仓库 201、同空间重复 409、另一空间同 URL 可建），
  API 套件 26 passed；UI 真机创建仓库成功（截图 31）。
- 同类扫描：其余 findUnique 的 username/role.name 仍是全局唯一，无同类问题；GitCredential 已用复合键。

## 用户管理：编辑「所属空间」（2026-11-13）

- 用户列表：用户单元格显示当前空间徽章 + 加入空间数（后端 `/users` 返回 `lastWorkspaceId`
  + `workspaceMembers[]`）。
- 编辑用户弹窗新增「所属空间」：多选加入的空间 + 选择「当前空间」；保存走
  `PATCH /users/:id { workspaceIds, currentWorkspaceId }`：
  - 增/删 WorkspaceMember 成员关系（事务）；
  - 当前空间必须属于所选集合；
  - owner 空间不能直接移除（400 `USER_WORKSPACE_OWNER_REMOVE`，需先转移归属）；
  - 下次登录进入所选当前空间。
- 验证：单测 27 passed（新增 3 条空间同步/owner/invalid 用例）、API `USER-SPACE-PATCH-01`
  （25 passed）、浏览器功能验收第 8 条（编辑用户切空间，截图 29），全量 server 通过。

## 平台资源「所属空间」展示与创建目标提示（2026-11-13，含第二批资源）

- 第二批补齐：Agent 岗位（AgentRoleDto.workspaceId，内置岗位显示平台共享）、记忆（MemoryItem.workspaceId）、
  集成渠道/通知渠道（message/notification channels 行 workspaceId + 创建目标提示）。
- 执行策略无独立列表页（在 Agent 配置内编辑），其归属由所在 Agent 承载；Agent 列表已显示空间。
- 至此带空间展示的资源：Worker / Provider / 技能 / 工具 / MCP Server / Git 仓库 / Agent /
  Agent 岗位 / 记忆 / 集成渠道 / 通知渠道。

## 平台资源「所属空间」展示与创建目标提示（2026-11-13）

- 后端列表补齐 `workspaceId`：Worker（原生 SQL/视图）、Model Provider（ProviderSummary）、
  Agent 列表、Git 仓库视图；Skill/Tool/MCP 原本返回整行已含。
- 前端统一 `SpaceBadge`（平台共享 / 当前空间 / 其他空间名）与 `CreateSpaceHint`
  （「创建到：<当前空间>」，平台管理员附「顶栏切换空间可换目标；需全空间共享请创建后迁移到平台空间」）。
- 已接入页面：Worker 列表、模型管理 Provider 列表、技能/工具/MCP 列表、仓库管理、Agent 列表；
  创建入口（新增 Provider / 技能工具 / 新增仓库 / 新建自定义 Agent）均显示创建目标。
- 说明：创建始终落在「当前空间」（租户中间件强制写归属）；切换顶栏空间即换目标空间；
  平台共享需创建后在「工作空间」页迁移到平台空间（管理员跨空间写仍只读，符合隔离设计）。
- 验证：浏览器功能验收新增第 6 条路径（Provider 显示「当前空间」、技能显示「平台共享」+ 创建提示），
  截图 25/26；功能验收 6 passed、API 24 passed、UI 3 passed。

## 正常产品流程验证 + 3 个链路缺陷修复（2026-11-13）

- 按真实用户路径：单令牌安装 worker → Web 建团队（按岗位新建，2 成员）→ 设置成员模型
  `local-qwen/qwen3.8-27b` → 团队群发消息 → 项目经理 Agent 在群聊回复「收到」（截图 28）。
- 该流程暴露并修复：
  1. 新空间建团队 500：`autoCreateMemberForSeat` 用旧 `member.findUnique({name})`，与
     多空间 `(workspaceId,name)` 唯一键不符 → 改空间内 `findFirst`；新增 `TEAM-MEMBER-01` 回归。
  2. 控制面派发 401：server→worker 统一用全局 `WORKER_TOKEN`，worker 用空间注册令牌 →
     新增 `Worker.dispatchTokenRef`（AES-256-GCM，注册时写入）+ WorkerClient 按 workerId
     解密并覆盖 `X-Worker-Token`（旧数据回退全局；迁移 `20261113130000_worker_dispatch_token`）。
  3. worker 资源注入 401：`WorkerOrJwtGuard`/`JwtAuthGuard` 只认全局 token；skills 读取仍 `@Public`
     → 两个守卫都接受空间注册令牌；skills 读取改 `@WorkerOrJwtAllowed()` 注入租户上下文。
- 修复后注入 `8 skills / 13 mcp servers`，群聊真实回复成功；server 全量 223 suites/5088 passed；
  API 24 passed；功能验收 5 passed；UI 3 passed。

## 真实模型端到端验证（qwen3.8-27b，2026-11-13）

- 单令牌安装 worker → 配置 `local-qwen` provider（`baseUrl=http://192.168.10.10:18020/v1`）+ 凭据
  → worker 收到 `providerKeys/providerConfigs` 写入隔离配置域并热加载 → 通过 worker 会话端点真实调用
  `qwen3.8-27b`，返回 `pong`（`step-finish.reason=stop`，tokens input=6432/output=4/reasoning=27）。
- 隔离复核：默认空间 worker 未收到该 provider/凭据；该空间 worker 列表只有本节点。
- 报告：`.design/multi-workspace/test-report-qwen-e2e.md`；截图 25/26。

## Worker 安装：单令牌（空间注册令牌）（2026-11-13）

把原「全局 X_WORKER_TOKEN + WORKSPACE_ID + WORKER_JOIN_TOKEN」合并为**一个空间注册令牌**：

- 管理员在空间内签发 `wst_<hex>`（`POST /workspaces/:id/worker-token`，owner/admin 或平台管理员），
  DB 仅存 SHA-256；安装命令里只有 `-e X_WORKER_TOKEN=wst_...`（curl 为 `--token wst_...`），
  不再出现 `WORKSPACE_ID` / `WORKER_JOIN_TOKEN`；令牌本身由服务端反查所属空间。
- `WorkerTokenGuard`：接受「全局 token（旧模式兼容）」或「空间注册令牌」。空间令牌会解析出空间，
  并校验请求中出现的 workerId 必须属于该空间（跨空间 → 403 `WORKER_SPACE_MISMATCH`；首次注册
  时 worker 尚不存在 → 放行由 register 绑定）；运行期心跳同样用该令牌鉴权。
- `WorkersService.register`：空间令牌直接决定归属空间；若同时传 WORKSPACE_ID 必须一致，
  否则 409；旧模式（全局 token + WORKSPACE_ID）仍强制 `WORKER_JOIN_TOKEN`。
- 安装向导：工作空间选择 + 「空间注册令牌」自动签发/重新生成（默认空间同样适用）；
  curl/docker 命令均只带一个 token。空间管理员可自助签发本空间令牌，不再依赖平台全局凭据。
- 验证：单测 guard 10 例 + register 4 例；API `TOKEN-SINGLE-01`（单令牌注册→归属反查→心跳鉴权→
  跨空间 403）通过；浏览器功能验收第 5 条路径（单令牌 curl/docker 命令）；server 223 suites/
  5088 passed；worker 1436 passed；web tsc/eslint/build OK。

## 真实 Worker 安装 · 凭据隔离验证（2026-11-13）

- 用两个真实 worker 容器（当前分支重建镜像）分别通过 `WORKSPACE_ID + WORKER_JOIN_TOKEN` 注册到两个空间；
  各自容器内 `auth.json` 只有本空间 provider key；同一 provider 不同 key 互不串、B 独有 provider 不出现在 A；
  key 轮换/吊销只影响所属空间；worker 列表/详情跨空间不可见。
- 报告：`.design/multi-workspace/test-report-worker-credentials.md`；截图 `shots/functional/22-凭证验证-空间B模型页.png`。
- 首次启动发现旧镜像不含加入码上报导致 403 → 重建 worker 镜像后通过（真实安装链路验证了加入码强制校验）。

## 角色分层：平台管理员 vs 空间管理员（2026-11-13）

**产品口径**：
- **平台管理员**：不受空间限制（跨空间只读、迁移、账号/角色/平台统计）。
- **空间管理员**（空间 owner/admin）：可在**本空间内**运营平台功能（模型/Worker/MCP/仓库/技能/工具/记忆/团队/Agent…），
  但**不能查看或管理其它空间**，也没有跨空间只读/迁移入口；系统空间只归平台管理员。
- 平台级资源域（users/roles/stats/platform.*）不对空间管理员兜底。

**后端**：
- 新增 `WorkspaceAdminGuard`（平台管理员 或 当前空间 owner/admin；系统空间仅平台管理员），
  替换模型/Worker 管理/MCP/仓库/记忆/协作指标等空间级管理端点上的 AdminGuard；
  账号、角色、平台统计、worker register-token 仍走 AdminGuard。
- `PermissionGuard` 增加空间管理员兜底：当前空间 owner/admin 可执行空间级资源的写操作
  （`users/roles/stats/platform.*` 除外；系统空间不兜底）。
- 修复双通道 GET（`@Public()` + WorkerOrJwtGuard）没有租户上下文导致跨空间泄漏：
  新增 `@WorkerOrJwtAllowed()` 标记，全局 JwtAuthGuard 校验 worker token 并标记；
  WorkspaceGuard 对 worker 通道按 `x-worker-id` 解析节点归属空间注入租户上下文。
- 新增 `joinToken` 相关无改动；本轮回归 server **223 suites / 5083 passed**。

**前端**：
- 角色文案区分：平台角色「平台管理员 / 平台成员」；空间角色「空间所有者 / 空间管理员 / 空间成员」。
- `canManageCurrentSpace()` 用于空间级管理按钮；跨空间只读/全部空间/迁移仍仅平台管理员可见。
- **修复登录态水合 TDZ**：`onRehydrateStorage` 同步执行时访问了下方的模块级 `let`（proactiveTimer）
  → ReferenceError → 水合 Promise 永久失败 → 硬刷新后路由/登录守卫全部失效（非平台管理员可直接停留 /system/*）。
  已把续期状态声明上移并加防御 catch；硬刷新后 `/stats`、`/system/*` 对成员正确重定向。

**验证**：API 新增 `ROLE-01`（空间管理员可管本空间、不能跨空间/平台级操作）、
`MCP-ISO-01`（JWT 与 worker 双通道列表均不串空间）；浏览器新增第 4 条路径
「空间管理员：可管本空间，但没有跨空间/平台级入口」（截图 19/20/21）。
API **22 passed**、功能验收 **4 passed**、UI **3 passed**。

## 新增：创建用户时选择工作空间（2026-11-13）

- 后端 `POST /users` 新增可选 `workspaceId` / `workspaceRole`（admin|member，缺省 member）：
  创建用户 + `WorkspaceMember` + `lastWorkspaceId` 同一事务落库，创建完成即可直接进入所选空间；
  系统空间不可加入（`USER_WORKSPACE_SYSTEM_NOT_JOINABLE`），空间不存在/归档 → `USER_WORKSPACE_NOT_FOUND`；
  不传 `workspaceId` 保持原行为（首次登录自动创建个人空间）。
- 前端「系统管理 → 用户管理 → 新增用户」弹窗新增「所属空间（可选）」下拉（数据源 `GET /workspaces/all`）
  与「空间角色（成员 / 空间管理员）」选择；不选时提示"首次登录自动创建个人空间"。
- 验证：users 单测 24 passed（新增 4 例）；API E2E `USER-WS-01` 通过（20 passed）；
  浏览器功能验收新增第 3 条路径「管理员：新增用户时可选择工作空间」通过（截图 17/18）；
  server 全量 222 suites / 5074 passed；UI 套件 3 passed；web tsc/eslint/build OK。

## 已知问题清零（2026-11-13）

> 来源：`test-report-ui.md` 第四节 + 本文件原「后续可选增强」。全部处理完毕并回归。

| 原问题 | 处理结果 |
|---|---|
| 「全部空间」最多 20 条、无搜索 | 全部空间区新增搜索框（名称/id）+ 分批加载（每批 20）+ 显示 N/总数 |
| 顶栏切换器为原生 select | 改为可搜索下拉面板（搜索框、当前空间 ✓、角色中文化、点击外部/Esc 关闭、平台资源提示） |
| 只读视图下写入口仍可点 | 新增 `useReadOnlyView()`：团队列表「新建团队」、团队创建页提交、Agent「新建」、工作空间创建/邀请/迁移全部置灰并带提示；服务端 403 仍兜底 |
| 迁移权限仅 AdminGuard | 新增平台权限点 `platform.relocate_resource` / `platform.cross_space_read`（角色 permissions 可单独授予，admin `{all:true}` 自动覆盖）；迁移/审计/全部空间接口改用 PermissionGuard |
| 迁移后无副作用重放 | 迁移成功后在迁出/迁入两个空间上下文分别：广播 worker `reload-config`、回放 git/模型凭据、广播 `workspace.resource.relocated` SSE；失败只告警不回滚（+单测） |
| 共享 WORKER_TOKEN 可自报任意空间 | 空间级 worker 加入码：`POST /workspaces/:id/worker-token` 签发（DB 只存 SHA-256，明文一次）；非默认空间注册强制校验（`WORKER_JOIN_TOKEN_INVALID`），默认空间向后兼容；worker 新增 `WORKER_JOIN_TOKEN` env（+单测 +API E2E） |
| `/uploads/*` 静态无鉴权 | 空间分区 URL 签名：返回 `?exp&sig`（HMAC-SHA256，默认 180 天），静态服务校验；无签名/篡改/过期 → 403；存量根目录 URL 保持可读（迁移期可用 `UPLOAD_URL_SIGNATURE_ENFORCE=false` 关闭）（+单测 +API E2E） |
| 共享节点凭据可能串空间 | 定向派发按请求空间过滤 + 注册/迁移回放均在该空间上下文内查询；新增单测锁定「A 空间 key 不发给 B 空间节点」 |
| 已知边界（保留） | uploads 签名 TTL 到期需重新获取 URL；共享节点 /tmp 文件仍属同一容器；跨空间 SSE 事件按当前空间过滤（设计如此）；业务数据不可迁移（设计如此） |

## 后续可选增强（非本目标阻塞项）

1. ~~凭据下发按空间 / worker 归属~~ —— M2-1 已完成主体；剩余：per-worker 密钥、共享节点凭据校验、git 凭据下发面显式断言。
2. ~~SSE 空间维度 / MCP 上下文~~ —— M2-2 已完成；剩余：前端 SSE 连接池按空间（M3）。
3. **工作目录分区 + worker 文件路径加固**（M2 最后一项）：`taskDirOf` / `ensureTaskWorkDir` / `plan-docs` 加 `workspaces/<id>/` 段（含存量任务目录兼容策略）；worker `GET /file` / `exec-server` realpath 限根；`/uploads/*` 静态服务后续可升级签名 URL。
4. ~~资源空间迁移（共享/回收）+ 审计~~ —— **M2-4 已完成**；剩余：把 `AdminGuard` 升级为可授权的权限点（`platform.relocate_resource`）、迁移后的副作用重放（MCP/技能/凭据重新注入、SSE 通知）。
4. **资源空间迁移（共享）**：独立审计端点 + `platform.view_all_workspaces` / `platform.relocate_resource` 权限 + 审计表 + 副作用重放。
5. **前端（M3）**：空间切换器、`X-Workspace-Id`、按空间前缀的 queryKey、空间成员管理 UI、管理员跨空间入口、E2E 多账号。

## 关键约定（后续开发必读）

- 新资源表必须：加 `workspaceId` + `workspace` 关系 + `@@index([workspaceId])`，并在 `tenant-models.ts` 登记 platform/private；否则中间件不会注入。
- 唯一键一律 `(workspaceId, ...)`；`findUnique` / `update` / `delete` / `upsert` 用 `tenantUniqueWhere`（脚本用 `prisma/tenant-unique.ts` 的 `seedUniqueWhere`，自包含、不 import src）。
- 子表/关联表靠父实体承载空间，不单独加列。
- 平台内置数据写 `ws_system`；用户数据写当前空间；测试/seed 脚本显式指定空间，不依赖上下文。
- 内部流程（worker 注册、事件回流、定时任务）目前**没有**租户上下文（`getTenantContext()` 为空 → 不注入），M2 需显式包裹 `runWithTenant` 并传空间。
