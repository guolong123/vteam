# Learnings — vteam-team-collaboration

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## Todo 1 tc-store：plans/plan_tasks 表 + execution_mode/persona 列 + 迁移 + PlansModule 骨架

- **迁移目录现为 20 个**：`20260816013314_team_collaboration_plans/` 为本 todo 新增，含
  CreateTable plans/plan_tasks + ALTER agents 加 persona + ALTER tasks 加 execution_mode + 两个 FK
  （plans_task_id_fkey → tasks、plan_tasks_plan_id_fkey → plans）。临时库策略沿用 memory-management 先例：
  对 `aiagents_plans_tmp`（docker exec 创建，172.24.0.5:3306，db 容器 aiagents-compose-db）跑 migrate dev。
- **migrate dev 同样混入历史 drift 补偿**：本次生成的迁移被塞进 `ALTER TABLE sessions MODIFY task_agent_id
  NOT NULL`、`ALTER TABLE task_agents MODIFY work_dir VARCHAR(191)`、`ALTER TABLE sessions ADD CONSTRAINT
  sessions_task_agent_id_fkey`——来源是历史迁移与 schema.prisma 的类型漂移（role_instance_separation /
  agent_work_dir），已人工剔除，只保留本计划 CreateTable + ADD COLUMN + 新 FK。grep 断言：迁移文件
  无 MODIFY、ALTER 仅 agents/tasks/plans/plan_tasks。
- **验证链路**：DROP 后重建临时库 → `migrate deploy` 全量 20 迁移 → `migrate status` "up to date" →
  SHOW CREATE TABLE 核对 plans/plan_tasks 结构与 FK → tsc --noEmit → `npm run test -- plans` 4 passed →
  DROP 临时库。
- **plans.service.spec 写法**：对齐 memories.service.spec 的 onModuleInit 续号模式，但需同时 mock
  `prisma.plan.findMany` 与 `prisma.planTask.findMany` 两个 delegate（onModuleInit 连续 resync 两个前缀）；
  pt_ 续号断言单独 describe，验证 `idGen.seed('pt', 12)` 与命名 id（pt_archived_sample）NaN 防护。
- **⚠️ 全量 jest 现状**：工作区含 Todo 7（tc-persona）在途未提交改动（agents.service.ts /
  worker-dispatcher.ts / persona.constants.ts 等），全量 3 个失败全部属 Todo 7 范围
  （persona.constants.spec「strict 含安全阀文案」文案不匹配、worker-dispatcher persona 拼接同源、
  agents.service.spec「persona 更新」全量顺序下失败——单独跑 31/31 通过）。
  baseline 验证：git stash 全部改动后 HEAD 全量 64/64 suites、1269/1269 tests 全绿 → 证明 3 个失败为
  Todo 7 在途 pre-existing，非本 todo 引入。Todo 7 完成后需复核这些 spec。
- **schema 落点**：Plan/PlanTask 模型插在「记忆域」注释块之前（协作计划域分区）；Task 加 executionMode
  在 managedMode 之后 + 反向 relation `plan Plan?`（taskId @unique → 1:1）；Agent 加 persona 在
  ackMessage 之后。plan.constants.ts 的 PLAN_STATUS 含 draft 预留态（Oracle R1：当前 planSubmit 直接落
  reviewing，draft 保留供未来草稿扩展）。

## Todo 7 tc-persona（Agent 性格维度）— 2026-08-16

