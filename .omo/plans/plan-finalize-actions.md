# plan-finalize-actions - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** 定稿确认之后自动干三件事（冻结带版本号的正式计划、归档旧账、群里发基线通告），执行时只认冻结版，定稿后再改必须走修订重评小循环，同时把计划模式全部关卡过一遍只松不紧。

**Why this approach:** 定稿最大的坑是“口头定稿”（没有冻结物，执行认的是感觉），所以用哈希冻结版做唯一可执行依据；门禁审计放最后兜底是因为前面已经证明现行放行面基本够用，只查漏不收紧。

**What it will NOT do:** 不重建定稿门和轮次语义，不碰节流配额与权限矩阵，不引入新哈希算法与分析页面。

**Effort:** Medium
**Risk:** Medium - 动执行门禁比对逻辑，靠哈希过期拦截单测与no-tighten检查锁住
**Decisions to sanity-check:** 正式版双锚（DB行+文档哈希）是否过重；修订入口是否覆盖executing/completed态；门禁审计发现过紧时的放宽幅度。

Your next move: 在 worker 会话里跑 `$start-work plan-finalize-actions` 开工，或先跑一次高精度评审。Full execution detail follows below.

---

> TL;DR (machine): Medium, Medium, 6 implementation todos + F1-F4 for post-finalize freeze/archive/notice, hash-gated execution, revise loop, loosen-only audit.

