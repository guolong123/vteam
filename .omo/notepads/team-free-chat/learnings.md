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

## [2026-09-06T12:00Z] Task: deploy-verify (deployed :13001 serves new UI, green smoke, zero litter)
- Rebuild: `docker compose up -d --build web` (120s timeout insufficient — Next.js build needs ~3-5min; reran with 600s). New images: aiagents-web b7442399618d, aiagents-server d2f9cc01b6e6 (compose also rebuilt+recreated init/server as web deps — server recreated from current HEAD, same code, healthy). `docker compose ps`: web Up healthy (recreated 17s), server Up healthy (recreated 28s). db untouched (Up 24h), worker untouched. web :13001/login → 200, api :13000/docs → 200.
- Backend freshness: admin/admin123 login OK; GET /teams/tm_0000000001 contains `userMembers` key ([]) — FRESH, no server rebuild needed.
- Deployed-web smoke (real Chrome via Playwright, baseURL http://localhost:13001): playwright.config.ts baseURL is hardcoded `http://localhost:3001` with no env override → temp config `web/playwright.deploy-verify.config.ts` (copy of repo config, baseURL :13001 only; storageState reused web/.auth/user.json, setup re-logins so origin matches) + deleted after run; repo gains no scratch files. Results: setup login vs :13001 ✓; team-users add/remove roundtrip ✓ (1.4s); pages -g zero-task: no modal/selector, echo visible, send-error 0, currentTaskId null ✓ (1.3s). /tmp/dv-verify/playwright.config.ts kept only as reference (module resolution forces config inside web/).
- Cleanup: both smoke teams left behind (spec DELETEs 500 — non-empty teams have no cascade, known quirk): tm_0000000003 (userMembers test) + tm_0000000004 (zero-task: 1 session s_0000000031 + 2 messages). API DELETE → 500 ×2 as expected → SQL sweep via `docker compose exec -T db mysql` in FK-safe order (message_deliveries[channel_id]→messages→sessions→task_group_instances[team_member_id]→team_queues→teams.main_agent_member_id=NULL→chat_channels→team_user_members→team_members→teams). Note: message_deliveries is keyed by channel_id (no message_id col); teams.main_agent_member_id self-FK must be NULLed before member delete. Verify: GET both teams → 404; teams list = seed-only (tm_0000000001/02); leftover counts 0 across sessions/members/tum/channels/tgi; tasks total 6, p_seed_1 = 6 (DB ground truth; tasks API with projectId param returned 3 — param/pagination quirk, DB authoritative).

## [2026-09-06T13:20Z] Task: team-prompt-fix
- Team-vs-task prompt 隔离：team-mode 专用 TEAM_GROUP_TRIGGER_INSTRUCTION 与任务版 GROUP_TRIGGER_INSTRUCTION 并存，dispatchForTeamTarget 只推 TEAM 块；task-mode 调用点字节不动是回归网，任何 task-mode 红即隔离错误。
- Spec 断言写准“修的是什么”：doclib 在禁调清单里出现是正确的（F1），bug 只是上下文行的“建议调用”措辞（F2）——断言应锚定旧措辞 'chat_history / doclib' 而非裸词 'doclib'。
- resolveExecContext 守卫用 typeof+startsWith('tm_') 前置于 taskId 分支：task id 恒 t_ 前缀故安全；同传 teamId 时仍先 400（守卫优先于 taskId 优先语义，符合“传了必错”指引）。
- block 注释内忌 `issue_*/plan_*` 连写（`* /` 闭合注释致 TS1005 级联）——字符串常量内可用、注释内用顿号分隔。

## [2026-09-06T13:45Z] Task: team-prompt-fix-verify (compose server rebuild + live F4/e2e)
- Rebuild: first `docker compose up -d --build server` failed at `npx prisma generate` (exit 1, transient); retry `docker compose build server` OK (cached layers), `up -d server` → healthy. New image aiagents-server dd263d8774e2 (built 2026-09-06 13:25 +0800). db/worker/web untouched (db Up 25h, worker Up 25h). Freshness gate: GET /teams/tm_0000000001 contains `userMembers` → FRESH. `docker compose ps`: server Up healthy.
- F4 probe: POST /api/v1/platform-mcp (X-Worker-Token: compose-worker-token) `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"chat_history","arguments":{"taskId":"tm_probe_xxx"}}}` → `{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"[400] 团队会话请传 teamId，不要传 taskId（taskId 是任务 ID，t_ 前缀）"}}`. Exact guidance fires live.
- e2e (fresh team tm_0000000006 promptfix-verify-133103, owner auto-tum_0000000005, 1 member tmm_0000000016 a_product, no main → first-member fallback, channel c_0000000009): ⚠️ @all/@agent mentions in zero-task mode yield `no_session` triggers by design (resolveMentions, taskId-less branch) and are filtered out of dispatch targets — team-main auto-dispatch (buildTeamMainTrigger) only fires on mention-free posts. Post m_0000000007 (no mentions, asks to call chat_history) → trigger dispatched, session s_0000000033 (team, taskId NULL, worker w_compose_worker, instanceRef set). Worker ran opencode ses_f8ac7ab41ffepOwHbxwuD7lfqA taskId=- (05:37:01→05:37:29Z), reply m_0000000009 landed.
- Live guard proof in agent parts (m_0000000008): `vteam_chat_history {taskId: tm_0000000006}` → error `MCP error -32602: [400] 团队会话请传 teamId…` (×2), then self-correct `vteam_chat_history {teamId: tm_0000000006}` → completed. Server platform-mcp 05:37–05:38 window: 13×200 / 9×202 / 4×405, zero -32003 in 60m logs (`grep -c 32003` = 0). Old taskId=tm_ 403 pattern gone; prompt+guard loop closes within one run.
- Side observation (out of scope, no fix): GET /channels/:id/trigger-results/:messageId on zero-task message 500s — getTriggerResults calls taskAgent.findMany with taskId null (Prisma validation). Poll path only; createMessage path unaffected.
- Cleanup: DELETE /teams/tm_0000000006 → 500 as expected → FK sweep (message_deliveries→messages[5]→sessions[1]→tgi→queues→main NULL→channels→tum→members→teams). Verify: GET → 404 TEAM_NOT_FOUND; leftovers 0; tasks total 6, p_seed_1 = 6. teams list = tm_0000000001/02 + tm_0000000005 (pre-existing, created 03:50Z by u_admin — NOT mine, untouched). No commits.

## [2026-09-06T14:00Z] Task: team-mention-fix
- getTriggerResults 500 根因与 prompt-fix 的 F4 探针正交：createMessage 早被 B2/prompt-fix 修成团队分支降级（no_session），唯独轮询端仍直查 taskAgent.findMany({taskId: null})。STEP 0 双探针是分水岭：poll 红（修）+ post 绿（不动），避免把好的 createMessage 改坏。
- 生产 Prisma 行为要在 jest 里复现，必须让 mock 按真实校验抛错（必填 String 列传 null 即 throw）；裸 mockResolvedValue 会把 500 掩成绿。faithful-throw mock 是这类维度污染 bug 的标准复现手法。
- 既有 getTriggerResults task-mode 用例的 channel fixture 实为团队行（teamId 有、taskId null）——mock 时代蒙混过关，维度分支落地后必须换成 taskGroupRow（taskId 非空）才能继续覆盖 task 路径；只换 fixture、不碰断言，回归网效力不变。
- TeamMember 无 removedAt/enabled（schema 已核，Agent 表亦无）：团队分支 removed/disabled 检查只能是防御性透传，真实行恒走会话查询；agent_removed 团队用例靠 mock 行携带 removedAt。
- 新增分支一律走 select 常量（TEAM_MEMBER_SELECT 复用），绝不在 teamMember 上 select 不存在的列（Prisma 校验同样 500）。

## [2026-09-06T05:52Z] Task: mention-fix-closeout
- Scope gate: `git status --short` showed ONLY the 6 fix files + .omo churn (boulder.json, learnings.md) — no secrets, proceed.
- Rebuild: `docker compose up -d --build server` (server only) → image aiagents-server 8be02a9ddebb (built 2026-09-06 13:47 +0800). Freshness gate GET /teams/tm_0000000001 has userMembers (0) → FRESH. db/worker/web untouched.
- Live @-mention probe (fresh team tm_0000000006 mention-closeout-probe, owner auto-tum_0000000005, 2 members tmm_0000000016/a_product + tmm_0000000017/a_developer, channel c_0000000009): POST @all (text+mentions:[{type:all}]) → 201 with 2 resolved triggers (no_session ×2, zero-task by design); GET trigger-results/m_0000000005 → 200 with triggers array (was 500 — MENTION FIX LIVE). Mention-free post m_0000000006 → 201 dispatched (session s_0000000033); worker ran and replied m_0000000008 calling chat_history with teamId (no 403 — PROMPT FIX LIVE). F4 regression: platform-mcp chat_history taskId=tm_probe_xxx → JSON-RPC -32602 `[400] 团队会话请传 teamId…` guidance intact.
- Note: CreateMessageDto takes `text` (not `content`) — first probe POST 400d on wrong field; corrected, no code impact.
- Commit 075d710 `fix(server): team-mode agent prompts and mention triggers` on top of 3a7c665 (exact 6 paths staged, +334/-13). .omo churn left uncommitted. No push.
- Cleanup: DELETE /teams/tm_0000000006 → 500 as expected → FK sweep (message_deliveries→messages[4]→sessions→tgi→queues→main NULL→channels→tum→members→teams). Verify: GET → 404 TEAM_NOT_FOUND; leftovers 0/0/0; teams = tm_0000000001/02 + tm_0000000005 (pre-existing, untouched); tasks total 6, p_seed_1 = 6.

## [2026-09-06T08:00Z] Task: autorefresh-fix (zero-task team SSE drop)
- Scope verdict (live, pristine HEAD): breakage is ZERO-TASK-TEAM-ONLY, group + private. Tasked teams + task-mode unaffected (tasked private msg arrived on scope=all). No stash test needed for scope: tree was pristine and deployed image == HEAD (server rebuilt 13:47z from 075d710).
- Root cause (server-only, frontend keys were correct): frontend singleton uses scope=all; controller gates scope=all by project membership and drops projectId=null events. toMessageDto carries NO taskId, so resolveProjectIdOfEvent returns null for any team channel without a resolvable task (zero-task: channel.taskId null → message.taskId absent → team.currentTaskId null → no tasks at all → null). Both channel- and team-scope chat.message.new dropped before reaching useSSE → manual refresh only. Prior fixer patched only the tasked path (currentTask fallback comment in code); zero-task left null.
- Failing-first: curl SSE scope=all + POST group msg on fresh zero-task team (tm_0000000007/c_0000000011, @all → no_session, no dispatch) → 201 but ZERO frames (heartbeat proved connection alive). Control: same on tasked team → delivered. Second find: explicit scope=channel:<team-channel> → 500 (resolveProjectId task.findUnique(id:null) throws; pre-existing, off the UI path, left untouched + noted).
- Fix (server, 2 files, task-mode byte-identical): RealtimeEvent += in-memory teamId (never persisted — create data untouched — never serialized — toMessageEvent picks fields); emitOnce attaches via resolveTeamIdOfEvent (team scope → scopeId; channel scope → channel.teamId); subscribe/getEventsSince accept visibleTeamIds; live + backlog share passesVisibility (project OR team; both null = unfiltered, preserving explicit-scope callers). Backlog: main query untouched (DB-authorized rows pass through), team candidates via second query (team scopeId in teams OR channel projectId null) merged + JS-trimmed + id-sorted + deduped. Controller scope=all resolves teamUserMember → teamIds. OR semantics only widen zero-task delivery; project path and non-member drops unchanged.
- Live proof (rebuilt server only, image healthy): 4/4 cells on scope=all — zt-group 2 frames (channel+team, owner tum), zt-private 2 frames, tasked-group user msg 1 frame + 13 agent reply frames + 40 message.part.delta (5 @all triggers dispatched, worker ran), tasked-private 1 frame. Integrity note: tasked-team team-scope dup correctly dropped for admin (no tum in tm_0000000001) while channel-scope passed via project — membership gating works as designed.
- Specs: realtime.service.spec + controller.spec (+6 cases: member/non-member live, tasked unchanged, backlog merge + non-member trim, controller member/non-member e2e). Failing-first via stash of the 2 source files: new specs red (TS2554 + 0 calls), pop → 65/65 green + tsc clean.
- Cleanup: messages m_0000000014–m_0000000033 deleted; tm_0000000007 fully swept (channels/tum/members/team); teams back to tm_0000000001/02/05; 0 leftover sessions; deliveries were 0 rows (untouched); realtime_events log left append-only (precedent). No commits.
- Known adjacent gaps (NOT fixed, out of scope): explicit channel: subscription on team channels 500s (should 403-or-allow via team membership); team-mode agent.loading carries taskId=`team:<id>` which matches neither task: nor team: frontend filters (loading spinner stays silent in team-mode; messages unaffected).

## [2026-09-06T08:01Z] Task: autorefresh-closeout
- Commit bba828b `fix(server): scope=all SSE delivers zero-task team events` (4 realtime files, +416/-11) on top of 075d710. 4-cell live regression (zt-group/zt-private/tasked-group/tasked-private) + non-member negative all PASS, litter swept, p_seed_1=6. No push.

## [2026-09-06T10:48Z] Task: seed-owner-fix
- Gap: seed.ts upserts team tm_0000000001 + 5 teamMembers directly (bypasses TeamsService.create, so no owner row, no team_group channel) → clean DB has 0 team_user_members → Todo-2 guard 403s every human post.
- Fix (server/prisma/seed.ts +13 only, after teamMember loop): `prisma.teamUserMember.upsert({where:{teamId_userId:{teamId:seedTeamId,userId:admin.id}},update:{},create:{id:'tum_0000000001',role:'owner',joinedAt:new Date()}})` — unique input name `teamId_userId` verified from schema @@unique([teamId,userId]) + teams.service.ts usage; `admin` is the seed-admin row (u_seed_admin, :80). Comment kept: explains seed-vs-create parity (necessary, not decorative). tsc --noEmit clean (LSP declined by user, tsc authoritative).
- Apply: full `npm run seed` with DATABASE_URL override mysql://root:aiagents-root@192.168.97.2:3306/aiagents (never .env), exit 0; ran TWICE (2nd proves idempotency, tum stays 1). Counts before→after: teams 1=1, users 3=3, tasks 0=0 (fresh DB), tum 0→1. No containers touched.
- Live proof: (1) GET /teams/tm_0000000001 as seed-admin shows userMembers=[{id:tum_0000000001,userId:u_seed_admin,role:owner}]. (2) Seed creates NO channels (verified: chat_channels empty; seed never did — orthogonal gap, out of scope), so proof fixture = one SQL-inserted team_group channel c_0000000001 (generated team_group_key auto = tm_0000000001): GET /channels?teamId lists it; seed-member POST → 403 PERMISSION_PROJECT_NOT_MEMBER "您不是该团队成员" (negative control = pre-fix symptom); seed-admin POST {text,mentions:[{type:all}]} → 201 m_0000000001, 5× no_session triggers (zero-task by design, no worker dispatch/litter).
- Cleanup: DELETE messages m_0000000001 → DELETE channel c_0000000001 (deliveries 0, sessions 0 untouched); verify messages 0, channels 0, teams/users/tasks unchanged. Id c_0000000001 freed so runtime idGen (in-memory, reseeds from max on restart) cannot P2002. No commits.

## [2026-09-06T18:55Z] Task: mention-target-fix
- Dead-end shape: zero-task @-mention triggers are CORRECTLY no_session out of resolveMentions (no task session exists to find) — the bug is downstream, createMessage drops them before dispatch. Fix the link (ensure-then-flip in createMessage), not the chain (resolveMentions/dispatcher already handle both states).
- ChatService has NO SessionLifecycleService injection (prisma/idGen/realtime/workerClient/dispatcher only) — so the ensure helper lives on the dispatcher as public buildTeamMemberTrigger, mirroring buildTeamMainTrigger's ensure+return shape; missing member throws (no taskAgent fallback), session creation 100% reused from ensureTeamSession.
- Per-trigger try/catch with logger.error (never empty catch) doubles as back-compat: the old 1505 spec (mock dispatcher lacks the method) hits TypeError→caught→keeps no_session and stays green UNEDITED. New specs mock the method and assert dispatched.
- tmm_ prefix guard on instanceId before ensure: team targets use teamMemberId only; non-tmm triggers are skipped, never misrouted.
- Additive-only diff (+215/-0): task-mode byte-identical is proven structurally (fix block gated by !effectiveTaskId) plus a green-green regression spec (@ on tasked team still task-path, helper never called).
- Evidence: .omo/evidence/team-free-chat/task-7.log §mention-target-fix (red 2 failed no_session/null → green 230/230 + tsc exit 0). No commits.

## [2026-09-06T11:01Z] Task: mention-target-verify
- Rebuild: `docker compose up -d --build server` (server ONLY) → image aiagents-server 625eefec5d4e (4 min old at verify). `docker compose ps`: server Up healthy, db/worker/web untouched (Up 19-20 min). Freshness gate: login 200 + new image + live fix behavior. No code changes, no commits.
- Gotcha 1 (infra): python urllib honors HTTP_PROXY (127.0.0.1:7890 here) → localhost calls 502 while curl bypasses. Fix: prefix all python probes with `NO_PROXY='*' no_proxy='*' HTTP_PROXY='' HTTPS_PROXY='' http_proxy='' https_proxy=''`.
- Gotcha 2 (identity): fresh team created as `admin` (u_admin) → GET /channels?teamId 403 PERMISSION_PROJECT_NOT_MEMBER (admin has 0 project memberships; findAccessibleChannels gates teamId-filtered list on projectIds.length). Redo as `seed-admin` (project owner) works. First attempt team tm_0000000004 swept clean (channels/tum/members/teams, 0 msgs/sessions).
- Repro cell PASS (fresh team tm_0000000005, 2 members tmm_0000000012/a_product + tmm_0000000013/a_developer, main NULL, channel c_0000000003): POST m_0000000003 `{text, mentions:[{type:'agent',agentId:'a_developer'}]}` (NON-main/second member) → 201 trigger `{"agentId":"a_developer","instanceId":"tmm_0000000013","sessionId":"s_0000000001","status":"dispatched"}` — was no_session/null. Mention shape note: agent-type mention resolves by template agentId (a_developer), no instanceId needed.
- Reply watch PASS: m_0000000004 agent processing → m_0000000005 agent/a_developer sent "我是开发者-1，实例 id: tmm_0000000013，负责编码实现与问题排查。" — mentioned agent self-identifies correctly.
- Regression cell PASS: mention-free POST m_0000000006 → 201 triggers=[{a_developer/tmm_0000000013/s_0000000001/dispatched}] (no-main → first-listed-member fallback, session reused) → reply m_0000000008 agent/a_developer sent (分工 text). Main path intact.
- Cleanup: FK-safe sweep deliveries→messages[6]→sessions[1]→queues→main NULL→channels→tum(tum_0000000004)→tgi[ti_0000000001/02, key lesson: tgi refs members, must go before members]→members→teams. Verify: GET tm_0000000005 → 404 TEAM_NOT_FOUND; teams=[tm_0000000003 (pre-existing, untouched), tm_0000000001]; tasks 0=0 before; 0 leftover msgs/sessions/tgi. message_deliveries keyed by channel_id (no message_id column).

## [2026-09-06T11:05Z] Task: mention-target-commit
- Commit 82d466f `fix(server): dispatch @-mention targets in team-mode` (4 files, +228/-0, no push): server/prisma/seed.ts, server/src/chat/chat.service.ts, server/src/chat/chat.service.spec.ts, server/src/chat/worker-dispatcher.ts. worker-dispatcher.spec.ts untouched (not in status). Secret scan clean; post-commit status shows only .omo churn.

## [2026-09-06T11:17Z] Task: channel-gate-fix
- findAccessibleChannels 团队查询分支的真正门钥是 teamUserMember（resolveChannelAccess 团队 stub 早已如此 :1310），而列表端误用了项目门——修法是把成员检查前移到 :243 之前并短路，而非放宽非成员逻辑；非成员分支必须字节不动，否则 403 语义漂移。
- ensureTeamChannel 已是幂等单例（含 P2002 回读），grep 确认后直接复用、零重复；成员分支无条件调用它（findFirst 命中即复用），比“先查行再决定”少一次显式存在查询；type=private 时跳过调用，避免读私聊列表时无端建群。
- spec 注意：chat.service.spec 的 teamUserMember.findUnique 默认 mock 是成员（{id:'tum_1'}），故既有 'teamId 过滤'/'taskId 映射' 用例修后自动走成员分支——断言仍过（list 形状不变），属分支迁移下的免费回归。
- admin 持 teams.edit 可自助加团队：admin/seed-admin 角色 permissions={all:true}，permission.guard.ts:100 对 all===true 任意权限点放行；POST /teams/:id/users 挂 @RequirePermission('teams.edit')（teams.controller.ts:100），故人类 admin 可自行 POST 加自己进团队（RBAC 未动，属用户侧后续决策）。
- session 空态 403 区分是 3 行改动：channelsQuery.isError + isApiError(status===403) 即判定（teamQuery 分支已有同风格 404 判定 :745 可抄）；重试按钮本就存在，无需新增。
- Live 幂等证据：seed-admin 连调 2 次 GET /channels?teamId=tm_0000000001 均为 total=1 同一 id；c_0000000005 createdAt 即调用时刻，自证 auto-create。预存他方行（tm_0000000003/06 频道、tum_0000000002/0000000005）只读核对、不碰。
- 证据：.omo/evidence/team-free-chat/task-7.log §channel-gate-fix。无 commit。

## [2026-09-06T11:20Z] Task: channel-gate-commit
- Commit fec2df0 `fix(server,web): team channel listing honors team membership` (3 files, +115/-2, no push): server/src/chat/chat.service.ts, server/src/chat/chat.service.spec.ts, web/app/(main)/teams/[id]/session/page.tsx. Secret scan clean; post-commit status shows only .omo churn.

## [2026-09-06] Task: web-rebuild — web healthy (aiagents-web 1d42c18f, 37s old), :13001 /login 200 + /teams/tm_0000000001/session 200; db/server/worker untouched.
