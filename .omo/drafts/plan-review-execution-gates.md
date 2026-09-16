---
slug: plan-review-execution-gates
status: review
intent: clear
review_required: true
pending-action: review .omo/plans/plan-review-execution-gates.md
approach: 按 31/32/33（含§6）四件套实现协作闭环——P1 回执账本新表+D1 dispatch记账、P2 issue状态锁+去重窗、P3 轮次账本放issue JSON+收敛门、P4 复活plans表做状态机+用户放行门+会话计划Tab；提示词seed补丁随行；单测与实现同todo（tests-after，沿仓库惯例）。
---

# Draft: plan-review-execution-gates

## Review round rr-20260116-01 (high-accuracy dual review)
- phase: complete
- momus: APPROVED (unconditional) | independent-oracle: CHANGES_REQUESTED (7 items, all folded into plan todos + R-R2 notes above)
## Review round rr-20260116-02 (fresh round after plan change)
- phase: complete
- momus: APPROVED | oracle: CHANGES_REQUESTED (7 items folded)
## Review round rr-20260116-03 (fresh round after plan change)
- phase: complete
- momus: APPROVED | oracle: CHANGES_REQUESTED (2 items folded: dedupKey parenthesization, event count +5)
## Review round rr-20260116-04 (fresh round after plan change)
- phase: complete
- round_status: approved
- momus: APPROVED (unconditional) | oracle: APPROVED (unconditional)
- final_live_validation: sha256 8ebf565e92db7b25f1b36a11c84dddee783974d40946c1458356c2c5525048d3 (19470 bytes) matches both receipts
- note: 两轮独立批准（round 1-3 各轮问题均已并入并复审通过）；可交付 $start-work。

# Draft: plan-review-execution-gates

## Components (topology ledger)
| id | outcome | status | evidence path |
| P1-receipt | 派发必有回执账本，回执恰好唤醒派发人一次 | active | server/src/chat/worker-dispatcher.ts:1251(dispatchAgentMention), :1474(dispatchForTeamTarget); server/src/platform-mcp/platform-mcp.service.ts:772(notifyAgent); worker-event.ingress.ts:624(handleTaskCompleted) |
| P2-idempotency | 重复派发被拦，先查后派进PM铁律 | active | server/src/chat/mention-throttle.ts:74; worker-dispatcher.ts:1251; issue状态机 server/src/issues/ |
| P3-rounds | 轮次账本+收敛门，非收敛不修订 | active | server/prisma/seed.ts:1569-1892(plan-review skills); plan-creation 1464-1568 |
| P4-lifecycle | plans表复活做状态机，用户放行门+页面状态 | active | server/prisma/schema.prisma:plans模型（一任务一计划，零读写仅级联删除）; tasks/:id/plan-docs+plan-steps路由; web会话计划Tab; question-modal+主确认链 |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
| 收敛门落点 | 先放PM侧流程函数/定时任务，不建review_rounds表 | 33篇已定两阶段，跑两轮再定表 | 是 |
| 轮次账本存放 | issue内容机器段（JSON） | 33篇已定；不污染schema | 是 |
| 测试策略 | tests-after：实现+扩展单测同todo | 仓库既有spec套件即按此惯例 | 是 |
| 去重窗 | 10分钟，复用message_receipts.dedupKey唯一索引 | 对齐30篇协作规约超时口径 | 是（常量可调） |
| 收敛超时 | 30分钟转人工 | P3设计值 | 是（常量可调） |

## Findings (cited - path:lines)
- notifyAgent返回triggered:boolean+reason（platform-mcp.service.ts:772-789），节流键team:<id>与任务键不冲突（868-874）；groupPost无triggered，走warn。
- dispatchAgentMention双维度（taskId/teamId，worker-dispatcher.ts:1251-1302），ensureTeamSession即建；dispatch返回{replies:[]}无triggered。
- mentionThrottle：pair 3次/60s，task预算20次/120s（mention-throttle.ts:46-49），pairKey无序对共享配额。
- team_view/task_context无回执计数字段（grep receipt零命中），扩展点在teamView.members[]与agentMembers[]。
- plans表零读写（仅teams.service.ts:493级联删除），plan-docs/plan-steps只做文件同步+todo透传，无状态语义。
- question-modal+主确认链完整（托管模式仅主Agent可确认），ask接线缺的只是permission条目（另案，不在本计划）。
- PM/plan/评审提示词源：seed.ts:550-751；plan-review skills种子化于1569-1892；成员回执靠@派发人唤醒（m_437系必达，无@石沉大海）。
- seed无任务创建（tasks靠mock），jest用server下npx jest --runInBand单文件过滤。

