# team-free-chat - Work Plan

## TL;DR (For humans)

**What you'll get:** 团队会话彻底摆脱任务依赖——零任务团队进会话直接畅聊，主 Agent 接待；意图明确就建真任务（缺项目信息就追问），意图不明就引导追问，绝不凭空建任务、绝不强制先建任务。确立产品原则：**团队是中心**，任务/项目/记忆等资源为团队服务、关联均为可选——团队零任务时一切团队能力（会话、成员、私聊、模型查看）照常工作。

**Why this approach:** 上一版"锚任务"方案被推翻：它用隐式任务绕过了问题，但任务仍是强制前置，违背"团队永恒、任务一次"原则。本计划把执行/记忆/权限直连团队——会话不再要求 task 行存在；交付物（产出物/Issue/计划/队列）天生任务归属，保持不动。团队成员管理（增删/别名）走团队端点本就无任务依赖；模型覆盖/启用/重置会话是执行控制，无任务上下文时只读降级（见 Todo 5），不强制建任务。

**What it will NOT do:** 不建隐式/锚任务（上一版 team-free-chat 初稿作废）；不改 FIFO/队列/状态机语义；不做私聊接待话术；不兼容旧数据的特殊处理（用户已明确）；不动交付物域表结构

**Effort:** Large
**Risk:** High - dispatcher 核心分支（3200 行 166 处 taskId）+ MCP 参数透传（3600 行 248 处）+ sessions 表结构变更；单测 + 浏览器冒烟覆盖

**Decisions to sanity-check:** sessions.task_id 改可空 + 新增 team_id 直连（历史行用 teamMember/taskAgent 回填）；新增 team_user_members 表 + 建团队者自动入成员；MCP 聊天族 taskId 改可选 + teamId 透传，交付族保持 task 必填；task_create 的 projectId 必填（逼出引导追问，不做默认）；团队成员管理 UI 只做极简列表/增删；**无任务上下文时模型覆盖/启用禁用/重置会话入口只读降级**（TeamMember 模型本就没有这些字段，这是执行控制不是成员属性；带任务后自动恢复全功能，不为此加表字段）

Your next move: 批准后直接 $start-work team-free-chat。 Full execution detail follows below.

---

> TL;DR (machine): Large effort, High risk, deliverables: 团队直连执行（sessions 解绑 task + 团队成员权限 + dispatcher team-mode + MCP 可选 taskId + task_create + 零任务会话 UI）

