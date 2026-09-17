# trigger-unification — 触发机制统一 + Agent Hook

## TL;DR (For humans)

**What you'll get:** 把系统里六套各自手写的"等一会儿/定期/满足条件再动手"机制收成一套底座；在这套底座上给 agent 新增"预约唤醒"能力（4 小时后叫我、全员静止后叫我）；服务重启/扩容后这些自动化不再静默失效；并新增「系统管理」二级导航来查看和管理它们。

**Why this approach:** 只统一"何时触发"（WHEN），把"什么条件"（IF）和"做什么"（THEN）留给各业务域。因为现有机制真正分化的地方是升级语义——评审门明确写着"本路径永不自动通知"、计划故意没有 deadline；硬抽成一个大而全的框架会把"绝不自动"变成"自动"，风险最高。

**What it will NOT do:** 不统一催办冷却范围、不统一升级语义、不合并义务行存储（回执表/账本 JSON/计划行各自保留）、不给计划加超时、不做 UI 新建触发表单、不做逐项开关、不放"平台配置"占位入口、v1 不接事件触发（只做定时 + 条件）。

**Effort:** Large
**Risk:** Medium-High — 动的是已被 receipt/评审/巡检依赖的执行底座，靠「逐步迁移 + 每步等价性验证 + PoC 门禁」锁住
**Decisions to sanity-check:** `timers` 走 expand-contract（非一次 rename）；`all_idle` 判定需先 PoC 实测 lag 才定 grace；wake 环路防护用 hook 行血缘（非 session depth）；事件触发降级为游标轮询的秒级延迟是否可接受。

Your next move: 在 worker 会话里跑 `$start-work trigger-unification` 开工。Full execution detail follows below.

---

> TL;DR (machine): Large, Medium-High, 21 implementation todos + F1-F4 for trigger abstraction, 6-step migration of ad-hoc schedulers, agent hook MCP tools, and /system admin UI.

## Background

现状是六类"延迟/周期/条件触发"各自手写，保障级别互不一致：

| 机制 | 位置 | WHEN | 状态 | 重启安全 | 多副本安全 |
|---|---|---|---|---|---|
| DB 一次性定时器 | `server/src/timers/timer.service.ts` | `fireAt<=now` | `timers` 表 | 行持久，⚠️ ticker 惰性 | ✅ 原子 claim |
| 内存周期巡检 | `server/src/tasks/task-progression.scheduler.ts` | 30s 扫 + `nextRunAt` | 内存 Map | ⚠️ 轮次清零 | ❌ |
| 内存看门狗 | `server/src/chat/worker-dispatcher.ts` | `setTimeout` / 60s 扫 | 内存 Map | ❌ | ❌ |
| 事件→动作 | 5× `realtime.subscribe` | bus 事件 | 无 | ❌ 漏事件 | ❌ 漏 / N 倍重复 |
| 读时惰性过期 | `questions.service` / `message-inbound` | GET 时比对 TTL | DB | ✅ | ✅ |
| 心跳/能力 ticker | `workers.service` / SSE / 企微 spinner | 固定 interval | DB/内存 | 视情况 | — |

已确认的两个事实：
- **无挂起/恢复机制。** agent「停止」= turn 结束，worker 回 `session.updated{idle}`，session 仍绑在 worker 上。唤醒 = 复用同一 `ses_` 再派一个 turn：`workerDispatcher.dispatchAgentMention({..., kind:'wake'})`。
- **`realtime_events` 已是带单调 `ev_` id 的持久日志**，可作事件触发的游标源（进程内 `subscribe` 会漏会重）。

可复用的重复项：`kind:scope:id` 幂等键、deadline 字段、`{timeoutMs,maxAttempts,cooldownMs}` 常量、终态守卫骨架、`team:`+`channel:` 事件双发。
**不可统一**：cooldown 范围（仅 receipt 按人）、升级语义（自动升级 vs 永不自动通知 vs 打回重修）、义务行存储形态。

## Scope

### Must have
- `TimerService` ticker 改 eager 启动（修既有静默失效 bug）
- `TimerService` → `TriggerService` 泛化：新增 `interval`（重复）+ `condition`（谓词轮询）+ scope/owner/guard 列
- 逐步迁移 4 个时钟型机制：`receipt_nudge` / `review_round_timeout` / `TaskProgressionScheduler` / dispatcher 看门狗与 idle-scan
- `Session.lastActivityAt` 落库，使 idle-scan 与 all_idle 判定重启安全
- Agent hook：`hook_register` / `hook_cancel` MCP 工具，kind = `time` + `all_idle`，action = `wake`
- 前端：Dock 一级「系统管理」+ `/system` 页内左侧二级导航 + `/system/triggers` 页面
- 前端：`users` / `roles` / `memories` 迁入 `/system/*`（旧路径 308 重定向）
- 前端：团队会话第 5 个 Tab「触发」
- 护栏：minDelay / TTL / 每 scope 配额 / 每 task 唤醒预算 / hook 行血缘环检测

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不统一催办冷却范围：`isAssigneeMuted`（按人 `lastNudgedAt`）保持 receipt 域独有
- 不统一升级语义：review-gate「本路径永不调用 notifier」「绝不自动放行」原样保留
- 不合并义务行存储：`MessageReceipt` 表、ledger-in-JSON、`Plan` 行各自保留，Trigger 只经 `{kind, id}` 引用
- 不给 `plan-lifecycle` 加 deadline（`dueAt` 必须可空）
- 不实现事件触发（`event` kind 仅占位，不透出）；不迁移 5 个 `realtime.subscribe`
- 不做 UI「新建触发/编辑触发」表单；不做逐项启停开关
- 不放「平台配置」占位入口
- 不改任务状态机 / RBAC 矩阵 / 门禁语义 / throttle 配额
- 不新增第三套哈希算法、不新增第三方依赖

