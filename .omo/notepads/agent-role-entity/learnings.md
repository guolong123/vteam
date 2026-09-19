# Learnings — agent-role-entity

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — AgentRole model + TeamMember.roleId + backfill migration (done)

- **id prefix `ar`** (`AGENT_ROLE_ID_PREFIX`): builtin rows use named ids `ar_<role>` (mirrors `a_<role>` / `ep_<role>`);
  migration-derived custom rows use `ar_c_<md5(raw)[:16]>`; fallback is `ar_general`.
- **Single source of truth** = `server/src/common/constants/agent-role.constants.ts`
  (`BUILTIN_AGENT_ROLES`, `FALLBACK_AGENT_ROLE`, `deriveCustomAgentRoleKey/Id`). `seed.ts` keeps a
  self-contained mirror (its documented convention: no `../src` imports in the runner image).
- **Fresh-DB ordering gotcha**: `migrate deploy` runs BEFORE seed (docker-compose `init` service), so at
  migration time `agents` is empty. The builtin INSERT resolves `default_agent_id` via scalar subquery
  `(SELECT id FROM agents WHERE id='a_product')` → NULL on fresh DB; **seed backfills** it via
  `agentRole.updateMany({ where: { id, defaultAgentId: null } })` (create-if-absent, never overwrites
  a user-edited default). Directly FK-ing to a not-yet-existing agent row would break fresh deploys.
- **Backfill case (ii) derivation** (must stay byte-identical in SQL and TS):
  `stem = LEFT(TRIM(BOTH '_' FROM REGEXP_REPLACE(LOWER(TRIM(role)),'[^a-z0-9]+','_')),32)` fallback `'role'`;
  `key = 'custom_'||stem||'_'||LEFT(MD5(role),8)`; `id = 'ar_c_'||LEFT(MD5(role),16)`. **MD5 hashes the RAW
  role**, not the normalized form — TS `deriveCustomAgentRoleKey` deliberately hashes raw too. Vector:
  `role='analyst' → custom_analyst_05d5c5df / ar_c_05d5c5dfb743a5bd`.
- **Live data had zero case ii/iii members** (28 members, all builtin). Had to CONSTRUCT probes
  (`a_probe_analyst` role='analyst', `a_probe_norole` role=NULL) before `migrate deploy`, then clean up.
  Post-migration verified tally: case-i 28 / case-ii 1 / case-iii 1 / MISMATCH 0, nulls 0.
- **FK proof on live MySQL 8.4.11**: deleting `ar_product` while in use → ERROR 1451 (RESTRICT works);
  deleting an agent that is `default_agent_id` → column becomes NULL (SetNull works, agent deletion not blocked).
- **Contenant migration path**: host MySQL port 3306 is not published (Docker Desktop macOS), so copy the
  migration dir + schema into `aiagents-compose-server` and run `npx prisma migrate deploy` there.
- Jest baseline grew 134→136 suites / 3101→3124 tests; `tsc --noEmit` exit 0; frozen baseline sha unchanged.
- **Next todos read `roleId`**: the running server container still has the OLD generated Prisma client
  (built before this migration); a rebuild/`prisma generate` is needed before services can use `agentRole`/`roleId`.

## todo 2 — classify the 7 built-in prompts (role/agent/platform) (done)

- **Reconstruction method**: `seed.ts` stores prompts as JS string concatenations across many physical
  lines. Classify the LOGICAL (rendered) lines: evaluate the `templateAgents` array literal with
  `planToolLine` in scope, then `prompt.split("\n")`. `planToolLine` is itself re-derived from
  `ROLE_BOUNDARIES["vteam-plan"].toolAllows` in the same file (the eval string came from seed.ts alone).
  Stable key for todo 8 = `(agent key, rendered line index)`; 264 lines total
  (39/42/36/38/38/41/30).
- **Artifact**: `.omo/evidence/agent-role-entity/task-2-classification.json` (oracle) +
  `task-2-classification.txt` (human table). Checker `scripts/verify-prompt-classification.mjs`
  re-derives both sides and exits 1 on any unclassified/drifted/duplicated line; negative case proven.
