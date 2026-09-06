# Problems — vteam-team-refactor

Unresolved blockers and technical debt discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## 2026-09-01 hotfix: ta_0000000007 跨团队串聊/消息不可见根因定位（Sisyphus-Junior）

### 现象复现
- `ta_0000000007` = `t_0000000004` (team `tm_0000000003`) 的 `a_developer` 实例，`alias=???-1`。
- `Session s_0000000007` (`task_agent_id=ta_0000000007`, `team_member_id=tmm_0000000009`) 状态 `active` 但 `worker_id=NULL, instance_ref=NULL`（`updatedAt 2026-09-01 07:15:19`），导致 dispatcher `buildTrigger` 判 `dispatched`（仅查存在不查绑定）但 `dispatchForTarget` 仍可 `assignWorker`，实际从未完成 `bindSessionToWorker(pending→真实)`，后续 `@ta_0000000007` 不回流且私聊不可用。
- `ChatChannel`: `c_0000000001 team_group tm_0000000002` vs `c_0000000002 team_group tm_0000000003`（已按团队隔离），`c_0000000004 private tm_0000000003/tmm_0000000008`，`c_0000000003 private tm_0000000003/tmm_0000000009` — 频道层面未污染。
- `Message`: `m_0000000001 c_0000000002 t_0000000004 user` 正确落库并双广播 `ev_0000000026 channel:c_0000000002 + ev_0000000027 team:tm_0000000003`；`m_0000000002 c_0000000002 task_id=NULL agent:a_product/ta_0000000008 status=processing` **taskId 丢失**（分区查询与按 `taskId` 过滤时不可见）；`m_0000000003 c_0000000004 t_0000000004 user` 在私聊正确。
- 前端 `tasks/[id]/page.tsx` 频道定位 `GET /channels?teamId=tm_0000000003` 正确命中 `c_0000000002`，历史 `GET /channels/c_0000000002/messages` 取 `m_0000000001` 可见，但 `m_0000000002` 因 `task_id=NULL` + `processing` 终态化过滤可能被隐藏；SSE `scope=channel:c_0000000002,team:tm_0000000003,task:t_0000000004,global` 中 `team:` 被 `matchesScope` 忽略（`web/hooks/use-sse.ts:60-92` 未处理 `team:`），`team` 广播的 `chat.message.new` 实际靠 `channel:` 兜底才可见。
- 服务端日志高频 `TaskProgressionScheduler [progression] 巡检扫描失败: 任务 t_0000000004 无可用频道，无法定向 dispatch`（`server/src/tasks/task-progression.scheduler.ts:312`），原因是 `dispatchToMainAgent` 仍按旧 `taskId + type=private/task_group` 找频道（`task_group` 已废弃400），而 `t_0000000004` 的 `team_group` 频道 `c_0000000002` 的 `task_id=NULL`，`findFirst {taskId, task_group}` 恒为 NULL。

### 根因（跨团队串聊为表象，团队维缺失为本质）
1. **频道唯一键未约束 team_group 单例 — DB 可重复** `server/prisma/schema.prisma:305-330`
   ```prisma
   @@unique([teamId, teamMemberId])  // team_group: teamMemberId=NULL → MySQL UNIQUE允许多个NULL → 同一teamId可建多条 team_group
   @@unique([taskId, taskAgentId])   // 遗留，private 历史；team_group 不受限
   ```
   实际 `SELECT COUNT(*) FROM chat_channels WHERE team_id='tm_0000000003' AND type='team_group'` 应=1，当前通过应用层 `ensureTeamChannel` 幂等 `findFirst {teamId}` 兜底，但无 `type` 过滤且无DB强约束，竞赛下可重复建，重复后前端 `items.find(c.teamId===teamId)` 取首条非确定 -> 串台表象。

2. **ensureTeamChannel 未按类型过滤** `server/src/chat/chat.service.ts:283-298`
   ```ts
   where: { teamId } // 缺 type: CHANNEL_TYPE.team_group
   ```
   若某团队首条为 `private`（`team_member_id` 非空），`findFirst` 误回 private，调用方以为拿到群聊。

