# Decisions — remove-project-dimension

Architectural choices and rationales discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## T9 (2026-09-07): Prisma migration + seed cleanup (project dimension drop)
- Backup first, local-only: `docker exec aiagents-compose-db mysqldump` (host has no
  mysql/mysqldump binaries; compose DB exposes no host port) -> evidence t9-happy.log
  line 1. All migrate/seed verification ran on an isolated temp MySQL 8 container
  (127.0.0.1:13306, removed afterwards); compose dev DB was read-only for T9.
- Todo 5 was schema-only (no migration): live DB had no memories.team_id, so the T9
  migration includes the ADD COLUMN + idx (add-then-drop step 1), matching plan
  acceptance (1). "Do NOT re-add" resolved by live-DB check, not by assumption.
- Backfill handles EITHER value: 2a in-place convert for rows already carrying
  team_id (T5/T7 compat); 2b single-team direct; 2c multi-team = INSERT copies for
  non-first teams FIRST then UPDATE original to first team (so T7 rows never spawn
  copies); 2d zero-team/orphan -> global; 2e task rows project_id nulled; 2f sweep.
- Copy ids CONCAT('me_mig_',UUID_SHORT()) = <=27 chars, fits VARCHAR(191).
- FK names are Prisma-deterministic (tasks_project_id_fkey / memories_project_id_fkey);
  same history replays on scratch rebuild, so the shipped DROP FOREIGN KEY names hold.
- Drill over backup-restore copy proved every branch (single->direct observed on live
  rows; multi/zero/task-stale/T7 via fixtures) before drops; full rebuild-from-scratch
  (empty DB migrate deploy + seed) doubles as the rollback drill (t9-failure.log).
- Seed note: 模型目录 seeds 0 rows in this checkout (buildModelSeedRows empty) —
  pre-existing, untouched by T9 (no seed.ts-adjacent files in scope).
- LSP unavailable (user declined install); verification = prisma validate + ts-node
  seed compile + migrate/seed green + SQL-level spot checks.

## T12 (2026-09-07): docs + READMEs project->team (F1 residual grep for docs scope)

- Files changed (26): docs/agent-platform/09-API设计.md (Projects section ->
  Teams, tasks routes POST/GET /tasks teamId, [project]->[team]), 13-任务状态机
  (projectId field->teamId, routes, 团队成员), 14-Agent配置与虚拟团队模型
  (permissionScope teams, 团队成员, POST /tasks), 15-数据模型细化 (drop
  projects/project_members tables + ER + relations + idx_tasks_team_status,
  23表->21表), 28-团队模型与排队设计 (POST /tasks, TeamMembershipGuard),
  08-平台架构设计 (TeamsModule, teams tables, tasks.team_id), 18-推进计划
  (routes/tables/indexes/prose), 03-FR-22~25 (team org model),
  02-用户与场景 (org model + user stories), 04/05/06/10/16/17 (scope prose,
  owner_type project->team), prototypes/role-permission/index.tsx (scopeType
  projects->teams + prose), docs/test-cases/00/01/02/03/04/06 (routes/codes/
  fields/bodies -> team + tm_0000000001), docs/deployment.md:81 (seed teams),
  docs/code-review-2026-08-report.md (redirect /teams), README.md +
  server/README.md + web/README.md (seed teams, module/page tables).
- Untouched by design: md-docs/, docs/test-reports/ (excluded history);
  01/11/18-审计/19/20/21/26/29/QA (generic product language or point-in-time
  records, all F1-clean); `project_manager` agent role name kept everywhere.
- Verification: scope-files F1 grep = 0 hits (evidence t12-grep.log is the
  repo-wide run with dist/.next excluded: 123 residual lines, ALL out of T12
  scope -> T11 e2e+specs (web/e2e, server specs, team-queue e2e),
  T8 leftovers (chat.service.ts comments, plans/issues controller comments),
  tracked root scratch *.mjs + learnings.md + .playwright-mcp logs,
  untracked prototype-viewer. F1 zero needs T10/T11 + rebuild + scratch
  cleanup in the final wave. Concurrent T10 session already cleaned web/app+src
  (projects page deleted) in the shared tree.
- No code files touched (docs/prose/comments only); no build/lint applicable
  to md (grep is the QA).
