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

## todo 6 — web role identity off `Agent.role` (the DTO seam + 5 map deletions)

- **The DTO `role` field is now a `agentKey` alias, and that is exactly what the web consumes.**
  `toAgentDto`/`toAgentDtoList` emit `role: agent.agentKey` and `AgentRow` no longer carries a
  `role` column. The web's `toAvatarRole(role)` therefore receives the machine key: templates are
  byte-identical (`agent_key === role` for all 7), custom agents move from `null → <agentKey>`
  and still fall back to `developer` because their key is not a theme key. Grep proof for
  `Agent.role` in `web/` is now comments-only.
- **Not every `AGENT_ID_ROLE` had the `a_`-derivation fallback the plan assumed.**
  `teams/[id]/tasks/page.tsx` used `AGENT_ID_ROLE[id] ?? "developer"` — no strip-and-check. Deleting
  only the map would have silently repainted every seeded task-member avatar to the neutral
  `developer` colour. The fix reuses `TeamMembersPanel`'s already-exported `toRole` (cross-page
  import is fine in Next App Router; no new constant, no `tokens.ts` edit) and the proof asserts
  the avatar role set stays `["architect","developer","plan","product"]`.
- **`librarian` is a template role that is NOT in `ROLE_KEYS`.** So the literal S3 expression
  `a.role && ROLE_KEYS.includes(a.role) ? a.role : a.type` flips `知识管理员 (librarian)` →
  `(template)`. The type-gated form `a.type === "template" && a.role ? a.role : a.type` is
  byte-identical to the old `a.role ?? a.type` on every live row including `librarian` — always
  check what the live seed renders before accepting a plan's expression verbatim.
- **BEFORE/AFTER on a live stack needs the origin-bound auth file, not the repo one.**
  `web/.auth/user.json` is bound to `http://localhost:3001` (the dev server origin) and gives
  an empty app shell on `:13001`. A one-shot setup project doing a real form login on the
  container origin fixes it; `storageState` does not port across origins.
- **One Playwright `options` read is racy**: the first read returned only `请选择` (the agents
  query had not resolved). `await expect.poll(() => select.locator("option").count())` before
  reading makes the capture deterministic.
- **Mechanical BEFORE/AFTER diff beats eyeballing.** Extract the marker blocks from both logs
  and `difflib.unified_diff` the fact lines: 37/37 identical, zero diff. Screenshot inspection
  is the complement, not the proof.
- **The checker manifest stays line-keyed, so any edit drifts it.** `UNMAPPED: 22` was pure drift;
  regenerating with the checker's own pipeline gives `OBSERVED: 148 / UNMAPPED: 0` and the
  synthetic `--extra-dir` probe still yields `UNMAPPED: 1` (exit 1) — the negative control keeps
  the happy path honest. Net shrink 150 → 148 keys = the 5 deleted maps.

## todo 10 — remaining worker-dispatcher reads re-sourced from `agentKey`

- **The field name `role` survives, the DB column does not.** `AgentIdentityInfo.role` and
  `TeamMemberInfo.role` are KEPT (removing them churns ~15 spec fixture literals with TS
  excess-property errors), but their value now comes from a new pure helper
  `roleLabelOfAgentKey(agentKey) = roleToAgentName(agentKey) ? agentKey : ''`. Built-in
  template rows (`agent_key === role`) render the key byte-for-byte; custom rows render the
  empty string — exactly what the old `agent.role ?? ''` produced when the column was null.
  A doc comment on each field names todo 8 as the rename/delete owner.
- **`resolvePolicyAgentCandidate`'s signature narrowed to `{ agentKey }` — that IS the
  compile-time guard.** Dropping `role` from the row type makes every spec fixture that
  passed `{agentKey, role}` a TS2353 error, so the compiler enumerates the migration sites.
  The 2 remaining role-key runtime assertions use `as never` deliberately to prove the
  legacy shape is ignored. This is the todo-1 rule-4 narrowing, not a spec weakening.