- **运行时拼接定案落地（Oracle M6）**：`agents.persona` 只存 key，`buildSystemInstructions` 按 `renderPersonaSection` 在运行时拼【性格】段进 system 提示（对齐 `MAIN_AGENT_INSTRUCTION` 动态注入先例 worker-dispatcher.ts:134-139）；**不**改写 `agents.prompt`（存量/用户自写提示词原样），性格段作为独立 block 经 `blocks.filter(b => b.length > 0)` 过滤空串。
- **schema 依赖处理**：Todo 1（tc-store）在并行执行中已落地迁移 `20260816013314_team_collaboration_plans`（含 `agents.persona` 列）——本任务**未自建迁移**，仅复用其列定义 + `prisma generate`。⚠️ 教训：若 Todo 1 晚于 Todo 7 落地，schema 无列会导致 `npx tsc --noEmit` 失败；需先补 schema 列 + generate 再实现 DTO 落库（任务 Dependencies 明示）。
- **PERSONA_LIBRARY 文案教训**：strict 安全阀文案必须含**精确子串"附改进建议"**（spec 用 `toContain` 断言）。首次写"每条批评必须**附上**改进建议"→ 因中间"上"字导致 `toContain('附改进建议')` 失败——文案须逐字对齐计划原文（"每条批评须附改进建议"）。
- **UpdateAgentDto persona 支持 null 清除**：service 用 `dto.persona !== undefined ? { persona: dto.persona ?? null } : {}`；class-validator `@IsOptional` 跳过 null 后再由 service 落 null 实现清除（对齐 ackMessage null=清空语义）。
- **agentIdentity hot path**：worker-dispatcher :1033 只 select 必要字段，需显式加 `persona: true` 否则运行时 persona 恒为 null（Persona 段永不注入，静默失效）。
- **AgentIdentityInfo 加必选字段 `persona: string | null`** 会破坏 spec fixture（worker-dispatcher.spec :862）与 agentIdentity 构造点（:1037）——同步更新两处；`agentRow?.persona ?? null` 兜底存量。
- **测试命中点**：agents.service.spec `findAll` 的 `Object.keys(...)` 精确字段断言（:187）需加 'persona'；create/update 用 `expect.objectContaining` 不受影响；controller.spec 全用 `toMatchObject` 不受影响。

## Todo 4 tc-flow：状态机联动 + 执行模式切换 — 2026-08-16

- **transitionOpts 闭包方案（关键）**：start/accept/archive 的 afterCommit 拿不到 task 上下文（签名仅 `(tx)`），需要「plan 模式 + plan 存在/approved」条件——用 case 块内局部闭包（`let planStarted/planCompletable`）在新增的异步 preflight 中设置，afterCommit 内按闭包判断。accept/archive 也因此**新增了只读 preflight**（direct 模式零 DB 调用，仅判断 executionMode；plan 模式查一次 plan 是否存在）。
- **preflight 异步化**：`TransitionOptions.preflight` 签名 `(task) => void` → `(task) => void | Promise<void>`，transition 调用点 `await opts.preflight?.(task)`。现有 start preflight 全同步，await 无行为变化（Metis MINOR-1）。
- **start plan 分支**：preflight 追加（团队/主实例校验之后）`task.executionMode === 'plan'` 时 `prisma.plan.findUnique({where:{taskId}, select:{status}})`，不存在或 `!== approved` → **400 BadRequest** `PLAN_NOT_APPROVED`（对齐 start 既有 TASK_EMPTY_TEAM/MAIN_AGENT_NOT_SET 的 400 语义）；afterCommit 闭包 `planStarted` 为 true 时 `tx.plan.update({status:'executing'})`。
- **mark-pending-review 新增 preflight（Metis MAJOR-2）**：plan 模式查 `planTask.findFirst({where:{plan:{taskId}, status:{in:[pending,in_progress]}}, select:{id}})`，命中 → **409 Conflict** `PLAN_TASKS_INCOMPLETE`（PlanTask 无 taskId 列，需经 `plan` relation 反查）。
- **accept/archive 置 completed（Oracle B3）**：afterCommit 内闭包 true 时 `tx.plan.update({where:{taskId}, data:{status:'completed'}})`。accept 既有 artifact 基线锁定逻辑保留，`artifacts.length === 0` 的 early return 改为 `> 0` 才锁定的等价结构（plan 更新在其后独立执行）。
- **updateExecutionMode（Metis MINOR-1 落点 + Oracle R5-MINOR-2）**：plan→direct 直接切换（plan 保持现状）；direct→plan 要求 `plan.findUnique` 存在且 approved，否则 **409** `PLAN_NOT_APPROVED`；任务已 in_progress 时用 `$transaction(async tx => { tx.plan.update(executing); tx.task.update(...) })` 保证执行态与计划态原子一致。非法 mode service 层抛 BadRequestException 防御（controller 端 @IsIn 已拦）。
- **CreateTaskDto.executionMode**：`@IsOptional @IsIn(Object.values(EXECUTION_MODES))`，枚举单一来源从 plan.constants 取（避免与常量漂移）；create 落库 `dto.executionMode ?? EXECUTION_MODES.direct`（迁移列 @default("direct") 兜底）。managedMode × executionMode 独立生效、互不干扰（DTO 描述 + service 注释说明）。
- **toTaskDto 输出 executionMode**（`task.executionMode ?? 'direct'` 兜底存量）——TaskRow 类型同步加 `executionMode: string`。
- **spec 类型耦合陷阱**：`assertSysMessageCreated` 参数类型为 `ReturnType<typeof mockTransitionTx>`——mockTransitionTx 加 `plan.update` 后，**CAS 并发测试里的局部 txModels 必须同步补 plan 字段**，否则 tsc TS2345。row() helper 需加 `executionMode: 'direct'`，且 create 首测的 `task.create` 精确断言（`toHaveBeenCalledWith` 全字段）要补 executionMode。
- **mock 扩展**：prisma mock 增加 `plan: {findUnique, update, updateMany}` + `planTask: {findFirst, findMany}`；mockTransitionTx 增加 `plan.update`。
- 验证：`npx tsc --noEmit` 非 platform-mcp 零错误（platform-mcp 报错为 Todo 2 在途 pre-existing）；`npx jest src/tasks --runInBand` **122 passed**（新增 14 条：start plan 3 + direct 零触发 1、mark-pending-review 3、accept 2、archive 2、create 落库 1、updateExecutionMode 8）。