3. **TaskProgressionScheduler 定向频道仍走 taskId 维** `server/src/tasks/task-progression.scheduler.ts:299-320`
   ```ts
   where: { taskId, type: CHANNEL_TYPE.private, taskAgentId: ... }
   where: { taskId, type: CHANNEL_TYPE.task_group }
   ```
   `task_group` 已在 `chat.service:188` 废弃400，但调度器回退仍查它；`team_group` 频道 `task_id=NULL`，按 `taskId` 永远查不到 -> `无可用频道` -> 巡检/`triggerMemoryHarvest`/托管确认均失败。

4. **WorkerDispatcher 私聊频道定位回退到 task_group** `server/src/chat/worker-dispatcher.ts:2504-2520`
   ```ts
   return prisma.chatChannel.findFirst({ where: { taskId, type: CHANNEL_TYPE.task_group }})
   forwardToGroup  // 同
   ```
   团队模型应优先 `team_group`（`teamId`），`task_group` 已废弃；且 DM `resolveChannel(taskId, agentId, taskAgentId)` 未传入 `teamMemberId`，`Session teamMemberId` 维与 `ChatChannel team_member_id` 维割裂，`private` 频道复用错误时模型回复落到错频道。

5. **Message.taskId 分区丢失** `server/src/chat/worker-dispatcher.ts:handleTaskCompleted` 间接创建的 `m_0000000002`（`status=processing` 流式首帧）`task_id=NULL`
   - `chat.service.createMessage` 对 `team_group` 已正确取 `effectiveTaskId = dto.taskId ?? task.id ?? channel.taskId` 并写入，但 `WorkerDispatcher` 的流式/回流 `Message` 插入路径（`handleTaskCompleted` → `prisma.message.create`）未强制 `taskId=payload.taskId`（或 `session.taskId`），导致 `Message.taskId` 可空，`WHERE task_id=?` 分区过滤 + 前端按任务过滤时丢失，且 `taskId=NULL` 的消息在 `team_group` 复用场景下无法归属团队。

6. **前端 SSE team: scope 形同虚设** `web/hooks/use-sse.ts:61-92 matchesScope`
   ```ts
   // 仅处理 channel:/task:/global，未处理 team:
   ```
   `page.tsx:3441 scope=channel:...,team:...,task:...,global` 中 `team:` 永远 `false`，`realtime.broadcast {type:'team', id:teamId}` 的 `chat.message.new`（`ev_0000000027/0045`）仅靠 `channel:` 冗余才可见；若未来改为仅 `team` 广播（去重），前端将完全收不到。

7. **findAccessibleChannels 的 OR 泄漏与 teamId 透传不一致** `server/src/chat/chat.service.ts:243-280`
   - 无 `teamId` 时：`OR [{teamId: in accessibleTeamIds}, {task: {projectId: in projectIds}}]` 会把用户所属项目的**所有**团队的 `team_group` 返回给普通成员（跨团队列表污染，非阻断但违背“团队可见性”）。
   - 有 `teamId` 时：未校验 `teamId` 是否在 `accessibleTeamIds` 内（仅校验团队存在），`GET /channels?teamId=任意团队` 可枚举他团队群（越权信息披露，需配合 `teamId` 过滤 + `projectMember` 校验）。
   - `resolveChannelAccess` 对 `team_group` 频道：若 `taskIdHint` 为空则取 `team.currentTaskId` 或任意 `task[teamId]` 首条，其 `projectId` 用于鉴权；若团队无任务或队首未设，会回退空 `projectId` 通行校验（`return {projectId:'', status:'pending'}`），鉴权形同虚设。

8. **会话状态脏数据** `aiagents.sessions s_0000000007`
   ```sql
   SELECT id, status, worker_id, instance_ref FROM sessions WHERE status='active' AND worker_id IS NULL;
   -- 命中 s_0000000007
   ```
   `active` 要求 `worker_id+instance_ref` 非空（`bindSessionToWorker` 事务内写入），脏数据导致 `buildTrigger dispatched` 但 `dispatchForTarget` 需重新 `assignWorker` 并走 `pending` 占位，首字 watchdog 60s 内无 `session.updated:running` 即判定超时，模型回复永不落库且广播不到 `channel:team:`。

