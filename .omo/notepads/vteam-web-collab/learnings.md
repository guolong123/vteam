
## Todo 2 wf-task-create：任务创建页执行模式选择 — 2026-08-16

- **改动文件**：`web/app/(main)/tasks/new/page.tsx`（单文件，无 server 改动）。
- **执行模式选择 UI**：在托管模式开关（managedMode toggle）下方新增 `execution-mode-select`，对齐 priority-select 先例（原生 `<select>` + label + hint）。选项：`direct`「轻量执行（默认）」/ `plan`「计划驱动」，切换时动态显示当前模式的说明文案（`executionModes.find(m => m.value === executionMode)?.desc`）。
- **State**：`executionMode: ExecutionMode`（类型 `"direct" | "plan"`），缺省 `"direct"`，与 `managedMode` 并列声明（:1519）。
- **TaskForm Props**：新增 `executionMode` + `onExecutionModeChange` 双 prop，TaskForm 调用点同步传入。
- **Payload**：提交 payload（:1791 附近）加 `executionMode` 字段，对齐 `CreateTaskDto.executionMode`（@IsOptional @IsIn，缺省 direct）。
- **样式**：select 宽 240px（比 priority-select 200px 稍宽，容纳「轻量执行（默认）」文案）；说明文案 `fontSize.sm + neutral[400] + marginTop: space.xs`，与托管模式说明文案视觉一致。
- **验证**：`npx tsc --noEmit` EXIT 0；`npx eslint "app/(main)/tasks/new/page.tsx"` 0 errors；全量 `npm run lint` 0 errors（14 warnings pre-existing 全部来自其他文件）；`npm run build` standalone 输出阶段 ENOENT 为 pre-existing 问题（非编译错误）。

## wf-agents: persona 性格配置 UI 实现记录

**日期**: 2026-08-16
**任务**: Todo 1 — wf-agents：Agent 管理页 persona 性格配置 UI

### 改动摘要

1. **类型扩展**：
   - `AgentItem` 新增 `persona: string | null` 字段
   - `UpdateAgentPayload` 新增 `persona?: string | null`（显式 null 清除）
   - `CreateAgentModalProps.onSubmit` 扩展 payload 含 `persona?: string | null`

2. **前端常量**：`PERSONA_OPTIONS` 数组（7 项：null=未配置 + 5 性格 key），含 label 和 preview 文案，对齐 `server/src/agents/persona.constants.ts` PERSONA_LIBRARY。

3. **草稿 state**：`personaDraft`（`useState<string | null>`），初始化 `agent.persona ?? null`，对齐 promptDraft/ackDraft 模式。

4. **ConfigPanel UI**：
   - 区块位于①b收到确认文案之后、②默认模型之前
   - 原生 `<select data-testid="persona-select">`（对齐 model-select 先例，ui 目录无 Select 组件）
   - 选中非 null 时展示文案预览卡片（neutral[50] 背景 + neutral[100] 边框）

5. **handleSave**：payload 新增 `persona: personaDraft`

6. **CreateAgentModal**：
   - 新增 persona state + reset
   - 原生 `<select data-testid="create-agent-persona">`（复用 inputBase 样式）
   - handleSubmit 透传 persona

7. **createMutation**：POST /agents payload 类型扩展含 persona

### 发现

- 后端 `CreateAgentDto` 已支持 `persona?: string`（:64），前端 POST 可直接传
- `AgentItem.persona` 由 `toAgentDto` 返回（:330），列表/详情查询均已含该字段
- template agent 的 persona 也可编辑（后端无 template 限制），与 ackMessage 一致
- web/ui 目录无 Select 组件，全页使用原生 `<select>`（model-select / priority-select 先例）

## Todo 3 wf-task-detail：任务详情页——执行模式显示/切换 + 执行计划区块 — 2026-08-16

