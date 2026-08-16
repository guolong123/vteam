# vteam-web-collab - Work Plan

## TL;DR (For humans)

**What you'll get:** vteam 控制台补全「团队协作」的可视化界面——① Agent 管理页可配置性格（沉稳/苛刻/激进/保守/创新）；② 任务创建可选执行模式（轻量 direct / 计划驱动 plan）；③ 任务详情页显示执行模式徽章、可切换模式、并可查看执行计划清单与**在页面上评审计划（通过/驳回附理由）**；④ 任务看板显示计划模式徽章。

**Why this approach:** 后端能力已上线（REV 44：MCP 工具/API/系统消息全就绪），本次纯前端补齐 UI 让用户"看得见、用得了"——关键缺口是**用户评审计划目前只能走 MCP**，必须补页面入口；落点全部复用既有页面结构（ConfigPanel/任务表单/TaskPanel）与样式先例，不新增依赖、不改导航。

**What it will NOT do:** 不做独立计划管理导航页（内嵌任务详情）；不预置 seed 性格；不改服务端（后端已完备）；不做 MCP 工具 UI（Agent 侧能力）。

**Effort:** Medium（6 个实现任务，纯 web 前端 + 部署）
**Risk:** Low - 前端增量改动（后端契约已验证、落点有先例）；部署仅 web 镜像
**Decisions to sanity-check:** ① 计划 UI 内嵌任务详情页（非独立导航）② 「暂无执行计划」空态走 404 分支 ③ persona 对 template agent 可编辑（与 ackMessage 一致）④ e2e 只断言无计划空态（seed 无 plan 数据），「有计划」留浏览器实测

Your next move: 审阅本计划后启动执行（`$start-work vteam-web-collab`），或先运行高精度评审。

---

> TL;DR (machine): Medium effort, Low risk — vteam 团队协作 web 前端（6 todos：persona 配置/任务创建模式/任务详情计划区块+评审/看板徽章/e2e/web 部署），后端 REV 44 就绪。

## Scope
### Must have
- **wf-agents**：`web/app/(main)/agents/page.tsx` ConfigPanel 加「性格配置」区块——persona select（PERSONA_LIBRARY 5 性格：steady/strict/aggressive/conservative/innovative）+ 选中项文案预览 + 保存（PATCH /agents/:id 带 persona）+ `UpdateAgentPayload` 补 `persona?: string | null` + CreateAgentModal 可选加；存量 persona=null 显示「未配置」
- **wf-task-create**：`web/app/(main)/tasks/new/page.tsx` 加「执行模式」选择（direct 轻量执行 / plan 计划驱动 + 说明）→ payload 加 `executionMode`
- **wf-task-detail**：`web/app/(main)/tasks/[id]/page.tsx`——`TaskDetail` 补 `executionMode`；右侧 TaskPanel 加：模式徽章（direct/plan）+ 模式切换入口（PATCH /tasks/:id/execution-mode，direct→plan 未批准 409 显示引导）+ **「执行计划」区块**（GET /plans?taskId= 计划头 + GET /plans/:id/tasks 子任务清单：六要素/assignee/状态 + 评审按钮：approved/rejected+reason 输入 → PATCH /plans/:id/review）+ 计划状态 SSE/refetch 联动
- **wf-board**：`web/app/(main)/board/page.tsx` TaskCard 加 plan 模式徽章（小）
- **wf-e2e**：web/e2e 补充断言（persona-select / execution-mode / plan-review-* testid），沿用 reference/testids.ts 模式
- **wf-deploy**：web 镜像构建（**根 context：docker build -f web/Dockerfile .**）+ helm upgrade（web tag → vteam-k8s-team-collab-web，完整基线 REV 45）+ 浏览器实测（登录 + agents persona 配置可见 + 任务详情计划区块 + 无 console 错误）

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 独立计划管理导航页（内嵌任务详情方案）；seed persona 预置
- 服务端改动（后端已完备；仅发现 bug 才修，且需单独确认）
- MCP 工具 UI（Agent 侧能力，用户透明）；新增 npm 依赖
- 不改 nav-dock 导航结构；不改既有页面逻辑（只加区块）

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + Playwright e2e + `npm run build` + `npm run lint`（web 目录；无单测基建）
- Evidence: .omo/evidence/task-<N>-vteam-web-collab.<ext>（outside ulw-loop use .omo/evidence/）