## Scope
### Must have
- 定稿后动作三件套（冻结带哈希正式版、旧轮次归档、基线通告）落在finalizePlan路径上，只增不改。
- 草稿vs正式规则：执行认哈希（门禁比对planVersion.hash），plan-docs无持久化信条加作用域注脚。
- 修订重评小循环：入口矩阵、版本号规则、复评 quorum、force/审计统一口径。
- 全门禁松紧审计：闭合清单逐项loosen-only裁决 + no-tighten机器检查。
- 提示词补丁（计划员收敛契约）+ UI面（冻结版本展示、归档入口）。
### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不重建定稿门（finalizePlan/confirmPlan/transition不动骨架，只做append-only side effect）。
- 不改轮次账本并发语义（SELECT FOR UPDATE、superseded/pending-hash/last-wins原样）。
- 不碰throttle配额/RBAC矩阵/任务状态机；不新增分析页。
- 不引入第三套哈希算法（复用triplet sha1-8；禁止新增）。
- 不在C3审计里收紧任何现行放行（force、a_plan豁免原样；收紧需单独立项）。

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + jest (--runInBand，单文件过滤） + curl+jq（API契约） + Playwright（定稿按钮/徽标）
- Evidence: .omo/evidence/plan-finalize-actions/task-<N>/（响应JSON、DB dump、截图、jest输出）
- 基线：动手前先跑所涉套件记pass数，回归时对比区分。

## Execution strategy
### Parallel execution waves
- Wave 1（先定后建）：todo 1 决策先行（dual-anchor载体+哈希钩+修订入口矩阵+C3闭合清单），2/3 并行跟进。
- Wave 2（收尾）：todos 4-6 可并行（不同文件），5的no-tighten检查依赖4的清单。

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2,3 | — |
| 2 | 1 | — | 3 |
| 3 | 1 | — | 2 |
| 4 | — | — | 5,6 |
| 5 | — | — | 4,6 |
| 6 | — | — | 4,5 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. 锁定dual-anchor载体、哈希钩与修订入口矩阵
  What to do / Must NOT do: 输出三项裁决并落盘到docs/agent-platform/33-评审轮次机制.md §6增补段：正式版=DB approved行+文档版本哈希双锚（哈希算法复用triplet sha1-8，禁止新算法）；哈希计算钩=计划员修订落盘后读文件算sha1前8写回账本，缺失则回执挂pending-hash；修订入口矩阵（approved/rejected可进approved→draft打回带reason，executing/completed增revise动作走小循环，pending_final不可打回）；force维持现状（绕过留审计，不因哈希收紧）；C3闭合门禁清单（逐项：执行门禁/issue锁/三元组门/throttle/force/a_plan豁免/toolAllows/bash-edit）。
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2,3
  References: server/src/tasks/plan-lifecycle.service.ts:86,133,189,229,266,366；server/src/issues/review-round-ledger.ts:10-43,330-369；server/src/issues/review-round-gate.service.ts:103-107,353-397；server/src/platform-mcp/platform-mcp.service.ts:969-972,1085-1134；server/src/chat/worker-dispatcher.ts:1311-1355,1362-1389；docs/agent-platform/33-评审轮次机制.md §6。
  Acceptance criteria: 33§6增补段存在且含dual-anchor定义、钩定义、入口矩阵表、C3清单；无其他章节改动（git diff --stat断言）。
  QA scenarios: happy-文档diff审阅通过；failure-任一裁决缺失即打回重写，Evidence .omo/evidence/plan-finalize-actions/task-1/decisions.md。
  Commit: Y | docs(plan): finalize dual-anchor, hash hook, revise matrix, C3 gate list
- [x] 2. 定稿后三件套：冻结版本、旧轮次归档、基线通告
  What to do / Must NOT do: 在finalizePlan路径上append-only增加：冻结（写plans行frozenVersion+frozenHash+finalizedBy/At，加法迁移，只增列）；哈希计算钩落在writePlanDoc→applyRoundUpdate回填链（禁止“某处自动算好”的悬空假设，接线点写死）；归档（superseded回执保留可查，复用账本归档不另建表）；通告（系统消息走postPlanSystemMessage同通道+SSE事件，内容含版本号/哈希/定稿人）。禁动transition/confirmPlan骨架与守卫豁免。
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: —
  References: server/src/tasks/plan-lifecycle.service.ts:133-182,229-264,366-421；server/prisma/schema.prisma:806-831；server/src/issues/review-round-ledger.ts:322-323,360-369。
  Acceptance criteria: finalize后DB行含frozen版本哈希、旧回执可查、群聊有基线通告行；二次finalize幂等同结果。
  QA scenarios: happy-curl POST confirm action=finalize全断言；failure-并发双finalize只落一行冻结（串行断言），Evidence .omo/evidence/plan-finalize-actions/task-2/freeze.json。
  Commit: Y | feat(plan): post-finalize freeze, archive and baseline notice
- [x] 3. 执行认哈希门禁与plan-docs信条注脚
  What to do / Must NOT do: 执行门禁比对planVersion.hash（不匹配→plan-gated+精确hint，提示期望/实际短哈希）；把plan-docs.service.ts:24-33“vteam不维护任何计划状态”信条改写为作用域版本（agent工作区文件仍是起草真相，冻结正式版以DB+哈希为准——是改写不是加注脚，避免两套真值源打架）；UI徽标旁展示冻结版本短哈希。
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: —
  References: server/src/chat/worker-dispatcher.ts:1362-1389；server/src/platform-mcp/platform-mcp.service.ts:1109-1136（plan-gated门禁实处）；server/src/tasks/plan-docs.service.ts:24-33；TeamRightPanel.tsx:562徽标区。
  Acceptance criteria: 哈希过期执行被拦并提示期望/实际短哈希；信条注脚存在；徽标显示冻结短哈希。
  QA scenarios: happy-匹配放行；failure-过期哈希被拦且hint含两边短哈希，Evidence .omo/evidence/plan-finalize-actions/task-3/gate.json。
  Commit: Y | feat(gate): hash-aware execution gate and docs footnote
- [x] 4. 修订重评小循环（含force口径统一）
  What to do / Must NOT do: 修订入口按todo1矩阵实现（approved→draft打回带reason验version+1轮次不变——version字段即账本planVersion字符串，轮次+1由收敛门开新轮次负责；executing/completed增revise动作：回到draft、version+1、轮次+1重走完整N/N复评，在途执行按门禁存量语义自然收敛，不追杀）；复评quorum=N/N（沿收敛门）；force绕过审计统一记forceReason列（不因哈希新增限制，沿todo1裁决）。
  Parallelization: Wave 2 | Blocked by: — | Blocks: —
  References: server/src/tasks/plan-lifecycle.service.ts:266-299 rejectPlan；review-round-gate.service.ts收敛段；platform-mcp.service.ts:969-972 force段。
  Acceptance criteria: 各入口×动作矩阵全断言；打回version+1轮次不变；force审计行存在。
  QA scenarios: happy-修订→复评→再定稿闭环；failure-非法入口精确码，Evidence .omo/evidence/plan-finalize-actions/task-4/loop.json。
  Commit: Y | feat(plan): revise-and-rereview mini-loop
- [x] 5. 全门禁松紧审计与no-tighten机器检查
  What to do / Must NOT do: 按todo1的C3闭合清单逐项裁决（结论只允许放宽或不动）；新增no-tighten机器检查（枚举门禁单测文件清单+改前改后pass数基线对比，任一放行变拒绝即红）；收紧需求一律记为独立提案不实现。
  Parallelization: Wave 2 | Blocked by: — | Blocks: —
  References: todo1的C3清单；worker-dispatcher门禁段；platform-mcp门禁段；既有门禁单测套件。
  Acceptance criteria: 清单逐项有裁决+证据测试；diff检查绿；无收紧项落地。
  QA scenarios: happy-清单全放宽/不动；failure-任一收紧即红，Evidence .omo/evidence/plan-finalize-actions/task-5/audit.json。
  Commit: Y | test(gate): loosen-only audit with no-tighten check
- [x] 6. 提示词补丁与UI收尾（收敛人+归档入口+版本号展示）
  What to do / Must NOT do: 计划员提示词追加收敛契约（收敛输入=轮次账本+ verdicts明细；输出=冻结候选版+归档清单）；UI加归档入口（读账本superseded）与版本号展示；seed单测同步。
  Parallelization: Wave 2 | Blocked by: — | Blocks: —
  References: server/prisma/seed.ts计划员段；TeamRightPanel.tsx:592,603,615；e2e testids.ts。
  Acceptance criteria: 提示词含收敛契约句；归档入口可点达旧轮次；单测绿；Playwright断言+截图。
  QA scenarios: happy-归档可达/版本可见；failure-缺失即红，Evidence .omo/evidence/plan-finalize-actions/task-6/ui.png。
  Commit: Y | feat(plan): consolidation contract prompts and archive UI

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit — todos与33§6增补一致，无Scope OUT越界（不重建定稿门/轮次语义，不碰throttle/RBAC/配额，不新增哈希算法与分析页），输出合规清单。
- [x] F2. Code quality review — 增量diff命名注释错误码一致，无as any新增，无死代码，迁移只增列。
- [x] F3. Real manual QA — curl定稿三件套+jq断言、哈希过期拦截、修订闭环、门禁审计清单复跑、UI截图；证据归档零人工点击断言。
- [x] F4. Scope fidelity — 以“定稿后改正式计划未走小循环”为回归剧本：直接改approved行旁路被拦或审计留痕，输出剧本报告。

## Commit strategy
- 每todo独立提交（信息见各todo Commit行），Wave内按依赖顺序；F波只审查不提交。
- 提交前该todo单测+相关回归全绿；快照类变更先验diff再-u。

## Success criteria
- 定稿确认后自动产出带哈希冻结版+归档可查+基线通告三件套。
- 执行只认冻结哈希，过期哈希被拦并提示两边短哈希。
- 定稿后变更必走修订重评小循环，直接改正式版被拦或审计。
- 全门禁审计结论只有放宽/不动，无收紧落地。
- 全部新增/修改单测绿，既有定稿门/轮次/门禁套件无回归。
