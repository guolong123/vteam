# Issues — server-gate-removal-tool-authority

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-09-18] task-1 gotcha — over-broad deletion risk
- In `tasks.service.ts`, the main-only refusal (`:1416-1418`, `TASK_STATUS_MAIN_AGENT_ONLY`) and the **accept/archive refusal** (`:1397`, `TASK_AGENT_COMPLETION_FORBIDDEN`) live ~20 lines apart in/around the same method family. Todo 2 must delete ONLY the main-only check and keep accept/archive at BOTH sites (`tasks.service.ts:1397` + `platform-mcp.service.ts:2842`). Do not delete by line range.

## [2026-09-18] VACUOUS-LOOP TRAP (found by orchestrator during todo 7 pre-flight)
`ROLE_SERVER_GATED_TOOLS` is now `[]`. Seven spec loops iterate it — they assert NOTHING while reporting green:
```
src/execution-policies/agent-policies.custom-agents.spec.ts:101, :109
src/execution-policies/agent-policies.matrix.spec.ts:129
src/common/constants/agent.constants.spec.ts:105, :310
src/prisma/seed.spec.ts:175, :386
```
Consequence: `agent-policies.matrix.spec.ts` (14 tests) and `policy-canonical.spec.ts` (80 tests) pass ONLY because the loops are empty. A green suite that asserts nothing is a false pass.
Fix (todo 7 owns): invert each loop to assert the NEW invariant over a NON-EMPTY tool set derived from the grant matrix — e.g. layer-① permission DENIES an ungranted formerly-gated tool, GRANTS a granted one. Record the per-loop iteration count as vacuity proof.

## [2026-09-19] F2 REJECT — question_confirm self-approval bypass (BLOCKING, verified by orchestrator)
**Finding:** the plan-required `QUESTION_SELF_CONFIRMATION_FORBIDDEN` integrity check is structurally ineffective for **platform** questions, so the L2 human-confirmation gate is bypassable.
- `questions.service.ts:621` `createForPlatform` stores `sessionId = mainAgentSessionOf(taskId)` (the MAIN member's session, or `'s_placeholder'`) and `agentId = options.agentId` (the agent being ADDED). **The requester's instance id is stored nowhere.**
- `questions.service.ts:314-322` `confirmByAgent` infers the requester as `row.sessionId → Session.teamMemberId` and compares to `input.instanceId`. For platform questions this resolves to the MAIN member, not the real requester → the check cannot fire for a non-main requester.
- Live grant check: `vteam-product.toolAllows` contains BOTH `vteam_team_add_member` AND `vteam_question_confirm` (same for `vteam-project_manager`) → a non-main product instance can `team_add_member` then `question_confirm` its own request → `handleTeamAddResolved` runs → agent added with `confirmedBy: '主 Agent'` and NO user confirmation.
- If the team has no `mainAgentMemberId`, `mainAgentSessionOf` → null → `'s_placeholder'` → session lookup misses → check fail-opens entirely.
- Plan todo 2 required: "the confirmer must not be the requester … because the identity gate was the only thing preventing self-approval". The check exists but is not effective on the path that matters.
- Test gap: `questions.service.spec.ts` hand-mocks `prisma.session.findUnique` to return the confirmer's own id, so the suite cannot see the mis-attribution. No `createForPlatform → confirmByAgent` round-trip test exists.
**Fix direction (delegated):** record the true requester on `createForPlatform` (content JSON `requesterInstanceId`, no schema migration needed), have `confirmByAgent` compare against it for platform questions, pass `args.selfInstanceId` from `teamAddMember`, and add a real round-trip regression test.
**Note on owner decision D10:** D10 recorded "a product/PM instance could confirm its own request" as an ACCEPTED residual risk with a role-based mitigation. This fix makes the integrity check actually work — strictly safer, blocks only approving your OWN request, removes no capability. Flagged to the user for awareness.

## [2026-09-19] F2 REJECT — other findings (non-blocking, queued for the same fix pass)
- Stale docblocks still asserting a 403 gate: `platform-mcp.service.ts:2879-2889` (taskCreate) and `:2944-2950` (skillCreate); `resolveTeamMainMemberId` docblock `:2858` says "调用方保持今日 403".
- Dead code: `server/prisma/seed.ts:70` declares `ROLE_SERVER_GATED_TOOLS` with zero reads; dead `select: { …, mainAgentInstanceId: true }` at `platform-mcp.service.ts:2907` and `:2971`.
- No drift lock between the migration SQL JSON and `ROLE_BOUNDARIES`/`buildRolePermission`.
- `platform-mcp.authority-matrix.spec.ts` derives `expect` from the same `ROLE_BOUNDARIES[*].toolAllows` that feeds `buildAgentPolicies()` (both sides move together) — proves the guard reads the allowlist, not that grants are correct. Its docblock overstates this as "中央可证伪证明". The independent hardcoded `GRANT_MATRIX` (`agent.constants.spec.ts:101-110`) is the genuine lock for the 7 formerly-gated tools.
- `writeEvidence` in the matrix spec rewrites the tracked `.omo/evidence/.../task-9-matrix.json` on every `npx jest` run → dirties the worktree as a test side effect.

## [2026-09-19] Final Verification Wave — verdicts
| gate | reviewer | verdict |
|---|---|---|
| F1 plan compliance | oracle | APPROVE |
| F2 code quality | oracle | **REJECT** (self-confirm bypass + stale docblocks) |
| F3 real manual QA | Sisyphus-Junior | APPROVE |
| F4 scope fidelity | oracle | APPROVE |
Fix pass required before re-running F2.
