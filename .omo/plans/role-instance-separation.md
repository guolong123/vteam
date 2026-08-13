# 角色/实例分离（role-instance-separation）

计划状态：已确认，待执行
分支建议：基于 xishuhq 默认分支新建 feature 分支

## 背景与目标

当前"团队成员"即 `agentId`，全链路按 **agent 任务内唯一** 建模（`task_agents`/`sessions`/`chat_channels` 均 `@@unique([taskId, agentId])`），无法表达"多个开发者"。

目标：**角色与实例分离**——任务创建时同一角色可添加多个实例（如 开发者-1、开发者-2），每个实例拥有独立会话/私聊/身份/被 @ 与指派。Agent 降级为"模板/类型"（提供 name/role/prompt/模型），任务实例（TaskAgent）升级为团队成员一等实体。

## 已确认决策（用户拍板）

1. **默认主 Agent = 项目经理**（任务创建页默认选中项目经理为主 Agent，替代当前的产品经理默认）
2. **实例不独立配置**：实例继承模板 agent 的 prompt/模型/权限，不做实例级覆盖（本期不加 promptOverride/defaultModelId 字段）
3. **不考虑数据兼容**：schema 约束直接改，不做存量数据迁移回填
4. **MCP 直接修改不兼容**：`notify_agent` 参数由 `agentId` 直接改为 `targetInstanceId`，不保留旧参数兼容

## 数据模型变更（单迁移）

```prisma
model TaskAgent {                       // 团队成员 = 实例
  id        String   @id                // 实例 id（ti_ 前缀）—— 团队成员唯一身份
  taskId    String   @map("task_id")
  agentId   String   @map("agent_id")   // 模板 agent（继承 name/role/prompt/model）
  alias     String?                     // 实例别名（默认「<角色中文名>-<seq>」，可自定义）
  seq       Int      @default(1)        // 同 agent 同任务内序号（服务端生成）
  joinedAt  DateTime @default(now()) @map("joined_at")
  removedAt DateTime? @map("removed_at")
  task  Task  @relation(...)
  agent Agent @relation(...)
  @@unique([taskId, agentId, seq], map: "uk_task_agents_task_agent_seq")  // 取代 [taskId, agentId]
  @@index([taskId, joinedAt], map: "idx_task_agents_task")
  @@map("task_agents")
}

model Session {
  id          String   @id
  taskId      String   @map("task_id")
  taskAgentId String   @map("task_agent_id")   // ← 新增，绑实例
  agentId     String   @map("agent_id")        // 保留（角色渲染/模型解析）
  workerId    String?
  instanceRef String?
  status      String   @default("created")
  createdAt / updatedAt ...
  @@unique([taskId, taskAgentId], map: "uk_sessions_task_agent")   // 取代 [taskId, agentId]
  @@map("sessions")
}

model ChatChannel {                     // 私聊频道按实例
  taskAgentId String? @map("task_agent_id")
  @@unique([taskId, taskAgentId], map: "uk_channels_task_agent")   // 取代 [taskId, agentId]
  @@map("chat_channels")
}

model Message {
  senderInstanceId String? @map("sender_instance_id")   // ← 新增，消息精确归属实例
  // mentions 结构升级: [{type:'agent', instanceId, agentId, name}]
}

model Task {
  mainAgentInstanceId String? @map("main_agent_instance_id")  // ← 新增，主实例（决策依据）
  // mainAgentId 保留（渲染兜底）
}

model Issue {
  assigneeInstanceId String? @map("assignee_instance_id")   // ← 新增，指派到具体实例
}
```

## 关键语义

- 运行时一切按实例：会话、私聊、@、issue 指派、主 Agent 判定（mainAgentInstanceId）、消息归属（senderInstanceId）、防冒充校验（registerExecution 按实例）
- 别名默认 `<角色中文名>-<seq>`（开发者-1/开发者-2），创建/编辑可改名；服务端生成 seq = 该 agent 该任务已用最大 seq + 1
- 身份注入（buildSystemInstructions）：【你的身份】"你是本任务的 开发者-1（实例 id: ti_x，角色: developer）"；【团队成员】实例列表（别名+角色+实例 id+主实例标注）；MAIN_AGENT_INSTRUCTION 按 当前实例==主实例 注入
- 群聊 @/notify_agent 按实例（@开发者-1 与 @开发者-2 是两个目标）
- 主 Agent：任务创建/编辑从实例列表中选择，默认项目经理

