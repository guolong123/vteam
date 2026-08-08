# Draft: Phase 4 Worker 与 opencode 集成（M4）

## 背景
- 用户要求：开始 Phase 4
- 已完成：Phase 0-3（M0-M3：脚手架、基础框架、任务与群聊、Agent 与产出物）
- 下一阶段：**Phase 4「Worker 与 opencode 集成」**（18 篇 §8，技术攻坚）
- **M4**：真实 Agent 会话跑通——@ 触发真实 opencode 会话 → 上下文注入 → 回复回流 → 产出物自动归档；worker 注册/心跳/离线自愈；git clone/pull 凭证链路

## Phase 4 范围（18 篇 §8）
- **8.1 WorkersModule**：注册/心跳/调度（WorkerRegistry POST /workers/register X-Worker-Token、HealthChecker 心跳 10s/超时 30s、Scheduler 按能力+负载分配、LifecycleManager 下发）
- **8.2 OpenCodeDriver V1**：Worker 侧 V1Runtime，createOpencodeServer spawn opencode 子进程，V1Driver 接口（createSession/sendMessage/listModels/getMessages/abortSession）
- **8.3 三级 SSE 打通**：① 模型输出流（opencode 事件捕获）② worker→控制面（WorkerSseClient 订阅+幂等落库+语义转换+转发）③ 控制面→前端（chat.message.new 等事件注册）
- **8.4 上下文注入与 @ 触发分派**：定位任务组会话 → 注入上下文（群聊历史+文档库 32KB 截断）→ 下发 /prompt → Loading → task.completed 回流
- **8.5 git 凭证机制**（17 篇）：credentials/repo_grants 两表（AES-256-GCM）、git 工具族注入、SSH 凭证三方式、ask 确认流

## 关键环境发现（实测验证）
- **opencode 1.18.15 已安装**（/home/keta/.opencode/bin/opencode），非需要模拟
- **`opencode run --format json` 实测通过**：NDJSON 流式事件 6 种（step_start/text/reasoning/tool_use/step_finish/error），4.8s 返回真实结果含 token/cost——三级 SSE ① 级基础成立
- **`--session` 多轮延续实测**：同一 sessionID 二次调用 agent 记得历史（含 memory 工具读写）——会话复用可行
- **模型可用**：opencode-go/deepseek-v4-flash（默认）等 22 个真实 provider 已配置；`-m provider/model` 显式指定
- **集成方式结论**：`opencode serve`（headless HTTP+SSE 常驻）最优——多会话并发、prompt_async 异步、abort/fork/permissions 齐全；`run` 每次冷启动；`acp` 面向 IDE 单宿主。后端**自起独立 serve**（现 4096 已被 1.18.14 占用）
- **schema 已就绪（零 DDL）**：Worker（opencodeVersion/capabilities/load/status/tokenHash/lastHeartbeatAt/idx_workers_status_heartbeat）、TaskGroupInstance、Session（workerId/instanceRef/uk_sessions_task_agent）全已建
- **credentials/repo_grants 两表需新建**（Phase 4 首次 DDL，17 篇 §3）；task_events 的 eventType 是 String 列，git.op/permission.request 无需 DDL
- **DI 替换点唯一**：chat.module.ts:24 useClass MockDispatcher → WorkerDispatcher，ChatService 零改动
- **缺口**：① 服务端无事件消费者（subscribe 仅 SSE 用、onArtifactSubmitted 无人调用）② WorkerClient/WorkersModule 零存在 ③ worker 事件常量（session.updated/message.part.delta/task.completed）未定义 ④ 无 worker 侧模块

## 调研结论摘要（3 方向）
### 1. opencode 集成（explore ses_023532f12ffe...）
- run --format json 事件：step_start/text(完整块非流式)/reasoning(--thinking)/tool_use(bash 含 command/output/exit)/step_finish(tokens+cost)/error(exit 1)
- serve：POST /session、POST /session/:id/prompt_async（204）、GET /event（SSE 30+ 事件含 message.part.updated delta）、abort/fork/permissions 全支持；SDK @opencode-ai/sdk@1.18.15 createOpencodeClient
- **V1Driver 建议：serve 为底座 + @opencode-ai/sdk 客户端**；本机 4096 已有 1.18.14 serve → 后端自起独立 serve（指定端口 + OPENCODE_SERVER_PASSWORD）
- 注意：~/.config/opencode/opencode.json 插件权限全 deny，跑真实仓库任务需 serve 侧配置 permissions

