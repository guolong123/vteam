# task-long-running - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** Tasks gain one new property: whether it is a long-running duty task. When set, the progress watchdog stops touching it entirely — no more waking it every ten minutes, no more auto-blocking it, no more "task stalled" notices in the group chat. It also cannot close itself: the agent is blocked from submitting the task for sign-off, so a stray "shift's over" message can't make the duty task disappear. People keep every completion tool they have now — mark-for-review, accept, archive — and the task can now also be deleted outright.

**Why this approach:** The watchdog exists to push a task toward a finished state. A permanent duty task has no finished state, so the watchdog is not misfiring — it is the wrong mechanism entirely. The fix is therefore a task-type distinction rather than a threshold tweak, and it is enforced at every place the watchdog could act, not just where it schedules.

**What it will NOT do:** It will not touch the team queue, the task state-transition table, or any watchdog timing values. It will not add a badge or list filter for the new property. It will not delete the code that marks a task as stalled. It will not add any session-rotation or context-compaction mechanism.

**Effort:** Large
<!-- Effort is exactly ONE band, never hours/days. Quick = single edit, minutes of agent work; Short = one focused change, a few files; Medium = multi-file feature in one session; Large = several waves, one long session; XL = multi-session or architectural work. A written duration is rewritten to a band. -->
**Risk:** Medium - two of the enforcement points fail *silently* in the dangerous direction if placed a few lines too late, and the database change is the one class of edit whose failure is invisible until deploy.
**Decisions to sanity-check:** Whether deleting a duty task should also promote the next queued task in that team (currently it does not — see Known limitations).

Your next move: start the worker session with `$ulw-execute task-long-running`. Full execution detail follows below.

---

> TL;DR (machine): Large / Medium risk. 11 implementation todos (4 deep-low, 2 quick, 1 visual-engineering, 2 writing, 2 unspecified-high) + F1-F4; new `tasks.long_running` column with TDD'd migration contract, watchdog exemption at 3 enforcement points, agent-completion gate, hard-delete exemption, plus 2 drive-by truth fixes.

## Scope

### Must have

1. **`tasks.long_running` 列落地（TDD 顺序）** — `server/prisma/schema.prisma` 的 `model Task` 内、`resetAfterComplete`（:249）之后新增 `longRunning Boolean @default(false) @map("long_running")`；手写迁移 `server/prisma/migrations/20261001000000_task_long_running/migration.sql`，内容为开头中文 WHY 注释块 + 单条 `ALTER TABLE \`tasks\` ADD COLUMN \`long_running\` tinyint(1) NOT NULL DEFAULT false`（**零回填、零 DROP、无索引**）；`npx prisma generate` 重生成 client。
   - **顺序被 PR #36 强制为 TDD**：仓库第一个迁移契约测试 `server/src/prisma/memory-role-inject.migration.spec.ts:7-9` 开篇即记录「因 PR #36 漏 `ADD COLUMN` 上生产，init job 抛 `ERROR 1054`」。且 CI 全程不建库（见 Verification strategy），契约测试是这份手写 DDL 的**唯一**护栏。⇒ **先写断言并跑到红，再写 DDL 与 schema 直到绿。**
2. **迁移契约 spec** — 新增 `server/src/prisma/task-long-running.migration.spec.ts`，照 `memory-role-inject.migration.spec.ts:43-49/52-68/70-124` 的文本解析模式，把 `tableDefinition()` helper 从 `memories` 移植到 `tasks`。必须断言 **双向** 平价（既有先例只断言 migration→schema 方向，`:71-79`）：正向「DDL 有该列 + `DEFAULT false` + 无 `UPDATE` 回填 + 无 `DROP`」；**反向「`model Task` 内确有 `longRunning Boolean @default(false) @map("long_running")` 字面量」**（`@map` 拼错时正向仍会过，但运行时 Prisma client 与实际列名静默不一致）；**基线不存在性**「`CREATE TABLE \`tasks\`` 块内无 `long_running`」（否则 deploy 报 `ERROR 1060`）。
3. **字段全管道往返** — `tasks.service.ts:81`（`TaskRow` 类型）/`:414`（`createTaskInternal`，默认 `?? false`）/`:723-725`（`update` 条件赋值）/`:1998`（`toTaskDto`，`Boolean(...)` 归一）；`dto/create-task.dto.ts:46-52` 与 `dto/update-task.dto.ts:43-49` 各加 `@ApiPropertyOptional` + `@IsOptional() @IsBoolean()`。Controller 零改动（`tasks.controller.ts:152/242` 已绑定）。`createByAgent`（:254）与 `create`（:228）共用 `createTaskInternal`，故一处改动覆盖 HTTP 与 agent 两条建任务路径。
4. **巡检豁免 —— 恰好 3 个强制执行点，不是 5 个** —
   - (a) `register()`（`task-progression.scheduler.ts:234-241`）：任务 `longRunning` 则早退，不排期。
   - (b) `handleProgressionFire()`（`:522-528`）：`select` 加 `longRunning`，命中则 **`return {expire:true}`**。**这是唯一必经点，且必须置于 `runPatrol()`（:565）与 `quietStreak++`（:567-568）之前** —— 门放在 :565 之后仍会叫醒 agent 并推进计数，而两种失败都不抛异常。
   - (c) `tasks.service.ts:1298` `systemBlock()` 内 `transition` 之前复查，命中则跳过自动置阻塞。**在 todo 6 实现**（同文件归 todo 6，避免 Wave 2 并发写）。
   - **只这 3 处。** 原先列入的 `persistPatrolTrigger()`（:260）与 `restoreInProgressTasks()`（:1022）**删除**：`persistPatrolTrigger` 是 `private` 且唯一调用者是 `register`（:250）；`restoreInProgressTasks`（:1020-1033）每行只有一句 `await this.register(row.id)`（:1026）。两者均被 (a) 传递覆盖。删掉可少一处 `findMany.where` 改动。
5. **生命周期门禁** — `tasks.service.ts:1565-1591` `transitionByAgent()`：把现有 `if (action === 'accept' || action === 'archive')`（:1581）扩展为同时覆盖 `mark-pending-review`，条件加 `task.longRunning`。抛 403 `TASK_ERRORS.TASK_AGENT_COMPLETION_FORBIDDEN`，沿用 :1584-1587 既有文案风格（已含「不要重复调用」）。放行 agent 的 `start`/`block`/`resume`；**人工路径全部七个动作一行不改**。
6. **硬删豁免** — `tasks.service.ts:1369-1376` `remove()`：把 `if (task.status === 'in_progress' || task.status === 'pending_review')` 收窄为 `&& !task.longRunning`。**必须写成条件收窄，不得写成 `if (task.longRunning) return ...` 早退** —— 早退会连带跳过 :1363-1368 的 404 分支。
7. **MCP 工具面** — `platform-mcp.tools.ts:707-719` `taskCreateSchema` 加 `longRunning: z.boolean().optional()`（照 `memorySaveSchema.autoInject` :395-400 的模式）；`platform-mcp.service.ts:3226-3276` `taskCreate` 透传（照 :3487 的 `args.x === true` 归一）；`platform-mcp.service.ts:1230-1237` `taskContext` 的 `select` 暴露该字段。
   - **注意**：`resetAfterComplete` 当年**没有**进 `task_create`，本项是净新增而非模板复制。`task_create` / `task_context` 均在 `platform-mcp.tools.ts:124-126/707-719` 现有注册表内，**不新增工具名**。
8. **Web** — `web/src/components/tasks/task-detail-types.ts:41` 附近加字段；`web/app/(main)/tasks/new/page.tsx` 加勾选（照 `reset-after-complete-toggle` 模式：checkbox :209-216、state :251、payload :285、wiring :341-342）；`web/e2e/reference/testids.ts:108` 附近注册新 testid。
9. **顺带修 A：注释订正（4 处事实错误〔含 1 处间隔数错〕+ 2 处措辞误导 + 2 处 quietStreak 失实描述，合计 8 处）** —
    - **事实错误（4 处）**：`:182-183`、`:207-208`、`:976-978` 声称「periodic patrol 已退役 / fan-out JOIN drain 接管」，而 `triggers.schedule()` 在 `:281-291` 真实在跑；另 `:126` 写「缺省 20min」而 `:40` 是 `10 * 60_000`。
    - **措辞误导（2 处，事实为真但表述会误导下一个人）**：`:59`「旧 setInterval 驱动已退役」与 `:107-109`「自主 setInterval 扫描已退役」**本身是真的**（setInterval 扫描确实已退役、ticker 确为唯一节拍），但它们常被下游读成「巡检整体已退役」。**改写时必须保留其真实性**（说明「仅 setInterval 扫描退役，interval 行巡检仍由 trigger ticker 驱动」），**不得**为满足任何验收门禁而删掉「已退役」字样后重写成新的错误断言——Success criteria #8 的零命中清单**只含**「退役清扫 / fan-out JOIN drain 接管 / periodic patrol 退役」三串，不含「已退役」。
    - **另订正** `:98` 类注释与 `register` 文档 `:229-230` 关于「重启安全核心 / quietStreak 不清零」的失实描述（见 todo 7 的清扫修法）。
10. **顺带修 B：启动清扫顺序 bug** — `onModuleInit` 中 `cancelStalePatrolTriggers()`（:184，`:980-1001` 无条件把库内**所有** pending 巡检行置 cancelled）先于 `restoreInProgressTasks()`（:187）。后者 → `register` → `persistPatrolTrigger` 见行已 cancelled → **删掉重建**（:274/:281），`fireCount` 归零、`payload` 不含 `quietStreak`，使 `:270-272` 的幂等早退在启动路径上永不命中。**修法：给清扫加「跳过该行 payload 里的 `taskId` 所指任务仍在 `in_progress`」的条件。** `taskId` 从行 `payload` 读（`ProgressionPatrolPayload` :76-79，写入点 :622），**不得解析 `dedupKey` 字符串**。**清扫本身不得删除**（它负责清理进程宕机期间转终态的任务遗留行）。
11. **同步既有断言** — 本次**没有**任何会因「新增一个 schema 参数」而变红的既有断言。`server/src/platform-mcp/platform-mcp.tool-naming.spec.ts:153-157` 看似钉死 `task_create` 的参数集合，但它的 `observed` 是 `Object.fromEntries(['selfInstanceId','teamId','taskId'].map(...))`（:186-192）——**只投影这三个 key**，故给 `taskCreateSchema` 加第 4 个参数 `longRunning` 后 `observed.task_create` 完全不变，该 spec **保持绿**。⚠️ 因此 **todo 4 不得**把 `longRunning` 加进 `expected.task_create`：那会引入一个 `observed` 永远不可能有的 key，`toEqual`（:202）反而把一条当前绿的 spec 弄红。
12. **文档同步** — 在 **5 个** `docs/agent-platform/` 文件补 `longRunning` 行（⚠️ 其中只有 **3 个**含 `resetAfterComplete`——`14-…`/`15-…`/`28-…`；`09`/`13` **从未收录**该字段，属既有漂移，本次只补 `longRunning`、不修漂移）：`docs/agent-platform/15-数据模型细化（ER图）.md:156-177`（字段表，`reset_after_complete` 在 :168）与 `:475-490`（ER mermaid，:483）、`docs/agent-platform/09-API设计.md:114-128`、`docs/agent-platform/13-任务状态机与全生命周期.md:36-50`、`docs/agent-platform/14-Agent配置与虚拟团队模型.md:204/281/296`、`docs/agent-platform/28-团队模型与排队设计.md:59/125/127`（后者 :11 自称团队域**唯一事实源**）。
13. **上线 runbook** — 顺序：迁移 → schema.prisma → `prisma generate` → 代码 → 部署 → `UPDATE tasks SET long_running=1 WHERE id='t_0000000003'` → **再** `POST /tasks/:id/resume`。须写明：(a) `scripts/deploy-k8s.sh:417-422` 的 `kubectl wait --for=condition=complete job/${RELEASE}-init` **是 best-effort，不是门禁**——它在 `if` 里且 `else` 分支只 `warn`（:421-422），随后 `:426` 的 `kubectl rollout status deploy/${RELEASE}-server … || warn` 照常执行；`set -euo pipefail`（:58）救不了，两个都在条件语境里。**故「迁移先于应用启动」并非脚本结构性强制，而是靠人工纪律**，runbook 必须补一个显式人工校验步骤（rollout 前确认 `_prisma_migrations` 无 `failed` 行、且 `tasks.long_running` 列已存在），否则迁移失败会带着 `Unknown column` 跑完 rollout；(b) `deploy-k8s.sh` 本身**不在本 PR 修改范围**；`prisma migrate deploy` **不**把 MySQL DDL 包进事务（失败会在 `_prisma_migrations` 留 `failed` 行，需人工 `migrate resolve`），单条 `ALTER TABLE ADD COLUMN` 在 MySQL 8 本身原子，风险低但需写明恢复路径；回滚 flag 用 `UPDATE ... SET long_running=0`，回滚列只能 dump-restore。

