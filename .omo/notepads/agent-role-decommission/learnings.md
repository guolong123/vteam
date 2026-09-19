# Learnings — agent-role-decommission

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — consumer map + precedence (inventory/design only)

- **The manifest is the union of 5 recorded greps**, not just `\.role`: `.role`
  (server 73, web 44) + `role: true` prisma selects (28) + the 9 named helpers
  (41) + the plan-duty literals (6) = **184 distinct file:line keys**. Committed at
  `scripts/agent-role-consumer-manifest.txt`; checker `scripts/check-agent-role-consumers.sh`
  prints `UNMAPPED: 0` and exits 0. Positive control via `--extra-dir` (synthetic
  consumer OUTSIDE the repo) prints `UNMAPPED: 1` and exits 1 — proven, not asserted.
- **`PLAN_AGENT_ID` and `isPlanRoleTarget` no longer exist in `server/src`.** The
  plan treats them as live tasks (todo 2/9). They were removed by
  `server-gate-removal-tool-authority`; only the stale `server/dist/**` still
  contains them. The real remaining plan literals are `PLANNER_AGENT_ID`
  (`review-verdict.listener.ts:35`) and `'a_plan'` (`plan-docs.service.ts:191`).
- **`roleNeedsIssueDetail` is at `:385`**, not the plan's `:350` nor its earlier
  `:358` — both were drift. `isPlanRole` is `:400` (plan said `:365`).
  `constantRoleNameOf` is `:746`; the plan didn't give it a line.
- **The precedence expression is `worker-dispatcher.ts:2141-2148`** (plan cited
  `:2094-2122`/`:2108-2112`; both drifted). Pinned with 5 spec-only tests against
  existing exports — no production seam needed. Full suite 140/3201 green.
- **`AgentRole` carries no capability** (`key/name/description/type/defaultAgentId/
  rolePrompt/sortOrder`). So the create/clone capability has exactly 3 sources:
  explicit `policyId` > chosen `AgentRole.defaultAgentId` -> that Agent's
  `policyId` > skeleton. Label changes must never re-provision the policy.

## todo 2 — plan duties from data (tools + duty), not a label

- **Two derivations, deliberately separate.** Suppression (memory + artifact
  sections) ← the RESOLVED policy `tools` (`!toolAllowed(tools,'vteam_memory_save'
  /'vteam_submit_artifact')`); plan-mode detection + plan literal ← the registered
  duty of the BOUND agent (`getOpencodeAgentDuty`). The rationale is recorded in
  `buildSystemInstructions` and on `BuildSystemInstructionsOptions.resolvedTools`.
- **`resolvedTools == null` must NOT suppress** (D2). First implementation inverted
  this and 7 spec cases went red — always treat absence-of-data as "no opinion",
  not as "deny". `toolAllowed` treats `allow`/`ask` as allowed (same as the worker
  guard's `isToolAllowed`).
- **One resolution, two consumers.** `resolveBoundaryCorrection` became
  `resolveBoundaryAndTools` returning `{correction, tools}`; dispatch resolves once
  so the boundary section and the suppression decision cannot drift under a DB/PATCH
  race. Fallback chain: `resolveByAgent` → `resolveConstantPolicySource(roleToAgentName)`
  → null (still lets `a_plan` keep its tool-less constant allowlist).
- **The literal value never changed, only its source.** `VTEAM_PLAN_AGENT_NAME = 'vteam-plan'`
  exported from `opencode-agent-duty.ts`, used by the dispatch candidate,
  `deriveAgentMode`, `resolveTaskEffect`. Wire bytes stay identical (the worker guard
  maps only the literal `vteam-plan`). Safety: production passes only vteam-namespace
  names; a custom `agentKey` of `plan` is already excluded by `builtInNames`;
  `vteam-prometheus` normalises to base `vteam-prometheus` ∉ PLAN set.
- **`isPlanRole` is now production-uncalled** (only its own definition + spec refs).
  Left in place for todo 8 deletion, recorded in evidence.
- **Mutation check caught the hardcoded path**: restoring the name-based OR made
  test (a) "planner WITH the tool still gets memory section" fail — that is the
  test that proves the data derivation is load-bearing.
- **Manifest is `file:line`-keyed and shifts.** After edits the checker showed
  UNMAPPED:52 (pure line drift). Regenerated with the checker's exact grep pipeline:
  184 → 178 keys (worker-dispatcher 44→36 consumers; plan-docs 0→2 new duty reads).
  UNMAPPED:0 after. The shrink is the migration-progress signal.

## todo 2 — D3/D4 duty-resolution shapes

- **D3** (`review-verdict.listener.ts`): `teamMember.findMany` with
  `agent{agentKey,role}` then `.find(getOpencodeAgentDuty(\`vteam-${agentKey ?? role}\`)==='plan')`;
  no match → `plannerMemberId` null (fail-open, unchanged).
- **D4** (`plan-docs.service.ts`): `resolvePlanAgentId()` queries Agent rows
  (`{id,agentKey,role}`) and returns the first plan-duty agent's `id`; unresolvable →
  warn + skip the gate consult (fail-open, no forged `'a_plan'` identity).