### 2. 现有代码可复用（explore ses_0235310e5ffe...）
- MessageDispatcher 抽象全复用（DispatchRequest/targets/onLoading/onFinal/onError 回调）
- MockDispatcher :158-208（loading 两阶段广播/落库/chat.message.new/emitFinal）模板复用
- session 状态机（start→active :529、remove→frozen :428、archive→archived :623）；workerId/instanceRef 列就绪无写入
- Realtime emit 先落库后广播（:81-116）/subscribe（:132-156）/projectId 解析（:258-295）；SSE 端点 @Sse()（controller:48）
- Artifacts append 归档+幂等+验收联动（:117-252）；onArtifactSubmitted 运行时无订阅者 → WorkerDispatcher 直接注入调用（推荐 a 路线）
- @ 触发解析 resolveMentions（:465-507）/buildTrigger 定位 session（:510-527）/dispatch 第 5 步（:344-358）
- 需新增：worker-dispatcher.ts、WorkerClient、WorkersModule、服务端事件幂等消费者、(worker_id,event_id) 去重、EVENT_TYPES 扩展、worker DTO

### 3. Phase 4 契约 + git 凭证（explore ses_02352faacffe...）
- /workers/register（X-Worker-Token 隔离用户 JWT，09 篇 §5.3 380-405 行）；心跳 10s×3=30s 超时
- 三级 SSE：① 引擎事件 ② worker.heartbeat/instance.created/session.updated/message.part.delta/agent.status/task.completed → 幂等落库→语义转换→转发 ③ 现有 6 事件字典已对齐（无需新增前端事件）；session.stream.chunk 走独立 /sessions/:id/stream
- 上下文注入：产出物清单+文档库最新版 <doclib> 块、32KB/文档截断、成员可关闭（12 篇 §8 270-307 行）
- 互 @ 3 轮上限+循环检测（10 篇 131 行）；错误三层 tool/message/retry（FR-21）
- git 凭证：credentials（repo_url 规范化/fingerprint 脱敏/AES-256-GCM）+ repo_grants（subject_type/effect 默认 ask/repo_url 外键防孤儿）两表；git 工具族 .opencode/tools/git.ts 7 工具（clone/pull/fetch/status/diff/log 默认 allow，push 默认 ask）；注入三方式（GIT_SSH_COMMAND 临时 key/SSH_AUTH_SOCK ssh-agent+shell.env hook/credential helper）；ask 确认流（once/always/reject，always 仅同会话）；审计 task_events git.op/permission.request
- **M4 验收标准**（18 篇 §8.6）：@ 触发真实会话（首字 ≤5s）→ 上下文注入 → 回复回流（幂等落库）→ 产出物自动归档 → worker 注册/心跳/离线自愈 → git clone/pull 凭证链路可执行（ask 确认流）

## 用户决策（2026-08-07 采访确认）
- **1B：Worker 独立可部署进程**（后续可远程）——仓库内建独立 worker 模块，含独立启动入口/部署脚本；server 启动时经注册客户端连 worker（X-Worker-Token）；单机验证：手动启动 worker 进程即可跑通 M4
- **2B：git 凭证最小链路**——本轮不做 credentials/repo_grants 两表 DDL、不做 ask 确认流/审计；只做 git 工具族注入 worker（clone/pull/fetch/status/diff/log 默认 allow）+ 凭证经 worker 环境配置（GIT_SSH_COMMAND 临时 key / credential helper）临时注入，验证真实仓库 clone/pull 可执行；零 DDL
- **3B：含前端**——/workers 列表页（worker-list 原型 646 行）+ 群聊流式展示增强（真实 thinking/tool 事件 → 现有 msg-thinking/msg-tool 组件 + message.part.delta 流式文本）
- **4：按 agent 独立配置模型**——agent.model 字段映射真实 opencode 模型（`-m provider/model`），WorkerClient 经 GET /models 动态获取模型列表替换 Phase 3 静态 available-models；测试真实会话次数设上限（单次运行 ≤5 次）
- **5：宽松验收**——首字 ≤15s 通过线，5s 目标线（05 篇 1.1）

## 决策影响
- 1B → 任务含 worker 侧模块（独立进程/部署脚本/注册客户端）+ server 侧注册流程真实化（X-Worker-Token、心跳）
- 2B → 无 DDL；git 工具族注入 + 临时凭证注入；验证 git_clone/git_pull 真实执行
- 3B → 前端任务：/workers 页（状态/心跳/负载/能力 + 注册指引）+ 群聊流式（msg-thinking/msg-tool 已备，加 stream 渲染）
- 4 → agents.service 模型列表改动态；测试用 mock/上限控制成本
- 5 → 验收线 15s

## 待验证（Metis/Oracle）
- [ ] 见验证轮
