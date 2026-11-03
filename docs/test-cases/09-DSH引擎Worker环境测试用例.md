---
title: DSH 引擎 Worker 环境测试用例
id: testcases-dsh-worker
order: 9
kind: 测试用例
description: WORKER_ENGINE=dsh 试用栈专项用例——引擎选择/注册投影、会话对话主流程、流式与终态、中断、模型与角色下发、重启恢复与容错（正向+反向）
---

# DSH 引擎 Worker 环境测试用例（TC-DSH）

## 1. 模块范围与环境

本文档覆盖 **dsh 引擎 Worker**（`WORKER_ENGINE=dsh`）试用栈的专项验证，对应分支 `feat/dsh-engine`、驱动实现 `worker/src/driver/dsh-*`、引擎接缝 `worker/src/engine/dsh/*`、vendored 补丁 `worker/scripts/vendor-sdk-server.mjs`、控制面集成 `server/src/chat/worker-dispatcher.ts`（dsh 分支）。背景依据：`md-docs/dsh-worker-p0-poc-report.md`（P0 结论 C1~C6）、`.omo/explainers/dsh-team-mode-borrowings.md`。

**测试环境（2026-11-03 实测）**

| 项 | 值 |
|----|----|
| Web 入口 | http://localhost:13001 |
| API 入口 | http://localhost:13000/api/v1 |
| Worker 执行端点 | http://localhost:14000（容器 4198，dsh 无 serve 端口） |
| DSH 观察面板（dsh-inspect） | http://localhost:13080（launch token 每次启动变化，`docker logs vteam-trial-dsh-inspect \| grep token`） |
| 管理员账号 | `seed-admin` / `Admin@123456` |
| 被测团队 | `tm_0000000002`（"测试"，页面 `/teams/tm_0000000002/session`） |
| 团队成员 | 项目经理-1 `tmm_0000000008`（a_project_manager）/ 开发者-1 `tmm_0000000009`（a_developer）/ 测试-1 `tmm_0000000010`（a_tester） |
| 私聊频道 | 群聊 `c_0000000009`；PM `c_0000000010`；开发者 `c_0000000011`；测试 `c_0000000012` |
| Worker 节点 | `w_trial_dsh`（engine=dsh，status=online，maxInstances=10） |
| 模型路由 | `opencode-go/deepseek-v4.1-flash`（唯一 enabled 模型；DSH_BASE_URL=https://opencode.ai/inference/go/v1） |
| DSH 版本 | `0.2.2-alpha.2`（镜像内 `dsh --version` 实测；node v24.22.2） |
| 部署形态 | `docker compose -f /tmp/trial-compose.yml`（db/init/server/web/worker 五容器）+ `docker-compose.dsh-inspect.yml`（观察面板旁挂） |
| 认证方式 | 用户端点 JWT Bearer；worker 注册/心跳/事件用 `X-Worker-Token: compose-worker-token` |

**dsh 与 opencode 的关键差异（用例预期全部以此为准，来源 worker/src/driver/dsh-driver.ts 头注）**

| 维度 | opencode v2 | DSH（本用例口径） |
|---|---|---|
| 传输 | HTTP REST + SSE | stdio JSON-RPC（一个客户端 = 一个子进程） |
| 会话 id | serve 侧 `ses_*` | 驱动生成 `dsh-<24hex>`，`session/prompt` 隐式建会话 |
| 消息历史 | `GET …/message` | 无累积 API → 驱动自建事件镜像（跨进程依赖 `session/resume`，resume 不回放事件） |
| 完成锚点 | 消息 finish | `turn/end` + `assistant/message.usage` → 合成 `step-finish`（reason=stop 才算完成） |
| 中断 | `POST …/interrupt` | vendored `session/cancel`（turn/end kind=aborted，进程存活，会话可继续） |
| 提问/权限 | 轮询 list + reply | 服务端推送 `user-question/ask` / `approval/request` → 驱动 pending 表 |
| 模型切换 | 会话级 POST | initialize 时固定 → **换模型 = 重启运行时**（约 1s） |
| todos/agents/integrations | 原生端点 | 不存在 → 空数组（engineCapabilities 对应能力位 false） |
| persona | 每会话 system | 进程级 env `DSH_SYSTEM_PROMPT` → **每角色一个运行时进程**（DshRolePool） |
| 首字粒度 | token 级 | committed 粒度（`assistant/stream-frame` vendored 补丁补流式），首字约 5s |

**冒烟命令**

```bash
# 登录拿 token（下文 $T）
curl -s -X POST http://localhost:13000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"seed-admin","password":"Admin@123456"}'
# worker 注册状态
curl -s http://localhost:13000/api/v1/workers -H "Authorization: Bearer $T"
# 容器内核验 dsh 版本与 vendored 补丁
docker exec vteam-trial-worker-dsh dsh --version
docker exec vteam-trial-worker-dsh sh -c 'grep -c "session/cancel\|session/steer\|session/create\|assistant-stream" \
  $(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js'
# 期望输出：0.2.2-alpha.2；vendored 计数 ≥ 5（cancel/steer/create/stream-frame 均存在）
```

**执行安全提示**