### Must NOT have (guardrails, anti-slop, scope boundaries)

- **不得在 `tasks.service.ts:1757-1759` 的通用 CAS 上加任何 `longRunning` 门禁。** `data: { status: to, version: {increment:1}, ...opts.fields }`（:1759；:1758 是其 `where:`）是**七个迁移共用**的写入口；`blocked` 有三个生产者——`block()`（:1266-1277，人工）、`systemBlock()`（:1296-1299，看门狗）、以及经 `transitionByAgent`（:1565）的 agent 路径。**只有 `systemBlock()` 该被门禁**（todo 4c）；人工 `block` 与 agent `block`（升级通道，决策 D4）必须照旧可用。
- **agent 的 `mark-pending-review` 必须返 403，不得静默跳过。** 静默跳过会让 agent 无限重试——正是既有 `accept`/`archive` 403 文案（:1585-1587「不要重复调用」）所警告的病理。
- **不得门禁人工路径。** `mark-pending-review`/`accept`/`reject`/`archive`/`block`/`resume` 对 `longRunning` 任务必须全部照旧可用（用户明确要求保留人工完成通道）。需负向断言，不得只靠散文。
- **不改** `Team.currentTaskId` 语义、`promoteNextInTx`、或任何队列逻辑。值班群独占团队是用户确认的设计意图。
- **不改** `TASK_TRANSITIONS`（`server/src/common/constants/task.constants.ts:44-55`）。门禁是叠加在既有表之上的 actor×type 前置检查，不是新状态或新动作。
- **不改** 任何看门狗阈值：`PROGRESSION_INTERVAL_MS` / `PROGRESSION_MAX_ROUNDS` / `STALL_QUIET_STREAK_LIMIT` / `STALL_CHAT_ACTIVITY_WINDOW_MS`。根因是语义不适用，不是阈值不当。
- **不做**心跳巡检、不保留任何形式的周期唤醒。不排期即无需为 `longRunning` 特殊处理 `maxFires`/`intervalMs`。
- **不新增** MCP 工具名。工具总数必须保持 32 —— 被 `server/src/platform-mcp/platform-mcp.controller.spec.ts:278`（`tools/list` 用例，断言在 :294）**和** `server/src/prisma/agent-role-capabilities.migration.spec.ts:210-211`（`toHaveLength(32)` + `new Set(...).size === 32`）两处钉死。⚠️ 同一文件 `:681` 的 `id: 32` 是 `wecom_reply` 的 JSON-RPC 用例体，**不是**工具数断言，不要把它算作第二处。
- **不做**启发式数据回填（不得用 `title LIKE` 或 `status` 推断）。**不得**在迁移内嵌 `UPDATE ... WHERE id=...` —— 硬编码 id 不可复审、不可重跑，且摧毁「零回填」这个安全属性。
- **不写** down-migration（仓库无此约定，`docs/tech-debt-rollback.md:12-15`）。
- **不删** `scan()`（:377）/`patrolNow()`（:364）/`isRegistered()`（:346）死代码。属独立清理。
- **不删** `cancelStalePatrolTriggers` 本身，只收窄其条件（见 todo 7 的 B2 断言）。
- **不改** `worker-dispatcher` 的 session 空闲扫描（`server/src/chat/worker-dispatcher.ts:4025`）或静默看门狗（:3594 静默唤醒截止）。二者作用域是 Session，不改 Task 状态（该文件对 Task 只有 :4298 一处读，零写）。**已知局限**：长驻值班会话闲置数日后，session 判死比巡检更可能杀掉它——若上线后出现值班会话被判死，另开 issue，不在本 PR 扩范围。
- **不加**会话轮转 / 上下文压缩机制。人工 `accept` 触发 `tasks.service.ts:1812-1829` 的 session reset，交接班即出口。
- **不改** `swagger-mcp` 的 `POST /tasks` 绑定现状（`swagger-mcp.handlers.ts:125-126` 有意不绑），不新增接线。
- **不加** 徽章 / 列表过滤（见 Known limitations）。**不提交** `openapi.json`（`@ApiProperty*` 是 `/docs` 与 swagger-mcp 唯一真源，`swagger-tools.ts:140-184`）。
- **不碰**工作区任何无关的已修改 / 未跟踪文件。发现即报告，不清理、不覆盖。

### Known limitations（有意接受，随 runbook 记录）

- **L1 — 硬删值班任务会让同团队的 `queued` 行成为孤儿。** `remove()`（:1378-1453）删掉本任务的 `teamQueue` 行并置空 `teams.currentTaskId`（:1449-1452），但**从不调用 `promoteNextInTx`**。本改动之前 `in_progress` 不可删，故此状态不可能出现；Must have #6 之后它成为可能。删掉值班任务 ⇒ 团队 `currentTaskId = null` + 若干永无人提升的 `queued` 行，而 `createTaskInternal:359`（`isIdle = !team.currentTaskId`）会把该团队读成**空闲**并让新任务插队。**今天影响面小，只因值班团队恰好只有这一个任务**（决策 D6）；一旦有人往该团队加第二个任务即成活 bug。修复路径是删完调 `promoteNext` —— 但那正是 D6 禁止的队列改动，故本 PR 不做。**第二类孤儿（同样由本改动首次变得可能）**：`remove()` 也**不删**那条 `payload.taskId` 指向被删任务的 `progression_patrol` 触发器行（只有 `persistPatrolTrigger`/`cancelStalePatrolTriggers` 碰 `triggers` 表）。影响有界——该行会经 `handleProgressionFire` 的 `!task → {expire:true}`（`trigger.service.ts:583-593`）自毁，且收窄后的启动清扫也会取消它（已删任务不是 `in_progress`）。**状态可手工修复**：公开入口 `promoteNext(teamId)` 已存在于 `tasks.service.ts:649-652`，无数据丢失（其他任务的 `teamQueue` 行存活）。**若你要消除它，唯一改动是在 `remove()` 末尾对该 team 调一次 `promoteNext`——一行，代价是给 D6 开一个口子。**
- **L2 — 不回填存量。** 除被显式指定的那一个值班任务外，任何已存在的常驻任务都不会自动被豁免，需逐个显式设置。⚠️ 该任务 id 由**运维提供**：`t_0000000003` 在仓库里只作为 `tasks.service.spec.ts` 的测试夹具出现，`server/prisma/seed.ts` 中并无此行，执行者无法从仓库确认它就是那个值班任务。
- **L3 — 改 flag 不主动注销遗留巡检行。** 依赖 `handleProgressionFire` 的 `{expire:true}` 在该行下次到期时自毁，即**最长一个巡检间隔（10min）**，不是 30s（30s 是已退役的旧扫描器周期，`TRIGGER_SCAN_INTERVAL_MS_DEFAULT`）。若需立即生效，运维可手工取消该 `progression_patrol` 行。

## Verification strategy
> Zero human intervention - all verification is agent-executed.

- **测试库现实（必须先知道，否则会写出不可执行的验收）**：**整条流水线里没有任何数据库。** `server/test/setup-env.js` 虽设 `DATABASE_URL=file:./test.db`，但 `server/test.db` **不存在**、`server/jest.config.js` **无 `globalSetup`**、CI（`.github/workflows/ci.yml:35`）**不跑 `db push`/`migrate` 也无 MySQL service**、`grep -rn "new PrismaService()"` 在 `server/src` + `server/test` **零命中**（每个 unit spec 都注入 `jest.Mock()` Prisma）、唯一 e2e spec 自述「不依赖外部DB（内存模拟服务行为+HTTP伪SSE）」（`server/test/e2e/team-queue.e2e-spec.ts:7`）。
  ⇒ **任何 QA 步骤都不得声称「迁移跑过了」或「约束在真实 DB 里成立」。** 全流程中真正触碰该列的只有三件事：`npx prisma validate`、`npx prisma generate`、`tsc --noEmit`。
- **Test decision**：**C1（todo 1，迁移 + 契约 spec）为 TDD**，其余 9 个 todo 为 tests-after。TDD 的依据不是风格偏好，而是三条已核验的事实：(i) `memory-role-inject.migration.spec.ts:7-9` 记录了同类改动的真实生产事故；(ii) 迁移 SQL 从不被执行，文本契约是唯一护栏；(iii) 先写断言会强制 DDL 字面量被「决定」而非事后贴合。其余 todo 用 tests-after 是**结构性安全**的——spec 整体 mock Prisma（`tasks.service.spec.ts:23-60`、`task-progression.scheduler.spec.ts:19-31`），给 `select` 加字段对既有夹具不可观测。
- **既有 spec 能力被低估，实际是资产**：
  - `task-progression.scheduler.spec.ts:177-209` 是**功能性内存 TriggerService**（`schedule` 按 `dedupKey` 写入 `rows` map 并尊重 `maxFires`；`cancel` 翻 `CANCELLED`），故 `rows[key].status` / `.fireCount` / `.payload.quietStreak` **可直接断言**，无需新夹具。
  - `:248-257` 已有用例「幂等：重复注册保留 pending 行（fireCount/quietStreak 不清零）」——**正是清扫修法要恢复的不变量**，只是从未经 `onModuleInit` 路径跑过，所以 bug 活了下来。todo 7 的 B1 就是把该既有用例重新指向启动路径。
  - `tasks.service.spec.ts` 对 Task DTO **零** `toStrictEqual`（已 grep），故加宽 `toTaskDto`（:1998）不破坏任何东西。
