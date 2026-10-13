---
slug: task-long-running
status: awaiting-approval
intent: clear
review_required: false
classification: Standard
pending-action: write .omo/plans/task-long-running.md
approach: 加 `Task.longRunning` boolean（照 `resetAfterComplete` 模板 1:1 复刻全管道），对 long_running 任务关闭 progression 巡检（5 个强制执行点）、禁止 Agent 驱动的 `mark-pending-review`（保留人工完整完成通道）、豁免 `remove()` 的 in_progress 拦截；顺带订正 5 处"巡检已退役"陈旧注释并修 onModuleInit 清扫/重建顺序 bug。
---

# Draft: task-long-running

## Components (topology ledger)

<!-- id | outcome (one line) | status: active|deferred | evidence path -->

| id | outcome | status | evidence path |
|---|---|---|---|
| C1 | `tasks.long_running` 列落地（schema + 手写 migration + 契约 spec） | active | `server/prisma/schema.prisma:249`（`resetAfterComplete` 模板）、`migrations/20260930010000_memory_role_inject/migration.sql:1-20`、`src/prisma/memory-role-inject.migration.spec.ts:70-124` |
| C2 | 字段经 service/DTO/API 完整往返 | active | `tasks.service.ts:81/414/723/1998`、`dto/create-task.dto.ts:46-52`、`dto/update-task.dto.ts:43-49`、`tasks.controller.ts:152/242` |
| C3 | long_running 任务不被巡检唤醒、不被自动置阻塞 | active | `task-progression.scheduler.ts:234-241/260/522-528/1022`、`tasks.service.ts:1298` |
| C4 | Agent 无法把 long_running 任务推出 in_progress；人工完成通道完好；可硬删 | active | `tasks.service.ts:1565-1591`（`transitionByAgent` 已有 accept/archive 403 先例）、`:1369-1376`（`TASK_DELETE_BLOCKED`） |
| C5 | Agent 工具面能读能写该字段 | active | `platform-mcp.tools.ts:707-719`、`platform-mcp.service.ts:1226-1238/3226-3276` |
| C6 | Web 可勾选 + 类型/徽章；agent-platform 文档同步 | active | `web/src/components/tasks/task-detail-types.ts:41`、`web/app/(main)/tasks/new/page.tsx:209-216`、`docs/agent-platform/15-…:156-177`+`:475-490` |
| C7 | 顺带修：5 处陈旧注释 + onModuleInit 清扫/重建顺序 | active | `task-progression.scheduler.ts:59/107-109/182-183/207-208/184/187/976-978` |

拓扑 7 个，全部 active，7 个可各自独立成败。

## Open assumptions (announced defaults)

| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| 字段类型 | `Boolean @default(false) @map("long_running")`，非 Prisma `enum` | 用户明确说"加一个字段来控制是不是长期任务"；且 `schema.prisma:10-27` 禁 enum（MySQL/SQLite 双库可移植性） | 是（改列类型需迁移） |
| 是否上 Web UI | 上，`tasks/new/page.tsx` 加勾选 | 与 `resetAfterComplete` 模板一致，用户在 UI 建值班任务时才可能勾；纯 DB 改字段不现实 | 是 |
| Agent 能否在建任务时置位 | 能，`task_create` 加可选 flag | 用户在 k8s 用 MCP 建群；`resetAfterComplete` 当年漏了这层是历史欠账，且不补就无法程序化建值班任务 | 是 |
| 会话无界增长 | **不新增机制**，接受现状 | 人工 `accept` 会触发 `tasks.service.ts:1812-1829` 的 session reset，交接班时"完成旧任务+建新任务"即是出口 | 是 |
| 迁移回填 | 零回填，`DEFAULT false`，由运维显式设那一个任务 | `status`/`title` 推不出"常驻值班任务"；错标 `true` 会永久关掉真任务的看门狗 | 是 |
| 测试策略 | tests-after（先改实现再补 spec） | 仓库既有风格：11 个 `*.migration.spec.ts` 与 177KB 的 `tasks.service.spec.ts` 都是实现伴随补断言；且 spec 里 `inProgressTask()` 无 `longRunning` 字段（spec:49-55），加字段不破坏存量断言 | 是 |

## Findings (cited - path:lines)

