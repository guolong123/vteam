
## 2026-08-13 T1 Schema 迁移（TaskAgent 升级为任务实例）

- **迁移命名**：沿用既有 `<yyyyMMddHHmmss>_<snake_name>/migration.sql`，本任务 `20260813130000_role_instance_separation`（最新既有为 20260813120000）。
- **MySQL ERROR 1553 关键坑**：`sessions`/`chat_channels` 的旧唯一索引 `uk_sessions_task_agent(task_id, agent_id)` 中，**task_id 首列同时支撑 task_id 外键**，agent_id 外键也绑定该复合索引。直接 `DROP INDEX` 换新唯一键会报 `ERROR 1553: Cannot drop index ... needed in a foreign key constraint`，即使已为 agent_id 单独建索引也无效（MySQL 仍绑定原索引）。正确顺序：**先建独立 `idx_*_task_id` / `idx_*_agent_id` → DROP FOREIGN KEY → DROP 旧 UNIQUE → ADD 新 UNIQUE → 重建外键**。
- **task_agents 无需拆外键**：其旧唯一索引 `uk_task_agents_task_agent(task_id, agent_id)` 不被 agent_id 外键绑定（外键索引由 `task_agents_agent_id_fkey` 独立承担），可直接 DROP+ADD，无需动外键。
- **唯一键语义变化破坏 6 处编译**：`taskId_agentId` 唯一键改名（TaskAgent → `taskId_agentId_seq`，Session/ChatChannel → `taskAgentId`）。最小语义等价适配：`findUnique`→`findFirst`（where 改 `{taskId, agentId}`）、`taskAgent.update`→`updateMany`、`session.create` 补 `taskAgentId`（用刚创建的 `ta.id`）。**不改业务逻辑**，实例化改造（seq 生成/alias/主实例判定）留 T2-T5。
- **spec mock 同步**：`chatChannel.findUnique.mockImplementation` 中按 `where?.taskId_agentId` 分支的 DM 反查 mock 需迁移到 `findFirst`（dispatch 的 sourceChannel 仍用 findUnique by id，两者并存）；`taskAgent.findUnique` mock 全量换 `findFirst`；ingress/worker-dispatcher 的 `findFirst` 默认返回 null 保证「无 private 频道」跳过落库路径。
- **手动落库 + 迁移记录**：本地 `.env` DATABASE_URL=localhost:3307 无监听（容器未映射宿主端口），无法 `prisma migrate deploy`。用 `docker exec -i aiagents-compose-db mysql -uroot -paiagents-root aiagents < migration.sql` 手动执行后，需**手动向 `_prisma_migrations` 插入记录**（id=UUID()，checksum=sha256sum(migration.sql)，migration_name，applied_steps_count=SQL 语句条数），否则后续 migrate 会认为迁移未应用。
- **插值验证**：唯一键 `uk_task_agents_task_agent_seq` 三维唯一——同 task 同 agent 插入 seq=1/2 成功，重复 seq 报 `ERROR 1062 Duplicate entry ... uk_task_agents_task_agent_seq`。测试行必须 DELETE 清理。
- **schema.prisma 与 DB 漂移注意**：`Session.taskAgentId` schema 声明必填 String，但迁移 SQL 加的是 NULL 列（"迁移期可空先加列"）；存量 9 行 sessions/chat_channels 的 task_agent_id 为 NULL，MySQL 唯一索引对 NULL 不冲突，语义与现状一致。T2 起业务写入时必须绑实例。

## 2026-08-13 T2 团队域改造（实例化团队 + 主实例）

- **DTO 契约**：create `agentIds[]` → `agents: [{agentId, alias?}]`（agentId 可重复=多实例）+ `mainAgentInstanceId?`；`mainAgentId?` 保留兼容映射（mainAgentInstanceId 缺省时映射到该 agent 第一个实例）。update-team `addAgentIds/removeAgentIds` → `addInstances[]/removeInstanceIds[]`（移除按实例 id）。update-task 补 `mainAgentInstanceId?`。
- **seq 生成**：事务内 `taskAgent.aggregate({_max:{seq}, where:{taskId, agentId}})` → `seq = max+1`（防并发重号），唯一键 `uk_task_agents_task_agent_seq` 兜底。alias 缺省 = `<角色中文名>-<seq>`，ROLE_LABELS 映射表（product=产品经理/project_manager=项目经理/architect=架构师/developer=开发者/tester=测试，未知角色回退 agent.name）。
- **主实例解析顺序**：入参 mainAgentInstanceId 优先 → mainAgentId 映射该 agent 第一实例 → null；校验必须属于本次创建实例集合（否则 400）。create 事务内先 task.create(main 置 null)，实例创建后 tx.task.update 写 mainAgentId+mainAgentInstanceId（task.update 前抛错自动回滚）。
- **start 语义变更**：preflight 校验 mainAgentInstanceId 非空（原 mainAgentId）；privateChannel 查找按 taskAgentId（原 taskId+agentId）；sysMessage/privateMessage 用主实例默认别名（产品经理-1 而非 agent 名）；团队分工用实例别名列表。
- **updateTeam 新语义**：addInstances 总是创建新实例（无"已存在幂等跳过"——同 agent 加第二个实例是合法操作）；remove 按实例 id 写 removedAt + 冻结该实例 session；主实例被移除 → task.update 清空 mainAgentId+mainAgentInstanceId；team.changed 广播 payload 含 instanceId+alias（保留 agentId 兼容）。
- **instances 排序**：toTaskDto 的 instances 按 (agentId, seq) 稳定排序（sort 用 agentId.localeCompare）。teamAgentIds 保留兼容但按 taskAgents 原始顺序（若从排序后的 instances 派生会导致顺序变化破坏既有断言/消费）。
- **查询 include 升级**：task 全部查询点 include `taskAgents: { include: { agent: { select: { id, name, role } } } }`（统一 TASK_AGENTS_INCLUDE 常量），instances 的 name/role 从 agent 关联取。
- **落库实证**：临时集成 spec 用真实 MySQL（DATABASE_URL 指向 docker bridge 172.24.0.4:3306，本机可达），KEEP_TEST_DATA=1 保留数据供 docker exec mysql 外部查库，实证后清理。双开发者任务 task_agents 两行 seq=1/2 alias=开发者-1/2、sessions 各绑实例、main_agent_instance_id=项目经理实例。
- **中文显示坑**：docker exec mysql 默认 client 非 utf8mb4 时中文列显示 `???`，查询需 `--default-character-set=utf8mb4`（数据本身正确，jest 断言已确认）。

## 2026-08-13 T3 会话与分派（worker-dispatcher 按实例）

- **当前实例解析**：dispatchForTarget 查 session 时 select 补 `taskAgentId`，当前实例 id = `session.taskAgentId`（可能 NULL——存量会话未绑实例，降级 agent 语义）。isMainAgent 判定 `session.taskAgentId != null && session.taskAgentId === taskRow.mainAgentInstanceId`——**必须用 `!= null` 而非 `!== null`**：mock/缺失字段场景 taskAgentId 为 undefined，`undefined !== null` 为 true 且 `undefined === undefined` 会误判主实例。
- **团队提取**：task.findUnique select 改 `mainAgentInstanceId` + taskAgents include（TaskAgent 完整行含 id/alias/seq/removedAt）。团队用 `.filter((ta) => !ta.removedAt)`（真实数据 removedAt null/Date；mock 缺字段 undefined 也被 `!` 保留，兼容 spec）。
- **身份段新形状**：`【你的身份】你是本任务的 {selfAlias ?? agent.name ?? agent.id}（实例 id: {selfInstanceId ?? agent.id}，角色: {role}）。`——selfAlias/selfInstanceId 缺省回退 agent 语义（存量会话不炸）。**旧断言 `你的 Agent id：` / `名称：` 全部失效**，需更新。
- **团队段新形状**：`- {alias ?? name ?? id}（实例 id: {instanceId}，角色: {role}）` + 主标注 `—— 主 Agent` 按 `m.instanceId === mainAgentInstanceId` 匹配（不再按 agent id）。
- **mainAgentId → mainAgentInstanceId 更名**：BuildSystemInstructionsOptions 字段更名（spec 中 mainAgentId: 'a_architect' → mainAgentInstanceId + team 需带 instanceId）。isMainAgent 保留由调用方计算传入（单一来源）。
- **dispatchAgentMention 按实例**：input `targetAgentId` → `targetInstanceId`；`session.findFirst({ where: { taskId, taskAgentId: targetInstanceId }, select: { id, agentId } })`；dispatch targets 的 agentId 从 session 行取（防同 agent 多实例串扰）。
- **platform-mcp 最小适配（T4 完整改）**：notifyAgent 参数仍为 agentId → `taskAgent.findFirst({ where: { taskId, agentId, removedAt: null }, orderBy: { seq: 'asc' } })` 映射 targetInstanceId，找不到实例回退 agentId（dispatchAgentMention 报错可见）。spec 的 taskAgent mock 需补 findFirst。
- **行为实证**（`.omo/evidence/role-instance-separation/t3-dispatch.txt`）：临时 jest 用例真实 dispatch 双开发者任务——s_dev_1→开发者-1（ta_dev_1）、s_dev_2→开发者-2（ta_dev_2）、s_pm_1→项目经理-1（ta_pm_1），主实例 system 含【主 Agent 职责】、非主实例不含，团队段三实例别名+实例 id+主标注。
- **全量验证**：tsc 0 错误；worker-dispatcher.spec 101 过；全量 56 suites / 1107 tests 全过。

