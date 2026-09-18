# agent-role-decommission - Work Plan

## TL;DR (For humans)

**What you'll get:** The old "role" word on each agent disappears. Anything that used to be decided by that word is now decided by real data: which permissions the agent actually has, and which built-in agent it is bound to. As a result, the "planner" duties stop being hardcoded to one specific agent name — anything correctly configured gets them, and nothing gets them by accident.

**Why this approach:** The word carried four unrelated jobs at once. With the new roles table (previous plan) doing the labelling, the remaining jobs each have a proper home: permissions come from the agent's policy, and planner behaviour comes from the tools the agent actually holds. That removes the last of the name-based special-casing.

**What it will NOT do:** It will not change what any existing agent is allowed to do, will not touch the execution engine's decision logic or the injection format, and will not introduce new behaviour for external agents.

**Effort:** Large
**Risk:** High - this reaches about fourteen modules and the engine's plan handling, and removing the old column is one-way. If the planner duties are re-pointed wrongly, the planner agent stops working while the tests still look green.

**Decisions to sanity-check:** (1) planner duties are derived from the tools an agent actually has, not from a new label; (2) the old column is deleted outright as you chose — the only rollback is restoring a pre-migration backup; (3) the plan-list tokens are re-pointed in the same plan, otherwise a planner bound to a different agent will be blocked.

Your next move: run `$start-work agent-role-decommission` to execute, or ask for a high-accuracy review first. Full execution detail follows below.

---

> TL;DR (machine): Large / High - delete `Agent.role` and redistribute its four jobs: label→`AgentRole`/`TeamMember.roleId` (plan 2), policy→`Agent.policyId`, plan duties→derived from the resolved policy `tools`, opencode name→`Agent.agentKey`. Migrate ~14 consumer modules, re-point the three `vteam-plan` literals and `PLAN_AGENT_ID`, derive memory/artifact suppression from tools, and prove with a populated-DB migration + live-stack regression.

## Scope

### Must have
- `Agent.role` is deleted from the schema, with every consumer migrated first (the column is dropped only after the consumer migration lands and is verified).
- Every former consumer resolves its need from a proper source: the role label from `AgentRole`/`TeamMember.roleId`; the policy from `Agent.policyId`; the opencode agent name from `Agent.agentKey`; plan behaviour from the resolved policy's `tools`.
- Planner behaviour (memory-section suppression, artifact-section suppression, plan instructions, plan-mode detection, plan-gate exemption) is derived from data — the resolved `tools` and the registered duty of the BOUND agent — not from an agent name or a Chinese substring.
- The three remaining `vteam-plan` literals and the `PLAN_AGENT_ID = 'a_plan'` literal are re-pointed so a correctly-configured planner works regardless of its name.
- A populated-database migration path with a documented rollback.
- Proof that factory behaviour is unchanged and that the planner still works end to end.
- **Declare the agent-selection precedence explicitly (review fix B7).** Three sources can name "which opencode agent runs": `Agent.agentKey` (→ `vteam-<agentKey>` policy candidate), `TeamMember.opencodeAgentName` (per-member override), and the engine default when neither applies. Today the chain is (`worker-dispatcher.ts:2094-2112`): the policy candidate wins WHEN the worker advertises support for it (`workerSupportsAgentPolicies`), else `opencodeAgentName`, else omit the `agent` key. `Agent.role` was a fourth fallback inside `resolvePolicyAgentCandidate` (`:151-159` via `roleToAgentName`). With `role` gone this todo must record the FINAL precedence in code + a comment + a test, and confirm the fallback behaviour for an agent whose `agentKey` is absent. Must NOT change the existing precedence semantics for any currently-working agent (that would be a behaviour regression the BEFORE/AFTER proof would catch).

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No change to `worker/**` wire formats: the guard's decision branches and the `/agent-policies` payload shape stay unchanged. (Re-pointing what the SERVER emits as a plan candidate is in scope; changing the worker's branch logic is not.)
- No change to the 7 built-ins' factory bytes (`before-agent-policies.json` sha `793093dc5106a76a929f2e043dd5a53af35a2b902e2d929268f1665782abbc3a`).
- No new `Agent.role`-like label on `Agent` (the label lives on `AgentRole`/`TeamMember`).
- No third-party policy emission or enforcement (plan 3 keeps external agents outside vteam policy).
- No `permissionScope` revival; no `deliverables` runtime consumption.
- No re-implementation of plans 1-3 (the editor, `AgentRole`, external display).
- No A/B dual path, legacy shim, or "deprecated"/"retired" annotations.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after** + jest (`server`, `worker`) + a populated-DB migration test + Playwright for the touched pages + a live-stack regression.
- Migration proof: run the migration against a DB that HAS existing `agent.role` values (including a custom non-builtin value) and assert every consumer still resolves correctly. A fresh-DB-only test is unacceptable (it would miss the data loss).
- Behaviour-preservation proof: before/after comparison of the resolved policy, the resolved agent name, the plan-mode decision, and the emitted `/agent-policies` payload for every seeded team member.
- Rollback proof: a documented, tested restore path (pre-migration dump) since the column drop is one-way.
- Evidence: `.omo/evidence/agent-role-decommission/task-<N>-agent-role-decommission.<ext>`

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- **Wave 1 — inventory + derive (serial):** the consumer map is the prerequisite; then the tool-derived duties, because everything else reads them.
- **Wave 2 — server consumers (parallelizable across modules):** execution-policy, dispatcher, teams/tasks labels, platform-mcp, chat.
- **Wave 3 — web consumers + the column drop:** the web maps, then the migration.
- **Wave 4 — proof:** populated-DB migration + live regression.
- **Final verification wave:** F1-F4 in parallel.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2,3,8 | — |
| 2 | 1 | 3,4,5,6,7,8 | — |
| 3 | 1,2 | 8 | 4,5,6,7 |
| 4 | 1,2 | 8 | 3,5,6,7 |
| 5 | 1,2 | 8 | 3,4,6,7 |
| 6 | 1,2 | 8 | 3,4,5,7 |
| 7 | 3,4,5,6 | 8 | — |
| 8 | 2,3,4,5,6,7 | 9 | — |
| 9 | 8 | F1-F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

