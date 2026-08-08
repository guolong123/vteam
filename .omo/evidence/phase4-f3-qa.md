# Phase 4 F3 QA 证据 — M4 真实端到端验证

> 日期：2026-08-08 | 执行：API 链路（curl）| 环境：server :3000（含 F2 修复）+ web :3001 + worker w_local_1（serve 随机端口 34975）
> 验收依据：`.omo/plans/phase4-worker-opencode.md` D8（首字 ≤15s 通过线、5s 目标线；总超时 60s；真实 opencode 调用 ≤5 次）

## 0. 执行摘要

| 项 | 结果 |
|---|---|
| Worker 链路（注册/心跳/能力上报） | ✅ 通过 |
| 真实会话端到端（首次 @） | ✅ 通过（消息落库 + SSE 广播） |
| 二次 @ 复用会话（D3） | ❌ **MAJOR**：回复不回流（静默失败） |
| 产出物自动归档（M4 验收） | ❌ 不可用（poll 路径不携带 artifacts） |
| 首字延迟（D8 ≤15s） | ❌ 25.7s（首次调用；环境含并行负载） |
| 总超时 60s + agent.error | ⚠️ 工作正常，但 60s 对复杂任务不足（实测 72s） |
| 真实 opencode 调用 | 3 次（≤5 合规） |
| F4 零污染 | ⚠️ 模型真实写文件污染仓库（已清理测试副产物） |

## 1. Worker 链路验证（API 层）

```json
GET /api/v1/workers →
[{
  "id": "w_local_1",
  "name": "local-worker",
  "opencodeVersion": "1.18.15",
  "capabilities": { "maxInstances": 1, "skills": [],
    "tools": ["git_clone","git_pull","git_fetch","git_status","git_diff","git_log","git_push"],
    "port": 34975 },
  "load": { "instances": 0 },
  "status": "online",
  "lastHeartbeatAt": "2026-08-07T18:04:13.580Z"
}]
```

- ✅ online + capabilities.port=34975（C2 修复生效）+ 7 个 git 工具（T5/T6 上报）+ opencode 1.18.15
- ⚠️ `load.instances` 恒 0：M4 已知边界——server 侧 WorkerClient 直连 serve（不经 worker 侧 v1-driver），instance-tracker 的 `trackInstanceStart` 接线点未接（learnings M4 已标注"awaiting T10 hookup"，实际 T10 未接入 worker driver）

## 2. 真实会话端到端（调用 #1：@a_product）

流程：登录(admin/admin123 → accessToken) → POST /projects（p_1786125886775_gxtzge）→ POST /projects/:pid/tasks（t_0000000006，team=[a_product]）→ POST /tasks/:id/start（in_progress）→ 定位群聊频道 c_0000000012 → POST /channels/:id/messages

```
02:05:26.211  T0 发送 @产品经理 请简要列出本任务的验收标准（3-5条）
              trigger: {agentId:a_product, sessionId:s_0000000009, status:dispatched}
02:05:26.291  SSE agent.loading phase=thinking（task scope）
02:05:26.713  SSE agent.loading phase=operating（task scope）
02:05:45.4    opencode 会话完成（4 轮 tool-calls，最终 step-finish reason=stop,
              tokens total=33267, cost=0.000346）
02:05:51.948  回复落库 m_0000000033（senderType=agent, senderId=a_product,
              content.text=完整验收标准, parts=18, status=sent）
              → SSE chat.message.new（channel:c_0000000012 scope）
```

**首字延迟 = 1786125951948 - 1786125926211 = 25737ms（25.7s）＞ 15s 通过线** ❌

**落库断言**：GET /channels/c_0000000012/messages 含 agent 消息 m_33，text 非空（5 条验收标准），parts 18 个（text/step-start/reasoning/tool/step-finish 混排），最终 step-finish reason=stop。

**SSE 时序断言**（task scope 订阅实际收到）：
```
agent.loading(thinking) → agent.loading(operating) → chat.message.new（channel scope 另订阅确认）
```
> 注：`chat.message.new` 按 **channel scope** 广播（worker-dispatcher.ts:463-467 `{type:'channel',id:channel.id}`），task scope 订阅收不到——前端 use-sse 需订阅 channel scope 或双 scope。agent.loading/agent.error 按 task scope 广播。

## 3. 二次 @ 复用会话（调用 #2：@a_product，D3 场景）— MAJOR BUG

```
02:06:39.475  发送 @产品经理 请用一句话总结你上面的回复
              trigger: {agentId:a_product, sessionId:s_0000000009, status:dispatched}  ← 复用同一会话 ✅
02:06:39.500  SSE agent.loading thinking
02:06:39.549  SSE agent.loading operating
02:06:39.599  opencode 会话消息[6] 完成（step-finish reason=stop, "真实 Agent 会话端到端跑通…零 DDL 零污染"）
              ← 回复已在 opencode 侧完成，但…
              ← server.log: [WorkerDispatcher] session s_0000000009 已由 ingress 回流落库，跳过轮询回流
              ← 无回复落库、无 chat.message.new、无 agent.error（静默失败）
```

**根因**（worker-dispatcher.ts pollForCompletion:561-594）：
`getMessages` 返回**整个会话累积历史**（含第一条的 step-finish），`findFinish` 对历史 step-finish(reason=stop) 立即命中 → `handlePolledCompletion` 检查 `completedSessions.has(s_0000000009)`=true（第一条已落库）→ 幂等跳过 + **提前 return**；且 `pollForCompletion` 在 findFinish 命中时先 `clearPendingWatchdog`（:585）→ 60s watchdog 也被清掉 → **无任何错误提示**。

