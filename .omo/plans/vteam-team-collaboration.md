# vteam-team-collaboration - Work Plan

## TL;DR (For humans)

**What you'll get:** vteam 平台升级为"有纪律的团队协作平台"：① 执行计划成为平台数据（任务启动前主 Agent 提交结构化计划 → 成员/用户评审 → 按计划任务逐项推进，同角色多实例可并行领任务）；② 任务级执行模式切换（直接模式轻量默认 / 计划模式按需开启）；③ Agent 性格维度（沉稳/苛刻/激进/保守/创新，可配置）；④ 团队感知与自治（Agent 可查看团队结构、主 Agent 可申请增员）。

**Why this approach:** 借鉴 omo「计划是平台追踪的执行契约、不是模型自维护的文档」哲学——计划数据化后可校验、可追踪、可联动、可复用；模式切换对齐 omo「默认轻量 + 按需开启」；协议层机制（计划/评审/感知/自治）挂在平台协议层（MCP 工具/数据表/状态机/系统提示段），**不绑定任何 agent 角色**，新建 agent 零配置即受约束；**persona 与 plan 模式为按需配置（Oracle M7：例外显式点名）**。

**What it will NOT do:** 不做 agent 完全自治（增员须用户/托管确认门）；不做计划/性格的 Web 管理界面（后续迭代）；不改任务状态机迁移逻辑本身（仅加条件校验分支）；不做 P3 远期增强（todo 级强制巡检、技能权限语义、多视角评审）。

**Effort:** Large（8 个实现任务，跨 plans/platform-mcp/tasks/worker-dispatcher/agents 五域）
**Risk:** Medium - 计划机制侵入状态机与系统提示（均为增量分支，direct 模式零行为变化）；双时点评审与 L2 自治为协作流程增强
**Decisions to sanity-check:** ① `execution_mode` 默认 direct（轻量），plan 按需开启 ② 评审位不绑角色（用户默认/主 Agent 指派任意成员，默认放行只拦 blocker）③ persona 保存时渲染进 prompt（存量 agent 不动）④ L2 增员经 question_confirm 确认门（L3 完全自治 out）

Your next move: 审阅本计划后启动执行（`$start-work vteam-team-collaboration`），或先运行高精度评审。完整执行细节见下文。

---

> TL;DR (machine): Large effort, Medium risk — vteam 团队协作增强（计划平台化 plans/plan_tasks + execution_mode 模式切换 + 双时点评审 + persona 性格 + team_view/my_profile 感知 + L2 增员自治），8 实现任务 + F1-F4 终验。

## Scope
### Must have
- **tc-store**：`plans` 表（pl_ 前缀/taskId 唯一/title/summary/scopeIn/scopeOut/status draft→reviewing→approved→rejected→executing→completed/createdBy）+ `plan_tasks` 表（pt_/planId/seq/title/content 六要素 Json/**assigneeInstanceId**/status pending→in_progress→done→blocked→skipped）+ `tasks.execution_mode`（direct\|plan，默认 direct）+ 迁移 + PlansModule（resyncIdPrefix pl_/pt_）
- **tc-mcp-plan**：MCP `plan_submit`（六要素结构校验）/ `plan_review`（approved/rejected 附 reason）/ `plan_task_transition`（进度汇报）——归属校验 + 状态机非法流转校验 + 系统消息
- **tc-mcp-l1**：MCP `team_view`（团队实例/会话状态/计划分配概览）/ `my_profile`（自身提示词摘要/角色/权限/toolEffects）——只读
- **tc-flow**：状态机联动——`start.preflight` 按 executionMode 校验（plan 模式要求 plan approved）+ `mark-pending-review` 校验（plan 模式要求 plan_tasks 全 done/blocked/skipped）+ **模式切换规则**（PATCH execution-mode：plan→direct 放宽；direct→plan 需已 approved）
- **tc-review**：双时点评审——计划前主 Agent 确认关键假设（协议引导）+ 计划后评审（用户 REST `PATCH /plans/:id/review` 默认 / 主 Agent 指派成员经 MCP plan_review；默认放行、只拦 blocker、附 reason）+ 系统消息（提交/通过/驳回）+ PlansController（GET /plans、GET /plans/:id/tasks）
- **tc-inject**：`GLOBAL_SYSTEM_INSTRUCTIONS` 新增【计划工作流】段，`buildSystemInstructions` 按 task.executionMode 条件注入（plan 模式注入引导：产出计划六要素→plan_submit→评审→plan_task_transition 推进→全 done 提交验收；direct 模式不注入）
- **tc-persona**：Agent 第五维【性格】段——`PERSONA_LIBRARY` 预制性格库（沉稳/苛刻/激进/保守/创新，各含【性格】文案 + **安全阀**：苛刻须附改进建议、沉稳须先复核）+ `renderPersonaSection(personaKey)` 模板函数 + 新 Agent 模板四方向后追加性格段（存量不改）
- **tc-auth**：L2 自治——MCP `team_add_member`（仅主 Agent）：创建增员确认请求（复用 question_confirm）→ 用户/托管确认后平台执行 updateTeam 增员
- 单测：plans/platform-mcp/tasks/worker-dispatcher/agents 各 spec 扩展