- `POST /workers/:id/shutdown`、`POST /workers/:id/restart` 会真实作用于 `w_trial_dsh`，涉及用例已标注；默认仅验证 404/参数分支，真实重启用例（TC-DSH-052）执行后需确认 worker 自动重新注册。
- 发消息用例会真实调用模型（opencode-go 网关），有真实 token 消耗；反向用例优先用无副作用分支。
- 会话/消息用例会在库中留下测试数据，执行后建议归档测试团队（tm_0000000002 为专用测试团队）。
- 已知现场异常（编写时实测，作为回归锚点，见 §9）：worker 日志 `session messages -> 0 条` ×12、`等待首字超时` ×5、`persona 切换（重启运行时）` ×3、DB 会话 `s_0000000002` 停在 running。

---

## 2. 引擎选择与 Worker 注册投影（TC-DSH-001~006）

> 实现依据：`worker/src/engine/index.ts`（resolveWorkerEngine 未知值抛错）、`worker/src/index.ts:1290-1340`（能力位上报 + dsh 模式 baseUrl 不带端口）、`worker/src/index.ts:1797-1801`（dsh 健康判据不看 serve）。

### 2.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-001 | 引擎取值解析：缺省/大小写/未知值 | 正向+反向 | P0 | 无（纯函数级验证，可用 `worker/src/engine/index.ts` 的单测或临时 node 脚本调 `resolveWorkerEngine`） | 1. `resolveWorkerEngine(undefined)`<br>2. `resolveWorkerEngine('DSH')`<br>3. `resolveWorkerEngine('dsh')`<br>4. `resolveWorkerEngine('claude')` | 1. 返回 `opencode`（缺省默认）<br>2/3. 返回 `dsh`（大小写不敏感）<br>4. **抛错**，文案含"不支持的 WORKER_ENGINE"并列出合法取值 `opencode / dsh`（不静默回落） |
| TC-DSH-002 | worker 注册上报 engine=dsh 与能力位 | 正向 | P0 | 试用栈在跑；admin token | 1. `GET /api/v1/workers`<br>2. 定位 `w_trial_dsh` | 1. `capabilities.engine="dsh"`、`status="online"`、`maxInstances=10`<br>2. `capabilities.engineCapabilities` 全为 false：`steer/todos/omoConfig/planFiles/integrations/externalAgents/mcpStatusProbe/perMessageModelSwitch`（实测已确认）<br>3. `capabilities.skills` 非空（≥1，实测 8 个）<br>4. `capabilities.tools` 含 git 工具族（git_clone/pull/fetch/status/diff/log/push） |
| TC-DSH-003 | dsh 模式上报不带端口的 baseUrl | 正向 | P1 | admin token；TC-DSH-002 通过 | 1. `GET /api/v1/workers`，取 `w_trial_dsh` 的 `capabilities.baseUrl` | 1. baseUrl 形如 `http://<host>`（**无** `:端口` 后缀，dsh 无 serve 端口；server 以此拼执行端点 `<base>:4198`）<br>2. 用该 baseUrl 派发消息能到达 worker（反向佐证：若带错误端口，派发 fetch failed） |
| TC-DSH-004 | 心跳携带引擎健康（dsh 无 serve 进程） | 正向 | P1 | worker 在线 | 1. 观察连续 2 个心跳周期（≤20s）<br>2. `GET /api/v1/workers` | 1. `status` 持续 `online`，不出现 `degraded`（dsh 模式健康=运行时子进程存活，**不看** serveServer.isRunning，见 worker/src/index.ts:1797）<br>2. `lastHeartbeatAt` 每次刷新 |
| TC-DSH-005 | vendored SDK 补丁在镜像内生效 | 正向 | P0 | 容器运行中 | 1. `docker exec vteam-trial-worker-dsh dsh --version`<br>2. 在容器内 grep SDK server `lib/index.js` 的 `session/cancel`、`session/steer`、`session/create`、`assistant-stream` | 1. `0.2.2-alpha.2`<br>2. 四个标记**全部存在**（构建期 vendor-sdk-server.mjs 幂等施加；缺失=镜像构建未跑 vendor，运行期将丢失中断/流式/preset 绑定） |
| TC-DSH-006 | 容器内运行时基线（node 版本/沙箱降级） | 正向 | P2 | 容器运行中 | 1. `docker exec vteam-trial-worker-dsh node --version`<br>2. `docker exec vteam-trial-worker-dsh bwrap --version`；执行一轮对话后观察日志 `sandbox/mode` | 1. node ≥ 24.9（实测 v24.22.2；DSH 硬性要求）<br>2. bwrap 在容器内受限时自动降级为 `workspace-write`，**命令仍可执行**（P0 约束 C4），worker 不因沙箱降级而失败 |

### 2.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-053 | WORKER_ENGINE 未知值启动即失败 | 反向 | P1 | 本地可起 worker 进程（不污染试用栈） | 1. `WORKER_ENGINE=claude node dist/index.js`（本地隔离环境） | 1. 启动即退出（非零），日志含 `不支持的 WORKER_ENGINE="claude"`<br>2. 不向 server 注册（GET /workers 无新节点） |
| TC-DSH-054 | DSH_API_KEY 缺失时响亮告警并可继续启动 | 反向 | P1 | 本地隔离环境 | 1. `WORKER_ENGINE=dsh` 且不设 `DSH_API_KEY` 启动 worker | 1. 启动日志出现 `[worker/dsh] 未配置 DSH_API_KEY` 警告（不崩溃，凭据可由控制面下发）<br>2. 若模型凭据确实缺失，该 worker 接单后本轮 `等待首字超时` → agent_error（对齐 §9 异常证据） |

