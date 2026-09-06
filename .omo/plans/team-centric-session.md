# team-centric-session - Work Plan

## TL;DR (For humans)

**What you'll get:** 会话入口从 `任务` 切到 `团队`：团队详情新增常驻会话页 `/teams/:id/session`，群聊按团队复用不随任务切换；左侧状态 Tab 改为“任务”列表（当前执行队首 + 等待队列 FIFO 可取消），不再走任务进入会话。

**Why this approach:** 复用已落地的 `team_group` 单例与 `TeamQueue` 排队，路由清晰、群聊常驻、切换任务不切群；任务页保留产出/配置，仅群聊入口迁移。

**What it will NOT do:** 不支持团队内并发、不做跨团队会话、不保留旧任务群聊双写（仅 302 过渡）

**Effort:** Medium
**Risk:** Medium - 路由与状态 Tab 重排涉及导航与实时订阅
**Decisions to sanity-check:** 团队会话常驻 `/teams/:id/session`；状态 Tab 即任务列表；旧 `/tasks/:id` 群聊 302 跳转

Your next move: 批准后双审。 Full execution detail follows below.

---

> TL;DR (machine): Medium effort, Medium risk, deliverables: 团队常驻会话页 + 状态 Tab 任务列表 + 导航重定向

## Scope
### Must have
- 新建 `web/app/(main)/teams/[id]/session/page.tsx` 常驻团队会话（复用群聊区、输入、实时、渠道绑定、`team_group` 单例）
- 状态 Tab 改为任务列表：当前任务（队首，`team.currentTaskId` 驱动，可开始/进行中/待验收）+ 等待队列（FIFO，`TeamQueue` 可取消，仅 `queued`）
- 导航统一：看板/列表/团队详情的“进入会话”全部指向 `/teams/:teamId/session`，`/tasks/:id` 群聊入口隐藏或 302 跳至所属团队会话
- 实时：团队会话按 `teamId` 订阅 `team:` + `channel:`，权限按团队
- 复用 `TeamQueueCard` 逻辑，`taskId` 改为 `team.currentTaskId` 驱动

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 团队内并发多任务
- 跨团队会话
- 旧 `/tasks/:id` 群聊的双写兼容（仅 302 过渡）
- 在团队会话页内再嵌任务创建/编辑（仍走 `/tasks/new?teamId=`）

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + 浏览器冒烟；框架 jest + Playwright
- Evidence: `.omo/evidence/team-centric-session/task-<N>.log` + screenshots

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- Wave 1: 路由与页面骨架（Todos 1-2）
- Wave 2: 状态 Tab 任务列表与导航（Todos 3-4）
- Wave 3: 收尾与验证（Todos 5-6）

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | - | 2,3 | - |
| 2 | 1 | 3,4 | - |
| 3 | 1,2 | 5 | 4 |
| 4 | 1,2 | 5 | 3 |
| 5 | 3,4 | 6 | - |
| 6 | 5 | - | - |

## Todos
- [x] 1. 新建团队常驻会话路由与页面骨架
  What to do / Must NOT do: 新建 `web/app/(main)/teams/[id]/session/page.tsx` 复用 `web/app/(main)/tasks/[id]/page.tsx` 的群聊区（`ChatHeader`、`MessageList`、`MessageInput`、`useRealtime` 等），按 `teamId` 取 `team_group` 单例（`GET /channels?teamId`），消息按 `teamId` 分区；Must NOT 仍按 `taskId` 取频道
  Parallelization: Wave 1 | Blocked by: - | Blocks: 2,3
  References (executor has NO interview context - be exhaustive): web/app/(main)/tasks/[id]/page.tsx:3377-3400, web/src/api/teams.ts:31, server/src/chat/chat.service.ts:173
  Acceptance criteria (agent-executable): `GET /teams/:id/session` 可渲染团队群聊，`GET /channels?teamId` 返回唯一 `team_group`
  QA scenarios (name the exact tool + invocation): happy: `npx playwright test` 打开团队会话页可见群聊；failure: 无 teamId 404；Evidence .omo/evidence/team-centric-session/task-1.log
  Commit: Y | feat(web): team session page skeleton

- [x] 2. 会话按团队复用（消息与实时）
  What to do / Must NOT do: 会话按 `teamId` 复用，`channel.teamId` 单例，`Message.taskId` 分区保留，`POST /channels/:id/messages` 按 `teamId` 分区落库，`realtime` 订阅 `team:` + `channel:`；Must NOT 按 `taskId` 重建群聊
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3,4
  References: server/src/chat/chat.service.ts:730, server/src/tasks/task-progression.scheduler.ts, web/hooks/use-sse.ts
  Acceptance criteria: 同团队两任务共用一群历史，切任务不切群
  QA scenarios: happy: 发消息后 GET /channels?teamId 消息可见；failure: 跨团队不串台；Evidence .omo/evidence/team-centric-session/task-2.log
  Commit: Y | feat(chat): team session reuse

