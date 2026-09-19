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

## todo 3 — execution-policies off `role` (policyId/agentKey)

- **`role` → `agentKey` is byte-safe for the constant fallback because template rows
  have `agentKey = role`** (schema comment + migration `20260914000000_add_agent_key`
  backfills `agent_key = role` for `type='template'`). So `constantRoleNameOf(agentKey)`
  produces the same `vteam-<name>` for all 7 built-ins; the emitted payload is untouched.
- **Removing `ep_<role>` outright would have silently changed capabilities, not just
  the code path.** On a partially-migrated DB (`policy_id` NULL — backfill is todo 7),
  returning null from `policyKeyOf` makes `resolveByAgent` skip an existing built-in
  row (possibly user-edited) and drop to factory constants. Kept a **policyId-keyed path
  derived from `agentKey` only** (`ep_<agentKey>` via `builtinPolicyIdOf`), never from
  `role`; it dies naturally after todo 7 and todo 8 deletes it.
- **Input type is the seam.** `AgentPolicyInput` keeps an optional `role?:` key purely
  so sibling callers (worker-dispatcher:3712, platform-mcp:3744, agents.service:620/647)
  still compile without cross-module edits; the service never reads it, and two specs
  prove that (only-`role` input → null; `agentNameOf` falls to `vteam-plan`).
- **Mutation checks are cheap and decisive here**: reverting the fallback to `role`
  killed 5 tests; deleting the agentKey-derived `policyKeyOf` branch killed exactly the
  partially-migrated-DB case. Both mutations were applied with `perl -0pi` on a backup
  copy and reverted.
- **Sibling todos edit the same working tree.** Todo 4's in-flight
  `create-agent.dto.ts`/`agents.service.ts` edits broke 4 *unrelated* suites at the time
  of my verification. Solution: a throwaway `git worktree add <tmp> HEAD`, copy ONLY the
  todo's files + symlink `server/node_modules`, run tsc/jest there — 140/3224 green —
  that is the honest signal for the commit. Never `git add` shared paths.
- **Manifest regeneration again** (todo 2 precedent): pure line drift showed
  `UNMAPPED: 10` after the edit; regenerated from the checker's own grep pipeline,
  178 → 176 keys, UNMAPPED 0. The net shrink is the migration-progress signal.
- **CORRECTION (same todo, final numbers):** the committed manifest is **178 → 177**
  (exec-policy keys 12 → 11). The first regeneration produced 176 but ran *before* a last
  doc-comment edit, so it was stale by 9 keys in the committed tree; regenerating against
  the committed source gives 177 and UNMAPPED 0. **Lesson: regenerate the manifest LAST,
  from the frozen source, and verify the checker in a clean worktree at the commit sha —
  a `| tail` that swallows the exit code will hide a red checker.**

## todo 3 — spec re-point vs. assertion weakening

