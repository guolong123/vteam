# Phase 2 任务与群聊核心（M2）开发计划

## TL;DR

> **Quick Summary**: 基于 18 篇《推进计划》§6，实现 Phase 2「任务与群聊核心」——后端 TasksModule（五态状态机 + 看板 + 团队 + task_events）+ ChatModule（群聊落库/历史/游标 + SSE 第③级）+ RealtimeModule 完整改造（scope 订阅 + 鉴权 + 事件持久化）+ MockDispatcher（确定性模板回复）；前端 task-board 接真实数据 + group-chat/dm-chat 迁移 + task-create 增强；达成里程碑 M2（任务创建 → 启动 → 群聊消息实时流转 mock 回复 → 看板五态流转 → 断线补拉）。
>
> **Deliverables**:
> - `server/`：TasksModule（10 端点 + 五态状态机 + task_events + 看板 + team）、ChatModule（频道/消息/历史游标）、RealtimeModule 完整改造（scope/鉴权/字符串事件 id/事件持久化）、AgentsModule 简化（GET /agents + seed 4 内置角色）、MessageDispatcher 接口 + MockDispatcher 实现
> - `web/`：useSSE hook（query token + since 续拉 + 事件分发）、MessageInput 重写（受控 + @ chips）、group-chat 页（/tasks/[id]）、dm-chat 页（/messages/[id]）、task-board 接真实数据、task-create 接真实提交
> - 里程碑 **M2**：创建→启动→群聊实时流转（mock 回复）→看板流转→断线补拉不丢
>
> **Estimated Effort**: XL
> **Parallel Execution**: YES - 4 波执行
> **Critical Path**: Realtime 改造 → TasksModule → ChatModule → 前端 SSE+群聊 → M2 联调

---

## Context

### Original Request
用户要求启动下一个计划：Phase 2 任务与群聊核心（18 篇 §6），实现完整范围（后端 TasksModule + ChatModule + MockDispatcher + 前端 4 页 + M2 联调）。

### Interview Summary
**Key Discussions**（用户确认 2026-08-07）:
- 范围：全量 Phase 2（TasksModule + ChatModule + MockDispatcher + 前端 4 页 + M2 联调）
- MockDispatcher：确定性模板回复（按角色预置模板，1-3s 延迟回流，可复现可断言）
- Agent 数据：后端 seed 预置 4 个内置角色 + GET /agents 简单端点
- 看板形态：保持「筛选条 + 响应式卡片网格」（对齐原型，不做五列 kanban）
- SSE 基建：完整改造（scope 订阅 + 鉴权 + 事件 id 与消息主键同源 + 事件持久化）
- SSE 鉴权：query token（EventSource 无法设 header）
- 消息主键：应用层自增序号前缀（m_1/m_2...）

**Research Findings**（三 agent 并行审计）:
- server：19 表全建齐（tasks 五态+version 乐观锁、sessions/channels 唯一约束、task_events、messages 游标索引）；RealtimeService 基座完整但缺 scope/鉴权/落库/字符串 id；TasksModule/ChatModule/MockDispatcher 需从零建；守卫断层（Projects 用 PlaceholderAuthGuard）
- web：task-board 静态 seed 网格；MessageInput 纯展示需重写；SSE 前端未接入；ChatBubble 三态可直接用；路由建议 /tasks/[id] + /messages/[id]
- 契约：五态迁移表 + 409 TASK_INVALID_TRANSITION；8 步发消息流程；SSE 事件帧；事件名统一 task.status.changed（点号）

### Metis Review
**Identified Gaps**（addressed）:
- 看板形态冲突（原型网格 vs §6.3 五列）→ 用户拍板保持网格
- RealtimeService 结构性缺口（number id vs 字符串主键、无落库、无 scope）→ 用户确认完整改造
- 守卫断层（PlaceholderAuthGuard 覆盖 req.user）→ 新模块用 JwtAuthGuard + 顺带清理
- seed 无 Agent、mock pid 与 seed 不一致 → 新增 seed 任务 + 修正 pid
- 事件名坑（task.status.changed vs task_status_changed）→ 统一点号全链路
- team 端点归属（§6.1 vs §7.2）→ 锁定 Phase 2

---

## Work Objectives

### Core Objective
完成 Phase 2：后端任务全生命周期（五态状态机 + 群聊实时流转 mock）+ 前端看板/群聊/私聊真实数据接入，达成 M2 里程碑。

### Concrete Deliverables
- `server/`：TasksModule、ChatModule、RealtimeModule 完整改造、AgentsModule 简化、MockDispatcher
- `web/`：useSSE、MessageInput 重写、group-chat/dm-chat 页、task-board/task-create 增强
- M2 验收证据

### Definition of Done
- [x] `cd server && npm run test` → 全量单测通过（含 TasksModule 状态机/ChatModule/Realtime 改造）
- [x] `cd server && npm run start:dev` → `GET /api/v1/health` 200
- [x] `cd web && npm run build` → 退出码 0
- [x] M2 联调：创建任务 → 启动 → 群聊发消息 @ Agent → SSE loading→回复回流 → 看板状态流转 → 断线补拉不丢
- [x] 前端 group-chat/dm-chat 与原型逐页视觉一致（Playwright 截图对比 + testid 断言）

### Must Have
- TasksModule 五态状态机（迁移表驱动 + CAS 乐观锁 + task_events 同事务落库 + 409 TASK_INVALID_TRANSITION + 幂等）
- ChatModule（频道/发消息 8 步/历史游标 {items,nextCursor}/SSE 第③级事件广播）
- RealtimeModule 完整改造（scope 订阅 + query token 鉴权 + 字符串事件 id 与消息主键同源 + 事件持久化）
- MockDispatcher（MessageDispatcher 接口抽象，确定性模板回复，Phase 4 零改动替换）
- 前端 useSSE hook + MessageInput 重写 + group-chat/dm-chat 页 + 看板接真实数据
- 事件名全链路统一 `task.status.changed`（点号）

### Must NOT Have (Guardrails)
- 不实现 Phase 3 能力：AgentsModule 完整 CRUD（仅 GET /agents 简单端点 + seed）、ArtifactsModule（背景文档只入 backgroundDocs Json 字段，不动 artifacts 表）、role-permission/user-management
- 不实现 Phase 4：WorkersModule、真实 WorkerClient、真实上下文注入、available-models、git 凭证
- 不实现群聊扩展：消息撤回/编辑/删除、已读回执、输入中指示、回复引用、图片上传
- 不做任务删除/恢复、撤销 accept、归档恢复（归档为终态）
- 不引入新依赖（SSE 用 EventSource 原生、mock 不接 LLM SDK、不引 sse 库）
- 前端共享 token/组件视觉零改动（§3.1 最高约束）；不"顺手优化"
- MockDispatcher 不模拟流式 parts、不产生 artifact.submitted 事件

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** - 全部验证由执行 agent 完成，证据存 `.omo/evidence/`。

### Test Decision
- **Infrastructure exists**: 是（server jest 基座 + web build）
- **Automated tests**: 后端 jest（关键模块 TDD 优先）+ 前端 Playwright 原型对比验收
- **Framework**: jest（server）/ Playwright browse 或 qa skill（web 验收）
- **If TDD**: TasksModule 状态机、ChatModule、Realtime 改造测试优先（RED→GREEN）

### QA Policy
- **后端**: Bash（curl）+ jest 断言状态码/响应字段/错误 code（TASK_INVALID_TRANSITION 等）
- **前端/UI**: Playwright（browse/qa skill）截图对比 + data-testid 断言 + SSE 事件流验证
- **SSE**: 脚本化 curl -N 验证事件流 + since 补拉；断线重连用代码控制（非人工断网）
- **Build**: tsc/build 退出码 0

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (基建收尾 + 并行起点，5 任务):
├── Task 1: RealtimeModule 完整改造（scope/鉴权/字符串事件 id/事件持久化）[deep]
├── Task 2: 守卫统一（ProjectMembershipGuard + 清理 PlaceholderAuthGuard）[deep]
├── Task 3: 消息主键生成器 + TASK_STATUS/事件常量 [quick]
├── Task 4: seed 4 内置 Agent + GET /agents 简单端点 [quick]
└── Task 5: 前端 useSSE hook（query token + since 续拉 + 事件分发）[unspecified-high]

Wave 2 (核心模块 MAX PARALLEL，7 任务):
├── Task 6: TasksModule 创建/详情/看板/CRUD（依赖 1,2,3,4）[deep]
├── Task 7: TasksModule 状态机（start/accept/reject/mark-pending-review/archive）（依赖 6）[deep]
├── Task 8: TasksModule team 端点（依赖 6,7）[unspecified-high]
├── Task 9: ChatModule 频道/发消息/历史游标（依赖 1,2,3,6）[deep]
├── Task 10: MockDispatcher + MessageDispatcher 接口（依赖 9）[unspecified-high]
├── Task 11: MessageInput 重写（受控 + @ chips）（依赖 5）[visual-engineering]
└── Task 12: task-board 接真实数据 + status_changed（依赖 5,6）[visual-engineering]