- [x] 3. 状态 Tab 改为任务列表（当前+排队）
  What to do / Must NOT do: 状态 Tab 改为“任务”列表：当前任务（`team.currentTaskId` 驱动，`TeamQueueCard` 逻辑，`taskId` 改为 `team.currentTaskId`）+ 等待队列 FIFO（`TeamQueue` 可取消，仅 `queued`），不再以任务为容器；Must NOT 再以 `taskId` 为状态容器
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 5
  References: web/app/(main)/tasks/[id]/page.tsx:2969 TeamQueueCard, web/src/api/teams.ts:45
  Acceptance criteria: 状态 Tab 显示当前任务（队首）与等待队列，队列可取消，非队首不可开始
  QA scenarios: happy: 建 B queued 后状态 Tab 可见；failure: 非队首 start 409；Evidence .omo/evidence/team-centric-session/task-3.log
  Commit: Y | feat(web): status tab task list

- [x] 4. 导航统一与重定向
  What to do / Must NOT do: 看板/列表/团队详情的“进入会话”全部指向 `/teams/:teamId/session`，`/tasks/:id` 群聊入口隐藏或 302 跳至所属团队会话（`GET /tasks/:id` 取 `teamId` 后 `router.replace`）；Must NOT 保留旧任务群聊入口双写
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 5
  References: web/app/(main)/board/page.tsx, web/app/(main)/teams/page.tsx, web/app/(main)/tasks/[id]/page.tsx
  Acceptance criteria: 任何“进入会话”均到团队会话页，旧任务群聊入口 302
  QA scenarios: happy: 板卡点击跳团队会话；failure: 无 teamId 任务 404；Evidence .omo/evidence/team-centric-session/task-4.log
  Commit: Y | feat(web): nav to team session

- [x] 5. 实时与权限（团队会话）
  What to do / Must NOT do: 团队会话按 `teamId` 订阅 `team:` + `channel:`，权限按团队（`teams:view`），`findAccessibleChannels` 按 `teamId` 收敛；Must NOT 按 `taskId` 订阅
  Parallelization: Wave 3 | Blocked by: 3,4 | Blocks: 6
  References: server/src/realtime/realtime.controller.ts, server/src/chat/chat.service.ts:173
  Acceptance criteria: `GET /events?scope=team:tm_xxx` 可收到团队消息，`GET /channels?teamId` 越权 403
  QA scenarios: happy: 双订阅收到；failure: 越权 403；Evidence .omo/evidence/team-centric-session/task-5.log
  Commit: Y | feat(realtime): team session scope

- [x] 6. 收尾与验证（文档与测试）
  What to do / Must NOT do: 更新 `docs/agent-platform/28-团队模型与排队设计.md` 与 `README` 的入口说明，补充 `web build` 与 `npm run test --runInBand`；Must NOT 保留旧 “任务进入会话” 文案
  Parallelization: Wave 3 | Blocked by: 5 | Blocks: -
  References: docs/agent-platform/28-团队模型与排队设计.md, README.md
  Acceptance criteria: 文档与实现一致，`web build` 绿
  QA scenarios: happy: 文档可渲染；failure: 旧文案残留；Evidence .omo/evidence/team-centric-session/task-6.log
  Commit: Y | docs: team-centric session

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit — APPROVE: team session page exists, nav unified, status tab task list, docs updated
- [x] F2. Code quality review — APPROVE: build passes, tsc clean, lint warnings only, no stubs
- [x] F3. Real manual QA — APPROVE: /teams/:id/session renders, channel team_group singleton, SSE team+channel, 404 handling
- [x] F4. Scope fidelity — APPROVE: no team concurrency, no cross-team session, no taskGroup dual write, no inline task creation in team session

## Commit strategy
- 每 Todo 独立提交，`feat(web):` / `feat(chat):` / `feat(realtime):` / `docs:` 前缀

## Success criteria
- 访问 `/teams/:id/session` 可进行团队群聊，不随任务切换而重建
- 状态 Tab 显示当前任务（队首）与等待队列，可取消排队，非队首不可开始
- 任何“进入会话”均到团队会话页，旧任务群聊入口已隐藏或 302
- 实时按团队订阅，产出/配置保留三 Tab
