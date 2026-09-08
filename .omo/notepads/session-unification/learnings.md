# Learnings — session-unification

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## Todo 4 — 会话写路径收敛 (2026-09-07)

- tasks.service.ts create 快照循环与 createInstances 内 `tx.session.create` 整段删除（仅删会话写，taskAgent 写保留）；createInstances 的 `status` 形参保留（tsconfig 无 noUnusedParameters，调用方不动）。
- teams.service.ts reset 重建行改 `taskId: null, taskAgentId: null`，delete-then-create 顺序不变（uk 约束要求先删后建）；另补 `deleteMany → create` invocationCallOrder 断言锁定顺序。
- spec 配套：create/add 的 `s_*` mockResolvedValueOnce 必须同步删除，否则 once 队列错位导致后续 te_/m_ id 断言漂移；session.create 旧断言改为 `not.toHaveBeenCalled()`。
- 并行 worktree 下 jest/tsc 可能撞上 sibling 文件的瞬时红（worker-dispatcher.ts BadRequestException、questions.service.spec.ts 语法错）：先验 scope（git status 限定 4 个文件 + tsc 按文件名过滤），重试一次确认 transient 后再记 foreign red，不碰 sibling 文件。
- Manual-QA 通道：jest + mock DB-shape 断言；live DB 证明递延 Todo 14（隔离栈实测）。

## Todo 2 — 任务六要素数据化 (2026-09-07)

- 六要素零 task 表读写：prompt 段/overrideModel/executionMode 全经 taskContext 传值，旧 taskRow 查询（teamId/mainAgentInstanceId/executionMode/projectId）整段不恢复；file 内残留 4 处 `prisma.task.findUnique` 均为 Todo 1/7/10 领地（dispatchAgentMention call-site + finalize/retry），本 Todo 零新增；`task.update/create` 全文件零命中（stop-writing 空验证即过）。
- 单触发器形状：task 段复用旧任务路径文案（chat_history/doclib/task_context 传 taskId + group_post {taskId}），team 段保持 Todo 1 字节不变；群聊指令按 `taskIdForPrompt ? GROUP : TEAM` 二选一，team_group/task_group 双 channel 类型都进分支（沿旧任务路径语义）。
- executionMode 400 必须放 dispatch() 环前快检（target 环内 try/catch 会吞成 onError 事件，抛不到调用方）；code `TASK_EXECUTION_MODE_INVALID`，沿 TEAM_SESSION_MISSING_DIMENSION  precedent。
- memoryIndex 仅任务模式构建（team 直聊 system 字节不变，旧用例零 mock 变更）；`prisma.memory` 经 try/catch 吞错返 null——无 memory mock 的 143 个旧用例无需改动；scoping 注：仅 prompt hint 富集，memorySave/Search 不动（Todo 9 拥有）。
- Failing-first 红绿：7 新测 5 红 2 绿（2 绿是 team-mode 不变性 + 主门已收敛的锁定项，符合预期）；6 个 Todo 1 interim 断言（含“归 Todo 2”标记）按合并语义更新，非回归。
- Adversarial：dirty_worktree（chat/ 下 6 sibling 文件未碰，diff 限定 2 文件）；misleading_success_output（证据 `> log 2>&1; echo EXIT:$?` 无管道）；stale_state N/A（单文件串行，无跨 Todo 状态依赖）。
- Manual-QA：jest + 字符串断言；live 递延 Todo 14（隔离栈实测），原因：单分派单元行为已由 mock 形状断言全覆盖，真机回流属 W4 范畴。

## Todo 11 — 重置端点团队路由 + toTaskDto 改组装 (2026-09-07)

- toTaskDto 改 async：team.findUnique（mainAgentMemberId）+ teamMember.findMany（含 agent）+ session.findMany（teamMemberId in + 非 archived）；findAll 须 `await Promise.all(rows.map(toTaskDto))`，其余调用点 `return this.toTaskDto(...)` 在 async 方法内自动拍平、无需加 await。
- DTO-only 查询去 include（create fresh/findAll/findOne/update post-update/updateExecutionMode/updateTeam fresh/updateInstance fresh/transition casFailed+fresh）；业务校验查询保留 include（update 初查/updateTeam 初查/transition 初查，供 teamInstancesOf 主实例门）。
- tasks.service.spec 里 session mock 缺 findMany：仅 teamId 非空且 members 非空的用例才需补 `(prisma.session as any).findMany = jest.fn()...`；无 teamId 的旧 row() 用例零改动即可过。
- teams resetMemberSession 语义对齐 bulk resetSessions：taskId/taskAgentId 恒 null、delete-then-create + TaskGroupInstance 软删先行；空会话成员仍建新行（非 bulk 式 early-return 0）。
- route-shape 断言放 tasks.controller.spec（原型方法 + PATH_METADATA sweep），新路由转发断言放 teams.controller.spec。
- 脏 worktree 下 git status 按目录过滤仍混入 sibling 改动（tasks DTOs/tasks.module/task-progression.scheduler 均为 import 重排类 foreign diff），以 `git diff` 抽查确认非本人改动后 itemize，不碰。

## Todo 3 — workdir 与执行键团队域统一 (2026-09-07)

- 调用点传真 taskId 即完成任务隔离：`resolveAgentWorkDir('', {taskAgentId:null}, …)` 改 `resolveAgentWorkDir(request.taskContext?.taskId ?? '', teamId)`；函数体砍掉 ta workDir→agent 名→任务级三级链，只剩 `taskId→tasks/<taskId> / 空→teams/<teamId>`（D2 按任务隔离）；`defaultAgentWorkDirPath` + `sanitizeWorkDirName` import 同删（本文件唯一引用，tsc 零错误）。
- 注册/watchdog 改名不改键：`executionKey/register/unregister/isAgentExecuting/startPendingWatchdog/clearPendingWatchdog/PendingDispatch.taskId` 的 `taskId` 形参改 `scope`（纯重命名，400+ 行外 Todo 5/7/10 调用点 positional 传参零影响）；`toExecutionScope` 逻辑不动（taskId 分支留给存量回流过渡，注释标明归 Todo 7/10）。
- Failing-first：stash src 只留 spec 跑 `-t Todo3` → 3 红（workdir 三项）2 绿（键复用/隔离已由 Todo 1 铺好，符合预期），证据 `su3-failingfirst.log`；恢复后全文件 153 绿 `su3-happy.log`，`-t 隔离冒烟` 1 绿 `su3-failure.log`，wecom  spec 9 绿（handleTaskCompleted 未碰）。
- 零命中是分区达成：自有区（分派/workdir/注册/watchdog）`taskAgentId/prisma.taskAgent/ta_` 代码零命中；残留 28 处全在他人领地（dispatchAgentMention→T5、completed/status→T7、fail/retry/resolveChannel/idle→T10、notify/group_post 协议串+MCP 兼容不动）+ 注释，逐项列出不碰。
- 脏 worktree：chat/ 下 7 sibling 文件（chat.service/message-dispatcher 等，属 Todo 1/2/5 已合入未提交）diff 抽查确认非本人后不动；本 Todo 只改 dispatcher + spec 两个文件。
- Manual-QA 通道：jest 键复用/隔离断言；live 递延 Todo 14（隔离栈实测），原因同 Todo 2（单分派单元行为 mock 全覆盖，真机回流属 W4）。
- Adversarial：dirty_worktree（上条）/ misleading_success_output（`> log 2>&1; echo EXIT:$?` 无管道）/ stale_state N/A（单文件串行，Todo 1/2 interim 断言按合并语义更新两处 F3 用例）。

