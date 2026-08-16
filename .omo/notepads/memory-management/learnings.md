# Learnings — memory-management

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## Todo 4 mem-inject：GLOBAL_SYSTEM_INSTRUCTIONS 追加【记忆管理】段

- **位置**：`server/src/chat/worker-dispatcher.ts` `GLOBAL_SYSTEM_INSTRUCTIONS` 数组末尾（【托管模式】段之后、`].join('\n')` 之前），作为第 18 条段。
- **文案含双引号**（`level: "task"|"project"|"global"`）→ 数组元素必须用**单引号**包裹，且文案内不得含单引号，否则会破坏 TS 字符串字面量。
- **spec 断言写法**：`GLOBAL_SYSTEM_INSTRUCTIONS` 是 join 后的 string，直接 `expect(...).toContain('【记忆管理】'/'memory_search'/'memory_save')` 即可机器断言（Metis m8 验收：三个 sentinel + 参数契约，勿写"模型会调用工具"行为断言）。
- **顺序回归**：用 `indexOf('【记忆管理】') > indexOf('【托管模式】')` 断言新段追加在末尾、不破坏既有段顺序。
- 验证：`npx jest src/chat/worker-dispatcher.spec.ts --runInBand` 108 passed；`npx tsc --noEmit` 通过。

## Todo 3 mem-trigger：accept 私信主 Agent 引导记忆总结 + archive 文案补充

- **改动文件**：仅 `server/src/tasks/tasks.service.ts` + `tasks.service.spec.ts`（表结构/MCP 工具/系统提示/REST/web 均不在本 todo）。
- **accept 分支 privateMessage**：在 `transitionOpts` 的 accept 分支新增 `privateMessage`（memory_save 引导文案），与 `sysMessage` 并存——群聊文案走 task_group 频道，私信文案走主实例 private 频道。
- **privateChannel 解析扩展**：`transition()` 中 `if (action === 'start' && task.mainAgentInstanceId)` → `if ((action === 'start' || action === 'accept') && ...)`。accept 与 start 共用主实例别名 + private 频道解析路径；`mainAgentInstanceId` 为 null 时跳过解析（保持 start 既有「无则跳过」语义）。
- **⚠️ Metis M1 语义约束（关键）**：senderType=system 消息**不触发** worker 分派（chat.service 仅对 senderType=user dispatch），所以 accept 私信是**被动提示**——事务内 `tx.message.create` 落库 + 事务后 `realtime.broadcast(CHAT_MESSAGE_NEW)` 广播，主 Agent 后续被触发执行时在私聊历史可见。**不要**实现主动唤醒。
- **私信失败不阻塞 accept**：私信与群聊消息同在一个 `sysMessages` 数组，事务内落库、事务后广播；不额外加 try/catch——保持 transition 既有异常语义（广播失败也不回滚已提交的 accept）。
- **archive 不加 privateMessage**：archive 将 sessions 全部置 archived（会话冻结），私信无人可响应，仅群聊 sysMessage 文案补充「任务级记忆已随验收沉淀（未总结不影响归档）」。
- **spec 测试要点**：accept 私信用例需 mock `prisma.chatChannel.findFirst` 两次（task_group + private，用 `mockResolvedValueOnce` 区分）；断言 `toHaveBeenNthCalledWith(2, {where:{taskId, taskAgentId: mainAgentInstanceId, type:'private'}})`；复用既有 `assertSysMessageCreated` 辅助断言 senderType=system 私信文案。无 mainAgentInstanceId 用例断言 `findFirst` 仅调用 1 次（不查 private）且 `message.create` 仅 1 次。
- 验证：`npx jest tasks/tasks.service.spec.ts --runInBand` 63 passed；`npx tsc --noEmit` 通过。

## Todo 1 实现发现（mem-store：Memory 模型 + 迁移 + 模块骨架）

