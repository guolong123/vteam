# Learnings — model-management

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## FILE-01: 创建任务「上传背景文档」占位按钮接入真实上传（2026-08-09，实现 + tsc 验证完成）

- **问题（QA 报告）**：`doc-upload-btn` 无 onClick（注释「Phase 1 不实现真实选择」），点击无反应 → backgroundDocs 恒空 → 任务无背景文档上下文。QA 报告 FILE-01 行（原判「无需修复/Phase 2」，本次按任务收尾补齐）。
- **前置基础（已就绪，无需新增后端）**：`POST /api/v1/uploads`（multipart 字段 `file`，JwtAuthGuard 全局鉴权）→ 201 `{url, name, size, ext}`（`url=/uploads/<UUID.ext>`，`size` 字节）；`GET /uploads/*` 静态可访问；白名单扩展名（pdf/doc/docx/xls/xlsx/csv/png/jpg/jpeg/gif/md/txt）+ 10MB 上限。
- **后端零改动确认**：`CreateTaskDto.backgroundDocs?: unknown[]` 本就是任意 Json 数组（存 `tasks.background_docs` Json 列），对象数组 `[{name, url}]` 直接兼容——**无需调整字段语义**。`tasks.service.ts` start() 私信消费逻辑（:542-549）对每元素「object 有 name 取 name，否则 String(d)」，传 `{name, url}` 后启动私信正确展示文档名。测试基线已有 `backgroundDocs: [{ name: 'd' }]` 对象数组用例。
- **worker 注入评估**：worker 侧（worker/src）**无 backgroundDocs 引用**（grep 确认）——背景文档仅是任务元数据，经启动私信把文档名提示给主 Agent；worker 资源注入只处理 skills/tools/mcpServers。**当前传 URL 仅为存引用**（落库后未来可经 GET /uploads/* 拉取内容），符合任务「仅存引用传 URL 即可」的评估结论。
- **前端实现**（`web/app/(main)/tasks/new/page.tsx`）：
  1. `BackgroundDoc` 加 `url` 字段；新增 `UploadedFileMeta` 接口 + `formatFileSize(bytes)`（KB 取整/MB 一位小数，对齐原型 mockDocs "868 KB"/"2.4 MB"）+ `colorOf(ext)`（docTypeColors 命中用之，否则 `DEFAULT_DOC_COLOR #64748B` 兜底——白名单 12 种 ext 仅 3 种有色，无兜底会白底白字）。
  2. `TaskForm`：内部 `fileInputRef` + hidden `<input data-testid="doc-file-input">`（accept 对齐上传白名单，onChange 上抛 File 并重置 value 允许重选同文件）；`doc-upload-btn` 加 `onClick` + `disabled={uploading}`（文案「上传中…」+ opacity 0.7）；上传错误条 `doc-upload-error`（role=alert + 关闭按钮 `doc-upload-error-dismiss`，红系配色对齐 create-error）。
  3. 文件列表行 testid `doc-file` → **`doc-file-item`**（key 由 `doc.name` 改 `doc.url`——UUID 文件名唯一，同名文件不冲突）；移除按钮加 `data-testid="doc-file-remove"`，`onRemoveDoc(url)` 按 url 过滤。
  4. 页面 `uploadMutation`（POST /uploads FormData，复用 api.ts 对 FormData 不设 Content-Type 的分支）→ onSuccess 转 `{name, size: formatFileSize, ext: toUpperCase(), color, url}` 入列表；onError `isApiError` 展示。
  5. **提交 payload**：`backgroundDocs.map(d => d.name)` → `backgroundDocs.map(d => ({ name: d.name, url: d.url }))`。
- **e2e 同步**：`web/e2e/reference/testids.ts` 1.3 task-create 条目 `doc-file` → `doc-file-input`/`doc-file-item`/`doc-file-remove`/`doc-upload-error`/`doc-upload-error-dismiss`（原 `doc-file` 仅在审计注册、无实际断言，安全替换）。
- **⚠️ 并行会话竞争**：工作区存在大量并行会话未提交改动（server chat/skills/workers/*、schema.prisma、web messages/skills/workers/* 等）——本次仅动 web tasks/new/page.tsx + testids.ts + notepad 三个文件；server tsc 未跑（后端零改动，命中并行中间态无意义）。web `npx tsc --noEmit` **0 错误**。
- **遗留（决策）**：拖拽上传（drop handler）未实现——按钮文案含「拖拽」但仅支持点击选文件，与原型「点击或拖拽」文案存在轻微偏差（Phase 2 可补 drag/drop）；未做上传中预览缩略图（仅显示文件名/大小/扩展名角标）。

---

## UX-01: Worker 重启/下线按钮从永久禁用变为真实可用（2026-08-09，实现 + 测试完成）

- **问题（QA 报告）**：workers 页「重启」「下线」按钮永久 disabled（注释「后端无端点」）。QA 报告 .gstack/qa-reports/qa-report-open-issues-2026-08-09.md UX-01 行。
- **设计决策（关键探索结论）**：worker 是**独立容器/进程**（opencode serve），server **无进程控制能力**——但已有 **T4a WorkerCommand 下行命令通道**（server `enqueueCommand` → worker 心跳时 `pendingCommands` 取出 → 心跳响应携带 commands → worker `dispatchCommands` → `onCommands` 回调执行）。**方案：复用该通道，不引入新协议**。worker 侧已具备两块可复用能力：
  1. **T4c RestartCoordinator**：`requestRestart()` 无活跃会话立即重启 serve + reRegister（更新 baseUrl/port），有活跃会话挂起等归零——重启命令直接复用它。
  2. **优雅退出 shutdown**（SIGTERM/SIGINT 收口：停心跳 → flush 事件 → stop serve → exit）——下线命令直接调它。
- **后端（workers.service + controller）**：
  - `WORKER_COMMAND_TYPES` 新增 `RESTART: 'restart'`、`SHUTDOWN: 'shutdown'`。
  - `requestRestart(id)`：findUnique 校验（404 WORKER_NOT_FOUND）→ `enqueueCommand({type:'restart', resourceVersion:'remote-restart'})` → 返回 `{workerId, command, queued:true}`。**不改状态**（重启期间心跳中断 30s 判离线属正常，reRegister 后恢复）。
  - `requestShutdown(id)`：**双管齐下**——① 立即 `update status=offline`（调度器 `assignWorker` 的 `status != offline` 过滤立刻停止分配 + 前端列表即时反映）；② `enqueueCommand({type:'shutdown'})` → worker 收到后优雅退出（进程退出 → 心跳停止 → **不会再刷回 online**，30s 健康检查兜底）。同步清理该 worker 的 `workerMcpStatus` 内存态（对齐 markStaleWorkersOffline 行为）。
  - controller：`POST :id/restart` / `POST :id/shutdown`，`@UseGuards(PermissionGuard) + @RequirePermission('workers.edit')`（CONF-03 读写同资源权限点；双段路由不与 `:id` 单段冲突）。
- **worker 侧（双写铁律）**：`worker-protocol.ts` WORKER_COMMAND_TYPES **必须与 server 同步新增**（T1 契约双写，contract.spec 靠 JSON 互通不锁枚举值）——只改 server 不改 worker 会导致命令 type 无法匹配。`index.ts`：dispatchCommands 打日志分支（RESTART「远程重启」/ SHUTDOWN「优雅退出」）+ onCommands handler 新增分支——RESTART → `restartCoordinator.requestRestart('远程重启')`（pending 打日志）；SHUTDOWN → `shutdown('remote-shutdown')`（main() 闭包内可直接引用，防重入由 shuttingDown 保证）。
- **前端（workers/page.tsx）**：
  - 权限：`hasPermission(user?.permissions, "workers", "edit")`（对齐后端 PermissionGuard）。
  - 操作可用性：**offline 禁用**（命令需心跳下发，offline 无心跳可取命令）+ busy 防并发（同一卡片任一操作进行中两按钮均禁用）。
  - 两个 `useMutation`（restart/shutdown）：onMutate 设 busy → onSuccess `invalidateQueries(["workers"])`（10s 轮询外立即刷新）→ onError 设页级错误条（`worker-action-error`，role=alert + 关闭按钮 + 3s 自动消失，对齐 skills 页 notice/providerError 模式）。
  - busy 态按钮文字「重启中…/下线中…」；offline/无权限 disabled + title 解释原因。
- **验证**：server `npx tsc --noEmit` **workers 文件 0 错误**（唯一报错来自**并行会话**的 `chat.service.spec.ts` 中间态 TS2739——非本任务文件）；jest workers.service.spec + workers.controller.spec **81/81 全绿**（新增 service 6 例：restart 入队/404、shutdown 入队+标 offline/404、mcpStatus 清理、restart 命令心跳取出即清空 + controller 2 例转发）；worker `npm run typecheck` 0 错误 + jest index.spec **30/30**（新增 restart/shutdown 透传 2 例）；web `npx tsc --noEmit` 0 错误。
- **⚠️ 并行会话竞争（复现）**：本工作区存在并行会话正在改 chat/skills 模块（`git status` 可见 chat.service.spec.ts/chat.service.ts/skills.*/schema.prisma/app.module.ts/main.ts 未提交改动）——server 项目级 tsc 会命中其中间态错误。**验证自己的改动用 git status 先区分文件归属，再对非本任务文件的报错向用户说明，不代改。**
- **遗留（决策）**：offline worker 调用 restart/shutdown API 时命令会**排队**（恢复上线后由心跳取出执行）——这是「离线期间操作补发」语义，前端按钮已禁用该入口，API 层保留幂等不报错。

---

## CONF-02: 权限矩阵「41 个未校验权限点」前端标注未启用（2026-08-09，实现 + tsc 验证完成）

- **问题（QA 严重）**：`server` 全仓 grep `@RequirePermission` 实证仅 7 个权限点被后端校验——agents.view/create/edit/delete（agents.controller.ts 全 4 操作）+ projects.create（projects.controller.ts:43）+ skills.view（skills.controller.ts:68/86）+ workers.view（workers.controller.ts:68/77）。前端角色配置页 `web/app/(main)/roles/page.tsx` 渲染 8 资源 × 6 操作 = 48 格，其中 41 格勾选后无任何后端校验 → **权限配置 UI 与后端校验脱节**（给受限角色加 `workers.edit: true` 后 PATCH worker 仍 403，实证勾选不生效）。
- **⚠️ 关键映射事实（projects.create 特殊性）**：后端校验 7 点中有 `projects.create`，但该权限点**不在前端矩阵**——前端 RESOURCES 8 项（tasks/chats/artifacts/agents/workers/skills/users/roles，对齐 roles.constants.ts PERMISSION_RESOURCES）不含 projects 资源。因此前端矩阵内实际命中白名单的仅 **6 格**（agents 4 + skills.view + workers.view），`projects.create` 保留在集合中仅供集中审计，渲染永不命中。
- **方案（报告建议①：仅前端标注，禁改后端守卫体系）**：
  1. `IMPLEMENTED_PERMISSIONS: ReadonlySet<string>` = 后端实际校验 7 点（含 projects.create 审计参考）。
  2. `PermissionMatrix` 渲染：不在白名单的格子 → 灰显虚线格「—」+ `data-implemented="false"` + title「该权限点后端未启用，勾选不生效」+ 非 button（不可点击，不触发 onToggle）。
  3. 整行资源无任何已启用点（tasks/chats/artifacts/users/roles 全行 6 格均未实现）→ 资源名后追加「未启用」pill 徽标。
  4. `PermLegend` 图例加第 4 项「未启用」（灰色虚线格），与 ✓/◐/✗ 并列；矩阵下两处说明文案补充「灰色「—」格为后端未启用的权限点」。
- **⚠️ 执行纪律（本次遵守）**：未动 server 任何守卫/常量；未启动 dev server / 不跑 playwright / 不 docker build——只做 `cd web && npx tsc --noEmit` 0 错误 + eslint 0 告警验证。
- **⚠️ 并行会话竞争（本次踩坑）**：同一 CONF-02 任务有并行会话同时编辑本文件，曾出现两份 `IMPLEMENTED_PERMISSIONS` 重复声明 + `isPermissionImplemented(ri,ci)`/`implementedAllowCount`/`unimplBadgeStyle` 等并行实现（git diff 可见）。并行会话随后回滚其改动，最终磁盘 diff 仅保留本会话实现（tsc 重复声明错误消失）。**教训：并行改同一文件需先看 git status/diff 基线，edit 前重读文件确认无并发写入。**
- **遗留（决策）**：`matrixToPermissions` 仍按矩阵值提交未实现格（若角色权限曾存 true 会原样提交）——后端不校验该点故无害，且任务明确"仅消除 UI 误导"；真正补后端校验为 CONF-03 单独处理。

---

## E4: CONF-01 修复——模板 Agent 默认模型与 worker 实际能力对齐（2026-08-09，实现 + 测试完成）

