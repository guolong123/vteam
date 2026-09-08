# session-unification — Draft

intent: clear
review_required: true（用户 2026-09-07 显式要求高精度双评审）
plan_sha256: parent-has-no-shell（由评审员按 intake contract 自行计算并回显，见 round 字段）
review_round_id: rr-su-20260907-02（首轮 momus APPROVED、oracle CHANGES_REQUESTED 6 项，已全量修复并独立核实三处代码指控）
round_status: approved-both-lanes（rr-su-20260907-02 双路 APPROVED；之后仅修 2 处纯文字：Todo4“归Todo 9”→“归Todo 10”、worker 列表补 9，不涉及归属/顺序/验收变更）
pending-action: handoff presented; ask start-or-high-accuracy (review already done, so handoff only)
review:
  momus: { status: approved, workspace_root: /Users/mac/01work/git-project/vteam, runtime_home: null, target: .omo/plans/session-unification.md, round_id: rr-su-20260907-02, plan_sha256: 5e124595090ecd60d24a9968f29f345d9653e859098c8556b66b13f12a5933c9, launch_id: momus-launch-02, session: ses_f84ecf8c3ffe81PJ9kDJjLLLQV, result: APPROVED }
  independent: { status: approved, workspace_root: /Users/mac/01work/git-project/vteam, runtime_home: null, target: .omo/plans/session-unification.md, round_id: rr-su-20260907-02, plan_sha256: 5e124595090ecd60d24a9968f29f345d9653e859098c8556b66b13f12a5933c9, launch_id: oracle-launch-02, session: ses_f84ecf77bffehNNtppiGJ7tTS0, result: APPROVED }

## Fix log round 1（oracle 6 项 → 修复）
1. message-question.dispatcher:155-174 main 门迁 team → Todo 9（已读原文核实）。
2. memory-index 块归属：Todo 9 唯一主人，Todo 3 只断言（单主人行已更新）。
3. questions 全调用点 + issues 725-749 → Todo 8 枚举（已 grep 核实 taskAgents.findMany）。
4. Todo 6 SQL 顺序钉死 + FK 预检 + chat_channels.taskAgentId 置空（sessions/chat_channels 双 FK Restrict 已核实）。
5. 波次：W2 内 Todo 6 先合再并行 T9/T11；Todo 12（前端）需 Todo 11 新路由；Todo 11 新 handler 落 teams.service/controller。
6. 可执行化：Todo 12 新建 session-unification.spec.ts + 选择器；F3 隔离库 DATABASE_URL 守卫 + 精确命令。
classification: Architecture（横跨 dispatcher/ingress/lifecycle/plans/issues/questions/frontend/schema，7 组件）
status: awaiting-approval
plan_path: .omo/plans/session-unification.md
plan_sha256: null
review_round_id: null
pending-action: write .omo/plans/session-unification.md

> 注：本环境无 shell 执行能力，无法运行 scaffold-plan.mjs；本 draft 为手工按模板结构创建，字段与脚本输出保持一致。

## Decisions（用户已拍板）
1. D1 = 不留 TaskAgent 快照：删 ta_ 域（表/快照会话/引用），保持简单。plans/issues/questions 的 ta_ 指派必须同步迁移到 tmm_。
2. D2 = 保留按任务隔离的工作目录：`tasks/<taskId>/` 由任务数据推导，执行仍落任务目录。
3. D3 = 每成员只有一个 opencode 会话：群聊不绑定会话（平台自维护消息，仅 group_post 落群）；私聊 = 按 teamMember 绑定的 sessionId 去 worker 实时查、直接展示（含上下文前缀块，用户已接受）。
4. 记忆转团队级 / 团队成员门 / tests-after 沿用 remove-project-dimension 既定决策。

## Fork answers（本次拍板）
- Q1 = 不兼容直接改造：删除任务会话代码路径（不留 task/team 双实现并存）；迁移删除存量 task-bound 会话行（执行前 mysqldump 备份）；uk_sessions_task_agent 约束保留冻结（文档注明）。
- Q2 = tests-after（实现+单测一体，agent 实跑 QA 始终包含）。

## Adopted defaults（非 owner 事项，直接采用并记录）
- reset-session 端点语义：按成员重置其团队会话（原按任务实例重置）。
- 任务级会话状态展示坍缩为成员全局状态（后果项，接受）。
- AgentQuestion.taskId NOT NULL 约束：团队路径沿用现有 `''` 空串写法，不动 schema 非空约束。
- plans 表不动（taskId @unique 保留，assignee 换 tmm_ 校验）。
- 测试数据：验证期产生的测试行可直接清理（无需保留测试数据；种子数据仍不得动）。

## Components ledger
| id | outcome | status | evidence |
|----|---------|--------|----------|
| dispatch-converge | 单团队分派入口，任务六要素数据化 | pending | worker-dispatcher.ts:973-1018/1077-1592/1702-2009 |
| session-writes | 快照/重置/回填全走 ensureTeamSession | pending | tasks.service.ts:453/1130/1879, teams.service.ts:819, session-lifecycle.ts:170/289 |
| ingress-finalize | 回流/终态/watchdog 执行键统一 team 域 | pending | worker-event.ingress.ts:465-627/740-857/950-975, dispatcher:2021-2954 |
| ta-refs-migrate | plans/issues/questions 指派迁 tmm_ | pending | plans.service.ts:142-156/333-351, issues.service.ts:131-180, questions.service.ts:260-290/539-548 |
| schema-migrate | 结构性列处理 + 迁移脚本 | pending | schema.prisma:280-281/762/788/832-851 |
| frontend-team-view | 会话状态/重置/session-history 团队化 | pending | session/page.tsx:98-103/242-252/468-497/796-804 |
| seed-tests-docs | 种子/单测/e2e/文档跟进 | pending | seed.ts, *.spec.ts, docs/agent-platform/ |

## Approval gate
status: plan-written-awaiting-handoff-ack.
approach: （见 plan 文件四波；Metis 20 项已全量折入；Q3 已定：记忆 task 级删、托管绑团队、问题按团队路由）。
Metis receipts: session ses_f8500e0e2ffezugugEf2iBmnm7 (20 gaps, all folded: reorder 8→6, waves pinned, single-owners, 7 uncovered paths claimed, compat→new team route, F rows executable).
next workflow action: present handoff, ask start-or-review, stop.
