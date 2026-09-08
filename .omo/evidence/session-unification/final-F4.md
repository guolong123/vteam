# Final-F4: 范围保真 (Scope Fidelity) — VERDICT: APPROVE

Date: 2026-09-07 (UTC) · Executor: Final Wave F4 · Zero code edits (read-only + suites + this file)

Plan reference: `.omo/plans/session-unification.md` → Final verification wave → **F4. 范围保真**：
"工具 grep + suite 重跑；排队/记忆/realtime/群聊分区与改造前一致；无新增 pid/兼容路由；外部会话改动 untouched"。

## 1. Suite 重跑（全部绿，log 实证而非仅 exit）

All commands run in `server/` with `> /tmp/f4-*.log 2>&1; echo "EXIT:$?"` (no pipe exit-eating).
Adversarial check `misleading_success_output`: every EXIT was cross-verified against
`Tests:`/`Test Suites:` lines and absence of FAIL/✕ in the captured log.

| Suite | Command | EXIT | Log proof |
|---|---|---|---|
| task status-machine | `npx jest src/tasks/tasks.service.spec.ts src/tasks/task-progression.scheduler.spec.ts src/tasks/tasks.controller.spec.ts` | 0 | `Test Suites: 3 passed, 3 total` · `Tests: 153 passed, 153 total` (`/tmp/f4-tasks.log`) |
| teams/questions | `npx jest src/teams/teams.service.spec.ts src/teams/teams.controller.spec.ts src/questions/questions.service.spec.ts src/questions/questions.controller.spec.ts` | 0 | `Test Suites: 4 passed, 4 total` · `Tests: 113 passed, 113 total` (`/tmp/f4-teams-questions.log`) |
| team-queue e2e | `npx jest --config ./test/jest-e2e.json test/e2e/team-queue.e2e-spec.ts` | 0 | `Test Suites: 1 passed, 1 total` · `Tests: 10 passed, 10 total` (`/tmp/f4-teamqueue-e2e.log`) |

Behavior preserved by these suites: FIFO queue + promote + version CAS (`建任务B→queued`, `并发队首竞争`,
`完成A后B自动current`), group-chat partition + cross-task history, reuseSession reset,
SSE `team:<id>` scope + latency ≤1000ms, task state machine transitions, team/question 403 semantics.

## 2. 无新增 pid/兼容路由

- `grep -rn "pid" server/src --include="*.ts" | grep -v spec` → hits are only `appid`
  (wecom card_action fields in `platform-mcp.service.ts`) + one historical comment
  (`remove-project-dimension Todo 7 去 pid`); **zero `pid/:pid/projects` route decorators**.
- `grep -rn "projects" server/src --include="*.controller.ts"` → **zero hits**
  (no `/projects` routes; plan OUT confirms `GET /api/v1/projects` unrelated).
- `grep -rni "compat..." *.controller.ts` → single pre-existing comment
  (`message-channels.controller.ts:311` test-send no-op note), no new compat route.
- Reset routes: only sanctioned Todo-11 team routes exist
  (`teams.controller.ts:129 `:id/reset-sessions``, `:139 `:id/members/:memberId/reset-session``);
  old `POST /tasks/:id/instances/:instanceId/reset-session` gone —
  `tasks.controller.spec.ts:104` locks the 404 (`旧 POST ... 已删除（404）`).
  Remaining `PATCH tasks/:id/instances/:instanceId` is a different endpoint, out of Todo-11 scope.

## 3. 备份已记录 (su6)

- `.omo/evidence/session-unification/su6-backup-20260907-213137.sql` exists (1853170 bytes).
- `su6-happy.log` line 1 = that exact backup path (plan Todo-6 "证据首行为备份路径" satisfied).

## 4. 外部改动 untouched（只读 git diff review，本轮零写入）

- `.omo/drafts/chat-followups-new-session.md` — untracked (`??`), content intact
  (team-free-chat follow-up task draft, header + 问题一/二 present).
- `web/src/components/ui/segmented-tabs.tsx` — untracked (`??`), content intact
  (SegmentedTabs component, token-based, header comment present).
- `web/src/components/ui/index.ts` — dirty-tree hunk is a clean 2-line append
  (`SegmentedTabs` export + type export), reviewed read-only via `git diff`, not modified.
- The 154-file dirty working tree (other session's concurrent work incl. above) was
  **never written to**: this run executed only `grep`/`git status|diff --stat|log` reads,
  `npx jest` runs (logs to `/tmp`, not the repo), and this evidence file.
  `git stash list` empty; no stash/checkout/reset performed.
- Adversarial note: pre-existing `M` entries were observed but not altered and not
  attributed to this plan; F4's duty is non-interference, which holds.

## VERDICT: APPROVE

- [x] team-queue e2e (10/10) + task status-machine (153/153) + teams/questions (113/113) — all green, log-verified.
- [x] No new pid/compat routes (route-decorator grep clean; only sanctioned Todo-11 team routes).
- [x] Backup recorded (su6 backup path exists, 1.85MB, referenced as su6-happy.log line 1).
- [x] Foreign work intact (chat-followups draft + SegmentedTabs + other hunks read-only, untouched).
- [x] Zero code changes made by this F4 run.

Evidence path: `.omo/evidence/session-unification/final-F4.md` (this file).
Raw suite logs: `/tmp/f4-tasks.log`, `/tmp/f4-teams-questions.log`, `/tmp/f4-teamqueue-e2e.log` (ephemeral; counts quoted above).