## Execution strategy
### Parallel execution waves
- **Wave 1**（2 todos，并行）：Todo 1（wf-agents）、Todo 2（wf-task-create）
- **Wave 2**（1 todo）：Todo 3（wf-task-detail，核心最大）
- **Wave 3**（2 todos，并行）：Todo 4（wf-board）、Todo 5（wf-e2e）
- **Wave 4**（1 todo）：Todo 6（wf-deploy，依赖全部）
- **Final verification wave**：F1-F4 并行

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. wf-agents | - | 3 | 2 |
| 2. wf-task-create | - | 3 | 1 |
| 3. wf-task-detail | 1, 2 | 4, 5, 6 | - |
| 4. wf-board | 3 | 6 | 5 |
| 5. wf-e2e | 1, 2, 3 | 6 | 4 |
| 6. wf-deploy | 1, 2, 3, 4, 5 | - | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. wf-agents：Agent 管理页 persona 性格配置 UI
  What to do / Must NOT do:
  - `web/app/(main)/agents/page.tsx`（2204 行，ConfigPanel 编辑面板 :796）：
    - 新增「性格配置」区块：位于提示词编辑器（:1093-1132）之后、确认文案（:1134）之前——`persona-select` 下拉（5 性格：steady 沉稳/strict 苛刻/aggressive 激进/conservative 保守/innovative 创新，key 对齐后端 PERSONA_LIBRARY persona.constants.ts）+ 选中项中文文案预览（静态，从前后端共享文案或前端常量）+ 未配置（null）显示「未配置」
    - 草稿 state 加 `personaDraft`（对齐 promptDraft/ackDraft 模式）；handleSave（:852-865）payload 加 `persona`（选择「未配置」传 null）
    - `UpdateAgentPayload`（:84-95）补 `persona?: string | null`
    - `AgentItem`（:52-73）补 `persona: string | null`
    - 创建弹窗 CreateAgentModal（:1634-1860）可选加 persona 选择（保持最小：可与编辑共用组件或省略）
  - 样式：复用平台主题 token（web/src/theme/tokens.ts）；区块样式对齐既有 ConfigPanel 区块卡；**persona select 用原生 `<select>`（对齐 agents 页 model-select 先例，Metis Minor 5——ui 目录无 Select 组件）**
  - **template agent 可编辑性（Metis Minor 6）**：persona 区块对 template 按**可编辑**处理（与 ackMessage 一致——后端 update-agent.dto.ts:40-48 无 template 限制，agents.service.ts:247 已放行）
  - Must NOT：不改其他区块逻辑；不新增 npm 依赖
  Parallelization: Wave 1 | Blocked by: - | Blocks: 3
  References (executor has NO interview context - be exhaustive): web/app/(main)/agents/page.tsx:796（ConfigPanel）、:1093-1132（提示词编辑器——persona 区块位置参照）、:84-95（UpdateAgentPayload）、:52-73（AgentItem）、:852-865（handleSave）、:1634-1860（CreateAgentModal）；server/src/agents/persona.constants.ts（PERSONA_LIBRARY 5 key + 文案）；server/src/agents/dto/update-agent.dto.ts:40-48（persona @IsIn + null 清空）；server/src/agents/agents.service.ts:247-248（PATCH 落库）、:330（toAgentDto 返回）；web/src/theme/tokens.ts
  Acceptance criteria (agent-executable): `cd web && npm run build` 通过 + `npm run lint` 通过；`npx tsc --noEmit`（web 有 TS 检查则跑）通过
  QA scenarios (name the exact tool + invocation): happy——jest 不可用（web 无单测），用 build+lint+Playwright：编辑 Agent → persona-select 选择 strict → 保存 → GET /agents 断言 persona=strict；failure——选择「未配置」保存 → persona=null。Evidence .omo/evidence/task-1-vteam-web-collab.txt
  Commit: Y | feat(web): Agent 性格配置 UI