## Todo 2 tc-mcp-plan：platform-mcp 域 plan_submit / plan_review / plan_task_transition 工具

- **改动文件**：`server/src/platform-mcp/platform-mcp.tools.ts` + `platform-mcp.service.ts` + `platform-mcp.service.spec.ts` + `platform-mcp.controller.spec.ts`（工具列表 16→19）。
- **⚠️ zod v4.4.3 refine 行为（关键踩坑）**：`z.object({...}).refine(...)` 返回的**仍是 ZodObject**（校验挂在 `_def.checks`），运行时 `z.ZodEffects` 为 `undefined`（classic API 无此导出），`_def.schema` 不存在。因此：
  - `zodObjectToJsonSchema` **无需解包 ZodEffects**——`(schema as ZodObject).shape` 直接可用，`instanceof z.ZodEffects` 写法在 tsc 直接 TS2339（`Property 'ZodEffects' does not exist`）。
  - refine 的 rejected-reason 必填校验经 `safeParse` 的 `_def.checks` 生效（controller tools/call 会走到），服务层仍二次校验兜底（防绕过 schema 直调 service，对齐 memory_save 纵深防御先例）。
  - schema 必须 export（`planSubmitSchema`/`planReviewSchema`），service.spec 需 import 测 zod safeParse 失败路径（对齐 memorySaveSchema 先例）。
