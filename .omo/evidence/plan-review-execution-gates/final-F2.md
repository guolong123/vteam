# F2 — Code Quality Review（plan-review-execution-gates 全增量）

- 范围：`be54c07..886d0b2`（12 todo commits：be54c07 → 54e4937 → 3ec61d8 → f04761e → 69d6c96 → 1fe1a5a → e9c1545 → e9c1545/e504a8e → 6b49ccb → 23fe403 → 6a41be5 → 886d0b2），62 files，+6845/−192。
- 工作区 `git status --porcelain` 有未提交脏树（models/workers/app-shell 等，与本增量无关，评审未触碰、未计入）。
- 方法：8 个新产品文件逐行通读＋ DTO/订阅清单/双迁移通读；修改文件按 hunk 抽查；每新服务 trace 一 happy＋一 error 路径；grep 取证。
- 产品代码零修改（只读评审）；唯一写入为本证据文件。

## 1. 新文件逐文件结论

### server/src/chat/message-receipt.constants.ts（62 行）✅
- `MESSAGE_RECEIPT_STATUSES` / `MESSAGE_RECEIPT_KINDS` 用 `as const`＋字面量联合类型，双库兼容（无 Prisma enum），与 schema 头部约定一致。
- `buildMessageReceiptDedupKey` 括号显式 `issueId ?? sha1(...)`，注释点出 `??` 优先级坑；`normalizeReceiptContent` 去空白取前 64——与 plan todo1 输入规范逐字一致。无 `any`，无 TODO。

### server/src/chat/message-receipts.service.ts（247 行）✅（一观察项见 §4-①）
- Happy：`ack()` pending→acked＋写库后 team:/channel: 双播 `receipt.acked`（`satisfies ReceiptEventPayload` 锁载荷形）。
- Error：非 pending/无行→直接返回（幂等，不写库不广播）；`emitPlanStatusChanged` 无团队归属→warn 跳过（翻转已落库，不阻断）。
- 类型断言均为 `as unknown as {…}` 具名结构，无 `as any`。事件名全部引用 `EVENT_TYPES` 常量，无字符串散落。
- Happy trace：`ack('mr_x')` → findUnique pending → update acked → `emitTeamChannel` → `realtime.broadcast(type, payload, {type:'team',id})`（`broadcast` 为 `emit` 语义别名，realtime.service.ts:167-168，签名吻合）＋ channel 帧（可解析时）。
- Error trace：二次 `ack` 同一 receipt → status≠pending → 原样返回，无二次广播（恰好一次语义成立）。

### server/src/tasks/plan-lifecycle.service.ts（377 行）✅
- Happy：`confirmPlan` approved→executing（`transition` 先 `verifyEnum`，写 confirmedBy/At，清 rejectReason）→系统消息→`receipts.emitPlanStatusChanged`（广播失败 catch＋warn，翻转已落库）。
- Error：错态 `ConflictException`＋精确码（`PLAN_CONFIRM_WRONG_STATE` 等 5 码，`details.current` 带 DB 真值；打回无 reason 400；完工非主实例 403）；`autoEnsureRow` 读错上抛由调用方 warn（tasks.service.ts:498-506 已接住）。
- 守卫禁令：出现 `prisma.plan` 仅本文件（5 处，豁免意图内）；无 `PLAN_STATUS/PLAN_TASK_STATUS/PLAN_ERRORS/planTask` 字面量（grep 见 §3）；`PLAN_LIFECYCLE_*` 中缀隔离＋注释声明意图。干净。
- `as unknown as` 均为具名类型（Plan / `{status}`），无 `as any`。

### server/src/issues/review-round-ledger.ts（385 行）✅
- Happy：`createLedger → mergeLedger（received 按成员覆盖、round/version 只升不降）→ embedLedger（旧机器段整体替换，幂等）→ parseLedger` 往返。
- Error：机器段损坏（无 fenced JSON / JSON 解析失败 / schema 校验失败）→ 抛 `REVIEW_ROUND_CORRUPT`；无机器段→null（非错）。
- `resolveVerdict` 三裁决顺序正确：hash 缺失→`pending-hash`（绝不标 superseded，即使版本也不对）→版本不符→`superseded`→相符→`received` 覆盖。注释与 docs 33 §3.3 对齐。纯函数，无依赖，无 `any`。