## Todo 5 — 触发与回填收敛 team-only (2026-09-07)

- chat.service 是本 Todo 独占文件：buildTrigger 改 (teamId, row) 直查 `{teamId, teamMemberId}`，buildTeamTrigger 删除（与收敛后 buildTrigger 完全重复）；buildMainAgentTrigger 改 (teamId) 单参（mainAgentMemberId→首位成员，全部 ta_ remap 删除）；resolveMentions 全部分支合并为单团队循环（无 teamId 时经任务归属反查 teamId，任务只作归属数据）；getSessionHistory 任务分支删除（无 teamMemberId → 平台表回退）；convertSessionMessages senderInstanceId 改读 teamMemberId；TEAM_AGENT_SELECT 无引用后删除（findOne L330 内联 select 保留，不属本 Todo）。
- resolveMentions 整函数单次替换比重构补丁更稳（花括号配平一次过）；替换时 oldString 尾部多留一行会残留旧分支尾——删后 grep `return { mentionsStored` 计数校验（应仅 2 处：early-return + 结尾）。
- member 行无 id 时 buildTrigger 触发 instanceId: undefined，toEqual 自动忽略——旧用例 mock 行不加 id 即可零改动过；新用例用 tmm_ id 做精确断言。
- TeamMember 无 enabled 列：AGENT_DISABLED 分支保留防御性检查（恒不触发），旧 disabled 用例按“快照禁用不再阻塞团队触发”语义重写（dispatched + expectNoTaskResolve 锁）。
- ingress 文件此前干净（Todo 1/2/3 未碰）：只删 adoptNewInstanceRefByTask + resolvePlatformSessionId 尾部改 return undefined；adoptNewInstanceRef（唯一 running）保留；调用点全部已保 raw（question/storeSessionId、status/`?? payload.sessionId`、updated/emit null），本 Todo 零调用点改动。
- dispatcher 只碰 dispatchAgentMention 一函数：输入形状不变（Todo 10 的 3551 调用点零改动过 tsc），teamId 经任务归属取，会话 `{teamId, teamMemberId}` 单次直查；ta_ 调用方（自动恢复）改走抛错，由 Todo 10 收敛为 tmm_（串行链语义）。
- spec 配套：chat.service.spec 旧 taskAgent 触发 mock 全量改 teamMember（bulk replaceAll 一次过）+ faithfulTaskAgent helper 改 expectNoTaskResolve 锁；ingress 3 个 Bug2 用例按删除语义重写（952/1011），988 原语义即过；dispatcher FR-13 where 断言改 {teamId, teamMemberId} + 单次查询断言，4499 回退半段改精确抛错。
- 证据落盘注意：server/ 下执行 jest 相对路径 `.omo/...` 会写到 server/.omo，须 mv 到仓库根 .omo/evidence/session-unification（本次 su5-*.log 已搬运）。
- Failing-first：su5-chat-1.log 中途 2 红（新 team 形状断言 vs 旧代码），实现补齐后全绿；baseline 三文件 EXIT 0 已留存。
- 未提交：改动留工作区供 LANE-A 串行 Todo 7/10 衔接（沿 Todo 11 precedent）。
- Manual-QA 通道：jest + 精确值断言（ta_ 抛错全文、ses_abc 原样保留）；live 递延 Todo 14（隔离栈实测）。
- Adversarial：dirty_worktree（dispatcher 其余 hunks 均为 Todo 1/2/3 已合入，diff 抽查确认；ingress 文件此前干净；foreign red 无）/ misleading_success_output（`> log 2>&1; echo EXIT:$?` 无管道）/ stale_state N/A（一文件一次收敛）。

## Todo 7 — ingress/finalize 收敛 team-only (2026-09-07)

- ingress delta 单团队分支：会话 select 砍掉 taskAgentId + `if (!taskId)` 门（恒读团队行），senderInstanceId 恒 teamMemberId；任务私聊反查分支整段删，只剩 `{teamId, teamMemberId, type: private}` 单次直查；task_group/team_group 双跳过保留（存量群聊防御）。question（`''` 归因已是现状）与 completed（纯透传）零代码改动，只加单测锁定。
- dispatcher finalize 唯一实现 = handleTeamTaskCompleted（签名改为单 payload，返回 {agentId, teamMemberId, text, displayText, finalParts} 供下游 wecom/归档复用）；handleTaskCompleted 退化为归属门 + 幂等门 + 委托 + wecom/归档（任务终态分支整段删，~120 行）。message 落库 taskId = payload.taskId ?? null（归因照写）；emitFinal taskId 恒 scope（`team:<teamId>`）；groupFallback 保留 team_group + 存量 task_group 防御；无 session 兜底经任务归属反查团队 + agent 反查成员（不断流）。
- 有意不动：toExecutionScope 的 taskId 分支（注释写明归 Todo 7/10，实则调用方已全传 null；改签名会扩散到 Todo 10 的 fail/retry 键，留给 Todo 10 删）；resolveChannel/forwardToGroup/handleAgentStatus/handleTeamAgentStatus（Todo 10 领地）；extractConclusionParts 导出保留（dispatcher import 摘除，tsc 干净）。
- spec 配套：D5 describe 的 beforeEach 统一补团队会话 mock（20+ 用例零散补改一次收敛）；group_post 六处 `where?.agentId` 路由改 `teamMemberId`（bulk replaceAll）；task_group 终态化用例加 session mock 即过（skip 保留）；F3P1/ta_ 旧语义按团队重写（senderInstanceId tmm_）；4640 幂等用例改无 session 兜底 Variant（任务归属+成员 mock，两次各落库）。
- Failing-first：3 红（delta 团队直查、finalize 团队路径+scope、team_group scope）2 绿（question `''`、无团队 emitError 均已收敛属锁定项）；实现后 dispatcher 21 红→全绿，ingress 4 红→全绿；终态 230/230（3 suites）+ tsc EXIT 0。
- 证据 `.omo/evidence/session-unification/su7-happy.log`（3 suites EXIT 0）+ `su7-failure.log`（channel-missing skip：dispatcher emitError + ingress 双跳过，各 EXIT 0，注意 server/ 下用仓库根绝对路径落盘防写偏 server/.omo）。
- 未提交：改动留工作区供 LANE-A 串行 Todo 10 衔接（沿 Todo 5/11 precedent）。
- Manual-QA 通道：jest + scope 字符串/final shape 精确断言；live 递延 Todo 14（隔离栈实测），原因：回流单元行为已由团队会话 mock 全覆盖，真机 ses_ 回流属 W4 范畴。
- Adversarial：dirty_worktree（4 文件外 hunks 均为 Todo 1/2/3/5 已合入 + 他 lane 脏文件，`git diff --stat` 限定 4 文件确认零越界；schema/chat.service/message-dispatcher 零 diff）/ misleading_success_output（`> log 2>&1; echo EXIT:$?` 无管道，计 2 次状态检查内）/ stale_state N/A（Todo 5 的 adopt 删除语义保持，无跨 Todo 状态依赖）。