## Decisions (with rationale)
- D1: 待回执账本建新表message_receipts（不用issue复用——回执是消息级事件，与工作项状态机正交；沿15篇风格建模）。
- D2: 去重键落同表dedupKey唯一索引（31/32共表，避免双账本漂移）。
- D3: 轮次账本第一阶段不建表（33篇两阶段承诺，验证后再定）。
- D4: 复活plans表做状态机（表与枚举现成且语义正好是draft/reviewing/approved/rejected/executing/completed，无需迁移新表；仅需补round/version列则视账本方案待定——默认先不加列，轮次账本仍走issue JSON）。
- D5: 执行门禁落dispatchAgentMention（读plans.status，非executing拒派执行类；读失败默认放行防误伤新任务——无plan行即无门）。
- D6: 用户确认入口只做页面按钮+POST确认（群聊指令复用PM转译，不单开MCP工具）。

## Scope IN
- P1：message_receipts表+迁移、记账/清账/唤醒一次、超时催办幂等、receipts查询+team_view/task_context计数、chat_history默认limit20+截断标记、成员/PM提示词补丁。
- P2：notify_agent可选issueId、dispatch入口状态锁+去重窗、PM铁律提示词、reason=duplicate返回。
- P3：轮次账本Schema+issue存放、派发词三元组模板、回执版本校验/superseded、收敛门通知、超时转人工、提示词补丁。
- P4：plans状态流转（approved待确认/executing/completed/rejected回draft）+用户确认端点+执行门禁+会话计划Tab状态徽/进度条/确认按钮+checklist聚合读issue。

## Scope OUT (Must NOT have)
- 不建review_rounds表（第二阶段事项）。
- 不改冷评审skill本体与只读纪律。
- 不改任务状态机、群聊分区、throttle限额/窗口。
- 不做ask权限表（另案），不碰mcpDenies/toolAllows。
- 不重写PM派发文风（只加三元组与铁律条目）。

## Open questions
- 无（CLEAR：31/32/33+§6已把outcome定死；可调常量均已按设计值采纳并记录在假设表，可在gate veto）。

## Approval gate
status: approved-and-planned
approach: 见头部approach；先P3轮次账本+提示词（当前任务正好是试验场），再P1+P2联调，最后P4状态机+页面；每件含单测与回归，跑两轮真实评审验证后收尾。
pending-action: none (plan written; handoff awaits start-work)

## Metis resolutions (folded into plan, 2026-09-16)
- R-A1 schema: message_receipts含dedupKey UNIQUE、issueId nullable、nudgeCount/lastNudgedAt/expiresAt、kind、forceReason；单迁移文件。
- R-A2/A6 return: 统一{triggered, reason: ok|duplicate|throttled|plan-gated, origMessageId?}，NOTIFY与内部唤醒同契约；throttle-reject与duplicate-reject reason区分。
- R-A3 ledger exclusion: kind=wake|round-notify不记账（无自回路）；CC=一次派发带抄送名单，不拆多receipt。
- R-A4 rounds: issue JSON带schemaVersion+分隔符；plan↔task↔issue以外键/约定链接；hash由计划员修订落盘钩计算；并发写串行化service方法。
- R-A5 clocks: receipt过期10m/去重窗10m/收敛30m三表并立；pending清零后命中去重窗返回duplicate（无pending即无催办资格，但重派仍拦）。
- R-A6/B4/B5 attribution: task.completed按instance级归因（session→teamMember），@按mentions精确到行；完工清该成员全部pending。
- R-B2 SSE: receipt.acked/expired、round.complete/stale、plan.status.*全定义，走team:/channel:订阅。
- R-B3 throttle: 内部wake/round-notify免除throttle计数（pair/task预算只约束外部派发）。
- R-B6 history: default-20+truncated/total+cursor，无LLM摘要。
- R-B8 confirm: POST /tasks/:id/plan/confirm幂等+confirmedBy审计；打回approved→draft带reason；executing→completed由PM标记端点。
- R-D5 gate: 无plan行→自动建bootstrap行（closed-by-default），仅DB读错fail-open+warn。
- R-R2 Oracle修复轮：守卫窄豁免仅plan-lifecycle.service.ts；加法列confirmedBy/confirmedAt/rejectReason；dedupKey永不NULL规范；kind保留位；issue锁五态精确语义；账本围栏分隔符+hash缺失挂起+SELECT FOR UPDATE串行；分页beforeId+64KB红线；确认端点鉴权任一团队成员、完成端点PM/主实例；真值源DB优先文件。
- R-C scope fences: 不建review_rounds表、不改skill本体/任务状态机/throttle/RBAC、不做分析页、升级只记提示不自动建issue。