### Must NOT have (guardrails, anti-slop, scope boundaries)
- **L3 完全自治**（agent 无确认改团队/配置）；web 计划/性格管理界面（后续迭代）
- P3 远期：巡检调度器 todo 级强制、skills 携带权限语义、review-work 多视角评审
- 不新增依赖；不改任务状态机迁移逻辑本身（仅 transitionOpts 加条件校验分支）
- 存量 agent prompt 不强制改（persona 为新模板选项）；记忆管理（已上线）不重复实现
- 本计划不含 k8s 部署（部署沿用既有流程另行执行）

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + jest（server 单测随实现写入，平台既有 spec 风格；本计划无 web 任务）
- Evidence: .omo/evidence/task-<N>-vteam-team-collaboration.<ext>（attemptDir = currentAttemptDir from 'omo ulw-loop status --json', .omo/evidence/ulw/<session>/<goalId>/a<attempt>; outside ulw-loop use .omo/evidence/）

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- **Wave 1**（2 todos，并行）：Todo 1（tc-store）、Todo 7（tc-persona，独立）
- **Wave 2**（2 todos，并行）：Todo 2（tc-mcp-plan）、Todo 4（tc-flow，均依赖 1，改不同文件）
- **Wave 3**（并行：Todo 3 + Todo 6；Todo 5 依赖 3 串行——Oracle MED-B：Todo 3 与 Todo 5 同改 platform-mcp.tools.ts/service/spec，防冲突）：Todo 3（tc-mcp-l1，**依赖 2——与 Todo 2 同改 platform-mcp，串行防冲突**）、Todo 5（tc-review，**依赖 2+3**）、Todo 6（tc-inject，依赖 1）
- **Wave 4**（1 todo）：Todo 8（tc-auth，依赖 1 + 4）
- **Final verification wave**：F1-F4 并行

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. tc-store | - | 2, 3, 4, 8 | 7 |
| 2. tc-mcp-plan | 1 | 3, 5 | 4 |
| 3. tc-mcp-l1 | 2 | 5 | 6 |
| 4. tc-flow | 1 | 8 | 2 |
| 5. tc-review | 2, 3 | - | 6 |
| 6. tc-inject | 1 | - | 3, 5 |
| 7. tc-persona | - | - | 1 |
| 8. tc-auth | 1, 4 | - | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. tc-store：plans/plan_tasks 表 + tasks.execution_mode + agents.persona + 迁移 + PlansModule 骨架
  What to do / Must NOT do:
  - `server/prisma/schema.prisma` 新增两个模型（对齐记忆域先例 schema.prisma 记忆域注释风格）：
    - `Plan`：`id String @id`（pl_ 前缀，服务层生成）；`taskId String @unique @map("task_id")`（一任务一计划）+ relation Task（onDelete Restrict）；`title String`；`summary String? @db.Text`；`scopeIn String? @db.Text`；`scopeOut String? @db.Text`；`status String`（字符串枚举：draft/reviewing/approved/rejected/executing/completed，应用层常量）；`createdBy String @map("created_by")`（主 Agent 实例 id）；**`reviewerInstanceId String? @map("reviewer_instance_id")`（Oracle B1：评审指派落库——被指派评审者实例，null=用户评审/未指派；plan_review 权限校验依据）**；`createdAt/updatedAt`；`@@map("plans")`
    - `PlanTask`：`id String @id`（pt_ 前缀）；`planId String @map("plan_id")` + relation Plan；`seq Int`；`title String`；`content Json`（六要素：{what, mustNot, references, acceptance, qa, commit}——允许字段缺省但 what 必填）；`assigneeInstanceId String? @map("assignee_instance_id")`（指派实例，同角色多实例并行分发）；`status String`（pending/in_progress/done/blocked/skipped 字符串枚举）；`createdAt/updatedAt`；`@@unique([planId, seq], map:"uk_plan_tasks_plan_seq")`；`@@index([planId])`；`@@map("plan_tasks")`
    - `Task` 模型加 `executionMode String @default("direct") @map("execution_mode")`；Task/Plan 反向 relation
    - **`Agent` 模型加 `persona String?` 列（Oracle B4：persona 字段并入本迁移——单一迁移，避免 Todo 7 并行迁移冲突）**
  - 生成迁移：`cd server && npx prisma migrate dev --name team_collaboration_plans` + `npx prisma generate`
  - **⚠️ 迁移 drift 策略（Oracle M8）**：对齐 learnings.md 既有教训——migrate dev 直连生产库会触发历史 drift 强制 reset；**在临时库生成迁移**（如 `aiagents_tmp`，learnings 有确切做法）→ 人工剔除混入的无关补偿 alter → **迁移文件仅含本计划 CreateTable + 新列 + FK**（无对既有表结构的补偿变更）；acceptance 断言此点
  - 新建 `server/src/plans/plan.constants.ts`：`PLAN_STATUS`（draft/reviewing/approved/rejected/executing/completed）+ `PLAN_TASK_STATUS`（pending/in_progress/done/blocked/skipped）+ `PLAN_ERRORS`（如 PLAN_NOT_FOUND/PLAN_INVALID_STATUS/PLAN_STRUCTURE_INVALID/PLAN_NOT_APPROVED/PLAN_TASKS_INCOMPLETE）+ `EXECUTION_MODES`（direct/plan）——**注（Oracle R1）**：`draft` 为预留态（当前 planSubmit 直接落 `reviewing`，draft→reviewing 无独立迁移动作；保留 draft 供未来"草稿保存"扩展）
  - 新建 `server/src/plans/plans.service.ts`（onModuleInit `resyncIdPrefix` pl_ 与 pt_）+ `plans.module.ts`（providers: PlansService）+ `app.module.ts` 注册
  - Must NOT：不改现有表结构（tasks 只加 executionMode、agents 只加 persona）；不引入 Prisma enum；不加全文索引；不产生含历史 drift 补偿的迁移
  Parallelization: Wave 1 | Blocked by: - | Blocks: 2, 3, 4, 8
  References (executor has NO interview context - be exhaustive): server/prisma/schema.prisma:122-155（Task 模型，:131 mainAgentInstanceId、:133 managedMode 先例）、:160（TaskAgent 角色多实例）、:372-405（Agent 模型 :379 prompt）；**.omo/notepads/memory-management/learnings.md（⚠️ 必读：:34-42 临时库迁移 + drift 剔除策略）**；server/src/memories/（已上线记忆管理的表/迁移/模块骨架可完全对照）；server/src/common/id-generator.ts:42；server/src/workers/session-lifecycle.service.ts:47-53（resyncIdPrefix）；server/src/app.module.ts（模块注册）
  Acceptance criteria (agent-executable): `cd server && npx prisma migrate status` up to date；**迁移文件 grep 断言：仅 CreateTable plans/plan_tasks + ALTER tasks 加 execution_mode + ALTER agents 加 persona + FK，无其他表 ALTER**；`npx tsc --noEmit` 通过；`npm run test -- plans` 通过（plans.service.spec：resyncIdPrefix pl_/pt_ 续号）
  QA scenarios (name the exact tool + invocation): happy——`npx prisma migrate dev --name team_collaboration_plans` 在临时库生成迁移且 deploy 幂等；failure——重复 migrate deploy 无 drift 错误 + 迁移文件不含历史补偿 alter（grep 断言）。Evidence .omo/evidence/task-1-vteam-team-collaboration.txt
  Commit: Y | feat(plans): 计划数据域与执行模式字段

