# agent-async-execution - Work Plan

## TL;DR (For humans)

**What you'll get:** 群聊 @agent 立即收到「收到」确认（文案可配）；agent 进入后台处理，左侧成员面板显示「工作中」状态；私聊可实时看到思考/工具/正文流式消息（折叠卡片），群聊只看到最终结论；处理过程中不再有 120s 超时报错，改为「无输出 30 分钟判死」。

**Why this approach:** 采用方案 A——worker 成为执行者（T10 完整接线）：server 把 prompt 下发 worker 的 HTTP 执行端点，worker 驱动 serve 并**主动上送**事件（session.updated / message.part.delta / agent.status / task.completed），server 只消费事件落库 + SSE 推送。事件流单向 push，逻辑清晰，worker 负载计数真实。

**What it will NOT do:** 不新建 serve 直连流式端点；不改 serve（opencode 进程）；群聊不推中间态（推理/工具不进群聊，仅最终结论）；不引入新依赖；不改 MockDispatcher 模板回复。

**Effort:** Large
**Risk:** Medium - 跨 worker/server/web 三端 + 新执行端点 + 事件协议接线，依赖已有 EventSender/awaitCompletion 但从未驱动过
**Decisions to sanity-check:** 判死 30min（env 可配）；私聊全量/群聊结论分流；「收到」文案默认值「收到，正在处理…」可配；worker 执行端点固定端口 4198（env 可配）

Your next move: 已批准（start-work 已执行）。Full execution detail follows below.

---

> TL;DR (machine): Large effort, Medium risk — worker 主动推执行（T10 接线）+ 收到确认 + running/idle 状态机 + 私聊全量/群聊结论流式 + 30min 判死

## Scope
### Must have
- worker 新增 HTTP 执行端点（POST /execute）接收 prompt/模型/目录/群聊历史上下文 → 驱动 serve（sendMessage+awaitCompletion 接线）→ 上送事件（session.updated/message.part.delta/agent.status/task.completed）+ trackInstanceStart/End 接线
- server dispatchForTarget 改调 worker 执行端点；dispatch 立即落库可配「收到」确认消息 + 广播
- server ingress 处理 message.part.delta（private 全量落库 / task_group 结论过滤）+ session 状态机扩展 running/idle + 判死 watchdog（首字超时 60s + 空闲 30min）
- agents 表新增「收到文案」字段（ackMessage）+ DTO + 配置页输入 + seed 默认
- 前端：左侧成员面板工作状态徽标（session.status）；私聊折叠卡片（reasoning 折叠 / tool 图标状态）；群聊仅结论；streaming 消息增量渲染
- 测试：worker 执行端点 + 事件上送、server ingress 分流/状态机/判死、前端状态展示、端到端（收到→running→流式→完成）

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不新建 /sessions/:id/stream 直连 serve 的流式端点（流式统一走 worker 上送 + 平台 SSE）
- 不改 serve（opencode 进程）本体
- 不做群聊中间态推送（推理/工具不进群聊，仅最终结论）
- 不引入新依赖（npm 包）
- 不改 MockDispatcher 的模板回复逻辑（mock 模式保持现状）
- 不做多轮工具调用审批 UI（超出本次范围）

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + TDD 混合（关键状态机/分流用 failing-first 单测；worker 执行端点为集成测试）——jest + tsc
- Evidence: .omo/evidence/task-<N>-agent-async-execution.<ext>

