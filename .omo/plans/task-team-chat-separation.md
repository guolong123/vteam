# task-team-chat-separation - Work Plan

## TL;DR (For humans)

**What you'll get:** 任务列表点击改为抽屉详情不再进聊天；团队会话成为唯一聊天入口并补齐私聊、模型选择等全部能力；删掉的聊天代码彻底清理无残留。

**Why this approach:** 任务与聊天解耦（抽屉保留上下文）、团队会话对齐任务聊天全量能力（除任务强绑定外）、零兼容负担清理保证代码干净。

**What it will NOT do:** 不保留任务+团队双群聊天；不在团队会话内嵌任务创建表单；不做团队内并发

**Effort:** Medium
**Risk:** Medium - 3400行任务聊天页拆解与340行团队会话页重构，涉及私聊/实时/面板拖拽
**Decisions to sanity-check:** 抽屉详情替代任务卡片跳转；团队会话右侧复用三Tab(team.currentTaskId驱动)；全量功能对齐+彻底清理无兜底

Your next move: 批准后直接 $start-work task-team-chat-separation。 Full execution detail follows below.

---

> TL;DR (machine): Medium effort, Medium risk, deliverables: 任务去聊天化抽屉 + 团队会话全量对齐 + 代码清理

## Scope
### Must have
- 看板/列表 TaskCard 去聊天化：onClick 改抽屉详情（状态/标题/描述/主Agent/团队/产出物/Issue/计划/状态操作），不再 router.push(/tasks/:id) 聊天页；抽屉内显式"进入团队会话"按钮
- /tasks/:id 剥离聊天：移除 MessageList/MessageInput/useRealtimeEvents/SSE 聊天区，仅保留任务详情+右侧面板（TaskPanel/TaskRightTabs 等）；深度编辑仍可跳此路由
- /teams/:id/session 功能对齐任务聊天页：完整 MembersPanel（含 model chip/启用禁用/重置会话/添加实例）、私聊 Tabs(private:channelId, teamMember 维度 /dm-channels)、可拖拽面板(useResizableWidth)、Question/IssueDetail/TaskEdit/ReviewDialog 弹窗、实时 team:+channel: 订阅
- 右侧 TaskRightTabs 复用到团队会话：状态/配置/产出三Tab，数据源切 team.currentTaskId 驱动 artifacts/issues/plans，队列 TeamQueueCard + TeamMemoryCard 保留
- 代码清理：删掉功能的相关代码彻底移除（无 feat flag/legacy/fallback），无用 import/type/常量/旧 channel 查询一并清理；所有 catch 必须日志，禁止空 catch 吞错

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 保留 /tasks/:id 中央聊天区双写（不做团队+任务双群）
- 团队会话内嵌任务创建/编辑表单（仍走 /tasks/new?teamId=）
- 团队内并发多任务会话（仍 FIFO 单队首）
- 为删掉功能保留兼容/兜底/AB 分支、注释掉的旧代码、空 catch 吞错

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + 浏览器冒烟；框架 jest + Playwright
- Evidence: .omo/evidence/task-team-chat-separation/task-<N>.log + screenshots

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- Wave 1: 看板去聊天化 + 抽屉详情（Todos 1-2）
- Wave 2: /tasks/:id 剥离聊天 + 团队会话全量对齐（Todos 3-5）
- Wave 3: 右侧三Tab复用 + 清理与验证（Todos 6-8）

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | - | 2,3 | - |
| 2 | 1 | 3 | - |
| 3 | 1 | 4,5 | - |
| 4 | 3 | 6 | 5 |
| 5 | 3 | 6 | 4 |
| 6 | 4,5 | 7 | - |
| 7 | 6 | 8 | - |
| 8 | 7 | - | - |

