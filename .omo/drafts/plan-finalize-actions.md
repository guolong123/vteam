---
slug: plan-finalize-actions
status: awaiting-approval
intent: clear
review_required: true
pending-action: review .omo/plans/plan-finalize-actions.md
approach: 定稿确认后由计划员收敛为带哈希冻结的正式版（旧轮次归档+基线通告），定稿后变更走修订重评小循环；并对计划模式全链门禁做一次松紧审计，只松不紧。
---

# Draft: plan-finalize-actions

## Components (topology ledger)
| id | outcome | status | evidence path |
| C1-consolidate | 定稿动作含冻结版本号+旧账归档+基线通告三件套 | active | server/src/tasks/plan-lifecycle.service.ts:229 finalizePlan; tasks.controller.ts:360 confirm; TeamRightPanel.tsx:592 finalize-btn |
| C2-draft-formal | 草稿与正式计划的存放/效力规则写死（正式版哈希唯一可执行） | active | review-round-ledger fence/superseded语义；plan-docs展示用 |
| C3-gate-audit | 全门禁清单过一遍，只松不紧，输出死锁清单（无死锁即过） | active | worker-dispatcher门禁+a_plan豁免；notify三元组门；throttle；force；toolAllows；bash/edit（此前直查证据） |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
| 正式版载体 | plans表approved行 + 冻结文档版本哈希 | 表是执行门禁唯一真值源，文档是人阅读版 | 是 |
| 变更管制粒度 | 定稿后任何改动重走修订+复评（小循环），无静默修改 | omo计划纪律（改计划即作废旧评审） | 否（用户定的） |
| 审计方向 | 只松不紧：发现过紧就地放宽，不收紧任何现行放行 | 用户原话，避免流程走不通 | 是 |

## Findings (cited - path:lines)
- finalize链完整在位：plan-lifecycle.service.ts:86 verifyEnum / 133 transition / 189 confirmPlan / 229 finalizePlan / 366 postPlanSystemMessage；tasks.controller.ts:360 confirm / 383 complete / 404 getPlan；TeamRightPanel.tsx:562 badge / 592 finalize-btn / 603 confirm-btn / 615 checklist；收敛经dispatchAgentMention kind=wake通知计划员+抄PM。
- 定稿门任务f3532f8已落地（含迁移20260917000000、plan-finalize.spec.ts、33§6、NOTES/asserts证据），新计划在其上做定稿后动作，不重复造门禁。
- 门禁审计lane回空壳，改用此前直查证据：执行门禁（worker-dispatcher + notify双处，a_plan豁免已上线）、issue锁、三元组门、throttle对、force绕过、toolAllows、bash/edit——逐项过松紧。
- omo参照：.omo/drafts/*.md可扔 → 用户批准 → .omo/plans/*.md唯一正本 → 改即重审（本会话rr-01→rr-04实证）。

## Decisions (with rationale)
- D1: 定稿后动作由计划员执行（起草人收敛），不是PM代笔——权责对齐。
- D2: 正式版=DB approved行+文档版本哈希双锚，执行只认哈希版本——防口头版。
- D3: 审计结论只允许“放宽或不动”，任何收紧提 gate 单独批——用户红线。
- D4: 测试策略tests-after沿仓库惯例，单测+行为探针。

## Scope IN
- finalize动作三件套（冻结版本/归档旧轮次/基线通告）+ 定稿后变更小循环规则 + 提示词补丁。
- 草稿vs正式存放效力规则（含哈希唯一可执行）。
- 全门禁松紧审计清单 + 过紧项放宽修复。

## Scope OUT (Must NOT have)
- 不重建定稿门本身（f3532f8已交付）；不改评审轮次/收敛语义；不碰throttle配额/RBAC矩阵；不做分析页。

## Open questions
- 无（CLEAR；可调项已按设计值采纳，上表可否决）。

## Approval gate
status: review
pending-action: review .omo/plans/plan-finalize-actions.md

## Review round rr-20260116-01 (high-accuracy dual review)
- phase: complete
- momus: APPROVED (unconditional) | oracle: CHANGES_REQUESTED (7 items, all folded below)
## Review round rr-20260116-02 (fresh round after plan change)
- phase: complete
- momus: APPROVED (unconditional) | oracle: APPROVED (unconditional, 2 cosmetic notes adopted or bandwidth-noted)
- note: SSe→SSE typo fixed post-approval (zero semantic impact, both reviewers pre-cleared as non-blocking); version-field phrasing left as-is per Oracle bandwidth note (worker clarifies at execution)
- final_live_validation: sha256 ad4fd2d83f6c97202d43a1f55dfa5ba5e5fe4955555e50ea8c804746d404f0bd (11906 bytes) matches both receipts
