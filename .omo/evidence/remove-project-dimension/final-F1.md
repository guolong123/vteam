# Final F1 — 计划合规审计 verdict: APPROVE

- Date: 2026-09-07 (UTC)
- Auditor: Final Wave F1 executor
- Plan: `.omo/plans/remove-project-dimension.md` (F1 amended allowlist)
- Pattern: `projectId|ProjectMember|/projects|:pid|p_seed_|PERMISSION_PROJECT_NOT_MEMBER|PROJECT_MEMBERSHIP`
- Repo-wide raw hits: 1870 lines / 153 files (excl. node_modules/.git/dist/.next/coverage)

## 1. worker-dispatcher.spec.ts 3 mocks (done by this audit)

Baseline (HEAD committed lines):
- `server/src/chat/worker-dispatcher.spec.ts:4365` — `projectId: 'p_1',` (mockImplementation return)
- `:4408` — `findUnique: jest.fn().mockResolvedValue({ projectId: 'p_1', teamId: ... })`
- `:4445` — same shape, `mainAgentInstanceId: null` variant

Working tree had reformatted them (expanded object literals, 10-space indent) at
4395/4484/4579. All 3 `projectId: 'p_1',` keys removed, nothing else touched.
`server/src/chat/worker-dispatcher.ts` contains zero `projectId` refs → dead mock
fields confirmed safe to drop.

Spec result: `npx jest src/chat/worker-dispatcher.spec.ts` →
**1 suite passed, 144/144 tests passed** (server/).
Post-edit chat-wide residual grep for full F1 pattern: **zero hits**.

## 2. Residual grep classification (every non-excluded hit)

Product-code sweep result — ZERO hits in:
`web/src`, `web/app`, `web/e2e`, `server/prisma`, `server/test`, `worker/`,
`docs/agent-platform/*`, `docs/test-cases/*`, `docs/deployment.md`,
`README.md`, `server/README.md`, `web/README.md`,
`server/src` non-spec code (incl. post-fix worker-dispatcher.spec.ts).

Per-hit classes:

(a) Absence-assertion spec lines (6, all assert projectId is GONE):
- `server/src/realtime/realtime.service.spec.ts:104,110,760` —
  `expect('projectId' in data/ev/events[0]).toBe(false)`
- `server/src/tasks/tasks.service.spec.ts:498,941` —
  `expect(result).not.toHaveProperty('projectId')`
- `server/src/tasks/tasks.controller.spec.ts:100` —
  `expect(String(p ?? '')).not.toContain(':pid')`

(b) History archives (plan-excluded, T12 acceptance):
- `md-docs/**` (38: `src/docs/scanner.ts` 20, `src/App.tsx` 17,
  `src/docs/DocExplorer.tsx` 1) — excluded archive dir; its own docs-viewer
  `projectId` route concept (`/docs/${projectId}/`), unrelated to removed dimension.
- `docs/test-reports/**` (~19, e.g. `02-项目与任务管理-测试报告.md`) —
  historical reports citing old `PERMISSION_PROJECT_NOT_MEMBER` codes.

(c) `.omo/**` plan/evidence records (~1800, incl. `t12-grep-initial.log` 1070 =
T12 pre-cleanup snapshot, `t12-grep.log` 123, notepads/plans/drafts/ledger) —
removal documentation itself.

(d) Scratch / logs / prototype placeholders:
- Root `*.mjs` (~25 files: `check-*.mjs`, `proto-*.mjs`, `dark-*.mjs`,
  `task-doc-check*.mjs`, `final-check.mjs`) — pre-existing Playwright scratch
  helpers awaiting old `**/projects**` URLs / `?pid=p_seed_1` paths. Stale helpers,
  no product import.
- `.playwright-mcp/console-*.log` (5) — old run logs (e.g. 401 on
  `/api/v1/projects`, which is the EXPECTED post-removal behavior).
- `web/test-results/**/trace.zip` (binary, git-ignored Playwright artifact) —
  embedded old URL strings; regenerates, not source.
- `prototype-viewer/src/prototypes/agent-create/AgentCreatePrototype.tsx:204,205,522`,
  `runtime-manage/RuntimeManagePrototype.tsx:362,363` — substring false positives
  on unrelated filesystem placeholder `/data/projects/repo-a`. NOTE: file is
  tracked (96 files), so strictly outside the "(d) untracked prototype-viewer"
  wording — but zero relation to the removed dimension (no projectId/:pid/route/
  guard); renaming the placeholder is unrelated churn, NOT fixing. Listed here
  with reason instead of edited (per MUST-NOT-DO).
- Root `learnings.md:101` (tracked) — pre-existing historical design note
  ("ProjectMembershipGuard 符合 RBAC 预期" smoke note). Out of T12's reference
  list; documents past behavior, implements nothing. Same treatment: listed, not
  edited.

Unexplained hits: **zero**. No route, guard, schema, service, DTO, seed-domain,
or frontend/e2e residue.

## 3. Code-level route check (server/src)

- `@Controller/@Get/@Post/@Put/@Patch/@Delete` containing `projects` or `:pid`:
  **zero hits** (spec files excluded from search; none there either).
- `server/src/projects/`: directory does not exist (deleted).
- `server/src/app.module.ts` + `server/prisma/schema.prisma`: zero
  case-insensitive `projects` refs → no module registration, no tables.
- `ProjectMembershipGuard` / `project-membership`: zero non-spec refs.
- `memberPermissions` (`server/prisma/seed.ts:37-47`): domains =
  agents/artifacts/chats/skills/tasks/workers/channels/teams — **no `projects`**.
- Observation (out of F1 pattern scope, NOT a finding): `permissionScope:
  { projects: '*' }` ×5 in seed.ts is per-Agent tool-sandbox JSON (16篇 §2.1
  tool permission model), a different `projects` concept from the removed
  Project team-dimension; T3 targeted `memberPermissions`, which is clean.
- `GET /api/v1/projects` has no registration → 404 by absence (live 404
  re-verified by F3).

## 4. 12/12 implementation checkboxes

Plan file read: Todos 1–12 all marked `[x]` (lines 39/45/51/57/63/69/75/81/87/93/
99/105). T11 documents the 3 worker-dispatcher mocks as T8-owned leftover —
closed by this audit (§1).

## VERDICT: APPROVE

Zero unexplained residual hits; no product logic touched (only the 3 dead mock
keys removed, spec green 144/144). Edge cases (§2d NOTE + learnings.md + ignored
trace.zip) are classified with reasons and require no fix. Proceed to F2.