- **plan_submit 严格顺序**（Oracle 契约落地）：`assertWorkerTask` → task.findUnique 主实例校验（`mainAgentInstanceId===selfInstanceId` 否则 403 PLATFORM_MCP_FORBIDDEN，对齐 task_transition）→ plan.findUnique 未终态查重（draft/reviewing/approved/executing → 409 PLAN_INVALID_STATUS；rejected/completed → 覆盖重提）→ tasks.what 空 → 400 PLAN_STRUCTURE_INVALID → assignee 校验（`taskAgent.findMany({taskId, id:{in:ids}, removedAt:null})` 缺失 → 400，对齐 issue_create 指派语义）→ `$transaction`：`plan.upsert({where:{taskId}, update:{status:reviewing, reviewerInstanceId:null}, create:{...}})` + 覆盖重提时 `planTask.deleteMany` 删旧 + 批量 create（seq 递增）+ 群聊系统消息 `tx.message.create` → 事务后 `realtime.broadcast`。
- **幽灵评审者防回归（Oracle MED-A/B1/R4）**：覆盖重提 upsert update 分支强制 `reviewerInstanceId: null`；plan_review 权限 = `selfInstanceId ∈ {task.mainAgentInstanceId, plan.reviewerInstanceId}`（reviewer 可能 null——null 时仅主实例可调）；评审完成后 `plan.update({reviewerInstanceId: null})`。spec 断言覆盖重提后原 reviewer 再调 plan_review → 403。
- **plan_review**：`planId?` 入参提供时 `findFirst({id: planId, taskId})` 校验归属，缺省 `findUnique({taskId})`；仅 `status==='reviewing'` 可评审（否则 400 PLAN_INVALID_STATUS）；rejected 无 reason → 400；approved 文案「执行计划已通过评审，可启动实施」，rejected 文案「执行计划被驳回：<reason>（可修改后重提或切换 direct 模式）」（Oracle M5 引导）。
- **plan_task_transition**：`planTask.findUnique` include `plan.taskId` 校验归属；权限 = `selfInstanceId === assigneeInstanceId || mainAgentInstanceId`（否则 403）；更新后 `planTask.findMany({planId})` 全部 ∈ {done,blocked,skipped} → 系统消息「执行计划任务已全部完成，可提交验收」。
- **⚠️ service.spec 归属校验陷阱**：`allowWorker()` 绑定 `session.taskAgentId=senderInstanceId`，传其他实例 id（assignee/reviewer）作 selfInstanceId 会被 assertWorkerTask 以同 code 403 拦下——跨实例权限用例必须新增 `allowWorkerAs(instanceId)` 辅助按实例绑定 session，否则权限断言「假绿」（测到的是归属校验而非目标逻辑）。
- **message.create 断言形状**：service 落库 `message.create({ data: {...} })`，断言必须用 `{ data: expect.objectContaining({...}) }` 包裹（与 tasks.service 系统消息模式一致）。
- **planTaskTransition 的 siblings 查询**：更新状态后 service 无条件查 `planTask.findMany` 判全终态——测试即使不关心完成提示也必须 mock `planTask.findMany`（否则 undefined.length 崩溃）。
- **⚠️ 并行 Todo 4（tc-flow）在途干扰**：工作区 tasks.service.ts/spec 含并行 agent 的 `updateExecutionMode` 未提交改动，`npx tsc --noEmit` 曾短暂报 tasks.service.spec.ts `plan` delegate 缺失（Todo 4 半成品）。**不属本 todo**，MUST NOT 修改；全量测试 1318/1318 通过即证明平台-mcp 改动无回归。Todo 2 完成时 tsc exit 0。
- 验证：`npx tsc --noEmit` EXIT 0；`npx jest src/platform-mcp --runInBand` 122 passed（service 121 + controller 1）；全量 `npx jest --runInBand` 64 suites / 1318 tests 全绿。

## Todo 6 tc-inject：GLOBAL_SYSTEM_INSTRUCTIONS 计划工作流段（按 executionMode 条件注入）— 2026-08-16

