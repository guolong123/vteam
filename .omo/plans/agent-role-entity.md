# agent-role-entity - Work Plan

## TL;DR (For humans)

**What you'll get:** "Role" becomes a real, manageable thing, and each agent's instructions get split into the right places. Today one block of text mixes three different concerns: what the post is for, how to do the work, and rules that apply to everyone. After this, the role says what the job is, the agent says how it works, and the shared rules live once instead of being copied into every role. You also get a Roles tab where each role is a named post that points at an agent, so adding someone to a team means picking the post and the right agent comes with it.

**Why this approach:** A role and an agent being the same row is what forced the instructions to be mixed up. Introducing one new table for roles lets us separate the two cleanly, and the instruction split follows naturally from that. The instructions are also the one part of this that is safe to reorganise, because the frozen "must not change" guarantee covers permissions and tools only, not prompt text.

**What it will NOT do:** It will not change what any agent is allowed to do, will not delete the old label column (that is the last plan), will not touch the execution engine or the injection format, and will not add external agents.

**Effort:** Large
**Risk:** Medium - the instruction split touches the seven built-in agents' text and the code that assembles each agent's instructions, so the system-prompt tests must be updated in step; the role table itself is additive and safe.

**Decisions to sanity-check:** (1) the role's instructions and the agent's instructions are joined, not one replacing the other; (2) what counts as "job boundary" belongs to the agent, not the role; (3) the shared receipt rules become one platform block, which changes nothing a user sees except that editing them now affects everyone at once.

Your next move: run `$start-work agent-role-entity` to execute, or ask for a high-accuracy review first. Full execution detail follows below.

---

> TL;DR (machine): Large / Medium - add the global reusable `AgentRole` model + `TeamMember.roleId` + Roles tab, AND fully split the 7 built-in prompts into role-part / agent-part / platform-part, joining role+agent instructions at runtime. Byte-identity (policy output) is untouched; system-prompt assertions must be updated in step.

## Scope

### Must have
- A new global, reusable `AgentRole` entity carrying **no capability**: identity (key/name/description), `type` (builtin/custom), `defaultAgentId`, an ordering value, and its own **role instructions** (the "what this post is" text).
- `TeamMember.roleId` linking a member to a role, with `AgentRole.defaultAgentId` pre-filling the member's `agentId` while an explicit member selection still wins.
- **The full instruction split** for the 7 built-in roles: extract the "what the post is" part into the role, leave the "how to work / what I can use" part on the agent, and lift the identical platform-level block (the receipt rules) into ONE platform constant that is injected rather than copied.
- Role instructions and agent instructions are **joined** at assembly time, not one overriding the other.
- What counts as the agent's job boundary stays on the **agent** (both its prompt section and the guard's correction text) — it is not moved to the role.
- A Roles tab inside `/agents` where roles are listed and edited (name/description/default agent/role instructions), with create/clone/delete and stated FK semantics.
- A backfill migration mapping every existing team member to the correct role.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No deletion of `Agent.role` (that is the final plan); it stays as the label source for this plan's backfill only.
- No capability fields on `AgentRole` (permission/tools/model/worker are NOT role properties).
- No change to `execution_policies`, the `/agent-policies` payload, or `worker/**`.
- No change to what any agent is permitted to do — the extraction moves instruction TEXT, never a permission value.
- No change to the 7 built-ins' policy output: `before-agent-policies.json` sha stays `3b8c5d4bf29003c48079b11623cf840f9741e3044f6b40e3bfe035c011ceaf87` (that artifact contains no prompt text — re-baselined by the prior plan `server-gate-removal-tool-authority`; verified 2026-09-19 before execution).
- No table named `roles` and no model named `Role` (the account-permission `Role` owns those, `schema.prisma:68-80`).
- No third-party agent integration (the display plan).
- No A/B dual path, legacy shim, or "deprecated" annotations.
- No loss of instruction content: every sentence of the current 7 prompts must land somewhere deliberate (role / agent / platform), and the assembly must be provably equivalent-or-better.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after** + jest (`server`) + Playwright for the Roles tab and member flows.
- Instruction-split proof: a **content-parity check** that every line of the pre-split prompts is accounted for in exactly one destination (role / agent / platform), with no line dropped and none duplicated. This is the anti-regression gate for the split.
- Assembly proof: for a built-in agent, the assembled system instructions contain the role part, the agent part, and the platform part, in a defined order, with no text repeated.
- Migration proof: run on a DB that HAS existing `agent.role` values; assert every member maps correctly — not only on a fresh DB.
- Backward-compat proof: the resolved agent for each seeded member is identical before/after.
- Policy-byte proof: re-run the frozen-sha harness; it must be unchanged (proving no permission was touched).
- Evidence: `.omo/evidence/agent-role-entity/task-<N>-agent-role-entity.<ext>`

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- **Wave 1 — schema + backfill (serial, blocking):** the model and migration must land before anything reads `roleId`.
- **Wave 2 — instruction split (serial-ish):** classification → platform extraction → assembly change → assertion updates; these touch the same surfaces.
- **Wave 3 — server + web role surfaces:** the CRUD module, member linking, the Roles tab, the member form.
- **Wave 4 — proof:** migration-on-real-data, instruction parity, assembly, baseline sha.
- **Final verification wave:** F1-F4 in parallel.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2,6,7 | — |
| 2 | 1 | 3,4,5 | — |
| 3 | 2 | 4,5,8 | — |
| 4 | 3 | 5,8 | — |
| 5 | 4 | 8 | — |
| 6 | 1 | 7,8 | 2,3,4,5 |
| 7 | 1,6 | 8 | 2,3,4,5 |
| 8 | 1-7 | F1-F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