- [x] 2. wf-task-create：任务创建页执行模式选择
  What to do / Must NOT do:
  - `web/app/(main)/tasks/new/page.tsx`（1871 行）：
    - 托管模式开关（:531-560）附近/下方加「执行模式」选择：`execution-mode-select`——direct「轻量执行（默认）」/ plan「计划驱动（需先提交执行计划并评审通过）」+ 简短说明文案
    - state 加 `executionMode`（缺省 direct）；提交 payload（:1768-1791）加 `executionMode`
  - Must NOT：不改托管模式逻辑；不改角色实例/Agent 选择逻辑
  Parallelization: Wave 1 | Blocked by: - | Blocks: 3
  References (executor has NO interview context - be exhaustive): web/app/(main)/tasks/new/page.tsx:531-560（托管模式开关样式先例）、:1768-1791（提交 payload）、:211（TaskForm）；server/src/tasks/dto/create-task.dto.ts（executionMode @IsIn(['direct','plan'])、缺省 direct）；server/src/tasks/tasks.service.ts:229（落库）
  Acceptance criteria (agent-executable): `cd web && npm run build` + `npm run lint` 通过
  QA scenarios (name the exact tool + invocation): happy——创建任务选 plan → POST 断言 executionMode=plan；failure——选 direct（默认）→ 行为不变。Evidence .omo/evidence/task-2-vteam-web-collab.txt
  Commit: Y | feat(web): 任务创建执行模式选择

- [x] 3. wf-task-detail：任务详情页——执行模式显示/切换 + 执行计划区块（核心）
  What to do / Must NOT do:
  - `web/app/(main)/tasks/[id]/page.tsx`（3001 行，TaskPanel 右侧面板 :1740）：
    - `TaskDetail` 类型（:96-118）补 `executionMode: "direct" | "plan"`（后端 toTaskDto 已返回 tasks.service.ts:1250）
    - **模式徽章**：状态徽章（:1783-1786）旁加 `execution-mode-badge`——direct 灰 / plan 蓝（对齐任务状态徽章样式）
    - **模式切换入口**：任务操作区块（:2105-2168）托管开关卡内/旁加「执行模式」切换（`execution-mode-toggle`）——PATCH /tasks/:id/execution-mode body {mode}；**direct→plan 未批准 409 时显示引导文案**（「请先提交执行计划并评审通过」）；plan→direct 直接切换
    - **「执行计划」区块**（任务操作上方 :2105 前，`plan-section`）：
      - 拉取：**单一 `GET /api/v1/plans?taskId=`（Metis Major 1：响应已含计划头 + 子任务清单全文 PlanWithTasksDto.tasks——不重复调 GET /plans/:id/tasks）** → 计划头（status/reviewerInstanceId/title/summary）+ PlanTaskDto[]（title/status/assignee 概览/content 六要素）
      - **空态/错误分支（Metis Major 2）**：catch `ApiError`——`err.status === 404`（PLAN_NOT_FOUND）→ 渲染「暂无执行计划」空态（plan 模式提示先提交计划）；其余（403/网络等）→ error + 重试按钮（`web/lib/api.ts:113-120` ApiError 有 status）
      - 展示：计划状态徽章（reviewing 琥珀/approved 绿/rejected 红/executing 蓝/completed 灰/draft 灰）、子任务清单（六要素可展开、assignee 名称、状态 pending/in_progress/done/blocked/skipped）
      - **评审入口**（关键缺口）：计划 reviewing 状态显示评审按钮——approved / rejected（**自定义评审弹窗，含 reason textarea——Metis Minor 5：ConfirmDialog 无输入能力，参照 users 页 user-form-overlay 带表单弹窗模式**）→ PATCH /api/v1/plans/:id/review {verdict, reason?}；评审后 refetch
      - 无计划时显示「暂无执行计划」（plan 模式提示先提交计划）
    - **SSE/refetch 联动（Metis Minor 7）**：SSE `CHAT_MESSAGE_NEW` handler（:2546-2606）增加 `invalidateQueries(['plans', taskId])`（或 plan 查询加 `refetchInterval: 30_000` 对齐 artifacts :2256）——评审/提交后计划区块自动刷新
  - 类型：新增 Plan 相关前端类型（PlanHeader/PlanTaskDto，对齐后端返回）
  - Must NOT：不改中间消息区/成员面板逻辑；不改群聊渲染（system 消息已自动显示）
  Parallelization: Wave 2 | Blocked by: 1, 2 | Blocks: 4, 5, 6
  References (executor has NO interview context - be exhaustive): web/app/(main)/tasks/[id]/page.tsx:96-118（TaskDetail）、:1740-2168（TaskPanel 区块结构）、:1783-1786（状态徽章）、:2105-2168（任务操作/托管开关）、:1160-1163（system 消息渲染）、:2546-2606（SSE handler——plans invalidate 落点）；server/src/plans/plans.controller.ts（GET /plans、PATCH /plans/:id/review——rejected 必填 reason、非 reviewing 400）；server/src/plans/plans.service.ts:196-226（findByTask 返回 tasks 全文）、:34-47（PlanWithTasksDto）；server/src/tasks/tasks.controller.ts:118-129（PATCH /tasks/:id/execution-mode）；web/lib/api.ts:136-145（api.get/patch）、:101-121（ApiError status——404 空态分流）；web/src/components/ui/（**无 Select；ConfirmDialog 无输入——评审弹窗参照 users 页 user-form-overlay 带表单模式，Metis Minor 5**）
  Acceptance criteria (agent-executable): `cd web && npm run build` + `npm run lint` 通过
  QA scenarios (name the exact tool + invocation): happy——Playwright：任务详情 → plan 模式任务显示计划区块（无计划任务「暂无执行计划」空态；有数据时清单+评审按钮）→ 评审 approved → 状态变绿；failure——direct→plan 未批准 → 切换返回 409 且显示引导文案；**approved 计划 + 已启动任务 → 切 plan 后计划徽章变 executing（Metis Minor 9：updateExecutionMode in_progress 分支会置 executing，tasks.service.ts:510-517）**。Evidence .omo/evidence/task-3-vteam-web-collab.txt
  Commit: Y | feat(web): 任务详情执行模式与执行计划区块

