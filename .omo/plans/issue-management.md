# issue-management - Work Plan

## TL;DR (For humans)

**What you'll get:** 平台内置 Issue 管理能力——Agent 可在任务内直接创建/查询/更新/流转 issue（与任务绑定），产品 Agent 建需求 issue 指派研发、测试 Agent 建缺陷 issue；前端新增「Issue 管理」页面支持增删改查与状态流转。

**Why this approach:** 完全复用现有平台 MCP 工具链路（`buildPlatformMcpTools` + `assertWorkerTask` 归属校验 + seed 内置 MCP server 模板）与任务模型（Task/TaskAgent），新增 Issue 数据模型 + issues 模块 + 内置工具 + 管理页，全局提示词追加工具说明让 Agent 自主使用。

**What it will NOT do:** 不做项目级 issue（仅任务绑定）、不做 kind 枚举（仅自由 tags 标签）、不做 issue 评论流、不做跨任务 issue、不做通知推送、不做看板式拖拽。

**Effort:** Medium
**Risk:** Medium - 状态流转边界 + MCP 工具归属校验（沿用 assertWorkerTask 模式风险低）；指派 agent 须在任务团队校验

**Decisions to sanity-check:** ① issue 仅任务绑定（taskId 必填）；② 状态机 open/in_progress/resolved/closed + reopen/reject；③ 仅 tags 自由标签；④ assigneeAgentId + assigneeUserId 双指派可选；⑤ 内置 MCP 工具并入 keta-platform 工具集（扩展而非新建 server）。

Your next move: approve, or run a high-accuracy review. Full execution detail follows below.

---

> TL;DR (machine): Medium effort, Medium risk - 5 todos across 5 waves; schema + issues 模块 + MCP 工具(扩展 keta-platform) + web 管理页 + 端到端；复用 platform-mcp/task 基座。

## Scope

### Must have

1. **Issue 数据模型 + 迁移**
   - `Issue` model（schema.prisma）：id(`is_` 前缀)、taskId 必填（FK → Task）、title、description?、status（默认 open）、tags（Json 字符串数组）、assigneeAgentId?（FK → Agent）、assigneeUserId?（FK → User）、**createdBy String?（FK → User，可空——MCP 创建者无用户上下文）**、**creatorAgentId String?（FK → Agent，Agent 经 MCP 创建时填；用户创建填 userId，对齐 Message.senderType/senderId 模式）**、resolvedAt?、closedAt?、createdAt、updatedAt；`@@index([taskId, status])`、`@@map("issues")`
   - 迁移：`npx prisma migrate dev --name issue_management`（agent 非交互环境若遇 drift/reset 提示，用 `migrate diff --from-migrations --to-schema-datamodel --script` + `migrate deploy` 备选）
   - 关系：Task.issues、Agent.issues（assignee + creator）、User.issues（assignee + creator）；relation 命名 IssueAssigneeAgent/IssueAssigneeUser/IssueCreatorAgent/IssueCreatorUser（全局唯一，不撞现有）
   - **创建者决策（Metis B1）**：用户经 web/API 创建 → createdBy=userId；Agent 经 MCP 创建 → creatorAgentId=agentId（createdBy 留空）；两者互斥至少一个非空
2. **server issues 模块**（CRUD + 状态流转）
   - `POST /issues`：任务成员可建（project_members 校验，经 task.projectId）；body {taskId, title, description?, tags?, assigneeAgentId?, assigneeUserId?}；assigneeAgentId 须在任务团队（task_agents 未 removed）
   - `GET /issues?taskId=&status=&assigneeAgentId=&page=`：列表（任务成员可查；按任务过滤）
   - `GET /issues/:id`：详情（含 task 标题/assignee 名）
   - `PATCH /issues/:id`：编辑（title/description/tags/assignee，任务成员）
   - `POST /issues/:id/transition`：状态流转 {action}——action ∈ {start, resolve, close, reopen, reject}；状态机 open→in_progress(start)/in_progress→resolved(resolve)/resolved→closed(close)/closed→open(reopen)/in_progress→open(reject)；非法 409 ISSUE_INVALID_TRANSITION
   - `DELETE /issues/:id`：软删或物理删（推荐软删：deletedAt）
   - 状态常量 `ISSUE_STATUS`（open/in_progress/resolved/closed）+ `ISSUE_TRANSITIONS` 迁移表 + `ISSUE_ERRORS`
   - `onModuleInit` resyncIdPrefix `is_`