- **主门禁 = `bash scripts/gate.sh [--with-playwright]`**（`scripts/gate.sh:1-40`）。server 段 = `npx prisma generate`（:84）→ `npm run lint:check` → `npm test`（:86）→ `npm run test:e2e`（:87）→ `npm run build`；另有 worker 段（`typecheck`/`test`/`build`）与 web 段（`lint:check`/`build`）。`--with-playwright` 才跑 web e2e，且 **Playwright 是 local-only**（`ci.yml:1-13` 有意排除），故 C6 的 CI 级覆盖是 `web: lint:check && build`。
- **裸 catch 回归守卫**：`.github/workflows/ci.yml:37-43` 在 `src/`（排除 `*.spec.ts`）的 `catch {` 数量超过 **baseline 175** 时失败。`cancelStalePatrolTriggers` 的收窄需要 fail-open `try/catch`，**必须断言该计数未上升**。
- 单 spec 迭代命令：`cd server && npx jest --runInBand <spec-path>`（`server/package.json` `test` = `jest --runInBand`；`jest.config.js` rootDir `src`、testRegex `.*\.spec\.ts$`）。
- Evidence: `.omo/evidence/task-long-running/task-<N>-task-long-running.<ext>`（ulw-loop 内为 `<attemptDir>/task-<N>-task-long-running.<ext>`）

## Execution strategy

### Parallel execution waves

11 个实施 todo + 4 个终验 todo，分 4 个执行波次 + 1 个终验波。

> **Wave 1 故意只有 1 个 todo。** 迁移、schema.prisma、Prisma client 重生成是一个不可分割的原子单元——加宽 Prisma `select` 的代码若无该列会在启动时抛 `Unknown argument`。把它拆成多个并行 todo 等于邀请半应用状态。此处不适用「每波 5-8 个」的拆分目标。

| Wave | Todos | 说明 |
|---|---|---|
| 1 | 1 | 原子 DDL 门禁（TDD 内部有序）。后续所有 todo 的 TS 类型都依赖其 `prisma generate` 产物 |
| 2 | 2, 3, 4, 5 | 文件域互不重叠：2 = `tasks.service.ts`+2 DTO+`tasks.service.spec.ts`、3 = `task-progression.scheduler.ts`+其 spec、4 = `platform-mcp.*`、5 = `web/*`。全部只读 Wave 1 产物 |
| 3 | 6, 7, 8 | 收口层。6 需 2 已合入（同一 `tasks.service.ts`）；7 需 **3 与 6 都已合入**（同一 scheduler + 守卫 spec 要断言 6 写的第三处 `select`）；8 需 2/4/5 已合入（依赖其最终形状）。⚠️ 6 与 7 同在 Wave 3 但**不是**并行——7 依赖 6 |
| 4 | 9, 10, 11 | 全量门禁与 runbook。9/10 目录互不重叠可并行；11 为文档 |
| F | F1, F2, F3, F4 | 终验波，全部并行，全部必须 APPROVE |

**同文件串行化铁律**（并行 agent 写同一文件必冲突，必须靠依赖矩阵强制）：
- `server/src/tasks/tasks.service.ts` → todo 2 → todo 6
- `server/src/tasks/task-progression.scheduler.ts` → todo 3 → todo 7

### 跨 todo 交互（实现者必读，勿各自独立推理）

1. **门禁位置是本计划最脆的一环。** `handleProgressionFire` 在 `:522-528` 读任务，但 `:565` 才 `runPatrol()`、`:567-568` 才 `quietStreak++`。门放在 :565 之后**仍然叫醒 agent、仍然推进计数**，且两种失败都**不抛异常**。故 todo 3 的验收必须包含「`dispatchAgentMention` 未被调用」+「`payload.quietStreak` 未推进」两条，而不只是「返回 `{expire:true}`」。
2. **必须配一条非 `longRunning` 的负向对照。** 否则一个「对所有任务都返回 `{expire:true}`」的实现能通过全部断言，同时把全平台看门狗悄悄打死。
3. **清扫修法与 `longRunning` 的交互**（todo 7 依赖此推理）：清扫改为「跳过仍 `in_progress` 的任务」后，`longRunning` 任务（状态恒为 `in_progress`）若有陈旧 pending 行将**不再被启动清扫取消**——这是有意的，该行由 todo 3 的 `{expire:true}` 在首个到期 tick 收敛；且 todo 3 在 `register` 早退，故不会重建。**不得**为此在清扫里再加 `longRunning` 条件，那会让 todo 3 变成单点依赖。
4. **「本改动减少触发器行」是错的。** 清扫修法让启动**不再**取消 in_progress 任务的行，存量行反而会跨发版存活。这正是修好 `:270-272` 幂等分支的目的，不是副作用。
5. **人工 `accept` 重置主会话**：`tasks.service.ts:1812-1829`（`reuseSession` / `resetAfterComplete` 判定）在 `accept` 同事务内批量 reset session。这是「会话无界增长」的既有出口。**todo 6 不得改动该逻辑**——它属于人工完成通道，必须保持原样可用。

### Dependency matrix
> **`Depends on` 是权威列**（据此排波次）；`Blocks` 仅为**保守**反向索引（偏多报，只会造成多余串行，不会漏屏障），**任何调度器都不得据其排波次**。每个 todo 的 `Parallelization: Wave N | Blocked by: … | Blocks: …` 行是本表的**逐条镜像**，`Blocked by` ≡ 本表 `Depends on`、`Blocks` ≡ 本表 `Blocks`；三者若冲突，**一律以本表 `Depends on` 为准**。

| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. DDL + 迁移契约 spec（TDD） | — | 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 | （独占波次） |
| 2. service 字段往返 + DTO | 1 | 6, 8, 9, 10 | 3, 4, 5 |
| 3. 巡检豁免 (a)(b) | 1 | 7, 9, 10 | 2, 4, 5 |
| 4. MCP 工具面 | 1 | 8, 9, 10 | 2, 3, 5 |
| 5. Web 类型 + 勾选 | 1 | 8, 9, 10 | 2, 3, 4 |
| 6. 生命周期门禁 + 硬删豁免 + 执行点 (c) | 2 | 7, 9, 10 | 8 |
| 7. Scheduler truth pass（注释 + 清扫） | 3, 6 | 9, 10 | 8 |
| 8. 文档同步（5 文件） | 2, 4, 5 | 11 | 6, 7 |
| 9. server 全量门禁绿 | 1, 2, 3, 4, 5, 6, 7 | F1-F4 | 10, 11 |
| 10. worker + web 门禁绿 | 1, 5 | F1-F4 | 9, 11 |
| 11. 上线 runbook | 8 | F1-F4 | （Wave 4 内与 9/10 并行；三者目录互不重叠：server / worker+web / docs） |
| F1-F4 | 9, 10, 11 | — | 彼此并行 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

- [ ] 1. `tasks.long_running` 列 + 迁移契约 spec（TDD：先写断言后写 DDL）
  What to do / Must NOT do: **先**创建 `server/src/prisma/task-long-running.migration.spec.ts`，把 `memory-role-inject.migration.spec.ts` 的 `tableDefinition()`（:43-49）与列解析 helper（:52-68）从 `memories` 移植到 `tasks`，写入全部断言，`cd server && npx jest --runInBand src/prisma/task-long-running.migration.spec.ts` 跑到**红**（迁移文件尚不存在）。**然后**：`server/prisma/schema.prisma` 的 `model Task` 内 `resetAfterComplete`（:249）之后加 `longRunning Boolean @default(false) @map("long_running")`；新建 `server/prisma/migrations/20261001000000_task_long_running/migration.sql`，开头写中文 WHY 注释块（说明：为何常驻任务不能有终态、为何零回填、为何无索引），正文**只有一条** `ALTER TABLE \`tasks\` ADD COLUMN \`long_running\` tinyint(1) NOT NULL DEFAULT false;`；`npx prisma generate`。跑到**绿**。
  **Must NOT do:** 迁移内不得出现 `UPDATE` / `DROP` / `CREATE INDEX` / 第二条语句；不得在迁移里内嵌 `UPDATE ... WHERE id=...`；不得省略 `@map`（漏 `@map` 会让 Prisma client 与实际列名静默不一致）；不得重生成 baseline（`docs/migration-baseline.md:30-32` 明禁）；不得加 down-migration。
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
  References (executor has NO interview context - be exhaustive): `server/prisma/schema.prisma:240-279`（`model Task`；:249 = `resetAfterComplete` 模板；:10-27 = 禁 Prisma `enum` 的双库可移植性说明）；`server/src/prisma/memory-role-inject.migration.spec.ts:7-9`（该 spec 存在的原因：PR #36 漏 `ADD COLUMN` 致生产 init job `ERROR 1054`）、`:43-49`（`baselineMemoryColumns`）、`:52-68`（`schemaMemoryColumns`）、`:70-124`（断言集合与 `tableDefinition` helper）；`server/prisma/migrations/20260930010000_memory_role_inject/migration.sql:1-20`（boolean `ADD COLUMN` + 中文 WHY 的模板，:16 是 DDL 本体）；`server/prisma/migrations/20260925000000_squashed_baseline/migration.sql:755-776`（基线 `CREATE TABLE \`tasks\`` 块，:770 = `reset_after_complete` 的既有 tinyint 列型）；`server/prisma/migrations/migration_lock.toml`（`provider = "mysql"`）；`docs/migration-baseline.md:30-32`；`docs/tech-debt-rollback.md:12-15`（无 down-migration）。**已核验的解除项**：全部 11 个 `*.migration.spec.ts` 对 `tasks` / `model Task` / `` CREATE TABLE `tasks` `` 均**零命中**（只解析 `memories`/`agent_roles`/`roles`/`execution_policies`），跨切常量只有 `VTEAM_MCP_TOOL_NAMES`(32) / `BUILTIN_AGENT_ROLES`(7) / `PLATFORM_CAPABILITY_KEYS`(29)，均不被一个 `tasks` 列影响；无任何 spec 枚举迁移目录数（`readdirSync` 仅出现于 3 个扫描 `server/src` 的 spec）。故本改动**不破坏**任何既有迁移契约测试——这正是把护栏放进**新** spec 的理由。
  Acceptance criteria (agent-executable): ① `cd server && npx jest --runInBand src/prisma/task-long-running.migration.spec.ts` 全绿；② `cd server && npx prisma validate && npx prisma generate` 退出码 0；③ `grep -c 'ALTER TABLE' server/prisma/migrations/20261001000000_task_long_running/migration.sql | tr -d ' '` 输出 `1`——**必须探 `ALTER TABLE` 而非 `long_running`**：`grep -c` 计的是**匹配行数**不是出现次数，而本 todo 强制要求写中文 WHY 注释块，该注释块几乎必然提到 `long_running` 这个列名，用它当探针会让正确实现输出 `2` 而误报失败。④ 另断言 `grep -c 'long_running' … | tr -d ' '` ≥ `1`（只验列名出现在文件里，不验其次数）。（`tr -d ' '` 是为 BSD/macOS 的 `wc` 前导空白；`grep -c` 本身无空白，加上无害。）；⑤ 新 spec 断言「基线 `CREATE TABLE \`tasks\`` 块不含 `long_running`」与「`model Task` 内含 `longRunning Boolean @default(false) @map("long_running")` 字面量」双向平价；⑥ `git diff --stat` 显示 `schema.prisma` 恰好 +1 行。
  QA scenarios (name the exact tool + invocation):
    - happy: `cd server && npx jest --runInBand src/prisma/task-long-running.migration.spec.ts` → 全绿。Evidence: `.omo/evidence/task-long-running/task-1-task-long-running.txt`
    - failure（**必须实跑并记录红**）: 先只创建 spec 不建 migration，跑同一命令 → 必须以「迁移文件缺失/列缺失」失败。**把这次失败输出存档**——它证明护栏真的会红，而不是恒真断言。Evidence: `.omo/evidence/task-long-running/task-1-task-long-running-tdd-red.txt`
    - failure: 临时把 `@map("long_running")` 改成 `@map("long_runing")`（拼错）跑 spec → **必须失败**（证明反向平价断言有效），随后改回。Evidence: `.omo/evidence/task-long-running/task-1-task-long-running-map-typo.txt`
  Commit: Y | `feat(db): tasks 新增 long_running 列 + 迁移契约测试`
  Recommended task executor category: deep-low - 单条 DDL 看似机械，但「双向平价断言」与「DDL 字面量必须被决定而非事后贴合」是本计划唯一有真实推理负担的部分，且其失败模式在 deploy 前不可见。