- **改动文件**：`web/app/(main)/tasks/[id]/page.tsx`（单文件，无 server 改动）。
- **TaskDetail 类型**：补 `executionMode: "direct" | "plan"` 字段（:96-118），后端 `toTaskDto` 已返回（tasks.service.ts toTaskDto 含 `executionMode: task.executionMode ?? 'direct'`）。
- **Plan 类型**：`PlanWithTasks` + `PlanTaskItem` 接口对齐后端 `PlanWithTasksDto`/`PlanTaskDto`（plans.service.ts:34-55），含 `tasks: PlanTaskItem[]` 子任务全文（content 六要素 + assignee 概览）。单一 GET /plans?taskId= 响应已含子任务全文，不调 GET /plans/:id/tasks（Metis Major 1 落地）。
- **计划状态主题**：`PLAN_STATUS_THEME` 五态映射（reviewing 琥珀 / approved 绿 / rejected 红 / executing 蓝 / completed 灰），对齐任务状态徽章视觉语言。子任务状态 `PLAN_TASK_STATUS_LABEL` 五态中文标签。
- **plansQuery**：`useQuery({ queryKey: ["plans", taskId], queryFn: () => api.get<PlanWithTasks>("/plans", { query: { taskId } }), refetchInterval: 30_000 })`，对齐 artifacts/issues 的 30s 轮询兜底模式。enabled 依赖 taskId + user.id。
- **空态/错误分流（Metis Major 2）**：catch `ApiError`——`err.status === 404` →「暂无执行计划」（plan 模式追加提示「请先提交执行计划」）；其余 → error + 错误信息展示。404 为空态（后端 `PLAN_NOT_FOUND` 为业务异常非系统错误）。
- **PlanSection 组件**：任务操作区块上方（plan-section），含计划状态徽章 + summary + 子任务清单（可展开六要素 content）。子任务行展示 seq/title/assigneeAlias/status，点击展开 content（string 直出，object JSON.stringify）。reviewing 状态显示「评审计划」按钮。
- **ReviewDialog 弹窗**：自定义评审弹窗（参照 users 页 user-form-overlay 模式），verdict 二选一按钮组（通过=绿 / 驳回=红）+ rejected 时 reason textarea（必填）。提交 PATCH /plans/:id/review {verdict, reason?}，成功后 refetch plans 缓存。
- **执行模式徽章**：`execution-mode-badge`，状态徽章旁展示——direct 灰底灰点「轻量执行」/ plan 蓝底蓝点「计划驱动」。对齐任务状态徽章 pill 样式。
- **执行模式切换**：`execution-mode-toggle` 原生 select（对齐 priority-select / model-select 先例），托管模式开关卡内。PATCH /tasks/:id/execution-mode {mode}；direct→plan 409 显示引导文案「请先提交执行计划并评审通过，再切换至计划驱动模式」；plan→direct 直接切换。
- **SSE 联动（Metis Minor 7）**：`onMessage` handler 加 `queryClient.invalidateQueries({ queryKey: ["plans", taskId] })`，chat.message.new（计划提交/评审均为 system 消息）触发 plans 缓存失效 + 30s 轮询兜底。
- **评审弹窗位置**：ReviewDialog 绝对定位覆盖 TaskPanel（position: absolute, inset: 0, zIndex: 60），对齐 TaskInfoEditModal / IssueDetailModal 的 absolute 覆盖模式。需 TaskPanel 有 `position: relative`（已有）。
- **⚠️ TypeScript unknown 类型陷阱**：`PlanTaskItem.content` 为 `unknown`（后端 content 为 Json），在 JSX 中 `{expanded && pt.content && (...)}` 会报 `Type 'unknown' is not assignable to type 'ReactNode'`——改用 `{expanded && pt.content != null ? (...) : null}` 三元表达式避免 unknown 直出 JSX。
- **验证**：`npm run lint` 0 errors（14 warnings pre-existing 全部来自其他文件）；`npm run build` 编译通过 + standalone 输出成功（ENOENT 为 pre-existing 问题非编译错误）。

