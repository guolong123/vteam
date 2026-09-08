# Learnings — remove-project-dimension

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## T3 (2026-09-07): decorator relocation + projects hard-delete
- Failing-first works well for path moves: delete old file first, capture the
  TS2307 list (11 hits here — plan listed 10 importers but missed the internal
  `projects.controller.ts` → `./current-user.decorator` self-import; fix it too
  or Phase A tsc stays red).
- All 10 external importers sit exactly one level under `src/`, so every new path
  is uniformly `../common/decorators/current-user.decorator` — path-only change,
  exported names (`CurrentUser`, `AuthenticatedUser`) identical, zero logic risk.
- Phase B `tsc` is EXPECTED red (exit 2, 12x TS2307 on `project-membership.guard`
  from Todo 1/2/4/6/8/11-owned files). Do not fix — gate for T3 is zero errors in
  touched files + zero dangling `projects/`/`ProjectsModule` refs + smoke suites green.
- `echo $PIPESTATUS`/`PIPESTATUS[0]` after a pipe printed empty in this shell —
  use `cmd; echo "EXIT:$?"` without pipes when a clean exit code is needed for evidence.
- Live `:13000` server predates the change (old bundle → 401 on /projects); T3 404
  proof must be code-level (dir gone + zero @Controller hits + app.module diff),
  valid only after next rebuild/restart.

## 2026-09-07 — T1 TasksService 去 pid
- Failing-first works cleanly with signature removals: spec-first edit yields TS2554 suite-compile failure (0 tests run) — unambiguous red before impl.
- `(this.prisma as any).teamUserMember` pattern already existed in createByAgent; reusing it for the create gate keeps the diff pid-plumbing-only, no Prisma type churn.
- Parallel-Todo tsc breakage (Todo 3 deleted project-membership.guard.ts mid-flight) must be itemized per-file in evidence; T1's own fix (guard own constant) removes one baseline error — record the delta, not just the total.
- findAll team-scope without touching query-tasks.dto.ts: type param as `QueryTasksDto & { teamId?: string }`, empty-teamId → no team filter (Todo 2 adds visible-teamIds filtering at controller).

## 2026-09-07 — T2 TasksController 路由去 pid
- Global ValidationPipe is whitelist:true + transform:true, so unknown query props are
  stripped before reaching the handler — `teamId` must NOT ride inside `QueryTasksDto`
  (DTO stays comment-only per scope); use a separate `@Query('teamId') teamId?: string`
  param instead. This also matches Todo 1's `findAll(query & { teamId?: string })` shape.
- No-teamId list without touching the service: controller fans out
  `service.findAll({ ...query, teamId: tid, page: 1, pageSize: 100 })` per visible teamId
  (from `teamUserMember.findMany`), merges `createdAt desc`, slices local page/pageSize
  (mirrored normalize helpers, default 20 cap 100). Per-team cap of 100 means teams with
  >100 filtered tasks lose tail rows in the merged view — accepted edge, note for follow-up
  (proper fix: service-level `teamId IN (...)` filter owned by service owner).
- `toTaskDto` items carry `createdAt: Date` (not string): type merge-sort comparator as
  `{ createdAt: string | Date }` or tsc fails the `.sort()` callback (TS2345).
- Route-shape assertions via `PATH_METADATA`/`METHOD_METADATA` (0=GET/1=POST) plus a
  no-'projects'/':pid' sweep over all handlers make "pid routes gone" machine-checked.
- Only tasks.controller.ts imported `ProjectId` — deleting project-id.decorator.ts is
  zero-blast-radius (verified by pre-delete grep); realtime/platform-mcp `projectId`
  hits are Todo6/7-owned, untouched.
- Probe-spec pattern for failure evidence: temporary `t2-failure.probe.spec.ts` with
  mocked Prisma (no DB needed — 401/400/403 all throw before I/O), run with
  `cmd; echo "EXIT:$?"`, then delete. Guard 401 code string is `AUTH_UNAUTHORIZED`.

## 2026-09-07 — T2 guard-fix (TeamMembershipGuard 无参直通 + :id 回退)
- `:id` team-first-task-fallback costs one extra `team.findUnique` (select id only)
  per task-scoped request; keeps teams/:id routes on the fast path (no task lookup)
  while fixing tasks/:id misresolution. Invalid id → 404 TASK_NOT_FOUND (was 403).
- No-param passthrough returns true AFTER the user check, so unauthenticated stays
  401; spec asserts zero prisma calls in passthrough to lock the "filtering lives
  downstream" contract.
- Extracting `resolveTeamIdFromTask` keeps both :id-fallback and :taskId branches on
  identical 404/400 semantics with no duplication.
- Resolves problems.md 2026-09-07 T2 entry (guard gap closed; per-team fan-out cap
  note remains as follow-up for service owner).

## T4 (2026-09-07): issues/plans team-chain membership + teamId filter
- Spec-first rename sweep is mechanical: `projectId: 'p_1'`→`teamId: 'tm_…'`,
  `prisma.projectMember`→`prisma.teamUserMember`, `PERMISSION_PROJECT_NOT_MEMBER`→
  `PERMISSION_TEAM_NOT_MEMBER` via replaceAll, then hand-rewrite only the
  projectId-path findAll block (teamId path needs no existence 404 — plan's
  failure paths are 400/403 only; missing team resolves to 403 via member miss).
- `(this.prisma as any).teamUserMember` cast pattern (from T1 tasks.service) keeps
  Prisma-type churn at zero when the generated client lags concurrent schema work.
- ts-jest compiles the import graph, so a mid-edit file from a parallel Todo
  (Todo 6 realtime.service.ts) can red-block your suite even when your files are
  correct — distinguish "my red" (dead-guard TS2307 in my imports) from
  "their red" via the failing file path, fix only listed files, itemize the rest.
- `PIPESTATUS`/piped `echo EXIT:$?` lies (reports tail/grep's code); evidence runs
  must use `cmd > file 2>&1; echo "EXIT:$?"` with no pipe.
- Dropped `ISSUE_ERRORS.PROJECT_NOT_FOUND` (sole user was deleted assertProjectMember;
  repo-wide grep confirmed zero other refs) instead of leaving a lying constant.

## 2026-09-07 — T8 chat/docs-site/questions team chain
- findAccessibleChannels list-vs-send split: non-member LIST → empty set `{items: [], total: 0}` (no existence leak), SEND → 403 via resolveChannelAccess. Keep the team-existence 404 BEFORE the membership check so `tm_missing` still 404s for everyone.
- resolveChannelAccess needs `teamId` in CHANNEL_TASK_SELECT: the include-provided `row.task` previously lacked teamId, so add `teamId: true` to the select or the common path silently falls back to the legacy projectMember branch.
- Legacy compat shape: task WITH teamId → teamUserMember gate; task WITHOUT teamId (old task_group/private rows) → projectMember check kept but error code unified to TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER. DTO shape (task.projectId) intentionally untouched — Todo 9/11 own column removal.
- questions controller gate needs PrismaService injected (was service-only); reply resolves taskId via agentQuestion first, findAll asserts only when taskId + user present — keeps old direct-call spec shape working.
- Concurrent-Todo breakage drill: Todo 6 left realtime.service.ts type-broken (TS2339/TS2554), poisoning every suite via the ChatService→RealtimeService import. Runtime-verify with `--globals '{"ts-jest":{"diagnostics":false}}'` and cover types separately with `tsc --noEmit | grep <own paths>` (clean). Evidence must itemize which failures are foreign (docs-mirror 4x fs tests = pre-existing baseline).

## 2026-09-07 — T8 followup fail-closed (project_members runtime drop)
- Fail-closed beats compat-fallback when the fallback's table is being deleted:
  teamId-less task context → 403 PERMISSION_TEAM_NOT_MEMBER, zero project reads.
  Tasks always carry teamId since the team refactor, so the fallback was dead code.
- `grep -c projectMember` must read 0 in the service; spec keeps exactly 2
  intentional `(prisma as any).projectMember` toBeUndefined assertions proving
  no fallback query can fire (mock itself deleted).
- Hot-file collision: CHANNEL_TASK_SELECT came back mangled mid-fix (concurrent
  edit or tool overlap) — tsc caught it (toChannelDto arg mismatch). Always
  re-grep + tsc hot files after each edit batch; fix with unique-anchored edits.
- Fixture rule for fail-closed gates: every success-path task mock needs
  teamId (private/taskGroup/archived/mainChannel); allowAccess's task mocks are
  vestigial once row.task carries teamId — keep them teamId-only, drop projectId.

## T7 (2026-09-07): platform-mcp task_create去 pid + my_projects删除 + T5兼容写清理
- Failing-first was free: Todo 1's signature changes (createByAgent 2-arg,
  findAll 1-arg) already left exactly the 2 TS2554 errors T7 must fix, plus 3
  red suites in baseline jest. Record both reds as the "before" — the fix is
  then deletion-only, no new logic to debug.
- createByAgent verify-don't-touch: Todo 1's `(callerInstanceId, dto)` shape
  confirmed by read; T7's only job was dropping the pid first-arg at the call
  site. Touching tasks.service.ts would have collided with Todo 1 ownership.
- Team-only mentions (parseGroupPostMentions): swap is 4 lines
  (select projectId→teamId, projectMember→teamUserMember) because the @user
  matching body is dimension-agnostic. TeamUserMember has the same `user`
  relation (id/username/displayName), so zero body changes.