## Todos
- [x] 1. 看板 TaskCard 去聊天化与抽屉骨架
  What to do / Must NOT do: 修改 web/app/(main)/board/page.tsx TaskCard onClick 从 router.push(/tasks/:id) 改为打开抽屉/弹窗（TaskDetailDrawer 新组件），展示任务状态/标题/描述/主Agent/团队/产出物/Issue/计划/TaskStatusActions；卡片底部"进入会话"仅在抽屉内显式"进入团队会话"按钮；Must NOT 保留卡片直跳聊天
  Parallelization: Wave 1 | Blocked by: - | Blocks: 2,3
  References (executor has NO interview context - be exhaustive): web/app/(main)/board/page.tsx:220-400 TaskCard, web/app/(main)/tasks/[id]/page.tsx:2329-2967 TaskPanel/TaskRightTabs
  Acceptance criteria (agent-executable): 点击看板卡片不跳 /tasks/:id，打开抽屉展示任务详情；抽屉内"进入团队会话"跳 /teams/:teamId/session
  QA scenarios (name the exact tool + invocation): happy: npx playwright test 点击卡片出现抽屉；failure: 旧 onClick 跳转已移除；Evidence .omo/evidence/task-team-chat-separation/task-1.log
  Commit: Y | feat(web): board task card drawer decoupled from chat

- [x] 2. 抽屉详情完整数据接入
  What to do / Must NOT do: 抽屉内接入 GET /tasks/:id, GET /tasks/:id/artifacts, GET /issues?taskId=, GET /plans?taskId=, GET /teams/:teamId 数据；复用 TaskPanel 右侧展示逻辑但无聊天；Must NOT 在抽屉内嵌 MessageList/输入
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3
  References: web/app/(main)/tasks/[id]/page.tsx:3341-3367 artifactsQuery/issuesQuery/plansQuery, web/src/api/teams.ts:86
  Acceptance criteria: 抽屉内产出物/Issue/计划真实数据渲染，队列卡片按 teamId 展示
  QA scenarios: happy: 抽屉内产出物列表可见；failure: 无 teamId 时不报错；Evidence .omo/evidence/task-team-chat-separation/task-2.log
  Commit: Y | feat(web): task drawer data wiring

- [x] 3. /tasks/:id 剥离聊天区仅留详情
  What to do / Must NOT do: 重构 web/app/(main)/tasks/[id]/page.tsx 移除 MessageList/MentionHint/MessageInput/useRealtimeEvents/SSE 聊天相关 state 与 handler，仅保留任务详情区+右侧面板（TaskRightTabs/TeamQueueCard/TeamMemoryCard/编辑弹窗）；删除 ChatBubble/MsgParts/LoadingIndicator 聊天引用；Must NOT 保留双群聊天分支
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 4,5
  References: web/app/(main)/tasks/[id]/page.tsx:1-3400 全文件, web/src/components/ui, web/hooks/use-realtime.ts
  Acceptance criteria: /tasks/:id 不再展示聊天消息与输入框，仅展示任务详情与右侧信息
  QA scenarios: happy: 访问 /tasks/:id 无聊天区；failure: 搜索旧 MessageList 无命中；Evidence .omo/evidence/task-team-chat-separation/task-3.log
  Commit: Y | refactor(web): strip chat from task detail page

- [x] 4. 团队会话 MembersPanel 完整回补与私聊
  What to do / Must NOT do: 重构 web/app/(main)/teams/[id]/session/page.tsx 回补完整 MembersPanel（model chip/启用禁用/重置会话/添加实例/更多菜单）、私聊 Tabs(state activeTab private:channelId, handlePrivateTab, privateChannelMap, POST /dm-channels teamMember 维度)、模型选择器(modelsQuery)、onToggleEnabled/onResetSession/onChangeModel 回调；Must NOT 用简化版成员列表
  Parallelization: Wave 2 | Blocked by: 3 | Blocks: 6
  References: web/app/(main)/tasks/[id]/page.tsx:504-1215 MembersPanel, web/app/(main)/teams/[id]/session/page.tsx:1-340, server/src/chat/chat.controller.ts
  Acceptance criteria: 团队会话左侧成员可切换私聊、可选模型、可禁用/重置；私聊 Tab 按 teamMember 复用
  QA scenarios: happy: 点击成员进入私聊 Tab；failure: 未登录不发起 /dm-channels；Evidence .omo/evidence/task-team-chat-separation/task-4.log
  Commit: Y | feat(web): team session members panel and private chat