## Execution strategy
### Parallel execution waves
- Wave 1（并行）：W1a worker 执行端点 + 事件上送接线；W1b schema+server 收到确认+状态机；W1c server ingress 分流+判死；W1d server dispatch 改调
- Wave 2（并行）：W2a 前端面板/折叠卡片/结论渲染；W2b agent 配置页「收到文案」
- Wave 3（串行）：端到端联调（compose 部署 + 浏览器/API 实测）
- Wave 4（并行）：F1-F4 final wave

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 worker 执行端点+事件上送 | - | 6 | 2,3,4,5 |
| 2 schema ackMessage + 收到确认 | - | 7 | 1,3,4,5 |
| 3 server ingress 分流+状态机 | 1 | 6,7,8 | 2,4,5 |
| 4 server dispatch 改调执行端点 | 1 | 6 | 2,3,5 |
| 5 判死 watchdog | 3 | 6,8 | 1,2,4 |
| 6 server 端到端单测/集成 | 1,3,4,5 | 9 | 7 |
| 7 前端配置页「收到文案」 | 2 | 9 | 6 |
| 8 前端面板/折叠卡片/结论 | 3 | 9 | 6,7 |
| 9 端到端联调部署 | 6,7,8 | - | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. worker 执行端点 + 事件上送接线（T10）
  What to do / Must NOT do: worker 新增 HTTP 执行端点（POST /execute，固定端口 WORKER_EXEC_PORT 默认 4198，基于 node:http 不引依赖）接收 {sessionId?/opencodeSessionId?/prompt(parts)/model/agent/directory/taskId/agentId/channelId}；驱动 serve：createSession（未创建时）+ sendMessage + awaitCompletion（worker/src/driver/prompt-await.ts:150 sendAndAwait 已有未接线）；awaitCompletion 的 onPoll 钩子内上送 message.part.delta 事件（payload: {taskId, agentId, sessionId, channelId, parts, status: 'streaming'}）；开始上送 session.updated(status=running)；完成上送 session.updated(status=idle) + task.completed（text/parts/tokens/cost/artifacts）+ trackInstanceStart/End 接线（worker/src/index.ts:447,:548 注释点）。不得改 serve；不得新增 npm 依赖；事件经 EventSender（worker/src/client/event-client.ts:97 send）。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 3,4
  References (executor has NO interview context - be exhaustive): worker/src/driver/prompt-await.ts:115-147 awaitCompletion（onPoll 钩子）、worker/src/driver/v1-driver.ts:178-215 sendMessage/getMessages/abort、worker/src/client/event-client.ts:97-119 send、worker/src/protocol/worker-protocol.ts WORKER_EVENT_TYPES、worker/src/index.ts:447,:548 T10 注释、server/src/workers/dto/worker-event.dto.ts:9-17 事件类型
  Acceptance criteria (agent-executable): `cd worker && ./node_modules/.bin/tsc --noEmit` 0 错误；新增 worker 单测（执行端点接收请求→驱动 serve mock→上送事件序列断言 session.updated(running)→delta→task.completed 顺序）；`./node_modules/.bin/jest --runInBand src/` 全绿
  QA scenarios (name the exact tool + invocation): happy = curl POST http://127.0.0.1:4198/execute（mock serve 注入）返回 202 + 事件序列断言；failure = 无 serve 时返回 503 错误 JSON。Evidence .omo/evidence/task-1-agent-async-execution.txt
  Commit: Y | feat(worker): T10 执行端点与事件上送接线

- [x] 2. schema ackMessage + server「收到」确认消息
  What to do / Must NOT do: agents 表新增 `ackMessage String?`（默认「收到，正在处理…」由 seed/常量兜底）；Prisma schema + migration + Agent DTO（agents.service.ts toAgentDto）+ CreateAgentDto/UpdateAgentDto/clone 透传；dispatch 时（worker-dispatcher.dispatchForTarget 或 ChatService）立即落库 agent「收到」消息（senderType=agent，content.text=ackMessage）+ 广播 chat.message.new + emitFinal 标记 ack 已发（防重复）；用户消息 @agent 触发时同步返回「收到」已落库。不得改消息表结构；「收到」不触发 dispatch 递归（ack 消息无 mentions）。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 7
  References: server/prisma/schema.prisma agents 模型、server/src/agents/agents.service.ts:309-328 toAgentDto、server/src/agents/dto/create-agent.dto.ts、update-agent.dto.ts、server/src/chat/chat.service.ts:318-384 createMessage、server/src/chat/worker-dispatcher.ts:361-396 dispatch
  Acceptance criteria (agent-executable): `cd server && ./node_modules/.bin/tsc --noEmit` 0 错误；migration 可 apply；单测：dispatch 后 message.create 被调（senderType=agent, text=ackMessage）且仅一次；chat.service.spec 适配
  QA scenarios: happy = curl POST /channels/:id/messages @agent → 响应后 GET /messages 含 agent「收到」；failure = ackMessage 为空 → 用默认文案。Evidence .omo/evidence/task-2-agent-async-execution.txt
  Commit: Y | feat(chat): 群聊 @agent 立即回「收到」（文案可配）

- [x] 3. server ingress message.part.delta 分流 + session 状态机 running/idle
  What to do / Must NOT do: ingress（worker-event.ingress.ts）对 message.part.delta 从「忽略」改为处理：解析 channelId→查 chatChannel.type——private → 落库/更新 streaming 消息（content.parts 累积，status 用 MESSAGE_STATUS.processing，按 sessionId 查最新未完成 agent 消息更新）；task_group → 只过滤结论性 text part（type=text 且非 synthetic 且非 reasoning/tool）累积，reasoning/tool 不落库；广播 MESSAGE_PART_DELTA 事件（scope=channel）；SESSION_STATUS 扩展 running/idle（event.constants.ts:52-59），session.updated 处理 mapSessionStatus 支持新值。不得改 serve；不得落库每 delta 一条消息（同一 session 聚合更新一条 processing 消息）。
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5,6,8
  References: server/src/workers/worker-event.ingress.ts:157-162（现忽略 delta）、:183-218 handleSessionUpdated、:357 mapSessionStatus、server/src/common/constants/event.constants.ts:52-59 SESSION_STATUS、:26-35 MESSAGE_STATUS、server/src/chat/worker-dispatcher.ts handleTaskCompleted 落库模式
  Acceptance criteria (agent-executable): `cd server && ./node_modules/.bin/tsc --noEmit` 0 错误；ingress.spec 新增：delta(private)→落库含 reasoning part；delta(task_group)→只落结论 text；session.updated(running/idle)→SESSION_STATUS 映射
  QA scenarios: happy = 直接 POST /api/v1/worker/events message.part.delta（private channel）→ GET messages 含 reasoning part；failure = task_group delta reasoning → 消息内容无 reasoning。Evidence .omo/evidence/task-3-agent-async-execution.txt
  Commit: Y | feat(chat): delta 流式分流（私聊全量/群聊结论）+ running/idle 状态