- [x] 1. [db] Add the `AgentRole` model and `TeamMember.roleId` (+ migration with backfill)
  What to do / Must NOT do: In `server/prisma/schema.prisma` add `model AgentRole` mapped to `agent_roles` with: `id` (follow the repo's id-prefix convention — pick and record a prefix), `key` (unique machine-safe identifier), `name`, `description`, `type` (`'builtin' | 'custom'`), `defaultAgentId` (optional FK to `Agent`), `rolePrompt` (the role instructions — text, nullable at the column level but every BUILTIN row must end non-empty), `sortOrder` (int, stable listing), timestamps. Add `TeamMember.roleId` (optional FK to `AgentRole`, `@map("role_id")`) with `onDelete: Restrict` (documented — an in-use role cannot vanish silently). **Also state `AgentRole.defaultAgentId`'s `onDelete` (review fix m8):** recommend `SetNull`, so deleting a bound agent clears the role's default rather than blocking agent deletion.
  Write the migration: create the table, add the column, seed the seven builtin roles (keys + names + `defaultAgentId` → the corresponding seeded template agents; `rolePrompt` may be empty at this step — todo 4 populates it), then **backfill** every existing `team_members` row.
  **Backfill rule (review fix M3 — the 0-null acceptance must be achievable):** resolve the role key from the referenced `Agent.role` value. Handle the three cases explicitly:
  (i) value matches a builtin role key → link that builtin `AgentRole`.
  (ii) value is a non-null, non-builtin string (e.g. specs use `'analyst'`) → **create a `type='custom'` `AgentRole` row** with a deterministic key derived from the value (record the derivation), then link it.
  (iii) value is `NULL` (a role-less custom agent — `create()` sets `role: dto.role ?? null`, `agents.service.ts:200`, and the web form never sent `role`) → link the member to a single well-known fallback role (create a `type='custom'` role with a documented key, e.g. a "general/未分类" role) rather than leaving `role_id` NULL.
  With (i)-(iii) the acceptance `SELECT COUNT(*) FROM team_members WHERE role_id IS NULL` = 0 becomes genuinely achievable on a populated DB. (If instead you choose to leave some NULL, you MUST relax the assertion to a scoped predicate and assert the remainder is explicitly listed — but the preferred path is 0 nulls via case (iii).)
  Must NOT name the table `roles` or the model `Role` (collision with the account-permission `Role`, `schema.prisma:68-80` + `@@map("roles")`). Must NOT drop or rename `Agent.role`. Must NOT put a capability field on `AgentRole`. Must state in the migration that the backfill is not reversible without a pre-migration dump, and record the exact restore command.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2,6,7
  References: `server/prisma/schema.prisma:68-80` (the RBAC `Role` to avoid), `:117-141` (`TeamMember`), `:583-626` (`Agent`, `role` at `:588`), `server/prisma/seed.ts:539-854` (the 7 template agents + their `role` values), `server/src/agents/agents.service.ts:200` (`role: dto.role ?? null` — the NULL case), migration conventions + a data-backfill precedent (`server/prisma/migrations/20260914000000_add_agent_key/migration.sql`), `server/src/common/id-generator.ts` (prefix conventions)
  Acceptance criteria (agent-executable): `cd server && npx prisma migrate deploy` succeeds on a DB that already has `agent.role` values; `SELECT COUNT(*) FROM team_members WHERE role_id IS NULL` returns 0; a test asserts each member whose agent had a builtin role key links the matching builtin role, a member with a custom value links a `type='custom'` role, and a NULL-role member links the documented fallback role; the seven builtin `AgentRole` rows exist with `defaultAgentId` set.
  QA scenarios (name the exact tool + invocation): happy — apply the migration to a copy of the populated DB and assert 0 nulls + correct mapping for all three cases; failure — a member whose agent has a custom `role` value AND a member whose agent has a NULL role both still end non-null (cases ii/iii). Evidence `.omo/evidence/agent-role-entity/task-1-migration.txt`
  Commit: Y | `feat(db): add agent_roles and team_members.role_id with backfill`

- [x] 2. [docs] Classify every line of the 7 built-in prompts into role / agent / platform
  What to do / Must NOT do: Read `server/prisma/seed.ts:539-854` (the 7 `templateAgents[].prompt` values) and produce a checked-in classification table: for EVERY line/section of every prompt, record exactly one destination — **role** (what the post is: identity, positioning, 职责, 边界声明), **agent** (how to work: permission usage, tool usage, 工作方式, 质量标准, 优先级), or **platform** (identical across all — the `团队协作规约` block ×7 and the `回执铁律` block ×4; see todo 3). Flag any line that is genuinely ambiguous with a proposed resolution.
  **Known duplication to resolve (review fix O6 — decide and record, chose the "pointer" option):** each prompt's `## 权限` section restates `ExecutionPolicy` in prose (e.g. "可写范围：仅…（层① permission.edit 路径 glob 强制）"). The prose and the policy can drift. **Decision:** keep a SHORT pointer ("权限边界以 ExecutionPolicy/【职责边界】为准，越界会被拒绝") and DROP the enumerated restatement of paths/effects, because the policy is the single source of truth and the editor (plan 1) now owns those values. Record this as a deliberate content change. Note: the parity check (todo 8) must therefore treat the dropped prose lines as **intentionally removed**, listed explicitly — not as "lost" lines.
  This todo produces the mapping only — no code changes. The mapping is the input to todos 3-5 and the anti-regression baseline for the parity check.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 3,4,5
  References: `server/prisma/seed.ts:539-854` (all 7 prompts; product at `:545-584` is the worked example), `docs/agent-platform/16-内置Agent角色与提示词库.md` (the four-direction structure: 职责/权限/工作方式/协同方式), `docs/agent-platform/14-Agent配置与虚拟团队模型.md` §3.1 (prompt semantics)
  Acceptance criteria (agent-executable): the mapping covers 100% of the prompt lines (a script counts source lines vs classified lines and reports equality); every `## 回执铁律`/`## 派发铁律`/`## 修订铁律` occurrence and every `团队协作规约` occurrence is marked (platform for the first two universal ones, role-specific for 派发/修订); the dropped `## 权限` prose lines are listed as intentional removals; no line is marked with two destinations.
  QA scenarios: happy — the classifier reports 0 unclassified lines; failure — an artificially unclassified line makes the check fail. Evidence `.omo/evidence/agent-role-entity/task-2-classification.txt`
  Commit: Y | `docs(agents): classify the 7 built-in prompts into role/agent/platform`

- [x] 3. [server] Extract the genuinely-universal platform block into one injected constant
  What to do / Must NOT do: **Corrected premise (review finding O1):** the blocks are NOT "7 identical copies". Verified in `server/prisma/seed.ts`:
  - `## 回执铁律` appears **4×** — `:581` (product), `:673` (architect), `:718` (developer), `:763` (tester), identical text.
  - `## 派发铁律` appears **1×** — `:626` (project_manager), DIFFERENT content.
  - `## 修订铁律` appears **1×** — `:811` (plan), DIFFERENT content.
  - `团队协作规约（全文见 …）` appears **7×** — `:575,620,667,712,757,801,848`, the genuinely universal block.
  - librarian has **no** 铁律 section.
  **DECISION (review fix Momus-B1/M4 — chose universality over conditional injection):** lift **BOTH** blocks to platform constants injected for **ALL 7 agents unconditionally**:
  (a) the `团队协作规约` block → one constant, all 7 (already universal — no behaviour change).
  (b) the `回执铁律` block → one constant, **all 7** — this deliberately EXTENDS it to project_manager/plan/librarian, which previously lacked it. This is a **deliberate, acknowledged behaviour change**, not an accident: it removes the need for any name/role-keyed conditional in the assembly (which would otherwise be a fifth hardcoded special case that plan 4 exists to delete), and the receipt rules are platform-wide policy that every vteam agent should follow. Record this as a stated change in the evidence and in the plan's Success criteria.
  (c) `派发铁律` (PM) and `修订铁律` (plan) → **role-specific**; leave them with their role/agent (do NOT fold into the platform block).
  Must NOT introduce ANY agent-name/role-keyed branch for block injection (that is the whole point of choosing universality). Must NOT change any block's text. Must NOT create a second copy of anything. Must NOT change a permission value.
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 4,5,8
  References: `server/prisma/seed.ts:575,581,620,626,667,673,712,718,757,763,801,811,848` (the exact occurrences), `server/src/chat/worker-dispatcher.ts:492-578` (`buildSystemInstructions` — note the real range is 492-578, not the 461-546 cited earlier) + the existing platform constants at `:206-448` (the pattern), `docs/agent-platform/30-团队协作规约.md` (the convention the shared blocks derive from)
  Acceptance criteria (agent-executable): `cd server && npx tsc -p tsconfig.json --noEmit` exits 0; a test asserts the `回执铁律` block appears exactly ONCE in the assembled instructions for **all 7** built-ins (including project_manager/plan/librarian — the deliberate extension); a test asserts the `团队协作规约` block appears exactly once for all 7; a test asserts `派发铁律`/`修订铁律` remain role-specific (present for their role, absent elsewhere); a test asserts no `templateAgents[].prompt` still contains either lifted block.
  QA scenarios: happy — counts match the universality decision above; failure — if a name-keyed conditional were introduced, the "all 7" assertion for `回执铁律` would fail. Evidence `.omo/evidence/agent-role-entity/task-3-platform-const.txt`
  Commit: Y | `refactor(prompts): lift the shared platform blocks into injected constants`

- [x] 4. [server] Split the role vs agent parts and re-point the seed prompts
  What to do / Must NOT do: Using todo 2's mapping, move the **role** lines into the builtin `AgentRole.rolePrompt` (created in todo 1) and keep the **agent** lines in `templateAgents[].prompt`. The role prompt answers "what is this post"; the agent prompt answers "how do I work with what I have". Do NOT duplicate a line into both. Do NOT move anything that expresses a permission/tool value — those stay described by (or point to) the policy. Keep each prompt coherent when read alone (a role prompt should read as a role definition; an agent prompt should read as an operator's brief).
  Parallelization: Wave 2 | Blocked by: 3 | Blocks: 5,8
  References: `server/prisma/seed.ts:539-854`, todo 2's classification artifact, `docs/agent-platform/16-内置Agent角色与提示词库.md` (the per-role four-direction prompts — the role-portion extract)
  Acceptance criteria (agent-executable): `npx tsc -p tsconfig.json --noEmit` exits 0; `npx jest --runInBand src/prisma` passes; a test asserts each builtin `AgentRole.rolePrompt` is non-empty and contains the role identity line; a test asserts no sentence appears in BOTH a role prompt and its agent prompt (de-duplication check).   **CRITICAL (review finding O7 — chose the idempotent data-migration path):** the role rows are created by the MIGRATION while this todo edits `seed.ts`, and a migration does not re-run on an existing deployment. Therefore populate `rolePrompt` via an **idempotent data migration** (`UPDATE agent_roles SET role_prompt = ... WHERE key = ...` for the 7 builtins, safe to re-run) AND keep `seed.ts` in sync for fresh installs. Do NOT rely on `seed.ts` alone. Assert on a POPULATED database that `SELECT COUNT(*) FROM agent_roles WHERE type='builtin' AND (role_prompt IS NULL OR role_prompt='')` returns 0. Without this, CI (fresh seed) passes while production serves empty role prompts.
  QA scenarios: happy — role and agent prompts are disjoint and each reads coherently; failure — the de-duplication check flags any shared sentence. Evidence `.omo/evidence/agent-role-entity/task-4-split.json`
  Commit: Y | `refactor(prompts): split role definitions from agent instructions`

