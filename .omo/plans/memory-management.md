# memory-management - Work Plan

## TL;DR (For humans)

**What you'll get:** vteam 平台新增完整的记忆管理能力：Agent 可通过平台内置记忆工具存取「任务级 / 项目级 / 全局级」三级记忆（任务完成后总结经验沉淀，新任务开始时按需检索复用）；任务验收通过时，主 Agent 会在私聊中收到总结引导；管理员可在新增的「记忆管理」页面查看、筛选、搜索和删除记忆。

**Why this approach:** 沿用平台已定调的「MCP 工具按需拉取」模式（与现有 14 个平台工具同一机制，worker 零改动）；触发采用混合机制——平台在任务验收通过时发提示、由主 Agent 自主调用记忆工具落库（平台不自动提取内容）；三级存储与平台「任务→项目→全局」的实体层级天然对应。

**What it will NOT do:** 不做记忆自动摘要/提取；不做记忆编辑功能（管理页仅查看/筛选/搜索/删除）；验收提示是私聊落库的被动提示（不会强行唤醒 Agent 执行）；不改 opencode 内置记忆工具；不做全文/向量检索。

**Effort:** Medium（6 个实现任务，跨 server + web 双端）
**Risk:** Medium - 与任务状态机与系统提示注入耦合；核心低风险（不改迁移逻辑、零 worker 改动）
**Decisions to sanity-check:** ① global 级记忆仅主 Agent 可写（防全局污染）② accept 私信为被动提示（不唤醒，主动唤醒属后续增强）③ REST 管理端点全挂 admin 守卫（比 tools 更严格）④ 检索用 content LIKE + tags 精确匹配

Your next move: approve 后执行 `$start-work memory-management`，或先运行高精度评审（momus + oracle 双评审）。完整执行细节如下。

---

> TL;DR (machine): Medium effort, Medium risk — vteam 记忆管理（6 todos：store/mcp/trigger/inject/rest/web + F1-F4 终验），三级记忆存取 + 混合触发 + 管理页面。

