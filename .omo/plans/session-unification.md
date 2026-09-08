# session-unification - Work Plan

## TL;DR (For humans)

- What you'll get：全量统一到团队会话的执行地基——单分派入口、会话只按成员建、回流只走 team 域、ta_ 快照域整体删除、任务只作为数据（taskId 字符串）流转。
- Why this approach：团队路径已是完整闭环（research 2/4 实证），收敛 = 删任务路径 + 把任务六要素数据化；Metis 缺口分析后已修正顺序（先迁引用后删表）、钉死分波与单文件串行。
- What it will NOT do：不改任务状态机/排队；不动 plans 表结构；不动 worker 执行协议；不保留任何 task 会话分支；realtime 可见性规则不动。
- Effort：15 个执行项 + 4 项终验；W1 三 lane 并行（A 链 6 连串行 + B 链 + C lane），W2（6 先合 → 9+11 并行 → 12），W3 清扫（含 Todo 15 种子修复），W4 实测（已完成）。
- Risk：删 ta_ 表是破坏性变更（迁移前 mysqldump；T8 先绿是 T6 前置门）；AgentQuestion 沿用 `''`；单成员单会话下同成员并发执行串行化（团队任务本就 FIFO，无新增约束）。
- Decisions：D1 删 ta_ 不留 / D2 workdir 按任务隔离保留 / D3 单成员单会话 / Q1 不兼容直改（新团队路由，老路由直删）/ Q2 tests-after / 测试数据可清理、种子不动 / Q3：任务级记忆删除（仅 team/global）/ 托管模式绑团队（Team.managedMode，读团队行）/ 任务域问题（AgentQuestion）按团队归属路由。

## Scope

IN：worker-dispatcher 分派收敛；会话写路径收敛；ingress/finalize/watchdog 收敛；plans/issues/questions 指派迁 tmm_ + 问题团队路由；记忆任务级删除（仅 team/global）；托管模式迁团队（Team.managedMode）；TaskAgent 表删除 + 迁移删存量 task 会话行；AgentQuestion 沿用 ''；前端会话状态/重置入口团队化；seed/单测/e2e/文档；隔离栈端到端实测。
OUT（Must-NOT-Have）：不得保留 task 会话分支或 task/team 双实现；不得改 plans 表结构；不得改 worker 侧执行协议（execute 入参形状除外，见 Todo 1）；不得回填/迁移存量 task 会话数据（只删）；realtime 可见性规则不动；`GET /api/v1/projects` 与本 plan 无关（上一期门禁，不得出现在此终验）。

## Verification strategy

- tests-after：每个 Todo 实现+单测一体；命令一律 `npx jest <path> > .omo/evidence/session-unification/suN.log 2>&1; echo "EXIT:$?"`（禁管道取码），`npx tsc --noEmit`，`npx prisma validate`（碰 schema 时）。
- Agent 实跑 QA 始终包含：每个后端 Todo 至少一组 happy（200/落库/scope 串断言）+ failure（400/403/404 精确 code）路径，证据 `suN-happy.log`/`suN-failure.log`。
- 终验：`npm run test` + `test:e2e` 全绿（预存失败逐项 stash 证伪）；残留 grep 达标；隔离栈端到端截图。

## Execution strategy

- 分波（W1→W4 顺序门，后一波需前一波绿）：
  - W1-LANE-A（同文件串行，不可并行合入）：Todo 1 → 2 → 3 → 5 → 7 → 10（worker-dispatcher.ts + chat.service.ts + ingress 主串）。
  - W1-LANE-B（串行）：Todo 4 → Todo 11（tasks.service.ts + teams.service.ts + tasks.controller.ts）。
  - W1-LANE-C（独立文件，可与 A/B 并行）：Todo 8（plans/issues/questions/platform-mcp/swagger）。
  - W2（内部顺序：Todo 6 先合；再 Todo 9 + Todo 11 并行；最后 Todo 12）：Todo 6（需 Todo 8 绿 + FK 预检）→ Todo 9（记忆/托管团队化）+ Todo 11（重置端点，需 Todo 4 绿）并行 → Todo 12（前端：订阅形状依赖 LANE-A，重置按钮依赖 Todo 11 新路由）。
  - W3：Todo 13（全量 specsweep + 文档，需全部代码 Todo 绿）。
  - W4：Todo 14（隔离栈实测，需 Todo 13 绿）。
