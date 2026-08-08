# Phase 4：Worker 与 opencode 集成（M4）

> 规划依据：18 篇 §8（505-549 行）+ 17 篇 git 凭证 + 用户决策 1B/2B/3B/4/5 + Oracle 实测验证 + Metis 规划验证
> 用户决策：1B（worker 独立进程）2B（git 最小链路零 DDL）3B（含前端）4（按 agent 配模型+测试≤5 次）5（宽松验收 15s）

## 目标（M4 验收标准，18 篇 §8.6）

**真实 Agent 会话跑通**：@ 触发真实 opencode 会话 → 上下文注入 → 回复回流（幂等落库）→ 产出物自动归档；worker 注册/心跳/离线自愈可用；git clone/pull 凭证最小链路可执行。

## 架构决策（已采纳验证结论）

### D1. 通信协议：全 push 三通道（Metis 必改点 1）
- 注册：`POST /workers/register`（X-Worker-Token header，与用户 JWT 隔离）
- 心跳：`POST /workers/:id/heartbeat`（10s 间隔；server 30s=3 周期超时判 offline）
- 事件上送：**`POST /worker/events` HTTP 回调**（payload 含 worker_id/event_id/type/payload/seq）——弃草案 SSE 订阅（避免长连接+重连成本，心跳已覆盖状态感知）

### D2. opencode serve 集成（Oracle 实测铁律）
- spawn：`opencode serve --port <随机> --hostname 127.0.0.1 --pure`（**--pure 必须**：去插件/MEMORY 注入/默认 agent，非 --pure input tokens 高达 7601）
- 鉴权：`OPENCODE_SERVER_PASSWORD` Basic Auth（username=opencode）
- **内容获取必须轮询** v1 `GET /session/{id}/message` 直到含 `step-finish(reason=stop)` 的 assistant 消息（SSE 不推 assistant 内容！）；abort 后无 step-finish → 完成判定不能是"有消息"
- SDK path key bug：`promptAsync` 必须传 `path:{id}`（类型声明 {sessionID} 是错的）
- directory 是 prompt_async 的 **query 参数**
- abort：`POST /session/{id}/abort` + Node AbortController 双保险
- 进程清理：spawn `detached:true` + `process.kill(-pid)` 进程组（实测无残留）
- 端口冲突：4096 已被 1.18.14 占用 → 随机端口 + 冲突重试

### D3. 会话/任务生命周期（Metis 必改点 2）
- `Session.workerId` 当前**无写入路径**（chat.service buildTrigger 只 select）→ T12 补：首次分派分配 worker → 写 workerId + instanceRef（存 opencode sessionId）+ status=active
- 无可用 worker：**报错 + agent.error**（默认不降级）；mock 降级仅作测试开关 `WORKER_MOCK_FALLBACK`（默认关）

### D4. 幂等方案（Metis 必改点 3，零 DDL 妥协）
- worker 侧 seq 单调递增 + server 内存去重 Map（TTL 环形缓冲）+ 连接内有序不重发
- **已知限制**：server 重启后内存去重丢失 → at-least-once 边界；生产级需 Phase 5 补 `(worker_id, event_id)` 唯一索引（DDL，不在 M4 承诺内）

### D5. 回复落库归属（Metis 必改点 4）
- WorkerEventIngress 只做幂等去重 + 语义转换 + RealtimeService.emit 转发
- **落库 + broadcast chat.message.new + emitFinal 归 WorkerDispatcher 回流处理器**（对齐 MockDispatcher 模板 mock-dispatcher.ts:181-208），防双写

