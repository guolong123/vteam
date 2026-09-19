# agent-native-permission-editor - Work Plan

## TL;DR (For humans)

**What you'll get:** Agents stop being locked to "read only". When you create an agent you can pick a role, so it starts with that role's real abilities instead of a blank that can do nothing. And on the agent's page the four basic permissions — write files, read files, run commands, spawn sub-agents — become editable, with a proper rule editor for the file-path rules. Saving a permission change tells you it needs a worker restart and gives you a button to do it.

**Why this approach:** Two separate defects cause the same complaint. First, a newly created agent gets a deliberately locked-down default and there is no way to change it from the page. Second, the four basic permission rows are drawn as read-only labels. We fix both: the create form can hand the agent a real role's permissions, and the four rows get real controls. The backend already accepts both changes, so this is mostly wiring plus a small amount of server-side safety validation.

**What it will NOT do:** It will not rename or remove any existing data, will not touch the execution engine's decision logic, and will not build the separate "roles you can manage" feature (that is the next plan).

**Effort:** Medium
**Risk:** Medium - one safety-sensitive detail: a write-rule list with no catch-all entry currently behaves as "allow everything", and one saving path can silently drop a field.

**Decisions to sanity-check:** (1) the catch-all write rule is forced back in as "deny" when missing, which tightens any existing agent that had an open write rule; (2) "spawn sub-agents" stays read-only with an explanatory note because the engine only honours it for the built-in planner; (3) saving says "restart the worker", it does not restart it for you.

Your next move: run `$start-work agent-native-permission-editor` to execute, or ask for a high-accuracy review first. Full execution detail follows below.

---

> TL;DR (machine): Medium / Medium - add a role picker to the agent create form (backend inheritance already exists) and make the four native permission rows editable (edit/read as glob rule lists, bash tri-state, task read-only), with server-side catch-all/glob/bash validation, a single serialized policy mutation, and a restart-worker affordance.

## Scope

### Must have
- Creating an agent lets the user choose a role; choosing one gives the agent that role's existing permission set (writable paths, bash, tools) instead of the do-nothing skeleton.
- The four native permission rows on the agent page are editable: `edit` and `read` as path-glob **rule lists** (glob + allow/deny + add/remove), `bash` as allow/ask/deny, `task` read-only with an explicit engine-limit note.
- Native permission edits are validated server-side so they cannot produce a silently-permissive or worker-breaking policy: no `write` key, the `edit` catch-all is enforced, `edit`/`read` must be glob maps with bounded shape, `bash` must be one of allow/ask/deny.
- Only one policy write can be in flight at a time, so a permission edit and a tool toggle cannot clobber each other.
- Saving a policy change surfaces that a worker restart is required, with a one-click restart.
- Runtime enforcement is proven on the real surface: an edited rule actually reaches the worker's injected artifacts.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No change to `worker/**` — the guard's branch order and the `/agent-policies` wire contract stay unchanged.
- No change to the 7 built-ins' factory bytes: `before-agent-policies.json` sha256 stays `3b8c5d4bf29003c48079b11623cf840f9741e3044f6b40e3bfe035c011ceaf87` (re-baselined by the previous plan `server-gate-removal-tool-authority`; re-verified 2026-09-19 before execution — see the `plan-staleness-audit` ledger entry).
- No new `AgentRole` entity, no `TeamMember` change, no `Agent.role` removal (those are plans 2 and 4).
- No third-party (OmO) agent integration (plan 3).
- No revival of `permissionScope` / `agent_tool_effects` (dropped by migration `20260913000000`).
- No collapsing `edit`/`read` glob maps into a tri-state control.
- No per-TeamMember permission override.
- No A/B dual path, legacy shim, or "deprecated"/"retired" annotations.
- No new version/CAS column on `execution_policies`.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after** + jest (`server`, `worker`) + Playwright for the web surface + a live worker restart round-trip for enforcement.
- Enforcement proof: edit a native rule through the page/API → restart the worker → read back `<workDir>/opencode.json` and `.vteam-role-guard/roles.json` → assert the edit is present and the other built-ins are unchanged → restore and prove the restore.
- Byte-identity guard: re-run the existing capture harness so the 7 built-ins' factory output still matches the frozen baseline.
- Evidence: `.omo/evidence/agent-native-permission-editor/task-<N>-agent-native-permission-editor.<ext>`

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- **Wave 1 — server safety (serial-ish):** validation + bashDeny round-trip + the inheritance test; they touch the same service file.
- **Wave 2 — web editor:** the glob rule-list component wired into the native rows (one todo — no component-test runner exists).
- **Wave 3 — web plumbing:** the serialized mutation, the restart affordance, the create-form role picker.
- **Wave 4 — proof:** DB-driven enforcement test + live round-trip.
- **Final verification wave:** F1-F4 in parallel.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2,3,7,8 | — |
| 2 | 1 | 3,8 | — |
| 3 | 1,2 | 4,8 | — |
| 4 | 3 | 8 | 5,6 |
| 5 | — | 8 | 4,6 |
| 6 | — | 8 | 4,5 |
| 7 | 1 | 8 | — |
| 8 | 1,2,3,4,5,6,7 | F1-F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