---

## 3. 会话与对话主流程（TC-DSH-007~014）

> 实现依据：`dsh-driver.ts` sendMessage（steer 仅在会话已活跃时使用，首轮必走 session/prompt）、`dsh-pool-driver.ts`（按角色路由 + 自愈归属）、`worker-dispatcher.ts:3014`（建会话即下发 preset+完整 persona）。

### 3.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-007 | 私聊发消息 → dsh 引擎真实回复（端到端） | 正向 | P0 | admin token；worker online；模型 enabled | 1. `POST /api/v1/channels/c_0000000011/messages`，body `{"content":"请只回复：DSH-E2E-OK"}`<br>2. 轮询 `GET /api/v1/channels/c_0000000011/messages`（每 5s，最长 120s） | 1. 201，返回 `{message, triggers}`<br>2. ≤120s 内出现 assistant 消息，正文含 `DSH-E2E-OK`（dsh committed 粒度首字约 5s，Web 用例超时口径 75s）<br>3. 消息正文**不含**系统提示词内容（persona 走进程 env，不拼用户消息——dsh-driver.ts 头注铁律） |
| TC-DSH-008 | 一轮聚合为一条消息且带 step-finish | 正向 | P0 | TC-DSH-007 已完成一轮 | 1. 查该轮 assistant 消息（库或 API）<br>2. 检查 parts | 1. 一次 turn 的多段 `assistant/message` 事件聚合为**一条** vteam 消息（commit 85c2be6 修复项）<br>2. parts 末尾含 `type="step-finish"`、`reason="stop"`、带 usage tokens（`findStepFinishPartKey` 可命中 `part:<id>`）——控制面以它判完成与落用量 |
| TC-DSH-009 | 用量（usage）随 turn 落库 | 正向 | P0 | TC-DSH-008 通过 | 1. `GET /api/v1/teams/tm_0000000002/usage`（或 model_usages 表）<br>2. 找该轮 token 记录 | 1. 存在记录且 `totalTokens>0`（DSH usage 映射：inputTokens/outputTokens/totalTokens → vteam input/output/reasoning/cache.read）<br>2. 幂等：同一轮重复回流不产生第二条（`usageCompletionDedupKey` = `part:<step-finish id>`） |
| TC-DSH-010 | 群聊 @开发者 → 点对点触发 | 正向 | P0 | admin token | 1. `POST /api/v1/channels/c_0000000009/messages`，body `{"content":"@开发者-1 请只回复：GROUP-DSH-OK"}`<br>2. 轮询群聊消息 | 1. 201 且 triggers 非空（@ 解析命中 a_developer）<br>2. ≤120s 开发者回复含 `GROUP-DSH-OK`，落群聊频道 |
| TC-DSH-011 | 多角色并发（PM/开发/测试同时接单） | 正向 | P0 | worker maxInstances≥3；admin token | 1. 并发向 c_0000000010/c_0000000011/c_0000000012 各发一条"请只回复：PAR-<角色>"<br>2. 等待三路回复（≤180s） | 1. 三路均真实回复（每角色独立运行时进程，dsh-role-pool.ts）<br>2. worker 日志出现 3 条 `会话 dsh-* 归属角色 <agentKey>（当前池内 N 个角色运行时）`<br>3. 无交叉串话（PM 会话不出现在 developer 镜像） |
| TC-DSH-012 | persona 按角色注入且不串角色 | 正向 | P0 | TC-DSH-011 通过 | 1. 对开发者问"你是谁、负责什么"<br>2. 对 PM 问同样问题 | 1. 两边回复分别体现 开发者/项目经理 岗位职责（persona 经 `DSH_SYSTEM_PROMPT` 进程 env 注入，dsh-role-pool.ts:100）<br>2. 回复不出现其它角色的人设内容 |
| TC-DSH-013 | 会话连续多轮上下文保持 | 正向 | P1 | TC-DSH-007 通过 | 1. 同频道第二条：`我上一条消息让你回复的那句话是什么？`<br>2. 等待回复 | 1. 回复能引用上一轮约定文本（同 sessionId 经镜像/DSH 侧持久化续接）<br>2. 轮次计数递增（`turn/end` data.turn ≥ 2） |
| TC-DSH-014 | 复杂任务下工具/平台 MCP 可用 | 正向 | P1 | 团队绑定任务（t_0000000002） | 1. 对开发者发：`请使用平台工具列出我的待办任务`<br>2. 观察 worker 日志与回复 | 1. 日志出现 `tool/call`→`tool/result` 事件对（平台 MCP `mcp-vteam` 经 patch `insert:` 注入）<br>2. 回复含任务信息（或明确无待办），不出现"工具不存在"类失败 |