- [ ] 1. [server] Build the complete `Agent.role` consumer map and the replacement for each
  What to do / Must NOT do: Produce an exhaustive, cited inventory of every read of `Agent.role` (and every function that depends on it: `resolveTemplateSource`, `roleToAgentName`, `isPlanRole`, `roleNeedsIssueDetail`, `ROLE_LABELS`, `constantRoleNameOf`, `policyKeyOf`, `agentNameOf`, `isPlanRoleTarget`). For each, record the replacement: label→`AgentRole`; policy→`Agent.policyId`; opencode name→`Agent.agentKey`; plan duties→the tool-derived duties (todo 2).
  **AGENT-SELECTION PRECEDENCE — DECLARE IT HERE (review fix B7, previously unowned; this plan rewrites the chain so it owns the decision).** Three sources can determine "which opencode agent runs" for a dispatched member: (1) `TeamMember.agentId` → the Agent row → `Agent.agentKey` → the policy candidate `vteam-<agentKey>`; (2) `TeamMember.opencodeAgentName` (per-member explicit override, incl. third-party); (3) the engine default (neither applies). The normative rule to record in code + a comment + a pinning test:
  1. If a policy candidate resolves (`agentKey` present and valid) AND the worker advertises support for it (`workerSupportsAgentPolicies`, `worker-dispatcher.ts:2108-2112`) → the **policy candidate wins**; `opencodeAgentName` is ignored for this dispatch.
  2. Else if `TeamMember.opencodeAgentName` is set → **it wins** (covers external agents and the gate-off case).
  3. Else → **omit the `agent` key** (engine default).
  4. **Post-`role`-removal fallback:** `resolvePolicyAgentCandidate` (`:151-159`) currently falls back to `roleToAgentName(role)`. With `role` gone, an agent with **no `agentKey` has NO policy candidate** → rule 2/3 applies directly. Document this explicitly: the removal NARROWS the candidate set (no more role-derived `vteam-<role>` name), and that narrowing must not silently change any currently-working seeded member (the BEFORE/AFTER proof in todo 9 catches it).
  This same statement must be cited by plan 3 todo 3 (the external-agent picker) so both plans agree. Must NOT change these semantics beyond the documented narrowing. Must NOT leave the precedence implicit.
  Then design the replacement for `resolveTemplateSource('ep_'+role)` / `buildSkeletonConfig` on create and clone — with `role` gone, a new agent's starting capability must come from an explicit `policyId`, from the chosen `AgentRole`'s `defaultAgentId` capability, or the skeleton; decide, document, and cover all three paths. Output this as a checked-in evidence file the later todos consume. Must NOT start editing code in this todo. Must NOT leave any consumer unmapped.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2,3,8
  References: `server/src/agents/agents.service.ts` (`resolveTemplateSource` :727-748, `buildSkeletonConfig` :754-773, create :179-220, clone :230-296), `server/src/chat/worker-dispatcher.ts` (`roleToAgentName`, `isPlanRole` :365, `roleNeedsIssueDetail` **:350** — note the plan's earlier `:358` was drift, `PLAN_AGENT_ID` :90, `isPlanRoleTarget` :1487-1500, the agent-row select ~:1980-1990, dispatch :2094-2122), `server/src/execution-policies/execution-policy.service.ts` (`constantRoleNameOf`, `policyKeyOf` :821-827, `agentNameOf` :829-838, `resolveAgentWithFallback`), `server/src/teams/teams.service.ts` (`defaultAlias`/`ROLE_LABELS`), `server/src/tasks/tasks.service.ts` (role labels + `effectivePlanMode`), `server/src/platform-mcp/platform-mcp.service.ts`, `server/src/chat/chat.service.ts`, `server/src/timers/triggers.service.ts`, `web/app/(main)/agents/page.tsx` (`toAvatarRole` ~:444, the role colour helpers ~:577-583, `ROLE_KEYS` duplicate ~:441, **AND the `CreateAgentModal` role picker added by plan 1 ~:1709-1717/1751-1761/2400-2408** — todo 4 owns re-pointing it), `web/src/components/teams/TeamMembersPanel.tsx`, `web/app/(main)/teams/new/page.tsx`
  Acceptance criteria (agent-executable): the evidence file lists every occurrence with `file:line`, each mapped to a concrete replacement; a grep-based check (the exact command recorded in the evidence) shows the inventory accounts for 100% of non-test `Agent.role` reads; **the agent-selection precedence is written down (the 4 rules above) and a test pins it**: policy candidate wins when the worker supports it, `opencodeAgentName` wins otherwise, neither → `agent` key omitted, and an agent with no `agentKey` has no candidate.
  QA scenarios: happy — the map is complete and the checker reports 0 unmapped; failure — an artificially added unmapped consumer makes the checker report it. Evidence `.omo/evidence/agent-role-decommission/task-1-consumer-map.txt`
  Commit: Y | `docs(agents): map every Agent.role consumer and declare agent-selection precedence`

- [ ] 2. [server] Derive plan duties from the resolved policy tools (not a label)
  What to do / Must NOT do: Replace the name-based plan detection with data-derived duties. Two distinct derivations are required and must be kept separate:
  - **Instruction suppression** (the memory section and the artifact section): derive from the RESOLVED policy `tools` — suppress exactly when the agent's effective allowlist lacks the corresponding tool (`vteam_memory_save` / `vteam_submit_artifact`). Rationale: suppression exists because plan's allowlist lacks those tools; keying it off a `duty` label would wrongly suppress an agent that legitimately holds them, and wrongly enable an agent that lacks them.
  - **Plan-mode detection** (`effectivePlan` / `effectivePlanMode`) and the **plan-gate exemption**: derive from the registered duty of the BOUND opencode agent (the existing duty notion), replacing both the `PLAN_DUTY_AGENTS` name set usage at the call sites and the `PLAN_AGENT_ID='a_plan'` literal.
  Re-point the three `vteam-plan` literals: the dispatch candidate (`worker-dispatcher.ts:2105-2107`), `deriveAgentMode` (`:253-255`), `resolveTaskEffect` (`:239-247`). Must NOT introduce a new `Agent.role`-like label. Must NOT change the worker wire format. Must NOT make `task`/`mode:all` reachable for an agent the engine would deny.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3,4,5,6,7,8
  References: `server/src/chat/worker-dispatcher.ts:461-578` (`buildSystemInstructions`; the suppression branches at `:513` and `:550`, the caller passing `agentRole` at `:2065`), `:365-374` (`isPlanRole` — to be removed), `:2078-2088` (`effectivePlan` derivation), `server/src/common/opencode-agent-duty.ts` (the duty source to reuse), `server/src/execution-policies/execution-policy.service.ts:239-247` (`resolveTaskEffect`), `:253-255` (`deriveAgentMode`), `server/src/tasks/tasks.service.ts:1809-1814` (`effectivePlanMode`), `worker/src/role-guard/policy.ts:189-199` (the worker-side task exception — read-only reference; do not change it)
  Acceptance criteria (agent-executable): `cd server && npx tsc -p tsconfig.json --noEmit` exits 0; a test asserts an agent whose resolved tools include `vteam_memory_save` DOES get the memory section even if it is a planner, and one lacking it does not; a test asserts a non-`a_plan` agent carrying plan duty passes the **server-side** plan gate; a test asserts the seven built-ins' `mode`/`task` values are unchanged from the frozen baseline. **NOTE (review finding O3):** the worker guard's `task` literal is out of scope — do NOT assert a renamed planner can actually fan out sub-agents end to end; assert only the server-side selection/gate/derivation.
  QA scenarios: happy — the duty/suppression tests pass and the built-in payload still matches the baseline; failure — reverting to name-based detection makes the "planner by data" test fail (mutation check, recorded). Evidence `.omo/evidence/agent-role-decommission/task-2-duty.json`
  Commit: Y | `refactor(dispatch): derive plan duties from policy tools, not agent names`

- [ ] 3. [server] Migrate `execution-policies` consumers off `role`
  What to do / Must NOT use: Update `execution-policy.service.ts` so policy resolution no longer reads `agent.role`: `policyKeyOf` uses `policyId` only (the `ep_<role>` fallback is removed after the migration backfills `policyId`), `constantRoleNameOf` and `agentNameOf` resolve from `agentKey`. Preserve the constant fallback path for missing rows — but keyed by `agentKey`/the registered name rather than a role string. Must NOT change the emitted `/agent-policies` payload (the byte-identity gate depends on it). Must NOT drop the fallback (partially-migrated DBs must still work).
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 8
  References: `server/src/execution-policies/execution-policy.service.ts` (`policyKeyOf` :821-827, `agentNameOf` :829-838, `resolveAgentWithFallback`, `buildAgentPolicies` :682-788, `resolveConstantPolicySource`), `server/src/execution-policies/agent-policies.matrix.spec.ts` + `agent-policies.custom-agents.spec.ts` (the byte-identity locks), `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json`
  Acceptance criteria (agent-executable): `npx jest --runInBand src/execution-policies` passes; the emitted 7 built-ins deep-equal the frozen baseline; a test asserts policy resolution works for an agent with `policyId` set and no `role` column.
  QA scenarios: happy — policy resolution + byte-identity green; failure — an agent whose `policyId` is null but which has a registered name still resolves via the constant fallback (no null crash). Evidence `.omo/evidence/agent-role-decommission/task-3-policy.json`
  Commit: Y | `refactor(policies): resolve policy without Agent.role`

- [ ] 4. [server+web] Migrate `agents.service` create/clone/update off `role`, AND re-point the create-form role picker
  What to do / Must NOT do: Update `resolveTemplateSource`/`buildSkeletonConfig` call sites to the replacement designed in todo 1: create/clone must obtain a starting capability without `role` (explicit `policyId`, or the `AgentRole` default agent's capability, or the skeleton). Update `update()` so a label change does not silently alter capability, and document the resulting behaviour when a user changes the label without changing the policy.
  **CROSS-PLAN OWNERSHIP (review fix B2 — this todo owns it):** plan 1 (`agent-native-permission-editor` todo 6) added a role picker to `CreateAgentModal` that posts the EXISTING `Agent.role` string, and explicitly delegated its migration to this plan. That debt is now owned HERE. You must:
  (i) re-point the picker to the new mechanism — select an `AgentRole` (whose `defaultAgentId` supplies the capability) or an explicit `policyId`; do NOT let it post a `role` string that no longer exists (the global `whitelist:true` pipe would silently strip it and every new agent would fall back to the skeleton — the exact defect plan 1 fixed);
  (ii) remove `role` from `create-agent.dto.ts` / `update-agent.dto.ts` / `clone-agent.dto.ts`;
  (iii) if the schema drops `Agent.role`, `create()`'s `role: dto.role ?? null` (`agents.service.ts:200`) must be removed too (it would be a compile error).
  Must NOT change `buildSkeletonConfig`'s deny-by-default values. Must NOT make label changes auto-re-provision the policy (destructive to user edits — an explicit earlier decision).
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 8
  References: `server/src/agents/agents.service.ts` (create :179-220 incl. `role:` at `:200`, clone :230-296, update :307-351, `resolveTemplateSource` :727-748, `buildSkeletonConfig` :754-773, `toAgentDto`), `server/src/agents/dto/{create,update,clone}-agent.dto.ts` (`create-agent.dto.ts:48-53` is the `role?` to remove), the plan-2 `AgentRole` API, `web/app/(main)/agents/page.tsx` (`CreateAgentModal` props/`onSubmit` ~:1709-1717, `handleSubmit` ~:1751-1761, the create mutation ~:2400-2408 — the picker added by plan 1), `.omo/plans/agent-native-permission-editor.md` (todo 6, the picker's origin)
  Acceptance criteria (agent-executable): `npx tsc --noEmit` exits 0; `npx jest --runInBand src/agents` passes; tests assert create-with-policy / create-via-role / create-blank each yield the documented capability, and that changing only the label leaves the capability unchanged.
  QA scenarios: happy — all three create paths produce the documented config; failure — changing only the label does NOT auto-replace the bound policy (assert unchanged). Evidence `.omo/evidence/agent-role-decommission/task-4-agents.json`
  Commit: Y | `refactor(agents): create/clone/update without Agent.role`

- [ ] 5. [server] Migrate label consumers (teams aliases, tasks, platform-mcp, chat, triggers)
  What to do / Must NOT do: Replace every remaining `Agent.role` read used for display or labelling with the `AgentRole`/`TeamMember` source: the team member default-alias label map, the task-side role labels, the platform-MCP profile payloads, the chat-service reads, and the triggers reads. Behaviour (the rendered label text) must stay identical for the seeded data. Must NOT change any API response shape beyond removing the now-absent `role` field (and where that field is part of a public response, decide and document whether it is replaced by the role label — do not silently drop a field the UI needs).
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 8
  References: `server/src/teams/teams.service.ts` (`defaultAlias`, `ROLE_LABELS`), `server/src/tasks/tasks.service.ts` (role labels ~:1832, `effectivePlanMode` ~:1809), `server/src/platform-mcp/platform-mcp.service.ts` (~:1124, 3734, 3819-3845), `server/src/chat/chat.service.ts` (~:120, 1880), `server/src/timers/triggers.service.ts` (~:406, 589), the plan-2 `AgentRole` entity
  Acceptance criteria (agent-executable): `npx jest --runInBand src/teams src/tasks src/platform-mcp src/chat` passes; a test asserts the alias for a seeded member is unchanged from the pre-migration value.
  QA scenarios: happy — a seeded member's alias is byte-identical before/after; failure — a member whose role mapping is missing renders the documented fallback rather than an empty label. Evidence `.omo/evidence/agent-role-decommission/task-5-labels.json`
  Commit: Y | `refactor(server): resolve labels from AgentRole, not Agent.role`

- [ ] 6. [web] Migrate the web role maps off `Agent.role`
  What to do / Must NOT do: Replace the web-side reads of the agent's `role` string: the avatar/colour mapping and the duplicated `AGENT_ID_ROLE`/`ROLE_AGENT_ID`/`ROLE_KEYS` maps. Source role identity from the `AgentRole`/`TeamMember` data instead of the deprecated string. The rendered colours/labels must stay the same for the seeded roles. Must NOT introduce a new duplicated constant — prefer a single shared source (the `roles` labels in `web/src/theme/tokens.ts:19-26` plus the role API). Must NOT change unrelated UI.
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 8
  References: `web/app/(main)/agents/page.tsx` (`toAvatarRole` ~:444, the role colour helpers ~:577-583, the `ROLE_KEYS` duplicate ~:441), `web/src/components/teams/TeamMembersPanel.tsx` (~:59-69), `web/app/(main)/teams/new/page.tsx` (~:49-57), `web/app/(main)/teams/[id]/page.tsx`, `web/src/theme/tokens.ts:8-26`, the `Agent.role` removal (`server/prisma/schema.prisma:588`)
  Acceptance criteria (agent-executable): `cd web && npx tsc --noEmit` exits 0; Playwright asserts a seeded agent/member renders the same colour and label as before; a grep check (command recorded) shows no remaining consumer of the dropped field.
  QA scenarios: happy — colours/labels unchanged for the seeded roles; failure — an agent whose role data is missing renders the documented neutral fallback rather than crashing. Evidence `.omo/evidence/agent-role-decommission/task-6-web.png`
  Commit: Y | `refactor(web): source role identity from AgentRole`

- [ ] 7. [db] Backfill then drop `Agent.role` (with a documented rollback)
  What to do / Must NOT do: Only after todos 2-6 land and pass: (a) backfill every remaining need — ensure every agent that relied on the `ep_<role>` fallback now has an explicit `policyId`; ensure every team member has a `roleId` (plan 2); (b) drop the `role` column in a migration; (c) document the rollback — the drop is one-way, so the rollback is restoring a pre-migration dump, and the plan must state the exact command. Must NOT drop the column before the consumers are migrated and verified. Must NOT combine the drop with unrelated schema changes. Must state in the migration comment why the column existed and what replaced it.
  Parallelization: Wave 3 | Blocked by: 3,4,5,6 | Blocks: 8
  References: `server/prisma/schema.prisma:588` (`role String?`), `server/prisma/migrations/` (conventions; drop precedents like `20260913000000_drop_agent_tool_effects_permission_scope/migration.sql`), `server/prisma/seed.ts` (the seed writes `role` today — must stop)
  Acceptance criteria (agent-executable): `npx prisma migrate deploy` succeeds on a populated DB; the policy backfill predicate is **explicitly scoped (review fix m6)**: every agent whose `policy_id` is NULL but whose pre-drop `role` resolved to a builtin `ep_<role>` row exists must end with a non-null `policy_id` — assert `SELECT COUNT(*) FROM agents a WHERE a.policy_id IS NULL AND a.type <> 'custom'` returns 0, and for `type='custom'` agents assert each has a policy OR is explicitly listed in the migration output as intentionally policy-less (never silently null). Also state the exact rollback command (`mysql < pre-drop-dump.sql` style, with the dump path named) and exercise it once on a copy.
  QA scenarios: happy — populated-DB migration leaves no orphaned non-custom agent and lists any intentionally policy-less custom agent; failure — running the migration on a DB with a custom `agent.role` value still succeeds (the value was only a label) and the agent keeps its policy. Evidence `.omo/evidence/agent-role-decommission/task-7-drop.txt`
  Commit: Y | `feat(db): drop agents.role after backfill`

- [ ] 8. [server] Remove the now-dead plan/label helpers and de-duplicate the constants
  What to do / Must NOT do: Delete the helpers made dead by the migration (`isPlanRole`, `roleToAgentName`, the unused duty name-set call sites, `constantRoleNameOf`'s role path) and collapse the duplicated role-key arrays to a single source. Ensure no dead code, no unused exports, no lingering `role`-based branches. Must NOT delete a helper still used elsewhere — verify by reference search first. Must NOT leave a shim or a "deprecated" comment.
  Parallelization: Wave 3 | Blocked by: 2,3,4,5,6,7 | Blocks: 9
  References: `server/src/chat/worker-dispatcher.ts` (`isPlanRole`, `roleToAgentName`, `roleNeedsIssueDetail`), `server/src/common/opencode-agent-duty.ts`, `server/src/execution-policies/execution-policy.service.ts`, `web/src/theme/tokens.ts`, plus whatever todo 1's consumer map identified
  Acceptance criteria (agent-executable): `npx tsc -p tsconfig.json --noEmit` exits 0 with no unused-symbol warnings for the touched files; `npx eslint <changed files>` reports 0 errors; a reference search (command recorded) shows the deleted helpers have no callers.
  QA scenarios: happy — the full suite still green after deletions; failure — an accidental deletion of a still-used helper fails the build (proving the reference check is real). Evidence `.omo/evidence/agent-role-decommission/task-8-cleanup.txt`
  Commit: Y | `refactor: remove role-based helpers and duplicate role maps`

- [ ] 9. [proof] Populated-DB migration + live behaviour-preservation regression
  What to do / Must NOT do: The closing proof. (a) Run the full migration chain against a DB that HAS existing `agent.role` values, including at least one custom value, and assert every consumer resolves correctly; (b) capture BEFORE values (for each seeded member: resolved policy, resolved opencode agent name, plan-mode decision, alias label) and assert AFTER equality; (c) re-run the byte-identity harness and confirm the frozen sha is unchanged; (d) verify the **server-side** plan selection + gate decision for a renamed plan-duty agent, and run the LIVE planner proof with a literal `vteam-plan` agent — **do NOT claim a renamed planner can fan out sub-agents** (the worker guard keeps the `vteam-plan` literal; review fix m3); (e) execute the rollback once on a copy and record it. Must NOT test only on a fresh DB. Must NOT modify the frozen baseline. Must NOT state an end-to-end renamed-planner result the worker cannot produce.
  Parallelization: Wave 4 | Blocked by: 8 | Blocks: F1-F4
  References: `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json` (sha `793093dc5106a76a929f2e043dd5a53af35a2b902e2d929268f1665782abbc3a`), `scripts/e2e-role-boundaries.sh` (the frozen-sha gate + scenario harness), `server/prisma/migrations/` (the new drop migration), the plan's own consumer map (todo 1), `worker/src/role-guard/policy.ts:189-199` (the worker literal that limits the claim)
  Acceptance criteria (agent-executable): populated-DB migration passes with 0 unresolved non-custom agents and any policy-less custom agents explicitly listed; all BEFORE/AFTER values are identical; the frozen sha is unchanged; the server-side plan selection/gate is correct for a renamed plan-duty agent (NOT a fan-out claim — see O3/m3); the rollback is exercised and recorded.
  QA scenarios: happy — all five proofs pass with artifacts; failure — a deliberately mis-set backfill makes the BEFORE/AFTER comparison fail (mutation check, recorded). Evidence `.omo/evidence/agent-role-decommission/task-9-proof.txt`
  Commit: Y | `test(e2e): prove role decommission preserves behaviour`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit ok before declaring complete.
- [ ] F1. Plan compliance audit
- [ ] F2. Code quality review
- [ ] F3. Real manual QA
- [ ] F4. Scope fidelity

## Commit strategy
- One commit per todo; prefix `feat|refactor|test|docs(<scope>): <summary>`.
- The consumer-map commit (todo 1) lands first and alone; the drop migration (todo 7) lands after every consumer migration is verified.
- Keep `npx jest --runInBand` green at every step; the byte-identity specs must never be regenerated.
- Do NOT push until the user says so.

## Success criteria
- `cd server && npx tsc -p tsconfig.json --noEmit`, `cd worker && npx tsc --noEmit`, `cd web && npx tsc --noEmit` all exit 0; jest fully green; Playwright green.
- The populated-DB migration resolves every consumer; `agents.role` no longer exists.
- For every seeded member, the resolved policy / resolved agent name / plan-mode decision / alias label are identical to before.
- The 7 built-ins' `/agent-policies` output still matches the frozen sha; `worker/**` untouched.
- A correctly-configured plan-duty agent is recognised by the SERVER-side plan gate regardless of its name. **Explicitly scoped limitation (review finding O3):** the WORKER guard still allows the `task` tool only for the literal agent name `vteam-plan` (`worker/src/role-guard/policy.ts:189-199`). Removing that requires a `worker/**` change, which this plan forbids. Therefore the plan's goal is: **the server stops hardcoding the name** (candidate selection, mode/task derivation, plan gate, instruction suppression). A renamed planner will be *selected and gated* correctly, but its `task` fan-out remains guarded by the worker literal — this residual is documented, NOT silently assumed away. If the user later wants a renamed planner to fan out sub-agents, that is a separate worker-side plan.
- No `Agent.role`, `roleToAgentName`, `isPlanRole`, or `PLAN_AGENT_ID`-style name literal remains; no shim, no "deprecated" comment.