### server/src/issues/review-round.service.ts（81 行）✅
- Happy：`applyRoundUpdate` 事务内 `SELECT … FOR UPDATE`（MySQL）→ 无账本建空账本（宿主 issueId 恒写回）→结构合并＋逐条裁决→description 写回。
- Error：宿主 issue 不存在→`NotFoundException(REVIEW_ROUND_ISSUE_NOT_FOUND)`；`$queryRawUnsafe` 缺失（mock/非 MySQL）→catch 退化事务内读-改-写（注释声明）。`RoundUpdate` 解构 `received` 与结构字段分离处理正确。

### server/src/issues/review-round-gate.service.ts（370 行）✅（一观察项见 §4-①）
- Happy：`recordVerdict` 3/3 → `applyRoundUpdate(status=complete)` → `notifyConvergence` 两次 `dispatchAgentMention(kind='wake')`（计划员＋抄 PM，todo4 豁免语义注释清楚）。
- Error：缺版本→只读打回（永不写入，hint 含 exact `待 N/N`）；`requestRevision` 非收敛→throw（message 含 `待 n/N`＋缺席名单）；`checkTimeout` 只置 stale＋三选项（`requiresConfirm:true`，永不调 notifier）；`confirmDegradedRelease` 非 stale/空名单/非法豁免→throw。
- `REVIEW_ROUND_GATE_ERRORS` 复用账本层错误码＋`REVISION_REFUSED/NOT_STALE`，未碰 issues.constants/task machine。`outcomeOf` 按 msgId 回读账本判定三态，逻辑自洽。

### server/src/chat/review-dispatch-triplet.ts（109 行）✅
- Happy：`parseReviewTriplet` 四要素（R<数字>/round、v<数字>、#8hex/hash、expected: 内 ≥1 个 `tmm_`）齐→`ok:true`。
- Error：缺任一→`ok:false + missing[]` 明细；`REVIEW_TRIPLET_HINT` 逐字锁定（注释声明单测全等断言）。
- `ensureRoleViewFooter` 含 footer 原样返回（幂等）。纯函数，无库交互。`VERSION_RE` 取 `v(\d+(\.\d+)?)` 后重拼 `v${…}`，与账本 `v0.3` 口径一致。

### web/src/components/teams/TeamRightPanel.tsx（PlanStatusBlock，+219 行）✅（一观察项见 §4-②）
- 四态徽标映射（draft/reviewing/rejected→灰，approved→琥珀闪烁，executing→蓝，completed→绿）与 plan todo12 文案一致；`data-status` 透出；未知态回退 UNKNOWN。
- Happy：approved＋登录成员→确认按钮→`ConfirmDialog(testid="plan-confirm")` 二次确认→POST confirm→invalidate `["task",taskId,"plan"]`。
- 版本轮次行 `vX·RX·n/N`；进度条＋缺席点名（`待 X、Y 回执`）；executing 清单读 issue 聚合（五态计数）。
- 文件内 `any`（`team: any` 等）沿用本文件既有 `eslint-disable + any` 惯例（该行是 context 未动行，非新增）；`parseRoundLedger` 前端最小镜像校验 `schemaVersion===1/round/expected/received`，损坏静默 null（展示层容错合理）。
- ConfirmDialog `testid="plan-confirm"` 派生 `-modal/-cancel/-confirm`（confirm-dialog.tsx:72），与 testids.ts 新增 4 项逐一对应。

### 附带新文件（全 ✅）
- `tasks/dto/plan-confirm.dto.ts`（action enum＋reason≤512）、`plan-complete.dto.ts`（instanceId 可选）：class-validator＋Swagger 注释齐；语义与 service 对齐。
- `realtime/realtime-subscriptions.ts`：`RECEIPT_ROUND_PLAN_EVENTS`＝4 事件＋`plan.status.*`×6（由 `PLAN_LIFECYCLE_STATUS` 派生，防漂移），session/board 双订阅。
- 双迁移 SQL 见 §5。

## 2. 修改文件抽查结论