- [x] 1. [server] Enforce the `edit` catch-all and validate native-permission shape (per-key semantics)
  What to do / Must NOT do: In `server/src/execution-policies/execution-policy.service.ts` extend `assertValidConfig` (currently ~:801-819, which only checks `permission`/`correction`/`tools` are plain objects and strips `permission.write`) so a native permission edit cannot be stored in a silently-permissive or malformed state. Required, per-key:
  - `permission.edit`, when present, must be a plain object. **Inject the catch-all in BOTH fail-open cases (review fix M1):** (i) `edit` is present but lacks the literal `'*'` key; (ii) `edit` is **absent from `permission` entirely**. In both cases set `edit: { '*': 'deny' }` (preserving any existing allow globs in case (i)) — write path only. Rationale, both verified in `worker/src/role-guard/policy.ts`: `isEditDenied` (`:383-402`) fails **open** when `editMap['*']` is absent, and the caller (`:159-165`) returns `{action:'allow'}` outright when `permission.edit` is not a plain object. A raw PATCH of `{ permission: { bash: 'deny' }, correction: {...} }` would otherwise still store a fail-open policy.
  - `permission.read`, when present, must be a plain object; **never inject anything** — the read default is `{'*':'allow'}` and an injected `deny` would break all reads (`policy.ts:150-152` `READ_TOOLS → allow`; layer ① `permission.read` is the effective read gate).
  - **Every `edit`/`read` value must be one of `'allow' | 'ask' | 'deny'`** (review fix B1). Do NOT reject `ask`: the guard's `isEditDenied` treats `ask` as allow (`policy.ts:394`: `effect === 'allow' || effect === 'ask'`), layer ① opencode natively supports `ask`, and pre-existing rows may already contain it (nothing validates today). Rejecting it would make such a row **uneditable** (the whole-config PATCH would 400) and contradict todo 3's `ask`-preservation requirement. Values outside the three-state set are rejected with `POLICY_CONFIG_INVALID`.
  - Every `edit`/`read` key must be a non-empty string, ≤256 chars; reject empty-string globs (they can never match); cap the rule count at 64 per map.
  - `permission.bash`, when present, must be exactly `'allow' | 'ask' | 'deny'`.
  Must NOT change `canonicalizePermission`/`canonicalizeEditMap` (the emit path `:185-210`) — injecting there would change `GET /agent-policies` output and risk the frozen baseline. Must NOT reject `permission.write`; keep stripping it (current behaviour). Must NOT touch any factory value.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2,3,7,8
  References: `server/src/execution-policies/execution-policy.service.ts:801-819` (`assertValidConfig`), `:185-210` (`canonicalizeEditMap`/`canonicalizePermission` — order only, do not add injection), `:513-535` (`update`), `:239-247` (`resolveTaskEffect`), `worker/src/role-guard/policy.ts:383-402` (`isEditDenied` fail-open proof), `:150-152` (`READ_TOOLS` always allow), `:169-188` (`bash` uses `bashDeny` only), `server/src/main.ts:56-59` (global `ValidationPipe({ whitelist: true })`)
  Acceptance criteria (agent-executable): `cd server && npx tsc -p tsconfig.json --noEmit` exits 0; a unit test asserts that PATCHing a policy with `permission.edit = { '**tasks/*/docs/**': 'allow' }` (no `'*'`) stores `{ '*': 'deny', '**tasks/*/docs/**': 'allow' }`; a test asserts `permission.read = { '*': 'allow' }` is stored unchanged (no injection); tests reject `edit: { '': 'allow' }`, `edit: { 'x': 'maybe' }`, `bash: 'sometimes'`, and a 65-key map.
  QA scenarios (name the exact tool + invocation): happy — `npx jest --runInBand src/execution-policies`; failure — PATCH via the existing Nest TestingModule harness with each malformed shape and assert 400 `POLICY_CONFIG_INVALID` plus that the stored config is untouched. Evidence `.omo/evidence/agent-native-permission-editor/task-1-validation.json`
  Commit: Y | `feat(policies): enforce edit catch-all and validate native permission shape`