- [x] 4. wf-board：任务看板 plan 模式徽章
  What to do / Must NOT do:
  - `web/app/(main)/board/page.tsx` TaskCard（:214）：状态徽章（:269）旁加 `plan-badge`——task.executionMode=plan 时显示「计划」小徽章（蓝），direct 不显示
  - 类型：TaskCard 相关类型补 executionMode（数据源 GET /projects/:pid/tasks 返回）
  - Must NOT：不改看板布局/拖拽/筛选逻辑
  Parallelization: Wave 3 | Blocked by: 3 | Blocks: 6
  References (executor has NO interview context - be exhaustive): web/app/(main)/board/page.tsx:214（TaskCard）、:269（状态徽章）、:362（数据源）
  Acceptance criteria (agent-executable): `cd web && npm run build` + `npm run lint` 通过
  QA scenarios (name the exact tool + invocation): happy——看板 plan 模式任务卡片显示「计划」徽章；failure——direct 任务无徽章。Evidence .omo/evidence/task-4-vteam-web-collab.txt
  Commit: Y | feat(web): 看板计划模式徽章

- [x] 5. wf-e2e：e2e 断言补充
  What to do / Must NOT do:
  - `web/e2e/pages.spec.ts`（**Metis Minor 8：实际 18 个 test 断言模式**）或新增独立 spec（沿用 reference/testids.ts + auth.setup 登录）：
    - agents 页：`persona-select` **存在且可交互**（可见/可打开下拉/可选值含 5 性格）——**不做保存断言（Metis Major 3b：写操作污染 seed，非幂等；如需验证保存用 clone agent 后编辑清理）**
    - tasks 详情：**「无计划空态」断言（Metis Major 3a：seed 无 plan 数据，`GET /plans?taskId=` 必 404——断言显示「暂无执行计划」）**；「有计划」分支留 F3 浏览器实测（seed 有 plan 的环境另造）；plan 模式任务显示 `execution-mode-badge`；direct→plan 切换 409 引导（**沿用 seed 任务 `t_0000000001` 或任一卡片，Metis H1**）
    - board：plan 模式任务显示 `plan-badge`（seed 无 plan 任务时可断言 direct 任务无徽章 + badge 元素存在性）
  - 更新 `reference/testids.ts` 加入新 testid（persona-select/execution-mode-*/plan-*）
  - Must NOT：不依赖测试数据创建；不做污染性写断言（persona 保存/clone 后清理例外）
  Parallelization: Wave 3 | Blocked by: 1, 2, 3 | Blocks: 6
  References (executor has NO interview context - be exhaustive): web/e2e/pages.spec.ts（16 testid 断言模式）、web/e2e/auth.setup.ts（seed-admin 登录）、web/e2e/reference/testids.ts、web/playwright.config.ts
  Acceptance criteria (agent-executable): `cd web && npm run test:e2e`（或 playwright test 指定 spec）通过
  QA scenarios (name the exact tool + invocation): happy——playwright test 全绿；failure——新断言失败则修正。Evidence .omo/evidence/task-5-vteam-web-collab.txt
  Commit: Y | test(web): 团队协作功能 e2e 断言

