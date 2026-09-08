# Final Wave F4 — Scope Fidelity Verdict: APPROVE

Date: 2026-09-07. Read-only gate. Zero product edits.

## 1. Suite re-runs (exits captured)

| Suite | Command (server/) | Result |
|---|---|---|
| team-queue e2e | `npx jest --config ./test/jest-e2e.json test/e2e/team-queue.e2e-spec.ts` | **10/10 pass** |
| tasks.service.spec + teams.service/controller.spec + questions.service/controller.spec | `npx jest src/tasks/tasks.service.spec.ts src/teams/teams.service.spec.ts src/teams/teams.controller.spec.ts src/questions/questions.service.spec.ts src/questions/questions.controller.spec.ts --runInBand` | **5 suites, 209/209 pass** (one expected noisy log: QuestionsService 409 hook error line, suite still PASS) |

Untouched subsystems (team FIFO queue, reuse/session, team-group chat partitioning, task status machine via service specs, questions) behave as before — no fidelity break found.

## 2. No new pid/compat routes

- `grep -rn -E "projects/:pid|:pid|/projects/" server/src/ --exclude='*.spec.ts'` → **zero hits** (exit 1, no output).
- With specs: single hit `server/src/tasks/tasks.controller.spec.ts:100` — absence assertion (`not.toContain(':pid')`), explicitly allowed per plan F1(a).
- Broader residual `projectId|ProjectMember|p_seed_|PERMISSION_PROJECT_NOT_MEMBER|PROJECT_MEMBERSHIP` in non-spec `server/src/` → **zero**. Web (`web/app web/src`) + `server/test` → **zero** (excluding absence-assertion lines).

## 3. Backup recorded

`.omo/evidence/remove-project-dimension/t9-backup-aiagents-20260907.sql` exists — 2,806,046 bytes, dated 2026-09-07 10:20.

## 4. Foreign work intact (read-only `git status` / `git diff HEAD` review)

- `web/src/components/ui/segmented-tabs.tsx` — untracked (`??`), foreign new file, not created/touched by this plan.
- `.omo/drafts/chat-followups-new-session.md` — untracked (`??`), foreign draft, untouched.
- `web/app/globals.css` (M) + `web/src/components/ui/index.ts` (M) — hunks are 100% foreign SegmentedTabs work (`--color-segment-active`, `SegmentedTabs` export); `grep -ciE project…` on the combined diff = **0**.
- `web/app/(main)/{git-repos,integrations,skills}/page.tsx` (M) — hunks are foreign SegmentedTabs refactor (SegmentedTabs import, `--color-segment-active`); 0 project lines each.
- `server/src/git-repos/git-{repos,credentials}.controller.ts` (M) — the single-line diff each is this plan's own Todo 3A decorator relocation (`../projects/current-user.decorator` → `../common/decorators/current-user.decorator`); in-plan, expected.

## 5. Observation (not a break, no action taken)

`server/src/chat/worker-dispatcher.spec.ts:4395,4484,4579` still contain `projectId: 'p_1'` inside task-mock payloads. These are pre-existing legacy mocks in a spec Todo 11 explicitly fenced off ("不得触碰 … worker-dispatcher.spec.ts"); they are mock data, not routes, and outside F4's exit criteria. Referred to F1 compliance audit; F4 does not fix per MUST NOT DO.

## VERDICT: APPROVE

All four F4 gates pass: suites green, no pid/compat routes, backup recorded, foreign work preserved.