- [ ] 2. [server] Round-trip `bashDeny` in the policy config DTO (chosen: option a)
  What to do / Must NOT do: `PolicyConfigDto` (`server/src/execution-policies/dto/policy-config.dto.ts`) declares only `permission`/`correction`/`tools`; with the global `whitelist: true` pipe (`server/src/main.ts:56-59`) any `config.bashDeny` is silently stripped, while `resolveBashDeny` (`execution-policy.service.ts:275-279`) and `guardForAgent` do read `config.bashDeny`. Because the new editor PATCHes the WHOLE config, an in-scope policy carrying `bashDeny` would lose it on save. **DECISION (review fix m7 — chose (a)):** add an optional `bashDeny?: string[]` to `PolicyConfigDto` and round-trip it (`@IsOptional() @IsArray() @IsString({ each: true })`). Do NOT take option (b): silently dropping a field the guard reads is a latent data-loss path, and the editor now owns whole-config writes. Must NOT change the guard's `bashDeny` semantics (`ROLE_BASH_DENY_PATTERNS` stays `[]`).
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3,8
  References: `server/src/execution-policies/dto/policy-config.dto.ts:16-57`, `server/src/main.ts:56-59`, `server/src/execution-policies/execution-policy.service.ts:275-279` (`resolveBashDeny`), `:868-870` (`guardForAgent` reads it), `server/src/common/constants/agent.constants.ts:269` (`ROLE_BASH_DENY_PATTERNS = []`)
  Acceptance criteria (agent-executable): `npx tsc --noEmit` exits 0; a test PATCHes a config containing `bashDeny: ['rm -rf /']`, re-reads it, and asserts the array survived; a test asserts a non-string element is rejected (400).
  QA scenarios: happy — round-trip test green via `npx jest --runInBand src/execution-policies`; failure — removing the field from the DTO makes the round-trip test fail (proves the assertion is real). Evidence `.omo/evidence/agent-native-permission-editor/task-2-bashdeny.json`
  Commit: Y | `feat(policies): round-trip bashDeny in the policy config DTO`