## Scope
### Must have
- **mem-store**：Prisma `memories` 表（me_ 前缀 id / level(task|project|global) / taskId? / projectId? / content TEXT / tags JSON / createdBy / deletedAt? 软删 / createdAt / updatedAt）+ 迁移 + MemoryModule（含 resyncIdPrefix 续号）
- **mem-mcp**：平台 MCP 新增 `memory_save` / `memory_search` 工具（zod schema + handler + assertWorkerTask 归属校验 + 级别校验：task 级存任务归属、project 级从 task 反查 projectId 防跨项目写、global 级仅主 Agent 可写防污染；save 落库需 selfInstanceId；search 在任务上下文聚合 task+project+global 三级可见记忆且过滤软删）
- **mem-trigger**：`accept`（pending_review→completed）时向主 Agent private 频道写入**被动提示**私信（引导其调用 memory_save 总结记忆；落库 + 广播，主 Agent 下次被触发时作为私聊历史可见——不承诺立即唤醒）；`archive` 群聊系统消息文案补充记忆提示（会话冻结约束，不私信）
- **mem-inject**：`GLOBAL_SYSTEM_INSTRUCTIONS` 新增【记忆管理】段（memory_save/memory_search 用法 + 何时检索/总结引导）
- **mem-rest**：`GET /memories`（level/projectId/taskId/keyword 过滤 + 分页）+ `DELETE /memories/:id`（软删），均挂 AdminGuard
- **mem-web**：`web/app/(main)/memories/` 记忆管理页面（级别筛选 + 关键词搜索 + 分页列表 + 删除）+ NAV_ITEMS/PAGE_TITLE 导航注册
- 单测：platform-mcp.service.spec / tasks.service.spec / worker-dispatcher.spec / memories.controller.spec / memories.service.spec 扩展

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 记忆编辑端点（PATCH /memories/:id）、记忆详情页、记忆列表/删除 MCP 工具（管理走页面）
- 记忆自动提取（平台不做 LLM 摘要/提取——Agent 主动总结）
- 权限矩阵扩展（不新增 memories 权限资源；管理端点用 AdminGuard）
- opencode 内置 memory 工具改造；worker 侧代码改动（工具经既有 MCP 注入链下发，零 worker 改动）
- 全文检索/向量化检索（content LIKE + tags 精确匹配即可）
- 不改动任务状态机迁移逻辑本身（start/reject/archive 既有行为不变，仅 accept 增私信、archive 文案补充）
- **不做 accept 后主动唤醒 dispatch**（M1 方案 B：system 消息不触发 worker 执行，私信为被动提示；主动唤醒属后续增强）

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + jest（server 单测随实现写入，平台既有 spec 风格）；web 用 `npm run build` + `npm run lint` + Playwright 冒烟（环境允许时）
- Evidence: .omo/evidence/task-<N>-memory-management.<ext>（attemptDir = currentAttemptDir from 'omo ulw-loop status --json', .omo/evidence/ulw/<session>/<goalId>/a<attempt>; outside ulw-loop use .omo/evidence/）

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- **Wave 1**（3 todos，可并行）：Todo 1（mem-store）、Todo 3（mem-trigger）、Todo 4（mem-inject）
- **Wave 2**（2 todos，可并行）：Todo 2（mem-mcp，依赖 1）、Todo 5（mem-rest，依赖 1）
- **Wave 3**（1 todo）：Todo 6（mem-web，依赖 5）
- **Final verification wave**：F1-F4 并行

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. mem-store | - | 2, 5 | 3, 4 |
| 2. mem-mcp | 1 | - | 3, 4, 5 |
| 3. mem-trigger | - | - | 1, 2, 4 |
| 4. mem-inject | - | - | 1, 2, 3 |
| 5. mem-rest | 1 | 6 | 2, 3, 4 |
| 6. mem-web | 5 | - | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. mem-store：Prisma Memory 模型 + 迁移 + MemoryModule 骨架
  What to do / Must NOT do:
  - `server/prisma/schema.prisma` 新增 `Memory` 模型（对齐 Task 模型 :121 与软删 ChatChannel.deletedAt :235 模式）：
    `id String @id`（me_ 前缀，服务层 IdGeneratorService 生成）；`level String`（task|project|global，字符串枚举，双库兼容——不声明 Prisma enum）；`taskId String? @map("task_id")` + `projectId String? @map("project_id")`（task 级冗余存 projectId 便于项目内检索）；`content String @db.Text`；`tags Json?`（标签数组）；`createdBy String @map("created_by")`（agent 实例 id 或 user id）；`deletedAt DateTime? @map("deleted_at")`（软删）；`createdAt/updatedAt`。relations：`task Task? @relation(fields:[taskId], references:[id], onDelete: Restrict, onUpdate: Restrict)`、`project Project? @relation(...)`；Task/Project 模型加反向 `memories Memory[]`。索引：`@@index([level], map:"idx_memories_level")`、`@@index([taskId, createdAt], map:"idx_memories_task_time")`、`@@index([projectId, createdAt], map:"idx_memories_project_time")`、`@@map("memories")`
  - 生成迁移：`cd server && npx prisma migrate dev --name memories`（产物 server/prisma/migrations/<ts>_memories/）；`npx prisma generate`
  - 新建 `server/src/memories/memory.constants.ts`：`MEMORY_LEVELS = { task: 'task', project: 'project', global: 'global' } as const`
  - 新建 `server/src/memories/memories.service.ts`（`onModuleInit` 用 `resyncIdPrefix(this.prisma.memory, 'me', this.idGen)` 续号，对齐 session-lifecycle.service.ts:47）+ `memories.module.ts`（providers: MemoryService）+ `app.module.ts` imports MemoriesModule
  - Must NOT：不改现有表；不加全文索引；不引入 Prisma enum
  Parallelization: Wave 1 | Blocked by: - | Blocks: 2, 5
  References (executor has NO interview context - be exhaustive): server/prisma/schema.prisma:121-155（Task 模型）、:225-235（ChatChannel 软删）、:288-342（Issue/Artifact deletedAt 模式）；server/src/common/id-generator.ts:42；server/src/common/id-resync.ts；server/src/workers/session-lifecycle.service.ts:47-53（resyncIdPrefix 用法）；server/src/app.module.ts（模块注册处）
  Acceptance criteria (agent-executable): `cd server && npx prisma migrate status` 输出 up to date；`npx tsc --noEmit` 通过；`npm run test -- memories` 通过（新增 memories.service.spec：resyncIdPrefix 对 me_ 前缀续号）
  QA scenarios (name the exact tool + invocation): happy——`npx prisma migrate dev --name memories` 生成迁移且 `npx prisma migrate deploy` 幂等不报错；failure——重复执行 `npx prisma migrate deploy` 验证幂等（无 schema drift 错误）。Evidence .omo/evidence/task-1-memory-management.txt
  Commit: Y | feat(memory): 记忆表模型与迁移

