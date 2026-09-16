# F1 Plan Compliance Audit — plan-review-execution-gates

- Audit date (UTC): 2026-09-16
- Auditor: Sisyphus-Junior (read-only; no product code touched)
- Plan: `.omo/plans/plan-review-execution-gates.md` (todos 1-12 + Scope OUT, 164 lines, all todos `[x]`)
- Docs: `docs/agent-platform/31-派发回执配对机制.md` (76 lines), `32-派发幂等与先查后派机制.md` (60 lines), `33-评审轮次机制.md` (115 lines, incl. §6 计划生命周期与用户放行门)
- Context: `git status --porcelain` shows only pre-existing working-tree modifications + untracked plan/draft files; all 12 plan commits present in log (`3ec61d8/54e4937/be54c07/f04761e/69d6c96/1fe1a5a/e9c1545/e504a8e/6b49ccb/23fe403/6a41be5/886d0b2`). Nothing committed by this audit.
- Method: every claim below cites a file path + line or a captured grep/diff output. No file was modified except this evidence file.

## Per-todo verdicts (deliverable ↔ docs section)

| Todo | Commit | Verdict | Evidence (file:line / output) |
|---|---|---|---|
| 1. message_receipts表迁移与模型 (docs 31 §3.1, docs 33 §5.5禁表清单) | `3ec61d8` | PASS | `server/prisma/migrations/20260916000000_add_message_receipts/migration.sql:2` `CREATE TABLE message_receipts`; `:16` kind default 'dispatch'; `:21` UNIQUE `dedup_key`; `server/src/chat/message-receipt.constants.ts:48` dedupKey=`from::to::(issueId ?? sha1(内容去空白后前64字符))`; `server/prisma/schema.prisma:354` `model MessageReceipt` |
| 2. plans表复活校验+自动建行+守卫窄豁免 (docs 33 §6.1) | `54e4937` | PASS | `server/prisma/schema.prisma:806` `model Plan`, `:813` status注释六态 draft/reviewing/approved/rejected/executing/completed, `:817-820` confirmedBy/confirmedAt/rejectReason加法列, `:827` `@@map("plans")`; `server/src/tasks/plan-lifecycle.service.ts:26` `PLAN_LIFECYCLE_STATUS` (无PLAN_STATUS字面量，本文件grep仅命中PLAN_LIFECYCLE_STATUS); 守卫 `server/src/platform-mcp/plan-removal.guard.spec.ts:90-109` 窄豁免仅`tasks/plan-lifecycle.service.ts`可`prisma.plan`读写且`planTask`全禁 |
| 3. 统一派发返回契约 (docs 32 §3.1, 31 §3) | `be54c07` | PASS | `server/src/platform-mcp/platform-mcp.service.ts:144-149` `{triggered, reason, origMessageId?, messageId, issueBound}`契约注释; `:155-162`类型定义; `:139` reason词汇`plan-gated`; `:674` groupPost注明triggerless无triggered |
| 4. 执行kind分类与计划门禁 (docs 33 §6.2, 32 §3.1) | `f04761e` | PASS | `platform-mcp.service.ts:957-962` kind参数; `:1049` `isThrottleExemptKind(args.kind)`; `server/src/chat/worker-dispatcher.gate.spec.ts` + `platform-mcp.service.gate.spec.ts` (commit stat 189+368行); `task-progression.scheduler.ts:332` 内部调用`kind: 'wake'` |
| 5. SSE事件与回执计数扩展 (docs 31 §3.4) | `69d6c96` | PASS (spec bump为允许项) | `server/src/common/constants/event.constants.ts:37-45` RECEIPT_ACKED/RECEIPT_EXPIRED/ROUND_COMPLETE/ROUND_STALE + 6个`plan.status.*`; `event.constants.spec.ts:41` `toHaveLength(27)` = 基线17+10 ≥ 要求+5; `mention-throttle.ts:46-49` 四预算常量字节未动 (diff仅追加`THROTTLE_EXEMPT_KINDS`豁免); `message-receipts.service.ts` 247行新建 |
| 6. 轮次账本格式与并发规则 (docs 33 §3.1) | `1fe1a5a` | PASS | `server/src/issues/review-round-ledger.ts:52` `REVIEW_ROUND_DELIMITER = '<!-- REVIEW-ROUND-JSON -->'`; `:90` `schemaVersion: 1`; `:46` `ReviewRoundService.applyRoundUpdate`串行化; `:39` `computePlanHash`落盘sha1前8 |
| 7. 收敛门与超时转人工 (docs 33 §3.3-3.4) | `6b49ccb` | PASS | `server/src/issues/review-round-gate.service.ts:35-36` `REVIEW_ROUND_TIMEOUT_MS = 30*60*1000`; `:21` complete自动通知, `:24` 非complete修订拒绝exact`待 N/N`; `:78-107` stale三选项待拍板项 |
| 8. 评审派发三元组模板 (docs 33 §3.2/§3.5) | `23fe403` | PASS (计划注Commit:N但实际独立提交，超额交付不扣分) | `server/src/chat/review-dispatch-triplet.ts:15-16` `REVIEW_TRIPLET_HINT`精确文案; `:19-26` `ROLE_VIEW_BOUNDARIES`+FOOTER三视角边界 |
| 9. 三方提示词seed补丁与行为探针 (docs 31 §3.5, 32 §3.3, 33 §3.6) | `e9c1545` | PASS | `server/prisma/seed.ts:611` 先查后派; `:568/:655/:699/:743` 回执必@派发人; `:786` 非收敛不修订exact`收敛未达成（n/N）…`; `:1666/:1731/:1796` VERDICT必引版本号; `.omo/evidence/plan-review-execution-gates/task-9/probe.json` |
| 10. chat_history分页契约 (docs 31 §3.4/§4.4) | `e504a8e` | PASS | `platform-mcp.service.ts:186-192` 默认20/上限100/硬上限`CHAT_HISTORY_MAX_BYTES = 64*1024`; `:108-111` `{items,truncated,total}`; `:263-264` beforeId倒序翻页; 纯截断标记无LLM摘要 (`:190-192`) |
| 11. 用户确认端点与状态流转 (docs 33 §6.1-6.3) | `6a41be5` | PASS | `server/src/tasks/tasks.controller.ts:352-358` `POST tasks/:id/plan/confirm` (approved→executing幂等+审计+系统消息+W2续推); `dto/plan-confirm.dto.ts`, `dto/plan-complete.dto.ts`新建; 真值源DB plans.status |
| 12. 会话计划Tab状态UI (docs 33 §6.3) | `886d0b2` | PASS | `web/src/components/teams/TeamRightPanel.tsx:546` plan-status-badge, `:560` plan-round-progress, `:576` plan-confirm-btn, `:587` plan-checklist; `web/e2e/reference/testids.ts:215-222`同步; `web/e2e/plan-status.spec.ts` 272行 |

