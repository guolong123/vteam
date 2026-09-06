---
slug: vteam-team-refactor
status: reviewing
intent: clear
review_required: true
pending-action: review .omo/plans/vteam-team-refactor.md
approach: 将“任务-群聊 1:1”改造为“团队-任务 N:1 串行 + 团队-群聊 1:1 + 团队-会话 可配置复用”，通过新增 Team 域（队名+成员实例模板）、任务指派团队（teamId 外键+并发互斥）、会话复用开关（reuseSession）落地
plan_path: .omo/plans/vteam-team-refactor.md
plan_sha256: null
review_round_id: r1
review:
  momus:
    status: running
    target: .omo/plans/vteam-team-refactor.md
  independent:
    status: running
    target: .omo/plans/vteam-team-refactor.md
---

# Draft: vteam-team-refactor

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
| id | outcome | status | evidence path |
| --- | --- | --- | --- |
| team-domain | Team 实体及实例模板管理端到端 | active |  |
| task-team-binding | 任务指派团队 + 单团队串行互斥 | active |  |
| chat-session-remap | 群聊/会话从 task→team 归属迁移与复用策略 | active |  |
| web-ux | 前端团队管理+任务创建指派+记忆开关 | active |  |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->
| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| 团队归属 | **全局团队**（用户已确认）— Team 不归属 Project，全员可见，需全局权限检查 | 用户明确选择全局团队，跨项目复用 | 否（已决策） |
| 并发定义 | 活跃= pending/in_progress/pending_review；completed/archived 视为释放 | 对齐任务状态机13篇；仅完成/归档后可接下一个 | 是 |
| 冲突行为 | **排队等待**（用户已确认）— 指派时若团队已有活跃任务则进入队列（FIFO），当前完成后自动拉起下一任务 | 用户明确选择排队而非 409 | 否 |
| 记忆默认 | 团队级 reuseSession 默认 true + 任务级 override（用户已确认：团队开关+任务覆盖） | 满足“默认保留记忆，可选开新 session” | 否 |
| 会话归属 | Session 仍以 TaskAgent 行承载，但 Team 复用时跨任务共享同一 TaskAgent 实例的 Session（新任务复用旧 instanceRef 若 reuse=true）；重置时批量 delete+create 新 Session 行并清空 TaskGroupInstance | 保持 uk_sessions_task_agent 约束，需评审 opencode history 是否跨任务复用 | 需设计评审 |
| 存量迁移 | **不考虑存量兼容，直接改**（用户已确认）— 允许 breaking migration，删除/重建相关约束与历史数据 | 用户明确不需兼容，直接改 | 否 |

## Findings (cited - path:lines)
- server/prisma/schema.prisma:122-162 Task 含 mainAgentId/mainAgentInstanceId, tasks 通过 TaskAgent 实例 + ChatChannel(task_group) + Session 1:1 绑定，每任务新建群聊/会话（tasks.service.ts:196-335 create 事务）
- server/prisma/schema.prisma:165-186 TaskAgent 唯一键 uk_task_agents_task_agent_seq (taskId,agentId,seq)，Session 唯一键 uk_sessions_task_agent (taskId,taskAgentId)（schema:226）
- server/prisma/schema.prisma:234-253 ChatChannel 唯一键 uk_channels_task_agent (taskId,taskAgentId)，task_group 每任务一个、private 每实例一个（chat.service.ts:748-759）
- server/src/tasks/tasks.service.ts:196-357 create() 同事务创建 task + task_group channel + taskAgents + sessions + taskEvent，并广播 TASK_STATUS_CHANGED
- server/src/tasks/tasks.service.ts:555-758 updateTeam() 仅 pending/in_progress 可调团队，新增/移除实例联动 Session frozen 与系统消息
- server/src/chat/chat.service.ts:555-680 createMessage 8步流程：权限→@解析→落库→广播→dispatcher 分派；T8 无@自动路由主实例（buildMainAgentTrigger）
- server/src/workers/session-lifecycle.service.ts:63-156 bindSessionToWorker/unbindSession 管理 Session.workerId/instanceRef + TaskGroupInstance；worker-dispatcher.ts:1034-1159 两阶段 bind(PENDING→opencode sessionId)
- server/src/workers/session-lifecycle.spec.ts / tasks.service.spec.ts / chat.service.spec.ts 现有覆盖点
- web/app/(main)/tasks/new/page.tsx:1-400+ AgentSelectPanel 以 InstancesByRole 多实例选型，无团队概念；tasks/[id]/page.tsx:3073-3082 通过 GET /channels?type=task_group 按 taskId 线性查找频道（1:1 强耦合）
- docs/agent-platform/14-Agent配置与虚拟团队模型.md:5.1-5.3 虚拟团队=任务侧 task_agents 集合，无独立 Team 实体；本文改造为新增独立 Team 域
- docs/agent-platform/15-数据模型细化（ER图）.md / 08-平台架构设计.md 双库兼容与三端架构约束