- T5 compat-write removal is NULL-safe: Memory.projectId is nullable without
  default, so dropping `projectId: null` / `projectId: memoryProjectId` from
  create data lands NULL identically. Keep the `as any` casts (Todo 9 owns
  column removal); keep level=project 400 guards (they're behavior, not compat).
- Spec-string hygiene: F1 greps `projectId` repo-wide, so even test NAMES must
  not contain the literal — renamed to 'selfInstanceId/title 必填'. Mock-shape
  leftovers (`projectMember` lowercase) don't match F1's `ProjectMember` but
  note them for Todo 11's sweep.
- tools/list count assertion (28→27) is the machine-check that my_projects is
  really gone from the served toolset, not just the service.

## T7-followup F2 RED-2 (2026-09-07): stale prompt referencing a deleted tool
- Deleting a tool is only half the job — system-prompt strings that NAME the tool
  (TEAM_SYSTEM_RECEPTION_INSTRUCTION told the model to call my_projects) are a
  second, grep-distinct surface. Sweep prompt constants for the deleted tool name,
  not just code refs.
- Absence-assertions (`not.toContain('my_projects')`) inherently contain the
  literal, so a naive "zero hits" grep on the spec will flag them — distinguish
  locking assertions (required) from prompt text (must go). Test names can drop
  the literal; assertions cannot.
- Prompt rewrite kept the parameter/gating rules verbatim and only swapped the
  decision branch (project-choice → direct create / ask-team). Byte-invariance
  tests for task-mode passed untouched, confirming no collateral change.

## T6 (2026-09-07): realtime team-scoped visibility, drop projectId
- Baseline was already red in own files: T3 deleted project-membership.guard.ts,
  controller spec failed TS2307 on the stale import — T6's import swap
  (TEAM_MEMBERSHIP_ERRORS) fixed it; record baseline red as fixed-delta, not new damage.
- subscribe/getEventsSince kept positional optional params
  (listener, scopes?, visibleTeamIds?) so the 3 fire-and-forget subscribers
  (message-question.dispatcher, notification-dispatcher, task-progression.scheduler)
  need zero changes.
- DB rows carry no team column, so scope=all补拉 does main query (scope+since only)
  then attachEventTeams batch-attribution (channel→team incl. taskId fallback,
  task/global→task.teamId, team→scopeId) + same teamFilter predicate as live path.
  Spec mocks must include task.findMany/chatChannel.findMany or attach silently
  nulls out (caught TypeError) and team tests false-fail.
- (this.prisma as any).task cast for teamId selects: generated client types lag
  concurrent schema work; runtime columns exist, cast keeps diff logic-only.
- schema.prisma showed M from sibling T5 (Memory.teamId) mid-flight — verified via
  git diff it is not mine; left untouched per MUST-NOT-DO.
- schema.prisma RealtimeEvent.projectId is String? nullable → omitting it in
  create is runtime-safe pre-Todo-9 (lands NULL); interface field + all code refs
  removed, grep projectId in realtime/ hits only spec self-assertions.

## T5 (2026-09-07): memory team level (task/team/global)
- Failing-first via stash-toggle: temp zod spec (MEMORY_LEVELS shape + save accepts
  team/rejects project) run with constants+tools stashed = RED 3 failed/exit 1,
  unstashed = GREEN 3 passed/exit 0. Genuine red-green without touching siblings.
  (`git stash push -q -- <2 files>` from server/ — paths are workdir-relative;
  earlier root-workdir invocation doubled the prefix and no-op'd.)
- Additive-only schema coexistence works: Memory gains teamId + idx_memories_team_time
  while projectId column/selects stay; task-level saves write BOTH teamId and
  projectId (compat), team-level writes teamId only, global writes neither.
  `npx prisma generate` (never migrate) keeps tsc teamId-aware.
- Service-level project guard needed despite zod: direct service calls bypass schema,
  so explicit `(args.level as string) === 'project'` → 400 MEMORY_INVALID in
  memorySave/memorySearch/memorySaveForTeam (MemoryLevel type no longer admits it).
- Cross-team 403 needs no new code: assertWorkerTeam (no session in team → 403,
  no cross-dim fallback) already enforces it; tests pin the behavior for both
  save and search. Team-level write gate intentionally looser than global
  (team shared, no main-agent check); global gate retained in both ctx branches.
- Blocked-suite protocol: platform-mcp suites can't compile (sibling Todo-1/7
  drift at service.ts:1028 taskCreate). Verify via tsc error-diff (only the 3
  known foreign errors) + runnable suites (memories/worker-dispatcher/scheduler:
  178 passed) + temp-spec red/green; itemize the block in t5-failure.log.

## T5-followup (2026-09-07): dead select removal
- Post-Todo-9 runtime trap: an unread `projectId: true` select survives type-check
  and unit tests (prisma mock ignores unknown selects) but throws once the column
  is dropped. Sweep own files for single-hit `projectId` selects after branch
  rewrites; delete the line even though "additive-only" — a dead read is not a
  schema change and Todo 9 will thank you.
- Bonus signal: sibling Todo 7's fix landed mid-flight (tsc foreign errors went
  3 → 1); re-check `tsc` deltas before writing evidence so the log doesn't
  enshrine stale blocks. Evidence: t5-followup.log.
## T10 (2026-09-07): 前端去 pid，团队上下文切换
- Foreign-hunk protocol works: `git status --porcelain -- web/` + full `git diff -- web/` FIRST;
  foreign files (SegmentedTabs adoption in git-repos/integrations/skills/memories + globals.css +
  ui/index.ts) never opened for edit — memories level-filter layered on top, diff shows both
  hunks cleanly. Final `git status -- web/` must show ONLY own files + pre-existing foreign set.
- Testid/route changes for Todo 11 e2e (all recorded, e2e untouched):
  DELETED route `/projects` + testids `project-list-root/project-card/create-project-button/
  project-artifacts-entry/create-project-modal/project-name-input/project-description-input/
  create-project-confirm/create-project-cancel/create-project-close/create-project-error/
  projects-loading/projects-error/projects-retry`; RENAMED `task-project-badge`→`task-team-badge`
  (board card team badge); DELETED `scope-project-select` (+ `data-project` chips) on roles page
  (`permission-scope` + `scope-inner-role-select` kept); memories `manage-tab[data-kind=project]`
  → `data-kind=team` ("团队" label; SegmentedTabs keeps manage-tabs/manage-tab testids);
  routes `/board?pid=`→`/board?teamId=`, `/artifacts?pid=`→`/artifacts?teamId=`,
  `/issues?pid=`→`/issues?teamId=`, `/tasks/new?pid=`→`/tasks/new?teamId=` (optional preselect),
  POST `/projects/:pid/tasks`→POST `/tasks`, GET tasks/issues via `?teamId=`.
  QueryKeys renamed `project-tasks`→`team-tasks`, `["projects"]` title lookups→`["team", teamId]`
  via teamsApi.get.
- Roles scope compromise: backend `RoleScope.projects` contract untouched (server out of scope),
  so the global/指定项目 toggle + `scopes.projects`透传 stay; only the GET /projects candidate
  pool + chip selector section deleted. Two role comments reworded to avoid the literal
  `/projects` (F1 grep matches the substring, incl. inside "(global/projects)").
- tsc gotcha: deleting a route leaves a stale `.next/types/**/projects/page.ts` stub → EXIT:2
  with ONLY `.next/` errors; `rm -rf .next/types` (regenerable) → EXIT:0. Always
  `grep -v '^\.next/'` the tsc log before concluding.
- QA against stale backend: compose stack runs the OLD bundle+schema (T9 migrated scratch only),
  so GET/POST `/tasks` 404 in screenshots — expected, logged in t10.log §4, full chain deferred
  to F3. Frontend proof stands: login→/teams, bare /board→/teams, ?teamId= preselect, team title
  via live GET /teams/:id, correct new API shapes in network log, 0 JS console errors
  (only 404 resource-load logs from the un-deployed backend).
- Nav order side effect: removing the `project` NAV_ITEM makes `teams` NAV_ITEMS[0], so the
  app-shell permission-guard fallback and Cmd+K "新建任务" (now bare `/tasks/new`, team picked
  in-form) both land on teams — no extra wiring needed.

## T10-followup (2026-09-07): roles dead-UI removal + users footnote (smoke FAIL 7-roles + OBS-1)
- users/page.tsx arrived with FOREIGN 项目→团队 hunks (sibling session); `git diff` it first,
  preserve byte-for-byte, layer only the footnote (user-pool-hint → 团队 model). Same drill as T10 memories.