### 3.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-055 | 发消息到不存在频道 | 反向 | P0 | admin token | 1. `POST /api/v1/channels/c_not_exist/messages`，body 合法 | 1. 404（频道不存在），错误码非 5xx<br>2. worker 无任何派发日志 |
| TC-DSH-056 | 未认证发消息 | 反向 | P0 | 无 token | 1. `POST /api/v1/channels/c_0000000011/messages`（无 Authorization） | 1. 401 `AUTH_UNAUTHORIZED`<br>2. 消息不落库 |
| TC-DSH-057 | member 角色越权发消息（权限点 chats.create） | 反向 | P1 | `seed-member`/`Admin@123456` token（若 seed 存在；否则跳过） | 1. 用 member token 发消息到 c_0000000011 | 1. 403 `FORBIDDEN_PERMISSION`（chats.create 被拒）——若 seed-member 有创建权限则按实际权限矩阵记录 |

---

## 4. 流式输出与轮次终态（TC-DSH-015~020）

> 实现依据：vendored `assistant/stream-frame`（vendor-sdk-server.mjs）、`web/hooks/use-realtime.ts`（MESSAGE_PART_DELTA）、`worker-dispatcher.ts:1090` findFinish（只认 assistant + reason=stop）、commit 0476387（turn/end 必须传 data.reason）。

### 4.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-015 | 流式增量：前端逐字渲染 | 正向 | P0 | Web 可访问；用长回复任务 | 1. Web 打开 `/teams/tm_0000000002/session`，进入开发者私聊<br>2. 发送"请写一篇 500 字微服务架构短文"<br>3. 发送后 10s 内观察消息气泡 | 1. 正文以增量方式增长（`message.part.delta` SSE 事件经 vendored `assistant/stream-frame` 转发；非整段一次性出现）<br>2. 最终全文与轮次定稿一致（定稿 = turn/end 聚合） |
| TC-DSH-016 | SSE 事件序列完整（delta → 终态） | 正向 | P0 | curl 或脚本订阅 SSE | 1. `curl -N http://localhost:13000/api/v1/events`（带 token）<br>2. 同时发一条消息，记录事件流 | 1. 依次出现 `chat.message.new`（用户消息）→ ≥1 条 `message.part.delta` → `agent.status`（终态）或会话 idle 信号<br>2. delta 载荷含 `{sessionId, messageId, part…}` 且 channelId 与频道一致 |
| TC-DSH-017 | turn/end 分类=completed → 会话回到 idle | 正向 | P0 | TC-DSH-007 通过 | 1. 完成一轮后查 `sessions` 表该会话 status<br>2. worker 日志查 `turn/end 定稿` | 1. 日志 `定稿入镜 … hasStepFinish=true`<br>2. 会话 status 回 `idle`（不再是 running/processing；commit 0476387 修复"永久卡 running"的根因回归锚点） |
| TC-DSH-018 | turn/end 分类=aborted → 不发 task.completed | 正向 | P1 | 运行中一轮（用长任务保证窗口） | 1. 发长任务，等待出现输出<br>2. `POST /api/v1/channels/c_0000000011/abort`，body `{"teamMemberId":"tmm_0000000009"}`<br>3. 查 model_usages 是否新增该轮记录 | 1. abort 返回 `{aborted:true, sessions:[…]}`<br>2. worker 日志 turn/end reason kind=aborted；合成 step-finish reason≠stop<br>3. 该轮**无** task.completed 完成落账（被取消一轮不当成功落库，dsh-event-map.ts classifyTurnEnd 口径）；部分已产出文本保留 |
| TC-DSH-019 | turn/end 分类=error → 快速失败 | 正向 | P1 | 可构造模型失败（如临时用错误凭据的独立会话） | 1. 对指定会话注入必失败轮次（错误 provider）<br>2. 观察轮询路 `findError` | 1. 轮内出现 `step-finish(reason=error)` 或 error part<br>2. 控制面在秒级返回失败（不等 120s 超时），消息状态置失败并带错误文案（`MODEL_FAILURE_FALLBACK_MESSAGE` 兜底） |
| TC-DSH-020 | 消息排序与 part 顺序稳定 | 正向 | P1 | TC-DSH-007~009 已产生多轮 | 1. `GET /api/v1/channels/c_0000000011/messages`（两页）<br>2. 检查 items id 顺序 | 1. items 按时间升序（游标分页语义）<br>2. 单条消息内 parts 顺序 = reasoning → text → step-finish（commit 8a82c6b"part 顺序混乱"修复回归锚点） |

### 4.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-058 | 模型不可用 → 首字超时判失败 | 反向 | P0 | 可将团队成员 overrideModelId 指向不可用模型（或临时停用凭据的隔离环境） | 1. 指派成员用不可用模型发消息<br>2. 等待 `WORKER_FIRST_TOKEN_TIMEOUT_MS`（300s）内观察 | 1. worker 日志 `[prompt-await] 等待首字超时` → `执行失败`<br>2. 消息状态置失败（agent_error），**不是**永久 processing（现场已出现 5 次，见 §9；本用例验证失败路径闭环） |
| TC-DSH-059 | 首字超时不会污染后续轮次 | 反向 | P1 | TC-DSH-058 刚发生 | 1. 同会话再发一条正常消息 | 1. 新一轮正常完成（pendingTurn/lastOutcome 已重置，不残留上轮终态）<br>2. 会话可继续（不因一次超时永久失效） |