- **问题（QA 严重）**：4 个模板 Agent 默认模型（zhipu/glm-5.1、deepseek/deepseek-v4-pro、opencode-go/deepseek-v4-flash、zhipu/glm-5.2）与 worker `w_compose_worker` 实际能力（**仅 26 个 opencode/* 免费模型**）交集为空 → 模板 Agent 默认模型创建任务 → dispatch 模型不匹配 → 无回复/insufficient_quota（OBS-009 配置层根因）。
- **探索确认（权威数据源）**：DB 查询（compose db `worker_model_availabilities` 26 行 + `workers.capabilities.models` 26 个）确认 worker 实际可执行清单 = 26 个 `opencode/*` 免费模型（ling-3.0-tiny-free / deepseek-v4-flash-free / glm-5-free / nemotron-3-ultra-free / qwen3.6-plus-free / big-pickle / grok-code 等，`opencode` provider）。**worker 上报模型已 C3 合并入库**（models 表 md_9~md_34 全部 enabled，与上报顺序一一对应，md_1~8 为 seed 核心模型）。
- **改动面**：
  1. `agent.constants.ts` STATIC_AVAILABLE_MODELS **追加 26 个 opencode/* 免费模型**（顺序与 worker 上报/DB md_9~34 完全一致——保证 buildModelSeedRows 编号对齐、seed 幂等无主键冲突；新部署 create 用友好 name，已部署 DB 走 upsert update 保留原 name）。
  2. TEMPLATE_DEFAULT_MODELS 改为 worker 可执行模型（保持 §4.1 语义侧重）：产品→`opencode/glm-5-free`（通用对话）、架构→`opencode/nemotron-3-ultra-free`（推理）、开发→`opencode/deepseek-v4-flash-free`（代码+快速，延续旧 DeepSeek 语义）、测试→`opencode/qwen3.6-plus-free`（通用强，穷举边界）。格式 `providerID/modelID` 不变（D7）。
  3. `seed.ts` 引用常量自动生效（:149 update + :154 create 均取 TEMPLATE_DEFAULT_MODELS），仅更新注释 8→34。
  4. `agent.constants.spec.ts`：`:8` 行数断言 8→34；**新增 CONF-01 契约断言**——模板默认模型与 STATIC_AVAILABLE_MODELS 中 opencode/* 模型均 ∈ worker 实测清单（spec 内硬编码 26 模型集合 + size===26 双锁，防"目录=能力"再脱节）。
- **验证**：server `npx tsc --noEmit` 0 错误；`jest agent.constants.spec` 6/6 全绿（含新增 CONF-01 用例）；`jest agents.service.spec` 27/27 全绿（fallback 断言 `toContain opencode-go/deepseek-v4-flash` 保留，不受新增影响）。
- **⚠️ 已存在 DB 模板 Agent 处理**：模板只读（PATCH 403）堵死配置通道，**DB 中已存在的 4 个模板 Agent defaultModelId 仍为旧值**（zhipu/deepseek 等）。**重 seed 机制 = seed.ts 幂等 upsert 的 update 分支**（:149 `update: { defaultModelId: TEMPLATE_DEFAULT_MODELS[agent.id] }`）——对已部署环境跑一次 `node dist/prisma/seed.js`（或 compose init 命令）即更新模板 defaultModelId；无独立迁移脚本，不重 seed 则旧值残留。
- **⚠️ 编号对齐坑（后续加 opencode/* 模型的铁律）**：buildModelSeedRows 按 STATIC_AVAILABLE_MODELS 顺序生成 `md_${idx+1}`；若追加模型的顺序与已上报入库的 md_ 编号不一致，且该模型在目标 DB 不存在（走 create 分支），会与已占用的 md_ 主键冲突。**新增 worker 实测模型必须按上报顺序追加**（当前 md_9~34 与 worker capabilities.models 顺序一一对应）。

---

## E3: 修复 MOCK-04 项目卡片「0 已完成」「0 个 Agent 成员」硬编码（2026-08-09，实现 + 浏览器实证完成）

- **根因**：`web/app/(main)/projects/page.tsx` 三处 Phase 1 占位——`EMPTY_TASK_COUNT = 0` 写死「已完成」数、`EMPTY_MEMBERS: RoleKey[] = []` 空成员数组、aria-label 硬编码「0 个 Agent 成员」；后端 `GET /projects` 只返回 `taskCount`（总任务数），无状态聚合、无成员列表。
- **方案（后端聚合，一次到位，非前端 N+1）**：`ProjectsService.findAll` 扩展两个响应字段，各一次查询（无 N+1、无 tasks 端点分页截断问题）：
  1. **`completedTaskCount`**：`prisma.task.groupBy({ by:['projectId'], where:{ projectId:{in}, status:{in:[completed, archived]} }, _count:{_all:true} })`——**「已完成」口径 = completed + archived**（归档是已完成终态，`TASK_TRANSITIONS.archive` 仅接受 completed；F3 的 6 个归档任务正确计入）。
  2. **`agentMembers`**：`prisma.taskAgent.findMany({ where:{ task:{projectId:{in}}, removedAt:null }, select agent {id,name,role} })`——项目下所有任务团队**未移除** Agent，内存按 projectId 去重（同 Agent 多任务只算一次）；**附真实 role**（对齐 `chat.service findOne` 的 agentMembers 模式），前端头像渲染直接用 `toAvatarRole(role)`（未知/自定义 → developer 兜底，对齐 agents 页），无需静态 id→role 映射表。
  - 空项目列表（`projectIds.length === 0`）短路跳过两个统计查询（spec 断言不调用）。
- **前端**：`Project` 接口加 `completedTaskCount` + `agentMembers: ProjectAgentMember[]`（`{agentId, name, role}`）；删 `EMPTY_TASK_COUNT`/`EMPTY_MEMBERS` 两常量；卡片渲染 `{project.completedTaskCount} 已完成` + `aria-label={agentMembers.length} 个 Agent 成员` + 头像堆叠；`taskCount ?? 0` 兜底一并删除（后端恒返回数字）。
- **验证**：server `nest build` 通过 + jest **44 suites / 707 tests 全绿**（基线 705 + 2 新用例：去重聚合断言含同 Agent 多任务只算一次 + 空项目回落 0/空数组 + 无项目不发统计查询）；web `npx tsc --noEmit` 0 错误。
- **浏览器实证（playwright channel=chrome）**：临时改库 p_seed_1 任务 → completed → 登录 seed-admin → /projects → p_seed_1 卡片「1 已完成」+「2 个 Agent 成员」aria-label + 2 个头像（a_architect/a_product）；p_seed_2 空项目「0 已完成」+ 空成员容器；0 console error；**实证后恢复任务为 in_progress**（改库验证 → 恢复现场闭环）。
- **⚠️ playwright 临时 spec 匹配坑**：`--project=pages` 的 `testMatch: /pages\.spec\.ts/` 只匹配该字面文件名——临时验证 spec 需命名 `e2e/mock04-pages.spec.ts`（含 "pages.spec.ts" 子串）才能跑进 pages 项目；测完删除。
- **⚠️ 断言坑**：卡片「1 个任务」数字与文案跨元素（数字在独立 span aria-hidden 内）——`getByText("1 个任务")` 匹配不到，用 `card.toContainText(/1\s*个任务/)`（innerText 合并跨元素文本）；AgentAvatar 内部多层 span，数头像用 `:scope > span`；0 成员空容器尺寸 0 是 hidden，`toBeAttached` 而非 `toBeVisible`。
- **⚠️ 环境坑（复现）**：3000 后端双实例（keta 用户 `--enable-source-maps` + root 无参）都被新 dist 覆盖重启；turbopack dev server 多次 playwright 连跑后无征兆退出（日志尾 `[?25h`，无错误）——重启用 `nohup node_modules/.bin/next dev --turbopack -p 3001` + `disown`（setsid 也退过）。

---

## E2: OBS-009 可观测性——模型调用失败快速报错（step-finish reason=error，2026-08-09，实现 + 测试完成）

- **根因（已探索确认）**：`findFinish`（worker-dispatcher.ts:75-88）只认 assistant 消息的 `step-finish(reason=stop)`；模型调用失败（无真实凭据 → 401/error）时 serve 产出 `step-finish(reason=error)`（或 error part）→ findFinish 不匹配 → 自持轮询静默等到 `DISPATCH_TIMEOUT_MS=120s` 才报错。QA 实测用户等 35s 无回复且无任何错误提示。
- **修复（两处）**：
  1. **新增导出 `findError(messages)`**：与 findFinish 同款遍历（仅 assistant 消息），命中 `step-finish(reason=error)` 或 `type==='error'` part 即返回错误文案——`p.error?.message` 优先，回退 `p.text`，再回退兜底常量 `MODEL_FAILURE_FALLBACK_MESSAGE`。`PollMessageShape.parts[].error?: {name, message}` 新增字段（serve error part 形状）。
  2. **`pollForCompletion` 轮询循环内**（findFinish 检测之前）对 `fresh`（cursor 之后新消息）做 `findError`——命中 → 立即 `clearPendingWatchdog` + `failedSessions.add` + `emitError({error: 'agent 处理失败：<serve 错误>'}）` + `broadcastAgentError({level:'retry', errorType:'model_error'})` + return（不等 120s）。
- **⚠️ 竞态坑（测试发现）**：poll 首轮可能在 `startPendingWatchdog` 注册**之前**就快速失败（`void this.pollForCompletion()` 在 dispatch 尾部 watchdog 注册前并发执行）——此时 `clearPendingWatchdog` 扑空，watchdog 照常注册并在 120s 二次 emitError。**修复：`startPendingWatchdog` 开头加守卫 `if (this.failedSessions.has(sessionId)) return;`**（dispatch 已在 promptAsync 后重置 failedSessions，守卫只拦截本轮 poll 已快速失败的场景）。两条时序都被覆盖：poll 先失败（守卫跳过注册）或 watchdog 先注册（clearPendingWatchdog 清除）。
- **保留语义**：正常完成（reason=stop）路径不变；120s 超时仍为兜底（serve 无响应/挂起）；快速失败后 failedSessions 标记 → 迟到回流（ingress/轮询 task.completed）跳过落库防双写。
- **测试**：`findError` 单测（error.message 命中 / error part 命中 / 回退 text / user 不算 / stop 不算 / 无错误 undefined）+ 2 个集成用例（step-finish error 快速 fail 且 advance 120s 无双报错 + error part 命中且迟到回流跳过落库）。**验证**：server `nest build` 通过 + jest **44 suites / 705 tests 全绿**（基线 702 + 新增 3）。
- **经验**：快速失败路径的「清除型守卫」（clearPendingWatchdog）与「注册前守卫」（startPendingWatchdog 的 failedSessions 检查）需成对实现——异步 void 并发路径上，清理时机可能晚于注册时机，只做清理不够。

---

## E1: 修复「用户管理编辑按钮完全失效」（ISSUE-002，2026-08-09，实现 + 浏览器实证完成）

- **根因（一行注释）**：`web/app/(main)/users/page.tsx` 文件头注释 :25 明写「编辑按钮：后端无 PATCH /users/:id → 保留原型占位（**无 onClick**）」——编辑按钮是纯占位，无 onClick、无弹窗、无请求。同行「重置密码」/「新增用户」正常（有完整弹窗链路）。
- **后端（三段式补齐 PATCH 链路）**：
  1. 新建 `dto/update-user.dto.ts`（UpdateUserDto）：username/displayName/email/roleId **全可选**（PATCH 部分更新语义）；email 支持 `string | null`——**null = 清空邮箱**（class-validator `@IsOptional()` 对 null 跳过校验，语义天然满足）。
  2. `UsersService.update(id, dto)`：存在校验（404）→ username 变更时唯一冲突（`dto.username !== existing.username` 才查）→ email 变更且非 null 时唯一冲突 → roleId 提供时校验角色存在 → **data 仅组装提交的字段**（`...(dto.x !== undefined ? {x: dto.x} : {})`）→ **空 data（PATCH 空 body）幂等返回 `findOne(id)`**（防 Prisma 空更新抛 PrismaClientValidationError——内部错误而非业务 400）。
  3. `UsersController @Patch(':id')` 声明在 `@Patch(':id/status')` 之后——`:id` 单段与 `:id/status` 双段互不吞，顺序无关但按「具体→一般」排可读性好。
- **前端（对齐 ResetPasswordModal 的 target 模式，不泛化 UserFormModal）**：
  - 新增独立 `EditUserModal`（`edit-user-*` testid 10 个）——「对照重置密码弹窗模式实现」任务要求字面落地；**不泛化 UserFormModal**（其 mode 分支会让新增弹窗回归风险上升，两弹窗字段集差异大：新增有密码、编辑有预填）。
  - 预填：`useEffect [open, target]` 每次打开 setUsername(target.username) / setEmail(target.email ?? "") / setRoleId(target.roleId)。
  - 提交 payload：`{username, displayName: username（兜底，与 create 一致）, email: 空串→null（清空语义）, roleId}`——email 空提交 null 而非 undefined，对齐后端「null=清空」。
  - UsersPage：`editTarget: UserItem | null`（target 非空即打开，对齐 resetTarget 模式）+ `updateMutation`（PATCH → onSuccess 关闭 + invalidate ["users"]）+ `onEdit={setEditTarget}` 传给 UserRow。
- **OBS-007 复核（无需改动）**：QA 报告称「新增用户弹窗缺角色选择」，但当前代码 `user-role-select` 角色按钮组已存在（GET /roles 驱动 + roleId 必填）——**QA 报告与代码基线不一致**（推测 QA 用受限用户测得 GET /roles 403 → 角色区空白被误判）。管理员视角实证 3 个角色按钮正常。
- **测试**：users.service.spec 新增 6 例（部分更新字段落库 / username 冲突 / email null 清空 / roleId 不存在 400 / 空 body 幂等 / 404）→ 43 suites / **689 tests 全绿**（基线 668 + 21 含并行会话增量）+ nest build。⚠️ **spec 编辑坑**：把新 describe 插到 resetPassword describe 中间时吞掉了其「目标用户不存在抛 404」用例且少一个 `});`——先读清 describe 边界再插入。
- **e2e**：reference/testids.ts user-management 条目注册 10 个 `edit-user-*`；pages.spec.ts 15/17 测试扩展：点编辑 → 弹窗 + 预填值 + 角色按钮 → 取消；新增用户弹窗角色按钮可见。**33/33 全绿**（1.2m）。
- **浏览器实证**（playwright headless，chromium-1208 executablePath 显式指定——node_modules playwright 要 1234 版本但缓存只有 1208）：11/11 PASS——点编辑弹窗出现 → 预填用户名（prefilled=T）→ 3 角色按钮 + 1 选中 → 切角色 → 保存 → 弹窗关闭 + **列表刷新显示新用户名（T-edited，PATCH 真生效）** → 再编辑还原数据 → 新增弹窗角色选择 3 按钮 → 重置密码回归 → **0 console 错误**。
- **⚠️ 实证脚本定位坑**：取行内用户名用 `row.locator("span", {hasText: /^[\w.-]+$/}).first()` 会命中**头像 span**（单大写字母）——头像（34px 圆形）与用户名（mono）同层级，用 `row.locator("div > div > div > span").first()` 精确取用户名。
- **⚠️ 环境坑（复现）**：`sudo node dist/src/main.js` 会走系统 node **v18.15.0**（pino tracingChannel 崩）——必须 `sudo /home/keta/.nvm/versions/node/v22.22.1/bin/node dist/src/main.js` 绝对路径；本机 3000 后端（PID 属 root）改后端后需 sudo kill + 绝对路径重启；3001 web dev 与 build 仍遵循 C11 教训（kill + rm -rf .next 再 build，build 后 .bin/next dev --turbopack -p 3001 重启）。

---

## D6: 修复「删除 provider 凭据失败错误不可见」（2026-08-09，实现 + 浏览器实证完成）

- **用户反馈**：删除凭据失败时"点了没反应"——`revokeMutation.onError` 设置了 `setConfigureError(err.message)`，但 `configureError` 只在 ConfigureModal 内渲染（:944），弹窗 `open={configuringProvider !== undefined}` 仅依赖 `configureOpen`（:941）；删除失败时 configureOpen 为 null → 弹窗关闭 → 错误状态设置了但无处显示（静默失败）。
- **方案 A（列表级内联错误条）落地**（providers-tab.tsx）：
  1. 新增独立 `providerError: string | null` state（与 configureError 语义分离——configureError 是"配置弹窗错误"，删除错误走列表级）。3s 自动消失 useEffect（对齐 skills 页 notice 行为）。
  2. `revokeMutation`：onSuccess 清空 providerError；onError 改设 providerError（**不再写 configureError**——原写法在弹窗未开时无效）。
  3. 删除按钮 onClick 前置 `setProviderError(null)`（重试前清旧提示）。
  4. 渲染：工具条与列表之间插入错误条（`provider-error-banner`，role=alert + ⚠ + 关闭按钮 `provider-error-dismiss` + 3s 自动消失；红系 #FEF2F2/#FECACA/#DC2626 对齐 skills 页 notice 错误态）。
- **次要优化（顺手做）**：删除按钮条件 `status !== "missing"` → `status === "configured"`——"已撤销"（revoked）状态再点删除无意义（DELETE 幂等成功、且语义混乱），仅 configured 显示删除按钮。e2e 无该按钮点击断言，安全。
- **⚠️ 验证路径坑（幂等 DELETE 无法自然触发 404）**：C12 的 `revokeCredentialByProvider` 是 findUnique 后 update revokedAt——**已软删记录重复 DELETE 仍成功（幂等）**，不存在 revokedAt=null 才删的语义。因此"先 API 直删 → 页面缓存过期 → 点删除 → 404"的路径不成立（第二次 DELETE 成功，无错误条）。浏览器实证改用 **playwright route 拦截** DELETE 返回 404（`page.route("**/api/v1/models/providers/*/credentials")` fulfill 404）——直接验证前端 onError → 错误条渲染逻辑，不依赖后端状态，更干净。
- **实证结果**（chrome headless，web dev 3001）：rows=7、deleteButtons=1（仅 opencode-go configured）、revokedButtonHidden=true（zhipu revoked 无删除按钮）、点删除 → `provider-error-banner` 可见（文本含 MODEL_CREDENTIAL_NOT_FOUND）、dismiss 后消失、无 JS console 错误。截图 `.omo/evidence/` 未存（模型不支持读图，playwright 文本断言为准）。
- **验证**：web `npx tsc --noEmit` 0 错误 + `npm run build` 通过（/models 9.52 kB）。⚠️ 环境坑：跑 build 前需 kill 3001 dev server + `rm -rf .next`（C11 教训），build 后 `node_modules/.bin/next dev --turbopack -p 3001` 重启（**npx/npm exec 的 `-p 3001` 会被解析成项目目录报错，必须直接调 .bin/next**）；dev 启动后首次编译 ~1.6s。

---

## C12: 修复「删除 provider 凭据」bug（2026-08-09，实现 + 验证完成）

- **用户反馈**：① 删除凭据不生效；② 每次点击发出多个不同编号的 DELETE 请求。
- **根因三连（explore 定位）**：
  1. `models.service.ts findAll` providerID 用 **contains 模糊匹配**——`providerID=opencode` 命中 opencode + opencode-go 两 provider 的模型。
  2. 前端 `resolveModelId` 每次裸 `GET /models?providerID=xxx` 取第一个匹配模型 id；后端 `orderBy createdAt asc` 同 createdAt 排序不稳定 → 每次点击解析到不同 model id → 多个不同编号 DELETE。
  3. **设计错配**：凭据按 providerID 粒度存（ModelCredential.providerID unique），删除却按「某模型 id」路由（`DELETE /models/:id/credentials`）→ resolveModelId 是保底 hack；且 revokeMutation 无 onError → DELETE 404（MODEL_CREDENTIAL_NOT_FOUND）静默失败 → 删除不生效。
- **后端改动**：
  1. **新端点** `DELETE /models/providers/:providerID/credentials`（AdminGuard）——`ModelsService.revokeCredentialByProvider(providerID)` 直接按 providerID `findUnique` ModelCredential → 无则 404 MODEL_CREDENTIAL_NOT_FOUND，有则 `update revokedAt=new Date()`。**不查 model 行**（worker-only provider 无模型也能删）。静态段 `providers` 声明在 `@Delete(':id')` 之前（紧跟 @Get('providers') 之后，对齐既有顺序）。
  2. **findAll providerID 改精确匹配**：`providerID: query.providerID ? query.providerID : undefined`（modelID/name 保留 contains 搜索）；`orderBy` 加第二键 `[{ createdAt: 'asc' }, { id: 'asc' }]` 保证同 createdAt 排序稳定。
- **前端改动**（providers-tab.tsx）：`revokeMutation.mutationFn` 改直接 `api.delete(\`/models/providers/${providerID}/credentials\`)`——**删除 resolveModelId 调用**（saveCredentialMutation 仍用 resolveModelId，故保留）；补 `onError: setConfigureError(isApiError(err) ? err.message : "删除失败，请稍后重试")`（对齐 saveCredentialMutation onError 模式，杜绝静默失败）。
- **⚠️ 路由顺序测试坑（沿用 C9）**：PATH_METADATA 定义在 `descriptor.value`（函数对象）上，读法 `Reflect.getMetadata(PATH_METADATA, ModelsController.prototype[method])`；声明顺序 = `Object.getOwnPropertyNames(prototype)` 顺序。新增断言 `providers/:providerID/credentials` 索引 < `:id` 索引。
- **测试**：models.service.spec 新增 revokeCredentialByProvider 3 例（按 provider 直删不查 model / 无凭据 404 / model 不存在 worker-only 也能删）+ findAll 精确匹配与 orderBy 第二键断言更新；models.controller.spec 新增 2 例（转发 + DELETE 路由顺序）。**验证**：server `npm run build` 通过 + jest **43 suites / 668 tests 全绿**（基线 663 + 新增 5）；web `npx tsc --noEmit` 0 错误 + `npm run build` 通过。
- **遗留（决策）**：POST 按 provider 保存凭据端点（`POST /models/providers/:providerID/credentials`）未做——用户问题聚焦删除，保存路径 resolveModelId 已被 findAll 精确匹配 + 稳定排序修复，不再每次漂移；如未来要支持 worker-only provider 配置凭据，可补该端点（body {token, targetWorkerIds?}）。

---

## D5: Provider 列表"只有 opencode/opencode-go 两个 provider"问题修复（2026-08-09，实现 + 验证完成）

- **根因（实证）**：`STATIC_AVAILABLE_MODELS` 8 个 seed 模型中 7 个**无 provider 前缀**（`deepseek-v4-pro`/`glm-5.1`/`glm-5.2`/`gpt-5.6-luna`/`grok-4.5`/`kimi-k2.6`/`qwen3.6-plus`）——`buildModelSeedRows`/`splitModelId` 首 `/` 拆不到 → 默认归 `opencode` → models 表 DISTINCT provider_id 只有 `opencode`/`opencode-go` 2 个 → `GET /models/providers` 聚合结果也只有 2 个 → Provider 页只有 2 行。
- **决策：provider 前缀采用 opencode models.dev 标准**（任务给定映射）：本机 `opencode models` 无凭据时只返回内置免费模型（opencode/big-pickle、gemma4/*、keta/* 等），seed 中这些模型不在实测列表，故按 models.dev 标准 id 补齐：
  - `deepseek-v4-pro` → `deepseek/deepseek-v4-pro`
  - `glm-5.1`/`glm-5.2` → `zhipu/glm-5.1`/`zhipu/glm-5.2`（GLM 属智谱）
  - `gpt-5.6-luna` → `openai/gpt-5.6-luna`
  - `grok-4.5` → `xai/grok-4.5`
  - `kimi-k2.6` → `moonshot/kimi-k2.6`
  - `qwen3.6-plus` → `qwen/qwen3.6-plus`
- **改动面**：
  1. `agent.constants.ts` STATIC_AVAILABLE_MODELS 全量携带前缀 + `TEMPLATE_DEFAULT_MODELS` 同步（a_product→zhipu/glm-5.1、a_architect→deepseek/deepseek-v4-pro、a_tester→zhipu/glm-5.2；a_developer 原 opencode-go/deepseek-v4-flash 不变）——模板默认模型必须指向目录中存在的模型，否则 agent.constants.spec 的 keys.has 断言挂。
  2. `seed.ts` **清理旧无前缀残留**：provider 前缀规范化后旧行（providerID='opencode' AND modelID IN 7 legacy）与新行唯一键不同，upsert 无法覆盖 → seed 前先 deleteMany（**先删 worker_model_availabilities 外键行，再删 model**，对齐 ModelsService.remove 的 FK Restrict 约束）；实测清理 7 行。
  3. `models.service.ts listProviders` **数据源 2（worker 上报合并）**：除 models 表 groupBy 外，追加在线 worker（status != offline）`capabilities.models`（string[]，拆 providerID）union——worker 配置凭据后上报的模型含新 provider，Provider 页自动出现；modelCount = 目录 count + worker 上报该 provider 模型数（worker-only provider 也能显示计数，重复 id 不特意去重——语义为"可用模型数"，与 worker 侧各自集合一致）。
- **⚠️ 兼容路径保留**：`splitModelId` 不含 `/` 归 opencode 的分支保留（存量 agent defaultModelId/外部上报可能仍是旧自由字符串），D5 后 seed 不再产出无前缀行，该分支仅作兼容。
- **验证**：server `nest build` 通过；jest **43 suites / 663 tests 全绿**（基线 661 + 新增 2：agent.constants.spec D5 provider≥4 断言、models.service.spec worker union 合并用例）；seed 实库重跑清理 7 行后 DISTINCT provider_id = **7 个**（deepseek/moonshot/openai/opencode-go/qwen/xai/zhipu）；`GET /models/providers`（admin token）返回 7 个 provider，模型数正确（zhipu=2 双模型）。

---

## C10: Provider 页切换后端聚合数据源，消除前端聚合冗余（2026-08-09，实现 + 验证完成）

- **背景**：Provider 页原先用「GET /models pageSize=100 全量分组 + 每 provider 并发 GET /models/:id/credentials」前端聚合（C6 期后端 providers 端点未交付时的并行时序误判）。C9 后端 `GET /models/providers` 交付后，切换为单一端点，**删除 2 个请求源**（modelsQuery 全量分组 + credentialsQuery 逐 provider 查凭据），保留 workersQuery（worker 多选数据源）。
- **类型**：`web/src/types/models.ts` 新增 `ProviderSummary {providerID, modelCount, configured, fingerprint, revokedAt}`（与后端 listProviders 响应字段一一对应）。
- **⚠️ 模型 id 闭环（保存/删除凭据的关键）**：C9 providers 响应**不含模型 id**（只聚合计数/凭据态）——保存 POST /models/:id/credentials 与吊销 DELETE 仍需目录行 md_ id。保底方案 `resolveModelId(providerID)`：`GET /models?providerID=<p>&pageSize=100` → 前端**精确 filter `m.providerID === providerID` 取首个**（⚠️ 后端 providerID 是 contains 模糊匹配，`opencode` 会误命中 `opencode-go`，必须前端二次精确过滤防前缀误命中），再 POST/DELETE `/models/<md_id>/credentials`。凭据按 provider 粒度（C4），任一模型 id 均可操作，不要求 enabled。
- **⚠️ queryKey 跨页共享陷阱**：原 credentialsQuery 用 `["model-credentials"]`（与 models 页共享，保存后两页凭据态一起刷新）；新 providersQuery 的 queryFn 是 GET /models/providers，**不能复用 ["model-credentials"]**——react-query 同 key 不同 queryFn 会互相污染缓存（models 页存 Map，providers 页存数组）。改用独立 key `["model-providers"]`，保存/吊销成功后**双 invalidate**：`["model-providers"]`（本页）+ `["model-credentials"]`（models 页共享的凭据态，保持跨页一致性）。
- **渲染逻辑零变化**：providerID + 模型数（p.modelCount）+ 三态徽章（toStatus 从 ProviderSummary 直接判定：configured → 绿 / !configured && revokedAt → 琥珀 / 否则灰）+ fingerprint（configured 时显示 p.fingerprint，其余 "—"）；配置弹窗交互（worker 多选/保存/删除）未动。
- **验证**：web `npx tsc --noEmit` 0 错误 + `npm run build` 通过（/providers 路由 7.87 kB）。后端零改动（C9 已交付）。

---

## C11: 模型管理单一入口（/models 双 Tab 合并 Provider 页）（2026-08-09，实现 + 验证完成）

- **用户需求原话**：「主入口应该只有一个模型管理，进去后通过 tab 页管理两个页面，支持切换」——Provider 页与模型页合并为单一「模型管理」入口 + Tab 切换。
- **方案**：`/models` 为主入口页，顶部 `manage-tabs`（对齐 skills 页双 Tab 模式：manage-tabs/manage-tab + TabKey state）双 Tab：**catalog（模型目录，默认）** / **providers（Provider 管理）**。`/providers` 路由保留为 server 组件 `redirect("/models")`（132 B 重定向页，URL 直达兼容）。
- **Provider 视图迁移**：原 `providers/page.tsx`（949 行）主体原样迁移到新文件 `web/app/(main)/models/providers-tab.tsx`（export default ProvidersTab；app 目录非特殊文件名不生成路由，安全 colocate）；**全部 testid 保留**（providers-root/provider-list/provider-* 22 项 + 弹窗交互）。原 providers 页删除，改 8 行重定向页。
- **models 页改造**：manage-toolbar 只放双 Tab + 搜索框（`tab === "catalog"` 条件渲染，providers tab 无搜索框）；计数徽章（X 个模型 · 已配置 Y/未配置 Z）从 toolbar 移到列表头「全部模型」行；model-hint 条件渲染（仅 catalog）；「凭证管理请前往 /providers」文案改为「切换到 Provider 管理 Tab」。
- **数据源独立（无污染）**：catalog=["models"]+["model-credentials"]，providers=["model-providers"]；`["workers"]` 双 Tab 共享——**同 key 同 queryFn 的 react-query 是缓存共享而非污染**（C10 教训的反面：污染只发生在同 key 不同 queryFn）。保存/吊销凭据后仍双 invalidate（["model-providers"]+["model-credentials"]）保持跨 Tab 一致。
- **导航精简 4 处**：nav-dock NAV_ITEMS 删 providers 项 + models label「模型目录」→「模型管理」；app-shell KEY_TO_PATH/CMDK_NAV_PATH/PAGE_TITLE 删 providers + models 标题改「模型管理 / 模型目录 · Provider 凭证管理」（**CMDK_NAV_PATH 与 cmdk-panel DEFAULT_CMDK_ITEMS 的 label 必须同步改**——handleCmdKSelect 以 label 查路径映射）；cmdk-panel DEFAULT_CMDK_ITEMS 删「Provider 管理」+「模型目录」→「模型管理」。
- **e2e 同步**：pages.spec.ts「18/18 /models」测试改为双 Tab 全流程（manage-tabs 可见 + 2 个 manage-tab + catalog 断言 + 切 providers tab 断言列表/徽章/弹窗开合 + 切回）；原 /providers 测试改为「旧路由重定向」测试（`toHaveURL(/\/models$/)` + models-manage-root 可见）。testids.ts 合并两页审计条目为单个「2.14 models-manage（模型管理：模型目录 + Provider 凭证双 Tab）」38 项 + PAGE_SMOKE /models 更新（含 provider-list）、删 /providers 行。
- **⚠️ e2e 弹窗 testid 重复**：provider-modal-cancel 出现 2 次（✕ + 底部取消），`.first()` 定位（沿用原 providers 测试写法）。
- **验证**：`npx tsc --noEmit` 0 错误 + `npm run build` 通过（/models 9.35 kB、/providers 132 B 重定向页）；playwright 实证（channel=chrome）：登录 → /models 双 Tab（2 个 tab）→ catalog 默认 → 切 providers 7 个 provider 行 + 配置弹窗开合 → 切回 catalog → /providers 重定向 /models，**0 console 错误**；e2e pages 项目 **17/17 全绿**（41s）。
- **⚠️ 环境坑（复现）**：生产 `npm run build` 与 dev server 共用 `.next` 目录——先 build 后 dev 会 ENOENT _buildManifest.js.tmp（dev 500）；修复：kill dev → `rm -rf .next` → 重启 `npm run dev`。dev server 与 build 不能并行跑同一工作区。

---


- **端点**：`GET /api/v1/models/providers`（成员只读，不挂 AdminGuard，与 GET /models 一致）。返回 `Array<{providerID, modelCount, configured, fingerprint, revokedAt}>`，Provider 页数据源（模型页纯展示）。
- **service 实现**（`ModelsService.listProviders()`，两次查询内存合并）：① `prisma.model.groupBy({by:['providerID'], where:{enabled:true}, _count:{_all:true}})` 一次取 provider + enabled 模型数；② `modelCredential.findMany()` 全量按 providerID 建 Map 取凭据状态（表很小，无复杂 join）。`configured = 存在且 revokedAt===null`；`fingerprint` 取库内已脱敏指纹，**未配置/已吊销时为 null**（明文零接触）；排序 providerID 字典序（简单稳定）。
- **⚠️ modelCount 语义**：groupBy 的 where 必须带 `enabled:true`——任务要求"该 provider 下 enabled 模型数"，与目录列表 enabled 过滤语义一致。
- **⚠️ 路由顺序关键点**：`providers` 静态段必须在 `@Get(':id')` 之前声明（NestJS 按声明顺序匹配，否则 GET /models/providers 被 :id 拦截 404）。插在 findAll 之后、findOne 之前。
- **⚠️ 测试路由顺序的 metadata 读取坑**：NestJS `@Get('providers')` 的 PATH_METADATA 定义在 **`descriptor.value`（函数对象）** 上，不是 `prototype+key`。读法必须是 `Reflect.getMetadata(PATH_METADATA, ModelsController.prototype[method])`（第二参传函数对象、无第三参）——用 `(proto, method)` 三参读法恒返回 undefined（本任务踩坑后修正）。声明顺序 = `Object.getOwnPropertyNames(prototype)` 顺序（排除 constructor），断言 `providers` 索引 < `:id` 索引。
- **mock 扩展**：`models.service.spec` 的 prisma.model mock 需补 `groupBy: jest.fn()`（groupBy 返回形如 `[{providerID, _count:{_all:n}}]`）。
- **验证**：`npm run build` 通过 + jest **43 suites / 661 tests 全绿**（基线 656 + 新增 5：service.spec listProviders 3 例（聚合/吊销 configured=false+fingerprint=null/空）、controller.spec 2 例（转发 + 路由顺序））。

## B2 修复：resolveModels 空列表重试（2026-08-09，实现 + 实证完成）

- **根因（F3 复现）**：`opencode serve` 健康检查通过（HTTP 200）≠ 模型列表就绪。容器内实测（真实凭据）：就绪 **303ms** 时 GET /api/model 返回 **0 模型**，**1573ms** 后才返回 **6212 个模型**。旧 resolveModels 单次调用拿到空数组 → 被当作"已探测无模型"上报 `capabilities.models=[]` → C3 availability 无行（详情页模型卡只能走目录兜底）。
- **修复语义变更（重要）**：resolveModels 的空列表从"已探测无模型（返回 `[]`）"改为**"未就绪（重试）"**：
  - 非空 → 返回 id 数组（正常上报）
  - **空列表 → 1s/2s/4s 指数退避重试（默认 retries=3，总探测 4 次，窗口 ~7s）**，直到非空
  - 重试耗尽仍空 → 降级 undefined（不携带 models，不阻断注册）
  - listModels **抛错 → 立即降级 undefined**（不重试，serve 未就绪/端点不支持同现状）
- **实现**（worker/src/index.ts）：`ModelListProbeOptions`（`retries`/`retryDelayMs`/`delay`）——`delay` 可注入（单测传 0ms 跳过真实等待，jest 不依赖 fake timers）；`resolveModels(lister, options)` 新增第三参。调用点 `registerCurrent` 不变（`resolveModels(driver)` 缺省选项）。
- **单测**（index.spec.ts 5 例）：首次非空只探测 1 次 / 空→空→非空 第 3 次成功（断言 listModels 调用 3 次）/ 持续空重试耗尽 → undefined（retries=2 时调用 3 次）/ 抛错立即 undefined（调用 1 次不重试）/ 既有映射成功用例保留。worker jest **17 suites / 208 tests 全绿**（基线 206 + 新增 2）+ typecheck 通过。
- **端到端实证**（compose 13000/13001 + worker 容器）：
  - 复现：容器内 spawn serve（XDG_DATA_HOME 指向真实 auth.json）→ 就绪 303ms 空、1573ms 后 6212 模型，与 F3 现象一致
  - 修复后：`npm run build` 产物 `docker cp` 覆盖容器 `/tmp/keta-worker/dist/index.js` + 预置 `/root/.local/share/opencode/auth.json`（真实凭据）→ `docker restart` → 日志：`模型列表探测为空（第 1/4 次，serve 可能仍在预热），1000ms 后重试` → **仅 1 次重试即非空** → 注册成功
  - server 库核对：`workers.capabilities.models` **26 个** + `worker_model_availabilities` **26 行**（C3 合并链路完整生效）——修复前此场景 capabilities.models=[]、availability 无行
- **⚠️ 环境坑**：
  - 本机 `docker compose build worker` 拉不到 `node:22-alpine`（docker.io 网络超时）——改用 `npm run build` + `docker cp` 覆盖容器 dist，免重建镜像
  - worker 容器内 serve 的 auth.json 是**测试假 token**（`sk-test-b1-token-0003`，provider 认证失败 → 0 模型），实证"非空"必须注入真实凭据（`/root/.local/share/opencode/auth.json`，serve 默认路径）；实证后 recreate 容器恢复基线
  - bash 工具持久 shell 对后台 spawn（opencode serve）不友好——curl 无 `--max-time` 会挂死 shell；serve 启动用 `setsid` 脱离 + 所有网络命令带超时；容器内无 curl/python3（alpine），用 node 内置 fetch



## C8: worker 默认模型配置 API + 详情页模型卡（2026-08-09，实现 + 验证完成）

- **PATCH /workers/:id（全新端点，无路由冲突）**：`workers.controller.ts` 新增 `@Patch(':id')` + `@UseGuards(AdminGuard)`（前置全局 JwtAuthGuard 鉴权）→ `WorkersService.updateDefaultModel(id, dto)`。controller.spec 需补 `PrismaService` mock（AdminGuard compile 时实例化，依赖 user.findUnique——对齐 models.controller.spec 模式）。
- **defaultModelId 格式关键点**：defaultModelId 是 **`providerID/modelID` 引用格式**（与 C2 worker 上报 id、C7 matchesModelRequirement 的 modelId 比较对象同构），**不是目录 `md_` 主键**——校验不能用 `ModelsService.findOne`，需按 @@unique(providerID, modelID) 查。新增 `ModelsService.findCatalogByRef(ref)`：复用私有 `splitModelId` 拆解约定（含 `/` 首个 `/` 拆，不含 providerID 归 opencode），select 含 enabled，返回完整行/ null。
- **updateDefaultModel 语义（三态区分）**：`defaultModelId` 非空 → findCatalogByRef 校验（不存在 **或 enabled=false** → 400 MODEL_NOT_FOUND，任务要求校验拦截）；`null`/空串 → 清除（跳过校验，落库 null）；`undefined` → 幂等跳过（data={}）。返回 `toWorkerView`（更新后完整视图）。
- **toWorkerView 扩展（Metis R11）**：入参类型与返回对象均加 `defaultModelId: string | null`——findAll/findOne/PATCH 三路径统一透出，前端详情页默认模型标识的数据源。⚠️ 测试 workerRow 需补 `defaultModelId: null` 默认值（toWorkerView 类型必填，jest 严格类型）。
- **详情页模型卡（第 7 块）**：`workers/[id]/page.tsx` 新增 `worker-detail-models` section。数据源**主选 `capabilities.models`（C2 上报持久化，离线可查）**；未上报/空 → **目录兜底 `GET /models?pageSize=100`**（enabled 全量）。每个 badge 显示 `provider / 模型名`（模型名经 catalogByRef Map 映射 `providerID/modelID → name`，缺失回退 modelID 末段；**ref 拆解复用 splitModelRef 页面内工具**，不含 `/` 旧自由字符串 providerID 归 opencode）。`worker.defaultModelId === ref` 匹配 → 绿系徽章「默认」（`worker-model-default`，data-testid）。空态 → 本地 `SectionEmpty`（page.tsx:105 本地定义，非 shared.tsx——Metis R10 确认）。
- **新 testid 注册**：`worker-detail-models` / `worker-model-badge` / `worker-model-default` 注册到 testids.ts **worker-list（2.13）条目**（worker 详情页无独立 PAGES 条目，其既有 testid 亦未单独注册——归入 worker-list 条目保持一致性）。badge 带 `data-model-id` + `data-default` 属性便于断言。
- **Web 类型扩展**：`shared.tsx` WorkerItem 加 `defaultModelId: string | null` + `capabilities.models?: string[]`（WorkerDetail 经 extends 继承）。
- **⚠️ 遗留清理**：移除 worker 详情页未使用的 `router`/`useRouter`（T13 迁移遗留，build lint 报 `no-unused-vars`）——顺手清理保持构建零新增警告。
- **⚠️ web build 缓存坑**：`npm run build` 偶发 `Cannot find module '../chunks/ssr/[turbopack]_runtime.js'`（Collecting page data 阶段，.next 缓存损坏）——`rm -rf .next` 后重建即过，非代码问题。
- **验证**：server `nest build` 通过 + jest **43 suites / 652 tests 全绿**（基线 643 + 新增 9：workers.service.spec 6（配置/不在目录 400/停用 400/null 清除/缺省跳过/404）+ toWorkerView 透出 1 + workers.controller.spec 2）；web `tsc --noEmit` 0 错误 + `npm run build` 通过（PATH 需 nvm v22.22.1），/workers/[id] 路由入表。


## C6: 前端模型管理页 + agent 页模型选择器增强（2026-08-09，实现 + 验证完成）

- **新增路由**：`web/app/(main)/models/page.tsx`（AppShell 内容区模式，root `models-manage-root` flex:1）——**导航 5 处注册**：nav-dock NAV_ITEMS 加 `{key:"models", label:"模型目录", icon:"◇"}`（第 4 位，worker 之后 skills 之前，图标 ◇ 不与现有冲突）；app-shell KEY_TO_PATH（models→/models，KEY_LOOKUP 自动反查）+ PAGE_TITLE（「模型目录 / 模型登记 / 凭据配置 / 启用停用」）+ CMDK_NAV_PATH（模型目录→/models）；cmdk-panel DEFAULT_CMDK_ITEMS 加「模型目录」导航项。Dock min-height 写死 360px 注释「7 图标」——8 图标时内容高度自然撑开（max-height calc(100% - xxl) 兜底），无需改。
- **testid 一致性验收通过**：原型 models-manage 19 个 data-testid 全部在实现页出现（`grep -oP 'data-testid="[^"]+"' 原型 | sort -u` vs 实现 comm -23 为空）。新增反馈类 testid（models-loading/models-error/models-retry/model-add-modal/model-provider-input/model-model-id-input/model-name-input/model-add-confirm/model-add-error）已注册 testids.ts（auditPage "2.14 models-manage"）+ pages.spec.ts 新测试「18/18」（文件头 17→18）。
- **模型页数据源**：GET /models 分页（pageSize=100 一次拉全量，agents 页同模式）→ 目录行（id=md_xxx）；**可用节点数 = 在线 worker（status≠offline）capabilities.models 含该模型 id 的计数**（无 availability API，worker 上报为近似源）；**凭据状态 = 每模型并发 GET /models/:id/credentials（Promise.all，单模型失败容错视同 missing）**——GET /models 不 join credential，页面级 queryKey=["model-credentials"] 一次拉全量 8 请求可接受。
- **模型页权限**：isAdmin（roleName==='admin'）控制写操作——model-add-button 条件渲染（非 admin 隐藏，源码 testid 保留不影响 grep diff）、model-toggle disabled、model-credential-save disabled（空 token 也禁用）；后端 AdminGuard 403 兜底。凭据保存 POST /models/:id/credentials {token, targetWorkerIds?}（targetWorkerIds 非空才传，对齐 C5 定向/全量语义）；启用停用 PATCH /models/:id {enabled}。
- **agents 页增强（P0.2 原型对齐）**：
  - **MODEL_NAMES 死代码删除**：前置处理 :322（AgentListItem 默认模型徽章）与 :796（currentModelName）两处引用 → 新增 **GET /models 目录查询**（queryKey=["model-catalog"]）建 `catalogByRef`（Map 双键：`providerID/modelID` + 裸 modelID——存量 defaultModelId 可能是不含 '/' 的旧自由字符串，双键兼容校验）→ `modelNameOf`（useCallback）传给 AgentListItem。
  - **AvailableModel 提取共享**：`web/src/types/models.ts`（agents 页私有定义移出；models 页不依赖它，未来 worker 详情卡可复用）。
  - **模型下拉 provider 显示**：option 文本 `${providerOf(id)} / ${name}`（providerOf=首个 '/' 前，无 '/' 原样），加 data-testid="model-option-provider"+data-model-id（对齐 P0.2）；model-source-hint 文案改为「平台模型目录（worker 上报合并入库，C3）」。
  - **token 输入（model-token-input + model-token-status 双态）**：⚠️ **凭据端点 :id 是目录行 md_xxx，而模型选择器 value 是 providerID/modelID——必须经 catalogByRef 解析 md id 才能 GET/POST /models/:id/credentials**；存量值不在目录（catalog 无行）→ 无端点可查视同未配置；保存 token 用页面级 mutation（POST 后 invalidate queryKey=["model-credential"]）。页面内新增 CredentialBadge（credentialTheme 与 models-manage 页内定义完全一致，"扩展 token"范式）。
  - **首选 worker（agent-worker-select）**：agent.workerId 可空，选项=自动调度（默认）+ GET /workers（在线优先排序，name · 在线/离线）；保存提交 `workerId: workerDraft || null`（显式 null=自动调度）；**server 侧同步补 workerId 支持**——UpdateAgentDto 加 `workerId?: string | null`（@IsString + @ValidateIf(o => o.workerId !== null) 允许 null）、agents.service AgentRow + update data + toAgentDto 透出（C1 字段此前未透出/不可 PATCH）。
  - **保存校验**：defaultModelId 非空但不在目录 → model-stale-warning 警告条（黄，不阻断保存，存量兼容）。
- **验证**：web `npx tsc --noEmit` 0 错；`npm run build` 通过（/models 路由注册 9.17 kB）；server `nest build` 通过 + jest **43 suites / 643 tests 全绿**；e2e **pages 16/16 + login/guard 17 全绿**（新增 18/18 models 测试）。
- **⚠️ 环境踩坑**：e2e 首轮 models 页 model-list 不可见——web dev 代理 /api/v1 → localhost:3000，而 3000 跑的是 **Aug08 旧 dist 实例**（无 /models 路由，404）；修复：`npm run build`（server）后 kill 旧进程重启 `node dist/src/main.js`（tmux api-dev 会话）。web dev server 旧 .next 缓存报 vendor-chunks MODULE_NOT_FOUND → `rm -rf .next` 重启（tmux web-dev2）。**C6 后 e2e 依赖后端含 ModelsModule 的最新 dist。**
- **agent-config 原型 testid 对齐**：原型模型区 7 个（model-config/model-select/model-option-provider/model-token-status/model-token-input/agent-worker-select/model-source-hint）实现全含；P0.2 原型的「保存」按钮无 testid，实现沿用（保存按钮无独立 testid 不违反 diff 契约）。agents 页 CredentialBadge 复用 data-testid="model-credential-status"（与 models 页同 testid，e2e 按页路由隔离断言无冲突）；模型页新增 model-add-cancel 弹窗出现 2 次（关闭 ✕ + 底部取消），原型无此 testid 属实现新增。

## C7: 模型解析优先级 + assignWorker 按模型过滤（2026-08-09，实现 + 测试完成）

- **模型解析优先级链**（`worker-dispatcher.ts`，Metis P1 修复后完整实现）：
  1. **Agent.defaultModelId**（显式非空直接用）→ 2. **沿 baseAgentId 链向上取最近非空 defaultModelId**（模板默认；`resolveAgentModelId` 私有方法，`MAX_BASE_AGENT_CHAIN_DEPTH=20` 防御异常链/环；链上遇 `type='template'` 或 `baseAgentId=null` 终止）→ 3. **执行 worker 的 defaultModelId**（兜底，`agentModelId ?? workerRow.defaultModelId ?? null`）→ 4. **null**（不指定，serve 默认）。解析结果 null → **跳过模型过滤**（回归现状：未配模型 agent 仍可调度任意 worker）。
- **dispatchForTarget 接线**（C 部分）：解析模型 → 组 `assignmentReq`（非空 modelId 才传）→ **两个 assignWorker 调用点（未绑定 :407 / 复用 worker offline 重分配 :435）都传 assignmentReq** → promptAsync 用解析后最终模型（:460）。Worker 行 select 增加 `defaultModelId`（阶段 2 兜底数据源）。
- **assignWorker 过滤**（`workers.service.ts`，Metis P1-3）：
  - `AssignmentRequirement` 增加可选 `modelId?`；候选查询 `include: { modelAvailabilities: { include: { model: { select: { enabled: true } } } } }`。
  - `matchesModelRequirement`（私有）判定顺序：modelId 省略/空 → 通过（现状回归）；`worker.defaultModelId === modelId` → 通过；**availability 无行（从未上报）→ 通过（过渡期降级，Metis P1-3 写死）**；已上报但 availability 不含该 enabled 模型 → 排除。
  - 排序保持：online 优先 + 剩余容量降序（filter 链在 sort 之前，不改变既有语义）。
- **3 调用点回归**（Metis P2-7）：worker-dispatcher.ts:407、:435 传 `assignmentReq`（含 modelId）；**agents.service.ts:291（getAvailableModels pull 兜底）保持无参调用**——目录空时仍返回任意可用 worker，再 listModels 探测，无回归。
- **测试**：43 suites / **643 tests** 全绿（基线 632 + 新增 11）——workers.service.spec 6 例（availability 含 enabled 模型选中 / 不含排除 / disabled 排除 / 从未上报降级 / defaultModelId 匹配 / modelId 未指定不过滤）、worker-dispatcher.spec C7 describe 3 例（Agent 显式 defaultModelId → assignWorker 携带 modelId + createSession 用拆分模型 / 沿 baseAgentId 多层 clone 链取模板默认 / Agent 模板均未配 → 跳过过滤 + worker.defaultModelId 兜底）+ 既有调用点回归（复用 worker 场景 select 含 defaultModelId 不破坏）。
- **⚠️ 测试契约修复**：跑全量 jest 发现 `agents.service.spec findAll` keys 契约断言缺 `workerId`——C1 的 toAgentDto 已含 `workerId`（Agent.workerId 软绑定字段）但 spec 期望数组未同步（并行 session 遗漏）。补 `'workerId'` 后全绿。教训：C1 加 toAgentDto 字段时须同步 findAll/update 的 keys 契约断言。
- **⚠️ 并行会话状态**：本任务启动时工作区已有并行 session 落地 C7 主体（resolveAgentModelId + assignmentReq 接线 + matchesModelRequirement + 测试），本会话负责**回归验证 + 测试契约修复 + 文档同步**。实现完全符合任务规格（含 null 跳过过滤、availability 缺失降级、3 调用点回归），无需改动业务代码。

## C4: 模型凭据加密存储（2026-08-08，实现完成）

- **schema**：`ModelCredential` 表（id `mc_` 前缀零填充、`providerID` unique（uk_model_credentials_provider）、`credentialRef`（AES-256-GCM 密文）、`fingerprint`（脱敏）、`revokedAt` 软撤销、createdAt/updatedAt）。**不建 FK**——凭据按 providerID 全局粒度（关键决策①），models.provider_id 非唯一，逻辑关联经 ModelsService 查询 model 解析 providerID。
- **迁移**：`20260808154421_add_model_credentials`（> 20260808145108 基线），对 MySQL 3307 实库应用成功，migrate status clean。
- **加密服务**（`server/src/common/credential-crypto.service.ts`）：AES-256-GCM（node:crypto 内置，零依赖），密钥来自 env `MODEL_CREDENTIAL_KEY`（支持 64 位 hex / base64 / 32 字节 utf8）。**缺失策略**：production 启动抛错（拒绝弱 key）；development/test 用硬编码显式标记的开发密钥 + logger.warn（可追溯）。密文格式 `ivHex:authTagHex:ciphertextHex`，解密 authTag 校验失败即抛错（防篡改/错 key）。**fingerprint**：前 4 + `****` + 后 4（如 `sk-a****89xz`），短 token（≤8）折半掩码。
- **模块**（`server/src/models/`，参照 mcp-servers 骨架）：ModelsModule（imports RealtimeModule 取 IdGeneratorService；providers ModelsService/CredentialCryptoService/AdminGuard；exports 两者供 C5 下发读取解密）。控制器 `models.controller.ts`：POST/DELETE `:id/credentials` 挂 AdminGuard，GET 成员只读（只出脱敏 fingerprint，无明文敏感信息）。
- **端点决策**：POST body 支持可选 `providerID`——显式提供须与 model 一致（不一致 → 400 MODEL_PROVIDER_MISMATCH），缺省取 model.providerID（防 GET 按 model.providerID 查不到）。同 provider 重复 POST 覆盖更新（幂等决策，任务要求）；DELETE 软撤销（revokedAt 置当前时间，保留审计轨迹）；GET 未配置返回 configured=false 不 404。
- **id-resync**：`mc_` 前缀复用通用 resyncIdPrefix（ModelsService.onModuleInit 调用），单测新增 mixed id 用例（数字序号 + 命名 id → 取数字最大）。
- **验证**：`npm run build` 通过；jest 43 suites / 595 tests 全绿（基线 559 + C4 新增 ~36：加密服务 15、models service 12、controller 5、id-resync mc_ 1、seed 相关）。实库核对：model_credentials 表可插入/查询/软删。
- **⚠️ 并行会话注意**：实现期间另一会话同时推进 C2/C5（workers/agents 文件被改），models 目录文件被并行增强（providerID 校验 + createdAt 字段）。C5 实现时以本 learnings + 当前 models 目录为唯一事实源，避免重复定义。


## C2: worker capabilities.models + defaultModelId 上报（2026-08-08，实现 + 验证完成）

- **models 字段结构（最终）**：`capabilities.models` 采用 **`string[]`（id 格式 `providerID/modelID`，如 `opencode-go/deepseek-v4-flash`）**。与 C1 目录 id 拆解约定天然对齐（STATIC id 含 `/` 按首个 `/` 拆 providerID/modelID），C3 合并入库直接复用拆解逻辑；server DTO `models?: string[]`（@IsOptional + @IsArray + @IsString({each:true})），worker-protocol 双写同构，无 whitelist 剥离/ValidateNested 400 风险。
- **⚠️ 并行会话冲突复盘**：实现期间另一活跃会话（boulder `model-management-b9263bc4`，同时推进 C3/C4）采用 `string[]` + env `WORKER_DEFAULT_MODEL` 方案，并覆盖了 worker-protocol.ts / register-worker.dto.ts / workers.service.ts(+spec) / worker-dto.spec.ts / config.ts / .env.example / README 等。我最初按 task 字面（对象数组 + `MODEL_DEFAULT_ID`）实现，两次恢复后被再次覆盖。**最终决策：对齐并行会话的 `string[]` + `WORKER_DEFAULT_MODEL`**——原因：① 该方案已被并行会话在协议/DTO/服务/测试四层建立且自洽，继续对抗会使工作区持续不可编译；② 与 C1 目录 id 格式内聚；③ 未来 C3 消费端由并行会话按此实现，对齐避免 C2/C3 契约断裂。经验：多会话并行同计划文件时，先 `git diff` + 核对 boulder task_sessions 判断活跃会话，避免与活跃会话反复互改同一文件。
- **异步化改造点清单**（worker/src/index.ts）：`buildCapabilities` → async（透传 models?: string[]）；`buildRegisterOptions` → async（透传 models + defaultModelId）；`registerCurrent` → async（serve 就绪后 `await resolveModels(driver)` 探测真实模型，结果传入 buildRegisterOptions）；启动链（原 :336-343）原本已 `await registerCurrent()` 无需改；`dispatchCommands`（:71-83）纯命令透传不涉注册组装，**无需改**——reload-config 链路经 restartCoordinator → reRegister → registerCurrent 自动刷新 models。
- **降级语义**：`resolveModels` 独立导出（可注入 mock listModels）：成功 → `string[]`（可为空 `[]`，表达"已探测无模型"）；失败 → undefined（不携带 models，不阻断注册，console.warn 可观测）→ server 侧 C3 以"未上报"区分降级。成功空数组与失败缺省语义不同，测试覆盖两态。
- **defaultModelId 上报**：config.ts 新增 `WORKER_DEFAULT_MODEL` env（`(env.X ?? '').trim() || undefined`，类型 `defaultModelId?: string`）→ buildRegisterOptions 非空才携带 → registry-client body 条件透传 → server RegisterWorkerDto.defaultModelId（@IsOptional + @IsString）→ workers.service.register 落 `Worker.defaultModelId` 列。
- **server 落库语义（精细版）**：`...(dto.defaultModelId !== undefined ? { defaultModelId: dto.defaultModelId || null } : {})`——**区分"未上报"与"显式清空"**：worker 未携带 defaultModelId 字段 → 不写入（保留 C8/PATCH 已配值，防误清）；显式携带（含空串）→ 写值或 null。capabilities 整块 Json 已含 models 透传（无需改落库逻辑）；toWorkerView 透传 capabilities 已含 models（C8 才加 defaultModelId 透出）。
- **验证**：worker build + jest 16 suites / 189 tests 全绿（基线 178 + 新增 11：index.spec 8 个 + contract.spec 3 个）；server build + jest 43 suites / 595 tests 全绿（基线 559 + C2 4 个 worker-dto 用例 + 并行 C4 新增）。

## C2 finalize：统一协议为 string[] + WORKER_DEFAULT_MODEL（2026-08-08）

- **背景**：上一条 C2 记录（对象数组 `Array<{providerID, modelID, name}>` + env `MODEL_DEFAULT_ID`）来自并行会话，其依据的 task 版本与本会话 task 规格不一致。本会话 task 规格白纸黑字要求 `WorkerCapabilities.models?: string[]`（id 格式 `providerID/modelID`）与 env `WORKER_DEFAULT_MODEL`。
- **决策**：以本会话 task 规格为准，将 worker-protocol/index/config/registry-client/contract.spec/index.spec + server register-worker.dto/worker-dto.spec 全部统一为 `models?: string[]` + `WORKER_DEFAULT_MODEL`；删除并行会话引入的 `WorkerModelInfo`/`WorkerModelInfoDto` 对象结构（ValidateNested 校验不再需要）。
- **C3 消费说明**：C3 合并入库时按 C1 learnings 的 id 拆解约定（含 `/` 按首个 `/` 拆 providerID/modelID，不含 `/` providerID 归 `opencode`）解析 string id，信息与对象数组等价，免二次拆分。
- **server 落库修正**：register 的 defaultModelId 改为**条件更新**——`dto.defaultModelId !== undefined ? { defaultModelId: dto.defaultModelId || null } : {}`。并行实现 `?? null` 会在旧 worker 重注册（不携带字段）时把已有值清空，误清 C8/PATCH 配置；条件更新只在显式提供时写入。
- **验证**：worker `tsc` + jest 16 suites / 189 tests 全绿；server `nest build` + jest 43 suites / 595 tests 全绿。


## C5a: opencode auth.json 注入机制（2026-08-08，实测完成）

**结论（写死进 C5）**：
- **路径解析优先级**：`$XDG_DATA_HOME/opencode/auth.json` > `$HOME/.local/share/opencode/auth.json`（实验 3 两者同时设置时 XDG 胜出；strace 证实 serve 真实打开 `$XDG_DATA_HOME/opencode/auth.json`）
- **格式**：`{providerID: {type:'api', key}}`（本机 9 provider 全 type=api）
- **无 `--config` 支持**：`opencode serve --help` / `opencode --help` 均无 `--config` 参数；注入只能走 env（HOME 或 XDG_DATA_HOME）
- **主选方案**：worker 设置进程级 `XDG_DATA_HOME=<worker-data-dir>` + 写 `<dir>/opencode/auth.json`（600 权限）→ `spawnServe` env=`{...process.env}`（opencode-server.ts:282）自动继承 → 调 `restart()`（:201-206）生效。不改 spawnServe 签名、不动 cwd
- **加载实证**：auth.json 含 deepseek → `opencode models deepseek` 列出 4 模型；空 auth.json → `Provider not found`。auth.json 是 provider 可用性的唯一开关
- **降级**：无 auth.json → 0 credentials 静默降级，serve 正常启动（C5 失败态不会崩 worker）
- 证据：`.omo/evidence/c5a-auth-json.md`

## C5: 模型凭据下发（WorkerCommand model-credentials + auth.json 注入）（2026-08-08，实现 + 测试完成）

- **协议双写**：`WorkerCommand` 增加 type `model-credentials` + 可选 `payload?: ModelCredentialsPayload`（`{providerKeys: Array<{providerID, key}>, targetWorkerIds?: string[]}`，targetWorkerIds 空=全量）。worker-protocol.ts 与 workers.service.ts 双写一致，contract.spec 新增 round-trip（含 targetWorkerIds 缺省 / reload-config 无 payload 向后兼容）3 例。**向后兼容**：reload-config 命令不携带 payload，既有结构不受影响。
- **下发唯一化（Metis R4）**：`WorkersService.dispatchModelCredentials(providerKeys, targetWorkerIds?)`——非空 → enqueueCommand 逐个精确下发；空 → broadcastCommand 原样广播（**不改 broadcastCommand 签名**）。ModelsService.setCredential 保存成功后调用（`dispatchAfterSave` 私有方法，token 只经下行命令明文传输，失败 warn 不阻断保存——注册回放兜底）。
- **POST body 扩展**：SetModelCredentialDto 加 `targetWorkerIds?: string[]`（@IsOptional + @IsArray + @IsString each），controller 4 参转发 service。Swagger 注释文档化定向/全量语义。
- **注册/心跳回放（Metis R5）**：register 成功后 `replayModelCredentials(worker.id)`——查 ModelCredential revokedAt=null → CredentialCryptoService.decrypt 解出明文 → enqueueCommand 组装 providerKeys；**并行会话补充** heartbeat 中 worker 从 offline 恢复时也回放（`worker.status === OFFLINE` 判断，select 已含 status）；一直在线心跳不重复回放（避免每 10s 重启 serve）。回放失败（解密/DB 错）warn 不阻断注册。
- **模块循环依赖**：ModelsService 需 WorkersService（触发下发）+ WorkersService 需 CredentialCryptoService（注册回放）→ **双向 forwardRef**：models.module imports forwardRef(WorkersModule)、workers.module imports forwardRef(ModelsModule)。⚠️ 注意并行会话 C3 曾把 workers.module 的 ModelsModule 写成非 forwardRef，我改为 forwardRef 解环。
- **worker 注入（C5a 方案落地）**：新文件 `worker/src/credentials/model-credential-injector.ts`：
  - `buildAuthJson(providerKeys)` → `{providerID: {type:'api', key}}`（C5a 实测格式）；空/空白 providerID/空 key 条目静默跳过
  - `writeAuthJson(providerKeys, {dir?})` → mkdir -p `<dir>/opencode` + writeFileSync(mode 600) + chmodSync 600；dir 缺省 `os.tmpdir()/keta-auth-<random>`（路径随机化，仿 git-credentials.ts）
  - `cleanupAuthJson(dataDir)` → rmSync recursive force（幂等，仿 git-credentials cleanup）
- **index.ts 接线**：dispatchCommands 对 model-credentials 打 providerID 清单日志（**token 绝不进日志**）；onCommands 回调处理——先 cleanup 上次注入目录（旧凭据明文不留存）→ writeAuthJson → `process.env.XDG_DATA_HOME = dataDir`（serve spawn env={...process.env} 自动继承，无需改 spawnServe 签名）→ restartCoordinator.requestRestart（活跃会话挂起）；**shutdown 时 cleanupAuthJson(injectedAuthDir) 兜底清理**（worker 退出明文 key 不留存，幂等）。
- **验证**：worker build 通过 + jest **17 suites / 206 tests 全绿**（基线 189 + 新增 17：injector.spec 12、contract.spec 3、index.spec 2）；server build 通过 + jest **43 suites / 632 tests 全绿**（基线 595 + 新增 37，含并行会话 C3/heartbeat 回放 + 心跳恢复回放 2 例：offline 恢复回放 / 一直 online 不重复回放）。
- **⚠️ 并行会话协作**：models.service.ts / workers.service.ts / agents.service.ts 被并行会话（C3）扩展（CRUD + available-models 接入 + heartbeat 回放），我基于其最新状态叠加 C5，未冲突。第一轮 server jest 出现 agents.service.spec TS2304（并行会话编辑中），等其完成后再跑即 630 全绿——**并行会话编辑窗口期测试失败属瞬时态**。
- **F3 端到端待验证**：注册 token → 指定 worker 定向（targetWorkerIds）→ worker 心跳取命令 → 写 auth.json（600）→ restart → opencode serve 调模型成功；全量广播 + 新 worker 注册回放两条路径单测已覆盖。

## C1: 模型目录数据层（2026-08-08，实现完成）

- **schema 变更**：新增 `Model`（id `md_` 前缀零填充，@@unique([providerID, modelID])，capabilities Json?，enabled 默认 true）+ `WorkerModelAvailability`（workerId+modelId 复合主键，双 FK RESTRICT）；`Worker.defaultModelId String? @map("default_model_id")`（worker 默认模型兜底，C8 用）；`Agent.workerId String? @map("worker_id")`（软绑定首选 worker，可空 null=自动调度，Metis R1）。**Agent.workerId 无 FK relation**——软绑定语义：worker 离线/不存在不阻断 agent 生命周期，C7 调度层运行时校验，不建数据库外键。
- **迁移**：`20260808145108_add_models_catalog`（> 20260808071700 基线），`prisma migrate dev` 对 MySQL 3307 实库成功，SQL 含 2 ALTER + 2 CREATE TABLE + 2 FK。
- **id-resync**：`md_` 前缀复用现有 `resyncIdPrefix`（工具已是通用实现，无需改码）；单测新增 mixed id 用例（md_ 数字序号 + 命名 id → 只统计数字最大续号到 9）。C3 建 ModelsService 时在 onModuleInit 调用 `resyncIdPrefix(this.prisma.model, 'md', idGen)` 即可（参照 tools.service.ts:59-60 模式）。
- **seed 预置**：`buildModelSeedRows()` 由 STATIC_AVAILABLE_MODELS 8 模型生成 models 行（防空目录回归，Metis P1-2），`md_0000000001`~`md_0000000008` 固定序号（幂等不漂移）；`TEMPLATE_DEFAULT_MODELS` 预置四模板 defaultModelId（模板只读 PATCH 403 堵死配置通道，只能 seed 预设，Metis R3）。
- **id 拆解约定**：STATIC 模型 id 含 `/`（如 `opencode-go/deepseek-v4-flash`）按首个 `/` 拆 providerID/modelID；不含 `/`（如 `deepseek-v4-pro`）providerID 归为 `opencode` 默认 provider。模板默认模型映射：产品=`opencode/glm-5.1`（通用对话）、架构=`opencode/deepseek-v4-pro`（推理）、开发=`opencode-go/deepseek-v4-flash`（代码）、测试=`opencode/glm-5.2`（推理）。
- **seed 幂等注意**：模板 upsert 必须走 `update: { defaultModelId: ... }`（不能 `update: {}`）——旧库模板行已存在（defaultModelId=null），只有 update 分支能补上预置值。
- **验证**：`npm run build` 通过；jest 40 suites / 559 tests 全绿（+2 新 spec：id-resync md_ mixed id、agent.constants seed 行断言）。实库核对：models 8 行 enabled=true、四模板 defaultModelId 就位、Worker.defaultModelId 字段可用。

## P0.2: agent-config 原型模型区增强（2026-08-08，实现 + QA 完成）

- **改动范围**：仅 `docs/agent-platform/prototypes/agent-config/index.tsx`——modelPool（4 项产品命名）替换为 modelCatalog（8 项目录语义，对齐 models-manage：providerID/modelID + name + note + enabled + credential + fingerprint）；五模板 defaultModel 映射为目录 id；模型区块新增凭据行 + 首选 worker 行；model-select/model-config/model-source-hint testid 原样保留。
- **模板默认模型映射（原型 mock 值，仅示意）**：产品→`opencode-go/deepseek-v4-flash`（通用对话）、架构→`opencode-go/deepseek-v4-pro`（推理）、开发→`zhipu/glm-5.1`（代码）、测试→`opencode-go/deepseek-v4-pro`（推理）、发布管家→`zhipu/glm-5.1`（代码）。⚠️ **与 C1 seed 预置值不一致**（C1：产品=opencode/glm-5.1、开发=opencode-go/deepseek-v4-flash 等）——原型为产品视角语义映射（flash=日常/通用、pro=推理、glm=代码），实现期 C6 的模板默认展示应跟随 **seed 预置值**（C1 是唯一事实源），勿照抄原型 mock。
- **凭据双态展示方案**：model-token-status 行依据当前选中模型 credential 条件渲染——configured 显示绿徽章 + 脱敏 fingerprint（mono，如 `sk-****d2k9`）；missing 显示灰徽章 + token 输入框（model-token-input，type=password）+ 保存按钮。模型下拉做成受控（useState selectedModelId 联动凭据态）——这是本页唯一交互（文件头注释已同步说明），其余区块保持纯静态。
- **下拉选项**：`{provider} / {name}`（如 "opencode-go / DeepSeek V4 Flash"），仅列 enabled 模型（grok-4.5 停用不可选）；option 带 data-testid="model-option-provider" + data-model-id + data-credential。
- **首选 worker**：agent-worker-select（非受控 defaultValue=""），选项 = 自动调度（默认）+ 3 个 mock worker（worker-linux-01/02 在线、worker-mac-01 离线，选项带 ·在线/离线 后缀）；说明文案「未选则自动调度到任意可用 worker（软绑定）」。
- **语义色**：credentialTheme（configured 绿 #059669/#ECFDF5/#A7F3D0、missing 灰 #64748B/#F1F5F9/#E2E8F0）页面内定义，与 models-manage 页内完全一致（"扩展 token"范式，不碰 _shared/styles）。
- **QA**：md-docs build 退出码 0；playwright 13 断言全绿（保留 testid 回归 ×3 + 新 testid ×3 + provider 前缀 + 默认已配置态 + 切换 glm-5.1 → 未配置态输入框出现 + worker 选项 4 项 + 0 console 错误）。证据 `.omo/evidence/agent-config-model-enhanced.png`。
- **QA 环境踩坑**：① 静态 build 产物（/tmp/site）运行时「0 个项目」——项目数据需 dev server 动态提供，原型走查必须用 dev server（`md-docs --host 127.0.0.1 --port <p>`，cwd=仓库根，勿传 `--docs` 指向项目本身否则扫描不到项目）；② 原型为懒加载模块，playwright goto 后需等 ≥3s（networkidle 不够）；③ 本机 playwright python 版本与 chromium-1208 不匹配，launch 需显式 executable_path 指向 chromium-1208。

## C4: model_credentials 表 + token CRUD + AES-256-GCM 加密（2026-08-08，实现 + 测试完成）

- **schema**：新增 `ModelCredential`（id `mc_` 前缀零填充，providerID **@@unique(uk_model_credentials_provider)** 按 provider 粒度、credentialRef（加密密文）、fingerprint（脱敏）、revokedAt 软删）。**不建 FK 到 models**——models.provider_id 非唯一，凭据按 provider 粒度全局唯一（auth.json 顶层键 = providerID，C5a 实测），逻辑关联经 ModelsService 按 model.providerID 解析。
- **迁移**：`20260808154421_add_model_credentials`（> C1 的 20260808145108），`prisma migrate dev` 实库 MySQL 3307 应用成功，`model_credentials` 表结构确认（provider_id UNI / credential_ref / fingerprint / revoked_at datetime(3)）。
- **加密服务**：`server/src/common/credential-crypto.service.ts`——AES-256-GCM（node:crypto 内置，无新依赖），密文格式 `ivHex:authTagHex:ciphertextHex` 三段；key 来自 env `MODEL_CREDENTIAL_KEY`（32 字节，支持 64 hex / base64 / utf8 三编码解析）；**缺失策略**：production → 启动抛错拒绝（绝不静默弱 key），development/test → 硬编码 DEV 密钥 + `logger.warn` 显式标记。fingerprint = `前4****后4`（如 `sk-a****89xz`），短 token（≤8）折半掩码。
- **端点**（`server/src/models/`，ModelsModule，路由 `/models/:id/credentials`）：
  - POST（AdminGuard）`{token, providerID?}`——按 provider 粒度 upsert（同 provider 重复 POST 覆盖更新 + 清除 revokedAt）；**providerID 校验一致策略**：body 显式提供时须与 model.providerID 一致，冲突 → 400 MODEL_PROVIDER_MISMATCH（避免 GET 按 model.providerID 查不到）。
  - GET（**成员只读**，不挂 AdminGuard——只出脱敏 fingerprint 无敏感信息）→ `{id, providerID, configured, fingerprint, revokedAt, createdAt}`；**绝不返回 credentialRef/明文 token**（明文零接触，17 篇 §3.4）。
  - DELETE（AdminGuard）→ 软删（revokedAt 标记，保留 fingerprint 审计轨迹）；未配置 → 404 MODEL_CREDENTIAL_NOT_FOUND。
  - model 不存在 → 404 MODEL_NOT_FOUND（三条端点先 resolveProviderID）。
- **续号**：`resyncIdPrefix(this.prisma.modelCredential, 'mc', idGen)`（onModuleInit），复用 C1 通用工具。
- **安全**：明文 token 只在 POST body 与 decrypt 时存在；日志只打 fingerprint；响应无明文。logger 用 `model=... provider=... fingerprint=...` 格式。
- **测试**：43 suites / **595 tests** 全绿（基线 559 + 新增 36）——credential-crypto.spec（roundtrip/随机 iv/三编码 key/错 key authTag 抛错/篡改/格式非法/生产缺 key 抛错/开发缺 key 警告可用/fingerprint 短 token）、models.service.spec（首次 create/重复 POST 覆盖更新/未配置 configured=false/providerID 冲突 400/吊销 revokedAt/404）、models.controller.spec（转发 + 无明文断言）。
- **决策记录**：遗留实现（先前会话）主体复用，修正三处与任务要求差异——① GET 由 AdminGuard 改**成员只读**（任务要求，fingerprint 非敏感）；② POST body 补 `providerID?` 可选 + 校验一致（任务要求 body {token, providerID?}）；③ 视图补 createdAt 字段（任务返回契约）。

## P0.3: 原型验收与文档同步（2026-08-08，完成）

- **build 验证**：`md-docs build --docs docs/agent-platform --out-dir /tmp/site` 退出码 0（node v22，默认 shell v18 会报 rolldown styleText 错误；验证注册无错）。⚠️ 注意 build 用 `--docs docs/agent-platform` 可以成功（前端包自带项目元信息），但 build 产物运行时「0 个项目」——项目数据由 dev server 动态注入，build 只是编译静态前端，不打包 docs 内容。
- **dev server 配置陷阱（与 P0.2 踩坑①一致，已复验）**：`md-docs --docs docs/agent-platform --host 0.0.0.0 --port 5177` 会把 docs 根直接指向项目目录 → scanner 认为 docs 下无项目（0 个项目）。**正确姿势：`md-docs --docs docs --host 0.0.0.0 --port 5177`（docs 根=仓库根下 docs/，项目=顶层子目录 agent-platform）**。修复后 192.168.10.78:5177 外部访问正常，显示「1 个项目 · 20 篇文档 · 18 个原型」。
- **models-manage 走查**：`#/p/agent-platform/protos/models-manage`（dev server 8933 内网 + 5177 外网均验证）——models-manage-root/model-list/model-search/credential-section/model-credential-input/model-credential-target-workers/model-credential-save 等 testid 断言 true；model-item/model-toggle/model-provider/model-name/model-id/model-credential-status 因列表多行返回「matched multiple elements」（属正常渲染）；0 console 错误。截图 `.omo/evidence/models-manage-proto.png`。
- **agent-config 增强区走查**：model-config/model-select/model-source-hint 既有 testid 回归通过；新增 model-token-status + agent-worker-select 可见；**model-token-input 默认不可见是预期**——受控条件渲染（仅当前选中模型 credential=missing 时才显示输入框，默认选中已配置模型故隐藏），不是缺陷。
- **全量走查 18 页**：login/project-list/task-create/task-board/group-chat/dm-chat/task-detail/agent-config/user-management/role-permission/worker-list/worker-install/skills-tools-manage/tool-register/nav-rail/nav-cmdk/nav-hybrid/models-manage 全部无 console 错误。⚠️ grep console 累积日志会误报（vite HMR/React DevTools info 命中 error 关键词），正确做法是每页 goto 前 `console --clear` 再 `console --errors`。
- **文档同步四处 17→18（/8→18）**：06 篇清单表加 models-manage 行（业务页）+ 页面范围「15 业务原型 + 3 导航方案 = 18」+ 新增 §2.13 模型目录管理页交互章节；18-原型审计报告加 §2.14 models-manage 盘点（testid 19 项）+ 汇总统计 18 + 使用矩阵 18 页 + 页面总数 18；05 篇 §3.1 交付表「18 个原型页面」+ 原型清单补 models-manage 块；docs/README.md「8 个原型」→「18 个原型」。
- **models-manage testid 清单（19 项）**：models-manage-root, manage-toolbar, model-search, model-add-button, model-list, model-item, model-toggle, model-provider, model-name, model-id, model-credential-status, credential-section, model-credential-select, model-credential-input, model-credential-select-all, model-credential-target-workers, model-credential-save, model-credential-cancel, model-hint（C6 实现页 testid diff 基准）。

### P0.3 补充（2026-08-08，验收复验）

- **dev server 实际启动参数**：5177 端口此前由 `md-docs --docs docs/agent-platform --host 0.0.0.0 --port 5177` 启动（PID 494825，cwd=仓库根），项目列表显示「0 个项目」——`--docs` 指向项目内部而非 docs 根，scanner 找不到顶层项目。**已 kill 重启为 `md-docs --docs docs --host 0.0.0.0 --port 5177`（tmux md-docs 会话）**，外部 `192.168.10.78:5177` 访问正常（1 个项目 · 18 个原型）。
- **全量走查 18 页**：全部无 console 错误。⚠️ group-chat 首轮报 4 条 `ERR_NETWORK_CHANGED`（网络波动，非代码错误），单独重测 3 次全过。走查脚本注意：`page.remove_listener` 对 lambda 包装器会 KeyError，**每页用独立 context 即可**（context.close 自动清理监听）。
- **第 5 处计数同步**：除计划内 4 处（06 清单表 / 18 审计报告 / 05 §3.1 / docs/README.md）外，`18-推进计划（分阶段实施）.md:40` 计划基线表也有「17 个原型页面」清单，已同步为 18 并补 models-manage（列在 agent-config 之后、role-permission 之前）。
- **文档渲染验证**：dev server 热更新后 playwright 断言——06 篇清单表含 models-manage 行 + 「18 个原型」；05 篇 §3.1 交付表「18 个原型页面」+ 模型目录管理；原型 tab 显示「18 个原型」+ 模型目录管理。05 篇文档 id 是 `nonfunc-acceptance`（非 `non-functional`），走查 URL 需用正确 id。

## C3: ModelsModule 目录服务（CRUD + worker 上报合并 + available-models 三路径，2026-08-09）

- **并行会话对齐**：工作区存在活跃并行会话（boulder model-management-b9263bc4）同时推进 C3/C5，已写好 DTO（create/update/query-models）+ models.service CRUD + controller CRUD + WorkersModule import ModelsModule。本会话复用其实现，统一两处与任务规格差异：① 错误码 MODEL_ID_CONFLICT → **MODEL_EXISTS**（任务要求 409 MODEL_EXISTS，前端无引用可自由对齐）；② 方法名 mergeWorkerModels → **syncFromWorkerCapabilities(workerId, models[])**（任务验收点名该名；service 定义 + register 调用 + spec 三处同步改名）。
- **ModelsService CRUD**（参照 mcp-servers 骨架）：
  - `findAll`：enabled 过滤 + providerID/modelID/name contains 搜索 + 分页 {items,total,page,pageSize}（$transaction count+findMany）
  - `create`：providerID+modelID 撞 @@unique → 先查后抛 409 MODEL_EXISTS（assertProviderModelAvailable，对齐 mcp-servers assertNameAvailable）；enabled 缺省 true；capabilities Json? 透传
  - `update`：部分更新 {name?, capabilities?, enabled?, providerID?, modelID?}；改唯一键时按合并后最终值校验并**排除自身**
  - `remove`：物理删除 + **先清 worker_model_availabilities 再删 model**（FK onDelete Restrict，非级联，需服务层显式编排）
  - `onModuleInit`：md_ + mc_ 双前缀续号（resyncIdPrefix 复用）
- **syncFromWorkerCapabilities（C3 核心集成点）**：worker 注册后 capabilities.models（string[]，providerID/modelID 格式）→ 逐条 splitModelId 拆解（含 `/` 按首个 `/` 拆，不含 → providerID=opencode）→ upsert 目录（findUnique 查存在复用，不存在 create name=modelID 默认）→ upsert availability（workerId_modelId 复合键 upsert）。**空数组/缺省 → 返回 0 不触碰目录**（C2 降级语义：未上报保留旧数据）。
- **WorkersService.register 接线**：upsert worker 后调用 `syncFromWorkerCapabilities(worker.id, dto.capabilities?.models)`，**包 try-catch 失败不阻断注册**（warn 可观测）——放在 C5 replayModelCredentials 之前。模块：WorkersModule import ModelsModule（**单向无环，ModelsService 不反向依赖 WorkersService，普通 import 无需 forwardRef**，与并行会话结论一致）。
- **getAvailableModels 三路径**（agents.service，Metis P1-2 优先级写死）：① 目录优先 listCatalogModels（enabled=true → [{id: providerID/modelID, name}]，无在线 worker 也可查）；② pull 兜底（目录空 + worker 在线 → WorkerClient.listModels）；③ STATIC fallback（两者皆空 → STATIC_AVAILABLE_MODELS + source:'fallback'）。返回结构保持纯数组 [{id,name}]（前端 agents/page.tsx 双形态兼容）。AgentsModule 新增 import ModelsModule。
- **测试**：43 suites / **630 tests** 全绿（基线 595 + 新增 35）——models.service.spec（CRUD 12 + sync 2 + listCatalog 1 + onModuleInit 改造）、models.controller.spec（CRUD 端点 5）、workers.service.spec（**集成验收**：register 上报 models → sync 透传 workerId+models 断言 + 未上报 undefined 透传 + sync 抛错不阻断注册 3 个）、agents.service.spec（三路径 5：目录优先/pull 兜底/无 worker 降级/listModels 异常/空列表）。`nest build`（tsc）通过。
- **⚠️ 提交注意**：工作区未提交改动混杂并行会话的 C5（workers.service MODEL_CREDENTIALS 命令 + replayModelCredentials + setCredential targetWorkerIds 参数）与 skills/tools 重构，本会话未执行 git commit——C3 提交 `feat(models): ModelsModule 目录服务与 available-models 接入` 需在并行会话协调后统一执行（避免把 C5 改动误带入 C3 commit）。

## C3 finalize：模块依赖修正与测试基线校正（2026-08-08）

- **⚠️ 模块依赖修正**：上一条 C3 记录写「ModelsModule 不反向依赖 WorkersService，单向 import 无需 forwardRef」——**与最终代码不符**。C5 落地后 ModelsModule 为「凭据保存后触发下发」在构造函数注入 `WorkersService`（dispatchAfterSave），ModelsService 亦被 WorkersService 依赖（注册回放 + 模型合并），**形成双向模块循环**：`models.module.ts: forwardRef(() => WorkersModule)` + `workers.module.ts: forwardRef(() => ModelsModule)`，**两边都必须 forwardRef**，任一缺失启动即报 Nest can't resolve dependencies。
- **C3 接线点（register）**：upsert worker 后 `try { await this.modelsService.syncFromWorkerCapabilities(worker.id, dto.capabilities?.models) } catch { warn 不阻断 }`，位于 C5 replayModelCredentials 之前。
- **available-models 三路径**（agents.service getAvailableModels）：目录优先 `modelsService.listCatalogModels()`（enabled=true，返回 `[{id: providerID/modelID, name}]`）→ 目录空且 worker 在线 pull 兜底 → 两者皆空 STATIC fallback；前端纯数组契约保持。
- **jest 类型严格差异**：`npx tsc --noEmit` 通过但 jest（ts-jest 更严格）报 TS2367——heartbeat 中 `status !== WORKER_STATUS.OFFLINE` 因 status 类型为 `"online"|"degraded"`（与 offline 无重叠）。修复：简化条件为 `if (worker.status === WORKER_STATUS.OFFLINE)`（新状态恒非 offline，语义等价）。
- **最终基线**：43 suites / **632 tests** 全绿（基线 595 + C3 新增 37）——models.service.spec idGen mock 改为按前缀生成（`nextId(prefix) => prefix_<seq>`），修正 sync 合并新建行 id 断言；workers.service.spec 补 ModelsService import；agents.service.spec 补 ModelsService mock + provider。`npm run build` 通过。
- **DTO 校验**：`create-model.dto.ts` 导出 `MODEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/`（providerID/modelID slug，update 复用 import），query-models.dto enabled 布尔 transform 对齐 mcp-servers。全局 whitelist（main.ts）已启用，无需改。

## B1（F3 CRITICAL）：凭据循环重启修复（2026-08-09，修复 + 实证完成）

- **根因（F3 实证）**：`workers.service.ts register()` **无条件调用 `replayModelCredentials(workerId)`**——凭据命令 → worker 写 auth.json → serve restart → reRegister（走同一 register()）→ 再回放 → 无限循环。实测旧镜像保存凭据后 worker 每 ~10s 重启一次（27+ 次循环），worker 详情 capabilities.models 恒为空。心跳路径有 OFFLINE 保护（仅 offline→online 回放），register 路径没有。
- **修复（`server/src/workers/workers.service.ts register()`）**：upsert 前先 `findUnique({ where: { id }, select: { status: true } })` 查原状态；回放条件改为 `if (!existing || existing.status === WORKER_STATUS.OFFLINE)`——仅首次注册（原不存在）或原 offline 时回放；已在线 worker 的 reRegister（serve 重启触发）**不回放**。与心跳路径语义一致：凭据只在 worker 首次上线或从离线恢复时下发一次。dispatchAfterSave（管理员保存后主动下发）保留不动。
- **配套修复（`worker/src/index.ts` RestartCoordinator restart 回调）**：serve 重启（随机端口变化）后须同步 `driver.baseUrl = await serveServer.restart()` 的返回值——否则 reRegister 的 resolveModels 探测打到旧端口 `fetch failed`，capabilities.models 恒空。B2（空列表预热重试）只覆盖"空列表"，不覆盖"fetch 到死端口"。
- **单测（`workers.service.spec.ts` register describe +4）**：① 首次注册（原不存在）→ 回放；② 已在线 reRegister → 不回放（modelCredential.findMany 不被调用）；③ 原 offline reRegister → 回放；④ 循环不复现（首次回放一次，在线 reRegister 不新增命令，命令不累积）。server jest **43 suites / 656 tests 全绿**（基线 652 + 4）。
- **实证（compose 13000/13001 实库）**：旧镜像保存凭据 → worker 循环重启（server 日志"模型凭据回放"刷屏 + worker 连续 execute restart）→ DELETE 凭据循环即停（replay 查 revokedAt=null 返回空）→ 部署修复后 server 保存凭据 → 45s+ 仅 1 次凭据注入重启（dispatchAfterSave 预期行为，循环切断）→ capabilities.models 上报 **26 个真实模型**，worker 稳定 online。
- **⚠️ docker cp 嵌套坑**：`docker cp <src>/dist <container>:/app/dist` 当目标已存在时**不会覆盖而是嵌套**成 `/app/dist/dist/...`（md5 不一致、容器仍跑旧代码）。正确姿势：`docker cp <src>/dist/. <container>:/app/dist/`（`.` 后缀强制覆盖内容）。且 compose worker 容器的实际工作目录是 **`/tmp/keta-worker`**（WORK_DIR），dist 拷贝目标是 `/tmp/keta-worker/dist` 而非 `/app/dist`。
- **⚠️ compose 环境构建限制**：本机 docker build 拉取 docker/dockerfile:1 frontend 元数据超时（registry-1.docker.io 不可达），无法 `docker compose build`——用"本地 `npm run build` + `docker cp` + `docker compose restart`"绕过（server 容器 dist 路径 `/app/dist`，worker 容器 `/tmp/keta-worker/dist`）。
- **⚠️ compose server 容器重启后 worker 状态**：server 容器 restart 会短暂中断 worker 心跳；markStaleWorkersOffline 仅在 status != offline 且 30s 未心跳时标 offline，worker 心跳间隔 10s，快速恢复不受影响。

## C6 拆分：Provider 管理页 + 模型列表页（纯展示）（2026-08-09，实现完成）

- **用户需求原话**：「模型列表不太对，应该不是新增模型，而是新增凭证，新增时要选择provider，输入key就好了。要有专门的凭证管理，可以列出所有的provider，已经配置凭证的显示已配置状态。点击配置弹出输入框。provider支持同步到节点。也就是现有的模型管理要分成2个页面，provider列表和模型列表，模型列表只做展示」
- **决策：前端聚合替代后端 providers 端点**——任务计划依赖「后端 GET /models/providers 聚合端点（并行任务）」，但该并行任务未交付（controller/service 无 providers 方法，spec 中 providers 仅为 Nest 测试 providers 数组）。采用前端聚合：`GET /models?pageSize=100` 拉全量 → 按 providerID 分组（Map 聚合）→ 每 provider 用**首个模型 id** 查 `GET /models/:id/credentials`（凭据按 provider 粒度 C4，同 provider 下任一模型 id 均可查询）。零后端改动、非侵入，规避 server 回归风险。
- **新页面 `web/app/(main)/providers/page.tsx`（/providers，Provider 管理）**：
  - 列表行 = providerID + 模型数 + 凭据状态徽章（**三态**：已配置绿 / 未配置灰 / 已撤销琥珀——`configured=true` 优先，否则 `revokedAt` 非空 → revoked）+ fingerprint（仅已配置显示）
  - 配置弹窗：provider 预填只读 + key 输入（password）+ 同步到节点（worker 多选，未选=全部广播 C5）+ 保存 → POST /models/:id/credentials {token, targetWorkerIds?}
  - 删除凭据（已配置/已撤销时显示）→ DELETE → 软撤销 revokedAt → 徽章变未配置
  - isAdmin 控制配置/删除；成员只读（无操作列）
  - 新增 testid 22 项：providers-root/toolbar/list/item/id/model-count/credential-status/fingerprint/configure-button/delete-button/config-modal/modal-provider/modal-key-input/modal-select-all/modal-workers/modal-save/modal-cancel/modal-error/hint/loading/error/retry
- **模型页 `web/app/(main)/models/page.tsx` 重构为纯展示**：
  - 移除：新增模型弹窗（CreateModelModal + model-add-button）、凭据配置区（credential-section + model-credential-* 全部）、启停开关（ToggleSwitch + model-toggle）
  - 保留：搜索 + 模型列表（provider/名称/模型ID/可用节点/凭据状态徽章）+ model-hint
  - enabled 改为**只读徽章 model-enabled-badge**（已启用蓝/已停用灰，替代写操作开关）
  - 共享类型提取到 `web/src/types/models.ts`（ApiModel/ModelsResponse/ApiWorker/CredentialView，原页面私有）
- **导航注册 5 处**：nav-dock NAV_ITEMS（models 后插入 providers，9 项——icons 区 overflow-y:auto 兜底不溢出）+ app-shell KEY_TO_PATH + PAGE_TITLE（models subtitle 改「模型目录只读展示」，providers 新增「凭证管理与节点同步」）+ CMDK_NAV_PATH + cmdk-panel DEFAULT_CMDK_ITEMS
- **e2e 同步**：pages.spec.ts /models 测试移除 credential-section 断言（改 model-enabled-badge + credential-section toHaveCount(0) 反断言）+ 新增 /providers 测试（列表 + 徽章 + 弹窗开合）；testids.ts models 审计页 testid 精简为 14 项展示类 + 新增 providers 审计页 22 项 + PAGE_SMOKE 双页更新
- **⚠️ TS 陷阱**：`useState(false)` 推断 boolean，存 providerID 字符串报 TS2367/TS2345——需 `useState<string | false>(false)`（双语义状态：false=关闭 / 字符串=open 的 providerID）
- **验证**：`npx tsc --noEmit` 通过 + `npm run build` 通过（/providers 路由生成）。e2e 未实跑（需 dev server + 后端），build 门已过

## D4: docker-compose 配置层对齐（WORKER_DEFAULT_MODEL + 注释同步）（2026-08-09，完成）

- **worker service 补 WORKER_DEFAULT_MODEL（C2 新增）**：environment 加 `WORKER_DEFAULT_MODEL: ${WORKER_DEFAULT_MODEL:-}`（可空占位，未设 = 空串，worker/src/config.ts:77 `(env.X ?? '').trim() || undefined` → 不指定、serve 默认）。注释说明：worker 默认模型兜底（Agent 未配模型时用，C7 模型解析优先级第 3 级）。已实测：未设 → `""`、设 `opencode-go/deepseek-v4-flash` → 透传。
- **init seed 注释**：说明用编译产物 `node dist/prisma/seed.js`（`npm run build` 产出；runner 镜像无源码不能 ts-node）——对齐 F3 修复（D1 原用 `npx prisma db seed` ts-node 编译失败）。
- **server MODEL_CREDENTIAL_KEY 注释**：模型 provider token 加密密钥（C4 AES-256-GCM，64 hex；生产必改，默认值仅本地 dev）。默认 dev key `05afa7cd...` 保留不动。
- **文件头注释**：worker 行补模型管理功能说明（WORKER_DEFAULT_MODEL 兜底 + 凭据下发注入 auth.json）。
- **验证**：`docker compose config` 通过（YAML 合法 + env 解析正确，无未定义变量警告）；未重建镜像（仅配置层更新，`docker compose up -d --build` 生效）。四服务 + init 结构未动，未加新服务。

## D6: workers 页去"新增 Worker" + curl 下载地址动态化（2026-08-09，实现 + 验证完成）

- **用户需求原话**：「worker里面，有两个添加worker的功能，去掉新增worker，只保留安装worker。另外curl安装时，下载地址需要走默认的当前页面访问地址，现在看着是一个example地址」。
- **① workers 页去"新增 Worker"（page.tsx）**：删除 `add-worker-button` 按钮（原型 testid）+ `WorkerGuide` 组件 + `GUIDE_STEPS` + `guideOpen` state + 空态自动展开 effect + `{guideOpen && <WorkerGuide/>}`——操作行仅剩 `install-worker-link`（「安装 Worker」→ /workers/install）。**决策：worker-guide 注册指引整体移除**（与 install 向导功能重叠且删除入口后无可达路径）；空态 EmptyState 文案同步改为「点击右上角安装 Worker」；文件头注释 testid 清单同步（删 add-worker-button/worker-guide）。⚠️ **workerCards 数据依赖登录 token**——playwright 浏览器旧 storageState token 过期时 workers 页显示「未认证或 token 无效/已过期」（API 401），需重新表单登录 seed-admin/Admin@123456（e2e auth.setup.ts 凭据，不是 Admin@123）。
- **② install 页 curl 下载地址动态化（install/page.tsx）**：`curlCommand` 下载 URL 从硬编码 `https://platform.example.com/install-worker.sh` 改为 **`${pageOrigin}/install-worker.sh`**；`serverUrl` 默认值从 `http://platform:8080` 改为当前 origin。**实现细节（hydration）**：pageOrigin 用 `useState("")` + `useEffect(() => setPageOrigin(window.location.origin))` 挂载后填充——直接 `useState(() => window.location.origin)` 会 SSR/hydrate 首帧不一致（mismatch 警告），空串首帧毫秒级被 effect 覆盖，可忽略；serverUrl 用第二个 effect `setServerUrl(cur => cur ? cur : pageOrigin)` 跟随 origin（用户改过就不覆盖）。
- **③ web/public/install-worker.sh（下载目标）**：一键安装脚本（`bash -n` 通过，chmod +x）。参数 `--server/--worker-id/--concurrency/--opencode/--token/--repo/--dir`；流程 = 前置校验（git/node≥18/opencode）→ `git clone --depth 1`（缺省 `git@gitee.com:xishuhq/aiagents.git`）→ npm install → 生成 .env（SERVER_URL/WORKER_ID/X_WORKER_TOKEN，不覆盖已有）→ token 校验 → build → `exec ./scripts/start.sh`。**⚠️ --concurrency 为预留参数**：worker 侧 `maxInstances` 硬编码 1（worker/src/index.ts:186，无 env 配置项），脚本仅提示不生效——已写入脚本注释与 curlSteps 文案（「拉取源码」而非「下载二进制」）。
- **e2e 同步**：pages.spec.ts 17/18 改为断言 `install-worker-link` 可见 + `add-worker-button`/`worker-guide` **toHaveCount(0)**（断言不存在元素，防回归）；testids.ts 2.13 worker-list 条目 `add-worker-button`→`install-worker-link`、删 `worker-guide`；PAGE_SMOKE /workers 同步。
- **验证**：web `npx tsc --noEmit` 0 错误 + `npm run build` 通过（/workers 4.37 kB、/workers/install 4.21 kB）；playwright 实证：workers 页 install-worker-link=1 + add-worker-button=0 + worker-guide=0 + 7 worker 卡片；install 页 curl 命令 = `curl -fsSL http://localhost:3001/install-worker.sh | bash -s -- --server http://localhost:3001 --worker-id worker-05 ...`（动态 origin 无 example）+ serverUrl 默认 http://localhost:3001；`GET /install-worker.sh` 200；e2e pages 3 项（setup + 16/17 + 17/18）全绿（8.6s）。
- **⚠️ 环境坑复现（C11 已知）**：生产 build 后 dev server ENOENT `_buildManifest.js.tmp`（.next 缓存损坏，持久 500）——修复：kill dev → `rm -rf .next` → 重启 dev（nohup 后台即可；tmux 会话 C-c 时 server 偶发整个销毁，nohup + 日志文件更稳）。

---

## QA-009/010/003: 后端校验缺陷修复（2026-08-09，实现 + 测试完成）

- **背景**：QA 报告（qa-report-192-168-10-78-13001-2026-08-09.md）三类后端校验缺陷——① POST /agents {"name":"","type":"custom"} 返回 201；② POST /workers/register 缺 capabilities → Prisma upsert 收到 undefined → 500；③ Provider key "abc" 可保存成功。
- **根因统一模式**：`@IsString()/@MaxLength()` 允许空串（empty string 是合法 string）、`@ValidateNested()/@Type()` 遇 undefined 直接跳过（不报错）→ 校验层放行，缺陷值穿透到 service/Prisma。
- **修复**：
  1. **CreateAgentDto.name + UpdateAgentDto.name** 补 `@IsNotEmpty()`（在 @IsString 后）→ 空名/显式空串 400。⚠️ `@IsOptional()` 只忽略 `undefined`/`null`，**不忽略空串**——UpdateAgentDto 补 @IsNotEmpty 后 `{name:""}` 仍被拒、缺省 name 仍可选，语义正确。
  2. **RegisterWorkerDto.capabilities + load** 补 `@IsObject() + @IsNotEmpty()`（在 @ValidateNested 前）→ 缺字段 400 非 500。worker 侧 buildCapabilities 恒返回对象、load 恒为 `{instances}`（registry-client `load: opts.load ?? {instances:0}` 兜底），加必填不破坏真实 worker 注册。
  3. **SetModelCredentialDto.token** 补 `@Matches(/^sk-[A-Za-z0-9_-]{8,}$/, {message:'token 需以 sk- 开头且至少 8 位…'})` → "abc"/无 sk- 前缀/过短 400。**决策**：用放宽版 `{8,}`（opencode 真实 token 均 sk- 前缀 + 长后缀；测试固定 token `sk-test-b1-token-0003`、`sk-raw-token` 均匹配）。
- **测试范式（沿用 tasks.controller.spec DTO 校验 describe）**：`validate(plainToInstance(cls, obj))` 断言 errors 非空/为空，比 e2e 轻量且直击 class-validator 行为：
  - agents.controller.spec 新增 5 例（create 空名/缺失/合法 + update 空串/缺省可选）
  - worker-dto.spec 新增 4 例（缺 capabilities/缺 load/标量 capabilities/完整对象通过）
  - models.controller.spec 新增 4 例（abc/无前缀/过短/合法）
- **⚠️ 全量 jest 瞬时红坑**：并行会话编辑 users.service.ts/spec 期间跑全量 jest 会报 `users.service.spec.ts` **babel 解析错误（expect '}'）**——文件被半写入的瞬时态，非代码问题；等会话写完重跑即 43 suites / 687 tests 全绿（基线 668 + 本任务 13 + 并行会话 ISSUE-002 6）。
- **验证**：`npm run build` 通过 + jest **43 suites / 687 tests 全绿**。
- **顺手加固 CloneAgentDto.name**：同类缺口（显式 `{name:""}` clone 会创建空名副本）——补 `@IsNotEmpty()` + 2 测试（空串拒/缺省过）。最终 agents.controller.spec 7 例、worker-dto.spec 4 例、models.controller.spec 4 例，合计 **+15 tests**（668 → 683，含并行会话 ISSUE-002 后 689）。

## E1: 修复 QA ISSUE-001 任务看板页头计数硬编码（2026-08-09，实现 + tsc 验证完成）

- **用户反馈（QA ISSUE-001）**：`/board?pid=...` 页头显示「任务看板 **5 个任务** · 4 个 Agent 在线」，但 `GET /projects/:pid/tasks` 实际 `total: 1`，看板各列只渲染 1 个任务卡片；项目列表卡片（`_count.tasks`）与页头、API 三方数据互不一致。
- **根因（精确定位）**：页头 subtitle 由 **AppShell 的 `PAGE_TITLE.board` 静态映射**提供（`web/src/components/layout/app-shell.tsx`），迁移时把原型 mock 值**原样硬编码**——原型 `docs/agent-platform/prototypes/task-board/index.tsx:349` 是 `subtitle={`${tasks.length} 个任务 · 4 个 Agent 在线`}`（tasks 为 mock 5 条），实现侧写成死字符串 `"5 个任务 · 4 个 Agent 在线"`，与真实数据完全脱节。**不是**看板页调错 API，board/page.tsx 的数据源（`["tasks", pid, status]` → `GET /projects/:pid/tasks`）本身就是对的，只有 AppShell 顶栏副标题写死。
- **修复方案（AppShell 动态 subtitle）**：
  1. `PAGE_TITLE.board.subtitle` 清空（死 mock 值删除），board 路由 subtitle 改由组件内动态组装。
  2. AppShell 内 `isBoard = pathname.split("/")[1] === "board"` + effect 读 `?pid=`（`new URLSearchParams(window.location.search)`，对齐 board/page.tsx 既有模式，避开 `useSearchParams` 的 Suspense 边界问题）。
  3. 两个 `useQuery`（QueryClientProvider 在 root layout，AppShell 可直接用）：
     - `["board-tasks", pid]` → `GET /projects/:pid/tasks?page=1&pageSize=1` 取 **total**（与看板页同源，三方对照基准）；
     - `["workers"]` → `GET /workers` 统计 **status !== 'offline'** 数量作为「Agent 在线」（**决策**：Agent 无在线态（agents.service 无 status 字段），Worker 才有 online/offline/degraded；「Agent 在线」映射为平台在线 worker 数，与 agents 页「在线优先」worker 语义一致）。queryKey `["workers"]` 与 agents 页同 key 同 queryFn → react-query **缓存共享非污染**（C10 教训的反面），跨页省一次请求。
  4. subtitle = `${total} 个任务 · ${onlineCount} 个 Agent 在线`；数据未就绪（total/online 任一 undefined）→ 空字符串（NavTopBar 隐藏，避免闪烁错误数字）。
  5. enabled 条件 `hydrated && !!token && isBoard`——登录水合完成 + 有 token 才发请求（AppShell 登录守卫同源判断）。
- **⚠️ 环境坑（build 并发冲突）**：本任务与并行会话（ISSUE-002 users 页面开发）同时工作——web 的 `.next` 是共享的，**两个 `next build` 同时跑会互相覆盖 `.next` 导致 ENOENT（routes-manifest.json / *_client-reference-manifest.js copyfile 失败）**，且并行会话编辑中的 users/page.tsx 会在 tsc/build 中产生瞬时 type error（`UserRow` 缺 `onEdit` prop——并行会话已修复，重跑即过）。教训：并行会话活跃期间，验证 build 须**先等对方 build 结束再独占 `.next` 跑**，或干脆只跑 tsc（tsc 不写 `.next`，无冲突）。
- **遗留观察**：项目列表卡片「{taskCount} 个任务 · **0 已完成**」的「已完成」计数（projects/page.tsx:161）仍是 `EMPTY_TASK_COUNT=0` 硬编码兜底（Phase 1 无统计端点），若项目含已完成任务会与 API 不一致——本次未处理（ISSUE-001 聚焦页头），后续可加任务状态计数端点或复用 tasks API 按 status 聚合。

## ISSUE-006: 后端权限矩阵覆盖不全修复（2026-08-09，实现 + 单测 + 运行时实证完成）

- **根因（QA 报告）**：AdminGuard 只挂在 users/roles 控制器；workers/models/skills 的 GET 仅依赖全局 JwtAuthGuard（登录即放行）；agents/projects 完全无守卫 → 受限用户（仅 3 个 view 权限点）可读 workers/models/skills、可 POST 创建 agents/projects（实测 201）。权限矩阵（8 资源 × 6 操作）实际只对 users/roles 生效。
- **决策（方案 A：精细权限模型）**：设计文档 09 篇 §2.3 明确「PermissionsModule 按角色权限矩阵（资源×操作）拦截」+ roles.constants.ts 固定 8 资源（tasks/chats/artifacts/agents/workers/skills/users/roles）× 6 操作（view/create/edit/delete/review/manage）→ 实现通用 `PermissionGuard`（`server/src/common/guards/permission.guard.ts`）+ `@RequirePermission('resource.action')` 方法级装饰器。
- **PermissionGuard 三种权限格式兼容**（对存量 seed 数据零迁移）：
  1. `permissions.all === true`（seed admin 简写）→ 全放行；
  2. `permissions.all === false`（seed member 简写）→ view 放行（成员只读）、写操作（create/edit/delete/manage）拒绝——对齐 09 篇「成员只读可见 + 写操作 [admin]」语义；
  3. 完整矩阵 `{ [resource]: { [action]: boolean } }` → 严格按权限点（缺省 false）。QA 的自定义角色（48 权限点矩阵）即此格式。
- **挂载范围（对齐 09 篇端点表）**：agents 全端点（view/create/edit/delete）；projects POST `projects.create`（8 矩阵无 projects 域 → admin/显式授权者放行、member 写拒绝）；workers GET 列表/详情 `workers.view`（09 §3.9 GET [admin]）、PATCH 保留 AdminGuard；skills GET 列表/content `skills.view`。**GET /projects 不加权限点**——09 §3.3 是 [project]（成员仅见已加入），service 层已按 userId 经 project_members 过滤，无越权语义。
- **⚠️ skills GET 双通道关键设计**：skills GET 挂 `@Public() + WorkerOrJwtGuard + PermissionGuard`。WorkerOrJwtGuard 先做两选一鉴权（X-Worker-Token 通过 → 挂 `request.workerToken`；否则走 JWT → 挂 `request.user`）。PermissionGuard 首步检测 `request.workerToken` 存在即**放行**（D1：worker token 与用户 JWT 隔离，T4b worker 注入拉取无用户上下文）——不破坏 worker 拉取；用户通道则严格校验 skills.view。实测：worker token GET /skills/:id/content → 200，受限用户同端点 → 403。
- **保持成员只读（非越权，不挂权限点）**：**models / tools / mcp-servers** 不在 8 资源矩阵（roles.constants.ts 固定 8 域，无 models/tools/mcp-servers 资源行），且 models.controller.ts 注释明示「GET（成员只读）不挂 AdminGuard——目录/凭据状态只读可见」、09 §3.8 tools GET 标记「成员只读可见」。**决策：保持成员只读，不做权限点校验**——QA 报告的 models.view 越权读是基于测试者假设的权限点，非设计语义。若未来要在矩阵中纳入这些资源，需先扩展 roles.constants.ts PERMISSION_RESOURCES。
- **模块注册**：PermissionGuard 依赖 PrismaService + Reflector（均为全局提供），挂载方模块须在 providers 注册（agents/projects/workers/skills.module.ts 均加）。
- **测试**：permission.guard.spec.ts 12 例（防御空标记/401/禁用/all:true/矩阵 true/矩阵 false 403/缺省资源 403/member 简写 view 放行 + 写拒绝/**workerToken 放行且不查用户**）+ skills.controller.spec overrideGuard(PermissionGuard)；**server 44 suites / 701 tests 全绿**（基线 689 + 新增）+ tsc 通过。
- **运行时实证（compose 13000/13001 部署，curl 受限用户）**：GET /workers 403、GET /skills 403、GET /users 403、GET /agents 200（有 agents.view）、GET /projects 200（成员过滤）、GET /models 200（成员只读）；POST /agents 403 `FORBIDDEN_PERMISSION agents.create`、POST /projects 403；admin 全通（POST agents 201）；worker token GET /skills 200。测试用户已禁用、验证 agent 已删除，受限角色保留（被引用 409，与 QA 报告遗留一致）。
- **⚠️ spec 陷阱**：permission.guard.spec.ts 的 `import { PrismaService } from '../prisma/...'` 少一级 `../`（spec 在 src/common/guards/，应为 `../../prisma/...`）会 TS2307 编译失败；给 controller 挂 PermissionGuard 后，该 controller 的 spec 必须 `overrideGuard(PermissionGuard)` 否则 compile 时 Nest 实例化守卫解析不到 PrismaService 报错。

## ISSUE-005: 前端无权限感知修复（导航过滤 + 路由守卫 + 顶栏真实角色）（2026-08-09，实现 + tsc + jest + build + 浏览器实证完成）

- **根因（QA 报告）**：受限用户（仅 tasks.view/chats.view/agents.view）登录后仍显示全部 8 项导航；直接访问 /users /roles /workers 等 URL 可进入页面（后端 403 兜底已生效但页面骨架暴露）；顶栏角色硬编码「项目管理员」（NavTopBar 默认值，AppShell 未传 userRole）。
- **数据源决策**：探索确认**登录响应 AuthUserView 原不含 permissions**（auth.service.ts toUserView 只透传 id/username/displayName/email/roleId/roleName/enabled）→ **方案：后端 toUserView 增加 permissions 字段**（`(user.role.permissions ?? {})` 兜底空对象），login/profile 的 `include: { role: true }` 本就含 permissions Json（Prisma role: true 全字段），仅接口+转换函数两处改动。前端一次登录拿到权限，无需额外 GET /roles/:id 请求。
- **前端权限判定工具（新建 web/lib/permissions.ts）**：`hasPermission(perms, resource, action='view')` + `isPlatformAdmin(perms)`，**三格式兼容对齐后端守卫语义**：`{all:true}` 全放行 / `{all:false}` 仅 view 放行（member 只读）/ 完整矩阵 `{[resource]:{[action]:bool}}` 精确匹配。isPlatformAdmin = all:true 或 `users.manage===true`（对齐 AdminGuard）。
- **导航过滤映射（app-shell.tsx NAV_VISIBLE）**：对齐**后端实际守卫语义**（ISSUE-006 实证），不是简单按 8 资源矩阵全映射：
  - 无权限点恒显示：project（GET /projects 成员过滤无权限点）、models（成员只读，models.controller 明示不挂 AdminGuard）、messages（chat.controller 无权限点仅 JWT）；
  - agents/workers/skills → 矩阵 view 权限点（PermissionGuard）；
  - users/roles → AdminGuard 语义（isPlatformAdmin）。
  - **实测受限用户（tasks/chats/agents view）导航显示 4 项：project/agents/models/messages**；member（all:false）显示 6 项（+workers/skills，view 类只读放行）。
- **路由守卫（app-shell.tsx ROUTE_GUARD）**：路由首段 → 判定（与导航同源，tools 段归 skills 资源）；无权限 → `router.replace(首个有权限导航的 KEY_TO_PATH)`（project 无权限点恒可进 → 落点 /projects）。AppShell 统一守卫（任务指定方案），复用既有 hydrated/token 登录守卫模式，effect 依赖 [hydrated, token, pathname, user, router]。
- **Cmd+K 命令面板同步过滤**：DEFAULT_CMDK_ITEMS「导航」组与导航可见性同源过滤（label→CMDK_NAV_PATH→路由段→ROUTE_GUARD），被禁路由不可从命令面板唤起；「操作」组保留。cmdk-panel.tsx 的 DEFAULT_CMDK_ITEMS 由 const 改 export，layout/index.ts 同步导出。
- **NavDock 非侵入扩展**：加 `items?: NavItem[]` 可选 prop（默认 NAV_ITEMS），收起态图标列 + 展开态列表两处 map 共用 navItems——组件保持通用无权限逻辑，过滤在 AppShell（有 authStore 上下文）。
- **顶栏角色（OBS-008）**：AppShell 传 `userRole={user ? roleLabel(user.roleName) : undefined}`，ROLE_LABEL admin→管理员/member→成员（对齐 users 页），自定义角色显示原名；NavTopBar 默认「项目管理员」仅未登录兜底。
- **旧持久化数据兼容**：authStore User.permissions 可选字段，旧 localStorage user 无 permissions → hasPermission 全 false → 导航全隐藏（保守安全）+ 受限路由全重定向。**副作用**：旧会话刷新后导航变少，重新登录即恢复（新登录响应带 permissions）——浏览器实证中实测到该行为（playwright 旧 storageState 登录后仅 3 项，重新表单登录后 8 项）。
- **验证**：server 44 suites / 702 tests 全绿（auth.service.spec +1 例 permissions 透传）；web tsc 0 错误 + build 通过；浏览器实证（本地 nest 3000 + dev 3001 代理，API_PROXY_TARGET 默认 localhost:3000）：
  - admin：8 项导航全显 + 顶栏「管理员」；
  - 受限用户 restricted-qa（新建角色「受限观察员」矩阵格式，tasks/chats/agents view）：导航 4 项（project/agents/models/messages）+ 顶栏「受限观察员」；
  - /users /workers 直达 → 重定向 /projects（重定向前页面瞬时数据请求被后端 403，双层防护）；/models 直达放行（成员只读）。
- **⚠️ 环境坑**：localhost:3000 被 root 的旧 node 进程（PID 见当时 lsof，命令行含 dist/main 或 nest 旧实例）占用——`pkill -f nest` 杀不到（命令行不匹配），需 `sudo lsof -i :3000` 定位后 `sudo kill`；新 nest 用 `nohup npm run start`（nest start 先编译 dist 再启动，dist 即新代码）。dev 3001 在 prod build 后必现 ENOENT _buildManifest.js.tmp（C11 已知），`rm -rf .next` 重启即可。受限用户/角色创建走 API（POST /roles 矩阵 + POST /users），留在本地 dev DB。

## F1: 修复「登录页立即注册死链」（ISSUE-011，2026-08-09，实现 + 浏览器实证完成）

- **根因**：`web/app/login/page.tsx` register-link 是**纯 span**（无 onClick、无 Link）——死链；`/register`、`/signup` 路由均不存在（无注册页文件）。后端 `POST /auth/register` 全链路可用（QA 报告已证：注册→登录→refresh 全通过）。
- **关键决策——注册返回结构决定跳转策略**：`AuthService.register()` 仅返回 `{id, username, displayName}`（**不含 token**，见 auth.service.ts:96-100）；`login()` 才返回 accessToken/refreshToken/user。因此注册成功后**不能直接登录**，走「跳 `/login?registered=1` → 登录页读 query 显示『注册成功，请登录』」协议。
- **RegisterDto 字段（对齐注册页表单）**：username 必填 max64、password 必填 **min6** max128、displayName **必填** max128、email 可选 @IsEmail max255——前端注册页 4 字段全对齐，前端校验含「密码至少 6 位」+ 简单邮箱正则（`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`，对齐后端 IsEmail 即时反馈）。
- **共享组件提取（设计系统复用而非复制）**：从 login/page.tsx 提取 `web/src/components/auth/BrandPanel.tsx`——导出 BrandPanel / useIsMobile / pageBg / authCardStyle / authInputStyle / authSubmitStyle / authLabelStyle 七个共享件，登录/注册两页共用，**文案与样式零改动**（纯迁移，回归风险可控）。
- **跨页面 query 协议注意（SSR 安全）**：注册成功提示不能放 useState 初始值读 `window.location.search`（SSR 时 window 未定义会崩）——必须 useEffect 内读取；且读完用 `history.replaceState` 清掉 `registered` 参数避免刷新重复提示。
- **验证**：web `npx tsc --noEmit` 0 错误 + `npm run build` 通过（/register 1.79 kB 静态生成）；playwright 浏览器实证 **9/9 PASS**（register-link 跳转→注册页 6 testid→空表单校验→短密码校验→完整注册→跳 /login?registered=1→成功提示→新账号登录→/projects→去登录链接→已登录访问 /register 重定向 /projects），0 console error；e2e login.spec **7/7 全绿**（含新增 3 例：死链修复跳转 + 两例前端校验，均不提交表单避免污染 seed）。
- **⚠️ 环境坑（沿用 C11/D6）**：build 前 kill 3001 dev + `rm -rf .next`；build 命令 5 分钟超时被杀但产物已完整（重跑增量秒过）；chromium 可执行路径是 `~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`（**linux64** 后缀，不是 linux）。
- **测试数据清理**：curl 探测创建的用户（`__probe_probe__`）无 DELETE API，用 server 目录 `node -e` + PrismaClient `deleteMany({where:{username}})` 直删；浏览器注册的 `qa_issue011_*` 用户保留（真实注册验证产物，member 角色无害）。

## F2: OBS-010 任务状态流转前端操作 UI（2026-08-09，实现 + tsc + build + 浏览器全链路实证完成）

- **背景**：QA 报告 OBS-010（中）——看板卡片仅 pending 有「开始任务」，in_progress/pending_review/completed 无「提交验收/验收通过/驳回/归档」按钮；任务详情页 TaskPanel 纯静态无状态操作。后端五态端点完整（tasks.controller.ts:103-154：start / mark-pending-review / accept / reject（RejectTaskDto.reason 可选 max512）/ archive），前端零调用。
- **共享组件（新建 web/src/components/tasks/task-status-actions.tsx）**：`TaskStatusActions({taskId, status})` 按五态渲染操作组（pending→start / in_progress→mark-pending-review / pending_review→accept+reject / completed→archive / archived 终态返回 null），board 卡片与详情页 TaskPanel 复用。组件内自持单 useMutation（mutationFn 按 action 拼 `/tasks/:id/:action`，reject 带 `{reason}`），onError 记错误、**onSettled 双失效 `["tasks"]` + `["task", id]` 缓存**（SSE task.status.changed 亦失效，双保险）。data-testid 对齐既有约定：start-task-button / start-task-hint / task-submit-review / task-accept / task-reject / task-archive / reject-modal / reject-reason-input / reject-confirm / reject-cancel。
- **⚠️ 关键坑：按钮冒泡**——board 卡片 section 带 `onClick → router.push(/tasks/[id])`，共享组件按钮必须 `e.stopPropagation()`（board 原 start 按钮有，迁移时易漏），否则点击操作直接跳详情页中断流程。
- **reject 原因弹窗**：复用项目 Modal 模式（absolute inset:0 相对宿主 + 遮罩点击关闭 + Esc 关闭，铁律 T15 无 fixed）——**宿主必须 position:relative**（board section 与 detail aside 均补上）；每次打开重置 reason；textarea maxLength 512 对齐 RejectTaskDto；确认提交后关闭弹窗，reason 空串转 undefined（不发空 body）。
- **board 页瘦身**：原 startState/startMutation/handleStart（乐观更新 + 回滚）整体迁入共享组件，页面删除约 60 行；「开始前检查」hint（start-task-hint + 失败红字）保留在组件内（仅 pending 且 pending/error 时展示）。共享组件不做乐观更新（依赖 invalidate + SSE 刷新，本地延迟可忽略），换取两页通用性。
- **验证**：web tsc 0 错误 + build 通过；playwright 浏览器实证 2/2 PASS（channel:"chrome" 用系统 Chrome，缓存只有 chromium-1208 而 playwright 期望 1234）：
  - 看板卡片全生命周期：start → 提交验收 → 驳回（reject-modal 填原因→确认）→ 状态回 in_progress → 提交验收 → 验收通过 → 归档 → 卡片 data-status=已归档 且无操作按钮；
  - 详情页 TaskPanel 同款按钮 + reject 弹窗（absolute 相对 aside 宿主）全链路通过；
  - reject 带 reason 请求被后端接受（DTO 校验失败会 400 显示 task-action-error），task_events 无读取端点故 reason 落库仅由状态回退间接证明。
- **⚠️ 环境坑（沿用 C11/D6/F1）**：next.config API_PROXY_TARGET 默认 localhost:3000（后端占 3000），QA 后端在 13001——验证 dev server 需 `env API_PROXY_TARGET=http://localhost:13001 npm run dev -- -p 3002`；playwright.config testMatch 白名单（pages/perf/guard...）不匹配任意新 spec 文件名 → 需临时独立 config（testDir ./e2e + testMatch 指定文件）跑验证脚本，跑完删除。种子任务 p_seed_1 仅 in_progress×1 + archived×1，全生命周期验证需先 POST /projects/p_seed_1/tasks 创建 pending 任务（agentIds 必填非空）。

## F3: ISSUE-004 创建/重置用户密码长度校验（2026-08-09，前端 UX 补齐，实现 + tsc 验证完成）

- **背景**：QA 报告 ISSUE-004（中）——/users 新增用户弹窗（user-form）输入 3 位密码时「创建用户」按钮已可点击（无前端长度校验），后端 `CreateUserDto @MinLength(6)` 已兜底（400 拦截），纯补前端 UX。
- **根因定位**：`web/app/(main)/users/page.tsx` 新增用户弹窗 handleSubmit 仅 `if (!username.trim() || !password || !roleId) return;`（仅非空），按钮 `disabled` 表达式同样仅非空；占位符已写「至少 6 位」但无校验。**重置密码弹窗**（reset-password-input）同样缺失。
- **修复模式（对齐 F1 register 页先例，不引入新模式）**：register 页是「提交时 `if (password.length < 6) { setError("密码至少 6 位"); }` + 内联错误提示」，按钮 `disabled={submitting}` 不做长度拦截（保持可点击以触发错误提示）——users 页两个弹窗完全同构实现：
  - **error 是 prop（来自父组件 mutation API 错误）**，本地校验错误不能复用 prop——各弹窗新增本地 `formError` state（自解释命名，不加注释），handleSubmit 中 `password.length < 6` 时 `setFormError("密码至少 6 位")` 并 return（不发起 onSubmit）；错误展示区 `{formError || error ? ... : null}`（本地校验优先，其次 API 错误）；每次打开弹窗重置时 `setFormError(null)`。
  - 新增用户弹窗（user-form-submit）与重置密码弹窗（user-reset-submit）两处都补齐，data-testid 分别 user-form-error / user-reset-form-error。
- **验证**：web `npx tsc --noEmit` 0 错误（PATH nvm v22.22.1）。未跑浏览器实证（任务范围：tsc + 代码校验，浏览器实测由后续 QA 阶段覆盖）。

## F4: ISSUE-004 缺陷修复——formError 随输入清除（2026-08-09，浏览器实测 2/2 PASS）

- **背景**：F3 实现后浏览器实测发现残留缺陷——3 位密码提交 → `user-form-error` 显示「密码至少 6 位」（✅），但改为 6 位密码后错误**仍显示**（toBeHidden 断言 20× visible）。根因：`formError` 只在打开弹窗时 `setFormError(null)`，受控表单输入变化（onChange）不清除 → 旧错误残留。
- **修复（两弹窗 UserFormModal / ResetPasswordModal 同构，单文件 web/app/(main)/users/page.tsx）**：
  - **onChange 清除（主方案）**：密码输入 `onChange={(e) => { setPassword(e.target.value); setFormError(null); }}`——输入即消错，UX 最直觉；
  - **handleSubmit 校验通过后清除（补防御，对齐 register 页 :81 `setError(null)` 先例）**：长度校验通过、调用 onSubmit 前 `setFormError(null)`——覆盖提交成功路径，即使未触发 onChange（如回车提交）也不残留；
  - 展示逻辑 `{formError || error ? ... : null}`、data-testid（user-form-error / user-reset-form-error）、disabled 表达式均不变。
- **验证**：web `npx tsc --noEmit` 0 错误（nvm v22.22.1）；playwright 浏览器实测 `npx playwright test -c issue004.config.ts`（dev `env API_PROXY_TARGET=http://localhost:13001 npm run dev -- -p 3002`，channel chrome）2/2 PASS：短密码拦截 OK + 改 6 位错误消失 OK。验证脚本 web/e2e/issue004-verify.spec.ts + issue004.config.ts 已留档复用。

## MOCK-02: 角色页「指定项目」选择器显示 3 个假项目（2026-08-09，实现 + tsc 验证完成）

- **背景**：QA 报告 MOCK-02（高）——`web/app/(main)/roles/page.tsx` 硬编码 `projectPool = ["智能报表模块", "数据采集平台", "告警中心"]`（原型假名，DB 无对应项目），权限范围「指定项目」多选渲染这 3 个假项目，用户可为角色勾选不存在的项目。
- **修复（单文件，只动选择器数据源）**：
  1. **删除 projectPool 常量**，新增 `ProjectsResponse` 类型（`{items: [{id, name}], total, page, pageSize}`，对齐 board/page.tsx 同款类型）；
  2. **新增 projects useQuery**：`queryKey: ["projects"]` + `GET /projects`（`enabled: !!user?.id`），`projectOptions = items ?? []`——**同 key 同 queryFn 与看板/产出物页缓存共享**（C10 教训的反面：共享而非污染）；`innerRolePool` 保留（项目内角色岗位，非项目实体，不属 MOCK-02）；
  3. **PermissionScope 组件收 `projects: {id, name}[]` prop**：渲染 `p.name`，选择值存 `p.id`（真实项目 id，对齐任务规格）；`data-project={p.id}` + 新增 `data-project-name={p.name}` 便于断言；**空态提示**「暂无可用项目（当前账号未加入任何项目）」。
- **⚠️ 存量回显兼容**：旧数据 scopes.projects 可能存了项目**名**（原型期假名或真实名）而非 id——active 判定与移除过滤均双匹配 `p.id || p.name`：假名（智能报表模块等）不匹配任何真实项目 → 自然不选中；真实名（AI 智能体平台）→ 仍能回显；toggle 移除时同时 filter 掉 id 与 name 两种形式，存量值可正常清除。seed 角色（admin `{global:true}` / member `{global:false}`）scopes.projects 为空，无存量风险。
- **后端零改动**：`RolesService.update/create` 对 scopes 原样存取 JSON（无 projects 校验/映射），前端改存 id 无需服务端配合。
- **e2e 零改动**：testids.ts 仅注册 `scope-project-select`（容器 testid），无假项目名/`data-project` 具体值断言。
- **验证**：web `npx tsc --noEmit` 0 错误（nvm v22.22.1）。未跑浏览器实证（后续 QA 阶段覆盖，同 F3 模式）。

## MOCK-03: Worker 安装向导默认假版本修复（2026-08-09，实现 + tsc + bash -n 验证完成）

- **背景**：QA 报告 MOCK-03（高）——`workers/install/page.tsx` `opencodeVersion` 默认 `"v2.0.0-beta.1"`（原型遗留假版本，worker 侧**无 V2Runtime 实现**，v2 仅 07 篇调研计划），默认 curl 命令 `--opencode v2.0.0` 直接复制会安装不存在的版本；workerId 默认 "worker-05" 亦为示例值。
- **版本真值确认**：真实版本 = **v1.18.15**（`worker/package.json` `@opencode-ai/sdk: 1.18.15`，QA 报告确认实际运行版本；install-worker.sh 的 `--opencode` 参数**仅提示校验**不装版本，脚本 clone 仓库源码走 `npm install`）。动态获取评估：install 页纯静态无 API 调用，后端 GET /workers 仅返回**已注册** worker 的 opencodeVersion——新装场景列表可能为空且版本参差，引入 API 依赖（含 token 401 风险，D6 坑）收益低 → 决策：**固定真实稳定版本号 + UI 标注**。
- **修复（单文件 install/page.tsx + install-worker.sh 示例注释同步）**：
  - `opencodeVersion` 默认 `v1.18.15`；下拉选项移除假版本 v2.0.0-beta.1（V2Runtime），保留 `v1.18.15（V1Runtime · 当前稳定）` 默认 + `v1.18.14（V1Runtime）` 备选；hint 由「v2 迁移只动 Worker 侧（11.5）」改为「与 worker 实际运行版本一致」。
  - **workerId 初始随机化**：抽公共 `randomWorkerId()`（worker-XX 10-99）供初始值 + 「重新生成」按钮共用；初始值 useState("") + 挂载 effect 填充（**对齐 D6 pageOrigin 模式避免 hydration mismatch**——useState 初始化随机值会导致 SSR/CSR 首帧不一致；首帧空串毫秒级被覆盖可忽略）。
  - `web/public/install-worker.sh` 头部用法示例 `--opencode v2.0.0-beta.1` → `v1.18.15`（文档与实现一致性）。
- **验证**：web `npx tsc --noEmit` 0 错误（nvm v22.22.1）；`bash -n web/public/install-worker.sh` 通过。未跑浏览器实证（tsc + 语法校验已覆盖，浏览器实测由后续 QA 阶段覆盖）。

## MOCK-01: 新建任务页预置 3 个假背景文档污染任务数据（2026-08-09，实现 + tsc + 浏览器实证完成）

- **背景**：QA 报告 MOCK-01（严重）——`web/app/(main)/tasks/new/page.tsx` 硬编码 `mockDocs`（需求说明书.pdf / 历史工单数据.csv / 接口文档.docx），页面打开即显示 3 个从未上传的假文档，且 `handleCreate` 提交 `backgroundDocs: mockDocs.map(d => d.name)` → 假文档写入后端（线上任务 t_0000000003/0004 的 background_docs 已存有这 3 个假文档）。
- **上传能力核查**：上传按钮 `doc-upload-btn` 注释明确「Phase 1 不实现真实选择」——**纯静态展示，无 input[type=file]、无 onChange、无 state**。按任务约束不新增上传功能（属新功能超出 MOCK-01 范围），仅去假数据。
- **修复（单文件 page.tsx）**：
  1. **删除 mockDocs 常量**（docTypeColors 保留——列表渲染 `doc.color` 仍引用，非死代码）；
  2. **新增受控 state** `backgroundDocs: BackgroundDoc[]`（`{name,size,ext,color}`），初始 `[]`——列表由真实上传 state 驱动，无文件时不渲染 `doc-file` 条目；
  3. **handleCreate 提交 `backgroundDocs: backgroundDocs.map(d => d.name)`**——无上传时恒为 `[]`，不再引用任何假常量；
  4. ✕ 移除按钮从「纯示意」绑定真实 `onRemoveDoc(name)`（state 过滤，列表管理语义闭环，不算新增上传功能）；
  5. 同步文件头/区块注释（mock 3 文件 → 真实列表初始空）。
- **验证**：web `npx tsc --noEmit` 0 错误（nvm v22.22.1）；playwright 浏览器实证（dev `env API_PROXY_TARGET=http://localhost:13001 node_modules/.bin/next dev --turbopack -p 3002`，storageState 复用 `.auth/user.json` seed-admin，channel chrome）2 项 PASS：`doc-file` 元素计数 = 0（无预置）+ 拦截 POST `/api/v1/projects/*/tasks` 断言 `backgroundDocs=[]`。
- **经验**：mock 数据污染真实提交链路的通用检查点——凡是提交 payload 里有「用户从未操作过就存在」的值，先查它是否来自硬编码常量而非 state；纯 mock 展示（无交互能力）与 mock 数据污染（提交）是两件事，前者可保留占位，后者必须拆掉。

## MOCK-06: 群聊 @ 候选混入非团队假 Agent（2026-08-09，实现 + tsc 验证完成）

- **背景**：QA 报告 MOCK-06（中）——`web/src/components/ui/message-input.tsx` `DEFAULT_MENTIONABLE` 硬编码 4 个模板 Agent（a_product/a_architect/a_developer/a_tester），未显式传 mentionable 的调用方 @ 面板会展示非团队成员的假 Agent（线上任务团队为「产品经理副本+开发者」时仍显示模板「产品经理」「测试」）。
- **调用方全量核查**（`MessageInput` 全库仅 2 个真实调用方，均显式传参）：
  1. `tasks/[id]/page.tsx:1153-1157`——`mentionable={mentionable}`（真实 `agentMembers`，来自 GET /channels/:id）✅ 已修（历史提交）；
  2. `messages/[id]/page.tsx:740-744`——`mentionable={[]}`（私聊语义：无需手动 @，发送时自动附带主 Agent mention）✅；
  3. `docs/agent-platform/prototypes/_shared/components.tsx` 的 MessageInput 是**独立原型展示组件**（不 import web 真实组件，默认 4 角色 chips 仅静态展示），非运行代码，不在线上。
- **兜底策略决策**：两个调用方都传真实数据 → `DEFAULT_MENTIONABLE` 兜底实际从不命中，但保留假 Agent 模板是隐患（未来新调用方忘传即回归）。**删除 DEFAULT_MENTIONABLE 常量，默认参数改为 `mentionable = []`**——兜底为空数组（@ 无候选）比假 Agent 更安全：宁可不提示，不展示错误成员。
- **修复**（单文件 message-input.tsx）：删除 :62-68 常量 + :74 默认值改 `[]`（附注释说明空兜底策略，防回归）。
- **验证**：web `npx tsc --noEmit` 0 错误（nvm v22.22.1）。未跑浏览器实证（tsc 覆盖；线上 @ 面板行为由后续 QA 阶段覆盖，同 MOCK-03 模式）。
- **经验**：默认参数里的「示例数据」是最隐蔽的 mock 污染源——组件级兜底常量（假用户/假成员/假列表）只要存在，任何新调用方忘传参就会把假数据带进真实链路。规则：**兜底值必须是空/保守值，真实数据一律由调用方显式传入**。

## MOCK-07: Agent 工具配置区硬编码假工具行 jenkins-*（2026-08-09，实现 + tsc 验证完成）

- **背景**：QA 报告 MOCK-07（低）——`web/app/(main)/agents/page.tsx` 工具配置区存在 `tool-wildcard-row`（:751-786）硬编码「jenkins-* → ask」静态示意行（注释「静态示意，对齐原型」），所有 Agent 详情工具权限列表都显示该行，用户误以为存在 jenkins-* 工具。
- **真实数据源核查**：工具权限列表 `ToolPermissionList` 本就有真实驱动——`rows = catalog（GET /tools?enabled=true，真实 source 徽章）+ toolDrafts（agent.toolEffects，PATCH 提交）`，空态（tool-empty「暂无工具权限配置」）与「+ 添加工具」（tool-action-input → commitAdd）逻辑完整。wildcard 行是唯一与数据无关的纯假行 → **整块删除**（含 `data-testid="tool-wildcard-row"` 与容器注释）。
- **修复**（单文件 page.tsx，4 处）：
  1. 删除整个 tool-wildcard-row 块（jenkins-* → ask 静态示意）；
  2. 「工具名即权限 action（如 jenkins-build），支持通配符批量授权（如 jenkins-*）」说明文案 → 泛化「工具名即权限 action，支持通配符批量授权」（去具体假工具示例）；
  3. 添加工具输入框 placeholder「（如 github_create_issue / jenkins-build）」→「（如 my_custom_tool）」；
  4. 文件头注释 + inferToolSource 兜底注释中的 jenkins-build 示例 → my-custom-tool（同步清理全文件残留）。
- **验证**：`grep jenkins|tool-wildcard-row` 0 残留（jenkins 全文件清零）；web `npx tsc --noEmit` 0 错误（nvm v22.22.1）。
- **经验**：原型保真迁移中「对齐原型」的静态示意行是低危但顽固的 mock 污染——它不污染提交链路（不进 payload），但污染展示链路（用户看到不存在的工具/功能）。规则：**凡是列表/矩阵类展示区，示意行必须由真实目录（GET /tools）或真实配置（toolEffects）驱动；帮助文案、placeholder、注释里的具体工具名示例一律泛化（my_custom_tool / my-custom-tool）**，避免任何「看起来像是系统已存在工具」的字样。

## MOCK-05: 用户「所属项目数」硬编码 0 修复（2026-08-09，后端 + 前端 + jest + tsc + 浏览器实证完成）

- **背景**：QA 报告 MOCK-05（中）——`web/app/(main)/users/page.tsx` `:119` `EMPTY_PROJECT_COUNT = 0`（注释「后端无端点 → 0 为真实兜底值」），`:264` 列表行恒显 0。QA 线上确认 zhangwei 实际拥有 wodeixiangmu 项目仍显示「0 所属项目」——硬编码 0 在用户有项目时是**误导**而非兜底。
- **后端（users.service.ts findAll）**：`findMany` select 改为 `{ ...SAFE_USER_SELECT, _count: { select: { projectMembers: true } } }`（User 模型本就有 `projectMembers ProjectMember[]` 关联，Prisma `_count` 一条 SQL 计数）。**只动 findAll**——findOne/create/update 等单用户端点保持 SAFE_USER_SELECT 不变（`_count` 仅列表契约需要，最小侵入）。
- **前端（users/page.tsx）**：`UserItem` 加可选 `_count?: { projectMembers: number }`（可选：findOne 端点不带）；**删除 `EMPTY_PROJECT_COUNT` 常量**；行渲染 `user._count?.projectMembers ?? 0`——0 现在是真实值（确实没加入项目）而非硬编码。同步更新文件头 :24 注释（原「后端无端点 → 兜底 0」）。
- **测试**：users.service.spec 新增用例「附带所属项目数 _count.projectMembers」——断言 findMany select 含 `_count: { select: { projectMembers: true } }` + 响应透传真实计数。jest **44 suites / 707 tests 全绿**（基线 706 + 新增 1）。
- **验证**：curl 实测本地 nest watch（3000）GET /users → seed-admin `_count.projectMembers = 2`（真实数据）；playwright 浏览器实测（3004 dev + 注入 admin 登录态）用户列表 **seed-admin 行显示「2 所属项目」**（原恒 0）、seed-member「0」（真实）。web `npx tsc --noEmit` 0 错误。
- **⚠️ 多 dev 实例踩坑**：两个 `next dev --turbopack` 共享 `.next` 目录会持续互踩产物（500 `Cannot find module chunks/ssr/[turbopack]_runtime.js`）——同仓库只能跑一个 dev（并行任务 3001 与验证用 3004 必须轮换，验证后已恢复 3001）。
- **经验**：「兜底 0」模式（对齐 EMPTY_TASK_COUNT）在**字段有真实数据源但页面没用**时是 bug 而非兜底——MOCK 类检查点：先查后端关联/计数能力（Prisma `_count` 零成本），能算就透传，不能算才降级「—」；硬编码展示值必须逐项核对是否有可计算来源。

---

## F2: OBS-003 + UX-17 删除/禁用操作二次确认（2026-08-09，实现 + 浏览器实证完成）

- **问题**：QA 报告 OBS-003【低】+ UX-17——Provider 凭据删除、角色删除、用户禁用均直接执行，无二次确认（凭据删除不可恢复，误触成本高）。
- **方案（共享 ConfirmDialog 组件，三处复用）**：新建 `web/src/components/ui/confirm-dialog.tsx`（`@/src/components/ui` 出口导出，与 EmptyState 等共享组件同层）——结构对齐 reject-modal/user-form-overlay（铁律 T15：absolute 相对宿主 + 遮罩点击关闭 + Esc 关闭，无 fixed/100vh/100vw）；props：`open/testid/title/description/confirmLabel/pendingLabel/danger/submitting/onClose/onConfirm`；testid 前缀默认 `confirm-delete`（生成 `confirm-delete-modal`/`-cancel`/`-confirm`），用户禁用传 `testid="confirm-toggle"` 按上下文命名。danger 红色确认按钮（#DC2626，对齐 roles 页 delete-role-button 色系），非危险操作传 `danger={false}` 走蓝。
- **三处接线（均 target 模式，确认后 mutate + 立即关闭，失败走既有错误展示）**：
  1. `providers-tab.tsx`：`revokeTarget: string | null` state；`provider-delete-button` onClick 改 `setRevokeTarget(p.providerID)`；确认后 `revokeMutation.mutate(revokeTarget)`；删除失败仍走 D6 的 `provider-error-banner`（列表级，弹窗已关也能看见）。
  2. `roles/page.tsx`：**删除原生 `window.confirm`（QA 无法验证且非项目 Modal 模式）**；`deleteConfirmOpen` state；`handleDelete` 只开弹窗；确认后 `deleteMutation.mutate(activeRole.id)`（确认时重读 activeRole，防弹窗期间角色切换）。
  3. `users/page.tsx`：**决策：禁用/启用都加确认**（可逆但误触成本高——禁错人立即失去登录能力）；`toggleTarget: UserItem | null`；标题/文案/确认按钮随方向动态（「禁用该用户？」红 /「启用该用户？」蓝 `danger={toggleTarget?.enabled}`）；确认后 `toggleMutation.mutate({id, enabled: !enabled})`。
- **验证**：web `npx tsc --noEmit` 0 错误；playwright 浏览器实测（chromium-1208 + 3001 dev + seed-admin 表单登录）**18/18 PASS 0 console error**——三场景各 6 断言：点操作按钮 → 弹窗出现（含目标名）→ 取消关闭且**零请求** → 再点确认 → **DELETE/PATCH 请求发出** + 弹窗关闭；roles 场景额外断言**未触发原生 window.confirm**（page.once('dialog') 监听）。
- **⚠️ 实测环境安全策略**：所有写操作（DELETE 凭据/角色、PATCH /status）用 `page.route` 拦截 fulfill 200——只验证前端「确认后发出请求」逻辑，**不真删真禁**（opencode-go 凭据加密不可恢复；test 角色、T 用户均保持原状，实测后 API 复核 configured=True / enabled / 角色存在）。
- **⚠️ /models 双 Tab 坑**：直接等 `providers-root` 超时——models 页默认 catalog tab，须先点 `manage-tab`（hasText Provider）切换再等 providers-root。
- **经验**：三处同构的「标题+描述+取消/确认」弹窗 → 建共享组件优于页面内三份复制（E1「不泛化 UserFormModal」的例外判据：字段集/交互完全同构才泛化，此处成立）；二次确认弹窗的 testid 按上下文命名（delete vs toggle），QA 断言可按操作类型精确锁定。

---

## E4: 修复 UX-13 看板「全部」视图混入已归档任务（2026-08-09，实现 + 浏览器实证完成）

- **根因**：`web/app/(main)/board/page.tsx:360-362`——all 筛选 `activeFilter.status` 为 undefined → 后端 `GET /projects/:pid/tasks?status=` 返回**全部状态含 archived**；渲染 `:376` `tasks = data?.items ?? []` 未过滤 → 归档任务混进「全部」视图。
- **方案（前端过滤，查询逻辑不变）**：`:376` 改 `(data?.items ?? []).filter((t) => activeFilter.key !== "all" || t.status !== "archived")`——all 时排除 archived；其余 5 个筛选 status 有值走后端查询，前端 filter 直接放行（行为不变）；「已归档」筛选仍可查看。页头无任务计数显示（仅 `tasks.length === 0` 空态判断），计数无需同步。
- **验证**：web `npx tsc --noEmit` 0 错误；浏览器实测（playwright 库 API 直连 chrome + 3001 dev + seed-admin 表单登录）：临时 `UPDATE tasks SET status='archived'`（t_0000000001，p_seed_1 唯一任务）→ all 视图 0 卡片（空态）→ 切「已归档」1 卡片 data-status=已归档 → 切回 all 0 卡片 → **0 console error**；实证后恢复 in_progress（改库 → 验证 → 恢复现场闭环）。
- **⚠️ playwright 跑临时脚本的两条路**：① config 的 projects 全部 testMatch 白名单（auth/pages/perf/guard…），任意命名的新 spec 都跑不进 → 用 `node e2e/xxx.cjs` 直接 `require("@playwright/test").chromium.launch({channel:"chrome"})` 库 API 跑，绕过 test runner；② dev server 重启后立即跑（turbopack 无征兆退出是常态，复现第三次）。

## [2026-08-09] UX-11：项目/用户列表加搜索框（QA 报告缺失项修复）

- **需求**：项目列表/用户管理无搜索框，项目/用户多时无法检索（.gstack/qa-reports/qa-report-192-168-10-78-13001-2026-08-09.md:356）。
- **改动（2 文件，纯前端本地过滤，后端零改动）**：
  | 文件 | 改动 |
  |---|---|
  | `web/app/(main)/projects/page.tsx` | state `keyword` + 过滤 `visibleProjects`（name/description 模糊匹配，toLowerCase includes）；操作行「标题-搜索框-新建按钮」布局（搜索框 flex:1/maxWidth:320/marginLeft:auto）；渲染分支：`projects.length===0`→原「还没有项目」EmptyState，`visibleProjects.length===0`→新「无匹配项目」EmptyState（不带动作），否则网格渲染 visibleProjects |
  | `web/app/(main)/users/page.tsx` | 同构：state `keyword` + `visibleItems`（username/displayName/email 匹配）；操作行加搜索框；`items.length===0`→原「暂无用户」，`visibleItems.length===0`→「无匹配用户」，列表行渲染 visibleItems |
- **样式**：完全复用模型页 model-search 范式（⌕ 图标 + 白底圆角边框容器 + 透明背景 input，token 全走 neutral/space/radius/fontSize/shadow）。testid：`projects-search` / `users-search`。
- **口径**：统计条（total / stats）保持全量不变，仅列表受过滤影响；搜索无命中用既有 EmptyState 组件（action 可选，不带动作）。
- **验证**：`npx tsc --noEmit` 0 错误；playwright 临时 spec（playwright.verify.config.ts 继承 base 配置 + verify project）实测 3/3 PASS：登录 setup → projects 搜索「不存在的关键词」→ empty-state「无匹配项目」→ 清空恢复卡片 → users 同理。临时 spec/config 已验证后删除，不污染 e2e 套件。
- **经验**：playwright project testMatch 精确匹配文件名，临时验证 spec 需临时 config（`-c` 指向）或放进既有 spec 正则覆盖范围；testDir 下不匹配任何 project testMatch 的文件直接报 "No tests found"。

## UX-18: 项目卡片「进入项目」无明确入口提示（2026-08-09，实现 + 浏览器实证完成）

- **问题**：QA 报告 UX-18【缺失提示】——项目列表卡片整卡可点但无任何按钮/文字提示「可进入」，用户需自行发现点卡片本体跳转 /board?pid=。
- **方案（双入口，主按钮放右下角）**：`web/app/(main)/projects/page.tsx` ProjectCard 底部区域从单行改为两行：
  1. 第一行（原样保留）：任务统计（左）+ 成员头像（右），borderTop 分隔；
  2. 第二行（新增操作行）：左下「产出物」次级入口（outline 样式保留）+ 右下「进入项目」primary 按钮——`data-testid="project-enter-button"`，样式对齐「新建项目」primary（#2563EB + pill + 蓝阴影），字号 sm 略小于页头按钮（卡片内视觉层级），`stopPropagation + onOpen?.()`（与卡片 onClick 同目标，防冒泡重复跳转）。
- **hover/焦点态**：CSS 类 `.project-enter-btn`（注入 projectCardCss 同款 `<style>`）：hover → 背景 #1D4ED8 + 阴影加深（transition background-color/box-shadow，不动 layout 属性）；`:focus-visible` → 2px #2563EB outline（对齐卡片自身 focus 风格）。
- **验证**：web `npx tsc --noEmit` 0 错误；playwright 实测（chromium-1208 executablePath 显式指定 + API 登录注入 zustand persist `agent-platform-auth` localStorage）**5/5 PASS 0 console error**：按钮可见文案「进入项目 →」、点击跳转 `/board?pid=<data-project-id>`（与卡片目标一致）、Tab 键盘聚焦 + Enter 触发跳转。截图 /tmp/opencode/ux18-enter-btn-hover.png 确认右下角定位、hover 深蓝生效、与产出物按钮/头像布局不拥挤。
- **经验**：整卡可点击的卡片类组件必须有显式「进入」主按钮（可用性铁律，卡片可点只是增强）；主操作按钮放右下角 + 次级按钮左下角是低成本高辨识度的双入口布局；卡片内按钮必须 `stopPropagation`（否则卡片 onClick 与按钮 onClick 双触发，router.push 同目标虽无害但行为不纯）。

## CFG-02: compose 移除 MODEL_CREDENTIAL_KEY 公开默认密钥（2026-08-09，配置修复完成）

- **问题**：QA 报告 CFG-02【高】——`docker-compose.yml:68` `MODEL_CREDENTIAL_KEY: ${MODEL_CREDENTIAL_KEY:-05afa7cd...}` 把固定 AES-256-GCM 密钥明文写进仓库；生产若未覆盖该变量即用公开密钥加密所有 provider 凭据 → 密钥泄露 = 凭据可全量解密。
- **方案（必填校验，禁用公开默认）**：改为 `${MODEL_CREDENTIAL_KEY:?MODEL_CREDENTIAL_KEY 未设置，请生成 32 字节随机密钥（openssl rand -hex 32）}`——compose 变量必填语法，未设置即 `docker compose up/config` 报错退出，杜绝静默回落公开默认。注释同步更新（生成方式 + 拒绝公开默认原因）。
- **server 端无需改动（已内建防线）**：`server/src/common/credential-crypto.service.ts` 双重保护——① `parseKey` 校验必须 32 字节（64 hex / base64 / 32B utf8）；② NODE_ENV=production 且无 key → 构造抛错拒绝启动；非生产缺 key → 用显式标记的全零 `DEV_MODEL_CREDENTIAL_KEY` + logger.warn（可追溯）。**漏洞本质是 compose 提供了公开默认 → 覆盖了 server 的"production 缺 key 抛错"防线**，故修复点在 compose 而非 server。
- **.env.example 无需改动**：`server/.env.example` 已有生成说明（`openssl rand -hex 32` / `openssl rand -base64 32` + 三种编码 + 缺失策略），本次仅补 compose 侧必填校验。
- **验证**：`docker compose config --quiet` 双路径——① 未设置变量 → `error while interpolating ... required variable MODEL_CREDENTIAL_KEY is missing a value: ...未设置...`（预期报错 ✓）；② 设置 64 hex 后 → 通过（exit 0 ✓）。

## CONF-01: 模板 Agent 默认模型改为 worker 实际可执行的 opencode/* 免费模型（2026-08-09，实现 + 验证完成）

- **问题**：QA 报告 CONF-01【严重】——4 个模板 Agent 默认模型（`zhipu/glm-5.1`/`deepseek/deepseek-v4-pro`/`opencode-go/deepseek-v4-flash`/`zhipu/glm-5.2`）与 worker `w_compose_worker` 实际能力（**仅 `opencode/*` 26 个免费模型**，实测上报 capabilities.models）**交集为空** → 模板 Agent 用默认模型创建任务 → dispatch 模型不匹配 → 无回复 / insufficient_quota（**"@ Agent 无回复"配置层根因**，OBS-009）。
- **实测确认 worker 能力清单**：compose DB（`aiagents-compose-db`）`worker_model_availabilities` 26 行全为 `provider_id='opencode'`（big-pickle / deepseek-v4-flash-free / glm-4.7-free / glm-5-free / grok-code / hy3-free / hy3-preview-free / kimi-k2.5-free / laguna-s-2.1-free / ling-2.6-flash-free / ling-3.0-flash-free / ling-3.0-tiny-free / longcat-2.0-free / mimo-v2-flash-free / mimo-v2-omni-free / mimo-v2-pro-free / mimo-v2.5-free / minimax-m2.1-free / minimax-m2.5-free / minimax-m3-free / nemotron-3-super-free / nemotron-3-ultra-free / north-mini-code-free / qwen3.6-plus-free / ring-2.6-1t-free / trinity-large-preview-free）；compose worker 容器内 `opencode models` 实测 8 个为其子集。**方案：STATIC_AVAILABLE_MODELS 追加全部 26 个 worker 实测 opencode/* 免费模型**（34 模型目录 = 8 核心 + 26 worker 能力，目录与 worker 能力全对齐），模板默认模型从中选 4 个（语义侧重保持：产品=通用对话 `opencode/glm-5-free`、架构=推理 `opencode/nemotron-3-ultra-free`、开发=代码 `opencode/deepseek-v4-flash-free`、测试=推理 `opencode/qwen3.6-plus-free`）。
- **改动文件**：`server/src/common/constants/agent.constants.ts`（STATIC_AVAILABLE_MODELS +26、TEMPLATE_DEFAULT_MODELS 4 值全改）、`agent.constants.spec.ts`（行数断言 8→34、新增 CONF-01 断言：模板默认模型 ∈ worker 26 清单）、`server/prisma/seed.ts`（仅注释同步，代码零改动——模板 Agent 的 defaultModelId 与模型目录均引用 constants，**seed 重跑自动生效**，无需迁移）。
- **已存在 DB 生效方式**：模板 Agent 只读（PATCH 403），defaultModelId 只能 seed 预设 → 重跑 `node dist/prisma/seed.js`（upsert update 分支按 id 覆盖 defaultModelId）即对已入库模板生效；新增 26 模型按 (providerID, modelID) 唯一键 upsert，已存在行命中 update 幂等不冲突。
- **验证**：server `npx tsc --noEmit` 0 错误；`agent.constants.spec.ts` 6/6 PASS（含新 CONF-01 断言）。
- **经验**：模型目录（seed）与 worker 实测能力必须**同一数据源对齐**——两套体系（8 核心凭据模型 vs 26 免费模型）并存且交集为空是配置层隐患的典型形态；修复以「目录=worker 能力全集」为锚，而非只改模板默认值（否则其他消费方仍可能引用空交集模型）。
- **经验**：compose 变量必填用 `${VAR:?msg}`（非 `:-` 默认），报错信息可中文直接给运维指引；安全类默认值铁律——**宁可启动失败也不写公开默认**，生产密钥类变量一律必填校验或随机生成。

---

## CONF-02: 权限矩阵 48 个权限点仅 7 个被后端校验——前端禁配未启用点（2026-08-09，方案①落地 + tsc 验证完成）

- **问题（QA 严重）**：前端角色配置页渲染 8 资源 × 6 操作 = 48 个权限点可勾选，但后端 `@RequirePermission` 实际只使用 **7 个唯一权限点**（server grep 实证：agents.view/create/edit/delete、projects.create、skills.view、workers.view，共 15 处）。其余 41 个点（chats/artifacts/tasks 全部、users/roles 大部分、skills/workers/projects 大部分）勾选后无任何后端校验——实证给受限角色加 `workers.edit: true` 后 PATCH worker 仍 403（"需要 users:manage" AdminGuard）。**权限配置 UI 与后端校验严重脱节**。
- **决策（方案①务实，方案②本期不做）**：后端按矩阵补齐 chats/artifacts/tasks 等守卫涉及大量控制器改造 + 权限语义设计，本期不做。前端将未实现的 41 个权限点**禁配 + 标注「未启用」**，仅消除"勾选不生效"的 UI 误导（⚠️ 仅 UI 层，不改后端守卫体系，CONF-03 单独处理）。
- **实现（`web/app/(main)/roles/page.tsx`，由并行 session 落地主体、本会话调和收尾）**：
  1. `IMPLEMENTED_PERMISSIONS` 白名单常量（ReadonlySet，7 个点，带来源注释：server grep RequirePermission 实证）。`projects.create` 在矩阵 8 资源中无 projects 行，永不命中，保留仅作集中审计参考。
  2. `PermissionMatrix`：`isImplemented(rKey, aKey)` 判定白名单；集合外格子提前 return 渲染禁用灰格 `—`（`disabledCellStyle`：灰显 + 虚线占位 + cursor not-allowed + `data-implemented="false"` + title「该权限点后端未启用，勾选不生效」+ aria-label），**非 button 天然不可点击**。
  3. 整行资源无任何已启用点（tasks/chats/artifacts/users/roles）→ 资源名后追加「未启用」徽章（`rowHasImplemented` 判定）。
  4. `PermLegend` 新增「未启用」图例项（20px `—` 灰格）；CreateRoleModal 提示 + 页面底部说明文案同步补充「灰色「—」格为后端未启用的权限点，勾选不生效」。
  5. **`matrixToPermissions` / `allowCount` 语义决策（保持原值提交）**：禁用格只影响渲染层，数据层仍保留原矩阵值（`data-perm={perm}`），保存时**仍提交原值**（非强制 false）——未启用点初始为 deny（blankMatrix/matrixFromPermissions 缺省），旧数据残留 true 亦无害（后端不校验）；allowCount 维持全矩阵统计（含未启用点），未做收紧，对齐报告「保留现有矩阵结构（testid permission-matrix、allowCount 统计对齐）」。
- **验证**：web `npx tsc --noEmit` **0 错误**（EXIT 0）。未启动 dev server、未跑 playwright、未 build、未跑 jest（遵守执行范围防并行冲突）。
- **⚠️ 并行会话撞车教训（重要）**：本任务与另一并行 session **同时**在改 `roles/page.tsx`——我按任务规格插入的 `IMPLEMENTED_PERMISSIONS`/`isPermissionImplemented`/`implementedAllowCount`/`unimplBadgeStyle` 与并行 session 已落地的实现（同名常量 + `disabledCellStyle`/`isImplemented`/`rowHasImplemented`）产生**重复定义**（tsc 必挂 Duplicate identifier）+ 未使用变量。处理：**以并行实现为主体，回退我造成的全部冲突块**（重复常量、未用辅助函数），`git diff` 确认最终 diff 只含并行实现。经验：多会话并行改同一文件时，落地前先 `git diff` 核对对方改动范围与命名，同语义只保留一套实现，避免重复定义与语义分叉。

## REG-01: 克隆 Agent / 新建自定义按钮未按权限隐藏（2026-08-09，前端 + tsc 验证完成）

- **问题（QA 中）**：`web/app/(main)/agents/page.tsx` 「克隆此 Agent」（clone-template-button）与「+ 新建自定义 Agent」（create-agent-button）对无 `agents.create` 权限的受限用户仍可见——后端 `POST /agents/:id/clone` 已挂 PermissionGuard（agents.create）会 403 拦截（数据安全闭环 OK），但前端入口未隐藏，受限用户点击后仅 console 403 无错误提示。
- **修复（单文件 page.tsx，4 处）**：
  1. `ConfigPanelProps` 新增 `canCreate: boolean`（带 JSDoc 对齐文件内 prop 文档约定）；
  2. ConfigPanel 内克隆按钮（原 956-978 行）包 `{canCreate && <button …>}` 条件渲染——**隐藏优先**（任务要求优先隐藏而非点击报错）；
  3. 页面主组件 `const canCreateAgent = hasPermission(user?.permissions, "agents", "create")`（user 来自 authStore，ISSUE-005 登录响应已透传 permissions）；
  4. ConfigPanel 调用处传 `canCreate={canCreateAgent}` + 新建按钮（原 1983-2000 行）同样包条件渲染。
- **语义对齐**：`hasPermission` 三格式兼容（`all:true` 全放行 / `all:false` 仅 view / 矩阵精确）——admin 与 agents.create=true 角色均正常显示按钮，member（all:false）与受限矩阵（无 agents.create）自动隐藏，与后端 PermissionGuard 判定一致。
- **范围决策**：编辑/删除入口（保存按钮 save-agent-button、effect 增删）本次不动——task 明确「聚焦克隆 + 新建，编辑/删除若已有控制则保持」；模板只读保护（type=template 表单禁用）是既有行为不涉及。
- **验证**：`cd web && npx tsc --noEmit` **0 错误**（EXIT 0）。未启动 dev server、未跑 playwright/build/jest（遵守执行范围防并行冲突，浏览器实测由 QA 阶段覆盖）。

## CONF-03: workers/skills 写守卫与读守卫语义不一致（2026-08-09，后端守卫 + 前端白名单同步 + tsc/spec 验证）

- **问题（QA 中）**：同资源读写守卫语义不一致——`workers.controller.ts` PATCH /workers/:id 挂 AdminGuard（要求 `users.manage`）、`skills.controller.ts` POST /skills 与 PATCH /skills/:id/status 亦挂 AdminGuard；而读操作（GET /workers、GET /skills）挂 PermissionGuard（workers.view / skills.view）。后果：**「Worker 管理员」角色（有 workers.view 权限点）不能管理 Worker**（PATCH 403 需 users.manage），而**「用户管理员」（有 users.manage）反而能管理 Worker**——权限语义倒挂；矩阵里 workers.edit / skills.create / skills.edit 勾选无后端校验。
- **修复（仅后端守卫 + 前端白名单，未动服务层）**：
  1. `workers.controller.ts` PATCH → `PermissionGuard + @RequirePermission('workers.edit')`（移除 AdminGuard import）；
  2. `skills.controller.ts` POST → `PermissionGuard + @RequirePermission('skills.create')`、PATCH status → `PermissionGuard + @RequirePermission('skills.edit')`（移除 AdminGuard import）。
- **语义验证（PermissionGuard 逻辑，见 permission.guard.spec.ts 既有覆盖）**：
  - admin（permissions.all=true）PATCH worker/skill 仍全放行（guard 第 100-102 行）；
  - member（all:false）写操作拒绝（action≠view → 403 FORBIDDEN_PERMISSION）；
  - 受限矩阵无 workers.edit/skills.create/skills.edit → 403；勾选后真实生效（CONF-02 白名单同步解锁）；
  - workerToken 通道：PATCH 走全局 JWT（无 @Public），不涉及 WorkerOrJwtGuard/worker 通道，D1 隔离不受影响。
- **前端白名单同步**（CONF-02 的 roles/page.tsx `IMPLEMENTED_PERMISSIONS` 7→10 项）：新增 `workers.edit`、`skills.create`、`skills.edit`——三格从禁用灰格变为可勾选，注释同步更新（workers：view/edit；skills：view/create/edit）。
- **范围决策**：`skills.module.ts` 中 AdminGuard provider 保留未移除（models/mcp-servers/tools/users/roles 模块仍使用，skills 内成为无害 dead provider，最小 diff 防并行冲突）；其他资源的 AdminGuard（models/mcp/tools）不在本任务范围（CONF-03 仅覆盖 workers/skills 两控制器）。
- **验证**：`cd server && npx tsc --noEmit` **0 错误**（EXIT 0）；`npx jest` workers.controller.spec + skills.controller.spec + permission.guard.spec + admin.guard.spec **4 suites / 32 tests PASS**；`cd web && npx tsc --noEmit` **0 错误**（EXIT 0）。未启动 dev server、未跑全量 jest/build/playwright（遵守执行范围防并行冲突）。

## CONF-03 后端落地确认（2026-08-09，本 session 补充）

- 与并行 session 的前端白名单同步（roles/page.tsx IMPLEMENTED_PERMISSIONS 7→10，含 workers.edit/skills.create/skills.edit）衔接一致：后端守卫改造完成，前端三格已从禁用灰格变为可勾选。
- 后端验证（本 session）：`cd server && npx tsc --noEmit` **0 错误**；`npx jest` workers.controller.spec + skills.controller.spec + permission.guard.spec **3 suites / 26 tests PASS**。skills.controller.spec 已移除 AdminGuard override/import（controller 不再挂载），workers.controller.spec 注释/测试名同步更新为 workers.edit。
- 未跑全量 jest / 未 build / 未启动 dev server（遵守执行范围防并行冲突）；admin.guard.spec 未改动（AdminGuard 本体零变更，其他资源模块仍使用）。

## UX-16 修复完成：配置区提示文案去内部代号

**问题**：`web/app/(main)/agents/page.tsx` 配置区提示文案含 FR-33/FR-34/FR-35/FR-36/FR-47/FR-32 及 C3/C4/C5 等内部代号，普通用户无法理解（qa-report-open-issues-2026-08-09.md:87）。

**修改**（9 处用户可见文本，代号 → 区域功能名，保留 `· 说明` 格式）：
| 位置 | 原文 | 改后 |
|---|---|---|
| :1045 | FR-33 · 即时生效于后续会话 | 提示词 · 即时生效于后续会话 |
| :1089 | FR-47 · 新会话默认使用 | 默认模型 · 新会话默认使用 |
| :1235 | 凭据已配置 · 按 provider 粒度生效（C4） | 凭据已配置 · 按服务商粒度生效 |
| :1236 | 保存后即时下发到 worker（C5） | 保存后即时下发到 Worker |
| :1320 | 模型列表来自平台模型目录（worker 上报合并入库，C3） | 模型列表来自平台模型目录（Worker 上报合并入库） |
| :1337 | FR-34 · 已启用 x/y | 技能 · 已启用 x/y |
| :1446 | FR-35 · 停用后 Agent 无法调用 | 工具 · 停用后 Agent 无法调用 |
| :1484 | FR-36 · 超出范围的操作转交用户确认 | 权限 · 超出范围的操作转交用户确认 |
| :1628 | 完全自定义（FR-32），创建后… | 完全自定义，创建后… |

**保留**：6 处代码/JSX 注释中的代号（:62/:118/:1032/:1073/:1240/:1471/:1792/:1803/:1832）——开发可读，非用户可见。

**验证**：`cd web && npx tsc --noEmit` → 0 错误。未启 dev server / 未跑浏览器（部署由 orchestrator 统一完成）。

Tags: UX-16, i18n, ux-wording, agents-page

## UX-05 修复：两个「保存」按钮区域标题与文案区分

**问题**：`web/app/(main)/agents/page.tsx` 页头整体「保存」按钮与模型凭据「保存」按钮文案相同，且模型配置区标题「默认模型」未覆盖凭据/Worker 范围，用户无法区分保存作用域（qa-report-open-issues-2026-08-09.md:81）。

**修改**（3 处，保持功能不变）：
| 位置 | 原文 | 改后 |
|---|---|---|
| :1085-1089 | 标题「默认模型」/ 说明「默认模型 · 新会话默认使用」 | 标题「模型与工具配置」/ 说明「默认模型 · 凭据 · 首选 Worker」 |
| :1005 | 页头保存按钮「保存」 | 「保存配置」（PATCH /agents/:id，提示词+模型整体保存） |
| :1229 | token 凭据按钮「保存」 | 「保存凭据」（POST /models/:mdId/credentials） |

**说明**：提示词区标题「提示词配置」已存在（:1042），未改动。区域标题（提示词配置 / 模型与工具配置）+ 按钮文案（保存配置 / 保存凭据）双重区分，消除作用域歧义。

**验证**：`cd web && npx tsc --noEmit` → 0 错误。未启 dev server / 未跑浏览器（部署由 orchestrator 统一完成）。

Tags: UX-05, ux-wording, agents-page

## UX-14: Agent 无删除入口（前端补齐 DELETE 入口 + 二次确认 + 权限隐藏，2026-08-09）

- **问题（QA 中，qa-report-open-issues-2026-08-09.md:85）**：后端 `DELETE /agents/:id`（agents.controller.ts:96-102，PermissionGuard + agents.delete）已存在，但 `web/app/(main)/agents/page.tsx` 未暴露删除入口——Agent 无法从前端删除。
- **修复（单文件 page.tsx，前端仅）**：
  1. `ConfigPanelProps` 新增 `canDelete: boolean`（type≠template 且具备 agents.delete）/ `onDelete: () => void` / `deleting: boolean`（ConfirmDialog submitting）/ `deleteError: string | null`；
  2. ConfigPanel 头部操作区（与克隆/保存并列）新增「删除」按钮 `data-testid="delete-agent-button"`（红色描边 danger 风格，`{canDelete && !isTemplate && …}` 条件渲染——template 只读不显示，后端 403 兜底）；
  3. 页面主组件 `const canDeleteAgent = hasPermission(user?.permissions, "agents", "delete")`（复用 hasPermission 三格式兼容，对齐后端 PermissionGuard）；
  4. `deleteMutation`：DELETE /agents/:id → onSuccess 关弹窗 + `invalidateQueries(["agents"])` + `setSelectedId(null)`（useEffect 自动选中剩余第一项）；onError 展示 deleteError banner（`data-testid="agent-delete-error"`，沿用 saveError 样式，项目无 toast 机制）；
  5. `<ConfirmDialog>`（复用 confirm-dialog.tsx，OBS-003 先例，默认 testid=confirm-delete → confirm-delete-modal）确认后才 DELETE，submitting 走 `deleting={deleteMutation.isPending}`。
- **⚠️ 并行会话合并教训（第二次撞车）**：UX-05/UX-16（文案简化）并行 session 同时改同一文件，与 UX-14 删除入口改动高度重叠（删除按钮/deleteError banner/deleteMutation/ConfirmDialog/state/传参几乎全同）。处理：`git diff` 核对后**以并行实现为主体**，回退我造成的重复块（重复 deleteMutation、重复 canDeleteAgent 定义），仅保留差异部分（ConfigPanelProps 的 canDelete/onDelete/deleteError + 补并行版缺失的 `deleting` 传参——并行版自行补上后 tsc 通过）。经验：多会话并行改同一文件同一功能时，重叠不可避免，关键是**先 diff 后写、同名语义只留一套、补对方缺漏而非重写**。
- **验证**：`cd web && npx tsc --noEmit` **0 错误**（EXIT 0）。未启动 dev server、未跑 playwright/build/jest（遵守执行范围防并行冲突，浏览器实测由 QA 阶段覆盖）。

## UX-14 修复：Agent 删除入口（前端暴露 DELETE /agents/:id）

**问题**：qa-report-open-issues-2026-08-09.md:85 —— 后端 `agents.controller.ts:96 @Delete(':id')` + `@RequirePermission('agents.delete')` 存在，但 `web/app/(main)/agents/page.tsx` 未暴露删除入口。

**后端语义确认**：`agents.service.ts` 的 `remove()` 经 `assertWritable(type)` 校验 → **type=template 删除 403**（PERMISSION_AGENT_READONLY），仅 custom/clone 可删（含 agent_skills/agent_tool_effects 关联清理）。因此前端对 template 隐藏删除按钮（与 PATCH 只读语义一致）。

**修改**（`web/app/(main)/agents/page.tsx`）：
| 位置 | 内容 |
|---|---|
| :782-789 | ConfigPanelProps 新增 `canDelete` / `onDelete` / `deleting` / `deleteError` 四 prop |
| :966-989 | 头部操作区删除按钮 `delete-agent-button`（danger outline 红，`canDelete && !isTemplate` 才显示） |
| :1062-1082 | `agent-delete-error` alert（对齐 saveError 错误模式，DELETE 非 2xx 展示） |
| :1819 | `canDeleteAgent = hasPermission(user?.permissions, "agents", "delete")`（对齐后端 PermissionGuard） |
| :1825 | `deleteConfirmOpen` / `deleteError` state |
| :1955-1970 | `deleteMutation`：DELETE /agents/:id → onSuccess 关闭弹窗 + invalidateQueries(["agents"]) + setSelectedId(null)（useEffect 自动回选首个）；onError 设置 deleteError |
| :2135-2154 | ConfirmDialog（复用 confirm-delete-modal testid）：title「删除 Agent」+ description 含 Agent 名与不可恢复提示 + submitting=deleteMutation.isPending |

**验证**：`cd web && npx tsc --noEmit` → 0 错误。未启 dev server / 未跑浏览器（部署由 orchestrator 统一完成）。

Tags: UX-14, delete, agents-page, permissions

---

## E4-fix: CONF-01 修正——模板默认模型改用 worker 实测 8 个清单（2026-08-09，实现 + tsc + jest 验证完成）

- **⚠️ 修正原因（E4 原修复有误）**：E4 以 **DB worker_model_availabilities 26 行**（worker capabilities.models 上报入库）为准选取模板默认模型，但**用户 worker 节点 `opencode models` 实测仅 8 个**——DB 中 18 个（ling-3.0-flash-free / hy3-free / minimax-m3-free / ring-2.6-1t-free / ling-2.6-flash-free / hy3-preview-free / qwen3.6-plus-free / mimo-v2-omni-free / mimo-v2-pro-free / nemotron-3-super-free / minimax-m2.5-free / glm-5-free / trinity-large-preview-free / kimi-k2.5-free / minimax-m2.1-free / glm-4.7-free / mimo-v2-flash-free / grok-code）为**假模型**（2026-08-08 18:14 同秒入库，来自当时 capabilities.models 上报）。**权威数据源 = worker 节点 `opencode models` 实测（8 个）**，不是 DB 上报表。
- **真实 8 个（权威）**：`opencode/big-pickle`、`opencode/deepseek-v4-flash-free`、`opencode/laguna-s-2.1-free`、`opencode/ling-3.0-tiny-free`、`opencode/longcat-2.0-free`、`opencode/mimo-v2.5-free`、`opencode/nemotron-3-ultra-free`、`opencode/north-mini-code-free`。
- **改动面（代码层，不部署/不重 seed——orchestrator 部署阶段统一清理 DB 假模型 + 重 seed）**：
  1. `agent.constants.ts` STATIC_AVAILABLE_MODELS **34→16**：移除 18 个假 opencode/*-free 模型，保留 8 核心（md_1~8）+ 8 真实（md_9~16，按实测清单顺序排列）。
  2. TEMPLATE_DEFAULT_MODELS 改实测清单内：产品→`opencode/ling-3.0-tiny-free`（轻量通用）、架构→`opencode/nemotron-3-ultra-free`（保留）、开发→`opencode/deepseek-v4-flash-free`（保留）、测试→`opencode/north-mini-code-free`（代码向穷举）。原 `glm-5-free`/`qwen3.6-plus-free` 是假模型，已换。
  3. `agent.constants.spec.ts`：行数断言 34→16；CONF-01 契约从 26 清单改为 8 真实清单（hardcode 8 个 + size===8 双锁，**目录=worker 实测能力**防再脱节）。
- **验证**：`cd server && npx tsc --noEmit` 0 错误；`npx jest src/common/constants/agent.constants.spec.ts --silent` 6/6 全绿。全仓 grep 无其他代码引用被移除的假模型。
- **⚠️ 教训（铁律）**：模型清单以 **worker 节点 `opencode models` 实测**为权威，**DB worker_model_availabilities / capabilities.models 上报仅作参考**——上报可能含假模型/测试注入（同秒批量入库高度可疑），spec 契约断言必须锁定实测清单而非 DB 上报数。
- **遗留（orchestrator 处理）**：DB 中 18 个假模型（worker_model_availabilities + models 表）需清理 + 重跑 seed 更新已入库模板 Agent defaultModelId（模板只读 PATCH 403，只能 seed 更新）。

## FILE-00: 文件存储基础能力（统一上传 + 静态服务，FILE-01/02、UX-10 共享基础，2026-08-09）

- **方案选优（web/public vs server uploads）**：选 **server uploads + ServeStaticModule 挂载 + web rewrite**。理由：① server 独立持有文件，读/写同源（main.ts useStaticAssets 与 multer destination 共用 `resolveUploadDir()`），与 Next build 产物（web/public 会在 build 时复制进 .next/standalone，运行时写入不生效）解耦；② 与现有 API 代理模式一致——web/next.config.ts 增加 `/uploads/:path*` → `API_PROXY_TARGET/uploads/:path*` rewrite（同 /api/v1 模式），dev/prod 均同源访问；③ 目录可由 `UPLOAD_DIR` 环境变量覆盖（默认 `server/uploads/`）。
- **新增模块 `server/src/uploads/`**：`uploads.constants.ts`（UPLOAD_ERRORS / ALLOWED_EXTENSIONS 12 种 / FILE_SIZE_LIMIT=10MB / resolveUploadDir）、`uploads.service.ts`（FileStorageService：静态 buildMulterOptions/assertAllowed/extractExtension/generateFilename + 实例 describe）、`uploads.controller.ts`（POST /api/v1/uploads）、`uploads.module.ts`（exports FileStorageService 供 FILE-01/02、UX-10 复用）。
- **关键设计**：① 文件名 `UUID.<ext>`（crypto.randomUUID + 保留小写扩展名，杜绝重名/路径穿越）；② **类型校验以扩展名白名单为准而非 mimetype**——浏览器/工具常把不同类型统一上报为 application/octet-stream，扩展名才是可控类型信号（返回 ext 与校验同源）；③ 大小限制走 multer limits → Nest 413（与 skills 上传同款机制，skills.controller.ts 先例）；④ 类型拒绝在 fileFilter 抛 BadRequestException({code: UPLOAD_FILE_TYPE_NOT_ALLOWED})，缺文件 400 UPLOAD_FILE_REQUIRED；⑤ 返回 `{url:'/uploads/<filename>', name, size, ext}`。
- **multer 类型**：multer 2.x 无自带 .d.ts，@types/multer 未安装；因 tsconfig `noImplicitAny:false`，`import { diskStorage } from 'multer'` 隐式 any 可编译（skills.controller.ts 的 memoryStorage 同款先例），无需新增依赖。fileFilter 参数类型复用 @nestjs/platform-express MulterOptions 内联结构。
- **验证**：`cd server && npx tsc --noEmit` 排除并行 session 正在修改的 chat.service.ts/chat.controller.ts 后 0 错误；`npx jest src/uploads` 26/26 全绿（service spec 覆盖 extractExtension/generateFilename/assertAllowed/fileFilter cb 语义/describe；controller spec 覆盖 describe 透传/缺文件 400）；`cd web && npx tsc --noEmit` next.config 0 错误。
- **⚠️ 并行冲突提醒**：本次执行中发现 chat.service.ts/chat.controller.ts 正被并行 session 编辑产生临时语法错误，tsc 全量红——验证时按文件过滤，不属本次改动。
- **遗留（下游任务衔接）**：FILE-01/02 背景文档/产出物上传、UX-10 群聊附件可注入 FileStorageService 复用 buildMulterOptions/describe；POST /uploads 当前仅全局 JWT 鉴权，如后续需按资源收口可加 PermissionGuard；worker 上报的 artifact fileRef（12 篇 §3.1）与浏览器上传 /uploads URL 是两条路径，FILE-02 需定义 fileRef 归一策略。

Tags: file-storage, uploads, multer, static-assets, FILE-00

---

## UX-09: 消息中心会话管理——删除/置顶/标记已读（后端 3 端点 + 前端操作 + schema 迁移，2026-08-09）

- **问题**：QA 报告 UX-09【中】——会话无删除/置顶/标记已读操作；后端 `chat.controller.ts` 无对应端点（GET/POST 仅 5 个）。
- **Schema 变更（ChatChannel 加 3 字段，channel 级简化）**：`pinned Boolean @default(false)`、`lastReadAt DateTime? @map("last_read_at")`、`deletedAt DateTime? @map("deleted_at")`。**评估结论**：用户级置顶/已读需 ChannelUser/MessageRead 关联表，任务明确"尽量简单"→ 用 channel 级标记（共享群聊会互相影响，演示平台可接受）。
- **后端（chat.controller + chat.service + dto/update-channel.dto.ts）**：
  1. `DELETE /channels/:id` → **soft delete**（deletedAt=now），列表隐藏 + 已删除频道 resolveChannelAccess 404（幂等）；非项目成员 403。返回 `{id, deletedAt}`。
  2. `PATCH /channels/:id {pinned}` → update pinned，返回频道 DTO；列表 `orderBy: [{pinned:'desc'},{createdAt:'desc'}]`（置顶优先）。
  3. `PATCH /channels/:id/read` → lastReadAt=now，返回 `{id, lastReadAt}`。
  4. **DM 复活语义**：`createDmChannel` 幂等命中已 soft delete 的 private 频道时 update 复活（deletedAt=null 复用原记录）——否则 `@@unique([taskId,agentId])` 唯一键冲突导致无法重建。
  5. `toChannelDto` 透传 pinned/lastReadAt；`findAccessibleChannels` where 加 `deletedAt: null`；`resolveChannelAccess` 加 `channel.deletedAt` 404 检查。
- **前端（web/app/(main)/messages/page.tsx）**：ChannelItem 加 pinned/lastReadAt；ConversationItem 右侧操作组（`conversation-pin-button` / `conversation-read-button` / `conversation-delete-button`，外层 div stopPropagation 防触发整卡跳转）；置顶态卡片浅蓝（#EFF6FF/#BFDBFE）；页面级 deleteMutation/pinMutation/readMutation 均 `invalidateQueries(["channels"])`；删除走 ConfirmDialog（OBS-003 先例，复用 confirm-delete-modal，title「删除会话」）。
- **验证**：`cd server && npx tsc --noEmit` 0 错误（排除并行 session 新建的 uploads.service.spec.ts 既有错误）；`npx jest chat` **3 suites / 104 tests 全绿**（chat.service.spec 40 个含新增 removeChannel/updateChannelPinned/markChannelRead 各 2-3 用例 + DM 复活用例）；`cd web && npx tsc --noEmit` 0 错误。未跑迁移（orchestrator 部署阶段 prisma migrate）+ 未部署（遵守执行范围）。
- **经验**：① **编辑插入方法时 oldString 若含目标方法 JSDoc 开头，newString 必须补回被吞的 JSDoc 前几行**（本次吞掉 resolveChannelAccess 的 `/**`+首行，tsc 报语法错误定位到 489 行）——Edit 的 oldString 是整段替换，易截断相邻 JSDoc；② soft delete + `@@unique` 复合键冲突必须显式处理"复活"分支，否则删除的 DM 无法重建；③ 删除语义与共享频道现实冲突（channel 级 deletedAt 删所有成员可见性）——任务明确简化优先，文档标注即可。
- **遗留（orchestrator）**：schema.prisma 3 新字段需 `prisma migrate` 生成迁移 + 部署；DB 既有 chat_channels 行 pinned=false / lastReadAt=NULL / deletedAt=NULL 由 default 兜底。

Tags: UX-09, chat, channel-management, soft-delete, prisma-migration

## UX-15: 技能编辑（后端 PATCH /skills/:id + 前端编辑弹窗，2026-08-09，实现 + tsc + jest 验证完成）

- **问题（qa-report-open-issues-2026-08-09.md:96，原标"无需修复"）**：技能仅有启停/上传覆盖，无编辑入口。收尾补齐。
- **后端（JSON body，非 multipart）**：
  - `PATCH /skills/:id` → `UpdateSkillDto {name?, description?, content?}`（全空 → 400 `SKILL_UPDATE_EMPTY`，新增错误码）。
  - `SkillsService.update(id, dto)`：404 查无 → name 走 `assertSkillName`（400 FRONTMATTER_INVALID）+ 唯一性（`assertNameFree` 增加 `excludeId` 排除自身，409）；content 走 `parseSkillMarkdown` 校验合法后落库原文。
  - **一致性不变量「DB 列 = content frontmatter」**（worker 注入读 content 原文，若列与 frontmatter 脱钩会导致注入 SKILL.md 名与列表展示名不一致）：显式提供的 name/description 用新工具函数 `rewriteFrontmatterField(content, key, value)` 同步重写 content frontmatter（支持标量替换 / 块标量整块删除 / 缺省追加，`skill-frontmatter.util.ts`）；只更新 content 时 name/description 列反向取 content frontmatter 解析值。
  - 编辑落库后同样 `broadcastReloadConfig`（F1 MAJOR 闭环）。
  - 权限：`@RequirePermission('skills.edit')`（与 PATCH status 同点，admin 专属）。路由 `@Patch(':id')` 与既有 `@Patch(':id/status')` 路径段数不同不冲突。
- **前端（`web/app/(main)/skills/page.tsx`）**：技能行操作区加「编辑」按钮（`skill-edit-button`，仅 admin）；弹窗 `edit-skill-modal-root`（name/desc 输入 + SKILL.md 全文 textarea，mono）→ PATCH /skills/:id；列表接口不含 content → 打开时 `GET /skills/:id/content` 拉取预填（editLoading 禁用保存）；保存校验 name slug 与后端 assertSkillName 一致。
- **验证**：`cd server && npx tsc --noEmit` 0 错误；`npx jest src/skills --silent` **3 suites / 54 tests 全绿**（service 新增 update 10 用例、controller 1 用例、frontmatter util 新增 rewriteFrontmatterField 6 用例）；`cd web && npx tsc --noEmit` 0 错误（**排除并行 session 未提交改动的 `web/app/(main)/messages/page.tsx` 2 个 TS2739**——stash 该文件后 tsc 0 错误证明非本次引入，已 pop 还原，勿触碰）。
- **经验**：① `assertNameFree` 由 `if (existing)` 改为 `if (existing && (excludeId===undefined || existing.id!==excludeId))`——若写成 `existing.id !== excludeId`，create（excludeId undefined + mock 无 id）会误判相等放行同名，既有 create 用例立即暴露；② PATCH 元信息编辑必须同步 content frontmatter（不变量），否则「改列不改注入原文」造成列表与 worker 注入脱钩；③ 并行 session 改动同一仓库其他文件时，验收前用 `git stash push -- <file>` 单文件暂存定位既有错误归属。

Tags: UX-15, skills, patch-endpoint, frontmatter-rewrite, frontend-modal

---

## FILE-02: doc/file 产出物查看/下载（收尾补齐，2026-08-09，实现 + tsc + jest 验证完成）

- **问题（qa-report-open-issues-2026-08-09.md FILE-02）**：doc/file 产出物仅显示「文件引用：{contentRef/filePath} + sha256」纯文本，不可查看/下载。
- **现状确认**：Artifact doc/file 的 `contentRef`/`filePath` 存 `submission.fileRef`——浏览器上传路径（POST /uploads 返回的 `/uploads/<filename>`，web rewrite 可达）与 worker 上报路径（12 篇 §3.1「worker 工作区文件引用 URL」，实测可能为原始路径/纯文件名）两条来源。数据无 size 字段（仅 contentRef/filePath/sha256）。
- **后端归一化（`server/src/uploads/uploads.service.ts` FileStorageService 新增静态方法，文件域知识收敛在 uploads）**：
  1. `normalizeFileRef(ref)`：`/uploads/` 前缀或 http(s):// 完整 URL → 原样；其他（worker 原始路径/纯文件名）→ 提取 basename 归一为 `/uploads/<basename>`（控制面已落盘 uploads 时可达；无扩展名/空串 → 原样不伪造 URL）。
  2. `describeFileRef(fileUrl)`：派生 `{name, ext, size}`；`/uploads/` 前缀经 `statSync(join(resolveUploadDir(), base))` 读磁盘 size（文件缺失 → null，前端不显示大小徽章）；外部 URL 不读本地磁盘 size=null。
  3. `artifacts.service.toVersionDto`：doc/file（`filePath` 非空）追加 `fileUrl/fileName/fileExt/fileSize` 派生字段，`contentRef/filePath` 原样不动（契约向后兼容，text 版本不附加）。
- **前端（`web/app/(main)/artifacts/page.tsx`）**：新增 `ArtifactFileView` 组件替换 doc/file 纯文本分支——可访问引用（/uploads/ 或 http(s)）渲染：图片类型（png/jpg/jpeg/gif）内嵌 `<img>` 预览（`artifact-image-preview`）+ 文件名链接（`artifact-file-link`，target=_blank）+ 扩展名/大小徽章（`artifact-file-badge`）+ 下载按钮（`artifact-file-download`，同源 /uploads/ 触发 download）+ sha256；不可访问引用降级为旧纯文本展示。
- **测试**：`uploads.service.spec.ts` 新增 normalizeFileRef 6 用例 + describeFileRef 4 用例（statSync 经 `import * as fs from 'node:fs'` spy，`'fs'`/`'node:fs'` 解析同一核心模块对象，spy 生效）；`artifacts.service.spec.ts` 新增 doc/file 版本归一化 + text 版本不附加 2 用例。
- **验证**：`cd server && npx tsc --noEmit` 0 错误；`npx jest src/uploads src/artifacts` **5 suites / 69 tests 全绿**（含并行 session 的 PermissionGuard controller 用例）；`cd web && npx tsc --noEmit` 0 错误。未部署/未起 dev server（遵守执行范围）。
- **经验**：① 文件域知识（扩展名/大小/上传目录）收敛在 `FileStorageService` 静态方法，artifacts.service 直接 import 复用，避免跨模块 DI 缠绕（uploads 不依赖 artifacts，无循环）；② 产出物 `filePath` 非空恰为 doc/file 的天然判别（text 恒为 null），无需给 toVersionDto 传 type；③ `node:fs` 与 `fs` 在 jest/Node 解析为同一模块对象，spyOn 均生效；④ **并行 session 冲突**：artifacts.controller.ts/spec.ts 同时被并行 session 加 PermissionGuard（CONF-02），本次 jest 首次跑 controller spec 报 PrismaService 未解析为并行 session 的中间状态，其后补齐 mock 后通过——跨 session 协作时先验证改动归属再判断失败。

Tags: FILE-02, artifacts, file-ref-normalize, uploads, file-download, image-preview

---

## UX-10: 群聊附件/图片上传（收尾阶段补齐，2026-08-09，实现 + 测试完成）

- **问题（QA 报告）**：群聊只能发文字，不能发文件/图片。QA 报告 .gstack/qa-reports/qa-report-open-issues-2026-08-09.md UX-10 行。
- **背景（文件存储基础已就绪，上一任务交付）**：`POST /api/v1/uploads`（multipart file 字段，diskStorage，扩展名白名单 pdf/doc/docx/xls/xlsx/csv/png/jpg/jpeg/gif/md/txt，10MB）→ `{url,name,size,ext}`；`GET /uploads/*` 静态可达（main.ts useStaticAssets + web next.config rewrite `/uploads/:path*` → API_PROXY_TARGET）。
- **后端改动（schema 改动允许，不实际迁移）**：
  1. `schema.prisma` Message 模型加 3 可空字段：`attachmentUrl String? @map("attachment_url")` / `attachmentName` / `attachmentType`——**改了 schema 必须 `npx prisma generate` 让 client 类型带上新字段**（否则 tsc 报 create data 属性不存在；generate 是本地代码生成，非迁移）。
  2. `CreateMessageDto` 加可选 `attachmentUrl` / `attachmentName` / `attachmentType`（均 @IsString + @IsOptional）——**不单独校验 URL 可访问性**（上传白名单已兜底类型/大小，静态服务由 main.ts 挂载）。
  3. `chat.service.ts`：MessageRow 类型加 3 字段；`createMessage` 落库**条件展开** `...(dto.attachmentUrl ? {attachmentUrl, attachmentName: dto.attachmentName ?? null, attachmentType: dto.attachmentType ?? null} : {})`（无附件消息不携带，避免旧测试精确断言 message.create 参数失败）；`toMessageDto` 恒透出 3 字段（无附件为 null，前端气泡渲染数据源）。
  4. **其他 message.create 调用点（mock/worker-dispatcher、tasks.service 系统消息）不需要改**——新字段可空，条件展开只在用户消息发送处。
- **前端（message-input.tsx + ChatBubble 共享组件，群聊/私聊两页自动获得能力）**：
  1. `MessageInput`：新增隐藏 file input（`message-attach-input`）+ 附件按钮（`message-attach-button`，SVG 回形针非 emoji）→ 选文件 → **客户端先行校验**（扩展名白名单 ALLOWED_ATTACHMENT_EXTS 对齐后端 + 10MB 上限，避免无提示 413）→ `FormData` 经 `api.post("/uploads", form)`（api.ts 已支持 FormData 自动去 Content-Type，浏览器带 boundary）→ 存 `pendingAttachment`（{url,name,size,ext}）→ 待发送预览（`message-attach-preview` + 移除按钮 `message-attach-remove`）+ 上传错误条（`message-attach-error` role=alert）。**上传后必须重置 `e.target.value=""`**——否则重选同名文件不触发 onChange。
  2. `SendMessagePayload` 加 `attachment?: MessageAttachment`；**handleSend 允许纯附件无文本发送**（`if ((!text && !pendingAttachment) || sending || attaching) return`）——纯图片/文件消息可用；发送中 + 上传中均禁用按钮。
  3. `ChatBubble` 加 `attachment?: ChatBubbleAttachment`（{url,name,size?,ext}）prop + 新 `AttachmentCard` 子组件：图片（png/jpg/jpeg/gif）→ `<img data-testid="attachment-image">` 内嵌预览；其他 → `<a data-testid="attachment-file" download>` 文件下载链接（文件名 + 大小格式化为 KB/MB）；外层容器 `message-attachment`。**纯附件消息（text 为空）不渲染空文本气泡**——`hasText = text.trim().length > 0`，气泡 div 仅 hasText 时渲染，附件卡片独立于气泡外挂（flex column 内）。
  4. 群聊页（tasks/[id]）与私聊页（messages/[id]）sendMutation 条件展开提交附件三字段 + 消息渲染 `attachment={msg.attachmentUrl ? {url, name: msg.attachmentName ?? msg.attachmentUrl, ext: msg.attachmentType ?? ""} : undefined}`。`RealtimeChatMessage` 类型加 `attachmentUrl?/attachmentName?/attachmentType?`（可空）。
- **⚠️ 前端渲染坑**：附件 `size` 后端 DTO **不透出**（Message 表无 size 列），上传后消息里文件链接不显示大小——ChatBubbleAttachment.size 设计为可选，向后兼容；如需显示大小需 schema 再加列（本期不做）。
- **测试**：chat.service.spec 新增 2 用例（带附件：message.create 收到 attachment 三字段 + 响应 DTO 透出 + dispatcher 空目标不受影响；无附件：data 不带 attachmentUrl 字段 + 响应透出 null）+ messageRow fixture 加 3 字段默认 null。**验证**：server `npx tsc --noEmit` **chat/uploads 文件 0 错误**（项目级仅剩并行 session 的 artifacts.service.spec.ts 4 个 fileSize/fileUrl 中间态错误，非本任务文件）；`npx jest chat` **3 suites / 106 tests 全绿**（基线 104 + 新增 2）；web `npx tsc --noEmit` 0 错误。未部署/未起 dev server/未跑浏览器（遵守执行范围）。
- **⚠️ 并行 session 竞争（复现）**：artifacts.service.spec.ts 由并行 session 正在改造（fileSize/fileUrl/fileName/fileExt 属性报 TS2339 中间态），server 项目级 tsc 4 个错误全部归属该文件——`grep chat|uploads` 过滤验证自己的改动 0 错误即可，不代改他人文件。

Tags: UX-10, chat-attachment, uploads, message-input, chat-bubble, image-preview

---

## CONF-02 方案②补齐：tasks/chats/artifacts 后端矩阵守卫落地（2026-08-09，实现 + spec + tsc 验证完成）

- **背景（QA 报告 CONF-02 行，方案②）**：CONF-02 方案①仅前端白名单禁配未启用点（41 个）；本次补齐后端守卫，使受限矩阵勾选后真实生效。已实现 10 点（agents 4 + projects.create + skills 3 + workers 2），本次补 tasks/chats/artifacts 三资源，白名单 10 → **20 点**。
- **权限点映射（对齐 09 篇端点表 + 语义收敛，不破坏既有数据级隔离）**：
  - `tasks.controller`（类级 ProjectMembershipGuard 成员过滤保留，方法级叠加 PermissionGuard）：GET 列表/详情 → `tasks.view`；POST 创建 → `tasks.create`；PATCH 编辑 / team / start / mark-pending-review / archive → `tasks.edit`；accept / reject → `tasks.review`（验收专属点，对齐原型「验收员」自定义角色组合）。
  - `chat.controller`（service 层 channel→task→project_members 校验保留）：GET channels / :id / messages / trigger-results → `chats.view`；POST messages / dm-channels → `chats.create`；PATCH :id（置顶）→ `chats.edit`；DELETE :id → `chats.delete`；**PATCH :id/read（标记已读）→ `chats.view`**——lastReadAt 是个人阅读状态非资源写操作，归读操作延伸，避免 member 只读用户被误拒（UX-09 功能保留）。
  - `artifacts.controller`（任务成员访问保留）：GET 列表/详情/版本 → `artifacts.view`；POST 旁路补充提交 → `artifacts.create`。
- **users/roles 决策：保持 AdminGuard 不变，不叠加矩阵权限点**——09 篇 §3.2/§3.7 标注 `[admin]`（用户列表/角色配置属管理域），若挂 `users.view`/`roles.view`，member 简写（all:false）会 view 放行 → **成员可读用户列表/角色矩阵，违反设计语义且泄露权限配置**。前端 users/roles 行维持「未启用」标注。
- **关键约束验证（PermissionGuard 三格式，逻辑零改动）**：admin（all:true）全放行；member（all:false）view 放行 / 写拒（tasks.create 等 403）——与 09 篇「成员只读可见 + 写操作 [admin]」一致；受限矩阵无对应点 → 403 `FORBIDDEN_PERMISSION`，勾选后真实生效。
- **模块注册**：tasks/chat/artifacts 三模块 providers 各加 `PermissionGuard`（依赖全局 PrismaService + Reflector，沿用 ISSUE-006 模式）。⚠️ controller 挂 PermissionGuard 后其 spec 必须 `.overrideGuard(PermissionGuard).useValue({canActivate: () => true})`，否则 compile 时 Nest 实例化守卫解析不到 PrismaService 报错（ISSUE-006 已记，本次复验）。
- **前端同步（roles/page.tsx IMPLEMENTED_PERMISSIONS 10 → 20）**：新增 tasks.view/create/edit/review、chats.view/create/edit/delete、artifacts.view/create；`rowHasImplemented` 动态判定 → tasks/chats/artifacts 三行「未启用」徽章自动消失。注释块更新为完整 20 点映射清单（含 users/roles 保持 AdminGuard 的说明）。
- **spec 更新**：tasks.controller.spec 加 PermissionGuard override + 4 条守卫元数据断言（`Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)`：view×2/create×1/edit×5/review×2）；artifacts.controller.spec 加 override + 2 条断言（view×3/create×1）。chat 无 controller.spec（service spec 不触守卫）。
- **验证**：`npx jest` tasks.controller.spec + artifacts.controller.spec + permission.guard.spec **3 suites / 37 tests 全绿** + chat.service.spec 42 全绿；`cd server && npx tsc --noEmit` 0 错误（排除并行 session FILE-02 的 artifacts.service.spec.ts 4 个 TS2339 中间态错误，见 UX-10 条目）；`cd web && npx tsc --noEmit` 0 错误。未部署/未跑全量 jest（遵守执行范围防并行冲突）。
- **经验**：① 读操作语义要按「读/写」本质判定而非 HTTP 动词——PATCH :id/read（已读）归 view 而非 edit，避免破坏 member 基础功能；② users/roles 的 view 权限点与 AdminGuard 语义冲突时**不叠加**（09 篇 [admin] 优先），前端对应行保持未启用即可；③ 验收类操作（accept/reject）用独立 `*.review` 点而非 edit，让「验收员」角色可组合（原型 member 矩阵 tasks 行 review=✓）；④ 并行 session 改同一仓库时，tsc 错误按文件归属过滤验证（`grep <自己文件>` 0 错误即可），不代改他人半成品。

Tags: CONF-02, permission-guard, tasks, chats, artifacts, permission-matrix
