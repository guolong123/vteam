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