---

## 5. 中断、提问与权限（TC-DSH-021~026）

> 实现依据：`dsh-driver.ts` abort（幂等 + vendored session/cancel 不可用时响亮警告）、pendingQuestions/pendingPermissions 表、`chat.controller.ts` POST /channels/:id/abort。

### 5.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-021 | 停止按钮中止运行中的轮次 | 正向 | P0 | 运行中一轮（长任务） | 1. Web 会话页点 `data-testid="session-abort"`<br>2. 观察消息区与 worker 日志 | 1. 调用 `POST /channels/:id/abort`（P5 停止按钮），日志出现 `session/cancel`<br>2. 按钮态恢复、无"停止失败"提示；**DSH 进程未被杀**（abort 语义=优雅中断） |
| TC-DSH-022 | 中断后会话可继续（keepInbox 语义） | 正向 | P0 | TC-DSH-021 通过 | 1. 中断后同会话发 `请只回复：AFTER-CANCEL-OK` | 1. 正常回复（P0 报告 gate ③：cancel 后后续 prompt 正常）<br>2. 新轮 turn 计数继续递增 |
| TC-DSH-023 | abort 幂等（无运行中会话连点） | 正向 | P1 | 无运行中会话的频道 | 1. 连续两次 `POST /channels/c_0000000011/abort` | 1. 均返回 200；第二次 `{aborted:false}`（幂等，不报错） |
| TC-DSH-024 | user-question 提问弹窗闭环 | 正向 | P1 | 触发提问的提示词（如让 agent 主动询问澄清） | 1. 发"请询问我需求细节后再继续"<br>2. `GET /api/v1/questions`（或会话页问题卡片）出现待答问题<br>3. 应答后继续 | 1. DSH `user-question/ask` 推送 → 驱动 pending 表登记 → 控制面可见（listQuestions 直读内存表）<br>2. 应答经 `replyQuestion` 回灌（answers 取每项第一个，DSH 单选）<br>3. 应答后本轮继续至完成 |
| TC-DSH-025 | approval/request 权限请求闭环 | 正向 | P1 | 触发需审批命令的提示词 | 1. 发会触发敏感命令的任务<br>2. 在权限面板批准 | 1. `approval/request` 推送 → pending 表 → 列表可见<br>2. 批准后命令执行、轮次完成；拒绝后 agent 收到拒绝并继续（不挂死） |
| TC-DSH-026 | 重复应答/未知请求幂等 | 正向 | P2 | TC-DSH-024 已应答 | 1. 对同一 requestID 再次 replyQuestion | 1. 不抛错（幂等忽略，日志 warn `不在待答列表`），会话状态不变 |

### 5.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-060 | abort 未知会话幂等不抛错 | 反向 | P1 | 无 | 1. 驱动层直调 `abort("dsh-not-exist")`（或构造频道下无会话的 abort） | 1. 幂等空操作（不向调用方抛错），日志 warn |
| TC-DSH-061 | vendored 补丁缺失时 abort 响亮降级 | 反向 | P2 | 未打 vendor 的镜像（构建期省略 vendor 步骤的隔离验证） | 1. 运行中调用 abort | 1. 日志出现 `session/cancel 不可用（vendored 插件未安装？）`<br>2. 中止未生效但**不崩溃**、轮次按超时兜底路径收口（提示需 P5 补丁） |

---

## 6. 模型 / 角色 / 技能 / 记忆 下发（TC-DSH-027~036）

> 实现依据：`dsh-driver.ts` switchRoute（换模型=重启运行时）、`worker/src/index.ts:323-390`（从控制面拉 Agent 列表生成 preset roster）、注入器 `engine/dsh/injector.ts`（凭据走 env 不落盘）。