- [x] 5. 团队会话可拖拽面板与弹窗回补
  What to do / Must NOT do: 回补 useResizableWidth(左224右300)、ResizeHandle、QuestionModal(pendingQuestion)、IssueDetailModal(detailIssueId)、TaskInfoEditModal、ReviewDialog、PlanSection；实时 scope 改为 team:+channel:；Must NOT 遗漏弹窗 Esc 关闭与遮罩
  Parallelization: Wave 2 | Blocked by: 3 | Blocks: 6
  References: web/app/(main)/tasks/[id]/page.tsx:1282-1313 ResizeHandle, 2163-2278 ReviewDialog, web/src/hooks/use-resizable.ts, web/hooks/use-realtime.ts
  Acceptance criteria: 拖拽分隔条可调宽度并持久化；弹窗可打开/关闭；SSE 按团队订阅
  QA scenarios: happy: 拖拽面板宽度变化；failure: 无 teamId/channelId 时 SSE 不连接；Evidence .omo/evidence/task-team-chat-separation/task-5.log
  Commit: Y | feat(web): team session resizable panels and modals

- [x] 6. 团队会话右侧三Tab复用与队列记忆
  What to do / Must NOT do: 将 TaskRightTabs(状态/配置/产出) 完整迁移到团队会话右侧，数据源以 team.currentTaskId 驱动 artifacts/issues/plans 查询；保留 TeamQueueCard+TeamMemoryCard；Must NOT 仍以 taskId 直连查询
  Parallelization: Wave 3 | Blocked by: 4,5 | Blocks: 7
  References: web/app/(main)/tasks/[id]/page.tsx:3104-3260 TaskRightTabs, 2969-3101 TeamQueueCard/TeamMemoryCard, web/src/api/teams.ts
  Acceptance criteria: 右侧三Tab在团队会话正常切换，状态显示队首+等待队列，产出物/Issue 按当前任务展示
  QA scenarios: happy: 切换三Tab内容正确；failure: currentTaskId 为空时产出区空态友好；Evidence .omo/evidence/task-team-chat-separation/task-6.log
  Commit: Y | feat(web): team session right tabs with queue

- [x] 7. 代码清理与异常日志
  What to do / Must NOT do: 全量清理删掉功能的死代码：/tasks/:id 旧聊天 import/type/常量/无用 query/mutation，board 旧 onOpen 直跳逻辑，团队会话旧简化分支；移除注释掉的兜底；所有 catch 加 logger.error/console.error 附上下文（teamId/taskId/channelId）；Must NOT 保留 feat flag/legacy 分支/空 catch
  Parallelization: Wave 3 | Blocked by: 6 | Blocks: 8
  References: web/app/(main)/tasks/[id]/page.tsx, web/app/(main)/board/page.tsx, web/app/(main)/teams/[id]/session/page.tsx, web/hooks/use-realtime.ts
  Acceptance criteria: grep "catch.*\{\s*\}" 无空 catch；tsc 无无用 import 警告；无注释掉的旧聊天代码残留
  QA scenarios: happy: npm run build 通过；failure: grep 空 catch 零命中；Evidence .omo/evidence/task-team-chat-separation/task-7.log
  Commit: Y | chore(web): clean dead chat code and add error logging

- [x] 8. 收尾与验证（导航/重定向/文档）
  What to do / Must NOT do: 统一导航：board/team detail 仅保留团队会话入口，tasks 列表无聊天入口；旧 /tasks/:id 聊天直链提示"已迁移至团队会话"；更新 docs/agent-platform/28-团队模型与排队设计.md 与 README 入口说明，补充 web build + npm run test --runInBand；Must NOT 保留旧"任务进入会话"文案
  Parallelization: Wave 3 | Blocked by: 7 | Blocks: -
  References: docs/agent-platform/28-团队模型与排队设计.md, README.md, web/app/(main)/board/page.tsx
  Acceptance criteria: 文档与实现一致，web build 绿，所有"进入会话"均指向 /teams/:teamId/session
  QA scenarios: happy: 文档可渲染；failure: 旧文案残留 grep 零命中；Evidence .omo/evidence/task-team-chat-separation/task-8.log
  Commit: Y | docs: team chat separation

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
- 每 Todo 独立提交，feat(web): / refactor(web): / chore(web): / docs: 前缀

## Success criteria
- 看板点击任务卡片打开抽屉详情，不再进入 /tasks/:id 聊天页
- 团队会话 /teams/:id/session 具备完整聊天能力（群聊+私聊+模型选择+成员操作+弹窗+拖拽+三Tab）
- /tasks/:id 仅展示任务详情与右侧信息，无聊天区
- 删掉功能的代码无残留，异常均有日志，无空 catch