- [x] 2. tc-mcp-plan：平台 MCP plan_submit / plan_review / plan_task_transition
  What to do / Must NOT do:
  - `server/src/platform-mcp/platform-mcp.tools.ts` 新增三个 schema 并注册（现有 16 工具 → 19）：
    - `planSubmitSchema`：`{taskId, selfInstanceId, title, summary?, scopeIn?, scopeOut?, tasks: [{title, what, mustNot?, references?, acceptance?, qa?, commit?, assigneeInstanceId?}]}`——tasks 至少 1 项；每项 title+what 必填（`z.array(...).min(1)`）
    - `planReviewSchema`：`{taskId, selfInstanceId, planId?, verdict: z.enum(['approved','rejected']), reason?}`（rejected 时 reason 必填）
    - `planTaskTransitionSchema`：`{taskId, selfInstanceId, planTaskId, status: z.enum(['in_progress','done','blocked','skipped'])}`
  - `platform-mcp.service.ts` 新增三个方法：
    - `planSubmit`：`assertWorkerTask(taskId, selfInstanceId)` → 主实例校验（mainAgentInstanceId===selfInstanceId，否则 403，对齐 task_transition 语义）→ **已存在未终态计划（draft/reviewing/approved/executing）→ 409；已终态（rejected/completed）→ 覆盖重提（Oracle B2：taskId @unique 一任务一计划，修订=upsert——update 旧 plan 行 + 重写 plan_tasks 删旧建新，而非 create 新行）；upsert data 统一置 `reviewerInstanceId: null`（Oracle R3-MAJOR-1：覆盖重提与新建同一语义——新计划无指派，防过期评审者凭残留 reviewerInstanceId 抢先 plan_review 的"幽灵评审者"）**；**结构校验**（tasks 每项 what 非空，缺失 → 400 PLAN_STRUCTURE_INVALID）；**assignee 校验（Oracle M2）**：submit 中 tasks 的 assigneeInstanceId 若提供，须 ∈ 该任务 task_agents 且 removedAt=null（否则 400，对齐 issue_create 指派校验语义）→ **`$transaction` 包裹（Oracle R5）**：plan.upsert + 批量 planTask 重建（seq 递增，删旧建新）→ **status=reviewing（Oracle R1：直接落 reviewing——planSubmit 即进入可评审态，避免 draft→reviewing 无写入路径导致评审永远不可达）** → 触发群聊系统消息「主 Agent 提交执行计划，请评审」（对齐 tasks 系统消息模式）
    - `planReview`：`assertWorkerTask` → **权限校验（Oracle B1）**：`selfInstanceId ∈ {task.mainAgentInstanceId, plan.reviewerInstanceId}`（reviewer 字段由 Todo 5 指派时落库；两者皆无 reviewer → 仅主实例可调）→ reviewing→approved/rejected（rejected 附 reason 必填）→ 系统消息「执行计划已通过评审，可启动实施 / 执行计划被驳回：<reason>（可修改后重提或切换 direct 模式）」（Oracle M5：rejected 引导文案）
    - `planTaskTransition`：`assertWorkerTask` → 校验 planTask 属于该任务 + 实例为该 planTask.assigneeInstanceId 或主实例 → 更新 status → 若全部 done/blocked/skipped 且无 pending/in_progress → 系统消息「执行计划任务已全部完成，可提交验收」
  - **每个新增工具同步 `platform-mcp.controller.spec.ts` 工具列表断言（Oracle M4：记忆管理先例已踩坑——learnings.md:81-82）**：tools/list 数量与名称断言随本 todo 更新
  - Must NOT：不做 delete/update 计划工具（修订走 plan_submit 覆盖语义）；不改 controller 分发；权限不绕过 assertWorkerTask；**不引入任务状态机迁移逻辑改动**
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 3, 5
  References (executor has NO interview context - be exhaustive): server/src/platform-mcp/platform-mcp.tools.ts:224-332（buildPlatformMcpTools + zod 模式）；platform-mcp.service.ts（**grep `assertWorkerTask` 定位，实际约 :967**）、memorySave 实现（grep `memorySave` 定位，级别校验 + 落库模式可对照）；tasks.service.ts 系统消息模式（transition 内 tx.message.create + 广播，:927-1003）；platform-mcp.service.ts 主实例校验（grep `mainAgentInstanceId` 定位 taskTransition 的 main 403 模式）
  Acceptance criteria (agent-executable): `cd server && npm run test` 通过（platform-mcp.service.spec 新增：submit 结构校验 400 / 归属 403 / 非主实例 403 / 重复提交 409；review 状态流转 + rejected reason 必填；task_transition 状态更新 + 全部完成提示；**幽灵评审者回归断言（Oracle MED-A）：覆盖重提（rejected→upsert）后 plan.reviewerInstanceId=null 且原 reviewer 再调 plan_review → 403**；tools/list 19 工具）
  QA scenarios (name the exact tool + invocation): happy——jest 断言 submit→review(approved)→task_transition(done) 全链状态与系统消息；failure——缺 what 400、非主实例 403、非法状态流转 409。Evidence .omo/evidence/task-2-vteam-team-collaboration.txt
  Commit: Y | feat(plans): 平台 MCP 计划工具

