# token-usage-stats - Work Plan

## TL;DR (For humans)

**What you'll get:** 群聊 Token 消耗统计：① 数据链路（opencode 已有的 `step-finish` 用量 → worker 透传 model → server 落库）；② 新表 `model_usage`（成员×模型×调用粒度的用量+费用行，幂等写入）；③ 聚合接口 `GET /teams/:teamId/usage`（成员/模型/团队三层一次算好）；④ 团队 tab 下「统计」子 tab（成员表格 + 模型展开行 + 三层汇总展示）。

**Why this approach:** 用量数据今天已走到 server 门口（`TASK_COMPLETED` 事件体含 tokens+cost）然后被丢弃——最小改动是接住它，而不是另建采集链。费用直接存 opencode 的 cost（无价格表、无调价口径争议）；历史不回填（残留 step-finish 不可靠）；全员可见（纯只读，无行级过滤）。

**What it will NOT do:** 不建模型单价表、不重算费用；不回填历史；不做按日/周时间序列（表留 `createdAt` 索引，聚合接口只做累计）；不引入图表库（纯 CSS 条）；统计 tab 无 admin 门；不改 opencode 本体、不改权限矩阵；不经统计接口写数据。

**Effort:** Medium（6 个实现任务，跨 worker + server + web 三端）
**Risk:** Medium — 写入幂等是核心风险（ingress 与自轮询双生产者）；其余低风险
**Decisions to sanity-check:** ① cost 存 opencode 原值（nullable，缺失记 null 区分"未知"与"免费"）② 只记新数据 ③ 全员可见 ④ 模型存 `providerID/modelID` 单字段串 ⑤ 汇总三层全由同一 `teamTotal`/`members[]` 前端派生

Your next move: approve 后执行工作流，或先运行高精度评审（momus）。完整执行细节如下。

---

> TL;DR (machine): Medium effort, Medium risk — 群聊 token 统计（6 todos：ctx透传/store/落库/api/web + F1-F4 终验），成员×模型用量费用 + 团队 tab 统计子 tab + 三层汇总。

## Scope

### Must have

**P1 数据链路（todos 1/2/3）**
- **usage-ctx**：worker `exec-server.ts` 的 `ctx`（:1509-1514，现有 taskId/agentId/channelId/sessionId）加 `model` 字段（`payload.model` 就在 :1493 手边，`{providerID, modelID}` 原样透传）；`TASK_COMPLETED` 事件体（:1556-1565）带上 `model` → `POST /api/v1/worker/events`（已有）
- **usage-store**：`model_usage` 表（`us_` 前缀 id，经 `IdGeneratorService` + `resyncIdPrefix` 续号，对齐 Memory 模式）：`teamId` / `taskId?` / `sessionId` / `channelId` / `teamMemberId`（成员归属键）/ `agentId` / `model String`（`providerID/modelID` 组合串，缺失记固定 `'unknown'`）/ `inputTokens outputTokens reasoningTokens? cacheReadTokens? cacheWriteTokens? totalTokens Int @default(0)`（写入前 `Number.isFinite` 校验归零）/ `cost Float?`（nullable，缺失 null）/ `createdAt`；索引 `@@index([teamId, teamMemberId])`、`@@index([teamId, model])`、`@@index([createdAt])` + 幂等唯一键（见 todo 3）；迁移 + 守卫测试（照抄 memory-refcount 模板：schema 声明/基线不含/索引名一致/无回填）
- **usage-sink**：`worker-dispatcher.handleTaskCompleted`（:2567）落库——读 `payload.tokens`（`ServeTokens` 形状：total/input/output/reasoning/cache.read/write，见 worker `v1-driver.ts:79-85`）+ `payload.cost` + 上下文（teamId/teamMemberId 取 session 归属，model 取事件体）；**幂等**：DB 唯一键做请求级去重（自然键由执行者按事件体确定，如 sessionId+worker 侧 step 序号/消息 id，`upsert` 或先查后写；注释写明所选键；内存 `completedSessions` 去重保留但不依赖）；脏数据归零不断链；写入失败只 `logger.warn` 不阻断消息落库

