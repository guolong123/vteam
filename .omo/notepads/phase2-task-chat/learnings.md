# Phase 2 任务与群聊核心 - Notepad

## 环境基线
- server 3000（nest dev 运行中）、web 3001（next dev 运行中）
- 登录 admin/admin123；seed 项目 p_seed_1/p_seed_2
- Phase 1 关键事实：PlaceholderAuthGuard（x-user-id）、RealtimeService number id、MessageInput 纯展示

## 契约速查（Phase 2）
- 五态：pending/in_progress/pending_review/completed/archived
- 409 TASK_INVALID_TRANSITION；幂等 200
- 事件名统一 task.status.changed（点号！）
- messages.status：user sending→sent；agent pending→processing→completed/failed
- SSE 帧 {id, type, payload, timestamp}；id 字符串 ev_<n> 与消息主键同源
- 8 步发消息流程：权限→@解析→落库→广播→分派→上下文→Loading→收敛

## Agents 模块（T14 简化版）
- seed 预置 4 个 template Agent：产品经理(a_product/product)、架构师(a_architect/architect)、开发者(a_developer/developer)、测试(a_tester/tester)，createdBy=u_admin，permissionScope 最小化（§4.1）
- GET /api/v1/agents → 200 `{items:[{id,name,role,type,prompt}], total:4}`；全局 JwtAuthGuard 已鉴权（无 token 401），无需额外 guard
- AgentsModule 仅 findAll（type=template），CRUD/clone/PATCH/available-models 属 Phase 3
- 测试：13 suites / 81 tests 全过（agents.service.spec 的 $transaction mock：数组在 calls[0][0]，直接断言 findMany 调用参数更稳）
- 注意：jest 有缓存残留假象，全量失败时用 `npx jest --runInBand --no-cache` 复核

## T2 认证守卫统一（已完成）
- 新建 `server/src/common/guards/project-membership.guard.ts`：`ProjectMembershipGuard`
  - 从 `req.user.id`（全局 JwtAuthGuard 挂载的 JWT 用户）取调用者，查 `project_members.projectId_userId` 复合唯一键
  - 非成员 → 403 `PERMISSION_PROJECT_NOT_MEMBER`；无 token → 401 `AUTH_UNAUTHORIZED`；缺 pid → 400 `PROJECT_ID_REQUIRED`
  - projectId 来源：优先路由参数 `:pid`，其次 `PROJECT_ID_KEY` metadata（反射兜底）
- 新建 `server/src/common/decorators/project-id.decorator.ts`：`@ProjectId()`（createParamDecorator 从 params.pid 提取）+ 导出 `PROJECT_ID_KEY`
- 清理 `PlaceholderAuthGuard`：文件已删除；ProjectsController 移除 `@UseGuards(PlaceholderAuthGuard)`，依赖全局 JwtAuthGuard
- `current-user.decorator.ts`：`AuthenticatedUser` 类型自持（{id, username, roleId, tokenType?}），不再 import 占位守卫
- 前端 `web/app/(main)/projects/page.tsx`：移除两处 `x-user-id` header，api.ts 的 Bearer 自动生效
- curl 验证：GET/POST /projects 仅 Bearer（无 x-user-id）→ 200/201，ownerId=u_admin（JWT 来源）；无 token → 401
- 后续 TasksModule 的 POST /projects/:pid/tasks 复用此 guard（需在模块 providers 注册，PrismaService 全局提供）
- 注意：并行任务 T1（Realtime 改造）进行中，realtime.controller.spec.ts 编译中间态会导致 `npm run test` 整体失败——非本项目回归

## 基建落地（T0 common/）
- `server/src/common/id-generator.ts`：`IdGeneratorService.nextId(prefix)` → `<prefix>_<零填充10位>`（如 m_0000000001），**字典序==数值序**（m_0000000009 < m_0000000010），可排序可游标；内存计数器 Map（15 篇 §2.2「本版单机进程内序列」）+ `seed(prefix, n)` 重启续号；JS 单线程原子段保证 Promise.all 并发无重复。index.ts 一并导出 task/event 常量。
- `task.constants.ts`：TASK_STATUS 五态 / TASK_STATUS_ORDER / TASK_PRIORITY / TASK_TRANSITIONS（5 动作迁移表，13 篇 §3.2）/ TASK_ERRORS.TASK_INVALID_TRANSITION。
- `event.constants.ts`：EVENT_TYPES 点号事件名（chat.message.new / task.status.changed / agent.loading / agent.error / team.changed，09 篇 §4.2）；MESSAGE_STATUS 六态 / CHANNEL_TYPE / SENDER_TYPE / SESSION_STATUS / ACTOR_TYPE。
- ⚠️ 并行 T1 正在改造 realtime.service（getEventsSince 变 async），其 spec 未同步 → 整体 npm run test 有编译/断言失败，非本任务引入；本任务 3 个 spec（17 tests）+ build 均通过。
- 现有 projects.service nextId 仍是时间戳+随机后缀（p_<ts>_<rand>），Phase 2 落库时必须换用 IdGeneratorService（seed 对齐后零填充续号）。

## Task 6（use-sse.ts）已完成
- `web/hooks/use-sse.ts`：useSSE({scope, onEvent, enabled}) + SSEEvent<T> 类型，原生 EventSource
- 关键事实：后端 toMessageEvent 虽发 `id:` 帧，但服务端只读 `@Query('since')` 不读 Last-Event-ID header → hook 手动记录 lastIdRef，onerror 时 close + 固定 1s 延迟重建，URL 拼 `&since=<lastId>` 补拉
- 心跳帧（data.id === null, type heartbeat）在 hook 内过滤：不推游标、不调 onEvent
- token 经 useAuthStore(s => s.token) 获取（比 getAuthToken 更响应式，水合/刷新后自动重建连接），query 传参（EventSource 无 header）
- onEvent 存 ref，父组件 re-render 不重建连接；依赖数组 [scope, token, enabled]
- 后端 T1（?token=&scope=）尚未完成，hook 按改造后契约先行实现，build 验证通过（exit 0）

## [2026-08-07] T1 RealtimeModule 改造
- schema.prisma 新增 RealtimeEvent（表 realtime_events）：id(String @id, ev_<10位零填充>)、type、scope_type(String: task/channel/global)、scope_id(String?)、payload(Json)、created_at；索引 idx_realtime_events_scope_id([scopeType, scopeId, id])
- 事件 id 从 number 改字符串：复用 T0/T3 的 IdGeneratorService.nextId('ev') → `ev_0000000001`（10 位零填充，字典序==数值序）；RealtimeService.onModuleInit 用 DB 最大 ev_ id `seed()` 对齐（重启续号）
- **emit/broadcast 变 async**：先 prisma.realtimeEvent.create 落库（08 §7.3）后 bus.emit 转发；订阅者回调仍同步
- subscribe(listener, scope?)：无 scope=全量；task/channel 要求 scopeType+scopeId 精确匹配，global 仅收 scopeType='global'（scopeId null）
- getEventsSince(since?, scope?) 变 async，以 DB 为准（findMany orderBy id asc + where），内存环形缓冲仅作实时层；返回行经 fromRow 映射 createdAt→ISO8601 timestamp
- controller GET /api/v1/events：@Public() 放行全局 JwtAuthGuard（EventSource 无法带 header），改 controller 内 JwtService.verifyAsync(token) 解析；无效/非 access → 401 AUTH_UNAUTHORIZED；缺 token → 401
- scope 解析：global（缺省）| task:<id> | channel:<id>；非法格式 → 400 SCOPE_INVALID
- 权限：task → tasks.projectId；channel → chat_channels.taskId → tasks.projectId；再查 project_members(projectId,userId)，非成员/资源不存在 → 403 PERMISSION_PROJECT_NOT_MEMBER（复用 ProjectMembershipGuard 错误码常量）
- SSE 帧 data 剥离 scope 元数据，仅 {id, type, payload, timestamp}；MessageEvent.id = 字符串事件 id；心跳保留 15s
- realtime.module：imports PrismaModule + JwtModule.registerAsync（与 auth.module 同 secret 配置），providers 增加 IdGeneratorService
- 验证：prisma generate + db push ✓；npm run test 81 passed（13 suites，含 T0/T2 并行产物）✓；npm run build exit 0 ✓

## [2026-08-07] T6 TasksModule CRUD/看板（已完成）
- 新建 `server/src/tasks/`：tasks.controller.ts + tasks.service.ts + tasks.module.ts + dto/{create,update,query-tasks}.dto.ts + 2 spec
- 端点（全挂 ProjectMembershipGuard，类级 @UseGuards）：
  - POST /api/v1/projects/:pid/tasks → 201 任务对象（含 teamAgentIds）；同事务 任务+chat_channels(task_group,agent_id=null)+task_agents+task_events，事务后 broadcast(EVENT_TYPES.TASK_STATUS_CHANGED, {taskId,from:null,to:pending,actorType:user,actorId}, {type:'task',id})（先落库后转发）
  - GET /api/v1/projects/:pid/tasks?status=&priority=&page=&pageSize= → {items,total,page,pageSize}；status 五态 @IsIn(TASK_STATUS)；pageSize 上限 100；created_at desc
  - GET /api/v1/tasks/:id、PATCH /api/v1/tasks/:id（title/description/priority/mainAgentId，mainAgentId 须 team 未 removed 否则 400 MAIN_AGENT_NOT_IN_TEAM；传 null 清除）
- **guard 扩展**：ProjectMembershipGuard.resolveProjectId 变 async，第三兜底 `:id` 路由反查 task.projectId（任务缺失 404 TASK_NOT_FOUND）；原 5 测试未破坏，新增 2 测试
- **IdGeneratorService 共享**：RealtimeModule 补导出 IdGeneratorService（否则 TasksModule 自建实例会独立计数）；TasksService.onModuleInit 按 t/c/ta/te 前缀 seed（重启续号，seedPrefix 查 findFirst orderBy id desc）
- 错误码新增：TASK_ERRORS.TASK_NOT_FOUND / MAIN_AGENT_NOT_IN_TEAM（task.constants.ts）
- TS 坑：TaskUpdateInput 无 mainAgentId 标量（只有 mainAgent 关系）→ 用 Prisma.TaskUncheckedUpdateInput
- 测试坑：控制器类级 @UseGuards(ProjectMembershipGuard) → 测试模块需提供 ProjectMembershipGuard + PrismaService mock，否则 Nest 无法解析 guard 依赖
- 事务测试范式：mockCreateTx 返回 txModels，直接断言 tx.task.create/taskAgent.create(逐 agent)/taskEvent.create 入参；再断言 realtime.broadcast 点号事件名
- 验证：npm run test 15 suites / 102 passed（81+21：tasks.service 12 + tasks.controller 7 + guard 2）；npm run build exit 0；curl 冒烟全过（201/400/404/401）；事务 5 类行全部落库

## [2026-08-07] MessageInput 重写为受控交互组件（T12，解锁 T13/T14）
- 文件：`web/src/components/ui/message-input.tsx`（唯一改动，index.ts 仅补类型导出）；**必须 "use client"**（用了 hooks，被 server component 经 barrel 导入会 RSC 报错）
- props：`{ value, onChange, onSend?, mentionable?, placeholder?, sending?, style?, className? }`
  - mentionable: `MentionableAgent[]` = `{ id, name, role }`（对齐 GET /api/v1/agents：a_product/产品经理/product …），默认 4 个 template agent
  - onSend: `(payload: SendMessagePayload) => void`，payload = `{ text, mentions }`，mentions = `MessageMention[]`（= MentionableAgent，按名 `@name` 匹配、按 mentionable 顺序去重）；空文本/纯空白不触发
- @ 交互：光标前正则 `/(^|[\s])@([\p{L}\p{N}_-]*)$/u`（需 u flag 匹配中文）→ 记录 mentionAt（@ 索引）+ query；候选区 `data-testid=message-input-mentions`（内嵌 textarea 上方，视觉复用 AgentBadge 的 roles/roleText token），query 按 name.includes 过滤，空候选不渲染；点击候选在 mentionAt 处插 `@名称 ` 并 rAF 恢复光标
  - 候选 chip `onMouseDown preventDefault` 阻止 blur 提前关闭候选（否则点击必失败）
- data-testid 语义变更：`message-input` **移到 textarea**（原在容器 div）、`message-input-mentions`=候选区、`message-input-send`=button（原 span）；T13 对接按新语义
- 发送：Enter 发送 / Shift+Enter 换行；**IME 组合中 Enter 不发送**（`e.nativeEvent.isComposing`）
- ⚠️ 坑：`npm run build`（production .next）后再跑 dev server 会 404 静态 chunk（main-app.js 等）→ React 不 hydrate → onChange 全失效（DOM 有值但受控不同步、按钮恒 disabled）。**必须 `rm -rf .next` 再重启 dev**
- 验证：Playwright 全链路通过——输入 "hello @"→ 4 候选(roles 全)、"hello @产"→ 仅 product、点击插入→ "hello @产品经理 "、候选关闭、发送 payload `{"text":"hello @产品经理","mentions":[{id,role}]}`、无 @ 不弹、Shift+Enter 换行、Enter 发送；build exit 0

## [2026-08-07] T14 任务看板接真实数据（已完成）
- `web/app/(main)/board/page.tsx`：移除 MockTask 静态 seed，接 GET /api/v1/projects/:pid/tasks（T6，{items,total,page,pageSize}）
  - pid：URL ?pid= 覆盖缺省 p_seed_1（effect 内读 window.location 避免 SSR 水合 mismatch，对齐 task-create）
  - 筛选：useQuery queryKey=["tasks", pid, status??"all"]，点筛选 → key 变化 → 服务端 status 参数重新 fetch（网络可见 ?status=pending&page=1&pageSize=100）；data-key 保持原型中文（all/待开始/…）
  - SSE：useSSE({scope:"global"}) → ev.type==='task.status.changed' → queryClient.invalidateQueries(["tasks"])
  - 卡片点击 → router.push(/tasks/[id])（T13 未建路由，404 属预期）；开始按钮 e.stopPropagation() 防冒泡跳转
  - 「开始任务」→ POST /tasks/:id/start（T7 已实现，CAS 乐观锁 + 前置校验团队非空/主 Agent 已确定）→ onMutate 乐观更新（setQueryData 改 in_progress）+ onError 回滚快照 + 失败提示（isApiError，红色置入 start-task-hint）；onSettled invalidate
  - teamAgentIds（a_product/a_developer…）→ RoleKey[]：AGENT_ID_ROLE 映射，未知 Agent 跳过；产出物数量 Phase 2 无端点 → EMPTY_ARTIFACT_COUNT=0（对齐 project-list 页 EMPTY_TASK_COUNT 模式）
  - 空态 EmptyState（gridColumn 1/-1）；加载/错误/重试态带 board-loading/board-error/board-retry testid
  - 视觉零改动：WAITING_STATUS/卡片布局/token 全保留，仅加 cursor:pointer + onClick

### ⚠️ 两个 server 侧修复（关键发现）
1. **task.status.changed 广播 scope 改 global**：原 create()/transition() 用 `{type:'task',id}`（task scope），而前端看板订阅 scope=global 收不到（subscribe 严格匹配 scopeType）。设计 09 篇 §4.1 明确「不传 scope 推送全局广播（任务状态变更等）」→ 两处 broadcast 改 `{type:'global'}`；tasks.service.spec 7 处断言同步更新。T7 已实现 start 端点（controller 有 POST /tasks/:id/start），本任务只改广播 scope。
2. **SSE 帧不得设命名 `event:` 字段**：server `toMessageEvent` 原来 `{id, type:event.type, data}` → 帧含 `event: task.status.changed` → EventSource 按命名事件派发，**onmessage 永不触发**（useSSE 用 onmessage → 收不到任何业务事件，T5 hook 与 T1 帧格式整体不工作）。修复：toMessageEvent 去掉 type（只留 id+data，业务 type 在 data JSON 内），心跳保留 type='heartbeat'；realtime.controller.spec 3 处 `events[0].type` 断言改 `(events[0].data as {type}).type`。
   - 教训：SSE 若 data 内已带 type，就不要在帧层再设 `event:`，否则 EventSource 只触发命名监听器；用 curl 验证会骗过你（curl 无视 event: 字段直接吐全部文本），**必须用浏览器 EventSource/fetch 流验证**。

### 验证
- server：16 suites / 151 tests 全过（含 realtime 32 + tasks 45）；npm run build exit 0
- web：npm run build exit 0（先 rm -rf .next）
- Playwright（localhost:3001/board?pid=p_seed_1，admin 登录态 localStorage）：
  - 渲染 5 个真实任务（t_0000000001~5 五态齐全，标题/成员头像/状态徽章正确，待开始卡片带开始按钮）
  - 筛选「待开始」→ 仅 1 卡 + 网络 ?status=pending
  - 点卡片 → URL 变 /tasks/t_0000000002（404 属 T13 未建路由，符合预期）
  - 开始任务 → POST /tasks/t_0000000002/start 201 → 卡片变「进行中」、按钮消失（乐观更新+invalidate）
  - SSE：外部 curl 建 t_0000000008 → 看板不刷新自动出现新卡（invalidated 重取）

## [2026-08-07] T7 五态状态机（已完成）
- tasks.service.ts 新增 transition 泛型 + start/markPendingReview/accept/reject/archive 5 方法；controller 新增 5 个 @Post('tasks/:id/...') 端点（挂类级 ProjectMembershipGuard，:id 路由守卫第三兜底反查 projectId）
- **迁移表驱动**：`const { from, to } = TASK_TRANSITIONS[action]`（T3 已建 5 动作迁移表），新增动作只改表不改分支
- **CAS 乐观锁**：`tx.task.updateMany({ where: { id, status: from, version: task.version }, data: { status: to, version: { increment: 1 }, ...fields } })` 在 $transaction 内与 task_events.create 同事务；count===0 → 重读：已处目标态→200 幂等（不写事件不广播）；否则 409 TASK_INVALID_TRANSITION {from,to,current}
- **顺序**：findUnique(404) → status===to 幂等 200 → status!==from 409 → preflight(start: 团队空 400 TASK_EMPTY_TEAM / mainAgentId 空 400 MAIN_AGENT_NOT_SET) → CAS 事务 → broadcast(task.status.changed, {taskId,from,to,actorType,actorId}, {type:'task',id}) → 重读返回 DTO
- 事件名必须 `task.status.changed`（EVENT_TYPES.TASK_STATUS_CHANGED 点号），禁用下划线变体
- 副作用：start 写 startedAt；mark-pending-review 写 pendingReviewAt；accept 写 completedAt（验收基线属 Phase 3）；reject reason 写 task_events.metadata({reason}) + pendingReviewAt=null；archive 写 archivedAt + tx.session.updateMany(where taskId, data status='archived')
- eventType 映射：start/mark-pending-review='status_change'、accept='accept'、reject='reject'、archive='archive'（08 篇 §6.1 type 枚举）
- 错误码新增：TASK_ERRORS.TASK_EMPTY_TEAM / MAIN_AGENT_NOT_SET
- 注意：toTaskDto 不含 version（DTO 契约无 version 字段，测试勿断言 result.version）
- 测试坑：事务 mock 需带 session.updateMany（archive 用）；CAS 并发测试用 mockResolvedValueOnce 编排「陈旧读 pending → updateMany count 0 → 重读 in_progress → 幂等 200」确定性模拟；Promise.all 编排不可控故用顺序编排
- 验证：npm run test 15 suites / 128 passed（102+26：tasks.service +19、tasks.controller +6、RejectTaskDto +1）；npm run build exit 0

