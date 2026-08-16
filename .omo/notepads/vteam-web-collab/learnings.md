
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