## TODOs

- [x] 1. Schema 迁移
- schema.prisma 按上述模型变更（TaskAgent 加 alias/seq/去唯一约束、Session/ChatChannel 加 taskAgentId、Message 加 senderInstanceId、Task 加 mainAgentInstanceId、Issue 加 assigneeInstanceId）
- 新建迁移目录 + migration.sql（ALTER TABLE 集合，MySQL）
- `npx prisma generate` + `npx prisma migrate dev`（或 deploy）通过
- 验证：`docker exec aiagents-compose-db mysql ... SHOW COLUMNS FROM task_agents/sessions/messages/issues` 新列存在、约束为 uk_task_agents_task_agent_seq

- [x] 2. 团队域改造（tasks.service + DTO + 主实例）
- create-task.dto：`agentIds` 改 `agents: [{agentId, alias?}]`（可重复 agentId，服务端生成 seq）
- tasks.service.create：实例批量写入（seq 生成）、mainAgentInstanceId 设置（默认规则见前端，服务端入参 mainAgentInstanceId 或 mainAgentId 兼容映射）
- updateTeam：按实例 add/remove/rejoin（dto 改 addInstances/removeInstanceIds）；remove 主实例 → 清空 mainAgentInstanceId
- start：主实例校验（mainAgentInstanceId 非空）、私信按实例解析、sysMessage 主实例名（默认别名）
- teamAgentIdsOf → 实例化助手（返回实例列表）
- toTaskDto：任务详情返回 instances: [{id, agentId, alias, seq, name, role, main:boolean}]（mainAgentId 字段仍返回但语义为主实例对应 agent）
- 相关 spec 更新（tasks.service.spec / controller.spec）
- 验证：tsc 0 错误；jest tasks 域全过；API 手工 curl 创建含双开发者实例任务成功

- [x] 3. 会话与分派（session-lifecycle + worker-dispatcher）
- session 创建/join 绑 taskAgentId（tasks.service 相关创建点同步）
- dispatchForTarget：目标解析按实例——sessionId 已绑定 taskAgentId；会话定位（dispatchAgentMention 等）从 (taskId, agentId) 改 (taskId, taskAgentId) findFirst；buildSystemInstructions 身份段注入实例（【你的身份】含实例 id+别名+角色）、团队段改实例列表（taskAgents 提取 alias/seq/agentId/name/role + 主实例标注）、MAIN_AGENT_INSTRUCTION 按 mainAgentInstanceId 判定
- dispatchAgentMention / notifyAgent 入口 targetAgentId → targetInstanceId
- 团队信息注入（上轮 main-agent-dynamic 成果）同步改为实例形状
- 相关 spec 更新（worker-dispatcher.spec）
- 验证：tsc 0 错误；jest worker-dispatcher 全过；单测覆盖"双开发者两个实例各自会话、身份段别名正确"

- [x] 4. MCP 实例化（platform-mcp.service + tools）
- notify_agent：参数 agentId → targetInstanceId（工具 schema 同步）
- issue_create/update：assigneeAgentId → assigneeInstanceId（工具 schema 同步）
- task_context：agentMembers 返回实例（{id: 实例id, alias, agentId, name, role, main}）
- assertWorkerTask：isAgentExecuting/registerExecution 按实例登记；session 定位按 taskAgentId
- 相关 spec 更新（platform-mcp.service.spec）
- 验证：tsc 0 错误；jest platform-mcp 全过

- [x] 5. 前端改造（web）
- tasks/new/page.tsx：
  - 角色卡片改"实例列表 + 添加按钮"（每角色可添加多实例，默认名 <角色中文名>-<seq>，可改名、可移除）
  - 默认主 Agent = 项目经理：INITIAL_CHECKED 含 project_manager（如 ["project_manager","developer"]），默认主 Agent=project_manager 实例；取消勾选主实例自动转移逻辑保留（转移目标优先级：项目经理→产品→…）
  - 提交：`agents: [{agentId, alias?}]` + mainAgentInstanceId
