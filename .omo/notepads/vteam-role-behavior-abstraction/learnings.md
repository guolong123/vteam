# Learnings — vteam-role-behavior-abstraction

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## Todo 2 — canonical emission + per-field DB resolution (task-2-canonical)

**Canonical order implemented** (all in `server/src/execution-policies/execution-policy.service.ts`, module-level, exported for tests):

- `permission` top-level: `edit`, `read`, `bash`, `task`, then the remaining keys in `VTEAM_MCP_TOOL_NAMES` registry order; any unknown extra keys appended lexicographically (`orderKeys`).
- `edit` map: `*` first, then the role's `ROLE_BOUNDARIES[name].writeGlobs` declared order, unknowns lexicographic.
- `read`: `orderKeys(read, ['*'])`.
- `tools`: role's `toolAllows` declared order, then user-added keys lexicographic (after `filterToolsMatrix` drops illegal values).
- `correction`: `scopeSummary`, `handoff`, `denyTemplate`; nested `handoff` in the role's `handoffTo` declared order.
- `permission.write` is deleted in `canonicalizePermission` before reordering (never emitted).

**Helpers added** (exported, pure): `resolveBuiltinPolicy`, `canonicalizePermission`, `canonicalizeTools`, `canonicalizeEditMap`, `canonicalizeCorrection`, `filterToolsMatrix`, `buildRolePermission`, `buildRoleCorrection`, plus the `ResolvedBuiltinPolicy` interface. The old private `isPlainObject` / `filterToolsMatrix` / `buildRolePermission` were **lifted to module scope and the privates deleted** (single path, no A/B duplicate) — service call sites use the module functions.

**Surprises / gotchas**

