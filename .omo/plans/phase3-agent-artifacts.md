# Phase 3 Agent 与产出物（M3）

## TL;DR

> **Quick Summary**: 完成 Phase 3「Agent 与产出物」——后端 AgentsModule 完整化（模板/克隆/自定义/available-models）、虚拟团队 sessions 状态机、ArtifactsModule（协议校验/归档/文档库/验收联动）；前端迁移 agent-config/user-management/role-permission 三原型页 + 新增项目级产出物管理聚合页（/artifacts?pid=，三筛+版本查看器+验收徽章），前后端同步推进，M3 验收闭环。
>
> **Deliverables**:
> - 后端：Agents CRUD+克隆、sessions active 过渡、ArtifactsModule 4 端点+归档链路+验收联动、artifact.submitted 事件、users 创建/重置密码、AdminGuard 落地、角色矩阵 CRUD
> - 前端：/agents（agent-config 原型）、/users（user-management 原型）、/roles（role-permission 原型 + Dock 新项）、/artifacts?pid=（新增聚合页：任务+类型+状态三筛 + 列表 + 版本查看器 + 验收徽章）
> - 入口改造：看板「产出物」按钮 + 项目卡片次级入口 + 群聊页 artifact-link 改真实跳转
> - 文档同步：18 篇 §7.4 更新（task-detail 不迁移、新增 /artifacts、/roles 两行）
>
> **Estimated Effort**: XL
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: 契约基座 → Agents/Artifacts 后端 → 前端聚合页 → M3 联调 → 验收

---

## Context

### Original Request
按推进计划（docs/agent-platform/18-推进计划（分阶段实施）.md §7）继续 Phase 3「Agent 与产出物」（M3 里程碑）——Agent 配置、虚拟团队、产出物归档闭环。用户明确：新增产出物管理聚合页（归属项目、任务关联、任务+类型+状态三筛、默认全部、列表+版本查看器）、验收状态徽章要加、前后端同步推进、role-permission 新建 /roles + Dock 新项、群聊页 artifact-link 改跳转按钮。

### Interview Summary
**Key Discussions**:
- 产出物管理页：路由 `/artifacts?pid=`（与 /board?pid= 同模式）、看板「产出物」入口 + 项目卡片次级入口、Dock 高亮归项目；项目级聚合、三筛默认全部；列表+版本查看器
- 验收状态徽章：要加（补原型，非按原型原样）
- 前后端同步推进（非前端先行）
- role-permission：新建 /roles + Dock 新项
- 群聊页 artifact-link 占位 → 真实跳转按钮 → /artifacts?pid=
- task-detail 原型不迁移（产出物聚合页取代单任务文档库）
- 测试策略：后端 jest（现有 17 spec/201 tests + 新增模块补 spec）；前端无测试框架（tsc + build + Playwright QA）

**Research Findings**:
- 后端：数据库 20 表 100% 就绪零迁移（Agent/agent_skills/agent_tool_effects/TaskAgent/Session/Artifact/ArtifactVersion 字段齐全）；创建任务已写 task_agents+sessions；team add/remove 完整（tasks.service.ts:333-502）；MockDispatcher 时序模式可复用；Realtime 基座就绪（注册 artifact.submitted 零改造）；AdminGuard 为占位放行（admin.guard.ts:15-19）
- 前端：tokens.ts 与原型 _shared/styles.ts 逐字一致（102 行全同）；导航 6 项就绪；ui 8 + chat 5 组件已迁移；agent-config/user-management 占位页待替换、role-permission 无路由、/artifacts 无路由

### Metis Review
**Identified Gaps** (addressed):
- 契约先行：前后端并行前先定 agents/artifacts API 契约（mock 回流样例数据）→ 计划含契约任务
- 验收状态机边界：退回后重提的版本语义（append 新版本 + sha256 幂等）→ 计划明确
- 克隆深层语义：克隆复制 agent_skills/agent_tool_effects、与模板解耦、baseAgentId 血缘 → 计划明确
- 零 DDL 护栏：schema 已就绪，实现中禁止 DDL；发现缺口先暂停讨论
- 模板只读保护覆盖 PATCH/DELETE 双路径 403
- Phase 0-2 回归防线（team/Realtime/创建任务）
- 文档同步：18 篇 §7.4 更新（task-detail 不迁移、新增 /artifacts、/roles）

---

## Work Objectives

### Core Objective
完成 Phase 3「Agent 与产出物」（M3）：后端 AgentsModule/ArtifactsModule/虚拟团队/验收联动 + 前端三原型页迁移 + 项目级产出物管理聚合页，实现「Agent 配置 → 加入任务 → mock 产出 → 归档 → 文档库展示 → 验收闭环」。

### Concrete Deliverables
- 后端：AgentsModule 5 端点扩展、sessions active 过渡、ArtifactsModule（4 端点+校验+归档+验收联动）、artifact.submitted 事件、users 创建/重置密码、AdminGuard 落地、角色矩阵 CRUD
- 前端：/agents、/users、/roles、/artifacts?pid= 四路由；看板/项目卡/群聊页入口改造；Dock 7 项
- 文档：18 篇 §7.4 同步

### Definition of Done
- [x] server: npx jest --no-cache --runInBand 全绿（现有 201 + 新增 spec）
- [x] server: npm run build exit 0
- [x] web: npx tsc --noEmit exit 0；npm run build exit 0
- [x] M3 端到端：Agent 配置 → 创建任务选 Agent → mock 会话产出 → 归档 → /artifacts?pid= 三筛+版本查看器+验收徽章 → accept 验收闭环（Playwright 实测）

### Must Have
- AgentsModule：GET /agents（type? 过滤+分页+扩展字段 skillIds/toolEffects/permissionScope/defaultModelId）、GET /agents/:id、POST /agents（custom）、POST /agents/:id/clone（事务复制三表+baseAgentId 血缘）、PATCH /agents/:id（template→403 PERMISSION_AGENT_READONLY）、GET /agents/:id/available-models（静态占位）
- 虚拟团队：sessions created→active 过渡（任务启动时）
- ArtifactsModule：json_schema 协议校验（非法回退普通消息）、归档链路（mock 事件注入、append 版本递增+sha256 幂等去重）、文档库 3 端点 + POST 旁路、artifact.submitted 事件注册
- 验收联动：accept 事务内标记 current_version.accepted_flag；验收后 append → 任务退回进行中；已验收版本写操作 409 ARTIFACT_ACCEPTED_IMMUTABLE
- 前端四路由 + 三筛 + 版本查看器 + 验收徽章 + 入口改造 + Dock 7 项
- users 创建/重置密码端点 + AdminGuard 真实实现 + 角色矩阵 CRUD
- 18 篇 §7.4 文档同步