- [x] 4. server dispatch 改调 worker 执行端点
  What to do / Must NOT do: WorkerClient 新增 execute(worker, {parts, model, agent, directory, taskId, agentId, channelId}) → POST {worker baseUrl}:{execPort}/execute；worker-dispatcher.dispatchForTarget 从「server 直连 serve promptAsync + 自持轮询」改为「调 worker 执行端点（fire-and-forget 202）+ 事件回流经 ingress」；自持轮询（pollForCompletion）降级为兜底通道（保留但默认不启动，或仅在执行端点失败时启用）；baselineCursor/群聊历史上下文（buildChatHistoryContext）随执行请求携带。不得改 MessageDispatcher 抽象契约；不得改 ChatService 调用点。
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 6
  References: server/src/workers/worker.client.ts:128-154 promptAsync、server/src/chat/worker-dispatcher.ts:397-559 dispatchForTarget（:491-493 prompt 构建、:530-547 基线、:552-557 promptAsync 调用）、:989 buildChatHistoryContext、:765-910 pollForCompletion
  Acceptance criteria (agent-executable): `cd server && ./node_modules/.bin/tsc --noEmit` 0 错误；worker-dispatcher.spec 适配（dispatch 后 workerClient.execute 被调、不启动自持轮询）；worker.client.spec 新增 execute 请求形状断言
  QA scenarios: happy = mock worker 执行端点返回 202 → dispatch 成功无超时；failure = 端点 503 → emitError。Evidence .omo/evidence/task-4-agent-async-execution.txt
  Commit: Y | refactor(chat): dispatch 经 worker 执行端点下发（方案 A）

- [x] 5. server 判死 watchdog（首字超时 + 空闲 30min）
  What to do / Must NOT do: 新增判死：running 状态无任何输出（无 delta/tool/session 活动）超 AGENT_IDLE_TIMEOUT_MS（默认 30min，env 可配）→ session 标 failed + agent.error 广播；ingress 维护 sessionId→lastActivityAt 内存表，delta/task.completed 刷新；dispatch 时首字超时 watchdog（FIRST_TOKEN_TIMEOUT_MS 默认 60s 无任何事件）→ emitError（区别于旧 120s 完成超时）；移除/停用旧 120s 完成超时 watchdog（startPendingWatchdog 语义变更）。不得误杀：有 delta 活动即刷新 lastActivityAt。
  Parallelization: Wave 1 | Blocked by: 3 | Blocks: 6
  References: server/src/chat/worker-dispatcher.ts:1127-1155 startPendingWatchdog（现 120s 完成超时）、server/src/workers/worker-event.ingress.ts delta 处理（task 3 后）、event.constants.ts SESSION_STATUS
  Acceptance criteria (agent-executable): `cd server && ./node_modules/.bin/tsc --noEmit` 0 错误；单测：空闲超 30min（fake timers）→ failed + agent.error；有 delta → 不判死
  QA scenarios: happy = fake timers 推进超时 → session failed；failure = 周期 delta 保持 running。Evidence .omo/evidence/task-5-agent-async-execution.txt
  Commit: Y | feat(chat): running 无输出 30min 判死 + 首字超时

- [x] 6. server 端到端单测/集成（wave1 汇总）
  What to do / Must NOT do: 汇总 wave1 集成：mock worker 执行端点 + ingress 事件流 → 完整链路（dispatch→ack→delta(private/group)→task.completed→session running/idle）单测覆盖；跑全量 server jest + tsc；修复跨任务接口不一致（如事件 payload 字段名、状态枚举对齐 worker/server 双端）。不得改已完成任务的文件语义（只修接口对齐）。
  Parallelization: Wave 2 | Blocked by: 1,3,4,5 | Blocks: 9
  References: server/src 全量、worker/src/protocol/worker-protocol.ts 与 server/src/workers/dto/worker-event.dto.ts 双端契约
  Acceptance criteria (agent-executable): `cd server && ./node_modules/.bin/tsc --noEmit` 0 错误；`./node_modules/.bin/jest --runInBand src/` 全绿（无新增失败）
  QA scenarios: happy = 集成测试模拟完整事件流断言落库/广播顺序；failure = 字段不匹配报错。Evidence .omo/evidence/task-6-agent-async-execution.txt
  Commit: N（集成修复并入前序 commit 或独立 fix）