- `platform-mcp.service.ts`：`checkIssueDispatchAllowed`（open 放/同人 in_progress 拦＋回显 origMessageId/换人放/终态放/读错 fail-open）、`checkPlanExecutionAllowed`（无行兜底建行、读错 fail-open）、`writeForceAuditReceipt`（写失败 warn 不阻断）、review 三元组 choke（kind=review 缺三元组→`triggered:false/reason='review-triplet'`＋精确 hint；放行嵌入视角 footer；`kind` 归一化未知→wake 安全默认）、`pendingReceipts` 接 `countPending`（taskContext＋teamView 两处）、`chat_history` 分页（默认 20/上限 100 常量命名、64KB 截断、`{items,truncated,total}`）。`DispatchReason` 五值类型与 MCP 描述文案三处同步（含新增 `review-triplet`，todo3 四值→todo8 五值演进有文档，非漂移）。
- `platform-mcp.tools.ts`：`kind/force/forceReason` schema＋`beforeId`＋limit 描述“默认 20”同步。✅
- `worker-dispatcher.ts`：`DispatchExecutionKind`＋`assertPlanExecutionAllowed`（ModuleRef 懒解析避环、fail-open）；自动恢复路径补 `kind:'wake'`。✅
- `tasks.controller.ts`：confirm（`tasks.edit`）/complete（`tasks.review`＋主实例 403）/GET plan（`source:'db'`＋fileDocs displayOnly＋divergence warning）。✅
- `tasks.service.ts`：`autoEnsureRow` hook（失败 warn 不阻断）✅；**但同文件 mainMember 继承 hunk 引入 prod `as any`×3（§4-③）。**
- `mention-throttle.ts`：`THROTTLE_EXEMPT_KINDS`＋`isThrottleExemptKind`，预算四常量零字节改动（注释立禁）。✅
- `event.constants.ts`：10 新事件 dot 命名，`plan.status.*` 与六态一一对应。✅
- `realtime-subscriptions.ts`＋`use-realtime.ts`＋`use-sse.ts`＋scope 单测：前后缀口径一致（`receipt./round./plan.status.`），会话页 team:+channel:+global、看板页 global+team:，缺席即红。✅
- 会话页：5 回调 teamId 守卫＋invalidate（键名问题见 §4-②）；`onOpenIssues` 改 teamId 透传（附带顺手优化，无害）。
- 看板页：receipt./round./plan.status. 前缀失效重取（仅计数联动）。✅
- `seed.ts`：ROLE_BOUNDARIES 文风追加＋铁律条目＋skills 三元组行，均为加法；`seed.spec.ts` 断言同步。✅
- `plan-removal.guard.spec.ts`：窄豁免仅 plan-lifecycle.service.ts，planTask 仍全禁，其余禁令逐字保留。✅
- `testids.ts`：plan-* 9 项新增与 UI/e2e 对齐 ✅；**但同提交 models-manage 段重写引用新 testid，而提交内 models 页无对应 testid（§4-④）。**

## 3. Grep 取证（`be54c07..886d0b2` 新增行）

```
as any（新增行）：仅 3 类——
  ① .omo/evidence/task-2/task-7 JSON 正文字符串（"no `as any` in new code" 等 prose，非代码）
  ② spec 文件：platform-mcp.service.spec.ts:4523 ×1；tasks.service.spec.ts ×6（基线该文件已有 93 处，属仓库既有 mock 惯例）
  ③ 产品代码：server/src/tasks/tasks.service.ts:6727-6728（mainMember hunk，(team as any)×2＋(m: any)×1，commit 54e4937 引入）← §4-③
@ts-ignore/@ts-expect-error/ts-nocheck（新增行）：零命中 ✅
TODO|FIXME|HACK|XXX（新增行）：零命中 ✅
console.log（新增行，server+web 产品路径）：零命中 ✅
console.* / debugger / eslint-disable（新增行，产品路径）：零命中 ✅
禁字面量（新文件）：PLAN_STATUS / PLAN_TASK_STATUS / PLAN_ERRORS / planTask 零命中；prisma.plan 仅 plan-lifecycle.service.ts（豁免意图内）✅
```

## 4. Findings（按严重度）