- [ ] 3. [web] Build the glob rule-list editor AND wire the four native rows (one todo — see the tooling note)
  **Tooling note (review fix B3):** `web/package.json` has ONLY `test:e2e` (Playwright, `@playwright/test`) — there is **no** jest/vitest/testing-library and no component-test config. An unwired component has no route for Playwright to mount, so a standalone "component + component tests, not wired yet" todo cannot produce executable evidence in this repo. Therefore the component and its wiring are ONE todo, verified through the real agents page with Playwright. Do NOT add a component-test runner (out of scope); do NOT split this back into two.
  What to do / Must NOT do:
  (a) **Component.** Build a reusable editor for a `Record<glob, 'allow'|'ask'|'deny'>` map: one row per rule (glob text input + effect control + remove button); an "add rule" button; the `'*'` catch-all row always visible and rendered first (it may be switched away from `deny`, but doing so shows an explicit warning that this opens all writes); **round-trip safety** — a stored value must be displayed and re-emitted as-is, never coerced (do NOT reuse `normalizeToolEffect`, which maps unknown→deny); client-side checks mirror the server (non-empty glob, ≤256 chars, ≤64 rules, no duplicate glob).
  (b) **Wire the four native rows.** In `EffectivePermissionSection` (`web/app/(main)/agents/page.tsx`, the `nativeRows.map` block ~:955-998) replace the read-only `EffectBadge` rendering: `edit`/`read` render the new editor; `bash` renders `ToolEffectSelect` (generalise its props so `toolName` is optional, or add a sibling); `task` stays read-only with a note that the engine honours it only for the built-in planner. The rows must render even when a key is ABSENT (today `nativeRows` filters by `key in permission` ~:923, so a missing `bash`/`task` is invisible and cannot be added) — render all four, seeding a sane default for an absent key. Keep the `editable` gate (~:625-627, `effective !== null`); state what the editor does on the `effective === null` early-return path (~:895-920).
  Must NOT change the MCP tool rows' behaviour. Must NOT change the save payload shape here (todo 4 owns the mutation). Must NOT put permission/tool editors anywhere but the agent page.
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 4,8
  References: `web/app/(main)/agents/page.tsx:955-998` (the block to replace), `:923` (`nativeRows` presence filter), `:336-385` (`ToolEffectSelect`), `:248-288` (`EffectBadge`), `:193-205` (`toolEffectMeta`/`ToolEffect`), `:598-604` (`NATIVE_PERMISSION_KEYS`), `:625-627` (`editable`), `:895-920` (the null path), `web/package.json` (the tooling constraint), `server/src/execution-policies/dto/policy-config.dto.ts:21-27` (the documented map shape), `server/src/common/constants/agent.constants.ts:248-260` (`buildEditPermission`/`buildReadPermission`), `worker/src/role-guard/policy.ts:189-199` (the `vteam-plan`-only task exception justifying the note)
  Acceptance criteria (agent-executable): `cd web && npx tsc --noEmit` exits 0; `npx playwright test` asserts, on the real agents page: all four rows render for an agent whose `permission` lacks `task`; `edit`/`read` expose the rule editor and a two-rule map round-trips unchanged; a stored `ask` value renders and re-emits as `ask` (not coerced); the catch-all row is present and first; switching `'*'` to `allow` surfaces the warning; a duplicate glob is rejected client-side; `bash` exposes the tri-state control; `task` is read-only with the note; a `type=template` agent's rows are editable.
  QA scenarios (name the exact tool + invocation): happy — Playwright opens an agent with the skeleton config, adds an `edit` rule, toggles `bash`, reloads, and both persist; failure — an agent whose `permission` has no `task` key still renders the `task` row (read-only + note), and a map containing `{ '*':'deny', 'x':'ask' }` saves with `ask` still `ask`. Evidence `.omo/evidence/agent-native-permission-editor/task-3-native-editor.png` + `.json`
  Commit: Y | `feat(web): editable glob rule-list for the native permission rows`