**看门狗是活的，注释是错的**
- `task-progression.scheduler.ts:281-291` 真的调 `triggers.schedule()`（interval 10min、maxFires 6、guardKey `progression_cooldown`）。
- 但 `:59`、`:107-109`、`:182-183`、`:207-208`、`:976-978` 五处声称"periodic patrol 已退役，fan-out JOIN drain 接管"。**全错**。探索初期差点照注释得出"看门狗是死代码"的结论。

**停滞判定链**
- `quietStreak` 存在触发器行 payload 里（`writeQuietStreak` :609-629），每次非否决 fire +1（:568），`>= STALL_QUIET_STREAK_LIMIT=3`（:44/:570）→ `fireStallDetected`（:588）→ `TasksService.systemBlock`（`tasks.service.ts:1296`）→ 群发 `【任务停滞】`（scheduler:710-757）→ `unregister`（:592）。
- 值班群白天无人提问 → 30 分钟必然触发。**不是阈值问题**：`quietStreak` 衡量"主会话近 10min 有没有说话"，而值班任务的正常稳态就是没人说话。

**唯一能改 TASK 状态的组件**
- `TASK_STATUS.blocked` 生产写入点唯一（`tasks.service.ts:1757`）。`worker-dispatcher.ts:4025/4186` 只写 `Session.status=failed`；`chat.service.ts:1762` 只读 `task.status`。已核验。

**`mark-pending-review` 是巡检关掉后仍活着的漏口**
- `buildProgressionPrompt`（scheduler:82-89）原文："若全部工作完成，调用 task_transition mark-pending-review 提交验收"。巡检关闭不防 agent 自主调用。

**已有门禁先例可直接扩展**
- `transitionByAgent`（`tasks.service.ts:1565-1591`）已对 agent 的 `accept`/`archive` 硬拒 403 `TASK_AGENT_COMPLETION_FORBIDDEN`，报错文案已写"请向用户报告任务已就绪、等待人工验收，不要重复调用"。long_running 只需在同一 if 块加 `mark-pending-review`。
- `TASK_TRANSITIONS`（`task.constants.ts:45-56`）表驱动，新增拦截不需改迁移表。

**队列不会被堵死（用户已决策）**
- `createTaskInternal:358-359` `isIdle = !team.currentTaskId`；`promoteNextInTx` 只在 accept(:1121)/reject(:1139)/archive(:1184) 调。常驻任务永久占位会永久堵死同团队队列——**用户确认值班群独占一个团队，此为设计意图，队列代码一行不动**。

**退出路径**
- `archive` → 类型门禁拒；`remove()` `:1369-1376` 硬拦 `in_progress` 抛 409 `TASK_DELETE_BLOCKED`。**用户决策：允许 long_running 直接硬删**（`remove()` 已有完整级联，`:1449-1452` 会置空 `teams.currentTaskId`）。

**人工完成通道完好**
- `mark-pending-review → accept → archive` 人工路径一行不改。`accept` 会触发 `tasks.service.ts:1812-1829` 的 session reset（`reuseSession`/`resetAfterComplete` 判定），顺带解决"主会话无界增长"。

**启动清扫顺序 bug（顺带修）**
- `onModuleInit` 先 `cancelStalePatrolTriggers()`（:184，:980-1001 无条件把库内**所有** pending 巡检行置 cancelled）再 `restoreInProgressTasks()`（:187）。后者 → `register` → `persistPatrolTrigger` 见行已 cancelled → **删掉重建**（:274/:281），`fireCount` 归零、payload 不含 `quietStreak`。故 `:270-272` 的幂等早退在启动路径上永不命中，`quietStreak`/`maxFires` 每次发版静默重置。类注释 :98「重启安全核心」与 `register` 文档 :229-230 在这点上是假的。
- **修法**：给清扫加"跳过仍在 in_progress 的任务"条件（而非删清扫），使 `:270-272` 幂等分支恢复可达。

**迁移约定**
- 手写 SQL（`migrate deploy` only，`docs/migration-baseline.md:30-32` 禁从 schema 重新生成 baseline）。目录名 `YYYYMMDDHHMMSS_snake_case`，开头中文 WHY 注释块。boolean 模板：`ADD COLUMN \`x\` tinyint(1) NOT NULL DEFAULT false`（`memory-role-inject:1-20`）。
- **`@map` 必写** —— `learnings.md:163` 记着漏 `@map` 的线上事故。
- 11 个 `*.migration.spec.ts` 契约测试解析 SQL 文本，断言 schema↔migration 一致、baseline 里不存在该列、`DEFAULT false`、禁回填/DROP。模板 `memory-role-inject.migration.spec.ts:70-124`。
- 无 down-migration（`docs/tech-debt-rollback.md:12-15`）。