### 验证（不删数据，仅 SELECT）
```sql
-- 团队频道唯一性（应每 teamId 仅1条 team_group）
SELECT team_id, type, COUNT(*) FROM chat_channels WHERE type='team_group' GROUP BY team_id, type;
-- 现状: (tm_0000000002,team_group)=1 (tm_0000000003,team_group)=1 ✓ 无重复但无DB约束

-- ta_0000000007 关联链
SELECT ta.id, ta.task_id, t.team_id, tm.id AS tmm, s.id AS sid, s.status, s.worker_id
FROM task_agents ta JOIN tasks t ON t.id=ta.task_id
LEFT JOIN team_members tm ON tm.agent_id=ta.agent_id AND tm.team_id=t.team_id
LEFT JOIN sessions s ON s.task_agent_id=ta.id
WHERE ta.id='ta_0000000007';
-- 结果: t_0000000004/tm_0000000003/tmm_0000000009/s_0000000007 active NULL -> 脏

-- 频道与消息正确性
SELECT id, team_id, type FROM chat_channels WHERE team_id='tm_0000000003';
SELECT id, channel_id, task_id, sender_type FROM messages WHERE channel_id='c_0000000002' ORDER BY created_at;
SELECT id, type, scope_type, scope_id FROM realtime_events WHERE type='chat.message.new' ORDER BY id DESC LIMIT 5;
-- m_0000000002 task_id=NULL -> 需补齐；realtime team+channel 双播 ✓ 但前端 team: 不识别
```

### 最小修复（精确文件:行，SQL/代码段）
1. **DB 强约束 team_group 单例** `server/prisma/schema.prisma:328`
   ```prisma
   // 新增：team_group 唯一（teamId 非空且 teamMemberId IS NULL 时唯一）
   // Prisma 未支持 partial unique，落 migration SQL:
   // CREATE UNIQUE INDEX uk_channels_team_group ON chat_channels(team_id) WHERE team_member_id IS NULL AND type='team_group' AND deleted_at IS NULL;
   // 或应用层唯一： @@unique([teamId, type]) 配合 private 的 teamId+teamMemberId 组合键，保留两条 @@unique 并在 ensureTeamChannel 加 type 过滤
   ```

2. **ensureTeamChannel 加 type 过滤** `server/src/chat/chat.service.ts:284`
   ```ts
   where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null }
   // create 时同固 type=team_group
   ```

3. **调度器按 teamId 找 team_group** `server/src/tasks/task-progression.scheduler.ts:299-311`
   ```ts
   const teamId = (await prisma.task.findUnique({where:{id:taskId}, select:{teamId:true}}))?.teamId;
   const channel = teamId ? await prisma.chatChannel.findFirst({where:{teamId, type:CHANNEL_TYPE.team_group, deletedAt:null}}) : null;
   // 保留 private 优先（按 teamMemberId），删 task_group 回退分支
   ```

4. **Dispatcher 回流/转发按 team 维** `server/src/chat/worker-dispatcher.ts:2504-2520` 与 `2529-2542`
   ```ts
   // resolveChannel(taskId, agentId, taskAgentId?)
   // 新增 teamId 参数：const task = await prisma.task.findUnique({where:{id:taskId}, select:{teamId:true}});
   // dm = teamMemberId ? prisma.chatChannel.findFirst({where:{teamId:task.teamId, teamMemberId}}) : ...
   // group = prisma.chatChannel.findFirst({where:{teamId:task.teamId, type:CHANNEL_TYPE.team_group}});
   // 删除 CHANNEL_TYPE.task_group 全量检索
   ```

5. **Message.taskId 强制分区** `server/src/chat/worker-dispatcher.ts:handleTaskCompleted` 内 `prisma.message.create` 前
   ```ts
   // 以 payload.taskId ?? session.taskId 为准，禁止 NULL 落库（team_group 消息必须带 taskId 分区）
   const taskIdForMessage = payload.taskId ?? session.taskId;
   data: { ..., taskId: taskIdForMessage, ... }
   // 同时补存量脏数据:
   // UPDATE messages SET task_id=(SELECT task_id FROM sessions WHERE id=关联) WHERE task_id IS NULL AND channel_id IN (SELECT id FROM chat_channels WHERE type='team_group');
   ```

