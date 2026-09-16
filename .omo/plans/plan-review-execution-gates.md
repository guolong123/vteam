# plan-review-execution-gates - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** 群聊派发不再石沉大海，重复派发会被拦，评审按轮次收敛，计划上线要你点一下确认才会开工——四件事都有账本可查。

**Why this approach:** 三个群聊事故根因都是“靠人记得看”：所以用账本（回执/轮次）代替记忆，用状态机（计划四态）代替口头，用返回码代替感觉。能复用现成的绝不新建（issue锁、plans空表、主确认链）。

**What it will NOT do:** 不建评审独立表，不改评审skill和任务状态机，不碰节流配额和权限矩阵，不做多余分析页。

**Effort:** Large
**Risk:** Medium - 跨notify/dispatch/评审/UI四条链，靠收敛门单测与三事回归剧本锁住
**Decisions to sanity-check:** 轮次账本先放issue JSON（跑两轮再定表）；无计划行自动建行兜底；确认入口只做页面按钮。

Your next move: 在 worker 会话里跑 `$start-work plan-review-execution-gates` 开工，或先跑一次高精度评审。Full execution detail follows below.

---

> TL;DR (machine): Large, Medium, 12 implementation todos + F1-F4 verification for dispatch-receipt/rounds/plan-gate close-loop.