### 6.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-027 | 模型目录仅含配置的单一路由 | 正向 | P1 | admin token | 1. `GET /api/v1/models`<br>2. 驱动层 `listModels()` | 1. API 仅 `opencode-go/deepseek-v4.1-flash` 且 enabled=true（DSH 模型清单来自 patch providers 配置，无枚举协议）<br>2. 驱动 listModels 返回同一路由（provider/model 一致性由 patch 生成器保证） |
| TC-DSH-028 | Agent 页绑定模型 → 下发生效（换模型=重启运行时） | 正向 | P0 | admin token；worker 运行中 | 1. 给开发者成员绑定当前路由（相同）→ 发消息 | 1. 相同路由**不重启**（switchRoute 幂等直返），日志无"模型路由切换"<br>2. 变体：绑定不同路由（需第二可用模型）→ 日志出现 `模型路由切换 …（重启运行时）`，重启后旧会话经 `session/resume` 恢复、新消息用新模型（info.modelID 变化） |
| TC-DSH-029 | 换模型不丢会话历史 | 正向 | P0 | TC-DSH-028 变体执行后 | 1. 换模型后同会话发"我上一句话说了什么" | 1. 能引用重启前内容（镜像虽清空，DSH 侧持久化 + resume 恢复）<br>2. 不出现 `session already exists` 死循环（resume 失败时降级新 id + 别名映射） |
| TC-DSH-030 | Agent 角色清单 → preset roster 注入 | 正向 | P0 | worker 启动完成 | 1. `GET /api/v1/agents`<br>2. worker 启动日志 | 1. 7 个内置角色（product/project_manager/architect/developer/tester/plan/librarian）<br>2. 日志 `[worker/dsh] agent-preset roster 已注入：N 个角色`（N=7；拉取失败时降级警告"退回单 persona"，不崩溃） |
| TC-DSH-031 | 建会话即绑定 preset（首 turn 前） | 正向 | P0 | TC-DSH-030 通过 | 1. 发消息触发建会话<br>2. worker 日志 | 1. 日志 `会话 dsh-* 角色=<agentKey>（persona N 字进进程 env）`<br>2. `session/create`（vendored）在建会话时绑定 preset——**不在**首 turn 后再 select（recompose 会丢 provider/model，P6 实测踩坑） |
| TC-DSH-032 | 技能下发到 worker 并可被引用 | 正向 | P1 | 技能目录存在（如 prototype-designer） | 1. `GET /api/v1/skills`<br>2. `GET /api/v1/workers` 的 capabilities.skills<br>3. 对开发者发"使用 prototype-designer 技能画一个登录页原型" | 1. 技能列表非空<br>2. worker 上报 skills 包含它（实测 8 个）<br>3. 回复体现技能产出（或明确说明），不出现"技能不存在" |
| TC-DSH-033 | 记忆 autoInject 注入系统提示 | 正向 | P2 | 团队存在启用记忆（当前 tm_0000000002 为空，需先建一条） | 1. `POST /api/v1/memories` 建一条 autoInject=true 记忆<br>2. 发消息，观察 worker 收到的 system 长度 | 1. 记忆创建成功<br>2. 该轮 system（persona）包含记忆内容（buildSystemInstructions 拼接）；无记忆时行为与现状一致 |
| TC-DSH-034 | 凭据不落盘（patch 只写变量名） | 正向 | P0 | worker 容器内 | 1. `docker exec vteam-trial-worker-dsh cat /data/vteam-worker/.vteam/dsh-profile.patch.yml`（或对应任务目录）<br>2. grep API key 值 | 1. patch 中 provider 行为 `apiKeyEnv: VTEAM_PROVIDER_*_KEY`（变量名引用）<br>2. **文件中不出现明文 key**（key 只在 spawn env；P0 约束 C3 安全要求） |
| TC-DSH-035 | 平台 MCP 鉴权头注入 | 正向 | P1 | worker 运行中 | 1. 检查 patch 的 `mcp-vteam` 条目<br>2. 发一轮触发平台工具的消息 | 1. patch 含 streamable-http url 与鉴权 headers（commit 40dec6b 修复项）<br>2. 工具调用成功（server 收到带鉴权的 MCP 请求） |
| TC-DSH-036 | dsh 能力位降级在控制面可见 | 正向 | P2 | admin token | 1. Web 打开 worker 详情/成员会话页 | 1. 前端对 `engineCapabilities` 全 false 的 worker 隐藏/降级对应功能入口（todos 面板空、无 per-message 模型切换、无 planFiles），**不报错**（server 据能力位跳过不支持端点而非猜引擎） |

### 6.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-062 | 控制面 Agent 列表不可达 → roster 降级 | 反向 | P1 | 断开 worker→server 的 /agents 拉取（隔离环境模拟） | 1. 启动 worker（server 不可达）→ 恢复 | 1. 启动日志 `GET /agents 失败 …（退回单 persona）`，worker 仍能注册<br>2. 恢复后心跳命令可重拉资源（注册后全量重注入，日志 `8 skills` 口径） |
| TC-DSH-063 | patch 条目形态回归：新增必须 insert: | 反向 | P0 | 构建期/单元级验证 | 1. 用平铺条目生成 patch 并在 DSH 上加载（P0 复现方式）<br>2. 用 `- insert:[...]` 形态加载 | 1. 平铺新增报 `patch: entry "xxx" not found`（DSH 视为修改已有条目）<br>2. insert 形态加载成功——回归锚点：注入器必须恒产 insert 形态（P0 约束 C1） |

---

## 7. 重启恢复与容错（TC-DSH-037~046）

> 实现依据：`worker-dispatcher.ts:2514`（dsh 不丢 instanceRef）、`dsh-pool-driver.ts` 自愈归属、`dsh-driver.ts` getMessages（镜像缺失→resume，绝不 404 已存在会话）、`dsh-role-pool.ts` 空闲回收（10min）。