## [2026-08-07] T10 前置 ChatModule 群聊（已完成）
- 新建 `server/src/chat/`：chat.controller.ts + chat.service.ts + chat.module.ts + chat.constants.ts + message-dispatcher.ts + dto/{create-message,create-dm-channel,query-messages}.dto.ts + chat.service.spec.ts（23 tests）
- 端点（权限在 service 层，全局 JwtAuthGuard + @CurrentUser）：
  - GET /channels?type= → {items,total}；type 仅 task_group|private（非法 400 CHANNEL_TYPE_INVALID）；可访问=频道所属任务的项目 ∈ 调用者 project_members
  - GET /channels/:id → 频道信息 + agentMembers（task_agents 未 removed）
  - GET /channels/:id/messages?cursor&limit → {items,nextCursor}；游标=消息主键 id
  - POST /channels/:id/messages → 201 {message,triggers}
  - POST /dm-channels → 201 private 频道；uk_channels_task_agent 幂等（已存在返回已有，不 409）
- **游标语义决定**：按 09 篇 §2.2/§3.5 + 10 篇 §6 实现「id 升序 + 游标续拉」——首次 cursor 空取**最早** 50 条（id ASC），nextCursor=末条 id 前端加载更多；取 limit+1 判末页 → 末页 nextCursor=null；WHERE channel_id=? AND id>cursor ORDER BY id ASC LIMIT ?（命中 idx_messages_channel_id）
- **8 步流程**：① resolveChannelAccess（channel→taskId→projectId→project_members；404 CHANNEL_NOT_FOUND / 403 PERMISSION_PROJECT_NOT_MEMBER；归档任务 → 409 TASK_ARCHIVED）→ ② resolveMentions（agent 未 removed+会话=dispatched / 无会话=no_session / removed=agent_removed / 不在团队=400 MENTION_AGENT_NOT_IN_TEAM / all 展开未移除全部；落库 mentions 保持原样）→ ③ message.create(senderType=user,status=sent,id=m_<n>) → ④ broadcast chat.message.new（scope channel）→ ⑤ MessageDispatcher.dispatch（**抽象类占位**：PlaceholderMessageDispatcher 返回 `已收到：<正文>` mock 回复，T10 替换 provider 即可）→ ⑥ 上下文注入跳过（Phase 4）→ ⑦ broadcast agent.loading（scope task，phase=thinking）→ ⑧ mock 回复 message.create(senderType=agent)+broadcast chat.message.new
- **坑**：TS interface 编译后消失不能作 DI token → MessageDispatcher 用**抽象类** + @Inject；模块 `{provide: MessageDispatcher, useClass: PlaceholderMessageDispatcher}`
- 权限不挂 ProjectMembershipGuard：路由参数是 :id（频道 id 非任务 id），guard 的 :id 反查是任务路由 → service 层自解析（对齐 realtime.controller resolveProjectId 链路）
- ChatService.onModuleInit seed 'm'/'c' 前缀（与 TasksService 共享 IdGeneratorService，只升不降无冲突）
- ⚠️ 并行 T7/T8 正在改 tasks 模块：tasks.service.ts 状态迁移广播已改 `{type:'global'}` 而 tasks.service.spec 仍期望 `{type:'task',id}` → npm run test 6 断言失败（**非本任务回归**，chat 23 tests + build exit 0 全过）