**测试基座**
- `server/package.json` `test` = `jest --runInBand`；`jest.config.js` rootDir `src`、testRegex `.*\.spec\.ts$`；`test/setup-env.js` 默认 sqlite（`file:./test.db`、`DB_TYPE=sqlite`）。**故 migration SQL 是 MySQL 方言但从不真跑**，契约 spec 只做文本解析。
- `task-progression.scheduler.spec.ts:49-55` 的 `inProgressTask()` 不含 `longRunning` → 新字段为 `undefined`（falsy）→ **存量 `triggers.schedule` 断言（:256/268/278/502/529/544）全部不受影响**。

**会被打破的既有断言**
- `docs/test-cases/02-项目与任务管理.md:130`（TC-TASK-016）断言 `GET /tasks/:id` 完整字段列表 → 需同步加字段。
- `platform-mcp.controller.spec.ts:278/681` 钉死 MCP 工具数 32 → 本次**不新增工具名**，只扩 `task_create` 参数，工具数不变。
- `platform-mcp.tool-naming.spec.ts:153-157` 钉死 `task_create` 的 required/optional 集合 → 需同步。

**DTO 即 MCP schema 源**
- `swagger-mcp/swagger-tools.ts:140-184` 从 OpenAPI 文档的 requestBody 生成工具 inputSchema，故 `create-task.dto.ts` / `update-task.dto.ts` 加 `@ApiPropertyOptional` **自动**发布到 `vteam-api` agent 工具面，`swagger-mcp.handlers.ts:167-171` 已把 `PATCH /tasks/{id}` 绑到 `tasksService.update`。零额外接线。
- 无提交的 openapi.json，`@ApiProperty*` 是 `/docs` 与 swagger-mcp 的唯一真源。

## Decisions (with rationale)

| # | 决策 | 理由 | 来源 |
|---|---|---|---|
| D1 | `longRunning Boolean @default(false) @map("long_running")`，非 enum | 用户说"加一个字段"；`schema.prisma:10-27` 禁 enum | 用户 + 探查 |
| D2 | 巡检**完全关闭**（不排期、不叫醒、不置阻塞） | 巡检的目的是把任务推向终态；常驻任务无终态 → 机制不适用，而非"误判豁免"。心跳方案被否：会持续诱导 agent 调 `mark-pending-review` | 用户（首轮否决 C）+ 证据 |
| D3 | 强制执行点 5 处，`handleProgressionFire:522-528` 为唯一必经 | 排期处 gate 不够：flag 翻 true 时已有 pending 行不会自动清；`{expire:true}` 让遗留行一个 tick 自毁（`trigger.service.ts:583-593`） | 证据 |
| D4 | Agent 禁 `mark-pending-review`，放行 `block`/`resume`；人工全放行 | 堵住巡检关掉后仍活着的漏口；`block` 是升级通道且非终态；用户明确要求"保留人工操作将任务状态设置为完成的操作" | 用户 + `:82-89` 证据 |
| D5 | `remove()` 对 long_running 跳过 `:1369` 拦截 | archive 被门禁拒、remove 被 `TASK_DELETE_BLOCKED` 拦，两条常规退路全堵死 | 用户 |
| D6 | 值班群独占团队 → 队列代码零改动 | `promoteNextInTx` 永不触发是设计意图 | 用户 |
| D7 | 顺带修 5 处陈旧注释 + 清扫顺序 bug | 陈旧注释本次已实际误导探查（得出"看门狗是死代码"）；清扫顺序 bug 使 `quietStreak` 每次发版静默重置，long_running 上线后仍需靠这个 bug 续命 = 定时炸弹 | 用户（次轮选项）+ 证据 |
| D8 | 零回填 migration | 启发式回填会永久关掉真任务的看门狗 | 证据 |

## Scope IN