- **本地 DATABASE_URL 指向 localhost:3307 不可达**：server/.env 配置的是 3307 端口但无进程监听。
  实际可用的库是 compose 栈的 `aiagents-compose-db`（172.24.0.5:3306，root/aiagents-root，db=aiagents）。
  运行 prisma 命令用环境变量覆盖 `DATABASE_URL="mysql://root:aiagents-root@172.24.0.5:3306/aiagents"`，不改 .env。

- **migrate dev 直接连 aiagents 库会检测到历史 drift 并强制 reset**：现有库 issues/projects/skills/tasks 的
  description 列与迁移预期不符（TEXT vs VARCHAR），prisma 要求 reset（会丢运行中服务的数据）。
  安全做法：在同一个 MySQL 实例建临时库（如 aiagents_mem_tmp），对空库跑 migrate dev
  （应用全部 18 个历史迁移 + 生成新迁移），产物与直接生成一致，验证后 DROP 临时库。

- **migrate dev 生成的迁移会混入历史 schema drift 的「补偿 alter」**：本次生成的 memories 迁移被塞进了
  `ALTER TABLE sessions MODIFY task_agent_id NOT NULL`、`ALTER TABLE task_agents MODIFY work_dir VARCHAR(191)`，
  来源是历史迁移与 schema.prisma 的类型漂移（role_instance_separation 建列可空、agent_work_dir 建列 VARCHAR(255)）。
  这类 alter 与本次变更无关、违反「不改动现有表结构」，必须手动从 migration.sql 剔除，只保留 CreateTable + 新 FK。
  剔除以 20260815150204_memories/migration.sql 为准。

- **迁移目录现为 19 个**：20260815150204_memories/ 为本次新增，含 CreateTable memories + 两个 FK
  （memories_task_id_fkey → tasks、memories_project_id_fkey → projects）。

- **验证链路**：临时库 `prisma migrate deploy` 全部应用 → `migrate status` 输出 "up to date" →
  SHOW CREATE TABLE 核对 FK → `tsc --noEmit` → `npx jest src/memories/... --runInBand`。
  jest 不依赖 MySQL（setup-env.js 切 sqlite 测试库）。

## Todo 5 mem-rest：记忆管理 REST 端点（GET /memories + DELETE /memories/:id）

- **改动文件**：`memories/dto/query-memories.dto.ts`（新建）、`memories.controller.ts`（新建）、
  `memories.controller.spec.ts`（新建）、`memories.service.ts`（填充 findAll/remove）、
  `memories.module.ts`（注册 Controller + AdminGuard）、`memory.constants.ts`（追加 MEMORY_ERRORS）。
- **错误码常量放 memory.constants.ts**：域错误码（MEMORY_NOT_FOUND）直接追加到既有 memory 域常量文件，
  对齐 tool.constants / mcp-server.constants 的「域常量单文件」约定，无需另建文件。
- **QueryMemoriesDto 对齐 QueryToolsDto**：page/pageSize 用 `@Type(() => Number) @IsInt @Min(1)`，
  pageSize 额外 `@Max(100)`（参考 query-messages.dto.ts）；level 用 `@IsIn(Object.values(MEMORY_LEVELS))`
  从常量单一来源取值（而非硬编码数组），避免与 memory.constants.ts 漂移。
- **findAll where 组装**：`{deletedAt: null, ...(level?…), ...(taskId?…), ...(projectId?…), ...(keyword? {content: {contains: keyword}})}`
  —— 用展开运算符条件透传（对齐 tools.service 的 `field: q ? {…} : undefined` 两种写法皆可，
  本实现取展开式，undefined 键天然剔除）。分页 `{items, total, page, pageSize}` 经
  normalizePage/normalizePageSize（pageSize 上限 100）。
- **remove 404 语义**：`findUnique` 后 `!existing || existing.deletedAt` 均 404（已软删条目二次删除也 404），
  对齐 issues.service 的 `if (!issue || issue.deletedAt)` 先例；存在则 `update({data: {deletedAt: new Date()}})`
  软删并**返回软删后条目**（对齐 ChatChannel 软删，比 issues 的 `{id, deleted: true}` 返回更完整）。