- Existing resolution specs passed `role:` because that was the only way to name a
  built-in before `agentKey` was threaded. Re-pointing those *inputs* to `agentKey:`
  changes no assertion and no expected value — it is the migration, not a weakening.
  Byte-identity specs (`matrix`/`custom-agents`/`db-builtin`) were only extended:
  +2 pins (deep-equal to the frozen baseline, and the baseline file's own sha256).

## todo 4 — agents.service create/clone/update off `role` + picker re-point

- **The three capability paths are exactly**: PATH 1 explicit `policyId` (bound as-is,
  no new policy row) > PATH 2 `agentRoleId` → `AgentRole.defaultAgentId` → that Agent's
  `policyId` → its stored `ExecutionPolicy.config` (deep-copied) → fallback
  `resolveConstantPolicySource('vteam-<agentKey>')` when the row is missing but the
  `agentKey` is a builtin name > PATH 3 `buildSkeletonConfig` (values frozen).
  `AgentRole` still carries NO capability — it is only a **selector**.
- **`resolveTemplateSource` signature changed to an options object**
  (`{ agentRoleId: string | null }`), so any spec that pokes it must be updated. The
  cross-module spec was `execution-policies/agent-policy-fallback.spec.ts` (todo 3's
  file) — the *call shape* only; todo 3 owns the service.
- **The whitelist-strip defect is now guarded at two levels**: a unit test runs the real
  `ValidationPipe({whitelist:true})` shape over create/update/clone DTOs and asserts
  `agentRoleId` survives while a stale `role` key is stripped; a live API control
  (`POST /agents {role:'developer'}` with no `agentRoleId`) proves the old wire yields
  the skeleton. Assert the *capability*, never just the request status.
- **`toAgentDto`'s `role` field was deliberately LEFT as a display passthrough** — todo 5
  owns the label consumers and todo 6 the web maps. Dropping the field here would have
  broken their byte-identical-label acceptance. Only capability resolution stopped
  reading `role` (`resolveManyByAgents` now receives `{policyId, agentKey}`).
- **`update()` label-vs-policy**: no label field exists in the DTO, and `policyId` is
  written only when explicitly passed. Live proof: create via `ar_developer` →
  `PATCH {name, role:'tester'}` → policyId/tools/permission identical, policy row config
  and `updatedAt` identical, and the stray `role` in the body was stripped by the pipe.
- **Mutation checks**: forcing `update()` to write `policyId` on a name change killed the
  label-noop test; nulling the PATH 2 resolution killed 4 PATH 2 tests. Both reverted.
- **Manifest regeneration (todo 2/3 precedent)**: 176 → 171 keys. The delta is exactly
  the removed write-path keys (3 writes + 1 `ep_<role>` read + 1 merged comment) plus the
  picker's replaced state key — verified key-by-key before regenerating, never hand-edited.

## todo 5 — label consumers re-sourced from AgentRole

- **Two different values hide behind one field name.** `Agent.role` was both the machine key
  (web `ROLE_KEYS.includes(role)` / `toAvatarRole` / colour maps) and the seed of the display
  label (`ROLE_LABELS[role]` → alias `<标签>-<seq>`). The migration therefore needs TWO
  accessors, not one: `roleKeyOf` → `AgentRole.key` for the API `role` field, `roleLabelOf` →
  `AgentRole.name` for the alias. Todo 1's recommendation (`role` = `AgentRole.name`) was
  reversed for this exact reason — `.name` (产品经理) fails `ROLE_KEYS` (keys are `product`),
  so avatars would silently fall to the developer fallback. Recorded in the evidence as a
  documented deviation.
- **`roleKeyOf(member)` reads the MEMBER's `role` relation, not the agent's.** Every payload
  member is a team-member row; `m.role.{key,name}` is `AgentRole` (Prisma relation on
  `TeamMember.roleId`). `m.agent` has no `role` field after this todo.
- **Alias needs the binding at write time, not just at read time.** `defaultAlias` runs inside
  `create()`/`addMember()` where the `AgentRole` row must already be known: `resolveMemberBinding`
  already fetched it for the `roleId → defaultAgentId` prefill, so its return type now carries
  `{key,name}` and the alias uses it with zero extra queries in the roleId path. The explicit-
  `agentId` path adds one lookup by `roleId` (only when a `roleId` was supplied).
- **The checker's `UNMAPPED` stays 0 while the count SHRINKS.** 171 → 150 keys (38 removed,
  17 added). Removed keys = genuinely eliminated reads; added keys = the new seam module +
  role-relation reads + line-shift rekeys. Regenerate with the checker's own pipeline; never
  hand-edit the manifest.
- **Behaviour proof must come from the RUNNING build, not the source.** Rebuild the server
  container and grep `dist/` for a new marker (`roleBindingOf`) plus the absence of the old one
  (`ROLE_LABELS`) before trusting an AFTER capture — otherwise the "after" is the old process.
