# VERDICT — deploy-su-clean (session-unification clean-slate deploy + smoke)

- Date (UTC): 2026-09-08 ~00:12–00:35
- Workdir: /Users/mac/01work/git-project/vteam
- Stack: shared compose (db/server/web/worker + init), `down -v` authorized, rebuilt `--build`
- Evidence dir: `.omo/evidence/deploy-su-clean/` (deploy.log, smoke.log, console-status.log, 10 PNGs)
- Product edits: ZERO (no edit/write to server|web|docs|specs; only evidence + learnings append)

## Deploy

| Check | Result |
|---|---|
| Pre-state recorded (compose ps + images, 16–20h old) | PASS → deploy.log head |
| `down -v` wiped volumes (mysql_data, worker_home, uploads, vteam_worker_data) | PASS EXIT 0 |
| `up -d --build`, all images Created fresh | PASS |
| init: all migrations incl. 20260907000001_drop_task_agent_domain + seed | PASS (log tail in deploy.log) |
| :13000/health → 200, web :13001 → 200, worker w_compose_worker registered (GET /workers 200, models listed) | PASS |
| Fresh-seed asserts: 0 tasks; tm_0000000001 + 5 team_members + 2 owners (tum_admin_seed/u_admin, tum_0000000001/u_seed_admin); teams.managed_mode present; task_agents ABSENT; sessions WHERE task_id NOT NULL = 0 | ALL PASS |

## Smoke verdict table

| # | Step | HTTP | Visual | Verdict |
|---|---|---|---|---|
| 1a | login seed-admin → /teams | 200 | 01,02 | PASS |
| 1b | /board → /teams redirect | 200 (settled /teams) | 03 | PASS |
| 1c | /projects → 404 (web Next 404 + API `Cannot GET /api/v1/projects`) | 404/404 | 04 | PASS |
| 2a | Create team smoke-su-clean first-try (T15 regression) | 201 tm_0000000002 | 02,05 | PASS |
| 2b | Create task in team | 201 t_0000000001 | 05,06 | PASS |
| 2c | DB: zero task-bound sessions (before + after lifecycle) | SQL 0 rows | smoke.log | PASS |
| 3a | Group @ execution → reply (warm path, t2) | 201 → dispatched → agent msgs m_0000000012/m_0000000016 | 06 | PASS (with F-A caveat) |
| 3b | DM chat round-trip (API + UI live, reply <5s, reasoning parts) | 201 → agent m_0000000003 | 10 | PASS |
| 3c | Agent tab spinner → red dot spot-check | n/a (API parts + UI 运行中 badge) | 10 | PARTIAL (badge captured; no isolated red-dot frame) |
| 4a | Issues create/flow (start→resolve→close) + team filter | 201×4 + 200 filter | 07 | PASS |
| 4b | Memories team write (MCP memory_save) → read back total=1, sessionId=s_0000000001 taskId=null | 200 (result me_0000000001) | 08 | PASS |
| 4c | Memories level=task rejected (REST 400 + MCP -32602) | 400 / -32602 | smoke.log | PASS |
| 4d | Users team-count (`_count.teamUserMembers`) | 200 | smoke.log | PASS |
| 4e | Roles global-only (`scopes.global`, no team scoping) | 200 | smoke.log | PASS |
| 5a | Task lifecycle start→review→accept→archive | 201×4, archived | API+07 ref (09 = no /tasks/:id route, drawer UI) | PASS |
| 5b | managedMode toggle on/off + questions list | 200/200/200 | smoke.log | PASS (question-confirm full routing not triggered — no agent question arose; feasible-check only) |
| 6a | Non-member task create → 403 PERMISSION_TEAM_NOT_MEMBER | 403 | smoke.log | PASS |
| 6b | Unknown member reset → 404 MEMBER_NOT_FOUND | 404 | smoke.log | PASS |
| 6c | GET /api/v1/projects → 404 | 404 | smoke.log+04 | PASS |

## FAIL / findings (all with screenshot + body, product untouched)

- **F-A — group @ cold-start silent drop.** First group @ on a team with a current task but no team session yet → 201, trigger `no_session`, NO dispatch, NO error, NO session created (chat.service: effectiveTaskId inherits current task → task-mode resolve → flip branch at :889 skipped). Evidence: smoke.log GROUP-AT + GROUP-POLL0..3 (only user msg), sessions table (only s_0000000001 from later DM). Narrowed: after any team session exists, same call → `dispatched` (GROUP-AT-T2).
- **F-B — archived latest task bricks team_group sends.** POST /channels/<team_group>/messages after t_0000000001 archived → 409 TASK_ARCHIVED (resolveChannelAccess fallback `findFirst latest task` :1599 + archived guard :819). Mitigated by creating t_0000000002 (currentTask path). Evidence: smoke.log GROUP-AT-RETRY.
- Both are follow-up bugs for the owning lane; NOT fixed here (zero product edits per MUST NOT DO).

## Console triage (console-status.log)

- `/projects` resource 404 → EXPECTED (route removed).
- `/api/v1/plans?taskId=` 404 on session page → pre-existing noise (plan panel probe; page fully functional, shot 06).
- `/tasks` + `/tasks/:id` → no web list/detail route (drawer-based UI; 09 records Next 404). Pre-existing; lifecycle evidenced via API + issues page.
- Zero pageerrors; zero other console.errors across 8-page tour.

## Residual state (left intentionally)

- Stack LEFT RUNNING (dev env): db/server/web healthy, worker up.
- Smoke data remains: team tm_0000000002 (+2 members), tasks t_0000000001 (archived) / t_0000000002 (pending, current), issue is_0000000001 (closed), memory me_0000000001, channels c_0000000002/c_0000000003, sessions s_0000000001, messages m_0000000001… — record for later cleanup.
- Temp scripts in /tmp only (su_smoke.py, run*.py, tour.mjs, live*.mjs, probe.mjs); tokens only in /tmp + redacted logs.