## 2026-08-13 T4 MCP 实例化（platform-mcp + tools + registerExecution + GLOBAL 指令）

- **notifyAgent 完整实例语义**：args `{taskId, selfInstanceId, targetInstanceId, content}`（删 agentId/selfAgentId，不留旧参数）。**落库消息 sender=目标实例**（spec 明确：senderId=目标实例 agent id（查实例行）、senderInstanceId=targetInstanceId）——非发送者；mentions 实例形状 `[{type:'agent', instanceId, agentId, name}]`（name=alias ?? agent.name）；text=`@目标别名 content`；dispatchAgentMention 传 targetInstanceId；返回 `{messageId, channelId, targetInstanceId}`。目标实例不存在/不在团队 → 404（不落库）。**注意 sender 语义与群聊普通消息（group_post sender=发送者）相反**，T5 前端渲染需按此契约。
- **assertWorkerTask 实例化**：参数 selfAgentId → selfInstanceId；活跃集合校验 `isAgentExecuting` 含实例 id；回退 findFirst 的 session select 补 `taskAgentId`，instanceId = `session.taskAgentId ?? session.agentId`，与 selfInstanceId 不一致 403（错误文案含 selfInstanceId）；返回实例 id。落库 senderId=agent id 经 `resolveSenderAgentId(taskId, instanceId)` 查实例行（行缺失回退 instanceId）。
- **taskContext 实例形状**：task select 补 `mainAgentInstanceId`（mainAgentId 保留渲染兜底）；taskAgent.findMany select 补 id/alias/seq/agentId；agentMembers = `{id(实例id), alias, agentId, name, role, main}`，main = id===mainAgentInstanceId。
- **registerExecution 按实例**：签名 `(workerId, taskId, instanceId)`，集合存实例 id；dispatchForTarget 传 `session.taskAgentId ?? target.agentId`（存量 NULL 回退 agentId 保持兼容）。unregisterExecution 三调用点传实例 id：handleTaskCompleted/handleAgentStatus 经 sessionId 反查 `session.taskAgentId ?? agentId`（select 补 taskAgentId）；startPendingWatchdog 增 instanceId 参数（PendingDispatch 加字段）。isAgentExecuting 语义不变。
- **issue 指派实例化**：MCP 工具 issue_create 的 assigneeAgentId → assigneeInstanceId；issues.service 落库 `issue.assigneeInstanceId`（assigneeAgentId 列保留，MCP 路径不写=null）；assertAssigneeInTeam 按前缀分流——`ta_` 前缀按 `{taskId, id}`（实例）、否则按 `{taskId, agentId}`（用户路径兼容）；toIssueDto 返回 assigneeInstanceId；Create/UpdateIssueDto 加 assigneeInstanceId 字段（用户路径 create/update 的 assignee 校验保持按 agentId，互不干扰）。
- **GLOBAL_SYSTEM_INSTRUCTIONS 文本注意**：notify_agent 参数说明引用"见【团队成员】"会让 `not.toContain('【团队成员】')` 断言（单参调用无团队段）失败——改用"见 task_context 的 agentMembers"。
- **spec 大改**：platform-mcp.service.spec 定义 senderInstanceId='ta_sender'，allowWorker session mock 补 taskAgentId；group_post describe beforeEach mock taskAgent.findFirst（resolveSenderAgentId 解析 senderId）；notify_agent describe 单独 mock 目标实例行；工具调用 selfInstanceId 传实例 id（非 agent id）。
- **行为实证**（`.omo/evidence/role-instance-separation/t4-mcp.txt`）：临时 jest 用例跑完清理——notifyAgent 双开发者 senderInstanceId=ta_dev_2/mentions 含目标实例/dispatch targetInstanceId=ta_dev_2；task_context 三实例含 main；assertWorkerTask 错误 selfInstanceId 403；存量会话（taskAgentId NULL）selfInstanceId=agentId 放行。
- **全量验证**：tsc 0 错误；platform-mcp 74 过、worker-dispatcher 101 过；全量 56 suites / 1108 tests 全过。

## 2026-08-13 T5 前端改造（创建页实例列表 + 详情/私聊/issue 实例化）

- **创建页状态模型**：`InstancesByRole: Partial<Record<RoleKey, InstanceDraft[]>>` + `mainKey`（本地临时 key，实例 id 服务端生成）。初始（决策 1）= `{project_manager: [pm-1], developer: [dev-1]}`，mainKey='inst-project_manager-1'。默认别名 = `defaultAliasOf(role, seq)` = `<角色中文名>-<seq>`（与后端 seq 生成规则一致）。
- **提交契约（严格对齐后端）**：`agents: [{agentId, alias?}]`（alias 仅显式改名时提交，服务端缺省生成）+ `mainAgentId`（主实例 key 无法匹配服务端实例 id——传 agent 由服务端映射该 agent 第一实例；用户在主实例上改别名不影响）。**不传 mainAgentInstanceId**（前端无法构造实例 id）。
- **主实例转移（FR-19 保留）**：`MAIN_TRANSFER_ORDER = [project_manager, product, architect, developer, tester]`，移除/停用当前主实例 → 取优先级最高角色第一个剩余实例（排除被移除 key）。移除角色 = 移除全部实例；停用角色经 role-toggle 勾选，启用 = 添加 1 默认实例。
- **详情页数据源**：agentMembers/mentionable/成员面板统一改用 `task.instances`（toTaskDto 返回 `[{id, agentId, alias, seq, name, role, main}]`）——**channel.agentMembers 仍是 agent 形状（后端 findOne 未实例化），不可再用作实例源**；instances 缺失时回退（存量防御）。
- **id 双轨制**：SSE 事件（loading/error/status）与消息 senderId 均为 **agentId** 维度；实例以 instanceId（ta_）为唯一键。成员面板 key=instanceId、状态匹配按 agentId（同 agent 多实例共享 SSE 状态——后端广播维度限制）。agentMap 同 agent 保留首个别名（防 Map 后写覆盖）。
- **消息 sender 别名兜底**：后端消息 DTO 无 senderInstanceId；T4 notify_agent 落库 mentions 为实例形状 `[{type:'agent', instanceId, agentId, name}]`（name=目标实例别名）——`senderNameFromMentions` 按 mentions[].agentId===senderId 取别名（如 开发者-2），否则 agentMap/agentId。
- **发送 mentions 附带 instanceId 但按 agentId 解析**：CreateMessageDto MentionInput 仅 `{type:'agent', agentId}`；多余字段（instanceId）JSON.stringify 保留、后端原样落库、resolveMentions 忽略。绝不能把 agentId 换成实例 id（teamMap 按 agentId 查会 400 MENTION_AGENT_NOT_IN_TEAM）。
- **issue 指派**：数据源 GET /tasks/:id → instances（编辑时用 issue.taskId，任务筛选可为空）；提交 `assigneeInstanceId`（ta_ 前缀，后端 assertAssigneeInTeam 按前缀分流）；IssueItem.assigneeInstanceId 后端 DTO 已返回（无 assigneeInstanceName——前端本地映射实例别名展示）。
- **私聊页**：新增 taskQuery 拿 instances；mainAgent = channel.agent（agentId）匹配首实例 → name=实例别名 + instanceId。createDmChannel 幂等按 (taskId, agentId)——同 agent 多实例私聊复用同频道（后端 T6 边界）。
- **验证环境坑**：部署容器（:13001/:13000）跑的是 T1-T4 之前构建（CreateTaskDto 仍要求 agentIds）——**必须本地起新构建 server 连容器 DB 验证**（DATABASE_URL='mysql://root:aiagents-root@172.24.0.4:3306/aiagents'，MODEL_CREDENTIAL_KEY 取仓库根 .env，nest build 输出在 dist/src/main.js），web dev `-p 3001` + `API_PROXY_TARGET=http://localhost:3000`。Playwright channel=chrome。容器内进程 kill 后 docker restart:unless-stopped 自动拉起（勿误杀）。
- **全量验证**：tsc 0 错误；npm run build 通过；Playwright 12/12 断言过（创建页交互/主实例转移/成员面板/@候选/issue 指派/私聊别名），JS 错误 0；截图 /tmp/opencode/t5-shots/。