## Scope
### Must have
- 数据模型：`sessions.task_id` 改可空 + 新增 `sessions.team_id`（历史行：有 teamMember 按成员归属团队回填，有 taskAgent 按任务归属团队回填，两者皆无保持 task 绑定）；新建 `team_user_members(team_id, user_id, role, joined_at)`；`TeamsService.create` 建团队者自动写入成员（owner）；`toTeamDto`（teams.service.ts:849）透出 `userMembers`；迁移 `20260904000000_team_execution_context`（多语句，仿 migrations/ 单文件多语句风格，先 ALTER sessions 再建表；`migrate deploy` 验证）
- 权限切换：新增 `TeamMembershipGuard`（仿 project-membership.guard 写法）；`resolveChannelAccess`（chat.service.ts:1200-1266，含 projectId:'' stub 分支）加团队路径——team 频道且无任务上下文时要求调用方是 team_user_members 成员，否则沿用项目成员校验；新增成员管理端点 POST/DELETE `/teams/:id/users`（body {userId, role?}，复用 teams.edit 权限点风格）；`GET /teams/:id` 返回含 userMembers
- Dispatcher team-mode：会话定位按 `(teamId, teamMemberId)`（无 taskId 时跳过 task 相关查询；**session 创建/绑定走 session-lifecycle.service.ts:62-111 `bindSessionToWorker`，必须同步加 team-mode 分支**——幂等键改为 `(teamId, teamMemberId)`，`uk_sessions_task_agent` 保持不动（task 行沿用），**新增唯一约束 `uk_sessions_team_member(team_id, team_member_id)` 覆盖 task_id 为空行**，TaskGroupInstance 仅 task-mode 维护）；团队 workdir 扩展 `resolveAgentWorkDir`（worker-dispatcher.ts:3039，兼容回退见 :1199）：team-mode 返回 `<根>/teams/<teamId>`（mkdir -p，同 :3039 写法）与 tasks/<taskId> 并列；无任务主触发走团队路径（`team.mainAgentMemberId` → 成员，无主则首成员，语义照抄 buildMainAgentTrigger team 分支 chat.service.ts:1524-1544）；`buildSystemInstructions` 加 team-mode 条件接待块（见下）；`registerExecution`/watchdog 的 taskId 键在 team-mode 下用 `team:<teamId>` 命名空间，避免与任务键碰撞；`resetTeamSessions`（session-lifecycle.service.ts:168-229）现已按 teamMemberId 全量处理 team 行，无需改动；`buildSystemInstructions` 单测 + dispatcher team-mode 单测（无任务派发建会话、主判定、话术包含断言）+ session-lifecycle team-mode 绑定单测；Must NOT 改 task-mode 任何分支（回归靠旧单测），Must NOT 碰 FIFO/transition
- 接待话术（team-mode 专属，task-mode 原文不动）：你是团队主 Agent 接待员；用户意图明确（含做什么、可执行）→ 先用 `my_projects` 查用户项目（恰好 1 个直接用，多于 1 个必须先问），再调 `task_create` 建真任务；意图不明→普通回复追问（做什么/归哪个项目/验收标准），禁止建任务、禁止走 QuestionModal；把 `task_create`、`my_projects` 工具名写进话术
- MCP 参数改造：`platform-mcp.tools.ts`（26 工具 :577 起）聊天族——`chat_history`、`group_post`、`notify_agent`、`memory_save`、`memory_search`、`question_confirm`、`channel_send`、`my_profile`、`team_view`：`taskId` 改可选 + 新增可选 `teamId`（zod describe 写清互斥/优先级：taskId 优先，无 taskId 用 teamId 定位团队会话）；交付族（`doclib`、`task_context`、`submit_artifact`、`issue_*`、`plan_*`、`task_transition` 等）保持 taskId 必填，缺失时报干净的错（"该工具需要任务上下文"）；新增 `task_create`（title*/description?/projectId*/priority?，门控=调用方是主 Agent：team-mode 下 session teamMember == team.mainAgentMemberId，task-mode 下沿用 task.mainAgentInstanceId 判定，参考 platform-mcp.service.ts:1386 isMain 写法，否则按该文件风格抛 Forbidden）；新增 `my_projects`（返回调用方用户项目列表，无参）
- 前端零任务会话：**不做项目选择器、不建锚任务**；`web/app/(main)/teams/[id]/session/page.tsx` 现有 `currentTaskId` 为空降级路径保持（queries 已是 enabled 门控，:127-214；空闲态 :977），补齐 teamsApi 类型里的 `userMembers`；团队详情页成员区旁加极简用户成员段（列表 + 按用户名/ID 添加 + 移除，复用 MemberRow 视觉语言但独立小组件，调新增 users 端点）；成员面板的模型 chip/启用禁用/重置会话/添加实例回调仅在有任务上下文（currentTaskId 非空）时传入，无任务时不传（面板现有 optional 回调 + teamEditable=false 即只读，附 footer 提示"成员管理需有进行中任务"之外的中性文案，Must NOT 为此给 TeamMember 加字段）；看板/抽屉/详情页不改（它们只读任务，本就工作）
- 单测 + 浏览器冒烟；框架 jest + Playwright；零空 catch（有 catch 必日志）

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 建隐式/锚任务或任何"代表任务"的占位行（上一版方案作废点，如执行器发现残留 is_free_chat 思路立即停下）
- 改 FIFO/队列/状态机/claim 语义（team_queues、promoteNext、transition 只读不碰）
- 私聊接待话术（私聊直达成员，不需要）
- 意图不明时建任务；无 team 成员身份时放行 team 频道发言之外的任何写操作
- 为旧数据写兼容分支（sessions 回填是一次性 SQL，不是运行时分支）
- **任何运行时兼容/回退分支（用户明确：直接推翻，不留 AB）**：
  - `worker-dispatcher.ts`：`selfInstanceId`、`registerExecution`、`cleanupChannel` 的 `teamMemberId ?? taskAgentId ?? agentId` 三级回退一律拆成维度专属（team-mode 只取 teamMemberId，缺失即报错不回退；task-mode 只取 taskAgentId）；删除 1305-1319 与 1420-1433 的 ta_↔tmm_ 双向映射块；team roster 为空即空列表，不再回退 taskAgents 拼凑
  - `chat.service.ts`：`buildMainAgentTrigger` 内 teamMember↔taskAgent 双向兼容查询删除（team-mode 只查 teamMember，task-mode 只查 taskAgent）；`resolveChannelAccess` 删除 `projectId:''` stub，team 无任务路径直接走团队成员校验
  - `platform-mcp.service.ts`：`assertWorkerTask` 的 taskAgentId 回退/agentId 语义回退删除（team-mode 按 `(teamId, teamMemberId)` 查会话，task-mode 按 `(taskId, taskAgentId)` 查会话，对不上就 403）
  - `web/app/(main)/teams/[id]/session/page.tsx`：凡注释标有"存量/回退/兼容/fallback"的 `??` 链与分支一律删除；正常的空值保护（`?.`、对缺失数据的 `?? null` 默认展示）不算兼容分支，不要误删
  - 唯一的例外：migration 回填 SQL（一次性，非运行时分支）与单测里的 mock 数据（非生产代码）

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + 浏览器冒烟；框架 jest + Playwright
- Evidence: .omo/evidence/team-free-chat/task-<N>.log + screenshots
- 关键断言矩阵：
  - 零任务团队（新成员用户）进会话直接发消息 → 主 Agent 回复，无任务行被创建（tasks 表零新增），无选择器弹窗
  - 明确意图（"帮我建个登录页任务"，用户多项目）→ 主 Agent 先问项目 → 用户回答后 task_create 建出真任务（指定项目）；用户单项目 → 直接建出
  - 不明意图（"随便聊聊"）→ 只有追问回复，任务表零新增
  - 非主成员调 task_create → 403；非团队成员发 team 频道消息 → 403；交付族工具无 taskId 调用 → 干净报错（非 500）
  - 回归：有任务团队的群聊/私聊/排队/状态机行为不变（旧单测全绿为准）

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- Wave 1: 数据模型 + 权限守卫（Todos 1-2，表结构与守卫形状本计划已定死，可并行）
- Wave 2: Dispatcher team-mode + MCP 参数改造（Todos 3-4，不同文件，可并行；共用"主身份判定"语义已在计划写死）
- Wave 3: 前端（Todos 5-6，可并行：会话页 vs 团队详情页不同文件）+ 收尾验证 Todo 7

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | - | 2,3,4,5,6 | 2 |
| 2 | 1 | 7 | 1 |
| 3 | 1 | 7 | 4 |
| 4 | 1 | 7 | 3 |
| 5 | 1 | 7 | 6 |
| 6 | 1,2 | 7 | 5 |
| 7 | 2,3,4,5,6 | - | - |