- [x] 3. tc-mcp-l1：平台 MCP team_view / my_profile（团队感知，只读）
  What to do / Must NOT do:
  - `platform-mcp.tools.ts` 新增 `teamViewSchema {taskId}` 与 `myProfileSchema {taskId, selfInstanceId}` 并注册（19 → 21 工具）
  - `platform-mcp.service.ts`：
    - `teamView(ctx, {taskId})`：assertWorkerTask（无 selfInstanceId 只读）→ 查 task_agents（未 removed）+ 各自 sessionStatus/sessionId（复用 toTaskDto 的 instances 构造逻辑）+ 该任务 plan_tasks 分配概览（assigneeInstanceId/status 计数）→ 返回 `{taskId, members: [{id, agentId, alias, role, seq, main, sessionStatus}], planSummary: {total, done, pending}}`
    - **与 task_context 差异（Metis MINOR-3）**：task_context 返回静态 agentMembers 清单；team_view 增量 = **会话实时状态（sessionStatus/sessionId）+ 计划任务分配概览（planSummary）+ 全量角色视图**——协作时判断"谁空闲可派活、计划分到谁头上"，非重复实现
    - **验收定位（Oracle m2）**：my_profile 与 task_context/task 详情有重叠，增量价值主要在**权限/toolEffects 视角**——验收标准聚焦"返回自身配置 + 摘要截断 + 403"，不追求高增量价值
    - `myProfile(ctx, {taskId, selfInstanceId})`：assertWorkerTask（带 selfInstanceId）→ 查 agent（prompt 摘要前 500 字符、role、permissionScope、toolEffects、defaultModelId）+ taskAgent（alias/seq/workDir）→ 返回自身配置视图
  - **同步 controller.spec 工具断言（Oracle R5-MINOR-1）**：Todo 3 落地 21 工具后，`platform-mcp.controller.spec.ts` 的精确数量+名称 toEqual 断言（:145/:157，learnings.md:96 踩坑纪律）必须同步 19→21——本 todo What to do 与 acceptance 均含此指令
  - Must NOT：无写操作（只读）；不暴露明文敏感信息（prompt 摘要截断即可）；不新增 controller
  Parallelization: Wave 3 | Blocked by: 2 | Blocks: -
  References (executor has NO interview context - be exhaustive): platform-mcp.service.ts（**grep `assertWorkerTask` 定位，实际约 :967**）；tasks.service.ts toTaskDto instances 构造 :1018-1032（team 视图复用）；agents.service.ts toAgentDto（profile 视图）；schema.prisma TaskAgent :160 / Agent :372
  Acceptance criteria (agent-executable): `cd server && npm run test` 通过（platform-mcp.service.spec 新增：team_view 成员列表 + planSummary 计数；my_profile 自身配置 + 摘要截断；403 归属）
  QA scenarios (name the exact tool + invocation): happy——jest 断言 team_view 返回成员与计划概览、my_profile 返回自身配置；failure——跨任务 403。Evidence .omo/evidence/task-3-vteam-team-collaboration.txt
  Commit: Y | feat(plans): 团队感知 MCP 工具