3. **内置 issue MCP 工具**（扩展 keta-platform 工具集）
   - `platform-mcp.tools.ts` `buildPlatformMcpTools` 追加 5 工具：
     - `issue_create`：{taskId, selfAgentId, title, description?, tags?[], assigneeAgentId?} → 创建（归属校验 + 团队校验）
     - `issue_list`：{taskId, selfAgentId, status?} → 任务 issue 列表
     - `issue_get`：{taskId, selfAgentId, issueId} → 详情
     - `issue_update`：{taskId, selfAgentId, issueId, title?, description?, tags?} → 编辑
     - `issue_transition`：{taskId, selfAgentId, issueId, action} → 状态流转
   - handler 均 `assertWorkerTask(ctx, taskId)` 归属校验（复用现有）
   - **GLOBAL_SYSTEM_INSTRUCTIONS**（worker-dispatcher.ts:57）追加 issue 工具说明块：「【Issue 管理】任务内管理 issue：创建/查询/更新/流转调用 keta-platform MCP 的 issue_create/issue_list/issue_get/issue_update/issue_transition（参数含 taskId 与 selfAgentId=你的 Agent id）。产品负责需求/缺陷 issue 创建与指派，研发处理指派给自己的 issue 并流转状态。issue 标签（tags）标识类型：需求/缺陷/优化等。」
4. **web issue 管理页**
   - 导航：nav-dock NAV_ITEMS 加 `{key:"issues", label:"Issue 管理", icon:"☰"}`（或合适图标）+ app-shell KEY_TO_PATH 加 `issues: "/issues"` + CMDK_NAV_PATH 加 `Issue 管理`
   - 路由 `web/app/(main)/issues/page.tsx`：列表（任务筛选下拉 + 状态筛选 + 标签徽章 + 状态徽章 + 指派 + 任务标题）+ 创建弹窗 + 编辑弹窗 + 状态流转按钮组 + 删除确认
   - 数据源：GET /issues?taskId=&status=；GET /tasks（任务下拉）；GET /agents（指派 agent 下拉）
   - 风格对齐现有管理页（models/skills 页白卡+徽章+弹窗模式，token 引用，无 fixed/100vh）
5. **端到端验证**
   - 单测：issues.service.spec（CRUD/状态机/权限/指派校验）、issues.controller.spec（守卫/DTO/404/409）、platform-mcp issue 工具 spec、worker-dispatcher GLOBAL_SYSTEM_INSTRUCTIONS 含 issue 说明断言
   - 端到端：部署后任务 @产品 → agent 调 issue_create 建需求 issue → 前端可见 → @研发 → issue_transition start/resolve/close 全流转 → 标签徽章正确

### Must NOT have (guardrails, anti-slop, scope boundaries)

- **不做** 项目级 issue（taskId 必填）；**不做** kind 枚举（仅 tags）；**不做** issue 评论/评论流；**不做** 跨任务 issue（MCP 校验 taskId 归属）；**不做** 通知推送/邮件；**不做** 看板拖拽/排序（仅列表）
- **不新建** 独立 issue-mcp server（扩展 keta-platform 工具集，复用 worker 注入链路）
- **不挂** ProjectMembershipGuard（:id 会误解析为 taskId → 404 TASK_NOT_FOUND，Metis M2）；**不建** issues 权限点（权限附属于任务成员，前端 NAV_VISIBLE 不加条目）
- **不修改** 任务状态机/Task 模型
- **不改** opencode 本体；issue MCP 工具经既有 platform-mcp 端点暴露
- **不做** issue 与 git 仓库/PR 的自动关联

## Verification strategy

> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after**（仓库现有模式）+ jest（server）
- Evidence: `.omo/evidence/issue-management/`（各 todo 的 QA 输出落此处）

## Execution strategy

### Parallel execution waves