- [ ] 2. `longRunning` 经 service + DTO 全管道往返
  What to do / Must NOT do: `tasks.service.ts` 四处——`:81` `TaskRow` 加字段；`:414` `createTaskInternal` 写 `resetAfterComplete:` 旁新增 `longRunning: (dto as any).longRunning ?? false`；`:723-725` `update` 加 `if ((dto as any).longRunning !== undefined) data.longRunning = ...`；`:1998` `toTaskDto` 加 `longRunning: Boolean(task.longRunning)`。`dto/create-task.dto.ts:46-52` 与 `dto/update-task.dto.ts:43-49` 各照 `resetAfterComplete` 加 `@ApiPropertyOptional({ description: ... })` + `@IsOptional() @IsBoolean()`。补 `tasks.service.spec.ts` 用例。
  **Must NOT do:** 不得改 `tasks.controller.ts`（:152/242 已绑定）；不得改 `toTaskDto` 的既有字段；不得让 `createByAgent`（:254）走独立写入路径（必须复用 `createTaskInternal`，一处改动覆盖 HTTP + agent）。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 6, 8, 9, 10
  References: `server/src/tasks/tasks.service.ts:81`、`:254`（`createByAgent`）、`:301`（`createTaskInternal`，两个建任务路径的唯一共享写体）、`:414`、`:699`（`update`）、`:723-725`、`:1922`（`toTaskDto`）、`:1998`；`server/src/tasks/dto/create-task.dto.ts:15-53`（全文，字段模板在 :46-52）；`server/src/tasks/dto/update-task.dto.ts:15-50`（:43-49）；`server/src/tasks/tasks.controller.ts:152-160`（POST /tasks）、`:242-248`（PATCH /tasks/:id）、`:166-172`（GET /tasks/:id）；`server/src/swagger-mcp/swagger-tools.ts:140-184`（`buildInputSchema` 合并 requestBody ⇒ DTO 装饰器**自动**发布到 `vteam-api` agent 工具面，零额外接线）、`server/src/swagger-mcp/swagger-mcp.handlers.ts:167-171`（`PATCH /tasks/{id}` → `tasksService.update`，经 `asDto<UpdateTaskDto>(args)` **无类型检查的 cast**）。**已核验**：`tasks.service.spec.ts` 对 Task DTO 零 `toStrictEqual`（grep），且 :23-60 显式 mock 全部约 12 个 Prisma model、加 `select` 字段对夹具不可观测 ⇒ 加宽 `toTaskDto` 不破坏任何东西。
  Acceptance criteria: ① `cd server && npx jest --runInBand src/tasks/tasks.service.spec.ts` 全绿；② 新增用例断言 `toTaskDto({ ..., longRunning: true })` 输出 `longRunning: true`，未设置时输出 `false`（照 :1395-1414 既有 `resetAfterComplete` 用例形态）；③ 新增用例断言 `create` 与 `createByAgent` 两条路径都把 `longRunning` 落库；④ `cd server && npx jest --runInBand src/tasks/tasks.controller.spec.ts` 全绿。
  QA scenarios:
    - happy: `POST /tasks` 带 `longRunning: true` → `GET /tasks/:id` 返回 `longRunning: true`（supertest，内存态）。Evidence: `.omo/evidence/task-long-running/task-2-task-long-running.txt`
    - failure: 新增用例断言 `update` 传 `longRunning: undefined` 时 `data` 不含该键（不得误置 false 覆盖已有 true）。Evidence: `.omo/evidence/task-long-running/task-2-task-long-running-partial.txt`
  Commit: Y | `feat(tasks): longRunning 字段经 service + DTO 往返`
  Recommended task executor category: quick - 四处 service 站点 + 两个 DTO 全是 `resetAfterComplete` 的逐字模板复制，模式唯一、无设计判断。

- [ ] 3. 巡检豁免：执行点 (a)(b)（第 3 点 (c) 在 todo 6）
  What to do / Must NOT do: (a) `register()`（`task-progression.scheduler.ts:234-241`）在既有 `status !== in_progress` 早退之后加 `longRunning` 早退，并把 `longRunning` 加入 :236 的 `select`。(b) `handleProgressionFire()`（:522-528）在既有 `!task || status !== in_progress` 判定之后、`mainMemberOfTask` 与 `runPatrol()` 之前加 `longRunning` 判定并 **`return {expire:true}`**——**位置必须在 :565 `runPatrol()` 与 :567-568 `quietStreak++` 之前**。(c) **已迁至 todo 6**（`systemBlock` 门禁要改 `tasks.service.ts`，而本 todo 与 todo 2 同处 Wave 2 并行；留在本处会造成同文件并发写）。本 todo 因此只改 `task-progression.scheduler.ts` 一个文件。
  **Must NOT do:** 不得动 `persistPatrolTrigger()`（:260）或 `restoreInProgressTasks()`（:1022）——二者被 (a) 传递覆盖，加了是冗余；不得在 `tasks.service.ts:1758` 的通用 CAS 上加门禁（七个迁移共用，见 Must NOT have）；不得改任何阈值常量；不得改 `update()` 去主动 `progression.unregister`（刻意交给 `{expire:true}` 自毁，见 L3）。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 7, 9, 10（Wave 2 内只改 `task-progression.scheduler.ts`，与 todo 2 的 `tasks.service.ts` 无重叠）
  References: `server/src/tasks/task-progression.scheduler.ts:233-251`（`register`，:236 的 `select`、:238 状态早退、:250 调 `persistPatrolTrigger`）、`:515-595`（`handleProgressionFire`；:522-528 读任务、:529-534 主成员、:541-560 否决链、**:565 `runPatrol()`**、**:567-569 `quietStreak++` + `writeQuietStreak`**、:570 上限比较、:577 `hasInflightWork`、:588 `fireStallDetected`、:592 `unregister`）、`:1020-1033`（`restoreInProgressTasks`，:1026 唯一语句 `register(row.id)`）、`:258-297`（`persistPatrolTrigger`，:250 唯一调用者）、`server/src/tasks/tasks.service.ts:1292-1300`（`systemBlock`，:1298 调 `transition`）、`server/src/timers/trigger.service.ts:583-593`（`{expire:true}` → 基座落 `cancelled`）。Spec 资产：`server/src/tasks/task-progression.scheduler.spec.ts:19-31`（mock Prisma）、`:49-55`（`inProgressTask()` 无 `longRunning` ⇒ `undefined` falsy ⇒ 存量断言不破）、`:177-209`（**功能性内存 TriggerService**，`rows` map 按 `dedupKey` 索引，`schedule` 尊重 `maxFires`，`cancel` 翻 `CANCELLED`）、`:248-257`（既有「幂等：保留 fireCount/quietStreak」用例）、`:340-351`（`seedPatrolRow` + `fireCount: 5, maxFires: 6`）、存量 `triggers.schedule` 断言在 `:256/268/278/502/529/544`。
  Acceptance criteria: ① `cd server && npx jest --runInBand src/tasks/task-progression.scheduler.spec.ts` 全绿，**且 :256/268/278/502/529/544 六处存量断言仍绿**；② 新增用例：`longRunning: true` + `register()` → `triggers.schedule` **未**被调用、`isRegistered()` 为 false；③ 新增用例：**已存在 `payload.quietStreak = 2` 的 pending 行** + `longRunning: true` + 触发 `handleProgressionFire` → 返回 `{expire:true}`、`workerDispatcher.dispatchAgentMention` **未被调用**、`rows[key].payload.quietStreak` **仍为 2**（未推进到 3）、**且无任何 stall handler 被触发**（`onStallDetected`(:303) 注册的 `stallHandlers`(:137) 数组保持为空——⚠️ scheduler **不持有** TasksService 依赖，其 spec 里不存在 `systemBlock`/`tasksService`/`fireStallDetected` 任何符号，**不要断言那些**）；④ **负向对照**用例：同 seed 但 `longRunning` 缺席 → `dispatchAgentMention` **被**调用、`quietStreak` 推进到 3、返回值**非** `{expire:true}`。
  （原 ⑤ `systemBlock` 用例已随 clause (c) 迁至 todo 6 的验收 ⑨⑩。）
  QA scenarios:
    - happy: ③ 全绿。**这是本特性的核心断言**——证明「flag 翻转当刻已有 `quietStreak=2` 遗留行」不会在下一轮被置阻塞。Evidence: `.omo/evidence/task-long-running/task-3-task-long-running.txt`
    - failure（**必做**）: 临时把 (b) 的门禁从 :528 移到 :565 `runPatrol()` **之后** → 用例 ③ 必须失败（`dispatchAgentMention` 被调用、`quietStreak` 变 3）。**这证明门禁位置是被机械验证的，不是靠注释约定。** 随后移回。Evidence: `.omo/evidence/task-long-running/task-3-task-long-running-gate-position.txt`
    - failure（**必做**）: 临时把 (b) 改成「对所有任务都返回 `{expire:true}`」→ 用例 ④ 负向对照必须失败。**这防止一个能通过全部正向断言、却把全平台看门狗打死的实现。** 随后改回。Evidence: `.omo/evidence/task-long-running/task-3-task-long-running-negative-control.txt`
  Commit: Y | `fix(tasks): long_running 任务豁免进度巡检（3 个强制执行点）`
  Recommended task executor category: deep-low - 门禁位置是本计划最脆的一环：门放晚一行照样叫醒 agent、门放成无条件就全平台失效，位置正确性必须靠断言而非注释保证。