## Todo 10 — fail/retry/bind 归一 + resolveTeamChannel 唯一化 (2026-09-07)

- dispatcher 收敛三件套：handleAgentStatus 任务分支 + handleTeamAgentStatus 双实现合并为单团队函数（有 session 经会话反查团队维度，无 session 经任务归属 teamId + (teamId, agentId) 成员定位，维度不全跳过）；failProcessingMessage 删除（failTeamProcessingMessage 唯一）；resolveChannel 整函数删除（fail 删除后零调用方已 grep 确认，残留引用仅他文件注释不动）；markSessionIdleDead 键/广播统一 `team:` scope；tryAutoRestart(teamId, teamMemberId, taskId|null) 经 resolveTeamChannel + dispatchAgentMention（tmm_ 直调），纯团队直聊无 taskId 时跳过自动恢复（失败已落库+广播）。
- lifecycle 全团队键：bind 删 task-mode 分支（无团队维度即 400）；unbind/reset/reads 的 updateMany/findMany 全换 (teamId, teamMemberId) 键；reset 重建行 taskId/taskAgentId 恒 null + teamId 必填；getInstancesByTask 删除 → getInstancesByTeamMember 新增；调用方枚举（LSP 未安装用 grep 代）：仅 tasks.service 委托 + specs，无 controller 路由，迁移两委托 + tasks.module 一行注释。
- Failing-first：新 specs 先行 8 红（dispatcher 团队形状）+ 2 套件编译红（新方法不存在），证据 su10-failingfirst.log；实现后 5 套件 383 绿 su10-happy.log，failure 单测（未知 channel 跳过）su10-failure.log，tsc EXIT 0。
- 未提交：沿 Todo 5/7/11 precedent 留工作区（同文件堆叠 LANE-A/B hunks 不可独立提交，终验 squash 时统一处理）。
- Manual-QA 通道：jest + 精确值断言（scope 字符串/senderInstanceId=tmm/未知 channel 零写）；live 递延 Todo 14（隔离栈实测）。
- Adversarial：dirty_worktree（tasks.service.ts 其余 hunks 为 LANE-B 已合入，diff 抽查确认仅委托方法为本人；dispatcher 残留 taskAgentId 仅 prompt 类型注释区=Todo 2 领地）/ misleading_success_output（`> log 2>&1; echo EXIT:$?` 无管道）/ stale_state N/A（Todo 7 的 scope/兜底语义保持，idle 单测注释的“归 Todo 10”项已兑现）。

## Todo 6 — 删 TaskAgent 域：表 + 迁移删存量 task 会话行 (2026-09-07)

- 前置门实证：su8-happy 361 绿 + LANE-A（su1 143/su2 150/su3 153/su5/su7/su10 383 绿）全过；脏 worktree 下 schema/seed 已有 remove-project-dimension 未提交 hunks（diff 抽查确认非本人，不碰）。
- STEP ZERO：compose 本地库 mysqldump（docker exec aiagents-compose-db，生产零接触），1.85MB，路径记 su6-happy.log 首行；无备份即 BLOCKED。
- FK 预检（SHOW CREATE TABLE + information_schema 实证，禁硬编码）：全库零 FK 引用 task_agents；sessions/chat_channels.task_agent_id 均为无 FK 纯字符串列；DROP 前无需ALTER DROP FK。数据面：task 会话 15（删）、ta channel 0、task 记忆 0、managed task 1（回填源）、main_inst task 2（置空）。
- 代码面 taskAgent 非零命中（tasks/platform-mcp/chat/teams/workers/swagger-mcp 的 prisma.taskAgent，归 Todo 9/11）：删表后 tsc 断档属计划内（plan 括号明示），本 Todo 不碰 service/spec 文件。
- schema：删 TaskAgent 模型 + uk + 三处反向关系；tasks.mainAgentInstanceId 列保留（迁移置空）、mainAgentId FK 保留；uk_sessions_task_agent 保留冻结 + FROZEN 注释；Team 加 managedMode（Task 删）；`npx prisma validate` 一次过。
- 迁移 20260907000001_drop_task_agent_domain 按钉死顺序（删会话→channel 置空→删 task 记忆→teams 加列+回填→tasks 删列→main_inst 置空→DROP TABLE）；seed.ts 零 ta_/managedMode 引用，无需改动。
- Manual-QA：隔离 scratch MySQL(:13306) 上 deploy + seed 双绿 + 表/列 spot-check；failure 侧真执行 down -v（rm）/up（fresh run）重建再 deploy+seed 双绿；scratch 用后即删（receipt：ps 零残留），共享 dev 库零迁移（task_agents 表仍在）。
- Adversarial：dirty_worktree（上）/ misleading_success_output（`> log 2>&1; echo EXIT:$?` 无管道，状态检查 1 次）/ stale_state（scratch 已删；.omo/evidence 被 gitignore，证据留工作区）。

## Todo 12 — 前端团队化：订阅/守卫/重置/历史 (2026-09-07)

- 前置：LANE-A 全绿 + Todo 11 新路由已合入（POST /teams/:id/members/:memberId/reset-session → teams.service.resetMemberSession，返 {teamId, memberId, session}）；toTaskDto 已从团队会话行组装 sessionStatus/sessionId（成员面板状态源天然团队化，page 侧 sessionSeed 逻辑不动）。
- LANE-A 形状实证：dispatcher 回流载荷 taskId 恒 `team:<teamId>` scope 串（toExecutionScope(null, teamId)），ingress 侧 taskId 仅归因透传；message DTO 无 taskId 列——客户端无法按键过滤任务分区群消息，故 :597/:654 守卫改为 team 域放行（仅丢明确归属另一团队的 team: scope 串），群消息保持跨任务可见（REST 历史不断裂）。
- 脏 worktree：web/ 下 33 文件 foreign hunks（含本文件 loading-归一化/unread 红点大段 + use-sse/use-realtime cosmetic diff），本人只动 page.tsx 指定 4 处 + 新建 spec；SegmentedTabs 等 foreign work 原样保留。
- Manual-QA 通道：Playwright 全 route-mock（零后端写；reset POST 被 page.route 拦截不断言真实落库），/tmp 独立 config 运行（不碰 playwright.config.ts，Todo 13 拥有）；失败兜底：无会话成员显“就绪”截图。
- Adversarial：dirty_worktree（git status 先行 + diff 限定 page.tsx）/ misleading_success_output（截图目检）/ stale_state（mock 分 phase 重载）/ flaky_tests（rerun 一次）。