**P2 接口（todo 4）**
- **usage-api**：`GET /teams/:teamId/usage`（全局 JwtAuthGuard + 团队成员检查：`team_user_members` 无行且非 admin → 403，抄 memories Todo2 模式；可选 `?model=` 精确过滤）。一次 `groupBy [teamMemberId, model]` 求和（走索引），内存拼成员名（TeamMember→Agent 名/Role 名联表，成员数小）；返回 `{members: [{teamMemberId, agentName, roleName, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, models: [{model, …同6字段}]}], teamTotal: {…6字段}}`；空团队返回零值结构（members: []，teamTotal 全 0/cost null→0 显示口径前端定）

**P3 前端（todo 5）**
- **usage-web**：`web/src/api/stats.ts`（抄 `memories.ts:51-91`：params/response 类型 + `statsQueryKey(teamId)` + `statsApi.summary(teamId)`）+ 新文件 `TeamStatsTab.tsx` + `TeamRightPanel.tsx` 4 处接线（:17 import、:587 union 加 `"stats"`、:948 按钮数组加 `{key:"stats",label:"统计"}`、:1334 后加 body 块传 `teamId/teamName`）
  - 表：主行按成员（成员头像名角色｜总数｜输入｜输出｜缓存读/写｜费用｜展开▾），展开行=该成员每个模型一行；样式抄 `system/roles/page.tsx:274-349`（borderCollapse separate、th 对象、cellBase、overflowX 包裹）；数字右对齐 + mono + 千分位；费用 `$`+4 位小数；比率 1 位小数
  - 三层汇总（全由 `teamTotal`/`members[]` 前端派生，无需新接口）：① 顶部四指标卡（Token 总数 / 输入输出 / 缓存命中读·写+命中率 / 总费用，副标题派生口径）；② 表尾合计行；③ Top3 成员条 + 模型分布迷你条（纯 CSS 宽度条）；`SegmentedTabs` 做 按成员/按模型 透视切换；空态 `EmptyState`（"暂无用量数据——新调用产生后自动统计"）；进入 tab 即查 + 手动刷新按钮（不做轮询）
  - 全员可见，无 admin 门

**P4 验收（todo 6）**
- **usage-e2e**：可用栈走一轮真实调用，断言数字落表进表；同一 completion 投递两次只记一行；脏 part 归零；非成员 403；汇总三层一致（卡片=表尾=Top 求和，费用同理）

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 模型单价表/费用重算；历史回填（`messages.content.parts` 残留不可靠）；时间序列聚合（只累计）；图表库新依赖；统计 tab 的 admin 门与行级过滤；opencode 本体改动；权限矩阵扩展；统计接口的任何写操作；`as any`/`@ts-ignore`/空 catch；并发双写用"先查后写"裸奔（必须唯一键）；写入失败阻断主流程

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + jest（server 单测随实现写入，对齐既有 spec 风格：worker 侧 exec-server 相关 spec、worker-dispatcher.spec、新增 usage 聚合 spec；web 用 `npm run build` + `npm run lint`，环境允许时浏览器冒烟）
- Evidence: .omo/evidence/task-<N>-token-usage-stats.<ext>（attemptDir = currentAttemptDir from 'omo ulw-loop status --json', .omo/evidence/ulw/<session>/<goalId>/a<attempt>; outside ulw-loop use .omo/evidence/）