## Decisions (with rationale)
- 新增 Team + TeamMember 模型而非复用 TaskAgent：Team 为跨任务复用模板（全局级），Task 通过 teamId 引用团队快照；团队成员变更不追溯已完成任务的历史快照
- 任务新增 teamId 外键（全局团队，breaking：非空必填，存量直接重建）+ Team.currentTaskId + TaskQueue（teamId, taskId, position, enqueuedAt）实现串行+排队；指派事务内检查 Team.currentTaskId，若忙则写入队列并返回 queued 状态
- 群聊归属从 taskId 改为 teamId（breaking：ChatChannel.teamId 非空，taskId 置空/移除，每团队一群复用）；消息历史按团队聚合，任务切换不新建频道
- 会话复用由 Team.reuseSession 默认 true + 任务级 resetAfterComplete 覆盖：true 复用同一 TaskAgent 实例的 Session 行（instanceRef 保留，opencode history 延续）；false/任务勾选时在任务 completed/archive 事务内批量 delete+create 新 Session 行并 soft-remove TaskGroupInstance
- 前端拆分：新增 /teams 管理页（创建/编辑/成员管理，全局列表）+ 任务创建页改为“选择团队”替代“选择 Agent”，团队内 alias/workDir/seq 在团队模板管理
- 调研补充点：需补充团队容量/重名校验、团队删除（仅空闲可删）、队列可见与手动重排、团队记忆索引按 teamId 聚合、on-hold 任务的 Worker 释放策略

## Scope IN
- Team 域模型（全局 team + team_members 模板，含 alias/seq/workDir/role 标签）、CRUD API、全局可见权限
- 任务指派团队（teamId 必填）、单团队一次一任务 + FIFO 排队（queued→active 自动拉起）、完成后释放并触发队列
- 群聊从“每任务一群”改为“每团队一群”（ChatChannel.teamId 非空唯一，消息按团队聚合，前端频道定位改为按 teamId）
- 会话记忆开关：团队级 reuseSession 默认 true + 任务级 resetAfterComplete 覆盖，跨任务复用 Session/opencode history
- 前端团队管理页（/teams 全局列表/创建/编辑/成员多实例）+ 任务创建/详情改为“选择团队”（替代选 Agent）+ 队列视图
- 调研补充：团队命名唯一校验、团队删除/归档条件、队列手动调整/取消、团队记忆索引聚合、Worker 空闲释放
- 单测/e2e 更新与证据（breaking migration 需重建种子与测试固件）

## Scope OUT (Must NOT have)
- 团队内并发多任务（刻意禁止，排队仅 FIFO 串行）
- 项目级团队隔离（首版按用户确认做全局团队，已排除）
- 团队成员数量上限以外的配额/计费
- 对 Agent 模板本身的改动（仅团队对 Agent 的引用模板）
- 存量兼容/双写过渡（用户确认直接改，已排除平滑迁移）

## Open questions
- 已全部收敛（用户于 2026-09-01 确认）：Q1=全局团队 / Q2=排队等待（FIFO，活跃=pending/in_progress/pending_review）/ Q3=团队开关+任务覆盖（reuseSession 默认 true，重置=新建 Session 行+清 TaskGroupInstance，Memory 表保留）/ Q4=不考虑存量兼容直接改（breaking）/ Q5=每团队一群（ChatChannel.teamId 复用）

## Approval gate
status: approved
approach: 将“任务-群聊 1:1”改造为“团队-任务 N:1 串行 + 团队-群聊 1:1 + 团队-会话 可配置复用”，通过新增 Team 域（全局队名+成员实例模板）、任务指派团队（teamId 必填+排队互斥）、每团队一群复用、会话复用开关（team 默认 true + task 覆盖）落地；用户已确认全局/排队/团队+任务开关/每团队一群/直接改
approved-at: 2026-09-01
plan_path: .omo/plans/vteam-team-refactor.md
next-action: plan 已写入并经 r1 双审修复，等待执行（/start-work）
review_round_id: r2
review:
  momus:
    status: completed
    result: REJECT (r2) -> FIXED (scope or/ removed, refs fixed, dependency matrix corrected)
    round_id: r2
    recheck: pending r3 if needed
  independent:
    status: completed
    result: NOT APPROVED (r2) -> FIXED (7 edits: lock 且, nullable expand, prefix _, teams:view, dual-lookup, index, validate)
    round_id: r2
  overall: FIXED, awaiting user final confirmation

<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