- **Live DB confirms the narrowing is safe: 0 rows have `agent_key IS NULL`; all 7 templates
  satisfy `agent_key = role`; all 3 custom rows have `role IS NULL` + a lowercase-ASCII key.**
  So no live row loses a policy candidate (`resolvePolicyAgentCandidate`) and no custom row
  gains an issue-detail instruction (`roleNeedsIssueDetail(customKey)` cannot match the
  Chinese substring checks because `AGENT_KEY_PATTERN` is `^[a-z][a-z0-9_-]{0,62}$`).
- **Assembled-prompt proof needs a FIXED work dir.** The first BEFORE/AFTER run diffed only by
  the random `keta-cap-XXXX` tmpdir embedded in the `【运行时工作目录】` section. Pinning
  `CAPTURE_WORKROOT` in the harness made all 4 captures (template/custom × with/without a
  policy service) byte-identical with stable shas. Lesson: any prompt capture involving a
  mkdtemp needs the root pinned, or the "diff" is noise.
- **A mutation that SURVIVES is a coverage finding, not a dead end.** `roleLabelOfAgentKey`
  returning the raw key passed the whole suite on the first spec revision (the custom-key
  leak was only unit-tested via built-in assertions). Adding a dispatch-level test with a
  custom member asserting `角色: ）` (and `not.toContain('角色: myagent')`) killed it. Record
  the survived mutation in the evidence — it is the honest reason the test exists.
- **A discriminating fixture beats three assertion fixtures.** One row with
  `role: '产品经理'` + `agentKey: 'myagent'` makes both the identity-line and the
  issue-detail regressions fail loudly, because the label leak is a Chinese display name and
  the issue check matches `产品`. Three separate "happy path" fixtures would not have caught
  a code path reading the wrong field for the same row.
- **The manifest is `file:line`-keyed, so doc-comment edits drift it.** Final regeneration
  after the comment pass: 147 → 149 keys, purely line drift on `worker-dispatcher.ts`
  (verified key-by-key: nothing outside that file changed). Regenerate LAST, from the frozen
  source, then run the checker (rc 0) plus the `--extra-dir` negative control (UNMAPPED 1).

## todo 7 — backfill + drop `agents.role`

- **The live DB needed NO backfill (0 orphans both types), yet the migration is not vacuous.**
  Proving a backfill "works" on data that needs none requires SYNTHESIZING the orphan: nulling
  `a_product.policy_id` in the scratch made a1 restore `ep_product`, which is the only way to
  show the m6 predicate fires. A migration proven only on already-clean data proves nothing.
- **A "mutation control" that gets auto-repaired is not a failed control — it is the predicate
  working.** First attempt: `policy_id=NULL, role='tester'` → migration succeeded (a1 resolved
  `ep_tester`). The guard only fires for a role that resolves to NO existing `ep_*` row. The
  discriminating mutation is `role='no-such-role-xyz' + agent_key='no-such-key-xyz'`; then
  a1/a2 miss, the guard INSERTs NULL, MySQL raises 1048, and DROP never runs (role_col=1).
- **MySQL pure SQL has no SIGNAL; a NOT-NULL temporary column is the conditional-failure idiom.**
  `CREATE TEMPORARY TABLE g (id VARCHAR NOT NULL); INSERT ... SELECT NULL FROM agents WHERE <bad>;`
  raises 1048 iff the predicate matches, aborting the migration before the destructive statement.
  It is the only portable pure-SQL assertion — verified live (rc=1) and pinned by a spec that
  asserts the guard appears BEFORE the `ALTER TABLE` in the file.
- **The seed's literal `role` field was BOTH the policy key and the column value.** Renaming it
  to `agentKey` (values identical for all 7 templates, live-verified) is safe precisely because
  the seed is the only writer of the literal and `@unique(agent_key)` already held the same
  strings. `create: {...agent}` spread meant the literal key was the wire key — a dropped column
  becomes `Unknown argument 'role'` at seed time, i.e. a broken `init` container, not a TS error.
- **The literal is parsed by scripts too.** `scripts/verify-instruction-parity.mjs` reads the
  `templateAgents` array textually (`a.role` → `a.agentKey`); any seed-literal rename must grep
  `scripts/` in addition to `server/` — the compiler never sees these readers.