## Pre-flight gate（Todo 1 之前必做，非 checkbox，不计入进度）
- `git add -A && git status --short` 人工确认无误加文件（尤其排查 .env/本地密钥类），再提交存量工作区（message：`docs(omo): team-free-chat work plan for team-led execution context`，如有其他会话遗留的大批改动则分开提交，不要混在一次 commit）
- 不备份数据库、不考虑老数据兼容（用户明确）：迁移直接跑，sessions 回填 SQL 只处理能归属的行，无归属历史行保持原样
- 验收：`git status --short` 干净（除本计划执行中新改动）；证据记入 `.omo/evidence/team-free-chat/task-0.log`（贴 status）
- 禁止把备份文件提交进仓库（如执行器顺手备了份也不许进仓库）

## Todos
- [ ] 1. 执行上下文数据模型（sessions 解绑 + 团队用户成员）
  What to do / Must NOT do: schema：`sessions.task_id` 改可空（`String?`），`sessions` 加 `team_id String?`（先可空方便回填；业务层保证 team-mode 必填），`sessions.task_agent_id` 改可空（team-mode 会话无任务实例），`task`/`taskAgent` 两个 relation 改可选（`Task?`/`TaskAgent?`，现有 Restrict 语义保留）；`task_group_instances.task_id` 改可空 + 加 `team_id String?`/`team_member_id String?`（team-mode 复用幂等行走新维度，task-mode 原样）；新建 `team_user_members(team_id,user_id,role,joined_at)`；新增唯一约束 `uk_sessions_team_member(team_id, team_member_id)`（task_id 为空行幂等用，`uk_sessions_task_agent` 保持不动）；迁移 `20260904000000_team_execution_context`（ALTER + CREATE TABLE + 回填 UPDATE：sessions 按 teamMember→team / taskAgent→task→team 回填 team_id；`migrate deploy` 验证）；`TeamsService.create` 事务内建团队者写入 owner 成员；`toTeamDto`（teams.service.ts:849-885）加 `userMembers`（id/userId/role/joinedAt）；`TeamDto` 前端类型（web teamsApi 处）同步加字段；jest 补用例（建团队自动含创建者成员；toTeamDto 含 userMembers）；Must NOT 动 task_agents/artifacts/issues/plans/queues 表，Must NOT 写运行时兼容分支
  Parallelization: Wave 1 | Blocked by: - | Blocks: 2,3,4,5,6
  References (executor has NO interview context - be exhaustive): server/prisma/schema.prisma Task/Session/TaskGroupInstance 模型区（Session :278-299，TaskGroupInstance :730-742，注意 taskAgent relation 必填改可选）, server/prisma/migrations/20260901000002_add_task_reset_after_complete/migration.sql（单语句风格）, server/src/teams/teams.service.ts:849-885 toTeamDto + create 事务, server/src/teams/teams.service.spec.ts, web teamsApi TeamDto 定义处（executor grep TeamDto）
  Acceptance criteria (agent-executable): migrate deploy 成功；建团队后 userMembers 含创建者；GET /teams/:id 返回 userMembers；历史 sessions.team_id 回填率 100%（有归属的可归属行）
  QA scenarios (name the exact tool + invocation): happy: npx jest teams.service.spec 绿；failure: 回填 SQL 报错则先修；Evidence .omo/evidence/team-free-chat/task-1.log
  Commit: Y | feat(server): team execution context model