## Design decisions (locked)

> 2026-09-17 经 Oracle 架构评审修订（首版有 7 处会导致生产事故的缺陷，见文末「Oracle 评审修订记录」）。

1. **抽象边界**：WHEN 统一（once / interval / condition 归一为"对 DB 状态的轮询"）；IF 保留（谓词为回调，不表达成配置）；THEN 保留（动作为函数，不是枚举）。
2. **存储**：单表方向（不建双表双写），但 `timers`→`triggers` **走 expand-contract 三段式**：①加新列 `dueAt` → ②回填 `dueAt = fireAt` → ③切读新列 → ④删旧列。**不在同一次迁移里 rename**。`kind` 收敛为后端白名单枚举，未知 kind → `expire` + 告警（不 feature-detect）；`guardKey` 仅允许注册表内的谓词名（白名单，非任意字符串）。`tmr_` 前缀**冻结**（不改 `trg_`，避免 id-resync 二次改动）。
3. **handler 合同**：`TriggerHandler` 返回 `{done:true} | {rescheduleAt:Date} | {expire:true}`；**绝对时间 `rescheduleAt`（非相对 ms）**，重启后可恢复。但复发/上限不得全推给 handler（否则退化为 `switch(kind)`）：**base 强制 `maxFires` 与 `expiresAt`**，handler 无权绕过；逾期未执行（服务停机错过窗口）→ base 钳制为 `now + jitter` 立即补一次，而非追赶全部错过的周期。
4. **all_idle 判定**：**DB + 内存一票否决**（非 DB-only）。`Session.status` 靠 worker 事件回流有秒级 lag，故：内存 `pendingBySession`/`activeExecutions` 若显示忙 → **veto**；DB 无 `running` 且 `now - max(Session.lastActivityAt) >= graceMs`（**默认 3~5min，非 60s**）→ 候选；fire 前**二次复核**；同 tick 命中多个 hook **只唤醒一次**。worker 离线致 `running` 常驻 → 由既有 worker 离线判定兜底。**此判定必须先做 PoC（见 todo 0）实测 lag 分布，PoC 不过则不进入 Wave 2。**
5. **系统触发权限**：`/system/triggers` 管理员可取消（含系统项）；团队会话 Tab 只读系统项、可取消 agent 项。**取消必须服务端复核 owner/admin，UI 隐藏不算权限。**
6. **事件触发**：降级为 `realtime_events` 游标轮询（`id > cursor`），换取重启/多副本正确性；v1 不实现，仅预留。
7. **二级菜单形态**：页内常驻左侧栏 208px（非 Dock 内联嵌套），`<1024px` 折叠为顶部横向 pill；选中态复用 Dock 的 `rgba(13,148,136,.1)` + `#0F766E` + 3px `#0D9488` 指示条。
8. **`平台配置` 子项**：v1 不显示（不放假入口），等有内容再加。
9. **hook↔trigger 一致性**：hook 行与其 trigger 行**必须同一 Prisma `$transaction` 建立**；reconciler 从收尾波**提前到 Wave 0**（启动即跑 + `failed` 行即时告警），nightly 兜底不作为主防线。
10. **内存态退役策略**：`activeExecutions` / `pendingBySession` / `completedSessions` / `failedSessions` / `sessionActivity` / `pollCursors` **不做删除式迁移**。`lastActivityAt` **双写**（内存 + DB），内存仅作 veto 不再作 source of truth；**退出决策（todo 21 于 2026-09-17 裁决，选 (a)：v1 永久保留内存 veto——已确认不删，`lastActivityAt` 内存 map 不删除）**。裁决依据：(b) 的前件要求「双写期 ≥1 个发布周期（= todo 1 独立上线后的下一个版本）且无 `sessionActivity` 分叉告警」，而裁决时整个 trigger-unification 仍是单分支未提交 WIP（`git tag` 为空、无任何版本发布、计划文件本身从未提交、todo 1 未独立上线——发布周期数为零），且代码库中根本不存在 `sessionActivity` 分叉告警机制（`分叉|diverg` 全库仅命中 plan-file 展示提示，无会话活动分叉遥测），(b) 的两个前件皆不成立。若将来重提退役，必须先补分叉遥测 + 走完一个发布周期，另开新 todo，不在本计划内。`isAgentExecuting` 快路径语义**零改动**（`platform-mcp.assertWorkerTask` 防伪依赖它）。
11. **wake 环路防护**：depth 计数器在 `reuseSession=true`（同 `ses_` 跨任务复用）下无附着点，弃用。改为 **hook 行血缘**：`parentHookId` + `rootTaskId` + 每 task 预算 N=5，判环 + 超预算切断；`resetAfterComplete` 仅将已完成 task 的 hook 置 `expired`，**不删链**（删链会丢失跨 task 判环依据）。
12. **fireDue 时间基准**：比较用 **DB `NOW()`**（非 app `now`），避免应用/DB 时钟漂移；查询加 `WHERE dueAt IS NOT NULL` + `ORDER BY dueAt LIMIT 100` + jitter，防重启后 overdue 惊群；interval 逾期后 `nextFireAt` **从 now 重算**（非旧值累加）。
13. **可观测**：trigger 行加 `skipReason` / `busyRetries` 列（写点在 todo 20），否则「为什么没醒」无法排查。wake 目标在 fire 时**重解** task/session；task 已归档 / 会话已 reset → 置 `expired`（不抛错、不静默滞留）。
14. **部署前提（v1）**：**单 `server` 副本**。内存 veto 只能否决本进程的忙态，多副本下他副本的进行中 turn 看不见 → `all_idle` 可能误醒。多副本需 leader 选举（列为升级触发条件，不在本次范围）。
15. **expand-contract 切换顺序**：回填与切读**不在同一次 deploy 保证**，故新代码必须用 `WHERE dueAt IS NOT NULL AND dueAt <= NOW()`（而非裸 `dueAt <= NOW()`，MySQL 下 null 行会漏选导致丢火）；窗口期 `schedule` 双写 `fireAt`+`dueAt` 两列。

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + jest（`--runInBand`，单文件过滤）+ curl+jq（MCP 契约）+ Playwright（/system 导航、团队 Tab）
- Evidence: `.omo/evidence/trigger-unification/task-<N>/`（响应 JSON、DB dump、jest 输出、截图）
- 基线：动手前先跑所涉套件记 pass 数，回归时对比区分
- **迁移等价性（核心）**：每迁一个消费者，必须证明「同样的输入 → 同样的触发时点 + 同样的动作」，用固定时钟单测锁死
- **重启安全**：每步后手动重启 server，验证 pending 仍按时触发（这是本次改动的主要收益，必须逐步骤证）