Wave 3 (前端页面迁移，5 任务):
├── Task 13: group-chat 页 /tasks/[id]（依赖 5,9,10,11）[visual-engineering]
├── Task 14: dm-chat 页 /messages/[id]（依赖 13）[visual-engineering]
├── Task 15: task-create 增强（真实提交 + Agent 列表 + 修正 pid）（依赖 4,6）[visual-engineering]
├── Task 16: AppShell 路由/标题/Dock 高亮配套（依赖 13,14）[quick]
└── Task 17: SSE 前端事件→Query 缓存桥（依赖 5）[unspecified-high]

Wave 4 (联调收口):
├── Task 18: M2 联调（创建→启动→群聊@→SSE 回流→看板流转→断线补拉）[unspecified-high]
├── Task 19: 原型一致性验收（group-chat/dm-chat/task-board/task-create 截图对比）[unspecified-high]
└── Task 20: 构建/测试全量验证（M2 证据汇总）[quick]

Wave FINAL (评审，4 并行):
├── Task F1: 计划合规审计 (oracle)
├── Task F2: 代码质量评审 (unspecified-high)
├── Task F3: 真实 QA（M2 全流程走查）(unspecified-high)
└── Task F4: 范围保真检查 (deep)
-> 汇总结果 -> 用户确认

