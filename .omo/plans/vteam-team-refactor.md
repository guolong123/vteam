# vteam-team-refactor - Work Plan

## TL;DR (For humans)

**What you'll get:** 将现在的“建任务再选 Agent 建群聊”改为“先建团队（取名+选 Agent 多实例）→ 建任务时指派团队”。同一团队一次只做一个任务（新任务排队等待），群聊按团队复用（任务切换不建新群），默认保留 Agent 记忆、可选“任务完成后开新会话”清空上下文。

**Why this approach:** 新增全局 Team 域承载成员模板，Task 通过 teamId 引用团队并用队列保证串行；ChatChannel 从 taskId 改为 teamId 归属以实现每团队一群；Session 复用由 Team.reuseSession 默认 true + 任务级覆盖控制，兼顾记忆保留与隔离。

**What it will NOT do:** 不支持团队内并发多任务；首版不做项目级团队隔离（全局团队）；不保留存量兼容（允许 breaking 迁移）；不改 Agent 模板本身；不做配额计费。

**Effort:** Large
**Risk:** High - breaking 迁移重塑 Task/ChatChannel/Session 归属与唯一约束，涉及并发队列与前端定位逻辑
**Decisions to sanity-check:** 全局团队而非项目级；排队 FIFO 而非 409 拒绝；每团队一群复用而非每任务一群；记忆开关团队默认+任务覆盖；存量直接改不兼容

Your next move: 批准后由 worker 执行。 Full execution detail follows below.

---

> TL;DR (machine): Large effort, High risk, deliverables: 全局 Team 域+任务串行队列+每团队一群+会话复用开关+前端团队管理与任务指派改造

## Scope
### Must have
- Team 域：全局 Team（id 前缀 `tm_` 锁死）+ TeamMember（id 前缀 `tmm_` 锁死）含 agentId/alias/seq/workDir/role 模板；字段 `name` 全局唯一、`description`、`reuseSession` 默认 true、`currentTaskId`、`createdBy/createdAt/updatedAt`；成员多实例（同 agent 可多行，`uk_team_members_team_agent_seq(teamId,agentId,seq)`）
- Team CRUD API：`POST /teams`、`GET /teams`、`GET /teams/:id`、`PATCH /teams/:id`、`DELETE /teams/:id`（仅空闲可删）、`POST /teams/:id/members`、`PATCH /teams/:id/members/:memberId`、`DELETE /teams/:id/members/:memberId`；全局可见，JwtAuth+PermissionGuard 必需，权限 `teams:view/create/edit/delete`（新增，基于 Role.permissions，不复用 users:view）
- Task 指派团队：`Task.teamId` FK→Team（expand 阶段 nullable 过渡，contract 阶段非空），`CreateTaskDto` 移除 `agents[]/mainAgentId` 仅 `teamId!` 必填；`PATCH /tasks/:id/teamId` 禁止（团队一经指派不可换队，避免历史串扰）
- 串行+排队：Team.currentTaskId + TeamQueue(teamId, taskId, position, enqueuedAt) FIFO；指派事务内以 `FOR UPDATE` 锁 team 行判定，若 Team.currentTaskId 指向活跃任务（pending/in_progress/pending_review），则写入队列返回 `queued`；`TasksService.transition` 的完成路径（accept/archive/reject→回 pending）释放后自动拉起队首（事务内 `currentTaskId = next.taskId` 并触发 start 语义或保持 pending 由用户手动 start）
- 群聊每团队一群：ChatChannel 新增 `teamId` 非空唯一（`uk_channels_team`），`type=team_group` 新值（`task_group` 视为 deprecated 返回 400 `CHANNEL_TYPE_DEPRECATED`），Message 加 `taskId` 分区与 `@@index([taskId,createdAt])`；`ChatService` 频道定位、权限、消息广播改为按 teamId；
- 会话复用：Team.reuseSession 默认 true 时，跨任务复用同一 TeamMember 对应的 Session 行（instanceRef 保留，opencode history 延续）；`Task.resetAfterComplete` 或 Team.reuseSession=false 时，在任务 `accept/archive` 事务内批量对该团队所有成员执行 `resetInstanceSession` 语义（delete+create 新 Session 行，soft-remove TaskGroupInstance）
- 前端：新增 `web/app/(main)/teams/page.tsx`（列表）与 `teams/[id]/page.tsx`（详情/成员管理）及 `teams/new`；改造 `tasks/new/page.tsx` 为“选择团队”下拉（替代 AgentSelectPanel）、`tasks/[id]` 频道定位改为 `GET /channels?teamId` 按 teamId 匹配、展示队列视图与 reuse 开关
- 调研补充：团队名唯一校验、团队删除条件、队列取消/重排、团队记忆索引按 teamId 聚合、Worker 空闲释放策略
- 测试与证据：单测/e2e 全链路，迁移后种子重建

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 团队内并发多任务（FIFO 串行是硬约束，禁止并行分派）
- 项目级团队隔离（首版按用户确认做全局团队，不建 projectId 外键）
- 对 Agent 模板（agents 表）的结构性改动（仅 Team 引用 agentId）
- 存量兼容或双写过渡（用户确认直接改，允许删约束与历史数据）
- 任务创建时同时改团队成员（成员管理仅在团队域，任务侧只选团队）
- 跨团队 @ 或跨团队会话复用（@ 解析仅在团队成员内）
- 配额/计费/审计等运营能力

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + TDD for queue concurrency edge；框架 jest（server）+ Next.js 可用单测，e2e 用现有 `scripts/perf/bench.mjs` SSE 模式扩展
- Evidence: `.omo/evidence/vteam-team-refactor/task-<N>.log` 含单测/e2e 输出与 `curl` 实录；迁移证据为 `prisma migrate` 日志与 `GET /teams`/`GET /channels?teamId` 响应快照

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- Wave 1: Schema & Team domain（Todos 1-4 可并行部分，1 阻塞 2-4）
- Wave 2: Task 指派与队列互斥（Todos 5-7 串行于 Wave1，5 阻塞 6-7）
- Wave 3: 群聊/会话重映射（Todos 8-10 并行，依赖 Wave2 的 teamId 语义）
- Wave 4: 前端团队管理与任务指派改造（Todos 11-14 并行，依赖 Wave1-3 API 契约）
- Wave 5: 收尾、测试、文档（Todos 15-17）

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | - | 2,3,4,5 | - |
| 2 | 1 | 5,11 | 3,4 |
| 3 | 1 | 5,6 | 2,4 |
| 4 | 1 | 8 | 2,3 |
| 5 | 1,2,3 | 6,7,8,11 | - |
| 6 | 5 | 7,9,15 | 8 |
| 7 | 5,6 | 15 | 8 |
| 8 | 1,5 | 9,10,12 | 6,7 |
| 9 | 8 | 10,15 | 6,7 |
| 10 | 8,9 | 15 | - |
| 11 | 2,5 | 12,15 | 3,4 |
| 12 | 8,11 | 15 | 3,4 |
| 13 | 11 | 15 | 8,9 |
| 14 | 11,12 | 15 | 3,4 |
| 15 | 5-14 | 16 | - |
| 16 | 15 | 17 | - |
| 17 | 16 | - | - |