- **全端点 AdminGuard**：GET/DELETE 均 `@UseGuards(AdminGuard)`（Metis m6 比 tools 的 GET 成员只读更严格），
  模块 providers 注册 `[MemoriesService, AdminGuard]`（AdminGuard 无状态仅依赖全局 PrismaService，
  参照 tools/tools.module.ts:19-21）。
- **controller.spec 的 403 测试策略**：AdminGuard 的 403 语义已有独立 `admin.guard.spec.ts` 全覆盖，
  controller.spec 用两个 describe——主 describe `overrideGuard(AdminGuard)→true` 测端点委托 +
  反射 `Reflect.getMetadata('__guards__', proto.findXxx)` 断言守卫元数据；独立 describe 提供真实
  AdminGuard + mock PrismaService 复验非 admin 403 FORBIDDEN_ADMIN。
- **⚠️ service.spec 的 $transaction mock**：`prisma.$transaction((args) => Promise.resolve(args))` 会返回
  未 resolve 的 promise 数组（断言拿到 Promise {}）；必须 `(args) => Promise.all(args)` 才能得到
  `[total, rows]` 解构值。
- **验证**：`npx jest src/memories --runInBand` 15 passed；`npx tsc --noEmit` 的报错全部来自
  platform-mcp（Todo 2 在途 memory_save 工具，新增 550 行），memories 目录零类型错误。
- **并行在途观察**：全量 jest 1 失败（platform-mcp.controller.spec.ts 工具名列表未含
  memory_save/memory_search）——Todo 2 待同步其 controller spec，非本任务回归。

## Todo 2 mem-mcp：platform-mcp 域实现 memory_save / memory_search 工具

- **改动文件**：`server/src/platform-mcp/platform-mcp.tools.ts` + `platform-mcp.service.ts` + `platform-mcp.service.spec.ts`（+ controller.spec.ts 工具数量断言 14→16）。
- **工具注册**：`buildPlatformMcpTools` 数组末尾追加 memory_save / memory_search（question_confirm 之后），工具数 14→16。**schema 必须 export**（`export const memorySaveSchema`）——controller.spec 需 import 测 zod safeParse 失败路径；文件内其他 schema 均不 export（仅内部消费），新增时按需导出即可。
- **memory_save 级别校验**（Metis M3/M4）：
  - task：`taskId=当前任务`、`projectId` 取 task 行冗余存（schema.prisma 注释「task 级冗余存 projectId」）；
  - project：`projectId` 从 task 行 `findUnique select projectId` 反查——**入参不接收 projectId**（TS 类型层面即拦截，防跨项目写入）；
  - global：`task.mainAgentInstanceId === selfInstanceId` 否则 403 PLATFORM_MCP_FORBIDDEN（防全局污染）。
- **落库形状**：`id: await this.idGen.nextId('me')`（MEMORY_ID_PREFIX='me'，与 memories.service.ts 一致）→ `me_0000000001`；`tags` 无标签传 `null`（`as Prisma.InputJsonValue | null`）；`createdBy=selfInstanceId`。
- **memory_search 软删过滤必须**（Metis M7）：`where: {deletedAt: null, OR: [{level:'task', taskId}, {level:'project', projectId}, {level:'global'}]}`；task 无 projectId 时**跳过 project 分支**（否则 `{level:'project', projectId: null}` 会误匹配无项目归属的 project 级记忆）。
- **query 用 prisma `content: {contains}` 层过滤**；**tags 取回后内存过滤**（Json 列无 prisma contains 支持，`filterMemoryByTags` 泛型化 `<T extends {tags}>` 保 DTO 类型不丢失）；limit 取回后 `slice(0, n)`（默认 20、max 50，`normalizeMemoryLimit` 收敛）。
- **`filterMemoryByTags` 必须泛型化**：若返回类型收窄为 `Array<{tags}>`，调用侧 `.map` 里访问 row.id/level/content 会 TS2339（tags-only 类型丢失）——泛型透传原行类型即可。
- **controller.spec.ts 工具数量断言需同步**：tools/list「返回 14 个工具」→ 16 个（names 数组追加 memory_save/memory_search + 各新增工具必填字段断言）。controller 分发逻辑（toolsCall）不动。
- 验证：`npx tsc --noEmit` 通过；`npx jest src/platform-mcp --runInBand` 100 passed（service 99 + controller 1）。