Critical Path: Task 1 → Task 6 → Task 7 → Task 9 → Task 10 → Task 13 → Task 18 → F1-F4
```

### Dependency Matrix
- **1**: - 6, 9, 17
- **2**: - 6, 7, 8, 9
- **3**: - 6, 7, 9
- **4**: - 15
- **5**: - 11, 12, 13, 17
- **6**: 1, 2, 3, 4 - 7, 8, 12, 15
- **7**: 6 - 8
- **8**: 6, 7 - 18
- **9**: 1, 2, 3, 6 - 10, 13, 14
- **10**: 9 - 13
- **11**: 5 - 13, 14
- **12**: 5, 6 - 19
- **13**: 5, 9, 10, 11 - 16, 18
- **14**: 13 - 16, 18
- **15**: 4, 6 - 18, 19
- **16**: 13, 14 - 18
- **17**: 5 - 18
- **18**: 8, 10, 13, 14, 15, 16, 17 - 19, 20
- **19**: 12, 15 - 20
- **20**: 18, 19 - F1-F4

### Agent Dispatch Summary
- **Wave 1**: 5 - T1→deep, T2→deep, T3→quick, T4→quick, T5→unspecified-high
- **Wave 2**: 7 - T6→deep, T7→deep, T8→unspecified-high, T9→deep, T10→unspecified-high, T11→visual-engineering, T12→visual-engineering
- **Wave 3**: 5 - T13→visual-engineering, T14→visual-engineering, T15→visual-engineering, T16→quick, T17→unspecified-high
- **Wave 4**: 3 - T18→unspecified-high, T19→unspecified-high, T20→quick
- **FINAL**: 4 - F1→oracle, F2→unspecified-high, F3→unspecified-high, F4→deep

---

## TODOs

- [x] 1. RealtimeModule 完整改造（scope/鉴权/字符串事件 id/事件持久化）

  **What to do**:
  - 改造 `server/src/realtime/realtime.service.ts`：
    - 事件 id 从 number 改为**字符串主键**（域前缀 `ev_<自增序号>`，与消息主键同源语义，Task 3 生成器复用）——保证 SSE `id` 与消息游标可统一比较
    - `emit/broadcast` 支持 scope（taskId/channelId 标注），`subscribe(listener, scope)` 按 scope 过滤
    - **事件持久化**：新增 events 落库（复用 task_events 表不可行——那是任务专用；新建 `realtime_events` 表或通用事件表，字段 id/type/scope_type/scope_id/payload/timestamp，索引 (scope_type, scope_id, id)），「事件先落库后转发」（08 §7.3）
  - 改造 `server/src/realtime/realtime.controller.ts`：
    - `GET /api/v1/events` 加 `?scope=task:<id>` / `?scope=channel:<id>` 参数解析
    - **鉴权**：query token 校验（`?token=<jwt>`，配合 Task 5 前端 useSSE）；校验调用者可访问该 scope（task→项目成员、channel→成员）
    - since 续拉改为读持久化事件表（替代内存环形缓冲，maxLog 保留为实时层缓冲）
  - 更新 `realtime.service.spec.ts` / `realtime.controller.spec.ts` 适配新行为

  **Must NOT do**:
  - 不重构事件总线核心机制（仍 EventEmitter + rxjs Observable）
  - 不改事件帧格式契约 `{id, type, payload, timestamp}`（id 类型改为字符串，帧结构不变）
  - 不引入新依赖（不引 redis/数据库专用队列）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: SSE 基座改造（scope/鉴权/持久化/游标统一）是 Phase 2 地基，需严谨设计
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 2-5）
  - **Blocks**: 6, 9, 17
  - **Blocked By**: None

  **References**:
  - `server/src/realtime/realtime.service.ts`（现有基座：emit/broadcast/getEventsSince/环形缓冲）
  - `server/src/realtime/realtime.controller.ts`（SSE 端点：since/心跳/toMessageEvent）
  - 09 篇 §4.1/§4.2（事件帧格式、scope 语义、第③级事件 data 结构）
  - 08 篇 §7.3（事件先落库后转发）
  - `server/prisma/schema.prisma`（新增 realtime_events 表的模型定义，参照 task_events 模式）

  **Acceptance Criteria**:
  - [ ] `GET /api/v1/events?scope=task:<id>&token=<jwt>` 只推送该 task 的事件（scope 过滤生效）
  - [ ] 无 token 或无效 token → 401；非项目成员访问 scope → 403
  - [ ] 事件 id 为字符串格式（`ev_<n>`），与 Task 3 消息主键同源可比较
  - [ ] 事件落库：重启服务后 `?since=<lastId>` 仍可补拉（持久化生效）
  - [ ] `cd server && npm run test` → realtime spec 全过

  **QA Scenarios**:
  ```
  Scenario: scope 过滤 + 鉴权（curl）
    Tool: Bash (curl)
    Preconditions: server 起 + admin token
    Steps:
      1. `curl -sN "http://localhost:3000/api/v1/events?token=$TOKEN&scope=task:t_1"` 后台订阅
      2. 触发 t_1 事件（broadcast test）→ 断言仅收到 t_1 相关事件
      3. `curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/api/v1/events"` → 401（无 token）
    Expected Result: scope 过滤生效、无 token 401
    Evidence: .omo/evidence/phase2-task-1-scope.md

  Scenario: 事件持久化 + since 补拉
    Tool: Bash (curl)
    Preconditions: 已产生事件 id=ev_5
    Steps:
      1. 重启 server（清内存）
      2. `curl -sN "http://localhost:3000/api/v1/events?token=$TOKEN&since=ev_3"` → 收到 ev_4, ev_5
    Expected Result: 重启后 since 补拉仍有效（事件落库）
    Evidence: .omo/evidence/phase2-task-1-persist.md
  ```

  **Commit**: YES
  - Message: `feat(server): RealtimeModule 完整改造（scope/鉴权/字符串事件 id/持久化）`
  - Files: server/src/realtime server/prisma
  - Pre-commit: `cd server && npm run test`

- [x] 2. 守卫统一（ProjectMembershipGuard + 清理 PlaceholderAuthGuard）

  **What to do**:
  - 新建 `server/src/common/guards/project-membership.guard.ts`：`ProjectMembershipGuard` —— 读取 `req.user.id`（JWT 来源），校验 `project_members` 表存在 (projectId, userId) 记录；缺失 → 403 PERMISSION_PROJECT_NOT_MEMBER；`@ProjectId()` 装饰器从路由参数/`@Param('pid')` 注入
  - 清理 `server/src/projects/placeholder-auth.guard.ts` 的覆盖行为：ProjectsModule 端点改为走全局 JWT 守卫（req.user 来自 JWT），移除 x-user-id 依赖
  - 更新 `projects.controller.ts`：`@UseGuards(ProjectMembershipGuard)` 替换 PlaceholderAuthGuard；`@CurrentUser()` 改为读 JWT 用户
  - 更新 `projects.service.spec.ts` 适配（若断言 x-user-id 行为）
  - 同步前端 `projects/page.tsx`：移除 `x-user-id` header（api.ts 已自动带 Bearer）

  **Must NOT do**:
  - 不改 AuthModule JWT 机制
  - 不实现角色权限矩阵（Phase 3）
  - 不破坏 login/register 的 @Public 路径

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 守卫重构涉及全局认证链与前端请求头，需谨慎避免破坏现有登录/项目功能
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 1,3-5）
  - **Blocks**: 6, 7, 8, 9
  - **Blocked By**: None

  **References**:
  - `server/src/projects/placeholder-auth.guard.ts`（现有 x-user-id 守卫，待清理）
  - `server/src/projects/current-user.decorator.ts`（@CurrentUser 读 req.user）
  - `server/src/auth/guards/jwt-auth.guard.ts`（全局 JWT 守卫，req.user 已挂 {id, username, roleId}）
  - `server/src/projects/projects.controller.ts`（现有端点守卫用法）
  - `server/prisma/schema.prisma`（project_members 表 + uk_project_members_pid_uid）
  - `web/app/(main)/projects/page.tsx`（前端 x-user-id header，需移除）

  **Acceptance Criteria**:
  - [ ] POST /projects/:pid/tasks（Phase 2）与现有 /projects 端点：非成员调用 → 403 PERMISSION_PROJECT_NOT_MEMBER
  - [ ] 成员调用 → 通过（req.user 来自 JWT，非 x-user-id）
  - [ ] 前端 projects 页去掉 x-user-id header 后仍正常（Bearer 即可）
  - [ ] `cd server && npm run test` 全过

  **QA Scenarios**:
  ```
  Scenario: 成员资格校验（curl）
    Tool: Bash (curl)
    Preconditions: server 起 + admin token + 项目 p_seed_1
    Steps:
      1. `curl -s "http://localhost:3000/api/v1/projects/p_seed_1/tasks?page=1" -H "Authorization: Bearer $TOKEN"` → 200（admin 是成员）
      2. 用非成员用户 token 访问 → 403，body 含 PERMISSION_PROJECT_NOT_MEMBER
      3. 无 token → 401
    Expected Result: JWT 鉴权 + 成员资格校验生效
    Evidence: .omo/evidence/phase2-task-2-guard.md
  ```

  **Commit**: YES
  - Message: `refactor(server): 守卫统一（ProjectMembershipGuard + 清理 PlaceholderAuthGuard）`
  - Files: server/src/projects server/src/common web/app/(main)/projects
  - Pre-commit: `cd server && npm run test`

- [x] 3. 消息主键生成器 + TASK_STATUS/事件常量

  **What to do**:
  - 新建 `server/src/common/id-generator.ts`：`nextId(prefix: string)` —— 应用层自增序号生成域前缀主键（`m_1`/`m_2`/`ev_1`），SQLite 下用事务内 `MAX(id)+1`（按 prefix 查 max）或计数器表；返回可排序字符串（**数值序 = 字典序**，零填充对齐避免 m_10 < m_9）
  - 新建 `server/src/common/constants/task.constants.ts`：`TASK_STATUS`（pending/in_progress/pending_review/completed/archived）、`TASK_STATUS_ORDER`、`TASK_PRIORITY`（high/medium/low）、迁移表 `TASK_TRANSITIONS`（from→to 合法集）
  - 新建 `server/src/common/constants/event.constants.ts`：`EVENT_TYPES`（chat.message.new / agent.loading / agent.error / task.status.changed / team.changed）、`MESSAGE_STATUS`（sending/sent/pending/processing/completed/failed）、`CHANNEL_TYPE`（task_group/private）、`SENDER_TYPE`（user/agent/system）
  - 事件名统一 `task.status.changed`（点号，09 篇权威）

  **Must NOT do**:
  - 不改 schema 主键类型（仍 VARCHAR(64)）
  - 不引入数据库自增列（保持字符串主键策略）
  - 不用时间戳+随机后缀（破坏排序）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 常量定义 + 简单生成器，逻辑明确
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 1,2,4,5）
  - **Blocks**: 6, 7, 9
  - **Blocked By**: None

  **References**:
  - `server/src/projects/projects.service.ts:117`（现有 nextId 模式——时间戳+随机后缀，需替换为自增）
  - 13 篇 §3.1（五态枚举与迁移表）
  - 09 篇 §4.2（事件类型）、§5.1（Mention/Trigger 类型）
  - 15 篇 §3.3/§3.5（tasks.status/messages.status 字段）

  **Acceptance Criteria**:
  - [ ] `nextId('m')` 连续调用返回 m_1, m_2, m_3...（数值序 = 字典序）
  - [ ] 并发调用（Promise.all 10 个）无重复
  - [ ] TASK_TRANSITIONS 覆盖全部 6 动作合法迁移
  - [ ] 事件名常量值 = `task.status.changed`（点号）
  - [ ] `cd server && npm run test` 有生成器单测

  **QA Scenarios**:
  ```
  Scenario: 生成器排序正确性
    Tool: Bash (node REPL 或 jest)
    Preconditions: 无
    Steps:
      1. 连续调用 nextId('m') 20 次 → 断言 m_1...m_20 升序
      2. `Promise.all([...10 次 nextId])` → 断言 10 个 id 唯一
    Expected Result: 有序、唯一
    Evidence: .omo/evidence/phase2-task-3-idgen.md

  Scenario: 状态常量完整
    Tool: Bash
    Steps:
      1. grep TASK_TRANSITIONS 覆盖 6 动作（start/mark-pending-review/accept/reject/archive + create）
      2. grep EVENT_TYPES 含 4 个 Phase 2 事件
    Expected Result: 常量齐备
    Evidence: .omo/evidence/phase2-task-3-constants.md
  ```

  **Commit**: YES
  - Message: `feat(server): 消息主键生成器 + 状态/事件常量`
  - Files: server/src/common
  - Pre-commit: `cd server && npm run test`

- [x] 4. seed 4 内置 Agent + GET /agents 简单端点

  **What to do**:
  - 扩展 `server/prisma/seed.ts`：预置 4 个内置角色 Agent（product 产品经理 / architect 架构师 / developer 开发者 / tester 测试）——name/type=template/role/prompt（14 篇模板提示词）/permission_scope
  - 新建 `server/src/agents/` 模块（简化版）：
    - `GET /api/v1/agents`（@Public 或 [project]？——建议项目成员可读，返回 id/name/role/type/prompt 摘要）
    - 不用 skills/toolEffects 关联（Phase 3）
  - 前端 task-create 的 agentOptions 改为从 GET /agents 拉取（Task 15 接），映射 Agent.role ↔ data-role

  **Must NOT do**:
  - 不实现 Agent CRUD/clone/PATCH/available-models（Phase 3 AgentsModule）
  - 不建 agent_skills/agent_tool_effects 关联数据（表已在，但 Phase 2 不填业务数据）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: seed 数据 + 简单 GET 端点
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 1-3,5）
  - **Blocks**: 15
  - **Blocked By**: None

  **References**:
  - `server/prisma/seed.ts`（现有 seed 模式：角色/用户/项目）
  - 14 篇 §4.1（四类预置模板：产品经理/架构师/开发者/测试）
  - `server/prisma/schema.prisma`（agents 表字段：name/type/role/prompt/permission_scope）
  - `web/app/(main)/tasks/new/page.tsx:50`（现有静态 agentOptions）

  **Acceptance Criteria**:
  - [ ] `npm run seed`（server）后 agents 表有 4 条 template 记录
  - [ ] `GET /api/v1/agents`（带 Bearer）→ 200 返回 4 个 Agent（id/name/role/type）
  - [ ] 前端 task-create 静态 agentOptions 可被此端点数据替代（Task 15 落地）

  **QA Scenarios**:
  ```
  Scenario: GET /agents 返回内置角色
    Tool: Bash (curl)
    Preconditions: server 起 + seed 完成 + admin token
    Steps:
      1. `curl -s "http://localhost:3000/api/v1/agents" -H "Authorization: Bearer $TOKEN"` → 200
      2. 断言返回 4 项，roles 含 product/architect/developer/tester
    Expected Result: 4 内置 Agent 可查
    Evidence: .omo/evidence/phase2-task-4-agents.md
  ```

  **Commit**: YES
  - Message: `feat(server): seed 4 内置 Agent + GET /agents 简化端点`
  - Files: server/prisma/seed.ts server/src/agents
  - Pre-commit: `cd server && npm run build`

- [x] 5. 前端 useSSE hook（query token + since 续拉 + 事件分发）

  **What to do**:
  - 新建 `web/hooks/use-sse.ts`：`useSSE(options: { url, scope?, onEvent, enabled? })`：
    - `new EventSource(\`/api/v1/events?token=${getAuthToken()}&scope=${scope}\`)`
    - **自动重连**：监听 onerror → 用 `lastEventId`（EventSource 原生）→ 重连带 `since` 参数补拉
    - 事件分发：按 `event.type` 调 onEvent 回调
    - 生命周期：unmount 关闭、token 变化重连
  - 新建 `web/hooks/use-sse.ts` 配套类型：SSEEvent<T>（id/type/payload/timestamp）
  - 不实现事件→Query 缓存具体逻辑（Task 17 做桥）

  **Must NOT do**:
  - 不引入 sse 库（原生 EventSource）
  - 不做通用事件总线/指数退避（Phase 2 只需简单重连）
  - 不把 token 放 localStorage 以外（getAuthToken 已处理）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: React hook 设计（生命周期/重连/分发），平衡型即可
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 1-4）
  - **Blocks**: 11, 12, 13, 17
  - **Blocked By**: None

  **References**:
  - `web/lib/api.ts:21`（getAuthToken 已为 SSE 预留）
  - `web/lib/stores/authStore.ts`（token 获取）
  - `server/src/realtime/realtime.controller.ts`（SSE 端点契约：?token=&scope=&since=）
  - `web/next.config.ts`（/api/v1 代理同源，SSE 可走）

  **Acceptance Criteria**:
  - [ ] useSSE 连接 `?token=<jwt>&scope=task:t_1` 收到事件（手动触发广播）
  - [ ] 断线重连：服务端断 5s 重连 → lastEventId/since 补拉不丢
  - [ ] `cd web && npm run build` 退出码 0
  - [ ] 无 token 时 hook 不连接（enabled 守卫）

  **QA Scenarios**:
  ```
  Scenario: SSE 连接与事件接收
    Tool: Playwright（browse/qa skill）
    Preconditions: server + web 起 + 登录态
    Steps:
      1. 打开使用 useSSE 的页面（或测试页）
      2. 后端触发 chat.message.new 事件
      3. 断言页面收到事件（状态更新或 console 记录）
    Expected Result: 事件接收成功
    Evidence: .omo/evidence/phase2-task-5-sse.md

  Scenario: 断线重连补拉
    Tool: Playwright + Bash
    Preconditions: 同上
    Steps:
      1. 记录 lastEventId
      2. 停止 server 5s → 重启
      3. 断言重连后收到 since 之后的补拉事件
    Expected Result: 补拉不丢
    Evidence: .omo/evidence/phase2-task-5-reconnect.md
  ```

  **Commit**: YES
  - Message: `feat(web): useSSE hook（query token + since 续拉 + 事件分发）`
  - Files: web/hooks
  - Pre-commit: `cd web && npm run build`

- [x] 6. TasksModule 创建/详情/看板/CRUD

  **What to do**:
  - 新建 `server/src/tasks/` 模块（controller + service + dto + spec）：
    - `POST /projects/:pid/tasks`：请求 `{title, description?, priority?, agentIds[], mainAgentId?, backgroundDocs[]?}`；**三件套同事务**（任务 + 群聊频道 chat_channels(task_group) + backgroundDocs 入 tasks.background_docs Json）；agentIds 写 task_agents；mainAgentId 校验须在 agentIds 内；status=pending；写 task_events(status_change, from=null, to=pending)；广播 task.status.changed
    - `GET /projects/:pid/tasks?status=&page=&pageSize=`：列表（看板用），`{items, total, page, pageSize}`；按 status 五态筛选
    - `GET /tasks/:id`：详情（含团队/主 Agent/产出物摘要）
    - `PATCH /tasks/:id`：`{title?, description?, priority?, mainAgentId?}`；mainAgentId 须团队内
  - 校验：ProjectMembershipGuard（Task 2）保证调用者在项目内
  - 任务对象返回字段：id/projectId/title/description/priority/status/mainAgentId/backgroundDocs/teamAgentIds/createdBy/createdAt/startedAt/pendingReviewAt/completedAt/archivedAt

  **Must NOT do**:
  - 不实现状态迁移端点（Task 7）
  - 不实现 team 端点（Task 8）
  - 不建 artifacts 表数据（文档库 Phase 3；backgroundDocs 只写 Json 字段）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 三件套同事务 + 团队成员资格校验 + 事件广播，核心业务逻辑
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（with 7-12）
  - **Blocks**: 7, 8, 12, 15
  - **Blocked By**: 1, 2, 3, 4

  **References**:
  - 09 篇 §3.4（tasks 端点字段）
  - 13 篇 §2.2/§4.1（三件套 + 创建流程）
  - 14 篇 §5.1（agentIds/mainAgentId 语义）
  - 15 篇 §3.3（tasks/task_agents/task_events 表）
  - `server/src/projects/projects.service.ts`（事务 + nextId 模式参考）
  - Task 2（ProjectMembershipGuard）、Task 3（nextId/常量）

  **Acceptance Criteria**:
  - [ ] POST /projects/:pid/tasks 成功 → 201 + 任务对象；同事务创建 chat_channels(task_group) + task_agents 落库 + task_events 落库
  - [ ] GET /projects/:pid/tasks?status=pending → 仅 pending 任务
  - [ ] 非成员调用 → 403；mainAgentId 不在 agentIds → 400 VALIDATION
  - [ ] 单测：创建事务完整性（任务+频道+团队+事件）、列表筛选、详情、PATCH

  **QA Scenarios**:
  ```
  Scenario: 创建任务三件套（curl）
    Tool: Bash (curl)
    Preconditions: server 起 + admin token + 项目 p_seed_1 + 4 Agent
    Steps:
      1. POST /projects/p_seed_1/tasks {title:"测试任务", agentIds:[a_1,a_2], mainAgentId:"a_1"}
      2. 断言 201 + status=pending
      3. 查 chat_channels 表 → 有 task_group 记录关联新任务
      4. 查 task_agents → 2 条 joined 记录
      5. 查 task_events → 1 条 status_change from=null to=pending
    Expected Result: 三件套齐全
    Evidence: .omo/evidence/phase2-task-6-create.md

  Scenario: 列表筛选与权限
    Tool: Bash (curl)
    Steps:
      1. GET /projects/p_seed_1/tasks?status=pending → 200 仅 pending
      2. 非成员 token 访问 → 403
      3. mainAgentId 不在 agentIds → 400
    Expected Result: 筛选/权限/校验生效
    Evidence: .omo/evidence/phase2-task-6-list.md
  ```

  **Commit**: YES
  - Message: `feat(server): TasksModule CRUD/看板（三件套同事务）`
  - Files: server/src/tasks
  - Pre-commit: `cd server && npm run test`

- [x] 7. TasksModule 状态机（start/mark-pending-review/accept/reject/archive）

  **What to do**:
  - 实现五态状态机服务（迁移表驱动，Task 3 TASK_TRANSITIONS）：
    - `POST /tasks/:id/start`：pending→in_progress；前置校验团队非空 + mainAgentId 已确定；写 startedAt；系统消息（群聊「任务已开始，主 Agent：X」）；广播 task.status.changed；启动消息私信主 Agent
    - `POST /tasks/:id/mark-pending-review`：in_progress→pending_review；写 pendingReviewAt；系统消息
    - `POST /tasks/:id/accept`：pending_review→completed；写 completedAt；系统消息（验收基线在 Phase 3 落 artifacts，Phase 2 仅状态）
    - `POST /tasks/:id/reject`：pending_review→in_progress；可带 `{reason?}` 写 task_events.metadata；系统消息
    - `POST /tasks/:id/archive`：completed→archived；写 archivedAt；sessions 全部 archived；系统消息
  - **CAS 乐观锁**：`UPDATE tasks SET status=?, version=version+1 WHERE id=? AND status=<前置> AND version=?`；影响行数 0 → 重读判断（幂等 200 或 409 TASK_INVALID_TRANSITION）
  - 每次迁移：task_events 同事务落库（eventType/fromStatus/toStatus/actorType/actorId/created_at）+ 广播 task.status.changed
  - 系统消息经 ChatModule（Task 9）发送 senderType=system

  **Must NOT do**:
  - 不实现验收基线锁定（Phase 3 ArtifactsModule 联动）
  - 不实现归档后的 worker 实例回收（Phase 4）
  - 不实现 reject 后自动重试

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 状态机迁移表 + CAS 并发安全 + 事件广播，Phase 2 最核心逻辑
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（with 6,8-12）
  - **Blocks**: 8
  - **Blocked By**: 6

  **References**:
  - 13 篇 §3.1/§3.2（迁移表）、§3.3（409）、§8.2（CAS 并发安全）
  - 09 篇 §3.4（状态迁移端点）
  - 15 篇 §3.3（tasks.version 乐观锁、task_events）
  - 10 篇 §8.1（状态变更系统消息文案）
  - Task 3（TASK_TRANSITIONS 常量）、Task 9（ChatModule 系统消息）

  **Acceptance Criteria**:
  - [ ] 每个迁移端点三态测试：合法迁移（status 更新 + version+1 + task_events 落库 + 广播）/ 非法迁移（409 TASK_INVALID_TRANSITION + code）/ 幂等（已处目标态 200 不重复 task_events）
  - [ ] CAS 并发测试：两个并发 start → 一个成功一个重读幂等 200；无重复 task_events
  - [ ] start 前置校验：团队空 → 409 或 400（明确 code）
  - [ ] 归档后所有状态迁移端点 → 409

  **QA Scenarios**:
  ```
  Scenario: 五态流转（curl）
    Tool: Bash (curl)
    Preconditions: 已有 pending 任务 + 团队
    Steps:
      1. POST /tasks/t_1/start → 200 status=in_progress
      2. POST /tasks/t_1/mark-pending-review → 200 status=pending_review
      3. POST /tasks/t_1/accept → 200 status=completed
      4. POST /tasks/t_1/archive → 200 status=archived
      5. 全程查 task_events → 4 条 event 记录
    Expected Result: 状态机流转 + 事件落库
    Evidence: .omo/evidence/phase2-task-7-flow.md

  Scenario: 非法迁移 + CAS
    Tool: Bash (curl)
    Preconditions: 任务在 pending
    Steps:
      1. POST /tasks/t_1/accept → 409 body.code=TASK_INVALID_TRANSITION
      2. 两个并发 POST /tasks/t_1/start → 一个 200、一个 200 幂等（无重复事件）
    Expected Result: 非法 409、并发幂等
    Evidence: .omo/evidence/phase2-task-7-transition.md
  ```

  **Commit**: YES
  - Message: `feat(server): TasksModule 五态状态机（CAS 乐观锁 + task_events）`
  - Files: server/src/tasks
  - Pre-commit: `cd server && npm run test`

- [x] 8. TasksModule team 端点

  **What to do**:
  - `POST /tasks/:id/team`：请求 `{addAgentIds[]?, removeAgentIds[]?}`
    - add：写 task_agents（joined_at）；新会话创建（sessions status=created）；群聊系统消息「{Agent} 已加入团队」；广播 team.changed
    - remove：写 removed_at（标记非删除）；会话 frozen；产出保留；群聊系统消息「{Agent} 已移出团队，其会话已冻结」；广播 team.changed
    - 时间窗：仅 pending/in_progress 合法；pending_review/completed/archived → 409
    - add 校验 agent 存在且未在团队（uk_task_agents_task_agent 冲突 → 409 或幂等）

  **Must NOT do**:
  - 不实现文档库上下文注入（Phase 4）
  - 不实现会话历史合并/恢复（14 篇 §9 开放问题）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 团队调整 CRUD + 系统消息联动，逻辑直接
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（with 6,7,9-12）
  - **Blocks**: 18
  - **Blocked By**: 6, 7

  **References**:
  - 14 篇 §5.3（add/remove 语义）
  - 09 篇 §3.4（POST /tasks/:id/team）
  - 10 篇 §8.3（团队调整系统消息）
  - 15 篇 §3.3/§3.4（task_agents removed_at、sessions status）

  **Acceptance Criteria**:
  - [ ] add → task_agents joined + 系统消息 + team.changed 广播
  - [ ] remove → removed_at 置位 + 会话 frozen + 系统消息
  - [ ] 时间窗：pending_review 后调用 → 409
  - [ ] 单测覆盖 add/remove/时间窗/重复 add

  **QA Scenarios**:
  ```
  Scenario: 团队调整（curl）
    Tool: Bash (curl)
    Preconditions: 进行中任务 + Agent
    Steps:
      1. POST /tasks/t_1/team {addAgentIds:["a_3"]} → 200，task_agents 新增
      2. POST /tasks/t_1/team {removeAgentIds:["a_3"]} → 200，removed_at 置位
      3. 任务转 pending_review 后再 add → 409
    Expected Result: add/remove/时间窗正确
    Evidence: .omo/evidence/phase2-task-8-team.md
  ```

  **Commit**: YES
  - Message: `feat(server): TasksModule team 端点`
  - Files: server/src/tasks
  - Pre-commit: `cd server && npm run test`

- [x] 9. ChatModule 频道/发消息/历史游标

  **What to do**:
  - 新建 `server/src/chat/` 模块：
    - `GET /channels?type=`：可访问频道列表（task_group + private）
    - `GET /channels/:id`：频道信息（类型/关联任务/成员 Agent）
    - `GET /channels/:id/messages?cursor=&limit=`：历史分页 `{items, nextCursor}`；游标 = 消息主键（Task 3 生成器，数值序）；idx_messages_channel_id 命中；limit 默认 50
    - `POST /channels/:id/messages`：8 步流程（权限 → @ 解析 → 落库 → 广播 chat.message.new → 分派（Task 10 MockDispatcher）→ Loading agent.loading → 异步收敛回复 chat.message.new）
    - `POST /dm-channels`：`{taskId, agentId}` 创建 private 频道
    - `GET /channels/:id/trigger-results/:messageId`：@ 触发结果轮询
  - 消息落库：senderType/user + content {text, parts} + mentions + status；用户消息 sending→sent
  - @ 解析：mentions agentId 须在团队内；被移除 → triggers agent_removed；不存在 agentId → 400 VALIDATION；all → 团队全部 Agent
  - 频道权限：成员校验（ProjectMembershipGuard 或 channel 关联任务校验）
  - 归档任务频道只读（发消息 → 409）

  **Must NOT do**:
  - 不实现真实上下文注入/worker 分派（Task 10 mock 接）
  - 不实现消息撤回/编辑
  - 不做 WebSocket（SSE 统一）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 8 步发消息流程 + 游标分页 + SSE 广播，核心链路
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（with 6-8,10-12）
  - **Blocks**: 10, 13, 14
  - **Blocked By**: 1, 2, 3, 6

  **References**:
  - 09 篇 §3.5/§5.1（chat 端点 + 8 步流程 + DTO）
  - 10 篇 §2/§3/§6（消息模型/频道/游标）
  - 15 篇 §3.5（chat_channels/messages 表）
  - 09 篇 §4.2（chat.message.new/agent.loading/agent.error 事件 data）
  - Task 1（Realtime 改造）、Task 3（id 生成器/常量）

  **Acceptance Criteria**:
  - [ ] 发消息：用户消息落库 + 广播 chat.message.new + triggers 返回（dispatched）
  - [ ] @ 解析：团队内 agent → dispatched；已移除 → agent_removed；不存在 → 400
  - [ ] 游标分页：limit、nextCursor、翻页无重复无遗漏、空历史 nextCursor=null
  - [ ] 归档任务频道发消息 → 409
  - [ ] 单测：8 步流程每步断言、游标分页正确性

  **QA Scenarios**:
  ```
  Scenario: 发消息 + SSE 广播（curl）
    Tool: Bash (curl)
    Preconditions: server 起 + 任务群聊频道 + 团队 Agent
    Steps:
      1. 订阅 SSE channel scope
      2. POST /channels/c_1/messages {text:"@产品经理 请分析需求", mentions:[{type:"agent",agentId:"a_1"}]}
      3. 断言 201 + {message, triggers:[{status:"dispatched"}]}
      4. SSE 收到 chat.message.new
    Expected Result: 8 步流程 + 广播
    Evidence: .omo/evidence/phase2-task-9-message.md

  Scenario: 游标分页
    Tool: Bash (curl)
    Steps:
      1. 发 15 条消息
      2. GET /channels/c_1/messages?limit=10 → 10 条 + nextCursor
      3. GET /channels/c_1/messages?cursor=<nextCursor>&limit=10 → 5 条 + nextCursor=null
      4. 断言无重复无遗漏
    Expected Result: 分页正确
    Evidence: .omo/evidence/phase2-task-9-cursor.md
  ```

  **Commit**: YES
  - Message: `feat(server): ChatModule 频道/消息/历史游标`
  - Files: server/src/chat
  - Pre-commit: `cd server && npm run test`

- [x] 10. MockDispatcher + MessageDispatcher 接口

  **What to do**:
  - 定义 `server/src/chat/interfaces/message-dispatcher.interface.ts`：`MessageDispatcher` 接口 —— `dispatch({message, triggers, task})`、`onLoading(cb)`、`onFinal(cb)`、`onError(cb)`（Phase 4 WorkerClient 实现同一接口即零改动替换）
  - 实现 `server/src/chat/mock-dispatcher.service.ts`：确定性模板回复
    - 按 Agent 角色（product/architect/developer/tester）预置回复模板数组
    - @ 触发后 1-3 秒延迟 → 发 agent.loading（thinking→operating）→ 最终回复落库（senderType=agent）→ 广播 chat.message.new
    - **确定性**：同输入同输出（模板按角色固定，可断言）
  - ChatModule 注入 MessageDispatcher（默认 MockDispatcher）
  - 系统消息（senderType=system）也走消息落库 + 广播

  **Must NOT do**:
  - 不接 LLM SDK/opencode（Phase 4）
  - 不模拟流式 parts（thinking 两阶段事件即可，不流式 text）
  - 不产生 artifact.submitted 事件（Phase 3）
  - 不新增依赖

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 接口抽象 + 确定性模板实现，逻辑清晰
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（with 6-9,11,12）
  - **Blocks**: 13
  - **Blocked By**: 9

  **References**:
  - 09 篇 §5.1（分派步骤 5-8：Loading→异步收敛）
  - 18 篇 §6.2（Phase 2 mock 模式定义；Phase 4 替换 WorkerClient 零改动）
  - 09 篇 §4.2（agent.loading data 结构：{taskId, agentId, sessionId, phase}）
  - 14 篇 §4.1（四类角色模板——mock 回复文案来源）

  **Acceptance Criteria**:
  - [ ] MessageDispatcher 接口定义完整（dispatch/onLoading/onFinal/onError）
  - [ ] MockDispatcher：同输入同输出（确定性）、延迟 1-3s、回复落库 senderType=agent + 广播
  - [ ] agent.loading 事件按 thinking→operating 两阶段发出
  - [ ] 单测：确定性断言（同一触发两次，回复相同）

  **QA Scenarios**:
  ```
  Scenario: @ 触发 mock 回复（curl + SSE）
    Tool: Bash (curl)
    Preconditions: server 起 + 群聊频道 + 团队 Agent
    Steps:
      1. SSE 订阅 channel scope
      2. POST 消息 @a_1
      3. 断言 SSE 收到：agent.loading(thinking) → agent.loading(operating) → chat.message.new(agent 回复)
      4. 断言回复内容 = 角色模板（确定性）
    Expected Result: loading→final 时序 + 确定性回复
    Evidence: .omo/evidence/phase2-task-10-mock.md

  Scenario: 接口替换点
    Tool: Bash
    Steps:
      1. grep MessageDispatcher 实现注册（ChatModule providers）
      2. 断言仅一个实现（MockDispatcher），Phase 4 可加 WorkerDispatcher
    Expected Result: 替换点清晰
    Evidence: .omo/evidence/phase2-task-10-interface.md
  ```

  **Commit**: YES
  - Message: `feat(server): MockDispatcher 确定性模板回复（MessageDispatcher 接口）`
  - Files: server/src/chat
  - Pre-commit: `cd server && npm run test`

- [x] 11. MessageInput 重写（受控 + @ chips）

  **What to do**:
  - 重写 `web/src/components/ui/message-input.tsx` 为受控组件：
    - props：`value/onChange/onSend/mentionable?: AgentOption[]/placeholder?/sending?: boolean`（保留 `message-input` / `message-input-mentions` / `message-input-send` 三个 data-testid）
    - 真实 textarea（受控）+ 发送按钮（button 带 onClick → onSend）
    - **@ mentions chips**：输入 `@` 触发候选列表（mentionable Agent），点击插入 mention chip；chips 显示在 textarea 上方
    - Enter 发送（Shift+Enter 换行）
  - 不改变视觉基线（对齐原型 message-input 样式：输入框 + 提示 chips + 发送按钮）

  **Must NOT do**:
  - 不改 tokens/共享样式
  - 不实现消息发送后的列表逻辑（群聊页 Task 13 接）
  - 不改变其他组件

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 交互组件重写（受控 + mentions 交互 + 视觉保真）
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（with 6-10,12）
  - **Blocks**: 13, 14
  - **Blocked By**: 5

  **References**:
  - `web/src/components/ui/message-input.tsx`（现有纯展示实现，待重写）
  - `docs/agent-platform/prototypes/group-chat/index.tsx`（原型 MessageInput 交互：@ chips + 发送）
  - 10 篇 §2.2（Part 展示规则）、§7.1（消息状态机）

  **Acceptance Criteria**:
  - [ ] 受控：value/onChange 双向绑定；发送按钮触发 onSend(value)
  - [ ] @ 输入弹出候选 chips，点击插入；发送时 mentions 结构正确
  - [ ] data-testid 全保留（message-input/message-input-mentions/message-input-send）
  - [ ] `cd web && npm run build` 退出码 0

  **QA Scenarios**:
  ```
  Scenario: 输入与发送（Playwright）
    Tool: Playwright（browse/qa skill）
    Preconditions: web 起 + 群聊测试页
    Steps:
      1. 定位 [data-testid=message-input]，输入 "测试消息"
      2. 输入 @ 触发候选 chips，点击某 Agent
      3. 点击 [data-testid=message-input-send]
      4. 断言 onSend 收到 {text, mentions}
    Expected Result: 受控输入 + @ chips + 发送回调
    Evidence: .omo/evidence/phase2-task-11-messageinput.png

  Scenario: 视觉一致
    Tool: Playwright
    Steps:
      1. 截图 message-input 与原型对比 → 无视觉 diff
    Expected Result: 与原型一致
    Evidence: .omo/evidence/phase2-task-11-visual.png
  ```

  **Commit**: YES
  - Message: `feat(web): MessageInput 重写（受控 + @ chips）`
  - Files: web/src/components/ui/message-input.tsx
  - Pre-commit: `cd web && npm run build`

- [x] 12. task-board 接真实数据 + status_changed 联动

  **What to do**:
  - 改造 `web/app/(main)/board/page.tsx`：
    - useQuery 接 `GET /projects/:pid/tasks?status=`（pid 从上下文/URL，见 Task 16 AppShell 配套；缺省用 seed 项目）
    - 保持**筛选条 + 卡片网格**形态（用户决策，不做五列）
    - 筛选条真实过滤：点「待开始/进行中/...」→ refetch 或前端过滤
    - 订阅 `task.status.changed`（useSSE Task 5）→ 卡片状态更新（Query 缓存 setQueryData 或 invalidate）
    - 卡片点击 → `router.push(/tasks/[id])`（群聊入口）
    - 「开始任务」→ `POST /tasks/:id/start` 真实调用 + 乐观更新
  - 移除静态 seed 数据（或保留为空态兜底）

  **Must NOT do**:
  - 不做五列 kanban / 拖拽 / 卡片移动动画
  - 不改 WAITING_STATUS 局部常量与卡片视觉

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 页面数据接入 + SSE 联动 + 交互改造，需视觉保真
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（with 6-11）
  - **Blocks**: 19
  - **Blocked By**: 5, 6

  **References**:
  - `web/app/(main)/board/page.tsx`（现有静态网格，待接数据）
  - `web/app/(main)/projects/page.tsx`（useQuery + useMutation + invalidate 范式）
  - `web/hooks/use-sse.ts`（Task 5）
  - `server/src/tasks/`（Task 6 端点）
  - 09 篇 §3.4（看板接口：?status= 筛选）

  **Acceptance Criteria**:
  - [ ] 看板渲染真实任务数据（GET /projects/:pid/tasks）
  - [ ] 筛选条真实过滤（status 参数生效）
  - [ ] 订阅 task.status.changed → 卡片状态更新
  - [ ] 卡片点击跳 /tasks/[id]；「开始任务」真实调用 POST /tasks/:id/start
  - [ ] `cd web && npm run build` 退出码 0

  **QA Scenarios**:
  ```
  Scenario: 看板真实数据 + 筛选（Playwright）
    Tool: Playwright（browse/qa skill）
    Preconditions: server + web 起 + seed 任务数据
    Steps:
      1. 打开 /board → 断言渲染真实任务卡片（非静态 seed）
      2. 点筛选「待开始」→ 断言仅 pending 卡片
      3. 点某卡片 → 断言跳转 /tasks/[id]
    Expected Result: 数据驱动 + 筛选 + 跳转
    Evidence: .omo/evidence/phase2-task-12-board.png

  Scenario: status_changed 联动
    Tool: Playwright + Bash
    Preconditions: 看板页打开 + SSE 连接
    Steps:
      1. 后端触发 task.status.changed（如 reject 操作）
      2. 断言看板卡片状态更新（无需刷新）
    Expected Result: SSE 驱动看板更新
    Evidence: .omo/evidence/phase2-task-12-status.png
  ```

  **Commit**: YES
  - Message: `feat(web): task-board 接真实数据 + status_changed 联动`
  - Files: web/app/(main)/board
  - Pre-commit: `cd web && npm run build`

- [x] 13. group-chat 页 /tasks/[id]

  **What to do**:
  - 新建 `web/app/(main)/tasks/[id]/page.tsx`（"use client"）：
    - **三栏布局对齐原型**：members-panel（196px，团队 Agent 列表 + 状态）+ 消息区（ChatBubble 列表 + MessageInput）+ task-info-panel（268px，任务信息 + artifact-link 占位）
    - useQuery 接 `GET /channels/:id/messages?cursor=&limit=`（频道 id 从任务关联获取或任务详情返回 channelId）
    - useSSE 订阅 channel scope：chat.message.new → 消息流追加；agent.loading → Loading 两阶段指示器（thinking/operating）；agent.error → 错误态；task.status.changed → 任务信息更新
    - 消息渲染：ChatBubble 三态复用 + 新建 Loading 两阶段组件（MsgThinking/MsgTool/MsgError 等迁移自原型）
    - MessageInput（Task 11）发送 → POST /channels/:id/messages；@ 触发 Agent
    - 无限滚动/加载更多（游标分页）
  - 新建 `web/src/components/chat/`：消息类型组件（thinking/tool/error/loading indicator，迁移自原型 group-chat 局部组件）

  **Must NOT do**:
  - 不做任务详情页完整功能（task-detail 是 Phase 3；task-info-panel 静态展示）
  - artifact-link 点击 → 占位（无 task-detail 页）
  - 不做已读/输入中/消息编辑

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 三栏群聊页迁移 + SSE 实时消息 + Loading 组件，最复杂前端任务
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3（with 14-17）
  - **Blocks**: 16, 18
  - **Blocked By**: 5, 9, 10, 11

  **References**:
  - `docs/agent-platform/prototypes/group-chat/index.tsx`（三栏布局 + 7 类消息 + LoadingIndicator，唯一视觉来源）
  - `web/src/components/ui/chat-bubble.tsx`（三态复用）
  - `web/hooks/use-sse.ts`（Task 5）、`server/src/chat/`（Task 9/10）
  - 10 篇 §2.2（Part 展示规则）

  **Acceptance Criteria**:
  - [ ] 三栏布局与原型一致（截图对比 + testid）
  - [ ] 消息历史加载（游标分页）+ 新消息 SSE 追加
  - [ ] @ Agent 发送 → Loading 两阶段 → 回复回流
  - [ ] agent.error → 错误态展示
  - [ ] `cd web && npm run build` 退出码 0

  **QA Scenarios**:
  ```
  Scenario: 群聊实时流转（Playwright）
    Tool: Playwright（browse/qa skill）
    Preconditions: server + web 起 + 任务群聊
    Steps:
      1. 打开 /tasks/t_1 → 断言三栏渲染 + 历史消息
      2. 输入 "@产品经理 分析需求" 发送
      3. 断言：用户消息立即显示 → agent.loading 指示器 → Agent 回复出现
      4. 截图三栏与原型对比
    Expected Result: 实时流转 + 视觉一致
    Evidence: .omo/evidence/phase2-task-13-groupchat.png

  Scenario: 错误态
    Tool: Playwright
    Preconditions: 触发 agent.error（mock 强制错误）
    Steps:
      1. 发 @ 消息触发错误
      2. 断言错误指示器/错误消息展示
    Expected Result: 错误处理
    Evidence: .omo/evidence/phase2-task-13-error.png
  ```

  **Commit**: YES
  - Message: `feat(web): group-chat 页 /tasks/[id]（三栏 + SSE 实时）`
  - Files: web/app/(main)/tasks/[id] web/src/components/chat
  - Pre-commit: `cd web && npm run build`

- [x] 14. dm-chat 页 /messages/[id]

  **What to do**:
  - 改造 `web/app/(main)/messages/page.tsx`：会话列表（GET /channels?type=，群聊 + 私聊），点击进入
  - 新建 `web/app/(main)/messages/[id]/page.tsx`（dm-chat）：
    - 单栏布局对齐原型 dm-chat（AgentInfoBar + 消息列表 + MessageInput）
    - 复用 ChatBubble + MessageInput + useSSE（channel scope）
    - POST /dm-channels {taskId, agentId} 创建私聊（进入时若不存在）
  - 复用 Task 13 的消息渲染组件

  **Must NOT do**:
  - 不做会话历史列表分页/搜索（Phase 2 简单列表）
  - 不做复杂 AgentInfoBar 详情（静态展示即可）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 单栏私聊页迁移 + 复用群聊组件
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3（with 13,15-17）
  - **Blocks**: 16, 18
  - **Blocked By**: 13

  **References**:
  - `docs/agent-platform/prototypes/dm-chat/index.tsx`（单栏私聊，唯一视觉来源）
  - `web/app/(main)/messages/page.tsx`（现有占位，会话列表落点）
  - 09 篇 §3.5（GET /channels、POST /dm-channels）
  - Task 13（消息渲染组件复用）

  **Acceptance Criteria**:
  - [ ] /messages 会话列表渲染（群聊 + 私聊频道）
  - [ ] /messages/[id] 单栏布局与原型一致 + 消息历史 + SSE 实时
  - [ ] 创建私聊（POST /dm-channels）正常
  - [ ] `cd web && npm run build` 退出码 0

  **QA Scenarios**:
  ```
  Scenario: dm-chat 会话流（Playwright）
    Tool: Playwright（browse/qa skill）
    Preconditions: server + web 起 + 已有私聊
    Steps:
      1. 打开 /messages → 断言会话列表
      2. 点击会话 → /messages/[id] 单栏渲染 + 历史
      3. 发消息 → SSE 回流
      4. 截图与原型 dm-chat 对比
    Expected Result: 私聊完整流 + 视觉一致
    Evidence: .omo/evidence/phase2-task-14-dmchat.png
  ```

  **Commit**: YES
  - Message: `feat(web): dm-chat 页 /messages/[id]`
  - Files: web/app/(main)/messages
  - Pre-commit: `cd web && npm run build`

- [x] 15. task-create 增强（真实提交 + Agent 列表 + 修正 pid）

  **What to do**:
  - 改造 `web/app/(main)/tasks/new/page.tsx`：
    - agentOptions 从静态数组改为 `GET /agents`（Task 4 端点）useQuery 拉取；Agent.role ↔ data-role 映射
    - 移除 mock fallback：真实 POST /projects/:pid/tasks 成功 → `router.push(/tasks/[id])`（或 /board）
    - **修正 pid**：`DEFAULT_PID="p1"` 改为真实 seed 项目 id（p_seed_1）或从项目列表选择
    - 背景文档上传：真实 multipart（POST /tasks/:id/background-docs 或创建时携带）——Phase 2 若 artifacts 表不动，则创建请求携带 backgroundDocs[] 元数据

  **Must NOT do**:
  - 不改表单视觉/字段布局（§3.1）
  - 不实现文档库展示（Phase 3）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 表单增强 + 数据源切换 + 跳转逻辑
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3（with 13,14,16,17）
  - **Blocks**: 18, 19
  - **Blocked By**: 4, 6

  **References**:
  - `web/app/(main)/tasks/new/page.tsx`（现有表单，agentOptions 静态 + mock fallback）
  - `server/src/agents/`（Task 4 GET /agents）
  - `server/src/tasks/`（Task 6 POST /projects/:pid/tasks）
  - 14 篇 §5.1（agentIds/mainAgentId）

  **Acceptance Criteria**:
  - [ ] Agent 勾选来自 GET /agents（非静态）
  - [ ] 真实提交成功 → 跳转 /tasks/[id] 或 /board（无 mock fallback）
  - [ ] pid 使用真实 seed 项目 id
  - [ ] `cd web && npm run build` 退出码 0

  **QA Scenarios**:
  ```
  Scenario: 真实创建流程（Playwright）
    Tool: Playwright（browse/qa skill）
    Preconditions: server + web 起 + 登录 + seed Agent/项目
    Steps:
      1. 打开 /tasks/new → 断言 Agent 勾选来自 API（非静态）
      2. 填标题 + 勾选 Agent + 提交
      3. 断言跳转成功 + 后端任务创建（curl 验证）
    Expected Result: 真实提交闭环
    Evidence: .omo/evidence/phase2-task-15-create.png
  ```

  **Commit**: YES
  - Message: `feat(web): task-create 增强（真实提交 + Agent API + pid 修正）`
  - Files: web/app/(main)/tasks/new
  - Pre-commit: `cd web && npm run build`

- [x] 16. AppShell 路由/标题/Dock 高亮配套

  **What to do**:
  - 改造 `web/src/components/layout/app-shell.tsx`：
    - `EXTRA_PAGE_TITLE` 细化：`/tasks/[id]` → 「任务群聊」，`/messages/[id]` → 「私聊」
    - Dock 高亮：`/tasks/[id]` 映射 board（KEY_LOOKUP 加 tasks → board）；`/messages/[id]` 已命中 messages
    - 确认新路由处于 (main) 组内自动获得 AppShell 外壳

  **Must NOT do**:
  - 不改 NavDock/NavTopBar/CmdKPanel 组件本身

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 标题映射 + 高亮配置，小改动
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3（with 13-15,17）
  - **Blocks**: 18
  - **Blocked By**: 13, 14

  **References**:
  - `web/src/components/layout/app-shell.tsx`（EXTRA_PAGE_TITLE/KEY_LOOKUP/pathToKey）
  - Task 13/14（新路由）

  **Acceptance Criteria**:
  - [ ] /tasks/[id] 标题「任务群聊」、Dock 高亮 board
  - [ ] /messages/[id] 标题「私聊」、Dock 高亮 messages
  - [ ] `cd web && npm run build` 退出码 0

  **QA Scenarios**:
  ```
  Scenario: 路由标题与高亮（Playwright）
    Tool: Playwright
    Preconditions: web 起 + 登录
    Steps:
      1. 打开 /tasks/t_1 → 断言顶栏标题「任务群聊」+ Dock board 高亮
      2. 打开 /messages/c_1 → 断言标题「私聊」+ messages 高亮
    Expected Result: 路由配套正确
    Evidence: .omo/evidence/phase2-task-16-shell.md
  ```

  **Commit**: YES
  - Message: `feat(web): AppShell 路由/标题/Dock 高亮配套`
  - Files: web/src/components/layout/app-shell.tsx
  - Pre-commit: `cd web && npm run build`

- [x] 17. SSE 前端事件→Query 缓存桥

  **What to do**:
  - 新建 `web/hooks/use-realtime.ts`（或扩展 use-sse）：事件 → Query 缓存更新
    - chat.message.new → `queryClient.setQueryData(["channel", id, "messages"], ...)` 追加消息
    - agent.loading/agent.error → 更新消息 loading 状态（按 messageId 聚合）
    - task.status.changed → `queryClient.invalidateQueries(["tasks"])` 或 setQueryData 更新看板
    - team.changed → 更新团队列表
  - 供 Task 13/14（群聊/私聊）与 Task 12（看板）共用

  **Must NOT do**:
  - 不实现通用事件总线（只针对 Phase 2 四类事件）
  - 不改 useSSE hook 本身（职责分离）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Query 缓存更新逻辑（事件→setQueryData/invalidate），平衡型即可
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3（with 13-16）
  - **Blocks**: 18
  - **Blocked By**: 5

  **References**:
  - `web/hooks/use-sse.ts`（Task 5，事件源）
  - `web/app/(main)/projects/page.tsx`（queryClient.invalidateQueries 用法）
  - 09 篇 §4.2（四类事件 data 结构）

  **Acceptance Criteria**:
  - [ ] chat.message.new → 对应 channel 消息列表追加（setQueryData）
  - [ ] task.status.changed → 看板任务缓存更新
  - [ ] agent.loading/error → 消息 loading 状态更新
  - [ ] `cd web && npm run build` 退出码 0

  **QA Scenarios**:
  ```
  Scenario: 事件驱动缓存（Playwright）
    Tool: Playwright + Bash
    Preconditions: server + web 起 + 群聊/看板页
    Steps:
      1. 打开看板 → 后端广播 task.status.changed → 断言卡片更新
      2. 打开群聊 → 后端广播 chat.message.new → 断言消息追加
    Expected Result: SSE 事件驱动 Query 缓存
    Evidence: .omo/evidence/phase2-task-17-bridge.md
  ```

  **Commit**: YES
  - Message: `feat(web): SSE 事件→Query 缓存桥`
  - Files: web/hooks
  - Pre-commit: `cd web && npm run build`

- [x] 18. M2 联调（创建→启动→群聊@→SSE 回流→看板流转→断线补拉）

  **What to do**:
  - 联调环境：web dev（3001）+ server dev（3000）+ seed 数据
  - 跑通 M2 主流程（Playwright + curl 混合）：
    1. 登录 → 项目列表 → 创建任务（选 Agent + 主 Agent）→ 跳转 /tasks/[id]
    2. 看板页可见新任务（pending）→ 点「开始」→ status=in_progress
    3. 群聊发消息 @ Agent → 用户消息即时显示 → agent.loading 指示器 → mock 回复回流
    4. 看板卡片状态随 task.status.changed 联动
    5. 断线重连：断开 SSE → 重连 `?since=` → 补拉不丢不重
  - 修复联调问题（CORS/代理/token 传递/游标）
  - 产出 M2 验收证据：全流程截图 + 数据流说明

  **Must NOT do**:
  - 不改前端视觉来适配接口（先修后端/适配层）
  - 不实现 Phase 3/4 功能

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 前后端联调排障 + 全流程验证
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（联调收口）
  - **Parallel Group**: Wave 4
  - **Blocks**: 19, 20
  - **Blocked By**: 8, 10, 13, 14, 15, 16, 17

  **References**:
  - 09 篇 §2（API 通用约定）
  - Task 6-17 全部产物
  - 18 篇 §6.4（M2 定义）

  **Acceptance Criteria**:
  - [ ] M2 主流程全通过（创建→启动→群聊@→SSE 回流→看板流转）
  - [ ] 断线补拉不丢不重
  - [ ] 控制台无网络错误（除预期 401/403）

  **QA Scenarios**:
  ```
  Scenario: M2 主流程（Playwright）
    Tool: Playwright
    Preconditions: server + web 起 + seed
    Steps:
      1. 登录 → 创建任务（Agent 勾选 + 主 Agent）→ 跳 /tasks/[id]
      2. 看板见新任务 → 开始 → in_progress
      3. 群聊 @ 产品经理 → 断言 loading → mock 回复
      4. 看板卡片联动更新
    Expected Result: M2 全流程通过
    Evidence: .omo/evidence/phase2-task-18-m2-flow.png

  Scenario: 断线补拉
    Tool: Playwright + Bash
    Steps:
      1. 记录 lastEventId
      2. 停 server 5s → 重启
      3. 断言重连补拉无重复无遗漏
    Expected Result: 断线补拉正确
    Evidence: .omo/evidence/phase2-task-18-reconnect.md
  ```

  **Commit**: YES
  - Message: `feat: M2 联调（任务→群聊→SSE 回流）`
  - Files: 联调配置 .omo/evidence/
  - Pre-commit: `cd web && npm run build`

- [x] 19. 原型一致性验收（group-chat/dm-chat/task-board/task-create 截图对比）

  **What to do**:
  - 对 4 个 Phase 2 页面逐页执行实现 vs 原型截图对比（Playwright 双开截图 + 结构比对）
  - 对比维度：布局结构、token、data-testid、交互形态（SSE 实时、@ chips、Loading 指示器）
  - 产出对比报告 `.omo/evidence/phase2-prototype-parity.md`（每页 PASS/FAIL + 差异截图）
  - 差异项修复（优先修实现侧对齐原型）

  **Must NOT do**:
  - 不得为通过对比而修改原型文件
  - 不得放宽对比标准

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 视觉对比与差异分析
  - **Skills**: [`playwright`]

  **Parallelization**:
  - **Can Run In Parallel**: NO（验收收口）
  - **Parallel Group**: Wave 4
  - **Blocks**: 20
  - **Blocked By**: 12, 15（看板/task-create 数据接入后验收）

  **References**:
  - `docs/agent-platform/prototypes/group-chat/index.tsx`、`dm-chat/index.tsx`、`task-board/index.tsx`、`task-create/index.tsx`（基准）
  - Task 12-15 迁移产物

  **Acceptance Criteria**:
  - [ ] 4 页全部 PASS（视觉一致）
  - [ ] 对比报告存在，差异项全部解决或用户确认豁免

  **QA Scenarios**:
  ```
  Scenario: 逐页对比
    Tool: Playwright
    Steps:
      1. 对每页：开 web 实现 + 原型，同尺寸截图
      2. 像素 diff + 结构断言（data-testid 存在性）
      3. 记录 PASS/FAIL + diff 图
    Expected Result: 4 页 PASS
    Evidence: .omo/evidence/phase2-prototype-parity.md + 各页 diff 图
  ```

  **Commit**: YES
  - Message: `test: 原型一致性验收（Phase 2 四页 PASS）`
  - Files: .omo/evidence/
  - Pre-commit: 无

- [x] 20. 构建/测试全量验证（M2 证据汇总）

  **What to do**:
  - 全量验证：`cd server && npm run test && npm run build`、`cd web && npm run build`
  - 汇总 M2 证据清单到 `.omo/evidence/phase2-m2-summary.md`（状态机/群聊/SSE/联调 4 项证据引用）
  - 检查无 Phase 3+ 功能泄漏（grep artifacts 表写入/Agent CRUD/worker 分派等不在范围代码）

  **Must NOT do**:
  - 不新写功能（纯验证汇总）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 验证命令执行 + 证据汇总
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（最终验证）
  - **Parallel Group**: Wave 4
  - **Blocks**: F1-F4
  - **Blocked By**: 18, 19

  **References**:
  - Task 1-19 各任务证据
  - 18 篇 §6.4（M2 定义）

  **Acceptance Criteria**:
  - [ ] server test/build 全过
  - [ ] web build 全过
  - [ ] M2 汇总文档齐全、无 Phase 3+ 泄漏

  **QA Scenarios**:
  ```
  Scenario: 全量门禁
    Tool: Bash
    Steps:
      1. cd server && npm run test → 全过
      2. cd server && npm run build → exit 0
      3. cd web && npm run build → exit 0
      4. grep -r "artifact" server/src --include="*.ts" | grep -v spec → 仅 Phase 2 范围内（backgroundDocs）
    Expected Result: 全部门禁通过
    Evidence: .omo/evidence/phase2-task-20-gate.md
  ```

  **Commit**: YES
  - Message: `docs: M2 证据汇总`
  - Files: .omo/evidence/
  - Pre-commit: 无

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .omo/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `cd server && npm run test && npm run build` + `cd web && npm run build`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp). Verify event name `task.status.changed` (dot) used consistently — grep for `task_status_changed` (underscore) variant in server/src, web/, tests.
  Output: `Build [PASS/FAIL] | Test [N pass/N fail] | Files [N clean/N issues] | EventName [PASS/FAIL] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (M2 flow: create → start → chat @ agent → SSE loading→reply → board status change → disconnect/reconnect since catch-up). Save to `.omo/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **1**: `feat(server): RealtimeModule 完整改造（scope/鉴权/字符串事件 id/持久化）` - server/src/realtime, server/prisma