- [x] 4. tc-flow：状态机联动 + 执行模式切换
  What to do / Must NOT do:
  - `server/src/tasks/tasks.service.ts` `transitionOpts`：
    - `start.preflight`（:645-658 现有团队/主 Agent 校验之后）追加按模式分支：查 task.executionMode——`plan` 模式：查 plans（taskId, status 未终态）不存在或 status≠approved → 400/409 `PLAN_NOT_APPROVED`（提示「执行计划未评审通过，请先 plan_submit + 评审」）；`direct` 模式跳过
    - **`start.afterCommit`（Oracle B3）**：plan 模式且 preflight 通过后 `plan.update({status: 'executing'})`（plan 生命周期与任务 start 联动——executing 状态的唯一写入点）
    - **`mark-pending-review` 分支新增 preflight（Metis MAJOR-2：该分支当前无 preflight，仅 fields+sysMessage :691-697；TransitionOptions.preflight 为可选字段 :141，可安全新增）**：`plan` 模式查 plan_tasks——存在 pending/in_progress → 409 `PLAN_TASKS_INCOMPLETE`（提示未完成任务）
    - **`accept` 与 `archive` 的 afterCommit（Oracle B3）**：plan 模式且存在 plan 记录 → `plan.update({status: 'completed'})`（任务验收/归档收尾 plan 生命周期，避免 approved 计划永久悬挂）
  - **TaskRow 类型扩展（Oracle m1）**：tasks.service.ts 的 TaskRow type（:85-103）增加 `executionMode` 字段（preflight/afterCommit 读 `task.executionMode` 需要类型）
  - **preflight 签名扩展（Oracle MINOR-1）**：`TransitionOptions.preflight` 当前为同步 `(task: TaskRow) => void`（:141）且调用点 `opts.preflight?.(task)`（:879）未 await——plan 门需查库（异步）；本 todo 显式扩展签名为 `(task: TaskRow) => void | Promise<void>` 并 await 调用点（现有 preflight 均为同步函数，await 无行为变化）
  - 模式切换（Metis MINOR-1：触发路径落点）：`tasks.controller.ts` 新增 `PATCH /tasks/:id/execution-mode`（body `{mode: 'direct'|'plan'}`，项目成员权限）→ service `updateExecutionMode(id, mode)`：plan→direct 直接切换；direct→plan 要求该任务已有 approved 计划（否则 409）——防绕过计划；**切换时任务已 in_progress → 顺带 `plan.update({status:'executing'})`（Oracle R5-MINOR-2：避免 approved 悬挂——executing 唯一写入点声明与切换路径一致）**；"direct→plan 需补计划"的补计划动作由主 Agent 手工 plan_submit 完成（非系统自动触发）
  - `CreateTaskDto`（:102 managedMode 旁）加 `executionMode?`（@IsIn(['direct','plan'])，缺省 direct）；tasks.create 落库；迁移 `executionMode String @default("direct")` 兼容存量数据
  - **managedMode × execution_mode 交互（Metis MINOR-2）**：两开关**独立生效、互不干扰**——execution_mode 管"计划门"（start/评审/验收前置），managedMode 管"确认权"（question/permission 由主 Agent 还是用户确认）；plan 模式下评审指派（notify_agent + plan_review）属常规协作不强制走托管确认
  - spec：start 按模式分支 + executing 置入断言、mark-pending-review 新增校验、accept/archive 置 completed 断言、切换规则、DTO、交互矩阵
  - Must NOT：不改迁移表 TASK_TRANSITIONS 本身与幂等/CAS 逻辑；direct 模式行为零变化
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 8
  References (executor has NO interview context - be exhaustive): tasks.service.ts:635-658（transitionOpts.start.preflight 现有校验）、:844-1010（transition 入口 CAS/事务）、:691-697（mark-pending-review 分支）；tasks.controller.ts（REST 端点模式）；tasks/dto/create-task.dto.ts:102（managedMode 同构）
  Acceptance criteria (agent-executable): `cd server && npm run test` 通过（tasks.service.spec 新增：plan 模式 start 前无 approved 计划 → 409；direct 模式 start 正常；mark-pending-review plan 模式未完成 → 409；切换规则两向；CreateTaskDto 校验）
  QA scenarios (name the exact tool + invocation): happy——jest 断言 plan 模式 start 被计划门拦截、direct 放行；failure——非法模式 400、direct→plan 无计划 409。Evidence .omo/evidence/task-4-vteam-team-collaboration.txt
  Commit: Y | feat(plans): 任务状态机与执行模式联动