## Execution strategy
### Parallel execution waves
> 依赖链强制小波次（store→sink/api→web→e2e 串行主干；ctx 与 store 无交集可并行）。
- **Wave 1**（2 todos，可并行）：Todo 1（usage-ctx，worker）、Todo 2（usage-store，prisma）
- **Wave 2**（2 todos，可并行）：Todo 3（usage-sink，依赖 1+2）、Todo 4（usage-api，依赖 2）
- **Wave 3**（1 todo）：Todo 5（usage-web，依赖 4）
- **Wave 4**（1 todo）：Todo 6（usage-e2e，依赖 1-5，需可运行栈）
- **Final verification wave**：F1-F4 并行

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. usage-ctx | - | 3, 6 | 2 |
| 2. usage-store | - | 3, 4, 6 | 1 |
| 3. usage-sink | 1, 2 | 6 | 4 |
| 4. usage-api | 2 | 5, 6 | 3 |
| 5. usage-web | 4 | 6 | - |
| 6. usage-e2e | 1-5 | F 波 | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. usage-ctx：worker ctx 透传 model 字段
  What to do / Must NOT do:
  - `worker/src/exec/exec-server.ts`：`ctx` 构造处（:1509-1514，现有 taskId/agentId/channelId/sessionId）新增 `model` 字段，取值 `payload.model`（:90 入参、:1493 `driver.createSession(payload.model)` 已在手边，`{providerID, modelID}` 原样透传；缺失时记固定串 `'unknown'`，与 todo 3 的未知口径一致）
  - `TASK_COMPLETED` 事件体（:1556-1565）带上 `model` → 现有 `POST /api/v1/worker/events` 通道（`worker/src/client/event-client.ts:129-138`、`worker/src/protocol/worker-protocol.ts:259` body 契约同步更新；`WORKER_EVENT_TYPES` :13-27 不动）
  - server 侧 ingress 类型（`server/src/workers/worker-event.ingress.ts:41-42` 旁）加 `model?: string` 可选字段（本 todo 只加类型不断言；消费属 todo 3）
  - 单测：exec-server 相关 spec 断言事件体含 model；缺失 payload.model 时为 `'unknown'`（或所选固定值，全链一致）
  - Must NOT：不动 `payload.model` 解析与会话创建逻辑；不动 opencode 驱动（`v1-driver.ts`/`prompt-await.ts`）；不动 server 消费逻辑（todo 3 才接）；不改事件类型枚举；不加价格相关字段
  Parallelization: Wave 1 | Blocked by: - | Blocks: 3, 6
  References (executor has NO interview context - be exhaustive): worker/src/exec/exec-server.ts:90（payload.model）、:1493（createSession）、:1509-1514（ctx）、:1536（runSendAndAwait）、:1556-1565（TASK_COMPLETED）；worker/src/protocol/worker-protocol.ts:13-27、:259；worker/src/client/event-client.ts:129-138；worker/src/driver/prompt-await.ts:344-358（buildResult 形状参考）；server/src/workers/worker-event.ingress.ts:41-42
  Acceptance criteria (agent-executable): worker 侧 tsc 通过（仓库 worker 的类型检查命令，先行确认）；相关 spec 全绿；事件体 JSON 含 `model` 字段
  QA scenarios (name the exact tool + invocation): happy——mock payload.model 断言 ctx.model 与事件体一致；failure——缺失 model 时断言固定 `'unknown'`。Evidence .omo/evidence/task-1-token-usage-stats.txt
  Commit: Y | feat(usage): worker 事件透传模型标识

- [x] 2. usage-store：model_usage 表 + 迁移 + 守卫测试
  What to do / Must NOT do:
  - `server/prisma/schema.prisma` 新增 `model ModelUsage`（对齐 Memory 模型模式）：`id String @id`（us_ 前缀，服务层 IdGeneratorService 生成，`onModuleInit` 用 `resyncIdPrefix` 续号）；`teamId String @map("team_id")`；`taskId String? @map("task_id")`；`sessionId String @map("session_id")`；`channelId String @map("channel_id")`；`teamMemberId String @map("team_member_id")`；`agentId String @map("agent_id")`；`model String`（`providerID/modelID` 组合串）；`inputTokens/outputTokens/reasoningTokens/cacheReadTokens/cacheWriteTokens/totalTokens Int @default(0)`；`cost Float?`（nullable）；`createdAt DateTime @default(now()) @map("created_at")`。索引：`@@index([teamId, teamMemberId], map:"idx_usage_team_member")`、`@@index([teamId, model], map:"idx_usage_team_model")`、`@@index([createdAt], map:"idx_usage_created")`；`@@map("model_usages")`。relations：一律软关联（只存 id，不建 FK，避免跨域耦合；注释写明）
  - 生成迁移：`cd server && npx prisma migrate dev --name model_usage`（若无 DB 则手工按先例格式编写，仅 `CREATE TABLE` + 索引，无回填）；`npx prisma generate`
  - 新建守卫测试（照抄 `server/src/prisma/memory-refcount.migration.spec.ts` 结构）：schema 声明/基线不含/索引名一致/迁移无 UPDATE
  - Must NOT：不加 price/单价列；不建 FK；不回填历史；不动 Model/Message/Session 既有模型；不引入 Prisma enum
  Parallelization: Wave 1 | Blocked by: - | Blocks: 3, 4, 6
  References (executor has NO interview context - be exhaustive): server/prisma/schema.prisma:771-786（Model 模型风格）、:379-414（Message）、:290-310（TaskEvent metadata Json 参考）；server/src/prisma/memory-refcount.migration.spec.ts（守卫模板逐条照抄）；server/prisma/migrations/20261009010000_memory_refcount/migration.sql（迁移格式先例）；server/src/common/id-generator.ts:42；server/src/workers/session-lifecycle.service.ts:47-53（resyncIdPrefix 用法）
  Acceptance criteria (agent-executable): `cd server && npx prisma migrate status` up to date（或 validate+generate 通过）；`npx tsc --noEmit` 通过；守卫 spec 全绿
  QA scenarios (name the exact tool + invocation): happy——迁移生成且 deploy 幂等；failure——向迁移注入 UPDATE 断言守卫变红。Evidence .omo/evidence/task-2-token-usage-stats.txt
  Commit: Y | feat(usage): 用量记录表模型与迁移