### 7.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-037 | worker 重启后会话恢复（不新建会话） | 正向 | P0 | 已有一轮对话的成员会话（记录 instanceRef `dsh-*`） | 1. `docker restart vteam-trial-worker-dsh`（⚠️ 需谨慎：重启真实 worker，用例后确认自动重注册）<br>2. 等 worker online（≤60s）<br>3. 同会话再发一条消息 | 1. 重启后 worker 自动重新注册（日志 `注册成功`；`清除 N 个陈旧会话锁`）<br>2. 新消息**沿用同一 instanceRef**（server 对 dsh 保留会话引用，不 unbind 重建）<br>3. 回复正常（`session/resume` 接入；镜像空但 DSH 侧历史在） |
| TC-DSH-038 | worker 离线期间会话引用保留 | 正向 | P0 | TC-DSH-037 前置 | 1. 重启窗口内查 sessions 表该会话 | 1. instanceRef **不被清空**（worker-dispatcher.ts:2522：engine=dsh 只换 worker 不丢引用；opencode 才 unbind）<br>2. 日志 `[dsh] worker … 离线但保留会话引用` |
| TC-DSH-039 | 重启后无归属会话自愈路由 | 正向 | P0 | TC-DSH-037 后继续 | 1. 重启后对旧会话发消息（池内映射已丢）<br>2. worker 日志 | 1. 日志 `会话 … 无归属 → 按本轮 agent=<agentKey> 自愈登记`（sendMessage 用本轮 agent/system 重建归属）<br>2. 事件归属、getMessages、abort 全部用同一 id（不出现"定稿入镜但轮询不退出"的错位） |
| TC-DSH-040 | 对已存在 DSH 会话 prompt 报 already exists → resume 续跑 | 正向 | P1 | 旧会话在 DSH 侧持久化 | 1. 构造 worker 内存镜像丢失后对该会话发消息 | 1. 日志 `已存在于 DSH 侧 → 尝试 resume 后继续本轮`<br>2. 本轮正常完成（不判失败） |
| TC-DSH-041 | resume 撞锁 → 新会话别名降级 | 正向 | P1 | 旧会话被旧 write handle 锁住的场景（强制重启运行时后立刻发消息） | 1. 复现锁冲突后发消息 | 1. 日志 `resume 失败（…）→ 放弃旧会话上下文，用新会话继续本轮`<br>2. 新 id 形如 `<旧id>-r<hex>`，`sessionAliases` 建立映射<br>3. **system 重新注入**（新会话 systemSent=false→true，agent 不丢失角色提示词）；上层用旧 id 调 getMessages/abort 仍可用 |
| TC-DSH-042 | 镜像未命中 → resume 恢复而非 404 | 正向 | P1 | 会话在 DSH 侧存在但本进程无镜像 | 1. 调 getMessages（exec-server 轮询路） | 1. 先 ensureStarted 再 resume，返回空镜像**不抛 404**<br>2. 日志 `会话已 resume 恢复（镜像为空，历史在 DSH 侧）`<br>3. 仅当 resume 明确报 not found 才抛 404 触发重建 |
| TC-DSH-043 | 空闲角色运行时回收（TTL 10min） | 正向 | P2 | 池内有 ≥1 个角色运行时且其会话全部结束 | 1. 空置 11 分钟<br>2. worker 日志 | 1. 日志 `回收空闲角色运行时：<role>`（dsh-role-pool reapIdle）<br>2. 回收后该角色新会话能重新拉起运行时（首字延迟约 1s） |
| TC-DSH-044 | 陈旧会话锁清理（启动期） | 正向 | P1 | 前一次运行时异常退出留下锁文件 | 1. 重启 worker<br>2. 启动日志 | 1. `已清理 N 个陈旧会话锁（worker 重启 = 前一运行时已终止）`（N≥0）<br>2. 后续 resume 不报 `is already owned by an active write handle` |
| TC-DSH-045 | 停机关闭全部角色运行时 | 正向 | P1 | 池内多个角色运行时 | 1. 优雅停 worker（SIGTERM） | 1. `closeAll` 遍历关闭（Promise.allSettled 不互相阻断），子进程退出<br>2. 无僵留 dsh 进程（`docker exec … pgrep -f "dsh --profile sdk"` 为空） |
| TC-DSH-046 | dsh 会话持久化文件落盘 | 正向 | P2 | 至少完成一轮对话 | 1. `docker exec vteam-trial-worker-dsh ls /data/dsh-home/sessions/` | 1. 存在与会话对应的持久化文件（DSH 侧 resume 的数据来源）<br>2. 回归锚点：一轮试用产生一个 dsh-会话文件（防"每轮新建会话"回归，commit 7f2efc4） |

### 7.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-064 | worker 全下线时派发失败提示 | 反向 | P0 | 停掉 worker（或隔离环境无 worker） | 1. 发一条消息 | 1. 控制面快速失败并给出可操作提示（"无可用 worker：请先启动 worker 节点"），消息置失败态而非永久 processing<br>2. worker 恢复后新消息正常派发 |
| TC-DSH-065 | 多角色兜底：无归属且多运行时 → __default__ | 反向 | P1 | 池内 ≥2 角色且会话无归属（极端时序） | 1. 对无归属会话发消息/订阅事件 | 1. 日志 `用 __default__ 兜底` / `事件订阅直连兜底角色`<br>2. 轮次仍能收口（订阅未命中时轮询兜底路工作，不产生永久 processing） |
| TC-DSH-066 | 事件无归属 sessionId 丢弃不崩溃 | 反向 | P2 | 构造无 sessionId 的事件（SDK 升级新事件类型） | 1. 向驱动 consumeEvent 投递缺归属事件 | 1. 日志 warn `事件无归属，丢弃`，进程存活<br>2. 未知事件类型（default 分支）忽略不报错（DSH developer preview 常有新增） |

