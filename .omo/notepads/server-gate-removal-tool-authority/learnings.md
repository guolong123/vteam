# Learnings — server-gate-removal-tool-authority

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-09-18] task-1 change map
- **The 11 removal throw sites are NOT uniform in shape.** 10 use `message: \`...\`` on the same line; `platform-mcp.service.ts:3036` (skill_create no-context) puts the message on the CONTINUATION line after a `new ForbiddenException({code,`. A naive `grep 'message'` completeness check finds only 10 and under-counts. Use the map's V2 extractor (or grep the `仅主 Agent` literal alone, not requiring `message` on the same line).
- **`worker/dist/` is NOT git-tracked** (`git ls-files worker/dist` = 0) yet exists on disk and contains stale `SERVER_GATED_TOOLS` in `dist/role-guard/policy.js` + `dist/resources/role-guard-plugin.js`. Todo 4's "rebuild dist" is therefore a real, required step — the e2e scripts load dist, not src.
- Grant-matrix deltas recomputed from live constants: product +5, architect +1, developer +1, tester +0, PM +7, plan +1, librarian +0 = 15 adds total. Resulting toolAllows: 21→26, 16→17, 18→19, 18→18, 20→27, 10→11, 9→9.

## [2026-09-18] todo 5 + 6 verification notes
- The todo-5 migration embeds the target `tools`/`permission` JSON as literals generated from the constants, guarded by a MySQL `<=>` JSON-compare predicate (idempotent: re-run = 0 rows; updated_at untouched since the column has no ON UPDATE).
- **Orchestrator's independent check**: parsed all 7 migration UPDATE blocks and deep-compared against live `ROLE_BOUNDARIES` — all matched for BOTH `tools` and `permission` (edit globs / bash / task / mcpDenies recomputed via ts-node). Good pattern for verifying generated data migrations.
- Tool descriptions in `platform-mcp.tools.ts` were agent-facing lies after de-gating ("仅主 Agent 可调用"); todo 6 corrected them to "调用权限由你的角色工具权限决定". The **global-memory main-only claim is TRUE and was correctly SCOPED, not deleted**.

## [2026-09-19] todo 9 — executable authority matrix (central falsifiable proof)
- **Cross-package import works under server jest**: `server/src/**/*.spec.ts` can `import { evaluateToolCall } from '../../../worker/src/role-guard/policy'`. `worker/src/role-guard/policy.ts` has ZERO imports (pure, no opencode dep), and `tsconfig.build.json` excludes `**/*spec.ts`, so `nest build`/`dist` layout is unaffected by the new spec. This is the real worker guard evaluation path — no mock.
- **The `rolesDoc` for the matrix comes from the REAL `ExecutionPolicyService.buildAgentPolicies()`** (the `/agent-policies` guard payload), not hand-built. Composing it with the real `evaluateToolCall` gives all 259 cells (7 roles × 37 tools = 29 MCP + 7 git + 1 browser) = 157 allow / 102 deny, all matching `ROLE_BOUNDARIES[*].toolAllows`.
- **`PlatformMcpService` needs 10 REQUIRED providers** (prisma, idGen, realtime, workerClient, workerDispatcher, artifactsService, issuesService, tasksService, questionsService, **GitReposService**) — omitting GitReposService fails Nest DI with "index [9]". All others are `@Optional()`. The existing spec's full provider list is the safe template.
- **Real `TasksService.transitionByAgent` start preflight needs `prisma.teamMember.count`** (not just findUnique/findMany) — the harness mock must include `count: jest.fn().mockResolvedValue(N)`.
- **Live happy path uses idle team `tm_0000000006`** (4 members, `main=tmm_0000000019`, no sessions by default). The MCP归属 check (`assertWorkerTask`) needs a live session bound to the main member, so the runner inserts a scoped fixture session `s_t9matrix_<team>` (idempotent) and deletes it in cleanup. `plan_complete` needs the plan row `executing`; the runner seeds `UPDATE plans SET status='executing'` (the plan-status gate is a different todo) then asserts `status=completed` is returned.
- **Vacuity guard for the retired empty set**: `ROLE_SERVER_GATED_TOOLS=[]`, so the matrix iterates `VTEAM_MCP_TOOL_NAMES`/`ROLE_BOUNDARIES[*].toolAllows` and RECORDS `iteratedCellCount` + `allowCellCount` + `denyCellCount` in the artifact; assertions require all three non-zero. A mutation granting one denied cell (`vteam-developer` → `vteam_task_create`) flips EXACTLY 1 cell — falsifiability confirmed.
- **Reproducible command** (new file `scripts/prove-authority-matrix.sh`, NOT an `e2e-*.sh` so no todo-8 ownership conflict): runs the spec then drives real HTTP create→start→plan_mode→plan_complete→mark-pending-review and merges both halves into `task-9-matrix.json`, then asserts the artifact. Self-cleaning (task/plan/events/messages/queue + fixture session removed on EXIT); verified zero residue on `tm_0000000006`.
