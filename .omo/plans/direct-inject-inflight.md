# 计划：fan-out 回执收敛健壮性修复（v1.0.3）

## 依据
bug-analyzer 全链分析（join/receipt/drain），已核 origin/main f7c3c02 行号。核心不变量：
**「成员的在飞履职收口（自然完成/失败/判死/显式 ACK）= 结清其名下 fan-out 凭证 → settledHook 走 drain 重查」**。

## 已拍板设计
- 自然完成（task.completed）与失败链（agent.status error / 静默耗尽 / 空闲判死）清掉该成员名下 pending 回执（ackPendingFor from=team.mainAgentMemberId to=member），依赖既有 settledHook→checkAndDrainFanOut 完成唤醒，不新增 drain 接线。
- join 报告行（sub→main answer）落库即 acked（纯审计）——消灭错误轴向的幽灵唤醒（D4）、join 行 nudge 引信（D5）、dedup 白占。
- busy-veto 分支加重查 timer（120s，进程内；pending>0 即停，防循环），修信号蒸发（D3）。
- 文案纠偏：tools.ts receiptTimeoutMin "缺省 10"→30；receipts.svc settledHook 轴向注释改口。
- 不动：dedup 永久唯一键（D6）、per-task 收敛口径（D8，保持团队全局）、多副本 durable claim。

## 涉及面
server/src/chat/message-receipts.service.ts、receipt-nudge.handler.ts（如需）、worker-dispatcher.ts（3+1 处清账挂钩）、platform-mcp.service.ts（join 行即 acked + veto 重查）、platform-mcp.tools.ts（文案）、双方 spec。

验收用例：① B 自然完成 + A answer end → 恰一 drain wake；② 完成时 PM busy → veto 后 120s re-check 唤醒；③ 失败/判死 → 清账并收敛；④ join 行不计 pending、不触发 nudge/幽灵 wake；⑤ 既有 acked/expired 语义回归。

## 交付链
PR → CI 绿 → 合并 → tag v1.0.3 → Release Images → helm 升级 → 集群验证。

---

# （历史）计划：在飞时消息直送 opencode（替代 defer-and-drain 排队）

## 背景与动机

- PR #43/v1.0.0 已上线「在飞守卫丢弃 → vteam 侧延后排队 + 注销后排干重派」（仅 server worker-dispatcher.ts）。
- 实际压测暴露问题：用户在 tm_0000000009 群 @ 开发者（tmm_0000000031，worker-37，opencode 1.19.0）后，消息被**延后**排入 `deferredDispatches`；开发者在飞执行**无终态事件**（挂死 → 无 unregister → 永不 drain），消息一直积压；最终用户手动在 opencode 里激活才有响应。vteam 侧排队依赖「注销必然发生」这一不可靠假设。
- worker-37 实测 opencode **1.19.0（V1 线）**：V1 serve 对「忙会话收到新 prompt_async」的语义 = 正在运行的 agent 循环每个 step 重读消息库，新 user 消息在下一个 step 边界被消化（de-facto steer / 顺次输入）；仅当消息恰好在 run 收尾的最后一次 DB 读取后才落库才会悬空（竞态窗口极小）。
- 用户明确要求（需求变更，覆盖 PR #43 的排队方案）：**不管在飞状态如何，消息发出即直接递给 opencode 处理，不在 vteam 侧排队**。

## 目标

同成员有在飞执行时，用户/agent 再发的群聊/私聊消息：
1. 不排 vteam 队列、不丢弃、不等注销排干；
2. 直接以「追加 prompt」方式提交到该成员**正在跑的同一个 opencode 会话**（复用 Session.instanceRef 的 ses_ id）；
3. 在飞执行完成后，server 端 activeExecutions 注销语义不变（幂等删除），后续消息恢复常规新执行派发。

## 变更面

### A. server/src/chat/worker-dispatcher.ts（移除排队，改为直送）

A1. 移除 defer-and-drain 全套：`DEFERRED_DISPATCH_TTL_MS`、`MAX_DEFERRED_DISPATCH_ITEMS`、`DeferredTeamDispatch`、`deferredDispatches` map、`deferTeamDispatch`、`drainDeferredDispatches`、`deferredKey`，以及 `unregisterExecution` 里的 drain 调用（恢复纯幂等删除）。

A2. 守卫分支（~`:2503`，现状 `if (isAgentExecuting(...).has(tmm)) { defer...; return; }`）改为：
```ts
const busyInFlight = this.isAgentExecuting(workerId, scope)?.has(teamMemberId);
if (busyInFlight) {
  logger.warn(`[dispatch-guard] …已有执行在飞，本次消息直接注入在飞会话（worker=${workerId}）`);
  // 【不】return、【不】deferTeamDispatch、【不】registerExecution
}
```
guard 后的现有流程（worker 定位、instanceRef、prompt 组装、payload 构建）全部照走；在 `workerClient.execute` 调用点（~`:2877`）分叉：
- 常规：照旧 `registerExecution` + `saveDispatchSnapshot` + 静默看门狗归属；
- busyInFlight：payload 加 `inFlight: true`；**跳过** `registerExecution`、`saveDispatchSnapshot`、静默看门狗（在飞的原执行本来就持有这些归属）；前缀回写（content.text 前缀归属）按现有前缀模板照常执行（消息归属仍落在原消息上）。

A3. 注入 prompt 文案：在 busyInFlight 分支为 finalPrompt prepend 一行给 agent 的机内说明（放现有前缀/系统说明模板区），大意：「用户在任务执行中发来新消息，已直接送达；处理完当前动作后请接着处理本条，不需等待确认」。仅注入模式携带。