---

## 8. Web 界面走查（TC-DSH-047~050）

> 既有自动化：`web/e2e-trial/dsh-trial.spec.ts`（7 个用例，`pnpm test:e2e --config playwright.trial.config.ts`，headed、chrome 通道、baseURL 13001）。本节为手工走查与自动化覆盖的补充对照。

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-047 | 团队会话页可达且成员齐全 | 正向 | P0 | Web 登录 seed-admin | 1. 打开 `/teams/tm_0000000002/session` | 1. 页面标题含"测试"；成员列表含 项目经理-1/开发者-1/测试-1<br>2. 无 JS 报错、无接口 500 |
| TC-DSH-048 | 私聊回复 + 停止按钮（自动化已覆盖） | 正向 | P0 | 同 TC-DSH-007 | 1. 点开发者卡片进入私聊<br>2. 发消息等回复（75s 口径）<br>3. 长任务期间检查 `[data-testid="session-abort"]` | 1. 回复出现（testid：`message-input` 输入、`message-input-send` 发送）<br>2. 运行中停止按钮可见可点，点击后无"停止失败" |
| TC-DSH-049 | Worker 页显示 dsh 引擎信息 | 正向 | P1 | Web 登录 | 1. 打开 `/workers` | 1. 节点行显示 engine=dsh、在线状态、maxInstances、skills/tools 摘要<br>2. 无"opencode 版本"误导字段（dsh 无 opencodeVersion，上报 unknown） |
| TC-DSH-050 | 模型/技能/记忆页对 dsh 栈展示 | 正向 | P2 | Web 登录 | 1. 依次打开 `/models`、`/skills`、团队记忆 tab | 1. `/models` 显示 deepseek-v4.1-flash（v4.1 精确匹配，勿被 v4-flash 干扰）<br>2. `/skills` 列表非空且与 worker 上报一致<br>3. 记忆页可开合（当前团队可为空列表） |

---

## 9. 观察面板与日志回归锚点（TC-DSH-051~052）

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-DSH-051 | dsh-inspect 只读旁挂可用 | 正向 | P2 | dsh-inspect 容器在跑 | 1. `docker logs vteam-trial-dsh-inspect \| grep token` 取 launch token<br>2. 浏览器打开 `http://localhost:13080` 并用 token 登录 | 1. DSH 原生 Web UI 可见（共享 DSH_HOME volume 的 web profile 实例）<br>2. 能看到与 vteam 界面同源的 DSH 原始会话/事件流（对照排查用）<br>3. 它不参与 vteam 执行（旁挂只读） |
| TC-DSH-052 | 现场异常回归锚点清单（本用例为回归索引） | 回归 | P0 | 保留 2026-11-03 实测证据 | 逐项在修复后回归：① 日志 `session messages -> 0 条`（×12）：getMessages 对"尚未跑 turn 或正在跑"的会话返回空镜像的路径审计，确认不阻塞 awaitCompletion；② `等待首字超时`（×5）：模型不可用/凭据缺失的失败闭环（对齐 TC-DSH-058）；③ `persona 切换（重启运行时）`（×3）：仅允许出现在建会话阶段（sendMessage 内绝不再切换——否则事件通道失效→永久 processing，实测踩坑记录于 dsh-driver.ts）；④ DB 会话 `s_0000000002` 停在 running：turn/end 分类/终态收口回归（commit 0476387 根因修复后应自动收敛或可被 abort 解救）；⑤ `执行失败`（×5）均应有对应消息失败态落库，不允许静默吞掉 | 每项给出"修复前证据（日志计数）→ 修复后预期（计数归零或有兜底闭环）"，作为 dsh 试用栈的持续回归基线 |

---

## 10. 用例索引与执行建议

| 分组 | 编号段 | 数量 | 优先级分布 |
|------|--------|------|-----------|
| 引擎选择与注册投影 | TC-DSH-001~006 / 053~054 | 8 | P0×3 |
| 会话与对话主流程 | TC-DSH-007~014 / 055~057 | 11 | P0×6 |
| 流式输出与轮次终态 | TC-DSH-015~020 / 058~059 | 8 | P0×4 |
| 中断、提问与权限 | TC-DSH-021~026 / 060~061 | 8 | P0×2 |
| 模型/角色/技能/记忆下发 | TC-DSH-027~036 / 062~063 | 12 | P0×4 |
| 重启恢复与容错 | TC-DSH-037~046 / 064~066 | 13 | P0×4 |
| Web 界面走查 | TC-DSH-047~050 | 4 | P0×2 |
| 观察面板与回归锚点 | TC-DSH-051~052 | 2 | P0×1 |
| **合计** | — | **66** | P0×26 / P1×24 / P2×16 |

**执行顺序建议**：§2 注册投影 → §3 主流程 → §4 流式终态 → §6 下发链路 → §5 中断 → §7 恢复容错（涉及 worker 重启，放最后）→ §8/§9 走查与回归锚点。

**API 冒烟脚本**：`scripts/e2e-dsh-worker.sh`（本文档配套，覆盖 TC-DSH-001/002/005/006/007/010/021/023/027/030/034/046/051 的可自动化子集，输出 PASS/FAIL 汇总）。