1. **`buildAgentPolicies()` byte-identity confirmed live, not just asserted**: a standalone ts-node harness compared the real `buildAgentPolicies()` (empty-prisma stub) against `.omo/evidence/.../before-agent-policies.json` → `JSON.stringify` byte-identical at HEAD with the new helpers in place. This task intentionally does NOT wire `resolveBuiltinPolicy` into `buildAgentPolicies()` (Todo 3 owns that).
2. MySQL `JSON` key order = **key length ascending, then bytewise** — verified in the evidence (`config_key_order` for plan starts `bash, edit, read, task, vteam_issue_get, …`). The reorder is fully reversed for a second independent shuffle; both resolve byte-identically.
3. `tools` fallback rule is "filtered result must have ≥1 legal entry, else constant allowlist" — so an all-illegal `tools` (`{bogus:'whatever'}`, `[]`, `'nope'`, `42`) falls back to the constant, never `{}`.
4. `bashDeny` coercion filters non-strings rather than returning the raw array (`['rm -rf /', 42, null]` → `['rm -rf /']`) — spec pins this.
5. New spec lives in `policy-canonical.spec.ts` (80 tests) so the frozen byte-lock specs are untouched. Expected values are derived from `ROLE_BOUNDARIES` constants (independent check), never inlined literals.
6. `mode` is deliberately NOT read from `config` in the resolver (matches plan MUST DO #4: derived by the existing rule; Todo 6 will centralize it).

## Todo 3 — `buildAgentPolicies()` reads the bound DB row for the 7 built-ins (task-3-db-read)

**Wiring** (all in `server/src/execution-policies/execution-policy.service.ts`):

- New exported pure helper `builtinPolicyIdOf(name)` (module-level, line 330): `${POLICY_ID_PREFIX}_${name.replace(/^vteam-/, '')}` → `vteam-plan`→`ep_plan`, `vteam-project_manager`→`ep_project_manager`, `vteam-librarian`→`ep_librarian`. Keeps the `ep_<role>` convention in ONE place (seed.ts has its own `ROLE_POLICY_BINDINGS` map; the conventions must stay in lockstep).
- `buildAgentPolicies()` (line 575) now: (1) maps `AGENT_POLICIES_ORDER` → `ep_<role>` ids, (2) ONE `prisma.executionPolicy.findMany({ where: { id: { in: ids } } })`, (3) maps rows by id, (4) `resolveBuiltinPolicy(name, row?.config ?? null)` per name, (5) emits `agents`/`guard.roles` from that **in `AGENT_POLICIES_ORDER`** (never from the query result order). The custom block (`agentKey != null && policyId != null`) is untouched and still does its own separate `findMany` for custom policy ids.

**Key decisions / gotchas**

1. **Reused `findMany`, NOT `findUnique`** — the frozen byte-lock specs (`agent-policies.matrix.spec.ts`, `agent-policies.custom-agents.spec.ts`, `agent-policies.controller.spec.ts`) mock only `agent.findMany` + `executionPolicy.findMany` with `mockResolvedValue([])`. The new built-in `findMany` therefore returns `[]` there ⇒ constant fallback ⇒ byte-identity holds with ZERO edits to those specs (confirmed: all 5 pre-existing suites still pass unchanged).
2. **`guard.roles` entries do NOT route through `guardForAgent`** for built-ins. `guardForAgent` still has its built-in short-circuit (returns `ROLE_BOUNDARIES.toolAllows`, ignoring config) — Todo 4 owns removing it. If Todo 3 had called `guardForAgent`, the resolver's config-sourced `tools` would be silently overridden. So the built-in guard block uses `policy.tools` / `policy.bashDeny` straight from `resolveBuiltinPolicy`. **After Todo 4 deletes the short-circuit, `guardForAgent` for built-ins becomes dead-ish on the `buildAgentPolicies` path — it is still used by `resolveByAgent` / `resolveManyByAgents` / the custom block, so do not delete the method, only the early return.**
3. `resolveBuiltinPolicy(name, row?.config ?? null)` — an absent row passes `null` (not `undefined`) so the resolver's per-field fallback engages; a row with a non-object `config` is also handled (`isPlainObject` → `{}`).
4. **Evidence harness pattern**: `.omo/evidence/vteam-role-behavior-abstraction/capture-db-read.mjs` stubs `prisma.executionPolicy.findMany` in-process (no DB) and runs the REAL `buildAgentPolicies()`. `allPass: true` proves: factory rows (incl. MySQL-shuffled key order + reversed row order) reproduce `before-agent-policies.json` byte-for-byte; single `findMany` with the 7 `ep_<role>` ids; missing rows / partial rows (no `tools`) → constant fallback, non-empty tools, no throw; a differing DB `tools` value wins over the constant (proves the read path is live).
5. New spec `agent-policies-db-builtin.spec.ts` (6 tests) is the in-jest version: asserts baseline `JSON.stringify` equality, constant emission order under shuffled rows, one batched `findMany` with the exact id set, DB-value-wins, and the two fallback cases. It reads the baseline JSON via a path relative to `__dirname` (`../../../.omo/evidence/...`) — jest `rootDir` is `server/src`, so this resolves to the repo-root `.omo/` dir.

## Todo 5 — unify the two fallback policies (`resolveByAgent` vs `resolveTemplateSource`) (task-5-fallback)

**Wiring** (all in `server/src/execution-policies/execution-policy.service.ts` + `server/src/agents/agents.service.ts`):

- New exported pure helper `resolveConstantPolicySource(name)` (module-level, right after `builtinPolicyIdOf`): returns `{ config: { permission, correction, tools }, description, bashDeny }` derived from `resolveBuiltinPolicy(name, null)` for a `ROLE_BOUNDARIES` name, else `null`. This is the **single constant-derivation entry point** shared by both paths.
- `resolveByAgent` / `resolveManyByAgents` now both funnel through ONE private `resolveAgentWithFallback(agent, policy, key)`. Row present → the pre-existing DB-config resolution verbatim (so Todo 4's `guardForAgent` change flows through untouched). Row missing AND `role` names a `ROLE_BOUNDARIES` role → `resolveBuiltinPolicy(constant, null)` (NOT null). Row missing + non-builtin → null. `resolveManyByAgents` now issues NO `findMany` when no agent has a key (was already the case) — but the shape is one `findMany` for all keys, then per-entry fallback.
- `agents.service.ts#resolveTemplateSource` now calls `resolveConstantPolicySource('vteam-'+role)` instead of hand-rolling the `permission`/`correction`/`tools` object from `ROLE_BOUNDARIES`. Dropped now-unused imports `buildEditPermission`, `buildReadPermission`, `ROLE_BOUNDARIES`, `VteamAgentName` from that file (kept `ROLE_POLICY_DENY_TEMPLATE` for `buildSkeletonConfig`).
- `platform-mcp.service.ts#myProfile` now `select`s `agentKey` and passes it to `resolveByAgent({policyId, role, agentKey})` so a custom agent's resolved `agentName` (`vteam-<agentKey>`) matches the `/agents` view instead of degrading to `vteam-<role>`.

**Key decisions / gotchas**

1. **Built-in detection is ROLE-based, not agentName-based**: `resolveAgentWithFallback` checks `constantRoleNameOf(agent.role)` (`vteam-<role>` ∈ `ROLE_BOUNDARIES`), NOT `boundaryOf(agentName)`. A custom agent whose `agentKey` happens to equal a built-in role (e.g. `agentKey:'product'`) would otherwise be misclassified as builtin and get the wrong `agentName`/tools. Role is the identity that carries the built-in namespace.
2. **Present-row behavior intentionally unchanged**: the fallback only fires when `policy` is null. `tools` for a present built-in row still comes from `guardForAgent` (constant short-circuit) — Todo 4 owns flipping that. So this task does NOT touch Todo 4's territory; the byte-lock specs stay green.
3. **`policyId` for a missing row** is `key ?? builtinPolicyIdOf(constantName)`; `policyName` is the derived `agentName`. Non-null is the whole point of the unification.
4. **Frozen byte-lock specs untouched**: `agent-policies.custom-agents.spec.ts:258-281` ("built-in ignores config.tools") still passes because present-row path is unchanged.
5. **`AgentsService.resolveTemplateSource` is private** — the new spec reaches it via a typed cast (`agents as unknown as { resolveTemplateSource(...) }`) to prove both paths share the derivation. The evidence harness (`capture-fallback.mjs`) also calls it after `ts-node` transpile (private → public at runtime).
6. **Evidence harness**: `.omo/evidence/.../capture-fallback.mjs` runs both real services with stubbed prisma (no DB). Checks: missing `ep_product`/`ep_plan`/`ep_librarian` rows → constant policy through `resolveByAgent` AND `resolveManyByAgents`; present row wins; `resolveTemplateSource` missing row → same constant object; unknown role → null; `AgentsService.create` with `role:'developer'` provisions its own `type='custom'` id ≠ `ep_developer`. `allPass:true`.



## Todo 4 + Todo 6 + Todo 7 — remove guard short-circuit, centralize mode/task, rewrite spec (task-4-guard / task-7-spec-rewrite)

**Unified guard resolver (Todo 4)** — all in `server/src/execution-policies/execution-policy.service.ts`:
- `guardForAgent()` no longer early-returns on a built-in name. New shape: `config == null` → constant allowlist for a `ROLE_BOUNDARIES` name (else `{tools:{},bashDeny:[]}`); `config != null` → `resolveGuardTools(agentName, config.tools)` + `resolveBashDeny(config.bashDeny)`.
- New exported pure helpers `resolveGuardTools(agentName, tools)` and `resolveBashDeny(bashDeny)` ARE the single fallback implementation; `resolveBuiltinPolicy` now calls them too (replacing its inline `canonicalTools.length>0 ? … : boundary.toolAllows` and array-filter). ONE fallback path, no duplication. `filterToolsMatrix` is still exported (used by policy-canonical spec / custom path indirectly) but the service no longer calls it directly.

**mode/task single authorities (Todo 6)**:
- `deriveAgentMode(name): 'primary'|'all'` — used by `resolveBuiltinPolicy` AND the custom-agent block (was `'primary' as const`).
- `resolveTaskEffect(name, storedTask?)` — DB `config.permission.task` wins when a legal tri-state, else `vteam-plan → allow` / others `deny`. Wired by merging the resolved task back into `cfg.permission` **before** `canonicalizePermission`, so it stays at the canonical `edit,read,bash,task,…` position even when the DB omitted `task` entirely.
- NO new DB field. New spec `agent-policy-derivation.spec.ts` (mode helper pin + task helper precedence + factory-state "allow exactly once == vteam-plan" over both `agents[]` and `guard.roles[]`).

**Getting the `resolveTaskEffect` merge right**: naive `permission.task = resolveTaskEffect(...)` after canonicalization appends `task` at the END of the key order (breaks byte-identity). Must spread into the input object before `canonicalizePermission`.

**Why the old spec had to be inverted**: `agent-policies.custom-agents.spec.ts:258-281` fed `tools:{vteam_group_post:'deny', bogus:'allow'}` and expected the constant allowlist. Note `bogus:'allow'` is a *legal* tri-state value, so canonicalization keeps it — the old fixture's "bogus" only looked illegal because it was ignored. Rewrote to (i) config-wins with a genuinely illegal value (`bogus:'whatever'`) dropped, (ii) absent/all-illegal/non-object `tools` → constant allowlist never `{}`, (iii) `bashDeny` string[]-filter + fallback. Added a 3rd test rather than only editing in place.

**Mutation check**: re-adding the short-circuit in `guardForAgent` makes 2 rewritten tests fail (`config.tools` value and `config.bashDeny` value both masked); restoring the file makes them green. Recorded verbatim in `.omo/evidence/vteam-role-behavior-abstraction/task-7-spec-rewrite.txt`.

**Evidence**: `.omo/evidence/.../capture-guard.mjs` → `task-4-guard.json` (`allPass:true`), proving factory-config byte-identity, absent/all-illegal fallback, differing `tools` wins through BOTH `resolveByAgent` and `buildAgentPolicies`, and `bashDeny` wins/falls back. `capture-db-read.mjs` still `allPass:true`; baseline sha256 unchanged `793093dc5106…bc3a`. Full server suite green (129 suites / 3005 tests).

## Todo 9 + Todo 10 — re-seed stops clobbering user edits (task-9-10-seed-preserve)

**Change** (`server/prisma/seed.ts` only):
- Template `executionPolicy.upsert` update: `{ name, description, type, config }` → `{}`.
- Template `agent.upsert` update: `{ prompt, policyId, agentKey }` → `{}`.
- Both create branches (and seeded ids `ep_<role>` / `a_*`, and policy-before-agent ordering) untouched.
- The two adjacent comment blocks rewritten to state the new contract honestly: built-ins are page-editable behavior sources, so re-seed no longer pushes platform-default prompt/config upgrades to existing installs; factory defaults land only on first create. (The old comments explicitly claimed the opposite — "seed 不承担保留用户定制的义务" — so leaving them would have been a lie.)

**Behavioral note on `update: {}`**: Prisma upsert with an empty update is a no-op on existing rows (columns untouched) while create still fires for missing rows. Minimal change: keeps `where`/`create` call shapes exactly as the spec's mocks expect; no findUnique-then-create refactor.

**Evidence** `.omo/evidence/vteam-role-behavior-abstraction/task-9-10-seed-preserve.txt` (`allPass: true`) via `capture-seed-preserve.mjs`: runs the REAL `main()` against an in-process fake prisma implementing true upsert semantics (existing + empty update => untouched). Proves on a fresh store all 7 policies/agents still create with factory config deep-equal to `before-seed-policy-config.json` and full 4-section prompts; on a second run all 14 update payloads are `{}`; user edits to `ep_product.config.tools`/description and `a_product.prompt`/policyId/agentKey survive; counterfactual check confirms the OLD payloads would have clobbered them (non-vacuous).

**Deliberate seed.spec.ts failures (Todo 12 owns the rewrite)** — `npx jest --runInBand src/prisma/seed.spec.ts` → `Tests: 22 failed, 22 passed, 44 total`. Raw output + verbatim test names captured in `.omo/evidence/.../task-9-10-seed-spec-failures.txt`. Split for Todo 12:
- 5 failing tests (6 assertion sites) literally encode overwrite and must invert: `:144` `expect(update.type)`, `:145` `expect(update.config).toEqual(create.config)`, `:201` same, `:216` `expect(update.agentKey)`, `:228` `expect(update.policyId)`, `:252-256` update key set `['agentKey','policyId','prompt']`.
- 17 more tests read `call[0].update.prompt` (now `undefined`) — they are NOT overwrite assertions; Todo 12 should point them at `call[0].create.prompt` (factory prompt still on create) or expose a shared helper. Tests are: the prompt-content suite in `seed（模板 Agent 预置 + 角色策略）` (7 tests: 四方向/越界转交/可用工具/协作规约/计划员四方向), `seed（计划 skills + 评审子句）` (2: 专属评审 skill / 无交叉污染), and all `seed（todo9 执行铁律与行为探针）` prompt probes (8) via `promptsById()` at `:955-964` — that helper itself reads `call[0].update.prompt`.
- Still GREEN as-is: ordering assertion `:232-242`, create-shape assertions, and the whole rest of the suite.
- Rest of server suite with seed.spec excluded: `npx jest --runInBand --testPathIgnorePatterns=seed.spec.ts` → **127 suites / 2959 tests passed** (exit 0). `npx tsc -p tsconfig.json --noEmit` exit 0.

## Todo 8 — allow editing built-in policies via PATCH (task-8-patch)

**Change** (3 files, `execution-policy.service.ts` is the only behavior change):
- `update()`: the `this.assertWritable(existing.type)` call is GONE (was the line right after the 404 check). `create()`'s explicit `type==='template'` throw and `remove()`'s `assertWritable` are untouched. The only remaining caller of `assertWritable` in this service is `remove()`.
- Docstrings corrected where they claimed PATCH-template is 403: class-level CRUD bullet (`仅 POST/DELETE → 403`), `update()` jsdoc, `assertWritable` jsdoc, controller class jsdoc + `@ApiOperation` summary for PATCH.
- Spec `execution-policies.controller.spec.ts`: the old PATCH-403 passthrough test was replaced by a 200+GET-persisted round-trip test; POST (~:112) and DELETE (~:235) 403 assertions byte-identical to before.

**Surprise: the POST wire status is 400, not 403** — the global `ValidationPipe` + DTO `@IsIn(['custom'])` rejects `type:'template'` before the service runs. The service-level 403 `POLICY_TEMPLATE_READONLY` is defense-in-depth and is what the kept controller spec pins (service mocked to reject). So "POST type=template → 403" is true at the service layer; at HTTP level the client sees 400 with the class-validator message. No test/behavior changed — this was already true at HEAD.

**Evidence harness pattern for HTTP-level proofs**: `capture-task8-patch.mjs` boots a real Nest `TestingModule` (controller + REAL service) with an in-memory PrismaService stub, installs `APP_GUARD: PermissionGuard` (its `user.findUnique` stub returns `permissions.all === true`), adds a tiny middleware setting `req.user = {id:'u_spec'}`, and applies the same `ValidationPipe` config as `main.ts`. Then supertest drives PATCH → 200, GET → persisted, POST template → DTO 400 + `service.create` → 403, DELETE → 403 + row survives, invalid PATCH → 400 + persisted config untouched. `allPass:true` in `task-8-patch.txt`.

**Parallel-todo mask**: during the run, `npx tsc --noEmit` and full `jest` in the live worktree were red — all errors confined to `server/src/chat/worker-dispatcher.ts`(+spec) (Todo 11's in-flight type rename `renderBoundarySection(agentName)` → `(correction)`) and `server/src/prisma/seed.spec.ts` (Todo 12's pending rewrite). Proven by copying ONLY the 3 in-scope files onto a pristine `git worktree add HEAD` checkout: isolated `npx tsc` exit 0 and **129 suites / 3005 tests all green**. Method: temp worktree + `node_modules` symlink + `.omo/evidence` copy (the db-builtin spec reads the baseline JSON via a repo-root-relative path).


## Todo 11 — boundary section sourced from resolved policy (task-11-boundary)

**Change** (3 files):
- `server/src/chat/worker-dispatcher.ts`:
  - New exported `BoundaryCorrection` interface + local `normalizeHandoff()` (pure). `renderBoundarySection(correction: BoundaryCorrection | null | undefined): string` — NO name-list gate, returns `''` when `scopeSummary` is absent/non-string/empty; otherwise the exact pre-change format. Dropped the `ROLE_BOUNDARIES` import from this file (the constant read now lives in the service helper).
  - `AgentIdentityInfo` gained `policyId?: string | null`; the dispatch `prisma.agent.findUnique` `select` now includes `policyId: true`; `agentIdentity` carries it.
  - New private `resolveBoundaryCorrection(agent)`: calls `executionPolicyService.resolveByAgent({policyId, role, agentKey})` (injected `@Optional()` like the Triggers dependency). `resolved != null` → `canonicalizeCorrection(resolved.correction, constantName ?? resolved.agentName)`; no service / throw / `resolved == null` → `resolveConstantPolicySource(constantName)?.config.correction` fallback; neither → `null`. Dispatch site is now `renderBoundarySection(await this.resolveBoundaryCorrection(agentIdentity))`.
- `server/src/chat/chat.module.ts`: added `ExecutionPoliciesModule` to imports.
- `server/src/chat/worker-dispatcher.spec.ts`: `createDispatcher(policyService?)` now passes a 12th ctor arg; rewrote the 3 name-arg tests; added custom-agent-correction, cleared-correction, empty-correction, and 2 byte-identity tests.

**Key decisions / gotchas**
1. **Canonicalize the DB correction before rendering.** This was the non-obvious bit: `handoff` order is load-bearing (rendered as `scope→target、…`), and MySQL native JSON reorders object keys (key-length then bytewise). The service's `canonicalizeCorrection` reorders `handoff` by the role's `handoffTo` declared order — the constant-fallback path is already canonical (built by the service). Without it, a DB-sourced correction would emit a different handoff order than the pre-change constant read and break byte identity. BOTH paths therefore return canonical order, which the reordered-JSON evidence check proves.
2. **`resolveByAgent` return-null semantics**: I treat `resolved === null` as "fall back to constant". For a known role the service already falls back internally (Todo 5), so this path is mostly for a missing/odd assembly. For a custom agent with a real policy row it returns the row's correction → non-empty section (the whole point).
3. **DB correction wins even when `scopeSummary` is empty**: an explicit user clear (empty string) must render `''`, NOT resurrect the constant. So the branch is `resolved != null → use its correction`, not `… && scopeSummary non-empty`. `renderBoundarySection` then returns `''` for the empty scope. Pinned by the "策略 correction 清空 scopeSummary" test.
4. **No cycle**: verified with a static module-import-graph walk (regex over `*.module.ts`, resolve transitive `…Module` imports): `ExecutionPoliciesModule -> ChatModule` **false**, `ChatModule -> ExecutionPoliciesModule` **true**, so no cycle. `@Optional()` injection makes the dispatcher constructible in every existing spec (all 6 other spec files that `new WorkerDispatcher(...)` still compile unchanged because the param is optional and last).
5. **BEFORE fixture captured at HEAD**: `before-boundary.json` (7 pre-change strings) generated by a throwaway ts-node script BEFORE editing. The post-change evidence (`capture-boundary.mjs` → `task-11-boundary.json`) diffs: (a) constant correction, (b) MySQL-key-reordered `before-agent-policies.json` guard correction through `canonicalizeCorrection`, (c) custom-agent correction via the REAL `resolveBoundaryCorrection`, (d) missing-service known-role fallback, (e) empty → `''`. `allPass:true`.
6. **In-worktree mask**: full `npx jest --runInBand` = **128/129 suites, 2987 passed / 22 failed** — ALL 22 in `src/prisma/seed.spec.ts`, owned by parallel Todos 9/10 (their `seed.ts` edit makes `update.type` undefined). Proven isolated: `git stash push -- prisma/seed.ts` → `seed.spec.ts` 44/44 green, then pop. My scope (`src/chat` 463/463; `src/execution-policies src/agents src/platform-mcp` 613/613; `npx tsc --noEmit` exit 0) is fully green.

## Todo 12 — seed spec rewrite: preservation instead of overwrite (task-12-seed-spec)

**Change** (`server/src/prisma/seed.spec.ts` only; no other file touched):

- **5 overwrite assertions inverted** to the new create-if-absent contract:
  - policy test: `expect(update.type).toBe('template')` + `expect(update.config).toEqual(create.config)` → `expect(update).toEqual({})`.
  - tools test: `expect(call[0].update.config).toEqual(call[0].create.config)` → `expect(call[0].update).toEqual({})`.
  - agentKey test: `expect(call[0].update.agentKey).toBe(...)` → `expect(call[0].update).toEqual({})`.
  - policyId test: `expect(call[0].update.policyId).toBe(...)` → `expect(call[0].update).toEqual({})`.
  - central test (was `['agentKey','policyId','prompt']` key set + `update.prompt` length): now **empty-update contract** — `Object.keys(call[0].update)` is `[]` for all 7 agent upserts **and** all 7 policy upserts, while `create.prompt` keeps the factory value (length > 50). Test name rewritten to state the contract.
- **17 prompt probes repointed** `call[0].update.prompt` → `call[0].create.prompt` (7 in `种子 Agent` suite, 2 in skills suite, 8 via the shared `promptsById()` helper — one edit fixed all 8). Content assertions (four-direction sections, tool hygiene, plan-review clauses, todo9 iron laws) are byte-identical, only the read site moved. The factory prompt still lands on **create**, so the coverage is not weakened.
- **Untouched & still green**: 7-template count, create-shape assertions (`create.type`, `defaultModelId:null`, ack removal), ordering assertion (policies upsert before agents), and every skill/memory/team assertion.

**Why `Object.keys(update)).toEqual([])` rather than `toEqual({})` for the central test**: jest `toEqual` ignores `undefined`-valued keys, so `{prompt: undefined}` would pass `toEqual({})`. The key-set form (faithful inverse of the deleted `Object.keys(...).sort()).toEqual([...])` assertion) catches that case. The other 4 inverted sites keep `toEqual({})` matching the existing repo style (e.g. `teamUserMember` at :451).

**Mutation check**: `update: { prompt: agent.prompt }` on the agent upsert → **3 preservation tests fail** (agentKey test, policyId test, central empty-update test), `Tests: 3 failed, 41 passed`. Restored → 44/44 green. Recorded in `.omo/evidence/.../task-12-seed-spec.txt`.

**Gotcha — do NOT use a global `sed` for the mutation**: `sed 's/update: {},/update: { prompt: agent.prompt },/'` rewrites **5** unrelated upserts (model/skill/etc.) in seed.ts. Mutate with a single targeted `Edit` on the agent upsert only; verify `git diff -- seed.ts` is empty afterwards and `grep 'update: { prompt'` returns nothing.

**Results**: `src/prisma/seed.spec.ts` 44/44 green (was 22 failed/22 passed); full server suite **129 suites / 3009 tests / 1 snapshot all green**; `npx tsc -p tsconfig.json --noEmit` exit 0.

## Todo 13 — unlock the template prompt editor (task-13-web-prompt)

**Change** (2 files, prompt-editor region only — Todo 14's matrix section untouched):
- `web/app/(main)/agents/page.tsx:1327` — `readOnly={isTemplate}` → `readOnly={readOnly}` (the prop the page passes as `false` at the ConfigPanel call site).
- `:1339` — textarea background `isTemplate ? neutral[50] : surface` → `readOnly ? …` (the gray fill was the second read-only affordance).
- Deleted the `{isTemplate && <span data-testid="agent-readonly-badge">只读</span>}` block at the panel header (~16 lines); the `模板` type badge stays (type identity vs. lock claim).
- Corrected three lying comments (`ConfigPanelProps.readOnly` "是否只读（type=template）", `TYPE_LABEL` "模板只读", save-mutation "template → 403 PERMISSION_AGENT_READONLY，UI 已只读避免触发") and dropped `agent-readonly-badge` from `web/e2e/reference/testids.ts` (inventory list; the id no longer exists in the app so keeping it would assert a ghost).

**Live Playwright QA was RUN** — local `next dev --port 3001` with `API_PROXY_TARGET=http://localhost:13000` against the compose server (already post-Todo-8, so PATCH template is 200). Proofs: `prompt-editor` `getAttribute('readonly') === null`, `isEditable() === true`, badge count 0, typed +68 chars → save PATCH 200 → reload → probe present (1798 chars), in-page API GET confirms, zero console ERROR/WARNING across the session. Screenshot `.omo/evidence/vteam-role-behavior-abstraction/task-13-web-prompt.png`, assertions + console census in the sibling `.json`.

**Lesson: mutating a live template prompt for proof means mutating shared env.** I PATCHed `a_product` for the probe. Restore method that works: reconstruct the exact seed literal with `node` `eval()` of the concatenated string block in `server/prisma/seed.ts` (my first `python` `unicode_escape` attempt double-decoded UTF-8 → mojibake, len 3792 vs 1732). Then PATCH back and compare **sha256** against a golden captured BEFORE any write — `d29275d5715f…50f1`, len 1732, byte-identical. Always take the golden first; never trust "looks the same".

**Panel-state note:** the header now shows two truthful chips for a template agent — role-colored `模板` and nothing else; the permissions footer still legitimately says `执行策略 · 只读` (layer-① native rows are read-only until Todo 14), so don't mistake that for the old lock badge.

**e2e pre-existing failures (not mine):** full `--project=pages` on the dev server = 15 passed / 2 failed (`zero-task 零任务直聊`, `skills-tools-manage /skills`). Both fail identically against the compose container `:13001` (pre-change image) via a temp baseURL config → shared-env data drift, neither touches `/agents`. The targeted `-g "agent-config"` run is 2/2 green. `npx tsc --noEmit` exit 0; `npx eslint` on both changed files exit 0 (one pre-existing `deleting` unused warning in ConfigPanel).

## Todo 14 — make the built-in tool matrix editable in the UI (task-14-web-matrix)

**Change** (1 file, `web/app/(main)/agents/page.tsx`, matrix section + stale copy only):
- `EffectivePermissionSection`: the gate was `agentType === "custom" || agentType === "clone"` (a `type`-based short-circuit). Replaced with `editable = effective !== null` — the true precondition for the existing mutation, since `policyMutation` PATCHes `/execution-policies/${effective.policyId}`. The `agentType` prop is gone from both the interface and the call site (`agentType={agent.type}` deleted at the ConfigPanel render).
- Layer-① native rows (`edit`/`read`/`bash`/`task`) and server-gated rows are rendered by **separate branches**; they never had a `ToolEffectSelect`, so nothing needed to change there. `handleToolChange` still early-returns on `isServerGated`.
- Footer copy `执行策略 · 只读|可编辑` (also type-gated) → `agent.effectivePermission ? "执行策略 · 可编辑" : "执行策略 · 未绑定"`. The "可编辑" chip is now truthful for templates; an unbound agent gets "未绑定" (previously it lied with "只读").
- Corrected 4 comments whose claims (权限区只读 / 模板只读 / 权限由服务端拥有前端只读) became false. Kept `ToolEffectSelect`'s `title={readOnly ? "模板只读" : undefined}` **unchanged** — it now only fires for a genuinely unbound/failed case, and on template rows `readOnly` is false.
- 15 insertions / 13 deletions, no restructuring, no payload change, no new endpoint.

**Counterfactual (non-vacuous) proof that the gate flipped**: temporarily copied `git show HEAD:…page.tsx` over the file, reloaded the dev server, and probed — HEAD renders `data-readonly="true"`, `aria-disabled="true"`, `title="模板只读"`, footer `只读`, and Playwright's actionability check **refused the click** ("element is not enabled"), so no PATCH was possible. Restored the task-14 file and verified `sha256 12a7ec28…1701`.

**Live stack gotcha — the compose server was rebuilt mid-session.** The container dist initially still had `this.assertWritable(existing.type)` inside `update()` (pre-Todo-8), but a concurrent actor rebuilt/restarted `aiagents-compose-server` during the run; a no-op `PATCH {}` then returned 200. Always re-probe the live contract (`PATCH {}` on a template policy) instead of trusting a container's `Created` timestamp — the dist mtime was newer than the image metadata suggested.

**Shared-env hazard: another agent was PATCHing the same `ep_product` row concurrently.** During my QA the API flipped `vteam_group_post` allow→deny→allow on its own (server logs showed unrelated `curl` PATCHes with content-length 1375/1380). Handle this by (a) capturing the golden config immediately before QA, (b) re-reading it right before the toggle, (c) asserting the UI matches the API before clicking (my first UI snapshot showed `deny` while the API said `allow` — the page had loaded a stale response), and (d) re-verifying byte-identity *after* the restore. Do not assume the seeded row is stable when other tasks are live.

**Restore receipt pattern**: `golden-config.json` captured pre-write → QA toggle → explicit `PATCH` with the golden JSON → compare `sha256(JSON.stringify(config))` AND the full row minus timestamps (`updatedAt`/`createdAt` will differ; strip them before deep-equal). Final: sha `2ace11785ade…6fab61`, deep-equal true, full-row-equal-except-timestamps true.

**Evidence**: `.omo/evidence/.../task-14-web-matrix.{png,json}` + `task-14-golden-policy-config.json`, `task-14-console.json` (0 ERROR/WARNING), `task-14-network.txt` (65 requests, 0 non-2xx). Targeted `-g "agent-config"` e2e 2/2 green; full `--project=pages` = 15 passed / 2 failed (the same pre-existing shared-env failures Todo 13 documented; neither touches /agents). `tsc --noEmit` exit 0; eslint 0 errors (1 pre-existing `deleting` warning).

**Worker-level restore check (added post-QA)**: after the restore PATCH, the worker's `/data/vteam-worker/.vteam-role-guard/roles.json` re-synced from the DB and all 7 built-in roles' `tools` deep-equal `before-agent-policies.json` (`guard.enabled: true`, 8 roles = 7 builtins + the unrelated custom `myagent`). So the transient QA toggle left no residue at either the DB or the worker layer. Note the guard file lives at `WORK_DIR/.vteam-role-guard/roles.json` (`WORK_DIR=/data/vteam-worker`), useful for future end-to-end checks.

## Todo 15 — DB-driven policy test + end-to-end verification (task-15-db-driven)

**LIVE e2e RUN and PASSED.** Original task text allowed "NOT RUN + substitute"; the live compose stack was reachable, so the real end-to-end proof was executed instead.

**New spec** `server/src/execution-policies/agent-policies-db-driven.spec.ts` (6 tests): seeds bound `ep_<role>` rows with a `config.tools`/`config.permission` that DIFFERS from the constant allowlist (only `vteam-product` edited; rows returned reversed + MySQL JSON key order) and asserts the differing values reach `buildAgentPolicies()` agents[]/guard.roles[] AND `resolveByAgent()`/`resolveManyByAgents()`; plus a strict worker-field-contract shape check and a no-rows control (non-vacuous). The pre-existing specs mock `findMany` to `[]` so they only cover the constant fallback — that is why this new spec is mandatory.

**Mutation check (recorded raw in `task-15-mutations.txt`)**: reverting Todo 3 (`resolveBuiltinPolicy(name, null)` in `buildAgentPolicies`) → 1 test fails; re-adding the Todo 4 built-in short-circuit in `guardForAgent` → 2 tests fail. Both fully reverted; `git diff` on `execution-policy.service.ts` empty.

**Scenario (f) had a stale, impossible assertion** — it asserted EVERY agent `permission.task == "deny"`, but the frozen baseline / real contract is exactly `vteam-plan = allow`, everyone else `deny` (the script was written before plan task=allow became load-bearing). It could never pass against a real stack. Rewrote it role-scoped (exactly-one-allow + no `write`), which is strictly more specific, not weaker. Also the injected `opencode.json` `agent` section is keyed by name with NO `name` field inside the entry — the old check read `a.get("name")` and would have reported `agent None`; read the key instead.

**Scenario (f2) added** (`scripts/e2e-role-boundaries.sh`): baseline sha256 gate → live pre-edit 7 builtins canonical-equal to baseline → PATCH `ep_product` (tools deny/ask/deny, permission.bash deny) → assert control plane reflects → reload worker → assert injected `roles.json` + `opencode.json` carry the edit AND the other 6 builtins are byte-identical to baseline → restore + reload → `after-agent-policies.json` sha256 == baseline. `SCENARIOS=f` runs only the deterministic f/f2 (no serve/model needed); the interactive a/c/d/e/g are gated by `want()`.

**⚠️ Biggest gotcha: `docker compose up -d --force-recreate worker` silently re-runs the `init` dependency, and a pre-Todo-9 init image reseeds `config` unconditionally — the just-PATCHed DB edit was reverted within ~2s, making the proof look like "DB path not wired".** Diagnosed by polling DB+roles.json second-by-second (DB flipped back to factory at t=2s). Fix: reload the worker with `docker restart worker` / `docker compose restart worker` (start-only injector re-fetches `/agent-policies`, no init re-run). Encoded as the script's `reload_worker()` helper. This is the trap any future "edit policy then reload worker" e2e must avoid.

**Live-stack deployment note**: the compose `aiagents-compose-server` image can lag the worktree (its `Created` may be newer than it looks). Probe with a no-op `PATCH {}` on a template policy: 403 = pre-Todo-8 binary, 200 = current. To run the real proof on a stale image without a full rebuild: `npx tsc -p tsconfig.build.json`, then `docker cp server/dist/. aiagents-compose-server:/app/dist/ && docker restart aiagents-compose-server` (same compiled JS as an image rebuild; fully reversible by `docker compose up -d --force-recreate server`). Todo 14's notepad entry documents a concurrent actor rebuilding the server mid-session — always re-probe the live contract (PATCH template) before trusting the container.

**Exact operator command for the live e2e** (repo root; WORKER_WORK_DIR is the in-container path, INJECTED_OPENCODE_JSON a host copy of the worker volume file):

```
docker compose cp worker:/data/vteam-worker/opencode.json /tmp/host-injected-opencode.json
SERVER_URL=http://localhost:13000 \
X_WORKER_TOKEN=compose-worker-token \
WORK_DIR=/data/vteam-worker \
WORKER_WORK_DIR=/data/vteam-worker \
INJECTED_OPENCODE_JSON=/tmp/host-injected-opencode.json \
SCENARIOS=f \
EVIDENCE_DIR=$PWD/.omo/evidence/vteam-role-behavior-abstraction \
RESTART_TIMEOUT_SEC=240 \
bash scripts/e2e-role-boundaries.sh        # exit 0
```

**Gates**: `cd server && npx tsc -p tsconfig.json --noEmit` exit 0; `npx jest --runInBand` = **130 suites / 3015 tests / 1 snapshot ALL GREEN** (was 129/3009; +1 suite / +6 tests). `worker npx jest` = 25 passed / 1 failed — the 2 failures are in `driver/v1-driver.spec.ts`, a file untouched by this plan (`git status worker/` and `git diff f0b1924 HEAD -- worker/` both EMPTY); the spec expects `provider.key === ''` filtering that `v1-driver.ts` never implemented → pre-existing, out of scope.

**Evidence**: `task-15-db-driven.txt` (full narrative), `task-15-mutations.txt`, `after-agent-policies.json` (sha == baseline), `f2-live-run.log` (live stdout), `f2-{pre-builtins,original-policy,edit-…,patch,postedit-…,injected-roles,injected-opencode,injected-summary,after-summary}.{json,txt}`. Baseline `before-agent-policies.json` untouched (sha `793093…bc3a`).

## F2 REJECT fixes — 2 blockers + 4 findings (fix commit)

**BLOCKER-1 (untracked evidence fixtures → non-reproducible suite).** The three specs
(`agent-policies-db-builtin`, `agent-policies-db-driven`, `worker-dispatcher.spec.ts`) read
`.omo/evidence/vteam-role-behavior-abstraction/{before-agent-policies.json,before-boundary.json}`,
but `git ls-files` for that dir was EMPTY — a fresh clone failed 2 suites. Fix = BOTH:
(1) `git add` the whole evidence dir (84 files; `.gitignore` only excludes `*.png` / `*.sql`, so
JSON/MJS/TXT are all commit-eligible); (2) a single `loadEvidenceJson` helper in
`__fixtures__/policy-fixtures.ts` that throws a **clear** message naming the path + the `git add`
remedy when the fixture is absent (skip-with-reason is NOT acceptable — that turns the byte-proof
into a no-op). Clean-checkout simulation: `git worktree add f0b1924` + symlinked `node_modules` —
the fixture-reading specs are green there once the fix commit is the tree under test.

**BLOCKER-2 (DB-sourced custom `permission.write` reached the wire).** `canonicalizePermission`
already deletes `write`, but the custom branches passed `config.permission` through raw:
`resolveByAgent` (service ~653) and `buildAgentPolicies` (~771, both `agents[]` and
`guard.roles[]`). Worker `assertAgentShape` throws on `write` → injector neutralizes the WHOLE
guard → one bad PATCH disarms every role. Fix: call `canonicalizePermission(config.permission,
agentName|name)` on all three emission sites, and harden the write-path validator
`assertValidConfig` to **strip-with-normalization** (`delete cfg.permission.write`) so the bad key
never lands in the DB at all. Strip (not reject) was chosen deliberately: it matches the built-in
emission behavior (delete-then-canonicalize) and keeps a single normalization philosophy — reject
would make built-ins and customs behave differently for the same input. Built-in factory output is
byte-identical (baseline sha unchanged).

**Key gotcha — `canonicalizePermission` is not just "delete write".** It also reorders top-level
keys to `edit,read,bash,task,...VTEAM_MCP_TOOL_NAMES` and canonicalizes nested `edit`/`read`. For a
custom agent, `boundaryOf(name)` is `undefined`, so `canonicalizeEditMap` falls back to `['*']` +
lexicographic — safe, and only `write` was at issue. So wiring it in did not alter any other
custom field's value; the existing `agent-policies.custom-agents.spec.ts` byte/field assertions
stayed green with no edits.

**FINDING-3.** `policyService as any` at `worker-dispatcher.spec.ts:157` → local `PolicyResolverStub`
type + `as unknown as ExecutionPolicyService` (scoped cast to the real ctor param type). No new
`as any` / `@ts-ignore` / non-null anywhere in the diff.

**FINDING-4.** `npx eslint --fix` on all 8 changed files → 0 errors (5 `no-unused-vars` warnings on
`worker-dispatcher.spec.ts` are PRE-EXISTING: proven by running the base file in a `git worktree`;
base also had 4 prettier errors that HEAD already fixed). One new warning I introduced
(`VteamAgentName` unused in `policy-canonical.spec.ts` after the fixture extraction) removed.

**FINDING-5.** Controller PATCH-template test mocked `service.update`, so it proved nothing. New
`execution-policy.service.spec.ts` (real `ExecutionPolicyService` + in-memory prisma store):
template PATCH config/name succeed + persist; `update` missing id → 404; `create(type=template)` →
403 + no write; `remove(template)` → 403 + row survives; `remove(custom)` succeeds;
`assertValidConfig` rejects non-object permission; `permission.write` on PATCH is stripped before
store. New tests (9 total).

**FINDING-6.** `reorderLikeMysql` / `factorySeedConfig` / `constantDerived` / `factoryRows` /
`policyRow` were copy-pasted across 3 specs. Extracted to
`server/src/execution-policies/__fixtures__/policy-fixtures.ts` (pure, no jest dep) and imported by
`policy-canonical.spec.ts`, `agent-policies-db-builtin.spec.ts`, `agent-policies-db-driven.spec.ts`
— plus `loadAgentPoliciesBaseline()` / `loadBoundaryBaseline()` consumed by the 3rd spec and
`worker-dispatcher.spec.ts`.

**BLOCKER-2 tests added** (`agent-policies.custom-agents.spec.ts`, new describe
"BLOCKER-2：DB 自定义策略 permission.write 防御式剥离"): poisoned custom policy config with
`permission.write` — `buildAgentPolicies()` agents[]/guard.roles[] carry no `write`; `resolveByAgent`
permission has no `write`. Non-vacuous: the raw value WOULD have contained it pre-fix (the
`JSON.stringify(...).not.toContain('"write"')` would fail).

**Gates**: `tsc -p tsconfig.json --noEmit` exit 0; `jest --runInBand` **131 suites / 3026 tests /
1 snapshot ALL GREEN** (was 130/3015; +1 suite `execution-policy.service.spec.ts` / +11 tests);
4 evidence harnesses re-run (`capture-db-read` / `capture-guard` / `capture-fallback` /
`capture-canonical`) all `allPass: true`; baseline sha `793093dc5106a76a929f2e043dd5a53af35a2b902e2d929268f1665782abbc3a` unchanged; `worker/` diff vs base EMPTY.