## Todo 6 mem-web：记忆管理页面 + 导航注册

- **改动文件**：`web/app/(main)/memories/page.tsx`（新建）、`web/src/components/layout/nav-dock.tsx`（NAV_ITEMS 追加）、`web/src/components/layout/app-shell.tsx`（PAGE_TITLE + KEY_TO_PATH + NAV_VISIBLE + CMDK_NAV_PATH + ROUTE_GUARD 五处追加）。
- **页面模式**：对齐 agents/models 页面 TanStack Query + api 封装。`useQuery<MemoriesResponse>` + `useMutation` + `invalidateQueries` 刷新。分页复用 `PageResponse<T>` 同构（items/total/page/pageSize）。
- **Tab 筛选**：复用 models/manage-tabs/manage-tab 模式（`data-testid="manage-tabs"` + `data-kind` + `data-active`），4 个级别 Tab（全部="" / task / project / global），切换时重置页码。
- **搜索防抖**：keyword state → `useEffect` 300ms 延迟 → debouncedKeyword → queryKey 变化触发 refetch。防抖同时重置 page=1。
- **级别徽章配色**：task=蓝(#2563EB) / project=紫(#7C3AED) / global=绿(#059669)，与 tokens 语义色系一致。
- **删除**：ConfirmDialog 二次确认 → `api.delete('/memories/'+id)` → `invalidateQueries` 刷新。删除失败 toast 固定定位 bottom center。
- **导航注册**：NAV_ITEMS 末尾追加 `{ key: "memories", label: "记忆管理", icon: "◈" }`。icon 用单字符符号对齐已有项。
- **app-shell 五处追加**：
  1. `KEY_TO_PATH`: `memories: "/memories"`
  2. `PAGE_TITLE`: `memories: { title: "记忆管理", subtitle: "查看与管理 Agent 记忆" }`
  3. `NAV_VISIBLE`: `memories: isPlatformAdmin`（Metis m5：非 admin 不显示入口）
  4. `CMDK_NAV_PATH`: `记忆管理: "/memories"`（命令面板导航组）
  5. `ROUTE_GUARD`: `memories: isPlatformAdmin`（路由守卫，非 admin 直接重定向）
- **验证**：`npx tsc --noEmit` 通过（零类型错误）；`npx eslint` 改动文件零错误零警告；`npm run lint` 14 warnings 均为既有代码（agents/artifacts/messages/models 等），非本次引入。`npm run build` 失败因环境 `@tailwindcss/postcss` 缺失（pre-existing，git stash 还原后 build 同样失败）。
- **⚠️ web/AGENTS.md Next.js 特殊约定**：文档要求读 `node_modules/next/dist/docs/` 下指南，但该目录不存在（no files found）。实际 next 版本 15.5.22，构建配置为标准 App Router，本次页面未涉及 breaking change。

## Todo 2 F2 修复：M2 显式级别分支 + M3 无 projectId 分支测试

- **M2 纵深防御**：`memorySave` 级别判断由 `task → project → else(隐式 global)` 改为显式三分支 `task → project → global` + **else 抛 400**（`BadRequestException({code: PLATFORM_MCP_MEMORY_INVALID, message: '非法记忆级别：<level>'})`）。非法 level 不再落入 global 分支（zod schema 已保证合法，此处防绕过 schema 直调 service）。新增错误码常量 `MEMORY_INVALID: 'PLATFORM_MCP_MEMORY_INVALID'` 于 platform-mcp.constants.ts（对齐 ARTIFACT_INVALID 命名模式）。
- **M3 测试补两条**（memory_search describe，mock `task.projectId: null`）：
  1. 显式 `level='project'` → `whereOr.length === 0` 早返回 `[]`（断言 `findMany` 未调用）；
  2. level 未传 → project 分支被跳过，`where.OR` 仅 `[{level:'task', taskId}, {level:'global'}]` 两级（task 无项目归属时不生成 `{level:'project', projectId: null}` 的误匹配条件）。
- 保持既有行为：task 有 projectId 时 project 分支照常生成，既有用例全绿。
- 验证：`npx tsc --noEmit` 通过；`npx jest src/platform-mcp --runInBand` **102 passed**（service 101 + controller 1）。

## F2 修复 M1：memories 页面删除失败提示 T15 违规

- **问题**：删除失败 toast 使用 `position: "fixed"` + `zIndex: 70`，违反页面铁律 T15（"无 fixed / 100vh / 100vw"）。
- **修复**：替换为内联 `role="alert"` 错误区，对齐 agents 页 `agent-delete-error` / `agent-save-error` 显示模式（neutral 红背景 + `!` 前缀 + 错误文案）。删除了 fixed/bottom/left/transform/zIndex 属性。
- **验证**：`npx tsc --noEmit` 通过；`npx eslint` 改动文件零错误；`grep "fixed"` 无命中。T15 铁律恢复。

## [2026-08-15T15:38Z] Task: plan-complete — 记忆管理计划全部完成
- 6 个实现任务 + F1-F4 终验全部完成（10/10），commit `cdad5e6`（feat(memory): 平台记忆管理）
- 最终验证：server 62 suites / 1258 tests 全绿；web build 通过（node v22.22.1，需 PATH 含 nvm 版本）；web lint 0 errors
- F1-F4 评审全部 APPROVE：F1 计划合规 / F2 代码质量（4 minor 已修 M1 fixed toast→内联、M2 level 显式分支+400、M3 补 2 条分支测试；M4 分页越界记为后续 UX 项）/ F3 真实 QA（REST+MCP 全链路 curl 验证，测试数据已清理）/ F4 范围保真（零蔓延）
- 部署前置：compose server 镜像需重建（含新代码）+ `prisma migrate deploy`（迁移 20260815150204_memories 已在 F3 验证可应用）
- 环境经验：web build 需 Node ≥20（本机 /usr/local/bin/node 为 v18.15.0，需 `export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"`）；web 依赖 @tailwindcss/postcss 需 npm install 补装
- git 收尾：task() 派发 session 创建失败（[object Object]）时，orchestrator 受控 git add+commit 兜底（精确清单，勿 git add .）

## [2026-08-16] Task: k8s 部署完成 — 记忆管理功能上线（REV 43）
- 镜像：server/web `docker-hosted.ketaops.cc/xishuhq/vteam-{server,web}:vteam-k8s-memory`（HEAD=cdad5e6）；worker 零改动复用 vteam-k8s-mcpurl
- ⚠️ web 镜像构建 context 必须为**仓库根**（`docker build -f web/Dockerfile .`，web/Dockerfile 引用了 web/package.json + worker + scripts/pack-worker.sh）；用 ./web 作为 context 会构建失败
- upgrade 纪律（REV14）：`helm get values vteam -n vteam -o yaml` 导出基线 → sed 只改 server/web 的 tag → `kubectl delete job vteam-init`（Job 不可变）→ `helm upgrade vteam chart/vteam -n vteam -f baseline --wait --timeout 300s`
- 验证：init Job 应用迁移 20260815150204_memories（memories 表存在）→ GET /api/v1/memories 返回 {items,total,page,pageSize} → MCP tools/list 含 memory_save/memory_search → web /memories 200
- 环境：context admin@local、ns vteam、ingress host vteam.ketaops.cc（NodePort 32054）；secret.dbPassword 从基线文件读取（kubectl exec mysql 查询用）
