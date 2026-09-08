# ROOTCAUSE — team-session 私聊 DM 无流式输出

## 症状
团队会话私聊 tab 发送消息后无流式输出、无回复；群聊正常。

##  Live 复现（compose 栈，server :13000 / web :13001，team tm_0000000001）
- 新建私聊频道 `c_0000000004`（成员 tmm_0000000005 测试-1），SSE 订阅
  `scope=channel:c_0000000004,team:tm_0000000001,global`。
- 探针 1（无 mentions，`POST /channels/c_0000000004/messages {text}`）→
  响应 `triggers: []`；60s 内 SSE 零 `message.part.delta`、零 `agent.loading`、
  DB 该频道仅用户消息一行——worker 从未执行。
- 探针 2（带 `@` mention）→ dispatch 发生，delta 落进私聊频道，但
  trigger 为任务快照 `ta_0000000015` + 任务会话 `s_0000000015`，
  agent 回复正文 "已回复群聊。"，终态回复落群聊 `c_0000000001`（m_0000000020），
  DM processing 行 m_0000000019 永久悬空。

## 根因（两层，都在 server/src/chat/chat.service.ts createMessage）
- **R1（主因，H4 成立）**：trigger 只来自 @ 解析；`type=private` 没有任何回退
  （team_group 在 793-830 有主触发回退）。DM 无可用 mention → `triggers=[]`
  → `dispatch({targets: []})` 空转 → 零执行、零 delta、零回复（H1 最强形式）。
- **R2（并发）**：`resolveChannelAccess` 对无任务团队频道合成团队 currentTask
  为任务上下文（1317-1348；私聊 taskId 恒 null）。于是即使 @ 触发，
  `effectiveTaskId=currentTask` → task-mode 分派（任务快照会话）→ 终态按群聊
  优先落库，DM processing 悬空。delta 能进 DM 只是 source 回退的巧合。
- **H2/H3 被证伪**：探针 2 的 delta 经 ingress 落私聊频道 + `realtime.emit`
  channel scope + SSE `channel:<id>` 订阅全链路正常；ingress/广播/订阅无辜。

## 修复（仅 chat.service.ts，3 hunk）
1. `isTeamPrivate = type===private && teamId` → `effectiveTaskId=null`
  （不继承 currentTask；DM 无任务分区，dtoTaskId 同忽略）。
2. `isTeamPrivate && triggers.length===0 && teamMemberId` → 经
   `buildTeamMemberTrigger(teamId, teamMemberId)` 补对端触发（会话即建即得）。
3. `dispatchTaskId` 团队私聊恒 `''` +透传 `teamId` → 全链路 team-mode：
   dispatchForTeamTarget → ingress 团队分支 → handleTeamTaskCompleted
   （resolveTeamChannel 私聊优先）→ DM 频道终态 + 广播。

## 影响面
- 团队私聊（teamId 有、taskId 无）才走新分支；task 私聊（teamId 无）与群聊
  路径字节不变。DM 用户消息不再写 taskId（原为误继承的 currentTask）。