- 同文件串行合入：worker-dispatcher.ts（1/2/3/5/7/9/10；其中 memory index 块唯一主人是 Todo 9，Todo 3 只断言键不改）、chat.service.ts（1/5）、session-lifecycle.service.ts（Todo 4 不碰本文件；Todo 10 拥有全部改写）、tasks.service.ts（4→11）、ingress（5→7）、platform-mcp.service.ts（8→9 按序：Todo 8 不碰记忆函数，Todo 9 拥有记忆函数）。
- DB 相关先隔离库验证 migration + 回滚流程；执行前 `mysqldump` 备份并记录路径首行；测试数据可删，种子不动；共享 dev 库迁移留到终验 F3 由专人确认。

## Todos

- [x] 1. 分派单入口：删任务路径，request 扁平化 + 执行键保留
  - References：`server/src/chat/worker-dispatcher.ts:973-1018`（dispatch 路由，删分叉）、`:1077-1592`（dispatchForTarget 整函数删除）、`:1702-2009`（提升为唯一入口）、`:994-1014/1236-1257/1566-1584`（分派侧 scope/broadcast 改 team）、`server/src/chat/message-dispatcher.ts:17-35`（DispatchRequest 加 `taskContext?: { taskId: string; overrideModelId?: string; executionMode?: string }`）、`server/src/chat/chat.service.ts` send 路径调用点 + `effectiveTaskId` 推导（:771-836，从 taskContext 取，DM 恒 null，queued-hint :1196-1206 保留）。
  - Acceptance：`teamMode=!request.taskId` 路由删除；dispatchForTarget 及仅被它引用的 task 私有 helper 删除（删前 `lsp_find_references` 确认零外部引用）；`execute()` 保留 `taskId` 键，值取 `taskContext.taskId ?? ''`（数据非身份，回流分支原样工作）；分派侧 loading/error broadcast 统一 `{type:'team'}` + `toExecutionScope(null,teamId)`；chat.service `effectiveTaskId` 不再读会话行；`tsc` 零错误。
  - QA happy：`npx jest src/chat/worker-dispatcher.spec.ts > .omo/evidence/session-unification/su1-happy.log 2>&1; echo "EXIT:$?"` 全绿 + taskContext 透传断言。QA failure：缺 teamId → throw（400 TEAM_SESSION_MISSING_DIMENSION），证据 `su1-failure.log`。
  - Commit：`refactor(dispatch)!: single team entry, task as data`。

- [x] 2. 任务六要素数据化：prompt/模型/模式/记忆/main门
  - References：`worker-dispatcher.ts:1204-1233`（任务 prompt）、`:1113-1125`（overrideModel）、`:1553/:263-266`（executionMode+plan）、`:1441-1507`（memoryIndex）、`:1392-1413`（main 门映射删除）、`:1831-1851`（团队 prompt 基线，合并单触发器）。
  - Acceptance：GROUP/TEAM 双触发器合并为单触发器（任务段 + team 段按 taskContext 有无拼接）；overrideModelId 从 taskContext 取；executionMode=plan 注入 workflow；memoryIndex 对 task+team+global 统一构建（注：仅 prompt hint 富集，不动 memorySave/Search 写/可见语义）；main 门唯一来源 `team.mainAgentMemberId`；`task.mainAgentId/mainAgentInstanceId` 列保留但停止写入（置空由 Todo 6 迁移执行）；`tsc` 零错误。
  - QA happy：plan 任务 prompt 含任务段 + workflow（字符串断言），证据 `su2-happy.log`。QA failure：executionMode 非法值 → 400，证据 `su2-failure.log`。
  - Commit：`refactor(dispatch): task six-elements as data`。

- [x] 3. workdir 与执行键：任务目录保留，registry/watchdog 全量改写点归一
  - References：`worker-dispatcher.ts:1287/1894-1899/4037-4043/4046-4056/4066-4115`（workdir）、`:805-807/3702`（key 形状）、`:1419-1423/1943`（registerExecution）、`:1984-2008` + 全部 `clearPendingWatchdog` 调用点（本 Todo 拥有全量改写，Todo 7/9 只做断言不改）。
  - Acceptance：`resolveAgentWorkDir(taskContext.taskId, ...)` 保留，无 taskId 回退 `teams/<teamId>`；executionKey/pending/watchdog 全量统一 team 域；register ref 恒 teamMemberId；`ta_`/`taskAgentId` 在本文件零命中（注释/历史除外）；`tsc` 零错误。
  - QA happy：同成员二次分派键复用（单测），证据 `su3-happy.log`。QA failure：双分派键隔离冒烟，证据 `su3-failure.log`。
  - Commit：`refactor(dispatch): team-scoped keys, task workdir kept`。