- **落点**：`GLOBAL_SYSTEM_INSTRUCTIONS` 静态数组（:59-79）**保持不动**；新增独立导出常量 `PLAN_WORKFLOW_INSTRUCTION`（紧随 MAIN_AGENT_INSTRUCTION 之后），由 `buildSystemInstructions` 在 dispatch 时按 `opts.executionMode === EXECUTION_MODES.plan` 动态追加（对齐 MAIN_AGENT_INSTRUCTION / persistentWorkDir 动态注入先例，blocks 数组按条件 push——非 isMainAgent/team 的内联三元）。
- **EXECUTION_MODES 枚举复用**：从 `../plans/plan.constants` import `EXECUTION_MODES`（direct/plan），不硬编码 'plan' 字符串——与 Todo 4 tc-flow 的枚举单一来源约定一致。
- **BuildSystemInstructionsOptions 加 `executionMode?: string`**：可选字段，存量调用（未传）不注入，direct 行为零变化。dispatch 处 taskRow select 补 `executionMode: true`，传 `taskRow?.executionMode`（taskRow 可能 null，可选链兜底）。
- **⚠️ hot path select 精确断言耦合（Todo 4 同型陷阱）**：worker-dispatcher.spec :377 `expect(prisma.task.findUnique).toHaveBeenCalledWith` 全字段断言必须同步补 `executionMode: true`，否则 toHaveBeenCalledWith 严格相等失败——改 select 后先跑单文件测试再全量。
- **spec 两组断言**（buildSystemInstructions describe 内、persona 段之后）：plan 模式含 `PLAN_WORKFLOW_INSTRUCTION` + 【计划工作流】+ 本任务执行模式=plan + plan_submit/plan_review/plan_task_transition + task_transition mark-pending-review；direct 模式与缺省调用均不含【计划工作流】/plan_submit（条件注入真实生效 + 向后兼容）。
- **验证**：`npx tsc --noEmit` EXIT 0（⚠️ 并行 todo 中途 platform-mcp.tools.ts teamView/myProfile TS2339 为其他 agent 在途半成品，非本任务引入——复跑后已消失）；`npx jest src/chat/worker-dispatcher.spec.ts --runInBand` 113 passed（新增 2 条）；`npm run test -- worker-dispatcher` 2 suites / 116 tests 全绿。

## Todo 3 tc-mcp-l1：platform-mcp 域 team_view / my_profile 团队感知只读工具 — 2026-08-16

- **改动文件**：`platform-mcp.tools.ts` + `platform-mcp.service.ts` + `platform-mcp.service.spec.ts` + `platform-mcp.controller.spec.ts`（工具列表 19→21）。
- **只读先例复用**：`team_view` 无 selfInstanceId，`assertWorkerTask(ctx, taskId)` 仅校验 worker 有任务会话（对齐 memorySearch）；`my_profile` 传 selfInstanceId（返回活跃实例 id 供后续查询定位）。
- **planSummary 语义定案**：`{total, done, pending}`——done = 终态子任务数（done/blocked/skipped，对齐 planTaskTransition 的 FINAL_STATES 判定），pending = total - done（pending/in_progress）；`planTask.findMany({where: {plan: {taskId}}})` 经 PlanTask 的 plan relation 反查该任务子任务（PlanTask 无 taskId 列）。
- **team_view 增量（Metis MINOR-3 落地）**：member 形状 `{id, agentId, alias, role, seq, main, sessionStatus, sessionId}`——sessionStatus/sessionId 复用 toTaskDto instances 构造逻辑（`sessions[0]` 取首项，orderBy createdAt asc，select {id, status}），taskContext 不含会话实时状态 + planSummary，非重复实现。
- **my_profile prompt 摘要**：`prompt.length > 500` → `promptSummary = prompt.slice(0, 500)` + `promptTruncated: true` 标记（Oracle m2 增量价值在权限/toolEffects 视角，不暴露完整 prompt 敏感信息）。
- **controller.spec 同步纪律再验证**：tools/list 断言精确名称 toEqual + 数量描述字符串（"19 个工具"→"21 个工具"）同步改；service mock 对象需补 `teamView/myProfile` jest.fn（tools/call 透传测试才不崩——但 tools/list 测试不调 handler 所以此前 19 工具下 mock 缺方法不报错）。
- **spec 无新增 delegate**：teamView 用 `taskAgent.findMany` + `planTask.findMany`（均已在 mock 中）；myProfile 用 `taskAgent.findFirst`（已有）+ `session.findFirst`。仅新增用例。
- 验证：`npx tsc --noEmit` EXIT 0；`npm run test -- platform-mcp` 132 passed（新增 10 条：team_view 4 + my_profile 4 + controller tools/call 透传 2）；全量 `npx jest --runInBand` 64 suites / 1330 tests 全绿。