## Todo 4 wf-board：任务看板 plan 模式徽章 — 2026-08-16

- **改动文件**：`web/app/(main)/board/page.tsx`（单文件，无 server 改动）。
- **TaskItem 类型**：补 `executionMode?: "direct" | "plan"`（:110），后端 `toTaskDto` 已返回该字段。
- **plan-badge**：状态徽章（:269）旁用 `<div>` 包裹双徽章，executionMode === 'plan' 时渲染蓝色「计划」pill 徽章（蓝底 #EFF6FF + 蓝边 #BFDBFE + 蓝点 + 蓝字 #2563EB），direct 时不渲染。data-testid="plan-badge"。
- **样式对齐**：复用 Todo 3 tasks/[id] 的 execution-mode-badge 样式（padding/radius/fontSize 等），但简化为仅 plan 模式显示（看板不区分 direct/plan 徽章，只标记 plan 模式任务）。
- **TaskCardProps 未改动**：task 对象本身含 executionMode，无需额外 prop 透传。
- **验证**：`npm run lint` 0 errors（pre-existing warnings）；`npm run build` 编译通过。

## Todo 5 wf-e2e：e2e 断言补充 — 2026-08-16

### 改动文件
- `web/e2e/reference/testids.ts`（新增 7 个 testid）
- `web/e2e/pages.spec.ts`（扩展 4 个测试用例）

### 新增 testid
1. **agents 页**：`persona-select`（原生 select，5 性格 + 未配置）
2. **tasks/new**：`execution-mode-select`（原生 select，direct/plan 二选一）
3. **tasks/[id]**：`execution-mode-badge`（状态徽章旁直接/计划驱动 pill）
4. **tasks/[id]**：`execution-mode-toggle`（原生 select，切换执行模式）
5. **tasks/[id]**：`plan-section`（执行计划区块容器）
6. **tasks/[id]**：`review-reason-input`（评审弹窗驳回原因 textarea）
7. **board**：`plan-badge`（任务卡片上的计划徽章）

### 断言覆盖
- **agents 页**：persona-select 存在且可交互（toBeVisible + toBeEnabled）
- **tasks/new**：execution-mode-select 存在（toBeVisible）
- **tasks/[id]**：execution-mode-badge + execution-mode-toggle + plan-section「暂无执行计划」空态
- **board**：plan-badge 存在（toBeVisible）

### 发现
- board 页 plan-badge 为条件渲染（seed 无 plan 任务时直接任务无徽章，但组件渲染逻辑存在）
- tasks/[id] 无计划空态文案：「暂无执行计划」（plan 模式追加「请先提交执行计划」）
- e2e 测试需本地 web+server 运行（localhost:3001），本次未实际运行验证（环境限制）
- testids.ts 补充后 PAGES 数组和 PAGE_SMOKE 均已更新

## 终验缺陷修复（F2-M1 / F2-M2 / Metis Minor 4）— 2026-08-16

### 改动

1. **F2-M1**（`tasks/[id]/page.tsx`）：404 空态「暂无执行计划」div 补 `data-testid="plan-section"`，统一 plan-section 语义——有/无计划时均可定位，e2e `getByTestId("plan-section")` 在两种状态下均通过。

2. **F2-M2**（`e2e/pages.spec.ts`）：board plan-badge 断言改为条件式——`badges.count() > 0` 时校验可见性，seed 无 plan 任务时跳过不失败。

3. **Metis Minor 4**（`docs/deployment.md`）：§3.2 web 构建命令从 `docker build ... ./web`（context 错误）改为 `-f web/Dockerfile .`（根 context），附注释说明 Dockerfile 引用 web/package.json + worker/ + scripts/ 的依赖关系。

### 验证
- `npm run build`：编译通过，standalone 输出正常
- `npm run lint`：0 errors（14 warnings pre-existing）