## Todo 9 — 记忆任务级删除 + 托管模式迁团队 (2026-09-07, W2)

- 起点实证：160 文件脏 worktree（LANE-A/B + Todo 6/8/10/11/12 全合入未提交）；本人域 git diff --name-only 限定 15 文件（memories×4 + platform-mcp×3 + dispatcher + questions×2 + msg-question-dispatcher + tasks×3 + teams×2），dispatcher 其余 hunks 为 Todo 1/2/3/5/7/10 已合入、只碰 memory-index 块。
- 基线：memories / platform-mcp / questions+teams 三套件 EXIT 0 + tsc EXIT 0（prisma client 未再生，taskAgent 引用仍编译过，Todo 13 拥有再生+迁移）。
- 设计钉死：MEMORY_LEVEL_INVALID 精确 code（PLATFORM_MCP_ERRORS + MEMORY_ERRORS 双常量，project 沿用 MEMORY_INVALID）；REST level=task 经 DTO IsIn + service 守卫双层 400；taskId 过滤从 DTO+service 整段删（Q1 不兼容）；questions scopeOf 改 async 团队 scope（{type:team}，无团队回退 global）；confirmByAgent 主门改 team.mainAgentMemberId；msg-question isSelfLoopTask 改 team.mainAgentMemberId + session.teamMemberId 比较。
- Failing-first：新测先行 2 红（memorySave level=task 400 精确 code；reply 未知团队 404），证据 su9-failingfirst.log。
- 未提交：沿 Todo 5/7/10/11 precedent 留工作区（同文件堆叠 hunks 不可独立提交，终验 squash 统一处理）。
- Manual-QA 通道：jest + 精确 code 断言（400 MEMORY_LEVEL_INVALID / 未知团队 404）；live 递延 Todo 14（隔离栈实测）。
- Adversarial：dirty_worktree（上）/ misleading_success_output（`> log 2>&1; echo EXIT:$?` 无管道）/ stale_state N/A（Todo 6 的 Team.managedMode 只读消费，零 schema 改动）。

## Todo 13 — sweep 记录 (2026-09-07)
- 枚举先行：全仓 taskAgent 命中远超 plan 显式清单（plan 列 tasks.service 仅 3 行，实际含快照写子系统 create/updateTeam/createInstances/updateInstance + 主门 6 处 + scheduler 全链路）。按 F1 零命中 + regen 后 tsc 绿倒逼全量迁移。
- 关键发现：regen 前 tsc 全绿是 stale client 假象（generated client 仍含 TaskAgent）。regen 唯一新增报错：ingress task.managedMode（tasks.managed_mode 已删）→ 改读 team.managedMode（Todo9 方向），后 tsc 零错。
- 主门统一为 team.mainAgentMemberId：tasks.transitionByAgent/start 预检、platform-mcp global/team_add、scheduler scan/dispatch、自环判定。旧列 mainAgentInstanceId 恒 null 导致旧门全 403/400（死门），属 Todo 6 后必然后果，非新行为。
- updateTeam 重实现到 team_members（add=建成员、remove=删成员+冻会话、主成员移除清 team.mainAgentMemberId）；updateInstance 降级为归属校验+透传（TeamMember 无 enabled/overrideModelId 列，分派期覆盖走 taskContext）。
- assertWorkerTask（任务维度）改经任务归属团队会话授权；teamIdOfTask 对显式 null 任务抛 404（保住既有 404 用例），未 mock（undefined）走 403。
- 证据：su13-baseline.log（改前 7 红/28 fail）→ su13.log（jest 25 fail 全同名预存 + e2e 11/11 + tsc 0）。integration 3 个基线红被本 Todo 修复（team 入口迁移）。
- 预存红：models×5/git-repos×5/docs-mirror×4/workers-gitRepo×5/agent.constants×6（与本 Todo 无关，foreign dirty；workers 5/5 rerun 确定性一致）。

## Todo 14 隔离栈实测 learnings（2026-09-08）
- 种子 id `tum_admin_seed` 非数字后缀 → `seedPrefix(id desc)` 首行解析失败 → idGen 从 0 续号 → 与 `tum_0000000001` 碰撞，建团队首试 500，retry-once 通过。产品侧 bug（种子/idGen 续号），后续修，不在本 Todo 动。
- 无 worker 隔离栈仍可走真实回流：分派自动建团队会话（s_, task_id NULL）→ 注册仿真 worker → `message.part.delta`(202) → DM 落 agent 消息。群聊 delta 无 private 频道会被设计性跳过（群回复只经 group_post），仿真回复应打 DM 频道。
- `memory_save(level=task)` 在 MCP zod 层即被拒（JSON-RPC -32602，HTTP 信封 200），service 层 `MEMORY_LEVEL_INVALID` 400 保留给非-zod 路径；负向证据写法需注明信封语义。
- worker 注册必填 `load: {instances}`（WorkerLoadDto），缺则 400；`x-worker-id` header 是团队维度归属校验必需（缺 → 403 MISSING_WORKER_ID）；delta 的 `sessionId` 传 `s_` 平台主键可直通，`ses_` 才走 instanceRef 反查/adopt。
- 任务 start 前置要团队 mainAgent（`MAIN_AGENT_NOT_SET` 400）； accep→archive 链 start→mark-pending-review→accept→archive 逐段 200。
- web 无 `/board` 路由（跳 `/teams`），任务证据用团队详情页 + API 日志；`/memories` 页直接展示团队记忆卡。
- 守卫经验：全程 `[[ $DATABASE_URL == *":13306/"* ]]`；zsh 下 `&` 的 URL 必须加引号；共享库零行断言 + containers pre/post 双文件是终验 F3 直接证据。

## F1 — 计划合规审计 (2026-09-07)

- F1 exact grep (`server/src --include="*.ts"` + `grep -v spec` + `grep -v 冻结|frozen`) returns EMPTY (EXIT:1); adversarial unfiltered sweep also EMPTY — stronger than plan expectation, nothing hides behind the allowlist.
- Extended sweep (`server`+`web`, ts/tsx/prisma): only `server/node_modules/.prisma/client` generated artifacts hit `taskAgent`; `web/` zero hits. Out of F1 scope, no action.
- `server/prisma/schema.prisma` retains `taskAgentId` plain-string cols + 冻结/FROZEN comments BY DESIGN (Todo 6 acceptance: uk_sessions_task_agent frozen, no backfill); T13 allows history + schema-frozen exceptions. Not in F1 `*.ts` scope anyway.
- 15/15 implementation Todos all `[x]` verified via plan read + grep count; F1–F4 wave boxes correctly still `[ ]`. Verdict APPROVE, evidence `final-F1.md`. Zero product/spec/doc edits (read-only audit).
- 2026-09-07 F4 session-unification scope-fidelity: APPROVE (tasks 153/153, teams/questions 113/113, team-queue e2e 10/10; no pid/compat routes; su6 backup present; foreign draft+SegmentedTabs untouched; zero code edits). Evidence: .omo/evidence/session-unification/final-F4.md