- **Wave 1**：todo 1（schema + 迁移）—— 基础，阻塞其余
- **Wave 2**：todo 2（server issues 模块）—— 依赖 1
- **Wave 3**：todo 3（MCP 工具 + 全局提示词）—— 依赖 2（handler 调 issues service）
- **Wave 4**：todo 4（web 管理页）—— 依赖 2 的 API
- **Wave 5**：todo 5（端到端）—— 依赖全部

### Dependency matrix

| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. schema+迁移 | — | 2,3,4 | — |
| 2. issues 模块 | 1 | 3,4 | — |
| 3. MCP 工具+提示词 | 2 | 5 | 4 |
| 4. web 管理页 | 2 | 5 | 3 |
| 5. 端到端 | 1-4 | — | — |

## Todos

- [x] 1. Issue 数据模型 + 迁移
  What to do / Must NOT do:
  - `server/prisma/schema.prisma` 追加 `model Issue`（放在 Artifact 段附近，加段注释 `// ===== Issue 域（任务内 issue 管理）=====`）：
    - `id String @id`、`taskId String @map("task_id")`、`title String`、`description String?`、`status String @default("open")`、`tags Json?`（字符串数组，`@map("tags")`）、`assigneeAgentId String? @map("assignee_agent_id")`、`assigneeUserId String? @map("assignee_user_id")`、`createdBy String? @map("created_by")`、`creatorAgentId String? @map("creator_agent_id")`、`deletedAt DateTime? @map("deleted_at")`、`resolvedAt DateTime? @map("resolved_at")`、`closedAt DateTime? @map("closed_at")`、`createdAt DateTime @default(now()) @map("created_at")`、`updatedAt DateTime @updatedAt @map("updated_at")`
    - **createdBy 可空（FK → User），新增 creatorAgentId（FK → Agent）**——用户创建填 createdBy、Agent 经 MCP 创建填 creatorAgentId（对齐 Message.senderType/senderId 模式，Metis B1）
    - 关系：`task Task @relation(fields: [taskId], references: [id], onDelete: Restrict, onUpdate: Restrict)`、`assigneeAgent Agent? @relation("IssueAssigneeAgent", ...)`、`assigneeUser User? @relation("IssueAssigneeUser", ...)`、`creatorAgent Agent? @relation("IssueCreatorAgent", ...)`、`creatorUser User? @relation("IssueCreatorUser", ...)`；Task 加 `issues Issue[]`、Agent 加 `assignedIssues`/`createdIssues`、User 加 `createdIssues`/`assignedIssues`（relation 命名全局唯一）
    - `@@index([taskId, status], map: "idx_issues_task_status")`、`@@index([assigneeAgentId], map: "idx_issues_assignee_agent")`、`@@map("issues")`
  - 迁移：`cd server && npx prisma migrate dev --name issue_management`；若 agent 非交互环境遇 drift/reset 提示 → 用 `npx prisma migrate diff --from-migrations --to-schema-datamodel --script` 生成 SQL 落迁移目录 + `npx prisma migrate deploy`；`npx prisma generate`
  - `server/src/tasks/tasks.service.ts` 或独立 issues service 的 onModuleInit 加 `resyncIdPrefix(this.prisma.issue, 'is', this.idGen)`（issues 模块 todo 2 做，此处确认 prisma client 可用）
  - Must NOT：不加 kind 字段、不加 projectId（仅任务绑定）、不做评论表、createdBy 可空（勿改回必填）
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2,3,4
  References:
  - `server/prisma/schema.prisma:118-147`（Task model 模板，含关系/FK/索引模式）
  - `server/prisma/schema.prisma:149-162`（TaskAgent 模板）、`:251`（Artifact 段）
  - `server/prisma/schema.prisma:291-320`（Agent model，creator relation 模板）
  - `server/prisma/migrations/20260812032006_git_repo_credentials/migration.sql`（迁移 SQL 格式参照）
  - `server/src/common/id-resync.ts`（resyncIdPrefix 通用函数）
  Acceptance criteria (agent-executable):
  - `cd server && npx prisma migrate dev --name issue_management` 成功（或 diff+deploy 备选）；`npx prisma validate` 通过；`npx tsc --noEmit` 0 错误
  - DB 实测：`SHOW COLUMNS FROM aiagents.issues` 含 15 列（id/task_id/title/description/status/tags/assignee_agent_id/assignee_user_id/created_by/creator_agent_id/deleted_at/resolved_at/closed_at/created_at/updated_at）；`SHOW INDEX FROM aiagents.issues` 含 idx_issues_task_status
  QA scenarios (name the exact tool + invocation):
  - happy: 迁移 + validate + tsc 全过（Evidence `.omo/evidence/issue-management/task-1-migrate.txt`）
  - failure: `npx prisma migrate dev` 幂等（重复跑无 pending、无 drift 提示）；validate 通过
  Commit: Y | `feat(issues): Issue 数据模型与迁移`

