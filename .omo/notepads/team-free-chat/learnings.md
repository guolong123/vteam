# Learnings — team-free-chat

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-09-06T00:30Z] Preflight: stock workspace commit split
66 modified + 69 untracked from prior completed-but-uncommitted sessions. No secrets in tree. Split into ae3ddba (server/worker), 6277ce5 (web), ca43396 (docs/.omo plan). Left ?? CHANGELOG.md untracked (generated). Evidence: .omo/evidence/team-free-chat/task-0.log.

## [2026-09-06T01:10Z] Task: todo-1 (execution context data model)
- prisma validate + tsc --noEmit clean after schema change; prisma generate required before tsc sees new delegates (teamUserMember).
- Local migrate deploy needs compose DB via IP (192.168.97.2:3306, root/aiagents-root, no host port mapping); localhost:3306 unreachable (P1001). Use DATABASE_URL env override, never edit server/.env.
- Bare UNIQUE(team_id, team_member_id) is undeployable against real data: seed has 5 members x 6 tasks = 30 sessions (one per task per member), first deploy failed P3018/1062 on backfill UPDATE. Fixed via STORED generated column team_member_key (CASE WHEN task_id IS NULL THEN CONCAT(team_id,'|',team_member_id) ELSE NULL END) + UNIQUE uk_sessions_team_member on it — same technique as 20260901000004 team_group_key. Manual DDL rollback + `migrate resolve --rolled-back` required before re-deploy (MySQL DDL is non-transactional; partial queries 1-14 persisted).
- Post-deploy: sessions.team_id backfilled 30/30, 0 unattributable rows; uk_sessions_task_agent untouched; jest teams.service.spec 55/55 pass.
- Spec mocks: every hand-built create-path tx object needs teamUserMember.create stub or create throws TypeError (mockCreateTx + 3 inline tx + onModuleInit seed assertion for 'tum').

## [2026-09-06T01:25Z] Task: todo-1-fix
- Generated-column uniques must be declared in schema.prisma as plain `String? @map(...)` + `@@unique([field])` (ChatChannel.teamGroupKey precedent); declaring the logical bare `@@unique([teamId, teamMemberId])` instead leaves schema-vs-DB drift that a future `migrate diff` would turn into an undeployable bare UNIQUE (1062 on seed data). Schema-file-only fix, no migration.
- Out-of-scope hygiene: verify `git ls-files` before rm vs checkout for stray files (CHANGELOG.md was untracked → rm safe); restore plan files with `git checkout --` and confirm empty status for those paths.

## [2026-09-06T00:53Z] Task: todo-4 (team-free-chat MCP: taskId optional + task_create + my_projects)
- Zod `.refine()` on object schemas keeps `shape` readable (planReviewSchema precedent) so `zodObjectToJsonSchema` required-derivation is unaffected; use refine for "taskId|teamId at least one" and keep the message containing 'taskId' (controller.spec asserts it on -32602).
- Making a field optional breaks exact-match spec expectations (`toEqual([...required])`, `toHaveBeenCalledWith` data shapes) — update the contract specs in the same change (controller.spec 26→28 tools, required arrays, my_projects exemption).
- Pre-existing red tests proven via `git stash push -- <my files>` + rerun on pristine tree: group_post message.create `taskId` expectation and tasks findAll `overrideModelId` expectation were already stale; synced expectations (service behavior correct), no runtime change.
- `Block comment` text must never contain `/`-joined `*_*/` fragments (`issue_*/plan_*` closes the comment → TS1005 cascade); use `、` separators in comments.
- TasksService.createByAgent shares create()'s transaction body via private `createTaskInternal(pid, dto, teamId, {createdBy, actorType})`; user path keeps projectMember check, agent path keeps project-existence check + skips it (pid allow-set gate lives in MCP service).

## [2026-09-06T02:00Z] Task: todo-2 (team membership guard + channel access + users endpoints)
- TeamMembershipGuard mirrors project guard minus Reflector/metadata branch (no team-id.decorator exists; strict touch-only-listed-files rule forbids creating it) — resolves teamId from route :id + :taskId fallback, looks up teamUserMember by teamId_userId, 403 reuses PERMISSION_PROJECT_NOT_MEMBER code.
- resolveChannelAccess stub-branch fix is branch-order safe: old tests all hit the task-found branch (allowAccess mocks task.findFirst), so only the no-task stub changed; verified 152/153 before, then 153/153 after.
- Pre-existing red: chat.service.spec ensureTeamChannel reuse case failed on clean tree too (peer-added teamGroupKey patch branch vs update mock returning undefined). Spec-only fix in allowed file: default chatChannel.update mock echoes where.id; all other update assertions per-test mockResolvedValue so unaffected.
- chat.service.spec prisma mock now needs teamUserMember.findUnique (default member) or any stub-branch test throws TypeError; teams.service.spec prisma mock needs user.findUnique + teamUserMember.findUnique/delete.
- TEAM_ERRORS additions: USER_NOT_FOUND + USER_ALREADY_MEMBER (409 on duplicate, not 500); removeUserMember missing membership reuses MEMBER_NOT_FOUND 404.
- Evidence: .omo/evidence/team-free-chat/task-2.log (jest 153/153 + tsc clean + own-files git status).