## F2 — 代码质量复核 (2026-09-08)

- 4/4 gates EXIT 0 with bodies verified (anti-misleading_success_output: tail + byte-count each log, never trust echo alone): server lint 0 err/44 warn, web lint 0 err/738 warn, server tsc empty-clean, web tsc empty-clean (no `.next` ghost → no cache clear needed, documented in final-F2.md §3).
- Warning profile: server = 41 no-unused-vars + 3 no-require-imports; web = 694 no-unused-expressions + 24 no-unused-vars + 9 exhaustive-deps + 6 no-explicit-any + 5 no-img-element. All style-level, pre-existing, non-blocking.
- Orphan sweep (`server/src` excl. specs, F1 frozen-comment pattern): dispatchForTarget / adoptNewInstanceRefByTask / taskAgent all 0 hits (grep EXIT:1); web/ 0 hits. memory-level `task`/`project` code refs = ONLY intentional Todo-9 400 guards (`platform-mcp.service.ts:1306/1315`). Verdict APPROVE, evidence `final-F2.md`.
- Watch-out: `tasks.service.ts:1176` acceptance prompt prose still tells main-agent to memory_save with deleted `level:"task"`/`"project"` — graceful 400-with-redirect at runtime, not an孤立 import, so F2-legal; flagged non-blocking for F4 reword. F2 rule "red exit → REJECT, do not fix" + read-only held: zero product edits.
- Opsec slip to avoid: relative log path under `server/` cwd wrote first lint log to `server/.omo/...`; moved to repo-root evidence dir. Always use repo-root-anchored paths for evidence redirection.
- 2026-09-07 F3 session-unification isolated-stack QA: REJECT — `resetMemberSession` (teams.service.ts:911-920) creates the replacement session WITHOUT `teamId`/`teamMemberKey` (only id/taskId:null/agentId/teamMemberId/status). Proven on scratch :13306: (1) post-reset MCP `memory_save(level=team)` → 403 PLATFORM_MCP_FORBIDDEN even after simulated worker pickup (assertWorkerTeam needs teamId+workerId+teamMemberId match); (2) next DM dispatch mints a SECOND row s_0000000005 WITH team_id while orphan s_0000000004 (team_id NULL) persists — D3 single-member-single-session violated. Fix pointer: include `teamId` + `teamMemberKey: teamId|memberId` in the create (mirrors ensureTeamSession teamId-required rule), then re-run CONFIRM-2/4. Headline flow otherwise green (team201/task201/group@201/DM201/delta202x2/streaming-accumulate/reset201/old-route404/managedMode/mcp-task-negative-32602/start400-then-archive; T15 seed fix verified first-try 201; 25 unit failures stash-proven pre-existing on HEAD; e2e 11/11). Scratch fully cleaned, shared stack untouched. Evidence: .omo/evidence/session-unification/final-F3/final-F3.md

## Todo 11 fix — reset 行补 teamId (F3 live 回归)

- resetMemberSession 的 session.create 必须带 `teamId`：teamMemberKey 系 STORED 生成列（task_id 为空时 = team_id|team_member_id），缺 teamId 则新行脱离 uk_sessions_team_member 单会话约束 → D3 破坏 + memory_save team 403 + 下次分派再 mint 一行。
- 仅加 `teamId: teamId`，teamMemberKey 无需显式写；taskAgentId 未动（保持既有形状，最小修复）。
- 回归 spec：create 断言加 teamId + 捕获 createdData 做 team 域 follow-up findFirst（memory_save 形）可解析；pre-fix 下 teamId 断言即红。
- 2026-09-07 F3 re-verify session-unification after resetMemberSession teamId fix: APPROVE — fresh scratch :13306 (su-f3r-db, cleaned): reset row carries team_id + derived team_member_key; CONFIRM-2 memory_save team → 200 me_0000000001 + read total=1 on reset row; CONFIRM-4 re-dispatch reuses same row (REUSE_OK, 1 row/member, no orphan). teamMemberKey is a STORED generated column (no app write needed). Shared stack untouched (1/3/20, leak 0). Zero product edits this pass. Evidence: final-F3/final-F3.md + reverify.log/sh.

## deploy-su-clean — 生产等价 clean-slate 实测 (2026-09-08)

- `down -v` 后 `--build` 一次过：init 跑全 40 迁移（含 drop_task_agent_domain）+ seed；health 200 才开测。早期间歇 502 是 proxy  env（127.0.0.1:7890 拦截 localhost）+ server warmup 叠加：curl 200 / python 502 是 bypass 差异造成，python 侧 `ProxyHandler({})` + curl `--noproxy '*'` 即解；secret（token/WORKER_TOKEN）只放 /tmp，日志统一 redact。
- T15 回归过：建团队首试 201（tm_0000000002），tum 续号正常；任务 start 前置仍要先 PATCH mainAgentMemberId（否则 MAIN_AGENT_NOT_SET 400）。
- 真机回流全链路通：DM 201 dispatched → ~10s 内 agent 回复（含 reasoning parts，senderInstanceId=tmm_）；group @ warm 路径经 group_post 回流 m_0012/m_0016；memory_save(level=team)+selfInstanceId → me_0000000001（sessionId=s_0000000001, taskId=null）→ GET read-back total=1；level=task 在 REST 400 与 MCP -32602 双层被拒。
- F-A（cold-start 静默丢分派）：有 current task 但尚无 team session 时的 group @ → 201 + no_session，无 dispatch、无报错、无建会话（effectiveTaskId 继承 current task 致 flip 分支 :889 跳过）；任一 team session 存在后同调用即 dispatched。复现证据 GROUP-AT vs GROUP-AT-T2。
- F-B（归档毒化群频道）：latest task archived 后 team_group POST → 409 TASK_ARCHIVED（resolveChannelAccess :1599 findFirst latest + :819 guard）；新建 pending task（currentTask 路径）即解。证据 GROUP-AT-RETRY。
- 生命周期后会话行保持 team 域：archive 后 s_0000000001 行 team_id 在、task_id NULL；toTaskDto 照常组装 sessionStatus（running/idle）。
- UI 现状：/board 跳 /teams；/tasks 与 /tasks/:id 无 web 路由（抽屉 UI，任务证据走 API + issues 页）；memories 页仍有“任务”Tab（点之 400，cosmetic）；session 页 plans?taskId= 404 为 pre-existing noise，页功能完整。
- 浏览器实测：Chrome executablePath 直驱 + getByText(/私聊/)（半角冒号）+ DM 占位符“发送私聊给 …”；console triage 只收 3 个资源 404。
- 本 pass 零产品改动（find mtime 有命中是 sibling lane 并发在改；本人只写 .omo/evidence + 本 append）。
- 残留：tm_0000000002/t_0000000001(archived)/t_0000000002(pending current)/is_0000000001(closed)/me_0000000001/c_0000000002-3/s_0000000001 待后清；栈保持运行。

