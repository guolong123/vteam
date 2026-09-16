## [2026-09-16 14:59 CST] Task: timer-infra

- 交付：通用定时器基础设施（infra only，无真实消费者）。`Timer` 模型（`timers` 表，
  `tmr_` 前缀经共享 `IdGeneratorService`）、`TimerService`（`schedule` / `cancel` /
  `registerHandler` / `fireDue`，方法名锁定供后续消费者编译）、轻量 `setInterval` ticker、
  `TimersModule`（已注册进 `app.module.ts`）。
- 关键协议：claim 用单条原子 `updateMany({ where: { id, status: pending,
  fireAt: { lte: now } }, data: { status: firing } })`，仅 `count === 1` 继续——重叠 tick
  双触发安全；成功→`fired`，handler 抛错→`failed` + `lastError`，无 handler→`failed` +
  `no handler for kind X`（大声暴露缺失消费者）；tick 内逐行 try/catch，循环永不 reject。
- 约定复用：String status/kind + `TIMER_STATUS` 应用层常量（无 Prisma enum）；
  ticker 照抄 `worker-dispatcher.startIdleScan`（`TIMER_SCAN_INTERVAL_MS`，默认 30000，
  `0` 禁用，惰性启动于首次 `schedule()`，`.unref()`，`onModuleDestroy` 清理）；
  `fireDue(now = new Date())` 遵循 wall-clock 参数注入（ticker 传 now，单测传固定值）；
  零新依赖。`message-receipts.service.expireDue` 未动，仅记为消费者任务可用构建块。
- 扩展合同（cron/repeat 后续任务零 infra 改动）：本版 one-shot `fireAt`；重复触发后续经
  新 nullable 列（如 cronExpr / repeatIntervalMs / nextFireAt）+ tasks 域拥有的
  `task_trigger` kind handler 实现；首个消费者 `receipt_nudge` kind 由 chat 域注册。
- dedupKey 必填、格式 `kind:scope:id`（nullable unique 在部分 DB 下破坏幂等，故 NOT NULL
  + UNIQUE）；`lastError` VARCHAR(191)，服务层 slice(0,191) 截断后落库。
- 验证：`npx jest src/timers`（mocked Prisma，无 DB）+ `npx tsc --noEmit` 全绿；
  `prisma generate` 已跑（`prisma.timer` 类型）。迁移 `20260916000001_add_timers`
  为 CREATE TABLE + 索引 ONLY，未验证真实 DB deploy（后续消费者任务如需联调再跑
  `migrate dev/deploy`）。
- [2026-09-16] schedule 并发竞态修复：findUnique-then-create 存在 TOCTOU，双并发同 dedupKey
  后者撞 P2002；现仅包 `create` try/catch，P2002 → 回读胜者行返回（仍 null 则重抛原错），
  幂等承诺在并发下依然成立（`isUniqueViolation` 复用既有 code-check 模式；回归单测覆盖）。

## [2026-09-16 24:00 CST] Task: receipt-nudge-consumer

- 交付：首个真实消费者 `receipt_nudge`。`notify_agent(..., receiptTimeoutMin?)`（tools.ts
  zod `z.number().optional()`，service 归一化兜底）→ execution-kind 真实分派成功后记账
  `message_receipts` 行（`expiresAt = now + timeout`，缺省 10，对齐 seed 10 分钟规则；
  夹取 [1,1440]，非法/NaN/非正 → 缺省永不抛）→ `timers.schedule('receipt_nudge', fireAt=expiresAt,
  payload, dedupKey=receipt_nudge:{teamId}:{receiptId})`。fire 时 handler 重读回执行，
  非 pending 静默 no-op（ack-race 安全）；pending + nudgeCount<1 → 经既有
  `dispatchAgentMention(kind='nudge')` 发一次平台催办（文案引原 messageId/第几次/平台实测
  elapsed 分钟，agent 永不自断言时长）+ `nudgeCount++`；pending + 已催办过 →
  行置 `expired` + 广播 `receipt.expired`（payload 加 `notice: 【自动催办】已自动催办1次仍无回执，
  请升级处理`，dispatcher 见 expired+notice 即升级），且永不排新 timer。
- 注册点选 chat 域（`ReceiptNudgeHandler implements OnModuleInit` 自注册，
  `ChatModule` providers + import `TimersModule`；`PlatformMcpModule` 亦 import
  `TimersModule` 供 schedule 侧注入）。理由：infra 注释（timer.service.ts + schema.prisma）
  均写明首个消费者由 chat 域注册；handler 四依赖（prisma/realtime/receipts/dispatcher）
  全在 ChatModule 内聚，无新环（TimersModule 仅依赖 RealtimeModule）。
- 关键守卫（防回归）：仅 kind=execution 记账排期——worker-dispatcher 注释明定
  review/nudge/wake 永不写账本行，gate 旧单测亦断言三者 `messageReceipt.create`
  未调用；handler 走 dispatchAgentMention 直调（不经 notifyAgent），nudge 自身
  kind=nudge 豁免记账 → 无自激环。记账形状照抄 force-audit 行（id `mr_` 前缀/
  summary 截 100/dedupKey 经 `buildMessageReceiptDedupKey`/kind=dispatch），
  P2002（与 force 行同键/重复派发）→ 回读 pending 行复用排期，非 pending 则
  warn 跳过。排期整体 try/catch warn-only（force-audit 同款 best-effort），
  `TimerService` 以 `@Optional()` 注入（本文件既有 4 处同模式），旧单测零改动。
- 单测坑：`Test.createTestingModule(...).compile()` 不跑 lifecycle，
  注册断言需 `await module.init()` 触发 `onModuleInit`。验证：
  新两套件 + gate/review/plan-hash/receipts/timers + 205 条大 service.spec +
  chat.controller.spec 全绿（296 条），`npx tsc --noEmit` exit 0。