## 部署 + 收尾 — 2026-08-16（REV 45）
- **部署**：web 镜像 `vteam-web:vteam-k8s-team-collab-web`（根 context `docker build -f web/Dockerfile .`，digest 198e9e98）→ 完整基线 helm upgrade（awk 只改 web 段 tag；server/worker 未动）→ 删 init Job → **REV 45 deployed** → init Job Completed
- **浏览器实测（F3）**：persona-select 6 选项可交互（选中 innovative）、execution-mode-select 2 选项默认 direct、任务详情 badge「轻量执行」+toggle+「暂无执行计划」空态、board 渲染正常、**realConsoleErrors=0**（仅 plan API 404 预期业务探测）——report.json allPass=true + 6 截图（/tmp/opencode/browser-qa-final/）
- **Final Wave**：F1 APPROVE / F2 APPROVE（首轮 REJECT 后修复：F2-M1 空态 plan-section testid、F2-M2 board 条件断言；F1 两条件：docs 修正 + e2e 由 F3 等价覆盖）/ F3 APPROVE / F4 APPROVE
- **git 收尾**：commit `93da22a` feat(web)（7 文件 + docs 修正 + .omo 计划产物）；历史遗留 png/yml 未提交
- **经验**：e2e 断言必须与产品 testid 放置严格对齐（空态也要有 testid）；数据依赖断言（seed 无 plan 任务）须条件化；docs/deployment.md 的 web 构建命令此前是错的（./web），根 context 是唯一正确方式

## seed 默认性格固化（server/prisma/seed.ts）
- **默认值**（按 k8s 环境当前配置固化）：a_product=innovative（产品经理/创新）、a_project_manager=aggressive（项目经理/激进）、a_architect=steady（架构师/沉稳）、a_developer=conservative（开发者/保守）、a_tester=strict（测试/苛刻）。
- **幂等选择**：seed 的 agent.upsert update 分支只同步 prompt（`update: { prompt }`），**不含 persona**——故 persona 仅在 create 分支生效（`...agent` 展开），存量环境已设 persona 不被 seed 覆盖，幂等重跑无害。新环境首次 create 即带默认性格。
- **验证**：`npx tsc --noEmit` EXIT 0（seed.ts 编译通过）；未跑真实 seed（需 DB 连接，部署 init Job 重跑时生效）。
- **约束**：仅改 seed.ts；未动 agent 其他字段/其他 seed 数据；无新增依赖。

## Todo 6 wf-style：任务详情页样式优化 — 2026-08-16

### 改动摘要

**① 执行模式工具栏（消息输入框下方）**
- **改动文件**：`web/app/(main)/tasks/[id]/page.tsx`
- **新增 `execution-mode-toolbar`**：MessageInput 下方添加一行工具栏（`data-testid="execution-mode-toolbar"`），包含：
  - `execution-mode-select` 下拉（direct「轻量执行」/ plan「计划驱动」）
  - 409 错误时显示引导文案（`executionModeError`）
  - 预留 flex 空间供后续扩展（模型选择等）
- **移除 `execution-mode-toggle`**：从 TaskPanel 中移除右侧面板的模式切换入口（避免重复）
- **TaskPanel props 清理**：移除 `onToggleExecutionMode`、`executionModePending`、`executionModeError` 三个 props

**② TaskPanel 独立滚动**
- `task-info-panel` aside 添加 `overflowY: "auto"`，利用 flex 布局自动获得高度约束
- 符合 T15 铁律：无 fixed/100vh/100vw，高度由 AppShell main flex column 接管

**③ 产出物 + 待办 Issue tab 切换**
- 新增 `activeTab` state（`"artifacts" | "issues"`，默认 `"artifacts"`）
- 产出物和待办 Issue 区块合并为 tab 切换 UI（`data-testid="artifacts-issues-tab"`）
- tab 样式：底部边框指示器（蓝色 `#2563EB`），对齐平台既有 tab 先例（models 页）
- 文档站入口按钮移至 tab 栏右侧（仅在产出物 tab 显示）