## 2026-08-13 T6 端到端验证（部署重建 + 双开发者全链路 + 4 项缺陷修复）

- **部署重建**：`docker compose up -d --build server web`（init 保持成功可跳过重建）；worker 必须
  `docker restart` 适配新 server（旧进程心跳 fetch failed）。MODEL_CREDENTIAL_KEY 从仓库根 .env 取。
- **4 项验收级缺陷全部实锤并修复**（T5 标注的 4 项后端边界在真实双开发者场景全部触发）：
  1) **@ 歧义**：resolveMentions 按 agentId 建 teamMap，同 agent 多实例 Map 覆盖——@开发者-2 触发
     开发者-1 会话（实测 worker 回复落库开发者-1 会话）。修复：MentionInput 加 instanceId；
     resolveMentions 优先按 mention.instanceId 匹配实例行；buildTrigger 按 taskAgentId 查会话
     （`session.findFirst({where:{taskId, taskAgentId}})`）；getTriggerResults 同源修正（teamMap→
     targetRows 实例列表）。**缺省回退顺序：未移除实例优先 → 任意状态兜底（判 agent_removed）**——
     单测期望已移除 @ 返回 agent_removed 而非 400，必须两段 find。
  2) **私聊复用**：createDmChannel 按 (taskId, agentId) 幂等，双开发者共用频道。修复：
     CreateDmChannelDto 加 taskAgentId?；幂等按 (taskId, taskAgentId)，缺省回退该 agent 第一实例
     （`taskAgent.findFirst({where:{taskId,agentId,removedAt:null},orderBy:{seq:'asc'}})`）；
     创建 data 用条件展开 `...(taskAgentId?{taskAgentId}:{})`（缺省不传字段，测试兼容）；
     toChannelDto 输出 taskAgentId。前端 onStartDm 传 taskAgentId，messages 页 mainAgent 优先
     channel.taskAgentId 精确命中实例（不再 find 首实例串扰）。
  3) **SSE loading 共享**：dispatchForTarget/ingress 广播 agent.loading 按 agentId 无实例维度。
     修复：DispatchTarget/DispatcherLoadingEvent 加 instanceId?；dispatchForTarget loading 广播
     带 `session.taskAgentId ?? null`；handleAgentStatus 反查 session taskAgentId 后 emit 带
     instanceId；message.part.delta 落 senderInstanceId。前端 loading/error/status key =
     `instanceId ?? agentId`（存量回退），nameByStateKey（key→别名）反查 label，MessageList
     sender 渲染优先 `senderInstanceId`→instanceNameById（精确别名，如 开发者-2 回复显示开发者-2）。
  4) **senderInstanceId 落库**：acknowledge/handleTaskCompleted/message.part.delta 落库点全补
     senderInstanceId（目标实例/executionRef/session.taskAgentId），toMessageDto 输出。
- **dispatch 契约**：ChatService dispatch targets 从 `{agentId, sessionId}` → `{agentId,
  instanceId, sessionId}`（MessageDispatcher 抽象接口加 instanceId?，mock-dispatcher 兼容）。
- **loading 事件收敛 key**：前端 onMessage 收敛用 `m.senderInstanceId ?? m.senderId`——
  回复消息带实例 id，收敛精确到实例（否则同 agent 双实例一起消失）。
- **worker 会话实证主 Agent 注入**：无 sqlite3，用 `docker cp` 拷 opencode.db 出来 python3
  sqlite3 查 message.data.system——主实例 system 含【主 Agent 职责】+团队段主标注，
  非主实例不含【主 Agent 职责】但团队段仍标注他人主身份。
- **回归**：全量 jest 1108 过（含更新断言：loading payload instanceId:null、dispatchAgentMention
  targets 带 instanceId、createDmChannel create 调用 taskAgentId 缺省不传）；web tsc+build 过；
  存量任务/旧频道（taskAgentId NULL）兼容路径 UI 正常。

## T8 群聊无 @ 消息自动路由主 Agent（2026-08-13）
- **实现**：chat.service.createMessage 步骤 2.5 —— `channel.type===task_group && triggers.length===0`
  时调 `buildMainAgentTrigger`（mainAgentInstanceId 优先 → mainAgentId 回退 seq 升序第一未移除实例）。
  命中未移除实例 → 复用 `buildTrigger`（按 taskAgentId 查会话）；已 removed/无主实例/不在团队 → 返回 null 不触发。
- **主实例字段随 resolveChannelAccess 一起取**：CHANNEL_TASK_SELECT 扩展 select mainAgentInstanceId+mainAgentId
  （ChannelRow.task 类型同步扩展），免二次查库；resolveChannelAccess 返回 task 类型补两字段。
- **契约**：有 @ 不叠加（triggers 非空即跳过）；private 不路由（仅 task_group）；
  任务无主实例/主实例已 removed → triggers 空，消息仅落库广播（行为与现状一致）。
- **行为实证**（:13000，t_0000000005 主实例=ta_0000000013）：
  无 @ → triggers=[{a_developer, ta_0000000013, s_0000000013, dispatched}]，主实例 ACK(m_0000000243)+回复(m_0000000245)
  落库 sender_instance_id=ta_0000000013；带 @ 项目经理-1 → 仅 ta_0000000012 触发（不叠加）；
  t_0000000004（无主实例）无 @ → triggers 空。
- **回归**：全量 jest 1114 过（+6 T8 用例）；tsc 0 错误。ACK/dispatch 复用现有链路（targets 带 instanceId）。

## 2026-08-13 T7 任务详情页添加实例（前端追加需求）

- **契约勘误**：任务描述写 `PATCH /tasks/:id/team`，实际后端 controller 是 `@Post('tasks/:id/team')`（T2 已实现且 T6 验证过）——前端用 `api.post`，勿改后端。
- **返回即刷新**：updateTeam 成功返回 toTaskDto（含 instances）→ `setQueryData(["task", taskId], res)` + invalidate 即可让成员面板/@ 候选/issue 指派（数据源同 task.instances）即时联动，无需重取频道。
- **角色选择数据源**：详情页新增 `GET /agents`（queryKey ["agents"] 与创建页共享缓存）；每角色取首个 agent（roleOptionsOf 去重），seed 预置 id（a_product 等）兜底——API 失败时添加不中断。
- **别名契约**：仅显式输入才提交 `alias`，缺省服务端生成 `<角色中文名>-<seq>`（与创建页 T5 提交一致）；前端 placeholder 提示即可，不预测 seq。
- **状态约束**：teamEditable = status pending|in_progress（后端 409 TASK_TEAM_NOT_ALLOWED 时间窗）；不可编辑时入口 disabled + title 提示。
- **错误呈现**：onError → isApiError err.message（404 AGENT_NOT_FOUND「Agent xxx 不存在」）；面板保留打开展示错误（成功才关闭重置），对齐 dmError 红色 #DC2626 模式。
- **组件内聚**：添加面板（展开/选中角色/别名/错误）状态全放 MembersPanel 内部，页面只传 agentOptions/teamEditable/adding/addError + async onAddInstance（返回 boolean 驱动面板关闭）；224px 窄面板用紧凑角色行（色点 + 中文名 + 选中勾）。
- **验证环境**：`docker compose up -d --build web` 重建后 :13001 生效；T7 在 t_0000000010（pending）添加 开发者-2 实测：task_agents seq=2 递增 + sessions 绑新实例 status=created（pending 任务 joinStatus）；错误/禁用路径用 Playwright route 拦截 API 验证（不污染数据）。

## 2026-08-13 P1 修复：私聊频道按实例精确落库（F2/F3 Final Wave REJECT 闭环）

- **根因教训（T6 修复 B 不完整）**：T6 修复 B 只让 `createDmChannel` 按 taskAgentId 幂等
  （频道**创建**独立），但消息**落库定位** `resolveChannel`（worker-dispatcher）/`privateTarget`
  （ingress）仍按 `{taskId, agentId}` findFirst——同 agent 多实例时命中最早创建的私聊频道，
  流式中间态+终态回复串扰到另一实例。**「按实例独立」验收必须覆盖创建与落库两个环节**，
  任何一侧只改创建不改落库都会留下隐私/归属错误。