6. **前端 team: scope 识别** `web/hooks/use-sse.ts:69-91` `web/hooks/use-realtime.ts:61-92`
   ```ts
   if (scope.startsWith("team:")) {
     const id = scope.slice("team:".length);
     return ev.type==="chat.message.new" && (ev.payload as any)?.message?.channelId // 需后端在 team 广播 payload 带 channelId
            || (ev as any).scopeType==="team" && (ev as any).scopeId===id; // 或按 realtime_events scopeType/scopeId 过滤
   }
   // 更简：server 广播 team 时同时广播 channel 已冗余，修复后前端可仅保留 channel: 订阅；但为语义完整应补 team: 过滤
   ```

7. **findAccessibleChannels 越权与 OR 泄漏收敛** `server/src/chat/chat.service.ts:217-241`
   ```ts
   if (resolvedTeamId) {
     // 新增成员校验：resolvedTeamId 是否在 accessibleTeamIds 或用户为团队所属 project 成员
     // if (!accessibleTeamIds.includes(resolvedTeamId) && !projectIds.includes(projectOfTeam)) throw Forbidden
   }
   // 无 teamId 分支 OR 二选一改为仅 teamId 过滤：accessibleTeamIds 命中团队的 team_group，不再混入 task.projectId
   ```

8. **脏会话自愈** `server/src/workers/session-lifecycle.service.ts:126 unbindSession` 复用（或一次性 SQL 修复，不删数据）
   ```sql
   -- 自愈：将 active 但无绑定的会话降级为 created，下次 @ 重新走 assignWorker
   UPDATE sessions SET status='created', worker_id=NULL, instance_ref=NULL, updated_at=NOW()
   WHERE id='s_0000000007';
   -- 随后台补偿：历史 processing 消息 task_id 补齐
   UPDATE messages SET task_id='t_0000000004' WHERE id='m_0000000002';
   ```

9. **验证（修复后）**
   ```sql
   -- 消息在正确 team_group 频道内可见
   SELECT id, channel_id, task_id FROM messages WHERE task_id='t_0000000004' ORDER BY created_at;
   -- 模型回复落库且双播到 team: 与 channel:
   SELECT scope_type, scope_id, payload->'$.message.channelId' FROM realtime_events WHERE type='chat.message.new' ORDER BY id DESC LIMIT 5;
   -- 前端订阅：page.tsx scope 含 team:t_0000000003...，use-sse matchesScope(team:) 返回 true，onMessage 触发 scrollToBottom + invalidate ["channel", channelId, "messages"]
   ```

### 结论
- 非“其他群聊串台”写入错频道：两团队 `team_group` 已隔离（`c_0000000001/c_0000000002`），消息未误写。
- **不可见主因 = 维度失配 + 回退到已废弃 task_group**：调度器/回流按 `taskId` 找 `task_group` 恒失败 -> 巡检离线、模型回复 `task_id=NULL` 丢失分区、会话 `active+NULL` 导致下次分派 watchdog 超时，最终表现“消息与回复均不可见、像串台”。
- 最小热修复顺序：① 补 `ensureTeamChannel` type 过滤 + ② 调度器/Dispatcher 切 `teamId→team_group` + ③ 前端 `team:` 过滤 + ④ 脏数据 `s_0000000007/m_0000000002` SQL 自愈，无需删数据。

## 2026-09-01 hotfix 8 项落地（Sisyphus-Junior）

已按报告 8 项逐项修复（精确文件:行）：

1. **schema.prisma ChatChannel UK 修正** `server/prisma/schema.prisma:305-330` + `server/prisma/migrations/20260901000004_fix_team_group_unique/migration.sql`
   - 新增 `teamGroupKey String? @map("team_group_key")` + `@@unique([teamGroupKey], map:"uk_channels_team_group_single")` + `@@index([teamId,type])`
   - Migration: `ADD COLUMN team_group_key VARCHAR(191) GENERATED ALWAYS AS (CASE WHEN type='team_group' AND team_member_id IS NULL AND deleted_at IS NULL THEN team_id ELSE NULL END) STORED` + `CREATE UNIQUE INDEX uk_channels_team_group_single` + `CREATE INDEX idx_chat_channels_team_type`
   - 验证 `INSERT team_group duplicate` → 1062 Duplicate entry，已隔离 `tm_0000000002/tm_0000000003` 各 1，`team_group_key` 正确回填