- [x] 5. [server] Join role + agent instructions at assembly, and update the system-prompt assertions
  What to do / Must NOT do: Change instruction assembly so the agent's system instructions contain the bound role's `rolePrompt` and the agent's own `prompt` **joined** (not one replacing the other), plus the two platform blocks from todo 3 — in the **exact order below (review fix M5 — this IS the decision; do not leave it to the implementer)**. Insert into the existing `blocks` array in `buildSystemInstructions` (`worker-dispatcher.ts:516-535`), which today starts with `globalText + identityLine + 【职责】${agent.prompt}`:
  1. `globalText` (unchanged)
  2. `identityLine` (unchanged)
  3. **`【岗位职责】${rolePrompt}`** ← NEW; only when a role binding exists and `rolePrompt` is non-empty
  4. `【职责】${agent.prompt}` (existing, unchanged position relative to 1-2)
  5. persona (unchanged)
  6. main-agent / non-main note (unchanged)
  7. wecom (unchanged)
  8. persistentWorkDir (unchanged)
  9. boundarySection (unchanged)
  10. `MAIN_AGENT_INSTRUCTION` if main (unchanged)
  11. team-mode reception if team mode (unchanged)
  12. **the two platform blocks from todo 3** (`团队协作规约` + `回执铁律`) — append as their own blocks after the existing character-level blocks but before the issue/plan sections, so they read as platform-wide closing rules
  13. `ARTIFACT_SUBMISSION_INSTRUCTION` unless suppressed (unchanged)
  14. `ISSUE_FULL_INSTRUCTION` if enabled (unchanged)
  15. `PLAN_PRODUCE`/`PLAN_REVIEW` if plan mode (unchanged)
  16. team roster (unchanged)
  17. memoryIndex (unchanged)
  Rationale for role-before-agent: the role says "what this post is" (framing), the agent says "how I work" (detail) — framing first reads correctly. Preserve the existing degraded paths exactly: no role binding → skip block 3; empty `rolePrompt` → skip block 3 (no empty heading); non-existent agent row → the current fallback (name←id, no `【职责】`, no throw); the plan-role section suppression must still behave.
  **Blast radius (review fix O5):** `buildSystemInstructions` has **~45 call sites** in `worker-dispatcher.spec.ts` (lines 466, 492, 572, 1272-2004, 6175-6221…). Several construct an identity carrying `role`/`agentRole` (`:1580,1584,1804,1809`) and the `AgentIdentityInfo` interface (`worker-dispatcher.ts:292`, `agentRole?` at `:464`) is the shape plan 4 changes. Update ONLY the assertions that pin the assembled shape; must NOT weaken or delete the others. **Replace the self-oracle (review fix M8):** `worker-dispatcher.spec.ts:590` asserts `expect(execArgs.system).toBe(expected)` where `expected` is produced by calling `buildSystemInstructions(...)` in the same test (`:575-589`) — both sides move together, so it can never catch an assembly regression. Replace it with a literal expected string OR explicit ordered `toContain`/index assertions pinning the new shape.
  Must NOT change the `system` field's transport or the worker's expectations. Must NOT drop any block. Must NOT let role and agent parts produce duplicated headings.
  Parallelization: Wave 2 | Blocked by: 4 | Blocks: 8
  References: `server/src/chat/worker-dispatcher.ts:492-578` (assembly; `:516-535` the `blocks` array; `:520` `【职责】`; `:521` persona; `:534` boundary), `:292` + `:464` (`AgentIdentityInfo`/`agentRole?`), `:1980-1990` (the agent-row select) — **note (review fix m5): `roleId` lives on `TeamMember`, not on the agent row.** The dispatcher already loads member rows separately; the role binding must be JOINED from `TeamMember.roleId` → `AgentRole.rolePrompt` at dispatch time (for a member-scoped dispatch) or from the agent's own role binding (if one exists), and the todo must state WHICH source each assembly path uses. Do not describe it as "the agent row's role"., `server/src/chat/worker-dispatcher.spec.ts:466-504` (the assertions to update: `:487` the `【职责】` check, `:492-503` the degraded path) and `:590` (the self-oracle to replace)
  Acceptance criteria (agent-executable): `npx tsc -p tsconfig.json --noEmit` exits 0; `npx jest --runInBand src/chat` passes; a test asserts a built-in agent's assembled instructions contain the role part AND the agent part AND the platform block exactly once each; a test asserts the no-agent-row degraded path still emits no `【职责】` and does not throw.
  QA scenarios: happy — assembled output contains all three parts, once each, and the degraded paths hold; failure — binding an agent to a role with an empty `rolePrompt` produces the agent-only assembly (no empty heading). Evidence `.omo/evidence/agent-role-entity/task-5-assembly.json`
  Commit: Y | `feat(dispatch): join role and agent instructions at assembly`