- [x] 3. usage-sink：handleTaskCompleted 落库（含幂等）
  What to do / Must NOT do:
  - `server/src/chat/worker-dispatcher.ts` `handleTaskCompleted`（:2567）：从 payload 读 `tokens`（`ServeTokens` 形状 total/input/output/reasoning/cache.read/write——worker `v1-driver.ts:79-85` 为准，`Number.isFinite` 逐字段校验归零）+ `cost`（number 则存，否则 null）+ 上下文（teamId/teamMemberId/sessionId/channelId/taskId 从归属解析，model 取事件体 `model` 缺失记 `'unknown'`，与 todo 1 一致）
  - **幂等（红线）**：DB 唯一键做请求级去重——自然键建议 `sessionId + worker 侧 step 序号/消息 id`（先读事件体实际字段再定，`upsert` 或先查后写二选一，并在代码注释写明所选键与理由）；内存 `completedSessions`（:2582-2589）保留但不作为唯一防线；ingress 路径与自轮询路径（:3229-3268）走同一写入函数
  - 写入失败只 `logger.warn`，绝不阻断消息落库（:2690-2720 的 `prisma.message.create` 优先）
  - 单测扩展 `worker-dispatcher.spec.ts`：同一 completion 投递两次只记一行；脏 part（缺字段/NaN/非数字）归零不断链；写入抛错时消息仍落库；model 缺失记 `'unknown'`
  - Must NOT：不动 `completedSessions` 既有语义；不动 text/parts/artifacts 消费；不信任 cost 做任何计算（原样存）；不在此 todo 建聚合逻辑；不用"先查后写"裸奔并发（必须唯一键兜底）
  Parallelization: Wave 2 | Blocked by: 1, 2 | Blocks: 6
  References (executor has NO interview context - be exhaustive): server/src/chat/worker-dispatcher.ts:835（payload 形状）、:851-866（findFinish）、:2567（handleTaskCompleted 死端点）、:2582-2589（completedSessions）、:2690-2720（消息落库）、:2816-2819（normalizeParts）、:3229-3268（自轮询生产者）；server/src/chat/message-parts.ts:14-21；server/src/workers/worker-event.ingress.ts:675-712；worker/src/driver/v1-driver.ts:79-85（ServeTokens 权威形状）
  Acceptance criteria (agent-executable): `cd server && npm run test` 全绿（含新增幂等/脏数据用例）；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy——jest 断言双投递单行、脏数据归零；failure——mock prisma 写入抛错断言消息落库不受影响。Evidence .omo/evidence/task-3-token-usage-stats.txt
  Commit: Y | feat(usage): 完成事件用量落库

