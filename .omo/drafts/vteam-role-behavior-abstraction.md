---
slug: vteam-role-behavior-abstraction
status: plan-written
intent: clear
review_required: false
pending-action: write .omo/plans/vteam-role-behavior-abstraction.md
approach: Reverse the three code-constant short-circuits (buildAgentPolicies / guardForAgent / renderBoundarySection) plus the dispatch-layer hardcodes, so every agent — built-in or custom — reads its behavior dimensions from execution_policies.config in the DB, with ROLE_BOUNDARIES demoted to seed source + missing-row fallback. Fix the prompt UI lock and stop seed from clobbering user edits. Byte-identity of built-in output is preserved by an explicit ordering constant.
execution_baseline: user_commits_or_stashes_in_flight_changes_before_start_work
---

# Draft: vteam-role-behavior-abstraction

## Components (topology ledger)

| id | outcome | status | evidence path |
| --- | --- | --- | --- |
| C1 | `buildAgentPolicies()` sources built-in agent/guard definitions from DB `ep_<role>` config; constants become missing-row fallback | active | `.omo/evidence/vteam-role-behavior-abstraction/` |
| C2 | `guardForAgent()` resolves built-in `tools`/`bashDeny` from policy config, not constants | active | (pending) |
| C3 | Boundary section + guard correction sourced from resolved policy `correction` (dispatch unification; includes custom agents) | active | (pending) |
| C4 | Built-in template policies become editable (403 removed) and seed stops overwriting them | active | (pending) |
| C5 | Dispatch-layer hardcodes (`VTEAM_AGENT_NAMES`, `roleToAgentName`, `PLAN_AGENT_ID`, `isPlanRole`) derived from agent identity/policy | active | (pending) |
| C6 | Prompts truly page-definable: UI lock fixed + seed no longer overwrites | active | (pending) |
| C7 | Byte-identical built-in output proven; new tests prove DB path actually drives output | active | (pending) |

## Open assumptions (announced defaults)

| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| Output ordering of the 7 built-ins | Keep an explicit order constant (presentation-only), values from DB | seed insert order ≠ required output order (verified); order is presentation, not behavior | yes |
| Missing DB row behavior | Fall back to `ROLE_BOUNDARIES` constant (mirrors `resolveTemplateSource` precedent) | preserves behavior on partially-migrated DBs | yes |
| `bashDeny` source | Policy config optional field; default = `ROLE_BASH_DENY_PATTERNS` (currently empty) | same `guardForAgent` short-circuit; zero behavior change by default | yes |
| Seed vs user edits | Seed only `create`s policy config + prompt; never overwrites an existing row | direct consequence of "允许直接编辑内置策略" + "seed 不再覆盖" | yes |
| Platform-default upgrades | No longer auto-propagate on re-seed | explicit tradeoff of allowing direct edits | yes |
| Custom agents' boundary section | Included: from their policy `correction` (today `''`) | otherwise the abstraction is half-done | yes |
| Rollout | One-shot; no A/B, no legacy shim, no deprecation notes | repo convention | no |
| Test strategy | tests-after; existing snapshot/byte locks retained + NEW DB-driven tests added | existing tests mock prisma to `[]` → cannot prove the DB path | yes |

## Findings (cited - path:lines)

### The three short-circuits (core target)
- `execution-policy.service.ts:326-351` — `buildAgentPolicies()` builds all 7 built-in defs + guard roles from `ROLE_BOUNDARIES[name]`/`AGENT_POLICIES_ORDER`; seeded `ep_<role>` rows never queried for built-ins.
- `execution-policy.service.ts:480-502` — `guardForAgent()` returns `ROLE_BOUNDARIES[agentName].toolAllows` for built-in names and ignores `config`.
- `worker-dispatcher.ts:167-185` — `renderBoundarySection()` reads `ROLE_BOUNDARIES` directly; `''` unless `isVteamAgentName`.

### Split-brain (verified defect)
`resolveByAgent/resolveManyByAgents` (`:218-313`) read `config.permission` from DB but `tools` from constants (via `guardForAgent`); `buildAgentPolicies` reads constants for both. Page and worker agree only because seed mirrors constants byte-for-byte.