- [ ] 4. [web] Serialize all policy writes through one mutation with a fresh payload
  What to do / Must NOT do: Add a native-permission mutation (or generalise the existing `policyMutation`, ~:691-710) so a native edit PATCHes `/execution-policies/:policyId` with `{ config: { permission: nextPermission, correction, tools } }`. Critical: the existing mutation builds its payload from a stale closure and `pendingKey` (~:713) serializes only tool toggles, so a native edit and a tool toggle can clobber each other; `execution_policies` has **no version column** (`schema.prisma:624-634`) so there is no server-side CAS. Therefore: (a) route BOTH native edits and tool toggles through ONE mutation with ONE in-flight gate that disables every control while a write is pending; (b) build the payload from the freshest refetched `effective` (not a stale closure); (c) preserve `correction` and `tools` on a native edit and `permission` on a tool toggle. **State explicitly (review fix m4):** the client-side gate fixes single-page interleaving only; a **multi-client** race (two browsers / the raw API) remains possible because there is no server CAS — this residual is ACCEPTED for this plan and recorded, not silently implied solved. Must NOT add a version column (out of scope). Must NOT change the PATCH endpoint or the payload shape.
  Parallelization: Wave 3 | Blocked by: 3 | Blocks: 8
  References: `web/app/(main)/agents/page.tsx:670-720` (`effectOf`/`matrixKeyOf`/`policyMutation`/`handleToolChange`), `server/src/execution-policies/execution-policy.service.ts:513-535` (`update` — whole-config replace), `server/prisma/schema.prisma:624-634` (no version column)
  Acceptance criteria (agent-executable): `npx tsc --noEmit` exits 0; a Playwright scenario performs a `bash` toggle and an `edit` rule edit back-to-back and asserts the final stored config contains BOTH changes (no lost update); a test asserts that while a write is in flight all native and tool controls are disabled.
  QA scenarios: happy — Playwright does two rapid edits and the stored config shows both; failure — the interleaved edits reproduce a lost update and the test fails. Evidence `.omo/evidence/agent-native-permission-editor/task-4-serialized.json`
  Commit: Y | `fix(web): serialize policy writes to prevent lost updates`

- [ ] 5. [web] Surface "restart the worker to apply" with a one-click action
  What to do / Must NOT do: `roles.json`/`opencode.json` are written only by the worker's `injectAll()` at startup / reload-config; a policy PATCH broadcasts nothing, so an edit appears to do nothing until the worker restarts. Add, next to the permission section, a clear notice plus a restart action. **The endpoint EXISTS (review fix M7):** `POST /api/v1/workers/:id/restart` (`server/src/workers/workers.controller.ts:121-125`, permission `workers.edit`). Because a policy is GLOBAL while `injectAll()` runs PER worker, state the propagation rule explicitly: restart EVERY registered worker (recommended — a policy change affects all of them), and if there are zero workers show a clear empty state instead of a dead button. Must NOT silently auto-restart on every save (that would interrupt in-flight sessions). Must NOT claim the change took effect before the restart.
  Parallelization: Wave 3 | Blocked by: — | Blocks: 8
  References: `server/src/workers/workers.controller.ts:121-125` (`POST /workers/:id/restart`), `worker/src/resources/injector.ts` (`injectAll`, managed-agent + roles.json writers), `worker/src/index.ts` (startup / reload-config call sites), `web/app/(main)/agents/page.tsx:691-710` (where the save succeeds today)
  Acceptance criteria (agent-executable): `npx tsc --noEmit` exits 0; Playwright asserts the notice appears after a successful save and that the action calls the restart endpoint for every online worker (assert the request(s)); a test asserts no automatic restart fires on save; with zero workers the notice shows the empty state.
  QA scenarios: happy — Playwright saves a change, sees the notice, clicks restart, and the restart request(s) fire; failure — saving does not auto-restart (assert no restart call). Evidence `.omo/evidence/agent-native-permission-editor/task-5-restart-notice.png`
  Commit: Y | `feat(web): surface worker restart requirement after policy edits`