- [x] 6. [server] AgentRole CRUD module + seed
  What to do / Must NOT do: Add an `agent-roles` module (controller/service/dto) with list/get/create/update/delete, guarded by the EXISTING permission matrix (`agents.view`/`agents.create`/`agents.edit`/`agents.delete` — reuse, do not invent new permission points). Builtin roles are protected from deletion like builtin template agents (403 + a stable code). Validate that `defaultAgentId` points at an existing agent. Expose `rolePrompt` as editable text. The seven builtin roles are seeded (todo 1 did the rows; this todo owns the API + the builtin protection). Must NOT expose capability fields. Must NOT change the `TeamMember` API here (todo 7).
  Parallelization: Wave 3 | Blocked by: 1 | Blocks: 7,8
  References: `server/src/agents/agents.controller.ts` + `agents.service.ts` (the module/permission/builtin-protection pattern to mirror), `server/src/common/decorators/require-permission.decorator.ts`, `server/prisma/seed.ts` (role seeding alongside the agents)
  Acceptance criteria (agent-executable): `npx tsc --noEmit` exits 0; `npx jest --runInBand src/agent-roles src/prisma` passes; tests assert `DELETE` on a builtin role → 403 and the row survives; a custom role supports full CRUD; `GET` returns 7 builtins with `defaultAgentId` + `rolePrompt`.
  QA scenarios: happy — `curl -s .../api/v1/agent-roles` returns the 7 builtins; failure — deleting a builtin → 403. Evidence `.omo/evidence/agent-role-entity/task-6-api.json`
  Commit: Y | `feat(agent-roles): add global reusable role entity with builtin protection`