- **Tally**: role=97, agent=92, platform=55, removed-intentionally=20.
- **Block semantics**: 团队协作规约 ×7 + 回执铁律 ×4 are `platform` (universal). 派发铁律 (PM) and
  修订铁律 (plan) are role-specific → `agent` (NOT folded into the platform block). 收敛契约 (plan) is
  likewise role-specific → `agent`. librarian has no 铁律 section; todo 3 deliberately EXTENDS 回执铁律 to
  all 7 (PM/plan/librarian gain it). This is why the artifact marks 回执铁律 platform at only 4 of 7 rows.
- **O6 removals**: 20 `## 权限` enumerated prose lines → `removed-intentionally`; pointer
  `权限边界以 ExecutionPolicy/【职责边界】为准，越界会被拒绝` is kept (product/PM/architect/developer/tester/
  librarian already have a live pointer line; **plan has none** — its 权限 §13 is an enumerated tool list
  that must be REPLACED by the pointer in todo 4, and the `seed.spec.ts` "可用工具" assertion must move).
- **Marker drift vs the task brief**: the brief quoted 团队协作规约 at seed `:576..849` and 回执铁律 at
  `:582/674/719/764`; the literal string lines are `:605,650,697,742,787,831,878` and `:611,703,748,793`.
  I anchor by content (checker-verified), not by the stale offsets.
- **Do NOT classify** the 3 unrelated `团队协作规约` occurrences at `seed.ts:2236-2260` (team-memory
  charter content) — they are not `templateAgents[].prompt` content.
- **Split consequence for todo 4**: all `## 职责` module-example bullets stay `role` even when they name a
  tool (vteam_issue_*, git_*, vteam_plan_complete) — the *responsibility* is the post, the tool is its means.
  Only `## 工作方式`/refusal-script/pointer lines are `agent`; the task-brief examples put 工作方式 in agent.

## todo 6 — AgentRole CRUD module + builtin protection (done)

- **New module** `server/src/agent-roles/` (controller/service/dto + 2 specs), registered in `app.module.ts`.
  Routes `/api/v1/agent-roles`: GET / (list), GET /:id, POST, PATCH /:id, DELETE /:id.
- **Permissions reused from the agents matrix, NOT invented**: read=`agents.view`, create=`agents.create`,
  update=`agents.edit`, delete=`agents.delete` — same `@UseGuards(PermissionGuard)` + `@RequirePermission(...)`
  idiom as `agents.controller.ts`. Asserted directly in the controller spec via
  `Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)` (pattern from artifacts/tasks/chat controller specs).
- **Builtin protection constant**: `AGENT_ROLE_ERRORS.AGENT_ROLE_BUILTIN_READONLY` (mirrors
  `AGENT_ERRORS.AGENT_READONLY` = `PERMISSION_AGENT_READONLY`). Declared `type='builtin'` → DELETE 403 and
  the row survives (asserted: `agentRole.delete` never called; live GET still 200). Same code for
  PATCH-builtin-`key` → 403.
- **Decision (recorded): PATCH on a builtin IS allowed** for `name`/`description`/`rolePrompt`/`defaultAgentId`
  (the Roles tab reads them), but changing `key` → 403. Mirrors the agents module (is_0000000030 lets template
  agents edit settings, `agentId`/`type` immutable). `type` is absent from the DTO, so it is structurally
  immutable; `key` is the builtin identity anchor and is explicitly guarded.
- **defaultAgentId validation**: non-null value must resolve to an existing `Agent` (else 400
  `AGENT_ROLE_DEFAULT_AGENT_NOT_FOUND`); `null`/absent clears/skips without a DB lookup. Validated on both
  create and update.
- **key**: `AGENT_KEY_PATTERN` (`^[a-z][a-z0-9_-]{0,62}$`) at DTO + service; uniqueness via `uk_agent_roles_key`
  → P2002 mapped to 409 `AGENT_ROLE_KEY_CONFLICT`. In-use role delete (FK RESTRICT) → P2003 mapped to 409
  `AGENT_ROLE_IN_USE` (never silently deletes).