- [x] 6. wf-deploy：web 镜像构建 + helm upgrade + 浏览器实测
  What to do / Must NOT do:
  - 构建 web 镜像：`cd /data/git-project/aiagents && docker build -f web/Dockerfile -t docker-hosted.ketaops.cc/xishuhq/vteam-web:vteam-k8s-team-collab-web .`（**根 context——web/Dockerfile 引用 web/package.json+worker+scripts，learnings 记过用 ./web 会失败**）+ push
  - 内容验证：镜像内 `.next/server/app/` 含 agents/tasks 页面更新
  - helm upgrade（完整基线 REV 45）：导出基线 → 只改 web.image.tag → vteam-k8s-team-collab-web（server 保持 vteam-k8s-team-collab）→ 删 init Job → upgrade（REV14 纪律）
  - 验证：rollout status + 浏览器实测（chromium + host-resolver-rules 访问 vteam.ketaops.cc:32054）——登录 → agents 页 persona 配置可见 → 任务详情计划区块/模式徽章 → console 无 error；**「有计划」分支在实测中验证（Metis Major 3a：seed 无 plan 数据，e2e 覆盖不了）**
  - **顺带修正 docs/deployment.md（Metis Minor 4：§3.2 写 `./web` context 与 Dockerfile 矛盾且会构建失败）**：web 构建命令改为 `docker build -f web/Dockerfile .`（一行文档修复）
  - Must NOT：不改 server/worker tag；不裸 --set；不动生产数据
  Parallelization: Wave 4 | Blocked by: 1, 2, 3, 4, 5 | Blocks: -
  References (executor has NO interview context - be exhaustive): **.omo/notepads/memory-management/learnings.md（部署先例 REV 43-44：基线文件、根 context、host-resolver 浏览器验证）**；.omo/notepads/vteam-team-collaboration/learnings.md（REV 44 部署 + 浏览器实测方法）；web/Dockerfile（**根 context：COPY web/package.json+worker+scripts/pack-worker.sh——用 ./web context 必失败**；docs/deployment.md §3.2 为过时 `./web` 写法，勿引用——本 todo 顺带修正）
  Acceptance criteria (agent-executable): helm REV 45 deployed + 浏览器实测（登录/agents persona/任务详情计划区块 + console 0 error）证据
  QA scenarios (name the exact tool + invocation): happy——浏览器实测 4+ 页面全过 + persona 配置可见；failure——页面 console 有 error 则修。Evidence .omo/evidence/task-6-vteam-web-collab.txt
  Commit: Y | deploy(web): 团队协作前端上线（REV 45）

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
- 每 todo 一个 commit（约定式提交：feat(web)/test(web)/deploy(web)）；执行完成可 squash 为单个（AGENTS.md 一个需求一个 commit，用 --amend）
- 前端改动无 Java，无需 googleJavaFormat；提交前 `cd web && npm run build` + `npm run lint` 通过
- 分支/推送：本计划本地 commit + 部署；PR 流程（如需）沿用既有（远端注意 xishuhq/aiagents 404，实际 origin=xishuhq/xteam）

## Success criteria
- Agent 管理页可配置/清除性格（persona select + 预览 + 保存生效）
- 任务创建可选执行模式（direct/plan）；任务详情显示模式徽章 + 可切换（409 引导）
- 任务详情「执行计划」区块可用：计划头/子任务清单/状态 + **用户评审（approved/rejected+reason）**——评审闭环在 UI 层完整
- 看板显示 plan 模式徽章；e2e 断言全绿
- web 部署 REV 45 上线，浏览器实测无回归（persona 配置可见、计划区块可用、console 0 error）