## Todo 5 tc-review：双时点评审流程 + PlansController + plan_get/plan_assign_reviewer — 2026-08-16

- **改动文件**：`plans.service.ts`（填充 findByTask/review/findTasks/assignReviewer）+ `plans.controller.ts`/`plans.module.ts`（注册 controller + exports PlansService）+ `plans/dto/`（query-plans.dto / review-plan.dto）+ `platform-mcp.tools.ts` + `platform-mcp.service.ts` + `platform-mcp.module.ts`（import PlansModule）+ 三份 spec（controller.spec 21→23、service.spec、plans 两 spec）。
- **双入口 review 独立实现（R4 置 null 一致性）**：REST `PlansService.review(planId, userId, verdict, reason?)` 与 MCP `PlatformMcpService.planReview` 各自独立实现完整校验（状态机仅 reviewing / rejected 无 reason 400 / 更新 status + reviewerInstanceId 置 null / 群聊系统消息同文案），不互相调用——权限模型不同（REST=项目成员，MCP=主实例或 reviewerInstanceId），但置 null 行为对齐（两入口成功后均置，防幽灵评审者）。
- **assignReviewer 单一实现（Oracle R3）**：`PlansService.assignReviewer(planId, reviewerInstanceId)` 无 userId（MCP 调用方已做主实例校验），负责 reviewer 团队校验（taskAgent.findFirst removedAt:null，否则 400 PLAN_STRUCTURE_INVALID 对齐 plan_submit 指派语义）+ 落库 reviewerInstanceId + 系统消息「已指派 <alias> 评审执行计划」（alias = alias ?? agentId）。MCP `planAssignReviewer` 仅做 assertWorkerTask → 主实例校验（403）→ taskId 解析 plan.id → 委托 plansService.assignReviewer，避免双实现。
- **REST 权限模型（对齐 issues.controller）**：PlansController 不挂 AdminGuard / ProjectMembershipGuard（其 :id 路由反查会把 /plans/:id 的 :id 误解析为 taskId → 404 TASK_NOT_FOUND）；项目成员校验在 PlansService.assertTaskMember 内（task.findUnique projectId → projectMember.findUnique，404 TASK_ERRORS.TASK_NOT_FOUND / 403 PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER）。这是 issues.controller 注释里已记录过的坑，plans 沿用同模式。
- **plan_get 只读通道（Metis MAJOR-4）**：无 selfInstanceId，仅 assertWorkerTask（对齐 team_view/memorySearch 只读先例）；planId 提供时用 findFirst({id, taskId}) 校验归属（防跨任务读）；返回计划头 + 任务清单全文（content 六要素 + 指派概览 assigneeAlias/assigneeName 经 taskAgent.findMany 解析 Map）。⚠️ 与 plans.service.findByTask 输出形状保持对齐（REST/MCP 同一 DTO 契约），但各自独立查库——findByTask 需 userId 成员校验，plan_get 无 userId，无法复用。
- **planTask DTO 不含 createdAt/updatedAt/planId**：toPlanTaskDto 只透出 {id, seq, title, content, assigneeInstanceId, assigneeAlias, assigneeName, status}——spec 期望对象**不能 spread 完整 mock 行**（否则 toEqual 深比对多 3 字段报错），需逐字段写期望。
- **spec 断言消息常量**：`senderType: 'system'`（SENDER_TYPE.system）、realtime.broadcast 事件 `'chat.message.new'`（EVENT_TYPES.CHAT_MESSAGE_NEW）——断言可直接写字面量（与 platform-mcp.service.spec 既有断言一致）。
- **验证**：`npx tsc --noEmit` EXIT 0；`npx jest src/plans src/platform-mcp --runInBand` 169 passed（新增 plans.service 14 + plans.controller 4 + platform-mcp plan_get 5 + plan_assign_reviewer 5 + 被指派 reviewer plan_review 1 + controller tools/call 透传 2）；全量 `npx jest --runInBand` 65 suites / 1363 tests 全绿（learnings 中 Todo 7 的 3 个 pre-existing 失败已消失——Todo 7 已由并行 agent 完成）。