### Must NOT Have (Guardrails)
- 数据库零迁移：禁止任何 DDL（schema 已就绪）；发现缺口先暂停讨论
- available-models 只做静态占位，不接动态模型市场/真实模型探测
- 不接真实 LLM：产出物全部由 mock 事件注入（MockDispatcher 模式）
- 不做多级审批工作流（仅单级 accept/reject）
- 不做租户级 RBAC 引擎（仅角色矩阵 CRUD）
- 文档库不做富文本编辑/批量下载（仅聚合展示 + 版本查看器）
- task-detail 原型不迁移（聚合页取代）
- 不引入新外部依赖（three 等）；克隆/写路径全部走现有 JwtAuthGuard + 模板只读 403
- 不碰 git 凭证/Worker（Phase 4）

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: 后端 YES（jest 17 spec/201 tests）/ 前端 NO（无测试框架）
- **Automated tests**: 后端 TDD（新增模块补 spec）；前端 None（tsc + build + Playwright QA）
- **Framework**: 后端 jest；前端无

### QA Policy
Every task MUST include agent-executed QA scenarios. Evidence saved to `.omo/evidence/task-{N}-{scenario-slug}.{ext}`.

- **API/Backend**: Bash (curl) - 登录拿 token，请求端点，断言 status + 响应字段
- **Frontend/UI**: Playwright - 导航、填表、点击、断言 DOM、截图
- **Config/Build**: tsc / npm build exit 0

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (契约与基座 - 并行启动):
├── T1: 18 篇 §7.4 文档同步 [quick]
├── T2: artifact.submitted 事件注册 + ArtifactsMockConsumer（mock 归档事件注入模板）[deep]
├── T3: AgentsModule 契约扩展：GET /agents 分页+type 过滤+扩展字段、GET /agents/:id [quick]
└── T4: sessions active 过渡 + 任务启动置 active [quick]

Wave 2 (核心模块 - 最大并行):
├── T5: AgentsModule CRUD：POST custom + clone + PATCH(模板403) + available-models [deep]
├── T6: ArtifactsModule 归档链路：json_schema 校验 + append 幂等 + 文档库 4 端点 [deep]
├── T7: 验收联动：accept 标记 accepted_flag + 409 不可变 + append 退回 [unspecified-high]
├── T8: users 创建/重置密码 + AdminGuard 落地 + 角色矩阵 CRUD [unspecified-high]
├── T9: 前端 /agents（agent-config 原型迁移）[visual-engineering]
├── T10: 前端 /users（user-management 原型迁移）[visual-engineering]
└── T11: 前端 /roles（role-permission 原型 + Dock 新项）[visual-engineering]

Wave 3 (聚合页与入口):
├── T12: 前端 /artifacts?pid= 聚合页（三筛+列表+版本查看器+验收徽章）[visual-engineering]
├── T13: 入口改造：看板「产出物」按钮 + 项目卡次级入口 + 群聊页 artifact-link 跳转 [visual-engineering]
└── T14: 后端可用性验证：GET /tasks/:id/artifacts + 三筛参数 + 版本查看器端点联调 [unspecified-high]

Wave 4 (M3 联调收口):
├── T15: M3 端到端联调（Agent 配置→任务→mock 产出→归档→聚合页→验收）[deep]
├── T16: 全量验证（server jest+build + web tsc+build + Playwright 回归）[unspecified-high]
└── T17: learnings/文档收口 + M3 证据汇总 [writing]

Wave FINAL (4 parallel reviews):
├── F1: Plan Compliance Audit (oracle)
├── F2: Code Quality Review (unspecified-high)
├── F3: Real Manual QA (unspecified-high)
└── F4: Scope Fidelity Check (deep)
-> Present results -> Get explicit user okay