- [x] 4. 会话写路径收敛：快照/加人/团队重置（不碰 lifecycle 文件）
  - References：`server/src/tasks/tasks.service.ts:453-462`（create 快照建会话—删除）、`:1879-1887`（addAgents 会话—删除）、`server/src/teams/teams.service.ts:819-830`（reset 改 taskId=null 重建语义；session-lifecycle.service.ts 本 Todo 不碰，归 Todo 10）。
  - Acceptance：任务创建/加人零 session 写；团队重置重建行 taskId/taskAgentId 恒 null；uk 写顺序保持先删后建（事务内，沿用既有模式）；`tsc` 零错误。
  - QA happy：建任务后 sessions 表无 task 行（mock 断言），证据 `su4-happy.log`。QA failure：空团队 reset 空操作不抛错，证据 `su4-failure.log`。
  - Commit：`refactor(sessions)!: team-only session writes`。

- [x] 5. 触发与回填收敛：buildTrigger 系 + adopt（chat.service 本 Todo 唯一主人）
  - References：`server/src/chat/chat.service.ts:1934-1937`（buildTrigger 改 team 直查，删 task 分支）、`:1983-2067`（buildMainAgentTrigger 改 team，删 ta_ remap）、`:431-439`（getSessionHistory task 分支改 team `findMany({teamMemberId})`）、`server/src/workers/worker-event.ingress.ts:950-975/983-1054`（删 adoptNewInstanceRefByTask；未知 instanceRef + 多 running 返回 undefined、调用方保 raw ses_ id，单测锁定精确值）、`worker-dispatcher.ts:1027-1076`（dispatchAgentMention 改 teamId+teamMemberId 直查，无回退）。
  - Acceptance：上述 task 锚定分支全部删除，无 task/team 双实现；`buildTeamMemberTrigger` 非 tmm_ throw 保留；`tsc` 零错误。
  - QA happy：ses_ 回流归一团队会话（单测），证据 `su5-happy.log`。QA failure：未知 instanceRef → 返回 undefined 且调用方保 raw id（精确断言），证据 `su5-failure.log`。
  - Commit：`refactor(triggers): team-only resolve paths`。

- [x] 6. 删 TaskAgent 域：表 + 迁移删存量 task 会话行（需 Todo 8 先绿）
  - References：`server/prisma/schema.prisma`（TaskAgent model + `uk_task_agents_task_agent_seq` + 反向关系删除；`tasks.mainAgentInstanceId` 迁移置 null（纯字符串列）；`mainAgentId` FK→agents 保留；uk_sessions_task_agent 约束保留冻结并注释；uk_sessions_team_member/uk_channels_* 保持不变）、新 migration（顺序钉死：`SHOW CREATE TABLE sessions/chat_channels` 确认 FK 名 → `DELETE FROM sessions WHERE task_id IS NOT NULL` → `UPDATE chat_channels SET taskAgentId=NULL WHERE taskAgentId IS NOT NULL` → `DELETE FROM memories WHERE level='task'` → teams 加 `managed_mode` 布尔默认 false 并从 tasks 回填 → tasks 删 `managed_mode` 列 → `DROP TABLE task_agents`）、`server/prisma/seed.ts`（删 ta_ 种子）。
  - Acceptance（前置门）：Todo 8 绿 + LANE-A（Todo 1/2/3/5/7/10）绿（删表后 taskAgent 模型消失，残留引用即 tsc 断档）+ `npx prisma validate` 通过 + `taskAgent` 非历史零命中（删表前复核）；空库 migrate deploy + seed 全绿；证据首行为备份路径。
  - QA happy：migrate + seed 输出，证据 `su6-happy.log`。QA failure：隔离库 `down -v && up --build` 重建演练（必须真实执行，禁“文档化代替”），证据 `su6-failure.log`。
  - Commit：`refactor(db)!: drop task_agents domain + stale task sessions`。