- [x] 4. usage-api：GET /teams/:teamId/usage 聚合接口
  What to do / Must NOT do:
  - 新建 `server/src/usage/`（`usage.controller.ts` + `usage.service.ts` + `usage.module.ts`，`app.module.ts` 注册；参考 `memories.module.ts` 注册模式）：`GET /teams/:teamId/usage`，全局 JwtAuthGuard + 团队成员检查（`team_user_members` 无行且非 admin → 403，抄 memories Todo2 的成员过滤模式与 `admin-permission.ts` 谓词；可选 `?model=` 精确过滤）
  - service：一次 `groupBy [teamMemberId, model]` 求和（走 `idx_usage_team_member`/`idx_usage_team_model`），内存拼成员名（TeamMember→Agent 名/Role 名联表；`cost` 求和时 null 按 0 参与但 teamTotal.cost 保持数字口径）；返回 `{members: [{teamMemberId, agentName, roleName, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, models: [{model, …同6字段}]}], teamTotal: {…6字段}}`；空团队返回零值结构（members: []，teamTotal 全 0）
  - 单测：成员过滤 403（跨团队/无归属）、groupBy 求和正确（含多模型分行）、空团队零值结构、`?model=` 过滤生效
  - Must NOT：不暴露任何写操作；不做时间序列/分页（成员数量级小，一次全量）；不联表存快照名（只存 id，名实时联表）；不改既有 controller
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 5, 6
  References (executor has NO interview context - be exhaustive): server/src/chat/chat.controller.ts:104、:164（scoped 端点模式）；server/src/memories/memories.service.ts（成员感知过滤先例）；server/src/users/admin-permission.ts（admin 谓词）；server/prisma/schema.prisma:916-934（TaskGroupInstance 成员关联参考）；server/src/memories/memories.module.ts + app.module.ts（模块注册）
  Acceptance criteria (agent-executable): `cd server && npm run test` 全绿；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy——jest 断言聚合数学正确与零值结构；failure——跨团队调用 403。Evidence .omo/evidence/task-4-token-usage-stats.txt
  Commit: Y | feat(usage): 团队用量聚合接口

- [x] 5. usage-web：「统计」子 tab（表格 + 三层汇总）
  What to do / Must NOT do:
  - 新建 `web/src/api/stats.ts`（抄 `memories.ts:51-91`）：`TeamStatsResponse` 类型（members[] 含 models[] 展开 + teamTotal，字段名与 todo 4 接口逐字对齐）、`statsQueryKey(teamId)`、`statsApi.summary(teamId)` → `api.get('/teams/'+teamId+'/usage')`
  - 新建 `web/src/components/teams/TeamStatsTab.tsx`（抄 `TeamMemoriesTab.tsx` 骨架：文件头注释、style 常量、data-testid root、`useMemo` params、`useQuery({queryKey, queryFn, enabled: !!teamId})`、`isApiError` 错误面）：
    - 表格：主行按成员（成员｜总数｜输入｜输出｜缓存读/写｜费用｜展开▾），展开行=该成员每个模型一行（model 名 mono）；样式逐项抄 `system/roles/page.tsx:238-261`（th 对象/cellBase）与 `:274-349`；`SegmentedTabs` 做 按成员/按模型 透视切换；数字右对齐 + `fontFamily.mono` + 千分位；费用 `$`+4 位小数；比率 1 位小数；无分页
    - 三层汇总（全由 `teamTotal`/`members[]` 前端派生）：① 顶部四指标卡（Token 总数 / 输入输出 / 缓存命中读·写+命中率=cacheRead/total / 总费用，副标题派生口径）；② 表尾合计行；③ Top3 成员条 + 模型分布迷你条（纯 CSS 宽度条）；空态 `EmptyState`；进入即查 + 手动刷新按钮（不做轮询）
    - 全员可见，无 admin 门
  - `TeamRightPanel.tsx` 4 处接线（:17 import、:587 union、:948 按钮数组、:1334 body 块传 `teamId/teamName`）
  - Must NOT：不引入图表库；不改 TeamMemoriesTab/管理页/server；不自建 fetch；不做分页；不动 session/page.tsx
  Parallelization: Wave 3 | Blocked by: 4 | Blocks: 6
  References (executor has NO interview context - be exhaustive): web/src/api/memories.ts:43-91；web/src/components/teams/TeamMemoriesTab.tsx:596-633；web/src/components/teams/TeamRightPanel.tsx:17、587、945-949、1329-1334、899；web/app/(main)/system/roles/page.tsx:238-261、274-349；web/src/components/ui/empty-state.tsx:18-25、segmented-tabs.tsx:23-31；web/src/theme/tokens.ts:57、66、80、93、96、99、125、132；web/lib/api.ts:146-155；web/lib/errors.ts
  Acceptance criteria (agent-executable): `cd web && npm run build` + `npm run lint` 通过；`npx tsc --noEmit` 通过；空态/合计/展开行渲染（Playwright 或手测冒烟，二选一记录）
  QA scenarios (name the exact tool + invocation): happy——build+lint 绿且 tab 渲染三层汇总一致；failure——API 403/空数据时错误态与空态正确。Evidence .omo/evidence/task-5-token-usage-stats.txt
  Commit: Y | feat(web): 团队用量统计子 tab