- **resolveChannel 签名升级**：`(taskId, agentId, taskAgentId?)`——taskAgentId 存在 →
  `findFirst({taskId, taskAgentId})` 精确匹配；缺失 → `{taskId, agentId}` 回退（存量兼容）。
  调用方实例 id 来源：**优先复用已有 session 反查**（handleTaskCompleted 已查 session 取
  taskAgentId；ingress 已有 deltaSenderInstanceId；failProcessingMessage 补一次
  session.findUnique）——不额外引入新查询。
- **failProcessingMessage 实例 id**：payload 带 sessionId → `session.findUnique` 反查
  taskAgentId；存量 NULL → undefined → resolveChannel 走 agentId 回退。
- **前端 session.updated 收敛 key**：`onSessionUpdated` 状态 key 必须与 loading/error/
  收敛 key 统一为 `instanceId ?? agentId`——同 agent 多实例时若用 agentId 作为 key，
  idle 收敛会命中/清除错实例（loading 不收敛）。sessionId → instanceId 映射随
  agent.loading/agent.error/agent.status 事件填充（与既有 agentIdBySessionRef 并存）。
- **regression 覆盖**：为 resolveChannel/privateTarget 各加双实例精确匹配 + 存量回退
  用例；integration spec 断言同步（session 绑实例 → findFirst 按 taskAgentId）。
- **不修（记录）**：P3 类——seq 并发撞唯一键无重试、forwardToGroup 死代码、
  createDmChannel 缺省回退并发重复频道（非验收项，F4 若撞见再评估）。
- **验证**：tsc 0 错误；全量 jest 56 suites / 1117 tests（+3）；web tsc+build 过；
  真实部署双开发者复测——ta_35 私聊消息全在 c_26（流式 processing + 终态 sent），
  c_25 零新增污染；SSE loading 仅目标实例处理中并正常收敛。

## 2026-08-13 数据清理与重置（reset-data，全新干净环境）

- **清空业务表保留 schema**：`SET FOREIGN_KEY_CHECKS=0; TRUNCATE <29 张业务表>; SET FOREIGN_KEY_CHECKS=1;`
  包 TRUNCATE 最稳（表间外键不影响清空顺序）。**保留 `_prisma_migrations`**（schema 版本记录，
  清掉会损坏迁移状态）。不 DROP 库/不重跑 migrate deploy。
- **表分布**：DB 共 30 张表 = 29 业务 + 1 系统（`_prisma_migrations`）。业务表含
  tasks/messages/chat_channels/sessions/task_agents/issues/artifacts/artifact_versions/
  task_events/task_group_instances/realtime_events/skills/agent_questions/git_credentials/
  git_repo_grants/model_credentials/models/tools/mcp_servers/roles/users/projects/
  project_members/agents/workers/worker_model_availabilities 等。
- **seed 重建范围**（server/prisma/seed.ts，全 upsert 幂等）：roles=admin/member、
  users=admin(u_admin)/seed-admin(u_seed_admin)/seed-member(u_seed_member)、
  projects=p_seed_1「AI 智能体平台」/p_seed_2「文档协作平台」+ project_members(owner)、
  template agents=5（a_product/a_project_manager/a_architect/a_developer/a_tester）、
  models=16、tools=10（6 builtin + 4 mcp）、mcp_servers=1（keta-platform）。
- **seed 执行方式**：server 容器内有编译产物 `dist/prisma/seed.js`，
  `docker exec aiagents-compose-server node dist/prisma/seed.js` 直接跑（比
  `docker compose up -d --build init` 快，无需重建镜像）。
- **运行时数据不重建**：workers=0 / worker_model_availabilities=0 是运行期自注册数据，
  seed 不生成——**需重启 worker 容器**（`docker restart aiagents-compose-worker`）
  自动重新注册。
- **uploads 清理**：`rm -rf server/uploads/*`（保留目录）；该目录未被 git 跟踪
  （git ls-files = 0），清理不产生 git 变更，无需提交。
- **MySQL 中文乱码坑（复用）**：查询中文需 `--default-character-set=utf8mb4`，否则显示 `???`
  （数据本身正确）。列名为 snake_case（display_name/role_id/owner_id，非 Prisma 驼峰）。
- **证据**：`.omo/evidence/role-instance-separation/reset-data.txt`（清理前后行数对比 +
  TRUNCATE + seed + 重建验证 + 容器状态）。

## 2026-08-13 T4 修复：MCP issue_create "Agent 不是该任务团队成员"

- **根因教训（T4 实例化遗漏）**：T4 只实例化了 platform-mcp 层（issueCreate 收 selfInstanceId、
  assertWorkerTask 按实例、assigneeInstanceId 落库），但 issues.service 的 agent 侧方法仍按
  **agentId 语义**——`assertAgentTaskMember` 用 `taskAgent.findFirst({taskId, agentId})` 按
  task_agents.agent_id 列匹配，传实例 id ta_xxx 查不到 → 403 NOT_MEMBER。**MCP selfInstanceId
  必须贯穿到 service 层校验与落库**，不能只在 MCP 层转义。
- **creator 落真实 agent id**：`issues.creator_agent_id` 外键指向 agents 表（a_ 前缀）——
  createByAgent 若把 selfInstanceId 原文落库会外键失败（Restrict）。必须从实例行解析
  `ta.agentId`（模板 agent id）再落。assignee_instance_id 无外键（字符串）可直接落实例 id。
- **统一解析助手模式**：新增 `resolveAgentInstance(taskId, ref)`——`ta_` 前缀 → 按
  `{taskId, id}`（实例行）；否则按 `{taskId, agentId}`（存量兼容）。全部 6 个 agent 方法
  （assert/create/findAll/findOne/update/transition）的前缀分流收敛到一处，避免散落
  startsWith 判断（T4 时 assertAssigneeInTeam 自己写了一份，未覆盖 assertAgentTaskMember）。
- **方法返回值承载实例语义**：assertAgentTaskMember 返回 `{ status, agentId }`（agentId=
  实例行解析的真实模板 agent id），createByAgent 解构落库——比"多查一次"干净。
- **spec mock 细节**：select 增加 id/agentId 后，createByAgent 成功用例的
  `taskAgent.findFirst` mock 必须带 agentId 字段，否则 creatorAgentId 落 undefined 被
  Prisma 忽略、断言失败；非落库方法（findAll/findOne/update/transition）的 mock 只需
  removedAt 即可。
- **验证**：tsc 0 错误；全量 jest 56 suites / 1121 tests（+4 实例化用例）；真实集成
  （DATABASE_URL 指 172.24.0.4:3306）createByAgent('ta_0000000037', 't_0000000012') 通过，
  查库 creator_agent_id=a_project_manager、assignee_instance_id=ta_0000000038；修复前等价
  SQL matched_rows=0 复现报错。证据 `.omo/evidence/role-instance-separation/fix-issue-mcp-member.txt`。

## 2026-08-13 T4 修复：notify_agent 落库 sender 归属（agent 互 @ 显示割裂）

- **根因教训（发送者/目标语义错位）**：T4 notifyAgent 契约定为"sender=目标实例"
  （senderId=targetAgentId、senderInstanceId=targetInstanceId、mentions @目标）——与群聊普通
  消息（group_post sender=发送者实例）语义相反。前端按 sender 渲染头像/名字 → "头像是目标
  （测试）、内容是发送者（项目经理）写的"。T5 前端 senderNameFromMentions 兜底（senderId 命中
  mentions[].agentId 时取 name）进一步放大：senderId=目标 agentId 恰好命中 mentions → 显示目标别名。
- **MCP 互 @ 的正确语义模型**："notify_agent = 发送者通知目标实例"——落库消息必须是**发送者**
  的发言（sender=发送者实例解析的真实模板 agent id + senderInstanceId=selfInstanceId），
  @目标只体现在 mentions 与 content.text 前缀；目标实例的**触发**由 dispatchAgentMention
  （targetInstanceId）完成，与落库 sender 无关。**显示语义与触发语义解耦**：落库管 UI 显示
  （sender），dispatch 管触发（target）。
- **解析助手复用**：resolveSenderAgentId(taskId, instanceId)——taskAgent.findFirst({id,
  taskId}) 查实例行取 ta.agentId（真实模板 agent id），实例行缺失（存量 agent id 直传）原样
  返回。group_post/notifyAgent 共用，行为一致。