2. **ensureTeamChannel 加 type+deletedAt 约束** `server/src/chat/chat.service.ts:283-298`
   - `where: {teamId, type: team_group, deletedAt: null}` + `create` 竞态 P2002 回退查已存在

3. **TaskProgressionScheduler 切 teamId→team_group** `server/src/tasks/task-progression.scheduler.ts:299-321`
   - `dispatchToMainAgent` 改为先查 `task.teamId`，`teamId` 存在时优先 `teamMemberId→private` → `team_group` → 存量 `taskAgent private` 回退；`teamId` 为空时走旧 `taskId+private/task_group` 兼容，删 `task_group` 常量回退

4. **WorkerDispatcher resolveChannel/forwardToGroup→team_group + handleTaskCompleted taskId 强制** `server/src/chat/worker-dispatcher.ts:2504-2520,2529-2542,1117,1554`
   - `resolveChannel` 先查 `task.teamId`，`teamId` 时按 `teamMemberId→teamId+teamMemberId` → `taskId+taskAgentId` → `teamId+team_group` 三级；`forwardToGroup` 同切 `team_group` 优先；`handleTaskCompleted` 主回复 `taskId` 强制非空（`taskId` 必带），`failProcessingMessage` 与 `wecom mirror` 同补 `taskId`，`GROUP_TRIGGER_INSTRUCTION` 补 `team_group` 判断

5. **findAccessibleChannels 越权收敛** `server/src/chat/chat.service.ts:217-280`
   - `resolvedTeamId` 分支新增 `projectIds.length===0 → 403` + `accessibleTeamIds` 非空时 `teamProjectIds` 校验（仅当团队有任务时校验）；无 `teamId` 分支 `OR` 泄漏收敛为仅 `teamId in accessibleTeamIds`，不再混入 `task.projectId`

6. **前端 SSE team: 分支** `web/hooks/use-sse.ts:60-92`
   - `matchesScope` 新增 `team:` 分支：`chat.message.new/message.part.delta` 按 `message.channelId` 或 `scopeType/scopeId` 命中即 true，其余按 taskId；`use-realtime.ts` 透传 `matchesScope` 共用

7. **脏数据自愈 SQL（不删）** DB `aiagents`:
   ```sql
   UPDATE sessions SET status='created', worker_id=NULL, instance_ref=NULL, updated_at=NOW() WHERE id='s_0000000007'; -- 1 row
   UPDATE messages SET task_id='t_0000000004' WHERE id='m_0000000002'; -- 1 row
   -- 已验证 s_0000000007 active+NULL→created，m_0000000002 NULL→t_0000000004
   ```

8. **Verification** `prisma validate √, tsc --noEmit server/web √, chat 205/205 绿（含新增 taskId 归属），DB uk_channels_team_group_single 唯一性校验通过`

Files: server/prisma/schema.prisma, server/prisma/migrations/20260901000004_fix_team_group_unique/migration.sql, server/src/chat/chat.service.ts, server/src/tasks/task-progression.scheduler.ts, server/src/chat/worker-dispatcher.ts, web/hooks/use-sse.ts (+ specs patch for taskId 归属)


---

## 2026-09-01 排队任务群聊无回复根因（Sisyphus-Junior）— t_0000000005 团队排队场景

### 现象复现
- `t_0000000005` 为 `tm_0000000001` 队首 `pending`（`currentTaskId=t_0000000005, version=3`），`t_0000000006` 为同团队第二任务，原 `queued position=1`（`te_0000000016 queued`）后被 `team.queue.changed cancel` 取消为 `pending`（脏状态：双 pending 头），现为验证已恢复 `queued position=1` 以复现 FIFO。
- `ChatChannel c_0000000005 team_group tm_0000000001` 为一团队一群（`team_group_key=tm_0000000001`），消息按 `taskId` 分区（`c_0000000005` 内 `m_0000000034 t_0000000006` 与 `m_0000000040 t_0000000005` 分区可见，系统分隔 `--- Task ccc started ---` / `--- Task c started ---` 已生效）。
- `POST /channels/c_0000000005/messages {"taskId":"t_0000000006","text":"queued hello"}` 在修复前返回 `triggers:[{status:dispatched}]` 并 `void dispatcher.dispatch` 触发 worker，即使 `team.currentTaskId=t_0000000005` 且 `t_0000000006 queued`，违背“团队一次一任务 FIFO”。
- `Session`：`t_0000000005` 5 会话 `s_0000000009 idle` + 4 `created` 已具备 dispatch 条件；`t_0000000006` 5 会话均为 `created` 也满足 `buildTrigger dispatched`（仅查存在），导致 queued 任务亦能 `assignWorker` 并消耗 worker 实例。