- [x] 5. tc-review：双时点评审流程 + PlansController（用户评审入口）
  What to do / Must NOT do:
  - 新建 `server/src/plans/plans.controller.ts`（PlansModule 注册 controller）：
    - `GET /plans?taskId=`（项目成员，查计划头 + 任务清单）——评审查看入口
    - `PATCH /plans/:id/review` body `{verdict: 'approved'|'rejected', reason?}`（项目成员可评审——对齐 FR-04 验收判定权在成员；rejected 必填 reason）→ plans.service.review（reviewing→approved/rejected + 群聊系统消息）
    - `GET /plans/:id/tasks`（任务清单，可含 assignee 概览）
  - `plans.service.ts` 填充：`findByTask(taskId)`、`review(planId, verdict, reason, actor)`（状态机校验：仅 reviewing 可评审；非法流转 400 PLAN_INVALID_STATUS；**两入口（REST/MCP）成功后均置 reviewerInstanceId=null（Oracle R4：防止过期指派者残留评审权）**）、`findTasks(planId)`、**`assignReviewer(planId, reviewerInstanceId)`（Oracle B1 数据化落点：评审指派时写入 plan.reviewerInstanceId——被指派评审者的 plan_review 权限依据；reviewer 为空=用户评审/未指派，plan_review 仅主实例可调）**
  - **新增 MCP `plan_get` 只读工具**（Metis MAJOR-4：评审闭环——notify_agent 只传文本，被指派评审者需能读计划全文）：`planGetSchema {taskId, planId?}` → assertWorkerTask（无 selfInstanceId 只读）→ 返回计划头 + 任务清单全文（含六要素 content）
  - **新增 MCP `plan_assign_reviewer` 工具（Oracle R3：指派独立成工具，避免 planReviewSchema 加 kind 字段的契约歧义）**：`planAssignReviewerSchema {taskId, selfInstanceId, reviewerInstanceId}` → assertWorkerTask + 仅主实例可调 → `assignReviewer` 落库 → 系统消息「已指派 <alias> 评审执行计划」——两个工具（plan_get + plan_assign_reviewer）注册到 buildPlatformMcpTools（21 → 23 工具，Oracle M4 同步 controller.spec 断言）
  - **双时点评审流程闭环**（并入 Todo 6 文案 + 本组件实现）：
    - 计划前（Metis 对应）：主 Agent 在 plan_submit **前**经群聊 @ 用户（或私信）确认关键假设（假设来源：plan_submit 的 summary/scopeIn/scopeOut——协议引导；**planSubmit 系统消息附「关键假设已确认」提示记录（Oracle m3：补一条协议记录）**）
    - 计划后（Momus 对应）：用户默认评审（REST `PATCH /plans/:id/review`）**或**主 Agent 指派任意成员——指派路径（Oracle B1/R3 修正）：主 Agent 经 **`plan_assign_reviewer` 工具**调用 `assignReviewer` 落库 `plan.reviewerInstanceId` → `notify_agent` 通知评审者（content 附 planId）→ 评审者用 **`plan_get` 读计划全文** → 经 MCP `plan_review`（`selfInstanceId=reviewer` 通过权限校验）提交结论 → 平台回写计划状态 + 群聊系统消息（提交/通过/驳回，驳回附引导文案：可修改重提或切换 direct）→ **评审结束（REST 或 MCP 入口）清空 reviewerInstanceId（置 null）**；评审准则默认放行、只拦 blocker、附具体 reason（写进系统提示引导）
  - spec：controller（成员权限、评审流转、rejected reason 必填）+ service（状态机、404）
  - Must NOT：评审不改变 plan_tasks 内容（修订走 plan_submit 新版本）；不做 DELETE plans；权限不扩矩阵（复用项目成员校验）
  Parallelization: Wave 3 | Blocked by: 2, 3 | Blocks: -
  References (executor has NO interview context - be exhaustive): server/src/issues/issues.controller.ts（REST + 项目成员校验模式）；tasks.service.ts 系统消息模式；docs/agent-platform/10-群聊与消息机制.md §8.1（系统消息三态）；FR-04/08（验收判定权在成员——评审同源）；platform-mcp.tools.ts（**Oracle MED-B：与 Todo 3 同改此文件+service+controller.spec——依赖 3 串行防 Wave 3 冲突；工具计数链 Todo 3 落地 21 后本 todo 才 21→23**）
  Acceptance criteria (agent-executable): `cd server && npm run test` 通过（plans.controller.spec + plans.service.spec：GET 查询、review 状态流转 + 群聊系统消息、rejected 无 reason 400、404、非成员 403、**review 成功后 reviewerInstanceId 置 null（R4）**、**被指派 reviewer 经 plan_review 提交成功（Oracle MED-B：reviewer 命中校验路径覆盖）**）；platform-mcp.service.spec 新增 plan_assign_reviewer（仅主实例、落库 reviewerInstanceId、系统消息）与 plan_get（只读 403）断言；tools/list 23 工具（R3）
  QA scenarios (name the exact tool + invocation): happy——jest 断言 review approved → status=approved + 系统消息「执行计划已通过评审」；failure——非法流转 400、非成员 403。Evidence .omo/evidence/task-5-vteam-team-collaboration.txt
  Commit: Y | feat(plans): 计划评审流程与系统消息

- [x] 6. tc-inject：GLOBAL_SYSTEM_INSTRUCTIONS 计划工作流段（按模式条件注入）
  What to do / Must NOT do:
  - `server/src/chat/worker-dispatcher.ts`：
    - **⚠️ 落点修正（Metis MAJOR-1）**：`GLOBAL_SYSTEM_INSTRUCTIONS` 常量（:58-78）**保持不动**（代码注释明言"常量保持不动（其他调用方兼容）"）；【计划工作流】段作为**独立常量**（`PLAN_WORKFLOW_INSTRUCTION`）定义在同文件，由 `buildSystemInstructions`（:152，已接收 agent/team/mainAgentInstanceId 参数）在 dispatch 时按 executionMode 动态追加
    - 【计划工作流】段文案（独立常量）：
      `【计划工作流】（本任务执行模式=plan）任务启动前主 Agent 须产出执行计划：经 plan_submit 提交（tasks 每项含 目标/边界/引用/验收/QA/提交 六要素）；计划评审由成员确认或主 Agent 指派成员（评审者可经 plan_get 读计划、plan_review 提交结论；评审默认放行、驳回须附理由）；评审通过后按 plan_task 逐项推进（plan_task_transition 汇报进度，状态 done/blocked）；全部完成后主 Agent 提交验收（task_transition mark-pending-review）。计划前如关键假设不明，先向成员确认再提交。`
    - `buildSystemInstructions` 扩展：新增参数或从传入上下文读 executionMode（plan 模式追加段；direct 模式不追加——对齐 persistentWorkDir 动态注入先例）
  - `worker-dispatcher.spec.ts` 新增两组断言：plan 模式 prompt 含【计划工作流】段与 plan_submit/plan_task_transition 工具名；direct 模式不含
  - Must NOT：不改既有 8+ 段文案与顺序；direct 模式行为零变化；不自动注入计划内容（保持按需注入哲学）
  Parallelization: Wave 3 | Blocked by: 1 | Blocks: -
  References (executor has NO interview context - be exhaustive): worker-dispatcher.ts:58-77（GLOBAL_SYSTEM_INSTRUCTIONS + join 注入）；buildSystemInstructions / dispatchForTarget（动态注入点——先 grep persistentWorkDir 定位动态段先例）；worker-dispatcher.spec.ts（既有 sentinel 断言模式，如【记忆管理】段 :942-952）
  Acceptance criteria (agent-executable): `cd server && npm run test` 通过（worker-dispatcher.spec 新增：plan 模式含段、direct 模式不含段）
  QA scenarios (name the exact tool + invocation): happy——jest 断言 plan 模式 prompt 含【计划工作流】+ plan_submit；failure——direct 模式断言不含（验证条件注入真实生效）。Evidence .omo/evidence/task-6-vteam-team-collaboration.txt
  Commit: Y | feat(plans): 系统提示计划工作流引导

