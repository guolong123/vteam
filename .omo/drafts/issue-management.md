# issue-management - Draft

## Request state
- **intent**: clear
- **review_required**: false
- **status**: exploring
- **slug**: issue-management
- **user request**: 支持 issue 管理，内置 issue 管理技能（MCP），让 AGENT 自行创建 issue；issue 与任务绑定；产品可创建 issue 让研发修改，测试可提交缺陷类型 issue；issue 支持标签标识类型；提供管理界面（增删改查 + 状态流转）；全局提示词增加工具说明。要求先分析做实现计划。

## Exploration findings (evidence)

### MCP 工具模式（复用基座）
- `server/src/platform-mcp/platform-mcp.service.ts`：现有 7 工具（chat_history/doclib/task_context/group_post/read_file/notify_agent/submit_artifact），handler 模式 + `assertWorkerTask(ctx, taskId)` 归属校验（selfAgentId 校验）
- `server/src/platform-mcp/platform-mcp.tools.ts`：`buildPlatformMcpTools(service)` 返回工具数组（name/description/inputSchema(zod)/handler）；`zodObjectToJsonSchema` 派生 JSON Schema
- `server/src/platform-mcp/platform-mcp.controller.ts`：tools/list + tools/call 分发（workerId 从 header）
- seed.ts:255 `keta-platform` MCP server + :283 tools 注册（source=mcp）——**内置 issue MCP 可仿此模式**（新建 mcp_servers 记录 + tools 记录，或扩展 keta-platform 工具集）

### 全局提示词（GLOBAL_SYSTEM_INSTRUCTIONS）
- `server/src/chat/worker-dispatcher.ts:57-71`：`GLOBAL_SYSTEM_INSTRUCTIONS` 数组——已有产出物声明（submit_artifact）/群聊发布（group_post）/agent 互@（notify_agent）说明。**新增 issue 工具说明在此追加**
- `buildSystemInstructions`(:73-106)：dispatch 时注入身份 + MCP 工具引导

### 任务/项目模型（issue 绑定基础）
- `Task`（schema.prisma:118）：id/projectId/title/description/priority/status/mainAgentId/backgroundDocs/createdBy/createdAt/startedAt/pendingReviewAt/completedAt/archivedAt；关系 project/taskAgents/taskEvents/sessions/chatChannels/artifacts/taskGroupInstances
- `Project`（:84）：id/name/description/ownerId/status/createdAt；members/tasks
- `TaskAgent`（:149）：taskId/agentId/joinedAt/removedAt（任务团队）
- `TaskStatus` 五态（task.constants.ts）：pending/in_progress/pending_review/completed/archived + 状态机 TASK_TRANSITIONS

### 前端管理页模式
- nav-dock.tsx NAV_ITEMS（9 项，新增"issue 管理"需加 + app-shell KEY_TO_PATH(:101) + CMDK_NAV_PATH）
- 页面风格：models 页（双 Tab+白卡+徽章）/ skills 页（三域管理）/ tasks 页——issue 管理页仿这些
- 状态流转交互：TaskStatusActions（task-status-actions.tsx）状态机按钮组模式可参照

## Open questions (owner-decisions)

**已确认（用户回答 2026-08-13）：**
1. **仅任务绑定**：Issue 必须挂在 task 下（taskId 必填）
2. **状态机**：`open / in_progress / resolved / closed`（closed 可 reopen 回 open；reject 可选 in_progress→open 退回）
3. **仅 tags 自由标签**：无 kind 枚举，用 tags 字符串数组（如 ["需求"]/["缺陷"]/["优化"] 自定义）
4. **指派 agent + 用户**：assigneeAgentId（可选，任务内 agent）+ assigneeUserId（可选）

## Components ledger

| id | 组件 | 一句话结局 | 状态 |
|----|------|-----------|------|
| C1 | schema + 迁移 | Issue 模型（taskId 必填 + tags 数组 + status + assigneeAgentId/UserId）+ 迁移 | exploring |
| C2 | server issue 模块 | CRUD + 状态流转 API + 权限（任务成员可建/管理） | exploring |
| C3 | 内置 issue MCP 工具 | issue_create/list/get/update/transition + 全局提示词说明 | exploring |
| C4 | web issue 管理页 | 列表/详情/创建/编辑/状态流转 + 标签徽章 + 导航入口 | exploring |
| C5 | 测试 + 端到端 | 单测 + agent 实测创建 issue | exploring |

## Next action

**状态：awaiting-approval**。向用户呈现审批简报，获批后写 `.omo/plans/issue-management.md`。

### 待规划方案（审批简报）

**目标**：内置 Issue 管理能力——agent 可经 MCP 自行创建/查询/更新/流转 issue（issue 与任务绑定），产品建需求 issue 指派研发、测试建缺陷 issue；前端提供 issue 管理页（增删改查 + 状态流转 + 标签徽章）。

**模块（5 组件）**：
- C1 schema：`Issue` 模型（id `is_` 前缀、taskId 必填、title、description、status 四态、tags 字符串数组、assigneeAgentId?/assigneeUserId?、createdBy、createdAt、resolvedAt、closedAt、reopenedAt）+ 迁移
- C2 server `issues` 模块：CRUD + 状态流转（open→in_progress→resolved→closed + reopen/reject）+ 权限（任务成员可建、指派校验 agent 在任务团队内）
- C3 内置 issue MCP 工具（扩展现有 keta-platform 工具集或新建 issue-mcp）：`issue_create`/`issue_list`/`issue_get`/`issue_update`/`issue_transition`，handler 复用 assertWorkerTask 归属校验；**GLOBAL_SYSTEM_INSTRUCTIONS 追加 issue 工具说明**
- C4 web issue 管理页：nav「Issue 管理」入口 + 列表（标签徽章/状态徽章/指派/任务）+ 创建/编辑弹窗 + 状态流转按钮组
- C5 测试 + 端到端：单测 + agent 实测（产品 agent 建需求 issue → 研发 agent 流转 in_progress → resolved → closed）

**范围外**：项目级 issue（仅任务绑定）、kind 枚举（仅自由 tags）、issue 评论/评论流、跨任务 issue、通知推送。

## Next action
向用户确认 4 个 owner 决策，获批后写计划。