- **spec mock 分流模式**：同一方法内多次 taskAgent.findFirst（目标实例查询 + resolveSenderAgentId
  发送者查询）时，mock 用 mockImplementation 按 where.id 分流返回不同行，而非单值 mockResolvedValue。
- **验证**：tsc 0 错误；全量 jest 56 suites / 1121 tests 全过；真实链路
  （docker compose up -d --build server → curl 直调 notify_agent selfInstanceId=ta_37
  target=ta_41）落库查证 sender_id=a_project_manager、sender_instance_id=ta_0000000037、
  mentions=[{ta_41,a_tester,测试-4}]，且 sessions s_0000000041 idle→running（触发语义不变）。
  证据 `.omo/evidence/role-instance-separation/fix-notify-agent-sender.txt`。
  补充（用户实测场景 target=ta_38 测试-1）：落库 m_0000000327 sender_id=a_project_manager、
  sender_instance_id=ta_0000000037、mentions=[{ta_38,a_tester,测试-1}]；sessions s_38
  idle→running；浏览器 UI 截图（fix-notify-agent-sender-ui.png）消息气泡蓝色"P"项目经理
  头像 + "项目经理-1 · 22:18" + "@测试-1 你好，请执行分配任务的验收测试"——sender 归属、
  触发、UI 三者全链路一致。

## 2026-08-13 T5 调查：重新配置 Agent 模型后重发消息模型没有变化

- **结论（实证驱动，非猜测）**：模型变更链路（DB → server → worker → serve）完整正常，
  "模型不生效"在当前代码中不可复现。真实复现：PATCH a_project_manager → deepseek-v4-pro →
  群聊 @（复用会话 ses_004bade45ffehFihqetEq25ST9）→ serve 日志 `stream providerID=opencode-go
  modelID=deepseek-v4-pro`，新模型生效。
- **核心嫌疑排除（实证方法）**：opencode serve 1.18.16 **不锁定会话模型**——同一会话两次
  prompt_async 传不同 model（flash → pro），user message model 字段分别记录，GET /session 会话
  model 更新为最新。历史会话同样多模型（ses_004855de9 内 flash 与 flash-free 并存）。
- **模型全链路透传确认**：worker-dispatcher.ts:886 resolveAgentModelId（每次 DB 读无缓存）
  → :946 toModelSelection → :1064 execute → worker.client.ts:208 body model → exec-server.ts:542
  sendAndAwait → v1-driver.ts:220 prompt_async body model → prompt-await.ts:429 直传。
- **关键判据**：`model = agentModelId ?? workerRow.defaultModelId ?? null`——agent 无模型时
  fallback worker 默认（当前 NULL）→ null → **serve 用默认模型 `opencode-go/gpt-5.6-luna`**。
  若用户配置的 defaultModelId 格式非法（无 '/'），toModelSelection 返回 null 同样落入 serve 默认。
- **用户问题可能原因**：① 配置的模型与当前相同（时间线显示 13:49 与 14:14 两次配置均为 flash，
  重发消息模型不变是预期）；② 新模型额度同样失效——serve 日志 `opencode/deepseek-v4-flash-free`
  报 `AI_APICallError: Rate limit exceeded`（"模型额度失效"场景的直接证据）；③ available-models
  返回目录全部 enabled 模型，不过滤 worker availability/凭据，用户可配置 dispatch 后失败的模型。
- **防御性改进**：worker 执行链路日志补 model 字段（v1-driver sendMessage + exec-server 执行
  完成），`model=(default)` 标记 serve 落入默认模型——用户/运维可 `docker logs aiagents-compose-worker
  | grep sendMessage` 直接确认每次 dispatch 实际使用的模型，避免"模型是否生效"盲猜。
- **验证**：worker tsc 0 错误；worker 全量 jest 21 suites / 355 tests 全过；真实环境重建 worker
  容器后改模型 → 日志 `sendMessage -> ses_xxx model=opencode-go/deepseek-v4-pro (HTTP 204)` +
  serve 日志 stream 双重确认；验证后环境还原（全 flash）。证据
  `.omo/evidence/role-instance-separation/fix-model-change.txt`。

## Fix: Agent 工作状态切页丢失（sessionByAgent 初始快照）
- **根因**：`web/app/(main)/tasks/[id]/page.tsx` `sessionByAgent` 初始 `{}` 仅靠 SSE 增量驱动；
  切页组件重建 + SSE 首连 `since=latest` 只收新事件，执行中 running 不重放 → 成员误显「就绪」。
- **后端状态源打通**：`sessions.status` 已是真实状态（dispatch→running、回复回流→idle），
  但 toTaskDto 未返回。修复：Prisma 补 `TaskAgent.sessions` 关系（`sessions.task_agent_id`
  列已存在，仅 Prisma 层关系，**无需 DB 迁移**，prisma generate 即可）→ TASK_AGENTS_INCLUDE
  增 `sessions: { select: {id,status}, where: { status: { not: 'archived' } } }` →
  instances 每项加 `sessionStatus`（每实例恒 1 条会话取首项，uk_sessions_task_agent 唯一）。
- **前端初始快照策略（关键）**：`useState(()=>{})` 无法取异步任务数据，改用
  `sessionSeedRef` 守卫 + effect 首次填充：**仅填缺失 key**（`!(inst.id in prev)` 才 set，
  不覆盖已到的 SSE 实时状态，避免 refetch/SSE 竞态覆盖 running/idle）。
- **连带收敛修复**：只 seed sessionStatus 会留 stale「工作中」——执行完成时页面若错过
  agent.loading（切页期间）则 `agentIdBySessionRef` 无映射、session.updated idle 被丢。
  故 instances 同时回传 `sessionId`，seed 时按 sessionId 建 `agentIdBySessionRef`/
  `instanceIdBySessionRef` 映射，idle 事件可收敛。
- **SSE key 约定不变**：`key = instanceId ?? agentId`（instanceId=taskAgentId ta_ 前缀），
  与 seed key（inst.id=ta_xxx）一致，members-panel `a.instanceId ?? a.id` 命中。
- **验证**：server 1122 / web build 通过；真实 @ 执行中→工作中、完成后 SSE 收敛→空闲；
  切页回来仍工作中。证据 `.omo/evidence/role-instance-separation/fix-agent-status-persist.txt`。

## 死代码清理（code-review-2026-08-report A1-A5，2026-08-13）
- 按审核报告删除 A 类确认死代码 5 处：A1 mock-dispatcher（被 WorkerDispatcher 取代）、
  A2 artifacts-mock-consumer（已接线但 simulateSubmission 无生产调用）、A3 git-credentials
  （占位脚手架，真实路径 git-credential-injector/git-tools 内联复刻）、A4 ui/sidebar+top-bar
  （被 NavDock/NavTopBar 取代，连带清 tokens.ts sidebarTheme）、A5 git-op-reporter（onPoll
  未接线的半成品 producer）。
- 关键原则：**只删 producer/死文件，保留消费者**——A5 的 worker-protocol.ts GIT_OP 常量
  与 server worker-event.ingress.ts git.op 消费逻辑（301/646-692）完整保留（消费者已接线、
  生产者未接线的半成品标注保留）。
- 删除前逐处 grep 复核报告证据（确认零生产引用才删）；删除后把悬空注释引用（MockDispatcher/
  git-credentials.ts/git-op-reporter.spec 等）改为描述性文字，避免悬挂引用。
- 验证：server 1107 jest / worker 336 jest / 三端 tsc 0 错误 / web build 通过 / 7 组无悬空
  grep 全 0 命中。C 类（canvasui 等）全部保留，未提交 git。证据
  `.omo/evidence/code-review/dead-code-removal.txt`。

## 2026-08-14 删除「查看 Agent 会话」无效占位入口

- **占位入口识别**：任务详情页右侧 aside 底部的「查看 Agent 会话」卡片是 Phase 3 会话面板的纯占位（title="会话面板（Phase 3）"，从未实现），data-testid="view-session-link" 无任何点击处理。
- **CMDK 操作项判定法**：Cmd+K 命令面板「操作」组项是否有效 = 是否在 app-shell handleCmdKSelect 有专门分支（如「新建任务」）或 CMDK_NAV_PATH 有 label。本项目中「查看产出物」「查看 Agent 会话」两者皆无 → 均无效，一并删除；「新建任务」保留。
- **同源残留清理**：删 DOM 元素后必须同步清理引用它的断言/审计文档（e2e/pages.spec.ts 的 toBeVisible 断言 + e2e/reference/testids.ts 的 testid 清单），否则 e2e 会挂。testids.ts 中同一 testid 出现在多处，注意用 replaceAll 或分上下文逐一删除。
- **playwright 脚本位置**：脚本放 /tmp 下无法解析 web 的 node_modules 的 playwright 包，需放到 web/ 目录内运行；扩展名 .mjs 下 require 报 ES module 错，用 .cjs 即可。
- **验证链**：tsc --noEmit 0 错误 → npm run build 通过 → grep 0 命中 → docker compose up -d --build web 重建 → playwright 实测 DOM 消失 + Cmd+K 项消失。