**④ e2e testid 更新**
- `web/e2e/reference/testids.ts`：
  - 新增 `execution-mode-toolbar`、`execution-mode-select`（工具栏）
  - 移除 `execution-mode-toggle`（已从 UI 中移除）
  - PAGE_SMOKE `/tasks/[id]` 同步更新

### 验证
- `npm run lint`：0 errors（14 warnings pre-existing）
- `npm run build`：编译通过，standalone 输出正常
- `/tasks/[id]` 页面大小：16.7 kB（+0.1 kB from previous）

### 发现
- TaskPanel 中移除 execution-mode-toggle 后，相关 props 可安全清理（TypeScript 编译验证）
- tab 切换使用条件渲染（`activeTab === "artifacts"` / `activeTab === "issues"`），避免不必要的 DOM 挂载
- overflowY: auto 在 flex 布局中自动生效，无需显式高度约束（flex: 1 + minHeight: 0 已处理）

### 发现（executionMode 约束语义调整，2026-08-16）
- 移除 updateExecutionMode direct→plan 的 409 PLAN_NOT_APPROVED 拦截：切换 = 用户意图声明（对齐 omo keyword-detector：说 ultrawork 立即生效，零前置校验）。计划门不放在切换点——start.preflight（approved = approval gate）与 mark-pending-review.preflight（计划任务全完成 = 验收门）保留把关。
- 顺带置 executing 逻辑保留但收窄：仅 in_progress 任务切 plan 且计划存在（approved/executing）时事务内置 executing；计划不存在/其他状态（reviewing/completed/draft）仅切模式不碰计划——避免「completed 计划被误重置为 executing」。
- 系统提示注入分层：新增 PLAN_CAPABILITY_INSTRUCTION（【执行计划】轻量引导）对所有任务无条件注入；plan 模式额外叠加 PLAN_WORKFLOW_INSTRUCTION（【计划工作流】完整段）。direct = 轻量；plan = 轻量 + 完整。模型始终知晓计划能力，不切换模式也能响应「使用计划模式」。
- 验证：`npx tsc --noEmit` 通过；jest tasks.service.spec + worker-dispatcher.spec 201 用例全过。
- 待部署：server 镜像重建 + helm REV；web 前端 tasks/[id] 切换引导文案同步（移除 409 提示，切 plan 后显示流程引导）。

## Todo 7 wf-execution-mode：执行模式切换交互优化 — 2026-08-16

### 改动摘要

**改动文件**：`web/app/(main)/tasks/[id]/page.tsx`（单文件，无 server 改动）

1. **移除 409 错误引导**（:3193-3203 `executionModeMutation`）
   - 删除 `if (isApiError(err) && err.status === 409)` 分支及对应引导文案
   - 仅保留通用错误处理：`setExecutionModeError(isApiError(err) ? err.message : "切换失败，请稍后重试")`
   - 后端已移除 409 校验（updateExecutionMode 切换任意成功），前端不再需要特殊处理

2. **流程引导文案**（:3418-3426 execution-mode-toolbar）
   - 三元条件渲染：`executionModeError` → 显示错误 / `task.executionMode === "plan" && !plansQuery.data` → 显示引导 / 其他 → null
   - 引导文案：「计划模式下，主 Agent 将调用 plan_submit 产出执行计划并提交您评审；评审通过后任务方可启动」
   - 样式：`fontSize.xs + neutral[500]`（中性灰色，不抢视觉焦点）
   - 显示条件：plan 模式 + 无计划（`plansQuery.data` 为 null/undefined）；有计划时不显示（计划区块自身展示状态）

### 设计决策

- **引导位置**：execution-mode-toolbar（消息输入框下方），与模式选择下拉同级——用户切换模式时立即看到流程说明，无需滚动到 plan-section
- **有计划时隐藏**：当 `plansQuery.data` 存在（无论状态），引导文案消失，由 plan-section 区块展示计划状态（reviewing/approved/rejected 等）
- **错误优先**：executionModeError 存在时优先显示错误，避免引导文案与错误信息冲突