- [x] 2. server issues 模块（CRUD + 状态流转）
  What to do / Must NOT do:
  - 新建 `server/src/issues/`：`issues.module.ts`（imports RealtimeModule + WorkersModule?，providers IssuesService + AdminGuard/权限）、`issues.controller.ts`、`issues.service.ts`、`dto/create-issue.dto.ts`、`dto/update-issue.dto.ts`、`dto/transition-issue.dto.ts`、`issues.constants.ts`
  - `issues.constants.ts`：`ISSUE_STATUS = { open, in_progress, resolved, closed }`、`ISSUE_TRANSITIONS = { start: open→in_progress, resolve: in_progress→resolved, close: resolved→closed, reopen: closed→open, reject: in_progress→open }`、`ISSUE_ERRORS`（ISSUE_NOT_FOUND/ISSUE_INVALID_TRANSITION/ISSUE_TASK_NOT_FOUND/ASSIGNEE_NOT_IN_TEAM/ISSUE_TASK_ARCHIVED）
  - `IssuesService`：
    - `onModuleInit`：`resyncIdPrefix(this.prisma.issue, 'is', this.idGen)`
    - `create(userId, dto)`：任务存在校验（404）→ 任务非 archived（409）→ 调用者任务成员校验（project_members 经 task.projectId，403）→ assigneeAgentId 须在任务团队未 removed（400 ASSIGNEE_NOT_IN_TEAM）→ create（status=open，tags 数组 Json；**createdBy=userId**）→ 返回 DTO
    - `createByAgent(agentId, dto)`：**MCP 专用**——同 create 校验 + assignee 团队校验，**creatorAgentId=agentId**（createdBy 留空）
    - `findAll(query, userId)`：任务成员校验（按 taskId 查）；过滤 taskId?/status?/assigneeAgentId?/deletedAt=null + 分页 {items, total}；items 附 task.title + assignee 名 + creator 名（agent/user 二选一）
    - `findOne(id, userId)`：详情（含 task/assignee/creator 关联），404 若不存在或 deletedAt
    - `update(id, userId, dto)`：任务成员校验 + 404 + 编辑 title/description/tags/assignee（assignee 变更重新校验团队）
    - `transition(id, userId, {action})`：任务成员校验 + 404 + ISSUE_TRANSITIONS[action] 判定（from 不匹配 → 409 ISSUE_INVALID_TRANSITION；已处目标态幂等 200）→ 更新 status + resolvedAt/closedAt 时间戳（resolve→resolvedAt=now，close→closedAt=now，reopen/reject→清空）
    - `remove(id, userId)`：任务成员校验 + 软删（deletedAt=now）
  - `IssuesController`（`@Controller('issues')`）：GET（成员只读，默认全局 JWT + service 内任务成员校验）/ POST / PATCH / DELETE / `POST :id/transition`——**不挂 ProjectMembershipGuard（:id 会被误解析为 taskId，Metis M2）**，一律 service 内从 issue.taskId → projectId 校验成员
  - 权限决策：issue 由任务成员管理（非 admin 专属）——controller 挂全局 JwtAuthGuard（默认），service 内校验任务成员；不挂 AdminGuard、不挂 ProjectMembershipGuard
  - `server/src/app.module.ts` 注册 IssuesModule
  - Must NOT：不挂 AdminGuard（成员可管理自己的任务 issue）；**不挂 ProjectMembershipGuard（:id 误解析为 taskId → 404 TASK_NOT_FOUND）**；不做项目级查询入口
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 3,4
  References:
  - `server/src/tasks/tasks.service.ts`（CRUD/分页/错误码/权限模式）
  - `server/src/artifacts/artifacts.service.ts`（简单 CRUD + onModuleInit resyncIdPrefix）
  - `server/src/common/constants/task.constants.ts`（TASK_STATUS/TASK_TRANSITIONS 状态机模式——ISSUE 仿此）
  - `server/src/tasks/dto/create-task.dto.ts`（DTO + class-validator 模式）
  - `server/src/app.module.ts`（模块注册）
  Acceptance criteria (agent-executable):
  - `npx tsc --noEmit` 0 错误
  - `npx jest --runInBand src/issues/` 新建 spec 全绿（service：create 校验/状态机全迁移/非法 409/幂等/软删/指派校验；controller：守卫/DTO/404）
  - 手动 API 冒烟（curl + token）：POST 创建 → GET 列表 → POST transition（start/resolve/close 链）→ 非法 transition 409 → DELETE 软删
  QA scenarios (name the exact tool + invocation):
  - happy: 全链 API 冒烟 + 单测（Evidence `.omo/evidence/issue-management/task-2-api.txt`）
  - failure: 非任务成员 POST → 403；assigneeAgentId 不在团队 → 400；in_progress 直接 close → 409；归档任务建 issue → 409
  Commit: Y | `feat(issues): Issue CRUD 与状态流转模块`

