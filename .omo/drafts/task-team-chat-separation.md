---
slug: task-team-chat-separation
status: awaiting-approval
intent: clear
review_required: false
pending-action: write .omo/plans/task-team-chat-separation.md
approach: 看板任务卡片去聊天化改为抽屉详情；/tasks/:id 剥离聊天仅留详情；团队会话对齐任务聊天页功能（私聊/模型/成员操作/弹窗/三Tab右侧+队列记忆），数据源切 team.currentTaskId
---

# Draft: task-team-chat-separation

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
| C1 | 任务列表去聊天化（board/入口不再跳 /tasks/:id 聊天页） | active | web/app/(main)/board/page.tsx:220-400 |
| C2 | 任务详情页保留为非聊天详情（原 /tasks/:id 聊天内容剥离） | active | web/app/(main)/tasks/[id]/page.tsx:1-3400 |
| C3 | 团队会话页 /teams/:id/session 保留并重设右侧菜单 | active | web/app/(main)/teams/[id]/session/page.tsx:1-340 |
| C4 | 导航与重定向清理（旧 /tasks/:id 群聊入口 404/302 统一） | active | web/src/components/layout/* |
| C5 | 实时/权限按团队收敛（task 维度订阅移除） | active | web/hooks/use-realtime.ts |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

## Findings (cited - path:lines)
- board/page.tsx:220-400 TaskCard onClick => router.push(/tasks/:id) 就是聊天页入口；卡片底部还有 enter-team-session 跳团队会话（混合）
- tasks/[id]/page.tsx: 3400+行，三栏：MembersPanel(224px) + MessageList + TaskPanel(300px, 含 TaskRightTabs 状态/配置/产出三 tab)
- teams/[id]/session/page.tsx:340行：常驻团队群聊（team_group 单例），左侧简化成员，中央消息区，无右侧面板
- teams/[id]/page.tsx: 团队详情页含 enter-team-session 按钮
- TaskPanel 右侧内容：状态(队列/记忆)、配置(执行模式/托管)、产出(产出物/Issue/计划)、任务信息编辑、ChannelBinding
- 当前无独立的 /tasks/:id 详情页（非聊天），去聊天化后需新建或复用

## Decisions (with rationale)
- D1 任务点击去向 = 抽屉/弹窗详情（用户选择）：看板/列表卡片 onClick 不再 router.push(/tasks/:id) 聊天页；改为 Board 侧抽屉展示任务详情（状态/标题/描述/主Agent/团队/产出物/Issue/计划/状态操作），保留列表上下文；深度编辑仍可跳 /tasks/:id 详情路由但该路由不再含聊天
- D2 团队会话右侧菜单 = 复用现有 TaskRightTabs 三Tab（状态/配置/产出）+ 队列/记忆卡片，数据源切 team.currentTaskId 驱动（用户选择）
- D3 团队会话功能补齐 = 除任务强绑定（taskId 单例）外的全部任务聊天能力回补：私聊会话 Tabs（含 /dm-channels teamMember 维度）、Agent 模型选择/启用/重置、MembersPanel 完整交互、Question/IssueDetail/TaskEdit 弹窗、resize 拖拽、实时 scope 收敛到 team+channel（用户补充）
- D4 清理原则（新增）= 不兼容不兜底不做AB：删掉功能的代码彻底清理（无 feat flag、无 legacy 分支、无 fallback 兼容），死代码/无用 import/注释掉的兜底一并移除；异常必须日志（console.error/logger）禁止空 catch 吞错

## Scope IN
- 看板 TaskCard 去聊天化：onClick 改抽屉，移除「进入会话→团队会话」混淆保留但仅在抽屉内显式入口
- /tasks/:id 路由剥离聊天：保留任务详情+右侧面板，移除 MessageList/输入/SSE 聊天区；该路由仅作深度详情/编辑
- /teams/:id/session 功能对齐任务聊天页：MembersPanel 完整版（含 model chip/启用禁用/重置会话/添加实例）、私聊 Tabs(private:channelId)、可拖拽面板、Question/IssueDetail/TaskEdit/ReviewDialog 全部回补
- 右侧 TaskRightTabs 复用到团队会话：以 team.currentTaskId 驱动 artifacts/issues/plans 查询，队列+记忆卡片保留
- 导航清理：board/team detail 仅保留团队会话入口
- 代码清理（新增）：删掉功能的相关代码彻底移除（无兼容/AB/兜底分支），无用 import/type/常量/旧 channel 查询一并清理；所有 catch 必须日志（logger.error / console.error + 上报），禁止空 catch

## Scope OUT (Must NOT have)
- 保留 /tasks/:id 中央聊天区双写（必须剥离，不做团队+任务双群）
- 团队会话内再嵌任务创建/编辑表单（仍走 /tasks/new?teamId=）
- 团队内并发多任务会话（仍 FIFO 单队首）
- 为删掉功能保留兼容/兜底/AB 分支、注释掉的旧代码、空 catch 吞错

## Open questions
- 已全部收敛（Q1=抽屉、Q2=三Tab、新增=功能对齐任务聊天页）

## Approval gate
status: approved
approach: 看板任务卡片去聊天化改为抽屉详情；/tasks/:id 剥离聊天仅留详情；团队会话对齐任务聊天页功能（私聊/模型/成员操作/弹窗/三Tab右侧+队列记忆），数据源切 team.currentTaskId，彻底清理不做兼容
pending-action: done
<!-- Plan created after approval at .omo/plans/task-team-chat-separation.md -->