- [x] 6. [web] Add a role picker to the create-agent form
  What to do / Must NOT do: `CreateAgentModal`'s `onSubmit` payload (~:1714) is `{ name, prompt?, persona?, agentKey }` and the create mutation (~:2400-2408) posts `{ ...payload, type: 'custom' }` — `role` is never sent, so a new agent always falls through to the do-nothing skeleton. Add a role selector populated from the canonical labels in `web/src/theme/tokens.ts:19-26` (`roles`, six entries: product/project_manager/architect/developer/tester/plan). The backend already inherits: `CreateAgentDto.role` is optional (`create-agent.dto.ts:48-53`) and `create()` passes it to `resolveTemplateSource` (`agents.service.ts:187`), which copies the `ep_<role>` policy. Details that must be honoured: include an explicit "none" option (falls to the skeleton, by design); do NOT offer `plan` — `ep_plan` carries `task:'allow'` that the guard shadows for any agent whose opencode name is not the literal `vteam-plan` (`worker/src/role-guard/policy.ts:189-196`), so it would be misleading; use `undefined` (not `''`) for "none" so the nullish path is taken (`agents.service.ts:187` + `:731-733`); update the props interface, the local state/reset effect, `handleSubmit`, and the mutation's payload type together (TypeScript will otherwise reject the extra field).
  **CROSS-PLAN HANDOFF (review fix B2 — was unowned):** this uses the EXISTING `Agent.role` string. Plan 4 deletes that column, so **plan 4 MUST own re-pointing this picker** to `policyId` / `AgentRole.defaultAgentId`. This is recorded here AND added to plan 4's consumer map + a plan-4 todo; after plan 4 lands, the picker must never silently post a removed field (which would drop every new agent back to the skeleton).
  Parallelization: Wave 3 | Blocked by: — | Blocks: 8
  References: `web/app/(main)/agents/page.tsx:1709-1717` (props + `onSubmit` payload), `:1751-1761` (`handleSubmit`), `:2400-2408` (create mutation), `:1920-1938` (the raw `<select>` pattern — no shared Select component exists), `:441` (`ROLE_KEYS` duplicate), `web/src/theme/tokens.ts:8-26` (`RoleKey` + `roles` labels), `server/src/agents/dto/create-agent.dto.ts:48-53` (`role?`), `server/src/agents/agents.service.ts:179-220` (create + the `185-194` inheritance branch), `:727-748` (`resolveTemplateSource`), `.omo/plans/agent-role-decommission.md` (the plan that removes `role` and must re-point this picker)
  Acceptance criteria (agent-executable): `npx tsc --noEmit` exits 0; Playwright creates an agent with role=developer and asserts the resulting agent's permissions are the developer capability set (not the skeleton), and that creating with "none" yields the skeleton; a test asserts `plan` is not offered.
  QA scenarios: happy — Playwright creates with `developer` and the detail page shows writable task paths + non-empty tools; failure — creating with "none" still yields `{ edit: {'*':'deny'}, bash:'deny', tools:{} }`. Evidence `.omo/evidence/agent-native-permission-editor/task-6-role-picker.png`
  Commit: Y | `feat(web): pick a role when creating an agent`

- [ ] 7. [server] Prove the create-path role inheritance is real (not just the branch)
  What to do / Must NOT do: Add a discriminating test that a created-with-role agent's bound policy equals the role's `ep_<role>` config, and that a role-less create yields the deny skeleton. Existing specs cover the skeleton; the inheritance path needs an explicit assertion. Must NOT change `buildSkeletonConfig` (`agents.service.ts:754-773`) — the skeleton stays as the genuinely-role-less default. Must NOT modify the frozen policy specs.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 8
  References: `server/src/agents/agents.service.ts:179-220` (create, branch `185-194`), `:727-748` (`resolveTemplateSource`), `:754-773` (`buildSkeletonConfig`), `server/src/agents/dto/create-agent.dto.ts:48-53`, `server/prisma/seed.ts` (the `ep_<role>` rows), `server/src/agents/agents.service.spec.ts` (existing skeleton assertions to extend)
  Acceptance criteria (agent-executable): `npx jest --runInBand src/agents src/prisma` passes; a new test asserts create-with-`role:'developer'` binds a policy whose `permission`/`tools` equal `ep_developer`'s, and create-without-role binds the skeleton.
  QA scenarios: happy — the new test passes; failure — reverting the `dto.role` pass-through (`:187`) makes it fail (mutation check, recorded). Evidence `.omo/evidence/agent-native-permission-editor/task-7-inheritance.json`
  Commit: Y | `test(agents): assert role inheritance on create`