## Execution strategy

### Parallel execution waves

> Oracle 修订：todo 1 拆分（eager ticker 先独立上线修静默失效）；`all_idle` PoC 成为 Wave 2 的硬前置门；reconciler 提前到 Wave 0；内存态走双写退役而非删除。

- **Wave 0（底座 + 自愈）**：todo 1（eager ticker，**独立可上线**，先修静默失效）、todo 2（expand-contract 加列）、todo 3（reconciler 启动自愈）先行；todo 1 与 2/3 无依赖可并行
- **Wave 1（消费者迁移，部分可并行）**：todo 7（`lastActivityAt` **双写**）必须先于 todo 8/9/11 完成；todo 5 与 6 可并行；**迁移期间内存 veto 态保留不删**
- **Wave 2（`all_idle` PoC 门 + 新功能）**：todo 10（PoC 实测 dispatch→`running` lag 分布，定 grace/debounce）为**硬门禁**，PoC 不过则 `all_idle` 降级为「建议位」不自动 wake、或整体不进入 Wave 2；todos 11-13 依赖 Wave 1 底座
- **Wave 3（前端）**：todos 14-15（/system 框架）与 18（团队 Tab）可并行；todo 16 依赖 14/15，todo 17 依赖 15
- **Wave 4（收尾）**：todos 19-21（护栏 + 可观测 + 双写退出决策）横切，最后做。**todo 11（建表带护栏字段）与 todo 19（判环逻辑）必须同版本发布、不拆分上线**（防「字段已建但判环未上」的无护栏窗口）

### Dependency matrix

| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 4,5,6,11 | 2,3,7 |
| 2 | — | 3,4,5,6,8,11 | 1,7 |
| 3 | 2 | 11 | 1,7 |
| 4 | 2 | 5,6,8,9,11 | 7 |
| 5 | 4 | — | 6,7 |
| 6 | 4 | — | 5,7 |
| 7 | — | 8,9,11 | 1,2,3 |
| 8 | 2,4,7 | — | 9 |
| 9 | 2,7 | — | 8 |
| 10 (PoC) | 7,8,9 | 11 | — |
| 11 | 2,7,8,9,10 | 12,13,19 | — |
| 12 | 11 | 13 | — |
| 13 | 11,12 | — | — |
| 14 | — | 15,18 | 17,19 |
| 15 | 14 | 16,18 | 17,19 |
| 16 | 15,20 | — | 17,18 |
| 17 | — | — | 14,15,16,18,19 |
| 18 | 14,15 | — | 16,17,19 |
| 19 | 11,12,13 | 21 | 20 |
| 20 | 11,12,13 | 16 | 19,21 |
| 21 | 11,19 | — | 20 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