- [x] 7. tc-persona：Agent 性格维度（第五维）
  What to do / Must NOT do:
  - 新建 `server/src/agents/persona.constants.ts`：`PERSONA_LIBRARY`（key → 【性格】段文案）：
    - `steady` 沉稳：先复核再下结论，不确定时明示置信度，不贸然承诺
    - `strict` 苛刻：高标准验收，主动挑错；**安全阀**——每条批评须附改进建议（对齐 Momus blocker-finder：只拦真实问题，不纠风格）
    - `aggressive` 激进：快速推进优先，先跑通再优化；**安全阀**——关键步骤保留验证，不跳验收
    - `conservative` 保守：稳扎稳打，倾向复用既有模式，变更前说明影响
    - `innovative` 创新：探索新路径，主动提出替代方案；**安全阀**——新方案须说明权衡
  - `renderPersonaSection(personaKey: string): string`（纯函数，未知 key → 返回空串 + 不抛错）+ spec
  - **拼接层定案（Oracle M6：消除"渲染进 prompt vs persona 字段"双写矛盾）**：采用**独立 persona 字段 + 运行时拼接**方案——`agents.persona` 存性格 key（Todo 1 迁移已并入字段，B4）；Agent 保存/创建时**不**改写 `agents.prompt`（存量/用户自写提示词原样）；性格段由 `worker-dispatcher` 的 `buildSystemInstructions`（或 MAIN_AGENT_INSTRUCTION 动态注入处，先 grep 定位）在**运行时**按 `agent.persona` 用 `renderPersonaSection` 拼接进系统提示（对齐既有动态注入先例，worker-dispatcher.ts:134-139）——避免污染用户可编辑的 prompt 单 TEXT（schema.prisma:379）
  - 新 Agent 模板提示词：`docs/agent-platform/16-内置Agent角色与提示词库.md` 角色模板尾部追加可选【性格】段占位说明；seed 模板不加（默认无性格）
  - Agent 创建/编辑 DTO 加 `persona?`（@IsIn(Object.keys(PERSONA_LIBRARY))）落库 `agents.persona`
  - spec：persona 库渲染 + 安全阀文案断言 + 未知 key 兜底 + **buildSystemInstructions 按 persona 拼接断言（persona=strict 时 prompt 含【性格】段，persona=null 不含）**
  - Must NOT：存量 agent 的 prompt 不强制改（persona 为可选）；性格不改变权限/工具边界（仅表达与协作风格）；**不改 agents.prompt 内容（运行时拼接）**
  Parallelization: Wave 1 | Blocked by: - | Blocks: -
  References (executor has NO interview context - be exhaustive): docs/agent-platform/16-内置Agent角色与提示词库.md（四方向结构 :77-106）；agents/dto/create-agent.dto.ts（DTO 模式）；agents.service.ts（prompt 落库）；platform-mcp.service.ts Momus 风格参照（blocker-finder 哲学）
  Acceptance criteria (agent-executable): `cd server && npm run test` 通过（persona 渲染 spec + agents DTO 校验）；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy——jest 断言 renderPersonaSection('strict') 含安全阀文案、renderPersonaSection('unknown') 返回空；failure——DTO 非法 persona 400。Evidence .omo/evidence/task-7-vteam-team-collaboration.txt
  Commit: Y | feat(agents): Agent 性格维度