- [ ] 4. MCP 工具面：`task_create` 可置位 + `task_context` 可读
  What to do / Must NOT do: `platform-mcp.tools.ts:707-719` `taskCreateSchema` 加 `longRunning: z.boolean().optional()`（照 `memorySaveSchema.autoInject` :395-400）；`platform-mcp.service.ts:3226-3276` `taskCreate` 把该参数并入传给 `createByAgent` 的 DTO（照 :3487 的 `args.x === true` 归一写法）；`platform-mcp.service.ts:1230-1237` `taskContext` 的 `select` 加 `longRunning`。**不得**同步 `platform-mcp.tool-naming.spec.ts`：它的 `observed` 只投影 `['selfInstanceId','teamId','taskId']`（:186-192），加第 4 个 schema 参数对它不可见 ⇒ 保持绿。⚠️ 把 `longRunning` 加进 `expected.task_create` 会引入 `observed` 永不可能有的 key，`toEqual`（:202）反而把当前绿的 spec 弄红。
  **Must NOT do:** **不得新增工具名**（工具总数必须保持 32，被 `platform-mcp.controller.spec.ts:278（断言在 :294）` 与 `agent-role-capabilities.migration.spec.ts:210-211` 两处钉死）；不得改 `agent.constants.ts` / `platform-capability.constants.ts` / `prisma/seed.ts` 的工具注册表（无新工具名即无需改）；不得改 `platform-mcp.controller.spec.ts` 的 32 断言。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 8, 9, 10
  References: `server/src/platform-mcp/platform-mcp.tools.ts:707-719`（`taskCreateSchema`）、`:124-126`（`taskContextSchema`）、`:395-400` 与 `:430-433`（`autoInject` 的 `z.boolean().optional()` 先例）、`:435-445`（`.refine` 先例）、`:1179-1185`（`task_create` 注册）、`:1074`（`task_transition` 注册）、`:1226+`（`zodObjectToJsonSchema`）；`server/src/platform-mcp/platform-mcp.service.ts:1226-1290`（`taskContext`，:1230-1237 显式 `select`）、`:3226-3276`（`taskCreate`，:3270-3275 只透传 `{title, description, priority, teamId}`）、`:3487`（boolean 归一写法）、`:3675`、`:3805`（`!== undefined` 更新写法）；`server/src/platform-mcp/platform-mcp.tool-naming.spec.ts:153-157` 与 `:186-192`、`:202`（**只投影 3 个 key，加参数不可见 ⇒ 本 todo 不得改它**）；`server/src/platform-mcp/platform-mcp.controller.spec.ts:278（断言在 :294）`（工具数 32）；`server/src/prisma/agent-role-capabilities.migration.spec.ts:210-211`（工具数 32 的第二处）。**注意**：`resetAfterComplete` 当年**没有**进 `task_create`（`taskCreateSchema` 无任何 boolean），故本项是净新增而非模板复制。
  Acceptance criteria: ① `cd server && npx jest --runInBand src/platform-mcp/platform-mcp.tool-naming.spec.ts` **照常运行**并全绿，同时**该 spec 文件本身未被本 todo 修改**（`git diff` 中不出现它）——⚠️ 「不得同步」约束的是**不得编辑它**，不是不得运行它——它对本改动不敏感，加参数不影响其 `observed`；② `cd server && npx jest --runInBand src/platform-mcp/platform-mcp.controller.spec.ts` 全绿且工具数仍为 32；③ `cd server && npx jest --runInBand src/prisma/agent-role-capabilities.migration.spec.ts` 全绿（32 未变）；④ 新增用例：`task_create` 传 `longRunning: true` ⇒ 落库为 true；传 `false` ⇒ 落库 false；省略 ⇒ 落库 false。
  QA scenarios:
    - happy: ④ 全绿。Evidence: `.omo/evidence/task-long-running/task-4-task-long-running.txt`
    - failure: `task_create` 传 `longRunning: "yes"`（字符串）**不得 500**——`swagger-mcp` 侧走 `asDto`（`swagger-mcp.handlers.ts:167-171`）无类型检查，HTTP 侧的 `@IsBoolean()` 保护不到 agent 入口。断言服务返回受控错误或安全默认，不抛未捕获异常。Evidence: `.omo/evidence/task-long-running/task-4-task-long-running-bad-type.txt`
  Commit: Y | `feat(mcp): task_create/task_context 支持 longRunning`
  Recommended task executor category: quick - schema + 透传两处改动，`autoInject` 是逐字可抄的同文件先例；唯一需注意的是**不得**同步 `tool-naming.spec.ts`（其 `observed` 只投影 3 个 key，加参数不可见，误加 `expected` 反而把绿 spec 弄红）。

- [ ] 5. Web：类型 + 新建任务勾选
  What to do / Must NOT do: `web/src/components/tasks/task-detail-types.ts:29-48` 的 `TaskDetail` 加 `longRunning?: boolean | null`；`web/app/(main)/tasks/new/page.tsx` 照 `resetAfterComplete` 勾选加全套——props（:133/:138）、checkbox（:209-216，含 `data-testid`）、state（:251）、提交 payload（:279-286）、wiring（:341-342）；`web/e2e/reference/testids.ts:108` 附近注册新 testid。
  **Must NOT do:** 不得加徽章或列表过滤（见 L 类与 Must NOT have）；不改 `web/src/types/task-status.ts`（状态单一源，有 `web/scripts/check-task-status-single-source.mjs` 在 prebuild 守护）；不改 `TaskDetailDrawer.tsx:36-45` / `board/page.tsx:111-127` / `teams/[id]/tasks/page.tsx:24-33` 这三处**窄化的本地重复接口**（它们本就不含任何 flag，无需同步）。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 8, 9, 10
  References: `web/src/components/tasks/task-detail-types.ts:29-48`（规范 `TaskDetail`；:41 = `resetAfterComplete?`）、`web/app/(main)/tasks/new/page.tsx:8-9`（文件头注释列出了该表单的字段契约）、`:65-230`（`TaskForm`）、`:133`、`:138`、`:209-216`（checkbox + `data-testid="reset-after-complete-toggle"` 在 :211）、`:251`、`:279-286`、`:341-342`、`web/e2e/reference/testids.ts:89-117`（:108 = 现有 toggle 注册；`PAGE_SMOKE` 在 :544-548）、`web/src/components/tasks/TaskInfoEditModal.tsx:47-135`（PATCH 弹窗，**刻意不含任何 boolean/priority** —— 故本字段在 UI 上是 create-only，与 `resetAfterComplete` 现状一致）、`web/package.json:13-14`（`check-task-status-single-source.mjs` 挂在 prebuild）。
  Acceptance criteria: ① `cd web && npm run lint:check` 退出码 0；② `cd web && npm run build` 退出码 0（CI 实际只跑这两项，`.github/workflows/ci.yml:1-13` 有意排除 Playwright）；③ `grep -n "long-running" web/e2e/reference/testids.ts` 有输出；④ 提交 payload 含 `longRunning`：勾选时为 `true`、未勾时该 key **被省略**（照 :285 既有的 `...(resetAfterComplete ? { resetAfterComplete: true } : {})` 条件展开形态，**不得**改成显式 `false`——语义由 `createTaskInternal`(:414) 的 `?? false` 兜底）。
  QA scenarios:
    - happy: `cd web && npm run lint:check && npm run build` 退出码 0。Evidence: `.omo/evidence/task-long-running/task-5-task-long-running.txt`
    - failure: 临时在 `task-detail-types.ts` 里把字段名打错成 `longRuning`，`npm run build` **必须失败**（证明类型真的被消费，而非装饰性声明）。随后改回。Evidence: `.omo/evidence/task-long-running/task-5-task-long-running-typo.txt`
  Commit: Y | `feat(web): 新建任务支持勾选长期值班任务`
  Recommended task executor category: visual-engineering - 需要按现有表单的既有交互/可访问性/testid 约定接入一个真实控件，非纯类型改动。

- [ ] 6. 生命周期门禁（禁 agent 提交验收）+ 硬删豁免
  What to do / Must NOT do: (a0) **执行点 (c) — `systemBlock` 门禁**（由 todo 3 迁入，因同文件归本 todo）：`tasks.service.ts:1296` `systemBlock()` 目前是**先 `transition`(:1298)、后 `findUnique`(:1303, `select: { teamId: true, title: true }`)**，故需在 `transition` **之前新增一次 `findUnique`**（`select: { longRunning: true }`）做前置判定，命中则跳过 `transition` 并记 warn 日志；**不得**把 `:1303` 那次查询前移来复用（它取的是 `teamId`/`title`，且在 `transition` 之后）。(a) `tasks.service.ts:1581` 的 `if (action === 'accept' || action === 'archive')` 扩展为 `if (action === 'mark-pending-review' || action === 'accept' || action === 'archive')` **且** `task.longRunning` 为真——注意现有 `findUnique`（:1571-1574）的 `select` 只取 `{id, teamId}`，需加 `longRunning`；`mark-pending-review` 的拒绝文案需与 :1584-1587 同风格（点明「请向用户报告值班任务持续进行中，不要重复调用」）。(b) `remove()` :1369 的条件收窄为 `if ((task.status === 'in_progress' || task.status === 'pending_review') && !task.longRunning)`，`:1359-1362` 的 `select` 需加 `longRunning`。
  **Must NOT do:** **必须返 403，不得静默跳过**（静默跳过会让 agent 无限重试）；**必须写成条件收窄，不得写成 `if (task.longRunning) return ...` 早退**（早退会连带跳过 :1363-1368 的 404 分支，等于给所有人删掉了删除保护）；**不得门禁人工路径**——七个动作对 `longRunning` 任务全部照旧可用；不得改 `block()`（:1265-1280）与 `systemBlock()` 之外的任何 `blocked` 写入点；不得改 :1812-1829 的 session reset 逻辑。
  Parallelization: Wave 3 | Blocked by: 2（3 已把 clause (c) 迁出，故本 todo 是 `tasks.service.ts` 的唯一 Wave-3 写者） | Blocks: 7, 9, 10
  References: `server/src/tasks/tasks.service.ts:1565-1591`（`transitionByAgent`；:1571-1574 `findUnique` select、:1581 现有 accept/archive 门、:1582-1587 403 抛出处与文案、:1589-1591 委托 `transition` 并传 `actor: ACTOR_TYPE.agent`）、`:1359-1376`（`remove`；:1359-1362 `findUnique` select、:1363-1368 404 分支、:1369-1376 `TASK_DELETE_BLOCKED`）、`:1378-1453`（级联本体；:1449-1452 置空 `teams.currentTaskId`，**从不调 `promoteNextInTx`** ⇒ 见 L1）、`:1265-1280`（人工 `block`，**不得门禁**）、`:1292-1300`（`systemBlock`）、`:1147-1158`（`block`/`resume` 的 `sysMessage` 文案）、`:1758`（七迁移共用的 CAS ⇒ **不是**门禁点）、`server/src/common/constants/task.constants.ts:44-55`（`TASK_TRANSITIONS`）、`:74-76`（`TASK_BLOCK_REASON_REQUIRED` / `TASK_AGENT_COMPLETION_FORBIDDEN`）、`:649-652`（公开 `promoteNext(teamId)`，L1 的手工修复入口）、`server/src/tasks/tasks.service.spec.ts:23-60`（mock 结构）。
  Acceptance criteria: ① `cd server && npx jest --runInBand src/tasks/tasks.service.spec.ts` 全绿；② 新增：`transitionByAgent(longRunning任务, inst, 'mark-pending-review')` **reject** `response.code === 'TASK_AGENT_COMPLETION_FORBIDDEN'`，且 `prisma.task.updateMany` **未被调用**（无部分写入）；③ **负向对照**：非 `longRunning` 任务的 `transitionByAgent(..., 'mark-pending-review')` 仍 resolve（防止无条件拒绝）；④ `longRunning` 任务上 agent 的 `accept`/`archive` 仍 403（既有门不得回归）；⑤ `longRunning` 任务上 agent 的 `block`/`resume` 仍可用（升级通道，D4）；⑥ **人工链完整**：`longRunning` 任务走人工 `mark-pending-review → accept → archive`，状态依次 `pending_review → completed → archived`；⑦ **删除回归**：`remove()` 对**非** `longRunning` 的 `in_progress` 任务**仍** reject `TASK_DELETE_BLOCKED`；⑧ `remove()` 对 `longRunning` 的 `in_progress` 任务 resolve `{deleted:true, id}`；⑨ **执行点 (c)**：`longRunning: true` 时 `systemBlock()` **不调** `transition`、任务状态保持 `in_progress`、记 warn 日志；⑩ **负向对照**：非 `longRunning` 时 `systemBlock()` 仍正常调 `transition` 置阻塞（防止写成无条件跳过）。
  QA scenarios:
    - happy: ② ⑥ ⑧ 全绿。Evidence: `.omo/evidence/task-long-running/task-6-task-long-running.txt`
    - failure（**必做**）: 临时把 (b) 改写成 `if (task.longRunning) { /* 跳过拦截 */ } else if (status === 'in_progress' || ...) { throw }` 的**早退**形态 → 用例 ⑦ 必须失败（404 分支被吞或 `TASK_DELETE_BLOCKED` 对所有人失效）。随后改回。**这是 D5 唯一的回归护栏。** Evidence: `.omo/evidence/task-long-running/task-6-task-long-running-delete-earlyreturn.txt`
  Commit: Y | `fix(tasks): 长期值班任务禁 Agent 提交验收 + 允许硬删`
  Recommended task executor category: deep-low - 门禁的失败方向全是静默的（漏 403 则 agent 无限重试、删除写成早退则给所有任务删掉保护），而 403 与条件收窄这两种「正确写法」在类型上等价。