- [x] 7. [server+web] Link members to roles and add the Roles tab + member pre-fill
  What to do / Must NOT do: (a) Extend the team-member DTOs/service so a member carries `roleId`; when `roleId` is given and `agentId` is not explicitly overridden, resolve `agentId` from `AgentRole.defaultAgentId`; when both are given the explicit `agentId` wins — document the precedence in code; keep `roleId` optional for backward compatibility. (b) Add a Roles tab inside `/agents` (Tab 1 Agent / Tab 2 角色) listing roles with a builtin badge and a detail form editing name/description/defaultAgentId/rolePrompt; create/clone/delete for custom roles; builtin roles read-only + no delete. **Note (review fix m2):** `web/app/(main)/agents/page.tsx` does NOT use `SegmentedTabs` today — you must ADD it (import from `@/src/components/ui`; existing users are `skills`, `git-repos`, `system/memories`, `system/triggers`, `integrations`). (c) Update the team member UI so picking a role pre-fills the agent, with the agent still switchable. Must NOT put permission/tool editors on the Roles tab (capability stays on the agent). Must NOT add a new nav item. Must NOT break the existing Agent tab or the alias/workDir/model-override behaviour.
  Parallelization: Wave 3 | Blocked by: 1,6 | Blocks: 8
  References: `server/src/teams/teams.service.ts` (addMember/updateMember + `defaultAlias`/`ROLE_LABELS` at `:35`, `:1292-1304`), `server/src/teams/dto/{add-member,update-member,create-team}.dto.ts`, `web/app/(main)/agents/page.tsx` (page; **`SegmentedTabs` is NOT imported here today — add it**), `web/src/components/ui/index.ts` (`SegmentedTabs`), `web/src/components/teams/TeamMembersPanel.tsx` (member picker; the duplicated `ROLE_KEYS`/`ROLE_AGENT_ID` at ~:59-69 should now come from the role API), `web/app/(main)/teams/new/page.tsx` (`ROLE_ORDER`/`FIXED_DESC`/`ROLE_AGENT_ID` at ~:41-57), `web/src/api/teams.ts`
  Acceptance criteria (agent-executable): `npx tsc --noEmit` (server + web) exits 0; tests assert a member added with only `roleId` resolves the role's default agent, and that an explicit `agentId` overrides it; Playwright asserts the two tabs, the 7 builtins listed, a builtin read-only with no delete, editing a custom role's default agent persists, and adding a member by role alone auto-fills the agent.
  QA scenarios: happy — Playwright adds `developer` by role and sees the developer default agent pre-filled, then overrides it and the override persists; failure — a builtin role shows no delete control. Evidence `.omo/evidence/agent-role-entity/task-7-roles-and-members.png`
  Commit: Y | `feat(roles): link members to roles and add the roles tab`