### Wave 0 — 底座 + 自愈

- [x] 1. `server/src/timers/timer.service.ts`: `ensureTicker` 改为 `onModuleInit` eager 启动（env `TIMER_SCAN_INTERVAL_MS<=0` 仍禁用）以修「重启后 pending 定时器不触发」— expect **独立可上线**、启动即见 ticker、无 `schedule()` 也能触发既有 pending 行 + spec 覆盖「boot 时已有 overdue 行 → 被 fireDue 取到」

- [x] 2. `server/prisma/schema.prisma` + 迁移（**expand-contract 三段式，不 rename**）：① 加列 `dueAt?`/`scopeType?`/`scopeId?`/`ownerInstanceId?`/`intervalMs?`/`nextFireAt?`/`guardKey?`/`fireCount`/`maxFires?`/`expiresAt?`/`skipReason?`/`busyRetries`；② **同迁移内 `UPDATE triggers SET dueAt = fireAt WHERE dueAt IS NULL`**；③ 新代码读 `dueAt`（**窗口期双写两列**）；④ 后续迁移删 `fireAt`。**`dueAt` 加索引 `(status, dueAt)`**；`kind` 收敛为后端白名单枚举，未知 kind → `expire`+告警；`guardKey` 仅限注册表白名单；`tmr_` 前缀**冻结不动** — expect `migrate deploy` 可跑、**回填完成前新代码不切读**、旧 2 行业务数据无损、`resyncIdPrefix` 零改动 + 单测覆盖「旧行回填后等价」+「`dueAt IS NULL` 行不被漏选」

- [x] 3. `server/src/triggers/`: 新增 reconciler —— **启动即跑 + 每 15min 周期兜底**（boot 之间产生的孤儿不等下次重启）；扫「hook pending 但 trigger 行 failed/missing」与「trigger fired 但 hook 仍 pending」两类孤儿，**`LIMIT 500` 分页 + claim 式修复防多副本双修**；**`failed` 行即时告警归属本 todo**（向 `realtime_events` 写 `trigger.reconcile`） — expect 启动自愈可测（预置孤儿 → boot 后被修）+ 周期兜底可测 + 两类方向各一单测

- [x] 4. `server/src/common/constants/` + `TriggerService`: 定义 `TRIGGER_KIND` 白名单（`receipt_nudge`/`review_round_timeout`/`progression_patrol`/`session_idle_scan`/`hook_fire`/`hook_poll`）与 `buildTriggerDedupKey(kind, scope, id)` 统一构造；`TriggerHandler` 签名返回 `TriggerOutcome = {done:true}|{rescheduleAt:Date}|{expire:true}`；**base 强制 `maxFires`/`expiresAt`**（handler 无权绕过）；逾期错过窗口 → **`nextFireAt = now + intervalMs + jitter(0~30s)` 从 now 重算（非旧值累加）**，one-shot 逾期只补一次不追周期；`fireDue` 用 **`WHERE dueAt IS NOT NULL AND dueAt <= NOW()`**（DB 时钟）+ `ORDER BY dueAt LIMIT 100`；**窗口期 `schedule` 双写 `fireAt`+`dueAt`** — expect 各域 dedup key 与现状逐字节一致（`receipt_nudge:{teamId}:{receiptId}`、`review_round_timeout:{issueId}:{round}`）+ 单测覆盖 claim 互斥 / `rescheduleAt` / `expire` / 上限强制 / 逾期钳制 / 双写列一致

### Wave 1 — 消费者迁移

- [x] 5. `server/src/chat/receipt-nudge.handler.ts`: `registerHandler` 换 `TriggerService` 新签名（handler 返回 `{done:true}`），`platform-mcp.service.ts` 排期改走新 `schedule` 以证明底座等价 — expect 现有 `platform-mcp.service.receipt-nudge.spec.ts` + `receipt-nudge.handler.spec.ts` 全绿且 dedup key 不变 + 重启后 pending 催办仍触发

- [x] 6. `server/src/chat/review-round-timeout.handler.ts` + `platform-mcp.service.ts`: 同上迁移；「超时绝不自动通知计划员」语义逐字保留以证明升级语义未被底座污染 — expect `review-round-open.spec.ts` 全绿、stale 仍不触发 notifier + 重启后 timeout 仍触发

- [x] 7. `Session.lastActivityAt` **双写**（`worker-event.ingress.ts` + `worker-dispatcher.ts`）: `handleSessionActivity`/`touchSessionActivity` 同时写内存与 DB；**内存 `pendingBySession`/`activeExecutions` 保留为 veto，不删**；`scanIdleSessions` 改查 DB（`status='running' AND lastActivityAt < now-idleTimeout`）+ 内存 veto 兜底 — expect 重启后仍能判死 + 单测覆盖「内存 Map 为空但 DB 有 stale running 行」+ `isAgentExecuting` 快路径语义零变化（`assertWorkerTask` spec 全绿）