- [ ] 7. Scheduler truth pass：注释订正（4 处事实错误〔含 1 处间隔数错〕+ 2 处措辞误导 + 2 处 quietStreak 失实描述）+ 启动清扫顺序修复
  What to do / Must NOT do: (a) 注释订正，分三类（**不要**把 6 处一律当成事实错误——`:59` 与 `:107-109` 内容为真）：**事实错误 4 处** = `:182-183`、`:207-208`、`:976-978`（「periodic patrol 已退役 / fan-out JOIN drain 接管」，而 `triggers.schedule()` 在 :281-291 真实在跑）+ `:126`（「缺省 20min」vs `:40` 的 `10 * 60_000`）；**措辞误导 2 处** = `:59`、`:107-109`（setInterval 扫描确已退役、ticker 确为唯一节拍，**改写须保留这一事实**，只去掉会被读成「巡检整体退役」的歧义）；另订正 `:98` 类注释与 `register` 文档 `:229-230` 中「重启安全核心 / quietStreak 不清零」的失实描述。(b) 修 `cancelStalePatrolTriggers()`（:980-1001）：先 `findMany` 出 pending 巡检行，**从每行 `payload.taskId` 取任务 id**（`ProgressionPatrolPayload` :76-79，写入点 :622；**不得解析 `dedupKey` 字符串**），批量/逐个查这些任务，**跳过仍为 `in_progress` 的**，其余照旧置 `cancelled`。(c) 新增源码守卫 spec（复用 `plan-removal.guard.spec.ts` 的源码扫描先例形态），**除注释断言外还必须断言三处 `select` 均含 `longRunning: true`**：`register` 的 :236 `select { id: true, status: true, teamId: true }`、`handleProgressionFire` 的 :524 `select { title: true, status: true, teamId: true }`、以及 todo 6 新增的 `systemBlock` 前置查询。**这是必需的**：两处 spec 的 Prisma 全是裸 `jest.Mock()`，无论 `select` 写什么都返回同一固定对象 ⇒ 漏加字段时全部新单测照样绿，而线上门禁已死，源码扫描是唯一能机械证明它的手段。
  **Must NOT do:** **不得删除清扫本身**——它负责清理进程宕机期间转终态的任务遗留行；不得在清扫里加 `longRunning` 条件（会让 todo 3 变成单点依赖）；不得改 `trigger.service.ts` 的任何基座语义；不得改死代码 `scan()`/`patrolNow()`（属独立清理）。新加的 fail-open `try/catch` 不得让 `src/` 的裸 `catch {` 计数超过 baseline 175。
  Parallelization: Wave 3 | Blocked by: 3, **6**（源码守卫 spec 要断言 todo 6 写入的第三处 `select`，故必须等 6 合入；⚠️ 不得为绿删该断言） | Blocks: 9, 10
  References: `server/src/tasks/task-progression.scheduler.ts:40`（`DEFAULT_PROGRESSION_INTERVAL_MS = 10 * 60_000`，与 :126 的「20min」矛盾）、`:44`（`STALL_QUIET_STREAK_LIMIT = 3`）、`:59`、`:76-79`（`ProgressionPatrolPayload { taskId, quietStreak? }`）、`:91-113`（类注释，含 :98「重启安全核心」）、`:126`、`:179-197`（`onModuleInit`；:184 清扫先于 :187 重建）、`:229-230`（`register` 文档「fireCount/quietStreak 不清零」）、`:258-297`（`persistPatrolTrigger`；:266-272 幂等早退、:274 删终态行、:281 重建）、`:609-629`（`writeQuietStreak`，:622 写 `payload: {...base, taskId, quietStreak}`）、`:976-1001`（`cancelStalePatrolTriggers`；:982-988 `findMany` 只 `select: { dedupKey: true }` ⇒ **需加 `payload`**、:990-1001 逐行置 cancelled）。Spec 资产：`server/src/tasks/task-progression.scheduler.spec.ts:177-209`（内存 TriggerService，`rows` map 可直接断言）、`:248-257`（既有「幂等：保留 fireCount/quietStreak」用例——本 todo 的 B1 就是把它重新指向启动路径）、`:340-351`（`seedPatrolRow`）、`.github/workflows/ci.yml:37-43`（裸 catch baseline 175）、守卫 spec 模板 `server/src/platform-mcp/plan-removal.guard.spec.ts`（递归扫 `server/src`、排除 `*.spec.ts`、断言禁用模式不复活；其设计注释指出「删除断言本身即触发 review」）。
  Acceptance criteria: ① `cd server && npx jest --runInBand src/tasks/task-progression.scheduler.spec.ts` 全绿。② **B1**：`onModuleInit` 对一个 `status: PENDING`、`fireCount: 3`、`payload.quietStreak: 2` 的 in_progress 任务行 ⇒ `rows[key].status` 仍为 `PENDING`、`fireCount` 仍 3、`payload.quietStreak` 仍 2、且 `triggers.schedule` **调用次数为 0**（未删重建）。③ **B2（安全断言）**：一个 pending 行、其任务**不在** `prisma.task.findMany` 结果中（模拟已转终态）⇒ `rows[key].status` 变为 `CANCELLED`。**B2 是防止「把清扫删掉」这个错误修法的唯一护栏。** ④ **B3**：`longRunning: true` 的 in_progress 任务 ⇒ `onModuleInit` 不调 `triggers.schedule`。⑤ 源码守卫断言：(i) `fan-out JOIN drain 接管` 与 `periodic patrol 退役` 两串在该文件**零命中**（这两串才是真正错误的表述）；(ii) `DEFAULT_PROGRESSION_INTERVAL_MS === 10 * 60_000` 且文件中每一处「缺省 Xmin」都与它一致；**(iii) 不对 `已退役` 子串做零命中断言**——`:59`/`:107-109` 里该字样对应的事实为真，强行消除会逼出新的错误注释。**断言常量与错误表述，而非断言具体措辞。**⑥ 裸 catch 预算：**逐字使用权威命令**——`{ grep -rn --include='*.ts' -E 'catch[[:space:]]*\{' server/src || true; } | grep -v '\.spec\.ts' | wc -l`（与 `.github/workflows/ci.yml:43-46` 和 `scripts/gate.sh:73-78` 的 `BARE_CATCH_BASELINE=175` 一致）。⚠️ **不得**用 `grep -rc`（出的是每文件计数而非总数，会低估 `catch{` 无空格写法）。当前实测 166，余量 9。
  QA scenarios:
    - happy: ② ③ ④ 全绿。Evidence: `.omo/evidence/task-long-running/task-7-task-long-running.txt`
    - failure（**必做**）: 临时把 `cancelStalePatrolTriggers` 的整个循环体删掉（保留 `findMany`）→ 用例 ② 通过但 **B2 必须失败**。**这证明 B2 真的在守护终态行清理。** 随后恢复。Evidence: `.omo/evidence/task-long-running/task-7-task-long-running-sweep-deleted.txt`
    - failure: 临时把清扫的跳过条件写成「跳过所有行」→ B2 必须失败。Evidence: `.omo/evidence/task-long-running/task-7-task-long-running-sweep-skipall.txt`
  Commit: Y | `fix(tasks): 订正巡检陈旧注释 + 修启动清扫重置 quietStreak 的顺序 bug`
  Recommended task executor category: deep-low - 清扫的收窄条件（从 payload 取 taskId、只跳过 in_progress）与 B1/B2/B3 三条断言的正确性互相依赖，错一个方向就是静默的行为回归。