## group-send-fixes — F-A 冷启动 + F-B 归档降级 (2026-09-08)

- F-A 修法：`!effectiveTaskId` 门是零任务时代的残留，task-mode 同样要 ensure；删门后 cold-start @agent 经 `buildTeamMemberTrigger`(ensureTeamSession) 翻 dispatched，首条即分派（live：s_0000000002 即建 + agent 回流 m_0000000029+）。queued 拦截在后不受影响；单成员 ensure 失败保留 no_session（FR-21 形）。
- F-B 修法：团队频道 archived 不再 409，降级团队直聊（task 合成 pending + effectiveTaskId=null + dispatch taskId:''）；fallback `findFirst` 加 `status:{not:archived}` 使最新归档不再占位；legacy task_group 保持 409，403/404 不动（live：c_0000000004 201 + m_0000000028 团队直聊回复，非成员仍 403）。
- 红先行：新 group-send-fixes 三 spec 在 pre-fix 下 2 failed；修后 chat 110 / chat+teams 360 全绿，tsc clean；server 容器单独 rebuild 验证（`build server + up -d server`，未 down -v、未改存量行）。
- 探针教训：python urllib 走环境 proxy 会 502 而 curl 直通 200——live 探针统一 curl 或 `ProxyHandler({})`；F-B 复现须 fresh team 走完 mainAgent→start→review→accept→archive 全链（start 前置 MAIN_AGENT_NOT_SET）。
- 残留：tm_0000000003/t_0000000003(archived)/c_0000000004/s_0000000002/s_0000000003 + fa/fb 探针消息（m_0000000019-38 段）；证据 .omo/evidence/group-send-fixes/。

## web-rebuild-2 — commit 保全 + web 单体重建 + spinner 取证 (2026-09-08)

- 脏树含双 plan（SU todos 1-15 全 x＋RPD todos 1-12 全 x）＋DM 跟进＋外会话草稿：按 concern 拆三 commit（eb0baa0 refactor(session)! / 5e07244 fix(chat) session-page / 9e743d0 chore foreign），中文 CJK 文件名须 `core.quotepath=off` 否则 add 静默失败；149 改＋21 新增核对 `diff --cached --name-only` 与排除 5 项一致后才 commit；secrets 扫 diff 仅文档字样＋空 secrets 对象。
- RPD 与 SU 同文件交织（tasks/teams/chat/memories/realtime/platform-mcp/session 页）无法按 hunk 经济拆分——合为原子 refactor 并在 body 注明 RPD 归属；SegmentedTabs（skills/memories/integrations/git-repos 统一样式，e2e testid 不变）无法确权归属则 keep＋note，不强行拆 foreign。
- `docker compose up -d --build web` 仅 web：aiagents-web 5ff199c05bec(08:12)→73dd8b727bdc(08:57)，healthy，:13001 200；db/server/worker uptime 连续未动。 served chunk 直 grep `dm-tab-spin` 命中 page-0a58d5732c3dd5b0.js——stale-bundle 排除法优先于反复点页面。
- Spinner 抓拍教训（诚实未命中）：复用会话 DM dispatch→首回复实测恒 ~3s（3 次 POST 201 全周期完成），MCP roundtrip 数秒＋150ms 页内 observer 仍可能因“分派排队超 30s”（P0 风暴期 worker 饱和）而零命中。逻辑链已审计闭环：dispatcher 同步 broadcast AGENT_LOADING{instanceId: teamMemberId} team-scope → onAgentLoading 按 instanceId??agentId 入表 → isTabLoading 查 instKey/m.id/tmmAlias（DB senderInstanceId=tmm_0000000003 佐证同域）；附带机制 live 目击（红点 dm-tab-unread-tmm_0000000001/2/3＋会话运行中＋成员卡）。下次抓 spinner：重置成员会话后 cold-start（30s+ 窗口）或 observer 命中即自动截图脚本。
- 并发 P0 时段 footprint 纪律：DM 回复经 group_post 工具会镜像进群（"在" m_0000000109 等），私聊验证也会漏群消息；误投群 1 条（active tab 切走后 fill+Enter 跟随当前 tab）。已在 web-rebuild-2/NOTES.md 全量披露未擅删；教训：先 GET activeTab/placeholder 断言再 send，且 P0 进行中尽量只观察不触发。

## roles-rename — 角色页去项目化文案 (2026-09-08)

- 改动仅 roles/page.tsx 3 行：roleLabel member `项目成员`→`团队成员`（含 204 行注释同步），roleDesc admin `项目生命周期`→`团队管理`；匹配全走 `role.name ===` 键（grep 实证），seed 键/permissionScope/IMPLEMENTED_PERMISSIONS/`projects.create` 零动。
- sweep 结论：web 内 `项目成员` 仅此一处 UI 命中；server 残留全是注释/swagger（plans/docs-site/platform-mcp，属后端不碰）；users 页/app-shell ROLE_LABEL 无项目字样；`project_manager` 系 Agent 角色（tools/register、teams/new、tokens）一律不碰；nav-top-bar 默认 `userRole="项目管理员"` 仅 user=null 回退（app-shell 登录态恒传显式 roleLabel），属全局 chrome 非 roles/member flow，按 scoped-diff 纪律不动并如实记录。
- e2e 零旧串断言（pages.spec roles 用例只查 testid），故 e2e 只读不改；验证链 tsc 0 + eslint 0（空日志）→ `up -d --build web`（web 镜像 bb681f8e，:13001 200；init/server 镜像连带重建属已知行为，server 重启后 health 200，db/worker uptime 未动）→ /tmp 外置 config 因模块解析失败，改放 web/ 根临时 spec+config（跑完即删，e2e/ 只读）→ live 断言新串可见+旧串 0 命中+截图。
- Adversarial：dirty_worktree（scoped diff 仅 roles 页 3 行；tasks/new、session 页、use-sse 等为 sibling lane foreign，不碰）/ misleading_success_output（live :13001 断言+截图，非 dev）/ stale_state（新镜像 Created ~1min + 容器 Started 02:40:35Z 双时间戳）。

## team-loading-filter — team: scope 丢 team: 前缀 loading (2026-09-08)

