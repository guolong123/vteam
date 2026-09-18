# vteam-role-behavior-abstraction - Work Plan

## TL;DR (For humans)

**What you'll get:** Every AI team member's behavior — its instructions, what it's allowed to do, and who it hands work off to — becomes something you can change from the web page instead of being fixed in the program. Today only your own hand-made agents are editable; the seven built-in ones are frozen, and the page can even show you a setting that the running system ignores. After this work there is one rule for all of them, so changing a built-in role actually takes effect. Re-running the setup routine will also stop wiping out your edits.

**Why this approach:** The database already stores a full, correct description of each built-in role — the problem is that the running system never reads it, it reads a copy hardcoded in the program instead. So this is not a rebuild; it is switching the system to read the copy it already has, and keeping the hardcoded copy only as a safety net if a database entry is missing. Because the two copies currently match exactly, we can prove the built-in roles behave identically before and after by comparing the before/after output byte for byte.

**What it will NOT do:** It will not change the built-in roles' actual powers, rules, or hand-off targets — only where those are stored. It will not build team blueprints or per-member overrides. It will not touch how the execution engine itself makes its allow/deny decisions.

**Effort:** Large
**Risk:** High - two traps are known and load-bearing: the database quietly reorders stored settings, which breaks strict before/after byte comparison unless we re-impose a fixed order; and several existing tests encode the old "built-ins ignore the database" behavior, so they must be deliberately rewritten rather than assumed to keep passing.

**Decisions to sanity-check:** (1) Re-running the setup routine will no longer push platform-updated defaults onto existing installs — that is the price of letting you edit built-ins directly. (2) Built-in policies become editable but still not deletable, because deleting one would silently strip a role's boundaries. (3) You must commit or stash your in-flight changes before starting, so the before/after proof has a trustworthy baseline.

Your next move: run `$start-work vteam-role-behavior-abstraction` to execute, or ask for a high-accuracy review first. Full execution detail follows below.

---

> TL;DR (machine): Large / High - invert 3 constant short-circuits so builtin+vendor agent policies resolve from the DB, unlock builtin editing, preserve user edits across reseed, prove byte-identical factory output + DB-driven effect end to end.

## Scope
### Must have
- Every agent — built-in or custom — resolves its behavior from the same source: the `execution_policies` DB row bound to it. The 7 built-in roles stop being a code-constant special case.
- Built-in roles' behavior dimensions become page-editable: prompt, permission (edit/read/bash/task), guard tool matrix (allow/ask/deny), boundary/correction text, and description.
- Re-seeding no longer destroys user edits to prompts or policies.
- The built-in roles' **effective** behavior in the factory/seeded state is unchanged — proven by a captured before/after artifact, not by assertion.
- The dispatch layer stops gating role behavior on a duplicated name list.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No new behavior dimension (no `duty` field, no `deliverables` consumption, no per-TeamMember override).
- No change to the worker wire contract: field set of `/agent-policies` stays `{agents:[{name,description,mode,permission}], guard:{enabled,roles:{...}}}`; no field additions (unknown keys make the worker throw → guard disabled).
- No change to worker-side guard decision semantics (`worker/src/role-guard/policy.ts` branch order stays).
- No change to the 7 built-ins' effective permission/tool/boundary **values** in the factory state.
- No A/B dual path, legacy shim, or "deprecated"/"retired" annotations.
- No TeamTemplate / team-blueprint feature.
- No MCP tool namespace or server-gated set changes.
- **No implementation of product code by the planning agent** — this plan is executed by a separate `$start-work` session.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after** + jest (`server`: `npx jest --runInBand`; `worker`: `npx jest`) + Playwright for the web surface + the existing bash e2e.
- **Baseline gate (must run first):** the worktree is dirty with in-flight edits to files this plan touches. Before any change, the executor confirms a clean tree (`git status --porcelain` empty for the in-scope files) — the user commits/stashes first per the approved baseline decision — then captures the pre-change output artifact.
- **Byte-identity is proven, not asserted:** capture `/agent-policies` (and the built-in portion of the guard payload) to `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json`, then re-capture after and diff. Any value delta is a regression; a key-order-only delta is resolved by the canonicalization in Todo 2 (see Risks).
- Evidence: `.omo/evidence/vteam-role-behavior-abstraction/task-<N>-vteam-role-behavior-abstraction.<ext>`

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- **Wave 0 — Baseline (serial, blocking):** capture the clean-tree pre-change artifact. Everything else depends on it.
- **Wave 1 — Server core (serial-ish):** the read-path inversion. One file is the hot spot (`execution-policy.service.ts`), so these are largely sequential.
- **Wave 2 — Dispatch unification:** policy-sourced boundary + module wiring. Parallel with Wave 3/4 once Wave 1 lands.
- **Wave 3 — Write path & seed:** 403 semantics, seed preservation, spec rewrites.
- **Wave 4 — Web surface:** prompt lock + built-in editability.
- **Wave 5 — Proof:** DB-driven tests + e2e.
- **Final verification wave:** F1-F4 in parallel.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2-15 | — |
| 2 | 1 | 3,4,5,6,9,10,15 | — |
| 3 | 2 | 11,15 | 4,5,6 |
| 4 | 2,3 | 7,12,15 | 5,6 |
| 5 | 2 | 8,12,15 | 3,4,6 |
| 6 | 2 | 12,15 | 3,4,5 |
| 7 | 4 | 12,15 | 8,9,10 |
| 8 | 5 | 12,13,15 | 7,9,10 |
| 9 | 2 | 12,15 | 7,8,10 |
| 10 | 2 | 12,15 | 7,8,9 |
| 11 | 3 | 14,15 | 7,8,9,10 |
| 12 | 4,5,6,11 | 15 | — |
| 13 | 8 | 15 | 14 |
| 14 | 11,13 | 15 | — |
| 15 | 2-14 | F1-F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