## 2026-08-14 附件上传 Failed to fetch 根因（Next rewrites ARG 陷阱）+ 粘贴支持

- **Failed to fetch 根因（web Dockerfile ARG 缺省陷阱）**：web/Dockerfile `ARG API_PROXY_TARGET=http://localhost:3000` 缺省值在容器内致命——Next standalone server.js 监听 `$HOSTNAME`（容器网络 IP），**无进程监听 127.0.0.1:3000**，容器内实测 `fetch("http://localhost:3000/...")` 直接 ECONNREFUSED。rewrites 在 next build 编译进 routes-manifest.json、运行时 ENV 无效，构建期漏传 ARG / 旧镜像 → 代理指向容器自身 → 浏览器 fetch TypeError: Failed to fetch。修复：Dockerfile 缺省 ARG 改为 `http://server:3000`（compose 网络服务名），docker-compose.yml 的 build args 注入保持。
- **实证方法论**：直连(13000) vs 代理(13001) curl 对比 + 容器内 fetch 探测 + routes-manifest 确认 + playwright 浏览器实测（0 失败请求才算过）——逐环节锁定，不猜。
- **附带 bug（纯附件消息 400）**：前端 MessageInput 允许无文本纯附件发送（text=""），后端 CreateMessageDto.text `@IsNotEmpty()` 拒绝 → 400 text should not be empty。修复：DTO 去掉 @IsNotEmpty 保留 @IsString（text 允许空串），import 同步移除 IsNotEmpty。**前后端契约不一致要查：前端发送按钮 disabled 条件 = 允许纯附件，后端 DTO 必填校验却拒绝**。
- **粘贴支持复用上传**：message-input.tsx 抽 `uploadFile(file)` 公共函数（扩展名校验→10MB→POST /uploads→pendingAttachment），handleFileChange 与 onPaste 共用。onPaste 遍历 clipboardData.items，`kind==="file"` 取第一个 getAsFile() → preventDefault（阻止浏览器把图片以 data: 插入 textarea）→ uploadFile；纯文本不拦截。playwright 模拟粘贴：page.evaluate 构造 DataTransfer.items.add(new File([bytes],...)) + dispatch ClipboardEvent('paste',{clipboardData,bubbles,cancelable})，检查 evt.defaultPrevented 验证拦截行为。
- **运维教训（本次踩坑）**：`/data` 分区 100% 满会导致 MySQL redo log resize 失败崩溃循环（Cannot resize redo log file #innodb_redo... Failed to set size），docker build cache 占 53GB；`docker builder prune -f` 腾空间即恢复。另外 compose 依赖链重建时若 init 种子脚本被锁卡住（seed upsert Lock wait timeout），需 kill MySQL 残留连接（SHOW PROCESSLIST + KILL）+ 删残留容器再 up。

## 2026-08-14 统一"用户上传附件"与"Agent MCP 上传"链路（unify-upload-archive）

- **归档公共化**：platform-mcp.archiveFetchedFile 全量搬移至 ArtifactsService.archiveFile（行为不变，只换宿主），platform-mcp 的 submitFileArtifact / group_post fetchAndArchiveAttachment 转调之；POST /uploads 带可选 taskId 时也走同方法 → 用户附件与 Agent 上传链路完全一致。
- **read_file 归档命中关键设计**：read_file 归档命中按 artifactVersion.filePath 归一化匹配（normalizeFileRef）。用户上传归档时 fileRef 必须存**落盘 URL**（=消息 attachmentUrl）而非 originalname，否则 Agent 用 chat_history 返回的 attachmentUrl 调 read_file 无法命中归档（走 worker 拉取 404）。filePath==attachmentUrl==contentRef 三者同源 → source:"archive" 读回内容。
- **上传归档不阻断上传**：归档在 upload 内 await + catch(warn)，失败仅记日志，附件照常返回——附件发送稳定性优先于归档完整性。
- **幂等去重天然覆盖重复上传**：同内容重复上传（同 sha256 + taskId）→ archiveFile 返回 duplicate，不新增 artifact/版本，UI 无感知。
- **chat_history 附件契约**：消息行补 attachmentUrl/attachmentName/attachmentType/senderInstanceId 四字段（无附件显式 null），Agent 可据此调 read_file 读取用户上传的附件。
- **多实例兼容**：chat_history 的 senderInstanceId 透出（agent 消息为 ta_ 实例 id，user 消息 null），与私聊/群聊落库双写结构对齐。
- 验证：server tsc 0 错 / 1115 jest 全过 / web tsc+build 过；浏览器实测群聊上传 → 消息附件三字段 + artifacts 新 file 产出物 → chat_history 含 attachmentUrl → read_file(source:archive) 读回 base64。证据 `.omo/evidence/role-instance-separation/unify-upload-archive.txt`。

## 2026-08-14 task_transition 权限实证 + assertWorkerTask 多实例精确匹配修复

- **真实缺陷（实证发现）**：assertWorkerTask 回退分支 `session.findFirst({ where: { taskId, workerId } })` 在多实例任务下返回**首条 session**（恰好是主实例的）→ 团队内合法非主成员（selfInstanceId 正确）被误判"禁止冒充"，提示不准确，且无法落到 transitionByAgent 的"仅主 Agent"403。**单元测试 mock 了 findFirst 返回值，掩盖了真实多实例歧义**——必须真实链路验证才能发现。
- **修复**：where 增加 `...(selfInstanceId !== undefined ? { taskAgentId: selfInstanceId } : {})`，selfInstanceId 提供时按实例精确匹配自身 session。安全不降级：跨任务/冒充实例因无自身 session → 403"禁止跨任务访问"。
- **Prisma OR 陷阱**：OR 内各分支字段集必须完全一致，`undefined` 值也会被剔除导致"Argument taskAgentId is missing"；`{ taskAgentId: x, agentId: undefined }` 与 `{ taskAgentId: null, agentId: y }` 仍报字段缺失。干脆不用 OR——因 selfInstanceId 恒为 ta_ 前缀、存量 taskAgentId NULL 会话的 instanceId 回退是 a_ 前缀 agentId，两者永不等（legacy 回退是死代码），直接按 taskAgentId 精确匹配即可。
- **错误提示 Agent 友好化**：MCP 工具的 403 不仅报错，还要给 Agent 完整引导——message 含实际 mainAgentInstanceId + 正确操作路径（"请知会主 Agent 调用 task_transition，或由管理员在任务管理界面操作"）。GSI（worker-dispatcher）同步"其余成员调用将返回 403 提示"。
- **验证方法论**：三层防线逐层实证——(a) 跨任务/冒充实例 → 403"禁止跨任务访问"（归属校验）；(b) 团队内非主实例 ta_38/ta_40 → 403 TASK_STATUS_MAIN_AGENT_ONLY 完整引导；(c) 主实例 ta_37 → start 幂等 + mark-pending-review 流转 + reject 回滚（actor_type=agent 落库 task_events）。验证后必须回滚状态（in_progress），不破坏数据。截图任务详情页确认状态与主 Agent 标记。
- **playwright 脚本运行**：脚本放 /tmp 下 NODE_PATH 指向 web/node_modules 才能 require playwright；用 .cjs（.mjs require 报 ES module 错）。
- 验证：server tsc 0 错 / 全量 jest 54 suites·1125 tests 过 / 真实链路 curl + 查库 + UI 截图。证据 `.omo/evidence/role-instance-separation/task-transition-permission.txt`。

## 2026-08-14 vteam Helm chart（chart/vteam，对齐 docker-compose 的 K8s 形态）