**证据链**：
- serve 34975 会话 `ses_022993f15ffeHJrv0wjnbYwJTW` 消息 [5]=user prompt 已写入、[6]=assistant 回复已完成（step-finish stop）
- server.log 仅一条 DEBUG "已由 ingress 回流落库，跳过轮询回流"（18:06:39）
- 消息列表无第二条 agent 回复；SSE 无 agent.error

**影响**：D3「二次 @ 复用同一 opencode 会话」是设计能力，但复用后回复永不回流、用户无感知（静默失败）。
**修复方向（QA 记录，未改代码）**：poll 需增量检测——用 `GET /session/{id}/message?before=<lastSeenId>` 只取新增部分；或 findFinish 限定在本次 prompt 之后的消息；或记录上次已见消息 id 集合，仅对新增消息判定 finish。

## 4. 调用 #3：@a_architect（新会话 + 产出物验证）

```
02:10:47       POST /tasks/t_0000000006/team add a_architect → team=[a_architect,a_product]
02:11:05.379  发送 @架构师 请撰写一份《M4验收标准》文档
              trigger: {agentId:a_architect, sessionId:s_0000000010, status:dispatched}  ← 新会话 ✅
02:11:06      SSE agent.loading thinking → operating
02:12:07      watchdog 60s 超时 → SSE agent.error + server.log "worker 处理超时（60s 未回流）" + "自持轮询超时"
02:12:19      opencode 会话完成（5 轮 tool 调用，tokens 2888，step-finish stop）← 迟到 12s
              → 被 failedSessions 标记跳过落库（防用户同时见错误+消息，F2 MINOR 设计生效）
```

- ❌ **60s 总超时不足**：架构师 72s 完成（5 轮 tool 调用 + 与当前 opencode 会话并行共用 serve 34975 的负载）→ 超时 agent.error。D8 验收线对复杂任务偏紧。
- ❌ **产出物自动归档不可用**：`handlePolledCompletion`（:597-619）构造 payload **不含 artifacts 字段**（仅 text/parts/tokens/cost）→ `handleTaskCompleted`（:497）归档循环拿到空数组。仅 ingress task.completed 回调带 artifacts，而 worker 侧 EventSender 不上送该事件 → **自持轮询路径下产出物声明永不归档**。验证：GET /tasks/t_0000000006/artifacts → `{"items":[],"total":0}`。
- ⚠️ **模型真实写文件**：架构师在 `directory=/data/git-project/aiagents`（promptAsync directory 参数）下真实创建了 `.omo/plans/m4-acceptance-criteria.md`（5823B，模型生成的 M4 验收文档）→ **F4 零污染风险**。QA 已删除该测试副产物。工作目录需隔离（如 worker workDir）或限制写权限。

## 5. 真实 opencode 调用计数

| # | 时间 | 触发 | 会话 | 结果 |
|---|---|---|---|---|
| 1 | 02:05:26 | @a_product | ses_022993f15ffe... | ✅ 回复落库（25.7s） |
| 2 | 02:06:39 | @a_product（复用） | 同上 | ❌ 回复完成但未回流（MAJOR bug） |
| 3 | 02:11:05 | @a_architect | ses_022940d65ffe... | ❌ 72s > 60s 超时，迟到跳过 |

**总计 3 次（≤5 合规）**，重试 0 次。

## 6. 发现的问题清单

| 级别 | 问题 | 影响 | 状态 |
|---|---|---|---|
| MAJOR | 二次 @ 复用会话回复不回流（poll 命中历史 step-finish 提前 return + watchdog 被清） | 复用场景静默失败，D3 不可用 | 已定位根因，未修 |
| MAJOR | 产出物自动归档链路不可用（poll 路径不携带 artifacts） | M4「产出物自动归档」未达成 | 已定位根因，未修 |
| MINOR | 首字延迟 25.7s > 15s 通过线 | D8 性能验收未达标（含并行负载因素） | 记录 |
| MINOR | 60s 总超时对复杂任务不足（实测 72s） | 多轮 tool 调用任务易超时 | 记录 |
| MINOR | 模型在仓库目录真实写文件 | F4 零污染风险（已清理副产物） | 记录 |
| MINOR | worker load.instances 恒 0（instance-tracker 未接线） | 前端 /workers 负载展示失真 | 已知边界（M4） |

## 7. 验证通过的链路

- ✅ Worker 注册/心跳/能力上报（含 port/git 工具）——C2/M2 修复生效
- ✅ 首次 @ 真实 opencode 会话全链路：dispatch → createSession → bind（workerId+instanceRef）→ promptAsync → doclib 注入（本任务无产出物，doclib 为空）→ loading 两阶段 → 轮询检测 step-finish → 幂等落库 → 广播 → emitFinal
- ✅ 幂等防双写（completedSessions：poll 检测到已落库历史时正确跳过而非重复落库）
- ✅ watchdog 超时 → agent.error 广播（错误路径正确）
- ✅ SSE 事件时序：agent.loading(thinking→operating) → chat.message.new
- ✅ 消息落库完整性：senderType=agent / content{text,parts} / status=sent

## 8. F3 结论

**主链路（首次 @）跑通，但 F3 验收未全绿**：
- D8 首字 ≤15s 未达标（25.7s，含环境并行负载）；
- 二次 @ 复用（D3 设计能力）与产出物自动归档（M4 核心验收）两个场景确认存在功能性缺陷；
- 建议 F4 前修复：① poll 增量检测（复用会话）；② poll 路径 artifacts 提取；③ 工作目录隔离。

> 遗留：F4（零污染）需在以上修复后复核；本 QA 未改任何代码，测试数据（项目 p_1786125886775_gxtzge / 任务 t_0000000006）保留可查。