- [x] 7. ingress/finalize 收敛：delta/question/completed 全走 team
  - References：`worker-event.ingress.ts:465-627`（delta team 分支提升唯一，删 task 私有目标；taskId 只做归因透传）、`:740-857`（question 沿用 `''`；managedMode/scopeOf 改由 Todo 9 团队化，本 Todo 只做归因透传）、`:634-677`（completed 透传）、`worker-dispatcher.ts:2021-2954`（删任务终态分支，handleTeamTaskCompleted 提升唯一；`emitFinal` taskId 字段继续承载 scope 字符串兼容前端；回流侧 scope 统一 team）。
  - Acceptance：无 task/team 双实现；message 落库 taskId 照写（归因）；team_group fallback 保留；`tsc` 零错误。
  - QA happy：team delta 落库 + scope=channel 广播（单测），证据 `su7-happy.log`。QA failure：channel 不存在 → 跳过不抛错，证据 `su7-failure.log`。
  - Commit：`refactor(ingress): team-only reflow paths`。

- [x] 8. plans/issues/questions/MCP 指派迁 tmm_（Todo 6 前置）
  - References：`server/src/plans/plans.service.ts:142-156`（assignee 校验改 teamMember）、`:333-351`（reviewer 改 teamMember；plans 表不动，`taskId @unique` 保留）、`server/src/issues/issues.service.ts:131-180`（assignee 改 tmm_）、`:725-749`（taskAgents.findMany 候选池改 teamMember，map 同步）、`server/src/questions/questions.service.ts:260-290/357/369/406/463/473/523/539-548`（ses_ 回退 + mainAgentSession 改 team 会话；managedModeOf/scopeOf/toDto 调用点全量改团队归因，执行期通读本文件确认无遗漏）、`server/src/platform-mcp/platform-mcp.service.ts:1388-1450`（planSubmit：main 门改 `team.mainAgentMemberId === selfInstanceId`，assert 改 team）、`:1705-1751`（planTaskTransition：isAssignee/isMain 改 tmm_ 比较）、`GET /plans?taskId=` 契约不变、`server/src/swagger-mcp/swagger-mcp.auth.ts:57/116`（补 team 感知断言）。
  - Acceptance：逐门枚举旧 ta_ 检查 → 新 tmm_ 检查（见上行号）；`GET /plans?taskId=` 不变；`GET /issues`、`GET /questions` 新增可选 `teamId` 过滤（问题经 session.teamId + task 归属 team 实现，无 schema 变更）；非成员 403 语义不变；`tsc` 零错误。
  - QA happy：指派/评审/回复/MCP 门单测绿（含逐门 403），证据 `su8-happy.log`。QA failure：非团队成员调 planSubmit → 403，证据 `su8-failure.log`。
  - Commit：`refactor(plans,issues,questions): tmm_ assignees`。

- [x] 9. 记忆任务级删除 + 托管模式迁团队
  - References：`server/src/memories/memory.constants.ts`（level 枚举删 task，仅 team/global）、`server/src/memories/memories.service.ts` + `dto/query-memories.dto.ts`（删 task 分支/过滤）、`server/src/platform-mcp/platform-mcp.service.ts` 记忆函数（memorySave level=task → 400 `MEMORY_LEVEL_INVALID`；memorySearch 删 task 分支；tools.ts 描述同步）、`worker-dispatcher.ts` memory index 块（本 Todo 唯一主人：删 task 计数/检索，仅 team+global；Todo 3 只断言 registry/watchdog 键，不碰本块）、`server/src/questions/questions.service.ts:372-384`（managedModeOf/scopeOf 改读团队行：经 session.teamId 查 team.managedMode）、`server/src/message-channels/message-question.dispatcher.ts:155-174`（main 门改 team：`team.mainAgentMemberId` + 会话 `teamMemberId` 比较，删 task.mainAgentInstanceId/taskAgentId 逻辑；所在函数体执行期通读确认）、`server/src/tasks/tasks.service.ts` + `CreateTaskDto`（删 managedMode 写入/入参，执行期 grep 枚举残留）、`server/src/teams/teams.service.ts` + `UpdateTeamDto`（update 接受 managedMode）。
  - Acceptance：level 非 team/global 入参 400（精确 code `MEMORY_LEVEL_INVALID`）；team/global 读写行为不变；团队 managedMode 开关经 Teams 更新生效，问题确认门读团队行；tasks 创建不再接受 managedMode；`tsc` 零错误。
  - QA happy：team/global 存取 + managedMode 开关链路（单测），证据 `su9-happy.log`。QA failure：level=task 入参 → 400 精确 code；未知团队读托管 → 404，证据 `su9-failure.log`。
  - Commit：`refactor(memory,managed)!: team-only levels + team managedMode`。