- [ ] 2. 团队权限守卫与频道接入
  What to do / Must NOT do: 新增 `TeamMembershipGuard`（仿 server/src/common/guards/project-membership.guard.ts 写法，查 team_user_members）；`resolveChannelAccess`（chat.service.ts:1200-1266）加团队路径：team 频道且解析不出任务上下文（现有 projectId:'' stub 分支处）→ 改要求 team_user_members 成员，否则 Forbidden（code 沿用 PROJECT_MEMBERSHIP NOT_MEMBER 语义）；新增 POST/DELETE `/teams/:id/users`（仿 teams.controller.ts:70-75 addMember 端点形状与 teams.service addMember 校验；body {userId, role?}，NOT_FOUND/MEMBER 校验，广播 TEAM_CHANGED 复用）；teams.controller.spec + service spec 补用例（成员可发/非成员 403/增删成员）；Must NOT 改项目资源的守卫，Must NOT 放宽到"登录即聊"
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 7
  References: server/src/common/guards/project-membership.guard.ts, server/src/chat/chat.service.ts:1200-1266 resolveChannelAccess + :776 resolveMentions 调用处, server/src/teams/teams.controller.ts（addMember 端点仿写）, server/src/teams/teams.controller.spec.ts
  Acceptance criteria: 非团队成员发 team 频道消息 403；成员 200；增删用户成员往返正常
  QA scenarios: happy: jest 新用例绿；failure: 旧项目校验用例红则检查分支顺序；Evidence .omo/evidence/team-free-chat/task-2.log
  Commit: Y | feat(server): team membership guard

- [ ] 3. Dispatcher team-mode（无任务执行）
  What to do / Must NOT do: worker-dispatcher.ts：会话定位按 `(teamId, teamMemberId)`（无 taskId 时跳过 task 相关查询；**会话创建走新增的 `ensureTeamSession(teamId, teamMemberId)`（放 session-lifecycle.service.ts，仿 bindSessionToWorker :62-117 事务写法：按新唯一键 `uk_sessions_team_member` 查到复用、查不到 create `{team_id 必填, task_id/task_agent_id 置空}`；注意 `bindSessionToWorker` 只绑定已存在行，缺失抛 404，不得复用它做创建**）；TaskGroupInstance team-mode 走新 team 维度列（`team_id`+`team_member_id`+workerId 幂等查复用，`task_id` 置空；task-mode 原样）；团队 workdir 扩展 `resolveAgentWorkDir`（worker-dispatcher.ts:3039，兼容回退见 :1199）：team-mode 返回 `<根>/teams/<teamId>`（mkdir -p，同 :3039 写法）与 tasks/<taskId> 并列；无任务主触发走团队路径（team.mainAgentMemberId → 成员，无主则首成员，语义照抄 buildMainAgentTrigger team 分支 chat.service.ts:1524-1544）；`buildSystemInstructions` 加 team-mode 接待块（taskId 为空时：主 Agent 接待员身份 + 意图明确→my_projects 查项目→task_create + 意图不明→追问三要素，禁建任务禁 QuestionModal，工具名写进话术）；执行键（`registerExecution`/`unregisterExecution`/`emitLoading` 调用处 worker-dispatcher.ts:751/773/1326/1475/1544/2124/2133/2716，executor 先核对签名再定键形状）team-mode 与 task-mode 必须可区分（`team:<teamId>` 命名空间仅为建议形状，键碰撞即 Bug）；`resetTeamSessions`（session-lifecycle.service.ts:168-229）现已按 teamMemberId 全量处理 team 行，无需改动；；`buildSystemInstructions` 单测 + dispatcher team-mode 单测（无任务派发建会话、主判定、话术包含断言）；Must NOT 改 task-mode 任何分支（回归靠旧单测），Must NOT 碰 FIFO/transition
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 7
  References: server/src/chat/worker-dispatcher.ts（taskId 166 处，重点 :213 buildSystemInstructions, :1301-1319 isMainAgent, :1443 调用点）, server/src/chat/chat.service.ts:1488-1544 buildMainAgentTrigger + :776 调用处, server/src/workers/session-lifecycle.service.ts:62-117 bindSessionToWorker（只绑定已存在行，team-mode 新建走新增 ensureTeamSession）, server/src/chat/worker-dispatcher.spec.ts（buildSystemInstructions 单测区）, server/src/workers/session-lifecycle.spec.ts
  Acceptance criteria: 单测断言通过；task-mode system 文案逐字不变；会话行 task_id 可空且 team_id 必填
  QA scenarios: happy: jest dispatcher 相关 spec 全绿；failure: 旧 task-mode 用例红则 diff 分支隔离；Evidence .omo/evidence/team-free-chat/task-3.log
  Commit: Y | feat(server): dispatcher team mode