- **No capability fields**: response object is exactly {id,key,name,description,type,defaultAgentId,rolePrompt,
  sortOrder,createdAt,updatedAt}; a spec asserts the key set and the absence of permission/tools/model/worker.
- **List order**: `orderBy: [{type:'asc'},{sortOrder:'asc'}]` — 'builtin'<'custom', so the 7 builtins lead,
  which is the authoritative listing contract (the task brief said "type/sortOrder order").
- **Live data caveat (expected, not a bug)**: todo 4 has not run, so all 7 builtin `role_prompt`s are still
  NULL. GET returns 7 builtins each with `defaultAgentId` set and the `rolePrompt` key present (value null).
  The spec asserts key presence + a mocked value, not non-null live data, so it won't false-fail pre-todo-4.
- **Container rebuild required** (carries over from todo 1): the running image predated the AgentRole model.
  `docker compose build server && docker compose up -d server` (plain up, NO `--force-recreate`) — the `init`
  service ran `migrate deploy` + seed, both idempotent; 8 rows preserved (7 builtin + ar_general).
- **Full-suite baseline**: grew 136→138 suites / 3124→3162 tests; `tsc -p tsconfig.json --noEmit` exit 0.
- **Evidence**: `.omo/evidence/agent-role-entity/task-6-api.json` (+ reusable `task-6-proof.sh`) with raw
  HTTP 200/201/403 outputs; DB recheck after delete-builtin = 8 rows, `ar_product` intact.

## todo 3 — lift shared platform blocks into injected constants (2026-09-19)
- **Real occurrence lines drift from the plan** (plan cited :575/:581/…, already stale). Anchored by
  CONTENT via the todo-2 artifact + grep: charter (团队协作规约) at seed `:605,650,697,742,787,831,878`;
  receipt (回执铁律) at `:611,703,748,793`; PM 派发铁律 `:656`; plan 修订铁律 `:841`. All 7 charter copies
  are byte-identical; all 4 receipt copies are byte-identical (sha256-verified).
- **The team-memory seed also contains 团队协作规约** (`seed.ts:2239/2260`, the fixed-id
  `me_team_collab_charter` memory). It is NOT prompt content — do not remove it.
- **Universality decision (Momus-B1/M4)**: both blocks lifted and injected UNCONDITIONALLY for all 7
  built-ins, no `role ===`/name branch at the injection site. 回执铁律 is thereby deliberately extended to
  project_manager/plan/librarian (was 4 agents). This is the whole point: a name-keyed conditional would be a
  5th hardcoded special case that plan 4 deletes.
- **Byte-identity gotcha**: the seed charter block ended with a trailing `\n` (the blank separator before the
  receipt block). The constant stores the 5 joined lines WITHOUT that trailing `\n`, and the assembler joins
  blocks with `\n\n`. Verify ASSEMBLED equivalence (old `charter+\n\n+receipt` == new blocks), not raw-string
  equality — raw charter strings differ only by that separator. `git diff --stat` shows exactly 55 deletions,
  0 insertions.
- **Removal pitfall**: the terminal `',` of each affected prompt literal lived on the last removed receipt
  line, so a naive block-delete leaves 5 prompts unterminated (`TS1109: Expression expected`). Fix the now-final
  line in place (`…\n' +` → `…',`, and drop the trailing `\n` to match the original terminal style).
- **Spillover tests to update**, all from seed.spec.ts + one dispatcher byte-oracle:
  the "7 模板 prompt 协同方式含协作规约摘录" test (invert to not-contain), the "成员回执铁律" test (now
  asserts each prompt does NOT contain the receipt text), the todo9 优先级 test (iron-law texts list drops the
  4 member prompts — they no longer carry PRECEDENCE inline; PM/plan keep their own iron laws), and
  worker-dispatcher.spec.ts `task-mode 文本字节不变` which pinned reception→artifact adjacency (now inserts
  before the charter block).