- 根因单测先行：`team:` 分支旧 `payload.taskId === id` 对 `team:<id>` 恒 false（dispatcher 经 toExecutionScope 广播恒带前缀）；repro-pre.log 4 红（loading/error/status/question）5 绿，红项恰为四类前缀事件，与“红点正常走 channel: 分支”现象自洽。
- 修法：`taskId === id || taskId === \`team:${id}\`` 双形状；SSEEvent 信封无 scopeType/scopeId（仅 id/type/payload/timestamp），故不依赖信封匹配，注释写明取舍。task:/channel:/global 三分支审计后不动：task: 对裸 taskId（toExecutionScope 有 taskId 即返裸 id）+ 会话页已不再订阅 task:；channel: 按 channelId 与前缀正交。
- web 无 jest/vitest 且禁新依赖 → 回归用 node 内置 test/runner（`web/hooks/use-sse.scope.test.mjs`），从 shipped 源码实时提取 matchesScope 转译后测，非拷贝；`node --test` 9/9 绿。eslint 有 1 条 `no-assign-module-variable`（变量名 `module` 撞 Next 规则）→ 改名即过；use-sse.ts:253 exhaustive-deps 警告为 pre-existing（F2 画像内），不动。
- `up -d --build web` 会连带 rebuild+recreate init/server 镜像与容器（源未改，内容同），db/worker 不动；server 重启后须验 health 200 + 登录 + 团队数（本次 4 个 intact），证据如实记 init/server Recreate。stale_state 对冲：源码 mtime（09:24）< 新镜像 Created（09:29:30，8129c8f0b523 ← 73dd8b727bdc）。
- Live 抓 spinner：先调 reset-session 造 cold-start（s_0000000012）拉长窗口；DM tab 先断言 placeholder（“发送私聊给 …”）再 send 防误投群；命中后立刻全页截图 + tab 元素截图 + DOM 取证（visible testids + spinner innerHTML/aria-label）。旧代码下 spinner 永不可见，故 live 命中本身即新包生效证明。console 仅已知 /plans?taskId= 404 噪音。

## managed-toggle — 托管模式团队级 rewiring (2026-09-08)

- 死写定位：`managedModeMutation` PATCH `/tasks/:id` + 面板读 `task.managedMode` + 创建表单 POST 带 `managedMode`，三处全死（后端已搬 team，tasks 端忽略）；readers（question.managedMode 三处）不动。
- 修法四文件：teams.ts DTO/update 加 managedMode（GET 本来就带，toTeamDto 输出确认后前端类型补齐即可）；mutation 经 `teamsApi.update(teamId, …)`，缓存键 `["task", id]`→`["team", teamId]`；面板 switch 读 `team?.managedMode ?? false`（props 形状不变）；TaskForm 为文件内私有单调用者，grep 确认后直接删 props/state/POST 字段。
- 验证链：API PATCH→re-GET 双向持久 + Playwright live :13001（seed-admin，tm_0000000001）点 switch→断言 PATCH body→reload 后 `aria-checked` 保持→翻回原值零残留；证据 `.omo/evidence/managed-toggle/`（fix-note/tsc/eslint/playwright/api-persist/rebuild log + 3 截图）。
- Adversarial：dirty_worktree（`web/hooks/use-sse.ts` + ledger/learnings 改动为先前 foreign 状态，scoped diff 仅 4 文件，未碰）；stale_state（`aiagents-compose-web` Created 01:53:19Z > rebuild 窗口，server/db/worker uptime 未动）；playwright 临时 spec/config 放 web/ 根跑完即删（e2e/ 只读未碰，git 无残留）。

## models-sync — agent-config 下拉 stale 根因与可见性权威修复 (2026-09-08)