- [x] 10. fail/retry/bind 归一 + resolveTeamChannel 唯一化
  - References：`worker-dispatcher.ts:3084-3181`（failTeam/failProcessing 合并为 team 唯一）、`:3944-3948`（retry team 化）、`:3511-3563`（删 L3536/L3554 task-keyed DM 分支，`resolveTeamChannel` 为唯一路径）、`server/src/workers/session-lifecycle.service.ts:79-162/247-280/363-392`（bind/unbind/reads 改 team 键；`getInstancesByTask` 调用方改 team 等价，调用点以 `lsp_find_references` 枚举为准）。
  - Acceptance：fail/retry/resolve 全走 resolveTeamChannel；bind/unbind 只认 team 行；`tsc` 零错误。
  - QA happy：失败回流 failed + 广播（单测），证据 `su10-happy.log`。QA failure：未知 channel → 跳过不抛错，证据 `su10-failure.log`。
  - Commit：`refactor(lifecycle): team-only fail/retry/bind`。

- [x] 11. 重置端点重建为团队路由 + toTaskDto 改组装
  - References：`server/src/tasks/tasks.controller.ts:215` + `tasks.service.ts:1108-1143`（删除旧实现）、新路由 `POST /teams/:teamId/members/:memberId/reset-session`（实现落 `server/src/teams/teams.service.ts` 新增 `resetMemberSession` + `server/src/teams/teams.controller.ts` 新 handler；请求体空；旧 `POST /tasks/:id/instances/:instanceId/reset-session` 路由整段删除，Q1 不兼容）、`tasks.service.ts:1777-1778`（toTaskDto instances/sessionStatus 从团队成员 + 团队会话组装）。
  - Acceptance：旧路由 404（路由不存在）；新路由重置成员团队会话（新 s_ 行 + 旧失效）；toTaskDto 无 ta_ 字段；`tsc` 零错误。
  - QA happy：重置后新行旧失效（单测），证据 `su11-happy.log`。QA failure：未知成员 → 404，证据 `su11-failure.log`。
  - Commit：`refactor(tasks)!: member-scoped reset-session route`。

- [x] 12. 前端团队化：订阅/守卫/重置/历史
  - References：`web/app/(main)/teams/[id]/session/page.tsx:515`（订阅改 `team:${teamId}`，去掉 `task:`）、`:597/654`（mismatch guards 仅过滤任务分区群消息，状态/问题事件放行 team 域）、重置入口改调 Todo 11 新路由、`data-testid="session-status"` 断言点、群聊跨任务可见保持、私聊 session-history 保持。
  - Acceptance：team 事件驱动状态点翻转；任务分区群消息仍按 taskId 过滤显示；成员面板状态源于团队会话；`npx tsc --noEmit` + eslint 干净；Playwright 新建 `web/e2e/session-unification.spec.ts`：3 用例（`data-testid="session-status"` 状态点翻转；重置按钮调新路由，执行期 grep 会话页枚举其 data-testid；群消息 task 分区不断裂），截图 `su12/`。
  - QA happy：上述 spec 全绿，截图 `su12/`，证据 `su12.log`（`npx playwright test session-unification > su12.log 2>&1; echo "EXIT:$?"`）。QA failure：无会话成员显示“就绪”兜底截图，证据同目录。
  - Commit：`refactor(web): team-scoped session view`。