- [ ] 4. MCP：taskId 可选 + task_create + my_projects
  What to do / Must NOT do: platform-mcp.tools.ts（26 工具 :577 起）：`chat_history`、`group_post`、`notify_agent`、`memory_save`、`memory_search`** 的 taskId 改可选 + 加可选 teamId（`question_confirm` 因 agent_questions.task_id 非空保持必填，`channel_send` 无 taskId 参数无需改动，`my_profile`/`team_view` 为任务上下文工具保持必填；zod describe 写清"taskId 优先，无则用 teamId 定位团队会话"）；交付族（doclib/task_context/submit_artifact/issue_*/plan_*/task_transition/question_confirm 等）保持 taskId 必填，缺失报干净的错（非 500，文案"该工具需要任务上下文"）；新增 `task_create`（title*/description?/projectId*/priority?，projectId 必填不设默认；门控=主 Agent：team-mode 下 session teamMember == team.mainAgentMemberId，task-mode 沿用 task.mainAgentInstanceId 判定，参考 platform-mcp.service.ts:1386，违者 Forbidden；**projectId 越权防护：pid 必须 ∈（该团队已有任务的 project 去重集 ∪ 该团队用户成员的项目集），否则 Forbidden（主身份只证明是主 Agent，不证明对任意项目有处置权）**；成功走新增的 `TasksService.createByAgent`（不得直调 `create()`——其内含按调用 userId 的 projectMember 校验 tasks.service.ts:216-224，agent 调用必 403；抽取 create() 事务体为私有方法，projectMember 校验仅用户路径执行，createdBy 落调用方实例 id，projectId 存在性校验保留，归因仿 `issueCreate` 的 creatorAgentId 写法 platform-mcp.service.ts:743-766））；新增 `my_projects`（无参：查调用方所在团队的成员用户 → projectMember 反查去重，返回用户项目列表，team-mode 下无 task 可用时的项目发现通道）；service spec 补用例（可选参数矩阵/主门控/缺省报错/createByAgent 归因）；Must NOT 放宽交付族，Must NOT 给 task_create 加项目默认（默认会杀死引导追问）
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 7
  References: server/src/platform-mcp/platform-mcp.tools.ts:577-767, server/src/platform-mcp/platform-mcp.service.ts:1386-1393 isMain 门控 + issue_create 归因写法（executor grep）, server/src/platform-mcp/platform-mcp.service.spec.ts
  Acceptance criteria: 单测绿；tools/list 可见新工具及更新后的 schema；非主调 task_create 403
  QA scenarios: happy: jest 新用例绿；failure: 门控误杀则对照 buildMainAgentTrigger 优先级；Evidence .omo/evidence/team-free-chat/task-4.log
  Commit: Y | feat(server): optional taskId MCP tools plus task_create