- **结构**：chart/vteam 含 Chart.yaml/values.yaml/values-dev.yaml/README.md + 14 个 templates（server/web/worker 三 Deployment、mysql StatefulSet、init Job、4 Service、3 PVC、ConfigMap/Secret/Ingress/NOTES）。自包含实现，不引入 bitnami 依赖。
- **随机值同源（关键设计）**：configmap 拼装 DATABASE_URL 的密码与 Secret.DB_PASSWORD 必须是同一生成值——在 `_helpers.tpl` 里用 `set` 在根 context 缓存随机值（`{{- $_ := set . "vteamDbPassword" (default (randAlphaNum 16) .vteamDbPassword) }}`），secret.yaml 与 configmap.yaml 都 include 同一 helper → 保证一致。首次安装随机生成，升级经 `lookup` 复用已有 Secret 值（避免密码轮换失配）。
- **Helm 模板陷阱**：`{{- include ...}}` 会吞掉前一行的换行导致 labels 合并（`helm.sh/chart: vteam-1.0.0app.kubernetes.io/name`）——include 前不能用 `-`；`fromYaml` 渲染 JSON 数组进 exec.command 不可靠（报 cannot unmarshal array），探针命令直接写 YAML list 最稳。
- **web API_PROXY_TARGET 铁律**：rewrites 编译进 routes-manifest.json，运行时 env 无效——chart 只把 `web.image.proxyTarget` 作为构建参数文档（README/values 注释），web Deployment 不注入任何代理 env（验证渲染仅注释出现）。
- **探针对齐**：server `/api/v1/health`、web `fetch($HOSTNAME:3000)` 都用 exec(node -e fetch)（node:22-alpine 无 curl/wget）；worker 不设 HTTP 探针（对齐 compose 无 healthcheck，活跃由 server 心跳判定）。
- **init 门控**：initContainer（node net 探测 mysql:3306，外部 DB 模式跳过）→ 对齐 compose `depends_on: db(service_healthy)`；Job command `npx prisma migrate deploy && node dist/prisma/seed.js`，backoffLimit=6 + ttlSecondsAfterFinished=300。
- **worker advertise**：`WORKER_ADVERTISE_HOST=http://<release>-worker`，worker 上报 baseUrl=`advertiseHost:servePort` → server 经 worker Service :4000 访问。
- **验证**：helm lint 0 错误；helm template 默认模式（14 资源齐全）+ external 模式（无 mysql，init 无 wait-db）+ values-dev 覆盖均渲染成功；抽查 DATABASE_URL 指向 vteam-mysql:3306/aiagents、configmap 密码==secret.DB_PASSWORD 一致、MODEL_CREDENTIAL_KEY 32 字符、PVC 挂载 /app/uploads|/data/keta-worker|/root、无模板残留。证据 `.omo/evidence/role-instance-separation/helm-chart.txt`。

## 2026-08-14 K8s worker 多副本注册冲突修复（WORKER_ID 唯一化）

- **根因**：chart ConfigMap 固定下发 WORKER_ID=w_<release>，worker 所有副本共享同一 ID → server 以 workerId 为主键 upsert（workers.service.ts:243 register）→ 后注册覆盖先注册，页面只显示 1 个 worker。
- **修复（零 worker 代码改动）**：WORKER_ID 移出共享 ConfigMap，改由 worker Deployment 经 downward API 注入 pod 名。选 `POD_NAME=fieldRef(metadata.name)` + `WORKER_ID="w_$(POD_NAME)"`（K8s env value 支持 $(VAR) 引用同容器先前 env）——保留 w_ 前缀协议语义，且每个 pod 全局唯一。显式 --set worker.env.workerId 时优先用该值。
- **worker 侧确认**：config.ts:95 `workerId = env.WORKER_ID || w_${hostname}`，env 值直接用无覆盖逻辑；hostname 容器内即 pod 名（天然唯一）——故 config.ts 也可作为天然兜底，但显式注入更清晰。
- **Job immutable 陷阱复现**：helm upgrade 历史 REV3 failed = "cannot patch Job spec.template: field is immutable"——改 configmap 后 init Job 也需重渲。本次 Job 已被 ttlSecondsAfterFinished=300 自动清理（delete job 返回 NotFound），无需手动删。
- **滚动替换旧 worker 行**：旧 pod 的 worker 行 30s 后由 server 健康检查自动判 offline（markStaleWorkersOffline），无需手动清理；分派只调度 online worker。
- **API 验证端口冲突**：本机 13000 被 docker compose server 占用，port-forward 绑定失败且 curl 会打到本机 compose 环境（误以为 K8s 数据）——遇此情况改走 `kubectl exec <server pod> -- node -e "fetch(...)"` 集群内验证最可靠。
- **验证实证**：2 副本 → DB workers 2 行 online 心跳双活（各自 w_<pod> 唯一）、API /api/v1/workers 2 online、worker_model_availabilities 两 worker 各 7 模型、两 worker 日志注册成功 workerId 不同。证据 `.omo/evidence/role-instance-separation/k8s-worker-replicas.txt`。

## 2026-08-14 删除离线 Worker 能力（DELETE /api/v1/workers/:id）

- **后端 remove(id)**：查 worker（404）→ 仅 offline 可删（online/degraded → 409 WORKER_ONLINE_NOT_REMOVABLE）→ `$transaction` 数组按序清理全部 workerId 外键引用后物理删除。**关键顺序**：availability/instances 硬删（软删 removedAt 不解除 FK Restrict，必须删行）→ sessions.workerId+instanceRef 置空（Session.workerId Restrict）→ agents.workerId 置空（软绑定"首选 worker"）→ worker.delete。成功后清理 workerMcpStatus/pendingCommands 内存态。
- **权限点 workers.delete**：roles.constants.ts 权限矩阵 8 资源 × 6 操作本就含 workers×delete，controller 直接 `@RequirePermission('workers.delete')`，PermissionGuard 按 `permission.split('.')` 解析 resource/action；seed admin `all:true` 简写天然放行，member `all:false` 仅 view 拒绝写——无需改权限矩阵/seed。
- **前端**：删除入口仅 `isOffline` 渲染（online 不暴露，后端 409 兜底）；ConfirmDialog 二次确认 + 确认后 invalidateQueries(['workers']) 刷新；无 workers.delete 权限禁用 + title 提示。对齐 agents 页删除确认模式。
- **Prisma $transaction mock 陷阱**：`prisma.$transaction([...])` 数组元素是 PrismaPromise（thenable）而非函数，测试 mock 里 `await op()` 会报 `TypeError: op is not a function`（2 个 remove 用例挂）——改为 `await op`（thenable await）即全绿。之前全量 1129 过是因为 remove 用例还没加。
- **K8s 部署流**：改 server 代码后需 docker build（tag vteam-worker-delete）→ push docker-hosted.ketaops.cc/xishuhq → `helm upgrade -n vteam --reuse-values --set server.image.repository=... --set server.image.tag=...`（⚠️ helm upgrade 必须带 `-n vteam`，否则报 "has no deployed releases" 误导）。
- **真实删除实证**：online 删除 → 409 行保留；offline 带关联（7 wma + 2 tgi + 1 session）删除 → workers 行消失 + wma/tgi 硬删清零 + session 保留但 worker_id/instance_ref 置空；offline 造出（scale sts --replicas=1 → 35s 判 offline）→ 删除 → 行消失；scale 回 2 后 pod 重新注册自动建新行。health/登录回归正常。
- **wget 不支持 DELETE method**：K8s 容器内（node:22-alpine 无 curl）用 `node -e "fetch(url, {method:'DELETE', headers:{Authorization}})"` 发 DELETE 最稳。
- 证据 `.omo/evidence/role-instance-separation/worker-delete.txt`。

## 2026-08-14 K8s 发消息无反应根因（vteam.ketaops.cc）

**症状**：任务 t_0000000002 发消息只有 ACK（"收到，正在处理…"）无 agent 实际回复。
**根因**：worker 上报 capabilities.baseUrl 用共享 ClusterIP 名 `http://vteam-worker:4000`；
server `resolveExecBaseUrl()` 拼出 `http://vteam-worker:4198`，而 vteam-worker ClusterIP
Service 仅暴露 4000（serve），4198（exec）未暴露 → dispatch 全部
`WorkerUnavailableException: fetch failed`。
**关键区分**：worker 心跳（worker→server）正常，但 server→worker 方向不通。
**修复**：chart statefulset-worker.yaml 新增 env
`WORKER_ADVERTISE_HOST=http://$(POD_NAME).vteam-worker-headless.<ns>.svc.cluster.local`
（每副本上报 pod 专属 headless DNS，exec 基址自动解析为同 origin :4198）；configmap 移除共享值。
**复验**：sendMessage -> ses_0008f7cb4ffeFGjDAftJ1ZYMR6 model=opencode/big-pickle (HTTP 204)，
agent 回复落库（m_0000000012）。
**通用排查顺序**：① 消息是否落库（无=接口/前端，有=dispatch）② ACK 有但无回复=dispatch
或模型失败 ③ 用 kubectl logs 查 WorkerUnavailable ④ 检查 worker 上报的 baseUrl 是否可达
（server 容器内 fetch 实测，区分 ClusterIP vs headless DNS）。
**StatefulSet 多副本部署注意**：server 对 worker 的调用必须走 pod 专属 headless DNS
（<pod>.<headless>.<ns>.svc），共享 ClusterIP 会造成负载均衡到错误副本 + 端口未暴露问题。