- `Task.longRunning` 列：schema + 手写 migration + `*.migration.spec.ts` 契约测试
- service 四处字段往返（`TaskRow`/create/update/`toTaskDto`）
- 两个 DTO（`create`/`update`）加 `@ApiPropertyOptional` + `@IsOptional() @IsBoolean()`
- 巡检 5 个强制执行点（`register`/`persistPatrolTrigger`/`handleProgressionFire`/`restoreInProgressTasks`/`systemBlock`）
- `transitionByAgent` 对 long_running 拒 `mark-pending-review`（403，沿用 `TASK_AGENT_COMPLETION_FORBIDDEN` 或新错误码）
- `remove()` 对 long_running 豁免 in_progress 拦截
- `platform-mcp`：`task_create` 加可选 flag + `task_context` select 暴露
- Web：`task-detail-types.ts` + `tasks/new/page.tsx` 勾选
- Docs：`docs/agent-platform/15-…:156-177`+`:475-490`、`09-API设计.md:114-128`、`13-任务状态机.md:36-50`
- 顺带修：5 处陈旧注释、`cancelStalePatrolTriggers` 加 in_progress 跳过条件
- 同步既有断言：TC-TASK-016、`platform-mcp.tool-naming.spec.ts:153-157`

## Scope OUT (Must NOT have)

- **不改** `Team.currentTaskId` / `promoteNextInTx` / 队列逻辑（值班群独占团队，队列是设计意图）
- **不改** `TASK_TRANSITIONS` 迁移表（`task.constants.ts:45-56`）——门禁是叠加在既有表之上的 actor 维度检查
- **不改** `maxRounds`/`PROGRESSION_INTERVAL_MS`/`STALL_QUIET_STREAK_LIMIT` 等任何看门狗阈值（根因是语义不适用，不是阈值不当）
- **不加**会话轮转/上下文压缩机制（人工 accept 已是出口）
- **不加** MCP 工具名（工具数必须保持 32，`platform-mcp.controller.spec.ts:278/681`）
- **不做**启发式数据回填
- **不删** `scan()`/`patrolNow()` 死代码（属独立清理，本 PR 不扩大范围）
- **不写** down-migration（仓库无此约定，`docs/tech-debt-rollback.md:12-15`）
- **不改** `worker-dispatcher` 的 session 空闲扫描 / 静默看门狗（作用域是 session，不改 TASK 状态）

## Open questions

无。四个 owner-decision 全部已由用户回答：团队独占（D6）、允许硬删（D5）、保留人工完成（D4）、加 boolean 字段（D1）。

**Extrinsic axes swept**（全部 explored/defaulted，无一需问）：
- budget/spend：无新增付费服务，纯自研平台加一列 → 不适用
- mandated stack：不引入新依赖；禁 enum 是仓库既有硬约束（`schema.prisma:10-27`）→ 已探索
- expected scale：无新增运行时组件；且本改动**减少**触发器行（常驻任务不再排巡检）→ 已探索
- audience/compliance：内部研发平台（vteam 自用），无合规约束 → 已探索

## Approval gate

status: passed

用户回复「OK，没问题，写计划吧」→ 批准。已 `scaffold-plan.mjs task-long-running --clear`（无 `--draft-only`）创建 `.omo/plans/task-long-running.md`，Metis gap analysis 已跑并折叠，11 个 todo 已 APPEND，`## TL;DR (For humans)` 最后填。

## Metis gap analysis — 折叠结果（BLOCKER 全部独立复核后成立）