## [2026-09-06T00:44Z] Task: todo-5 (前端零任务直聊加固)
- session page 零任务路径走查：queries :127-214 已全部 enabled 门控、scope :415 已条件化、idle :977 已存在、发送 :597 已省略空 taskId——四处均无需改；实修仅两处：header `team.members/queue.length` 加 `?? []`（后端未返字段即 crash），发送失败加 `sendError` 行内行（`team-session-send-error`，无 router push、无弹窗）。
- 私聊 Tab/右侧三 Tab 零改动；TeamMembersPanel 对 undefined 回调已 `?.` 自保，零任务传 undefined 即只读，无需动。
- TeamDto.userMembers 已由 Todo 1 加入 web/src/api/teams.ts（TeamUserMemberDto id/userId/role/joinedAt），本任务验证后跳过。
- 本地 :13000 后端早于 Todo 1（新建团队无 userMembers、无 team_group 频道），真机 zero-task 用例本地必停在 team-session-empty——这是正确降级（快照无崩溃）， grading 需 Todo-1 后端。用 route 桩临时验证通过后即删桩、留截图为证。
- 种子 tm_0000000002 无频道（建于自动建频道之前），zero-task 夹具必须全新创建团队（创建者即 owner），不可复用种子；DELETE /teams/:id 对无任务空队列团队可用，测试自清理；本地 web dev 需 API_PROXY_TARGET=http://localhost:13000。

## [2026-09-06T09:00Z] Task: todo-6 (团队用户成员管理极简前端)
- 后端 toTeamDto 的 userMembers 仅 {id,userId,role,joinedAt}（无 username），故列表展示 userId（mono）/role（中性 pill)/joinedAt；GET /users?search 存在但挂 AdminGuard 且前端无 usersApi，按任务书降级为「用户 ID 输入框」，不发明端点（e2e 仅用它解析 seed-member 的 userId）。
- 独立组件 web/app/(main)/teams/[id]/user-members.tsx（UserMembersSection：自有 useMutation + 行内 error state + invalidate ["team",id]/["teams"]），page.tsx 仅 +import 与一行挂载（`team.userMembers ?? []` 兼容旧后端），Agent 成员区零触碰；MemberRow 视觉语言复用（同款 row 容器/pill/✕ 按钮 + theme tokens，零硬编码色）。

## [2026-09-06T01:03Z] Task: todo-3 (Dispatcher team-mode 无任务执行)
- DispatchRequest 不动（message-dispatcher.ts 零触碰）：team-mode 判定 = `!request.taskId`（空串），teamId 经 `DispatchRequest & {teamId?}` 扩展字段透传，Todo 7 调用侧 cast 传入即可；task-mode 签名与分支字节级保持。
- 执行键隔离零签名变更：公有 register/unregister/isAgentExecuting 签名不变，team-mode 调用侧传 `team:<teamId>` 作用域（toExecutionScope 导出供测）；taskId 形如 t_ 前缀永不与 team: 碰撞。
- ensureTeamSession 查 teamMemberKey 唯一键（值为 `teamId|teamMemberId`，与 migration STORED 生成列表达式一致），bindSessionToWorker team 分支 findFirst/create 精确走 (teamId, teamMemberId, workerId, instanceId) 且 taskId 置空；旧 task-mode create/findFirst 断言为精确匹配，task 分支一字未动。
- 主门一致性：dispatcher team-mode isMainAgent = session.teamMemberId === team.mainAgentMemberId（与 platform-mcp taskCreate 团队维度门逐字一致，无 ta_ 映射、无回退）；触发选择 resolveTeamMainTrigger 语义对齐 chat.service buildMainAgentTrigger 团队分支（有 mainId 则取成员否则首位，悬空不回退首位）。
- execute 不带 taskId（ExecuteOptions.taskId 可选，omit 后 worker.client.ts 零改动）；回流经 ingress 归一后 sessionId 反查团队会话走团队路径，落库 taskId 置空、senderInstanceId=成员。
- 接待话术含 my_projects/task_create 工具名 + 禁 QuestionModal（/禁止.*QuestionModal/ 断言）；task-mode 字节不变用替换关系式断言（teamOut == base 插入接待段）。
- 预存红：全量 jest 7 套件/30 用例红，经 git stash 4 文件 + 洁树重跑同数红证伪（peers 在途：seed/docs-mirror/agent.constants/workers/models/git-repos），与本任务无关。
- 证据：.omo/evidence/team-free-chat/task-3.log（159+185 绿 + tsc + 4 文件 status）。
- 运行 :13000 后端早于 Todo 1/2（GET team 无 userMembers 键，POST /teams/:id/users 报 Cannot POST 404）：e2e team-user-members 在添加步止于行内错误属预期，按任务书注记证据、不 hack UI；真机走查反而实证了失败路径（行内错 + 无导航 + Agent 区完好），截图 task-6-section/inline-error.png；tsc clean + workspace 后端代码对照即验证。
- playwright.config.ts 新增 team-users project（testMatch team-user-members.spec.ts + storageState + setup 依赖），`-g"team-user-members"` 可直跑；新 spec 内嵌登录/建团队/解析 userId/清理全流程，不碰 peers 在改的 pages.spec.ts。