- [ ] 8. 文档同步（5 个文件 + testid 目录）
  What to do / Must NOT do: 在 5 个 `docs/agent-platform/` 文件补 `longRunning` 行（⚠️ 只有 3 个含 `resetAfterComplete`：`14-…`/`15-…`/`28-…`；`09`/`13` 从未收录，属既有漂移，本次只补 `longRunning`）：`15-数据模型细化（ER图）.md:156-177`（字段表）与 `:475-490`（ER mermaid，:483 旁）、`09-API设计.md:114-128`、`13-任务状态机与全生命周期.md:36-50`、`14-Agent配置与虚拟团队模型.md:204/281/296`、`28-团队模型与排队设计.md:59/125/127`。补 `docs/test-cases/02-项目与任务管理.md:130`（TC-TASK-016）字段列表。
  **Must NOT do:** **不得**顺手修既有的文档漂移——`13-…:41` 写「五态」而 `15-…:166` 说六态（`queued`）、`13-…:42` 写 `mainAgentId` 而实际 DTO 字段是 `mainAgentMemberId`、`resetAfterComplete` 从未进 `09`/`13`。**这些另开 issue，不吸收进本 PR**（吸收会把一列改动变成没人要求的文档重写，且使 diff 不可复审）。**不得**提交 `openapi.json`。**不得**把 `docs/test-cases/02-…:130` 当成会被打破的断言——它是手写 QA 目录行，无人执行，且其字段列表**已经**是错的（`mainAgentId` vs `mainAgentMemberId`）；只补 `longRunning` 一行即可。
  Parallelization: Wave 3 | Blocked by: 2, 4, 5 | Blocks: 11
  References: `docs/agent-platform/15-数据模型细化（ER图）.md:46`（BOOLEAN 类型映射示例行）、`:156-177`（任务域字段表；:166 `priority`、:168 `reset_after_complete`、:170 `background_docs`）、`:475-490`（ER mermaid；:483 `boolean reset_after_complete`）；`docs/agent-platform/09-API设计.md:114-128`（§3.4 端点表；:119 POST /tasks、:121 PATCH /tasks/:id —— **两处本已陈旧**：:119 无 `resetAfterComplete`、:121 仍有已不存在的 `mainAgentId`）；`docs/agent-platform/13-任务状态机与全生命周期.md:36-50`（§2.1 字段表；:42「五态」、:43 `mainAgentId` —— 本 todo 只补 `longRunning` 行，**不动** :42/:43）；`docs/agent-platform/14-Agent配置与虚拟团队模型.md:204/281/296`；`docs/agent-platform/28-团队模型与排队设计.md:11`（自称团队域唯一事实源）、`:59`（POST /tasks 签名）、`:125/127`（flag 规则表）；`docs/test-cases/02-项目与任务管理.md:130`（TC-TASK-016）。
  Acceptance criteria: ① `grep -rln "longRunning\|long_running" docs/agent-platform/ | wc -l | tr -d ' '` ≥ `5`；② `grep -n "longRunning" docs/agent-platform/13-任务状态机与全生命周期.md` 有输出且**该文件 :42/:43 未被改动**（`git diff` 中不出现这两行）；③ `git diff --stat docs/` 只含上述 6 个文件；④ 仓库内不存在 `openapi.json`（`test ! -f server/openapi.json`）。
  QA scenarios:
    - happy: ① ② ③ 全绿。Evidence: `.omo/evidence/task-long-running/task-8-task-long-running.txt`
    - failure: 临时在 `13-…` 的 `longRunning` 行里写入错误列名 `long_runing` → `grep -n "longRunning" docs/agent-platform/13-任务状态机与全生命周期.md` 必须无输出（证明该文件确实被覆盖到）。随后改回。Evidence: `.omo/evidence/task-long-running/task-8-task-long-running-doc-coverage.txt`
  Commit: Y | `docs(agent-platform): 补 longRunning 字段到 5 处数据模型/API 文档`
  Recommended task executor category: writing - 纯文档同步，无代码推理；难点仅在「补行而不顺手修既有漂移」的克制。

- [ ] 9. server 全量门禁绿
  What to do / Must NOT do: 跑 `cd server && npx prisma validate && npx prisma generate && npm run lint:check && npm test && npm run test:e2e && npm run build`，逐个修掉因本改动而失败的项（含 todo 1-7 遗留的红）。**不得**为了让套件变绿而删断言、`.skip`、或放宽期望值——若某条既有断言确实与新行为冲突，**改期望值**并在提交信息里说明理由，**不得**删该用例。（注意：`tool-naming.spec.ts` 不属此列，见 todo 4。）**不得**改 `platform-mcp.controller.spec.ts:278（断言在 :294）` 与 `agent-role-capabilities.migration.spec.ts:210-211` 的 32（工具数未变）。**不得**新增 `catch {` 使裸 catch 超过 175。
  Parallelization: Wave 4 | Blocked by: 1, 2, 3, 4, 5, 6, 7 | Blocks: F1-F4
  References: `scripts/gate.sh:1-40`（server 段顺序：:84 `npx prisma generate` → `lint:check` → :86 `npm test` → :87 `npm run test:e2e` → `build`）、`server/package.json`（`test` = `jest --runInBand`、`lint:check`、`build` = `nest build`）、`server/jest.config.js`（rootDir `src`、testRegex `.*\.spec\.ts$`、setupFiles `../test/setup-env.js`）、`server/test/setup-env.js`、`server/test/e2e/team-queue.e2e-spec.ts:1-7`（:4 自述不依赖外部 DB）、`.github/workflows/ci.yml:35`（`lint:check && npm test && npm run test:e2e && npm build`）、`.github/workflows/ci.yml:37-43`（裸 catch baseline 175）、`server/src/platform-mcp/platform-mcp.controller.spec.ts:278（断言在 :294）`、`server/src/prisma/agent-role-capabilities.migration.spec.ts:210-211`、`server/src/platform-mcp/platform-mcp.tool-naming.spec.ts:153-157`。
  Acceptance criteria: ① 上述整条命令链退出码全为 0；② 裸 catch 计数（**用 CI 的权威命令** `{ grep -rn --include='*.ts' -E 'catch[[:space:]]*\{' src || true; } | grep -v '\.spec\.ts' | wc -l`，**不得**用 `grep -rc`）≤ 175；③ 工具数断言仍为 32（两处）；④ 报告须显式声明「迁移 SQL 从未在真实 DB 上执行过，全流程仅 `prisma validate` / `prisma generate` / `tsc` 触碰该列」——**不得声称迁移已验证**。
  QA scenarios:
    - happy: 整条命令链退出码 0。Evidence: `.omo/evidence/task-long-running/task-9-task-long-running-gate.txt`
    - failure: 临时把 todo 3 的 (b) 门禁删掉跑 `npm test` → **必须红**（`longRunning` 相关新用例失败）。这证明套件真的在守护本特性，而非恒绿。Evidence: `.omo/evidence/task-long-running/task-9-task-long-running-regression-check.txt`
  Commit: Y | `chore(server): 全量门禁绿`
  Recommended task executor category: unspecified-high - 本身是机械跑测，但「区分真回归与需更新期望值」需要判断，且横跨多个 spec 文件。

- [ ] 10. worker + web 门禁绿
  What to do / Must NOT do: 跑 `cd worker && npm run typecheck && npm test && npm run build` 与 `cd web && npm run lint:check && npm run build`，修掉因本改动（含 `task-detail-types.ts` 手写镜像）而失败的项。**不得**改 `web/src/types/task-status.ts`（有 `web/scripts/check-task-status-single-source.mjs` 在 prebuild 守护）；不得为绿而删 Playwright 用例；不得跑 `npm run test:e2e`（web）并把它当 CI 门禁——`ci.yml:1-13` 有意排除 Playwright，`gate.sh` 只在 `--with-playwright` 下才跑。
  Parallelization: Wave 4 | Blocked by: 1, 5 | Blocks: F1-F4
  References: `scripts/gate.sh:1-40`（worker 段 = `typecheck`/`test`/`build`；web 段 = `lint:check`/`build`；:33 `--with-playwright` 开关）、`.github/workflows/ci.yml:1-13`（有意排除 Playwright）、`.github/workflows/ci.yml:61`（worker `npm run typecheck`）、`web/package.json:13-14`（prebuild 挂 `check-task-status-single-source.mjs`）、`web/src/components/tasks/task-detail-types.ts:29-48`（手写镜像 server DTO，无 codegen）、`worker/`（本次无代码改动，应零失败——若失败说明 todo 2/5 有溢出）。
  Acceptance criteria: ① 两条命令链退出码全为 0；② `test ! -f web/openapi.json`；③ `cd web && node scripts/check-task-status-single-source.mjs`（或 `npm run build` 间接执行）退出码 0。
  QA scenarios:
    - happy: 两条命令链退出码 0。Evidence: `.omo/evidence/task-long-running/task-10-task-long-running.txt`
    - failure: 临时在 `task-detail-types.ts` 加一个不存在的属性引用并跑 `npm run build` → **必须失败**。Evidence: `.omo/evidence/task-long-running/task-10-task-long-running-typecheck.txt`
  Commit: Y | `chore(worker,web): 全量门禁绿`
  Recommended task executor category: unspecified-high - 两个独立包的构建门禁，失败点分散但每处修复都很浅。