### D6. git 凭证最小链路（决策 2B）
- 凭证来源：worker 环境变量（GIT_SSH_KEY_PATH/GIT_SSH_COMMAND 模板），不入库
- 注入方式：**GIT_SSH_COMMAND 临时 key**（`ssh -i <tempkey> -o StrictHostKeyChecking=no`），比 credential helper 简单可靠
- 不做 credentials/repo_grants 表、不做 ask 确认流/审计（下轮）
- 测试仓库：本地真实仓库（/data/git-project/* 或 xishuhq 只读 clone）；验收证据 = git clone/pull 真实输出

### D7. 模型映射（决策 4 + Metis 必改点 6）
- `Agent.defaultModelId` 存 opencode 模型 id（如 `opencode-go/deepseek-v4-flash`）→ `-m <defaultModelId>` 直接拼
- T11 替换 STATIC_AVAILABLE_MODELS（现为旧 id gpt-4o 等，agents.service.ts:46-50）→ WorkerClient.listModels 动态获取
- **旧种子数据/测试用旧 id 需同步迁移**（零 DDL 但语义变更）

### D8. 验收指标（决策 5）
- 首字 ≤15s 通过线、5s 目标线（05 篇 1.1）；总超时 60s + abort
- 轮询间隔 500ms
- 真实 opencode 调用 ≤5 次/单次运行；单元测试 100% mock WorkerClient

## 任务分解（T1-T14 + F1-F4）

- [x] T1 契约先行：worker 协议 + 事件常量
- 交付：`server/src/workers/dto/`（register/heartbeat/event 三 DTO）、`worker/src/protocol/`（双写类型）、协议契约测试
- 验收：双端类型互相序列化（契约测试绿）；`event.constants.ts` 扩展事件（session.updated/message.part.delta/task.completed/agent.status）
- 依赖：无

- [x] T2 worker 独立目录骨架 + 部署脚本
- 交付：`worker/package.json`（@opencode-ai/sdk）、`worker/src/index.ts`、`worker/scripts/start.sh`、`.env`（X-Worker-Token/端口）
- 验收：`npm run worker` 起进程；独立 `tsc` 通过；无 server 依赖
- 依赖：T1（类型）

- [x] T3 V1Runtime：spawn opencode serve
- 交付：`worker/src/runtime/opencode-server.ts`
- 验收：`--pure` 必带（非 --pure FAIL）；Basic Auth；detached + kill(-pid) 进程组清理；随机端口冲突重试
- 依赖：T2

- [x] T4 V1Driver：createSession/sendMessage/listModels/getMessages/abort
- 交付：`worker/src/driver/v1-driver.ts` + `prompt-async.ts`
- 验收：SDK path 用 {id}；轮询 500ms；step-finish(reason=stop) 判定；abort 双保险；directory query 参数
- 依赖：T3

- [x] T5 git 工具族注入 + 凭证环境
- 交付：`worker/src/git/`（GIT_SSH_COMMAND 临时 key 注入）
- 验收：真实仓库 git clone/pull 命令可执行（验证脚本输出命令回显）
- 依赖：T3

- [x] T6 worker 注册/心跳 + 事件上送
- 交付：`worker/src/client/registry-client.ts` + `event-client.ts`
- 验收：启动即注册（X-Worker-Token）；10s 心跳；事件带 (worker_id, event_id, seq) 单调递增
- 依赖：T4、T1

- [x] T7 WorkersModule（server 控制面）
- 交付：`server/src/workers/`（registry/heartbeat/scheduler/lifecycle）+ `workers.controller.ts`
- 验收：POST /workers/register 落库 + tokenHash；10s×3 心跳超时→offline；GET /workers 列表；X-Worker-Token 校验；server 重启扫描过期心跳标 offline
- 依赖：T1

- [x] T8 WorkerClient（server→worker）
- 交付：`server/src/workers/worker.client.ts`
- 验收：prompt/listModels/abort 三方法；worker offline 时报错
- 依赖：T1

- [x] T9 事件回流消费（幂等）
- 交付：`server/src/workers/worker-event.ingress.ts`
- 验收：消费 POST /worker/events；内存去重 Map(event_id)；语义转换→RealtimeService.emit（先落库后广播 realtime.service.ts:81-116）；agent.error 事件落库转发（event.constants.ts:11 现无人 emit）
- 依赖：T6、T7

- [x] T10 WorkerDispatcher 替换（核心）
- 交付：`server/src/chat/worker-dispatcher.ts` + 改 `chat.module.ts:24` useClass MockDispatcher→WorkerDispatcher
- 验收：dispatch→定位/分配 worker（T12）→doclib 上下文注入（12 篇 §8：产出物清单+最新版 32KB 截断）→下发→回流处理（落库+广播 chat.message.new+emitFinal/emitError）；无 worker 报错；产出物声明→ArtifactsService.append（artifacts.service.ts:117-125 直连）
- 依赖：T7、T8、T9

- [x] T11 agent.model 映射 + GET /models 动态化
- 交付：agents.service.ts 替换 STATIC_AVAILABLE_MODELS→WorkerClient.listModels
- 验收：available-models 返回 opencode 真实模型；defaultModelId 直接映射 -m；旧 id 种子/测试同步迁移
- 依赖：T8

- [x] T12 Session/TaskGroupInstance 生命周期
- 交付：Session.workerId/instanceRef 写入路径、status=active 更新、TaskGroupInstance.instanceId（=opencode sessionId）
- 验收：分派后 Session 行可见 workerId+instanceRef；二次 @ 复用同一 opencode 会话
- 依赖：T7、T8

- [x] T13 前端 /workers 列表页
- 交付：`web/app/(main)/workers/` + worker-list 原型迁移（prototypes/worker-list/index.tsx：状态/心跳/负载/能力 + 注册指引）
- 验收：data-testid 断言（worker-status/worker-card/worker-heartbeat）；原型逐 token 一致（18 篇 §3.1 最高约束）
- 依赖：T7

- [x] T14 群聊流式展示增强
- 交付：web 群聊：msg-thinking/msg-tool 渲染 + message.part.delta 流式文本 + SSE 断线重连（EventSource + getEventsSince 续拉 realtime.service.ts:163-180）
- 验收：真实会话 thinking/tool 事件可见、文本流式出现
- 依赖：T9、T10

## Final Verification Wave

- [x] F1 计划合规审计（oracle）
- 逐项核对决策 1B-5B；`git diff` 无 schema.prisma 变更（零 DDL 铁证）；真实调用计数 ≤5；首字 15s/5s 双线记录

- [x] F2 代码质量（oracle）
- worker/server 边界（worker 无 Nest 依赖）；V1Runtime kill(-pid) 进程组清理；SDK path:{id} bug 规避有注释；轮询/心跳间隔常量；**--pure 必带，非 --pure 直接 FAIL**

- [x] F3 QA（Playwright + 真实 serve）
- 1 次真实 serve 会话端到端（@ 触发→首字≤15s→task.completed→消息落库→artifact 归档）；SSE 时序断言（loading→thinking→tool→text→completed）；git clone/pull 真实命令输出证据；mock 单测全绿

- [x] F4 零污染
- schema.prisma 零变更；无 credentials/repo_grants 表；无 Phase 5 功能泄漏；现有测试全绿（当前 284）；worker-list 原型一致

## 并行/串行依赖
```
T1 ──┬─→ T2 → T3 ──┬─→ T4 → T6 ──→ T9 ──→ T10 ──→ T14
     │              └─→ T5 (∥T4)       ↑
     ├─→ T7 ──→ T13      T8 ←── T11
     └─→ T8 ──→ T12
```
- 关键路径：T1→T2→T3→T4→T6→T9→T10→T14→F3（8 串行步）
- 最大并行度 3：T4∥T5、T11∥T12、T13 与 T12 并行