- [x] 8. `server/src/tasks/task-progression.scheduler.ts`: 巡检循环改 `TriggerService` 的 `interval` 形态（DB 存 `rounds`/`nextFireAt`）替代内存 `Map`+`setInterval` 以修「重启丢轮次计数致防空转上限失效」；**迁移期保留内存冷却 veto** — expect `maxRounds` 在重启后仍生效 + 冷却检查（`isSessionPending`/`getLastActivityAt`）行为不变 + `restoreInProgressTasks` 精简为数据修复

- [x] 9. `server/src/chat/worker-dispatcher.ts`: first-token 看门狗改 `TriggerService`（DB 存 pending dispatch）替代 `setTimeout`；**`pendingBySession` 保留为 veto 不删** — expect 重启后无首字的 dispatch 仍被标记 failed + `activeExecutions` 的 `isAgentExecuting` 语义不变（MCP `assertWorkerTask` 依赖它）

### Wave 2 — all_idle PoC 门 + Agent Hook

- [x] 10. **PoC（硬门禁，可执行定义）** `server/src/triggers/` 临时探针: 埋点 `dispatchAgentMention` → worker `session.updated{running}`，**采 N≥100 次样本**，输出 P50/P99 到 `.omo/evidence/trigger-unification/todo-10/`。**通过判据：P99 ≤ 30s 且 `graceMs ≥ P99 + 60s`**；**裁决人 = 计划作者**；**超时 2 天未通过 → 自动降级为「建议位」**（`all_idle` 不自动 wake，转人工确认）。硬降级阈值 `P99 > 30s` 写在本 todo — expect 数据报告 + 明确通过/降级结论；**降级时 todo 11 的 `all_idle` 分支仅写建议不 wake，其余不变**

- [x] 11. 新增 `server/src/triggers/hook.service.ts` + hook 迁移: `hks_` 表 `{id, scopeType, scopeId, ownerInstanceId, kind(time|all_idle), wakeText, target, status, dueAt?, graceMs?, expiresAt, dedupKey, fireCount, parentHookId?, rootTaskId?, lastError, skipReason?}`；`time` → 排 `hook_fire` trigger；`all_idle` → 全局 `hook_poll` 扫描求值 `DB predicate + 内存 veto`，同 tick 命中多个只唤醒一次；触发走 `dispatchAgentMention({..., kind:'wake'})`，`wakeText` 限长 2k + `[hook:<kind> <id>]` 前缀；hook 行与 trigger 行**同一 `$transaction` 建立**；**血缘继承规则：wake 建新 hook 时 `parentHookId = 触发它的 hook.id`，`rootTaskId` 继承不重置**；`resetAfterComplete` **仅将已完成 task 的 hook 置 `expired`，不删链**；wake 目标 **fire 时重解**，task 归档/会话 reset → `expired`；**veto 路径（忙则不醒）必须同时写 `skipReason`** — expect 单测覆盖 time 到点唤醒 / all_idle 无 running 时唤醒 / 忙则 veto 不误醒且写 `skipReason` / 目标失效置 `expired` / 事务失败无半写 / 血缘正确继承

- [x] 12. `server/src/platform-mcp/platform-mcp.tools.ts`: 新增 `hook_register` / `hook_cancel` 两个工具（zod schema + `buildPlatformMcpTools` 条目），handler 强制走 `resolveExecContext`/`assertWorkerTask|Team`、`ownerInstanceId` 服务端取自 `callerId`（拒绝客户端传入）；`hook_cancel` **服务端复核 owner 或 admin**（UI 隐藏不算权限） — expect 未知 scope 400、跨团队冒用 403、非 owner 非 admin 取消 403、schema 经 `zodObjectToJsonSchema` 透出

- [x] 13. `server/prisma/seed.ts` + `execution-policies`: `vteamTools` 追加 `hook_register`/`hook_cancel` 两行；`ROLE_BOUNDARIES` + 各角色 `toolAllows` 决定放行面（默认 deny，先仅 product/main 角色 allow）经 `agent-policies.matrix.spec.ts` 校验 — expect `npm run seed` 幂等、新工具对未授权角色 403、矩阵 spec 绿

### Wave 3 — 前端

- [x] 14. `web/src/components/layout/nav-dock.tsx` + `app-shell.tsx`: `NAV_ITEMS` 增 `{key:"system",label:"系统管理",icon:"⛭"}`；同步 `KEY_TO_PATH`/`CMDK_NAV_PATH`/`PAGE_TITLE`/`NAV_VISIBLE`（`isPlatformAdmin`）/`ROUTE_GUARD`；移除 `users`/`roles`/`memories` 三个一级项 — expect Dock 出现「系统管理」、Cmd+K「导航」组由 `NAV_ITEMS` 单源派生自动跟随、非管理员不可见