A4. `unregisterExecution` 恢复不带 drain；五个注销点语义不变。

### B. worker 侧（exec-server.ts / driver / worker-protocol.ts）

B1. `worker-protocol.ts` execute payload 类型加可选字段 `inFlight?: boolean`（双端共享协议文件，保持既有注释风格：中文注释）。

B2. `exec-server.ts` `runExecution`（~`:1513`）：`payload.inFlight && payload.sessionId` 命中轻量注入路径：
- 直接 `driver.sendMessage(sessionId, {parts, directory, agent?})`（`POST /session/{id}/prompt_async?directory=`）——fire-and-forget；
- **不做** baselineIds 快照、不做 completion 轮询（prompt-await）、不做首字超时 abort；
- **不** `trackInstanceStart`/`task.completed`/instance 生命周期事件（原执行持有归属；其 completion 轮询会在最后一个 step-finish（含注入回合的回复）后统一出终态，server 端一次注销收口）；
- 失败（4xx/5xx/网络）仅 `logger.warn`，不重试；
- 返回 `202 {accepted:true}` 与常规路径同形。

B3. delta 转发：检查现有 `MessageDeltaTracker`/SSE 键控。若 delta 按 (serve 会话, opencode message id) 键控可直接复用则照常转发注入回合的流式输出（UI 有流式体验）；若按 instance/per-execution 键控则注入路径**跳过**流式（回复文本在大流终态 flush 补写时一次性落库，功能可用、体验略降），不得与原执行的 delta 流产生双写冲突。

B4. worker 不阻断：`/execute` 对同 ses 并发不设防的现状保持——注入是显式轻路径；常规两次 /execute 并发依旧靠 server 守卫避免。

### C. spec 更新

- server `worker-dispatcher.spec.ts`：删除 defer/drain 全部用例；重写守卫用例为「在飞 → 不 registerExecution、execute 仍被调（payload 含 inFlight:true 和追加前缀）、不写 dispatchSnapshot、不再排队」；补「在飞注入后原执行注销→下一条消息恢复常规新执行」。
- worker `exec-server` 相关 spec：新增 inject 用例（prompt_async 调用 shape、无 task.completed、无 completion poll）。
- 全部遵循仓库既有风格：中文注释、无 `as any`/`@ts-ignore`。

### D. 验证

- server：npx jest 全量（≥4312 用例基线）、`lint:check` 0 error、`tsc --noEmit -p tsconfig.build.json`。
- worker：worker 包 jest 全量、lint、tsc。
- 兜底冒烟（可选）：compose 栈手工跑同成员在飞 + 连发消息，观察 worker serve 收到 prompt_asyinc 且 agent 依次处理。

## 风险与边界

- **V1 竞态窗口**：消息恰落在 run 收尾最后一次消息库读取之后时，opencode 会悬空该消息（无兜底）。概率极低且不累积（等价于「消息迟一步被 agent 看见失败」）；worker 升 opencode 2.x 后可切换 inbox API（`delivery:"queue"`），本计划不做双版本兼容。
- **聚合归账**：注入回合的 assistant 输出会进入原执行的终态聚合文本（一条 task.completed 涵盖两轮），消息归属计入原消息 —— 可接受的简化，UI 上回复与消息序列顺序仍正确。
- **旧版本 worker 兼容**：`inFlight` 字段是新增——旧 worker 忽略未知字段?（需确认 exec-server 对未知字段宽容性；实现时验证）。老 worker 收到 `inFlight:true` 会走常规 full run —— 行为回退为「并发第二次 full execute」，需在 server 侧对这种历史形态保守（本 PR 发布后 worker 随 self-update 升级到同一 codeVersion，过渡窗口短，可接受）。
- PR #43 引入的排队机制随本 PR 移除（刚合并即被替代，此为用户对在线上压测行为的需求裁决）。

## Momus 评审采纳的修正（并入实现）

1. `:2875-2881` execute 失败 catch 里的 `unregisterExecution` 必须按 `!busyInFlight` 条件化——注入失败不得注销原执行的在飞登记（守卫/防冒充语义依赖它）。
2. `:2753` 第二处 `registerExecution` 同样按 `!busyInFlight` 条件化（同 A2 原则）。
3. `inFlight?: boolean` 不进 `worker-protocol.ts`：按仓库双写约定，分别在 server `ExecuteOptions`（`worker.client.ts:161`）与 worker `ExecuteRequestPayload`（`exec-server.ts:84`）同步加字段。
4. 注入分支放在 `runExecution` 的 `trackInstanceStart`/try/finally **之外**（或 `/execute` handler `:947` 处先分流），避免双重影响 load 指标、注入失败落 outer catch 以注入 payload 报 AGENT_STATUS error 误标原运行失败。
5. 注入路径 parts 组装必须复用 `prepareAttachmentParts(payload)`（否则带图消息丢图）；`busyInFlight` 且 `opencodeSessionId` 缺失的兜底 = warn + 走常规派发。
6. B3 简化：注入路径恒不建 delta tracker（原运行的 SSE/poll 会把注入回复按时流式+聚合，无体验回退）。

## 交付链

feat 分支（基于 origin/main）→ jest/lint/tsc 全绿 → PR → 合并 → tag `v1.0.1` → Release Images → helm 升级（codeVersion=v1.0.1 触发 worker-37 自更新）→ 集群验证同成员在飞连发消息直送 opencode。