- [ ] 8. [proof] End-to-end enforcement + byte-identity
  What to do / Must NOT do: Add the test that fails under the old behaviour and extend the live e2e: (a) a DB-driven test that a differing native `edit` rule reaches `buildAgentPolicies()` and `resolveByAgent()`; (b) a live round-trip — PATCH a built-in's `edit` rule through the API, restart the worker (via `POST /api/v1/workers/:id/restart`), and assert the injected `opencode.json` + `.vteam-role-guard/roles.json` carry it while the other 6 built-ins are byte-identical to the frozen baseline; (c) re-run the existing capture harness and confirm `before-agent-policies.json`'s sha is unchanged; (d) assert a `permission.write` is still stripped and never emitted (`opencode-config-builder.ts:111-115` throws on it, which would neutralize the whole guard); (e) assert that a policy PATCHed with `permission.edit` ABSENT ends up stored with `edit: {'*':'deny'}` (the M1 case). Restore everything and prove the restore. Must NOT weaken existing tests. Must NOT modify `before-agent-policies.json`.
  Parallelization: Wave 4 | Blocked by: 1,2,3,4,5,6,7 | Blocks: F1-F4
  References: `server/src/execution-policies/agent-policies.matrix.spec.ts:119-164` (mocks prisma to `[]` — why a DB-driven test is mandatory), `scripts/e2e-role-boundaries.sh` (scenario f/f2 harness + the frozen sha gate), `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json` (sha `3b8c5d4bf29003c48079b11623cf840f9741e3044f6b40e3bfe035c011ceaf87` — re-baselined by the previous plan; the plan's original `793093dc…` is stale), `worker/src/resources/injector.ts` (write + neutralize), `worker/src/resources/opencode-config-builder.ts:111-115` (the `write` rejection), `worker/src/exec/exec-server.ts:1122-1167` (the `startsWith('vteam-')` gate — confirm the new rule still lands for a `vteam-*` agent), `server/src/workers/workers.controller.ts:121-125` (the restart endpoint)
  Acceptance criteria (agent-executable): the new test fails if todo 1's catch-all enforcement is reverted (mutation check recorded); the live script passes with the edited rule present in the injected artifacts and the other 6 built-ins diff-empty against the baseline; the absent-`edit` PATCH is stored with the catch-all; the frozen sha is unchanged.
  QA scenarios: happy — edit `ep_product`'s `edit` rule → restart worker → the rule appears in `roles.json`/`opencode.json` and the other six match the baseline; failure — editing the rule produces no change in the injected artifacts. Evidence `.omo/evidence/agent-native-permission-editor/task-8-enforcement.txt`
  Commit: Y | `test(e2e): prove native permission edits reach the worker`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit ok before declaring complete.
- [ ] F1. Plan compliance audit
- [ ] F2. Code quality review
- [ ] F3. Real manual QA
- [ ] F4. Scope fidelity

## Commit strategy
- One commit per todo; prefix `feat|fix|test|refactor(<scope>): <summary>`.
- Keep `npx jest --runInBand src/execution-policies src/agents` green at every step.
- Evidence artifacts under `.omo/evidence/agent-native-permission-editor/` are committed with the final proof todo.
- Do NOT push until the user says so.

## Success criteria
- `cd server && npx tsc -p tsconfig.json --noEmit`, `cd web && npx tsc --noEmit`, `cd worker && npx tsc --noEmit` all exit 0.
- `cd server && npx jest --runInBand` fully green; `cd web && npx playwright test` green for the touched pages.
- A newly created agent with a chosen role has that role's real permissions; with "none" it still gets the deny skeleton.
- All four native rows are editable (task read-only + note); an absent key still renders.
- PATCHing a malformed native permission returns 400 and does not alter the stored config; a rule map missing the catch-all is stored with `'*':'deny'`; a PATCH with `edit` **absent** is also stored with the catch-all; `read` is never injected; `ask` is accepted (not rejected) for `edit`/`read` values and round-trips unchanged.
- Two rapid writes (rule edit + tool toggle) both survive in one client; the residual multi-client race is documented as accepted (no server CAS).
- The 7 built-ins' factory `/agent-policies` output still matches the frozen sha; `worker/**` is untouched.