- [x] 15. 新增 `web/app/(main)/system/layout.tsx` + `src/components/layout/system-sidebar.tsx`: 页内常驻左侧 208px 二级导航（复用 `tokens.ts` 的 `surface`/`border`/`space`/`radius`/`fontSize`，选中态复用 Dock 的 `rgba(13,148,136,.1)`+`#0F766E`+3px `#0D9488` 指示条），`<1024px` 折叠为顶部横向 pill，顶栏面包屑 `系统管理 › <子项>` — expect 窄屏不挤压内容、深色模式跟随 `.dark`、选中态与 Dock 视觉一致

- [x] 16. 新增 `web/app/(main)/system/triggers/page.tsx`: 照 `memories/page.tsx` 骨架（`PageWindow` + `SegmentedTabs`[全部/定时/条件/事件] + 来源筛选 + 300ms 防抖搜索 + `Pagination` + `StatusBadge` + `EmptyState` + `ConfirmDialog`），触发历史抽屉照 `integrations/page.tsx` 的 `DeliveryDrawer`；**展示 `skipReason`（为什么没醒，依赖 todo 20 的写点）**；系统项取消仅管理员可见 — expect 列表可按团队/状态/来源筛选、取消走 `ConfirmDialog`、失败/跳过原因可见、SSE `useRealtimeEvents` + 10-30s `refetchInterval` 兜底刷新

- [x] 17. 新增 `web/app/(main)/system/{users,roles,memories}` + 旧路径重定向: 三个页面迁入并保留 `/users` `/roles` `/memories` 为 308 重定向以保书签与现有 e2e；同步更新受影响 e2e 断言 — expect 旧 URL 可达不 404、`npm run test:e2e` 相关用例绿

- [x] 18. `web/src/components/teams/TeamRightPanel.tsx`: `TaskSubTabs` 增第 5 个「触发」Tab（`{key:"triggers",label:"触发",badge:待触发数}`），挂按 `teamId+taskId` 过滤的同一列表组件；系统项只读、agent 项可取消 — expect badge 显示待触发数、Tab 内可取消 agent 项、系统项无取消按钮

### Wave 4 — 护栏与可观测

- [x] 19. `server/src/triggers/hook.service.ts`: 强制护栏 —— `minDelay≥60s`、默认 TTL 24h（上限 7d）、每 scope pending 上限 20、**每 task 唤醒预算 N=5**、**环检测用 hook 行血缘** `parentHookId`+`rootTaskId`（判环 + 超预算切断；跨 task ping-pong 用 `(parentHookId 链 + wakeText 相似度)` 兜底）、触发前复核忙则 `rescheduleAt:+60s` 最多 10 次后 `expired`（写 `busyRetries`） — expect 每条护栏有单测、超限返回明确错误而非静默、A↔B 同 task 与跨 task ping-pong 均能被切断、`reuseSession=true` 跨任务时血缘不误杀

- [x] 20. `server/src/triggers/` + `server/src/realtime/`: trigger 触发/过期/跳过写 `realtime_events`（`trigger.fired`/`trigger.expired`/`trigger.skipped`）以供 UI 与排查；成本归属记 `ownerInstanceId`；**`skipReason`/`busyRetries` 的写点落在本 todo（todo 16 的展示依赖它）** — expect `/system/triggers` 能看到触发历史与跳过原因 + 单测覆盖事件发射 + `skipReason` 在 veto/超时/目标失效三类路径均有写入

- [x] 21. `server/src/triggers/` + `server/src/chat/worker-dispatcher.ts`: **双写退出决策与落地（已裁决：选 (a)，见 decision 10）** —— 二选一并写明理由：**(a) v1 永久保留内存 veto**（仅双写不删 map，在 decision 10 显式写「已确认不删」）或 **(b) 定义退出标准**（双写期 ≥1 个发布周期、无 `sessionActivity` 分叉告警 → 删 `lastActivityAt` 内存 map，保留 `activeExecutions`/`pendingBySession` veto，附 spec）。**裁决人 = 计划作者；「1 个发布周期」= todo 1 独立上线后的下一个版本** — expect 结论落到 decision 10 或本 todo，不留「稳定后清理」的悬空表述 + 若选 (b) 有 spec 覆盖删后行为

- [x] 22. **【执行期发现的新增工作】** `server/src/timers/` 新增 controller：`triggers` 的 REST 只读列表 + 取消端点，供 todo 16/18 的前端消费（计划原缺此环，无任何 todo 产出该 API）—— `GET /api/v1/triggers`（query: `scopeType`/`scopeId`/`taskId`/`teamId`/`status`/`kind`/`page`/`pageSize`，返回 `{items,total,page,pageSize}`，items 含 `id/kind/status/dueAt/nextFireAt/scopeType/scopeId/ownerInstanceId/fireCount/skipReason/lastError/lastActivityAt` 与来源判定 `source: 'agent'|'system'`）；`DELETE /api/v1/triggers/:id`（取消：置 `cancelled`，**服务端复核 owner 或 admin**，非 owner 非 admin → 403）。复用 `AdminGuard`/`PermissionGuard` 既有语义，只读列表允许团队成员按 scope 过滤、跨团队不可见 — expect curl 契约绿（列表分页/过滤、取消 200、越权取消 403、未知 id 404）+ controller spec 覆盖 + `source` 判定把 `receipt_nudge`/`review_round_timeout`/`progression_patrol`/`session_idle_scan` 归 `system`、`hook_fire`/`hook_poll` 归 `agent`