## Todo 8 tc-auth：L2 自治——主 Agent 申请增员（question_confirm 确认门）— 2026-08-16

- **改动文件**：`questions.service.ts`（createForPlatform + onResolved 钩子 + forwardReply 平台短路）、`questions.constants.ts`（PLATFORM_QUESTION_SOURCE）、`questions.controller.ts`（reply 传 @CurrentUser userId）、`tasks.service.ts`（updateTeam actor 审计 + confirmedBy 文案）、`platform-mcp.constants.ts`（+2 错误码）、`platform-mcp.tools.ts`（+team_add_member → 23→24）、`platform-mcp.service.ts`（teamAddMember + handleTeamAddResolved）+ 4 份 spec。
- **平台 question 旁路（Oracle R2 落点）**：`forwardReply` 入口按 `content.source==='platform'` 短路到 `resolvePlatformQuestion`（不经 workerClient——serve 无该 requestId 必 404→expire）→ 终态落库 + 触发 createForPlatform 注册的 onResolved 钩子 + emit `AGENT_QUESTION {resolved:true}` 收敛。现有托管 question 转发路径零改动（独立标记分支）。
- **onResolved 钩子机制**：`QuestionsService.platformResolvers` Map（key=requestId）注册执行钩子（team_add_member 场景闭包捕获 → handleTeamAddResolved → updateTeam + 审计）；终态/超期（expire）时触发并移除；钩子异常不阻塞弹窗收敛（try/catch + logger）。
- **answers 二维契约（Oracle M3）**：确认回调 answers 为 `string[][]`（`[['确认']]` 确认 / `[['拒绝']]` 拒绝 / null 拒绝）；`handleTeamAddResolved` 以 `answers?.[0]?.[0] === '确认'` 判定执行，否则不执行。
- **createForPlatform 细节**：requestId 用 `que_platform_<seq>`（`seq.split('_')[1]` 提取序号——⚠️ `slice(4)` 依赖前缀长度，mock 前缀 'aq_' 时多去一位，必须用 split）；content 前端兼容形状 `{questions:[{question, header, options:{label,description}[]}], source:'platform'}`；sessionId 主 Agent 会话占位（无则 's_placeholder'，仅满足非空约束不转发）。
- **updateTeam actor 审计（Oracle M1/m4）**：updateTeam 第 4 参 `opts {actorType, actorId, confirmedBy}`，事务内写 taskEvent（add→team_add / remove→team_remove，metadata 含 agentIds/confirmedBy）；缺省回退 `user/userId`；confirmedBy 存在时系统消息标注「已加入团队（经主 Agent 申请、<确认方> 确认）」。确认回调时任务已终态 → updateTeam 409 → handleTeamAddResolved 捕获 ConflictException 显式记录并忽略（不向上抛）。
- **teamAddMember 幂等**：taskAgent.findFirst(agentId, removedAt:null) → 400 AGENT_ALREADY_IN_TEAM；agentQuestion.findMany(taskId, pending) 内存过滤 source/action/agentId → 409 PENDING_APPLICATION（pending 但非本 agent 不冲突）。
- **explicit alias 语义**：`explicitAlias = args.alias?.trim() || null`——申请文案用 displayAlias（显式或 agent 名），但传给 updateTeam 的 alias **仅显式别名**（否则 createInstances 默认别名会被 '开发者' 覆盖）。
- **controller.spec 工具列表同步纪律再验证**：23→24 需同时改 it 描述文案 + names toEqual + 新增 schema 断言（team_add_member: taskId/selfInstanceId/agentId 必填）；service mock 加 teamAddMember。
- 验证：`npx tsc --noEmit` EXIT 0；全量 `npx jest --runInBand` 65 suites / **1382 tests** 全绿（新增 19 条）。

