---
slug: agent-async-execution
status: drafting
intent: clear
review_required: false
pending-action: write .omo/plans/agent-async-execution.md
approach: worker 主动推送执行（T10 完整接线）：server 经新 HTTP 执行端点把 prompt 下发 worker，worker 驱动 serve 并上送 session.updated/message.part.delta/agent.status/task.completed 事件回流；dispatch 立即落库可配「收到」确认消息；session 状态机扩展 running/idle；私聊落库全量 parts（前端折叠卡片），群聊仅落库结论性 text；running 状态无输出 30min 判死。
---

# Draft: agent-async-execution

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

- c1-worker-exec | worker 新增 HTTP 执行端点接收 prompt 并驱动 serve + 事件上送 | active | worker/src/runtime/
- c2-server-dispatch | dispatchForTarget 改调 worker 执行端点；「收到」确认消息落库 | active | server/src/chat/worker-dispatcher.ts
- c3-server-ingress | message.part.delta 处理（私聊全量/群聊结论过滤）；session 状态机扩展 | active | server/src/workers/worker-event.ingress.ts
- c4-agent-config | agents 表新增可配「收到文案」字段 + 配置页输入 | active | server/prisma/schema.prisma + web/app/(main)/agents/
- c5-web-panel | 左侧成员面板工作状态 + 私聊折叠卡片/群聊结论渲染 | active | web/app/(main)/tasks/[id]/page.tsx + web/app/(main)/messages/[id]/page.tsx
- c6-idle-timeout | running 状态无输出 30min 判死（env 可配） | active | server/src/chat/worker-dispatcher.ts + ingress

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

- worker 执行端点端口 | 新增固定端口（如 4198，env WORKER_EXEC_PORT 可配），与 serve 随机端口解耦 | serve 端口随机（--port 0），执行端点需 server 可发现的固定地址 | 可逆（env 可配）
- 「收到」文案默认值 | 默认「收到，正在处理…」；agent 配置页可改 | 用户未指定默认文案，配置可改即兜底 | 可逆
- 判死空闲阈值 | 30 分钟（env AGENT_IDLE_TIMEOUT_MS 可配） | 用户确认 30min | 可逆
- 群聊结论判定 | 仅 step-finish 后的最终 text 落库；中间态（reasoning/tool）群聊不落库 | 用户确认「仅最终结论」 | 可逆
- 私聊全量 | reasoning/tool/text 全部 parts 落库，前端折叠展示 | 用户确认「折叠卡片」 | 可逆

## Findings (cited - path:lines)

- 当前回复一次性落库：dispatchForTarget 构建 prompt（server/src/chat/worker-dispatcher.ts:491-493），回复仅经 step-finish 后 handleTaskCompleted 落库（:630-743），watchdog 120s 超时 emitError + failedSessions 丢弃迟到回流（:1127-1155）
- session 状态仅 created/active/frozen/archived，无 running/idle（server/src/common/constants/event.constants.ts:52-59）
- worker EventSender 已就绪、事件类型全定义（worker/src/client/event-client.ts:97 send；server/src/workers/dto/worker-event.dto.ts:9-17 WORKER_EVENT_TYPES），但 T10 会话执行接线未实现：worker/src/index.ts:447、:548 注释明确 trackInstanceStart/End 与事件上送 TODO；sendAndAwait（worker/src/driver/prompt-await.ts:150）无调用方
- worker 进程无 HTTP 执行端点（端口 46267 是 serve 子进程）；server→worker 现有通道仅心跳下行 pull 命令（server/src/workers/workers.service.ts:59-115 enqueueCommand/broadcastCommand + worker/src/index.ts:75 dispatchCommands），不适合实时任务下发
- ingress 对 message.part.delta 明确忽略（server/src/workers/worker-event.ingress.ts:157-162 D2 设计），/sessions/:id/stream 端点不存在（server/src/realtime/realtime.controller.ts 仅统一 SSE）
- 前端 tasks 页已消费 agent.loading（web/app/(main)/tasks/[id]/page.tsx:862-985 loadingByAgent/errorByAgent/sessionByAgent），左侧成员面板有 loading 指示；原型 group-chat 有 MEMBERS 状态概念（docs/agent-platform/prototypes/group-chat/index.tsx:46-51）
- agents 表无「收到文案」字段；Agent DTO/配置页（web/app/(main)/agents/page.tsx:52-71 AgentItem）需扩展
- 群聊历史注入刚实现（1320cbe 之后的 buildChatHistoryContext，worker-dispatcher.ts:989）——历史上下文已含频道全部消息，方案 A 需保证执行端点下发时携带该上下文