## Final Verification Wave

- [x] F1. 需求符合性审计：逐条对照本文档 Scope / Design decisions（15 条）与 Must NOT have，确认未越界、未收紧任何门禁/权限语义 → 由 oracle 复核
- [x] F2. 代码质量评审：新增/改动文件逐行审，无 stub/`any`/吞错；**`activeExecutions`/`pendingBySession` 两个 veto 必须仍存在**（`lastActivityAt` 内存 map 的去留以 todo 21 的 (a)/(b) 裁决为准，二者均不违反本条）、`isAgentExecuting` 语义零漂移 → 由 oracle 复核
- [x] F3. 真实手工 QA：MCP 直调走通「注册 4h time hook → 重启 server → 到点被唤醒」与「注册 all_idle hook → 全员静止 → 主 agent 被唤醒巡检」两条链路；**必测两条边界**：① turn 进行中（worker 离线/事件在途）**不误醒** ② 重启后 overdue 批量**只补一次**且可观测到 `skipReason` → 由 unspecified-high 执行
- [x] F4. 范围保真 + 回归：确认 worker/web 仅动既定文件、C3 门禁零改动；`server` 与 `web` 全量测试对比动手前基线，区分新增失败与既有失败 → 由 oracle 复核

## Acceptance Criteria

1. server 重启后，重启前已排期的催办/评审超时/巡检/首字超时**全部仍按时生效**（当前全部静默失效）。
2. `receipt_nudge` 与 `review_round_timeout` 的 dedup key、触发时点、动作与迁移前**逐字节等价**，既有 spec 全绿且未放宽。
3. 任务巡检 `maxRounds` 在重启后仍生效（当前重启即清零 → 防空转失效）。
4. agent 可经 MCP `hook_register` 注册 4 小时后的唤醒，正常结束回合（团队显示空闲），到点后在**同一会话**被唤醒并保留上下文。
5. agent 可注册 `all_idle` hook；团队全员静止后主 agent 被唤醒执行产出检查。
6. 任意 hook 都不可能自唤醒死循环：minDelay / TTL / 每 task 预算 / hook 血缘环检测四道护栏均生效且有单测（含 A↔B ping-pong 被切断）。
7. `/system/triggers` 可查看全部待触发/已触发/已失败项并给出失败原因；`/system` 侧栏在 `<1024px` 折叠为顶部 pill；`/users` `/roles` `/memories` 旧路径 308 重定向可达。
8. 团队会话第 5 个 Tab「触发」显示本任务待触发项，系统项只读、agent 项可取消。
9. 普通成员看不到「系统管理」入口；未授权角色调用 `hook_*` 返回 403。
10. 未实现项（event hook / cron / 平台配置入口 / UI 新建表单）在代码与 UI 中均无半成品残留。
11. 内存 veto 态（`activeExecutions`/`pendingBySession`）在迁移后仍存在且 `isAgentExecuting` 语义未漂移（未被「删净」误伤）。

## Oracle 评审修订记录（2026-09-17）

首版计划经 Oracle 硬审，判定「方向正确（统一 WHEN、保留 IF/THEN、拒绝统一冷却与升级）但按原文执行必出生产事故」。以下 7 项已修订入计划：

| # | 首版缺陷 | 修订 |
|---|---|---|
| 1 | `timers` 原地 rename `fireAt→dueAt` 一次到位 | 改 **expand-contract 三段式**（加列→回填→切读→删列），`tmr_` 前缀冻结 |
| 2 | `{{rescheduleAt}}` 复发逻辑全推 handler → 退化为 `switch(kind)` | **base 强制 `maxFires`/`expiresAt`**；逾期钳制 `now+jitter` 补一次，不追赶周期 |
| 3 | **`all_idle` DB-only 判定** | 改 **DB + 内存 veto**；grace 从 60s 提至 **3~5min**；fire 前二次复核；同 tick 只唤醒一次；**先做 PoC 实测 lag**（todo 10 硬门禁） |
| 4 | 迁移删内存 Map → 破坏防伪快路径与事件去重 | **双写退役**：内存只做 veto 不做 source of truth；`isAgentExecuting` 零改动 |
| 5 | **wake depth ≤2** 在 `reuseSession=true` 下无附着点、可被 A↔B 绕过 | 改 **hook 行血缘** `parentHookId`+`rootTaskId`+按 task 预算；`resetAfterComplete` 清链 |
| 6 | hook/trigger 双写仅靠 nightly 兜底 | 建行走**同一 `$transaction`**；reconciler **提前到 Wave 0 启动即跑** + `failed` 即时告警 |
| 7 | `fireDue` 用 app `now`；重启 overdue 惊群；缺 `skipReason` | 改 **DB `NOW()`** + `ORDER BY dueAt LIMIT 100` + jitter；补 `skipReason`/`busyRetries` 观测列 |