- **2**: `refactor(server): 守卫统一（ProjectMembershipGuard + 清理 PlaceholderAuthGuard）` - server/src/projects, server/src/common
- **3**: `feat(server): 消息主键生成器 + 状态常量` - server/src/common
- **4**: `feat(server): seed 4 内置 Agent + GET /agents` - server/prisma/seed, server/src/agents
- **5**: `feat(web): useSSE hook（query token + since 续拉）` - web/hooks
- **6**: `feat(server): TasksModule CRUD/看板` - server/src/tasks
- **7**: `feat(server): TasksModule 状态机` - server/src/tasks
- **8**: `feat(server): TasksModule team 端点` - server/src/tasks
- **9**: `feat(server): ChatModule 频道/消息/历史` - server/src/chat
- **10**: `feat(server): MockDispatcher 确定性模板回复` - server/src/chat
- **11**: `feat(web): MessageInput 重写（受控 + @ chips）` - web/src/components/ui/message-input.tsx
- **12**: `feat(web): task-board 接真实数据 + status_changed` - web/app/(main)/board
- **13**: `feat(web): group-chat 页 /tasks/[id]` - web/app/(main)/tasks/[id]
- **14**: `feat(web): dm-chat 页 /messages/[id]` - web/app/(main)/messages
- **15**: `feat(web): task-create 增强（真实提交）` - web/app/(main)/tasks/new
- **16**: `feat(web): AppShell 路由/标题/Dock 高亮配套` - web/src/components/layout/app-shell.tsx
- **17**: `feat(web): SSE 事件→Query 缓存桥` - web/hooks
- **18**: `feat: M2 联调（任务→群聊→SSE 回流）` - 联调配置/证据
- **19**: `test: 原型一致性验收` - .omo/evidence/
- **20**: `docs: M2 证据汇总` - .omo/evidence/

---

## Success Criteria

### Verification Commands
```bash
cd server && npm run test   # Expected: all pass (含 Tasks/Chat/Realtime 改造)
cd server && npm run build  # Expected: exit 0
cd web && npm run build     # Expected: exit 0
curl -s http://localhost:3000/api/v1/health  # Expected: {"status":"ok"}
```

### M2 联调验证
```bash
# 登录 → 创建任务 → 启动 → 发消息 @Agent → SSE 观察 loading→message → 看板 status 变化 → 断线补拉
# 详细步骤见 Task 18 QA Scenarios
```

### Final Checklist
- [x] 所有 "Must Have" 存在
- [x] 所有 "Must NOT Have" 不存在
- [x] 所有测试通过
- [x] 事件名 task.status.changed 全链路一致
- [x] M2 里程碑达成