- [ ] 11. 上线 runbook（含已知局限）
  What to do / Must NOT do: 在 `docs/` 下写 runbook（建议 `docs/deployment-task-long-running.md`；文中所有 `t_0000000003` 一律写成占位符 `<值班任务 id>` 并注明**由运维提供**——它在仓库中仅作 `tasks.service.spec.ts` 的测试夹具出现，`server/prisma/seed.ts` 无此行，执行者无法从仓库核实），写明：(1) 完整上线顺序——迁移 → `schema.prisma` → `prisma generate` → 代码 → 部署 → `UPDATE tasks SET long_running=1 WHERE id='t_0000000003'` → **再** `POST /tasks/:id/resume`（顺序不可反：先 resume 会在未打标记的任务上重新武装看门狗，30min 内被重新阻塞）；(2) ⚠️ `scripts/deploy-k8s.sh:417-422` 的 `kubectl wait --for=condition=complete job/${RELEASE}-init` **是 best-effort，不是门禁**：它在 `if` 里、`else` 分支只 `warn`（:421-422），`:426` 的 `kubectl rollout status … || warn` 照常执行，`set -euo pipefail`（:58）在条件语境里无效。**故「迁移先于应用启动」靠人工纪律而非脚本强制**，runbook 须补显式人工校验步骤（rollout 前确认 `_prisma_migrations` 无 `failed` 行、且 `tasks.long_running` 列已存在）；**不得**修改 `deploy-k8s.sh` 本身；(3) `prisma migrate deploy` **不**把 MySQL DDL 包进事务，失败会在 `_prisma_migrations` 留 `failed` 行需人工 `migrate resolve`（单条 `ALTER TABLE ADD COLUMN` 在 MySQL 8 原子，风险低）；(4) flag 回滚 `UPDATE ... SET long_running=0`，列回滚只能 dump-restore；(5) **L1** 硬删值班任务会让同团队 `queued` 行成为孤儿，修复入口是公开的 `promoteNext(teamId)`（`tasks.service.ts:649-652`），无数据丢失；(6) **L2** 零回填，除 `t_0000000003` 外需逐个显式设置；(7) **L3** 改 flag 不主动注销遗留巡检行，依赖 `{expire:true}` 在最长一个巡检间隔（**10min**，非 30s）自毁，急需立即生效则手工取消该 `progression_patrol` 行；(8) **session 判死不在本次范围**——长驻值班会话闲置数日后可能被 `worker-dispatcher.ts:4025` 的空闲扫描判死（只写 `Session.status`，不改 Task），若发生另开 issue。
  **Must NOT do:** 不得把 L1 描述成「不存在」；不得声称迁移可自动回滚；不得在 runbook 里写 `UPDATE` 的批量/条件推断写法（只允许显式单 id）。
  Parallelization: Wave 4 | Blocked by: 8（与矩阵第 11 行一致；Wave 4 内与 9/10 并行是**目录不相交**的并发主张，不是依赖主张——9/10 全绿不是本 todo 的前置） | Blocks: F1-F4
  References: `scripts/deploy-k8s.sh:417-422`（`kubectl wait --for=condition=complete job/${RELEASE}-init`）、`:426`（`kubectl rollout status deploy/${RELEASE}-server`）、`scripts/gate.sh:1-40`、`docs/tech-debt-rollback.md:12-15`（无 down-migration ⇒ dump-restore）、`server/src/tasks/tasks.service.ts:649-652`（`promoteNext(teamId)`）、`:1449-1452`（`currentTaskId` 置空）、`:358-359`（`isIdle`）、`server/src/tasks/task-progression.scheduler.ts:40`（10min 间隔）、`server/src/timers/trigger.service.ts:583-593`（`{expire:true}` → cancelled）、`server/src/chat/worker-dispatcher.ts:4025`（session 空闲扫描）、`docs/deployment.md`（既有部署文档风格参考）。
  Acceptance criteria: ① runbook 存在且上述 8 项齐全；② 顺序里 `UPDATE` 明确排在 `resume` **之前**；③ L1/L2/L3 三条局限均带**可执行的修复或恢复路径**；④ `grep -n "10min\|10 分钟" <runbook>` 命中 L3 的间隔说明。
  QA scenarios:
    - happy: F 终验逐条对照 runbook 检查，8 项全中。Evidence: `.omo/evidence/task-long-running/task-11-task-long-running.txt`
    - failure: F3 人工 QA 按 runbook 的顺序**故意先 resume 再 UPDATE** → 须观察到 30min 内被重新阻塞。⚠️ **必须先满足前置条件，否则该场景在正确实现上也无法通过**：`task-progression.scheduler.ts:577` 的 `hasInflightWork`(:641) 在任务**存在任一 `in_progress` issue**（`STALL_INFLIGHT_ISSUE_STATUSES`）**或**任务分区 `messages.task_id` 在 `STALL_CHAT_ACTIVITY_WINDOW_MS`(10min, :58) 内**有新消息**时，会走 `:578-584` 的**递延分支**（`quietStreak` 清零并 return，永不到 `fireStallDetected`）——而「有在途工作」正是值班任务的常态。故前置条件为：**该任务无 `in_progress` issue，且任务分区连续 10min 无新消息**。满足后观察**低层信号**（**读日志行** `[progression] taskId=… 连续 3 轮无进展，触发停滞处理`，scheduler:585-588，紧接 `fireStallDetected` 之前打出，同时含 quietStreak 值与 fireStallDetected 已调用的证据——⚠️ **不可**用 `GET /api/v1/triggers` 取 `payload.quietStreak`，`TriggersService.toItem`(triggers.service.ts:315-333) 的返回体不含 `payload`)，群公告 `【任务停滞】` 只是其表象。Evidence: `.omo/evidence/task-long-running/task-11-task-long-running-ordering.txt`
  Commit: Y | `docs(deployment): 长期值班任务上线 runbook 与已知局限`
  Recommended task executor category: writing - 交付物是运维文档，难点在把 3 条技术局限写成可执行的操作指引而非免责声明。

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit — 逐条对照本计划 13 条 Must have 与 11 个 todo，核实每一项都有对应改动与断言；核实无任何 Must NOT have 被违反（尤其：未在 `tasks.service.ts:1757-1759` 通用 CAS 加门禁、agent 门禁返 403 非静默、人工路径未被门禁、无新 MCP 工具名、零回填、清扫未被删除）。Recommended task executor category: unspecified-high
- [ ] F2. Code quality review — 审查 `deep-low` todo（1/3/6/7）的门禁位置、`:126` 等注释订正的准确性（**按三类分别审**：`:182-183`/`:207-208`/`:976-978`/`:126` 这 4 处是事实错误须改正；`:59`/`:107-109` 这 2 处**内容为真**、只许改写歧义**不得**改成新的错误断言——若 F2 按「6 处皆错」的前提审这两处，会把真注释改错）、清扫条件从 `payload.taskId` 取值（而非解析 `dedupKey`）、裸 `catch {` 未超 175、以及所有新注释是否与最终行为一致（尤其 `:98` 与 `:229-230` 关于 quietStreak 的表述）。Recommended task executor category: unspecified-high
- [ ] F3. Real manual QA — **载体：仓库根 `docker-compose.yml` 的 `db`(mysql:8, :22-29) + `init`(`npx prisma migrate deploy && node dist/prisma/seed.js`, :44-47) + `server`(:56) + `web`(:96)**，用 `docker compose up -d db init server` 起真实栈（这是全流程唯一能拿到真实 MySQL 的途径，CI 与单测都没有）。在真实运行的服务上按 runbook 走一遍：(a) 建一个 `longRunning=true` 任务并 `start`，观察 **≥3 个巡检周期**内任务状态恒为 `in_progress`、无 `【任务停滞】` 群公告、`triggers` 表无 `kind='progression_patrol'` 的 pending 行；(b) 人工走 `mark-pending-review → accept → archive` 全链；(c) 验证 agent 调 `mark-pending-review` 收到 403；(d) 反向顺序（先 resume 后打标记）复现被重新阻塞，**但必须先排除 `hasInflightWork` 的递延分支**：确认该任务无 `in_progress` issue 且任务分区连续 10min 无新消息（`STALL_INFLIGHT_ISSUE_STATUSES` / `STALL_CHAT_ACTIVITY_WINDOW_MS`，scheduler:641-694/:58），否则 `:578-584` 会把 `quietStreak` 清零并 return，`【任务停滞】` 永不出现——此时不得判为失败，应先排除前置条件。以日志行 `[progression] taskId=… 连续 3 轮无进展，触发停滞处理`（scheduler:585-588）为准，它同时给出 quietStreak 值与 `fireStallDetected` 已调用的证据；⚠️ `GET /api/v1/triggers` **不返回** `payload`（`TriggersService.toItem`:315-333），故 `quietStreak` 无法经 API 读取，群公告为表象。Recommended task executor category: unspecified-high
- [ ] F4. Scope fidelity — 核实 diff 未触碰：`Team.currentTaskId`/队列逻辑、`TASK_TRANSITIONS`、任何看门狗阈值常量、`worker-dispatcher` 的 session 扫描、Swagger-MCP 绑定现状、`docs/` 中 `13-…:41/:42` 的既有漂移、死代码 `scan()`/`patrolNow()`、`agent.constants.ts`/`platform-capability.constants.ts`/`seed.ts` 的工具注册表。Recommended task executor category: unspecified-high

## Commit strategy

- **单一分支、一个线性历史**，11 个 todo = 11 个原子提交（终验波不提交，只出报告）。
- 每个 todo 末尾自带 `Commit:` 行，worker 照做，不自行合并/改写。
- 提交信息用仓库既有 conventional commits 风格（参考近期 `feat(memory): 角色级记忆 + 单条记忆的自动注入开关` / `fix(web): ...` / `fix(db): ...`）。
- **Todo 1 必须是独立提交且信息中显式写明「迁移先行」的上线顺序**——运维会按提交顺序 review。
- **Todo 3（巡检豁免）与 todo 7（注释 + 清扫）不得压成一个提交**：两者独立可回滚，且 7 依赖 3 与 6 都已合入才能验证清扫改动（7 的源码守卫 spec 要断言 6 写入的第三处 `select`）。
- 不 squash、不 rebase 已推送历史。当前分支 `task-delete-and-db-readiness-v2` 与本需求无关，**建议新开 `task-long-running`**；若沿用当前分支，todo 1 的提交必须与其既有提交解耦。
- **不 commit 任何 `.omo/evidence/` 之外的临时文件**；evidence 按 Verification strategy 的路径落盘。

## Success criteria

全部满足才算完成，且**全部由 agent 自行验证，零人工介入**：

1. `cd server && npx prisma validate && npx prisma generate` 成功；`npx tsc --noEmit` 零错误。**这三者 + `prisma generate` 是全流程中唯一真正触碰 `long_running` 列的东西**——不存在任何"在真实 DB 里验证过"的主张。
2. `bash scripts/gate.sh` 退出码 0（server + worker + web 三段）；`--with-playwright` 段为可选，**不得**把 Playwright 当 CI 门禁（`ci.yml:1-13` 有意排除）。
3. **核心特性断言成立**（对 `longRunning=true` 的 `in_progress` 任务）：`register()` 不调 `triggers.schedule`；`handleProgressionFire` 返回 `{expire:true}` 且 `dispatchAgentMention` **未被调用**、`payload.quietStreak` **未推进**；**`systemBlock()` 可被调用但不得调 `transition`**、任务状态保持 `in_progress`（见 todo 6 AC ⑨；scheduler 侧断言 `stallHandlers` 为空，勿在 scheduler spec 里断言 `systemBlock`）。**并且**负向对照成立：非 `longRunning` 任务的同一条路径仍叫醒 agent、仍推进计数、返回值非 `{expire:true}`。
4. **启动路径断言成立**：B1（in_progress 任务的 pending 行跨启动存活，`fireCount`/`quietStreak` 不被重置、`triggers.schedule` 调用 0 次）、**B2（任务已转终态的 pending 行仍被清扫为 `CANCELLED`——防止"把清扫删掉"这个错误修法）**、B3（`longRunning` 任务在启动时不排期）。
5. **人工完成通道未被破坏**：`longRunning` 任务走人工 `mark-pending-review → accept → archived` 全链成功（状态依次 `pending_review → completed → archived`）；agent 的 `block`/`resume` 仍可用。
6. **回归护栏成立**：非 `longRunning` 的 `in_progress` 任务 `remove()` **仍**抛 `TASK_DELETE_BLOCKED`；非 `longRunning` 任务的 agent `mark-pending-review` **仍**成功；`longRunning` 任务的 agent `accept`/`archive` **仍** 403。
7. **存量不破**：`task-progression.scheduler.spec.ts` 原有全部用例仍绿（尤其 :256/268/278/502/529/544 的 `triggers.schedule` 断言）；MCP 工具数仍为 32（`platform-mcp.controller.spec.ts:278（断言在 :294）` 与 `agent-role-capabilities.migration.spec.ts:210-211` **两处**）；`src/` 裸 `catch {` 计数 ≤ 175。
8. **源码守卫成立**：`server/src/tasks/task-progression.scheduler.ts` 中**不**存在「退役清扫 / fan-out JOIN drain 接管 / periodic patrol 退役」类**错误**表述；且每一处「缺省 Xmin」注释都与 `DEFAULT_PROGRESSION_INTERVAL_MS`（`10 * 60_000`）一致。**断言常量与错误表述，而非断言具体措辞**；⚠️ **不得**对「已退役」子串做零命中断言——`:59`/`:107-109` 里该字样对应的事实为真（setInterval 扫描确已退役、ticker 确为唯一节拍），消除它只会逼出新的错误注释。守卫 spec 用 `plan-removal.guard.spec.ts` 的源码扫描先例形态。
9. 文档：5 个 `docs/agent-platform/` 文件均含 `longRunning` 行；`13-…:41/:42` 的既有漂移**未被**改动；仓库内无 `openapi.json`。
10. 上线 runbook 存在且顺序正确（`UPDATE` 在 `resume` **之前**），L1/L2/L3 三条局限各带可执行的修复或恢复路径。
11. **已知局限 L1 被显式记录而非隐藏**：硬删值班任务会让同团队 `queued` 行成为孤儿（`remove()` 从不调 `promoteNextInTx`，而 `createTaskInternal:359` 会把该团队读成空闲），修复入口 `promoteNext(teamId)` 已在 `tasks.service.ts:649-652` 存在，无数据丢失。