| # | 发现 | 处置 |
|---|---|---|
| B1 | **Success criterion #4 不可执行**：整条流水线**没有任何数据库**——`server/test.db` 不存在、`jest.config.js` 无 `globalSetup`、`ci.yml:35` 无 `db push`/`migrate` 也无 MySQL service、`grep "new PrismaService()"` 零命中、唯一 e2e spec 自述「不依赖外部DB」 | 已核验。全部断言改写为对内存 `rows` map + mock prisma 的断言；Verification strategy 加「任何 QA 不得声称迁移跑过」的硬约束 |
| B2 | **`:1757`「blocked 唯一写入点」是错的**：`data: { status: to, ... }`（:1758）是七迁移共用 CAS；`blocked` 有三个生产者（`block()` :1266-1277 人工 / `systemBlock()` :1296 看门狗 / `transitionByAgent` :1565 agent，D4 明确放行） | 已核验（读了 :1750-1762 + grep）。Must NOT have 首条即「不得在 :1758 通用 CAS 加门禁，只有 `systemBlock()` 该被门禁」 |
| B3 | **门禁位置是静默失败**：`handleProgressionFire` :522-528 读任务但 :565 才 `runPatrol()`、:567-568 才 `quietStreak++`，门放 :565 之后仍叫醒 agent 且不抛异常 | todo 3 验收新增「`dispatchAgentMention` 未被调用」+「`quietStreak` 未推进」，并加**必做**的 failure 场景：临时把门移到 :565 之后，断言必须红 |
| B4 | **缺负向对照**：一个「对所有任务都返回 `{expire:true}`」的实现能通过全部正向断言，同时把全平台看门狗打死 | todo 3 验收第 ④ 条 + 必做 failure 场景 |
| B5 | **缺 boot 断言，尤其 B2（终态行仍被清扫）**——这是防止「把清扫删掉」这个错误修法的唯一护栏 | todo 7 验收 ②③④（B1/B2/B3） |
| B6 | **C1 应为 TDD**：`memory-role-inject.migration.spec.ts:7-9` 记录 PR #36 漏 `ADD COLUMN` 致生产 `ERROR 1054`；且迁移 SQL 从不被执行，文本契约是唯一护栏 | todo 1 改为 TDD 内部有序（先写断言跑到红，再写 DDL 到绿），含两条必做 failure 场景 |
| S1 | 「5 个强制执行点」实为 **3 个**：`persistPatrolTrigger`(:260) 是 private 唯一调用者是 `register`(:250)；`restoreInProgressTasks`(:1022) 每行只有 `register(row.id)`(:1026) | Scope IN #4 收窄为 3 点，并写明为何删掉另两处 |
| S2 | **`:126` 是第 6 处假注释**（「缺省 20min」vs `:40` 的 `10 * 60_000`） | 已核验。Scope IN #9 与 todo 7 纳入 |
| S3 | 「遗留行 ≤30s 自毁」错——30s 是已退役旧扫描器周期，真实是**一个巡检间隔 10min** | 改为 10min，并作为 L3 写进 runbook |
| S4 | **清扫修法应从行 `payload.taskId` 取任务**（:76-79、写入点 :622），不得解析 `dedupKey` 字符串 | 已核验 :618-624。todo 7 明确 |
| S5 | 「本改动减少触发器行」错——清扫修法让启动**不再**取消，存量行反而跨发版存活 | Execution strategy 交互 #4 订正 |
| S6 | **TC-TASK-016 不是断言**（手写 QA 目录行，无人执行，且已陈旧：`mainAgentId` vs 实际 `mainAgentMemberId`） | 从「会被打破的既有断言」降级为可选文档同步 |
| S7 | 工具数 32 **还**被 `agent-role-capabilities.migration.spec.ts:210-211` 钉死 | 已核验。Must NOT have 与 todo 4/9 均补上第二处 |
| S8 | **`asDto` 是无检查 cast**，`@IsBoolean()` 保护不到 agent 入口 | todo 4 加 failure 场景：传 `longRunning: "yes"` 不得 500 |
| S9 | 注释验收不该 grep 具体措辞 | Success criterion #8 改为「断言常量与注释一致」，并用 `plan-removal.guard.spec.ts` 的源码守卫先例形态 |
| S10 | 缺 `scripts/gate.sh` 主门禁与裸 catch baseline 175 | Verification strategy 补齐；todo 7/9/10 纳入 |
| S11 | 缺 Scope OUT：session 判死/静默看门狗（`worker-dispatcher.ts:4025`/`:3535`）——长驻值班会话闲置数日后**它比巡检更可能杀掉会话** | Must NOT have 补一条，并说明「若上线后被判死另开 issue」 |
| S12 | 缺 Must NOT：agent 门禁必须 403 非静默跳过；不得门禁人工路径 | Must NOT have 补两条，并配负向断言（todo 6 验收 ③⑤⑥） |
| S13 | 文档实为 **5 个**文件带 `resetAfterComplete`（漏 `14-…`、`28-…`），且 draft 写错两个文件名 | Scope IN #12 改为 5 文件 + 正确文件名 |

**已核验的解除项**：11 个 `*.migration.spec.ts` 对 `tasks`/`model Task`/`` CREATE TABLE `tasks` `` **零命中**（只解析 `memories`/`agent_roles`/`roles`/`execution_policies`），跨切常量仅 `VTEAM_MCP_TOOL_NAMES`(32)/`BUILTIN_AGENT_ROLES`(7)/`PLATFORM_CAPABILITY_KEYS`(29) ⇒ 给 `model Task` 加一列**不破坏**任何既有迁移契约测试。这正是把护栏放进**新** spec 的理由。