## Scope
### Must have
- P1: message_receipts账本（记账/清账恰好一次唤醒/超时催办幂等/看板计数）+ chat_history默认20+截断标记。
- P2: issue状态锁 + 10分钟去重窗 + reason=duplicate统一返回 + PM先查后派铁律。
- P3: 轮次账本（issue JSON，版本钉定/superseded/并发串行）+ 收敛门（N/N自动通知/超时转人工）+ 派发三元组模板。
- P4: plans表复活（校验枚举+自动建行）+ 用户确认端点（幂等+审计）+ 执行门禁（kind分类）+ 会话计划Tab（状态徽/进度条/确认按钮/checklist）。
- 三方提示词seed补丁（PM铁律/成员@规则/计划员非收敛不修订/评审版本引用）+ 行为探针回归。
### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不建review_rounds表；不改冷评审skill本体、任务状态机、群聊分区、throttle限额/窗口、mcpDenies/toolAllows/RBAC；不做LLM摘要、不做分析页；升级只提示不自动建issue；ask权限表另案。

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + jest (--runInBand, 单文件过滤） + Playwright（计划Tab） + curl+jq（API契约）.
- Evidence: .omo/evidence/ (plan-review-execution-gates/task-<N>/：响应JSON、DB dump、截图、jest输出）。
- 基线：动手前先跑所涉套件记pass数，回归时对比区分。

## Execution strategy
### Parallel execution waves
- Wave 1（契约+账本）：todos 1-5，可并行（不同文件），1先行（表是4/5的前置；2独立不依赖1）。
- Wave 2（轮次+提示词+历史）：todos 6-10，6先行（账本格式是7/8的前置），9/10可并行。
- Wave 3（用户门+UI）：todos 11-12，依赖Wave1（plans表+门禁点）与Wave2（收敛门输出approve）。

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 4,5 | 3 |
| 2 | — | 11 | 3 |
| 3 | — | 4 | 1,2 |
| 4 | 1,3 | 11 | 5 |
| 5 | 1 | — | 4 |
| 6 | — | 7,8 | 9,10 |
| 7 | 6 | — | 8 |
| 8 | 6 | — | 7 |
| 9 | — | — | 6,10 |
| 10 | — | — | 6,9 |
| 11 | 2,4 | 12 | — |
| 12 | 11 | — | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. message_receipts表迁移与模型
  What to do / Must NOT do: 新建Prisma迁移（单文件）+模型：id(mr_)/messageId/fromInstanceId/toInstanceId/taskId nullable/teamId/summary/status(pending|acked|expired)/dedupKey UNIQUE/issueId nullable/nudgeCount default0/lastNudgedAt nullable/expiresAt/kind(dispatch|wake|round-notify，wake/round-notify保留位永不写入，仅防未来误用)/forceReason nullable/createdAt/ackedAt；dedupKey输入规范=`from::to::(issueId ?? sha1(内容去空白后前64字符))`（括号必须显式——`??`优先级低于拼接，不加括号时NULL分支永不生效；永不NULL，MySQL允许多NULL故必须永不NULL）；15篇风格命名；不碰其他表，不建review_rounds表。
  Parallelization: Wave 1 | Blocked by: — | Blocks: 4,5
  References: server/prisma/schema.prisma Message模型(320)/Session模型(252)为范本；docs 31 §3.1；docs 33 §5.5（禁表清单）；dedupKey输入规范=`from::to::(issueId ?? sha1(内容去空白后前64字符))`，永不NULL。
  Acceptance criteria: `npx prisma migrate diff`仅含本表；`npx jest --runInBand src/prisma`通过；dedupKey对NULL-issueId两条不同内容生成不同键（单测断言）。
  QA scenarios: happy-`npx prisma migrate deploy`本地空库成功，evidence .omo/evidence/plan-review-execution-gates/task-1/migrate.log；failure-重复migrate幂等无错。
  Commit: Y | feat(db): message receipts ledger for dispatch pairing
- [x] 2. plans表复活校验与自动建行（含守卫窄豁免）
  What to do / Must NOT do: 先读plan-removal.guard.spec.ts（禁plans模块目录存在、禁plan_* MCP、禁PLAN_STATUS系列常量、禁prisma.plan/planTask读写）与schema.prisma plans枚举；校验枚举确为draft/reviewing/approved/rejected/executing/completed（不符则停下报人，不准猜）；新写server/src/tasks/plan-lifecycle.service.ts为唯一读写choke点（放tasks/下，避开“plans模块目录不存在”断言），并同步窄化守卫单测——仅该文件豁免prisma.plan读写（planTask仍全禁），其余禁令逐字保留；文件中禁止出现PLAN_STATUS/PLAN_TASK_STATUS/PLAN_ERRORS字面量（用字符串字面量或PLAN_LIFECYCLE_STATUS）；加法迁移仅加confirmedBy/confirmedAt/rejectReason三可空列；任务创建成功后调autoEnsureRow（有则跳过、无则建draft；失败只warn不阻断创建）。
  Parallelization: Wave 1 | Blocked by: — | Blocks: 11
  References: server/src/platform-mcp/plan-removal.guard.spec.ts:56-115（逐条对）；server/prisma/schema.prisma:plans模型；server/src/tasks/tasks.service.ts任务创建段；server/src/teams/teams.service.ts:493级联删除（保持，tx.plan不在prisma\.正则内但不得扩散）。
  Acceptance criteria: 守卫单测全绿（含新增豁免断言：仅plan-lifecycle.service.ts可读写plans表）；新任务建后plans行存在且status=draft；已有行不重复建。
  QA scenarios: happy-创建任务→查plans行draft；failure-DB读错→创建仍成功+warn日志；failure-其他文件读写plans表→守卫单测即红，evidence task-2/plans-proof.json。
  Commit: Y | feat(plans): revive plan lifecycle home with narrow guard exemption
- [x] 3. 统一派发返回契约（含notify issueId参数与内部签名）
  What to do / Must NOT do: notifyAgent新增可选issueId参数（缺省返回issueBound:false提醒，不硬拦）并透传；notifyAgent与dispatchAgentMention统一返回{triggered, reason: ok|duplicate|throttled|plan-gated, origMessageId?, messageId?, issueBound}；先用lsp_find_references列出dispatchAgentMention全部调用方再改内部签名（其返回保持void，triggered只在notifyAgent层组装）；groupPost文档注明无triggered；MCP input/output schema同步。不改throttle限额/窗口。
  Parallelization: Wave 1 | Blocked by: — | Blocks: 4
  References: server/src/platform-mcp/platform-mcp.service.ts:772-789(notifyAgent),868-908(throttle+分派),577-609(groupPost)；platform-mcp.tools.ts notify schema；server/src/chat/worker-dispatcher.ts:1203(dispatch),1251(dispatchAgentMention)；mention-throttle.ts:46-49,92。
  Acceptance criteria: 节流返回triggered:false+reason成对出现；成功返回triggered:true；issueId缺省返回issueBound:false；现有notify/dispatch单测全绿。
  QA scenarios: happy-节流触发返回体断言；failure-契约缺字段即红，evidence task-3/contract.json。
  Commit: Y | feat(dispatch): unified triggered/reason return contract
- [x] 4. 执行kind分类与计划门禁（含issue锁精确语义）
  What to do / Must NOT do: notifyAgent/dispatchAgentMention新增kind参数（execution|review|nudge|wake，默认execution；wake/round-notify内部调用传wake且不记账）；kind=execution要求plans.status=executing（无plan行→按todo2建行；DB读错fail-open+warn）；review/nudge/wake豁免；force+reason绕过并审计记forceReason。issue锁精确语义：对照issues.constants五态机——open可派；in_progress同assigneeInstanceId拦、换人放；resolved/closed/rejected视为终态放行新一轮（派发词须注轮次）；assignee比较字段用assigneeInstanceId（实现先读常量核对，字段名不符以实现探查为准并回写文档）。禁：误拦评审/唤醒/催办。
  Parallelization: Wave 1 | Blocked by: 1,3 | Blocks: 11
  References: worker-dispatcher.ts:1251-1302,1474-1519；platform-mcp.service.ts:860-908；message_receipts.kind列(todo1)；issues常量与issue模型（实现时grep定位）。
  Acceptance criteria: approved态派execution被拒并提示计划未放行；review/wake/nudge全放行；force带原因放行且审计有行；issue终态/换人放行矩阵全断言。
  QA scenarios: happy-门禁矩阵（4kind×3状态×issue五态抽样）全断言；failure-DB读错→放行+warn，evidence task-4/gate-matrix.json。
  Commit: Y | feat(gate): execution-kind classifier and plan execution gate
- [x] 5. SSE事件与回执计数扩展
  What to do / Must NOT do: 新增事件receipt.acked/receipt.expired/round.complete/round.stale/plan.status.*（走team:/channel:订阅，订阅者清单写入单测：会话页+看板页，单测断言缺席即红；event.constants.spec.ts长度断言同步——基线17，至少+5（receipt.acked/receipt.expired/round.complete/round.stale+1个plan.status.*），以实际展开数为准并加dot命名断言）；team_view/task_context加pendingReceipts计数；内部wake/round-notify免throttle计数（pair/task预算只约束外部派发，预算常量diff为零，grep断言mention-throttle.ts:46-49未动）。不新增分析页。
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: —
  References: platform-mcp.service.ts:440(taskContext),1883(teamView)；tools.ts:99,423 schemas；realtime事件注册处（grep EVENT_TYPES）；worker-event.ingress.ts:624。
  Acceptance criteria: 事件名载荷有单测；计数查询返回n/N；预算常量diff为零（grep断言）。
  QA scenarios: happy-事件收发断言；failure-预算常量被改即红；failure-突发3评审回执+1唤醒+1轮次通知无丢失（throttle豁免回归），evidence task-5/events.json。
  Commit: Y | feat(realtime): receipt/round/plan events and receipt counts
- [x] 6. 轮次账本格式与并发规则
  What to do / Must NOT do: issue内容机器段分隔符定为`<!-- REVIEW-ROUND-JSON -->`围栏+fenced json（含schemaVersion:1）；plan↔task↔issue链接=派发issue即轮次宿主issue（派发时写回issueId）；hash由计划员修订落盘钩计算（落盘后读文件算sha1前8写回账本；hash缺失时回执挂起pending-hash，不标superseded）；并发写走`applyRoundUpdate`串行化service方法（issues行SELECT FOR UPDATE，MySQL；合并规则：received按成员覆盖、version仅升不降）；同一轮同一人多次回执取最后一次。
  Parallelization: Wave 2 | Blocked by: — | Blocks: 7,8
  References: docs 33 §3.1；seed.ts plan-creation 1464-1568；plan-docs.service.ts落盘路径；issue模型与内容字段。
  Acceptance criteria: Schema示例可校验；并发双写测试无丢失；hash缺失挂起非误标。
  QA scenarios: happy-账本读写往返；failure-并发写串行不断言丢失；failure-hash缺失回执挂起，evidence task-6/ledger.json。
  Commit: Y | feat(rounds): round ledger schema and serialized writes
- [x] 7. 收敛门与超时转人工
  What to do / Must NOT do: received==expected自动通知计划员可修订+抄PM；版本校验（缺版本打回、无关版本标superseded）；30分钟超时转stale并生成待拍板项（等/催办指定人/降级放行三选项，不自动放行）；N-1放行需显式确认调用。
  Parallelization: Wave 2 | Blocked by: 6 | Blocks: —
  References: docs 33 §3.3-§3.4；worker-dispatcher.ts:1251（通知复用）；PM汇总格式m_553体。
  Acceptance criteria: 单份回执Revision请求被拒并提示待N/N；跨版本回执superseded；超时转人工无自动通知计划员。
  QA scenarios: happy-3/3自动通知；failure-2/3修订请求被拒+提示exact文案，evidence task-7/gate.json。
  Commit: Y | feat(rounds): convergence gate and stale adjudication
- [x] 8. 评审派发三元组模板
  What to do / Must NOT do: PM派评审词强制round+planVersion(+hash)+expected名单三元组；缺三元组计划员有权退回；视角边界写入派发（架构方案/开发可执行/测试判据）。
  Parallelization: Wave 2 | Blocked by: 6 | Blocks: —
  References: 群聊派发词m_482/484/486体；seed.ts PM提示词573-592；plan-review skills 1569-1892。
  Acceptance criteria: 缺三元组派发被计划员侧校验拒绝（单测断言提示文案）。
  QA scenarios: happy-三元组齐全放行；failure-缺版本号派发被拒，evidence task-8/dispatch.txt。
  Commit: N（提示词与模板随todo9统一提交）
- [x] 9. 三方提示词seed补丁与行为探针
  What to do / Must NOT do: seed.ts追加（不改写文风，只加条目）：PM先查后派铁律（issue_get+近20条）+被催先报状态+催办引原messageId；成员回执必@派发人；计划员非complete不修订；评审VERDICT必引版本号；优先级表：平台校验>铁律>原文风。行为探针回归（脚本化怎么样了输入不断言新派发；单份回执修订企图被拒）。
  Parallelization: Wave 2 | Blocked by: — | Blocks: —
  References: seed.ts:550-751(PM/plan/成员)，1569-1892(skills)；seed.spec.ts:94,421断言点。
  Acceptance criteria: 渲染后提示词含全部铁律句；seed单测绿；行为探针两条通过。
  QA scenarios: happy-探针通过；failure-删任一条铁律探针即红，evidence task-9/probe.json。
  Commit: Y | feat(prompts): dispatch/receipt/round iron laws with precedence
- [x] 10. chat_history分页契约
  What to do / Must NOT do: 默认limit=20；超长响应{items,truncated:true,total}；cursor用beforeId（messageId游标，倒序翻页）；只做截断标记，不做LLM摘要；响应体超64KB即红线断言；既有调用方回归（默认变更面列出并逐个确认）。
  Parallelization: Wave 2 | Blocked by: — | Blocks: —
  References: chat_history handler（platform-mcp tools/service内grep定位）；chat.service.spec.ts:1353 trigger结果相关；调用方清单grep chat_history。
  Acceptance criteria: 无limit调用返回20条+truncated+total；beforeId第二页取到余量；响应≤64KB；既有单测全绿或同步更新。
  QA scenarios: happy-分页往返；failure-132KB式全量拉取不再出现（断言响应size上限），evidence task-10/paging.json。
  Commit: Y | feat(chat): paged history with truncation marker
- [x] 11. 用户确认端点与状态流转
  What to do / Must NOT do: POST /tasks/:id/plan/confirm（任一团队成员可点；managed主确认链仅作模式参照，不照搬“仅主可点”规则；approved→executing，幂等，记confirmedBy/confirmedAt（todo2加法列），落系统消息，触发PM续推W2）；approved→draft打回带reason（version+1，轮次不变，重走收敛）；executing→completed标记端点PATCH /tasks/:id/plan/complete（PM/主实例鉴权）；wrong-state精确错误码；计划真值源=DB plans.status（文件plan-docs仅展示用，徽标/按钮/checklist一律读DB）。
  Parallelization: Wave 3 | Blocked by: 2,4 | Blocks: 12
  References: tasks.controller.ts路由风格；plans表(todo2)；QuestionsService主确认模式（managed仅主可确认）作鉴权参照；m_553汇总体作通知文案参照。
  Acceptance criteria: 确认翻转一次，二次POST幂等同结果；错态码精确；confirmedBy审计可查；无plan行先建行再确认。
  QA scenarios: happy-全流转draft→approved→executing→completed；failure-重复确认/错态/无权限各有精确错误；failure-文件与DB不一致时以DB为准并告警，evidence task-11/confirm.json。
  Commit: Y | feat(plan): user confirm gate and lifecycle transitions
- [x] 12. 会话计划Tab状态UI
  What to do / Must NOT do: 状态徽（修订中灰/待执行琥珀/执行中蓝/完成绿）+版本轮次（vX·RX·n/N）+轮次进度条（缺席点名）+approved态[确认开始执行]按钮（成员可见，二次确认）+executing checklist（读issue聚合）；testids：plan-status-badge/plan-round-progress/plan-confirm-btn/plan-checklist；Playwright断言+截图。
  Parallelization: Wave 3 | Blocked by: 11 | Blocks: —
  References: web会话页计划Tab（planDocsQuery:226/planStepsQuery:251）；TeamRightPanel徽标模式；question-modal二次确认模式；e2e testids.ts。
  Acceptance criteria: 四态徽标文案色值；按钮仅approved+成员可见；进度条点名缺席者；截图存档。
  QA scenarios: happy-四态截图；failure-非approved无按钮（DOM断言），evidence task-12/*.png + asserts.json。
  Commit: Y | feat(web): plan status badge, progress and confirm button

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit — 逐条核todos 1-12交付物与31/32/33（含§6）对应章节一致，无Scope OUT越界（review_rounds表/skill本体/状态机/throttle/RBAC；唯一允许的守卫改动是plan-lifecycle.service.ts窄豁免），输出合规清单。
- [x] F2. Code quality review — 增量diff审查：命名/注释/错误码一致性，无as any新增，无死代码，迁移可回滚。
- [x] F3. Real manual QA — 用Playwright+curl+jq把验收矩阵跑一遍：回执恰好一次唤醒、去重拦连击、收敛门2/3拒修订、approved执行派发被拦、确认按钮翻转、四态截图；证据归档，零人工点击断言。
- [x] F4. Scope fidelity — 以m_426/m_526/m_446三事为回归剧本重演，确认新机制下分别被接住（唤醒/拦截/拦修订），输出剧本报告。

## Commit strategy
- 每todo独立提交（信息见各todo Commit行），Wave内按依赖顺序；F波只审查不提交。
- 提交前该todo单测+相关回归全绿；快照类变更先验diff再-u。

## Success criteria
- message_receipts表落库，派发-回执-唤醒一次闭环可演示；去重/状态锁拦截可演示；轮次收敛门可演示；用户确认按钮翻转可演示。
- 全部新增/修改单测绿，既有notify/dispatch/issue/chat/history suites基线无回归。
- 三事回归剧本（m_426漏看/m_526重复派/m_446提前修订）全部被新机制接住。
- 文档31/32/33与实现一致（行为漂移处回写文档）。