- [x] 2. mem-mcp：平台 MCP memory_save / memory_search 工具
  What to do / Must NOT do:
  - `server/src/platform-mcp/platform-mcp.tools.ts`：新增 `memorySaveSchema`（`{taskId: string, selfInstanceId: string, level: z.enum(['task','project','global']), content: z.string().min(1).max(20000), tags: z.array(z.string()).max(20).optional()}`）与 `memorySearchSchema`（`{taskId: string, query?: string, level?: z.enum([...]), tags?: z.array(z.string()), limit?: z.number().int().min(1).max(50)}`），并在 `buildPlatformMcpTools` 数组注册 `memory_save` / `memory_search` 两个工具（description 说明三级语义与按需拉取）
  - `server/src/platform-mcp/platform-mcp.service.ts`：
    - `memorySave(ctx, args)`：`assertWorkerTask(ctx, taskId, selfInstanceId)`（:808 归属校验，落库类工具需 selfInstanceId，防冒充）→ **级别校验**：`level=task` → projectId 取 task 行冗余存；`level=project` → projectId 从 task 行反查（**不接收 projectId 入参**，防跨项目写入——写 project 级 = 写当前任务所属项目的记忆）；`level=global` → **仅主 Agent 可写**：`task.mainAgentInstanceId === selfInstanceId` 否则 403（防全局污染，M3）→ `prisma.memory.create({id: nextId('me'), level, taskId, projectId, content, tags, createdBy: selfInstanceId})` → 返回 `{memoryId, level}`
    - `memorySearch(ctx, args)`：`assertWorkerTask(ctx, taskId)`（无 selfInstanceId，只读，查询类工具契约对齐 platform-mcp.tools.ts:100-109 模式）→ 解析 task 行 projectId → `prisma.memory.findMany({where: {deletedAt: null, OR: [{level:'task', taskId}, {level:'project', projectId}, {level:'global'}]}})`（**软删过滤必须**，M7）→ query 过滤（content contains）+ tags 过滤（取回后内存过滤，tags 为 Json 无 prisma contains 支持）+ limit 截断 → 返回 `[{id, level, content, tags, createdBy, createdAt}]`（createdAt desc 排序）
  - Must NOT：不做 memory_list/memory_delete 工具；不改 platform-mcp.controller.ts 分发；不自动注入记忆内容
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: -
  References (executor has NO interview context - be exhaustive): server/src/platform-mcp/platform-mcp.tools.ts:224-332（buildPlatformMcpTools + zod schema 模式，现有 14 工具注册处）；server/src/platform-mcp/platform-mcp.service.ts:808-861（assertWorkerTask 归属校验，selfInstanceId 语义 :819-835）；server/src/platform-mcp/platform-mcp.service.ts 落库类工具 selfInstanceId 用法（groupPost/submitArtifact，先行 grep `selfInstanceId` 定位）；server/src/platform-mcp/platform-mcp.controller.ts:170-205（toolsCall 校验分发，无需改动）
  Acceptance criteria (agent-executable): `cd server && npm run test` 通过（platform-mcp.service.spec 新增用例：memory_save 合法落库返回 memoryId；冒充/无绑定会话 403；非法 level 400；memory_search 聚合 task+project+global 三级、query/tags 过滤、deletedAt 过滤）
  QA scenarios (name the exact tool + invocation): happy——jest platform-mcp.service.spec 新增 describe 全绿；failure——断言跨任务访问（不同 worker 无绑定会话）返回 403、非法 level 返回 400。Evidence .omo/evidence/task-2-memory-management.txt
  Commit: Y | feat(memory): 平台 MCP 记忆工具