## 2026-08-14 SSH 私钥格式兼容问题确认（git_clone 失败根因）

- **问题真实存在**：平台下发并原样落盘的 OPENSSH 容器格式 ssh-rsa 私钥，在 worker（OpenSSH 10.3p1 + OpenSSL 3.5.7）加载报 `error in libcrypto: unsupported`（EXIT 255），git clone `Permission denied (publickey)`；转 PKCS#1 PEM 后加载/克隆均成功。密钥内容数学有效（openssl rsa -check ok / sign-verify ok），纯格式兼容问题。当前 3 个仓库凭证共享同一把 ssh-rsa 3072 私钥，全部受影响。
- **环境取证**：worker 容器 `ssh -V`=OpenSSH_10.3p1+OpenSSL 3.5.7；无 `openssl` 二进制（alpine 精简镜像），有 ssh-keygen；宿主机 8.9/3.0.2 交叉验证同样失败（文本略异：`error in libcrypto`）。
- **关键区分**：worker 自己 `ssh-keygen -t rsa` 生成的 OPENSSH key 加载**正常**——不是环境普遍禁用 ssh-rsa，而是平台这把 key 的特定容器内容在 OpenSSL 3.x 下不被支持；两把 key 容器结构解析几乎一致（仅 comment/padding 差异），根因在 libcrypto 内部。**ed25519（同为 OPENSSH 头）不受影响**。
- **worker 内 `ssh-keygen -p -m PEM` 不可用**：转换也需先加载 key，对问题 key 同样报 unsupported；worker 又无 openssl 二进制 → 修复必须纯代码解析 openssh-key-v1 容器（Node 实测可行：解 keytype=ssh-rsa → 提 n/e/d/p/q → 算 dp/dq/qinv → 构 PKCS#1 DER，DER 与 python cryptography 标准导出逐字节一致，加载 EXIT 0 指纹不变）。
- **修复建议**：worker 侧 `git-tools.ts writeTempKey` 格式归一（检测 OPENSSH 头+解容器 keytype，ssh-rsa→PKCS#1 PEM，ed25519 原样）；平台录入侧转换仅对新录入生效；长期引导 ed25519。DER 构造需单测锁定（mpint 前导零/qinv/base64 每 64 字符换行是坑）。
- **验证方法速查**：kubectl exec worker `cat /root/.keta-git-creds.json`（明文）→ node 提 key 写临时文件 → `ssh-keygen -y -f` 复现 → python cryptography 导出标准 PKCS#1 → `ssh-keygen -y -f` 对比指纹（应一致 `SHA256:iy36pU1xfSgNS1/Ir059x9BdHfzN+/vmyPyDmGNAzmc`）→ GIT_SSH_COMMAND git clone 端到端。

## [2026-08-14] worker 移除共享 ClusterIP Service（方案 B）— k8s-remove-worker-svc.txt
- **共享 Service 无实际作用**：REV 12 headless DNS 修复后，server 分派已全部走
  `WORKER_ADVERTISE_HOST=http://<pod>.<sts>-headless.<ns>.svc:4000`（exec :4198 同 origin），
  共享 `vteam-worker` ClusterIP（:4000/serve）仅剩 serve 调试入口 → 直接删除，
  serve 经 port-forward 到 pod 调试。StatefulSet `serviceName` 依赖 headless Service，
  **必须保留**。
- **helm upgrade 删 Service 不触发 worker 重启**：StatefulSet template 未变，仅 Service
  资源被 helm 回收，worker 会话/注册零中断（pods AGE 不变）。
- **port-forward 语法坑**：`kubectl port-forward sts/<sts>` 合法（转发到 ordinal 0），
  `sts/vteam-worker-0` 会 NotFound——StatefulSet 名不含 ordinal。指定副本用
  `kubectl port-forward pod/vteam-worker-1 14000:4000`。
- **本机端口被 compose 占用**：13000/13001/14000 是 `aiagents-compose-*`（docker）
  映射，查 K8s server 需另选端口（13003）转发；K8s 与 compose 环境数据独立
  （compose server 的 workers 只含 w_compose_worker）。
- **回归模式**：POST /channels/{id}/messages @ agent → 观察 ACK（"收到，正在处理…"）
  + 最终回复落库 + server 日志 `[ingress] session s_xxx status → running/idle`，
  6m 窗口无 WorkerUnavailable 即证明 headless 直连分派正常。
- **API 返回控制字符坑**：群聊历史含 Agent 多行回复，json 解析前需剥
  `[\x00-\x08\x0b\x0c\x0e-\x1f]`（server 未转义，Python json 直接报 Invalid control character）。

- **私聊历史 = serve 会话（DM 需求）**：新增 GET /channels/:id/session-history，
  workerClient.getMessages 拉 serve 全量 → 转换（user/assistant 映射、reasoning/tool parts
  保留、synthetic 剔除）；未绑定/worker 不可达回退平台表（source=db）。前端私聊页
  fetchChannelMessages 按 channel.type=private 分流，mergeSnapshotWithLive 按 id 前缀
  （serve=msg_/ses-，平台=m_）区分快照与 SSE 增量，同 sender processing 替换去重。
- **serve step-finish 不总是持久化**：历史 assistant 消息常无 step-finish part，
  status 判定不能依赖它——历史一律 sent，仅最后一条 assistant 无 finish 标 processing。
- **serve user 消息含注入 prompt**：【任务上下文】+用户文本合成单个 text part（无
  synthetic 标记），前端 ChatBubble 原样展示，与改造前行为一致，如需纯净展示需
  转换层剥离注入前缀（本期未做，保持 serve 语义透传）。

- **私聊 SSE 不刷新根因（dm-sse-no-refresh）**：handleTaskCompleted 复用**跨轮次残留**的
  processing 消息（delta 建后 agent 失败/中断未清理）→ 本轮回复写入旧消息，createdAt 保留
  旧轮时间 → SSE 广播 message.createdAt 过期 → 前端 mergeSnapshotWithLive 按 createdAt 排序
  把新回复排到历史中间 → 私聊页底部不刷新（SSE 事件接口正常返回数据，页面却不实时更新）。
  修复：dispatchForTarget 每轮 execute 前 `message.updateMany` 把目标频道该 agent 残留
  processing 标记 failed → 本轮回复新建或复用本轮 delta 的 processing，createdAt 正确。
  诊断要点：日志「流式消息终态化 message=m_526」+ DB 查 created_at 是否早于本轮 + 页面
  按文本 grep 回复定位其在历史中间而非底部。
- **failProcessingMessage 只标记最新一条 processing**：同 agent 频道内多 processing 残留时
  其余不清理；dispatch 前统一清理兜底，防终端回复复用旧残留。

- **长文本列根治（fix-text-columns）**：`value too long for column description`（VARCHAR(191)）
  源于 description 列无 @db.Text 而 DTO 无 MaxLength → 用户长文本落库 500。修复：Task/Issue/
  Project/Skill 四个 description 列改 TEXT（新迁移 20260814150000_text_columns）。排查方法：
  grep schema 中 `String?` 无 @db.Text 且对应 DTO 无 MaxLength 的列即长文本候选（title/枚举/
  短字段不动）。K8s 部署纪律：镜像重推 vteam-k8s-textfix + `helm get values` 导出完整基线
  仅改 server.image.tag → helm upgrade，init Job 自动重跑 prisma migrate deploy。

- **worker 缩容 + 内存调整纪律（main-fix-and-worker-tune）**：sts 可能被手动
  kubectl edit 过而 helm 基线仍旧值——先 `helm get values vteam -n vteam` 对比，
  别信 kubectl get sts 表面值。改资源/副本一律改 chart values.yaml + values-dev.yaml
  (生产基线覆盖源) 双处，再完整基线 -f upgrade（严禁只 --set）。worker 内存
  limit 1Gi→8Gi、requests 256Mi→1Gi（常驻 ~2Gi，requests 若低于常驻需留意驱逐）。
  chart/ 目录此前从未 git 跟踪（untracked），改 chart 时注意首次 add。
  StatefulSet 缩容不删 PVC（worker-1 遗留 PVC 保留，扩容可复用）。
  worker 注册记录 w_vteam-worker-1 变 offline 属预期（pod 已终止），不误判为故障。