## [2026-08-07] use-realtime.ts（SSE → Query 缓存桥，供 T13）
- 新建 `web/hooks/use-realtime.ts`：`useRealtimeEvents({scope?, enabled?, onMessage?, onTaskStatusChanged?, onAgentLoading?, onAgentError?})`，内部复用 useSSE（未重复实现 EventSource）
- 导出类型（payload 对齐后端）：ChatMessageEvent{message:{id,channelId,senderType,senderId,content:{text,parts},mentions,status,createdAt}} / TaskStatusEvent{taskId,from,to,actorType,actorId} / AgentLoadingEvent{taskId,agentId,sessionId,phase} / AgentErrorEvent{taskId,agentId,messageId?,level?,errorType}
- 默认行为：chat.message.new → setQueryData(['channel',<channelId>,'messages'], 幂等追加，按 message.id 去重——SSE 断线补拉会重复投递；**无既有缓存时不凭空创建**（避免与页面首次 fetch 竞争，交给 onMessage 回调）；task.status.changed → invalidateQueries({queryKey:['tasks']}) 前缀失效（对齐 board 页）；agent.loading/error 仅回调
- **scope 透传 useSSE，一个 hook 实例=一条连接=一个 scope**：chat.message.new 是 channel scope、agent.loading 是 task scope、task.status.changed 是 global scope → T13 群聊页需两处调用（channel:<id> + task:<id>）或各自订阅
- agent.error 后端暂无 emit（仅常量定义，Phase 3 worker 回流后才有），类型先按 09 篇 §4.2 契约定义
- 验证：`npm run build` exit 0（含 tsc 类型检查）；不改 useSSE/现有页面、无新依赖

## [2026-08-07] T10 MockDispatcher（已完成，Phase 4 WorkerDispatcher 替换点）
- 新建 `server/src/chat/mock-dispatcher.ts`：`MockDispatcher extends MessageDispatcher`（同 Placeholder 实现同一抽象，chat.module.ts 仅换 useClass 即接入）
- **确定性模板**：ROLE_REPLY_TEMPLATES 按角色（product/architect/developer/tester）预置 2 条/角色固定文案（16 篇 §3~§6 定位）；role 从 agentId 解析（seed 契约 a_<role>，无前缀原样）；选择 = hashText(text) 取模（UTF-16 code unit ×31 累乘，无依赖）→ 同输入同输出可断言；未知角色兜底默认模板
- **时序（dispatch 内部全包，09 篇 §4.2/FR-20/21）**：sleep(MOCK_DELAY_MS + random×MOCK_DELAY_RANGE_MS)（默认 1000+[0,2000)=1~3s）→ 每目标 agent.loading(thinking) → agent.loading(operating)（scope=task）→ message.create(senderType=agent, status=sent) → 广播 chat.message.new（scope=channel，先落库后转发）；逐目标串行，单目标失败 catch 打日志不阻塞其他
- **延迟注入点**：构造参数 delayMs/delayRangeMs（默认 MOCK_DELAY_MS/MOCK_DELAY_RANGE_MS 常量导出）——测试 new MockDispatcher(prisma, idGen, realtime, 0, 0) 直连实例跳过 DI，或 jest fake timers + Math.random spy 精确断言延迟区间
- **ChatService 改动**：第 5 步 dispatch 改 **fire-and-forget**（`void dispatch().catch(log)`）——09 篇 §5.1「@ 触发同步返回受理（201），处理结果走 SSE」；原第 7 步（loading 广播）与第 8 步（收敛落库+广播）**移除**（职责移交 MockDispatcher，避免双重 loading/双重落库）；M2 验收「用户消息 ≤1s 展示」要求 201 不得被 1~3s 延迟阻塞
- chat.service.spec 适配：仅断言用户消息落库×1 + 广播×1 + dispatch 受理参数；loading/回复断言移到 mock-dispatcher.spec
- 消息 id：MockDispatcher 直接注入 PrismaService + IdGeneratorService + RealtimeService（与 ChatService 同源共享 'm' 计数，重启续号一致）；toMessageDto 本地复制对齐 ChatService 契约
- 验证：npx jest --runInBand --no-cache 17 suites / 171 tests 全过（chat 31 = 23 适配 + 8 新增）；npm run build exit 0；⚠️ 全量首次跑偶发 4 fail 系并行任务中间态 flaky（notepad 已知），复跑即过

## [2026-08-07] T12 团队调整端点 POST /tasks/:id/team（已完成）
- 端点：controller `@Post('tasks/:id/team')`（挂类级 ProjectMembershipGuard，:id 反查 projectId）；service `updateTeam(id, dto, userId)`；DTO `dto/update-team.dto.ts`（addAgentIds/removeAgentIds 可选字符串数组）
- **时间窗**：仅 pending/in_progress 合法；其余 409 `TASK_TEAM_NOT_ALLOWED`（新错误码，details{current}）——14 篇 §5.3 与 13 篇 §7.4 联动
- **add 语义**：全新 → tx.taskAgent.create（id=ta_<n>，joined_at 默认）；已 removed → update removedAt=null + joinedAt 刷新（重新加入）；已存在未移除 → **幂等跳过**（200 不广播，与状态迁移幂等一致）——决策：不 409，避免前端重复提交炸
- **remove 语义**：taskAgent.updateMany 写 removed_at（标记非删除）+ session.updateMany 置 frozen（WHERE task_id AND agent_id）；主 Agent 被移除 → tx.task.update mainAgentId=null（start 前置 MAIN_AGENT_NOT_SET 兜底）；产出物不动（保留）
- **系统消息**：任务内直接写 messages 表（不依赖 ChatModule 方法）：查 chat_channels where taskId+type=task_group → message.create（senderType=system, senderId=null, id=nextId('m'), content={text,parts:[]}, status=sent）→ 广播 chat.message.new（scope={type:'channel',id}，T9 模式）；文案 10 篇 §8.3：「{Agent名} 已加入团队」/「{Agent名} 已移出团队，其会话已冻结」（Agent 名查 agent 表）
- **team.changed 广播**：逐变更 Agent 一条 `{taskId, action:'add'|'remove', agentId}`，scope={type:'task', id}（09 篇 §4.2 明确 task scope，区别于 task.status.changed 的 global）
- TasksService 需写 messages → ID_PREFIX 加 message:'m' + onModuleInit seed（与 ChatService 共享 IdGeneratorService 只升不降无冲突）
- **幂等判定前置**：add/remove 列表先各自 Set 去重；remove 过滤掉同时出现在 add 的 id（add 优先）；全部命中幂等分支 → 直接返回当前 DTO，不查 agent、不开事务、不广播
- 404 场景：任务不存在 TASK_NOT_FOUND；add 目标 Agent 不存在（agent.findMany 前置校验，仅对真正要 create 的）→ AGENT_NOT_FOUND（TASK_ERRORS 新增，code 与 chat 域同值）
- 测试：tasks.service +10（add 全新/幂等/rejoin/remove/remove 主Agent/remove 不在团队/空请求/时间窗/404/任务不存在）、controller +2（路由转发 + DTO 校验）；**mock 坑：mockTeamTx 的 message.create 返回值必须带完整行（含 createdAt Date），否则 toSystemMessageDto 的 toISOString 崩**
- 验证：npx jest --runInBand --no-cache 17 suites / 171 tests 全过（tasks 57 = 45 + 12）；npm run build exit 0
- ⚠️ curl 冒烟被阻塞：并行任务 T10 的 MockDispatcher 构造器带 Number 默认参数无 @Inject → Nest DI 解析失败（"argument Number at index [3]"）→ dev server 无法热重载新代码（3000 端口旧实例 2819546 仅提供旧路由）→ **非本任务回归**，ChatModule 未动；行为验证以单测断言为准

## [2026-08-07] 任务创建页接真实数据（T13 M2 联调入口，已完成）
- 文件：`web/app/(main)/tasks/new/page.tsx`（唯一改动；表单视觉零改动，只换数据源 + 提交逻辑）
- **Agent 勾选数据源**：静态数组 → `useQuery({queryKey:['agents'], queryFn:()=>api.get('/agents'), enabled:!!user?.id})`（T4，{items:[{id,name,role,type,prompt}]}）→ agentOptions `{id,name,role,desc}`；role 与 data-role 一一对应（a_product/… 的 role 就是 product/architect/developer/tester），勾选/主 Agent 联动交互全部保留（state 仍以 RoleKey 驱动，仅提交时映射 id）
- **desc 决策**：用 FIXED_DESC 固定描述（原型文案「需求拆解与验收标准」等，视觉唯一来源）而非 `prompt.slice(0,30)`——prompt 是长句，截断会破坏原型文案；prompt 仅作兜底。保留 `data-role` 属性（Playwright 断言用）
- **优先级映射坑**：select 显示中文 低/中/高（原型文案），但 CreateTaskDto 校验 `@IsIn(['high','medium','low'])` → 必须 PRIORITY_API 映射 `{低:'low',中:'medium',高:'high'}`，否则 400；原 mock 提交直接把中文 priority 塞进 payload（后端就绪后必炸）
- **agentIds 映射**：checkedAgents 是 RoleKey，API 要真实 Agent id → `roleToId = Map(agentOptions o=>[o.role,o.id])` + ROLE_AGENT_ID 兜底（a_product/a_architect/a_developer/a_tester，T14 预置）——API 未就绪提交不中断
- **真实提交**：POST /projects/:pid/tasks（pid=URL ?pid= 缺省 `p_seed_1`，原 mock "p1" 是错的）→ 201 返回 {id} → `router.push('/tasks/'+id)`（T13 路由未建，404 属预期，对齐 board 页 T14）；catch → `isApiError(err)?err.message:兜底文案` 展示红色 create-error（testid 新增）；**移除 mockMode 成功态与 mock 提示**
- backgroundDocs 仍为 mock 元数据（mockDocs.map(d=>d.name)），Phase 2 不接真实 multipart
- 面板新增 agents-loading / agents-error / agents-retry（对齐 board 页范式）；data-testid 全部保留 + create-error
- 验证：`npm run build` exit 0；Playwright 全链路——GET /agents 200 网络可见、4 卡片 data-role 正确、POST /projects/p_seed_1/tasks 201 请求体 `{agentIds:["a_product","a_developer"],mainAgentId:"a_product",priority:"medium",backgroundDocs:[3文件名]}`、成功跳转 /tasks/t_0000000011、空标题 title-error、?pid=p_nonexistent → create-error「您不是该项目成员」（403 PERMISSION_PROJECT_NOT_MEMBER）
- ⚠️ 再次踩坑：**production build 后 dev server 的 .next 被污染 → web 500**，必须 `kill <next pid> && rm -rf .next && npm run dev` 重启（T12 已记录一次）

## [2026-08-07] T10 MockDispatcher DI 修复（已完成）
- **坑**：MockDispatcher 构造器曾带 `delayMs?: number` / `delayRangeMs?: number` 带默认值参数 → Nest 反射 design:paramtypes 得到 `Number` → 启动报 `Nest can't resolve dependencies of the MockDispatcher (..., ?, Number). argument Number at index [3]`。单测直接 `new MockDispatcher(...)` 传参所以不暴露，**server 启动才炸**——单测通过 ≠ DI 可用
- **修复（方案 A）**：构造器只留 DI 可解析服务（PrismaService/IdGeneratorService/RealtimeService）；延迟改为**公开可配置字段** `public delayMs = MOCK_DELAY_MS; public delayRangeMs = MOCK_DELAY_RANGE_MS;`，测试实例化后 `d.delayMs = 0` 覆盖（辅助函数 createDispatcher 默认参数保持 0 以兼容全部调用点）
- 教训：**TS number 类型在运行时是 Number 元数据，Nest 一律当注入 token 尝试解析**；构造器任何非服务参数（即使有默认值）都会炸启动，延迟/阈值/开关类配置一律放类字段或 @Optional()+@Inject() token
- 验证：17 suites / 171 tests 全过；npm run build exit 0；杀旧 nest 重启 → `Nest application successfully started` 无 DI 错误；curl 链路实测：登录 → 创建任务（t_0000000012，agentIds 字段名非 teamAgentIds！400 报错提示过）→ 群聊频道 c_0000000012 → POST messages @ a_product → **201 {message, triggers:[{status:'dispatched'}]}**（无 session 时是 no_session 不参与分派——需先建 sessions 行 uk_sessions_task_agent）→ 4s 后历史出现 agent 回复「需求已明确，输出需求文档要点与验收标准…」（product 模板）→ realtime_events 时序：chat.message.new(user) → agent.loading(thinking) → agent.loading(operating) → chat.message.new(agent) 完全对齐 09 §4.2
- 清理：测试任务/消息/事件/session 全量删除，dev.db 恢复 2 个 seed 任务

## [2026-08-07] T13 群聊页 tasks/[id]（已完成，M2 联调主入口）
- 文件：新建 `web/app/(main)/tasks/[id]/page.tsx`（"use client"，三栏）+ `web/src/components/chat/`（5 组件：loading-indicator / msg-thinking / msg-tool / msg-error / msg-aborted，从原型 group-chat 局部组件迁移，token 走 src/theme/tokens）
- **频道定位（不改后端）**：GET /tasks/:id 不含 channelId → `GET /channels?type=task_group` 返回 items[].taskId 匹配当前任务（后端 toChannelDto 含 taskId）→ 得 channelId；再 `GET /channels/:id` 拿 agentMembers（任务团队未 removed Agent {id,name,role}）做 members-panel + @ mentionable + agentMap（senderId→名/角色）
- **消息历史**：`GET /channels/:id/messages?cursor&limit=50`；queryKey 必须 `['channel', channelId, 'messages']`（useRealtimeEvents appendMessage 幂等追加按 id 去重，key 不一致 SSE 追加不命中）。游标语义=id 升序，首次取**最早** 50 条（非最新！），nextCursor=末条 id，「加载更多」按钮（chat-load-more）取更新消息追加尾部，nextCursor=null 隐藏
- **SSE 三次调用（T17 单 hook 单 scope）**：`channel:<id>`（chat.message.new 默认追加缓存 + onMessage 滚到底 + 收敛 loading/error）、`task:<id>`（agent.loading 两阶段 + agent.error）、`global`（task.status.changed → invalidate ['task', taskId] 刷新面板）。⚠️ task.status.changed 是 global scope（T14 改过），不是 task scope！
- **Loading 两阶段**：loadingByAgent state（agentId→phase），消息列表尾部 LoadingIndicator（「思考中…/操作中…」）；成员面板被 @ 的 Agent 显示「处理中」+ 脉冲点（groupchat-pulse 动画，页面内 groupchatCss 注入）。收敛：收到同 agent 的 chat.message.new（senderType=agent）→ 删 loading + error
- **@ 发送**：MessageInput mentionable=agentMembers；onSend payload {text, mentions} → POST /channels/:id/messages，mentions 转换 `{type:'agent',agentId}`；正文含 @all 时追加 `{type:'all'}`（服务端展开团队全部）。sending 禁用按钮，成功清空输入
- **agent.error**：errorByAgent state → MsgError（retry 琥珀/其余红色），errorType 列表判断 isRetryable
- 渲染：ChatBubble 三态（user 右/agent 左/system 居中）复用共享组件；agent 消息 content.parts 非空时渲染 thinking/tool/error/aborted 组件（Phase 2 parts 恒空，仅预留）
- **坑 1**：StatusKey 只含 4 态（无「待开始」）→ STATUS_LABEL 用 Record<TaskApiStatus, string> + 本地 WaitingBadge（对齐 board 页范式），StatusBadge 仅 4 态
- **坑 2**：build 后 dev server .next 污染 → `kill <next> && rm -rf .next && npm run dev` 重启（T12 记录过，再次踩）
- **坑 3（Playwright）**：getByTestId('loading-indicator').isVisible() 在 loading 窗口内会误判 false（时序/滚动问题）→ 用 `page.evaluate(() => document.querySelectorAll('[data-testid="loading-indicator"]').length)` 原生 DOM 轮询才捕获到「产品经理 思考中…」/「架构师 操作中…」
- **坑 4**：authStore persist 键名是 `agent-platform-auth`（非 auth-storage），注入独立 EventSource 验证 scope 时 localStorage 解析用错键会拿不到 token
- 验证：npm run build exit 0（tsc 类型检查过）；Playwright 全链路——三栏（members 196px/task-info 268px 精确）、历史消息 50 条 + 加载更多追加至 78 条、@ 候选仅团队 2 Agent、发送 201 + 用户消息即时显示 + 「操作中…」指示器 + agent 回复实时追加 + loading 收敛、成员面板「处理中」联动、启动任务 → task-info-panel 徽章「待开始」→「进行中」实时刷新、404 任务 → chat-error「任务不存在」
- 清理：测试任务 t_0000000014 + 频道/消息/session/taskAgent/taskEvent 全量删除，dev.db 归零

## [2026-08-07] dm-chat 私聊（会话列表 + 单栏私聊页，已完成）
- 文件：新建 `web/app/(main)/messages/[id]/page.tsx`（"use client"，单栏）+ 改造 `web/app/(main)/messages/page.tsx`（原 EmptyState 占位 → 会话列表）
- **会话列表**：GET /channels（不带 type → task_group + private 全部）→ 按 type 分组（私聊在上/群聊在下，conversation-section-dm/group testid）。后端 toChannelDto **已含 agent{id,name,role} 与 task{id,title,status} 关联**——private 显示 Agent 名/角色徽章、task_group 显示任务标题/状态徽章，无需额外查 agents 表。⚠️ 坑：group 项徽章必须把 API 状态经 STATUS_LABEL 转中文再喂 renderStatusBadge（StatusBadge 查 statusColors 无兜底，直接传 'pending' 会 `reading 'bg'` 崩）。
- **单栏私聊页（对齐原型 dm-chat）**：AgentInfoBar（dm-agent-info：头像/名/AgentBadge/状态点+meta「正在协作「{task.title}」 · 私聊会话（与群聊共用同一 session）」）→ 消息列表（chat-message-list，复用 ChatBubble + chat 过程组件 + 游标分页 chat-load-more）→ Footer（view-session-link 占位 + MessageInput mentionable=[]）。数据：GET /channels/:id → GET /channels/:id/messages?limit=50；SSE 两级 scope（channel:<id> chat.message.new + task:<taskId> agent.loading/error）。404 频道（URL 直达）→ dm-error + dm-back-list 返回 /messages。
- **私聊发送语义（FR-14 不需手动 @）**：mentionable=[]，onSend 自动附带该频道 Agent 的 mention `[{type:'agent',agentId}]` **仅当其在 agentMembers（任务团队）内**——否则 resolveMentions 400 MENTION_AGENT_NOT_IN_TEAM；有 session → dispatched → mock 回复；无 session → no_session 仅回显。
- **历史 loading 收敛 bug（关键修复）**：SSE 首连 since 为空补拉全部历史事件，task scope（loading）与 channel scope（chat.message.new 回复）**两条连接处理顺序不定** → 「回复先收敛、loading 后设置」→ 刷新/返回会话页恒「处理中」。修复：messagesQuery 首次成功后 effect 遍历缓存，凡「最后一条消息为 agent 回复」的 Agent 清除其残留 loading/error（历史状态由消息列表反映；进行中处理的 loading 事件会重新设置）。
- ⚠️ 坑：**手写时间戳格式消息 id（m_<ts>N）污染 idGen 序列**——ChatService.onModuleInit seedPrefix 按 DB 最大 id 续号，时间戳数字 > 零填充序号 → 后续消息 id 变时间戳格式。测试数据落库消息一律走 nextId 或删干净。
- ⚠️ 坑：Next dev 代理（rewrite → localhost:3000）下 SSE 长连接**偶发 ERR_CONNECTION_REFUSED / ERR_INCOMPLETE_CHUNKED_ENCODING / 404/403** → chat.message.new 丢失（loading 事件经 task 连接到、回复经 channel 连接丢）。验证脚本对回复追加加重试（未达重发触发新事件）。生产独立 API 域无此问题。
- ⚠️ 坑（重踩）：`npm run build` 后 dev server .next 污染 → 500/`__webpack_modules__[moduleId] is not a function` → 必须 `kill <next> && rm -rf .next && npm run dev` 重启。
- 验证：`npm run build` exit 0（tsc 过）；Playwright 16/16——列表分组/Agent 名/任务标题/点击跳转/AgentInfoBar（在线）/历史 3 条/发消息即时回显/loading 指示器/agent 回复 SSE 追加/loading 收敛/404 兜底/返回列表。server 侧事件时序：chat.message.new(user) → agent.loading(thinking) → operating → chat.message.new(agent)，回复落库成功。
- 清理：DM-TEST 任务/频道/消息/session/loading 事件全量删除，dev.db 归零（channels/messages/sessions/tasks=0）。

## [2026-08-07] AppShell 标题映射 + Dock 高亮（T13 群聊/T14 私聊）
- `web/src/components/layout/app-shell.tsx`：`EXTRA_PAGE_TITLE` 从「首段 key」改为「全路径 key」——`/tasks/new`→创建任务、`/tasks/[id]`→任务群聊、`/messages/[id]`→私聊
- **Dock 高亮**：`KEY_LOOKUP` 追加 `tasks: "board"`（Dock NAV_ITEMS 无 tasks 图标，任务路由首段映射 board）→ /tasks/[id] 与 /tasks/new 均高亮「任务看板」；/messages/[id] 首段 messages 已命中（T14 路由未建时 AppShell 仍渲染，404 内容区不影响顶栏/Dock 验证）
- **新增 `resolvePageTitle(pathname)`**：动态段判定优先（`parts[0]===tasks && parts[1]!=='new'` → 任务群聊；`messages` 二级 → 私聊）→ **先查 EXTRA_PAGE_TITLE[pathname]（精确路径）再查 PAGE_TITLE[key]**
- ⚠️ **坑（本任务踩到）**：tasks→board 映射后 `pathToKey('/tasks/new')` 返回 board → 若按原顺序 `PAGE_TITLE[key] ?? EXTRA_PAGE_TITLE[pathname]`，/tasks/new 会被 board 标题（任务看板）抢先命中 → **精确路径查找必须排在 key 查找之前**
- ⚠️ **Playwright 坑**：NavTopBar 的 data-testid 是 `topbar`/`top-title`（**非 nav-topbar**），`[data-active="true"]` 在 nav-item 上（含 rail-icon 图标+label）；`wait_until="networkidle"` 在 SSE 长连接页面永不触发 → 用 `domcontentloaded`
- 验证：`npm run build` exit 0（tsc 含类型检查）；Playwright 四场景全过——/tasks/[id] 任务群聊+board 高亮、/messages/[id] 私聊+messages 高亮、/tasks/new 创建任务（回归）、/messages 消息中心；dev server 500 再次踩 .next 污染 → kill+rm -rf .next 重启

## [2026-08-07] M2 联调验收（§6.4 里程碑，全流程 PASS + 1 个阻断修复）
- **M2 全链路验证通过**：登录→创建任务（勾选 Agent+主 Agent）→看板 pending→开始 in_progress→群聊 @产品经理（51ms 受理）→loading 两阶段→mock 回复回流→看板 SSE 联动→断线补拉。Playwright 9/9 PASS，证据 `.omo/evidence/phase2-m2-summary.md`
- **阻断修复（sessions 缺失）**：任务创建/team add 均不建 sessions → @ 恒 no_session → mock 回复永不回流（M2 直接失败）。修复：`tasks.service.ts` create 事务为每 teamAgent 补 `session.create(status=created)` + updateTeam add 补建/rejoin 恢复 created；ID_PREFIX 增 `session:'s'` + onModuleInit seed。⚠️ 教训：**「每 Agent 每任务独立会话」（10 篇 §3.3）是 @ 分派的前提**，T6/T12 遗漏导致 C1 主流程断裂——联调前应先断言 sessions 表非空
- **idGen 再污染**：messages 残留手写时间戳 id（m_<ts>N）→ onModuleInit seed 续到 14 位数字 → 新消息 id 全变时间戳格式。处理：删残留 + 重启（恢复零填充）。⚠️ 再次确认：**seed 逻辑信任 DB 最大 id，任何非零填充残留都会永久污染**；测试清理必须覆盖 messages（含历史遗留）
- **前端登录失效排查路径**：登录按钮无响应 + URL 变 `/login?` = 未 hydrate（main-app.js 404）→ 不是登录逻辑问题，是 .next 污染 → kill+rm .next 重启（第 N 次踩）
- **Playwright（Python）坑**：`.first` 是属性不是方法（`.first()` 报 `'Locator' object is not callable`）；登录后跳转等待用 URL 轮询（wait_for_url glob 在 dev 编译期不可靠）；loading 指示器 100ms 高频轮询才能抓到两阶段（1-3s 窗口）；dev 首次编译竞态（goto 后需 wait_for_selector + 停顿）
- **断线补拉验证方法**：记 DB max(ev id) → kill server → 重启 → since 重连断言仅新事件（无重复不丢）；`?since=` 精确补拉已实测

## [2026-08-07] Phase 2 原型一致性验收（4/4 PASS + 1 缺陷修复）
- **交付**：`.omo/evidence/phase2-prototype-parity.md` + `.omo/evidence/phase2-parity/` 8 张截图（impl-*/proto-* 各 4）
- **对比方式**：实现页 Playwright 实拍（等数据加载完成）vs md-docs :5178 原型预览 + 源码结构核对（DeviceFrame 视口窄会裁剪卡片/右栏，布局与 token 必须源码双路验证）
- **验收结论**：4 页布局（分栏比例/网格/间距）、token（气泡 #2563EB/#FFFFFF+neutral[200]、筛选 #3B82F6、徽章 #475569）、data-testid 全部与原型源码对齐；差异仅数据内容（mock 编号/静态勾选/动态文案）→ 豁免
- **缺陷修复（双 scope 补拉时序竞态）**：私聊页刷新恒「操作中…」残留（回复先收敛、loading 后设置）；群聊页同隐患。根因：历史收敛 effect 依赖仅 `[isSuccess, data]` 一次性执行，task scope loading 重放晚于 effect 则永久残留。**修复**：messages/[id] 与 tasks/[id] 收敛 effect 依赖加 `loadingByAgent, errorByAgent`（setState 无变化返回原引用不循环）→ 私聊 3 连刷全收敛 + tsc exit 0
- **⚠️ .next 污染再现**：Playwright 会话中 board 页「加载中」卡死 + 登录按钮无响应 + chunk 404 = hydration 失败（非登录逻辑问题）→ `kill <next> && rm -rf .next && setsid nohup npm run dev`（注意 bash 工具超时会连带杀 nohup 子进程，用 setsid + disown 隔离）
- **⚠️ server 重启坑**：`npm run start:prod` 会因 `dist/main` 不存在失败——实际入口是 `node dist/src/main`（nest build 输出到 dist/src/）
- **清理**：dev.db 全部测试数据删除（messages→realtime_events→sessions→task_agents→task_events→chat_channels→tasks 顺序），保留 projects/agents/users/roles/project_members；**删完必须重启 server**（onModuleInit seed 信任 DB 最大 id，重启恢复零填充——验证新 id 回到 t_0000000001）

## [2026-08-07] T20 最终门禁（全 PASS，Phase 3+ 无泄漏）
- **门禁**：`jest --runInBand --no-cache` 17 suites / **171 tests** 全过（基线从 13/81 增至 17/171）；`nest build` exit 0；`rm -rf .next && npm run build` exit 0；health `{"status":"ok",...}` 200
- **Phase 3/4 泄漏检查方法（可复用）**：
  - artifacts：`grep -rn "prisma.artifact\|artifactVersion" src/` 必须 **0 命中**（schema.prisma 表定义 L234/L251 允许；backgroundDocs 仅作 task 表 JsonValue 写入 tasks.service.ts:149）
  - Agent CRUD：agents.controller.ts 仅 `@Get()`；`prisma.worker`/`WorkerClient`/opencode/availableModels/repoGrant/`prisma.credential` 全 0 命中（schema 仅 model Worker L365，无 Credential/RepoGrant 表）
  - web 侧 `worker|artifact|credential` 仅命中导航文案（nav-dock/app-shell）+ EmptyState 占位页（/workers、/agents 注释 Task 13/14 实现）→ 不算功能泄漏
  - 事件名：`task_status_changed` 下划线变体 server+web 全量 **0 命中**；点号 `task.status.changed` 定义于 event.constants.ts:12
- **⚠️ 注意**：注释里提及 Phase 4 计划（mock-dispatcher.ts:103、chat.module.ts:16 的 WorkerDispatcher）是设计说明不算泄漏，审查时按"注释 vs 实际调用"区分
- 证据：`.omo/evidence/phase2-final-gate.md`

## [2026-08-07] F3 真实 QA（M2 全流程 + 边界场景，VERDICT: APPROVE）
- **结论**：Scenarios 5/5 | Integration 11/11 | Edge Cases 5/5 → APPROVE。报告 `.omo/evidence/final-qa/phase2-f3-qa.md`
- **主流程复测数据**：用户消息 226ms 显示；agent 回复落库 1.3s（≤3s）；看板 SSE 联动 45-61ms（3/3）；断线补拉 curl 层 since 精确（重启后新 4 事件补拉 2 channel + 2 task，无重复不丢）
- **⚠️ 新环境坑：kill server 后新实例 EADDRINUSE**——旧 nest 实例有 SSE 长连接（EventSource 保持事件循环活跃），SIGTERM 优雅关闭**永不退出** → 端口占用 → 新实例启动失败静默退出。**必须 `kill -9` 旧实例**再重启；启动后验证 idGen 复位（新任务应 t_0000000001）
- **⚠️ Next dev 代理挂起断连**：kill server 后浏览器 EventSource **无 onerror**（代理不返回错误，连接静默挂着，10s 探针无 error 事件）→ useSSE 重建不触发。验证前端断线补拉改用 **Playwright route 模拟断连**（fulfill 一帧后关闭流 → onerror → 重建 URL 带 since → 补拉帧幂等追加）。生产 nginx 对 upstream 断连返回 502 → onerror 正常，仅 dev 代理有此问题
- **⚠️ Playwright add_init_script 字符串必须是语句/IIFE**：传 `"() => {...}"` 会被 eval 成未调用的箭头函数（静默无效）；`"(function(){...})()"` 才执行。且 SPA 客户端路由（router.push）不重新执行 init script
- **观察项 1（loading 两阶段可感知性弱）**：mock-dispatcher thinking→operating→回复之间无 sleep，事件间隔 11ms/15ms → 前端「思考中…」一闪而过，本次仅捕获「操作中…」。事件层两阶段契约满足（ev 时序），UI 能力存在，非阻断
- **观察项 2（S4 首测 flaky）**：外部改状态首次 10s 未联动，复测 3/3 通过（45-61ms），与 dev 代理 SSE 偶发丢事件一致，非稳定复现
- **边界场景复测**：E1 pending→accept 409 TASK_INVALID_TRANSITION；E2 seed-member(Admin@123456) 403；E3 归档后发消息 409 TASK_ARCHIVED；E4 @非团队 400 MENTION_AGENT_NOT_IN_TEAM；E5 /tasks/nonexistent → chat-error「任务不存在」
- **seed-member 密码**：`Admin@123456`（seed.ts ADMIN_PASSWORD，非 admin123）
- **清理**：业务表 6 表归零 + kill -9 重启 server（idGen 复位 t_0000000001 验证）→ dev.db 仅 seed

## [2026-08-07] F4 补缺：GET /channels/:id/trigger-results/:messageId（T9 轮询端点）
- 背景：F4 范围保真检查发现 T9 缺失（09 篇 §3.5 要求 @ 触发结果轮询：被触发 Agent、dispatch 状态、回复消息 id；前端 SSE 兜底）
- 实现决策：**直接查 messages 表推导，不建进程内内存映射**——多实例部署下其它实例分派的回复无法进内存映射，DB 推导无跨实例一致性问题且零状态管理（单条索引查询成本可忽略）
- 状态推导复用 createMessage 同源链路：task_agents.removedAt → agent_removed（不查会话）；未移除查 sessions（uk_sessions_task_agent）→ dispatched/no_session
- replyMessageId：`message.findFirst({channelId, senderType:'agent', senderId:agentId, createdAt:{gt:原消息}, orderBy:{id:'asc'}})` 取最早一条回复
- mentions 解析：agent 型直取；all 型展开为团队未移除全部（与 resolveMentions 同语义）；null/非数组 → 空 triggers
- 错误码新增：MESSAGE_NOT_FOUND(404，消息不存在或跨频道)、MESSAGE_NOT_USER(400，非用户消息)
- 契约：返回 `{triggers:[{agentId,status,replyMessageId?}]}`（TriggerPollResult 独立接口，不动 TriggerResult，避免污染 createMessage 响应）
- 测试：7 个用例（dispatched 有回复 / no_session / agent_removed / 404 / 400 / 空 mentions / @all 展开）；全量 17 suites 182 tests 全过，build exit 0

## [2026-08-07] F4 T10 修复：MessageDispatcher 回调契约 + 死代码清理
- **接口扩展（message-dispatcher.ts）**：抽象类新增 onLoading/onFinal/onError 回调注册（返回 this 链式）+ protected emitLoading/emitFinal/emitError 触发方法 + DispatcherLoading/Final/ErrorEvent 类型。回调存储于抽象类私有字段，emit 内 try/catch 吞订阅者异常——**订阅者失败不影响分派主流程**（loading 广播/落库/广播继续）
- **死代码删除**：PlaceholderMessageDispatcher 类删除（grep 全仓确认零引用，仅自身/mock-dispatcher 注释提及，注释一并清理）；`@Injectable` import 随之移除（不再需要）
- **MockDispatcher 接入**：replyFor 中 loading 两阶段广播后各 emitLoading(thinking/operating)、落库+广播后 emitFinal({taskId, agentId, messageId, text})；dispatch catch 中 emitError({taskId, agentId, error})——**广播/落库时序零改动**
- **ChatService 接通（行为不变）**：构造函数订阅三回调仅写日志（onLoading/onFinal → debug、onError → error）。⚠️ 关键决策：**不重复广播**——loading/final 广播已由分派器内部完成，若 ChatService 再广播会改变 8 步流程时序，注释中已说明防误改
- **测试**：chat.service.spec 新增「构造时三回调各注册一次」；mock-dispatcher.spec 新增回调契约 3 用例（onLoading×2→onFinal×1 事件内容对号 / 单目标失败 onError 双目标不阻塞 / 回调抛异常被吞不影响结果）——dispatcher mock 需补 onLoading/onFinal/onError jest.fn()（mockReturnThis 支持链式），否则构造时报 TypeError
- **验证**：17 suites / 182 tests 全过（基线 171，新增 11 含其他任务测试）；`nest build` exit 0
- **T17 team.changed 事件处理（F4 保真修复）**：`web/hooks/use-realtime.ts` EVENT 常量加 `TEAM_CHANGED: 'team.changed'`（第五类事件，文件头注释同步 4→5 类）；新增 `TeamChangedEvent` 类型 `{taskId, action: 'add'|'remove', agentId}`（对齐后端 T8 updateTeam 广播 payload，逐 Agent 一条）；options 加 `onTeamChanged?: (payload, event)`；switch 分发 case TEAM_CHANGED → 仅回调（无默认缓存行为，团队更新由页面处理）
- **页面消费**：群聊页 task scope 订阅（agent.loading/agent.error 同一次）加 `onTeamChanged` → `payload.taskId === taskId` 时 `queryClient.invalidateQueries({queryKey: ['channel', channelId]})` 失效频道详情缓存（agentMembers 来自 GET /channels/:id），members-panel 自动重取刷新
- **验证**：`cd web && npm run build` exit 0。⚠️ 教训：工作区存在并发修改（其他任务给 page.tsx 加了 DM 私聊功能，1033→1093 行），首次 build 失败是并发写期间 Next.js 读取不一致文件快照（报错符号/行号与磁盘文件不符）+ `.next` 缓存损坏（Cannot find module './611.js'）；`rm -rf .next` 后重建即过——**并发协作时 build 失败先核对磁盘文件与报错一致性，再清缓存重试**

## [2026-08-07] F4 T7 修复：状态机系统消息（10 篇 §8.1 文案落库 + 广播）
- **缺口**：`tasks.service.ts transition()` 只做 CAS + task_events + 广播 task.status.changed，未按 T7 What to do 补群聊系统消息副作用
- **实现**：`TransitionOptions` 增 `sysMessage(ctx)` / `privateMessage(ctx)` 回调（ctx={task, mainAgentName}）；`transition()` 在事务前查 task_group 频道（T8 updateTeam 同模式），start 额外解析主 Agent 名（agent.findUnique）+ 查 private 频道；事务内 tx.message.create（senderType=system，content={text, parts:[]}）；事务后广播 chat.message.new
- **5 动作精确文案**（10 篇 §8.1）：start「任务已开始，主 Agent：{名}」/ mark-pending-review「任务已提交待验收」/ accept「任务已验收完成，产出物基线已锁定」/ reject「任务被驳回，请补齐产出后重新提交」（有 reason 附「。驳回原因：{reason}」，13 篇 §4.4）/ archive「任务已归档，历史可回看」
- **start 私信主 Agent**（13 篇 §4.2）：private 频道存在则发启动消息（任务目标/团队分工/背景文档），无 private 频道则跳过（本次 mock 验证了「无频道跳过」——channel 为 undefined 时不落库）
- **CAS 语义**：系统消息写入仅发生在 CAS 成功分支（count=1），CAS 失败/幂等不写消息不广播（与 task_events 一致）；并发成功方落库、失败方零副作用已单测
- **测试**：tasks.service.spec.ts 状态机成功迁移断言 `assertSysMessageCreated`（精确文案 + senderType=system + parts=[]）；CAS 并发测试断言成功方 2 条消息（群聊+私信）落库、无重复 task_events；门禁 `npm run test -- --no-cache` 17 suites / **182 tests** 全过（基线 171 → 182），`npm run build` exit 0
- ⚠️ **重构注意**：transition 事务前的 chatChannel.findFirst 查询对每个成功迁移新增 1 次 DB 往返；幂等/409 路径在状态校验后立即返回，不触发该查询——spec 中既有 409/幂等测试无需补 mock（已验证）

## [2026-08-07] 登录无提示 = .next 污染 + 任务入口缺失
- 登录失败无提示根因：`npm run build` 污染运行中 dev 的 .next → `/_next/static/css/app/layout.css` 404 → React 不 hydrate → 错误提示不渲染。修复：kill dev + rm -rf .next + 重启 dev。
- 登录后无"新建任务"入口：① CmdK「操作→新建任务」label 不在 CMDK_NAV_PATH 映射中，点击无反应；② projects 页项目卡片无点击行为（原型暗示点卡片进项目任务）。

## [2026-08-07] 修复：任务新增入口（CmdK「新建任务」+ 项目卡片点击）
- **CmdK「新建任务」**（app-shell.tsx handleCmdKSelect）：label 不在 CMDK_NAV_PATH（7 导航项）映射中 → 在映射查路径前增加 `if (label === "新建任务")` 分支 push `/tasks/new?pid=p_seed_1`（task-create 缺省项目约定：URL ?pid= 优先，无则 p_seed_1）。setCmdkOpen(false) 提到分支前（所有选择都先关面板），其他 7 导航项逻辑不变
- **项目卡片可点击**（projects/page.tsx ProjectCard）：根 section 加 `className="project-card-clickable"` + `role="button"` + `tabIndex={0}` + onClick（Enter/Space 键盘等价，a11y）；onOpen 由 ProjectsPage 传 `router.push(\`/tasks/new?pid=${p.id}\`)`（useRouter 新引入）。hover 视觉零改动：内嵌 `<style>` 仅 cursor:pointer + 轻微 box-shadow md / border-color 加深 + focus-visible outline，不触碰布局/间距/配色 token
- **Playwright 实测**（dev :3001，admin/admin123）：① Cmd+K →「新建任务」→ /tasks/new?pid=p_seed_1 ✓；② projects 点「文档协作平台」卡片 → /tasks/new?pid=p_seed_2 ✓；③ CmdK「任务看板」→ /board 回归 ✓；console 0 error
- ⚠️ 环境坑：`next build` 两次连续跑第二次偶发 `Cannot find module './vendor-chunks/@tanstack.js'`（.next 缓存损坏），rm -rf .next 重试即过——与既有记录一致；Playwright MCP 偶发 `Browser is already in use` 因 stale SingletonLock（进程已死但锁残留），删 profile 下 SingletonLock/Socket/Cookie 即可

## [2026-08-07] ChatBubble 短文本逐字换行修复
- 症状：短文本（"你好"）在私聊/群聊渲染成一行一个字
- 根因：ChatBubble text 容器 `maxWidth:78%` 放在 flex 列（inner，alignItems:flex-end）子项上，百分比相对内容宽解析形成循环 → 压到 min-content（两字宽 45px+padding）→ pre-wrap 下逐字换行
- 修复（chat-bubble.tsx）：根 row 容器加 `maxWidth:78%; minWidth:0`；inner 列加 `maxWidth:100%; minWidth:0; width:100%`；text 容器 `width:100%; maxWidth:100%`（去掉 fit-content）
- 验证：getClientRects 精确断言「你好」1 行（26px）；长文本正常多行换行；build exit 0
- 测量教训：scrollHeight/lineHeight 算行数会因 padding 误报，应用 getClientRects()

## [2026-08-07] 群聊三栏宽度调整 + ChatBubble 对齐修复
- 三栏宽度（tasks/[id]）：members-panel 196→224px、task-info-panel 268→300px（左右加宽、消息区变窄）
- ChatBubble user 消息对齐：根容器加 `justifyContent/alignSelf: flex-end`（user）修复右对齐；text 用 fit-content + 根 maxWidth:78% + inner maxWidth:100%/minWidth:0 解决短文本逐字换行且不撑满
- 实测：user 气泡 gapRight 24px（贴右），"你好" 1 行（58px 气泡），agent 长文本正常换行

## [2026-08-07] 项目 ↔ 任务绑定闭环：taskCount + 卡片跳 /board?pid=（已完成）
- **后端** `server/src/projects/projects.service.ts` findAll：`include: { project: { include: { _count: { select: { tasks: true } } } } }` → items 加 `taskCount: row.project._count.tasks`（Prisma 关联计数，不额外查询）
- **前端** `web/app/(main)/projects/page.tsx`：Project 接口加 `taskCount: number`；卡片底部总数渲染 `project.taskCount ?? EMPTY_TASK_COUNT`（EMPTY_TASK_COUNT 仍作已完成数兜底 0，后端无 doneCount 端点）；卡片 onClick 改 `router.push('/board?pid=${p.id}')`（原 /tasks/new?pid=）
- **看板标题** `web/app/(main)/board/page.tsx`：新增 `ProjectsResponse` 类型（仅 id/name）+ useQuery `["projects"]`（与 projects 页同 key 共享缓存）→ find pid 取项目名 → status-filter 上方加 `board-title` 行「{项目名} · 任务看板」，缺失时固定「任务看板」（布局零改动，仅新增一行）
- **spec** `projects.service.spec.ts`：memberRows mock 补 `_count: { tasks: 2 }`，断言加 `taskCount: 2`
- **验证**：`npx jest --runInBand --no-cache` 17 suites / 182 tests 全过（基线 182 不变）；`nest build` exit 0；`rm -rf .next && npm run build` exit 0
- **⚠️ server 重启坑（重踩）**：3000 端口跑的是 `node dist/src/main`（prod 编译产物，非 nest dev watch）——改完代码必须 `nest build` + **kill -9 旧实例重启**（SIGTERM 被 SSE 长连接阻塞永不退出）；启动路径相对于 `server/` 目录（`dist/src/main`），bash 工具默认 cwd 是仓库根会 MODULE_NOT_FOUND，必须 workdir=server
- curl 实测：GET /api/v1/projects → p_seed_1/p_seed_2 taskCount=1（真实非 0）

## [2026-08-07] 项目↔任务绑定闭环
- 后端 projects.service.ts findAll 加 `_count: { select: { tasks: true } }` → items 含 taskCount
- 前端项目卡片显示真实任务数（project.taskCount ?? 0）
- 项目卡片点击改跳 `/board?pid=xxx`（原 /tasks/new）——项目任务列表用看板承载
- 看板标题：?pid= 命中项目名显示「{项目名} · 任务看板」（useQuery ["projects"] 共享缓存）
- 实测：卡片「1 个任务」、点击→/board?pid=p_seed_2、标题「文档协作平台 · 任务看板」、该看板 1 个任务
- 坑：node dist/src/main 是 prod 产物非 dev watch，build 后需 kill -9 重启才生效

## [2026-08-07] SSE 多 scope 订阅（一条连接合并 channel+task+global）
- **动机**：群聊页原需 3 条 SSE 连接（channel:<id> / task:<id> / global），HTTP/1.1 每连接占 1 个浏览器并发槽（6 上限）→ 静态资源排队。合并后 1 条连接。
- **service 改造（realtime.service.ts）**：`subscribe(listener, scopes?: RealtimeScope | RealtimeScope[])`——无 scopes = 全量不过滤（兼容旧调用）；有 = `scopeList.some(scopeMatches)` 任一命中即转发。`getEventsSince(since?, scopes?)` where 改为 `{ OR: scopes.map(buildScopeWhere) }`。新增私有 `toScopeList()`（单 scope 包数组/缺省→空）与 `buildScopeWhereList()`（OR 组合）。
- **controller 改造（realtime.controller.ts）**：`parseScope` 返回 `RealtimeScope[]`——逗号拆分（trim + 忽略空段），全空/缺省 → `[{type:'global'}]`；单段解析逻辑抽 `parseScopeSegment`（global | task:<id> | channel:<id>，非法 400 SCOPE_INVALID）。`assertScopeAccess(scopes[], userId)` 逐 scope 循环校验，global 跳过，任一非 global 无权限 → 403。`events()` 把数组传给 subscribe/getEventsSince。
- **Prisma OR 语义确认**：global 事件 scopeId 为 null，`scopeId: 't_1'` 相等条件不误匹配——`{ OR: [{scopeType:'task',scopeId:'t_1'},{scopeType:'global'}] }` 行为正确。
- **⚠️ 既有单 scope 测试断言形式变化**：`where: { scopeType:'task', scopeId:'t_1' }` → `where: { OR: [{scopeType:'task',scopeId:'t_1'}] }`（单 scope 也走 OR 包裹）。service.spec 2 处、controller.spec 1 处断言同步更新。
- **多 scope 权限测试坑**：mock 须按 `mockResolvedValueOnce` 编排逐 scope 校验调用次数（第一次放行 + 第二次 null → 403），不能全用 mockImplementation（同 projectId 无法区分）。
- 新增用例：subscribe 多 scope 命中任一（t_1 + c_1 收到、t_2/global 丢弃）、getEventsSince 多 scope OR 查询（task+global 混用）、controller 逗号分隔放行 + 命中推送 + 补拉 OR 断言、多 scope 任一段无权限 403。
- 验证：`npx jest --no-cache src/realtime --silent` 36/36 通过（原 32 + 新 4）；`nest build` exit 0。

## [2026-08-07] 前端 SSE 连接合并 + Turbopack dev（性能双修，已完成）
- **背景**：web 端两个性能问题——① dev 首次编译慢（路由 chunk 按需 webpack 编译实测 15s）；② SSE 连接过多（群聊页 3 条 channel/task/global + 私聊页 2 条 channel/task，加 HMR WebSocket 占死浏览器 HTTP/1.1 单域 6 连接上限 → 静态资源排队）。
- **Turbopack**：`web/package.json` dev 脚本 `next dev` → `next dev --turbopack`（Next 15.5 turbopack dev 稳定）。实测 3101 端口 `npx next dev --turbopack -p 3101`：**3s 就绪**（对比 webpack 15s 首编），首页/群聊页/私聊页 curl 全 200 无编译报错。next.config.ts 只有 rewrites 代理（无 middleware/instrumentation），Turbopack 兼容，SSE 代理链路验证：请求成功转发到后端（返回后端 401 AUTH_UNAUTHORIZED 而非 404/502，证明代理工作正常）。
- **群聊页 tasks/[id]**：3 个 useRealtimeEvents → 1 个，`scope="channel:${channelId},task:${taskId},global"`，`enabled: !!channelId && !!taskId`（合并连接等 channel 定位完成才建）。回调全保留：onMessage（滚底 + agent 回复收敛 loading/error）、onAgentLoading/onAgentError、onTeamChanged（`payload.taskId===taskId` 过滤后 invalidate ['channel', channelId]）、onTaskStatusChanged（`payload.taskId===taskId` 过滤后 invalidate ['task', taskId]）。
- **私聊页 messages/[id]**：2 个 useRealtimeEvents → 1 个，scope 拼装 `[`channel:${channelId}`, channel?.taskId ? `task:${channel?.taskId}` : null].filter(Boolean).join(',')`（channel 恒有、task 段异步加载后加入、空段剔除防尾逗号），`enabled: !!channelId`。回调合并：onMessage + onAgentLoading/onAgentError。
- **⚠️ 多 scope 防线**：一条连接收到全部订阅 scope 的事件（channel 连接也会收到 task/global 事件）→ 回调内原有 `payload.taskId === taskId` 判断是**必要防线**，合并时一个都不能丢；chat.message.new 的 appendMessage 按 queryKey `['channel', message.channelId, 'messages']` 隔离，不会污染其他频道缓存。
- **hooks 注释**：use-sse.ts scope 注释补逗号分隔多 scope 说明（URLSearchParams 无需转义逗号，后端 split(',')）；use-realtime.ts 文件头 + options.scope 注释同步（一个实例=一条连接，多 scope 逗号分隔，勿各开一条连接）。
- **⚠️ 冒烟保护用户 dev 的 .next**：`npm run build` + 冒烟 dev 都会写 web/.next（污染运行中 3001 dev → 静态 chunk 404/hydration 失败）。流程：`cp -a web/.next /tmp/opencode/web-next-backup` → build → 冒烟 → `rm -rf web/.next && cp -a 备份回来` → 用户 3001 零影响。
- **⚠️ pkill 自杀坑**：`pkill -f "next dev --turbopack -p 3101"` 的 pattern 会匹配到 bash 工具自身的 `sh -c` 包装进程 → 把自己所在的 shell 杀掉 → 命令挂起超时。杀 dev 进程用端口反查 PID：`ss -tlnp | grep ':3101' | grep -oP 'pid=\K[0-9]+'` → `kill -9`。
- 验证：`cd web && npm run build` exit 0（含 tsc 类型检查，`/tasks/[id]` `/messages/[id]` 均编译）；3101 冒烟三页 200 + SSE 代理链路通；kill 3101 + 恢复 .next 备份。

## [2026-08-07] 全站单例 SSE 连接池（消除页面切换重建 event 连接）
- **背景**：每个 useSSE 实例独立 EventSource → 页面切换旧连接关/新连接建 + 多连接占满浏览器 HTTP/1.1 单域 6 连接上限。目标：全站每个 token 至多 1 条连接。
- **use-sse.ts 重构为模块级单例连接池**：
  - `pool = new Map<string, SharedConnection>()`，key=`${token}|all`（token 隔离：登出/切换账号分池）；SharedConnection{es, listeners:Set, refCount, lastId, retryTimer, closeTimer}
  - 连接 URL 恒 `scope=all`（后端按用户可见项目过滤权限）；options.scope 语义从「URL scope」改为「前端过滤规则」，由新导出 `matchesScope(ev, scopeStr?)` 前端过滤（channel:<id>→chat.message.new+channelId；task:<id>→agent.loading/error/team.changed+taskId；global→task.status.changed；缺省/all→放行）
  - 生命周期：useEffect（依赖 [token, enabled]）内 refCount++/listeners.add；cleanup refCount--，归零时 50ms 延迟关闭（CLOSE_DELAY_MS 防 StrictMode 双调用误关，窗口内重订阅 clearTimeout 取消）；首订阅者 connect
  - 断线重连：onerror → es.close + 1s 后重建，URL 带连接级 lastId 补拉，补拉事件重放给全部 listeners（useRealtimeEvents 前端过滤 + appendMessage 幂等去重兜底安全）
  - onmessage：心跳帧（id null）跳过；listener 逐个 try/catch（订阅者异常不阻塞分发）
- **use-realtime.ts**：`useSSE({scope:'all', ...})`（共享连接恒 all）+ 内部 `if (!matchesScope(ev, scope)) return` 前端过滤后走原 switch 分发；options.scope 注释同步（前端 split(',') 过滤，不再透传 URL）；import 增加 matchesScope
- **页面零改动**：tasks/[id]（channel+task+global）、messages/[id]（channel+task 动态拼装）、board（useSSE({scope:'global'})）调用形式全保留——board 的 scope:'global' 现在走 useSSE 内部 matchesScope 过滤，语义等价
- **matchesScope 放 use-sse.ts 导出**（而非 use-realtime 私有）：useSSE 内部过滤（board 页传 scope 场景）也需要它，放 use-realtime 会循环依赖（use-realtime imports use-sse）；两处共用同一函数无重复实现
- **验证**：`npm run build` exit 0（tsc 含类型检查）；3101 turbopack dev 四页面（/ /board /tasks/[id] /messages/[id]）全 200，SSE 代理链路通（3101→后端返回 SCOPE_INVALID 而非 404/502）
- ⚠️ **后端 scope=all 未就绪（并行开发中）**：curl 后端 `?scope=all` 现返回 400 SCOPE_INVALID——前端 URL 已按契约用 all，SSE 连接数浏览器级验证须等后端完成后再补（build + 代码审查已验证连接池单例逻辑）；当前 3101 冒烟期间 SSE 连接会 onerror 重连（预期，页面渲染不受影响）
- **流程复用**：备份 web/.next（/tmp/opencode/web-next-backup）→ build → 3101 冒烟（setsid 隔离）→ kill 3101（ss -tlnp 反查 PID）→ rm -rf .next + cp 备份回来 → 用户 3001 零影响

## [2026-08-07] 后端 scope=all 全量订阅 + 按可见项目过滤（对接前端连接池）
- **背景**：前端 use-sse.ts 连接池恒 `scope=all`（单 token 单连接），后端需全量放行但**必须按调用者成员项目过滤事件**（防信息泄露：全量模式下不过滤会收到所有项目消息）
- **schema**：`RealtimeEvent` 加可空列 `projectId String? @map("project_id")` + `@@index([projectId])`；`npx prisma db push` 更新 dev.db（SQLite 加可空列安全，已有数据 projectId=null）
- **service 变更（realtime.service.ts）**：
  - `RealtimeEvent` 接口加 `projectId: string | null`（SSE 下发帧仍 {id,type,payload,timestamp}，前端无感知）
  - `emit` 落库前用新私有方法 `resolveProjectIdOfEvent(event)` 解析并写入 project_id：task scope→tasks.projectId；channel scope→chat_channels.taskId→tasks.projectId（两级）；global scope→payload.taskId 反查（无 taskId→null）；**任何查询失败/未找到→null 不抛错**（try/catch 包裹，事件照常落库转发）；事件频率低每事件 1-2 次 DB 读，刻意不加缓存
  - `subscribe(listener, scopes?, visibleProjectIds?)`：scope 过滤保留；新增 project 过滤谓词 `toProjectFilter`——null/undefined→不过滤（**兼容全部现有调用**）；显式空数组→恒 false（无可见项目时任何事件不放行）；非空→仅放行 `projectId ∈ 集合` 且 projectId 非 null（global 无归属事件不兜底放行）
  - `getEventsSince(since?, scopes?, visibleProjectIds?)`：`buildScopeWhereList` 在 scope OR 基础上，visibleProjectIds 非 null 时叠加 `projectId: { in: [...] }`（显式空数组→`in: []` 空结果，安全）
- **controller 变更（realtime.controller.ts）**：
  - `events()`：`const isAll = scope === 'all'`；isAll → `parsedScopes=[]`（service 空数组=全量不过滤），**跳过 assertScopeAccess**（all 无逐资源校验语义），可见集合=`prisma.projectMember.findMany({where:{userId},select:{projectId:true}}).map(m=>m.projectId)`，subscribe/getEventsSince 传 `(isAll ? visibleIds : null)`；非 all 走原 parseScope+assertScopeAccess 流程（visibleProjectIds=null 向后兼容）
  - `parseScope` **不放行 'all'**（若放行，assertScopeAccess 对 [] 空转无意义且语义混乱；'all' 必须在 events() 单独判断）
  - @ApiQuery scope description 追加 `| all`（全量订阅但仅收成员项目事件）
- **⚠️ 关键安全决策（偏离原计划）**：原计划「visibleProjectIds 空数组→不过滤」，但用户无成员项目时 resolveVisibleProjectIds 返回 [] → 若不过滤将**全量泄露**。修正为「null/undefined 不过滤（现有调用不受影响）、显式空数组=恒空过滤」。经验：**权限过滤的"空集合"必须视为"禁止一切"而非"不过滤"**，只有"未启用该机制"（null/undefined）才放行
- **测试**：service spec 新增 12 用例（emit projectId 解析 task/channel/global 三路 + payload 无 taskId + 解析失败不中断 + subscribe 命中/未命中/projectId null 拦截/null 不过滤/空数组恒拦截 + getEventsSince 叠加 in 过滤/AND 组合/null 不过滤）；controller spec 新增 3 用例（all 放行实时过滤 + all 补拉 in 过滤含 since + 无成员项目收不到任何事件）；既有 36 用例零改动全绿
- **验证**：`npx jest --no-cache src/realtime --silent` 51 passed；全量 `npx jest --no-cache --runInBand` 17 suites / 201 tests 全过（无回归）；`npm run build` exit 0

## [2026-08-07] 导航层级重构：任务并入项目（Dock/CmdK 移除看板入口 + board 强制 pid）
- **背景**：项目与任务是父子层级（数据层 tasks.projectId 已存在），主菜单不再直接展示「任务看板」，任务只能经「项目 → 项目卡片 → /board?pid=」进入
- **nav-dock.tsx**：`NAV_ITEMS` 删除 `{key:"board",label:"任务看板",icon:"☰"}`（图标列 + 展开面板共用数组，删一项两处生效，7→6 项；文件头注释同步）
- **app-shell.tsx**：
  - `KEY_TO_PATH` 删除 `board: "/board"`（goto() 失去 board 入口）
  - `KEY_LOOKUP` 手动补 `board: "project"` + `tasks: "board"` 改 `tasks: "project"`——**/board、/tasks/[id]、/tasks/new 路由首段均映射 project**，Dock 高亮「项目」入口（体现父子层级）。注意 KEY_LOOKUP 的 board 段原本由 KEY_TO_PATH 派生，删除后必须显式补，否则 pathToKey('/board') 返回 "" 无高亮
  - `CMDK_NAV_PATH` 删除 `任务看板: "/board"`
  - **resolvePageTitle 对 /board 特殊处理**：pathToKey('/board') 现在返回 "project"（不再是 "board"），若按 key 查 PAGE_TITLE 会落到 project「项目列表」——需在 key 查找前加 `if (parts[0]==='board') return PAGE_TITLE.board` 保留看板专属顶栏标题（PAGE_TITLE.board 项保留，非死代码）
- **cmdk-panel.tsx**：`DEFAULT_CMDK_ITEMS` 导航组删除「任务看板」（操作组「新建任务/查看产出物/查看 Agent 会话」保留）
- **board/page.tsx**：
  - 删除 `DEFAULT_PID = "p_seed_1"`；`pid` state 初始 `null`；effect：有 urlPid → setPid，无 urlPid 且 userId → `router.replace("/projects")`（**禁止回退 seed**，未登录由 AppShell 守卫跳 /login）
  - tasks/projects 两处 useQuery `enabled` 加 `!!pid`（防 pid=null 时请求 `/projects/null/tasks`）
  - TaskCard props 加 `projectName?: string`；卡片头部编号行左侧加项目徽章 `[data-testid="task-project-badge"]`「📁 {projectName}」（flex 左组容器 + maxWidth 160 + ellipsis 防溢出），数据源复用 `["projects"]` 缓存 find(pid)；其他样式/布局/data-testid 零改动
- **验证**（3101 turbopack dev + Python Playwright admin/admin123）：
  - /projects：rail-icon 6 项无 board、nav-item 6 项无「任务看板」、body 全文无「任务看板」、CmdK 导航组 6 项（新建任务保留）
  - 点项目卡 → `/board?pid=p_seed_2`；board-title「文档协作平台 · 任务看板」；task-project-badge「📁 文档协作平台」
  - 直接访问 /board（无 pid）→ 客户端重定向 /projects（useEffect router.replace，非服务端 307，curl 只能见 200 HTML）
  - Dock 高亮：/projects、/board?pid=、/tasks/[id]、/tasks/new 全部高亮 project；/tasks/new 顶栏标题仍「创建任务」（EXTRA_PAGE_TITLE 优先于 key 查找，不回归）
  - `npm run build` exit 0（含 tsc）；kill 3101 + 恢复 web/.next 备份（用户 3001 零影响）
- ⚠️ **环境坑**：Playwright headless shell 缓存版本是 1208 而 playwright 1.60 要 1223 → `launch(executable_path=...)` 指向 `/home/keta/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell` 绕过；browse skill 的 gstack server 启动卡「Another instance is starting the server」锁残留，弃用改 Python Playwright

## [2026-08-07] 登录页品牌区重构（深色渐变 + 高度铺满，已完成）
- 文件：`web/app/login/page.tsx`（唯一改动；LoginForm 区 228-283 行零改动）
- **高度铺满**：内层分栏容器 `minHeight: 720` → `minHeight: "100vh"`（外层已是 100vh，内层不同步会露底）；移动端折叠布局同享（useIsMobile 未动）
- **深色渐变**：`brandBg` 浅色毛玻璃 → `linear-gradient(150deg, #0F1B3D 0%, #1E3A8A 35%, #4338CA 70%, #6D28D9 100%)`（深海军蓝→靛蓝→紫，呼应 Logo #3B82F6→#8B5CF6，150deg 比 135 更沉稳）
- **brandOnDark 常量**：深底浅色文字/边框/点缀集中管理（text #F8FAFC / textStrong #F1F5F9 / textSub .65 / textMuted .6 / textList .75 / border rgba(255,255,255,.12) / accent #93C5FD），透明度层级参考 sidebarTheme，不散落 magic number
- **逐项适配**：产品名 neutral[900]→#F8FAFC、副标题 neutral[500]→rgba(255,255,255,.65)、价值主张标题 neutral[800]→#F1F5F9、列表 neutral[600]→rgba(255,255,255,.75)、✓ 图标 #3B82F6→#93C5FD、团队角色 neutral[500]→rgba(255,255,255,.6)、边框 neutral[200]→rgba(255,255,255,.12)、Logo 阴影加深 0 8px 24px rgba(59,130,246,.35)
- **高级感细节（零 DOM 结构变更）**：光晕用 background 多层叠加 `radial-gradient(60% 40% at 80% 90%, rgba(139,92,246,.25), transparent 70%), ${brandBg}`（不破坏 flex 布局）；价值主张区加半透明白卡片底（padding space.lg + radius.lg + rgba(255,255,255,.06) + 1px border）
- **保留项**：Logo 渐变块/四色圆点原色、data-testid、useIsMobile、桌面/移动分支结构、LoginForm 全部
- 验证：`npm run build` exit 0（tsc 过）；3101 turbopack dev 冒烟——/login HTTP 200 无编译错，渲染 HTML 含新渐变/光晕/浅色文字/`min-height:100vh`；kill 3101 + 恢复 .next 备份，用户 3001 零影响
- 流程复用：build 前先 `cp -r .next .next.bak`，冒烟后 `rm -rf .next && cp -r .next.bak .next && rm -rf .next.bak`

## [2026-08-07] 登录页品牌区回退（深蓝→极浅渐变，V2 反馈迭代）
- **用户反馈**：V1 深蓝渐变（150deg #0F1B3D→#6D28D9）太突兀，与白色主题不协调
- **brandBg**：→ `linear-gradient(160deg, #FFFFFF 0%, #F0F4FF 45%, #F5F0FF 100%)`（白→极淡蓝→极淡紫，呼应 Logo 蓝紫系但压到极浅；160deg 方向比 150 更柔和）
- **brandOnDark 全部回深色**（背景浅了深字才可读）：text #0F172A / textStrong #1E293B / textSub rgba(15,23,42,.6) / textMuted rgba(15,23,42,.55) / textList rgba(15,23,42,.7) / border #E2E8F0 / accent #3B82F6（✓ 回产品蓝）
- **glow 调淡**：rgba(139,92,246,.25) → `.08`（极淡紫光晕保留层次不抢眼）
- **价值主张区卡片移除**：V1 的 `rgba(255,255,255,.06)` 半透明卡片底在浅底上冗余且突兀 → 恢复裸 `<div>`（简化优先；glow 保留即可）
- **范围纪律**：仅动 brandBg/brandOnDark 两常量 + 卡片 div + 第 11 行注释；LoginForm 区（228-380 行）、data-testid、useIsMobile、minHeight:100vh、Logo 阴影全不动
- 验证：`npm run build` exit 0（tsc 过）；3101 turbopack 冒烟 /login 200 无编译错，server HTML 含新极浅渐变 + 深色文字 + `.08` glow，旧深蓝（0F1B3D/6D28D9）0 残留；kill 3101 + 恢复 .next 备份，用户 3001（pid 未变）零影响
- ⚠️ **Hydration 注意**：改码后 3001 dev 的 SSR chunk 仍是旧代码（client 已新），server/client 可能不一致——不碰 3001 进程，由用户 curl 3001 验证后自行重启解决

## [2026-08-07] Canvas UI 全局效果 + 头像旁下拉切换（Glass / Droplets / 关闭）
- **需求**：全站 Canvas UI 炫酷效果，右上角切换；最终落点=用户头像旁下拉（顶栏 NavTopBar children 插槽，与登出按钮并排）
- **组件来源**：`@canvas-ui/droplets-react` / `@canvas-ui/glass-react` npm **不存在**（404）；官方文档 canvasui.dev/docs/components/{droplets,glass} 提供**完整源码**（"Or copy the source below"），用 curl + python 正则提取 `<pre><code>` 块落盘（write 工具直接写 700+ 行会 JSON 超限）
- **SSR 关键坑**：两组件内部 `useSyncExternalStore(emptySubscribe, supportsHtmlInCanvas, () => false)`——server snapshot 恒 false、client 可能 true，**直接 SSR 必 hydration 不匹配**。必须 `next/dynamic(() => import(...), { ssr: false })` 客户端专用挂载
- **html-in-canvas 依赖**：`layoutsubtree` 属性 + `ctx.drawElementImage` + `canvas.requestPaint`（Chrome 实验 API）。不支持时组件自动降级（source canvas display:none + 渲染纯雨滴/玻璃球本体，不折射内容），页面不受影响；headless Playwright 不支持该 API（验证时只看到效果本体）
- **全局挂载**：web/app/layout.tsx body 内 `<Providers><CanvasUIGlobal>{children}</CanvasUIGlobal></Providers>`（包登录页 + 工作区）；外层 div 需 minHeight:100vh（子 content div 高 100%）
- **状态共享**：新增 `web/src/components/canvasui/store.ts`（zustand persist，key=agent-platform-canvasui-effect）——AppShell 头像旁 `<select>` 读/写 store，CanvasUIGlobal 按 store 渲染对应效果；登录页无 AppShell 仍按 store 默认值渲染
- **参数**：Droplets（intensity 0.5 / scale 0.4 / refraction 0.2 / fallSpeed 1 / staticDrops 0.2 / interaction 0.3/0.6/3 / tint [0.5608,0.7059,1]）；Glass（size 120 / ior 1.5 / edge 0.7 / depth 250 / aberration 1 / zoom 1.5 / follow 0.2 / shape circle / targets "h1,h2,h3,a,button,code"）
- **切换验证**：select value ↔ store ↔ localStorage 三向同步；none 时组件完全卸载（canvas 0 个）；0 console errors

## [2026-08-07] Canvas UI 增加第三个效果：Canvas（画布绘画）
- **需求**：效果选择器从 3 态扩到 4 态（玻璃球 / 雨滴 / 画布 / 关闭）
- **组件**：官方源码 canvasui.dev/docs/components/canvas → Canvas.tsx（1042 行，curl+python 提取 `<pre><code>` 落盘，0 转义残留）
- **改动**：store.ts 类型加 "canvas"；global.tsx dynamic 引入 Canvas + 渲染分支（参数：threadSize 2 / threadWidth 0.2 / texture 1 / grain 0.5 / halftone 0.1 / dotSize 6 / strength 1 / relief 0.45 / gloss 0.35 / bristle 0.4 / dry 2.5 / radius 0.08 / followSpeed 3 / tint [0.8392,0.8078,0.7529]）；app-shell 下拉加「画布」option
- **Canvas 组件特性**：自带文本遮罩（textMask，缩小 0.25 采样文本区域保清晰）+ paint 双缓冲（RGBA16F/RGBA8，PAINT_MAX 1024）+ 笔刷跟随指针画湿漆浮雕；与其他组件一样依赖 html-in-canvas，不支持时降级
- **验证**：tsc exit 0；Playwright 下拉 4 项、切 canvas → localStorage 持久化 + 2 canvas + layoutsubtree 1 + 0 errors

## [2026-08-07] Canvas UI 全量效果接入（28 个 + 关闭）
- **需求**：官网 33 组件全部接入全局效果选择器（用户 Chrome Canary 已开 canvas-draw-element flag，可看完整折射效果）
- **提取**：3 个并行 quick agent 从官网各组件文档页 curl + python 提取 `<pre><code>` 源码落盘（每组 10 个，~1min/组）；组件文件 619-2050 行，0 转义残留
- **3D 组件决策**：5 个 *Object 组件（AsciiObject/GlassObject/ParticleObject/DitheredObject/LiquidObject）**不纳入**——它们需要显式 src 渲染 GLB/SVG 模型（官网 demo 用 Duck.glb），且依赖 three 库未安装导致 tsc 报错；直接删除这 5 个文件（未使用）
- **注册架构**：store.ts 效果键扩到 28 个；global.tsx 改用 **EFFECTS 映射表**（key → {Comp, props}）统一渲染，避免 28 个手写 if 分支；只有 glass/droplets/canvas 有定制参数（官网 demo 配置），其余用组件 DEFAULTS
- **下拉分组**：app-shell CANVASUI_GROUPS 常量 + `<optgroup>` 分 5 组（光学与玻璃 7 / 流体与天气 5 / 火与能量 4 / 复古与特效 6 / 粒子与结构 6）+ 关闭 = 29 项；select maxWidth 120
- **验证**：tsc exit 0（删 3D 后）；Playwright 实测 liquid/frost/shatter/hexfloat 均正常渲染（2 canvas + layoutsubtree 1）+ localStorage 持久化 + 0 errors
- **坑**：dynamic ssr:false 组件切换是异步的——切换后立即查 canvas 为 0 是时序问题（chunk 加载 + useEffect 挂载），需等待片刻再验证；Playwright evaluate 不支持 Promise 箭头函数

## [2026-08-07] Phase 3 T2 ArtifactsModule 骨架 + artifact.submitted 事件（已完成）
- **事件注册**：`event.constants.ts` EVENT_TYPES 加 `ARTIFACT_SUBMITTED: 'artifact.submitted'`（第 6 类，点号命名，不动现有 5 个）；event.constants.spec 标题「5 个事件」→「6 个事件」+ 补一条断言（下划线检查循环自动覆盖新事件）
- **新建 `server/src/artifacts/`**（4 源 + 2 spec）：
  - `artifacts.module.ts`：仿 chat.module——imports [RealtimeModule]（共享 IdGeneratorService 实例）、controllers [ArtifactsController]、providers [ArtifactsService, ArtifactsMockConsumer]、**exports 两者**（T6 消费事件落库 / T14 测试触发需要）
  - `artifacts.controller.ts`：`@Controller()` + `@Get('tasks/:id/artifacts')` 空骨架 → 转 `artifactsService.findByTask(id)` 返回 `[]`（T6 补全查询/权限守卫，本任务不挂 ProjectMembershipGuard）
  - `artifacts.service.ts`：构造注入 PrismaService/IdGeneratorService/RealtimeService（对齐 MockDispatcher 模式，T6 落库时用），findByTask 空骨架返回 `[]`
  - `artifacts-mock-consumer.ts`：`ArtifactsMockConsumer`——**触发式广播** `simulateSubmission(taskId, {type,title,content,fileRef?})`：sleep（公开字段 delayMs/delayRangeMs 默认 200+[0,300)=200~500ms，对齐 MockDispatcher 的**构造器不放 number 参数**教训）→ payload `{taskId,type,title,content,fileRef}`（fileRef 缺省 `mock://<taskId>/<seq>` 私有计数器递增，显式传入原样透传）→ `realtime.broadcast(EVENT_TYPES.ARTIFACT_SUBMITTED, payload, {type:'task', id:taskId})` → 返回事件帧
  - **不落库**：构造注入 prisma/idGen 仅占位（Phase 4 WorkerDispatcher 签名一致），归档落库由 T6 消费事件后做；零 DDL、零新依赖、不改 chat/tasks/realtime 现有逻辑
- **模块接线**：app.module.ts imports 加 ArtifactsModule（import + 数组各一处）
- **测试**：`artifacts-mock-consumer.spec.ts` 4 用例（payload+scope 断言 / fileRef 缺省递增+显式透传 / fake timers+Math.random spy 延迟 350ms 未到不广播到点广播 / 不落库 prisma.artifact.create 未调用）；`artifacts.controller.spec.ts` 1 用例（转发 findByTask 返回 []）
- **验证**：`npx jest --no-cache src/common/constants src/chat src/realtime src/artifacts --silent` 8 suites / 109 tests 全绿；全量 `--runInBand --no-cache` **19 suites / 215 tests** 全过；`nest build` exit 0
- ⚠️ **测试坑（本任务踩到）**：fileRef 递增断言先写 3 个 payload 但只调 2 次 simulateSubmission → 越界断言失败——先数清调用次数再断言 mock.calls 长度，防"断言比实际调用多"的低级错

## [2026-08-07] Phase 3 T3 AgentsModule 查询扩展（findAll 过滤/分页/扩展字段 + GET /agents/:id）
- **新建** `server/src/agents/dto/query-agents.dto.ts`：`QueryAgentsDto`（type? @IsIn(['template','custom']) + page?/pageSize? 分页校验，完全对齐 QueryProjectsDto 模式）
- **agents.service.ts 重写**：
  - `findAll(query: QueryAgentsDto = {})` → `where = { type: query.type ? { equals: query.type } : undefined }`——**type 缺省返回全部类型**（非原 type=template 硬编码）；分页 page 从 1 起（默认 1）/pageSize 默认 20 上限 100（normalizePage/normalizePageSize 从 projects.service 复制）；返回 `{items, total, page, pageSize}`
  - **扩展字段映射**：`AGENT_INCLUDE = { skills: true, toolEffects: true }` 常量（列表/详情共用）→ skillIds: skills.map(s=>s.skillId) / toolEffects: toolEffects.map(t=>({toolAction, effect})) / baseAgentId / permissionScope / defaultModelId / createdAt / updatedAt
  - `findOne(id)`：findUnique + include → 不存在 404 `NotFoundException({code: TASK_ERRORS.AGENT_NOT_FOUND, message})`（复用 task.constants 的 TASK_ERRORS，与 tasks 域同错误码）
- **controller**：GET /agents 接 `@Query() query: QueryAgentsDto`；新增 `@Get(':id') findOne`（注意：路由顺序 GET / 在前不影响，:id 独立无冲突）
- **契约**：GET /agents → `{items:[{id,name,role,type,prompt,baseAgentId,defaultModelId,permissionScope,skillIds,toolEffects,createdAt,updatedAt}], total, page, pageSize}`；GET /agents/:id → 同构单对象；非法 type → 400 ValidationPipe
- **spec 变更**（service 5 用例 + controller 2 用例 = 8 tests）：mock 行补 `skills: [{skillId}]` / `toolEffects: [{toolAction, effect}]` 字段；原「仅 5 字段 + where type=template」断言**必须改**——新契约含扩展字段且无参不再硬过滤 type；补 type 过滤 / 分页 skip/take / pageSize>100 收敛 / findOne 命中 + 404 用例；`$transaction` mock 仍是数组 [count, rows]（mockResolvedValue）
- **⚠️ server 是 prod 编译产物**（`node --enable-source-maps dist/src/main`，非 dev watch）：改码后必须 `npx nest build` + **kill -9 旧 PID 重启**（learnings 多次记录），否则跑旧路由（GET /agents 无扩展字段、/agents/:id 404 Cannot GET）；重启后验证 `curl /api/v1/health` 或直接登录 curl
- **curl 实测**：GET /agents?type=template&page=1&pageSize=2 → {items:2, total:4, page:1, pageSize:2} 每项含扩展字段（permissionScope 为 seed JSON 对象，skillIds/toolEffects 空数组=预期，agent_skills/agent_tool_effects seed 未写）；GET /agents/a_product → 完整关联；GET /agents/a_nonexistent → 404 {code:AGENT_NOT_FOUND}；无参 GET → {items,total,page,pageSize}（total 4）；type=custom → total 0；type=bogus → 400
- **向后兼容确认**：前端 task-create 只取 items[].id/name/role/type/prompt，新增字段不破坏；旧 `{items,total}` 消费方仍可读（多了 page/pageSize 不影响）
- **未做**（T5 范围）：POST/PATCH/clone/available-models；零 DDL（未动 schema）

## [2026-08-07] Phase 3 T4 任务启动置 session active（已完成）
- **背景**：active 全库原无写入点——session 创建 created、remove 置 frozen、archive 置 archived，start 后 session 仍 created（curl 实测库内 2 个 in_progress 任务 session 全 created）
- **start 置 active**：`start()` 过渡事务加 `afterCommit` 钩子（对齐 archive 的 sessions 置 archived 模式）：`tx.session.updateMany({ where: { taskId: id, status: SESSION_STATUS.created }, data: { status: SESSION_STATUS.active } })`——**where 限定 status=created**（不误动 frozen 被移除成员的会话）；CAS 并发失败（count=0）时 afterCommit 不执行，天然幂等
- **rejoin/create 衔接（updateTeam）**：任务 `in_progress` 时 add 团队（全新 create 与 rejoin 恢复）的 session 置 **active**；`pending` 时保持 **created**。实现：事务内 `const joinStatus = task.status === TASK_STATUS.in_progress ? SESSION_STATUS.active : SESSION_STATUS.created`（task 在 updateTeam 入口已查出，直接引用）；create/rejoin 两分支共用
- **chat.service 无关**：buildTrigger 只查 session 存在性（dispatched/no_session）不分状态，Phase 4 worker 分派才消费 active 状态
- **测试**：tasks.service.spec +4（start 独立用例断言 updateMany where{taskId,status:created}→active；updateTeam 3 用例：in_progress rejoin→active / pending rejoin→created / in_progress add 全新→session.create active）；原 start 主用例补 session 断言。`npx jest --no-cache src/tasks --silent` **61 tests 全过**
- **curl 实测**（admin/admin123，字段名 `accessToken` 非 access_token）：建 pending 任务 3 agent → start 前 sessions 全 created → POST /tasks/:id/start 201 in_progress → sessions 全 **active** ✓；in_progress 任务 remove（frozen）→ add 回（rejoin）→ session **active** ✓；pending 任务 remove → add 回 → session **created** ✓
- ⚠️ **pkill 坑（重踩）**：`pkill -9 -f "dist/src/main"` 会匹配**自身 bash 命令行**（含同字符串）导致自杀/超时——杀 server 用精确 PID（`ps aux | grep ... | awk '{print $2}'`）或 `pkill -9 -f 'node .*dist/src/main\.js'` 精确模式；另 build 后须重启（prod 编译产物）
- **清理**：测试任务 t_0000000004/5 全量删除（messages→realtime_events(含 global scope 事件用 `json_extract(payload,'$.taskId')` raw SQL)→sessions→task_agents→task_events→chat_channels→tasks），kill 重启复位 idGen；dev.db 归零仅剩 seed 的 t_0000000002/3

## [2026-08-07] Phase 3 T8 users 创建/重置密码 + AdminGuard + 角色矩阵 CRUD（已完成）
- **AdminGuard 落地**（原 Phase 1 占位放行）：注入 PrismaService，从 `request.user.id`（全局 JwtAuthGuard 已填充 {id,username,roleId}，jwt.strategy validate 产物）查 user+role；放行条件二选一：`permissions.all === true`（seed admin 简写 `{all:true}`，兼容存量）/ `permissions.users.manage === true`（Phase 3 矩阵格式）；用户不存在/禁用 → 401；无权限 → 403 `{code:'FORBIDDEN_ADMIN'}`；**必须注册为 users.module providers**（有构造依赖后 Nest 不再能裸实例化）
- **POST /users**：{username,password,displayName,email?,roleId}；冲突校验（username/email findUnique → 409 USERNAME_CONFLICT/EMAIL_CONFLICT）+ bcrypt 10 轮哈希，逻辑对齐 auth.service.register（不注入 AuthService，独立实现避免触碰 auth 现有流程）；roleId 不存在 → 400；返回 SAFE_USER_SELECT（绝不含 passwordHash）
- **POST /users/:id/reset-password**：{newPassword}；bcrypt 重哈希覆盖 → 200 SAFE_USER_SELECT；用户不存在 404
- **角色矩阵 CRUD**（roles.controller + roles.service，并入 users 模块，类级 AdminGuard）：
  - GET /roles：findMany orderBy createdAt asc（含 permissions/scopes 原样返回）
  - POST /roles：{name,permissions,scopes?}；name 唯一 409；permissions 缺省用 emptyPermissions()（8 资源×6 操作全 false）；scopes 缺省 `{global:false,projects:[],innerRoles:[]}`；isBuiltin=false；id `r_${Date.now()}`
  - PATCH/DELETE：预置判断用 `isBuiltin===true || name in ['admin','member']` 双保险 → 403 `{code:'FORBIDDEN_BUILTIN_ROLE'}`；DELETE 前查 user.count({where:{roleId}}) > 0 → 409 防外键 Restrict 报错
  - 权限矩阵结构（对齐原型 role-permission 8 资源×6 操作）：tasks/chats/artifacts/agents/workers/skills/users/roles × view/create/edit/delete/review/manage
- **⚠️ Prisma Json 列类型坑**：`Record<string, unknown>` 不能直接赋给 Prisma Json 字段——必须 `as Prisma.InputJsonValue`（项目惯例见 tasks/agents/chat/realtime service）
- **⚠️ jest mockResolvedValue 陷阱**：update 内部两次 findUnique（查目标+查 name 冲突），`mockResolvedValue` 会让第二次也返回同对象导致误判 409——第二次用 `mockResolvedValueOnce(null)` 显式区分
- **测试**：users.service.spec +7（create 4：成功 bcrypt 验证/username 冲突/email 冲突/roleId 不存在；resetPassword 2）+ roles.service.spec 10 用例 + admin.guard.spec 6 用例（含矩阵格式放行/403 FORBIDDEN_ADMIN）；`npx jest --no-cache src/users --silent` **30 tests 全过**；`npm run build` exit 0
- **curl 实测**（admin/admin123 登录，accessToken 字段）：GET /users admin 200 / member 403 FORBIDDEN_ADMIN ✓；POST /users 创建成功含角色关联、重复 username 409 ✓；reset-password 后新密码可登录 ✓；GET /roles 返回 admin{all:true}/member 预置 ✓；POST 自定义角色 ✓；PATCH/DELETE r_admin 403 FORBIDDEN_BUILTIN_ROLE ✓；PATCH 自定义 200 ✓；DELETE 自定义 200 {deleted:true} ✓；DELETE 被引用自定义 409 ✓
- **重启**：server 是 prod 编译产物（node --enable-source-maps dist/src/main，PPID=1 守护进程），改码后 `npm run build` + 精确 PID kill 重启（pkill 自杀坑见 T4）
- **未做**：不改 schema（零 DDL，复用 Role.isBuiltin）；不做租户级 RBAC（仅平台角色矩阵）；未动 auth 登录/注册流程

## [2026-08-07] Phase 3 T5 AgentsModule CRUD（create/clone/PATCH/DELETE/available-models，已完成）
- **新建** `server/src/common/constants/agent.constants.ts`：`AGENT_ERRORS`（`AGENT_NOT_FOUND:'AGENT_NOT_FOUND'` / `AGENT_READONLY:'PERMISSION_AGENT_READONLY'` / `AGENT_CLONE_INVALID`）——**键名按任务 AGENT_NOT_FOUND/AGENT_READONLY/AGENT_CLONE_INVALID，值对齐 14 篇 §7 的 403 错误码 `PERMISSION_AGENT_READONLY`**；AGENT_NOT_FOUND 与 TASK_ERRORS/CHAT_ERRORS 同值（跨域兼容，前端/旧测试不破坏）
- **DTO**：`create-agent.dto.ts`（`ToolEffectDto{toolAction,effect}` 嵌套 + CreateAgentDto：`type @IsIn(['custom'])` 仅 custom 可创建 / name 必填 / prompt?/role?/skillIds?/toolEffects?/permissionScope?@IsObject/defaultModelId?）；`update-agent.dto.ts`（可选标量 + skillIds/toolEffects 重建语义）；`clone-agent.dto.ts`（name? 缺省「源名副本」）
- **agents.service.ts**：`create(userId, dto)` 三表事务（Agent type=custom/baseAgentId=null/createdBy=userId + agent_skills 批量 + agent_tool_effects 批量，`createAssociations` 内 `[...new Set(skillIds)]` 去重 + toolAction 去重防 @@unique 冲突）；`clone` 先 findUnique 源（404 AGENT_ERRORS.AGENT_NOT_FOUND）→ 事务复制（新行 type=clone、baseAgentId=源.id、name 请求值或「源名副本」、createdBy 当前用户，`copyAssociations` 复制 skills/toolEffects）；`update/remove` 先查 type=template → `ForbiddenException{code: AGENT_READONLY}`，clone/custom 可写（14 篇 §2.2 第 4 条「对 clone/custom 正常更新」）；update 标量 + skillIds/toolEffects 显式传入才重建（deleteMany + create）；remove 事务删 agent_skills + agent_tool_effects + agent；`getAvailableModels` 返回 `STATIC_AVAILABLE_MODELS` 常量（gpt-4o/claude-3-5-sonnet/deepseek-v3，注释标 Phase 4 接 WorkerClient GET /models）；`OnModuleInit` seed `a/as/ate` 前缀（seedPrefix 从 tasks.service 复制，`last.id.slice(prefix.length+1)` 对 a_product 非零填充 parseInt NaN 自动跳过）
- **模块/控制器**：`agents.module.ts` imports 加 `RealtimeModule`（共享 IdGeneratorService，与 tasks/chat/artifacts 同源）；controller 新增 `POST /`、`POST :id/clone`、`PATCH :id`、`DELETE :id`、`GET :id/available-models`（注意 `@Get(':id/available-models')` 放在 `@Get(':id')` 之前，静态段优先不冲突）
- **验证**：agents 域 `npx jest --no-cache src/agents --silent` 25 tests 全绿；全量 `--runInBand --no-cache` **22 suites / 276 tests** 全过；`nest build` exit 0
- **curl 实测**（admin/admin123，`?` 需引号防 zsh glob）：POST custom 三表写入返回 toAgentDto 全字段（DB 确认 agent_skills 2 行 + agent_tool_effects 2 行）；clone → type=clone/baseAgentId=a_0000000001/「数据分析师副本」/三表继承；PATCH 克隆体改 prompt+skill 后 GET 源不受影响（**解耦验证 ✓**）；PATCH/DELETE 模板 → 403 `{"code":"PERMISSION_AGENT_READONLY"}`；DELETE custom → 200 且 agent_skills/agent_tool_effects 归零；POST type=template → 400 `type must be one of following: custom`；available-models → 3 项静态数组；clone 不存在源 → 404 AGENT_NOT_FOUND
- ⚠️ **坑（重踩）**：skills 表 seed 未写（空表）→ POST custom 带 skillIds 直接 **500 P2003 Foreign key constraint**（agent_skills.skillId FK→skills 不存在）。curl 实测需先插测试 skill（node Prisma upsert s_skill1/s_skill2），测完清理归零；**skillIds 无 API 校验存在性，依赖 DB FK 兜底**（任务未要求服务层校验）
- **清理**：删 a_0000000001/2 + agent_skills + agent_tool_effects + s_skill1/2，dev.db 归零（仅剩 4 seed 模板）

## [2026-08-07] Phase 3 T6 ArtifactsModule 归档链路（协议校验 + append 幂等 + 文档库端点）（已完成）
- **新建** `artifacts.constants.ts`：`ARTIFACT_TYPES = ['text','doc','file']` + `ARTIFACT_ERRORS`（INVALID_DECLARATION / ARTIFACT_NOT_FOUND / ARTIFACT_VERSION_NOT_FOUND / ARTIFACT_ACCEPTED_IMMUTABLE 预留 T7）
- **新建** `dto/artifact.dto.ts`：`CreateArtifactDto`（type @IsIn / title @IsNotEmpty + content?/fileRef? @IsOptional，交叉约束留服务层）+ `QueryArtifactsDto`（type / accepted('true'|'false') / page / pageSize）
- **artifacts.service.ts 重写**（构造注入 prisma/idGen/realtime 不变）：
  - **协议校验**：`validateArtifactDeclaration` 导出纯函数（轻量手写，零新依赖）——type 必填且枚举 text/doc/file；title 必填非空；text→content 必填、doc/file→fileRef 必填；未知字段忽略（12 篇 §3.1）
  - `append(taskId, submission, meta?)`：校验（非法抛 400 INVALID_DECLARATION）→ `sha256(content)` → **幂等**：`artifactVersion.findFirst({where:{sha256, artifact:{taskId,type}}})` 命中返回 `{status:'duplicate'}` 版本不增 → 事务：同 **taskId+type+title** 定位现有产出物，无则 create(currentVersion=1)+v1，有则 update(currentVersion+1)+新 version；doc/file 的 contentRef/filePath 存 fileRef（mock 占位，不真实拉取，重试逻辑注释预留）
  - `onArtifactSubmitted(payload)`：消费 T2 MockConsumer 广播契约；非法**不抛错**返回 `{status:'invalid'}`（事件链路不被非法输入打崩，回退普通消息语义），合法转 append
  - `findByTask`（分页 {items,total,page,pageSize} + type/accepted 筛选）：accepted 筛选需**先取 task 内候选 artifacts + 批量查 versions 聚合 currentVersion 再内存过滤**——Prisma 无法在 where 里跨行引用父行 currentVersion（`version = Artifact.currentVersion` 不支持），accepted 参数用字符串 'true'/'false'（query 无 boolean 自动转换）
  - `findOne`（详情 + versions 升序列表）/ `findVersion`（指定版本；404 ARTIFACT_VERSION_NOT_FOUND）
  - **ID 前缀**：模块内 `ID_PREFIX = { artifact:'art', version:'artv' }` + onModuleInit seed 两个前缀（复制 tasks seedPrefix 模式，重启续号 ✓）
- **controller**：GET /tasks/:id/artifacts（接 QueryArtifactsDto）、GET /artifacts/:id、GET /artifacts/:id/versions/:version（ParseIntPipe 转 number，非整数 400）、POST /tasks/:id/artifacts（旁路，body 组装 payload 后 append，非法 400）
- **spec**：`artifacts.service.spec.ts` 新增 19 用例（协议校验 3 / append 6 / onArtifactSubmitted 2 / findByTask 3 / findOne+findVersion 4 + onModuleInit seed）；controller.spec 改 4 端点转发。`npx jest src/artifacts` 3 suites 26 tests；**全量 22 suites / 276 tests 全过**；`nest build` exit 0
- **curl 实测**（admin/admin123，任务 t_0000000002）：POST text v1 → 201 archived；同内容再 POST → **duplicate 版本不增**；同 title 不同 content → archived v2（currentVersion 2）；doc+fileRef → 新建 doc v1；type=code → 400 DTO 拦截；text 缺 content / doc 缺 fileRef → 400 `ARTIFACT_INVALID_DECLARATION`（服务层交叉校验兜底）；GET 列表 2 items + type/accepted 筛选 ✓；GET 详情 2 versions 升序 + sha256 与 `echo -n | sha256sum` 一致 ✓；versions/99 → 404 VERSION_NOT_FOUND；art_nonexist → 404 NOT_FOUND
- **idGen 复位验证**：清库（DELETE artifact_versions/artifacts）→ kill 重启 → 新归档从 art_0000000001 递增（onModuleInit seed 生效）
- ⚠️ **坑**：prisma mock 不真实执行 where——findByTask type 筛选测试的 mock 返回列表必须与过滤条件自行对齐（否则 total 断言偏差）；POST body content 对 doc/file 是可选（DTO 层），交叉约束必须由服务层 validateArtifactDeclaration 兜底（两类 400 实测确认）
- **未做**（T7 范围）：acceptedFlag 验收联动 / 409 ARTIFACT_ACCEPTED_IMMUTABLE；零 DDL、零新依赖

## [2026-08-07] Phase 3 T7 验收联动（accept 标记 accepted_flag + 409 不可变 + append 退回进行中）（已完成）
- **tasks.service.ts `accept`**：transition 增加 `afterCommit`（同事务）——`tx.artifact.findMany({where:{taskId},select:{id,currentVersion}})` → `tx.artifactVersion.updateMany({where:{OR: artifacts.map(a=>({artifactId:a.id,version:a.currentVersion}))},data:{acceptedFlag:true}})`。**关键坑**：不能用 `where:{artifactId:{in:[...]},version:{in:[...]}}` 交叉匹配——会误标非当前版本（如 artA 当前 v3、artB 当前 v2 时，(A,2) 存在也会被标）。必须 OR 精确组合，利用 @@unique([artifactId,version])
- **artifacts.service.ts `append` 409**：幂等去重**优先**（同 sha256 → duplicate 返回，不触发 409）；幂等未命中 → 事务内 `artifactVersion.findUnique({where:{artifactId_version:{...}}})` 查当前版本 acceptedFlag → true 抛 `ConflictException{code:'ARTIFACT_ACCEPTED_IMMUTABLE'}`（09 篇 §3.6 409），409 抛在事务内回滚，无任何写操作
- **append 退回进行中**：归档事务**提交后**（事务外）`prisma.task.updateMany({where:{id,status:'completed'},data:{status:'in_progress',version:{increment:1}}})` CAS 防并发；count>0 才 `realtime.broadcast('task.status.changed',{from:'completed',to:'in_progress',actorType:'system',actorId:null},{type:'global'})`。**避免循环依赖**：artifacts 服务不 import tasks 服务，直接 prisma + realtime
- **reject 语义不动**：pending_review→in_progress 现有逻辑零改动（任务要求）
- **spec**：tasks.spec 的 mockTransitionTx 加 `artifact.findMany`（默认 []，空产出物不调 updateMany）+ `artifactVersion.updateMany`；start 并发测试内联 tx mock 也要补同字段（TS 类型报错 TS2345 踩坑）；artifacts.spec 的 createService prisma mock 加 `task.updateMany`（默认 {count:0}，否则 append 归档路径 `reverted.count` 会 undefined TypeError）+ `artifactVersion.findUnique`
- **验证**：域 5 suites 92 tests；全量 22 suites / 281 tests（276→281）；`nest build` exit 0
- **curl 实测**（admin/admin123，任务 t_0000000004）：start→append v1→mark-pending-review→accept completed；GET artifacts 当前版本 acceptedFlag=true ✓；同内容 append → duplicate（幂等优先不 409）✓；新内容 append 已验收 → 409 `{"code":"ARTIFACT_ACCEPTED_IMMUTABLE","message":"产出物「验收结论」当前版本已验收锁定（v1），不可追加"}` ✓；验收后新 title append → archived + 任务状态退回 in_progress ✓；新产出物未验收可继续 append v2 ✓
- **清理**：删 t_0000000004 全链路（artifacts/channels/sessions/events/agents）+ messages，dev.db 归零（剩余 2 seed 任务）

## [2026-08-07] Phase 3 T9 前端 /agents 页（agent-config 原型迁移 + 真实 API）（已完成）
- **改写** `web/app/(main)/agents/page.tsx`：337 字节占位 → 完整原型迁移（左 320px Agent 列表 + 右 ConfigPanel 五块配置面板）。data-testid 与原型一致：agent-config-root / agent-list-item(+data-agent-id,data-active) / clone-template-button(+data-agent-id) / prompt-editor / model-config+model-select+model-source-hint / skill-list / tool-permission-list+tool-permission-item+tool-toggle-item+tool-effect-select+tool-wildcard-row / permission-config；新增真实功能 testid：save-agent-button / create-agent-modal / agent-readonly-badge / tool-add-button / tool-empty
- **API 接线**（T3/T5 契约）：useQuery GET /agents（pageSize=100，列表条目已含扩展字段）→ 选中再 GET /agents/:id 详情（`detailQuery.data ?? listItem` 兜底即时渲染，避免选中切换闪空）；GET /agents/:id/available-models 驱动 model-select；clone-template-button → POST /agents/:id/clone → invalidate 列表 + setSelectedId(克隆体)（key=id 重挂载面板草稿，闭环可继续编辑）；新建弹窗 POST /agents{type:'custom'} → invalidate + 选中新建；custom/clone → PATCH /agents/:id（prompt/defaultModelId/toolEffects）
- **模板只读态决策**：`isTemplate = type === 'template'`（非任务书写的 `type !== 'custom'`）——后端 PATCH 仅禁 template（403 PERMISSION_AGENT_READONLY），clone 可写，若按任务公式 clone 会误判只读导致克隆后无法编辑，功能闭环断裂。只读时：textarea readOnly / select disabled / effect radio 无 onClick / 隐藏保存+添加工具按钮 / 顶部「只读」徽章
- **技能面板静态展示**（对齐原型「纯静态示意」）：skills 表无独立列表端点 + `agent_skills.skillId` FK→skills.id 约束（seed 未建 skill，**提交 skillIds 必 500 P2003**）→ 技能只渲染勾选态不随 PATCH 提交；池外真实 skillId 原样展示防丢
- **工具 effect 可编辑可提交**：`agent_tool_effects.toolAction` 自由字符串（**无外键**）→ PATCH 提交 toolEffects 重建关联安全；工具来源启发式推断（页面内 `inferToolSource`：基础裸权限名→内置、含 `_`（<server>_<tool>）→MCP、其余→自定义）；enabled 后端无字段，真实数据恒启用；空列表显示空态行 + 「添加工具」输入行（仅可编辑态）
- **页面内扩展 token**：toolEffectMeta（allow 绿/ask 琥珀/deny 红 三态色）+ toolSourceMeta（内置蓝/自定义紫/MCP 青）+ SKILL_POOL + MODEL_NAMES（gpt-4o/claude-3-5-sonnet/deepseek-v3，与后端 STATIC_AVAILABLE_MODELS 一致），未动 tokens.ts 基线
- **permissionScope 渲染**：permissionRows() 从对象（{projects,write,ask,doclibOnly}）映射「可访问资源/可执行操作/写操作确认」三行（对齐原型行结构）；仅展示不 PATCH
- **草稿同步技巧**：ConfigPanel `key={selectedAgent.id}` 强制重挂载 → 内部 useState 从 agent 初始化草稿，免手动 useEffect 同步；同 id 详情 refetch 不打断用户编辑
- **顺手修复基线 lint error**：`canvasui/global.tsx` `ComponentType<any>`（ESLint no-explicit-any error，阻断 next build）→ `ComponentType`（默认 {} 泛型，运行时零改动）——否则 `npm run build` 无法 exit 0
- **验证**：`npx tsc --noEmit` exit 0；`npm run build` exit 0（/agents 8.68 kB，编译+lint+15 static pages 全过；脏 .next 缓存会导致 pages-manifest.json ENOENT，需 `rm -rf .next` 后重建）
- **零改动**：tokens.ts / 无新依赖 / 不迁移 task-detail

## [2026-08-07] Phase 3 T10 用户管理页迁移（web/app/(main)/users/page.tsx，已完成）
- **交付**：占位 14 行 → 1132 行完整页（统计条 4 卡 + 账号列表 user-item 行 + UserFormModal 新增弹层 + ResetPasswordModal 重置密码弹层），data-testid 与原型 user-management/index.tsx 全量一致（user-management-root/user-stats/add-user-button/user-item/user-role-badge/user-status-badge/user-edit-button/user-toggle-button/user-reset-button/user-form-overlay/user-form/username-input/user-email-input/user-password-input/user-role-select/user-form-cancel/user-form-submit）
- **契约关键发现（决定数据映射）**：GET /users items **不含角色名**（仅 roleId）→ 必须并行 GET /roles 做 roleId→中文名映射（admin→管理员/member→成员，自定义角色原样显示）；**无「所属项目数」端点** → 列表列兜底 0（对齐 project-list 页 EMPTY_TASK_COUNT 范式）；POST /users 的 displayName **后端必填**但表单无该字段 → displayName=username 兜底；roles 接口返回 `RoleItem[]`（非分页包裹，直接数组）
- **页面内扩展 token（不写 tokens.ts）**：roleTheme（管理员蓝/成员绿，仿原型 :35-43）+ statusTheme（启用绿/禁用红）+ **ROLE_FALLBACK 兜底主题**（自定义角色灰蓝 #475569 系，resolveRoleTheme 命中 roleTheme 否则兜底）——自定义角色场景原型未覆盖，必须加兜底否则 theme 查找崩
- **user-role-select 形态决策**：任务描述写「角色 select」，但原型 testid user-role-select 是**按钮组**（非原生 select 下拉）——保真优先保留按钮组结构，数据源换成 GET /roles 动态渲染（data-role=英文名/data-active），默认选中 member 角色；与「保真迁移」原则一致
- **重置密码弹层**：原型 user-reset-button 是占位无交互，本任务按要求新增弹层（user-reset-overlay/form/password-input/cancel/submit）→ POST /users/:id/reset-password {newPassword}
- **交互接线**：useQuery ["users"]（pageSize 100 拉满）+ useQuery ["roles"]；toggle → PATCH /users/:id/status {enabled:!current}（onSettled invalidate + onError 置 users-action-error）；create/reset mutation onSuccess 关弹层 + invalidate；编辑按钮保留占位（后端无 PATCH /users/:id）
- **弹层铁律**：照抄 projects 页 CreateProjectModal 模式（absolute inset 0 + 遮罩 + Esc + 每次打开重置表单），root position:relative + overflowY:auto，零 fixed/vh/vw
- **验证**：`npx tsc --noEmit` exit 0；`npm run build` exit 0（⚠️ 并行任务 agents/roles 页 lint warning + canvasui global.tsx no-explicit-any 曾致 build 失败——并行修复后复跑全绿，**非本任务引入**，需复跑确认）；Playwright 全链路——全部 testid 存在、统计条真实数值（总用户 3/管理员 2/成员 1/已禁用 0）、角色徽章「成员●」「管理员◈」、新增用户 → 列表即时出现 → 禁用（data-status=禁用/⛔）→ 启用 → 重置密码弹层关闭、角色按钮默认选中 member
- **Playwright 验证模式（可复用）**：authStore persist key=`agent-platform-auth`，add_init_script 注入 `{state:{token,user:{...}},version:0}`（用 json.dumps 序列化 token 防引号问题）；headless shell 用 1208 版 executable_path
- **清理**：后端无 DELETE /users → 测试用户用 `prisma.user.deleteMany({where:{username:{startsWith:'t10user'}}})` 清理（users.service.create 用 `u_${Date.now()}` 非 IdGeneratorService，无 idGen seed 污染，删后无需重启 server）；dev.db 恢复 3 个 seed 用户
- ⚠️ **.next 删除坑（重踩）**：rm -rf .next 会让运行中 dev（3001 turbopack）500 → 必须 kill dev（pid 含 sh+node+next-server 三层）+ rm -rf .next + `setsid nohup npm run dev` 重启（setsid 防 bash 工具超时连带杀 nohup 子进程）；SSR 验证 /users 只见「AI Agents」品牌区是正常现象（authStore 客户端水合后才渲染 children，curl 拿不到页面 testid，必须浏览器带登录态验证）

## [2026-08-07] Phase 3 T11 /roles 前端页（原型迁移 + 自定义角色 CRUD + Dock 7 项，已完成）
- **新建** `web/app/(main)/roles/page.tsx`（"use client"，~900 行）：保真迁移 `docs/agent-platform/prototypes/role-permission/index.tsx`——左角色列表 240px（role-item）+ 右权限矩阵 8 资源×6 操作 + PermissionScope + permission-note，data-testid 与原型一致（role-permission-root/role-item/add-role-button/permission-matrix/permission-scope/scope-project-select/scope-inner-role-select/permission-note）
- **页面内扩展 token（仿原型，不写 tokens.ts）**：`permCellTheme`（allow ✓#059669/#ECFDF5/#A7F3D0 / partial ◐#D97706/#FFFBEB/#FDE68A / deny ✗#94A3B8/#F8FAFC/#E2E8F0）+ `roleThemes`（admin #2563EB/◈ / member #059669/● / custom #7C3AED/✦）；RESOURCES/ACTIONS 的 key 对齐后端 PERMISSION_RESOURCES（tasks/chats/artifacts/agents/workers/skills/users/roles）与 PERMISSION_ACTIONS（view/create/edit/delete/review/manage）
- **后端权限结构映射关键**：预置角色 permissions 是简写 `{all:true}`（admin）与 `{all:false}`（member），**非 8×6 矩阵**！`matrixFromPermissions` 先判 `p.all===true→全 allow / all===false→全 deny`，否则逐格读 `{资源:{操作}}` 缺省 deny；`matrixToPermissions` 反向产出全量 8×6 bool 矩阵（PATCH/POST 用）——预置角色只读不提交，自定义角色提交全量矩阵
- **补原型缺失交互**：add-role-button → CreateRoleModal（名称 + 8×6 矩阵点击循环 允许↔禁止，默认全 deny，POST /roles）；自定义角色选中 → 矩阵/scope 可编辑 + dirty 时「保存修改」（PATCH permissions+scopes）+「删除角色」（confirm + DELETE，被引用 409 提示）；预置（isBuiltin）→ 矩阵只读 + 标题「内置只读」徽章 + 无操作行；PATCH/DELETE 403 FORBIDDEN_BUILTIN_ROLE 走 roles-action-error 内联提示（无 toast 组件，对齐 projects 页 create-error 模式）
- **PermissionScope 受控化**：原型内部 useState scopeType 纯展示 → 受控版（value+onChange+editable），scopeType 从 value.global 推导 + key=activeRole.id 重挂载（对齐原型 key=def.key）；projectPool/innerRolePool 静态池对齐原型文案（任务不做租户 RBAC）
- **Dock 7 项同步**：nav-dock NAV_ITEMS 加 `{key:"roles",label:"角色权限",icon:"⚖"}`（7→8？不，6→7 项）；app-shell KEY_TO_PATH 加 roles:"/roles"（KEY_LOOKUP 从 KEY_TO_PATH 派生自动含 roles 反向映射）+ CMDK_NAV_PATH 加 角色权限:"/roles" + PAGE_TITLE 加 roles；cmdk-panel DEFAULT_CMDK_ITEMS 导航组加「角色权限⚖」（导航组 6→7 项，与 Dock 图标一一对应）
- **验证**：`npx tsc --noEmit` exit 0；`npm run build` exit 0（rm -rf .next 后干净重试，15/15 页面含 /roles 8.23 kB）；dev server 环境恢复 3001 turbopack
- ⚠️ **Next 15.5.22 build flaky bug（新发现，与代码无关）**：`Collecting page data` 阶段偶发 `ENOENT pages-manifest.json` / `Cannot find module for page: /favicon.ico`（app/favicon.ico 静态元数据路由的 route manifest 回归，Vercel PR #74885/#74876，v15.2.0-canary.9 引入）——**rm -rf .next 后重试即可过**，非业务代码问题；learnings 既有「build 失败先核对磁盘文件一致性再清缓存重试」再次验证
- ⚠️ **环境并发坑**：并行任务 `next dev --turbopack` 运行中 build 会与之互踩 .next（dev 写 .next 与 build 冲突）→ build 独占验证流程：kill dev → rm -rf .next → build → 重启 dev（ss -tlnp 反查端口 PID 精确 kill，pkill 会自杀）；dev 端口冲突时后起者落到 3002，需收敛回 3001 单一实例
- ⚠️ **users 页 tsc 假错**：`tsc --noEmit` 首次报 `.next/types/validator.ts users/page default missing`——是 .next 陈旧类型缓存（并行任务刚把 users 页从占位改成完整实现），rm -rf .next 后即消，非代码问题
- **并行任务 build 竞态**：canvasui/global.tsx `ComponentType<any>` no-explicit-any 是 build 阻断 error（并行任务已知，learnings T10 记录过）——本任务加 `// eslint-disable-next-line` 豁免（各效果组件 props 类型各异，注册表统一收窄破坏赋值兼容，运行时零改动）

## [2026-08-07] T14 文档库端点可用性验证 + 种子数据（已完成）
- **筛选参数无需补齐**：QueryArtifactsDto 已含 type(@IsIn text/doc/file)/accepted(@IsIn true/false)/page/pageSize；findByTask 已实现 type 透传（Prisma where）+ accepted 按 currentVersion 内存过滤 + 分页（pageSize 上限 100）
- **端点实测（全部 201/200 通过）**：GET /tasks/:id/artifacts?type=doc → 仅 doc；?accepted=true/false → 按 currentVersion acceptedFlag 过滤正确；分页 pageSize=1&page=2 → 第 2 页命中；非法 type=xxx → 400（ValidationPipe）
- **版本查看器响应结构**：GET /artifacts/:id → {id,taskId,type,title,currentVersion,createdAt,updatedAt,versions:[ArtifactVersionDto]}；GET /artifacts/:id/versions/:version → 单版本全字段（id/artifactId/version/contentRef/filePath/sha256/acceptedFlag/authorAgentId/changeNote/createdAt）；版本不存在 → 404
- **⚠️ accept 是任务级基线锁定**：tasks.service accept 的 afterCommit 把该任务**所有** artifact 当前版本 acceptedFlag=true（12 篇 §7）。「同任务一真一假」无法靠 accept 达成——必须先验收（任务下只有 text）再追加 doc（新 title 走新建 v1，acceptedFlag 默认 false）
- **验收后 append 联动实测**：accept（任务 completed）→ POST 新 title doc → 201 archived + 任务自动退回 in_progress（12 篇 §7 联动，CAS 命中才广播）；已验收**同 title** append 才 409（ARTIFACT_ACCEPTED_IMMUTABLE），新 title 不拦截
- **种子数据（保留，T12/T15 联调用，勿删）**：
  - t_0000000002（p_seed_1「智能」）：art_0000000002 text「需求分析结论」v1 accepted=true（mark-pending-review→accept 真实流程）；art_0000000005 doc「需求规格说明书」v1 accepted=false（fileRef s3://seed/docs/requirement-spec-v1.pdf）
  - t_0000000004（p_seed_1，本任务新建「种子数据-文档产出任务」）：art_0000000004 file「测试数据包」v1 accepted=false（fileRef s3://seed/files/test-data-pack.zip）
- 验证：npx jest --no-cache src/artifacts --silent 3 suites / 30 tests 全过；npm run build exit 0

## [2026-08-07] Phase 3 T13 产出物入口改造（已完成）
- **背景**：看板/项目卡/群聊页三处跳转到产出物页 /artifacts?pid=（Phase 3 产出物模块入口，原型无此入口，用户确认新增）
- **三入口实现**：
  - `board/page.tsx`：board-title 区改 `justifyContent:space-between`，标题右侧加「产出物」按钮（data-testid=`artifacts-entry-button`，pill 白底边框样式复用 neutral/radius token）→ `router.push(\`/artifacts?pid=${pid}\`)`（pid 为 URL ?pid= state）
  - `projects/page.tsx`：ProjectCard props 加 `onArtifacts`；卡片底部任务统计区右侧加「产出物」小按钮（data-testid=`project-artifacts-entry`）→ `router.push(\`/artifacts?pid=${p.id}\`)`；**onClick 内 `e.stopPropagation()` 防冒泡触发卡片主跳转 /board?pid=（MUST 要求）**；ProjectsPage map 处传 onArtifacts
  - `tasks/[id]/page.tsx`：TaskPanel props 加 `onOpenArtifacts`；产出物区占位（原 title=Phase 3 无跳转）改为真实按钮：有 backgroundDocs 时逐项 `role="button"+tabIndex` 点击跳转、无产出物时渲染「查看产出物」按钮（data-testid=`artifact-link` 保留）；调用处 `router.push(\`/artifacts?pid=${task.projectId}\`)`（TaskDetail.projectId 已存在）
- **app-shell KEY_LOOKUP 补 `artifacts: "project"`**：/artifacts 路由首段映射 project → Dock 高亮「项目」入口（MUST 决策：补映射而非空高亮）
- **验证**：`npx tsc --noEmit` exit 0；`npm run build` exit 0（/artifacts 未在路由表属预期，T12 页面未建）；Playwright（3101 turbopack）5/5 PASS——看板按钮可见+跳 /artifacts?pid=p_seed_1、项目卡跳 /artifacts?pid=p_seed_2（卡片真实 pid）+ 不触发主跳转（URL 无 board）、群聊 task-info-panel artifact-link 跳 /artifacts?pid=p_seed_1
- **⚠️ /artifacts 路由未建**：点击跳转后 404（console 404 为预期，T12 完成页面后自动消除）；本任务只做入口代码
- **⚠️ build 污染 3001 再现**：登录页 500 = .next 被 build 污染 → 标准流程：备份 .next → build → 3101 独立 dev 冒烟 → kill 3101 → rm -rf .next + cp 备份回（用户 3001 零影响）；3001 若仍异常由用户 kill+rm .next 重启

## [2026-08-07] Phase 3 T12 /artifacts 产出物聚合页（已完成）
- **新建** `web/app/(main)/artifacts/page.tsx`（"use client"，~640 行）：路由 /artifacts?pid=（与 /board 同模式，AppShell content 区）
- **数据架构（项目级聚合）**：GET /projects/:pid/tasks 拿任务列表（下拉数据源 + taskName 映射）→ 对每个任务 GET /tasks/:id/artifacts 循环聚合（**T6 是任务级端点，无项目级总接口**，前端 Promise.all 并行请求，数量少可接受）；三筛全走后端参数（任务下拉过滤目标任务集合，type/accepted 走请求 query），queryKey `["artifacts", pid, taskKey, typeKey, acceptedKey]` 变化重新 fetch（对齐 board 状态筛模式）
- **三筛**：任务下拉（原生 select，data-testid=task-filter-select）+ 类型筛按钮组（全部/结论文本/文档/文件，TYPE_OPTIONS key=text/doc/file）+ 验收筛按钮组（全部/已验收/未验收，key=true/false）；默认全部；筛选联动（handleXChange 同时 setSelectedId(null) 收起展开区）
- **列表项**：类型徽章（页面内 ARTIFACT_TYPE_THEME：text 紫 #7C3AED / doc 蓝 #2563EB / file 绿 #059669，对齐原型 artifactTypeTheme）+ 标题（flex:1 ellipsis）+ 所属任务（maxWidth 180 ellipsis）+ 版本 v{n}（neutral[200] pill）+ 作者（authorAgentId → AGENT_ID_ROLE 映射 AgentAvatar+角色名，**未知/空 → 「系统」**）+ **验收徽章（ACCEPTED_THEME 已验收绿 #059669/未验收灰 #64748B，data-accepted）** + 时间（本地格式 YYYY-MM-DD HH:mm）
- **版本查看器**：点击行 inline 展开（文档流，无浮层）→ GET /artifacts/:id 拿 versions（升序）→ 版本切换 `‹ v1 ›` pills（activeVersion ?? currentVersion 判定当前高亮 roleText.product）→ GET /artifacts/:id/versions/:version 详情 → 内容区 text=contentRef pre-wrap、doc/file=文件引用 filePath+sha256 前 16 位 → 时间线（versions reverse + formatTime，当前版本在前）+ 收起 ✕（onClose）；key=artifactId 重挂载
- **空态**：tasks 空 → EmptyState「暂无任务」；items 空 → EmptyState「暂无产出物」（组合筛可达）
- **验证**：`npx tsc --noEmit` exit 0；`npm run build` exit 0（/artifacts 4.18 kB 入路由表）；Playwright 27/27 PASS（登录注入）——聚合 3 产出物/类型徽章三色/验收徽章 1true+2false/三筛逐项联动/组合空态/版本查看器展开+v1 高亮+时间线+收起/doc 文件引用；无 pid 重定向 /projects PASS
- **⚠️ 双 dev 共享 .next 竞态（本任务最大坑）**：3001 用户 dev 与冒烟 3101 共享 web/.next，同时运行互相破坏编译产物 → /artifacts 页面客户端偶发水合失败 → AppShell 守卫误跳 /login（HTML 200 但 token 状态异常）。**稳定解法：仓库内隔离目录 web-iso**（cp -a web → 删 .next → **真实复制 node_modules 576M**（Turbopack 拒绝 symlink：外层 symlink「points out of the filesystem root」+ npm 嵌套 node_modules symlink 也不认）+ next.config.ts 加 `distDir: '.next-iso'`）→ `next dev --turbopack -p 3200` 完全隔离 → Playwright 打 3200 稳定
- **⚠️ Playwright 登录态注入偶发失效**：add_init_script 写 localStorage 后，若 zustand persist rehydrate 时序与 AppShell 守卫竞态 → 偶发跳 /login（同 URL 有时成功有时失败，非确定性）。**改用真实登录表单流程最稳**（username/password/login-button testid 登录 → URL 轮询）——本任务 27/27 全用真实登录
- **⚠️ build 污染 3001（重踩）**：rm -rf .next 后 3001 dev ENOENT app-build-manifest（500）→ 标准恢复：kill 3001 dev 三层 PID（sh+node+next-server）→ rm -rf .next → `PORT=3001 setsid nohup npm run dev` 重启（setsid 防 bash 超时连带杀）
- **零改动**：tokens.ts / 无新依赖 / 不迁移 task-detail TabBar 结构

---

# Phase 3 Agent 与产出物（M3 里程碑）— 收口总结

> 日期：2026-08-07 ｜ 范围：`.omo/plans/phase3-agent-artifacts.md` T1-T16（T17 收口）｜ 交付：AgentsModule / ArtifactsModule / 虚拟团队 / 验收联动 / 前端四页 + 三入口 + Dock 7 项

## 后端模块结论

### AgentsModule（模板只读 403 / 克隆血缘 / available-models 静态）
- 契约：GET /agents（type 过滤 + 分页 + 扩展字段 skillIds/toolEffects/permissionScope/defaultModelId/baseAgentId）、GET /agents/:id、POST /agents（custom 三表事务）、POST /agents/:id/clone（baseAgentId 血缘 + 三表深拷贝 + 与源解耦）、PATCH/DELETE /agents/:id、GET /agents/:id/available-models
- **模板只读 403**：PATCH/DELETE 对 type=template → 403 `PERMISSION_AGENT_READONLY`（14 篇 §2.2 / FR-33）；clone/custom 可写可删。前端只读判定必须用 `type === 'template'`（而非 `type !== 'custom'`），否则克隆体误判只读导致编辑闭环断裂
- **克隆血缘**：baseAgentId=源 id，副本改 prompt/skill 不影响源（解耦验证通过）；克隆不复制会话/任务关系（仅三表 + 血缘）
- **available-models 静态占位**：返回固定模型数组（gpt-4o/claude-3-5-sonnet/deepseek-v3，与前端 MODEL_NAMES 一致），Phase 4 接 worker 真实探测
- ⚠️ 坑：skills 表 seed 未建 → POST custom 带 skillIds 会 500 P2003 FK（agent_skills.skillId→skills 不存在），skillIds 无服务层存在性校验，依赖 DB FK 兜底；前端技能面板因此纯静态展示不随 PATCH 提交

### ArtifactsModule（json_schema 校验 / 幂等 append / 409 不可变 / 验收联动 / 退回进行中）
- **协议校验**：validateArtifactDeclaration（type 枚举 text/doc/file、text→content 必填、doc/file→fileRef 必填）；非法声明 → 事件链路回退普通消息不产生归档（onArtifactSubmitted 不抛错返回 invalid）
- **归档链路**：消费 artifact.submitted（T2 触发式 mock 广播，scope=task）；append 递增版本 + **sha256 幂等去重**（同 task+type+sha256 已存在 → duplicate 版本不增）
- **409 不可变**：已验收版本写操作 → 409 `ARTIFACT_ACCEPTED_IMMUTABLE`（幂等去重优先，命中不触发 409）；409 抛在事务内回滚零写
- **验收联动（accept 任务级标记）**：tasks.service accept afterCommit 标记该任务**所有** artifact 当前版本 accepted_flag=true——⚠️ 必须用 `OR: artifacts.map(a=>({artifactId:a.id, version:a.currentVersion}))` 精确组合，不能用 `{artifactId:{in}, version:{in}}` 交叉匹配（会误标非当前版本）
- **append 退回进行中**：验收后新 append → 任务 completed→in_progress（CAS updateMany + task.status.changed global 广播）；artifacts 服务不 import tasks 服务（避免循环依赖），直接 prisma + realtime
- 文档库端点：GET /tasks/:id/artifacts（分页 + type/accepted 筛选）、GET /artifacts/:id（含 versions 升序）、GET /artifacts/:id/versions/:version；accepted 筛选因 Prisma 无法跨行引用 currentVersion，先取候选 + 批量查 versions 聚合再内存过滤

### users / AdminGuard / 角色矩阵
- POST /users（bcrypt + 冲突校验 409 USERNAME_CONFLICT/EMAIL_CONFLICT，逻辑对齐 auth.service.register 独立实现）、POST /users/:id/reset-password
- **AdminGuard 落地**：从占位放行改为真实校验（查 user+role），放行条件 `permissions.all===true`（seed admin 简写）/ `permissions.users.manage===true`；无权限 → 403 `FORBIDDEN_ADMIN`；必须注册为 users.module providers
- **角色矩阵 CRUD**：GET/POST/PATCH/DELETE /roles；预置角色（isBuiltin 或 admin/member）只读 → 403 `FORBIDDEN_BUILTIN_ROLE`；DELETE 前查 user.count 防外键 409；权限矩阵 8 资源×6 操作（对齐原型 role-permission）
- ⚠️ 坑：Prisma Json 列必须 `as Prisma.InputJsonValue`；jest mockResolvedValue 会让 update 内两次 findUnique 返回同对象误判 409，第二次用 mockResolvedValueOnce(null)

## 前端四页结论

| 页 | 原型 | 关键实现 |
|----|------|---------|
| /agents | agent-config（975 行） | 左列表 + 右五块配置面板；模板只读态；克隆/新建调真实 API；工具 effect 可编辑（toolAction 无 FK 安全）；技能静态展示 |
| /users | user-management（779 行） | 统计条 + 列表 + UserFormModal + ResetPasswordModal；GET /users 无角色名 → 并行 GET /roles 映射；displayName=username 兜底；role-select 保真按钮组 |
| /roles | role-permission（660 行） | 左角色列表 + 右 8×6 权限矩阵 + PermissionScope；自定义角色 CRUD（补原型缺失交互）；预置只读；**Dock 第 7 项「角色权限⚖」** + CMDK 同步 |
| /artifacts?pid= | 聚合页（新增） | 任务/类型/验收状态三筛默认全部；列表含验收徽章（已验收绿/未验收灰）；版本查看器（‹ v2 v1 › + 时间线）；空态 |

- 入口改造：看板「产出物」按钮（artifacts-entry-button）+ 项目卡片次级入口（project-artifacts-entry，stopPropagation 防冒泡）+ 群聊页 artifact-link 真实跳转 → /artifacts?pid=
- 导航：app-shell KEY_LOOKUP 补 `artifacts: "project"`（/artifacts 高亮「项目」）；/roles 挂 Dock + CMDK + PAGE_TITLE
- 数据架构决策：/artifacts 是任务级端点无项目级总接口 → 前端 Promise.all 循环聚合（数量少可接受）；三筛全走后端参数（queryKey 变化重新 fetch）
- 页面内扩展 token 模式（不写 tokens.ts）：toolEffectMeta / toolSourceMeta / roleTheme / statusTheme / permCellTheme / ARTIFACT_TYPE_THEME / ACCEPTED_THEME + 兜底主题（自定义角色灰蓝）

## 关键坑清单（Phase 3 沉淀）

1. **accept 是任务级基线锁定**：accept 标记任务所有 artifact 当前版本；「同任务一真一假」只能先验收再追加新 title（新 title 走新建 v1 默认未验收）；验收后同 title append 才 409，新 title 不拦截
2. **Next 15.5.22 build flaky bug**：`Collecting page data` 偶发 `ENOENT pages-manifest.json` / `Cannot find module for page: /favicon.ico`（Vercel PR #74885/#74876，v15.2.0-canary.9 引入）——rm -rf .next 重试即过，非代码问题
3. **双 dev 共享 .next 竞态**：3001 用户 dev 与冒烟 3101 共享 web/.next 互相破坏 → 页面偶发水合失败 → AppShell 守卫误跳 /login。稳定解法：仓库内隔离目录 web-iso（真实复制 node_modules 576M + next.config.ts 加 `distDir: '.next-iso'` + `next dev -p 3200`）
4. **Playwright 登录态注入偶发失效**：add_init_script 写 localStorage 与 zustand persist rehydrate 竞态 → 偶发跳 /login（非确定性）。稳定解法：**改用真实登录表单流程**（username/password/login-button testid → URL 轮询）；authStore persist key=`agent-platform-auth`
5. **build 独占验证流程**：kill dev → rm -rf .next → build → 重启 dev（ss -tlnp 反查端口 PID 精确 kill，pkill 会自杀）；build 前备份 web/.next（/tmp/opencode/web-next-backup），冒烟后恢复保用户 3001 零影响
6. **Nest DI number 参数坑（重踩）**：构造器任何非服务参数（即使带默认值）都会炸启动（Number 元数据被当注入 token），延迟/阈值配置放公开类字段
7. **并行协作 build 竞态**：工作区并发修改时 build 失败先核对磁盘文件与报错符号一致性，再 rm -rf .next 重试；canvasui global.tsx `ComponentType<any>` no-explicit-any 是 build 阻断 error（加 eslint-disable 豁免）

## 测试与门禁

- server：**22 suites / 281 tests 全绿**（Phase 2 基线 201 → +80）；`npm run build` exit 0；零 DDL（schema 复用）
- web：`npx tsc --noEmit` exit 0；`npm run build` exit 0（15 页面含 /agents /users /roles /artifacts）
- Playwright 冒烟：/agents 只读+克隆闭环 / users CRUD / roles 矩阵+Dock 7 项 / artifacts 三筛+版本查看器+验收徽章 27/27 / 三入口跳转 5/5
- M3 端到端（T15）：Agent 配置 → 创建任务选 Agent → 启动（sessions active）→ mock 产出 → 归档 → 聚合页 → mark-pending-review → accept → 验收徽章 + accepted_flag + 409 不可变，闭环跑通