- [x] 3. mem-trigger：accept 私信主 Agent 引导记忆总结 + archive 文案补充
  What to do / Must NOT do:
  - `server/src/tasks/tasks.service.ts` `transitionOpts`（:635-753）：
    - `accept` 分支（:698-725）新增 `privateMessage: ({ task }) => '任务已验收完成，产出物基线已锁定。请调用 vteam MCP 的 memory_save 工具（参数 {taskId, selfInstanceId, level: "task", content, tags?}）总结本任务执行中的经验、教训与关键决策，沉淀为任务级记忆；如有跨任务复用价值，另存一条 level=project 记忆。'`
    - `archive` 分支（:737-749）`sysMessage` 文案改为 `任务已归档，历史可回看。任务级记忆已随验收沉淀（未总结不影响归档）`
  - `transition()`（:844-1010）privateChannel 解析：将 `if (action === 'start' && task.mainAgentInstanceId)`（:884）扩展为 `if ((action === 'start' || action === 'accept') && task.mainAgentInstanceId)`——accept 与 start 同样解析主实例 private 频道用于私信
  - **语义（Metis M1，重要）**：`senderType=system` 消息不会触发 worker 执行（chat.service.ts:418 仅对 `senderType=user` 分派 dispatch、:563-577）——accept 私信是**被动提示**：落库 + 广播 `CHAT_MESSAGE_NEW`，主 Agent 在 accept 后**下一次被触发执行时**（@ / notify_agent / 任务收尾）作为私聊历史可见并据此总结。**不承诺立即唤醒**；主动唤醒（accept 后 dispatch 主 Agent）为后续增强（scope out）。记忆总结的主动性由 GLOBAL_SYSTEM_INSTRUCTIONS 常驻引导（Todo 4）兜底——主 Agent 在 completed 后任何一次执行都会收到「验收完成收到总结引导时调用 memory_save」提示
  - Must NOT：不改状态迁移表/迁移逻辑/幂等语义；不在 archive 加 privateMessage（会话冻结 sessions→archived 无法响应）；不做主动唤醒 dispatch；私信失败不得阻塞/回滚 accept（私信落库在事务内、失败仅广播降级——保持现有 transition 异常语义）
  Parallelization: Wave 1 | Blocked by: - | Blocks: -
  References (executor has NO interview context - be exhaustive): server/src/tasks/tasks.service.ts:635-753（transitionOpts 全部动作分支）、:698-725（accept 分支 sysMessage/afterCommit 基线锁定）、:737-749（archive 分支）、:877-903（privateChannel 解析，当前仅 start）、:943-958（private 私信落库模式）、:844-1010（transition 统一入口，CAS/事务/广播）；docs/agent-platform/13-任务状态机与全生命周期.md:105-107（accept/archive 副作用）
  Acceptance criteria (agent-executable): `cd server && npm run test` 通过（tasks.service.spec 新增用例：accept 成功且主实例 private 频道收到 senderType=system 引导私信；无 mainAgentInstanceId 的 accept 正常完成无私信不报错；archive sysMessage 文案含「记忆」）
  QA scenarios (name the exact tool + invocation): happy——jest tasks.service.spec 断言 accept 后 private 频道消息存在；failure——构造无主实例任务断言 accept 不抛错、无私信。Evidence .omo/evidence/task-3-memory-management.txt
  Commit: Y | feat(memory): 验收完成触发记忆总结引导