- tasks/[id]/page.tsx：成员面板按实例展示（别名+角色徽章+序号）、主 Agent 徽章挂实例、@ 候选按实例（mentionable 结构带 instanceId）
- messages/[id]/page.tsx：私聊按实例（channel.taskAgentId）
- issues 页：指派下拉按实例（开发者-1/开发者-2 分开）
- 群聊消息渲染：sender 别名（实例）
- web `npx tsc --noEmit` 0 错误 + `npm run build` 通过

- [x] 6. 端到端验证
- seed 重跑落库正常
- Playwright/浏览器（admin/admin123, :13001）：
  - 创建任务：添加两个开发者实例（开发者-1、开发者-2），默认主 Agent=项目经理，改名/移除正常
  - 任务详情：成员面板两实例独立展示，主 Agent 徽章在项目经理实例
  - 群聊：@开发者-1 触发开发者-1 会话（@开发者-2 不串扰）；或至少验证 mentionable 列表两实例分列
  - 私聊：两开发者各自独立私聊频道
  - issue：指派下拉含 开发者-1/开发者-2
  - 截图留档
- 回归：单开发者任务、issue 流转、主 Agent 职责注入（MAIN_AGENT_INSTRUCTION 仅主实例）
- 证据写 .omo/evidence/role-instance-separation/*.txt

## 范围边界

- 不实现：实例级 prompt/模型/权限覆盖（决策 2）、存量数据迁移（决策 3）、旧参数兼容（决策 4）
- 不改动：worker 容器执行协议（execute 透传 sessionId/agentId 保持，身份信息经 system 通道下发）；Agent 实体本身（模板/自定义）
- 模板 seed 中 5 角色不变（产品/项目经理/架构师/开发者/测试），仅"任务内可多实例"

## TODOs（追加需求，用户 T6 后提出）

- [x] 7. 支持任务创建后增加 agent 实例（前端详情页团队添加实例 UI）
  - 后端 updateTeam.addInstances 已就绪（T2）；前端 tasks/[id]/page.tsx 成员面板补"添加实例"入口（角色选择 + 别名，复用创建页 RoleInstanceCard 交互）→ POST updateTeam addInstances → 成员面板刷新；新增实例自动建会话绑实例（T2 已实现）
  - 验证：详情页添加开发者-2 实例成功、成员面板/群聊 @/私聊/issue 全链路按新实例可用；tsc/build 通过
- [x] 8. 群聊无 @ 消息自动路由到主 Agent
  - chat.service.createMessage：频道为 task_group 且 dto.mentions 为空（无 @）时 → 自动触发主实例（task.mainAgentInstanceId 优先，回退 mainAgentId 第一实例；未 removed 且存在会话）→ 加入 triggers（dispatched 走 dispatch+ACK）
  - 有 @ 时保持现有逻辑；私聊频道不路由（仅 task_group）
  - 验证：群聊发无 @ 消息 → 主实例 ACK + 触发执行；有 @ 消息行为不变；私聊无 @ 不触发；tsc/jest 回归

## 验证基线

- server: `npx tsc --noEmit` 0 错误；`npx jest` 全量通过
- web: `npx tsc --noEmit` 0 错误；`npm run build` 通过
- 端到端：T6 清单逐项 + 截图

## 注意点（继承智慧）

- dispatchForTarget 现有按 (taskId, agentId) findFirst 定位会话——多实例后必须按 taskAgentId 定位，否则两个开发者共享 opencode 会话上下文串扰（本次正确性核心）
- registerExecution/isAgentExecuting 按 agentId 登记——必须改实例（防冒充校验依赖）
- start 私信/remove 冻结/sysMessage 主 Agent 名等按实例解析
- 群聊 @解析（worker 侧 mention 触发）需要区分同名角色实例
- seq 生成需在事务内（并发添加同角色实例防重号）

## Final Verification Wave

- [x] F1. Plan compliance audit（对照本计划逐项核对：schema/团队域/会话分派/MCP/前端/端到端全部落地，范围外未混入）
- [x] F2. 代码质量审查（实例模型设计、按实例会话定位、防冒充校验、seq 并发）
- [x] F3. Real manual QA（真实 UI：多开发者任务创建→群聊 @→私聊→issue 指派→主 Agent=项目经理，截图留档）
- [x] F4. 验收：验证基线全绿 + 证据齐全