## Todos
- [x] 1. Prisma Schema 新增 Team/TeamMember/TeamQueue 并改造 Task/ChatChannel/Session 归属（expand-contract 可回滚）
  What to do / Must NOT do: 新增 model Team(id String @id 前缀 `tm_`, name String @unique, description String? @db.Text, reuseSession Boolean @default(true), currentTaskId String? @map("current_task_id"), version Int @default(0) @map("version") 乐观锁, createdBy String @map("created_by"), createdAt/updatedAt), TeamMember(id String @id 前缀 `tmm_`, teamId String @map("team_id") FK→Team, agentId String @map("agent_id") FK→Agent, alias String?, seq Int @default(1), workDir String? @map("work_dir"), createdAt) + @@unique([teamId, agentId, seq]), TeamQueue(id String @id 前缀 `tq_`, teamId String @map("team_id") FK→Team, taskId String @unique @map("task_id") FK→Task, position Int, enqueuedAt DateTime @default(now()) @map("enqueued_at")) + @@index([teamId, position]); Task 新增 teamId String? @map("team_id") FK→Team nullable（expand 阶段允许空以兼容存量，contract 阶段改为必填 String 且创建时校验）；保留 projectId；ChatChannel 新增 teamId String? @map("team_id") @unique(uk_channels_team) nullable（Wave1）+ 保留 taskId nullable（过渡），Wave5 再删 taskId 列；Session 新增 teamMemberId String? @map("team_member_id") FK→TeamMember nullable（过渡，与 taskAgentId 双写），最终以 teamMemberId 为主；Message 新增 taskId String? @map("task_id") 去规范化分区 + @@index([taskId,createdAt]) 与 @@index([channelId,taskId])；生成迁移 `migrations/*_team_refactor_expand`（仅加列）与后续 `migrations/*_team_refactor_contract`（改 teamId 为 NOT NULL 并删 taskId）；执行前必须 `mysqldump` 快照并存证据；Must NOT 单步直接删约束导致不可回滚。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 2,3,4,5
  References (executor has NO interview context - be exhaustive): server/prisma/schema.prisma:122-253 (Task/TaskAgent/ChatChannel/Session 现状), server/src/common/id-generator.ts:1-47, server/prisma/migrations/202508*/*_init.sql, docs/agent-platform/15-数据模型细化（ER图）.md:ER 约束, docs/agent-platform/08-平台架构设计.md:双库兼容
  Acceptance criteria (agent-executable): `npx prisma format` 通过；`npx prisma migrate dev --name team_refactor_expand` 生成且 `npx prisma validate` 通过；`npx tsc --noEmit` 通过；`SELECT * FROM teams` 可建空表
  QA scenarios (name the exact tool + invocation): happy: `npx prisma migrate deploy` 在空库可重复执行；failure: 插入重复 team.name 抛唯一约束 P2002；Evidence .omo/evidence/vteam-team-refactor/task-1.log 含 dump 与 migrate 日志
  Commit: Y | feat(prisma): team domain expand-contract migration (add teamId nullable)

- [x] 2. 后端 TeamsModule CRUD（全局团队，含成员多实例与 reuseSession）— 含单测同提交
  What to do / Must NOT do: 新增 `server/src/teams/` 模块（teams.controller.ts, teams.service.ts, dto/create-team.dto.ts, dto/update-team.dto.ts, dto/add-member.dto.ts）；`POST /teams` 校验 name 全局唯一、members[].agentId 存在、seq 事务内 `SELECT MAX(seq) FOR UPDATE`（`$queryRaw` 行锁）防并发重号、alias 缺省 `<角色>-<seq>`、workDir 缺省 `/data/vteam-worker/<sanitize(agent.name)>[-seq]`；`GET /teams` 全局列表（分页+name 搜索，需 JwtAuth + `teams:view/create/edit/delete` 权限）、`GET /teams/:id` 含 members、reuseSession、`currentTaskId`、queue preview；`PATCH /teams/:id` 可改 name/description/reuseSession（name 唯一，version 乐观锁）；`DELETE` 仅当 currentTaskId 为空且 `TeamQueue.count==0` 时允许；成员增删改联动 `team.updatedAt`；广播 `TEAM_CREATED/UPDATED/DELETED`；Must NOT 在团队侧创建 ChatChannel（频道懒创建于首次任务指派）；Must NOT 免鉴权（全局≠开放）。
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5,11
  References: server/src/tasks/tasks.service.ts:196-335 (create 实例 seq/alias/workDir 逻辑可复用), server/src/agents/agents.service.ts:1-80, server/src/common/constants/event.constants.ts:1-30, server/src/auth/jwt-auth.guard.ts:1-40, server/prisma/schema.prisma:Team/TeamMember
  Acceptance criteria: `curl POST /api/v1/teams {name:"vteam开发团队", members:[{agentId:"a_product"},{agentId:"a_developer"}]}` 返回 201 且 members 含 seq/alias；重复 name 返回 409 `TEAM_NAME_EXISTS`；`GET /teams` 可见；单测 `server/src/teams/teams.service.spec.ts` 覆盖创建/重名/多实例/忙删 且 `npm run test --runInBand` 绿
  QA scenarios: happy: 创建含多实例同 agent 两行、alias/workDir 自动生成；failure: name 重复 409、agentId 不存在 404、删除忙团队 409 `TEAM_BUSY`；Evidence .omo/evidence/vteam-team-refactor/task-2.log 含测试绿条
  Commit: Y | feat(teams): global team CRUD with multi-instance members

- [x] 3. IdGenerator 与 Seed 调整（锁定前缀 tm_/tmm_/tq_）
  What to do / Must NOT do: 在 `IdGeneratorService` 注册 `tm_`/`tmm_`/`tq_` 三前缀（锁死，不用 team/teamMember 全写），`onModuleInit` 按 `teams/team_members/team_queues` 最大序号对齐 `seedPrefix("tm_"/"tmm_"/"tq_")`；更新 `server/prisma/seed.ts` 种子：创建 1 个全局示例团队 `vteam开发团队` 含 5 角色各 1 实例供 e2e；Must NOT 为存量任务补数据（直接改，种子仅供新库）。
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5,6
  References: server/src/common/id-generator.ts:1-47, server/prisma/seed.ts:14-50, server/src/tasks/tasks.service.ts:180-188 (seedPrefix)
  Acceptance criteria: `npm run seed` 成功且 `teams` 表有示例团队；`idGen.nextId("tm_")` 递增不冲突
  QA scenarios: happy: 重启后 id 续号；failure: 前缀冲突检测；Evidence .omo/evidence/vteam-team-refactor/task-3.log
  Commit: Y | chore(seed): team id prefixes and global sample team

- [x] 4. Realtime 事件与常量扩展（team 事件）
  What to do / Must NOT do: 在 `server/src/common/constants/event.constants.ts:1-40` 新增 `EVENT_TYPES.TEAM_CREATED/TEAM_UPDATED/TEAM_DELETED/TEAM_QUEUE_CHANGED` 与 `CHANNEL_TYPE.team_group` 新值（锁死，不复用 task_group）；`RealtimeService.broadcast` 的 scope 支持 `type: 'team'` 且 `GET /api/v1/events?scope=team:<id>` 可订阅；SSE 双订阅过渡期兼容 `task:` 与 `team:`；Must NOT 改动现有 SSE 鉴权
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 8
  References: server/src/common/constants/event.constants.ts:1-40, server/src/realtime/realtime.service.ts:1-80, server/src/chat/worker-dispatcher.ts:684-900
  Acceptance criteria: 广播 `team.queue.changed` 可被 `GET /api/v1/events?scope=team:<id>` 订阅收到
  QA scenarios: happy: 创建团队后 SSE 收到 team.created；failure: 非法 scope 不广播；Evidence .omo/evidence/vteam-team-refactor/task-4.log
  Commit: Y | feat(realtime): team channel and queue events

- [x] 5. TasksService 改造：任务创建指派团队 + 串行排队（FIFO，行锁+版本双保险）— 含单测同提交
  What to do / Must NOT do: 改造 `CreateTaskDto` 为 `{title, description, priority, teamId!* 必填, executionMode, managedMode, backgroundDocs, resetAfterComplete?: boolean}` **移除** `agents/mainAgentId`（不保留 deprecated）；`TasksService.create(pid,userId,dto)` 事务内：`SELECT team FOR UPDATE`（`$queryRaw FOR UPDATE`）**且** `Team.version` 乐观锁 CAS（`UPDATE ... WHERE version=?` 重试 3 次）双保险 → 校验 team 存在且调用者为 `task.projectId` 的项目成员（`ProjectMember` 检查，弥补全局团队的权限泄漏）→ 若 `team.currentTaskId` 为空且队首无活跃任务则 `team.currentTaskId = newTaskId` 并 `version+1` 且 `task.status=pending`，否则写入 `TeamQueue(position = MAX(position)+1 FOR UPDATE)` 且 `task.status=queued`；同时为 team 所有 members 创建 TaskAgent 快照行与 Session 行（若 reuseSession=true 则复用已存在 Session 的 instanceRef，否则新建）；Message 写入时带 `taskId` 分区；广播 `TASK_STATUS_CHANGED` 与 `TEAM_QUEUE_CHANGED`；新增 `TasksService.promoteNext(teamId)`；Must NOT 允许任务不带 teamId；Must NOT 无锁并发导致两人同时抢到队首。
  Parallelization: Wave 2 | Blocked by: 1,2,3 | Blocks: 6,7,8,11
  References: server/src/tasks/tasks.service.ts:196-357 (create), server/src/tasks/dto/create-task.dto.ts:51-121, server/prisma/schema.prisma:Task/Team/TeamQueue, server/src/common/constants/task.constants.ts:TASK_STATUS, server/src/common/guards/project-membership.guard.ts:83-116
  Acceptance criteria: `POST /projects/:pid/tasks {teamId}` 当 team 空闲时创建后 `team.currentTaskId` 指向新任务；当 team 忙时新任务入队 `position` 递增且 `GET /teams/:id` queue 可见；并发 2 个 `POST` 同 team 仅 1 个成队首；单测 `tasks.service.spec.ts` 覆盖空闲/忙时/并发 3 分支且绿
  QA scenarios: happy: 连续创建 3 任务，仅首个 pending 其余 queued 且 position 1-2；failure: teamId 不存在 404、teamId 缺失 400、非项目成员 403；Evidence .omo/evidence/vteam-team-refactor/task-5.log 含测试绿条
  Commit: Y | feat(tasks): team assignment with FIFO queue and serial guard

- [x] 6. 任务状态机扩展 queued 与自动拉起（promoteNext，含锁）
  What to do / Must NOT do: 在 `TASK_STATUS` **新增 `queued`**（锁死，不复用 pending）；`transitionOpts` 的 `accept/archive/reject→pending` 的 `afterCommit` 事务内以 `FOR UPDATE` 锁 team 行调用 `promoteNext(teamId)`：若队列有队首则 `team.currentTaskId = next.taskId` 且 `version+1` 并将 next 任务从 `queued→pending`，`TeamQueue` 删除队首行并重排后续 position（或保留但标记已提升）；队列空则 `currentTaskId=null`；广播 `TEAM_QUEUE_CHANGED`；`start` 前置校验：仅当 `taskId === team.currentTaskId` 且 `status===pending` 时允许 `pending→in_progress`；看板筛选需新增 `queued` 过滤；Must NOT 允许非队首任务 start。
  Parallelization: Wave 2 | Blocked by: 5 | Blocks: 7,9,15
  References: server/src/tasks/tasks.service.ts:840-1100 (transitionOpts/start/accept/archive), server/src/common/constants/task.constants.ts:1-40, server/src/common/constants/event.constants.ts:1-30
  Acceptance criteria: 完成当前任务后队首自动成为 currentTaskId，新队首可 start；非队首 start 返回 409 `TEAM_NOT_QUEUE_HEAD`；队列空时 currentTaskId=null
  QA scenarios: happy: 完成→拉起→start 链路；failure: 队首外 start 409、空队列时释放 currentTaskId 为 null；Evidence .omo/evidence/vteam-team-refactor/task-6.log
  Commit: Y | feat(tasks): queued status and auto-promote next

- [x] 7. 会话记忆开关：reuseSession 默认 true + 任务级 resetAfterComplete
  What to do / Must NOT do: Team.reuseSession 默认 true 时，新任务复用各 member 已有 Session 行（不重置 instanceRef/opencode history）；若 Team.reuseSession=false 或 `CreateTaskDto.resetAfterComplete=true`，则在任务 `accept/archive` 事务内对该团队所有 TeamMember 对应的 Session 批量执行 `resetInstanceSession` 语义（`session.deleteMany`+`create` 新 `s_` 行，`TaskGroupInstance` soft-remove），并写入系统消息“已为下一任务开新会话”；提供 `POST /teams/:id/reset-sessions` 手动重置入口；Must NOT 删除 Memory 表（记忆隔离仅通过新 Session 的 history 清空实现）。
  Parallelization: Wave 2 | Blocked by: 5,6 | Blocks: 15
  References: server/src/tasks/tasks.service.ts:790-838 (resetInstanceSession), server/src/workers/session-lifecycle.service.ts:63-156, server/src/chat/worker-dispatcher.ts:1034-1159, server/prisma/schema.prisma:Session/TaskGroupInstance/Memory
  Acceptance criteria: reuse=true 时跨任务 Session.id/instanceRef 保持不变且 `GET /channels/:id/session-history` 可追溯；reuse=false 或勾选后新 Session.id 变更且 history 清空
  QA scenarios: happy: 连续两任务 reuse=true 时第二任务首条 @ 能命中前任务 history 的记忆索引；failure: 归档时重置失败回滚；Evidence .omo/evidence/vteam-team-refactor/task-7.log
  Commit: Y | feat(sessions): reuseSession default true with per-task reset

- [x] 8. ChatService 改造：频道归属 teamId，每团队一群复用 + 消息 taskId 分区 — 含单测同提交
  What to do / Must NOT do: `ChatChannel` 语义改为 `teamId` 非空唯一 `uk_channels_team(teamId)`（Wave1 nullable 过渡，含 `@@index([taskId,createdAt])` 与 `@@index([channelId,taskId])`），新增 `GET /channels?teamId=` 过滤与 `CHANNEL_TYPE.team_group` 新值；`ChatService.findAccessibleChannels(userId, {type, teamId})` 同时支持 `teamId` 与过渡期 `taskId` 双过滤（过渡期 `taskId` 经 `Task.teamId` 映射到 team），最终 `GET /channels?type=task_group` 返回 400 `CHANNEL_TYPE_DEPRECATED`；`createMessage` 的权限改为 `team` 存在性 + 调用者对 `task.projectId` 的成员校验（防全局泄漏）；`buildMainAgentTrigger/resolveMentions` 从 `TeamMember`（`where removedAt=null`）而非 `TaskAgent` 解析；`Message` 写入时带 `taskId` 分区并在跨任务复用时插入 `system: --- Task B started ---` 分隔；新任务不再创建频道（团队首任务时懒创建 `team_group` 频道）；过渡期前端双订阅 `team:` 与 `task:`，验收验证两者；Must NOT 新建 taskId 全表扫描（过渡期双过滤除外）。
  Parallelization: Wave 3 | Blocked by: 1,5 | Blocks: 9,10,12
  References: server/src/chat/chat.service.ts:173-208 (findAccessibleChannels), server/src/chat/chat.service.ts:555-680 (createMessage), server/src/chat/chat.service.ts:864-1000 (resolveMentions/buildMainAgentTrigger), server/prisma/schema.prisma:ChatChannel/Message, server/src/common/constants/event.constants.ts:CHANNEL_TYPE
  Acceptance criteria: `GET /channels?teamId=tm_xxx` 返回唯一 team_group 频道；`POST /channels/:id/messages` 在同一团队的连续两个任务中历史可见且以 taskId 分隔；`GET /channels?type=task_group` 返回 400；单测覆盖 teamId 定位与权限
  QA scenarios: happy: 同团队两任务共用一频道历史且有分隔；failure: 跨团队 @ 400、非法 teamId 404、非成员 403；Evidence .omo/evidence/vteam-team-refactor/task-8.log 含测试绿条
  Commit: Y | feat(chat): team-group channel reuse per team

- [x] 9. WorkerDispatcher 与 SessionLifecycle 适配 teamMember 维度
  What to do / Must NOT do: `WorkerDispatcher.dispatch` 的 `team` 注入从 `TeamMember` + `Agent` 组装 `TeamMemberInfo[]`；`SessionLifecycle.bindSessionToWorker` 保持 `uk_sessions_task_agent` 但上层改为按 `teamMemberId` 维度复用（若 schema 已加 teamMemberId 则按新键，否则按 `TaskAgent` 快照的 teamMemberId 关联）；`dispatchAgentMention` 的 `targetInstanceId` 改为 `teamMemberId`；Must NOT 为每任务重建 TaskGroupInstance（复用时保留）。
  Parallelization: Wave 3 | Blocked by: 8 | Blocks: 10,15
  References: server/src/chat/worker-dispatcher.ts:116-150, 684-1159, server/src/workers/session-lifecycle.service.ts:63-156
  Acceptance criteria: @ 触发时 `buildSystemInstructions` 的 team 段显示团队别名/seq 正确；二次 @ 复用同一 opencode sessionId
  QA scenarios: happy: 同团队跨任务二次 @ 复用 workerId/instanceRef；failure: 离线 worker 自动 unbind 并重分配；Evidence .omo/evidence/vteam-team-refactor/task-9.log
  Commit: Y | feat(worker): dispatcher team member binding

- [x] 10. 私聊与历史：private 频道按 teamMember 维度复用
  What to do / Must NOT do: `POST /dm-channels` 改为 `{teamId, teamMemberId}` 或 `{teamId, agentId}` 解析到 teamMember；private 频道唯一键 `uk_channels_team_member(teamId, teamMemberId)`；`getSessionHistory` 按 team 维度复用 session；Must NOT 为每任务创建私聊（复用）。
  Parallelization: Wave 3 | Blocked by: 8,9 | Blocks: 15
  References: server/src/chat/chat.service.ts:687-759 (createDmChannel), server/src/chat/chat.service.ts:269-328 (getSessionHistory)
  Acceptance criteria: 同一团队的私聊在跨任务后历史保留（reuse=true）或清空（重置）
  QA scenarios: happy: 私聊历史跨任务可见；failure: 非团队成员私聊 400；Evidence .omo/evidence/vteam-team-refactor/task-10.log
  Commit: Y | feat(chat): private channel reuse per team member

- [x] 11. 前端：全局团队管理页（列表/创建/编辑/成员多实例）— 含交互测试同提交
  What to do / Must NOT do: 新增 `web/app/(main)/teams/page.tsx`（GET /teams 列表，全局搜索+分页）、`web/app/(main)/teams/new/page.tsx`（复用 tasks/new 的 AgentSelectPanel/RoleInstanceCard 但提交到 POST /teams，含团队名输入、reuseSession 开关、成员 alias/workDir 编辑）、`web/app/(main)/teams/[id]/page.tsx`（详情+成员增删改、删除按钮仅空闲可点、队列预览、当前任务卡片）；新增 `web/src/api/teams.ts` 封装；Must NOT 在团队页内选任务（仅管理团队模板）。
  Parallelization: Wave 4 | Blocked by: 2,5 | Blocks: 12,15
  References: web/app/(main)/tasks/new/page.tsx:1-100 (AgentSelectPanel/RoleInstanceCard), web/src/components/ui/message-input.tsx, web/app/(main)/messages/page.tsx:1-60
  Acceptance criteria: 可创建“vteam开发团队”并见于列表；成员多实例 alias/workDir 生效；reuse 开关可切；可视回归无样式断裂
  QA scenarios: happy: 创建→列表→详情→增删成员→删除空闲团队；failure: 重名 409 提示、删除忙团队 409 禁止；Evidence .omo/evidence/vteam-team-refactor/task-11.log
  Commit: Y | feat(web): global teams management pages

- [x] 12. 前端：任务创建与详情改为“选择团队”+ 排队与群聊按 teamId — 含交互测试同提交
  What to do / Must NOT do: 改造 `web/app/(main)/tasks/new/page.tsx` 的 handleCreate 为 `POST /projects/:pid/tasks {teamId, resetAfterComplete?}`，移除 agents 选型面板改为团队下拉（GET /teams）+ 选中团队成员预览（只读）+ reset 勾选；改造 `web/app/(main)/tasks/[id]/page.tsx` 的频道定位从 `GET /channels?type=task_group` 按 taskId 扫描（约 1-80 行的 channelsQuery 逻辑，需实探）改为 `GET /channels?teamId`（按 teamId 单例匹配，channelId 复用）、SSE scope 从 `task:` 改为 `team:` 并双订阅过渡期兼容（验收验证 both）、MembersPanel 从 teamMembers 渲染、任务队列卡片展示 `TeamQueue`；Must NOT 新建 taskId 全表扫描（过渡期双订阅除外）。
  Parallelization: Wave 4 | Blocked by: 8,11 | Blocks: 15
  References: web/app/(main)/tasks/new/page.tsx:handleCreate, web/app/(main)/tasks/[id]/page.tsx:1-100 (channelsQuery/channelId 需实探), server/src/chat/chat.service.ts:173-208 (findAccessibleChannels teamId), web/src/api/teams.ts
  Acceptance criteria: 创建任务时下拉选团队成功；忙时创建后显示 queued 位置；群聊在同一团队的任务间历史复用可见
  QA scenarios: happy: 选团队建任务→群聊不新建→第二任务排队→首任务完成→自动拉起队首；failure: 未选团队 400、非队首 start 被禁；Evidence .omo/evidence/vteam-team-refactor/task-12.log
  Commit: Y | feat(web): task creation by team and team-group chat wiring

- [x] 13. 前端：团队队列视图与记忆开关 UX
  What to do / Must NOT do: 在 `web/app/(main)/teams/[id]/page.tsx` 与 `tasks/[id]/page.tsx` 增加队列列表（position/enqueuedAt/taskTitle/status）+ 取消排队按钮（DELETE /teams/:id/queue/:taskId，仅 queued 可取消）+ 记忆开关说明（reuseSession 默认保留，任务级勾选项文案“完成后为下一任务开新会话”）；Must NOT 允许拖拽重排（首版仅 FIFO 展示与取消）。
  Parallelization: Wave 4 | Blocked by: 11 | Blocks: 15
  References: web/app/(main)/teams/[id]/page.tsx, web/app/(main)/tasks/[id]/page.tsx
  Acceptance criteria: 队列中任务可见且可取消；reuse 开关文案清晰
  QA scenarios: happy: 入队→取消→重入队顺序正确；failure: 取消非 queued 409；Evidence .omo/evidence/vteam-team-refactor/task-13.log
  Commit: Y | feat(web): queue view and memory toggle UX

- [x] 14. 导航与权限：全局团队入口与守卫
  What to do / Must NOT do: 在 `web/app/(main)/layout.tsx` 侧边栏新增“团队”入口指向 `/teams`；后端对 `/teams/*` 路由免除 `ProjectMembershipGuard` 仅保留 JwtAuth+PermissionGuard（`teams:*`），`Task` 的 `projectId` 仍保留用于项目归属展示但团队校验不依赖它；更新 Swagger `POST /teams` 等文档（`server/src/swagger-mcp/*`）；Must NOT 让未登录可访问。
  Parallelization: Wave 4 | Blocked by: 11,12 | Blocks: 15
  References: web/app/(main)/layout.tsx, server/src/common/guards/project-membership.guard.ts:38-116, server/src/teams/teams.controller.ts, server/src/swagger-mcp/*
  Acceptance criteria: 未登录访问 /teams 跳登录；已登录可见入口且 Swagger 有 team 分组
  QA scenarios: happy: 侧边栏团队入口导航；failure: 未鉴权 401；Evidence .omo/evidence/vteam-team-refactor/task-14.log
  Commit: Y | feat(web): nav entry and auth guard for global teams

- [x] 15. 单测与集成测试补齐（团队/队列/频道复用/会话复用）— 汇总补充覆盖
  What to do / Must NOT do: 汇总前序 Todos 已含的单测（Todo2 的 teams 基础、Todo5/6 的排队/lock/promote、Todo7 的 reuse/reset、Todo8 的 team_group/权限）并补全遗漏：新增 `server/src/teams/teams.service.spec.ts` 与 `teams.controller.spec.ts` 的边界（并发 seq 重号、version 冲突重试）、扩展 `chat.service.spec.ts` 与 `worker-dispatcher.spec.ts` 的 team 成员 @ 解析与 SSE `team:` scope；Must NOT 将本 Todo 作为唯一测试出口（功能 Todos 已需绿条，本 Todo 仅查漏）。
  Parallelization: Wave 5 | Blocked by: 5-14 | Blocks: 16
  References: server/src/teams/teams.service.spec.ts, server/src/tasks/tasks.service.spec.ts, server/src/chat/chat.service.spec.ts, server/src/chat/worker-dispatcher.spec.ts, server/src/chat/worker-dispatcher.wecom.spec.ts
  Acceptance criteria: `npm run test --runInBand` 全绿；queued/promote/reuse 三分支覆盖率 ≥80%
  QA scenarios: happy: 并发 2 任务同团队的 FIFO 保证；failure: 重名/忙删/非队首 start 均 409；Evidence .omo/evidence/vteam-team-refactor/task-15.log
  Commit: Y | test: team queue and channel reuse coverage (supplement)

- [x] 16. E2E 与性能冒烟（排队+群聊复用+会话复用）
  What to do / Must NOT do: 编写 e2e `test/e2e/team-queue.e2e-spec.ts`：建全局团队→建任务 A（active）→建任务 B（queued）→发团队群聊消息→完成 A→断言 B 自动成为 currentTaskId→群聊历史跨任务可见→reuse 开关切换后历史清空验证；复用 `scripts/perf/bench.mjs` 的 SSE 模式测 `channel:team:<id>` 订阅；Must NOT 依赖存量数据。
  Parallelization: Wave 5 | Blocked by: 15 | Blocks: 17
  References: server/test/*, scripts/perf/bench.mjs:120-260
  Acceptance criteria: e2e 在 fresh DB 上通过；`benchGroupChat` 对 team_group 频道 latency 仍 ≤1000ms
  QA scenarios: happy: 全链路排队拉起与群聊复用；failure: 并发创建队首竞争不丢队；Evidence .omo/evidence/vteam-team-refactor/task-16.log
  Commit: Y | test(e2e): team queue and reuse smoke

- [x] 17. 文档与迁移说明（15 篇 ER 更新与 CHANGELOG）
  What to do / Must NOT do: 更新 `docs/agent-platform/15-数据模型细化（ER图）.md` 新增 Team/TeamMember/TeamQueue 与 ChatChannel.teamId 的 ER；更新 `docs/agent-platform/14-Agent配置与虚拟团队模型.md` §5 为独立 Team 域；新增 `docs/agent-platform/28-团队模型与排队设计.md`（可选）；更新 `README.md` 与 `server/README.md` 的团队概念；记录 breaking 迁移步骤与回滚（重建库）；Must NOT 保留“每任务一群”旧文案。
  Parallelization: Wave 5 | Blocked by: 16 | Blocks: -
  References: docs/agent-platform/15-数据模型细化（ER图）.md, docs/agent-platform/14-Agent配置与虚拟团队模型.md, README.md
  Acceptance criteria: 文档与实现一致，ER 图含 team/queue/channel 关系
  QA scenarios: happy: 文档可渲染；failure: 旧约束文案残留检查；Evidence .omo/evidence/vteam-team-refactor/task-17.log
  Commit: Y | docs: team model and queue design

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
- 每 Todo 独立提交，commit message 遵循 `type(scope): summary`（见各 Todo Commit 行），Wave 内按依赖顺序提交
- breaking 迁移单独一提交 `feat(prisma): team domain...`，便于回滚；随后的 TeamsModule/Task 队列/Chat 重映射各一提交
- 前端团队页与任务指派页各一提交，测试与文档各一提交
- 最终验证波不产生代码提交，仅产出证据与评审记录

## Revision after review (r1 fixes applied)
- Momus r1: 消除 `或/兼容/需明确` 歧义 — 前缀锁 `tm_/tmm_/tq_`、DTO 移除 agents、queued 枚举锁死、channel 锁 `team_group`+400、id-generator/行号/swagger 引用已修正；将测试回填至功能 Todos（2/5/8/11/12 含单测同提交，15 仅作查漏），超大 Todos 已拆粒度说明（Todo2/8/11 各 ≤3 文件内完成）
- Oracle P0: 队列并发加 `FOR UPDATE`/version CAS 重试；全局≠开放—团队可见但任务创建与频道访问仍校验 `task.projectId` 成员；迁移改为 expand-contract（先加 nullable teamId 后删 taskId）+ mysqldump 快照；消息加 taskId 分区与分隔符防污染；Session 重置在 accept/archive 同事务内删建并 soft-remove TaskGroupInstance

## Success criteria
- 可创建全局团队“vteam开发团队”（选 Agent 多实例，reuseSession 默认 true），团队名全局唯一校验生效
- 指派团队建任务：空闲团队直连 pending，忙时新任务入 FIFO 队列且可在团队页/任务页看到排队位置；当前任务完成/归档后队首自动成为 currentTaskId 且可 start，非队首 start 被 409 拒绝；并发双建队首不丢失
- 每团队一群：同一团队的连续任务共享同一 `team_group` 频道历史（以 taskId 分隔），`GET /channels?teamId` 可定位，`GET /channels?type=task_group` 返回 400
- 会话记忆：默认跨任务复用 Session/opencode history（群聊/私聊历史延续），勾选“完成后开新会话”或 team reuse=false 时新任务会话为全新且 history 清空，Memory 表不受影响
- 前端：`/teams` 列表/创建/详情可用，`/tasks/new` 改为选团队，`/tasks/[id]` 按 teamId 展示群聊与队列（含取消排队）
- 测试：新增单测/e2e 全绿，性能冒烟群聊 latency 仍达标（≤1000ms）