- [x] 4. mem-inject：GLOBAL_SYSTEM_INSTRUCTIONS 新增【记忆管理】段
  What to do / Must NOT do:
  - `server/src/chat/worker-dispatcher.ts` `GLOBAL_SYSTEM_INSTRUCTIONS` 数组（:58-77）末尾追加一条：
    `【记忆管理】任务执行中的经验与知识可通过 vteam MCP 记忆工具存取。开始任务/需要历史经验时，调用 memory_search（参数 {taskId, query?, level?, tags?, limit?}）按需检索任务级、项目级与全局级记忆；任务验收完成收到总结引导时，调用 memory_save（参数 {taskId, selfInstanceId, level: "task"|"project"|"global", content, tags?}）沉淀经验——任务专属经验写 level=task，跨任务复用价值写 level=project，全局级（level=global）仅沉淀平台通用知识，勿写项目/任务专属信息。`
  - Must NOT：不改其他既有段文案；不自动注入记忆内容（保持 21 篇按需注入哲学）；不改 prompt 构造逻辑本身
  Parallelization: Wave 1 | Blocked by: - | Blocks: -
  References (executor has NO interview context - be exhaustive): server/src/chat/worker-dispatcher.ts:58-77（GLOBAL_SYSTEM_INSTRUCTIONS 数组，join('\n') 注入）；server/src/chat/worker-dispatcher.spec.ts（prompt 构造断言现有用例，追加新断言）；docs/agent-platform/21-平台MCP-Server设计方案.md:37-39,103-107（按需注入决策 + 任务 ID 注入）
  Acceptance criteria (agent-executable): `cd server && npm run test` 通过（worker-dispatcher.spec 新增断言：构造 prompt 包含「【记忆管理】」与 memory_save/memory_search 用法文案）
  QA scenarios (name the exact tool + invocation): happy——jest 断言 prompt 含记忆段；failure——断言若未注入记忆段则测试失败（验证改动真实生效）。Evidence .omo/evidence/task-4-memory-management.txt
  Commit: Y | feat(memory): 系统提示记忆引导

- [x] 5. mem-rest：记忆管理 REST 端点（GET /memories + DELETE /memories/:id）
  What to do / Must NOT do:
  - `server/src/memories/` 新增：
    - `dto/query-memories.dto.ts`：`QueryMemoriesDto { level? (@IsIn(['task','project','global'])), projectId? , taskId?, keyword?, page? (min 1), pageSize? (min 1 max 100) }`（对齐 QueryToolsDto 模式）
    - `memories.service.ts`：`findAll(query)` —— where `{deletedAt: null, level?, taskId?, projectId?, ...(keyword ? {content: {contains: keyword}} : {})}` + `orderBy createdAt desc` + 分页 `{items, total, page, pageSize}`；`remove(id)` —— 不存在 → 404 `MEMORY_NOT_FOUND`；存在 → `update({deletedAt: new Date()})` 软删（对齐 Issue/ChatChannel 软删）
    - `memories.controller.ts`：`@Controller('memories')`，`GET /memories` + `DELETE /memories/:id`，均 `@UseGuards(AdminGuard)`（Metis m6：复用 AdminGuard 的管理端点模式——GET/DELETE 全端点 admin，比 tools 的「GET 成员只读」更严格；AdminGuard 语义为 `permissions.all===true` 或 `users.manage===true`，不扩展权限矩阵）
    - `memories.module.ts`：providers [MemoryService, AdminGuard]（AdminGuard 复用 users/admin.guard.ts）
  - `app.module.ts` imports MemoriesModule（若 Todo 1 已注册则确认唯一注册）
  - Must NOT：不做 PATCH 编辑端点；不扩展权限矩阵（roles.constants.ts 8 资源不动）；不做成员只读 GET 通道
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 6
  References (executor has NO interview context - be exhaustive): server/src/tools/tools.controller.ts:36-81（AdminGuard 管理端点模式）；server/src/users/admin.guard.ts:25-67（AdminGuard 语义）；server/src/tools/tools.service.ts:70-95（分页 + 过滤模式，normalizePage/normalizePageSize）；server/src/issues/issues.service.ts（软删 remove 模式，grep `deletedAt` 定位）；server/src/tools/dto/query-tools.dto.ts（QueryDto 校验模式）
  Acceptance criteria (agent-executable): `cd server && npm run test` 通过（memories.controller.spec + memories.service.spec：GET level/keyword 过滤与分页、DELETE 软删后 findMany 不含、404、403 非 admin）；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy——jest 断言 GET 返回 {items,total,page,pageSize} 且 DELETE 后列表减少；failure——无 admin 权限调用 403、删除不存在 id 404。Evidence .omo/evidence/task-5-memory-management.txt
  Commit: Y | feat(memory): 记忆管理 REST 端点