- [x] 3. 内置 issue MCP 工具 + 全局提示词
  What to do / Must NOT do:
  - `server/src/platform-mcp/platform-mcp.tools.ts` `buildPlatformMcpTools` 追加 5 工具（zod schema + handler 调 IssuesService）：
    - `issue_create`：`{taskId, selfAgentId, title, description?, tags? (z.array(z.string())), assigneeAgentId?}` → `service.createByAgent(agentId, ...)`（**creatorAgentId=agentId**，Metis B1）
    - `issue_list`：`{taskId, selfAgentId, status? (enum open/in_progress/resolved/closed)}` → 任务 issue 列表（不含 deletedAt）
    - `issue_get`：`{taskId, selfAgentId, issueId}` → 详情（含 task 标题/assignee）
    - `issue_update`：`{taskId, selfAgentId, issueId, title?, description?, tags?}` → 编辑
    - `issue_transition`：`{taskId, selfAgentId, issueId, action (enum start/resolve/close/reopen/reject)}` → 流转
  - `platform-mcp.service.ts` 注入 IssuesService（constructor 加依赖）+ 5 个 handler 方法（**均 `assertWorkerTask(ctx, taskId, args.selfAgentId)` 三参数归属校验**——selfAgentId 必填防冒充，Metis M4；再调 issues service；异常映射 MCP 错误码）
  - `platform-mcp.module.ts` imports IssuesModule（无环——IssuesModule 只依赖 RealtimeModule，不依赖 platform-mcp）
  - **GLOBAL_SYSTEM_INSTRUCTIONS**（`server/src/chat/worker-dispatcher.ts:57-71`）追加 issue 工具说明块（中文，风格一致）：「【Issue 管理】任务内 issue 协作：创建 issue 调 keta-platform MCP 的 issue_create（参数 {taskId, selfAgentId, title, description?, tags?, assigneeAgentId?}）；查询 issue_list/issue_get；更新 issue_update；状态流转 issue_transition（action: start/resolve/close/reopen/reject）。产品/测试 Agent 负责创建需求或缺陷 issue 并指派，研发 Agent 处理指派给自己的 issue 并流转状态。issue 标签（tags）标识类型（如 需求/缺陷/优化）。」
  - Must NOT：不新建独立 issue-mcp server（扩展 keta-platform）；不改 assertWorkerTask；issue handler 必须三参数归属校验（selfAgentId 必填）
  Parallelization: Wave 3 | Blocked by: 2 | Blocks: 5 | Can parallelize with: 4
  References:
  - `server/src/platform-mcp/platform-mcp.tools.ts`（buildPlatformMcpTools + zod schema 模式）
  - `server/src/platform-mcp/platform-mcp.service.ts`（handler + assertWorkerTask + 注入模式）
  - `server/src/platform-mcp/platform-mcp.module.ts`（模块 imports）
  - `server/src/chat/worker-dispatcher.ts:57-71`（GLOBAL_SYSTEM_INSTRUCTIONS 追加点）
  Acceptance criteria (agent-executable):
  - `npx tsc --noEmit` 0 错误
  - `npx jest --runInBand src/platform-mcp/` 全绿（新增 issue 工具 spec：创建/列表/流转/归属校验 403）
  - 断言 GLOBAL_SYSTEM_INSTRUCTIONS 含 "issue_create" 关键字（jest 或 grep）
  - 端到端预演：worker 容器 `opencode mcp list` keta-platform connected + tools/list 含 issue_* 工具
  QA scenarios (name the exact tool + invocation):
  - happy: tools/list 返回 12 工具（原 7 + issue 5）+ issue_create 实测创建成功（Evidence `.omo/evidence/issue-management/task-3-mcp.txt`）
  - failure: 非本任务 worker 调 issue_create → 403 归属拒绝；status 非法 → 400
  Commit: Y | `feat(issues): 内置 issue MCP 工具与全局提示词`