- 根因双写者：可见性状态（models.enabled + worker_model_availabilities）有两个写者——live 权威 `syncLiveModels`（models.service.ts:444-555）与 worker 注册快照 `syncFromWorkerCapabilities → upsertCatalogModel`（356-390/629-649，后者新建行 enabled 缺省 true，schema @default(true)）。worker capabilities.models 是启动时快照（live 实测数千条），上游免费模型轮换后快照变 stale：注册即把 stale opencode 行以 enabled=true+availability 写回目录，page（available-models → listCatalogModels enabled∩availability，agents.service.ts:300-304）即显示 stale；仅手动 POST /sync 收敛（本次 sync disabled 6205，总 6213 行；之后 providerID=opencode 恰 8 行 md_1688-95）。
- 修法（仅 models.service.ts）：快照路径新建 opencode/* 行 `enabled:false`（候选登记不授可见性，授權唯一归 sync 的 upsertAndEnable；非 opencode/local/custom/admin 语义不动）；同步清理 deleteMany 加 `model:{enabled:false}`（stale 快照不再 strip live 已确认行的 availability，CONF-01 假模型清理保留——假模型本就新建 disabled）。page 读路径零改（已是同一真相源），web/ 零硬编码模型表（grep 空命中实证，STATIC_AVAILABLE_MODELS=[]）。
- 用户断言核验：`opencode/nemotron-3.5-lightning-free` 不在 sync liveModels 8 名单 → 按上游真相判 stale，排除正确。
- spec 现状：models.service.spec 的 2 个 listCatalogModels 旧测在 availability 门加上后即红（mock 缺 findMany，属 T13 models 预存红一部分），本次顺手补齐（findMany mock + 行 id + select 含 id 断言对齐实现）；controller DTO×3 + workers git×5 共 8 红经 stash 前后对照证实为 pre-existing foreign，与本 diff 无关。
- 验证链：jest models+agents 75/75（含 failing-first 2 红→绿：新建可见性 2 测 pre-fix 红，log 留存）+ server tsc/eslint 空 + web tsc 空/eslint 0 err；`up -d --build server` 仅 server 镜像 04659a6f→e25c6ea9（web/worker 镜像与 db/worker/web 容器 StartedAt 未动，teams=4 intact）；live :13001 Playwright：dropdown DOM 恰 8 live、4 stale 零命中（DROPDOWN_IDS 落 playwright.log）+ 双截图（原生 select 收起态，目检 "未设置" 下拉存在）。
- 教训：原生 <select> 截图恒收起——可视化证据以 DOM 断言 + 日志为准，截图仅作页面状态佐证；workdir 陷阱：git pathspec 相对 repo 根，server/ 下跑 jest、根下跑 git stash（本次空转两次才对齐）。

## models-truth — sync 真值源倒向 worker 可执行集 (2026-09-08)

- 根因定锤三证据：旧 serve（00:14Z 启动）`/api/model` 26 行 8 active 恰等于 sync 8 bogus；新 serve（04:03Z 启动，同 Dockerfile pin 1.18.16）`/api/model` 31 行 7 active 恰等于 CLI 7——serve 注册表是启动时一次性加载、免费轮换即 stale；CLI（`opencode models`=Provider.list()，sst/opencode models.ts）每次 fresh 加载 + 鉴权过滤 = 可执行真值，且 1.18.29/1.18.16 双版本一致。Zen 公共端点（70 models，含全部 CLI 7）不含 ling-3.0-tiny/laguna/longcat/north-mini-code 四者 = 退市铁证。
- 排除 naive-(a)：capabilities.models 是 7507 行无 key junk（V1Driver.listModels 注释/spec 写 key 过滤但实现全量 push，v1-driver.spec 2 红 pre-existing 在 HEAD 即红，本 diff 零碰该文件）——snapshot 永不授可见性，否则复活数千 junk。
- 修法（server-only 不够，worker-report 唯一精确收敛）：worker `resolveExecutableModels()` spawnSync `opencode models`（15s 超时，仿 mcp-status-probe；失败/空→undefined 永不断言零可用）→ capabilities.executableModels（register/reRegister 全覆盖）；server DTO 加同名字段（whitelist 会 strip，不加 registration 链路丢字段——workers.service 逻辑零改）；syncLiveModels 优先 union 上报集、旧 worker 回退 /api/model；upsert+enable/孤儿禁用/快照 enabled:false 三语义全保留。
- disabled 6205→0→1720 是预期剪枝（5 bogus + 1715 无凭据 junk，providers 全 configured=False 实证；total disabled 7925=6205+1720），非数据丢失；local/custom/凭据 provider 由既有孤儿规则跳过（未碰）。
- 首 sync 空结果是正确行为：新 worker 容器仍在 boot probes（offline）→ offline 不剪枝；online 后重跑即 synced:7/disabled:1720/live=CLI 7。status 检查教训：sync 空先查 worker status 再怀疑代码。
- 旧容器 CLI 1.18.29 vs Dockerfile pin 1.18.16：opencode 会自更新，容器内二进制版本会漂移——版本断言以 `opencode models` 输出为准，不以 --version 为准。
- 脏 worktree 纪律：7 文件 scoped（models.service+spec、register-worker.dto、worker index+spec、protocol+contract），roles/session/use-sse/teams/TeamRightPanel/tasks-new 全系 sibling foreign；pre-existing 红（workers.service git-creds×5、v1-driver×2）以“零 diff 文件 + HEAD 即红”定性，不碰。
- 原生 select 可视化仍以 DOM 断言为准（DROPDOWN_IDS 落 playwright.log），tmp spec/config 放 web/ 根跑完即删。

## models-credential — 凭据可见性双触发收敛 (2026-09-08)

- 用户症状根因是 STALE SYNC STATE 非逻辑 bug：DB 时间戳铁证——opencode-go 键 06:13:15Z 建，8 行 dis 禁于 03:19Z/04:05Z（当时无凭据，禁得对），27 行于 06:13:41Z 被用户手动 sync 救回。可见性重算此前只靠手动 POST /sync。
- 双触发缺一不可（时序证明）：save 时 worker 还没拿到 key（heartbeat 下发~10s 后），saveATP同步旧 offering 无可见效果；reRegister 时 offering 已变但快照只恢复 availability 永不 enable——故 set/revoke 尾 + register 尾各 best-effort sync 一次，失败只 warn 永不阻断主流程（保存/注册）。
- 凭据密钥零接触：live 验证用一次性 dummy key（value 永不落盘/日志，仅服务端 masked fingerprint），用户真 key 全程未读未用；事后 revoke 清零，残留仅 revoked 审计行（by design）+ worker auth.json 经 replay/restart 自愈。
- 中止 run 收尾纪律：先查残留（model_credentials 表多出 mc_0000000002 dummy）再验证；revoke 本身即新代码路径的 live 演练。
- 空 sync/空 prune 都是正常态：offline→空回（verified earlier）；converged 重 sync→零写（verified：re-register 后 DB 无 churn，log 无剪枝行）。
- 脏 worktree 下 revert-check 标准动作：root 下 `git stash push -- <file>`→server/ 下跑 jest→pop；server/ 下直接 stash 会 pathspec 翻倍空转（已踩两次）。
- Playwright 断言用 `go.length>0 + 关键 id + bogus 缺席` 三段式，比精确计数更抗轮换漂移（本 session 轮换稳定故 34 精确亦成立）。

## worker-browser-diagnosis — agent-browser singleton contention (2026-09-08)
- WHAT: agent-browser (Vercel Rust) + Chrome-for-Testing (x64) / apt chromium fallback (ARM64); NOT playwright/CDP-in-worker. Dockerfile:23,46-57; shim spawnSync bare in worker/src/browser/browser-tools.ts:67. Headless default; only Chrome flags AGENT_BROWSER_ARGS=--no-sandbox,--disable-gpu (Dockerfile:78, compose:144).
- ISOLATION: none. No --session/--profile/--context/--cdp in worker/src (grep zero); single <workDir>/.opencode/tools/browser.ts (browser-tools.ts:78-87) on singleton serve (index.ts:555-559); concurrency = maxInstances=5 ses_* on one serve (exec-server.ts:13-14) with counter-only instance-tracker.ts (no lock).
- CONTENTION: shared default daemon/profile in shared HOME /root (worker_home volume, compose:165) -> single active tab + single user-data-dir lock (DevToolsActivePort). Upstream #896/#1378: second launch with same profile attaches to first Chrome -> tab hijack/accumulation, nav timeout, cookie leak (--session alone != storage isolation, needs BrowserContext/--context per #1068/#1114).
- VERDICT: cannot multi-open; breaks = tab hijack, @eX ref invalidation, cookie leak, concurrent open timeout. MIN SURFACE: inject --session/--profile|--context per ses_ in renderBrowserToolsFile, scope user-data-dir per agent under /data/vteam-worker, add mutex/queue or BrowserContext, handle daemon lifecycle/ports.

## worker-browser-isolation — per-agent isolation option A (2026-09-08)
- CLI 实证优先：`agent-browser 0.27.0` 有 `--session`（独立 daemon sock/tabs/cookies/storage，skill 文档原话）+ `--profile <path>`（真实 user-data-dir，DevToolsActivePort 锁在 dir 内），无 `--context`——诊断篇的 BrowserContext 假设被证伪，本版只需两 flag。
- 身份透传关键：opencode plugin `ToolContext`（tool.d.ts）自带 `sessionID/directory/agent`——shim `execute(args, context)` 直接取，无全局可变 current-session，无需按执行重写共享工具文件（单 serve 单 browser.ts，多 ses_ 共存）。
- `--profile ignored: daemon already running` 系良性（首次 open 已 honored、dir 落盘 Default/ 等；后继命令不能 retarget 已正确隔离的 live daemon）。
- 并发无需 mutex：双 `--session` 并发 open 均 exit 0 + 独立 .sock（诊断篇担心的全局锁不存在）；`close --all` shim 内拒掉；profile 保留（登录持久，volume 持久化）。
- 脏 worktree 纪律：index.ts/contract.spec 等含 sibling lane（models-truth）foreign hunks，本 diff 限定 browser-tools/exec-server/index.ts 一行 wiring + 新 spec；`git stash` 跑单测须在 repo 根且只列 tracked 文件（untracked 新 spec 会致 pathspec 失败）。
- v1-driver.spec 2 红经 stash 证实 HEAD 即红（foreign pre-existing）；server eslint 6 errors 全在 chat.service(.spec).ts foreign 文件；worker 无 eslint 配置（tsc 即门）。
- live 证明须进 NEW worker 容器（rebuild 后 Created 变更）跑真实 CLI；cookie/localStorage 值一律 redact（名断言留存）。