### DB rows already carry the full config
- `seed.ts:903-917` — `config = { permission, correction, tools: {...toolAllows} }`; upsert at `:918-929`.

### Ordering hazard
- `AGENT_POLICIES_ORDER` (`:75-83`) = plan, product, architect, developer, tester, project_manager, librarian.
- seed `templateAgents` (`seed.ts:539-818`) = product, project_manager, architect, developer, tester, plan, librarian.
- ⇒ DB read order cannot reproduce required output order; explicit ordering constant required.

### Dispatch-layer hardcodes
- `worker-dispatcher.ts:86` `PLAN_AGENT_ID='a_plan'`; `platform-mcp.service.ts:123` duplicate; used `:1592`.
- `worker-dispatcher.ts:102-110` `VTEAM_AGENT_NAMES`; `:129-136` `roleToAgentName`; `:147-155` `resolvePolicyAgentCandidate` (agentKey-first); `:333` `isPlanRole`; `:2076-2082` boundary assembly.
- `chat.module.ts:34` — no `ExecutionPoliciesModule` ⇒ dispatcher cannot inject the service today.

### Worker wire contract (frozen)
- `injector.ts:203` — `getJson('/agent-policies', {})`; `x-worker-token` + `x-worker-id`; no timeout; failure → `null` → `writeNeutralized`.
- `opencode-config-builder.ts:16-38` expected shape; `:51-53,111-115` unknown field throws ⇒ guard disabled. No field additions.
- `policy.ts:124-201` guard reads only `permission.edit`/`tools`/`bashDeny`/`correction`; `:189-196` only hardcoded name exception is `vteam-plan`.

### Byte-identity locks
- `agent-policies.custom-agents.spec.ts:88-91` — order/deep/`JSON.stringify`/`toMatchSnapshot`.
- `__snapshots__/agent-policies.custom-agents.spec.ts.snap` — only `.snap` in repo; the real gate (88-90 self-referential).
- `agent.constants.spec.ts` — literals `:220-322`, 29 MCP names `:111-113`, 7 gated `:94-104`.
- `seed.spec.ts:132-203` — mirror equality.
- All mock prisma → `[]` (`agent-policies.matrix.spec.ts:120-164`) ⇒ cannot prove DB path. New tests mandatory.
- `scripts/e2e-role-boundaries.sh:372-418` — scenario (f) task contract on `/agent-policies` + injected `opencode.json`.

### Prompt dimension
- `web/app/(main)/agents/page.tsx:1343` — `readOnly={isTemplate}` locks template prompt.
- `seed.ts:941` — `update: { prompt, policyId, agentKey }` overwrites prompt; `seed.ts:920` overwrites policy config.

### BLOCKER: MySQL JSON normalizes key order (kills naive byte-identity)
- `schema.prisma:629` — `config Json` maps to MySQL native `JSON`, which **does not preserve object key insertion order** (MySQL sorts keys by length, then bytewise, on storage).
- The byte-lock at `agent-policies.custom-agents.spec.ts:90` asserts `JSON.stringify(policies) === JSON.stringify(expected)` against a fixture built from **code literals**; `:91` snapshots the serialized string.
- ⇒ Building built-in output directly from a DB-read `config` will reorder nested `permission`/`tools` keys and break both the `JSON.stringify` identity and the `.snap`.
- **Mitigation (must be in the plan):** do NOT treat raw DB JSON key order as the contract. Re-impose canonical order deterministically in code (rebuild `edit`/`read` via `buildEditPermission`/`buildReadPermission`, and emit `mcpDenies`/`tools` in a stable canonical order), then assert **semantic deep-equality** as the true invariant plus canonical serialization for the snapshot. The invariant is "effective permissions/tools/boundaries unchanged", not "MySQL returns the same key order".

### Migration conventions
- dir `<YYYYMMDDHHMMSS>_<snake_case>/migration.sql`; mysql. Backfill precedent `20260914000000_add_agent_key/migration.sql:12`. No data migration needed (rows already full).