Critical Path: T2 → T6 → T12 → T15 → F1-F4 → user okay
Parallel Speedup: ~70% faster than sequential
Max Concurrent: 7 (Waves 1 & 2)
```

### Dependency Matrix
- **T1-T4**: 独立，Wave 1 并行
- **T5**: T3 - T15, 3
- **T6**: T2 - T14, 15, 3
- **T7**: T6 - T15, 3
- **T8**: 独立 - T15, 3
- **T9-T11**: 独立 - T15, 3
- **T12**: T6, T14 - T15, 3
- **T13**: 独立（入口按钮，目标页面 T12 建后联调） - T15, 3
- **T14**: T6 - T12, 15, 3
- **T15**: T5-T13 - T16, 4
- **T16**: T15 - F1-F4, 4
- **T17**: T16 - F1-F4, 4

### Agent Dispatch Summary
- **Wave 1**: T1 → quick, T2 → deep, T3 → quick, T4 → quick
- **Wave 2**: T5 → deep, T6 → deep, T7 → unspecified-high, T8 → unspecified-high, T9-T11 → visual-engineering
- **Wave 3**: T12-T13 → visual-engineering, T14 → unspecified-high
- **Wave 4**: T15 → deep, T16 → unspecified-high, T17 → writing
- **FINAL**: F1 → oracle, F2 → unspecified-high, F3 → unspecified-high, F4 → deep

---

## TODOs

> 实现 + 测试 = ONE Task。任务标签用裸数字格式 `1.`、`2.`（Final Wave 用 `F1.`）。每个任务必须有 QA 场景。

- [x] 1. 18 篇 §7.4 前端迁移表文档同步

  **What to do**:
  - 更新 `docs/agent-platform/18-推进计划（分阶段实施）.md` §7.4 前端表：删除 task-detail 行（不迁移，由产出物聚合页取代）
  - 新增两行：`/artifacts?pid=`（产出物管理聚合页：项目级、任务+类型+状态三筛、版本查看器、验收徽章）与 `/roles`（角色权限，新 Dock key）
  - §7.5 M3 里程碑描述同步（产出物聚合页替代 task-detail 单任务文档库展示）

  **Must NOT do**:
  - 不改 §7.1-7.3 后端范围（Agents/虚拟团队/Artifacts 契约不变）
  - 不改其他设计文档

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 纯文档编辑，无逻辑
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**: 无

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T2-T4)
  - **Blocks**: T15（M3 联调需文档一致）
  - **Blocked By**: None

  **References**:
  - `docs/agent-platform/18-推进计划（分阶段实施）.md:451-465` - §7.4 前端迁移表（task-detail 行待删）
  - `docs/agent-platform/18-推进计划（分阶段实施）.md:466-472` - §7.5 M3 里程碑描述
  - 用户决策：task-detail 不迁移、/artifacts?pid= 聚合页、/roles + Dock 新项

  **Acceptance Criteria**:
  - [ ] §7.4 无 task-detail 行；新增 /artifacts?pid= 与 /roles 两行
  - [ ] §7.5 M3 描述与聚合页方案一致

  **QA Scenarios**:
  ```
  Scenario: 文档同步完整
    Tool: Bash
    Preconditions: 文档已编辑
    Steps:
      1. grep "task-detail" 18 篇 → 应仅剩 §2.7 原型介绍引用（迁移表无）
      2. grep "artifacts?pid=" → 有
      3. grep "/roles" §7.4 → 有
    Expected Result: 3 项全部满足
    Evidence: .omo/evidence/task-1-doc-sync.txt
  ```

  **Commit**: YES
  - Message: `docs: 推进计划 §7.4 同步 Phase 3 前端范围（task-detail 移除、/artifacts、/roles）`
  - Files: `docs/agent-platform/18-推进计划（分阶段实施）.md`

- [x] 2. artifact.submitted 事件注册 + ArtifactsMockConsumer（mock 归档事件注入）

  **What to do**:
  - `server/src/common/constants/event.constants.ts` EVENT_TYPES 加 `ARTIFACT_SUBMITTED: 'artifact.submitted'`
  - 新建 `server/src/artifacts/` 模块骨架：ArtifactsModule/ArtifactsController（文档库 GET 端点先空）/ArtifactsService
  - 新建 `ArtifactsMockConsumer`（或仿 MockDispatcher 模式）：模拟 Phase 4 worker 回流——定时/触发式广播 `artifact.submitted` 事件（scope=task，payload 含 taskId/type/title/content/fileRef），供归档链路消费。参考 `server/src/chat/mock-dispatcher.ts:126-211` 的时序模式（sleep → 事件广播 → 落库）
  - 事件经 RealtimeService.broadcast 广播（scope task:id，projectId 自动解析已具备）

  **Must NOT do**:
  - 不做真实文件上传/存储（fileRef 仅字符串占位）
  - 不做 json_schema 校验（T6 做）
  - 不改现有事件类型

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 模块骨架 + 事件驱动 mock 消费链路，需理解 Realtime/Dispatcher 模式
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T6（ArtifactsModule 归档链路消费此事件）
  - **Blocked By**: None

  **References**:
  - `server/src/common/constants/event.constants.ts:8-14` - EVENT_TYPES 注册模式
  - `server/src/chat/mock-dispatcher.ts:126-211` - MockDispatcher 时序（sleep→loading→回复→落库→广播）
  - `server/src/realtime/realtime.service.ts:81-125` - emit/broadcast + scope
  - `server/src/chat/chat.module.ts:24` - DI useClass 注入模式
  - `server/prisma/schema.prisma:234-268` - Artifact/ArtifactVersion 表结构

  **Acceptance Criteria**:
  - [ ] artifact.submitted 注册成功，npx jest src/common/constants 通过
  - [ ] ArtifactsMockConsumer 可广播 artifact.submitted（curl SSE 订阅 task scope 收到）

  **QA Scenarios**:
  ```
  Scenario: 事件注册 + mock 广播
    Tool: Bash (curl)
    Preconditions: server 运行（3000）
    Steps:
      1. 登录拿 token；订阅 SSE scope=task:t_0000000002（后台 curl）
      2. 触发 ArtifactsMockConsumer（或测试端点/注入调用）
      3. 断言收到 data: {...type: "artifact.submitted"...}
    Expected Result: SSE 收到 artifact.submitted 帧
    Evidence: .omo/evidence/task-2-event-broadcast.txt

  Scenario: 兼容性 - 现有事件不回归
    Tool: Bash
    Steps: npx jest --no-cache src/chat src/realtime src/common/constants
    Expected Result: 全绿
    Evidence: .omo/evidence/task-2-regression.txt
  ```

  **Commit**: YES
  - Message: `feat(artifacts): artifact.submitted 事件 + ArtifactsMockConsumer 骨架`
  - Files: `server/src/...`

- [x] 3. AgentsModule 契约扩展：GET /agents 分页 + type 过滤 + 扩展字段、GET /agents/:id

  **What to do**:
  - `server/src/agents/agents.service.ts` findAll：加 `type?` 过滤参数 + 分页（page/pageSize，缺省分页，对齐 projects 分页模式）；响应每项扩展映射 skillIds（关联 agent_skills）/toolEffects（关联 agent_tool_effects）/permissionScope/defaultModelId/baseAgentId
  - 新增 GET /agents/:id 详情端点（含完整关联）
  - DTO：QueryAgentsDto（type?/page?/pageSize?）

  **Must NOT do**:
  - 不做 POST/PATCH/clone（T5 做）
  - 不改 schema

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 单模块查询扩展，模式清晰
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T5（CRUD 依赖现有查询结构）、T9（/agents 页依赖扩展字段）
  - **Blocked By**: None

  **References**:
  - `server/src/agents/agents.service.ts:15-34` - 现 findAll（5 字段）
  - `server/src/agents/agents.controller.ts:19-23` - 现端点
  - `server/prisma/schema.prisma:274-325` - Agent/agent_skills/agent_tool_effects
  - `server/src/projects/projects.service.ts` - 分页模式参考

  **Acceptance Criteria**:
  - [ ] GET /agents?type=template 返回 4 个预置模板，含 skillIds/toolEffects/permissionScope/defaultModelId 字段
  - [ ] GET /agents/:id 返回完整关联
  - [ ] npx jest src/agents 通过

  **QA Scenarios**:
  ```
  Scenario: type 过滤 + 扩展字段
    Tool: Bash (curl)
    Preconditions: server 运行，admin token
    Steps:
      1. GET /agents?type=template → 断言 items 每项含 skillIds/toolEffects/permissionScope 字段
      2. GET /agents/a_product → 200 含完整关联
    Expected Result: 字段齐全
    Evidence: .omo/evidence/task-3-agents-query.txt
  ```

  **Commit**: YES
  - Message: `feat(agents): GET /agents 分页+type 过滤+扩展字段 + 详情端点`

- [x] 4. sessions active 过渡（任务启动置 active）

  **What to do**:
  - `server/src/tasks/tasks.service.ts` 任务启动（start）时：将该任务所有 session 从 created 置 active（对齐 SESSION_STATUS.active，event.constants.ts:44-51）
  - 复用现有 start 事务逻辑（tasks.service.ts:215-225 附近）
  - 确认 rejoin（team add）的 session 若在 created/frozen 恢复后置 active 的语义（与团队变更衔接）

  **Must NOT do**:
  - 不改 sessions 表结构
  - 不做 worker 调度（Phase 4）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 单点状态过渡
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T15（M3 联调）
  - **Blocked By**: None

  **References**:
  - `server/src/tasks/tasks.service.ts:215-225` - start 事务/状态广播
  - `server/src/tasks/tasks.service.ts:191` - session 创建 created
  - `server/src/common/constants/event.constants.ts:44-51` - SESSION_STATUS

  **Acceptance Criteria**:
  - [ ] 启动任务后 GET session（DB 直查）status=active
  - [ ] npx jest src/tasks 通过

  **QA Scenarios**:
  ```
  Scenario: 启动置 active
    Tool: Bash (curl + node DB 查)
    Preconditions: 有 pending 任务含 task_agents
    Steps:
      1. POST /tasks/:id/start
      2. node 查 sessions where taskId → status 全 active
    Expected Result: active
    Evidence: .omo/evidence/task-4-session-active.txt
  ```

  **Commit**: YES
  - Message: `feat(tasks): 任务启动置 sessions active`

- [x] 5. AgentsModule CRUD：POST custom + clone + PATCH（模板 403）+ available-models

  **What to do**:
  - POST /agents（custom）：创建 Agent + agent_skills + agent_tool_effects（三表事务）；入参 type=custom/prompt/skillIds/toolEffects/permissionScope/defaultModelId
  - POST /agents/:id/clone：深拷贝副本（baseAgentId 血缘指向源），同事务复制三表；克隆体与源解耦（改克隆体不影响模板）
  - PATCH /agents/:id：type=template → 403 `PERMISSION_AGENT_READONLY`（14 篇 §7 / FR-33）；custom 可更新
  - DELETE /agents/:id：template → 403；custom 可删（含级联关联清理）
  - GET /agents/:id/available-models：静态占位（返回固定模型列表数组，Phase 4 接 worker 真实探测）
  - DTO：CreateAgentDto/UpdateAgentDto/CloneAgentDto

  **Must NOT do**:
  - 不改 schema；不接真实模型探测
  - 克隆不复制会话/任务关系（仅 Agent 三表 + baseAgentId）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 三表事务 + 克隆血缘 + 权限拦截，逻辑较多
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T6-T11)
  - **Blocks**: T15（M3 联调）
  - **Blocked By**: T3（查询结构）

  **References**:
  - `server/src/agents/agents.service.ts` - 查询结构（T3 后）
  - `server/prisma/schema.prisma:274-325` - Agent 三表
  - `server/src/tasks/tasks.service.ts:33-40` - 事务 + id-generator 模式
  - `server/src/common/constants/` - 错误码定义模式（仿 AUTH_ERRORS/PROJECT_MEMBERSHIP_ERRORS 新建 AGENT_ERRORS）
  - 14 篇 §2.2/§7：克隆语义、模板只读 403

  **Acceptance Criteria**:
  - [ ] POST custom 创建成功（三表）；GET /agents 可见
  - [ ] clone 后 baseAgentId=源 id；改克隆体不影响源
  - [ ] PATCH/DELETE template → 403 PERMISSION_AGENT_READONLY
  - [ ] available-models 返回静态数组
  - [ ] npx jest src/agents 通过

  **QA Scenarios**:
  ```
  Scenario: 克隆 + 血缘 + 解耦
    Tool: Bash (curl)
    Preconditions: server 运行，admin token
    Steps:
      1. POST /agents/a_product/clone → 新 id，baseAgentId=a_product
      2. PATCH 克隆体改 prompt → 200；GET /agents/a_product → prompt 不变
      3. PATCH /agents/a_product → 403 PERMISSION_AGENT_READONLY
    Expected Result: 血缘/解耦/403 全对
    Evidence: .omo/evidence/task-5-clone.txt

  Scenario: available-models 静态占位
    Tool: Bash (curl)
    Steps: GET /agents/a_product/available-models → 200 数组
    Expected Result: 静态模型数组
    Evidence: .omo/evidence/task-5-models.txt
  ```

  **Commit**: YES
  - Message: `feat(agents): custom/clone/PATCH(模板403)/available-models`

- [x] 6. ArtifactsModule 归档链路：json_schema 校验 + append 幂等 + 文档库端点

  **What to do**:
  - ArtifactsService 核心：
    - 协议校验：json_schema 校验 artifact 声明（type/title/content/fileRef）；非法声明回退普通消息不产生归档（12 篇 §3 / FR-38）
    - 归档链路：消费 ArtifactsMockConsumer 的 artifact.submitted 事件；text 直接归档 / doc+file 经 mock 拉取（重试 3 次 2s/4s/8s，Phase 3 mock 直接可用）；append 递增版本 + sha256 幂等去重（同 task+type+sha256 已存在则跳过）
    - 文档库端点：GET /tasks/:id/artifacts（分页）、GET /artifacts/:id、GET /artifacts/:id/versions/:version
    - POST /tasks/:id/artifacts（旁路，Phase 3 供前端/测试注入 mock 产出）
  - artifact ID 前缀 'art' + version 前缀（id-generator 注册或模块内自建，参考 tasks.service.ts:33-40）
  - 响应 DTO：ArtifactDto（id/taskId/type/title/currentVersion）+ ArtifactVersionDto（version/contentRef/filePath/sha256/acceptedFlag/authorAgentId/changeNote/createdAt）

  **Must NOT do**:
  - 不做真实文件存储（fileRef 字符串占位）
  - 不做验收联动（T7 做）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 协议校验 + 幂等 + 重试 + 版本管理，核心业务
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T7（验收联动依赖归档）、T14（联调）、T15
  - **Blocked By**: T2（mock 事件）

  **References**:
  - `server/src/chat/mock-dispatcher.ts` - 事件消费时序参考
  - `server/prisma/schema.prisma:234-268` - Artifact/ArtifactVersion
  - 12 篇 §3/§5/§6：协议校验、归档链路、文档库
  - `server/src/common/constants/event.constants.ts` - 事件（T2 后含 artifact.submitted）

  **Acceptance Criteria**:
  - [ ] 非法 json_schema 声明 → 不产生 artifact（回退消息）
  - [ ] 同 sha256 重复 append → 幂等去重（版本不增）
  - [ ] GET /tasks/:id/artifacts、GET /artifacts/:id、GET /artifacts/:id/versions/:version 正确
  - [ ] npx jest src/artifacts 通过

  **QA Scenarios**:
  ```
  Scenario: 归档 + 幂等
    Tool: Bash (curl)
    Preconditions: server 运行；任务 t_0000000002
    Steps:
      1. POST /tasks/:id/artifacts {type:'doc', title:'架构', content:'...'} → 200 artifact v1
      2. 重复同 content 提交 → 幂等（currentVersion 仍 1）
      3. 改 content 再提交 → v2
      4. GET /tasks/:id/artifacts → 2 条（或 1 条 2 版本）
    Expected Result: 版本递增 + 幂等去重
    Evidence: .omo/evidence/task-6-archive.txt

  Scenario: 非法声明回退
    Tool: Bash (curl)
    Steps: POST {type:'bogus', title:'x'} → 校验拒绝，无 artifact 产生
    Expected Result: 400 或回退，DB 无 artifact
    Evidence: .omo/evidence/task-6-invalid.txt
  ```

  **Commit**: YES
  - Message: `feat(artifacts): 归档链路（json_schema 校验/幂等 append/文档库端点）`

- [x] 7. 验收联动：accept 标记 accepted_flag + 409 不可变 + append 退回

  **What to do**:
  - `server/src/tasks/tasks.service.ts` accept 端点（:559-566）：事务内标记该任务所有 ArtifactVersion 当前版本 accepted_flag=true（12 篇 §7）
  - 已验收版本的写操作 → 409 `ARTIFACT_ACCEPTED_IMMUTABLE`（T6 的 append 链路检查）
  - 验收后新 append → 任务自动退回 in_progress（状态过渡 + task.status.changed 广播）
  - reject 语义保持（pending_review→in_progress）

  **Must NOT do**:
  - 不改 schema；不做多级审批

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 状态联动逻辑中等复杂度
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T15
  - **Blocked By**: T6（归档链路）

  **References**:
  - `server/src/tasks/tasks.service.ts:549-580` - mark-pending-review/accept/reject 现状
  - 12 篇 §7：验收联动设计
  - `server/prisma/schema.prisma:251-268` - acceptedFlag 字段

  **Acceptance Criteria**:
  - [ ] accept 后 ArtifactVersion.accepted_flag=true
  - [ ] 已验收版本写操作 → 409 ARTIFACT_ACCEPTED_IMMUTABLE
  - [ ] 验收后 append → 任务退回 in_progress + 广播
  - [ ] npx jest src/tasks src/artifacts 通过

  **QA Scenarios**:
  ```
  Scenario: 验收闭环
    Tool: Bash (curl)
    Preconditions: 任务有 artifact v1；状态 in_progress
    Steps:
      1. POST /tasks/:id/mark-pending-review → POST /tasks/:id/accept
      2. node 查 artifact_versions → accepted_flag=true
      3. 再 POST 新 artifact → 409 ARTIFACT_ACCEPTED_IMMUTABLE 或任务退回
    Expected Result: 验收联动全对
    Evidence: .omo/evidence/task-7-accept.txt
  ```

  **Commit**: YES
  - Message: `feat(tasks): 验收联动（accepted_flag/409/退回）`

- [x] 8. users 创建/重置密码 + AdminGuard 落地 + 角色矩阵 CRUD

  **What to do**:
  - users 模块：POST /users（创建用户，含角色分配，复用 auth.service.ts register 的 bcrypt/冲突校验逻辑）、POST /users/:id/reset-password（重置密码）
  - AdminGuard 落地：`server/src/users/admin.guard.ts` 从占位放行改为真实校验（基于用户角色 Role.permissions 检查 users:manage 权限）
  - 角色矩阵：Role 表 CRUD 端点（GET /roles、POST /roles、PATCH /roles/:id、DELETE /roles/:id；预置 admin/member 只读 403）+ 权限矩阵数据结构（8 资源 × 6 操作，对齐原型 role-permission）

  **Must NOT do**:
  - 不做租户级 RBAC 引擎（仅平台角色矩阵）
  - 不改 schema（Role 表已有 permissions/scopes Json）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 多端点 + 权限逻辑
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T11（/roles 页）、T15
  - **Blocked By**: None

  **References**:
  - `server/src/auth/auth.service.ts:43-95` - register（bcrypt/冲突校验复用）
  - `server/src/users/admin.guard.ts:15-19` - 占位 guard
  - `server/src/users/users.controller.ts:27-51` - 现有列表/详情/状态端点
  - `server/prisma/schema.prisma:58-70` - Role 表（permissions/scopes）
  - `docs/agent-platform/prototypes/role-permission/index.tsx:57-68` - 8 资源 × 6 操作矩阵

  **Acceptance Criteria**:
  - [ ] POST /users 创建成功（含角色）；POST /users/:id/reset-password 生效
  - [ ] AdminGuard 拦截非管理员访问 users:manage 端点
  - [ ] 角色 CRUD 可用；预置角色 403
  - [ ] npx jest src/users 通过

  **QA Scenarios**:
  ```
  Scenario: 用户管理闭环
    Tool: Bash (curl)
    Preconditions: server 运行
    Steps:
      1. POST /users {username, password, roleId} → 200
      2. 新用户登录 → 可登录
      3. POST /users/:id/reset-password → 200；旧密码失效新密码生效
      4. 非 admin 访问 GET /users → 403
    Expected Result: 全对
    Evidence: .omo/evidence/task-8-users.txt

  Scenario: 角色矩阵 CRUD
    Tool: Bash (curl)
    Steps: GET /roles → 预置角色；PATCH 预置 → 403；POST 自定义 → 200
    Expected Result: 预置只读 + 自定义可写
    Evidence: .omo/evidence/task-8-roles.txt
  ```

  **Commit**: YES
  - Message: `feat(users): 创建/重置密码 + AdminGuard + 角色矩阵 CRUD`

- [x] 9. 前端 /agents（agent-config 原型迁移）

  **What to do**:
  - 将 `docs/agent-platform/prototypes/agent-config/index.tsx`（975 行）迁移到 `web/app/(main)/agents/page.tsx`（替换 337 字节占位）
  - 布局：左 Agent 列表 + 右五块配置面板（提示词/默认模型/技能勾选/工具 effect 三态/权限范围），data-testid 与原型一致（agent-list-item/clone-template-button/prompt-editor/model-select/skill-list/tool-effect-select/permission-config）
  - 接真实 API：GET /agents（T3）、GET /agents/:id（T3）、POST /agents/clone（T5）、POST /agents custom（T5）、PATCH（T5）
  - 模板只读态交互：type=template 的 Agent 显示只读（PATCH 按钮禁用/隐藏），custom 可编辑
  - 页面内扩展 token：toolEffectMeta/toolSourceMeta（仿原型 :156-170，不扩散共享层）

  **Must NOT do**:
  - 不改 tokens.ts 基线；不新增依赖
  - 不迁移 task-detail

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 原型页迁移 + 表单交互
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T15
  - **Blocked By**: T3（API）、T5（CRUD）

  **References**:
  - `docs/agent-platform/prototypes/agent-config/index.tsx` - 原型（data-testid 全列表在调研记录）
  - `web/app/(main)/agents/page.tsx` - 占位页待替换
  - `web/src/components/ui/agent-avatar.tsx` - 复用
  - `web/src/theme/tokens.ts` - tokens

  **Acceptance Criteria**:
  - [ ] /agents 渲染：Agent 列表 + 五块配置；data-testid 与原型一致
  - [ ] 模板只读态（无 PATCH 按钮）、custom 可编辑
  - [ ] 克隆/新建调真实 API 成功
  - [ ] tsc + build exit 0

  **QA Scenarios**:
  ```
  Scenario: /agents 页加载 + 只读态
    Tool: Playwright
    Preconditions: 登录态
    Steps:
      1. 导航 /agents → 断言 agent-config-root + agent-list-item 数量=4
      2. 点选模板 a_product → prompt-editor 只读、无编辑按钮
      3. 点 clone-template-button → 新 custom Agent 出现且可编辑
    Expected Result: 渲染/只读/克隆全对
    Evidence: .omo/evidence/task-9-agents.png
  ```

  **Commit**: YES
  - Message: `feat(web): /agents 迁移 agent-config 原型 + 真实 API`

- [x] 10. 前端 /users（user-management 原型迁移）

  **What to do**:
  - 将 `docs/agent-platform/prototypes/user-management/index.tsx`（779 行）迁移到 `web/app/(main)/users/page.tsx`（替换占位）
  - 统计条 + 用户列表（头像/用户名/角色徽章/邮箱/项目数/状态徽章/操作）+ UserFormModal 新增弹层，data-testid 一致（user-stats/add-user-button/user-item/user-toggle-button/user-form-submit）
  - 接真实 API：GET /users、POST /users（T8）、PATCH /users/:id/status（已有）、POST /users/:id/reset-password（T8）
  - 页面内扩展 token：roleTheme/statusTheme（仿原型 :35-43）

  **Must NOT do**:
  - 不改 tokens.ts；不新增依赖

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T15
  - **Blocked By**: T8（API）

  **References**:
  - `docs/agent-platform/prototypes/user-management/index.tsx` - 原型
  - `web/app/(main)/users/page.tsx` - 占位页
  - `web/src/components/ui/` - 复用

  **Acceptance Criteria**:
  - [ ] /users 渲染统计条+列表+弹层；data-testid 一致
  - [ ] 新增用户/禁用/重置密码调真实 API
  - [ ] tsc + build exit 0

  **QA Scenarios**:
  ```
  Scenario: /users 页全流程
    Tool: Playwright
    Preconditions: 登录态（admin）
    Steps:
      1. 导航 /users → user-stats + user-item 渲染
      2. add-user-button → 弹层填表 → submit → 列表新增
      3. user-toggle-button → 状态徽章切换
    Expected Result: CRUD 全对
    Evidence: .omo/evidence/task-10-users.png
  ```

  **Commit**: YES
  - Message: `feat(web): /users 迁移 user-management 原型 + 真实 API`

- [x] 11. 前端 /roles（role-permission 原型 + Dock 新项）

  **What to do**:
  - 将 `docs/agent-platform/prototypes/role-permission/index.tsx`（660 行）迁移到 `web/app/(main)/roles/page.tsx`（新路由）
  - 左角色列表 + 右权限矩阵表（8 资源 × 6 操作）+ PermissionScope，data-testid 一致（role-item/permission-matrix/permission-scope/add-role-button）
  - **补自定义角色 CRUD 交互**（原型 add-role-button 无 onClick）：新增/编辑/删除自定义角色；预置 admin/member 只读（403）
  - Dock 新增导航项：`nav-dock.tsx` NAV_ITEMS 加 `{ key: "roles", label: "角色权限", icon: "⚖" }`（7 项）；app-shell KEY_TO_PATH/CMDK_NAV_PATH/PAGE_TITLE 同步
  - 接真实 API：GET /roles、POST/PATCH/DELETE（T8）
  - 页面内扩展 token：permCellTheme/roleThemes（仿原型 :38-51）

  **Must NOT do**:
  - 不改 tokens.ts；不做租户级 RBAC

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T15
  - **Blocked By**: T8（API）

  **References**:
  - `docs/agent-platform/prototypes/role-permission/index.tsx` - 原型
  - `web/src/components/layout/nav-dock.tsx:35-42` - NAV_ITEMS 6 项待加第 7 项
  - `web/src/components/layout/app-shell.tsx` - KEY_TO_PATH/CMDK_NAV_PATH/PAGE_TITLE

  **Acceptance Criteria**:
  - [ ] /roles 渲染矩阵表；Dock 出现「角色权限」第 7 项
  - [ ] 自定义角色 CRUD 可用；预置只读
  - [ ] tsc + build exit 0

  **QA Scenarios**:
  ```
  Scenario: /roles 页 + Dock 项
    Tool: Playwright
    Preconditions: 登录态
    Steps:
      1. 导航 /roles → permission-matrix 渲染（8×6 格）
      2. Dock 出现「角色权限」项（7 项）
      3. add-role-button → 创建自定义角色 → 矩阵可编辑；PATCH admin → 403
    Expected Result: 页面 + Dock + CRUD 全对
    Evidence: .omo/evidence/task-11-roles.png
  ```

  **Commit**: YES
  - Message: `feat(web): /roles 迁移 role-permission 原型 + Dock 新项`

- [x] 12. 前端 /artifacts?pid= 产出物管理聚合页（三筛 + 列表 + 版本查看器 + 验收徽章）

  **What to do**:
  - 新建 `web/app/(main)/artifacts/page.tsx`（路由 /artifacts?pid=，与 /board?pid= 同模式）：
    - 项目上下文：URL ?pid= 读取（缺省无 → 引导到项目页）
    - 头部：项目名 + 「产出物管理」
    - **三筛**：任务下拉（该项目任务列表）、类型筛（全部/结论文本/文档/文件）、验收状态筛（全部/已验收/未验收），默认全部
    - **列表**：类型徽章 + 标题 + 所属任务 + 版本 + 作者（AgentAvatar + 角色）+ **验收状态徽章**（新增：已验收绿/未验收灰）+ 时间
    - **版本查看器**：点击行展开（复用原型 ArtifactViewer 结构：类型徽章 + 标题 + 版本切换 `‹ v2 v1 ›` + 版本时间线），接 GET /artifacts/:id + versions/:version
  - 数据源：GET /tasks/:id/artifacts（T6）、GET /projects/:pid/tasks（看板模式复用）、GET /artifacts/:id
  - 页面内扩展 token：artifactTypeTheme（结论文本紫/文档蓝/文件绿，仿原型 task-detail :41-45）+ 验收状态色
  - 空态：EmptyState 组件（无任务/无产出物）

  **Must NOT do**:
  - 不迁移原型 task-detail 的 TabBar/群聊结构（仅复用 ArtifactViewer 部分结构）
  - 不做富文本编辑/下载

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 新页面 + 复杂筛选交互 + 版本查看器
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T13-T14)
  - **Blocks**: T15
  - **Blocked By**: T6（文档库 API）、T14（联调验证）

  **References**:
  - `docs/agent-platform/prototypes/task-detail/index.tsx:41-45,300-476` - ArtifactTypeBadge/ArtifactItem/ArtifactViewer 结构（复用参考）
  - `web/app/(main)/board/page.tsx:380-395` - ?pid= URL 读取模式
  - `web/src/components/ui/empty-state.tsx` - 空态
  - `web/src/components/ui/agent-avatar.tsx` - 作者展示

  **Acceptance Criteria**:
  - [ ] /artifacts?pid= 渲染：项目名 + 三筛 + 列表（含验收徽章）
  - [ ] 三筛联动正确（任务/类型/状态组合过滤，默认全部）
  - [ ] 点击行展开版本查看器（版本切换）
  - [ ] 空态正确
  - [ ] tsc + build exit 0

  **QA Scenarios**:
  ```
  Scenario: 聚合页三筛 + 版本查看器
    Tool: Playwright
    Preconditions: 项目 p_seed_1 有 ≥2 任务含产出物（T6 造数据）
    Steps:
      1. 导航 /artifacts?pid=p_seed_1 → 断言项目名 + artifact-item 数量
      2. 任务筛选特定任务 → 列表过滤
      3. 验收状态筛「已验收」→ 仅已验收项
      4. 点击行 → artifact-viewer 展开，版本切换 ‹ v1 ›
    Expected Result: 三筛 + 查看器全对
    Evidence: .omo/evidence/task-12-artifacts.png

  Scenario: 空态
    Tool: Playwright
    Steps: 导航 /artifacts?pid=<无产出物项目> → EmptyState 展示
    Expected Result: 空态文案
    Evidence: .omo/evidence/task-12-empty.png
  ```

  **Commit**: YES
  - Message: `feat(web): /artifacts 产出物管理聚合页（三筛+版本查看器+验收徽章）`

- [x] 13. 入口改造：看板「产出物」按钮 + 项目卡片次级入口 + 群聊页 artifact-link 跳转

  **What to do**:
  - `web/app/(main)/board/page.tsx`：标题区加「产出物」按钮 → `/artifacts?pid=${pid}`
  - `web/app/(main)/projects/page.tsx`：项目卡片加次级入口（产出物按钮）→ `/artifacts?pid=${p.id}`
  - `web/app/(main)/tasks/[id]/page.tsx`：task-info-panel 的 artifact-link 占位（:658-707）改为真实按钮 → `/artifacts?pid=${pid}`（pid 从 task 数据取 projectId）

  **Must NOT do**:
  - 不改卡片主跳转（/board?pid=）
  - 不改导航高亮逻辑（artifacts 归 project）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: T15
  - **Blocked By**: None（跳转目标 T12 建）

  **References**:
  - `web/app/(main)/board/page.tsx:474-485` - 标题区
  - `web/app/(main)/projects/page.tsx:555` - 卡片 onOpen
  - `web/app/(main)/tasks/[id]/page.tsx:658-707` - artifact-link 占位

  **Acceptance Criteria**:
  - [ ] 看板/项目卡/群聊页三处入口点击 → /artifacts?pid= 正确
  - [ ] tsc + build exit 0

  **QA Scenarios**:
  ```
  Scenario: 三入口跳转
    Tool: Playwright
    Preconditions: 登录态
    Steps:
      1. /board?pid=p_seed_2 点「产出物」→ URL /artifacts?pid=p_seed_2
      2. /projects 卡片点「产出物」→ 同
      3. /tasks/:id 右侧 artifact-link → 同（pid=该项目）
    Expected Result: 三入口 URL 正确
    Evidence: .omo/evidence/task-13-entry.png
  ```

  **Commit**: YES
  - Message: `feat(web): 产出物入口（看板/项目卡/群聊）`

- [x] 14. 后端可用性验证：文档库端点 + 三筛参数 + 版本查看器联调

  **What to do**:
  - 验证/补全 GET /tasks/:id/artifacts 支持筛选参数：`?taskId=`（若路由已是任务级则确认任务筛由前端按项目任务列表做）、`?type=`、`?accepted=`（验收状态）
  - 确认 GET /artifacts/:id 与 /versions/:version 响应结构供前端查看器使用
  - 若 T6 端点缺筛选参数，补齐 DTO（QueryArtifactsDto）
  - 造种子数据：为 p_seed_1 两任务各注入 1-2 条 artifact（含不同 type/验收状态），供 T12 前端联调

  **Must NOT do**:
  - 不改归档核心逻辑（T6 已定）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: T12
  - **Blocked By**: T6

  **References**:
  - `server/src/artifacts/`（T6 后）
  - `server/src/projects/projects.service.ts` - 分页/筛选模式

  **Acceptance Criteria**:
  - [ ] GET /tasks/:id/artifacts?type=&accepted= 筛选正确
  - [ ] GET /artifacts/:id、/versions/:version 响应完整
  - [ ] 种子数据就位（p_seed_1 两任务各有产出物）

  **QA Scenarios**:
  ```
  Scenario: 筛选 + 版本联调
    Tool: Bash (curl)
    Preconditions: 种子数据就位
    Steps:
      1. GET /tasks/:id/artifacts?type=doc → 仅 doc
      2. GET /tasks/:id/artifacts?accepted=true → 仅已验收
      3. GET /artifacts/:id/versions/1 → v1 完整字段
    Expected Result: 筛选/版本全对
    Evidence: .omo/evidence/task-14-filter.txt
  ```

  **Commit**: YES
  - Message: `feat(artifacts): 文档库筛选参数 + 联调种子数据`

- [x] 15. M3 端到端联调（Agent 配置 → 任务 → mock 产出 → 归档 → 聚合页 → 验收）

  **What to do**:
  - 端到端走查完整链路：克隆模板配置 Agent → 创建任务选 Agent（mainAgentId 校验）→ 启动（sessions active）→ mock 会话产出 → ArtifactsMockConsumer 广播 artifact.submitted → 归档落库 → /artifacts?pid= 聚合页实时刷新（SSE）→ mark-pending-review → accept → 验收徽章更新 + accepted_flag
  - 修复联调发现的问题（跨 T5-T14 的集成 bug）
  - 验证 SSE 实时性：归档后聚合页 artifact 列表刷新（artifact.submitted → 前端订阅）

  **Must NOT do**:
  - 不接真实 LLM；不做 Phase 4 worker

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 端到端联调 + 跨模块问题定位
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (sequential)
  - **Blocks**: T16
  - **Blocked By**: T5-T14

  **References**:
  - 全部 T1-T14 产出
  - `web/hooks/use-realtime.ts` - 前端 SSE 事件桥（需确认 artifact.submitted 是否要加入分发——若需要则补 EVENT 常量 + 页面回调）
  - 18 篇 §7.5 M3 验收闭环定义

  **Acceptance Criteria**:
  - [ ] 端到端闭环跑通（Playwright 截图 + SSE 日志证据）
  - [ ] 聚合页 SSE 实时刷新 artifact
  - [ ] 验收徽章状态正确流转

  **QA Scenarios**:
  ```
  Scenario: M3 全链路
    Tool: Playwright + curl
    Preconditions: 双端运行
    Steps:
      1. /agents 克隆配置 Agent
      2. 创建任务选 Agent → 启动
      3. mock 产出 → SSE 收到 artifact.submitted → 聚合页出现
      4. mark-pending-review → accept → 徽章「已验收」+ DB accepted_flag
    Expected Result: 全链路闭环
    Evidence: .omo/evidence/task-15-m3-flow.md + 截图
  ```

  **Commit**: YES
  - Message: `fix: M3 端到端联调集成修复`

- [x] 16. 全量验证（server jest+build + web tsc+build + Playwright 回归）

  **What to do**:
  - server：`npx jest --no-cache --runInBand --silent` 全绿（现有 201 + 新增 agents/artifacts/users spec）+ `npm run build` exit 0
  - web：`npx tsc --noEmit` + `npm run build` exit 0
  - Playwright 回归：登录/项目/看板/群聊/私聊/登出 + 新四页（/agents /users /roles /artifacts）冒烟
  - 验证 Phase 0-2 无回归（创建任务/team/Realtime）

  **Must NOT do**:
  - 不改代码（纯验证；发现 bug 记 evidence 交 T15 或后续修）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4
  - **Blocks**: T17
  - **Blocked By**: T15

  **References**:
  - 无（全量命令）

  **Acceptance Criteria**:
  - [ ] server jest 全绿 + build exit 0
  - [ ] web tsc + build exit 0
  - [ ] Playwright 回归全过

  **QA Scenarios**:
  ```
  Scenario: 全量门禁
    Tool: Bash
    Steps:
      1. cd server && npx jest --no-cache --runInBand --silent
      2. cd server && npm run build
      3. cd web && npx tsc --noEmit && npm run build
    Expected Result: 全部 exit 0 / 全绿
    Evidence: .omo/evidence/task-16-gate.txt
  ```

  **Commit**: NO（验证任务，无代码改动）

- [x] 17. learnings/文档收口 + M3 证据汇总

  **What to do**:
  - `.omo/notepads/phase2-task-chat/learnings.md` 追加 Phase 3 结论（或新建 phase3 notepad）
  - `.omo/evidence/phase3-m3-summary.md`：M3 里程碑验收证据汇总（功能清单 + 测试结果 + 截图索引 + 端到端场景）

  **Must NOT do**:
  - 不改代码

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4
  - **Blocks**: F1-F4
  - **Blocked By**: T16

  **References**:
  - `.omo/evidence/phase2-m2-summary.md` - M2 汇总格式参考

  **Acceptance Criteria**:
  - [ ] learnings 追加 + M3 汇总文件存在

  **QA Scenarios**:
  ```
  Scenario: 证据完整
    Tool: Bash
    Steps: 检查 .omo/evidence/phase3-m3-summary.md + learnings 追加
    Expected Result: 文件存在内容完整
    Evidence: .omo/evidence/task-17-summary.txt
  ```

  **Commit**: YES
  - Message: `docs: Phase 3 M3 验收证据汇总`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns (DDL changes, three import, dynamic model market) — reject with file:line if found. Check evidence files exist in .omo/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + linter + `bun test` (server jest). Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (Agent 配置 → 任务 → mock 产出 → 归档 → 聚合页 → 验收). Test edge cases: empty project, invalid artifact declaration, template PATCH 403, 409 accepted immutable. Save to `.omo/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- 按任务粒度 commit：`feat(agents): ...` / `feat(artifacts): ...` / `feat(web): ...`，每任务一个 commit（同需求小改 amend）

---

## Success Criteria

### Verification Commands
```bash
# 后端
cd server && npx jest --no-cache --runInBand --silent   # 全部通过（现有 201 + 新增）
cd server && npm run build                              # exit 0
# 前端
cd web && npx tsc --noEmit && npm run build             # exit 0
# M3 端到端（Playwright）
# Agent 配置 → 创建任务选 Agent → mock 产出 → 归档 → /artifacts?pid= 三筛+版本查看器+验收徽章 → accept
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] All tests pass
- [x] M3 端到端闭环演示通过