- [x] 1. [baseline] Capture the pre-change `/agent-policies` artifact on a clean tree
  What to do / Must NOT do: Confirm `git status --porcelain` is empty for `server/prisma/seed.ts`, `server/src/chat/worker-dispatcher.ts`, `server/src/common/constants/agent.constants.ts`, `server/src/execution-policies/**`, `web/app/(main)/agents/page.tsx`. If not, STOP and report (the user must commit/stash first — approved baseline decision). Then capture the current built-in policy output to the evidence path. Must NOT edit any file.
  Parallelization: Wave 0 | Blocked by: — | Blocks: all
  References: `.omo/drafts/vteam-role-behavior-abstraction.md` (§Additional verified hazards, dirty-worktree item); `server/package.json` (`test`, `seed`); `scripts/e2e-role-boundaries.sh:372-418`
  Acceptance criteria (agent-executable): `git status --porcelain -- server/prisma/seed.ts server/src/chat/worker-dispatcher.ts server/src/common/constants/agent.constants.ts server/src/execution-policies web/app/\(main\)/agents/page.tsx` prints nothing; evidence file `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json` exists and is valid JSON containing 7 agents.
  QA scenarios (name the exact tool + invocation): happy — capture a small jest/node harness that imports `ExecutionPolicyService` with prisma mocked to `[]` (fallback path == today's constants path) and writes the serialized `buildAgentPolicies()` output; failure — if the tree is dirty the todo FAILS and reports the offending paths. Evidence `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json`
  Commit: N | (no code change; capture-only)

- [x] 2. [server] Canonical emission + per-field DB resolution + write-time safety validation (the core inversion)
  What to do / Must NOT do: In `execution-policy.service.ts` add a **canonical emitter** that produces a deterministic key order independent of MySQL JSON storage order, and a **per-field resolver** that reads from the policy config with constant fallback. Introduce `resolveBuiltinPolicy(name, config | null)` returning `{ description, mode, permission, tools, bashDeny, correction, serverGated }`. Canonical order spec (must reproduce today's output exactly): top-level `permission` = `edit`, `read`, `bash`, `task`, then remaining keys in `VTEAM_MCP_TOOL_NAMES` registry order; `edit` map = `*` first (if present) then remaining keys in the constant's declared order; `read` = as declared; `tools` = keys in the corresponding `ROLE_BOUNDARIES[name].toolAllows` declared order, then any user-added keys appended lexicographically. Add normalization used before emitting: strip/refuse a `write` key in `permission`, coerce `bashDeny` to a string array, drop illegal `tools` values (reuse `filterToolsMatrix`). Must NOT add fields to the wire payload; must NOT change any factory-state value.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3,4,5,6,9,10,15
  References: `server/src/execution-policies/execution-policy.service.ts:75-83` (AGENT_POLICIES_ORDER), `:326-420` (buildAgentPolicies), `:480-502` (guardForAgent), `:504-514` (filterToolsMatrix), `:517-530` (buildRolePermission), `:532-540` (assertWritable); `server/src/common/constants/agent.constants.ts:117-147` (VTEAM_MCP_TOOL_NAMES order), `:198-207` (RoleBoundary), `:248-266` (buildEditPermission/buildReadPermission), `:282-548` (ROLE_BOUNDARIES); `server/prisma/schema.prisma:624-634` (`config Json`); `server/prisma/migrations/20260824000001_add_execution_policy/migration.sql:10` (`config JSON NOT NULL`)
  Acceptance criteria (agent-executable): `cd server && npx tsc -p tsconfig.json --noEmit` exits 0; a unit test asserts that for each of the 7 names, canonicalized output produced from a config fixture round-tripped through `JSON.parse(JSON.stringify(x))` with **keys reordered** equals the constant-derived output (deep-equal AND `JSON.stringify`-equal).
  QA scenarios (name the exact tool + invocation): happy — `npx jest --runInBand src/execution-policies` with a shuffled-key config fixture asserting canonical output is byte-identical to the constant-derived fixture; failure — a config with `permission.write` present is NOT emitted, and a `tools` value of `'bogus'` is dropped. Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-2-canonical.json`
  Commit: Y | `refactor(policies): canonicalize policy emission and resolve builtin fields per-field`

- [x] 3. [server] `buildAgentPolicies()` reads the bound DB row for the 7 built-ins (constant fallback)
  What to do / Must NOT do: Replace the constant-only construction at `:327-351` with: for each name in `AGENT_POLICIES_ORDER`, look up its bound policy (`ep_<role>` via the agent row's `policyId`, or the `ep_<role>` id convention) using a single `findMany` (batch, no N+1), then resolve via Todo 2's resolver. Keep emitting in `AGENT_POLICIES_ORDER` (the seed insert order differs — product, PM, architect, developer, tester, plan, librarian per `seed.ts:539-818` — so order MUST come from the constant, not the query). Missing row OR missing field ⇒ constant fallback (never throw, never emit partial). Must NOT change the response shape; must NOT introduce a new prisma method in a way that breaks existing mocked specs.
  Parallelization: Wave 1 | Blocked by: 2 | Blocks: 11,15
  References: `server/src/execution-policies/execution-policy.service.ts:326-420`; `server/prisma/seed.ts:539-818` (templateAgents order ≠ AGENT_POLICIES_ORDER), `:868-929` (policy upsert, `config` shape at `:903-917`); `server/src/execution-policies/agent-policies.custom-agents.spec.ts:80-92` (byte locks), `:17-26` (BUILTIN_ORDER)
  Acceptance criteria (agent-executable): `npx jest --runInBand src/execution-policies` passes; the emitted built-in payload deep-equals `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json`; `policies.agents.map(a => a.name)` equals `AGENT_POLICIES_ORDER`.
  QA scenarios (name the exact tool + invocation): happy — `npx jest` with `executionPolicy.findMany` mocked to return the factory config for one role, asserting output equals baseline; failure — the row missing ⇒ fallback to constants with no throw. Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-3-db-read.json`
  Commit: Y | `feat(policies): source builtin agent policies from bound db rows`

- [x] 4. [server] `guardForAgent()` resolves builtin `tools`/`bashDeny` from config (remove the short-circuit)
  What to do / Must NOT do: Delete the built-in-name early return at `:487-494`. Resolve `tools` from `config.tools` (filtered + canonicalized) when present, else the constant allowlist; `bashDeny` from `config.bashDeny` when present, else `ROLE_BASH_DENY_PATTERNS`. Applies to `resolveByAgent`, `resolveManyByAgents`, and `buildAgentPolicies`. Must NOT let a partial/legacy `tools` silently tighten a role's effective allowlist in the factory state (factory configs carry the full allowlist — assert this). Must NOT change worker-side semantics.
  Parallelization: Wave 1 | Blocked by: 2,3 | Blocks: 7,12,15
  References: `server/src/execution-policies/execution-policy.service.ts:480-502`; `:218-256` (resolveByAgent), `:264-313` (resolveManyByAgents); `server/src/execution-policies/agent-policies.custom-agents.spec.ts:258-281` (**asserts the opposite today — must be rewritten in Todo 7**); `worker/src/role-guard/policy.ts:124-201` (what the guard actually reads)
  Acceptance criteria (agent-executable): `npx tsc --noEmit` exits 0; for a built-in name with a config whose `tools` equals the constant allowlist, output deep-equals the baseline; with `tools` absent, it falls back to the constant allowlist.
  QA scenarios (name the exact tool + invocation): happy — `npx jest` with a config carrying the full allowlist ⇒ output equals baseline; failure — config with `tools` absent ⇒ constant allowlist used, never `{}`. Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-4-guard.json`
  Commit: Y | `refactor(policies): resolve builtin guard tools from policy config`

- [x] 5. [server] Unify the two fallback policies (`resolveByAgent` vs `resolveTemplateSource`)
  What to do / Must NOT do: Today `resolveByAgent` returns `null` on a missing row while `resolveTemplateSource` derives from `ROLE_BOUNDARIES` (`agents.service.ts:729-776`). Unify on a single shared helper so both use DB-wins-with-constant-fallback. Preserve `agents.service.ts` create/clone provisioning behavior (a custom agent still gets its OWN `type=custom` policy via `provisionCustomPolicy`). Also fix `platform-mcp.service.ts:3830-3833`, which omits `agentKey` when calling `resolveByAgent` — pass it so a custom agent's resolved `agentName` matches the `/agents` view. Must NOT change custom-agent provisioning semantics or the `effectivePermission` response shape.
  Parallelization: Wave 1 | Blocked by: 2 | Blocks: 8,12,15
  References: `server/src/agents/agents.service.ts:182-223` (create), `:233-299` (clone), `:576-645` (toAgentDto/toAgentDtoList), `:701-721` (provisionCustomPolicy), `:729-776` (resolveTemplateSource), `:782-801` (buildSkeletonConfig); `server/src/platform-mcp/platform-mcp.service.ts:3830-3833`
  Acceptance criteria (agent-executable): `npx jest --runInBand src/agents src/execution-policies src/platform-mcp` passes; a test asserts a missing `ep_<role>` row yields the constant-derived policy (not `null`) through BOTH paths, and that a custom agent still gets its own `type=custom` policy id.
  QA scenarios (name the exact tool + invocation): happy — `npx jest` with the DB row deleted, asserting both paths return the constant-derived policy; failure — a custom agent never binds the `template` row (`policyId !== 'ep_<role>'`). Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-5-fallback.json`
  Commit: Y | `refactor(policies): unify policy fallback across resolve paths`

- [x] 6. [server] Make `mode` and `task` derivation explicit and pinned
  What to do / Must NOT do: `mode` is not stored in the DB config; it is derived (`name === 'vteam-plan' ? 'all' : 'primary'`). Make that derivation a single named helper with a unit test pinning it (so a future DB `mode` field can replace it without touching call sites). For `permission.task`, decide ONE authority and document it in code: prefer the DB value when present, fall back to the `vteam-plan`-only rule; add a regression test asserting `task === 'allow'` only for `vteam-plan` in the factory state. Must NOT introduce a new DB field.
  Parallelization: Wave 1 | Blocked by: 2 | Blocks: 12,15
  References: `server/src/execution-policies/execution-policy.service.ts:332` (mode), `:517-530` (task hardcode); `server/prisma/seed.ts:896-910` (seed computes `taskEffect`, stores `task`); `server/src/execution-policies/agent-policies.matrix.spec.ts:102,111,171-233`
  Acceptance criteria (agent-executable): `npx jest --runInBand src/execution-policies` passes; a test asserts `mode` is `'all'` exactly once (vteam-plan) and `permission.task === 'allow'` exactly once in the built-in output.
  QA scenarios (name the exact tool + invocation): happy — factory config ⇒ same `mode`/`task` values as baseline; failure — a config that omits `task` still yields the derived value, never `undefined` on the wire. Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-6-mode-task.json`
  Commit: Y | `refactor(policies): centralize mode and task derivation`

- [x] 7. [server] Rewrite the specs that encode the old short-circuit semantics
  What to do / Must NOT do: Rewrite `agent-policies.custom-agents.spec.ts:258-281` (`resolveByAgent 对内置名忽略 config.tools`) to assert the NEW semantics: a built-in resolves `tools` from its config, and an absent/partial config falls back to the constant allowlist. Update any assertion elsewhere that pins "built-ins ignore config". Keep the byte-identity suite (order + deep-equal + `JSON.stringify` + snapshot) intact and GREEN. Must NOT weaken or delete the byte-identity assertions.
  Parallelization: Wave 3 | Blocked by: 4 | Blocks: 12,15
  References: `server/src/execution-policies/agent-policies.custom-agents.spec.ts:1-283` (esp. `:18-26`, `:79-92`, `:258-281`); `server/src/execution-policies/agent-policies.matrix.spec.ts:119-154`; `server/src/execution-policies/agent-policies.controller.spec.ts`
  Acceptance criteria (agent-executable): `npx jest --runInBand src/execution-policies` fully green; the rewritten test fails if the built-in short-circuit is reintroduced (mutation check).
  QA scenarios (name the exact tool + invocation): happy — new assertions pass via `npx jest`; failure — temporarily re-adding the short-circuit makes the rewritten test fail (record the run). Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-7-spec-rewrite.txt`
  Commit: Y | `test(policies): assert builtins resolve guard tools from config`

- [x] 8. [server] Allow editing built-in policies via PATCH (remove only the PATCH 403)
  What to do / Must NOT do: Remove the `assertWritable(type)` call from `update()` so `PATCH /execution-policies/:id` works for `type='template'`. **Keep** the POST template rejection (prevents forging new template rows; the DTO already restricts to `custom`) and **keep** the DELETE template rejection (deleting a built-in policy would silently remove a role's boundary at dispatch). Update `execution-policies.controller.spec.ts` only for the PATCH case (`:156-168`); leave the POST (`:111-127`) and DELETE (`:192-202`) 403 assertions intact. Must NOT remove the create/delete guards.
  Parallelization: Wave 3 | Blocked by: 5 | Blocks: 12,13,15
  References: `server/src/execution-policies/execution-policy.service.ts:152-157` (create 403), `:175-199` (update), `:203-210` (remove), `:532-540` (assertWritable); `server/src/execution-policies/execution-policies.controller.spec.ts:111-202`; `server/src/execution-policies/dto/create-execution-policy.dto.ts:30-35` (`@IsIn(['custom'])`)
  Acceptance criteria (agent-executable): `npx jest --runInBand src/execution-policies` passes; `PATCH /execution-policies/ep_product` with a modified `config.tools` returns 200 and persists; `POST` with `type:'template'` still returns 403; `DELETE /execution-policies/ep_product` still returns 403.
  QA scenarios (name the exact tool + invocation): happy — `curl -X PATCH` a built-in policy then GET it back changed; failure — `curl -X DELETE` the built-in policy returns 403 `POLICY_TEMPLATE_READONLY`. Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-8-patch.txt`
  Commit: Y | `feat(policies): allow editing builtin policy config via patch`

- [x] 9. [server] Stop re-seed from overwriting user-edited prompts
  What to do / Must NOT do: Change the template-agent upsert (`seed.ts:929-955`) so `update` no longer writes `prompt` (and no longer writes `policyId`/`agentKey` — they are bindings a user may have changed). Use `update: {}` for template agents (create-if-absent semantics). Document in the seed comment that platform-default prompt upgrades no longer auto-apply to existing installs — the accepted tradeoff of making built-ins editable. Must NOT change the create payload, the seed id set, or the upsert ordering (policies still upsert before agents).
  Parallelization: Wave 3 | Blocked by: 2 | Blocks: 12,15
  References: `server/prisma/seed.ts:918-929` (policy upsert), `:929-955` (agent upsert, `update` at `:941`); `server/src/prisma/seed.spec.ts:244-264` (asserts `update.prompt` today), `:114-130`, `:232-242` (ordering)
  Acceptance criteria (agent-executable): `cd server && npx tsc -p tsconfig.json --noEmit` exits 0; after `npm run seed` twice with an intervening manual prompt edit, the edit survives the second run.
  QA scenarios (name the exact tool + invocation): happy — edit a template prompt via `PATCH /agents/:id`, re-run `npm run seed`, re-GET shows the edited value; failure — a fresh DB still creates all 7 template agents with the factory prompt. Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-9-seed-preserve.txt`
  Commit: Y | `fix(seed): preserve user-edited template prompts across reseed`

- [x] 10. [server] Stop re-seed from overwriting user-edited policy config
  What to do / Must NOT do: Change the policy upsert (`seed.ts:918-929`) so `update` no longer writes `config`/`description` (use `update: {}` for the template policy rows). Note `seed.spec.ts:145` (`update.config === create.config`) and `:201` (`call[0].update.config === call[0].create.config`) encode the old overwrite behavior — invert them in Todo 12. Must NOT change the template policy ids (`ep_<role>`) or the create-time config shape.
  Parallelization: Wave 3 | Blocked by: 2 | Blocks: 12,15
  References: `server/prisma/seed.ts:903-929`; `server/src/prisma/seed.spec.ts:132-203` (`:145`, `:195-201`); `server/src/execution-policies/execution-policy.service.ts:152-157`
  Acceptance criteria (agent-executable): `npx tsc -p tsconfig.json --noEmit` exits 0; after `npm run seed` twice with an intervening policy `config.tools` edit, the edit survives.
  QA scenarios (name the exact tool + invocation): happy — `PATCH /execution-policies/ep_product`, re-run `npm run seed`, re-GET shows the edited config; failure — a fresh DB still creates all 7 `ep_<role>` rows with the factory config. Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-10-seed-policy.txt`
  Commit: Y | `fix(seed): preserve user-edited policy config across reseed`

- [x] 11. [dispatch] Source the boundary section from the resolved policy (drop the name-list gate)
  What to do / Must NOT do: Replace `renderBoundarySection(agentName)` (`worker-dispatcher.ts:167-185`) with a renderer that takes the **resolved policy `correction`** (`{scopeSummary, handoff, denyTemplate}`) rather than a name, and delete the `isVteamAgentName` early-return so custom agents also get a boundary section from their policy. At the dispatch site (`:2073-2083`) resolve the target's policy through `ExecutionPolicyService` and pass its `correction`. Inject `ExecutionPolicyService` into `ChatModule` (add `ExecutionPoliciesModule` to imports — verify no cycle: `ExecutionPoliciesModule` must not import `ChatModule`; follow the `@Optional()` precedent at `platform-mcp.service.ts:404` if needed). Must NOT change the injected text for the factory state (the correction values are identical to today's constants, so the rendered string must be byte-identical); must NOT change `roleToAgentName` or `resolvePolicyAgentCandidate` behavior. Note the scope boundary: `VTEAM_AGENT_NAMES`/`roleToAgentName` **stay** as the identity/fallback mapping (they gate `agent` selection, not behavior text); only the behavior-text source moves to the policy. This is deliberate — the abstraction target is behavior, not the agent-name namespace.
  Parallelization: Wave 2 | Blocked by: 3 | Blocks: 14,15
  References: `server/src/chat/worker-dispatcher.ts:167-185` (renderer), `:102-110` (VTEAM_AGENT_NAMES), `:117-136` (isVteamAgentName/roleToAgentName), `:147-155` (resolvePolicyAgentCandidate), `:460-546` (buildSystemInstructions, `boundarySection` at `:502`), `:2054-2083` (dispatch site); `server/src/chat/chat.module.ts:34`; `server/src/execution-policies/execution-policies.module.ts`; `server/src/platform-mcp/platform-mcp.service.ts:404` (`@Optional()`)
  Acceptance criteria (agent-executable): `npx tsc -p tsconfig.json --noEmit` exits 0; `npx jest --runInBand src/chat` passes; for each of the 7 built-ins the rendered boundary string equals the pre-change string (compare against a captured fixture).
  QA scenarios (name the exact tool + invocation): happy — factory correction ⇒ byte-identical boundary text to baseline (assert via `npx jest`); failure — a custom agent with a policy `correction` now receives a non-empty boundary section (previously `''`). Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-11-boundary.json`
  Commit: Y | `refactor(dispatch): render boundary section from resolved policy`

- [x] 12. [seed/spec] Rewrite the seed specs to encode preservation instead of overwrite
  What to do / Must NOT do: Invert `seed.spec.ts` assertions that encode overwrite: `:145` (`update.config === create.config`), `:201`, and `:244-264` (the prompt `update` key set and `update.prompt` string). Replace them with assertions that `update` is empty (`{}`) for template agents and template policies, while the `create` branch still carries the full factory prompt/config. Preserve the ordering assertion (`:232-242`) and the create-shape assertions. Must NOT delete the spec's ability to catch a missing template seed.
  Parallelization: Wave 3 | Blocked by: 4,5,6,11 | Blocks: 15
  References: `server/src/prisma/seed.spec.ts:114-130`, `:132-203`, `:232-264`, `:266-300`; `server/prisma/seed.ts:918-955`
  Acceptance criteria (agent-executable): `npx jest --runInBand src/prisma` fully green; the spec fails if `update` starts carrying `prompt`/`config` again (mutation check).
  QA scenarios (name the exact tool + invocation): happy — assertions pass via `npx jest`; failure — temporarily restoring `update: { prompt }` makes the spec fail (record the run). Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-12-seed-spec.txt`
  Commit: Y | `test(seed): assert reseed preserves template prompt and policy config`

- [x] 13. [web] Unlock the template prompt editor
  What to do / Must NOT do: At `web/app/(main)/agents/page.tsx:1343` replace `readOnly={isTemplate}` with the component's real `readOnly` prop (passed as `false` at `:2553`), and remove/adjust the "只读" template badge so the UI no longer claims the prompt is locked. The server already permits the PATCH. Must NOT change the save path or the payload shape; must NOT touch unrelated UI.
  Parallelization: Wave 4 | Blocked by: 8 | Blocks: 15
  References: `web/app/(main)/agents/page.tsx:1343` (`readOnly={isTemplate}`), `:1174-1189` (badge), `:2553` (`readOnly={false}`), `:1086-1097` (save mutation); `server/src/agents/dto/update-agent.dto.ts:52` (`prompt?: string`)
  Acceptance criteria (agent-executable): `cd web && npx tsc --noEmit` exits 0; a Playwright run shows the prompt textarea for a `type=template` agent is editable and a saved change persists after reload.
  QA scenarios (name the exact tool + invocation): happy — Playwright edits the template prompt, saves, reloads, value persists; failure — the textarea is not `readOnly` (previously it was). Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-13-web-prompt.png`
  Commit: Y | `fix(web): allow editing template agent prompts`

- [x] 14. [web] Make the built-in tool matrix editable in the UI
  What to do / Must NOT do: Extend the permission section's `editable` gate (`agents/page.tsx:624`, readOnly at `:875`) so built-in (`type=template`) agents' guard tool rows expose the allow/ask/deny control and PATCH the bound policy (the mutation at `:689-707` already targets `/execution-policies/:policyId`). Keep layer-① native rows (`edit`/`read`/`bash`/`task`) read-only as today. Must NOT change the mutation payload shape or the server-gated rows' display.
  Parallelization: Wave 4 | Blocked by: 11,13 | Blocks: 15
  References: `web/app/(main)/agents/page.tsx:619-1021` (EffectivePermissionSection), `:624` (`editable`), `:660-717` (effectOf/matrixKeyOf/policyMutation), `:875` (readOnly); `server/src/execution-policies/execution-policies.controller.ts:64-70`
  Acceptance criteria (agent-executable): `cd web && npx tsc --noEmit` exits 0; Playwright toggles a tool state on a template agent, reloads, and the new state persists.
  QA scenarios (name the exact tool + invocation): happy — Playwright toggles allow→deny on a built-in agent, confirms persistence; failure — the control is present and enabled (previously read-only). Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-14-web-matrix.png`
  Commit: Y | `feat(web): edit builtin agent tool matrix from the page`

- [x] 15. [proof] DB-driven policy test + end-to-end verification
  What to do / Must NOT do: Add a test that FAILS under the old short-circuit: seed a DB row (`findMany` mock or a real integration test) whose `config.tools` differs from the constant allowlist, and assert `buildAgentPolicies()` / the guard payload reflects the DB value. Then extend `scripts/e2e-role-boundaries.sh` scenario (f) to prove: editing a built-in policy's tool state changes the injected `opencode.json` + `roles.json` after a worker reload, while the other 6 built-ins stay byte-identical to the captured baseline. Must NOT weaken the existing scenario assertions.
  Parallelization: Wave 5 | Blocked by: 2-14 | Blocks: F1-F4
  References: `server/src/execution-policies/agent-policies.matrix.spec.ts:119-164` (**mocks prisma to `[]` — this is why a new DB-driven test is mandatory**); `server/src/execution-policies/agent-policies.custom-agents.spec.ts:79-92`; `scripts/e2e-role-boundaries.sh:372-418`; `worker/src/resources/injector.ts:200-220` (fetch + neutralize), `:322-360` (write), `:451-456` (roles.json); `worker/src/resources/opencode-config-builder.ts:119-153` (strict validation → guard neutralization); `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json`
  Acceptance criteria (agent-executable): the new test fails if Todo 3/4 are reverted (mutation check, recorded); `bash scripts/e2e-role-boundaries.sh` passes scenario (f) with the DB-edited value present in the injected artifacts, and the 6 untouched built-ins diff-empty against the baseline.
  QA scenarios (name the exact tool + invocation): happy — edit `ep_product` `tools` via `curl -X PATCH`, reload the worker, observe the change in `roles.json` + `opencode.json` and no diff for the others; failure — editing the policy produces NO change in the injected artifacts (proves the DB path is not wired). Evidence `.omo/evidence/vteam-role-behavior-abstraction/task-15-db-driven.txt` + `after-agent-policies.json`
  Commit: Y | `test(e2e): prove builtin policies are db-driven end to end`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
- One commit per todo, prefix `feat|fix|refactor|test|docs(<scope>): <summary>`; Todo 1 is capture-only (no commit).
- Wave 1 commits must keep `npx jest --runInBand src/execution-policies src/agents src/prisma` green at every step.
- The byte-identity evidence artifacts (`before-agent-policies.json`, `after-agent-policies.json`) are committed under `.omo/evidence/` with the final proof todo.
- Do NOT push until the user says so.

## Success criteria
- `cd server && npx tsc -p tsconfig.json --noEmit`, `cd worker && npx tsc --noEmit`, `cd web && npx tsc --noEmit` all exit 0.
- `server`: `npx jest --runInBand` green (esp. `src/execution-policies`, `src/agents`, `src/prisma`, `src/chat`); `worker`: `npx jest` green.
- **Factory-state invariant:** the 7 built-ins' emitted `/agent-policies` payload (agents + guard roles) deep-equals the baseline captured from the clean tree in Todo 1.
- **Feature proof:** editing a built-in role's prompt, tool state, or boundary via the page changes the worker's injected `opencode.json` / `roles.json` after reload — and leaves the other 6 built-ins unchanged.
- **Seed proof:** re-running `npm run seed` preserves user-edited prompts and policy configs.
- No worker wire-contract change: `assertGuardRole` / `assertAgentShape` accept the emitted payload without throwing (guard not neutralized).