- [x] 4. web Issue 管理页
  What to do / Must NOT do:
  - `web/src/components/layout/nav-dock.tsx`：NAV_ITEMS 加 `{ key: "issues", label: "Issue 管理", icon: "☰" }`（**放 project 后**，nav-dock 现有 9 项无 tasks 键，Metis m1）
  - `web/src/components/layout/app-shell.tsx`：KEY_TO_PATH 加 `issues: "/issues"`；CMDK_NAV_PATH 加 `Issue 管理: "/issues"`；**NAV_VISIBLE/ROUTE_GUARD 不加 issues 条目**（后端无 issues 权限点，登录即可访问——加了会因 hasPermission 恒 false 导致导航永久隐藏 + 路由拒绝，Metis M3）
  - 新建 `web/app/(main)/issues/page.tsx`（"use client"）：
    - **项目上下文（Metis M1）**：仿 board 页 `?pid=` 必填——进入无 pid → 重定向 /projects；任务下拉数据源 `GET /projects/:pid/tasks`（**不是 GET /tasks，后者不存在**）
    - 数据源：`useQuery(["issues"], GET /issues?taskId=)` + `GET /projects/:pid/tasks`（任务筛选下拉）+ `useQuery(["agents"], GET /agents)`（指派 agent 下拉）+ `GET /users`（指派用户下拉，若存在）
    - 工具条：项目（URL pid）+ 任务筛选下拉 + 状态筛选 + 新建按钮
    - 列表行：issue title + 状态徽章（open=灰蓝/in_progress=蓝/resolved=绿/closed=灰）+ tags 标签徽章（多彩）+ 指派（agent/user 名）+ 任务标题 + 创建者（agent/user）+ 时间 + 操作（编辑/流转/删除）
    - 创建/编辑弹窗：title/description/tags（逗号分隔转数组）/assigneeAgentId（agent 下拉）+ assigneeUserId（用户下拉，可选）
    - 状态流转按钮组（**新建独立 IssueStatusActions 组件，禁止复用 Task 的 start/reject 常量/组件——两者 action 同名，Metis m6**）：按当前状态渲染可执行操作（start/resolve/close/reopen/reject）
    - 删除 ConfirmDialog
    - 风格对齐现有管理页（白卡+徽章+弹窗+token，无 fixed/100vh）
  - 类型：`web/src/types/issues.ts`（IssueItem/IssueDetail/CreateIssuePayload/UpdateIssuePayload）
  - Must NOT：不做看板拖拽；不做项目级入口（仅任务筛选）；不改任务页；不挂 ProjectMembershipGuard 相关前端守卫
  Parallelization: Wave 4 | Blocked by: 2 | Blocks: 5
  References:
  - `web/app/(main)/models/page.tsx`（列表/徽章/弹窗/白卡风格）
  - `web/app/(main)/skills/page.tsx`（三域管理 + 状态徽章 + 弹窗模式）
  - `web/src/components/tasks/task-status-actions.tsx`（状态流转按钮组模式）
  - `web/src/components/layout/nav-dock.tsx:35-44` + `app-shell.tsx:101-111`（导航三处）
  - `web/src/types/models.ts` / `web/lib/api.ts`（类型 + API 调用模式）
  Acceptance criteria (agent-executable):
  - `cd web && npx tsc --noEmit` 0 错误；`npm run build` 通过
  - 部署 `docker-compose up -d --build web` → Playwright/浏览器（:13001）：nav 出现「Issue 管理」→ /issues 渲染列表 → 创建 issue → 列表出现（状态徽章/tags 徽章）→ 状态流转（start→resolved）→ 编辑 → 删除 → 消失；截图留档
  QA scenarios (name the exact tool + invocation):
  - happy: 全 UI 流程 + 截图（Evidence `.omo/evidence/issue-management/task-4-web.txt`）
  - failure: 空态显示；任务筛选联动；非法流转按钮不渲染
  Commit: Y | `feat(issues): Issue 管理页面`