- [x] 8. [proof] Instruction parity + populated-DB migration + policy-byte regression
  What to do / Must NOT do: The closing proof. (a) **Instruction parity**: assert every line from the pre-split prompts is present exactly once across role/agent/platform (no loss, no duplication), using todo 2's mapping as the oracle. (b) **Assembly**: capture a built-in agent's assembled system instructions and assert the three parts appear once each in the documented order. (c) **Migration**: run the full chain on a populated DB (existing `agent.role` values) and assert 0 null `role_id` + correct mapping + that the resolved dispatch agent per seeded member is unchanged. (d) **Policy bytes**: re-run the frozen-sha harness and confirm `3b8c5d4bf29003c48079b11623cf840f9741e3044f6b40e3bfe035c011ceaf87` is unchanged (re-baselined by the prior plan; the original `793093dc…` was stale). (e) exercise the rollback once on a copy. Must NOT test the migration only on a fresh DB. Must NOT modify the frozen baseline. Must NOT weaken any assertion to reach green.
  Parallelization: Wave 4 | Blocked by: 1-7 | Blocks: F1-F4
  References: todo 2's classification artifact, `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json`, `scripts/e2e-role-boundaries.sh` (the sha gate + harness), `server/src/chat/worker-dispatcher.spec.ts`, `server/prisma/migrations/` (the new migration)
  Acceptance criteria (agent-executable): parity reports 0 lost and 0 duplicated lines; the assembly assertion passes; the populated-DB migration yields 0 unresolved members with unchanged dispatch resolution; the frozen sha is unchanged; the rollback is exercised and recorded.
  QA scenarios: happy — all five proofs pass with artifacts; failure — deleting one line from a role prompt makes the parity check report a loss (mutation check, recorded). Evidence `.omo/evidence/agent-role-entity/task-8-proof.txt`
  Commit: Y | `test(e2e): prove instruction parity and role migration`