### Additional verified hazards
- **Worker rejects illegal/unknown DB values → whole guard disabled.** `opencode-config-builder.ts:119-140` `assertGuardRole` throws on: role not an object, unknown field, non-object `permission`/`tools`, non-string-array `bashDeny`, non-object `correction`. `:143-153` throws on any key outside `['permission','tools','bashDeny','correction']`. The throw is caught at `injector.ts:328-333` → `writeNeutralized` → **entire guard off + all managed agents removed**. So every DB-sourced value must be defensively normalized server-side (illegal `tools` values dropped by `filterToolsMatrix`; `bashDeny` must stay a string array).
- **`policy.task` must stay derived, not blind-copied.** `buildRolePermission` (`:517-530`) hardcodes `task: name === 'vteam-plan' ? 'allow' : 'deny'`; seed stores `task` inside `config.permission` (`seed.ts:903-910`) with the same value. The plan must pick one authority and pin it with a `vteam-plan` regression test.
- **Seed non-destructive change breaks existing specs.** `seed.spec.ts:145` asserts `update.config === create.config`; `:201` asserts `call[0].update.config === call[0].create.config`; `:252` asserts the exact prompt-upsert `update` key set. Changing seed semantics REQUIRES updating these assertions in the same todo.
- **`isPlanRole` is a string heuristic, not identity.** `worker-dispatcher.ts:333-342` matches `'plan' | 'vteam-plan'` plus any role containing `计划`; it gates the memory/artifact section suppression at `:481` and `:518`. De-hardcoding must preserve this exact behavior or `system` output drifts. `roleNeedsIssueDetail` (`:318-327`) is the same pattern.
- **`PLAN_AGENT_ID` is dual-sourced.** `worker-dispatcher.ts:86` and `platform-mcp.service.ts:123` each define it; the plan gate at `platform-mcp.service.ts:1592` and the exempt path at `worker-dispatcher.ts:1448-1462` both depend on it. A partial de-hardcode leaves the two disagreeing.
- **`ChatModule` wiring risks a cycle.** Must import `ExecutionPoliciesModule` without creating one; `platform-mcp.service.ts:404` already uses `@Optional()` injection as precedent for defensive wiring.
- **Dirty worktree = no reliable baseline.** Uncommitted edits exist to `seed.ts`, `worker-dispatcher.ts`, `agent.constants.ts`, the `.snap`, and `agent-policies.matrix.spec.ts` — exactly the files under change. The FIRST todo must capture the before-state after the user commits/stashes.
- **Two fallback policies disagree today.** `resolveByAgent` returns `null` on a missing row; `resolveTemplateSource` falls back to constants. The plan must unify them or "DB-first" behaves differently between the `/agents` API and `/agent-policies`.

## Decisions (with rationale)
- D1: Target three short-circuits + dispatch hardcodes; no new abstraction layer.
- D2: Precedence = DB row wins, constant is missing-row fallback (mirrors `resolveTemplateSource`).
- D3: Ordering stays an explicit constant (presentation-only).
- D4: `ROLE_BOUNDARIES` demoted to seed source + fallback.
- D5: Worker wire contract frozen; no field additions.
- D6: `seed.ts` mirror + `seed.spec.ts` byte-equality retained.
- D7: Byte-identity + new DB-driven tests both mandatory.
- D8: Execution baseline = user commits/stashes in-flight changes before `$start-work`.

## Scope IN
- `buildAgentPolicies()` reads `ep_<role>` config for built-ins (constant fallback).
- `guardForAgent()` resolves built-in `tools`/`bashDeny` from config.
- Boundary section/correction from resolved policy (dispatch unification; includes custom agents).
- Built-in template policies editable; seed stops overwriting prompt + policy config.
- Web: template prompt lock removed; built-in edits exposed.
- Dispatch: hardcodes derived from agent identity + policy; `ChatModule` wiring.
- Tests: preserve byte locks; add DB-driven proof.

## Scope OUT (Must NOT have)
- No new behavior dimension; no change to built-ins' effective permissions/tools/boundaries.
- No worker wire-format change; no `/agent-policies` field additions.
- No worker guard decision-semantics change.
- No A/B dual path, legacy shim, deprecation annotations.
- No TeamTemplate / team-blueprint.
- No per-TeamMember prompt/policy override.
- No `deliverables` runtime consumption.
- No MCP namespace / server-gated set changes.

## Open questions
None — three owner-decisions answered; baseline decision answered.

## Approval gate
status: approved — user approved plan creation; execution baseline = commit/stash first.