- Global-only scope display that keeps data passthrough: drop editable/onChange props entirely
  (don't leave dead props — noUnusedParameters-safe), keep `value`+`theme` by rendering a
  value.global-branched badge + helper; draftScopes still resets on role change and rides PATCH
  untouched. Non-global legacy roles get an explicit "存量范围透传保留，不可编辑" note.
- Testid deltas for Todo 11 (e2e untouched): DELETED `data-scope-type="projects"`,
  `scope-inner-role-select` (+ `data-inner-role` chips); KEPT `permission-scope`,
  `data-scope-type="global"`. (Earlier: `scope-project-select` already gone in T10.)
- QA env gotcha: next dev was down on arrival AND a fresh dev defaults API_PROXY_TARGET to
  :3000 (proxy 500s) — restart with `API_PROXY_TARGET=http://localhost:13000`. Kill the temp
  dev afterwards to restore prior state; record both in the log.

## T11 (2026-09-07): e2e 与测试脚手架去 pid sweep
- seed.spec 是 sibling-drift 磁石：BUILTIN_SKILLS 落库 + 种子团队（team/teamMember/teamUserMember
  upsert）+ TEMPLATE_DEFAULT_MODELS 清空三处漂移叠加，5 tests 全红。修法是补 mock + 跟进断言
  （toBeNull + 更名），不动 seed.ts 产品逻辑；先 `grep -oE 'prisma\.[a-zA-Z]+' seed.ts | sort -u`
  列全量再补 mock，一次收敛。
- Baseline 证伪优先于 rerun：6 红 suite 与 T11 零交集时，`git stash push` 全量入栈重跑（同 25 failed）
  比 rerun 2x 更强，直接定性为 pre-existing。stash pop 后记得 `git status` 确认恢复。
- T10 learnings 漏了 `agent-option` 删除（tasks/new 改为团队成员只读预览 `team-member-preview-item`，
  且需 `?teamId=` 预选才直出）。e2e 修 spec + 同步 testids.ts reference 条。
- 新前端 × 旧后端 e2e 是有效部分验证：guard/login/teams 等前端路由断言全绿；board/drawer/perf 的
  404 失败用 curl 直证（`Cannot GET/POST /api/v1/tasks`），归因写进 t11-e2e.log，F3 关。
- Foreign worktree（SegmentedTabs 重构 skills/models，testid 已变）不越界：spec 保持 T10 口径，
  失败项 itemize 归 foreign owner，不替人重写。
- F1 grep 注意大小写：`projectMembers`（小写 p）不命中 `ProjectMember`；但 spec/test 名中的
  `projectId`/`/projects`/`:pid` 字面量会命中，一律改写（断言体本身保留，它就是反向断言）。

## 2026-09-07 — F4 scope-fidelity gate: APPROVE (read-only)
- team-queue e2e 10/10 + tasks/teams/questions 5 suites 209/209 全绿；server/src 非 spec `projects/:pid|:pid|/projects/` 零命中（唯一 spec 命中为 absence 断言）；t9 mysqldump 备份 2.8MB 在位；foreign（segmented-tabs.tsx 新文件、chat-followups 草稿、globals.css/ui/index + git-repos/integrations/skills hunks）经 diff 确认 0 project 行、未被本计划触碰。证据 final-F4.md。
- worker-dispatcher.spec.ts 残留 3 处 `projectId: 'p_1'` mock 为 Todo 11 明确 fence-off 的遗留，非路由，转交 F1 审计；F4 按 MUST NOT DO 不修。

## 2026-09-07 — F1 plan-compliance audit: APPROVE
- T8-owned 3 mocks closed: baseline HEAD 4365/4408/4445 (`projectId: 'p_1'`),
  working tree had prettier-reformatted them (4395/4484/4579, 10-space indent);
  removed keys only via replaceAll + single edit; `worker-dispatcher.ts` zero
  projectId refs confirmed dead fields first. Spec green 144/144; chat-wide F1
  pattern zero after edit.
- Repo-wide 1870 lines/153 files → every non-excluded hit classified: (a) 6
  absence-assertion spec lines (realtime 3/tasks-service 2/tasks-controller 1);
  (b) md-docs (own docs-viewer projectId concept) + docs/test-reports history;
  (c) .omo records (t12-grep-initial.log 1070 = T12 pre-cleanup snapshot);
  (d) root *.mjs scratch + .playwright-mcp logs + git-ignored trace.zip +
  prototype-viewer `/data/projects/` placeholder false-positives (tracked, so
  noted as allowlist-wording stretch — unrelated churn, not fixed) + root
  learnings.md:101 historical smoke note (out of T12 scope, listed not edited).
- Route check: no projects/:pid decorators, `server/src/projects/` gone,
  app.module/schema zero `projects`, ProjectMembershipGuard zero non-spec refs,
  memberPermissions has teams/no-projects; `permissionScope.projects` in seed is
  agent tool-sandbox JSON (different concept, out of pattern scope).
- Zero product-logic edits; evidence: final-F1.md.

## 2026-09-07 F3（fresh-stack QA）
- `npm run build` 后必须 `npx prisma generate`（client 是生成产物）：遗漏时 `POST /tasks` 报 500（旧 client 仍要求 `project` relation），易误判为产品 bug。注意仓库根的 `prisma` 解析出来的是 v7 wrapper（`generate` 未注册），必须在 `server/` 目录用 prisma 6 执行。
- 主 Agent 须用任务快照实例 id（`ta_*`，`task_agents` 行），不是团队成员 id（`tmm_*`）——`MAIN_AGENT_NOT_IN_TEAM` 400 是按设计的域校验。
- Playwright MCP 截图必须 `wait_for` 关键文本后再拍，否则在 turbopack dev 下极易拍到空白页；所有截图逐张目检（本次作废空白 2 张、重复 1 张）。
- session 页控制台 `GET /plans?taskId= → 404` 是 by-design（无计划任务，`retry:false`），非 JS 异常，与拆除无关。

## 2026-09-07 — F2 RED-1 fix (web use-sse.ts:92 `as any` → typed access)
- `(payload as any)?.message?.channelId` → `payload.message?.channelId` is provably zero-risk when the local is already typed (`message?: { channelId?: string }`): `as any` is compile-erased, optional chaining preserved, so runtime semantics identical; web lint went 1-error → EXIT 0 and tsc stayed EXIT 0.
- F2 scoping lesson: a RED in an untouched file is still fixable only with explicit line-scoped authorization — the original REJECT was correct under "touched files only"; the fix became legal via the follow-up instruction naming the exact line. Record the authorization, don't generalize.

## 2026-09-07 — Compose deploy (remove-project-dimension tree vs persistent volume)
- Backup path recorded FIRST in deploy.log: `.omo/evidence/compose-deploy/backup-20260907-1156.sql`
  (2.8MB via `docker exec aiagents-compose-db mysqldump -uroot -paiagents-root aiagents`;
  host has no mysql client, compose db exposes no host port — same drill as T9).
- `.env` already carried MODEL_CREDENTIAL_KEY (compose reads .env automatically; shell
  env was empty — no generation needed, value never logged, only "set-in-.env").
- `docker compose up -d --build` one shot (EXIT 0): init Exited 0 applying exactly one
  migration `20260907000000_drop_project_dimension` (38 found, 1 applied) + seed;
  server healthy ~30s, web healthy ~40s. Poll the health endpoint, don't sleep blindly.
- Post-drop DB: `SHOW TABLES LIKE 'project%'` empty; the 1 live task (t_0000000001,
  brief expected 6 p_seed_1 tasks but live DB only ever had 1 — verified pre-deploy
  and backed up) preserved with team_id tm_0000000001 intact, status pending_review.
- E2E on host ports: health 200, seed-admin login 200, /teams lists 4 teams,
  POST /tasks 201 (t_0000000002 queued), board?teamId= total 2, GET /projects 404
  `Cannot GET /api/v1/projects`, workers shows w_compose_worker registered.
- Screenshots: wait for key text (`vteam`, `compose-deploy-verify`) before shooting;
  both inspected, not just saved. Evidence: deploy.log + 2 PNGs in
  .omo/evidence/compose-deploy/.

## 2026-09-07 — Clean-slate redeploy + full smoke (compose-smoke)
- Pre-destroy verified both backups non-empty (t9 2806046B, compose-deploy 2817425B),
  then `down -v` removed all 4 volumes; `up -d --build` EXIT 0, init applied all 38
  migrations incl. drop_project_dimension on empty DB; health 200 on first poll.
- Fresh-DB truth (differs from brief): 3 users (not 4), team_user_members=1 owner
  (not 5 — the 5 are team_members agent instances), 0 tasks/issues, 5 agents.
- Playwright ran from /tmp scripts via createRequire(workdir package.json) — ESM has no
  NODE_PATH; no browser preinstalled (`npx playwright install chromium`, ~95MB).
- Queue semantics bit the script twice: 2nd task is `queued`, start 409s with
  TEAM_NOT_QUEUE_HEAD (correct behavior); lifecycle must run on the pending HEAD task.
  Task transitions return HTTP 201 (Nest POST default), issue transitions too —
  assert 200/201, not 200.
- Drawer testids differ: board card `enter-team-session` vs drawer
  `enter-team-session-drawer`; click the title text (card center = 开始任务 button).
- Findings for plan follow-up: (1) FAIL — roles 权限范围 keeps 全局（所有项目）/
  指定项目 toggle + 项目内角色 chips (dead UI, no picker, zero /projects calls);
  (2) OBS — users page footnote still documents the 「仅项目」 org model (stale copy).
- Console triage: GET /plans?taskId= 404 on direct-mode tasks logged as console error
  (pre-existing noise); all other 404-resource errors expected/transient, zero pageerrors.
- Evidence: .omo/evidence/compose-smoke/ (build.log, smoke.log + FINAL VERDICT, 14 PNGs).
  Remaining smoke- data: t_1 archived, t_2 pending head, t_3 queued; is_1/is_2 closed;
  1 group msg. Stack left RUNNING. Zero product edits.

## 2026-09-07 — DM 私聊无流式双根因（chat.service createMessage）
- R1（H4）：trigger 只来自 @ 解析，private 无回退 → mentions 为空时
  `dispatch({targets: []})` 空转，worker 零执行。探针：`triggers: []` + 60s
  零 delta/loading/DB 行。修法：`isTeamPrivate && triggers空 && teamMemberId`
  → `buildTeamMemberTrigger` 补对端 dispatched（对齐 team_group 主触发回退形）。
- R2：`resolveChannelAccess` 对 taskId 为 null 的团队频道合成 currentTask，
  私聊 `effectiveTaskId` 被误继承 → task-mode 误派（ta_ 快照会话 + 终态落群聊，
  DM processing 悬空）。探针：@ 触发得 ta_ 会话 + "已回复群聊。" + 终态落群聊。
  修法：团队私聊 `effectiveTaskId=null` + `dispatchTaskId=''` 恒走 team-mode。
- H2/H3 证伪优先于修：@ 探针的 delta 本就正确落私聊频道（ingress source 回退 +
  channel scope emit + SSE `channel:<id>` 订阅），省掉 ingress/realtime 改动。
- Failing-first 在共享脏 worktree 下：`git stash` 会连带兄弟改动导致旧文件
  编译失败（假红）；改用单条件短路（`isTeamPrivate = false && …`）做 red/green
  翻转，2 failed → 99 passed，干净且可逆。
- Live 取证顺序：fresh DM 频道（避 stale）→ SSE 先连 → 发消息 → 60-90s 窗口
  查帧/DB/日志；frame 证据存 `frames-*.txt`（ev id + type + channel + 摘要），
  Playwright 只做最终 UI 截图（DM tab testid 用 `ta_` 实例维度，非 tmm_）。

## 2026-09-07 — DM 私聊 own-message 不可见（session-history 合并修复）
- 根因是结构不是时序：`getSessionHistory` 纯 session 源时，worker 侧用户文本经 prompt
  注入拼进 `【团队上下文】` 上下文消息，无独立 user 条目（H3 主因）；POST 后立即
  refetch 撞上 worker 未 ingest 窗口只是加重（H1 次因）；`sessions.find(已绑定)` 选会话
  正确，H2 证伪。取证顺序：session-before（8 items 全 msg_）vs db-before（3 m_ 行）→
  POST → session-after（1 item）vs db-after（含新 m_）→ +75s 定型。
- 去重有精确 join 键：DB agent 行 `content.parts[].messageID == worker info.id`
 （m_0000000026 ↔ msg_07a82f46…），无需文本启发式；DB agent 行自带 reasoning/tool
  parts，所以合并 = DB 全量（user/system/agent）+ 未被引用 session agent 增补，
  session user 伪影一律排除。SSE delta 同 queryKey 零改动，流式天然兼容。
- 脏 worktree 下 TDD：`git stash` 会连带兄弟改动致假红；回归 spec 用
  `prisma.message.findMany` mock（DB 降序 mock 对齐实现 `orderBy id desc`）做 red/green。
  旧 session-only 断言（3 items 含 user 伪影）按新契约更新为 agent-only + regression 用例。
- Live 验证要点：server 跑 dist 产物，改 chat.service 必须 `docker compose up -d --build
  server`（禁 down -v，init 容器会重跑但数据卷保留）；DM tab testid 是任务实例维度
  `dm-tab-private-ta_*`（非 tmm_，经 agentId+seq 映射到团队成员频道）；Playwright 自带
  config 的 testMatch 会吞掉外部 spec，用独立 `pw-dm-tmp.config.ts` + `testDir` 隔离，
  跑完删除；截图必须 reload 后重进 DM 再拍（refetch 持久性），并目检非空白。

## 2026-09-07 — DM Tab per-agent status（spinner + 未读红点）
- 状态设计：`unreadByInstance: Record<string, true>` 纯内存态（Tab 键 instanceId ?? agentId）；
  spinner 直接派生自既有 `loadingByAgent`（零新状态），红点仅 `!loading && unread` 时渲染，
  二者天然互斥；`onAgentLoading`/`onAgentStatus(running)` 起工即清红点，`handlePrivateTab`
  首行清红点（建频道失败也算已读，重渲染不恢复）。
- loading key 有三命名空间（实例 id / agentId / tmm_）：Tab 侧 working 判定三路别名都查
  （`instKey`、`m.id`、按 agentId+seq 匹配的 tmm），`clearUnreadForStateKey` 对 agentId 做
  fan-out；`useSSE` 回调走 ref（最新闭包），onMessage 内可直接读 `privateChannelMap`/
  `activeTab`，无需额外 ref 镜像。
- tokens.ts 无 danger/error 语义 token：红点 `#DC2626` 沿用本文件既有错误红并在行内注释
  说明；spinner 用 `space.md` 尺寸 + `neutral[300]` 軌道 + `currentColor` 顶部（:active
  白字蓝底/非 active 深字白底都可见），keyframes 用 dm-tabs 内联 `<style>`（`dm-tab-spin`）。
- 验证坑：web dev 代理缺省 `API_PROXY_TARGET=http://localhost:3000` 会导致登录 500，
  必须以 `API_PROXY_TARGET=http://localhost:13000` 启动；`/tmp` 下的脚本引用不了
  `playwright` 包，拷入 `web/*.tmp.mjs` 跑完即删（勿进 e2e 目录）。
- Live-stack  quirk（已实证，未修，超出 scope）：群聊 run 的 `agent.status running`
  有时不带 instanceId（key 落到 `a_architect`），而完成消息按 `senderInstanceId`
  （`ta_*`）清 loading → 该 agentId key 的 loading 残留，spinner 常亮并按 spec 压制该
  Tab 红点；message-list 的 `loadingLabel` 同病。证据见
  `.omo/evidence/dm-tab-status/run.log`；修它会改变既有 loading 语义，故不动。

## 2026-09-07 — session loading-stuck fix（key 归一化 + staleness 兜底）
- 三命名空间 key（ta_ 实例 / a_ agentId / tmm_ 成员）下，写 canonical（instanceId ?? agentId）
  + 删全量展开是最小修复形状：`agentKeysFor({instanceId, agentId})` 用 seed 双端播种再经
  agentMembers + team.members 展开，起工/终结各执一端也能相遇；`clearUnreadForStateKey`
  等红点路径一律不动（红点 fan-out 语义已定，动它即改 dot 契约）。
- Staleness 选单 interval（60s 扫、10min 丢）而不用 render 时懒查：stuck 条目恰恰发生在
  "零后续事件" 时，懒查依赖的 render/事件可能永远不来；timestamp 放 ref 与 state 同 key
  维护，删除路径必须同步清 ref（removeLoadingKeys 内聚这一点）。
- 脏 worktree 下同文件有 sibling 未提交 hunks（dm-tab spinner/红点 @832/844/851/973）：
  `git diff` 先按 hunk 归属，自己的 hunk（92/287/422/451/473/490）只碰 key 处理；
  tab render/unread 零改动即是 dot 回归保证，不替人验、不替人改。
- Live 取证：dev :3001（API_PROXY_TARGET=:13000）直接 serve 修改文件，compose
  server/worker 不动；Bearer token 在 zustand persist（localStorage/sessionStorage JSON
  的 state.token），page.evaluate 里扫两个 storage 取 token 调 /api/v1 拿 teamId；
  群聊发一句 → loading 现 → 4s 后自清 + 回复到，截图三张即闭环。temp 脚本放
  web/*.tmp.mjs 跑完即删（/tmp 下 resolve 不了 playwright）。
- Simulation 先行：old 逻辑双向复现 stuck（bare→instance、instance→bare）+ new 清除 +
  sibling 隔离，8/8 全绿后再上 live，live 一次过。
- 上条 quirk 已由本 fix 关闭：起工 bare agentId + 终结 senderInstanceId 正是 Scenario A，
  simulation 复现 + live 自清双重验证。

## 2026-09-07 web-rebuild: stale :13001 image promoted to current tree
- Pre-state proved staleness: web container Created 3h ago, image Created 2026-09-07T04:24:49Z
  (smoke-deploy build, predating dm-tab-status/loading-stuck/roles-cleanup fixes).
- `docker compose up -d --build web` exit 0; only web recreated (db/server/worker untouched,
  db Up 3h+ across pre/post, no down -v, no volume ops).
- Post-state: new image Created 2026-09-07T07:29:38Z, web Healthy, :13001 HTTP 200 first poll.
- Live proof on :13001 (NOT dev :3001): session page stuckCount("操作中")=0, spinnerCount=0;
  roles page hasProjectScope("指定项目")=false, hasGlobal=true → global-only scope live.
- Evidence: .omo/evidence/web-rebuild/rebuild.log + 01-session-live13001.png + 02-roles-live13001.png.
- Zero product edits by this task (worktree dirt is pre-existing remove-project-dimension work).

## 2026-09-07 — 群 @ DM 镜像（dm-mirror，createMessage 主路径）
- 镜像点选在群消息广播后/FIFO 拦截前：targets 仍是 dispatched 原态；
  放在拦截后会被 queued 改写吃掉，放在 dispatch 后则与 fan-out 语义纠缠。
- @all 排除必须按 dto.mentions 源头配对（trigger 不带 origin）：显式 @agent
  与 trigger 按 agentId 1:1 消费（instanceId 优先），@all/主回退天然落空。
  ta_ 实例 → teamMember.findFirst(agentId) 换 tmm_；tmm_ 直用，零 DB 查询。
- 脏 worktree 下红证：禁 git stash（同文件有兄弟 hunks），用自家门短路
  `false &&` 做 2-fail/3-pass 行为红，revert 即绿；tsc 与 ts-jest 诊断可不一致
  （union 收窄 TS2339 只在 jest 侧先爆），以 jest 编译为准修类型。
- 既有 suite 零破的运气成分：旧用例 teamMember.findFirst 皆 mock null，
  镜像 lookup 落空即跳过；新 spec 用 mockImplementationOnce 首调用注 parts
  锁逐字契约（echo-mock 下深相等才有意义）。
- Live：server 改动必须 `--build server`（dist 产物）；DM 基线-增量计数代替
  fresh-DM（禁删行）；mirror 5s 落库、worker 回信 ~80s；Playwright 脚本放
  web/*.tmp.cjs（包解析），跑完即删；截图逐张目检。

## 2026-09-07 dm-session-dump spike: worker user turns are injection composites — keep mirror (arch A)
- Raw `GET /session/<ref>/message` for DM channel c_0000000003 (session s_0000000020, instanceRef ses_f8555a2eaffeK5b1fW9dAGooVx): 5 entries, 2x role=user.
- Each user entry = ONE text part, `synthetic` key absent, text = `【团队上下文】…\n\n` + verbatim user msg (dispatcher worker-dispatcher.ts:1829-1851 joins them into one prompt string).
- convertSessionMessages synthetic filter can't split one part → user DTOs would be KEPT+MANGLED (prefix leaked); mergeSessionWithPlatform's session-user exclusion is load-bearing.
- VERDICT arch A (keep mirror); arch B needs dispatcher to send context as synthetic/system parts first, else prefix-strip is brittle + duplicates mirrored rows. Evidence: .omo/evidence/dm-session-dump/raw-session.json + ANALYSIS.md.

## session-unification research 1/4
- Scope: server/src (chat/, workers/, teams/, plans/) + schema.prisma Session model. Facts only, zero product edits.
- Schema (server/prisma/schema.prisma:257-282): Session has taskId?, taskAgentId?, teamId?, teamMemberId?, teamMemberKey? (STORED gen col, only non-null when task_id IS NULL). Keys: `uk_sessions_task_agent(taskId,taskAgentId)` (task path) + `uk_sessions_team_member(teamMemberKey)` (only constrains task-less rows). Task rows carry BOTH taskAgentId and teamMemberId (dual-populated, see tasks.service create below).

### A. Session CREATION sites (task path vs team path)
- A1 tasks.service.ts:453-462 `create()` tx — TASK path (per TaskAgent snapshot): `session.create({taskId, taskAgentId:taId, agentId, teamMemberId:m.id, status:created})`. Key: taskId+taskAgentId (uk_sessions_task_agent), teamMemberId co-stored. Breaks-if-team-only: per-task snapshot rows disappear; buildTrigger/dispatchForTarget/resolveChannel task lookups (C-sites) find nothing → all task triggers become no_session; uk_sessions_task_agent consumers (resetInstanceSession, dispatchAgentMention fallback) lose their key.
- A2 tasks.service.ts:1879-1887 `addAgentsInTx()` — TASK path (late-added instance): `session.create({taskId, taskAgentId:ta.id, agentId, status})`, NO teamMemberId. Key: taskId+taskAgentId only. Breaks-if-team-only: same as A1; additionally any teamMemberId-first code reading these rows gets null teamMemberId.
- A3 tasks.service.ts:1130-1138 `resetInstanceSession(taskId,instanceId)` — TASK recreate: `deleteMany({taskAgentId:instanceId})` then `session.create({taskId, taskAgentId:instanceId, agentId})` (line 1128 comment: delete first to free uk_sessions_task_agent). Key: taskId+taskAgentId. Breaks-if-team-only: reset endpoint has no team-session equivalent; caller (tasks.controller.ts:215) passes ta_ id which would not exist.
- A4 session-lifecycle.service.ts:170-238 `ensureTeamSession(teamId,teamMemberId)` — TEAM path (only team creator): `findUnique({teamMemberKey})` else `session.create({teamId, teamMemberId, agentId, taskId:null, taskAgentId:null, status:created})` (P2002 race → re-read). Key: teamMemberKey (uk_sessions_team_member). Team-only-safe: this IS the team path; task rows never flow through here.
- A5 teams.service.ts:819-830 `resetSessions(teamId)` + session-lifecycle.service.ts:289-350 `resetTeamSessionsInTx/resetTeamSessions` — TEAM+ TASK hybrid reset: `findMany({teamMemberId in memberIds})` → soft-remove TaskGroupInstance → `deleteMany(ids)` → `session.create({taskId:s.taskId, taskAgentId:s.taskAgentId, agentId, teamMemberId, status:created})` (preserves old taskId/taskAgentId verbatim). Key: looked up by teamMemberId, recreated with task keys intact. Breaks-if-team-only: re-created rows would need taskId=null, but current code copies s.taskId/s.taskAgentId; also tasks.service.ts:1669 `accept/archive` calls `resetTeamSessionsInTx` when `!reuseSession || resetAfterComplete`.
- A6 worker-dispatcher dispatchForTarget:1257-1266 — NOT a row creator: creates opencode-side session via `workerClient.createSession()` then `sessionLifecycle.bindSessionToWorker(sessionId, workerId, opencodeSessionId)` (second bind writes instanceRef). Row must pre-exist (A1/A2). Same shape in dispatchForTeamTarget (~1749+ second half, team dir `teams/<teamId>`).

### B. resolvePlatformSessionId (workers/worker-event.ingress.ts:950-975) + helpers
- B1 `resolvePlatformSessionId(sessionId, workerId, taskId?, agentId?)` — role: normalize worker回流 sessionId to platform PK. `s_` passthrough (L959); else `resolveSessionIdByInstanceRef` (L962); else `adoptNewInstanceRef` (L969); else `adoptNewInstanceRefByTask` (L974). Called from: handleSessionUpdated L340, handleAgentStatus L392, handleMessagePartDelta L471, handleTaskCompleted L640, handleAgentQuestion L758.
- B2 `resolveSessionIdByInstanceRef` L924-932: `session.findFirst({instanceRef})`. Key: instanceRef (dimension-agnostic). Team-safe.
- B3 `adoptNewInstanceRef(newRef, workerId)` L983-1016: `session.findMany({workerId, status:running})`, requires exactly 1 row, then `updateMany({id, status:running, instanceRef:{not:newRef}}, {instanceRef:newRef})`. Key: workerId+status (dimension-agnostic). Team-safe (but multi-running ambiguity pre-exists).
- B4 `adoptNewInstanceRefByTask(newRef, workerId, taskId?, agentId?)` L1024-1054: needs taskId; `session.findFirst({workerId, taskId, ...(agentId?{agentId}:{})})` then回写 instanceRef. Key: workerId+taskId(+agentId) — TASK-scoped. Breaks-if-team-only: team-mode events carry no taskId (L1030 `if(!taskId) return undefined`) → falls to undefined, caller handleAgentQuestion keeps raw ses_ id (L764 storeSessionId fallback); other callers get undefined sessionId (status/delta/completed lose platform mapping).

### C. Session-lifecycle service (workers/session-lifecycle.service.ts)
- C1 `bindSessionToWorker(sessionId,workerId,instanceId)` L79-162 — role: write workerId+instanceRef+status=active + upsert TaskGroupInstance. Branches on row: `if(session.taskId)` → task-mode idempotency `(taskId,workerId,instanceId)` (L98); else requires `session.teamId && teamMemberId` else 400 TEAM_SESSION_MISSING_DIMENSION (L117) → team-mode idempotency `(teamId,teamMemberId,workerId,instanceId)` with `taskId:null` row (L125-142). Key: row-driven. Team-only-safe for team rows; task branch dies with task rows.
- C2 `unbindSession(sessionId)` L247-280 — role: dispatch-failure rollback (F2 M5). `updateMany({taskId:session.taskId, workerId, instanceId:instanceRef})` soft-remove + clear row to created. Key: taskId from row (null for team rows → `where:{taskId:null,...}` still matches team-mode TaskGroupInstance rows which store taskId null). Mostly team-safe.
- C3 `getInstancesByTask(taskId)` L363 + `getInstanceBySession(sessionId)` L374-392 — role: TaskGroupInstance reads by `where:{taskId,...}`. Key: taskId. Breaks-if-team-only: no team equivalent; callers (dispatcher T10 reuse check, task page query) get empty.
- C4 `onModuleInit` L62 — only resyncs `ti_` prefix, dimension-agnostic.

### D. Team-mode ensure (worker-dispatcher.ts + chat.service.ts)
- D1 `resolveTeamMainMember(teamId)` worker-dispatcher.ts:1603 — `team.findUnique({mainAgentMemberId})` else first TeamMember by seq. Key: teamId+teamMemberId. Team-native.
- D2 `buildTeamMainTrigger(teamId)` worker-dispatcher.ts:1632-1650 — `resolveTeamMainMember` + `ensureTeamSession(teamId, memberId)` → `{agentId, instanceId:memberId, sessionId}`. Key: team only. Team-native.
- D3 `buildTeamMemberTrigger(teamId,teamMemberId)` worker-dispatcher.ts:1659-1679 — `teamMember.findFirst({id,teamId})` (throws if missing, NO ta_ fallback — L1656 ban comment) + `ensureTeamSession`. Key: team only. Team-native.
- D4 chat.service.ts:860-868 (team_group zero-task no-@ main fallback) → calls D2; chat.service.ts:897-908 (zero-task @-mention no_session→dispatched flip, only `tmm_` ids) + chat.service.ts:933-944 (team private DM peer trigger) → call D3. All team-keyed; task-mode (`effectiveTaskId` non-null) never enters.
- D5 `dispatchForTeamTarget(request,target,teamId)` worker-dispatcher.ts:1702-~1900 — role: team dispatch. `target.instanceId` REQUIRED as teamMemberId, no fallback (L1712-1718); missing sessionId → `ensureTeamSession` (L1723); then strict check `session.teamMemberId===teamMemberId && session.teamId===teamId` else throw (L1739-1747). Key: team only. Team-native.
- D6 `dispatch(request)` worker-dispatcher.ts:973-1018 — router: `teamMode=!request.taskId`; team-mode requires teamId else throw, calls D5; task-mode calls dispatchForTarget. Error scope: team-mode `toExecutionScope(null,teamId)`, task-mode raw taskId.
- D7 `dispatchAgentMention` worker-dispatcher.ts:1027-1064 — task-group @ bridge: `findFirst({taskId, teamMemberId:targetInstanceId})` FIRST (L1036) then fallback `findFirst({taskId, taskAgentId:targetInstanceId})` (L1041). Key: task-anchored dual lookup. Breaks-if-team-only: taskId-anchored row gone; caller at L3965 `resolvePrivateChannelForRetry` passes ta_ targetInstanceId which team-only store cannot resolve (D3 throws on non-tmm_ by ban).

### E. Task-path session CONSUME/lookup sites (all break if only team sessions exist)
- E1 chat.service.ts:1934-1937 `buildTrigger(taskId,row)` — `session.findFirst({taskId, taskAgentId:row.id})` → dispatched/no_session. Key taskId+taskAgentId. Break: every task @ trigger becomes no_session (only D3 tmm_ flip covers zero-task path, not task path). Team counterpart `buildTeamTrigger` L1971-1974 uses `{teamId, teamMemberId}`.
- E2 chat.service.ts:1983-2067 `buildMainAgentTrigger(taskId,task)` — resolves TaskAgent row (mainAgentInstanceId/mainAgentId/team.mainAgentMemberId→TeamMember→TaskAgent remap L2042-2056) then delegates to E1 `buildTrigger`. Key ends taskId+taskAgentId. Break: main-agent fallback in task channels yields no_session even when team session exists.
- E3 chat.service.ts:431-439 `getSessionHistory` task branch — `session.findFirst({taskId:channel.taskId, taskAgentId:channel.taskAgentId})`; team branch L410-423 uses `findMany({teamMemberId})`. Break: task private-channel history loses worker serve augmentation (falls back to DB).
- E4 worker-dispatcher.ts:1088-1097 `dispatchForTarget` session load — `session.findUnique({id})` select incl. taskAgentId+teamMemberId; then L1114 `taskAgent.findUnique({id:session.taskAgentId})` for overrideModelId; L1241/1251/1571/1581 broadcast/instanceId `teamMemberId ?? taskAgentId`; L1390 selfInstanceId same; L1419 registerExecution `teamMemberId ?? taskAgentId ?? agentId`; L1425 resolveChannel(taskId,agentId, teamMemberId ?? taskAgentId). Key: row PK then taskAgentId-first with teamMemberId priority. Break: taskAgentId null → overrideModel lost, execution registry/watchdog/instanceId collapse to teamMemberId (works only if row kept teamMemberId).
- E5 worker-dispatcher.ts:2053-2059 `handleTaskCompleted` + L3011-3015 `handleAgentStatus` error + L3154-3158 `failProcessingMessage` + L3944-3948 `resolvePrivateChannelForRetry` — all `session.findUnique({id})` then read `.taskAgentId` (L2058 executionRef, L3015 unregister key, L3158 channel key, L3948 retry target; L3941 `ta_` prefix check bypasses lookup). Break: taskAgentId null → execution unregister key, channel resolution, retry target all degrade to agentId (multi-instance precision lost).
- E6 worker-dispatcher.ts:3536-3555 `resolveChannel(taskId,agentId,taskAgentId)` — teamId present: try `chatChannel.findFirst({teamId, teamMemberId:taskAgentId})` if ta_ is actually tmm_ (L3524-3533), then `findFirst({taskId, taskAgentId})` (L3536), then `{teamId, agentId, private}` (L3542), then team_group (L3548); legacy `findFirst(taskAgentId?{taskId,taskAgentId}:{taskId,agentId})` (L3554). Break: L3536/L3554 task-keyed DM lookups miss; survives only via teamMemberId/team_group fallbacks.
- E7 ingress consume: handleAgentStatus L400-404 `session.findUnique→taskAgentId` for emit instanceId (task-only, team events keep payload id); handleMessagePartDelta L483-493 `findUnique→{taskAgentId,teamId,teamMemberId}` but team branch gated `if(!taskId)` (L488) — task events ignore teamMemberId; L526-529 private target `where:{taskId, taskAgentId:deltaSenderInstanceId}`; handleAgentQuestion L774-777 backfill `findUnique→{taskId, agentId}`. Break: taskId-less team sessions skip team attribution in task handlers by design.
- E8 platform-mcp.service.ts:1197-1200 `memorySave` task branch `session.findFirst({taskAgentId:selfInstanceId})`; L1207-1210 channel `{taskId, taskAgentId}` (team branch L1077-1080 uses `{teamId, teamMemberId}`); L4028-4037 `assertWorkerTask` `session.findFirst({taskId, workerId, ...(selfInstanceId?{taskAgentId})})` (team counterpart L4107 `assertWorkerTeam` uses `{teamId, workerId, teamMemberId}`); L2363-2366 group_post ctx fallback `findFirst({workerId})→{taskId, taskAgentId, agentId}` (taskAgentId-first). Break: all task-dimension auth/attribution rejects or misattributes when rows are team-only.
- E9 questions.service.ts:260-263 reply forward `session.findUnique({id})→{workerId, instanceRef}` (dim-agnostic, safe); L281-290 ses_ worker fallback `session.findFirst({taskId, agentId, workerId!=null})` (task-keyed); L547-550 `mainAgentSessionOf` `session.findFirst({taskId, taskAgentId:mainAgentInstanceId})`. Break: L281 fallback + L547 main-session placeholder fail under team-only.
- E10 swagger-mcp.auth.ts:57-60 `session.findFirst({workerId, status:running})→taskAgentId` then `taskAgent.findUnique({id:taskAgentId})` (L68); L116-119 `assertWorkerTask` `findFirst({taskId, workerId})`. Key: taskAgentId/taskId. Break: team sessions have teamMemberId not ta_ → L68 lookup null → FORBIDDEN; team callers have no team-aware assert here.
- E11 teams queue/promote: teams.service.ts queue ops (enqueueQueue L956/cancelQueue L886) touch only team_queues/task.status — NO session handling. No "promote" creating sessions found; promotion = tasks.service create path A1 (snapshot sessions per member) + `currentTaskId` CAS. teams.service.ts:759-831 `resetSessions` is the only team-side session writer (see A5).
- E12 plans reviewer: plans.service.ts:333-350 `assignReviewer` writes `plan.reviewerInstanceId` after `taskAgent.findFirst({id:reviewerInstanceId, taskId:plan.taskId})`; approval clears it. Zero `prisma.session` usage in plans/ (grep: only taskId/reviewerInstanceId hits). Reviewer identity is ta_ snapshot id, NOT a session — breaks only indirectly via E1 (reviewer trigger session lookup) if ta_ snapshots go away.

## session-unification research 3/4 (2026-09-07): taskId-dependent branches in ingress + finalize + memory/plans/questions — facts only
Scope: `server/src` (workers/, chat/, plans/, memories via platform-mcp/, questions/, prisma/schema). No edits proposed.

### A. ingress — worker-event.ingress.ts
- `handleMessagePartDelta` L465-627 — task vs team split:
  - L468 `taskId = str(raw.taskId)`; L471-476 `resolvePlatformSessionId(sessionId, workerId, taskId, agentId)`.
  - L487-494: team dims (`teamIdOfSession`/`teamMemberIdOfSession`) ONLY populated when `!taskId` (comment: stock task sessions keep taskAgentId semantics even if they carry teamMemberId). `deltaSenderInstanceId = taskAgentId ?? teamMemberId ?? null` L492-493.
  - `privateTarget` L524-541: task branch `taskId && agentId` → `findFirst({taskId, taskAgentId} | {taskId, agentId})`; team branch → `findFirst({teamId, teamMemberId, type: private})`. Team-only SUFFICES (branch already exists).
  - Group skip L546-555 covers both `task_group` and `team_group` when no private channel.
  - `message.create` L594-608 writes NO `taskId` at all (only channelId/senderInstanceId/content) — delta persistence is already task-free. `taskId` only flows to `touchSessionActivity`/`notify` scope L619-625.
- `handleTaskCompleted` L634-677 — builds `TaskCompletedPayload {taskId, agentId, sessionId, workerId, channelId, text, parts…}` L646-660 and `notify(taskCompletedCallbacks)` L675; no DB write here (D5: dispatcher owns persistence). `taskId` is pure pass-through → teamId+memberId suffices IF dispatcher team branch resolves session (it does, see B).
- `handleAgentQuestion` L740-857:
  - L771-780: taskId/agentId from payload, fallback `session.findUnique select {taskId, agentId}`.
  - L807-819 `agentQuestion.create {requestId, sessionId: storeSessionId, taskId: taskId ?? '', agentId: agentId ?? '', …}` — ⚠️ STRUCTURAL: `AgentQuestion.taskId` is `String` NOT NULL (schema.prisma L838); team path (no taskId) writes `''` empty-string debt today.
  - L827-834 `managedMode` via `task.findUnique({managedMode})` gated on taskId (team path → false, no team equivalent). L854-855 `scopeOf(taskId)` → team path emits `global` scope (frontend补拉 filters by taskId → team questions invisible to task-scoped pull).
- `resolvePlatformSessionId` L950-975: `s_` passthrough L959; `ses_` → instanceRef lookup L962; `adoptNewInstanceRef` (unique-running, task-free) L969; `adoptNewInstanceRefByTask` L974/`L1024-1039` — `session.findFirst({workerId, taskId, agentId})` task-anchored回写. Team path has NO equivalent keyed fallback (relies on unique-running or direct instanceRef hit).
- `scopeOf` L889-894: taskId string → `{type:'task'}` else `global`.

### B. finalize — chat/worker-dispatcher.ts
- `handleTaskCompleted` L2021+ — router: `!taskId` + sessionId → `handleTeamTaskCompleted` L2024-2028; `!taskId` + no session → error-drop L2029-2032. Team branch already exists.
  - Task branch: idempotency via `completedSessions`/`failedSessions` keyed by sessionId L2037-2046 (task-free keys, fine); session反查 `select {agentId, taskAgentId}` L2053-2056 → `executionRef`/`sessionTaskAgentId` L2058-2059.
  - `unregisterExecution(workerId, taskId, ref)` L2068-2074 — execution registry key = `workerId:taskId` (`executionKey` L805); ⚠️ STRUCTURAL (in-memory): unifying scope key changes register/unregister/clearPendingWatchdog matching (`clearPendingWatchdog(taskId, agentId)` L2075).
  - `resolveChannel(taskId, agentId, sessionTaskAgentId)` L2085-2089; `groupFallback = task_group|team_group` L2095-2097; groupFallback → skip正文落库 + only `emitFinal` L2186-2192.
  - ⚠️ STRUCTURAL FK writes: `message.update data {content, status, taskId}` L2132-2139 and `message.create {…, taskId, senderInstanceId: executionRef}` L2140-2152 — `messages.task_id` nullable (schema L324) but task branch always writes it (`Task.task_id` FK Restrict, schema L226-class relation). Team path proves null-writeable.
  - `emitFinal({taskId, …})` L2167-2172 / L2192 — `taskId` doubles as frontend scope key.
- `handleTeamTaskCompleted` L2846-2954 — team-only, suffices as-is: session反查 `select {agentId, teamId, teamMemberId}` L2860-2863, all-three-required else skip L2867-2872; `scope = toExecutionScope(null, teamId)` L2873; `unregisterExecution(workerId, scope, teamMemberId)` L2875; `resolveTeamChannel` L2879; `team_group` fallback skips落库 L2892-2896; create writes `taskId: null, senderInstanceId: teamMemberId` L2918-2930; `emitFinal({taskId: scope,…})` L2937-2942 (taskId field carries team scope string — downstream scope compat note).
- `resolveChannel` L3511-3563 — task-anchored entry (`taskId` param) but internally team-capable: `task.findUnique select {teamId}` L3516-3520; taskAgentId→TeamMember probe → `{teamId, teamMemberId}` DM L3522-3533; else `{taskId, taskAgentId}` DM L3536-3540; no-instance → `{teamId, agentId, private}` L3541-3547; group `{teamId, team_group}` L3548-3552; legacy `{taskId,…}` L3554-3558 + `{taskId, task_group}` L3559-3562. With teamId+memberId alone, `resolveTeamChannel` covers it; only legacy task-dim channels need taskId.
- `resolveTeamChannel` L1682-1694 — pure `{teamId, teamMemberId}` DM → `{teamId, team_group}`; suffices.
- `dispatchAgentMention` L1027-1076 — session lookup `{taskId, teamMemberId}` L1037 first, fallback `{taskId, taskAgentId}` L1041-1042; task-anchored (per-@ dispatch always has taskId today). Team analogue is `dispatchForTeamTarget` L1702+ / team-member trigger L1653+ (session `findUnique` by id + team check L1729-1745).
- `failProcessingMessage` L3141-3167 requires `taskId && agentId` (early return L3144-3147) + `resolveChannel`; team analogue `failTeamProcessingMessage` L3084-3137 exists (resolveTeamChannel + taskId:null writes).
- Identity/execution helpers: `registerExecution` set stores instance ids (`ta_` or teamMemberId-first L1418-1422); `selfInstanceId = teamMemberId ?? taskAgentId` L1389-1390; dual-dim main check L1393-1409 maps `mainAgentInstanceId (ta_)` → team member row. `ta_`↔`tmm_` mapping already centralized here.

### C. taskGroupInstance + session keys — session-lifecycle.service.ts + schema.prisma
- `bindSessionToWorker` L79-162: task branch L96-113 idempotent `findFirst({taskId, workerId, instanceId})` → create with `taskId`; team branch L114-143 `findFirst({teamId, teamMemberId, workerId, instanceId})` → create with `taskId: null, teamId, teamMemberId`. Both exist; team suffices for team sessions.
- `ensureTeamSession` L170-238: `uk_sessions_team_member` (`teamMemberKey = teamId|teamMemberId`) findUnique L183 + create `{teamId, teamMemberId, taskId: null, taskAgentId: null}` L208-219, P2002 race-retry L223-236.
- ⚠️ STRUCTURAL unique keys (schema.prisma): `uk_sessions_task_agent (task_id, task_agent_id)` L280 KEPT (comment L39-41: intentionally frozen for stock migration safety); `uk_sessions_team_member (team_member_key)` L281 — STORED generated column only non-NULL when `task_id` IS NULL (L264-265 comment), so task-bound rows never participate in team key. `TaskGroupInstance` model L715-730: `task_id` now NULLABLE (migration 20260904000000) + `team_id`/`team_member_id` NULLABLE, all FK Restrict — team writes structurally allowed.
- Related unique keys: `uk_channels_task_agent (taskId, taskAgentId)` L314 vs `uk_channels_team_member (teamId, teamMemberId)` L313 + `uk_channels_team_group_single` L315 — both dims have channel keys. `tasks.service.ts` L85 / L1108-1109: one session per instance via uk; archived-then-create trips the constraint → delete-then-create in txn (unification must preserve this write order).
- Read paths: `getInstancesByTask(taskId)` L363-368 and `getInstanceBySession` L374-392 (`{taskId, workerId, instanceRef}`) are task-keyed; team callers need by-(teamId,teamMemberId) equivalents (none exist yet — fact, not proposal).

### D. memory — platform-mcp.service.ts
- `resolveExecContext` L4063-4089: `taskId` present → `{kind:'task'}` via `assertWorkerTask` L4072-4078; else `teamId` → `{kind:'team'}` via `assertWorkerTeam` L4080-4087; neither → 400 L4088; `taskId` starting `tm_` → 400 L4067-4071. Dual context already exists.
- `assertWorkerTask` L3996-4055: `session.findFirst({taskId, workerId, taskAgentId?})` L4028-2037, returns `taskAgentId ?? agentId` L4047. Team analogue `assertWorkerTeam` L4096-4140: `session.findFirst({teamId, workerId, teamMemberId?})`. AuthZ suffices per-dim; dims never fall back to each other (L4094 comment).
- `memorySave` L1117-1233: team kind → `memorySaveForTeam` L1132-1133. Task branch: `taskId = exec.taskId` L1142; `task.findUnique select {teamId, mainAgentInstanceId}` L1144-1147; task-level → `memoryTaskId = taskId` L1160-1162; team-level → teamId from task row (task w/o team → 400) L1163-1169; global → `mainAgentInstanceId === selfInstanceId` else 403 L1170-1176; source lookups: `taskAgent.findUnique` L1192-1195, session by `taskAgentId` L1197-1200, channel `{taskId, taskAgentId}` L1207-1210; `memory.create {taskId: memoryTaskId, teamId: memoryTeamId,…}` L1214-1231. `memories.task_id` NULLABLE (schema L808) + `team_id` L809-ish — team/global rows already null-taskId-capable.
- `memorySaveForTeam` L1025-1101: ⚠️ STRUCTURAL for task-level — `level === 'task'` → 400 "needs task context" L1036-1038 (no team-anchored task memory exists); team/global writes `taskId: null` L1086, session lookup `{teamId, teamMemberId}` L1077-1080. teamId+memberId suffices for team/global only.
- `memorySearch` L1246-1378: team branch L1290-1301 (team+global OR; explicit task level → 400 L1291-1294); task branch L1302-1328 needs `task.findUnique` L1303 for teamId, pushes `{level:task, taskId}` L1314-1316. Consequence: team-only callers never see task-level memories (visibility partition, fact).

### E. plans — subagent assignment (assigneeInstanceId ta_ vs tmm_)
- MCP `planSubmit` (platform-mcp.service L1388+): `assertWorkerTask(taskId, selfInstanceId)` L1414 (ta_-scoped); `task.mainAgentInstanceId === selfInstanceId` main-only gate L1426-1431; `plan.findUnique({taskId})` L1433 (`plans.task_id` ⚠️ STRUCTURAL `@unique`, schema L762 — one plan per task, no team-keyed lookup).
- MCP `planTaskTransition` L1705-1751: same assert L1714; `planTask.plan.taskId === args.taskId` ownership L1737-1742; `isAssignee = assigneeInstanceId === selfInstanceId` (ta_ compare) L1744, `isMain` (ta_) L1745 → else 403 L1746-1751.
- `plans.service.ts`: `resolveAssigneeOverview` maps `assigneeInstanceId → taskAgent` rows scoped `where {id IN ids, taskId}` L142-156; `assignReviewer` validates `where {id: reviewerInstanceId, taskId: plan.taskId, removedAt: null}` L334 (task_agents table — ta_ domain); `findTaskGroupChannel(taskId)` L130-132 `{taskId, task_group}`; `findByTask` authZ `assertTaskMember` = taskId→teamId→teamUserMember L90-104. No `tmm_` handling anywhere in plans/ (grep: all assignee refs are ta_).
- plans.controller/service + DTO: `GET /plans?taskId=` required (`query-plans.dto.ts` L6-12 "一任务一计划"); all reads keyed `where {taskId}` (service L196). Team-only insufficient: which task's plan is unanswerable without task resolution (plan has no teamId column — schema L762-774 task-only FK).

### F. questions/instances referencing task sessions
- `questions.service.ts`: `findAll({taskId?, status})` L91-97 task-scoped补拉; reply path L197-328: `row.taskId` → worker lookup L283 (`{taskId, agentId}`-ish反查), `managedModeOf(taskId)` L372-377 (`task.findUnique`, falsy taskId → false L373), `scopeOf(taskId)` L383-384; `mainAgentSessionOf(taskId)` L539-548 session `where {taskId, taskAgentId: mainAgentInstanceId}`; platform-created questions use `sessionId = mainAgentSession ?? 's_placeholder'` L449 (placeholder debt). Controller `assertTaskMember(taskId)` L86-102: taskId→teamId→teamUserMember.
- Instances: `chat.service.ts` L1448 `tmm_`-first sender resolution; dispatcher L1022-1076 dual lookup; `tasks.service` L85/L1108 session-per-instance invariant. `issues.service.ts` member check `task_agents.id` for `ta_` refs (L131-150, L180) — same ta_-anchored pattern as plans (out of scope but adjacent).

### G. structurally-required list (for unification plan input)
1. `AgentQuestion.taskId` NOT NULL (schema L838) — team-path `''` writes today (ingress L812).
2. `uk_sessions_task_agent` frozen by design (lifecycle L39-41, schema L280); team key only covers task-less rows (schema L264-265).
3. `plans.task_id @unique` + zero teamId on plan/planTask (schema L762-795); assignee/reviewer validated against `task_agents` (ta_) — plans.service L156/L334, mcp L1744-1745.
4. Finalize `messages.task_id` writes in task branch (dispatcher L2137/L2144) — nullable column so writability is fine, but every task-branch write path sets it (FK Restrict to tasks.id).
5. Execution registry + watchdog keyed by taskId string (dispatcher L805/L2068-2075) — in-memory structural coupling, not DB.
6. `TaskGroupInstance.task_id` NULLABLE + team dims present (migration 20260904000000) — NOT blocking; task-mode writes remain task-keyed by choice, not constraint.

## session-unification research 4/4 (2026-09-07, read-only)
Frontend (`web/app/(main)/teams/[id]/session/page.tsx`):
- `sessionByAgent: Record<string,string>` state (:98) keyed by `instanceId ?? agentId` (:604, `onAgentStatus`), with `agentIdBySessionRef`/`instanceIdBySessionRef` maps (:102-103) seeded from `currentTask.instances[].sessionId/sessionStatus` (:478-497); `onSessionUpdated` (:613-622) resolves sessionId→agent/instance key then `setSessionByAgent(prev=>({...prev,[key]:status}))`. Key has NO taskId dimension — task scoping is indirect via `currentTaskId` closure.
- Session labels: `sessionLabel` (:468-474) = first `active|running` entry not in loadingByAgent → `${stateName} 会话运行中`; `TeamMembersPanel` (:242-252) resolves `sessionStatusByAgent[instanceId ?? id] ?? [agentId]` → working=running「工作中」/idle「空闲」/else「就绪」 + `data-testid="session-status"` (:1082). T6 comment (:239-241) notes session stays agentId-dimension because `session.updated` payload lacks instance id (old protocol).
- Message taskId partitioning: group send attaches `...(isGroupTab && currentTaskId ? {taskId: currentTaskId} : {})` (:722); private/DM sends NEVER attach taskId (DM has no task-partition semantics — server `chat.service.ts:833/1049/1172/1439`). Group history `GET /channels/:id/messages` (:169) sends NO taskId filter; header copy says 「历史跨任务可见」 (:1011) and 「常驻群聊 · 按团队复用，切任务不切群」 (:921). Private history uses `GET /channels/:id/session-history` (:179) with `messages` fallback (:183-184).
- Task-scoped filtering lives in event handlers, not queries: `onAgentStatus` drops `payload.taskId !== currentTaskId` (:597); `onAgentQuestion` same (:654); `onTeamChanged/onTaskStatusChanged/onArtifactSubmitted/onIssueChanged` only invalidate `["task",currentTaskId]`-family keys when payload.taskId matches (:627-644). `useRealtimeEvents` scope string includes `,task:${currentTaskId}` (:515). `use-realtime.ts:140` + `use-sse.ts:57,91` document that `session.updated` emits only {sessionId,status,workerId} (no taskId/agentId) so frontend must map via sessionId→agentId.
- Session view task scope points: `currentTaskId = team?.currentTaskId` (:134) drives `["task",currentTaskId]` + artifacts/issues/plans/questions queries (:136-222), header current-task pill `data-task-id` (:908-916), member-menu gating `hasCurrentTask ? … : undefined` for toggle/reset/model (:942-944, :947), `teamEditable` similarly. Group vs private rendering split: group strips to text-only non-synthetic parts, private passes through reasoning/thinking/tool (:1030-1037, comment :1026-1028).
Backend teams queue/plan flows reading sessions by task:
- `tasks.service.ts` session create per member per task (:453-462: `session.create {taskId, taskAgentId:taId, agentId, teamMemberId, status:created}`); unique key `uk_sessions_task_agent (taskId,taskAgentId)` (`session-lifecycle.service.ts:39-46`); `toTaskDto` exposes `sessionStatus/sessionId = ta.sessions[0]` (:1777-1778) — per-task per-instance single session row.
- `promoteNextInTx` (`tasks.service.ts:576-653`) + `promoteNext` (:658-662) read ONLY team/queue (FOR UPDATE team row, teamQueue head, `currentTaskId` flip, queued→pending, delete head, renumber positions, broadcast TEAM_QUEUE_CHANGED promoted/idle) — reads NO session rows. Sessions for the newly promoted task already exist from create-time snapshot; no session lookup by task on promote path.
- `resetSessions` paths DO read sessions by team-member set then carry taskId through: `teams.service.ts:742-845` (`teamMember.findMany` → `session.count/findMany where teamMemberId in memberIds` :750-761/:788-799, per-row `taskGroupInstance.updateMany where {taskId:s.taskId,workerId,instanceId:s.instanceRef}` :806-814, delete+create new `s_` rows preserving `taskId/taskAgentId/agentId/teamMemberId` :817-830, sys msg 「已为下一任务开新会话」 :833-843) and canonical impl `session-lifecycle.service.ts:289-350 resetTeamSessionsInTx` (same shape; called from `tasks.service.ts:1669-1672` accept/archive when `!reuseSession || resetAfterComplete`, plus separator sys msg :1673-1690).
- Plans reviewer `ta_` refs are TaskAgent-instance scoped, not session scoped: `plans.service.ts:43 reviewerInstanceId`, `review()` clears `reviewerInstanceId→null` (:279-285) + sys msg (:286-297), `assignReviewer(planId, reviewerInstanceId)` validates `taskAgent.findFirst where {id:reviewerInstanceId, taskId:plan.taskId, removedAt:null}` (:333-342) then writes `plan.reviewerInstanceId` (:348-351). No session table read in plans flow; task binding is via `plan.taskId` + channel lookup `findTaskGroupChannel(plan.taskId)`.
- Chat server task partition: group messages carry `taskId` (`chat.service.ts:771-836 effectiveTaskId`, queued-hint sys msg `taskId: effectiveTaskId` :1196-1206); DM `taskId` forced null (:833/:1049/:1172/:1439). BUT `findMessages` (:349-373) filters ONLY `{channelId, id<cursor}` — no taskId filter; `mergeSessionWithPlatform` (:591-622) merges by channelId only. So task partitioning is write-side attribution + separator sys messages, not read-side filtering.
What breaks if sessions lose task binding (visual/functional):
- Per-task session status: `currentTask.instances[].sessionStatus/sessionId` seed (:478-497) + `toTaskDto` snapshot (:1777-1778) collapse to one global row per member — header pill, members-panel 工作中/空闲/就绪 dots, `session-status` label, and `reset-session` per-instance (`POST /tasks/:id/instances/:iid/reset-session` :796-804, server :1108-1143 delete+create by taskAgentId) lose their per-task target.
- Message task separators: group history is intentionally cross-task (:1011); separators are sys msgs (「已为下一任务开新会话」 teams :839/tasks :1682, queue排队提示 :1196-1206, plan review/assign :273-275/:344). Without taskId on sessions/messages, accept/archive reset still fires but the separator + `task:` SSE scope (:515) + taskId-mismatch guards (:597/:654) can't attribute which task's boundary it was.
- Queue/promote correctness: `currentTaskId`/queue UI (`TeamRightPanel.tsx:42,50,157,205`, `teams/page.tsx:99-102`, `[id]/page.tsx:265-335`, `TaskDetailDrawer.tsx:339`) + `enqueueQueue/cancelQueue/promoteNext` all key off taskId; sessions keyed team-global would leak running state across queued→promoted handovers (promote path reads no sessions, so nothing re-binds them).

## session-unification research 2/4 (2026-09-07): task-mode vs team-mode dispatch diff — facts only
- Scope: `server/src/chat/worker-dispatcher.ts` `dispatch()` L973-1018 routes `dispatchForTarget()` L1077-1592 (task) vs `dispatchForTeamTarget()` L1702-2009 (team); `message-dispatcher.ts` L17-35 `DispatchRequest{messageId,channelId,taskId,text,targets}`; `toExecutionScope()` L735-743; `buildSystemInstructions()` L217-281.
- Router (L976-996): `teamMode = !request.taskId`; `teamId` read from extended field `(request as {teamId?}).teamId` L977-978; per-target branch L981-990; catch scope L994-996 `teamMode ? toExecutionScope(null,teamId) : request.taskId`; `emitError({taskId: scope})` L1001-1005; `broadcastAgentError({taskId: scope, ..., teamId?})` L1006-1014 with `{type:'team'}` vs `{type:'task'}` inside `broadcastAgentError` L4230-4232.
- Session selection: task L1088-1097 `session.findUnique({id: target.sessionId})` select `workerId/instanceRef/taskAgentId/teamMemberId`, throws if `!target.sessionId` L1082-1084 or `!session` L1098-1100; team L1713-1747 `teamMemberId = target.instanceId ?? null`, missing → throw L1714-1718 (no fallback); `!sessionId → ensureTeamSession(teamId,teamMemberId)` L1722-1728; then `session.findUnique` select `workerId/instanceRef/teamId/teamMemberId` L1729-1738 + strict match `teamMemberId/teamId` else throw L1739-1747.
- Worker bind/reuse identical shape, different session key: task L1104-1142 `PENDING` stale check + `assignWorker` + `bindSessionToWorker(target.sessionId,...)`; team L1750-1776 same on `sessionId` (ensured); offline-rebind blocks identical (task L1149-1189 vs team L1779-1819) incl. `opencodeSessionId=null` reset + re-bind; `createSession` + second bind task L1257-1276 vs team L1874-1891 (same rollback via `unbindSession`).
- Model resolution: task L1113-1125 `taskAgent.overrideModelId` lookup (by `session.taskAgentId`) overrides `resolveAgentModelId(target.agentId)` (C7 chain L3634-3662); team L1759-1762 `resolveAgentModelId` only, NO `overrideModelId` lookup; both `toModelSelection(agentModelId ?? workerRow.defaultModelId ?? null)` (task L1197-1199 vs team L1825-1827) and `toModelSelection` L3665-3679.
- Prompt construction: task L1204-1233 `【任务上下文】你的当前任务ID：${taskId}。…chat_history/doclib/task_context（传taskId）…group_post（{taskId,content,fileRef?}）` L1207-1211; group trigger L1214-1223 fires on `task_group OR team_group` → `GROUP_TRIGGER_INSTRUCTION` L288-292 (`group_post {taskId,...}`); team L1829-1851 `【团队上下文】你当前在团队 ${teamId} 直聊（无任务）。…chat_history/group_post（传teamId）` L1831-1834; trigger L1839-1841 fires ONLY on `team_group` → `TEAM_GROUP_TRIGGER_INSTRUCTION` L300-308 (`{teamId,selfInstanceId,...}`, bans taskId, bans my_profile/team_view/doclib/issue/plan/task_transition). WeCom: task L1224-1231 tailored carries `{taskId,selfInstanceId,text,atUser?}`; team L1842-1849 tailored drops param list (generic `wecom_reply`, no taskId). Both append `request.text` last + optional image pointer (`resolveImageAttachments(request.messageId)` task L1532 vs team L1956, shared impl L4146-4180).
- System instructions (`buildSystemInstructions` L217-281): task `execute().system` L1545-1555 passes `isMainAgent, mainAgentInstanceId, team, selfInstanceId=(teamMemberId ?? taskAgentId), selfAlias, taskInstanceId=session.taskAgentId, persistentWorkDir=taskWorkDir, executionMode=taskRow.executionMode, memoryIndex`, NO `teamMode/taskId` keys → `isTeamMode=false` L256-261; team `execute().system` L1968-1977 passes `isMainAgent, mainAgentInstanceId=mainAgentMemberId, team, selfInstanceId=teamMemberId, selfAlias, persistentWorkDir=teamWorkDir, teamMode:true, taskId:''` → appends `TEAM_SYSTEM_RECEPTION_INSTRUCTION` L319-328, NO `taskInstanceId/executionMode/memoryIndex`. Identity line dual-id only in task path (L225-233 `taskInstanceId != selfInstanceId` → `团队成员id + 任务实例id`); team path single `tmm_` id. Main-agent rule differs: task L1392-1413 `selfInstanceId == task.mainAgentInstanceId` + ta_→tmm_ mapping via `taskAgent(agentId,seq)`; team L1936-1940 `teamMemberId == team.mainAgentMemberId`. Team roster: task L1314-1357 `teamMember(teamId)` non-empty else `taskAgents` snapshot (+ L1358-1387 empty-team fallback re-query); team L1911-1931 `teamMember(teamId)` only, empty allowed. `PLAN_CAPABILITY_INSTRUCTION` both (L262); `PLAN_WORKFLOW+REVIEW_CHECKLIST` only when `executionMode==plan` (task only, L263-266). Memory index block L277-279 only built in task path L1441-1507 (`memory.count/findMany` task+team+global, ≤1200 chars); team path never builds/passes it.
- Memory injection: task-only (see above); team prompt+system contain zero memory counts/tags/descriptions.
- Workdir (`resolveAgentWorkDir` L4066-4115): task call L1287 `resolveAgentWorkDir(taskId, session, target)` → `taskAgent.workDir` → `/data/vteam-worker/<sanitize(name)>[-seq]` (L4092-4099, L4119-4122) → agent-name fallback L4103-4113 → `ensureTaskWorkDir <根>/tasks/<taskId>` L4037-4043; team call L1894-1899 `resolveAgentWorkDir('', {taskAgentId:null}, target, teamId)` → early return L4072-4074 `ensureTeamWorkDir <根>/teams/<teamId>` L4046-4056. `directory` passed to `execute()` = `taskWorkDir` (task L1539) vs `teamWorkDir` (team L1963); same value also injected as `persistentWorkDir` system line L246-249.
- `channelId` passed to worker `execute()`: both pass through `request.channelId` unchanged (task L1542 vs team L1965). Difference is only what the id denotes (task-group/private channel vs team-group/DM channel) and what the prompt/system tell the model to do with it (`group_post {taskId}` vs `{teamId}`).
- `taskId` flows into worker `execute()` (task path L1536-1556): (1) `prompt` text L1208 `【任务上下文】…任务ID：${taskId}` + `GROUP_TRIGGER`/`WECOM` param hints naming `taskId`; (2) top-level `execute({taskId})` L1540 — team path L1960-1978 omits the key entirely; (3) `system` indirectly: `team[]` instanceIds (`ta_`/`tmm_`), `selfInstanceId/taskInstanceId`, `mainAgentInstanceId`, `executionMode`, `memoryIndex` (all task-scoped queries), but no raw `taskId` string except via workdir path; (4) `channelId` L1542 is the task's channel (resolves via `resolveChannel(taskId,...)` L1425-1429); (5) `sessionId` L1543 is the opencode session bound to the platform session whose row carries `taskId/taskAgentId`. Team path equivalents: (1) prompt carries `teamId` L1832, bans `taskId` L300-308; (2) no `taskId` key; (3) system carries `team[]` (`tmm_` only), `selfInstanceId=tmm_`, `mainAgentMemberId`, `teamMode:true,taskId:''`; (4) `channelId` = team channel; (5) `sessionId` bound to `(teamId,teamMemberId)` session.
- Watchdog/scope keys: `pending` key `${taskId}:${agentId}` L3702; task calls `startPendingWatchdog(taskId,...)` L1585-1591, team calls `startPendingWatchdog(scope,...)` L2002-2008 where `scope=toExecutionScope(null,teamId)` = `` `team:${teamId}` `` L1711 (+def L735-743); `pendingBySession/lastActivityAt/completedSessions/failedSessions` keyed by platform `sessionId` in both (L3736-3738, L1980-1981, L1562-1563). `registerExecution(workerId, taskId|scope, ref)` task L1419-1423 ref=`teamMemberId ?? taskAgentId ?? agentId`, team L1943 ref=`teamMemberId`; `executionKey=workerId:taskId|scope` L805-807. `clearPendingWatchdog(taskId|scope, agentId)` on reflow: task `handleTaskCompleted` L2075 vs team `handleTeamTaskCompleted` L2877 `clearPendingWatchdog(scope,agentId)`; team reflow entry `handleTaskCompleted` L2024-2027 branches `!taskId && sessionId → handleTeamTaskCompleted` L2846-2954 (session反查 teamId/teamMemberId L2860-2866, `resolveTeamChannel` L2879, `taskId:null`落库 L2922, team_group回退仅 emitFinal L2892-2895).
- Loading broadcast scope: task thinking L1236-1247 + operating L1566-1577 `broadcast(AGENT_LOADING, {taskId, agentId, instanceId: teamMemberId ?? taskAgentId, sessionId, phase}, {type:'task', id:taskId})` + `emitLoading({taskId,...})` L1248-1254/L1578-1584; team thinking L1854-1864 + operating L1984-1994 `broadcast(..., {taskId: scope, agentId, instanceId: teamMemberId, sessionId, phase}, {type:'team', id:teamId})` + `emitLoading({taskId: scope,...})` L1865-1871/L1995-2001. Dispatch-catch error broadcast follows same scope split L1001-1014. Cleanup-channel query differs: task `resolveChannel(taskId,agentId,teamMemberId ?? taskAgentId)` L3511-3563 (teamId→DM→team_group→legacy) vs team `resolveTeamChannel(teamId,teamMemberId)` L1682-1694 (`(teamId,teamMemberId)` DM → `team_group`).
- Load-bearing vs incidental (for task execution; no proposal): load-bearing — prompt context line (`taskId` vs `teamId` tool-call contract, L1207-1211 vs L1831-1834) because MCP tools enforce `taskId`-required/403 (`TEAM_GROUP_TRIGGER` L306 bans taskId; reception L326-327 bans taskId); top-level `execute({taskId})` presence/absence (L1540 vs omitted L1960-1978) because reflow branches on it (L2024-2027) and worker/MCP attribute calls by it; `overrideModelId` lookup (task-only L1114-1120) because per-instance model override would be lost; `executionMode`+plan-workflow injection (task-only L1553/L263-266) because plan-mode gating lives there; memory index (task-only L1441-1507) because retrieval hints vanish; workdir root (`tasks/<taskId>` vs `teams/<teamId>`, L4037-4056) because file/artifact paths diverge; `registerExecution`/watchdog key domain (`taskId` vs `team:teamId`, L805-807/L3702) because MCP `assertWorkerTask` and idle/timeout attribution key off it; main-agent gate source (`task.mainAgentInstanceId`+mapping L1392-1413 vs `team.mainAgentMemberId` L1936-1940) because who gets `MAIN_AGENT_INSTRUCTION` changes. Incidental (same mechanics, different key): stale-pending check, assignWorker+bind, offline-rebind, createSession+second-bind, `resolveAgentModelId→toModelSelection` core, image-attachment plumbing, thinking→operating two-phase shape, `completed/failedSessions` reset per dispatch (L1562-1563 vs L1980-1981).
- Unification input (facts only): if the session is always a team session, the task-context items currently carried by session identity that must arrive as data are: `taskId` string (prompt L1208 + `execute.taskId` L1540 + `resolveChannel/cleanupChannel` L1425-1429 + `resolveAgentWorkDir` L1287); `taskAgentId` as `taskInstanceId` (system dual-id L225-233/L1551 + `registerExecution` ref L1422 + loading `instanceId` fallback L1241-1242); `task.mainAgentInstanceId + executionMode + teamId` (taskRow query L1302-1312 + main mapping L1392-1413 + plan/memory/workdir derivations); per-dispatch `request.channelId` stays pass-through in both paths today (L1542/L1965).

## session-unification Todo 1 (2026-09-07): single team dispatch entry
- Failing-first held: 2 new specs red pre-impl (taskContext ignored → execute.taskId undefined; missing-teamId emitted not threw), green post-impl. Baseline 144/144 → final 143/143 (deleted 621-main-CR-dup + 672-no-fallback-by-design + old emitError-shape test; added passthrough + 400 tests).
- Deletion via 3 anchored Edit chunks (doc→prompt / loading→selfInstanceId / main-gate→watchdog tail); zero-check by grep (LSP server not installed, user-declined): dispatchForTarget refs were only dispatch() call + own docstring. No task-only private helpers existed (resolveChannel/buildSystemInstructions/resolveAgentWorkDir/GROUP_TRIGGER shared or Todo-2-owned) — recorded, nothing else deleted.
- Execute wire subtlety: `taskId: taskContext?.taskId ?? ''` keeps the KEY always; worker client omits falsy on the wire (`...(opts.taskId ? …)`), so team path behavior unchanged while mocks see `''`. Old `toBeUndefined` assert → `toBe('')`.
- Scope-change asserts are the bulk: broadcasts `{type:'team'}`, error/loading `taskId: 'team:<id>'`, watchdog keyed by scope. Row-routed leftovers (markSessionIdleDead reads row.taskId; clearPendingWatchdog(taskId,agentId) in finalize) NOT touched — Todo 3/10 own them; tests adapted via ingress-faithful dual-notify (activityCb task.completed with sessionId) + Todo-N notes, never product edits outside the 3 files.
- dispatchAgentMention bridge (same-file call site, scope-unification only): teamId via task row + taskContext passthrough; ta_/tmm_ lookup rewrite stays Todo 5.
- chat.service send-path: teamId always (was only when !dispatchTaskId) + taskContext when non-empty; effectiveTaskId derivation untouched (DM null, queued-hint kept); ugly `as … & {teamId?}` cast deleted (fields now typed).
- chat.service.spec needed a 2-line expectation update (exact dispatch-arg assert) — direct contract fallout of the in-scope change, disclosed. worker.client.ts:169 stale `dispatchForTarget` comment-word left (foreign file; F1 will trip — note for owner).
- Integration spec (3 tests) red via new teamId gate — NOT migrated (needs Todo 5/7 product context); itemized for Todo 13 sweep.
- Evidence: `.omo/evidence/session-unification/su1-happy.log` (143/143 EXIT 0) + `su1-failure.log` (400 test EXIT 0); live-curl deferred to Todo 14 (no deploy in unit lane — passthrough + scope-string asserts stand in). No schema change → prisma generate N/A. Two placeholders during deletion consolidated to one section marker.
- Dirty-worktree caution: all 5 touched files had large pre-existing diffs vs HEAD (siblings' uncommitted work) → NO commit; DoneClaim lists files for lane coordinator.