### 验证
- `npm run lint`：0 errors（14 warnings pre-existing）
- `npm run build`：编译通过，standalone 输出正常
- `/tasks/[id]` 页面大小：16.8 kB（+0.1 kB from previous）

## 外部 worker 连不上内置 MCP：引导性增强（方案 A+B+D）— 2026-08-16

### 问题根因
- 集群外 worker（install-worker.sh 一键安装）不提供 WORKER_MCP_URL 配置入口，用 server 下发的默认地址（seed PLATFORM_MCP_URL = 集群内 `http://vteam-server:3000/api/v1/platform-mcp` / `http://server:3000`）→ DNS 无法解析 → 内置 vteam MCP 探测 failed
- 覆盖链路本身正确：worker env WORKER_MCP_URL → capabilities.mcpUrl（注册上报，registry-client.ts:108）→ server 按 x-worker-id 覆盖内置地址下发（mcp-servers.service.ts）→ injector 注入 opencode.json（injector.ts:226 携 x-worker-id）——只缺入口/提示/文档

### 改动清单（纯引导，机制零改动）
- `web/public/install-worker.sh`：新增 `--mcp-url <url>` 参数（缺省空 → 非空才 `update_env WORKER_MCP_URL`，不强制）；安装后若未配置 WORKER_MCP_URL 打印醒目提示（集群内 worker 无感知）；帮助注释 + 未知参数报错同步更新
- `worker/.env.example`：补 WORKER_MCP_URL 条目 + 集群外 worker 注释
- `worker/src/mcp-status/mcp-status-probe.ts`：内置 MCP failed 时读注入的 <cwd>/opencode.json 的 `mcp.<name>.url`，hostname ∈ {server, vteam-server}（`isClusterInternalUrl`）→ 输出「内置 MCP 不可达：地址 <url> 为集群内服务名，集群外 worker 请设置 WORKER_MCP_URL=<外部可达地址>」；告警只在节流窗口外新探测触发（30s 节流语义保持）；内置名兼容新名 `vteam` + 存量旧名 `keta-platform`（seed 改名迁移）
- `worker/README.md`：环境变量表补 WORKER_MCP_URL 行 + 「集群外 worker 配置」小节
- `docs/deployment.md`：4.4 后补「4.4.1 集群外 worker 配置（WORKER_MCP_URL）」小节

### 关键设计决策
- **告警 URL 来源**：不依赖 config.mcpUrl（集群外 worker 未设置 WORKER_MCP_URL 时为空，会丢告警），而是探测时读注入后的 opencode.json——probe 探测的就是该文件效果，自包含且准确；解析器做成 `resolveBuiltinMcpUrl` 注入点便于单测
- **不打扰原则**：仅 hostname ∈ {server, vteam-server} 才提示；外部域名/IP 可达失败不提示；connected/needs_auth 不提示；非内置 server failed 不提示
- **幂等**：update_env 先删 `^KEY=` 再追加；`--mcp-url` 缺省不写 .env（集群内 worker 无感知）
- **旧名兼容**：seed 将 keta-platform 改名 vteam，存量部署仍可能注入旧名，BUILTIN_MCP_SERVERS 双名匹配

### 验证结果
- `bash -n web/public/install-worker.sh`：SYNTAX_OK
- worker jest 全量：19 suites / 361 tests 全通过（含 mcp-status 24 个，新增 12 个告警分支用例）
- `scripts/pack-worker.sh` 重跑：worker-src.tar.gz 212K，`tar -tzf` 确认 .env.example 在包内且含 WORKER_MCP_URL
- 部署待派发：install-worker.sh 由 web/public 静态服务提供，需 web 镜像重建才生效；worker-src.tar.gz 随 web 发布