- [x] 8. tc-auth：L2 自治——主 Agent 申请增员（question_confirm 确认门）
  What to do / Must NOT do:
  - `platform-mcp.tools.ts` 新增 `teamAddMemberSchema {taskId, selfInstanceId, agentId, alias?, workDir?}` 并注册（23 → 24 工具，Oracle M4：Wave 3 plan_get+plan_assign_reviewer 后计数；同步 platform-mcp.controller.spec 工具列表断言）
  - **⚠️ 前置机制（Oracle B5/R2：既有 question 流无"平台侧发起 + 确认后回调"能力，且确认路径会误转发 serve）**——`questions.service` 需**新建**两个能力（非复用）：
    - `createForPlatform(taskId, question, options)`：平台侧主动创建 question（`que_` 前缀落库；当前 AgentQuestion 仅由 worker 事件上送，无平台创建入口——需新增；参考 questions.service 现有落库字段）；**sessionId 用主 Agent 会话占位并注释"仅满足非空约束，不实际转发"（Oracle R2）**
    - **确认回调钩子 + 旁路（Oracle R2 核心）**：平台发起的 question 加**独立标记**（如 `content.source='platform'`）；**content 保持前端可渲染兼容形状（Oracle MED-2）**——`{questions: [{question, header, options}], source: 'platform'}`（对齐 ingress 落库 `{questions:[]}` 形状，前端弹窗零改动）；`reply`/`confirmByAgent` 处理平台 question 时**短路 forwardReply**（不调 `workerClient.questionReply`——serve 无该 requestId 必 404→expire，:292-297 僵尸判定；平台 question 直接终态落库 + 触发 onResolved 回调 + **emit AGENT_QUESTION resolved:true 收敛（Oracle MED-2：对齐 forwardReply/expire 的弹窗关闭事件，防非托管用户弹窗悬挂）**）；**现有托管 question 的 forwardReply 转发行为保持不动**（独立标记分支隔离，不改公共路径）
    - onResolved(requestId, answers, actor)：平台侧注册的执行钩子（team_add_member 场景 → 校验+updateTeam）
  - `platform-mcp.service.ts` `teamAddMember`：`assertWorkerTask` → **仅主实例**可调（mainAgentInstanceId===selfInstanceId，否则 403，对齐 task_transition 主实例语义）→ **集成契约**：
    - **请求源**：Agent 发起（主实例调用 team_add_member）
    - **requestId 生成**：`questionsService.createForPlatform` 生成（`que_` 前缀）；**kind=question**，**answers 选项按 questions 表实际存储形状（Oracle M3：questionConfirmSchema.answers 为 `string[][]` 二维数组——选项为 `[['确认'], ['拒绝']]`）**
    - **落库**：question 记录（question=「主 Agent 申请将 <agentName>（别名 <alias>）加入团队，是否确认？」）
    - **确认路径**：用户经现有 question 弹窗确认（REST reply）；托管模式下主 Agent 经 question_confirm（answers=[['确认']]）确认
    - **执行（回调）**：`onResolved` 确认通过 → 平台执行 `tasksService.updateTeam(taskId, {addInstances: [{agentId, alias, workDir}]}, actor)`——**actor 审计（Oracle M1）**：updateTeam 当前不写 task_events、userId 参数未使用（tasks.service.ts:480 已核实）——本 todo 顺带在 updateTeam 增加 team 变更的 task_event 记录（eventType:'team_add'、actorType/actorId=确认方：user/确认用户 或 agent/主实例）+ 系统消息标注「经主 Agent 申请、<确认方> 确认」；拒绝不执行
    - **幂等**：重复申请同一 agentId 且已加入 → 400 AGENT_ALREADY_IN_TEAM；申请 pending 中重复 → 409
    - **失败路径**：确认拒绝 → 群聊系统消息「增员申请被拒绝」；超时由前端弹窗机制兜底（对齐现有 question 超时语义）；**确认回调时任务已终态（pending/in_progress 之外）→ updateTeam 自然 409，显式记录并忽略（Oracle m4：写进 spec 断言）**
  - spec：主实例 403、申请落库、确认后 updateTeam 调用 + task_event 审计、拒绝不调用、重复加入 400、终态回调 409 忽略、answers 二维形状断言
  - Must NOT：不做成员移除工具（L3 边界）；不绕过确认门；不扩大 agent 权限（新成员仍走任务创建时的权限/工具配置继承）；**不改变现有托管 question 流转行为（平台发起 question 用独立标记隔离）**
  Parallelization: Wave 4 | Blocked by: 1, 4 | Blocks: -
  References (executor has NO interview context - be exhaustive): platform-mcp.service.ts questionConfirm 实现（:grep question_confirm 定位——kind=question/permission、answers/response 收敛）；questions.service（question 落库）；tasks.service.ts updateTeam :480-628（addInstances 执行）；docs 14 篇（团队成员创建/权限继承）
  Acceptance criteria (agent-executable): `cd server && npm run test` 通过（platform-mcp.service.spec 新增：非主实例 403、申请创建确认请求、确认后 updateTeam、拒绝不执行、重复加入 400）
  QA scenarios (name the exact tool + invocation): happy——jest 断言主 Agent 申请→确认→updateTeam 调用且新成员出现；failure——非主实例 403、确认拒绝无副作用。Evidence .omo/evidence/task-8-vteam-team-collaboration.txt
  Commit: Y | feat(plans): 主 Agent 增员申请自治

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
- 每个 todo 完成后单独 commit（约定式提交：feat(plans)/feat(agents) scope）；执行完成后如用户要求 squash 为单个 commit（AGENTS.md「同一需求不要新增 commit」，用 `git commit --amend` 合并后续小改）
- 本改动不涉及 Java（NestJS/TS），无需 googleJavaFormat；提交前 `cd server && npx tsc --noEmit` 通过
- ⚠️ 远端注意：AGENTS.md 模板远端 `xishuhq/aiagents`/`ketabot/aiagents` 404 不存在；实际远端 origin=xishuhq/xteam、github=guolong123/vteam——推送/PR 前确认正确目标（本计划仅本地 commit，推送由执行时决定）
- 数据库迁移文件（server/prisma/migrations/<ts>_team_collaboration_plans/）随功能 commit 一并提交

## Success criteria
- Agent 可经平台 MCP 全链使用计划机制：plan_submit（六要素校验）→ 评审（用户/指派成员）→ plan_task_transition 推进 → 任务状态机联动（plan 模式 start 前置 approved、mark-pending-review 前置任务完成）
- 任务级执行模式切换生效：direct 默认轻量、plan 按需开启、切换规则防绕过
- 双时点评审落地：计划前确认假设（协议引导）+ 计划后可执行性评审（默认放行、只拦 blocker、附 reason）
- Agent 性格维度可配置（新模板含【性格】段 + 安全阀）；L1 团队感知（team_view/my_profile）只读可用；L2 自治（主 Agent 增员申请经确认门）生效
- server 全量单测通过（含 8 个新增/扩展 spec），既有 62+ suites 无回归
