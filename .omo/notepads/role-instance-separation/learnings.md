
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