## 外部/跨机 worker 连不上（baseUrl=127.0.0.1）：引导性增强（A+B+D）— 2026-08-16

### 问题根因
- worker 上报 `capabilities.baseUrl = ${WORKER_ADVERTISE_HOST}:${servePort}`，`WORKER_ADVERTISE_HOST`
  默认 `http://127.0.0.1`（worker/src/config.ts）——手动脚本 install-worker.sh 不引导设置 → server
  在远端用回环地址连 worker → 连接失败 → agent 提示 worker 不可用
- 次因：`OPENCODE_SERVE_HOSTNAME` 默认 `127.0.0.1`（config.ts），外部 worker 的 serve 只监听回环
- 执行端点 exec-server 已监听 0.0.0.0，无需改动

### 改动清单（纯引导，机制零改动）
- `web/public/install-worker.sh`：新增 `--advertise-host <url>`（→ update_env WORKER_ADVERTISE_HOST）与
  `--serve-hostname <host>`（→ update_env OPENCODE_SERVE_HOSTNAME），非空才写入（本机/集群内无感知）；
  安装后未提供 --advertise-host 且 .env 无 WORKER_ADVERTISE_HOST 时醒目提示（对齐 WORKER_MCP_URL 提示块
  ⚠️ 格式）；帮助注释 + 未知参数报错同步更新；旧参数全保留
- `worker/src/config.ts`：WorkerConfig 新增 `workerAdvertiseHostExplicit` 标记（env 中非空值即 true）——
  告警触发的判定标准，避免「值恰好 127.0.0.1 的本地开发」误报
- `worker/src/index.ts`：新增 `warnLoopbackAdvertiseHost(config)` 独立导出函数，main() 在 printStartup 后
  调用；仅未显式设置时 console.warn 一次醒目提示（含 WORKER_ADVERTISE_HOST + OPENCODE_SERVE_HOSTNAME 引导）
- `worker/.env.example`：OPENCODE_SERVE_HOSTNAME / WORKER_ADVERTISE_HOST 两行补集群外注释
- `worker/README.md`：env 表两行补集群外说明；「集群外 worker 配置」小节重命名扩展为三件套组合示例
  （WORKER_MCP_URL + WORKER_ADVERTISE_HOST + OPENCODE_SERVE_HOSTNAME，含执行端点已 0.0.0.0 说明）
- `docs/deployment.md` 4.4.1：扩展为「WORKER_MCP_URL + 可达地址三件套」，含一键安装命令示例

### 关键设计决策
- **防误报判定标准**：告警只看「是否显式设置」（workerAdvertiseHostExplicit = env 非空），不看值是否为
  127.0.0.1——显式设置 127.0.0.1（本地开发）不提示；空串/空白视为未设置（回落默认 + 仍提示）
- **告警一次**：仅 main() 启动时调用一次（非心跳/探测路径，无节流问题）
- **幂等**：update_env 先删 `^KEY=` 再追加；缺省不写 .env（本机/集群内 worker 无感知）
- **独立导出**：warnLoopbackAdvertiseHost 独立导出便于单测（console.warn spy 三态：未设置提示 / 显式
  127.0.0.1 不提示 / 显式非回环不提示）

### 验证结果
- `bash -n web/public/install-worker.sh`：SYNTAX_OK
- worker jest 全量：19 suites / 368 tests 全通过（新增 7 个：config 4 + index 3）
- `npm run typecheck`：EXIT 0
- `scripts/pack-worker.sh` 重跑：worker-src.tar.gz 216K，`tar -tzf` 确认 .env.example 在包内且含
  WORKER_ADVERTISE_HOST / OPENCODE_SERVE_HOSTNAME / 集群外注释
- 部署待派发：install-worker.sh + worker-src.tar.gz 随 web 镜像重建生效；worker 代码改动（config/index
  告警）需 worker 镜像重建生效；本任务不部署（另行派发）