## Todo 4 F2-M1 修复：executing 回切放行（切换死锁消除）— 2026-08-16

- **死锁场景（F2 M1）**：任务 in_progress + plan 模式已启动（plan.status=executing）→ 切 direct（plan 保持 executing）→ 回切 plan 时原校验 `plan.status !== approved` → 409 PLAN_NOT_APPROVED；而 plan_submit 覆盖重提对 executing 也是 409（PLAN_ACTIVE_STATUSES 含 executing，platform-mcp.service.ts:50-55）→ **无法通过任何合法操作恢复 plan 模式**。
- **修复（方案 A）**：`updateExecutionMode` 的 direct→plan 校验放行 `status ∈ {approved, executing}`——executing 表示计划曾批准且已执行，回切无需重新评审；错误提示文案保留。completed/reviewing/rejected/draft/无 plan 仍 409（completed 场景补了拒绝测试）。
- **spec 新增 2 条**：①「plan（executing）→ direct → 再切回 plan 成功」——两步切换（mock plan.status=executing，断言第二次切换走 in_progress 事务分支、plan.update(executing) 幂等、无 409）；②「direct → plan 计划已 completed → 409」——锁定仅 approved/executing 放行边界。
- **⚠️ edit 陷阱**：newString 若吞掉相邻 `it(...)` 声明行会留下孤立测试体，jest 报 TS1128 语法错误——大块替换时 oldString 必须精确锚定结尾，避免吃掉下一用例的 it 行。
- 验证：`npx tsc --noEmit` 非 platform-mcp 零错误；`npx jest src/tasks --runInBand` **126 passed**。

## F2 M1 修复：updateExecutionMode 切换死锁（plan=executing 回切放行）— 2026-08-16

- **根因**：任务 in_progress + executionMode=plan + plan.status=executing（plan 模式已启动）→ 切 direct（plan 保持 executing）→ 再切回 plan 时，direct→plan 校验只认 `approved` → 409 PLAN_NOT_APPROVED；且 plan_submit 对 executing 同样 409（PLAN_ACTIVE_STATUSES 含 executing，防覆盖重提）→ **plan 模式无法恢复的死锁**。
- **修复（方案 A）**：`tasks.service.ts updateExecutionMode`（约 :507-511）direct→plan 校验条件由 `plan.status !== approved` 改为 `plan.status !== approved && plan.status !== executing`——executing 表示计划曾批准且已启动，回切无需重新评审；保留 409 与错误文案，仅对 reviewing/rejected/completed 拦截。**未改** plan_submit 的 executing 409 语义（执行期禁止覆盖重提是合理防护，本修复只消除切换死锁）。
- **回归测试**：tasks.service.spec updateExecutionMode describe 新增「plan（executing）→ direct → 再切回 plan 成功」——两步 mock（第一步 direct 切换仅 task.update；第二步 plan 回切 in_progress + plan=executing → $transaction 内 tx.plan.update 保持 executing + task.update 置 plan），断言第二次切换成功不抛 409、executionMode=plan。另补「completed → 409」边界（仅 approved/executing 放行语义闭环）。
- **⚠️ 并行/残留编辑陷阱**：任务开始前工作区已含半个「幂等返回」测试（`prisma.task.findUnique.mockResolvedValue` 前缺 `it(...)` 头，describe 顶层残留语句）——疑似前序修复尝试未清理。发现时先核对 git diff 与 Read 是否一致（文件行数随并行 agent 编辑变化：2581→2641→2643），确认残留为半成品后由并行 agent 修复补齐 it 头；**勿假设文件只被自己修改**。
- 验证：`npx tsc --noEmit` EXIT 0；`npx jest src/tasks --runInBand` 3 suites / **126 passed**（updateExecutionMode 10 条全绿，含 M1 回归）。未做 git commit。