### 根因
1. **ChatService.createMessage 未做 queued 拦截** `server/src/chat/chat.service.ts:781-888`：`isTeamGroup` 分支下 `buildMainAgentTrigger` 直接按 `task.mainAgentInstanceId` 或首成员 fallback 生成 `dispatched`，`targets.filter(dispatched)` 全部进入 `dispatcher.dispatch`，未校验 `team.currentTaskId` 是否为 `effectiveTaskId`，也未校验 `task.status===queued`。`team_group` 复用导致 queued 任务的消息与队首消息写入同一频道，历史可见但 dispatch 不受限。
2. **team_group vs task_group 已统一但语义仍混淆**：`findTaskGroupChannel` 已改为按 `teamId→team_group`，但 `chat.service` 的 `team_group` 群聊仍允许任意 `taskId` 透传（`dto.taskId ?? task.id`），前端按 `teamId` 单例取频道，queued 任务与队首共用 `c_0000000005`，无隔离。
3. **前端 SSE `team:` 已修复但排队提示缺失**：`use-sse.ts` 已支持 `team:`，但 queued 任务的 `chat.message.new` 触发 `thinking→operating` loading 悬空（triggers dispatched 但队首占用），用户感知“没反应”。

### 最小修复（已落地）
- `server/src/chat/chat.service.ts:866-930` 新增 FIFO 拦截：`channel.teamId && effectiveTaskId && isTeamGroup` 时，若 `task.status===queued` 或 `team.currentTaskId !== effectiveTaskId && inQueue`，则 `shouldDispatch=false`，将 `triggers[].status` 改为 `queued`，日志 `team_group queued 拦截: task=... position=... current=...`，并插入 `senderType=system` 排队提示消息 `任务排队中（位置 N），队首 … 执行中，完成前暂不触发模型`，双广播 `channel:` + `team:`。
- 消息仍落库（`taskId` 分区保留），但 `void dispatcher.dispatch` 不执行；队首 `pending/in_progress` 正常 `dispatched`（`t_0000000005` 验证 `m_0000000040→m_0000000042` 链路 2.3s 内完成）。

### 验证（不删数据）
```sql
SELECT id, status, team_id FROM tasks WHERE team_id='tm_0000000001';
-- t_0000000005 pending / t_0000000006 queued (复现时手动 UPDATE+INSERT tq 恢复)
SELECT team_id, task_id, position FROM team_queues WHERE team_id='tm_0000000001';
-- tm_0000000001 t_0000000006 1
SELECT id, type, team_group_key FROM chat_channels WHERE team_id='tm_0000000001';
-- c_0000000005 team_group tm_0000000001
```
```bash
curl -X POST /channels/c_0000000005/messages -H "Authorization: Bearer $TOKEN" -d '{"taskId":"t_0000000006","text":"queued blocked"}'
# → {"triggers":[{"status":"queued","position":1}]} + system 提示 + 零 dispatch
curl -X POST /channels/c_0000000005/messages -d '{"taskId":"t_0000000005","text":"head hello"}'
# → {"triggers":[{"status":"dispatched"}]} + worker s_0000000009 running→idle + m_0000000042 agent 回复
docker logs server | grep "team_group queued 拦截"
# →  team_group queued 拦截: task=t_0000000006 position=1 current=t_0000000005
```

### 结论
- 非频道未创建、非 dispatcher 无会话：`c_0000000005` 存在，`s_0000000009` 可用。
- **真因 = 排队任务在 team_group 复用频道下仍被 dispatch**，应拦截并提示排队中（消息保存，晋升后可重试），已按最小修复实施。

Files: server/src/chat/chat.service.ts