**Spec 资产被低估（已核验）**：`task-progression.scheduler.spec.ts:177-209` 是**功能性内存 TriggerService**（`rows` map 按 `dedupKey` 索引、`schedule` 尊重 `maxFires`、`cancel` 翻 `CANCELLED`），故 `rows[key].status`/`.fireCount`/`.payload.quietStreak` 可直接断言；`:246-256` 已有「幂等：保留 fireCount/quietStreak」用例——**正是清扫修法要恢复的不变量**，只是从未经 `onModuleInit` 跑过，所以 bug 活了下来。`tasks.service.spec.ts` 对 Task DTO 零 `toStrictEqual`，加宽 `toTaskDto` 不破。

## 采纳的 owner-decision（用户已答 4 个；Metis 新提 4 个，按可辩护默认采纳并公示）

| # | 问题 | 采纳默认 | 可逆 |
|---|---|---|---|
| OD-1 | 硬删值班任务会让同团队 `queued` 行成为孤儿（`remove()` 从不调 `promoteNextInTx`，而 `createTaskInternal:359` 会把该团队读成空闲） | **接受并记录为 L1**。修复就是删完调 `promoteNext`——但那正是 D6 禁止的队列改动。手工修复入口 `promoteNext(teamId)`（:649-652）已存在，无数据丢失。**已公示：若要消除，唯一改动是 `remove()` 末尾加一行 `promoteNext`（给 D6 开一个口子）** | 是（一次 API 调用） |
| OD-2 | UI 是否加徽章/列表过滤 | **不加**，严格对齐 `resetAfterComplete`（该字段全仓无任何徽章） | 是（纯增量） |
| OD-3 | 迁移内嵌 `UPDATE ... WHERE id=...` vs 人工执行 | **人工执行**，拒绝迁移内嵌。硬编码 id 不可复审、不可重跑，且摧毁「零回填」这个安全属性 | 是（一条 UPDATE） |
| OD-4 | 文档：只补行 vs 顺带修既有漂移 | **只补行**。`13-…:42`「五态」/`13-…:43` `mainAgentId` 属既有漂移，另开 issue——吸收进来会把一列改动变成没人要求的文档重写 | 是（仅文档） |

## 结构性自检（已跑）

- 首个 `## ` 标题 = `## TL;DR (For humans)` ✓（HR6 backstop）
- 标题顺序 = 模板顺序 ✓（TL;DR → Scope → Verification strategy → Execution strategy → Todos → Final verification wave → Commit strategy → Success criteria）
- 实施行 11 条，全部 column-zero 且匹配 `- [ ] N. ` ✓
- 终验行 4 条，全部 column-zero 且匹配 `- [ ] F<n>. ` ✓
- `Recommended task executor category:` 行 15 条 = 11 实施 + 4 终验 ✓（F3/F4 原本误用中文标签「推荐 category:」，已 perl 归一）
- 无散文标题/普通 bullet 被当作 task ✓

## Review round state

status: in_flight
phase: review_round_initialized
review_required: true
reviewer_request: 用户在计划交付后明确要求「跑双评审」（CLEAR 路径的 opt-in）
plan_path: .omo/plans/task-long-running.md
plan_sha256: cf024df2505802fc4305b2a2561ad6325482fbc44641eb3a18354724facffeea
review_round_id: r1-20261001T094558
round_status: active
pending-action: review .omo/plans/task-long-running.md

retrieval validation (parent-side, before dispatch): workspace root realpath = /Volumes/SSD-Data/01work/git-project/vteam；`.`/`.omo`/`.omo/plans` 三段 `test -L` 均为 false 且 `stat -f %HT` 均为 Directory；`.omo/plans/task-long-running.md` 为 Regular File；sha256 由同一次读出 `cf024df2…ffeea`；68697 bytes / 302 lines。runtime_home = /Users/mac。

review:
  momus: { status: launching, workspace_root: /Volumes/SSD-Data/01work/git-project/vteam, runtime_home: /Users/mac, target: .omo/plans/task-long-running.md, round_id: r1-20261001T094558, plan_sha256: cf024df2505802fc4305b2a2561ad6325482fbc44641eb3a18354724facffeea, launch_id: 1790819158-a1, session: null, result: null }
  independent: { status: launching, workspace_root: /Volumes/SSD-Data/01work/git-project/vteam, runtime_home: /Users/mac, target: .omo/plans/task-long-running.md, round_id: r1-20261001T094558, plan_sha256: cf024df2505802fc4305b2a2561ad6325482fbc44641eb3a18354724facffeea, launch_id: 1790819158-a1, session: null, result: null }