- [x] 6. usage-e2e：端到端冒烟（真实调用落表进表）
  What to do / Must NOT do:
  - 在可用栈走一轮真实 agent 调用：断言 `model_usage` 落行 → `GET /teams/:teamId/usage` 聚合正确 → 统计 tab 三层汇总一致；双投递单行；脏 part 归零（单测已覆则引用）；非成员 403
  - 若无可运行栈，允许降级为 server 集成测试 + web build 冒烟，并在证据中明确声明降级口径
  - Must NOT：不为冒烟改业务代码；不留测试脏数据
  Parallelization: Wave 4 | Blocked by: 1-5 | Blocks: F 波
  References (executor has NO interview context - be exhaustive): todo 1-5 的证据文件；docker-compose.yml；server healthy 探针
  Acceptance criteria (agent-executable): 证据文件记录每条断言的实际输出；降级时声明口径
  QA scenarios (name the exact tool + invocation): happy——真实调用数字端到端一致；failure——双投递单行。Evidence .omo/evidence/task-6-token-usage-stats.txt
  Commit: N（证据提交可并入 F 波；无代码变更不单独 commit）

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit：逐条核对 Scope Must have / Must NOT have（重点：无单价表、无回填、无时间序列、无图表依赖、无 admin 门、统计接口零写操作、幂等唯一键存在、失败不阻断）
- [x] F2. Code quality review：`cd server && npm run test && npx tsc --noEmit` + worker 类型检查 + `cd web && npm run build && npm run lint`；无 `as any`/`@ts-ignore`、空 catch、错误吞没（sink 失败必须 logger.warn）
- [x] F3. Real manual QA：集成环境冒烟——统计 tab 三层汇总一致、展开行模型正确、空态/错误态、成员过滤 403、双投递单行
- [x] F4. Scope fidelity：git diff 范围核对——未动 opencode 驱动、未动权限矩阵、未动 worker/ 以外目录、package.json 零 diff（无新依赖）

## Commit strategy
- 每个 todo 完成后单独 commit（约定式提交，scope=usage/web）：`feat(usage): <subject>` / `feat(web): <subject>`；小改用 `git commit --amend` 合并
- 提交前跑 server `npx tsc --noEmit` + worker 类型检查 + web `npm run build` 确认无编译错误
- 分支流程：基于 xishuhq 远端默认分支 checkout 开发分支 → 推送 ketabot → PR 指向 xishuhq/develop
- 数据库迁移文件（server/prisma/migrations/<ts>_model_usage/migration.sql）必须随功能 commit 一并提交

## Success criteria
- 真实 agent 调用后 `model_usage` 落行（用量/model/成员归属正确，脏数据归零，失败不阻断）
- 同一 completion 双投递只记一行（幂等键生效）
- `GET /teams/:teamId/usage` 聚合数学正确、空团队零值结构、非成员 403
- 统计子 tab 渲染：成员表 + 模型展开行 + 三层汇总一致、全员可见
- server 全部单测通过（含新增/扩展 spec 与迁移守卫），web build+lint 通过，既有 suites 无回归；F1-F4 全部 APPROVE