## Decisions (with rationale)

- D1 执行链路 = 方案 A（worker 主动推）：server→worker 新增 HTTP 执行端点（POST /execute），worker 驱动 serve 并上送事件。理由：用户确认；逻辑清晰（worker 是执行者，事件流单向 push）；对齐 T10 原设计；worker 负载计数真实
- D2 收到确认 = server 落库可配文案：dispatch 时立即落 agent 消息（文案取自 agent 配置，默认「收到，正在处理…」）+ 广播 chat.message.new。理由：零延迟、确定性，不等模型；文案可配
- D3 session 状态机扩展 running/idle：worker 上送 session.updated（running=执行中，idle=空闲/完成），server ingress 落库 + SSE 广播 session.updated，前端左侧面板按状态显示「工作中」。理由：持久化（刷新不丢），用户要求按 session 状态判断
- D4 流式增量 = worker 上送 message.part.delta（含 reasoning/tool/text parts）→ server ingress 按频道类型处理：private 全量落库（streaming 消息增量更新），task_group 仅过滤出结论性 text 落库（中间态不落库）。理由：用户确认私聊看思考/工具、群聊仅结论
- D5 判死 = running 状态无任何输出（无 delta/tool 事件）超 AGENT_IDLE_TIMEOUT_MS（默认 30min）→ 标记 failed + agent.error。由 server 判死（ingress 维护 last-activity 时间戳）。理由：用户确认 30min + 按 session 状态
- D6 watchdog 语义变更：从「120s 等完成」改为「首字超时」（prompt 下发后 N 秒无任何输出才报错，如 60s），首字后进入 running 无完成超时。理由：长期任务不应有完成超时，只有空闲判死

## Scope IN

- worker：HTTP 执行端点（接收 prompt/模型/目录/上下文）+ 驱动 serve（sendMessage+awaitCompletion 接线）+ 事件上送（session.updated/message.part.delta/agent.status/task.completed）+ trackInstanceStart/End 接线
- server：dispatchForTarget 改调 worker 执行端点；「收到」确认消息；ingress 处理 delta（私聊/群聊分流）+ session 状态机 running/idle + 判死 watchdog（首字超时 + 空闲 30min）；轮询路径移除或降级为兜底
- schema：agents 表新增「收到文案」字段（如 ackMessage）；session 状态枚举扩展
- agent 配置页：新增「收到文案」输入
- 前端：左侧成员面板工作状态徽标；私聊折叠卡片（reasoning 折叠 / tool 图标状态）；群聊仅结论消息；streaming 消息增量渲染
- 测试：worker 执行端点 + 事件上送、server ingress 分流/状态机/判死、前端状态展示、端到端（收到→running→流式→完成）

## Scope OUT (Must NOT have)

- 不新建 /sessions/:id/stream 直连 serve 的流式端点（流式统一走 worker 上送 + 平台 SSE）
- 不改 serve 本身（opencode 进程）
- 不做群聊中间态推送（推理/工具不进群聊，仅最终结论）
- 不引入新依赖
- 不改 MockDispatcher 的模板回复逻辑（mock 模式保持现状）
- 不做多轮工具调用审批 UI（超出本次范围）

## Open questions

- 无（用户已确认全部 4 项决策）

## Approval gate
status: awaiting-approval
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->

- 探索已穷尽，全部 4 项 owner 决策已由用户确认（30min 判死 / 私聊折叠卡片 / 群聊仅结论 / 方案 A worker 主动推）
- 批准后动作：运行 scaffold（不带 --draft-only）创建 .omo/plans/agent-async-execution.md，填充 ## Todos 与 ## Final verification wave，交付执行
- 执行将在独立 worker 会话（如 $start-work）中进行，本会话不做任何实现