- [x] 6. mem-web：记忆管理页面 + 导航注册
  What to do / Must NOT do:
  - 新建 `web/app/(main)/memories/page.tsx`（对齐 agents/page.tsx:76-120 分页响应模式 + TanStack Query useQuery/refetch）：
    - 类型 `MemoryItem {id, level: 'task'|'project'|'global', content, tags, createdBy, createdAt}` + `MemoriesResponse {items, total, page, pageSize}`
    - level 筛选 tab（全部/任务/项目/全局，对齐 models/page.tsx tab 模式）；keyword 搜索（防抖 300ms，query 传 GET /memories）；分页列表（level 徽章配色、content 摘要、tags、createdBy、createdAt）；删除按钮（confirm 后 `api.delete('/memories/'+id)` → invalidateQueries 刷新）
    - 数据源 `api.get<MemoriesResponse>('/memories', {query: {level, keyword, page, pageSize}})`（web/lib/api.ts:136-145）
  - `web/src/components/layout/nav-dock.tsx` `NAV_ITEMS`（:35-45）追加 `{ key: "memories", label: "记忆管理", icon: "◈" }`
  - `web/src/components/layout/app-shell.tsx` `PAGE_TITLE`/`EXTRA_PAGE_TITLE`（:212-231）加 `/memories` 映射
  - **导航权限过滤（Metis m5）**：`app-shell.tsx` 的可见导航项过滤函数（:159-166 同处，users/roles 走 `isPlatformAdmin`）把 `memories` 一并纳入——非 admin 不显示「记忆管理」导航项（后端 GET/DELETE 已挂 AdminGuard，非 admin 点击即 403；前端隐藏避免误导）
  - Must NOT：不做编辑/详情弹窗；不改其他页面；不引入新依赖
  Parallelization: Wave 3 | Blocked by: 5 | Blocks: -
  References (executor has NO interview context - be exhaustive): web/app/(main)/agents/page.tsx:76-120（PageResponse 分页 + TanStack Query 模式）、:10（API 注释）；web/lib/api.ts:136-145（api.get/delete）；web/src/components/layout/nav-dock.tsx:35-45（NAV_ITEMS）；web/src/components/layout/app-shell.tsx:212-231（PAGE_TITLE/pathToKey）；web/app/(main)/models/page.tsx（tab 筛选模式）；web/src/theme/tokens.ts（主题 token）
  Acceptance criteria (agent-executable): `cd web && npm run build` 通过；`npm run lint` 通过；Playwright 冒烟（环境允许时）：/memories 页面可达、列表渲染、筛选切换、删除后列表刷新
  QA scenarios (name the exact tool + invocation): happy——`npm run build` + lint + 浏览器访问 /memories 渲染列表；failure——API 返回错误时页面显示错误态、空列表显示空态。Evidence .omo/evidence/task-6-memory-management.txt
  Commit: Y | feat(memory): 记忆管理页面

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
- 每个 todo 完成后单独 commit（约定式提交，scope=memory）：`feat(memory): <subject>`；执行完成后如用户要求可 squash 为单个 commit（AGENTS.md「同一需求不要新增 commit」优先，用 `git commit --amend` 合并后续小改）
- 本改动不涉及 Java 代码（NestJS/TS + Next.js），无需 googleJavaFormat；提交前跑 `npx tsc --noEmit`（server）+ `npm run build`（web）确认无编译错误
- 分支流程（AGENTS.md）：基于 xishuhq 远端默认分支 checkout 开发分支 → 推送 ketabot → PR 指向 xishuhq/develop（head=ketabot:<branch>）
- 数据库迁移文件（server/prisma/migrations/<ts>_memories/）必须随功能 commit 一并提交

## Success criteria
- Agent 可经平台 MCP `memory_save`/`memory_search` 存取三级记忆（task/project/global），归属校验阻止跨任务冒充访问
- 任务 `accept` 时主 Agent 在 private 频道收到总结引导私信；`archive` 群聊系统消息含记忆提示；状态机既有行为无回归
- Admin 可经 `GET /memories` 过滤/搜索/分页查看全部记忆，`DELETE /memories/:id` 软删清理；非 admin 403
- Web「记忆管理」页面可查看/筛选/搜索/删除记忆，导航入口生效
- server 全部单测通过（含 5 个新增/扩展 spec），web build + lint 通过；既有 60+ suites 无回归