- **One existing spec pinned the EXPAND-phase invariant and MUST flip in contract.** 
  `agent-role.migration.spec.ts` asserted `Agent.role` "未被 drop/rename" — that assertion is the
  todo-1 promise, and todo 7 is the todo that fulfils it. Flipping it to `not.toMatch` (with the
  migration id named) is the correct contract transition, not a weakened test; leaving it would
  mean the suite forbids the plan's own goal.
- **A baseline test count is not a ceiling.** Here the suite grew 140→141/3244→3251 because the
  drop migration got its own structural contract spec (7 tests) — the repo's convention for every
  data migration (`agent-role.migration.spec.ts`, `agent-prompt-backfill.migration.spec.ts`).
  Report both numbers with the delta explained.
- **Docker can wedge on an external bind-mount `docker run`; `docker cp` + exec inside a running
  container is the recovery path.** The engine (OrbStack) hung mid-`docker run -v /Volumes/...`;
  after an app relaunch all compose services returned via `restart: unless-stopped` and `init`
  stayed exited (no reseed). `docker cp` the new migration into the server container, then
  `prisma migrate deploy` — no host bind-mount, no `--force-recreate`.

## todo 8 — findings / gotchas

- **The plan's "delete `roleToAgentName`" premise was stale by the time todo 8 ran.** Every live
  call site already passed an `agentKey` (todo 10 migrated the last two), so the function was
  alive and only its NAME was stale. Renaming (`roleToAgentName` → `agentKeyToVteamAgentName`)
  was the lower-risk option vs. leaving a name that lies: 2 call sites + the spec, zero behaviour.
  Had we deleted it per the literal plan text, `roleLabelOfAgentKey` and `resolveBoundaryAndTools`
  would both have broken — caught by the reference search, exactly the discipline the todo demands.
- **`isPlanRole` was the only genuinely dead symbol.** Its refs were self-export + doc comment +
  its own spec import/block. Deleting the spec block is what drops the suite from 3251 → 3250;
  a stale `TODO(agent-role-decommission todo 8)` marker sat in `roleLabelOfAgentKey`'s doc — the
  marker named a deferral the plan's own reconsideration had already answered (keep the fields).
  Resolving it = deleting the marker and stating the field's nature in one line.
- **`AgentIdentityInfo.role` / `TeamMemberInfo.role` LOOK dead but are not.** They feed the
  assembled identity line (`角色: <key>`) and the roster line; removing them ripples into ~15 spec
  fixture literals plus every assembled-prompt assertion for zero rendering gain. The correct
  cleanup is to stop calling them "role" in the comment and document them as key-derived labels —
  a comment-accurate field, not a deleted one.
- **`Object.keys(roles)` as a derived constant is order-safe here because JS integer-like keys do
  not exist in this map.** All six keys are non-numeric strings, so insertion order is guaranteed;
  the derived array is byte-identical to every replaced literal. Had a numeric-like key existed
  (`"1"`, `"2"`), `Object.keys` would reorder it ahead of string keys and an explicit ordered
  derivation would have been mandatory.
- **A differently-named sibling constant can hide in the same collapse.** `teams/new/page.tsx:50`
  declares `ROLE_ORDER` (same six values, different name AND different semantics: instance-bucket
  ordering). It is NOT one of the nine `ROLE_KEYS` sites, so the literal survives in the built
  bundle. Collapsing purely by VALUE rather than by symbol would have silently changed an
  ordering contract — grep by `const <name>` and read the usage, not just the value.
- **The checker's `UNMAPPED>0` after a real deletion is line drift, not a false alarm.** The
  manifest is line-keyed, so deleting ~10 lines above every remaining `.role` mention in
  `worker-dispatcher.ts` invalidates nearly every key in that file. Regenerate with the checker's
  OWN pipeline (`emit_server` + `emit_web` blocks) before declaring failure — then re-run the
  `--extra-dir` negative control to prove the checker still catches genuinely new reads.
- **Stale gitignored `server/dist` keeps deleted symbols "visible" to a naive repo-wide grep.**
  `dist/.../worker-dispatcher.d.ts` still declares `isPlanRole` and `isPlanRoleTarget` after the
  source is gone. Any "is this symbol really deleted" evidence MUST scope to `server/src`, and
  say so — a repo-wide grep hit in `dist` is an artifact, not a reference.