- [x] 13. seed/单测/e2e/文档跟进（含残留 taskAgent 读迁移）
  - References：`server/prisma/seed.ts`（删 ta_ 种子）、全量 `*.spec.ts`（ta_/task 会话 mock 改 team，命令 `npx jest <path> > .omo/evidence/session-unification/su13.log 2>&1; echo "EXIT:$?"` 逐模块）、`server/test/e2e/team-queue.e2e-spec.ts`（helper 改 team 会话）、`docs/agent-platform/13/14/15/28` + `docs/test-cases/` 相关章节；**残留读迁移（显式清单，执行期逐项确认）**：`platform-mcp.service.ts` 的 teamView/taskContext/group_post 等函数内 `prisma.taskAgent` 读（~290/432/599/1192/1840/1919/2166/4144，以执行期 grep 为准）→ 改 teamMember 等价读；`workers.service.ts:553`、`teams.service.ts:398`、`tasks.service.ts:195(seedPrefix 去 ta_ 前缀)/1064/1080`、`chat.service.ts:323`、`swagger-mcp.auth.ts:86` 同理；上述各 spec 的 `prisma.taskAgent.*` mock（含 `not.toHaveBeenCalled` 断言，一律删除/改写，client 再生后访问即抛错）；注释中的 `TaskAgent` 字样一并清理（F1 grep 会命中）。
  - Acceptance：`npm run test` 全绿（预存失败逐项 stash 证伪并记录）；收尾执行 `npx prisma generate` 后 `npx tsc --noEmit` 全绿（顺序：先改完所有引用再 generate）；e2e team-queue 10/10；文档 ER/时序与实现一致；全仓 `taskAgent` 零命中（历史目录 + schema 冻结注释除外）。
  - QA happy：全量输出尾 + 退出码，证据 `su13.log`。QA failure：证伪记录，证据同文件。
  - Commit：`test: team-session sweep for specs/e2e/docs`.

- [x] 14. 隔离栈端到端实测
  - References：`docker-compose.yml`（aiagents 栈）；前 13 Todo acceptance。
  - Acceptance：scratch MySQL（用完即删）migrate + seed → 建团队→建任务→群 @ 执行→私聊→记忆 team 读写→验收归档截图存 `.omo/evidence/session-unification/final/`；共享 dev 库不动；测试数据可删。
  - QA happy：全链路截图 6+，证据目录。QA failure：失败截图 + 日志，证据同目录。
  - Commit：`chore: session-unification e2e evidence`.

- [x] 15. 种子 idGen 续号健壮性修复（T14 实测发现）
  - References：IdGeneratorService 及各 service 内联 `seedPrefix` 拷贝（执行期 grep `seedPrefix` 全枚举）、`server/prisma/seed.ts`（`tum_admin_seed` 非数字后缀触发）、相关 spec。
  - Acceptance：seedPrefix 跳过非数字后缀 id（仅在可解析行取 max）；fresh-seed 后首次建团队成员 201（回归单测锁定，复现 T14 首试 500）；`tsc` 零错误。
  - QA happy：回归单测绿，证据 `su15-happy.log`。QA failure：全非数字表 → 计数器从 0 起不断言崩溃（单测锁定），证据 `su15-failure.log`。
  - Commit：`fix(seed): idGen skips non-numeric seed ids`。

## Final verification wave

- [x] F1. 计划合规审计：工具 grep；命令 `grep -rn "taskAgent\|dispatchForTarget\|adoptNewInstanceRefByTask" server/src --include="*.ts" | grep -v spec | grep -v "冻结\|frozen"` 期望零命中；15/15 已合入；证据 `.omo/evidence/session-unification/final-F1.md`。
- [x] F2. 代码质量复核：工具 `npm run lint` + `npx tsc --noEmit`（server+web）；期望双双退出 0；无孤立 import/死文件；证据 `final-F2.md`。
- [x] F3. 真实 QA 通关：工具 jest/e2e/Playwright；`npm run test` + `test:e2e` 全绿；隔离栈走查截图齐；备份路径已记录；隔离库守卫：`export DATABASE_URL=mysql://root:<pw>@127.0.0.1:13306/su_e2e`（scratch MySQL 容器端口 13306，用完即删），前置断言 `[[ $DATABASE_URL == *":13306/"* ]] || exit 1`（禁共享 dev 库）；server 侧命令在 `server/` 下执行并 `> log 2>&1; echo EXIT:$?`；证据 `final-F3.md`。
- [x] F4. 范围保真：工具 grep + suite 重跑；排队/记忆/realtime/群聊分区与改造前一致；无新增 pid/兼容路由；外部会话改动 untouched；证据 `final-F4.md`。

## Commit strategy

- 每 Todo 独立提交（message 见各 Todo Commit 行）；破坏性变更（1/4/6/9/11）加 `!` 标记。
- Todo 6 合入前必须在证据目录留下 `mysqldump` 备份路径记录。
- 终验通过后可选 squash，由执行会话决定并报备。

## Success criteria

- 功能：单成员单团队会话跑通群聊、私聊、任务执行全链路；任务只作为数据流转。
- 数据：无 task-bound 会话行写入；TaskAgent 表消失；AgentQuestion 空 taskId 沿用既有写法。
- 质量：lint + tsc + 单测 + e2e 全绿；终验 grep 达标。