- [x] 7. 前端 agent 配置页「收到文案」
  What to do / Must NOT do: agents 配置页（web/app/(main)/agents/page.tsx）Agent 编辑表单新增「收到确认文案」输入（ackMessage，文本域，placeholder 默认文案）；AgentItem/UpdateAgentPayload 类型扩展；PATCH 提交。不得改模型管理页；不得改表单其他字段。
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 9
  References: web/app/(main)/agents/page.tsx:52-71 AgentItem、:81-91 UpdateAgentPayload、编辑表单区
  Acceptance criteria (agent-executable): `cd web && ./node_modules/.bin/tsc --noEmit` 0 错误（或 next build lint）；页面可编辑并保存 ackMessage
  QA scenarios: happy = 浏览器打开 agent 配置页编辑 ackMessage 保存 → GET /agents/:id 返回新值；failure = 留空 → 默认文案。Evidence .omo/evidence/task-7-agent-async-execution.txt
  Commit: Y | feat(web): agent 配置「收到文案」

- [x] 8. 前端成员面板工作状态 + 私聊折叠卡片 + 群聊结论渲染
  What to do / Must NOT do: tasks/[id] 左侧成员面板按 session.status（running→「工作中」徽标，idle→空闲）渲染（消费 SESSION_UPDATED 事件更新 sessionByAgent）；messages/[id] 私聊消息区渲染 streaming 消息：reasoning 折叠卡片（可展开）、tool 图标+名称+状态、text 增量更新（MESSAGE_PART_DELTA 事件）；群聊只渲染结论 text（后端已过滤，前端无需特殊处理，仅确保不显示 reasoning）。不得改任务看板；不得改频道列表逻辑。
  Parallelization: Wave 2 | Blocked by: 3 | Blocks: 9
  References: web/app/(main)/tasks/[id]/page.tsx:199-236 loadingAgentIds/processing 渲染、:862-985 loading/sessionByAgent 消费、web/app/(main)/messages/[id]/page.tsx 消息渲染、web/hooks/use-realtime.ts:48-61 RealtimeChatMessage、web/src/components/chat/msg-parts.tsx
  Acceptance criteria (agent-executable): `cd web && ./node_modules/.bin/tsc --noEmit` 0 错误；组件渲染测试或 build 通过
  QA scenarios: happy = 浏览器打开私聊页模拟 delta 事件 → reasoning 折叠卡片 + 流式 text；群聊页 → 仅结论。Evidence .omo/evidence/task-8-agent-async-execution.txt
  Commit: Y | feat(web): 成员工作状态 + 私聊折叠卡片/群聊结论

- [x] 9. 端到端联调部署（compose 13000/13001）
  What to do / Must NOT do: docker compose build + up（server/worker/web）；全链路实测：发消息@agent → 群聊「收到」→ worker 执行 → 左侧「工作中」→ 私聊流式 delta（reasoning/tool 可见）→ 群聊仅最终结论 → session idle；30min 判死用 env 缩短验证（AGENT_IDLE_TIMEOUT_MS=10s 临时配置实测后还原）。不得在未验证前推送远端。
  Parallelization: Wave 3 | Blocked by: 6,7,8 | Blocks: -
  References: docker-compose.yml、部署环境 13000/13001
  Acceptance criteria (agent-executable): 部署后实测：①@agent 群聊立即见「收到」②左侧 agent 显示「工作中」③私聊见 reasoning/tool/流式 ④群聊仅结论 ⑤完成后 idle ⑥空闲判死生效（env 缩短）
  QA scenarios: happy = curl/browser 全链路（@→收到→流式→结论→idle）；failure = 判死。Evidence .omo/evidence/task-9-agent-async-execution.txt
  Commit: N（部署验证，代码 commit 已在前序任务）

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
- 每任务独立 commit（见各任务 Commit 行）；跨任务接口对齐的 fix 独立 commit
- 提交前检查：涉及 Java 无；Node 无格式化要求；git status 确认仅本任务文件
- 遵循仓库约定式提交（feat/fix/refactor + scope）

## Success criteria
- 群聊 @agent → 立即「收到」（文案可配），agent 后台处理
- 左侧成员面板显示「工作中」（session running）→ 完成后空闲
- 私聊可见 reasoning/tool/流式 text（折叠卡片）；群聊仅最终结论
- 无 120s 完成超时报错；无输出 30min 判死 failed
- worker 事件主动上送（T10 接线完成），无 server 自持轮询依赖
- 全量测试绿：server jest + worker jest + tsc（server/worker/web）