- [x] 5. 端到端验证
  What to do / Must NOT do:
  - 部署：`docker-compose up -d --build server worker web` → 健康检查
  - 场景 A（产品建需求 issue）：新创建任务（seed 无预置任务，首个任务 id 为 t_0000000001，Metis m2）→ 任务 @产品 → agent 调 issue_create（tags=["需求"], assigneeAgentId=a_developer）→ 验证 DB issues 落库（creator_agent_id=a_product）+ 前端 /issues 可见
  - 场景 B（研发流转）：任务 @研发 → agent 调 issue_transition（start→resolved→close 链）→ 验证状态流转 + 时间戳
  - 场景 C（测试建缺陷）：@测试 → issue_create（tags=["缺陷"]）→ 前端标签徽章正确
  - 场景 D（权限/校验）：非任务成员（seed-member 非该项目）→ 403；非法流转 → 409；指派不在团队 → 400
  - 验证全局提示词生效：worker 会话内 issue 工具可调用（tools/list 含 issue_*）
  - Must NOT：不破坏现有功能（回归：群聊/私聊/git/MCP 正常）
  Parallelization: Wave 5 | Blocked by: 1-4 | Blocks: —
  References:
  - 端到端脚本模式（本会话既有 curl + python 解析用法）
  - `docker-compose.yml`（部署）
  Acceptance criteria (agent-executable):
  - 场景 A/B/C 全通过（issue 创建/流转/标签）+ 场景 D 校验 403/409/400 + 回归正常
  QA scenarios (name the exact tool + invocation):
  - happy: 全场景日志 + 消息落库查询输出至 `.omo/evidence/issue-management/task-5-e2e.txt`
  - failure: 任一场景失败 → 定位修复（回对应 todo）后重跑
  Commit: N（验证不提交，修复并入对应 todo 的 commit）

## Final verification wave

> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.

- [x] F1. Plan compliance audit（对照本计划逐项核对：schema/模块/MCP 工具/提示词/管理页/端到端全部落地，范围外未混入）
- [x] F2. Code quality review（typecheck + 全量测试 + 代码风格与现有一致；issues 模块/状态机/MCP handler 逻辑正确；无敏感信息泄漏）
- [x] F3. Real manual QA（真实 UI 走一遍创建→指派→流转→删除，截图留档）
- [x] F4. Scope fidelity（确认 Must NOT have 未越界：无项目级 issue、无 kind 枚举、无评论流、无新建独立 MCP server）

## Commit strategy

- 一个需求一个 commit（AGENTS.md 约定）：5 个实现 todo 各对应一个 commit，全部在功能分支 `feature/issue-management`（基于 xishuhq 默认分支）
- commit message：`feat(issues): <摘要>`（每个 todo 的 Commit 行已给出）
- 提交前 `git fetch xishuhq` 同步 base；完成后推 ketabot（或实际远端）建 PR
- 本仓库 TS/TSX 无 Java → 不触发 googleJavaFormat

## Success criteria

1. Issue 数据模型落库（issues 表），与任务绑定（taskId 必填）
2. server issues 模块：CRUD + 状态机（open/in_progress/resolved/closed + reopen/reject）全可用，权限正确（任务成员）
3. 内置 5 个 issue MCP 工具（issue_create/list/get/update/transition）经 keta-platform 暴露，Agent 可调用；全局提示词含 issue 工具说明
4. 前端 Issue 管理页：列表（标签/状态徽章/指派/任务筛选）+ 创建/编辑/流转/删除全可用 + 导航入口
5. 端到端：产品建需求 issue → 研发流转 closed → 测试建缺陷 issue 标签正确；权限/校验 403/409/400 正确；回归无破坏