convergence: max_rounds 5（仅显式用户请求可突破）；ledger 在 round 1 后冻结；approval-with-notes 计为 approval；fix 走最小编辑、不扩范围。

## Round 1 结果（两路均 changes_requested）+ 修复

两路都过了检索门（sha256 `cf024df2…ffeea` / 68697 bytes，均回显一致）。

### 两路冲突的裁定

**`tool-naming.spec.ts` 加参数是否变红**——Oracle 判「不变红，且我的同步指示会把绿 spec 弄红」，Momus 判「necessarily fails it，必须同步」。我以代码裁定：`:186-192` 的 `observed` 是 `Object.fromEntries(['selfInstanceId','teamId','taskId'].map(...))`，**只投影 3 个 key**，schema 里第 4 个 key 对断言不可见。**Oracle 正确，Momus 这条判错。** 已按 Oracle 修。

### 接受的 blocker 台账（round 1 后冻结）

| id | 来源 | 类别 | 核实 | 修法（最小编辑） |
|---|---|---|---|---|
| B-A | Oracle B1 | explicit_requirement_or_accepted_decision | ✅ 自查 `:417-422` 在 `if` 里、`else` 只 `warn`；`:426` 照常 rollout；`set -euo pipefail`(:58) 在条件语境无效 | Must have #13 与 todo 11(2) 改为「best-effort，不是门禁」+ 补人工校验步骤；**明写不改 `deploy-k8s.sh`** |
| B-B | Oracle B2（裁定） | explicit_requirement_or_accepted_decision | ✅ 自查 `:186-192` 投影 | **删除**「同步期望集合」的危险指示；改为显式禁令；todo 4 AC① 改为「该 spec 未被修改且仍绿」 |
| B-C | Oracle B3 = Momus B1 | reproducible_broken_flow / explicit_requirement_or_accepted_decision | ✅ 两条路径都确认同文件 | **把 todo 3 的 clause (c) `systemBlock` 门禁整体迁入 todo 6**（同文件归一所有者在 Wave 3、已串在 todo 2 之后）；todo 3 变单文件；波次表改为精确列文件域；矩阵 3/6 行修正 |
| B-D | Momus B2 | reproducible_broken_flow | ✅ 自查 `:577` → `:578-584` 递延分支 + `hasInflightWork`(:641) | todo 11 failure QA 与 F3(d) 补**前置条件**（无 `in_progress` issue + 任务分区 10min 无新消息）并改看低层信号（`quietStreak` 递增 + `fireStallDetected`），群公告降为表象 |

### 折叠的 non-blocking notes

Oracle N1（**三处 `select` 无任何验收能证明含 `longRunning`**——mock 全返回固定对象，漏加则单测全绿而线上门禁已死）→ 采纳，扩展 todo 7 源码守卫 · Oracle N2（L1 第二类孤儿：`remove()` 也不删那条 `progression_patrol` 行）→ 采纳 · Oracle N3/Momus N6（裸 catch 命令 `grep -rc` 出每文件计数，须用 CI 权威 `-E 'catch[[:space:]]*\{'` + `grep -rn … | wc -l`；实测 166/175）→ 采纳 · Oracle N4/Momus N5（依赖矩阵自相矛盾）→ 采纳 · Oracle N5/Momus N4（只有 3 个文档含 `resetAfterComplete`，非 5）→ 采纳，改为「5 个要补、其中 3 个有该字段」 · Oracle N6（web 未勾时是**省略 key** 不是 `false`）→ 采纳 · Momus N1（`:681` 不是工具数断言，真断言在 `:294`）→ 采纳 · Momus N2（**6 处里只有 4 处是事实错误**，`:59`/`:107-109` 内容为真；且原 AC⑤ 的 grep 逼着把真注释改错）→ 采纳，AC⑤ 改为只对错误表述零命中 · Momus N3（scheduler 不持有 TasksService 依赖，spec 无 `systemBlock` 符号）→ 采纳，AC③ 改断言 `stallHandlers` 为空 · Momus N7（8 处行号漂移）→ 采纳 · Momus N8（`t_0000000003` 仅是测试夹具，`seed.ts` 无此行，id 应为运维输入）→ 采纳。

### 未采纳 / 记为 note

无 blocker 被判不合格。**用户的三条红线未被任何一方挑战**，评审未要求扩大范围；`fix_edit_policy = smallest_edit_no_scope_expansion` 全程遵守。

## Review round 2（已派发）