- [ ] 5. 前端：零任务会话直聊（无选择器）
  What to do / Must NOT do: 确认并加固 `web/app/(main)/teams/[id]/session/page.tsx` 在零任务下的降级（currentTaskId 为空时 queries 已 enabled 门控 :127-214、空闲态 :977、发送不带 taskId；实测走一遍修崩处）；**不做项目选择器、不建锚任务**；发消息失败行内报错不跳页；teamsApi TeamDto 加 userMembers 类型；Must NOT 改私聊 Tab 与右侧面板逻辑（锚任务不存在，有任务团队行为不变）
  Parallelization: Wave 3 | Blocked by: 1 | Blocks: 7
  References: web/app/(main)/teams/[id]/session/page.tsx:127-214 queries, :415 scope, :977 空闲态, web/e2e/pages.spec.ts（7b 会话冒烟仿写零任务用例）
  Acceptance criteria (agent-executable): 全新零任务团队进会话无弹窗无选择器，发消息主 Agent 回复；任务表零新增
  QA scenarios (name the exact tool + invocation): happy: npx playwright test -g"team-session zero-task" 通过；failure: 403 则查成员身份（Todo 2 联调）；Evidence .omo/evidence/team-free-chat/task-5.log + screenshot
  Commit: Y | feat(web): zero-task team session

- [ ] 6. 前端：团队用户成员管理（极简）
  What to do / Must NOT do: 团队详情页成员区旁加"用户成员"小段：列表（用户名/角色/加入时间）+ 按用户名添加 + 移除；调 Todo 2 的 users 端点（teamsApi 加方法）；失败行内报错；复用 MemberRow 视觉语言但独立小组件（别塞进 agent 成员组件）；Must NOT 做邀请/审批流，Must NOT 动 agent 成员区
  Parallelization: Wave 3 | Blocked by: 1,2 | Blocks: 7
  References: web/app/(main)/teams/[id]/page.tsx 成员区（executor 定位 MemberRow/import 段）, web/src/api/teams.ts
  Acceptance criteria: 增删用户成员往返正常；非成员发消息仍 403
  QA scenarios: happy: Playwright 走一遍增删；failure: 端点 404 则查路由注册；Evidence .omo/evidence/team-free-chat/task-6.log + screenshot
  Commit: Y | feat(web): team user members UI

- [ ] 7. 收尾验证（全链路冒烟）
  What to do / Must NOT do: 全新团队（零任务）→直接发明确需求→主 Agent（必要时先问项目）→task_create 建出真任务（指定项目；忙闲状态机正确）→再发模糊消息→只有追问、任务表零新增；非主调 task_create 403；**task_create 传无关项目 pid → 403（越权防护）**；非成员发消息 403；交付族无 taskId 调用干净报错；**无兼容死代码审计**：`grep -rn "存量\|回退\|兼容\|fallback\|legacy\|LEGACY" server/src/chat server/src/workers server/src/platform-mcp web/app/\(main\)/teams` 零命中（注释说明除外；migration SQL 与单测 mock 除外）；跑全量相关 jest + web build + Playwright 会话冒烟（含回归：有任务团队群聊/私聊/排队/状态机）；Must NOT 留测试脏数据（用后清理测试任务/团队/成员）
  Parallelization: Wave 3 | Blocked by: 2,3,4,5,6 | Blocks: -
  References: .omo/evidence/team-free-chat/task-*.log, web/e2e/pages.spec.ts, server/src/tasks/tasks.service.spec.ts, server/src/platform-mcp/platform-mcp.service.spec.ts
  Acceptance criteria: 上述行为断言全过；jest 相关 spec 全绿；web build 绿；Playwright 冒烟绿
  QA scenarios: happy: 真任务行出现且状态机正确；failure: 任一断言失败回对应 Todo 修；Evidence .omo/evidence/team-free-chat/task-7.log + screenshots
  Commit: Y | test: team-mode e2e verification

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit
- [ ] F2. Code quality review
- [ ] F3. Real manual QA
- [ ] F4. Scope fidelity

## Commit strategy
- 每 Todo 独立提交，feat(server): / feat(web): / test: 前缀

## Success criteria
- 零任务团队进会话：无弹窗无选择器，直接发消息主 Agent 接待，全程不报错，任务表零新增
- 意图明确：真任务被建出（指定项目，忙闲状态机正确）
- 意图不明：只有追问回复，任务表零新增
- 非主调 task_create 403；跨项目 task_create 403；非成员发言 403；交付族无 task 干净报错；看板/列表无幽灵任务
- 有任务团队的一切行为与改前一致（旧单测全绿为准）