- **`scripts/verify-prompt-classification.mjs` is now stale by design** (todo 2's pre-removal oracle) and is
  NOT in CI; todo 8 owns the post-split parity proof. Did not touch it.
- **Suite**: 138 suites / 3169 tests passed (+7 vs the 3162 baseline); tsc exit 0. Evidence:
  `.omo/evidence/agent-role-entity/task-3-platform-const.txt`.

## Todo 7 · members ⇄ roles + Roles tab + member pre-fill (2026-09-19)

- **Precedence lives in ONE helper** (`TeamsService.resolveMemberBinding`, `teams.service.ts`): explicit
  `agentId` wins; `roleId`-only resolves `AgentRole.defaultAgentId`; `roleId` with a null default → 400
  `ROLE_DEFAULT_AGENT_MISSING`; both missing → 400 `MEMBER_AGENT_REQUIRED`. `create()` resolves all members
  BEFORE the transaction (fast-fail + avoids re-querying AgentRole inside the tx); `addMember`/`updateMember`
  call the same helper. This is the single seam — do not add a second resolution path.
- **Generic return preserves the row**: `resolveMemberBinding<T extends {agentId?; roleId?}>(input: T)` returns
  `T & {...}` so `alias`/`workDir` survive. A narrower `{agentId;roleId}` return type silently drops them and
  TS raises `Property 'alias' does not exist` at the create loop — caught immediately by tsc.
- **`ValidationPipe` is `whitelist: true, forbidNonWhitelisted: false`** (`main.ts:56`), and
  `AddMemberDto.agentId` had to become optional; the required-ness moved to the service. Existing exact-match
  specs (`teamMember.create` with `toHaveBeenNthCalledWith`) now need `roleId: null` added — 2 in teams.service
  + 2 in tasks.service; the `objectContaining` ones were unaffected.
- **`roleId` is persisted on BOTH member-creation paths**: `teams.service` (create/addMember/updateMember) and
  `tasks.service.createTeamMembers` (`POST /tasks/:id/team` addInstances) — the session add-instance flow.
  `toTeamDto` now surfaces `roleId` so the UI can round-trip it.
- **Roles tab is a separate component** `src/components/agents/AgentRolesTab.tsx` (page.tsx is already 3100+
  LOC). `SegmentedTabs` was NOT imported in agents/page.tsx — added it (testids `manage-tabs`/`manage-tab`,
  label filter must use `hasText: "角色"` not exact). The Agent tab is wrapped in a fragment so its DOM/behaviour
  is byte-unchanged; existing `pages.spec.ts` `/agents` assertions stayed green.
- **Capability fence**: AgentRolesTab imports only identity/DTO code and renders zero permission/tool editors;
  a hint line points capability to the Agent tab. `canEdit`/`canCreate`/`canDelete` are gated by
  `hasPermission(agents.*)`.
- **Member pre-fill de-hardcoded**: `TeamMembersPanel` no longer uses `ROLE_KEYS`/`ROLE_AGENT_ID` for the
  picker — it lists `/agent-roles` and on pick sets `selectedAgentId = role.defaultAgentId`; the added Agent
  `<select>` (testid `add-instance-agent-select`) lets the user override, and `onAddInstance` now takes
  `{agentId, roleId, alias}`. `teams/new` uses a local `agentIdForRoleKey` backed by the role API. Dead
  `agentIdForRole` export + `ROLE_AGENT_ID` const removed; `ROLE_KEYS` retained only for avatar/theme mapping.
- **Playwright harness copy** (`scripts/e2e-roles-members.sh` + `web/e2e/roles-members.spec.ts`): tmp config →
  compose web :13001, `channel:"chrome"`, admin login. The session add-member flow requires a team WITH a
  `pending` task (`teamEditable = currentTask.status pending|in_progress`) — a fresh team whose task is created
  via `POST /tasks` is `pending`, so the flow is reachable. Delete the throwaway team in `finally`.
- **Suite**: server 138 suites / 3169 tests green; `npx tsc --noEmit` exit 0 server + web; Playwright 3/3 green.
  Evidence `.omo/evidence/agent-role-entity/{task-7-proof.json,e2e.txt,task-7-roles-and-members.png}`.