- [x] 9. [db] Backfill the 7 built-ins' `agents.prompt` to the post-split text (DISCOVERED by F3 — the split is not real on a deployed DB)
  **The blocking defect (F3 REJECT, independently reproduced by the orchestrator).** Todo 4 split the prompts in `seed.ts` and added an idempotent data migration for `agent_roles.role_prompt` (the O7 fix) — but **no migration rewrites the existing `agents.prompt` rows**, and the agent upsert in `seed.ts` is `update: {}` (create-if-absent, deliberate). Consequence on ANY deployed DB: `agents.prompt` still holds the **pre-split** text (role identity + `## 职责` + `## 协同方式` + `团队协作规约` + `回执铁律`), and the new assembly (todo 5) joins `AgentRole.rolePrompt` **on top of it** → the role part and the platform blocks appear **twice**. Verified live: all 7 builtins showed `identity=2`, and sentence de-dup found 8–14 shared sentences per agent (`/` `.omo/evidence/agent-role-entity/f3-qa/`). This violates the plan's own Success criterion "assembled instructions contain role + agent + platform once each" and "no sentence appears in BOTH a role prompt and its agent prompt". Fresh installs are fine (seed create writes the split text) — the defect is upgrade/populated-DB only.
  Required:
  - An **idempotent data migration** that rewrites `agents.prompt` for the 7 builtin template agents to the SAME post-split text `seed.ts` writes (keep seed in sync for fresh installs; the migration is what fixes existing deployments — exactly the O7 pattern applied to the agent side).
  - **PRESERVE USER EDITS:** `agents.prompt` is a user-editable field. Do NOT blind-overwrite. Guard the UPDATE so it only rewrites a row that still carries the pre-split factory text (e.g. the row still contains the role identity line AND BOTH platform markers / matches the recorded pre-split hash), and record the guard predicate. A row a user has customized must be left alone (record how you detect that).
  - Prove it on the **POPULATED** DB (not a fresh seed): after the migration, dispatch/assemble a builtin and assert role + agent + platform blocks appear **exactly once each, in order**, and the sentence de-dup reports **0 shared sentences** — re-run F3's check.
  - Record the rollback path for this migration.
  Must NOT change the prompt TEXT the split produced (byte-equal to `seed.ts`). Must NOT clobber a user-edited prompt. Must NOT weaken the todo-8 parity checker. Must NOT touch permissions / `worker/**` / the assembly logic.
  Parallelization: Wave 7 (discovered) | Blocked by: 4,5 | Blocks: F3 re-run
  References: `server/prisma/seed.ts` (the post-split `templateAgents[].prompt`; the upsert with `update: {}`), `server/prisma/migrations/20260919000008_populate_builtin_role_prompts/migration.sql` (the O7 precedent + literal-embedding technique), `.omo/evidence/agent-role-entity/f3-qa/{VERDICT-REJECT.md,role-agent-dedup-populated-db.txt,assembled-all7-populated-db.txt}`, `server/src/common/constants/agent-role-prompts.constants.ts`
  Acceptance criteria (agent-executable): on the populated DB, `agents.prompt` for the 7 builtins equals the post-split text (byte-compare against `seed.ts`); the assembled system for a builtin contains role/agent/platform once each in order; the sentence de-dup reports 0 shared sentences; a user-edited prompt (simulated on a scratch row) is NOT overwritten; the migration is re-runnable (2nd run = 0 rows changed); the frozen sha is unchanged.
  QA scenarios: happy — migration applied to the populated DB de-duplicates the assembled output for all 7 builtins; failure — before the migration the assembled output duplicates the role part (the current live state, recorded).
  Evidence `.omo/evidence/agent-role-entity/task-9-agent-prompt-backfill.txt`
  Commit: Y | `fix(db): backfill the split agent prompts on deployed databases`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit ok before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
- One commit per todo; prefix `feat|refactor|test|docs(<scope>): <summary>`.
- The schema/migration commit (todo 1) lands alone so it can be reviewed before anything reads `roleId`.
- The instruction-split commits (2-5) form one logical unit; land them in order and keep `npx jest --runInBand src/chat src/prisma` green between them.
- Do NOT push until the user says so.

## Success criteria
- `cd server && npx tsc -p tsconfig.json --noEmit` and `cd web && npx tsc --noEmit` exit 0; jest + Playwright green.
- The migration on a populated DB leaves 0 null `role_id` and maps every member correctly; existing dispatch resolution is provably unchanged.
- Role instructions and agent instructions are joined at assembly; a built-in's assembled instructions contain role + agent + platform parts once each, in order.
- Instruction parity holds: no line lost, none duplicated; the platform block exists once in code, not 7 times.
- The Roles tab works (builtins read-only, custom CRUD, default-agent persistence); a member added by role alone gets the role's default agent; an explicit agent overrides.
- `Agent.role` is untouched; no table named `roles`; `worker/**` untouched; the frozen policy sha is unchanged; no permission value changed anywhere.