- ① **【观察/集成缺口·中】无产品调用路径**：`ReviewRoundService.applyRoundUpdate` 除 specs 外仅 issues.module 注册；`ReviewRoundGateService` 同；`MessageReceiptsService.ack / expireDue / emitRoundComplete / emitRoundStale` 无产品调用方（`emitPlanStatusChanged` 经 plan-lifecycle、`countPending` 经 platform-mcp 有调用）。即：轮次写/裁决/收敛通知与回执清账/超时目前只能经单测与（F3）直调演示，群聊 ingest→`recordVerdict` 的生产接线在本增量不存在。按 todos 文（6/7 验收＝单测＋串行化）属预期内分期，但 F3/F4 需明确演示方式（直调服务 vs 补 ingest hook，后者属新需求，不在本评审强求）。
- ② **【小】queryKey 失配**：会话页实时回调 invalidate `["plans", currentTaskId]`（5 处），而 `PlanStatusBlock` 订阅 `["task", taskId, "plan"]`（TanStack 前缀匹配对不上）→ receipt/round/plan 事件不会即时刷徽标，靠 10s 轮询兜底。建议后续小改：统一为 `["task", taskId, "plan"]`（或补 invalidate）。不阻塞（轮询覆盖，最终一致）。
- ③ **【小】产品代码新增 `as any`×3**：tasks.service.ts mainMember hunk（`(team as any)?.mainAgentMemberId` 等）。行为无害、`team` 局部类型弱所致；但违“无 as any 新增”字面标准。注：该 hunk 系叠加上游分支 built-on-top（todo2 证据自述未回退），且同提交新文件零 `as any`。建议：补精确类型（如 `Team & { mainAgentMemberId?: string|null }`）消除；鉴于零行为风险，列为 advisory。
- ④ **【极小/休眠】testids 漂移**：886d0b2 重写 testids.ts models-manage 段（`provider-search` 等），但提交内 models 页无对应 testid（`git show 886d0b2:…/models/page.tsx | grep -c`＝0，匹配实现只在未提交脏树）。已确认提交内 pages.spec.ts 对 `PAGE_SMOKE` 仅 import 未迭代——无执行测试受影响，纯 reference 漂移，待 models 改写提交后自然对齐。记录备查。

## 5. 迁移回滚安全 ✅

- `20260916000000_add_message_receipts`：全新表 CREATE（幂等重复 deploy 无错；i/fk 无—逻辑关联不建 FK，不碰他表）。回滚＝`DROP TABLE message_receipts`（空表/新表，无数据丢失面）。
- `20260916000000_add_plan_confirm_columns`：plans 表纯加三可空列（`confirmed_by/confirmed_at/reject_reason`），存量行全 NULL、读写语义不变，回滚＝DROP COLUMN（审计列，无回填依赖）。
- 仓库无 down-migration 惯例（migrations 目录无 `*down*`；README 回滚口径＝重建卷/`migrate reset`＋备份），双迁移均为加法-only，符合 forward-only 安全要求。
- 模型↔迁移一致性：schema.prisma `MessageReceipt` 17 列/unique dedupKey/双索引/`@@map("message_receipts")` 与迁移 SQL 逐列对齐；`Plan.confirmedBy/confirmedAt/rejectReason` 可空映射对齐（schema:806-820）。

## 6. 命名/注释/错误码一致性 ✅

- 错误码全部命名空间化：`PLAN_LIFECYCLE_ERRORS`（5）、`REVIEW_ROUND_ERRORS`（2）、`REVIEW_ROUND_GATE_ERRORS`（复用＋2）、`DispatchReason`（5 值三处同步）、`TASK_ERRORS.TASK_NOT_FOUND` 复用；wrong-state 一律 409＋`details.current`，reason 必填 400，主实例 403——码位与 plan todo11 约定一致。
- 命名：`mr_/pl_/m_` 前缀、15 篇风格；注释统一中文＋“todo N / 31/33 篇 §x”出处标注；`REVIEW_ROUND_DELIMITER` 服务/前端逐字节一致（含注释互指）。

## Verdict: APPROVE（附 §4 四项 advisories，无 must-fix blocker）

增量命名/注释/错误码一致；新文件零 `as any`/`@ts-ignore`/TODO/console；迁移加法-only 可回滚；守卫窄豁免精确。§4-①为已知分期缺口（F3 明确演示路径即可）、②③为小改建议、④为休眠漂移——均不构成行为缺陷，不阻塞 F3/F4。