**Oracle 给出的 3 个升级触发条件**（若命中则重新评估，不在本次范围）：
- PoC 测得 lag P99 > 30s 或 worker 离线频发 → `all_idle` 降级为「建议位」不自动 wake，转人工确认
- trigger 量 > 10k pending → 再做分区索引 `(status,dueAt,scopeId)` 与多副本 leader 选举；v1 单副本 claim 足够
- 多 `server` 副本部署 → 需 leader 选举（内存 veto 只覆盖本进程）

## Oracle 二审修订记录（2026-09-17，第二轮）

二审判定「方向全对、7 项有实质修订，但 6 项只修了一半（写了原则、没写接线）→ 不可直接执行」。以下已全部落地为可执行 todo：

| # | 二审指出的缺口 | 已落地 |
|---|---|---|
| 1 | expand-contract 缺双写写方、null 漏选、缺索引 | todo 2/4 明确「同迁移回填」+ `WHERE dueAt IS NOT NULL` + `dueAt` 索引 + `schedule` 双写两列；新增 decision 15 |
| 2 | maxFires/钳制残留下 jitter 量值与 nextFireAt 重算 | todo 4 写死 `jitter(0~30s)` 与「从 now 重算」 |
| 3 | PoC 无执行方法/采样量/裁决人/超时 | todo 10 改为可执行：N≥100 样本、判据 `P99≤30s 且 grace≥P99+60s`、裁决人、2 天超时降级 |
| 4 | 双写无退出项（F2 反而要求保留 → 永久双写） | 新增 **todo 21**：二选一（永久保留 或 定义退出标准 + spec）；decision 10 引用它 |
| 5 | `resetAfterComplete` 清链语义未定义、跨 task 环可绕过 | todo 11 明确「仅置 expired 不删链」+ 血缘继承规则；todo 19 加跨 task 兜底与 N=5 预算 |
| 6 | reconciler 只 boot 跑、无分页/claim、告警无归属 | todo 3 改为「启动 + 每 15min + LIMIT 500 + claim 式 + 告警归属本 todo」 |
| 7 | jitter 位置、可空 dueAt 排序、`skipReason` 写点缺失 | todo 4/11/20；todo 16 依赖 todo 20 |
| 8 | **两套依赖矩阵打架** | 删除重复矩阵，保留单一权威矩阵（todo 3 依赖 2） |
| 9 | 护栏字段在 todo 11、判环在 todo 19 → 中间无护栏窗口 | todo 19 依赖 11/12/13，且 todo 11 建表即带字段；护栏逻辑与建表同日完成不跨发布 |
| 10 | `hook_poll` veto 语义依赖 dispatcher/巡检迁移 | todo 11 依赖补 8/9 |
| 11 | 机器 TL;DR 计数失真 | 改为 21 |

## Oracle 三审（终审）修订记录（2026-09-17）

三审判定：**无生产事故级阻塞**（null 漏选 / DB NOW / veto 误删 / 血缘 / 双写 / 惊群 均已落地字面），仅剩文档自洽问题。已修复：

| # | 三审指出 | 已修复 |
|---|---|---|
| 1 | 矩阵 row4 「Blocks 5,6」却「Can-parallelize 5,6」自相矛盾 | row4 Can-parallel 删 5,6；row7 Blocks 补 8；row8 Depends 补为 `2,4,7` |
| 2 | 矩阵 row16 与 row18 互相 Blocks/parallel 打架 | 16 不再 Blocks 18（16 是展示页、18 是 Tab 挂同一组件，并行无害），删对称边 |
| 3 | 「护栏与建表同发布」只在依赖里暗示、正文无字 | Wave 4 描述补「todo 11 与 19 必须同版本发布」 |
| 4 | `F1` 仍写 13 条（实为 15） | 改为 15 条 |
| 5 | todo 21 缺裁决人与「1 发布周期」定义 | 补「裁决人 = 计划作者；1 周期 = todo 1 独立上线后的下一个版本」 |
| 6 | `F2` 措辞易被误读为禁止 todo 21 选项 (b) | 改为「两个 veto 必须仍在；`lastActivityAt` 去留以 todo 21 裁决为准」 |

**放行后需盯的 2 个非阻塞风险**：
1. PoC 若 P99 > 30s 自动降级 → todo 11 的 `all_idle` 分支只写建议不 wake（已写明，执行时勿漏）
2. 单副本假设（decision 14）——若中途扩副本，`all_idle` 可能误醒，届时走升级触发条件重估