## [2026-09-06T09:30Z] Task: todo-7 (收尾验证全链路冒烟)
- 鲜度门：compose server 镜像早于工作区（GET team 无 userMembers + POST users 404 即 stale）；`docker compose build server && up -d` 重建后断言通过才开测。migrate deploy 无 pending（Todo-1 已部署到 compose MySQL 192.168.97.2:3306）。
- B1 生成列写入：team_group_key 系 GENERATED ALWAYS，5 处显式写 teamGroupKey（teams/chat/tasks/platform-mcp）全报 MySQL 3105；teams 侧被 try/catch 吞掉致新团队无频道（零任务页 team-session-empty）。修法：删显式写、保留读；schema.prisma 声明不动（Todo-1-fix 先例）。
- B2 零任务无分派：createMessage 仅 task 锚定才建主触发 + dispatch 不带 teamId → targets=[] 空转。修法：team-mode 默认主触发（复用 dispatcher.buildTeamMainTrigger，主门/会话语义单源）+ `...(!dispatchTaskId && channel.teamId ? {teamId} : {})` cast 透传；task-mode 分支零触碰。chat.service.spec + worker-dispatcher.spec 218 绿。
- B3 task_create 活体 500：tasks.created_by FK→users，实例 id 非用户行。修法：createByAgent 用团队用户成员（owner 优先）落 createdBy，实例归属走新 opts.actorId（taskEvent + 广播；缺省=createdBy，用户路径字节一致）。platform-mcp/task_create 成功用例签名不变（'p_2','tmm_main'）。
- 烟雾脚本经验：macOS 系统代理污染 urllib（curl 正常）→ ProxyHandler({}) 直连；bg dispatch 会抢占 (team,member) 会话（uk_sessions_team_member 1062）→ 复用现行 workerId 而非重插；sessions.updated_at 无默认值 → 显式 NOW(3)；清理顺序 messages→tgi(task)→sessions(task)→events→agents→tasks→tgi(member)→sessions(team)→queues→userMembers→channels→members→teams→workers（main/current 先 NULL）。
- e2e：zero-task/7b 一次过；team-user-members 需 spec-only 修（创建者 auto-owner，空态断言改 owner 行断言）。web dev 会 wedged（全路由 500，/login 亦然）→ 重启解决，重跑三用例全绿。DELETE /teams 对有 userMember/会话的团队 500（remove 无级联，FK 止）→ 烟雾/e2e 清理走 SQL sweep，API 仅做 404 校验。
- 基线：full jest 7 套件/30 用例红 == 已知基线（seed/agent.constants/docs-mirror/workers/models/git-repos），无新增；web build 绿。
- 证据：.omo/evidence/team-free-chat/task-7.log（20/20 矩阵 + 审计 + 基线）+ task-7-zero-task.png + task-7-user-members.png。

## [2026-09-06T10:05Z] Task: todo-7-fix (零空 catch 三件套)
- chat B2 触发 catch 与 ensureTeamWorkDir mkdir catch 改 log-only（error/warn + 上下文），语义零变：失败仍空 triggers / 仍返 dir。
- ensureTeamSession findUnique-then-create 非原子：并发双分派同键 create 必有一方 P2002（task-7.log duplicate entry 实证）。修法：catch 内判 code==='P2002'（platform-mcp ensure 系同风格）→ warn + 同 tx 重读胜者行 reused:true；重读 miss 则重抛原错（不吞非竞态错）。spec 用 mockRejectedValueOnce(P2002)+findUnique 两次分辨验证。
- session-lifecycle 原无 Logger：补 `new Logger(SessionLifecycleService.name)`（@nestjs/common 同文件 import）。

## [2026-09-06T10:20Z] Task: todo-7-fix2 (addUserMember P2002 → 409)
- findUnique-then-create 非事务竞态同 ensureTeamSession 模板：catch 判 code==='P2002' → warn（含 team/user）→ 重读确认 → 命中报既有形 409，miss 重抛。catch-only，不包 tx、不动逻辑。

## [2026-09-06T01:45Z] Task: commits (layered, per-Todo split impossible)
- Todos 1-4+7 share server files (teams/chat/dispatcher/mcp/tasks/lifecycle overlap hunks) — file-level per-Todo split would be dishonest. Committed as layers: c1779d3 feat(server) all backend (todos 1-4,7 incl. B1/B2/B3 + P2002 races), c24e44a feat(web) zero-task session (todo 5), 2c84962 feat(web) team user members UI (todo 6). Evidence logs/pngs are git-ignored (*.log, .omo/evidence/**/*.png) — not committed by design.