Evidence dirs present for all todos: `.omo/evidence/plan-review-execution-gates/{task-1,…,task-12}` (`ls`确认12个目录齐).

## Scope OUT ban proofs (each with grep output)

- BAN-A 不建review_rounds表: `grep -rn "review_rounds" server/src --include="*.ts" | grep -v ".spec.ts"` → 唯一命中 `server/src/issues/issues.module.ts:21` 注释行“不建 review_rounds 表” (设计意图声明，非建表); `grep "ReviewRound\|review_rounds" server/prisma/schema.prisma` → 零命中; 账本实现为issue JSON (`review-round-ledger.ts:52`)，符合docs 33 §3.1/§5。PASS
- BAN-B 不改冷评审skill本体: `git diff 3ec61d8^..HEAD --stat -- server/src/skills server/src/tools` → 空 (零改动); seed.ts改动73+/20-全为铁律条目追加 (todo9允许项，docs 31 §3.5/32 §3.3/33 §3.6要求)。PASS
- BAN-C 不碰任务状态机: `tasks.service.ts`在计划区间唯一功能增量为`planLifecycle.autoEnsureRow`兜底建行 (fail-open+warn) 与主实例继承; 任务六态流转 (`pending_review→completed→archived`, `tasks.controller.ts:309-345`引13篇§4.4/§4.5) 零改动; `task-progression.scheduler.ts`唯一改动为`kind: 'wake'`传参一行。PASS (注: 54e4937顺带将任务创建mainAgentId/InstanceId由恒null改为继承`team.mainAgentMemberId`，属创建赋值非状态机变迁，不在禁令清单，记为观察项非违规)
- BAN-D 不碰群聊分区: `git diff 3ec61d8^..HEAD --stat -- server/src/chat/chat.service.ts server/src/chat/chat.controller.ts` → 空; `CHANNEL_TYPE.task_group/team_group`定义未动。PASS
- BAN-E 不碰throttle限额/窗口: `mention-throttle.ts:46-49` `DEFAULT_PAIR_MAX=3/WINDOW=60_000/TASK_BUDGET=20/WINDOW=120_000` 四常量diff字节为零 (69d6c96 diff仅追加`THROTTLE_EXEMPT_KINDS=['wake','round-notify']`豁免 —— todo5明确允许); RBAC侧 `git diff … -- server/src/roles server/src/auth server/src/users` → 空; `mcpDenies/toolAllows`所在文件零改动。PASS
- BAN-F 守卫禁令 (PLAN_STATUS/plan_* MCP/updateExecutionMode): `PLAN_STATUS|PLAN_TASK_STATUS|PLAN_ERRORS`在prod唯一命中为`event.constants.ts:40-45`的`PLAN_STATUS_DRAFT…`事件键 — 经`node`实测守卫正则`/\b(PLAN_STATUS|…)\b/`对`PLAN_STATUS_DRAFT`返回false (`_`为词字符，无边界)，守卫语义下不命中，属todo5允许的`plan.status.*`事件 (spec已同步27); `plan_*` MCP工具名grep零命中; `updateExecutionMode`零命中; `prisma.(plan|planTask)`命中全部位于豁免文件`tasks/plan-lifecycle.service.ts:93/103/120/138/142/173`且无`planTask` (与守卫`:94-108`三断言一致)。PASS
- 唯一允许的守卫改动: 计划列明“唯一允许的守卫改动是plan-lifecycle.service.ts窄豁免” — 实际即`plan-removal.guard.spec.ts:92-108`豁免块 + 同文件别处零放宽 + `tasks.service.ts` choke点调用。PASS
- 其它禁令 (LLM摘要/分析页/ask权限表): todo10用纯截断标记 (`CHAT_HISTORY_MAX_BYTES`+`[truncated]`标记行) 无摘要; 无分析页新增 (todo5 web改动仅订阅+计数); 权限表零改动。PASS

## Verdict

**APPROVE** — todos 1-12交付物与docs 31/32/33 (含§6) 逐节对应，12个证据目录齐，全部Scope OUT禁令均有grep/diff零命中证明 (唯一豁免即计划允许的plan-lifecycle窄豁免+事件数spec bump 17→27)。观察项1条 (todo2 commit顺带主实例继承赋值，非状态机变更，不构成违规)。