plan_sha256: **a69ddc9a31d96c2df211c2f13f786f967769e39ac93613f0375e163d79595378**（77384 bytes / 306 lines）
review_round_id: **r2-20261001T100013**
launch_id: **1790820013-b1**
ledger: 已冻结（4 条 accepted blockers 全部已修）
round 2 范围限定：只核实 4 条已修 blocker + 检查修复是否引入回归 + 符合 blocker_eligibility 的新发现。**不得**重扫全盘。

## 双路高精度评审 — 终态（已完成）

plan_sha256（最终，与两路批准摘要一致）: `2b59bf831819b3e569c2644d40cdffb4c8ef12e75c03e1a1cf59137d0614bafa`（80675 bytes / 307 lines）
final review_round_id: `r5-20261001T110130` · launch_id: `1790823690-e1`

| 轮 | 绑定摘要（前 8 位） | Oracle | Momus | 该轮 blocker |
|---|---|---|---|---|
| r1 | `cf024df2` | changes_requested | changes_requested | 5 |
| r2 | `a69ddc9a` | changes_requested | changes_requested | 5 |
| r3 | `176ce3f6` | **approved** | **approved** | 0 |
| r4 | `f23634e7` | **approved** | **approved** | 0 |
| r5（上限） | `2b59bf83` | **approved** | **approved** | 0 |

评审会话：Oracle `ses_f0adbb4a1ffeULM5GIFVSHIyW1` / `ses_f0ace9f6bffdy4pHETfJR68l9l` / `ses_f0ace590b7ffdCSUMlIV6g2QOSR` / `ses_f0aa3389effe4LbenJCJoBuztu` / `ses_f0a969a05ffee0LxGy1U2F40G1`；Momus `ses_f0adb8824ffeDOWfeIRTBXnrIj` / `ses_f0ace9f2cffdN2WfuLt54AFcEt` / `ses_f0ac59071ffdLb0iQkyUdzGhY7` / `ses_f0ac590b7ffdCSUMlIV6g2QOSR` 的 Momus 路 / `ses_f0aa3389effe4LbenJCJoBuztu` / `ses_f0a969a04ffehb1Pgpdjz266TX`。

累计 **12 个 blocker 全部核实成立并修复**，零条为评审方吹毛求疵。其中三类若混进生产会造成「套件绿、门禁死」：
1. **恒真断言**（r2 B3）：裸 catch 命令被写成 `-E 'capture'[[:space:]]*'\{'`，zsh 报 `no matches found`、计数 0，永远 ≤175 通过，却标为「权威」并附假证据值 166。Momus 实跑发现。
2. **互斥门禁**（r2 B4/B6，双路互证）：Success criteria #8 要求「已退役」零命中，而 Must have #9 / todo 7 AC⑤(iii) / F2 三处明令保留它（该子串在 `:59`/`:107-109` 处**内容为真**）。唯一能满足的方向是被禁止的方向。
3. **行数探针**（r4 N13/P9，双路互证）：`grep -c` 计匹配行数，而 todo 强制要求写会提及列名的 WHY 注释块 → 正确实现被判失败。

**两路冲突 2 次，均以源码裁定**：
- r1 `tool-naming.spec.ts` 加参数是否变红 —— Oracle 判「不变红且我的同步指示会弄红绿 spec」，Momus 判「必然变红」。以 `:186-192` 的 `Object.fromEntries(['selfInstanceId','teamId','taskId'].map(...))` 裁定：**Oracle 对**。
- r4 矩阵第 11 行收窄是否制造矛盾 —— Oracle 与我判「制造」，Momus 判「消除」。以「Wave 4 并行依据目录不相交、是并发主张非依赖主张」裁定：**Momus 对**。

**用户的三条红线全程未被任何一方挑战**：「不改队列、不动看门狗阈值、零回填」原样保留，`fix_edit_policy = smallest_edit_no_scope_expansion` 五轮无例外。

留档的非阻塞 note（不重开台账）：todo 1 AC③ 探 `ALTER TABLE`，若 WHY 注释块内 legit 出现该字面量会输出 2（措辞可避免、输出自明、改一词即恢复，且 AC⑤ 的解析式断言才是实质护栏）；AC④ 省略了完整路径；`ci.yml:37-43` 与 `:43-46` 两种引用同指一个守卫块。

## Approval gate

status: passed（计划已交付，执行待用户启动）

next workflow action: 用户在独立 worker 会话执行 `$ulw-execute task-long-running`。**规划方不自行开始执行。**
