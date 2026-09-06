---
slug: team-centric-session
status: drafting
intent: clear
review_required: true
pending-action: write .omo/plans/team-centric-session.md
approach: 将会话入口从任务为核心改为团队为核心，新建团队常驻会话页 /teams/:id/session，状态 Tab 改为任务列表（当前任务+排队），不再走任务进入会话
plan_path: .omo/plans/team-centric-session.md
plan_sha256: null
review_round_id: null
review:
  momus:
    status: pending
    target: .omo/plans/team-centric-session.md
  independent:
    status: pending
    target: .omo/plans/team-centric-session.md
---

# Draft: team-centric-session

## Components (topology ledger)
| id | outcome | status | evidence path |
| --- | --- | --- | --- |
| team-session-route | 团队常驻会话路由与页面 | active |  |
| status-tasks-tab | 状态 Tab 改为任务列表（当前+排队） | active |  |
| nav-redirect | 导航与重定向（任务→团队会话） | active |  |
| realtime-team | 团队会话实时与权限 | active |  |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| 会话路由 | /teams/:id/session 常驻，/tasks/:id 保留产出/配置但群聊入口隐藏或 302 跳团队会话 | 团队一群已落地，群聊按 teamId 复用，与当前任务解耦 | 是 |
| 状态 Tab 内容 | 当前任务（队首）+ 等待队列（FIFO，可取消） | 复用 TeamQueueCard 逻辑，taskId 改为 team.currentTaskId 驱动 | 是 |
| 配置与产出 | 保持三 Tab 结构，状态=任务列表，配置=记忆/托管/渠道，产出=任务详情/产出物/Issue/计划 | 与现有三 Tab 一致，仅左 Tab 内容换为任务列表 | 是 |
| 兼容 | 旧 /tasks/:id 群聊入口隐藏，保留 302 跳转与双订阅过渡 | 避免外链与书签断裂 | 是 |

## Findings (cited - path:lines)
- web/app/(main)/tasks/[id]/page.tsx:3377-3394 频道定位 GET /channels?teamId (team_group) 已按 teamId，任务页仍以 taskId 为路由入口
- web/app/(main)/teams/[id]/page.tsx:67-387 团队详情页已有 TeamQueueCard 逻辑，可复用
- web/src/api/teams.ts:31 TeamDto 含 currentTaskId/queue/members/mainAgentMemberId
- server/src/teams/teams.service.ts:189 findAll 含 queue，server/prisma/schema.prisma Team/TeamQueue/ChatChannel teamId
- docs/agent-platform/28-团队模型与排队设计.md 团队一群与排队设计已落地

## Decisions (with rationale)
- 新建团队会话页而非在任务页内嵌：路由清晰，群聊常驻，切换任务不切群
- 状态 Tab 即任务 Tab：当前任务（队首）+ 等待队列，避免再以任务为容器
- 任务页群聊入口移除或跳转：不再走任务进入会话，统一团队入口

## Scope IN
- 新建 /teams/:id/session 会话页（复用群聊区、输入、实时、渠道绑定）
- 状态 Tab 改为任务列表（当前任务 + 排队任务列表，可取消，仅 queued 可操作）
- 导航：看板/列表/团队详情的“进入会话”全部指向 /teams/:teamId/session，/tasks/:id 群聊入口隐藏或 302
- 实时：团队会话按 teamId 订阅 team: + channel:，权限按 team 成员

## Scope OUT
- 任务内并发多任务
- 跨团队会话
- 旧 /tasks/:id 群聊的双写兼容（仅 302 过渡）

## Open questions
- 会话页是否需展示团队下所有任务的历史切换（下拉）还是仅当前+队列？默认仅当前+队列
- 产出/配置是否仍在团队会话页展示还是保留在任务页？默认保留在任务页，团队会话仅聊与状态

## Approval gate
status: drafting
